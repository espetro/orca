// Shared engine for the class-method-extractor: spec types, ts-morph helpers,
// facade generation, and this.X rewriting. Used by both move and verify.
import { readFileSync } from 'node:fs'
import { Project, SyntaxKind, type MethodDeclaration, type SourceFile } from 'ts-morph'

type DepKind = 'direct' | 'callback' | 'lazy' | 'state'
// 'state': mutable field that MOVES into the facade. The field decl (with its
// initializer) is transplanted, and all this.X references (reads and writes)
// drop the receiver inside the facade. Wiring deletes it from the source class.
type DepSpec = { kind: DepKind; from: string }
type ExtractorSpec = {
  target: string
  className: string
  methods: string[]
  deps: Record<string, DepSpec>
  /** Class fields owned (moved) by the facade; declared state deps implicitly. */
  stateFields?: string[]
  /** Class the methods are moved FROM. Defaults to the OrcaRuntimeService god class. */
  sourceClassName?: string
}

const BACKUP_PATH = '/tmp/orca-runtime.before.ts'
const FACADE_BACKUP_PATH = '/tmp/runtime-facade.before.ts'

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

const DEFAULT_SOURCE_CLASS_NAME = 'OrcaRuntimeService'

function parseSpec(path: string): ExtractorSpec {
  return JSON.parse(readFileSync(path, 'utf8')) as ExtractorSpec
}

function newProject(): Project {
  return new Project({
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    manipulationSettings: { indentationText: 'TwoSpaces', quoteKind: 'single' }
  })
}

function toCamel(name: string): string {
  return name.replace(/[-_](\w)/g, (_, c: string) => c.toUpperCase())
}

function facadeFieldName(target: string): string {
  const base = toCamel(target.replace(/\.ts$/, ''))
  return base.startsWith('runtime')
    ? base.charAt('runtime'.length).toLowerCase() + base.slice('runtime'.length + 1)
    : base
}

function depsTypeName(className: string): string {
  return `${className}Deps`
}

// All this.X references (fields + methods) inside the given methods.
function captureSet(methods: MethodDeclaration[]): Map<string, Set<string>> {
  const perMethod = new Map<string, Set<string>>()
  for (const method of methods) {
    const captures = new Set<string>()
    for (const prop of method.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
      if (prop.getExpression().getKindName() === 'ThisKeyword') {
        captures.add(prop.getName())
      }
    }
    perMethod.set(method.getName(), captures)
  }
  return perMethod
}

// Build identifier -> { module, typeOnly } map from the source file's imports.
function importMap(sf: SourceFile): Map<string, { module: string; typeOnly: boolean }> {
  const map = new Map<string, { module: string; typeOnly: boolean }>()
  for (const imp of sf.getImportDeclarations()) {
    const clauseTypeOnly = imp.isTypeOnly()
    for (const named of imp.getNamedImports()) {
      map.set(named.getAliasNode()?.getText() ?? named.getNameNode().getText(), {
        module: imp.getModuleSpecifierValue(),
        typeOnly: clauseTypeOnly || named.isTypeOnly()
      })
    }
    const def = imp.getDefaultImport()
    if (def) {
      map.set(def.getText(), { module: imp.getModuleSpecifierValue(), typeOnly: clauseTypeOnly })
    }
  }
  return map
}

// Rewrite this.X accesses per dep kinds. Shared by move and verify (normalization oracle).
function normalizeBody(text: string, spec: ExtractorSpec): string {
  let out = text

  for (const [dep, d] of Object.entries(spec.deps)) {
    if (d.kind === 'callback') {
      out = out.replace(new RegExp(`this\\.${d.from}(?=\\s*\\()`, 'g'), `this.deps.${dep}`)
    } else if (d.kind === 'lazy') {
      out = out.replace(new RegExp(`this\\.${d.from}\\b`, 'g'), `this.deps.${dep}()`)
    } else {
      out = out.replace(new RegExp(`this\\.${d.from}\\b`, 'g'), `this.deps.${dep}`)
    }
  }
  return out
}

function methodFullTextWithComments(method: MethodDeclaration): {
  spanStart: number
  spanEnd: number
  text: string
  commentText: string
} {
  const sf = method.getSourceFile()
  const ranges = method.getLeadingCommentRanges()
  const spanStart =
    ranges.length > 0 ? Math.min(...ranges.map((r) => r.getPos())) : method.getStart()
  const full = sf.getFullText()
  return {
    spanStart,
    spanEnd: method.getEnd(),
    text: full.slice(method.getStart(), method.getEnd()),
    commentText: full.slice(spanStart, method.getStart())
  }
}

// Strip `private` so the facade member is callable from the source class (TS2341).
function publicizeMethodText(text: string): string {
  return text.replace(/^(\s*)private\s+/, '$1')
}

function facadeImports(
  facadeText: string,
  sfMap: Map<string, { module: string; typeOnly: boolean }>
): string[] {
  const used = new Set<string>()
  for (const m of facadeText.matchAll(/[A-Za-z_$][\w$]*/g)) {
    used.add(m[0])
  }
  const byModule = new Map<string, { names: string[]; typeOnly: boolean }>()
  for (const name of used) {
    const entry = sfMap.get(name)
    if (!entry) {
      continue
    }
    const key = `${entry.module}`
    const bucket = byModule.get(key) ?? { names: [], typeOnly: entry.typeOnly }
    bucket.names.push(name)
    byModule.set(key, bucket)
  }
  const imports: string[] = []
  for (const [module, { names, typeOnly }] of [...byModule.entries()].sort((a, b) =>
    a[0].localeCompare(b[0])
  )) {
    const list = names.sort().join(', ')
    imports.push(
      typeOnly ? `import type { ${list} } from '${module}'` : `import { ${list} } from '${module}'`
    )
  }
  return imports
}

function facadeSource(
  spec: ExtractorSpec,
  movedTexts: Map<string, string>,
  sourceFile: SourceFile
): string {
  const className = spec.className
  const sfMap = importMap(sourceFile)
  const depEntries = Object.entries(spec.deps)
  const cls = sourceFile.getClass(spec.sourceClassName ?? DEFAULT_SOURCE_CLASS_NAME)
  const callbackType = (methodName: string): string => {
    const method = cls?.getMethod(methodName)
    if (!method) {
      fail(`callback dep "${methodName}": no such method on ${cls?.getName() ?? 'source class'}`)
    }
    const params = method
      .getParameters()
      .map((p) => p.getText())
      .join(', ')
    const ret = method.getReturnTypeNode()?.getText()
    if (!ret) {
      fail(`callback dep "${methodName}": cannot derive return type; add an explicit one`)
    }
    return `(${params}) => ${ret}`
  }
  const lazyType = (fieldName: string): string => {
    const member = cls?.getInstanceProperty(fieldName)
    if (!member) {
      fail(`lazy dep "${fieldName}": no such property on ${cls?.getName() ?? 'source class'}`)
    }
    const typeText = member.getType().getText(sourceFile)
    if (typeText === 'unknown' || typeText === 'any') {
      fail(`lazy dep "${fieldName}": field type resolved to ${typeText}`)
    }
    return typeText
  }
  const directType = (fieldName: string): string => {
    const member = cls?.getInstanceProperty(fieldName)
    if (!member) {
      fail(`direct dep "${fieldName}": no such property on ${cls?.getName() ?? 'source class'}`)
    }
    const typeText = member.getType().getText(sourceFile)
    if (typeText === 'unknown' || typeText === 'any') {
      fail(`direct dep "${fieldName}": field type resolved to ${typeText}`)
    }
    return typeText
  }
  const typeLines: string[] = []
  const fieldLines: string[] = []
  for (const field of spec.stateFields ?? []) {
    const member = cls?.getInstanceProperty(field)
    if (!member) {
      fail(`state field "${field}": no such property on ${cls?.getName() ?? 'source class'}`)
    }
    fieldLines.push(`  ${member.getText()}`)
  }
  for (const [dep, d] of depEntries) {
    if (d.kind === 'direct') {
      typeLines.push(`  ${dep}: ${directType(d.from)}`)
    } else if (d.kind === 'lazy') {
      typeLines.push(`  ${dep}: () => ${lazyType(d.from)}`)
    } else {
      typeLines.push(`  ${dep}: ${callbackType(d.from)}`)
    }
  }
  const methodTexts = spec.methods.map(
    (name) => movedTexts.get(name) ?? fail(`internal: missing moved text for ${name}`)
  )
  const classText = `export type ${depsTypeName(className)} = {
${typeLines.join('\n')}
}

export class ${className} {
  private readonly deps: ${depsTypeName(className)}
${fieldLines.length > 0 ? `${fieldLines.join('\n')}\n\n` : ''}
  constructor(deps: ${depsTypeName(className)}) {
    this.deps = deps
  }

${methodTexts.join('\n\n')}
}
`
  const imports = facadeImports(classText, sfMap)
  return `${imports.join('\n')}\n\n${classText}`
}

function stubFor(method: MethodDeclaration, facadeField: string): string {
  const modifiers = method
    .getModifiers()
    .map((m) => m.getText())
    .join(' ')
  const typeParams =
    method.getTypeParameters().length > 0
      ? `<${method
          .getTypeParameters()
          .map((t) => t.getText())
          .join(', ')}>`
      : ''
  const params = method
    .getParameters()
    .map((p) => p.getText())
    .join(', ')
  const args = method
    .getParameters()
    .map((p) => p.getName())
    .join(', ')
  const ret = method.getReturnTypeNode()?.getText()
  const prefix = modifiers ? `${modifiers} ` : ''
  const retAnn = ret ? `: ${ret}` : ''
  return `${prefix}${method.getName()}${typeParams}(${params})${retAnn} {
    return this.${facadeField}.${method.getName()}(${args})
  }`
}
export {
  DEFAULT_SOURCE_CLASS_NAME,
  parseSpec,
  newProject,
  normalizeBody,
  captureSet,
  facadeSource,
  stubFor,
  publicizeMethodText,
  facadeImports,
  importMap,
  methodFullTextWithComments,
  facadeFieldName,
  depsTypeName,
  toCamel,
  fail,
  BACKUP_PATH,
  FACADE_BACKUP_PATH
}

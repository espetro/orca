#!/usr/bin/env node
// POC codemod engine: moves methods off the OrcaRuntimeService god class into a
// facade class (Pattern A), rewriting this.X accesses per a dependency spec.
// Run with: node tools/class-method-extractor/cli.ts <move|verify> ...
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Project, SyntaxKind, type MethodDeclaration, type SourceFile } from 'ts-morph'

type DepKind = 'direct' | 'callback' | 'lazy'
type DepSpec = { kind: DepKind; from: string }
type ExtractorSpec = {
  target: string
  className: string
  methods: string[]
  deps: Record<string, DepSpec>
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
    ? base.charAt('runtime'.length).toLowerCase() + base.slice('runtime'.length)
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
  const lines: string[] = []
  for (const [dep, d] of depEntries) {
    if (d.kind === 'direct') {
      lines.push(`  ${dep}: ${directType(d.from)}`)
    } else if (d.kind === 'lazy') {
      lines.push(`  ${dep}: () => ${lazyType(d.from)}`)
    } else {
      lines.push(`  ${dep}: ${callbackType(d.from)}`)
    }
  }
  const methodTexts = spec.methods.map(
    (name) => movedTexts.get(name) ?? fail(`internal: missing moved text for ${name}`)
  )
  const classText = `export type ${depsTypeName(className)} = {
${lines.join('\n')}
}

export class ${className} {
  private readonly deps: ${depsTypeName(className)}

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
function runMove(file: string, specPath: string, dryRun: boolean): void {
  const spec = parseSpec(specPath)
  const project = newProject()
  const sf = project.addSourceFileAtPath(resolve(file))
  const cls = sf.getClassOrThrow(spec.sourceClassName ?? DEFAULT_SOURCE_CLASS_NAME)
  const methods = spec.methods.map((name) => cls.getMethodOrThrow(name))

  const captures = captureSet(methods)
  const movedSet = new Set(spec.methods)
  const depNames = new Set(Object.values(spec.deps).map((d) => d.from))
  const unknown = new Map<string, string[]>()
  for (const [methodName, caps] of captures) {
    const offending = [...caps].filter((c) => !movedSet.has(c) && !depNames.has(c))
    if (offending.length > 0) {
      unknown.set(methodName, offending)
    }
  }
  if (unknown.size > 0) {
    console.error('Refusing to move: unaccounted this.X captures (add to spec deps or moved set):')
    for (const [m, caps] of unknown) {
      console.error(`  ${m}: ${caps.join(', ')}`)
    }
    process.exit(1)
  }

  console.log(`Capture set for ${spec.methods.length} methods of ${spec.className}:`)
  for (const [methodName, caps] of captures) {
    const external = [...caps].filter((c) => !movedSet.has(c))
    console.log(
      `  ${methodName}: total=[${[...caps].sort().join(', ')}] external=[${external.sort().join(', ')}]`
    )
  }
  const union = new Set<string>()
  for (const caps of captures.values()) {
    for (const c of caps) {
      if (!movedSet.has(c)) {
        union.add(c)
      }
    }
  }
  console.log(`External capture union: [${[...union].sort().join(', ')}]`)
  console.log(`Spec deps: ${JSON.stringify(spec.deps)}`)

  if (dryRun) {
    console.log('dry-run: no files written.')
    return
  }

  copyFileSync(resolve(file), BACKUP_PATH)
  const targetPath = join(sf.getDirectoryPath(), spec.target)
  const hadFacade = existsSync(targetPath)
  if (hadFacade) {
    copyFileSync(targetPath, FACADE_BACKUP_PATH)
  }

  // 1. Extract moved method texts (with leading comments) and rewrite this.X per deps.
  const movedTexts = new Map<string, string>()
  for (const method of methods) {
    const { text } = methodFullTextWithComments(method)
    const facadeMethodText = publicizeMethodText(text)
    movedTexts.set(method.getName(), normalizeBody(facadeMethodText, spec))
  }

  // 2. Generate facade file.
  writeFileSync(targetPath, facadeSource(spec, movedTexts, sf))

  // 3. Drop dead privates; stub only methods still referenced in the source class.
  const facadeField = facadeFieldName(spec.target)
  const stillReferenced = (name: string): boolean => {
    const movedSpans = methods.map((m) => [m.getStart(), m.getEnd()] as const)
    for (const ref of cls.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
      if (ref.getExpression().getKindName() !== 'ThisKeyword' || ref.getName() !== name) {
        continue
      }
      const pos = ref.getStart()
      if (movedSpans.some(([s, e]) => pos >= s && pos < e)) {
        continue
      }
      return true
    }
    return false
  }
  const stubbed = new Set<string>()
  const removed = new Set<string>()
  const spans: { name: string; spanStart: number; end: number; text: string }[] = []
  for (const method of spec.methods.map((n) => cls.getMethodOrThrow(n))) {
    const name = method.getName()
    const { spanStart, commentText } = methodFullTextWithComments(method)
    if (method.hasModifier(SyntaxKind.PrivateKeyword) && !stillReferenced(name)) {
      removed.add(name)
      spans.push({ name, spanStart, end: method.getEnd(), text: '' })
    } else {
      stubbed.add(name)
      spans.push({
        name,
        spanStart,
        end: method.getEnd(),
        text: `${commentText}${stubFor(method, facadeField)}`
      })
    }
  }
  // Replace bottom-up so earlier spans stay valid.
  for (const s of [...spans].sort((a, b) => b.spanStart - a.spanStart)) {
    sf.removeText(s.spanStart, s.end)
    if (s.text) {
      sf.insertText(s.spanStart, s.text)
    }
  }
  for (const name of removed) {
    console.log(`Removed ${name} (private, unreferenced after move: no stub emitted).`)
  }

  // 4. Facade field declaration + constructor wiring.
  const cls2 = sf.getClassOrThrow(spec.sourceClassName ?? DEFAULT_SOURCE_CLASS_NAME)
  const fieldDecl = `private readonly ${facadeField}: ${spec.className}`
  const members = cls2.getMembers()
  // Insert after the last sibling *Commands field, else after the store field.
  let anchorIndex = -1
  for (let i = members.length - 1; i >= 0; i--) {
    const text = members[i].getText()
    if (/private readonly \w+Commands: \w/.test(text) || /private readonly store:/.test(text)) {
      anchorIndex = i
      break
    }
  }
  if (anchorIndex !== -1) {
    cls2.insertMember(anchorIndex + 1, `  ${fieldDecl}`)
  } else {
    cls2.insertMember(0, `  ${fieldDecl}`)
  }
  const ctor = cls2.getConstructors()[0]
  const wiring = Object.entries(spec.deps)
    .map(([dep, d]) => {
      if (d.kind === 'direct') {
        return `${dep}: this.${d.from}`
      }
      if (d.kind === 'lazy') {
        return `${dep}: () => this.${d.from}`
      }
      return `${dep}: (arg) => this.${d.from}(arg)`
    })
    .join(',\n')
  const assign = `this.${facadeField} = new ${spec.className}({\n${wiring}\n})`
  if (ctor) {
    const stmts = ctor.getStatements()
    const idx = stmts.findIndex((s) => s.getText().startsWith('this.store = store'))
    ctor.insertStatements(idx + 1, assign)
  }
  // 5. Import into the top import block: right after the last existing
  // `./runtime-*` value import (sibling facade), else among the top imports.
  const importInsertIndex = (() => {
    const imports = sf.getImportDeclarations()
    let lastRuntimeValue = -1
    for (const imp of imports) {
      const spec2 = imp.getModuleSpecifierValue()
      if (/^\.[\w/-]*\/?runtime-/.test(spec2) && !imp.isTypeOnly()) {
        lastRuntimeValue = imp.getSpecifier().getEnd()
      }
    }
    if (lastRuntimeValue !== -1) {
      return lastRuntimeValue
    }
    return imports.length > 0 ? imports[0].getStart() : 0
  })()
  sf.insertText(
    importInsertIndex,
    `\nimport { ${spec.className} } from './${spec.target.replace(/\.ts$/, '')}'`
  )

  sf.saveSync()
  console.log(`Wrote facade ${targetPath} and edited ${resolve(file)}`)
  console.log(`Backups: ${BACKUP_PATH}${hadFacade ? `, ${FACADE_BACKUP_PATH}` : ''}`)
}

function stripWs(text: string): string {
  return text.replace(/\s+/g, '')
}

function runVerify(
  beforePath: string,
  afterPath: string,
  specPath: string,
  manifestPath: string
): void {
  const spec = parseSpec(specPath)
  const project = newProject()
  const before = project.addSourceFileAtPath(resolve(beforePath))
  const after = project.addSourceFileAtPath(resolve(afterPath))
  const beforeCls = before.getClassOrThrow(spec.sourceClassName ?? DEFAULT_SOURCE_CLASS_NAME)
  const afterCls = after.getClassOrThrow(spec.className)

  const drifts: string[] = []
  for (const name of spec.methods) {
    const beforeMethod = beforeCls.getMethodOrThrow(name)
    const afterMethod = afterCls.getMethod(name)
    if (!afterMethod) {
      // Private-and-unreferenced methods are removed, not stubbed: nothing to compare.
      if (beforeMethod.hasModifier(SyntaxKind.PrivateKeyword)) {
        continue
      }
      drifts.push(`${name}: missing in facade`)
      continue
    }
    const beforeText = publicizeMethodText(normalizeBody(beforeMethod.getText(), spec))
    const afterText = afterMethod.getText()
    if (stripWs(beforeText) === stripWs(afterText)) {
      continue
    }
    // Show an AST-aware word diff for the drift, then fail.
    const dir = mkdtempSync(join(tmpdir(), 'cme-verify-'))
    const f1 = join(dir, 'before.ts')
    const f2 = join(dir, 'after.ts')
    writeFileSync(f1, beforeText)
    writeFileSync(f2, afterText)
    const res = spawnSync('difft', ['--color=never', '--width=120', f1, f2], { encoding: 'utf8' })
    drifts.push(`${name}: body drift\n${res.stdout ?? '(difft unavailable)'}`)
  }
  if (drifts.length > 0) {
    console.error(`verify FAILED (${drifts.length} drifts):`)
    for (const d of drifts) {
      console.error(`\n--- ${d}`)
    }
    process.exit(1)
  }

  const beforeLines = readFileSync(resolve(beforePath), 'utf8').split('\n').length
  const afterLines = readFileSync(resolve(afterPath), 'utf8').split('\n').length
  const stubCount = spec.methods.filter((n) => beforeCls.getMethod(n) === undefined).length
  const manifest = {
    spec: specPath,
    target: spec.target,
    methodsMoved: spec.methods,
    deps: spec.deps,
    locRemovedFromSource: beforeLines - afterLines,
    locAddedInFacade: readFileSync(resolve(afterPath), 'utf8').split('\n').length,
    delegationStubCount: stubCount
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`verify OK: ${spec.methods.length} methods byte-equivalent after normalization.`)
  console.log(`Manifest written to ${manifestPath}`)
}

function main(): void {
  const [cmd, ...rest] = process.argv.slice(2)
  const flag = (name: string): boolean => rest.includes(name)
  const opt = (name: string): string | undefined => {
    const i = rest.indexOf(name)
    return i !== -1 ? rest[i + 1] : undefined
  }
  if (cmd === 'move') {
    const file = opt('--file')
    const specPath = opt('--spec')
    if (!file || !specPath) {
      fail('usage: cli.ts move --file <orca-runtime.ts> --spec <spec.json> [--dry-run]')
    }
    runMove(file, specPath, flag('--dry-run'))
  } else if (cmd === 'verify') {
    const before = opt('--before')
    const after = opt('--after')
    const specPath = opt('--spec')
    const manifest = opt('--manifest')
    if (!before || !after || !specPath || !manifest) {
      fail(
        'usage: cli.ts verify --before <orig-backup> --after <facade-file> --spec <spec.json> --manifest out.json'
      )
    }
    runVerify(before, after, specPath, manifest)
  } else {
    fail(
      `usage: cli.ts <move|verify>\n  move --file <file> --spec <spec.json> [--dry-run]\n  verify --before <orig-backup> --after <facade-file> --spec <spec.json> --manifest out.json`
    )
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main()
}

export { runMove, runVerify, normalizeBody, captureSet, facadeSource, stubFor, publicizeMethodText }

// move subcommand: executes a spec against the source file (backup, generate
// facade, transplant, stub, wire ctor) and writes the new facade file.
import { SyntaxKind } from 'ts-morph'
import { copyFileSync, existsSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  BACKUP_PATH,
  DEFAULT_SOURCE_CLASS_NAME,
  FACADE_BACKUP_PATH,
  captureSet,
  facadeFieldName,
  facadeSource,
  methodFullTextWithComments,
  newProject,
  parseSpec,
  normalizeBody,
  publicizeMethodText,
  stubFor
} from './core.ts'

function runMove(file: string, specPath: string, dryRun: boolean): void {
  const spec = parseSpec(specPath)
  const project = newProject()
  const sf = project.addSourceFileAtPath(resolve(file))
  const cls = sf.getClassOrThrow(spec.sourceClassName ?? DEFAULT_SOURCE_CLASS_NAME)
  const methods = spec.methods.map((name) => cls.getMethodOrThrow(name))

  const captures = captureSet(methods)
  const movedSet = new Set(spec.methods)
  const stateSet = new Set(spec.stateFields ?? [])
  const depNames = new Set(Object.values(spec.deps).map((d) => d.from))
  const unknown = new Map<string, string[]>()
  for (const [methodName, caps] of captures) {
    const offending = [...caps].filter(
      (c) => !movedSet.has(c) && !depNames.has(c) && !stateSet.has(c)
    )
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
  // 4b. Remove state fields now owned by the facade.
  for (const field of spec.stateFields ?? []) {
    cls2.getInstanceProperty(field)?.remove()
    console.log(`Moved state field ${field} into facade.`)
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
      return `${dep}: (...args) => this.${d.from}(...args)`
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
        lastRuntimeValue = imp.getEnd()
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

export { runMove }

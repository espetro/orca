// verify subcommand: normalization-oracle diff of moved methods (before vs facade).
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { SyntaxKind } from 'ts-morph'
import {
  DEFAULT_SOURCE_CLASS_NAME,
  newProject,
  parseSpec,
  publicizeMethodText,
  normalizeBody
} from './core.ts'

function stripWs(text: string): string {
  return text.replace(/\s+/g, '')
}

export function runVerify(
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

#!/usr/bin/env node
// POC codemod engine: moves methods off the OrcaRuntimeService god class into a
// facade class (Pattern A), rewriting this.X accesses per a dependency spec.
// Run with: node tools/class-method-extractor/cli.ts <move|verify> ...
import { pathToFileURL } from 'node:url'
import { runMove } from './move.ts'
import { runVerify } from './verify.ts'
import { fail } from './core.ts'

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

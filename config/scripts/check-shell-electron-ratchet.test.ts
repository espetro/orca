import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  diffAgainstBaseline,
  readBaseline,
  scanShellElectronImporters
} from './check-shell-electron-ratchet.ts'

describe('readBaseline', () => {
  it('drops comments and blank lines and sorts', () => {
    expect(readBaseline('# comment\n\n  src/main/b.ts \nsrc/main/a.ts\n')).toEqual([
      'src/main/a.ts',
      'src/main/b.ts'
    ])
  })
})

describe('diffAgainstBaseline', () => {
  it('reports added files', () => {
    expect(diffAgainstBaseline(['a.ts', 'b.ts'], ['a.ts'])).toEqual({
      added: ['b.ts'],
      removed: []
    })
  })

  it('reports removed files', () => {
    expect(diffAgainstBaseline(['a.ts'], ['a.ts', 'b.ts'])).toEqual({
      added: [],
      removed: ['b.ts']
    })
  })

  it('reports no difference when sets match', () => {
    expect(diffAgainstBaseline(['a.ts'], ['a.ts'])).toEqual({ added: [], removed: [] })
  })
})

describe('the checked-in shell electron baseline', () => {
  it('matches what non-test modules in src/main currently import', () => {
    const current = scanShellElectronImporters()
    const baseline = readBaseline(readFileSync('config/shell-electron-baseline.txt', 'utf8'))
    expect(diffAgainstBaseline(current, baseline)).toEqual({ added: [], removed: [] })
  })
})

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  captureSet,
  normalizeBody,
  runMove,
  runVerify
} from '../../tools/class-method-extractor/cli'
import { Project } from 'ts-morph'

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) {
    rmSync(d, { recursive: true, force: true })
  }
})

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cme-unit-'))
  dirs.push(dir)
  return dir
}

const FIXTURE = `
export class GodClass {
  constructor(store?: { ping(): void }) {
    this.store = store
    this.notifier = store ?? null
  }
  private store?: { ping(): void }
  private counter = 0
  private notifier: { ping(): void } | null = null

  publicA(): string {
    this.counter = this.counter + 1
    return this.helper(this.counter)
  }

  private helper(n: number): string {
    return \`n:\${n}\`
  }

  async publicB(input: string): Promise<string> {
    return this.helper(input.length + this.counter)
  }

  usesCallback(): void {
    this.emitEvent('x')
  }

  emitEvent(event: string): void {
    const notifier = this.notifier
    if (notifier) {
      notifier.ping()
    }
    console.log(event)
  }

  remaining(): string {
    return this.publicA()
  }
}
`

const SPEC = {
  sourceClassName: 'GodClass',
  target: 'moved-commands.ts',
  className: 'MovedCommands',
  methods: ['publicA', 'helper', 'publicB', 'usesCallback'],
  deps: {
    counter: { kind: 'direct', from: 'counter' },
    notifier: { kind: 'lazy', from: 'notifier' },
    emitEvent: { kind: 'callback', from: 'emitEvent' }
  }
}

describe('class-method-extractor', () => {
  it('computes capture sets from this.X references', () => {
    const project = new Project({ skipAddingFilesFromTsConfig: true })
    const sf = project.createSourceFile('fixture.ts', FIXTURE)
    const cls = sf.getClassOrThrow('GodClass')
    const captures = captureSet([cls.getMethodOrThrow('publicA'), cls.getMethodOrThrow('publicB')])
    expect(captures.get('publicA')).toEqual(new Set(['counter', 'helper']))
    expect(captures.get('publicB')).toEqual(new Set(['counter', 'helper']))
  })

  it('normalizes this.X per dep kinds (direct, lazy, callback)', () => {
    const body = 'const a = this.counter; const b = this.notifier; this.emitEvent(a)'
    expect(normalizeBody(body, SPEC)).toBe(
      'const a = this.deps.counter; const b = this.deps.notifier(); this.deps.emitEvent(a)'
    )
  })

  it('move: rewrites bodies, generates facade, leaves delegation stubs', () => {
    const dir = scratch()
    const file = join(dir, 'god.ts')
    const facade = join(dir, 'moved-commands.ts')
    writeFileSync(file, FIXTURE)
    const specPath = join(dir, 'spec.json')
    writeFileSync(specPath, JSON.stringify(SPEC))

    runMove(file, specPath, false)

    const god = readFileSync(file, 'utf8')
    const moved = readFileSync(facade, 'utf8')
    expect(god).toContain('return this.movedCommands.publicA()')
    expect(god).toContain('return this.movedCommands.publicB(input)')
    expect(god).toContain('new MovedCommands({')
    expect(god).toContain('counter: this.counter')
    expect(god).toContain('notifier: () => this.notifier')
    expect(god).toContain('emitEvent: (arg) => this.emitEvent(arg)')
    expect(god).toContain('MovedCommands } from')
    expect(moved).toContain('export type MovedCommandsDeps')
    expect(moved).toContain('export class MovedCommands')
    expect(moved).toContain('this.deps.counter')
    expect(moved).toContain('this.deps.emitEvent(')
    // Cross-call between moved methods stays this.-based
    expect(moved).toContain('this.helper(')
    // Remaining method keeps calling the stub
    expect(god).toContain('return this.publicA()')
  })

  it('move: refuses unaccounted captures with exit 1', () => {
    const dir = scratch()
    const file = join(dir, 'god.ts')
    writeFileSync(file, FIXTURE)
    const specPath = join(dir, 'spec.json')
    writeFileSync(specPath, JSON.stringify({ ...SPEC, deps: { counter: SPEC.deps.counter } }))
    let code = 0
    const originalExit = process.exit
    process.exit = ((n?: number) => {
      code = n ?? 0
      throw new Error('exit')
    }) as typeof process.exit
    try {
      runMove(file, specPath, true)
    } catch {
      // expected refuse path
    } finally {
      process.exit = originalExit
    }
    expect(code).toBe(1)
  })

  it('verify: passes on normalized equivalence and writes manifest', () => {
    const dir = scratch()
    const before = join(dir, 'before.ts')
    const facade = join(dir, 'moved-commands.ts')
    writeFileSync(before, FIXTURE)
    const specPath = join(dir, 'spec.json')
    writeFileSync(specPath, JSON.stringify(SPEC))
    runMove(before, specPath, false)
    // move edited before.ts in place; treat post-move source as the "before" backup copy is wrong,
    // so instead re-verify against the untouched fixture vs the facade.
    writeFileSync(before, FIXTURE)
    const manifest = join(dir, 'manifest.json')
    runVerify(before, facade, specPath, manifest)
    const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as {
      methodsMoved: string[]
      delegationStubCount: number
      deps: Record<string, { kind: string }>
    }
    expect(parsed.methodsMoved).toEqual(SPEC.methods)
    expect(parsed.delegationStubCount).toBe(0)
    expect(parsed.deps.counter.kind).toBe('direct')
  })

  it('verify: detects drift', () => {
    const dir = scratch()
    const before = join(dir, 'before.ts')
    const facade = join(dir, 'moved-commands.ts')
    writeFileSync(before, FIXTURE)
    const specPath = join(dir, 'spec.json')
    writeFileSync(specPath, JSON.stringify(SPEC))
    runMove(before, specPath, false)
    writeFileSync(before, FIXTURE)
    // Corrupt the facade body
    writeFileSync(
      facade,
      readFileSync(facade, 'utf8').replace(
        'return this.helper(input.length + this.deps.counter)',
        'return `drifted:${this.deps.counter}`'
      )
    )
    const manifest = join(dir, 'manifest.json')
    expect(() => runVerify(before, facade, specPath, manifest)).toThrow()
  })
})

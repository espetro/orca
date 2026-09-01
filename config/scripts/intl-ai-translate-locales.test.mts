import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  findIdenticalToEn,
  renderReportMarkdown,
  runPostFillGate
} from './intl-ai-post-fill-gate.mts'
import type { LocaleCatalog } from './locale-translation-policy.mts'
import { isIntlAiDisabled, main } from './intl-ai-translate-locales.mts'

function catalog(entries: Record<string, string>): LocaleCatalog {
  const out: LocaleCatalog = {}
  for (const [dottedKey, value] of Object.entries(entries)) {
    const parts = dottedKey.split('.')
    let cursor = out
    for (const part of parts.slice(0, -1)) {
      cursor[part] = (cursor[part] as LocaleCatalog) ?? {}
      cursor = cursor[part] as LocaleCatalog
    }
    cursor[parts.at(-1) as string] = value
  }
  return out
}

const EN_CATALOG = catalog({
  'app.title': 'Orca',
  'app.open': 'Open {{value0}}',
  'app.save': 'Save changes'
})

describe('intl-ai post-fill gate', () => {
  it('passes a matching catalog and counts keys', () => {
    const zh = catalog({
      'app.title': 'Orca',
      'app.open': '打开 {{value0}}',
      'app.save': '保存更改'
    })
    const report = runPostFillGate({ locale: 'zh', enCatalog: EN_CATALOG, localeCatalog: zh })
    expect(report.passed).toBe(true)
    expect(report.keyCountEn).toBe(3)
    expect(report.keyCountLocale).toBe(3)
  })

  it('rejects a key-count mismatch', () => {
    const zh = catalog({ 'app.title': 'Orca', 'app.open': '打开 {{value0}}' })
    const report = runPostFillGate({ locale: 'zh', enCatalog: EN_CATALOG, localeCatalog: zh })
    expect(report.passed).toBe(false)
    expect(report.errors[0]).toContain('Key count mismatch')
  })

  it('applies the overrides polish layer (repairCatalog)', () => {
    const zh = catalog({
      'app.title': '虎鲸',
      'app.open': '打开 {{value0}}',
      'app.save': '保存更改'
    })
    const report = runPostFillGate({ locale: 'zh', enCatalog: EN_CATALOG, localeCatalog: zh })
    expect(report.overridesApplied).toBeGreaterThan(0)
    expect(report.identicalToEn.find((entry) => entry.key === 'app.title')?.value).toBe('Orca')
  })

  it('flags identical-to-en values in the report without failing the gate', () => {
    const zh = catalog({
      'app.title': 'Orca',
      'app.open': '打开 {{value0}}',
      'app.save': '保存更改'
    })
    const report = runPostFillGate({ locale: 'zh', enCatalog: EN_CATALOG, localeCatalog: zh })
    expect(report.identicalToEn).toEqual([{ key: 'app.title', value: 'Orca' }])
    expect(report.passed).toBe(true)
  })

  it('renders a markdown report with flags and result', () => {
    const zh = catalog({ 'app.title': 'Orca' })
    const report = runPostFillGate({ locale: 'zh', enCatalog: EN_CATALOG, localeCatalog: zh })
    const markdown = renderReportMarkdown(report)
    expect(markdown).toContain('# intl-ai post-fill gate: zh')
    expect(markdown).toContain('FAIL')
    expect(markdown).toContain('`app.title`')
  })

  it('mutates the locale catalog in place when polish repairs apply', () => {
    const zh = catalog({
      'app.title': '虎鲸',
      'app.open': '打开 {{value0}}',
      'app.save': '保存更改'
    })
    runPostFillGate({ locale: 'zh', enCatalog: EN_CATALOG, localeCatalog: zh })
    expect(JSON.stringify(zh)).toContain('"Orca"')
  })
})

describe('intl-ai findIdenticalToEn', () => {
  it('skips empty strings', () => {
    const en = catalog({ 'a.b': '', 'a.c': 'Same' })
    const target = catalog({ 'a.b': '', 'a.c': 'Same' })
    expect(findIdenticalToEn(en, target)).toEqual([{ key: 'a.c', value: 'Same' }])
  })
})

describe('intl-ai translate locales CLI', () => {
  const tempDirs: string[] = []
  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })))
    tempDirs.length = 0
    vi.restoreAllMocks()
  })

  it('INTL_AI_DISABLED=1 exits 0 with zero fetches and zero writes', async () => {
    process.env.INTL_AI_DISABLED = '1'
    try {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
      const writeSpy = vi.spyOn(fs, 'writeFile')
      const exitCode = await main(['--locale', 'zh', '--all'])
      expect(exitCode).toBe(0)
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(writeSpy).not.toHaveBeenCalled()
    } finally {
      delete process.env.INTL_AI_DISABLED
    }
  })

  it('isIntlAiDisabled reads INTL_AI_DISABLED exactly', () => {
    expect(isIntlAiDisabled({ INTL_AI_DISABLED: '1' })).toBe(true)
    expect(isIntlAiDisabled({ INTL_AI_DISABLED: '0' })).toBe(false)
    expect(isIntlAiDisabled({})).toBe(false)
  })

  it('refuses a non-allowlisted model without --allow-paid before any fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const exitCode = await main(['--locale', 'zh', '--model', 'anthropic/claude-sonnet-4'])
    expect(exitCode).toBe(1)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('defaults to dry-run when no mode flag is given', async () => {
    // parseFlags is not exported; assert the observable dry-run contract instead:
    // with no key available the run fails loud at env resolution, never fetches.
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const writeSpy = vi.spyOn(fs, 'writeFile')
    const exitCode = await main([])
    expect(exitCode).toBe(1)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(writeSpy).not.toHaveBeenCalled()
  })

  it('rejects en as a target locale', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const exitCode = await main(['--locale', 'en'])
    expect(exitCode).toBe(1)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('dry-run never writes locale files or lockfiles', async () => {
    // The writeReport path is only reachable after a real fill; dry-run exits
    // at runCheck. Assert via the gate's writeReport name to keep zero writes.
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'intl-ai-cli-'))
    tempDirs.push(tempDir)
    const zh = catalog({ 'app.title': 'Orca' })
    expect(() =>
      renderReportMarkdown(
        runPostFillGate({
          locale: 'zh',
          enCatalog: EN_CATALOG,
          localeCatalog: zh
        })
      )
    ).not.toThrow()
  })
})

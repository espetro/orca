import { describe, expect, it } from 'vitest'

import type { LocaleCatalog } from './locale-translation-policy.mts'
import { repairCatalog } from './locale-translation-policy.mts'

// Regression: en.json routinely carries keys a locale catalog has not been bootstrapped with yet
// (~190 per locale at the time of writing), which crashed the whole repair run before it did any work.

type LocaleCatalogNode = Exclude<
  LocaleCatalog[string],
  string | readonly LocaleCatalog[string][] | null | undefined
>

function requireCatalogObject(node: LocaleCatalog[string], label: string): LocaleCatalogNode {
  if (node === null || node === undefined || typeof node === 'string' || Array.isArray(node)) {
    throw new Error(`fixture catalog must contain a ${label} object`)
  }
  return node
}

describe('repairCatalog with un-bootstrapped keys', () => {
  const enCatalog: LocaleCatalog = {
    auto: {
      lib: { agent: { catalog: { '760bc6883d': 'Codex' } } },
      components: { untranslated: 'Continue', nested: { alsoMissing: 'Refresh' } }
    }
  }

  const translatedOnly = (): LocaleCatalog => ({
    auto: { lib: { agent: { catalog: { '760bc6883d': '사본' } } } }
  })

  it('skips leaves the locale catalog is missing instead of throwing', () => {
    for (const locale of ['ko', 'ja', 'zh', 'es']) {
      const localeCatalog = translatedOnly()
      expect(() => repairCatalog(enCatalog, localeCatalog, locale), locale).not.toThrow()
      expect(requireCatalogObject(localeCatalog.auto, 'auto').components, locale).toBeUndefined()
    }
  })

  it('still repairs the leaves that are present', () => {
    const localeCatalog = translatedOnly()
    expect(repairCatalog(enCatalog, localeCatalog, 'ko')).toBe(1)
    const agentCatalog = requireCatalogObject(
      requireCatalogObject(requireCatalogObject(localeCatalog.auto, 'auto').lib, 'lib').agent,
      'agent'
    ).catalog
    expect(requireCatalogObject(agentCatalog, 'catalog')['760bc6883d']).toBe('Codex')
  })
})

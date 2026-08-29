import { describe, expect, it, vi } from 'vitest'

const monacoSetupModule = vi.hoisted(() => ({
  monaco: {
    editor: { marker: 'combined-diff-viewer-fixture' },
    __setup: false
  },
  __esModule: true
}))

// Why: mock the dynamic setup module so the test asserts the lazy contract
// (setup module loaded once, same instance returned) without pulling in the
// real monaco-editor bundle.
vi.mock('./monaco-setup', () => monacoSetupModule)

import { ensureMonaco, getLoadedMonaco, requireLoadedMonaco } from './monaco-lazy'

describe('ensureMonaco', () => {
  it('resolves to the monaco-setup module and runs setup only once', async () => {
    const first = ensureMonaco()
    const second = ensureMonaco()
    expect(first).toBe(second)

    const monaco = await first
    expect(monaco).toBe(monacoSetupModule.monaco)
    expect(getLoadedMonaco()).toBe(monaco)
    expect(requireLoadedMonaco()).toBe(monaco)
    // The dynamic import of the setup module must not be re-triggered.
    await expect(ensureMonaco()).resolves.toBe(monaco)
  })
})

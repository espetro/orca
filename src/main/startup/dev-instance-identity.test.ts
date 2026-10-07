import { describe, expect, it } from 'vitest'
import { getDevInstanceIdentity, shouldApplyPreReadyAppName } from './dev-instance-identity'

describe('dev-instance-identity', () => {
  it('keeps packaged identity stable', () => {
    expect(getDevInstanceIdentity(false, {})).toMatchObject({
      name: 'Orca',
      appName: 'Orca',
      isDev: false,
      devLabel: null,
      dockBadgeLabel: null,
      appUserModelId: 'com.stablyai.orca'
    })
  })

  it('makes a baked product name a full standalone variant identity', () => {
    const g = globalThis as typeof globalThis & { ORCA_PRODUCT_NAME?: string | null }
    g.ORCA_PRODUCT_NAME = 'Orca Canary'
    try {
      const identity = getDevInstanceIdentity(false, {})
      expect(identity.name).toBe('Orca Canary')
      // Own appName → own "Orca Canary Safe Storage" key, own AUMID (matches appId suffix).
      expect(identity.appName).toBe('Orca Canary')
      expect(identity.appUserModelId).toBe('com.stablyai.orca.canary')
      expect(identity.isDev).toBe(false)
      // No pre-ready rename: the key derives from its own CFBundleName.
      expect(shouldApplyPreReadyAppName(identity)).toBe(false)
    } finally {
      delete g.ORCA_PRODUCT_NAME
    }
  })

  it('pins a stable dev appName across branches so the safeStorage key does not churn', () => {
    const a = getDevInstanceIdentity(true, { ORCA_DEV_BRANCH: 'feature/a' })
    const b = getDevInstanceIdentity(true, { ORCA_DEV_BRANCH: 'feature/b' })

    // Per-branch label differs (window title / app menu)...
    expect(a.name).not.toBe(b.name)
    // ...but the Keychain-driving appName is identical and distinct from prod.
    expect(a.appName).toBe('Orca Dev')
    expect(b.appName).toBe('Orca Dev')
    expect(a.appName).not.toBe('Orca')
  })

  it('never renames a packaged build before ready', () => {
    // Any packaged build (incl. Canary) derives its safeStorage key from its own
    // CFBundleName; a pre-ready rename would orphan its encrypted secrets.
    expect(shouldApplyPreReadyAppName(getDevInstanceIdentity(false, {}))).toBe(false)
    expect(shouldApplyPreReadyAppName({ isDev: false })).toBe(false)
  })

  it('applies the dev name before ready so safeStorage sees it', () => {
    expect(shouldApplyPreReadyAppName(getDevInstanceIdentity(true, {}))).toBe(true)
  })

  it('derives a readable dev label from worktree and branch env', () => {
    const identity = getDevInstanceIdentity(true, {
      ORCA_DEV_REPO_ROOT: '/repo/worktrees/dev-indicator',
      ORCA_DEV_WORKTREE_NAME: 'dev-indicator',
      ORCA_DEV_BRANCH: 'nwparker/dev-indicator'
    })

    expect(identity).toMatchObject({
      isDev: true,
      devLabel: 'dev-indicator',
      devBranch: 'nwparker/dev-indicator',
      devWorktreeName: 'dev-indicator',
      devRepoRoot: '/repo/worktrees/dev-indicator'
    })
    expect(identity.name).toBe('Orca: nwparker/dev-indicator')
    expect(identity.dockBadgeLabel).toBeNull()
    expect(identity.appUserModelId).toMatch(/^com\.stablyai\.orca\.dev\.[a-f0-9]{10}$/)
  })

  it('includes the branch when it differs from the worktree basename', () => {
    const identity = getDevInstanceIdentity(true, {
      ORCA_DEV_REPO_ROOT: '/repo/worktrees/payment-ui',
      ORCA_DEV_WORKTREE_NAME: 'payment-ui',
      ORCA_DEV_BRANCH: 'feature/billing-shell'
    })

    expect(identity.devLabel).toBe('payment-ui @ feature/billing-shell')
    expect(identity.name).toBe('Orca: feature/billing-shell')
    expect(identity.dockBadgeLabel).toBeNull()
  })

  it('allows an explicit label override', () => {
    const identity = getDevInstanceIdentity(true, {
      ORCA_DEV_INSTANCE_LABEL: 'manual label',
      ORCA_DEV_WORKTREE_NAME: 'dev-indicator',
      ORCA_DEV_BRANCH: 'feature/other'
    })

    expect(identity.devLabel).toBe('manual label')
    expect(identity.name).toBe('Orca: feature/other')
    expect(identity.dockBadgeLabel).toBeNull()
  })
})

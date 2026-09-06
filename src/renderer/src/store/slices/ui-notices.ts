import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import {
  DEFAULT_BROWSER_PAGE_ZOOM_LEVEL,
  normalizeBrowserPageZoomLevel
} from '../../../../shared/browser-page-zoom'
import { normalizeKagiSessionLink } from '../../../../shared/browser-url'
import { getSetupScriptPromptDismissalKey } from '../../lib/setup-script-prompt'
import type { PersistedTrustedOrcaHooks } from '../../../../shared/orca-yaml-hook-types'
import type { ChangelogData, UpdateStatus } from '../../../../shared/update-status-types'
import type { OrcaHookScriptKind } from '../../lib/orca-hook-trust'
import type { ReleaseChannel } from '../../../../shared/release-channel'

export type UINoticesSlice = {
  trustedOrcaHooks: PersistedTrustedOrcaHooks
  markOrcaHookScriptConfirmed: (
    repoId: string,
    kind: OrcaHookScriptKind,
    contentHash: string
  ) => void
  markOrcaHookRepoAlwaysTrusted: (repoId: string) => void
  clearOrcaHookTrustForRepo: (repoId: string) => void
  setupScriptPromptDismissedRepoIds: readonly string[]
  dismissSetupScriptPrompt: (repoHostIdentity: string) => void
  setupGuideSidebarDismissed: boolean
  setSetupGuideSidebarDismissed: (dismissed: boolean) => void
  setupGuideBrowserMilestoneMigrated: boolean
  setupGuideBrowserMilestoneLegacyComplete: boolean
  markSetupGuideBrowserMilestoneMigrated: (legacyComplete: boolean) => void
  browserImportHintHidden: boolean
  setBrowserImportHintHidden: (hidden: boolean) => void
  mobileEmulatorTabIntroDismissed: boolean
  dismissMobileEmulatorTabIntro: () => void
  mobileEmulatorAgentSetupDismissed: boolean
  dismissMobileEmulatorAgentSetup: () => void
  projectOrderManualDefaultNoticeDismissed: boolean
  dismissProjectOrderManualDefaultNotice: () => void
  usagePercentageDisplayChangeNoticeDismissed: boolean
  dismissUsagePercentageDisplayChangeNotice: () => void
  usageEmptyStateDismissed: boolean
  dismissUsageEmptyState: () => void
  updateStatus: UpdateStatus
  setUpdateStatus: (status: UpdateStatus) => void
  // Why: cache last-'available' changelog so the card keeps rich content while downloading; cleared on idle/checking to avoid staleness.
  updateChangelog: ChangelogData | null
  // Why: UpdateCard is lazy-loaded and may miss the transient checking status; hold manual-check intent until a terminal state consumes it.
  updateUserInitiatedCycle: boolean
  dismissedUpdateVersion: string | null
  clearDismissedUpdateVersion: () => void
  /** Dev-only channel override; null follows the running build's own channel. */
  releaseChannelOverride: ReleaseChannel | null
  setReleaseChannelOverride: (channel: ReleaseChannel | null) => void
  // Why: ephemeral, renderer-only — never persisted; resets each session and on every phase transition (see setUpdateStatus).
  dismissUpdate: (versionOverride?: string) => void
  updateCardCollapsed: boolean
  setUpdateCardCollapsed: (collapsed: boolean) => void
  updateReassuranceSeen: boolean
  markUpdateReassuranceSeen: () => void
  /** True on the launch where the OSC 52 default-on migration overrode a persisted `false`. */
  osc52ClipboardDefaultOnNoticePending: boolean
  clearOsc52ClipboardDefaultOnNotice: () => void
  isFullScreen: boolean
  setIsFullScreen: (v: boolean) => void
  /** URL opened when a new browser tab is created. Null = blank tab (default). */
  browserDefaultUrl: string | null
  setBrowserDefaultUrl: (url: string | null) => void
  browserDefaultSearchEngine: 'google' | 'duckduckgo' | 'bing' | 'kagi' | null
  setBrowserDefaultSearchEngine: (engine: 'google' | 'duckduckgo' | 'bing' | 'kagi' | null) => void
  browserDefaultZoomLevel: number
  setBrowserDefaultZoomLevel: (level: number) => void
  browserKagiSessionLink: string | null
  setBrowserKagiSessionLink: (link: string | null) => void
}

export const createUINoticesSlice: StateCreator<AppState, [], [], UINoticesSlice> = (set, get) => ({
  trustedOrcaHooks: {},
  markOrcaHookScriptConfirmed: (repoId, kind, contentHash) =>
    set((s) => {
      const existing = s.trustedOrcaHooks[repoId]
      const currentEntry = existing?.[kind]
      if (currentEntry?.contentHash === contentHash) {
        return s
      }
      const nextRepo = {
        ...existing,
        [kind]: { contentHash, approvedAt: Date.now() }
      }
      const next = { ...s.trustedOrcaHooks, [repoId]: nextRepo }
      window.api.ui.set({ trustedOrcaHooks: next }).catch(console.error)
      return { trustedOrcaHooks: next }
    }),
  markOrcaHookRepoAlwaysTrusted: (repoId) =>
    set((s) => {
      const existing = s.trustedOrcaHooks[repoId]
      if (existing?.all) {
        return s
      }
      const next = {
        ...s.trustedOrcaHooks,
        [repoId]: {
          ...existing,
          all: { approvedAt: Date.now() }
        }
      }
      window.api.ui.set({ trustedOrcaHooks: next }).catch(console.error)
      return { trustedOrcaHooks: next }
    }),
  clearOrcaHookTrustForRepo: (repoId) =>
    set((s) => {
      if (!(repoId in s.trustedOrcaHooks)) {
        return s
      }
      const next = { ...s.trustedOrcaHooks }
      delete next[repoId]
      window.api.ui.set({ trustedOrcaHooks: next }).catch(console.error)
      return { trustedOrcaHooks: next }
    }),
  setupScriptPromptDismissedRepoIds: [],
  dismissSetupScriptPrompt: (repoHostIdentity) =>
    set((s) => {
      const dismissalKey = getSetupScriptPromptDismissalKey(repoHostIdentity)
      if (!repoHostIdentity || s.setupScriptPromptDismissedRepoIds.includes(dismissalKey)) {
        return s
      }
      const next = [...s.setupScriptPromptDismissedRepoIds, dismissalKey]
      window.api.ui.set({ setupScriptPromptDismissedRepoIds: next }).catch(console.error)
      return { setupScriptPromptDismissedRepoIds: next }
    }),
  setupGuideSidebarDismissed: false,
  setSetupGuideSidebarDismissed: (dismissed) =>
    set((s) => {
      if (s.setupGuideSidebarDismissed === dismissed) {
        return s
      }
      window.api.ui.set({ setupGuideSidebarDismissed: dismissed }).catch(console.error)
      return { setupGuideSidebarDismissed: dismissed }
    }),
  setupGuideBrowserMilestoneMigrated: true,
  setupGuideBrowserMilestoneLegacyComplete: false,
  markSetupGuideBrowserMilestoneMigrated: (legacyComplete) =>
    set((s) => {
      if (
        s.setupGuideBrowserMilestoneMigrated &&
        s.setupGuideBrowserMilestoneLegacyComplete === legacyComplete
      ) {
        return s
      }
      const updates = {
        setupGuideBrowserMilestoneMigrated: true,
        setupGuideBrowserMilestoneLegacyComplete: legacyComplete
      }
      window.api.ui.set(updates).catch(console.error)
      return updates
    }),
  browserImportHintHidden: false,
  setBrowserImportHintHidden: (hidden) =>
    set((s) => {
      if (s.browserImportHintHidden === hidden) {
        return s
      }
      window.api.ui.set({ browserImportHintHidden: hidden }).catch(console.error)
      return { browserImportHintHidden: hidden }
    }),
  mobileEmulatorTabIntroDismissed: false,
  dismissMobileEmulatorTabIntro: () =>
    set((s) => {
      if (s.mobileEmulatorTabIntroDismissed) {
        return s
      }
      window.api.ui.set({ mobileEmulatorTabIntroDismissed: true }).catch(console.error)
      return { mobileEmulatorTabIntroDismissed: true }
    }),
  mobileEmulatorAgentSetupDismissed: false,
  dismissMobileEmulatorAgentSetup: () =>
    set((s) => {
      if (s.mobileEmulatorAgentSetupDismissed) {
        return s
      }
      window.api.ui.set({ mobileEmulatorAgentSetupDismissed: true }).catch(console.error)
      return { mobileEmulatorAgentSetupDismissed: true }
    }),
  projectOrderManualDefaultNoticeDismissed: true,
  dismissProjectOrderManualDefaultNotice: () =>
    set((s) => {
      if (s.projectOrderManualDefaultNoticeDismissed) {
        return s
      }
      window.api.ui.set({ projectOrderManualDefaultNoticeDismissed: true }).catch(console.error)
      return { projectOrderManualDefaultNoticeDismissed: true }
    }),
  // Why: default true so pre-hydration / new sessions never flash the change notice before persistence resolves.
  usagePercentageDisplayChangeNoticeDismissed: true,
  dismissUsagePercentageDisplayChangeNotice: () =>
    set((s) => {
      if (s.usagePercentageDisplayChangeNoticeDismissed) {
        return s
      }
      window.api.ui.set({ usagePercentageDisplayChangeNoticeDismissed: true }).catch(console.error)
      return { usagePercentageDisplayChangeNoticeDismissed: true }
    }),
  usageEmptyStateDismissed: false,
  dismissUsageEmptyState: () =>
    set((s) => {
      if (s.usageEmptyStateDismissed) {
        return s
      }
      window.api.ui.set({ usageEmptyStateDismissed: true }).catch(console.error)
      return { usageEmptyStateDismissed: true }
    }),

  updateStatus: { state: 'idle' },
  setUpdateStatus: (status) => {
    const prevState = get().updateStatus.state
    const update: Partial<
      Pick<
        UINoticesSlice,
        'updateStatus' | 'updateChangelog' | 'updateCardCollapsed' | 'updateUserInitiatedCycle'
      >
    > = {
      updateStatus: status
    }
    if (status.state === 'checking') {
      update.updateUserInitiatedCycle = status.userInitiated === true
    } else if (status.state === 'idle') {
      update.updateUserInitiatedCycle = false
    }
    if (status.state === 'available') {
      // Why: always overwrite (even with null) so a prior version's changelog can't leak into a later simple-mode update.
      update.updateChangelog = status.changelog ?? null
    } else if (
      status.state === 'idle' ||
      status.state === 'checking' ||
      status.state === 'not-available'
    ) {
      // Why: reset on cycle-boundary states so stale rich content from a previous cycle can't resurface.
      update.updateChangelog = null
    }
    // 'downloading'/'downloaded'/'error': leave updateChangelog untouched to keep the original 'available' content.
    if (status.state !== prevState) {
      // Why: re-surface the card on each phase transition so a collapsed `downloading` doesn't bury `downloaded`/`error`.
      update.updateCardCollapsed = false
    }
    set(update)
  },
  updateChangelog: null,
  updateUserInitiatedCycle: false,
  dismissedUpdateVersion: null,
  clearDismissedUpdateVersion: () => {
    set({ dismissedUpdateVersion: null })
  },
  releaseChannelOverride: null,
  setReleaseChannelOverride: (channel) => {
    void window.api.ui.set({ releaseChannelOverride: channel }).catch(console.error)
    set({ releaseChannelOverride: channel })
  },
  dismissUpdate: (versionOverride?: string) =>
    set((s) => {
      // Why: the 'error' variant has no version field, so the card passes it via versionOverride.
      const dismissedUpdateVersion =
        versionOverride ?? ('version' in s.updateStatus ? (s.updateStatus.version ?? null) : null)
      const activeNudgeId =
        'activeNudgeId' in s.updateStatus ? (s.updateStatus.activeNudgeId ?? null) : null
      // Why: persist dismissal so relaunch doesn't immediately re-show the same card until a newer release.
      void window.api.ui.set({ dismissedUpdateVersion }).catch(console.error)
      // Why: main can't otherwise tell an offered update was abandoned, which keeps a local-build session pinned and stalls background checks.
      void window.api.updater.dismissAvailableUpdate().catch(console.error)
      // Why: only consume the nudge campaign for cards from a nudge cycle, not ordinary dismissals.
      if (activeNudgeId) {
        void window.api.updater.dismissNudge().catch(console.error)
      }
      return { dismissedUpdateVersion, updateUserInitiatedCycle: false }
    }),
  updateCardCollapsed: false,
  setUpdateCardCollapsed: (collapsed) => set({ updateCardCollapsed: collapsed }),
  updateReassuranceSeen: false,
  markUpdateReassuranceSeen: () => {
    void window.api.ui.set({ updateReassuranceSeen: true }).catch(console.error)
    set({ updateReassuranceSeen: true })
  },
  osc52ClipboardDefaultOnNoticePending: false,
  clearOsc52ClipboardDefaultOnNotice: () => {
    // Why clear locally first: a failed persist must not re-toast this session. It will
    // re-arm on the next launch, which is the safe direction for a one-shot notice.
    set({ osc52ClipboardDefaultOnNoticePending: false })
    void window.api.ui.set({ osc52ClipboardDefaultOnNoticePending: false }).catch(console.error)
  },
  isFullScreen: false,
  setIsFullScreen: (v) => set({ isFullScreen: v }),
  browserDefaultUrl: null,
  setBrowserDefaultUrl: (url) => {
    void window.api.ui.set({ browserDefaultUrl: url }).catch(console.error)
    set({ browserDefaultUrl: url })
  },
  browserDefaultSearchEngine: null,
  setBrowserDefaultSearchEngine: (engine) => {
    void window.api.ui.set({ browserDefaultSearchEngine: engine }).catch(console.error)
    set({ browserDefaultSearchEngine: engine })
  },
  browserDefaultZoomLevel: DEFAULT_BROWSER_PAGE_ZOOM_LEVEL,
  setBrowserDefaultZoomLevel: (level) => {
    const normalized = normalizeBrowserPageZoomLevel(level)
    void window.api.ui.set({ browserDefaultZoomLevel: normalized }).catch(console.error)
    set({ browserDefaultZoomLevel: normalized })
  },
  browserKagiSessionLink: null,
  setBrowserKagiSessionLink: (link) => {
    const normalized = link ? normalizeKagiSessionLink(link) : null
    void window.api.ui.set({ browserKagiSessionLink: normalized }).catch(console.error)
    set({ browserKagiSessionLink: normalized })
  }
})

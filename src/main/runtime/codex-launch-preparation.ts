import type { AgentProviderSessionMetadata } from '../../shared/agent-session-resume'
import type { CodexSessionResumePreparation } from '../codex/codex-session-resume-home'
import { ensureRealHomeCodexHookState } from '../codex/codex-real-home-hook-install'
import { isAgentStatusHooksEnabled } from '../agent-hooks/managed-agent-hook-controls'
import type { CodexAccountSelectionTarget } from '../codex-accounts/runtime-selection'
import type { CodexHomeLaunchContext } from '../ipc/pty'
import { markCodexProjectTrusted } from '../agent-trust-presets'
import { getDefaultWslDistro } from '../wsl'
import { codexHookService } from '../codex/hook-service'
import { getOrcaManagedCodexHomePath, getSystemCodexHomePath } from '../codex/codex-home-paths'
import { prepareCodexAiVaultSessionResume } from '../codex/codex-ai-vault-session-resume'
import { prepareCodexSessionResume } from '../codex/codex-session-resume-preparation'
import { prepareLegacySharedCodexSessionResume } from '../codex/codex-legacy-session-resume'
import { ManagedCodexHomeTemporarilyUnavailableError } from '../codex-accounts/host-codex-managed-home-ownership'
import { resolveHostCodexSessionSourceHome } from '../codex/codex-session-source-home'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import type { createCodexSessionMigrationScheduler } from '../codex/codex-session-migration-scheduler'
import type { Store } from '../persistence'
import type { CodexRuntimeHomeService } from '../codex-accounts/runtime-home-service'

export type CodexLaunchPreparationDeps = {
  app: Electron.App
  getStore: () => Store | null
  getCodexRuntimeHome: () => CodexRuntimeHomeService | null
  getCodexSessionMigration: () => ReturnType<typeof createCodexSessionMigrationScheduler> | null
}

export function createCodexLaunchPreparation(deps: CodexLaunchPreparationDeps) {
  async function prepareCodexRuntimeHomeForLaunch(
    target?: CodexAccountSelectionTarget,
    launchEnv?: NodeJS.ProcessEnv,
    launchContext?: CodexHomeLaunchContext
  ): Promise<string | null> {
    const store = deps.getStore()
    const codexRuntimeHome = deps.getCodexRuntimeHome()
    if (
      target?.runtime !== 'wsl' &&
      launchContext?.launchAgent === 'codex' &&
      launchContext.workspacePath
    ) {
      try {
        // Why: renderer quick-launch cannot await trust IPC before its PTY mounts; launch prep runs before every recognized Codex spawn.
        await markCodexProjectTrusted(launchContext.workspacePath)
      } catch (error) {
        console.warn('[codex-project-trust] failed to pre-mark launch workspace:', error)
      }
    }
    const ensureRealHomeHooksIfSelected = async (): Promise<boolean> => {
      if (
        target?.runtime === 'wsl' ||
        !codexRuntimeHome!.isHostSystemDefaultRealHomeSelected(launchEnv)
      ) {
        return false
      }
      // Why (flag ON, system default): the hook entry must exist — appended last
      // and trusted by codex's own app-server grant — in the real ~/.codex before
      // the pane spawns. An incapable grant flips the lane gate so the launch
      // below falls back to the managed home instead of a status-blind pane.
      await ensureRealHomeCodexHookState({
        hooksEnabled: isAgentStatusHooksEnabled(store?.getSettings()),
        userDataPath: deps.app.getPath('userData')
      })
      return true
    }
    let realHomeHooksPrepared = await ensureRealHomeHooksIfSelected()
    // Why: a ManagedCodexHomeTemporarilyUnavailableError must escape uncaught —
    // the fallbacks below all key off `null`, which means "system default", so
    // swallowing the refusal would launch the wrong account (#STA-4422).
    let runtimeHomePath = codexRuntimeHome!.prepareForCodexLaunch(target, launchEnv, {
      unavailableManagedHomePath: launchContext?.unavailableManagedHomePath
    })
    if (runtimeHomePath === null && !realHomeHooksPrepared) {
      // Why: launch prep can reject an untrusted managed home and clear its
      // selection. Establish hook capability for that newly selected lane, then
      // re-resolve if the capability gate rejects it.
      realHomeHooksPrepared = await ensureRealHomeHooksIfSelected()
      if (realHomeHooksPrepared) {
        runtimeHomePath = codexRuntimeHome!.prepareForCodexLaunch(target, launchEnv, {
          unavailableManagedHomePath: launchContext?.unavailableManagedHomePath
        })
      }
    }
    if (runtimeHomePath === null && target?.runtime !== 'wsl') {
      // Why: Codex runs on the user's real ~/.codex; the managed-home hook
      // install below would target a home Codex never reads on this lane.
      return null
    }
    const hookTarget =
      target?.runtime === 'wsl'
        ? {
            runtime: 'wsl' as const,
            wslDistro: target.wslDistro?.trim() || getDefaultWslDistro()
          }
        : target
    const hooksEnabled = isAgentStatusHooksEnabled(store?.getSettings())
    try {
      // Why: honor the persisted off switch so post-startup launches can't reinstall removed hooks.
      const status = hooksEnabled
        ? ((await codexHookService.installForRuntimeHome(runtimeHomePath, hookTarget)) ??
          // Why: a managed account's launch home is its own self-contained
          // CODEX_HOME, so hooks/trust must install there, not the shared mirror.
          (await codexHookService.install(runtimeHomePath ?? undefined)))
        : (codexHookService.refreshRuntimeUserHooksForRuntimeHome(runtimeHomePath, hookTarget) ??
          (await codexHookService.refreshRuntimeUserHooks(runtimeHomePath ?? undefined)))
      if (status.state === 'error') {
        console.warn(
          `[codex-hook-service] failed to ${
            hooksEnabled ? 'refresh' : 'refresh user'
          } runtime hooks before launch`,
          status.detail
        )
      }
    } catch (error) {
      // Why: hook install is best-effort launch prep; a malformed hooks file must not block Codex from starting.
      console.warn(
        `[codex-hook-service] failed to ${
          hooksEnabled ? 'refresh' : 'refresh user'
        } runtime hooks before launch`,
        error
      )
    }
    return runtimeHomePath
  }

  async function prepareCodexSessionResumeForLaunch(args: {
    providerSession: AgentProviderSessionMetadata
    target: CodexAccountSelectionTarget
    launchEnv?: NodeJS.ProcessEnv
    workspacePath?: string
  }): Promise<CodexSessionResumePreparation | null> {
    const codexRuntimeHome = deps.getCodexRuntimeHome()
    const store = deps.getStore()
    if (args.target.runtime === 'wsl' || !codexRuntimeHome || !store) {
      return null
    }
    const systemHomePath = getSystemCodexHomePath()
    // Why: codexSessionSourceHome is import-only; treating it as CODEX_HOME would mutate history sources and bypass account auth.
    const trustedHomes = [
      systemHomePath,
      ...codexRuntimeHome.getHostCodexHomePathsForSessionDiscovery()
    ]
    const settingsStore = store
    // Why: resolved eagerly, once, before any ranking or provenance match. The
    // marker read used to be deferred into the ranking thunk so a
    // provenance-present resume never paid for it, but that optimisation let an
    // unreadable selected home reach the PTY as "no selection": the provenance
    // branch simply omits the account from `trustedHomes` and another account's
    // readable alias wins. A throw here refuses the whole resume instead
    // (#STA-4422).
    const selectedAccountCodexHome =
      codexRuntimeHome.resolveSelectedHostAccountCodexHomePathForResume()
    // Why: a `fresh` outcome must skip migration, trust and hook repair entirely — there is
    // no verified origin home to prepare, so the PTY layer drops the resume argv (#10793).
    const preparation = await prepareCodexSessionResume({
      sessionId: args.providerSession.id,
      transcriptPath: args.providerSession.transcriptPath,
      trustedCodexHomes: trustedHomes,
      // Why: the legacy id rescan's winning home becomes this pane's CODEX_HOME, i.e. its account;
      // rank it by the current selection so settings insertion order can never decide the account.
      getSelectedAccountCodexHome: () => selectedAccountCodexHome,
      systemCodexHomePath: systemHomePath,
      // Why: the mirror winning is what triggers the migration into ~/.codex below, so it must
      // outrank the path-sorted account homes or a system-default selection resumes as an account.
      sharedRuntimeCodexHomePath: getOrcaManagedCodexHomePath(),
      resolveVerifiedResumeHome: async (sessionSource) => {
        let migrated = { useRealCodexHome: false }
        try {
          migrated = await prepareLegacySharedCodexSessionResume(
            {
              agent: 'codex',
              executionHostId: 'local',
              filePath: sessionSource.transcriptPath,
              codexHome: sessionSource.homePath
            },
            {
              isHostSystemDefaultRealHome: () => codexRuntimeHome!.isHostSystemDefaultRealHome(),
              systemCodexHomePath: systemHomePath
            }
          )
        } catch (error) {
          // Why: this launch path pins CODEX_HOME to the account that OWNS the
          // rollout and deliberately refuses to repin onto whichever account is
          // selected now (#10793), so it does not wire
          // getSelectedHostAccountCodexHomePath and this branch cannot fire today.
          // It stays as a contract guard: the blanket catch below must never
          // silently swallow a typed refusal if that ever changes.
          if (error instanceof ManagedCodexHomeTemporarilyUnavailableError) {
            throw error
          }
          // Why: migration is a compatibility repair; its failure must not prevent the PTY from resuming from its trusted origin home.
          console.warn(
            '[codex-session-resume] Legacy rollout migration failed; using origin home:',
            error
          )
        }
        const resumeHome = migrated.useRealCodexHome ? systemHomePath : sessionSource.homePath

        if (args.workspacePath) {
          try {
            await markCodexProjectTrusted(args.workspacePath)
          } catch (error) {
            console.warn('[codex-project-trust] failed to pre-mark resumed workspace:', error)
          }
        }
        const isSystemHome =
          normalizeRuntimePathForComparison(resumeHome) ===
          normalizeRuntimePathForComparison(systemHomePath)
        const hooksEnabled = isAgentStatusHooksEnabled(settingsStore.getSettings())
        try {
          if (isSystemHome) {
            await ensureRealHomeCodexHookState({
              hooksEnabled,
              userDataPath: deps.app.getPath('userData')
            })
          } else if (hooksEnabled) {
            await codexHookService.install(resumeHome)
          } else {
            await codexHookService.refreshRuntimeUserHooks(resumeHome)
          }
        } catch (error) {
          // Why: hook repair is best-effort; session provenance must still win over the currently selected home.
          console.warn('[codex-hook-service] failed to prepare automatic resume home:', error)
        }
        return resumeHome
      }
    })
    return preparation.outcome === 'resume'
      ? {
          ...preparation,
          reconcileSharedRuntimeAuth:
            normalizeRuntimePathForComparison(preparation.codexHomePath) ===
            normalizeRuntimePathForComparison(getOrcaManagedCodexHomePath())
        }
      : preparation
  }

  function prepareAiVaultSessionResume(
    args: Parameters<typeof prepareCodexAiVaultSessionResume>[0]
  ) {
    return prepareCodexAiVaultSessionResume(args, {
      runtimeHome: deps.getCodexRuntimeHome(),
      systemCodexHomePath: resolveHostCodexSessionSourceHome(deps.getStore()!.getSettings())
    })
  }

  return {
    prepareCodexRuntimeHomeForLaunch,
    prepareCodexSessionResumeForLaunch,
    prepareAiVaultSessionResume
  }
}

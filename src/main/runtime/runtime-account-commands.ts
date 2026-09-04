import type {
  ClaudeRateLimitAccountsState,
  CodexRateLimitAccountsState
} from '../../shared/managed-account-types'
import type { CodexAccountSelectionTarget } from '../codex-accounts/runtime-selection'
import type { CodexRateLimitResetOutcome, RateLimitState } from '../../shared/rate-limit-types'
import type { CodexResetCreditExpectedScope } from '../../shared/codex-reset-credit-scope'
import type { ClaudeAccountService } from '../claude-accounts/service'
import type {
  CodexAccountService,
  CodexRateLimitResetRpcResult as _CodexRateLimitResetRpcResult
} from '../codex-accounts/service'
import type { RateLimitService } from '../rate-limits/service'

// ─── RuntimeAccountServices and AccountsSnapshot ─────────────────────────────
// Type definitions matching those in orca-runtime.ts for the account facade.

export type RuntimeAccountServices = {
  claudeAccounts: ClaudeAccountService
  codexAccounts: CodexAccountService
  rateLimits: RateLimitService
}

export type AccountsSnapshot = {
  claude: ClaudeRateLimitAccountsState
  codex: CodexRateLimitAccountsState
  rateLimits: RateLimitState
}

export type CodexRateLimitResetRpcResult = {
  scope: CodexResetCreditExpectedScope
  snapshot: AccountsSnapshot
} & (
  | { outcome: CodexRateLimitResetOutcome }
  | {
      status: 'rejectedBeforeProvider'
      retryDisposition: 'discardAttempt'
      reason: string
    }
)

// ─── RuntimeAccountCommands Facade ─────────────────────────────────────────────

export class RuntimeAccountCommands {
  private accountServices: RuntimeAccountServices | null = null

  setAccountServices(services: RuntimeAccountServices): void {
    this.accountServices = services
  }

  // Why: sibling facades (RuntimeSkillArtifactCommands, RuntimeSkillInstallCommands)
  // receive a lazy accessor for the underlying services so they can short-circuit
  // when no account services are configured. Keep returning the same instance until
  // setAccountServices replaces it.
  getAccountServices(): RuntimeAccountServices | null {
    return this.accountServices
  }

  private requireAccountServices(): RuntimeAccountServices {
    if (!this.accountServices) {
      throw new Error('Account services are not configured on this runtime')
    }
    return this.accountServices
  }

  getAccountsSnapshot(): AccountsSnapshot {
    const { claudeAccounts, codexAccounts, rateLimits } = this.requireAccountServices()
    return {
      claude: claudeAccounts.listAccounts(),
      codex: codexAccounts.listAccounts(),
      rateLimits: rateLimits.getState()
    }
  }

  // Why: RateLimitService polls only when the Electron window is visible AND
  // focused, and the inactive-account caches fill lazily when the user opens
  // the desktop AccountsPane. Mobile has neither trigger, so without this the
  // phone shows 0% / "—" against a backgrounded desktop. Errors swallowed
  // because partial usage is still useful for the rest of the snapshot.
  async refreshAccountsForMobile(): Promise<void> {
    const { rateLimits } = this.requireAccountServices()
    await Promise.allSettled([
      rateLimits.refresh(),
      rateLimits.fetchInactiveClaudeAccountsOnOpen(),
      rateLimits.fetchInactiveCodexAccountsOnOpen()
    ])
  }

  // Why: connection migration replays subscriptions; use the stale-aware lane
  // so a reconnect cannot turn one mobile viewer into continuous forced fetches.
  async refreshAccountsForMobileSubscriber(): Promise<void> {
    const { rateLimits } = this.requireAccountServices()
    await Promise.allSettled([
      rateLimits.refreshIfStale(),
      rateLimits.fetchInactiveClaudeAccountsOnOpen(),
      rateLimits.fetchInactiveCodexAccountsOnOpen()
    ])
  }

  selectClaudeAccount(accountId: string | null): Promise<ClaudeRateLimitAccountsState> {
    return this.requireAccountServices().claudeAccounts.selectAccount(accountId)
  }

  selectCodexAccount(accountId: string | null): Promise<CodexRateLimitAccountsState> {
    return this.requireAccountServices().codexAccounts.selectAccount(accountId)
  }

  selectCodexAccountForTarget(
    accountId: string | null,
    target: CodexAccountSelectionTarget
  ): Promise<CodexRateLimitAccountsState> {
    return this.requireAccountServices().codexAccounts.selectAccountForTarget(accountId, target)
  }

  async consumeCodexRateLimitResetCredit(
    idempotencyKey: string,
    expectedScope: CodexResetCreditExpectedScope
  ): Promise<CodexRateLimitResetRpcResult> {
    const { claudeAccounts, codexAccounts } = this.requireAccountServices()
    const result = await codexAccounts.consumeRateLimitResetCredit(idempotencyKey, expectedScope)
    // Why: Codex selection and usage were captured before its mutation queue
    // advanced. Re-reading them here could pair scope A with queued selection B.
    const snapshot = {
      claude: claudeAccounts.listAccounts(),
      codex: result.codex,
      rateLimits: result.rateLimits
    }
    if ('status' in result) {
      return {
        status: result.status,
        retryDisposition: result.retryDisposition,
        reason: result.reason,
        scope: result.scope,
        snapshot
      }
    }
    return {
      outcome: result.outcome,
      scope: result.scope,
      snapshot
    }
  }

  removeClaudeAccount(accountId: string): Promise<ClaudeRateLimitAccountsState> {
    return this.requireAccountServices().claudeAccounts.removeAccount(accountId)
  }

  // Why: register a managed Claude account from a CLAUDE_CONFIG_DIR the caller
  // already logged into. Lets the `orca account add` CLI drive `claude login` in
  // the user's terminal on a headless host, then capture the credentials here —
  // the desktop GUI's interactive add flow is unreachable over a remote runtime.
  addClaudeAccountFromConfigDir(
    configDir: string,
    options?: {
      runtime?: 'host' | 'wsl'
      wslDistro?: string | null
      previousLegacyCredentialsSha256?: string | null
    }
  ): Promise<ClaudeRateLimitAccountsState> {
    return this.requireAccountServices().claudeAccounts.addAccountFromConfigDir(configDir, options)
  }

  removeCodexAccount(accountId: string): Promise<CodexRateLimitAccountsState> {
    return this.requireAccountServices().codexAccounts.removeAccount(accountId)
  }

  // Why: Codex counterpart of addClaudeAccountFromConfigDir — register a managed
  // Codex account from a CODEX_HOME the caller already logged into, so headless
  // hosts can add accounts via `orca account add --agent codex`.
  addCodexAccountFromHome(
    sourceHome: string,
    target?: { runtime?: 'host' | 'wsl'; wslDistro?: string | null }
  ): Promise<CodexRateLimitAccountsState> {
    return this.requireAccountServices().codexAccounts.addAccountFromHome(sourceHome, target)
  }

  // Why: rate-limit polling fires every 5 minutes and on account switch.
  // Mobile clients subscribe to receive a fresh AccountsSnapshot whenever
  // RateLimitService pushes new usage data, mirroring the existing
  // `rateLimits:update` IPC channel desktop already uses.
  onAccountsChanged(listener: (snapshot: AccountsSnapshot) => void): () => void {
    const services = this.requireAccountServices()
    return services.rateLimits.onStateChange((rateLimits) => {
      listener({
        claude: services.claudeAccounts.listAccounts(),
        codex: services.codexAccounts.listAccounts(),
        rateLimits
      })
    })
  }
}

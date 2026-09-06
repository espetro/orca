/* eslint-disable max-lines -- Why: Claude/Codex switchers + shared provider details menu moved verbatim from StatusBar.tsx; one cohesive concern. */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Loader2, RotateCcw } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Checkbox } from '@/components/ui/checkbox'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '../../store'
import { getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import {
  fetchProviderAccountsSnapshot,
  selectClaudeProviderAccount,
  selectCodexProviderAccount
} from '@/runtime/runtime-provider-accounts-client'
import {
  getWindowsTerminalCapabilityOwnerKey,
  useWindowsTerminalCapabilities
} from '@/lib/windows-terminal-capabilities'
import {
  markLiveCodexSessionsForRestart,
  resolveCodexRestartPromptAccountLabel
} from '@/lib/codex-session-restart'
import { ProviderPanel, formatResetCreditExpiry } from './tooltip'
import { STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS } from './status-bar-context-menu-policy'
import { normalizeUsagePercentageDisplay } from '../../../../shared/usage-percentage-display'
import {
  buildClaudeStatusSwitchGroups,
  buildCodexStatusSwitchGroups,
  getCodexStatusActiveId,
  getCodexStatusRuntimeKey,
  getStatusBarPreferredWslDistro,
  normalizeClaudeStatusRuntimeTarget,
  normalizeCodexStatusRuntimeTarget,
  resolveClaudeStatusAccountState,
  resolveCodexStatusAccountState,
  shouldIncludeSettingsWslRuntime,
  toCodexStatusRuntimeTarget,
  type ClaudeStatusSwitchGroup,
  type CodexStatusRuntimeTarget,
  type CodexStatusSwitchGroup
} from './provider-runtime-switch-groups'
import {
  InlineUsageBars,
  InlineUsageSignInAction,
  InlineUsageSkeleton,
  ProviderLetterBadge,
  ProviderSegment,
  isUnavailableInactiveUsage
} from './provider-usage-display'
import { useStatusBarMenuFocusHandoff } from './menu-focus-handoff'
import { summarizeCodexRestartStatus } from './codex-restart-status-summary'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import type {
  ClaudeRateLimitAccountsState,
  CodexRateLimitAccountsState
} from '../../../../shared/managed-account-types'

function CodexRestartStatusPrompt(): React.JSX.Element | null {
  const tabsByWorktree = useAppStore((s) => s.tabsByWorktree)
  const ptyIdsByTabId = useAppStore((s) => s.ptyIdsByTabId)
  const codexRestartNoticeByPtyId = useAppStore((s) => s.codexRestartNoticeByPtyId)
  const queueCodexPaneRestarts = useAppStore((s) => s.queueCodexPaneRestarts)

  const staleCodexStatus = useMemo(
    () =>
      summarizeCodexRestartStatus({
        tabsByWorktree,
        ptyIdsByTabId,
        codexRestartNoticeByPtyId
      }),
    [codexRestartNoticeByPtyId, ptyIdsByTabId, tabsByWorktree]
  )

  if (staleCodexStatus.staleTabCount === 0) {
    return null
  }

  return (
    <>
      <DropdownMenuSeparator />
      <div className="px-2 py-2">
        <div className="text-[11px] text-muted-foreground">
          {/* Why: notices are per-PTY-session but restart is per-pane; show both counts so split panes don't look wrong. */}
          {staleCodexStatus.staleSessionCount === 1
            ? translate(
                'auto.components.status.bar.StatusBar.605901a495',
                '1 Codex session is still on the old account'
              )
            : translate(
                'auto.components.status.bar.StatusBar.1446d0d8a0',
                '{{value0}} Codex sessions are still on the old account.',
                { value0: staleCodexStatus.staleSessionCount }
              )}
          {staleCodexStatus.staleWorktreeCount > 1 ? (
            <span className="mt-0.5 block">
              {translate(
                'auto.components.status.bar.StatusBar.59c6e7b4e0',
                'Visible sessions restart now. Others restart when their worktree becomes active.'
              )}
            </span>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => queueCodexPaneRestarts(staleCodexStatus.stalePtyIds)}
          className="mt-2 inline-flex w-full items-center justify-center rounded-md border border-border/70 px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent/60"
        >
          {staleCodexStatus.staleSessionCount === 1
            ? translate('auto.components.status.bar.StatusBar.6cd6650b4c', 'Restart Session')
            : translate(
                'auto.components.status.bar.StatusBar.cd9d7b40ff',
                'Restart {{value0}} Sessions',
                { value0: staleCodexStatus.staleSessionCount }
              )}
        </button>
      </div>
    </>
  )
}
function AccountRuntimeToggle<TGroup extends { key: string; label: string }>({
  groups,
  value,
  onChange,
  ariaLabel
}: {
  groups: TGroup[]
  value: string
  onChange: (group: TGroup) => void
  ariaLabel: string
}): React.JSX.Element | null {
  if (groups.length <= 1) {
    return null
  }

  return (
    <div className="px-2 pt-2">
      <div
        role="radiogroup"
        aria-label={ariaLabel}
        className="inline-flex w-full items-center rounded-md border border-border bg-background/50 p-0.5"
      >
        {groups.map((group) => {
          const active = group.key === value
          return (
            <button
              key={group.key}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onChange(group)}
              className={`min-w-0 flex-1 rounded-sm px-2 py-1 text-center text-xs outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 ${
                active
                  ? 'bg-accent font-medium text-accent-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <span className="block truncate">{group.label}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
// Exported so its account-switch/reset logic is preserved for row drill-in even
// though the footer now opens the consolidated UsageRosterPanel first.
export function ClaudeSwitcherMenu({
  claude,
  compact,
  iconOnly,
  asSubmenu = false,
  triggerContent
}: {
  claude: ProviderRateLimits
  compact: boolean
  iconOnly: boolean
  asSubmenu?: boolean
  triggerContent?: React.ReactNode
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [accountsExpanded, setAccountsExpanded] = useState(false)
  const [accounts, setAccounts] = useState<ClaudeRateLimitAccountsState>({
    accounts: [],
    activeAccountId: null,
    activeAccountIdsByRuntime: { host: null, wsl: {} }
  })
  const [isSwitching, setIsSwitching] = useState(false)
  const mountedRef = useRef(true)
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const fetchSettings = useAppStore((s) => s.fetchSettings)
  const recordFeatureInteraction = useAppStore((s) => s.recordFeatureInteraction)
  const refreshClaudeRateLimitsForTarget = useAppStore((s) => s.refreshClaudeRateLimitsForTarget)
  const fetchInactiveClaudeAccountUsage = useAppStore((s) => s.fetchInactiveClaudeAccountUsage)
  const inactiveClaudeAccounts = useAppStore((s) => s.rateLimits.inactiveClaudeAccounts)
  const claudeTarget = useAppStore((s) => s.rateLimits.claudeTarget)
  const settings = useAppStore((s) => s.settings)
  const runtimeEnvironments = useAppStore((s) => s.runtimeEnvironments)
  const hasActiveRuntimeEnvironment = Boolean(settings?.activeRuntimeEnvironmentId?.trim())
  const runtimeTarget = useMemo(() => getActiveRuntimeTarget(settings), [settings])
  const providerAccountHostLabel = hasActiveRuntimeEnvironment
    ? (runtimeEnvironments.find(
        (environment) => environment.id === settings?.activeRuntimeEnvironmentId?.trim()
      )?.name ??
      translate('auto.components.status.bar.StatusBar.remoteServerLabel', 'Remote server'))
    : undefined
  const windowsTerminalCapabilities = useWindowsTerminalCapabilities(
    navigator.userAgent.includes('Windows') || hasActiveRuntimeEnvironment,
    false,
    getWindowsTerminalCapabilityOwnerKey(settings?.activeRuntimeEnvironmentId),
    runtimeTarget
  )
  const claudeAccountSyncKey = useAppStore((s) => {
    const settings = s.settings
    if (!settings) {
      return 'no-settings'
    }
    return `${settings.activeRuntimeEnvironmentId?.trim() || 'local'}:${settings.activeClaudeManagedAccountId ?? 'system'}:${JSON.stringify(settings.activeClaudeManagedAccountIdsByRuntime ?? null)}:${settings.claudeManagedAccounts.map((account) => `${account.id}:${account.updatedAt}`).join('|')}`
  })
  const accountState = resolveClaudeStatusAccountState(settings, accounts)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const activeRuntimeEnvironmentId = settings?.activeRuntimeEnvironmentId?.trim() || null
  // Why: keyed on owner id, not settings identity, so routine settings mutations don't re-run the remote snapshot fetch.
  const loadAccounts = useCallback(async () => {
    const snapshot = await fetchProviderAccountsSnapshot({ activeRuntimeEnvironmentId })
    // Why: a failed Claude half is a substituted empty roster; keep prior state.
    if (snapshot.failedProviders?.includes('claude')) {
      console.error('Claude account list failed; keeping previous status bar state.')
      return
    }
    if (mountedRef.current) {
      setAccounts(snapshot.claude)
    }
  }, [activeRuntimeEnvironmentId])

  useEffect(() => {
    void loadAccounts().catch((error) => {
      console.error('Failed to load Claude accounts for status bar:', error)
    })
  }, [loadAccounts, claudeAccountSyncKey])

  const handleOpenChange = useCallback((nextOpen: boolean): void => {
    setOpen(nextOpen)
    if (!nextOpen) {
      setAccountsExpanded(false)
    }
  }, [])

  // Why: fetch inactive-account usage only on switcher expansion; remote-owned accounts have no local cache to fill.
  const handleAccountsExpandedToggle = useCallback((): void => {
    const nextExpanded = !accountsExpanded
    setAccountsExpanded(nextExpanded)
    if (nextExpanded && !hasActiveRuntimeEnvironment) {
      void fetchInactiveClaudeAccountUsage()
    }
  }, [accountsExpanded, fetchInactiveClaudeAccountUsage, hasActiveRuntimeEnvironment])

  const handleSelectAccount = async (
    accountId: string | null,
    target: CodexStatusRuntimeTarget
  ): Promise<void> => {
    if (isSwitching) {
      return
    }
    setIsSwitching(true)
    try {
      const next = await selectClaudeProviderAccount(settings, {
        accountId,
        runtime: target.runtime,
        wslDistro: target.wslDistro
      })
      recordFeatureInteraction('claude-account-switching')
      if (mountedRef.current) {
        setAccounts(next)
      }
      // Why: remote selections live on the server; local GlobalSettings are untouched, so refetching is pure churn.
      if (!hasActiveRuntimeEnvironment) {
        await fetchSettings()
      }
      if (mountedRef.current) {
        setAccountsExpanded(false)
      }
    } catch (error) {
      console.error('Failed to switch Claude account from status bar:', error)
    } finally {
      if (mountedRef.current) {
        setIsSwitching(false)
      }
    }
  }

  const handleSelectRuntime = async (group: ClaudeStatusSwitchGroup): Promise<void> => {
    const currentKey = getCodexStatusRuntimeKey(
      normalizeClaudeStatusRuntimeTarget(accountState, toCodexStatusRuntimeTarget(claudeTarget))
    )
    if (group.key === currentKey) {
      return
    }
    setAccountsExpanded(false)
    try {
      await refreshClaudeRateLimitsForTarget(group.runtimeTarget)
    } catch (error) {
      console.error('Failed to switch Claude usage runtime:', error)
    }
  }

  const selectedRuntimeKey = getCodexStatusRuntimeKey(
    normalizeClaudeStatusRuntimeTarget(accountState, toCodexStatusRuntimeTarget(claudeTarget))
  )
  const fallbackWslDistro = getStatusBarPreferredWslDistro(
    settings,
    windowsTerminalCapabilities.wslDistros
  )
  const switchGroups = buildClaudeStatusSwitchGroups(
    accountState,
    toCodexStatusRuntimeTarget(claudeTarget),
    {
      fallbackWslDistro,
      includeFallbackWsl: !hasActiveRuntimeEnvironment && shouldIncludeSettingsWslRuntime(settings),
      hostLabel: providerAccountHostLabel
    }
  )
  const selectedGroup =
    switchGroups.find((group) => group.key === selectedRuntimeKey) ?? switchGroups[0]
  const activeTarget = selectedGroup?.targets.find((target) => target.active)

  return (
    <ProviderDetailsMenu
      provider={claude}
      compact={compact}
      iconOnly={iconOnly}
      asSubmenu={asSubmenu}
      triggerContent={triggerContent}
      ariaLabel={translate(
        'auto.components.status.bar.StatusBar.3dd7ddfae1',
        'Open Claude details and account switcher'
      )}
      topContent={
        <AccountRuntimeToggle
          groups={switchGroups}
          value={selectedGroup?.key ?? selectedRuntimeKey}
          onChange={(group) => void handleSelectRuntime(group)}
          ariaLabel={translate(
            'auto.components.status.bar.StatusBar.11e2354daf',
            'Claude usage runtime'
          )}
        />
      }
      open={open}
      onOpenChange={handleOpenChange}
    >
      <DropdownMenuLabel>
        {translate('auto.components.status.bar.StatusBar.d450654fa2', 'Claude Account')}
      </DropdownMenuLabel>
      <DropdownMenuItem
        onSelect={(event) => {
          event.preventDefault()
          handleAccountsExpandedToggle()
        }}
      >
        <span className="max-w-[180px] truncate text-[12px] text-foreground">
          {activeTarget?.label ??
            translate('auto.components.status.bar.StatusBar.c676918adc', 'System default')}
        </span>
        {accountsExpanded ? (
          <ChevronDown className="ml-auto size-3.5 text-muted-foreground/85" />
        ) : (
          <ChevronRight className="ml-auto size-3.5 text-muted-foreground/85" />
        )}
      </DropdownMenuItem>
      {accountsExpanded ? (
        <div className="px-1 pb-1">
          <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
            {translate('auto.components.status.bar.StatusBar.9332ba8684', 'Switch to')}
          </div>
          <div className="max-h-[220px] overflow-y-auto rounded-md border border-border/60 bg-accent/5 p-1 scrollbar-sleek">
            {selectedGroup?.targets.length === 0 ? (
              <div className="px-2 py-1.5 text-[11px] text-muted-foreground">
                {translate('auto.components.status.bar.StatusBar.c98ea88392', 'No other accounts')}
              </div>
            ) : null}
            {selectedGroup?.targets.map((target) => {
              const inactiveUsage = target.id
                ? inactiveClaudeAccounts.find((a) => a.accountId === target.id)
                : null

              return (
                <DropdownMenuItem
                  key={`${selectedGroup.key}:${target.id ?? 'system'}`}
                  disabled={isSwitching || target.active}
                  onSelect={(event) => {
                    event.preventDefault()
                    if (!target.active) {
                      void handleSelectAccount(target.id, target.runtimeTarget)
                    }
                  }}
                >
                  <div className="flex w-full flex-col gap-0.5">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="min-w-0 flex-1 truncate">{target.label}</span>
                      {target.active ? (
                        <span className="shrink-0 text-[10px] font-medium text-muted-foreground">
                          {translate('auto.components.status.bar.StatusBar.ff0fbe9311', 'Active')}
                        </span>
                      ) : null}
                    </div>
                    {inactiveUsage?.isFetching && !inactiveUsage.rateLimits ? (
                      <InlineUsageSkeleton />
                    ) : inactiveUsage?.rateLimits ? (
                      <InlineUsageBars
                        limits={inactiveUsage.rateLimits}
                        isFetching={inactiveUsage.isFetching}
                      />
                    ) : null}
                  </div>
                </DropdownMenuItem>
              )
            })}
          </div>
          <div className="px-2 py-1.5 text-[10px] leading-4 text-muted-foreground">
            {translate(
              'auto.components.status.bar.StatusBar.8295903d17',
              'Restart live Claude terminals before continuing old conversations after switching.'
            )}
          </div>
        </div>
      ) : null}
      <DropdownMenuSeparator />
      <DropdownMenuItem
        onSelect={() => {
          openSettingsTarget({
            pane: 'accounts',
            repoId: null,
            sectionId: 'accounts-claude'
          })
          openSettingsPage()
        }}
      >
        {translate('auto.components.status.bar.StatusBar.75ded02687', 'Manage Accounts…')}
      </DropdownMenuItem>
    </ProviderDetailsMenu>
  )
}
export function CodexSwitcherMenu({
  codex,
  compact,
  iconOnly,
  asSubmenu = false,
  triggerContent
}: {
  codex: ProviderRateLimits
  compact: boolean
  iconOnly: boolean
  asSubmenu?: boolean
  triggerContent?: React.ReactNode
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [accountsExpanded, setAccountsExpanded] = useState(false)
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false)
  const [skipFutureResetConfirm, setSkipFutureResetConfirm] = useState(false)
  const [accounts, setAccounts] = useState<CodexRateLimitAccountsState>({
    accounts: [],
    activeAccountId: null
  })
  const [isSwitching, setIsSwitching] = useState(false)
  const [isRedeemingReset, setIsRedeemingReset] = useState(false)
  const [reauthenticatingAccountId, setReauthenticatingAccountId] = useState<string | null>(null)
  const mountedRef = useRef(true)
  const accountsExpandedRef = useRef(accountsExpanded)
  // Why: Radix item-select is separate from the nested button click, so stopPropagation alone won't prevent the row switch.
  const suppressNextAccountSelectRef = useRef(false)
  const suppressNextAccountSelect = useCallback(() => {
    suppressNextAccountSelectRef.current = true
    window.setTimeout(() => {
      suppressNextAccountSelectRef.current = false
    }, 0)
  }, [])
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const fetchSettings = useAppStore((s) => s.fetchSettings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const recordFeatureInteraction = useAppStore((s) => s.recordFeatureInteraction)
  const refreshCodexRateLimitsForTarget = useAppStore((s) => s.refreshCodexRateLimitsForTarget)
  const consumeCodexRateLimitResetCredit = useAppStore((s) => s.consumeCodexRateLimitResetCredit)
  const fetchInactiveCodexAccountUsage = useAppStore((s) => s.fetchInactiveCodexAccountUsage)
  const inactiveCodexAccounts = useAppStore((s) => s.rateLimits.inactiveCodexAccounts)
  const codexTarget = useAppStore((s) => s.rateLimits.codexTarget)
  const settings = useAppStore((s) => s.settings)
  const runtimeEnvironments = useAppStore((s) => s.runtimeEnvironments)
  const hasActiveRuntimeEnvironment = Boolean(settings?.activeRuntimeEnvironmentId?.trim())
  const runtimeTarget = useMemo(() => getActiveRuntimeTarget(settings), [settings])
  const providerAccountHostLabel = hasActiveRuntimeEnvironment
    ? (runtimeEnvironments.find(
        (environment) => environment.id === settings?.activeRuntimeEnvironmentId?.trim()
      )?.name ??
      translate('auto.components.status.bar.StatusBar.remoteServerLabel', 'Remote server'))
    : undefined
  const windowsTerminalCapabilities = useWindowsTerminalCapabilities(
    navigator.userAgent.includes('Windows') || hasActiveRuntimeEnvironment,
    false,
    getWindowsTerminalCapabilityOwnerKey(settings?.activeRuntimeEnvironmentId),
    runtimeTarget
  )
  const codexAccountSyncKey = useAppStore((s) => {
    const settings = s.settings
    if (!settings) {
      return 'no-settings'
    }
    return `${settings.activeRuntimeEnvironmentId?.trim() || 'local'}:${settings.activeCodexManagedAccountId ?? 'system'}:${JSON.stringify(settings.activeCodexManagedAccountIdsByRuntime ?? null)}:${settings.codexManagedAccounts.map((account) => `${account.id}:${account.updatedAt}`).join('|')}`
  })
  const accountState = resolveCodexStatusAccountState(settings, accounts)

  const activeRuntimeEnvironmentId = settings?.activeRuntimeEnvironmentId?.trim() || null
  // Why: keyed on owner id, not settings identity, so routine settings mutations don't re-run the remote snapshot fetch.
  const loadAccounts = useCallback(async () => {
    const snapshot = await fetchProviderAccountsSnapshot({ activeRuntimeEnvironmentId })
    // Why: a failed Codex half is a substituted empty roster; keep prior state.
    if (snapshot.failedProviders?.includes('codex')) {
      console.error('Codex account list failed; keeping previous status bar state.')
      return
    }
    if (mountedRef.current) {
      setAccounts(snapshot.codex)
    }
  }, [activeRuntimeEnvironmentId])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    accountsExpandedRef.current = accountsExpanded
  }, [accountsExpanded])

  useEffect(() => {
    // Why: the roster mounts this switcher on demand, while the sync key covers
    // account mutations without refetching again when its submenu opens.
    void loadAccounts().catch((error) => {
      console.error('Failed to load Codex accounts for status bar:', error)
    })
  }, [loadAccounts, codexAccountSyncKey])

  const handleSelectAccount = async (
    accountId: string | null,
    target: CodexStatusRuntimeTarget
  ): Promise<void> => {
    if (isSwitching || reauthenticatingAccountId !== null) {
      return
    }
    const previousActiveAccountId = getCodexStatusActiveId(accountState, target)
    setIsSwitching(true)
    try {
      const next = await selectCodexProviderAccount(settings, {
        accountId,
        runtime: target.runtime,
        wslDistro: target.wslDistro
      })
      recordFeatureInteraction('codex-account-switching')
      if (mountedRef.current) {
        setAccounts(next)
      }
      // Why: remote selections live on the server; local GlobalSettings are untouched, so refetching is pure churn.
      if (!hasActiveRuntimeEnvironment) {
        await fetchSettings()
      }
      const nextActiveAccountId = getCodexStatusActiveId(next, target)
      if (previousActiveAccountId !== nextActiveAccountId) {
        await markLiveCodexSessionsForRestart({
          previousAccountLabel: resolveCodexRestartPromptAccountLabel(
            accountState.accounts,
            previousActiveAccountId
          ),
          nextAccountLabel: resolveCodexRestartPromptAccountLabel(
            next.accounts,
            nextActiveAccountId
          ),
          // Why: two accounts can share an email, so the labels alone cannot
          // tell the store whether this switch lands back on the launch account.
          previousAccountId: previousActiveAccountId ?? null,
          nextAccountId: nextActiveAccountId ?? null,
          // Why: the mutation wrote this row's slot only, so panes on any other
          // lane still launch under the account they already had.
          target,
          // Why: clearing a distro-less WSL row nulls every distro slot at once.
          clearsEveryWslDistro: accountId === null
        })
        // Why: collapse to the summary row (not close) so the follow-up "restart open tabs" prompt appears in the same flow.
        if (mountedRef.current) {
          setAccountsExpanded(false)
        }
      }
    } catch (error) {
      console.error('Failed to switch Codex account from status bar:', error)
    } finally {
      if (mountedRef.current) {
        setIsSwitching(false)
      }
    }
  }

  const handleSignInAccount = async (
    accountId: string,
    target: CodexStatusRuntimeTarget
  ): Promise<void> => {
    if (isSwitching || reauthenticatingAccountId !== null) {
      return
    }
    const previousActiveAccountId = getCodexStatusActiveId(accountState, target)
    setReauthenticatingAccountId(accountId)
    try {
      const next = await window.api.codexAccounts.reauthenticate({
        accountId,
        // Why: signing in from a signed-out status bar should leave the account
        // usable; the main process still refuses to steal an existing selection.
        activateIfSelectionWasEmpty: true
      })
      recordFeatureInteraction('codex-account-switching')
      if (mountedRef.current) {
        setAccounts(next)
      }
      await fetchSettings()
      const nextActiveAccountId = getCodexStatusActiveId(next, target)
      if (previousActiveAccountId !== nextActiveAccountId) {
        // Why: sign-in that lands on a new active account changes pane credentials
        // exactly like an explicit switch, so it owes the same restart prompt.
        await markLiveCodexSessionsForRestart({
          previousAccountLabel: resolveCodexRestartPromptAccountLabel(
            accountState.accounts,
            previousActiveAccountId
          ),
          nextAccountLabel: resolveCodexRestartPromptAccountLabel(
            next.accounts,
            nextActiveAccountId
          ),
          previousAccountId: previousActiveAccountId ?? null,
          nextAccountId: nextActiveAccountId ?? null,
          target
        })
        if (mountedRef.current) {
          setAccountsExpanded(false)
        }
      } else if (mountedRef.current && accountsExpandedRef.current) {
        await fetchInactiveCodexAccountUsage()
      }
      toast.success(
        translate('auto.components.status.bar.StatusBar.codexSignInSuccess', 'Signed in to Codex')
      )
    } catch (error) {
      console.error('Failed to re-authenticate Codex account from status bar:', error)
      toast.error(
        translate(
          'auto.components.status.bar.StatusBar.codexSignInError',
          'Codex sign-in failed. Please try again.'
        )
      )
    } finally {
      if (mountedRef.current) {
        setReauthenticatingAccountId(null)
      }
    }
  }

  const handleSelectRuntime = async (group: CodexStatusSwitchGroup): Promise<void> => {
    const currentKey = getCodexStatusRuntimeKey(
      normalizeCodexStatusRuntimeTarget(accountState, toCodexStatusRuntimeTarget(codexTarget))
    )
    if (group.key === currentKey) {
      return
    }
    setAccountsExpanded(false)
    try {
      await refreshCodexRateLimitsForTarget(group.runtimeTarget)
    } catch (error) {
      console.error('Failed to switch Codex usage runtime:', error)
    }
  }

  const handleRedeemReset = async (): Promise<void> => {
    if (isRedeemingReset) {
      return
    }
    setIsRedeemingReset(true)
    try {
      await consumeCodexRateLimitResetCredit()
    } catch (error) {
      console.error('Failed to redeem Codex rate-limit reset from status bar:', error)
    } finally {
      if (mountedRef.current) {
        setIsRedeemingReset(false)
      }
    }
  }

  const handleResetMenuSelect = (): void => {
    if (settings?.skipCodexRateLimitResetConfirm) {
      void handleRedeemReset()
      return
    }
    setSkipFutureResetConfirm(false)
    setResetConfirmOpen(true)
  }

  const handleConfirmReset = async (): Promise<void> => {
    if (isRedeemingReset) {
      return
    }
    if (skipFutureResetConfirm) {
      try {
        await updateSettings({ skipCodexRateLimitResetConfirm: true })
      } catch (error) {
        console.error('Failed to save Codex reset confirmation preference:', error)
      }
    }
    await handleRedeemReset()
    if (mountedRef.current) {
      setResetConfirmOpen(false)
      setSkipFutureResetConfirm(false)
    }
  }

  const handleOpenChange = useCallback((nextOpen: boolean): void => {
    setOpen(nextOpen)
    if (!nextOpen) {
      setAccountsExpanded(false)
    }
  }, [])

  const handleAccountsExpandedToggle = useCallback((): void => {
    const nextExpanded = !accountsExpanded
    setAccountsExpanded(nextExpanded)
    if (nextExpanded && !hasActiveRuntimeEnvironment) {
      // Why: fetch inactive-account usage only on switcher expansion; remote-owned accounts have no local cache to fill.
      void fetchInactiveCodexAccountUsage()
    }
  }, [accountsExpanded, fetchInactiveCodexAccountUsage, hasActiveRuntimeEnvironment])

  const selectedRuntimeKey = getCodexStatusRuntimeKey(
    normalizeCodexStatusRuntimeTarget(accountState, toCodexStatusRuntimeTarget(codexTarget))
  )
  const fallbackWslDistro = getStatusBarPreferredWslDistro(
    settings,
    windowsTerminalCapabilities.wslDistros
  )
  const switchGroups = buildCodexStatusSwitchGroups(
    accountState,
    toCodexStatusRuntimeTarget(codexTarget),
    {
      fallbackWslDistro,
      includeFallbackWsl: !hasActiveRuntimeEnvironment && shouldIncludeSettingsWslRuntime(settings),
      hostLabel: providerAccountHostLabel
    }
  )
  const selectedGroup =
    switchGroups.find((group) => group.key === selectedRuntimeKey) ?? switchGroups[0]
  const activeTarget = selectedGroup?.targets.find((target) => target.active)
  const resetCreditCount = codex.rateLimitResetCredits?.availableCount ?? null
  const resetCreditExpiry =
    resetCreditCount !== null
      ? formatResetCreditExpiry(codex.rateLimitResetCredits?.nextExpiresAt, resetCreditCount)
      : null
  // Why: reset credits redeem against the desktop's own Codex login, not a remote account owner's.
  const canRedeemReset =
    !hasActiveRuntimeEnvironment && resetCreditCount !== null && resetCreditCount > 0

  return (
    <ProviderDetailsMenu
      provider={codex}
      compact={compact}
      iconOnly={iconOnly}
      asSubmenu={asSubmenu}
      triggerContent={triggerContent}
      // Why: Codex reset credits render beside the reset action below; showing
      // them in the generic provider summary duplicates the same metadata.
      hidePanelResetCredits
      ariaLabel={translate(
        'auto.components.status.bar.StatusBar.ba55303942',
        'Open Codex details and account switcher'
      )}
      topContent={
        <AccountRuntimeToggle
          groups={switchGroups}
          value={selectedGroup?.key ?? selectedRuntimeKey}
          onChange={(group) => void handleSelectRuntime(group)}
          ariaLabel={translate(
            'auto.components.status.bar.StatusBar.38b5647724',
            'Codex usage runtime'
          )}
        />
      }
      open={open}
      onOpenChange={handleOpenChange}
    >
      <Dialog open={resetConfirmOpen} onOpenChange={setResetConfirmOpen}>
        <DialogContent className="sm:max-w-[420px]" {...STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS}>
          <DialogHeader>
            <DialogTitle>
              {translate('auto.components.status.bar.StatusBar.972a1ff497', 'Reset Codex limits?')}
            </DialogTitle>
            <DialogDescription>
              {translate(
                'auto.components.status.bar.StatusBar.6d1042aa6f',
                'This uses one Codex rate-limit reset credit for the active account and resets any eligible usage windows immediately.'
              )}
            </DialogDescription>
          </DialogHeader>
          <label className="flex cursor-pointer items-center gap-2 rounded-sm px-1 py-1 text-xs text-foreground/80 transition-colors hover:text-foreground">
            <Checkbox
              checked={skipFutureResetConfirm}
              onCheckedChange={(checked) => setSkipFutureResetConfirm(checked === true)}
            />
            <span>
              {translate('auto.components.status.bar.StatusBar.f077f586db', "Don't ask again")}
            </span>
          </label>
          <DialogFooter>
            <Button variant="outline" onClick={() => setResetConfirmOpen(false)}>
              {translate('auto.components.status.bar.StatusBar.c0e972d726', 'Cancel')}
            </Button>
            <Button onClick={() => void handleConfirmReset()} disabled={isRedeemingReset}>
              {isRedeemingReset ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <RotateCcw className="size-4" />
              )}
              {isRedeemingReset
                ? translate('auto.components.status.bar.StatusBar.25d8bbde69', 'Using reset…')
                : translate('auto.components.status.bar.StatusBar.e159fc1fd7', 'Reset now')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {resetCreditCount !== null ? (
        <>
          <DropdownMenuLabel className="space-y-0.5">
            <div>
              {resetCreditCount === 1
                ? translate(
                    'auto.components.status.bar.StatusBar.5e5f9f5160',
                    '1 rate-limit reset available'
                  )
                : translate(
                    'auto.components.status.bar.StatusBar.5ecae9197c',
                    '{{value0}} rate-limit resets available',
                    { value0: resetCreditCount }
                  )}
            </div>
            {resetCreditExpiry ? (
              <div className="text-[11px] font-normal text-muted-foreground">
                {resetCreditExpiry}
              </div>
            ) : null}
          </DropdownMenuLabel>
          {canRedeemReset ? (
            <DropdownMenuItem
              disabled={isRedeemingReset}
              onSelect={(event) => {
                event.preventDefault()
                handleResetMenuSelect()
              }}
            >
              {isRedeemingReset ? (
                <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
              ) : null}
              {isRedeemingReset
                ? translate('auto.components.status.bar.StatusBar.25d8bbde69', 'Using reset…')
                : translate('auto.components.status.bar.StatusBar.e159fc1fd7', 'Reset now')}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuSeparator />
        </>
      ) : null}
      <DropdownMenuLabel>
        {translate('auto.components.status.bar.StatusBar.7657e3db9c', 'Codex Account')}
      </DropdownMenuLabel>
      <DropdownMenuItem
        onSelect={(event) => {
          event.preventDefault()
          handleAccountsExpandedToggle()
        }}
      >
        <div className="flex min-w-0 flex-1 flex-col gap-0.5 py-0.5 text-[12px]">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate text-foreground">
              {activeTarget?.label ??
                translate('auto.components.status.bar.StatusBar.c676918adc', 'System default')}
            </span>
          </div>
        </div>
        {accountsExpanded ? (
          <ChevronDown className="ml-auto size-3.5 text-muted-foreground/85" />
        ) : (
          <ChevronRight className="ml-auto size-3.5 text-muted-foreground/85" />
        )}
      </DropdownMenuItem>
      {accountsExpanded ? (
        <div className="px-1 pb-1">
          <div className="max-h-[220px] overflow-y-auto rounded-md border border-border/60 bg-accent/5 p-1 scrollbar-sleek">
            {selectedGroup ? (
              <>
                {selectedGroup.targets.map((target) => {
                  const inactiveUsage = target.id
                    ? inactiveCodexAccounts.find((a) => a.accountId === target.id)
                    : null
                  // Why: sign-in spawns a local `codex login`, so a remote-owned account can't be re-authed from this desktop.
                  const showSignInAction =
                    !hasActiveRuntimeEnvironment &&
                    !target.active &&
                    target.id !== null &&
                    isUnavailableInactiveUsage(inactiveUsage?.rateLimits)
                  const isSigningIn = reauthenticatingAccountId === target.id
                  const isBusy = isSwitching || reauthenticatingAccountId !== null

                  return (
                    <DropdownMenuItem
                      key={`${selectedGroup.key}:${target.id ?? 'system'}`}
                      onSelect={(event) => {
                        // Why: keep the menu open so the follow-up "restart live Codex tabs" prompt stays in this interaction.
                        event.preventDefault()
                        if (suppressNextAccountSelectRef.current) {
                          suppressNextAccountSelectRef.current = false
                          return
                        }
                        if (!target.active) {
                          void handleSelectAccount(target.id, target.runtimeTarget)
                        }
                      }}
                      disabled={isBusy || target.active}
                    >
                      <div className="flex w-full min-w-0 flex-col gap-0.5">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="min-w-0 flex-1 truncate">{target.label}</span>
                          {target.active ? (
                            <span className="shrink-0 text-[10px] font-medium text-muted-foreground">
                              {translate(
                                'auto.components.status.bar.StatusBar.ff0fbe9311',
                                'Active'
                              )}
                            </span>
                          ) : null}
                        </div>
                        {inactiveUsage?.isFetching && !inactiveUsage.rateLimits ? (
                          <InlineUsageSkeleton />
                        ) : showSignInAction ? (
                          <InlineUsageSignInAction
                            isFetching={inactiveUsage?.isFetching ?? false}
                            isSigningIn={isSigningIn}
                            disabled={isBusy}
                            onSignInPointerDown={suppressNextAccountSelect}
                            onSignIn={() => {
                              suppressNextAccountSelect()
                              if (target.id !== null) {
                                void handleSignInAccount(target.id, target.runtimeTarget)
                              }
                            }}
                          />
                        ) : inactiveUsage?.rateLimits ? (
                          <InlineUsageBars
                            limits={inactiveUsage.rateLimits}
                            isFetching={inactiveUsage.isFetching}
                          />
                        ) : null}
                      </div>
                    </DropdownMenuItem>
                  )
                })}
              </>
            ) : null}
          </div>
        </div>
      ) : null}
      {open ? <CodexRestartStatusPrompt /> : null}
      <DropdownMenuSeparator />
      <DropdownMenuItem
        onSelect={() => {
          openSettingsTarget({
            pane: 'accounts',
            repoId: null,
            sectionId: 'accounts-codex'
          })
          openSettingsPage()
        }}
      >
        {translate('auto.components.status.bar.StatusBar.75ded02687', 'Manage Accounts…')}
      </DropdownMenuItem>
    </ProviderDetailsMenu>
  )
}

export function ProviderDetailsMenu({
  provider,
  compact,
  iconOnly,
  ariaLabel,
  topContent,
  hidePanelResetCredits = false,
  open,
  onOpenChange,
  children,
  asSubmenu = false,
  triggerContent
}: {
  provider: ProviderRateLimits
  compact: boolean
  iconOnly: boolean
  ariaLabel: string
  topContent?: React.ReactNode
  hidePanelResetCredits?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  children?: React.ReactNode
  // When set, render as a drill-in submenu (used by the consolidated Usage
  // popover) with triggerContent as the full-width row instead of a segment.
  asSubmenu?: boolean
  triggerContent?: React.ReactNode
}): React.JSX.Element {
  const recordFeatureInteraction = useAppStore((s) => s.recordFeatureInteraction)
  const usagePercentageDisplay = normalizeUsagePercentageDisplay(
    useAppStore((s) => s.usagePercentageDisplay)
  )
  const menuFocusHandoff = useStatusBarMenuFocusHandoff()

  const handleOpenChange = (nextOpen: boolean): void => {
    if (nextOpen) {
      menuFocusHandoff.reset()
      recordFeatureInteraction('usage-tracking')
    }
    onOpenChange?.(nextOpen)
  }

  const panelBody = (
    <>
      {topContent}
      <div className="p-2">
        {/* Why: provider-specific action sections may render richer reset-credit UI. */}
        <ProviderPanel
          p={provider}
          showResetCredits={!hidePanelResetCredits}
          usagePercentageDisplay={usagePercentageDisplay}
        />
      </div>
      {children ? (
        <>
          <DropdownMenuSeparator />
          {children}
        </>
      ) : null}
    </>
  )

  if (asSubmenu) {
    return (
      <DropdownMenuSub open={open} onOpenChange={handleOpenChange}>
        <DropdownMenuSubTrigger className="w-full items-center gap-3 px-3.5 py-2.5">
          {triggerContent}
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent
          {...STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS}
          collisionPadding={{ top: 8, bottom: 32, left: 8, right: 8 }}
          className="max-h-(--radix-dropdown-menu-content-available-height) w-[300px] overflow-y-auto p-0 scrollbar-sleek"
        >
          {panelBody}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    )
  }

  return (
    <DropdownMenu open={open} onOpenChange={handleOpenChange} modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center cursor-pointer rounded px-1 py-0.5 hover:bg-accent/70"
          aria-label={ariaLabel}
        >
          {iconOnly ? (
            <ProviderLetterBadge p={provider} />
          ) : (
            <ProviderSegment p={provider} compact={compact} display={usagePercentageDisplay} />
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        {...STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS}
        side="top"
        align="start"
        sideOffset={8}
        className="w-[260px]"
        onPointerDownOutside={menuFocusHandoff.onPointerDownOutside}
        onCloseAutoFocus={menuFocusHandoff.onCloseAutoFocus}
      >
        {panelBody}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

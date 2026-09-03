import type { LegacyPaneKeyAliasEntry } from '../../shared/persisted-state-types'
import { parseLegacyNumericPaneKey, parsePaneKey } from '../../shared/stable-pane-id'
import {
  CLOSED_AGENT_STATUS_PANE_KEYS_MAX,
  CLOSED_AGENT_STATUS_TAB_IDS_MAX,
  PANE_KEY_ALIASES_MAX,
  RETIRED_PANE_FENCES_MAX,
  type PaneKeyAliasEntry,
  type RetiredPaneAlias,
  type RetiredPaneFence
} from './agent-hook-payload-sanitize'

export type AgentStatusDisposition = 'accept' | 'suppress' | 'restart'

export {
  CLOSED_AGENT_STATUS_PANE_KEYS_MAX,
  CLOSED_AGENT_STATUS_TAB_IDS_MAX,
  PANE_KEY_ALIASES_MAX,
  RETIRED_PANE_FENCES_MAX,
  type PaneKeyAliasEntry,
  type RetiredPaneAlias,
  type RetiredPaneFence
}

type AgentHookServer = {
  readonly state: {
    lastStatusByPaneKey: Map<string, unknown>
  }
  legacyPaneKeyAliases: Map<string, PaneKeyAliasEntry>
  closedAgentStatusTabIds: Set<string>
  closedAgentStatusPaneKeys: Set<string>
  restartedStatusLaunchTokenHashByPaneKey: Map<string, string>
  retiredPaneFencesByKey: Map<string, RetiredPaneFence>
  markPaneClosedForAgentStatus(paneKey: string): void
  markTabClosedForAgentStatus(tabId: string): void
  scheduleStatusPersist(): void
  notifyStatusChangeListeners(): void
}

type RegisterOptions = { authorityVerified: boolean }

export class PaneAuthorityRegistry {
  private readonly _server: AgentHookServer

  private _paneKeyAliasPersistenceListener: ((entries: LegacyPaneKeyAliasEntry[]) => void) | null =
    null

  constructor(server: AgentHookServer) {
    this._server = server
  }

  setPaneKeyAliasPersistenceListener(
    listener: ((entries: LegacyPaneKeyAliasEntry[]) => void) | null
  ): void {
    this._paneKeyAliasPersistenceListener = listener
  }

  normalizeHookBodyPaneKeyAlias(body: unknown): unknown {
    if (typeof body !== 'object' || body === null) {
      return body
    }
    const record = body as Record<string, unknown>
    const rawPaneKey = record['paneKey']
    if (typeof rawPaneKey !== 'string') {
      return body
    }
    const physicalPaneKey = rawPaneKey.trim()
    if (!physicalPaneKey) {
      return body
    }
    const resolved = this.resolvePaneKeyAlias(physicalPaneKey)
    if (resolved === physicalPaneKey) {
      return body
    }
    return { ...record, paneKey: resolved }
  }

  getAgentStatusDisposition(
    paneKey: string,
    options?: {
      hookEventName?: string
      isReplay?: boolean
      source?: unknown
      hasExplicitPrompt?: boolean
      launchToken?: string
    }
  ): AgentStatusDisposition {
    const resolved = this._resolvePaneKeyAlias(paneKey)
    if (this._server.closedAgentStatusPaneKeys.has(resolved) && !(options?.isReplay ?? false)) {
      return 'restart'
    }
    return 'accept'
  }

  resolvePaneKeyAlias(paneKey: string): string {
    return this._resolvePaneKeyAlias(paneKey)
  }

  private _resolvePaneKeyAlias(paneKey: string): string {
    const parsed = parsePaneKey(paneKey)
    if (parsed) {
      return paneKey
    }
    const legacy = parseLegacyNumericPaneKey(paneKey)
    if (legacy) {
      const alias = this._server.legacyPaneKeyAliases.get(paneKey)
      return alias?.stablePaneKey ?? paneKey
    }
    const alias = this._server.legacyPaneKeyAliases.get(paneKey)
    return alias?.stablePaneKey ?? paneKey
  }

  registerPaneKeyAlias(
    legacyPaneKey: string,
    stablePaneKey: string,
    ptyId: string | null,
    updatedAt = Date.now(),
    options: RegisterOptions = { authorityVerified: false }
  ): void {
    const existing = this._server.legacyPaneKeyAliases.get(legacyPaneKey)
    if (existing) {
      if (existing.stablePaneKey === stablePaneKey) {
        return
      }
    }
    if (this._server.legacyPaneKeyAliases.size >= PANE_KEY_ALIASES_MAX) {
      const oldestKey = this._findOldestAliasKey()
      if (oldestKey) {
        this._server.legacyPaneKeyAliases.delete(oldestKey)
      }
    }
    this._server.legacyPaneKeyAliases.set(legacyPaneKey, {
      stablePaneKey,
      ptyId,
      updatedAt,
      authorityVerified: options.authorityVerified
    })
    this._server.markPaneClosedForAgentStatus(stablePaneKey)
    this._server.notifyPaneKeyAliasPersistenceListener()
  }

  clearPaneKeyAliasesForPty(
    ptyId: string,
    options?: { shouldClearStablePaneKey?: (stablePaneKey: string) => boolean }
  ): void {
    let changed = false
    for (const [legacyPaneKey, entry] of this._server.legacyPaneKeyAliases) {
      if (entry.ptyId === ptyId) {
        if (
          !options?.shouldClearStablePaneKey ||
          options.shouldClearStablePaneKey(entry.stablePaneKey)
        ) {
          this._server.legacyPaneKeyAliases.delete(legacyPaneKey)
          changed = true
        }
      }
    }
    if (changed) {
      this._server.markPaneClosedForAgentStatus(ptyId)
      this._server.notifyPaneKeyAliasPersistenceListener()
    }
  }

  retirePaneAuthority(paneKey: string): void {
    const resolved = this._resolvePaneKeyAlias(paneKey)
    this._server.markPaneClosedForAgentStatus(resolved)
    if (this._server.restartedStatusLaunchTokenHashByPaneKey.has(resolved)) {
      const hash = this._server.restartedStatusLaunchTokenHashByPaneKey.get(resolved)
      if (hash) {
        this._server.restartedStatusLaunchTokenHashByPaneKey.set(resolved, `${hash}\x00`)
      }
    }
    const fence = this._buildRetiredPaneFence(resolved)
    if (this._server.retiredPaneFencesByKey.size >= RETIRED_PANE_FENCES_MAX) {
      const oldestKey = this._findOldestFenceKey()
      if (oldestKey) {
        this._server.retiredPaneFencesByKey.delete(oldestKey)
      }
    }
    this._server.retiredPaneFencesByKey.set(resolved, fence)
  }

  restorePaneAuthority(paneKey: string): boolean {
    const resolved = this._resolvePaneKeyAlias(paneKey)
    const tabId = this._extractTabId(resolved)
    if (tabId && this._server.closedAgentStatusTabIds.has(tabId)) {
      return false
    }
    this._server.closedAgentStatusPaneKeys.delete(resolved)
    this._server.retiredPaneFencesByKey.delete(resolved)
    return true
  }

  transferPaneAuthority(
    fromPaneKey: string,
    toPaneKey: string,
    ptyId: string | null,
    updatedAt = Date.now(),
    options?: { authorityVerified: boolean }
  ): void {
    const resolvedFrom = this._resolvePaneKeyAlias(fromPaneKey)
    const resolvedTo = this._resolvePaneKeyAlias(toPaneKey)
    const existing = this._server.legacyPaneKeyAliases.get(resolvedFrom)
    const currentStable = existing?.stablePaneKey ?? resolvedFrom
    if (this._server.legacyPaneKeyAliases.size >= PANE_KEY_ALIASES_MAX) {
      const oldestKey = this._findOldestAliasKey()
      if (oldestKey) {
        this._server.legacyPaneKeyAliases.delete(oldestKey)
      }
    }
    this._server.legacyPaneKeyAliases.set(resolvedFrom, {
      stablePaneKey: resolvedTo,
      ptyId,
      updatedAt,
      authorityVerified: options?.authorityVerified ?? existing?.authorityVerified ?? false
    })
    if (currentStable !== resolvedTo) {
      this._server.markPaneClosedForAgentStatus(currentStable)
    }
    this._server.markPaneClosedForAgentStatus(resolvedTo)
    this._server.notifyPaneKeyAliasPersistenceListener()
    this._server.scheduleStatusPersist()
    this._server.notifyStatusChangeListeners()
  }

  canTransferPaneAuthority(
    paneKey: string,
    ptyId: string | undefined,
    ownsPty: (paneKey: string, ptyId: string) => boolean
  ): boolean {
    const resolved = this._resolvePaneKeyAlias(paneKey)
    if (this._server.restartedStatusLaunchTokenHashByPaneKey.has(resolved)) {
      return true
    }
    const entry = this._server.legacyPaneKeyAliases.get(resolved)
    if (entry) {
      if (entry.authorityVerified) {
        return true
      }
      if (ptyId && ownsPty(entry.stablePaneKey, ptyId)) {
        return true
      }
      const ptyEntry = this._findAliasByPtyId(ptyId ?? '')
      if (ptyEntry && ptyEntry.stablePaneKey === entry.stablePaneKey) {
        return true
      }
    }
    return false
  }

  stop(): void {
    this._paneKeyAliasPersistenceListener = null
  }

  private _buildRetiredPaneFence(ownerKey: string): RetiredPaneFence {
    const paneKeys: string[] = [ownerKey]
    const aliases: RetiredPaneAlias[] = []
    for (const [physicalPaneKey, entry] of this._server.legacyPaneKeyAliases) {
      if (entry.stablePaneKey === ownerKey) {
        paneKeys.push(physicalPaneKey)
        aliases.push({ physicalPaneKey, entry })
      }
    }
    return { paneKeys, aliases }
  }

  private _findOldestAliasKey(): string | null {
    let oldest: string | null = null
    let oldestAt = Infinity
    for (const [key, entry] of this._server.legacyPaneKeyAliases) {
      if (entry.updatedAt < oldestAt) {
        oldestAt = entry.updatedAt
        oldest = key
      }
    }
    return oldest
  }

  private _findOldestFenceKey(): string | null {
    let oldest: string | null = null
    let oldestAt = Infinity
    for (const [key, fence] of this._server.retiredPaneFencesByKey) {
      const fenceAt = Math.min(...fence.aliases.map((a) => a.entry.updatedAt))
      if (fenceAt < oldestAt) {
        oldestAt = fenceAt
        oldest = key
      }
    }
    return oldest
  }

  private _findAliasByPtyId(ptyId: string): PaneKeyAliasEntry | null {
    for (const entry of this._server.legacyPaneKeyAliases.values()) {
      if (entry.ptyId === ptyId) {
        return entry
      }
    }
    return null
  }

  private _extractTabId(paneKey: string): string | null {
    const parsed = parsePaneKey(paneKey)
    if (parsed) {
      return parsed.tabId
    }
    const legacy = parseLegacyNumericPaneKey(paneKey)
    if (legacy) {
      return legacy.tabId
    }
    return null
  }
}

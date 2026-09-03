import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { HookListenerState } from '../../shared/agent-hook-listener/listener-state'
import {
  authorityCommitmentsMatch,
  dropHydratedIdleClaudeSubagents,
  HYDRATE_MAX_AGE_MS,
  isValidPaneKey,
  readPersistedLaunchTokenHash,
  sanitizeHydratedEntry,
  sanitizePersistedAuthorityCommitment,
  LAST_STATUS_FILE_VERSION,
  type EnrichedAgentHookEventPayload,
  type LastStatusFile,
  type PersistedAgentHookAuthorityCommitment,
  type PersistedAgentHookEventPayload
} from './agent-hook-payload-sanitize'
import { seedCodexStateFromSnapshot } from '../../shared/agent-hook-listener/providers/codex-state'
import {
  seedClaudeLeadTurnFromPersistedStatus,
  seedClaudeSubagentRosterFromSnapshots
} from '../../shared/agent-hook-listener/providers/claude-roster-state'

type AgentHookServerDeps = {
  readonly state: HookListenerState
  lastStatusFilePath: string | null
  endpointDir: string | null
  hydratedLaunchTokenHashByPaneKey: Map<string, string>
  persistedAuthorityCommitmentsByPaneKey: Map<string, unknown>
  connectionTimestampWatermarkById: Map<string, number>
  resolvePaneKeyAlias(paneKey: string): string
  toAuthorityEvidence(payload: unknown, launchTokenHash: string | undefined): unknown
}

export class AgentStatusPersistence {
  private statusPersistTimer: ReturnType<typeof setTimeout> | null = null
  private lastWrittenJson: string | null = null

  constructor(private server: AgentHookServerDeps) {}

  scheduleStatusPersist(STATUS_PERSIST_DEBOUNCE_MS: number): void {
    if (!this.server.lastStatusFilePath) {
      return
    }
    if (this.statusPersistTimer) {
      clearTimeout(this.statusPersistTimer)
    }
    this.statusPersistTimer = setTimeout(() => {
      this.statusPersistTimer = null
      this.runStatusPersist()
    }, STATUS_PERSIST_DEBOUNCE_MS)
    if (typeof this.statusPersistTimer.unref === 'function') {
      this.statusPersistTimer.unref()
    }
  }

  flushStatusPersistSync(): void {
    if (this.statusPersistTimer) {
      clearTimeout(this.statusPersistTimer)
      this.statusPersistTimer = null
    }
    if (!this.server.lastStatusFilePath) {
      return
    }
    this.runStatusPersist()
  }

  private serializeStatusFile(): string {
    const entries: Record<string, PersistedAgentHookEventPayload> = {}
    const authorityCommitments: Record<string, PersistedAgentHookAuthorityCommitment> = {}
    const conflictedCommitments = new Set<string>()
    for (const [paneKey, commitment] of this.server.persistedAuthorityCommitmentsByPaneKey) {
      authorityCommitments[paneKey] = { ...commitment }
    }
    for (const [paneKey, payload] of this.server.state.lastStatusByPaneKey) {
      if (!isValidPaneKey(paneKey)) {
        continue
      }
      const enrichedPayload = payload as EnrichedAgentHookEventPayload
      const childOnlyBoundary = enrichedPayload.claudeLeadBoundaryChildOnly === true
      const {
        claudeRunningNonAgentTask: _claudeRunningNonAgentTask,
        promptInteractionKey: _promptInteractionKey,
        restoredUnconfirmed: _restoredUnconfirmed,
        observation: _observation,
        isReplay: _isReplay,
        launchToken,
        ...persistedPayload
      } = enrichedPayload
      const launchTokenHash = launchToken?.trim()
        ? createHash('sha256').update(launchToken.trim()).digest('hex')
        : this.server.hydratedLaunchTokenHashByPaneKey.get(paneKey)
      entries[paneKey] = {
        ...persistedPayload,
        ...(childOnlyBoundary ? { claudeLeadBoundaryChildOnly: true } : {}),
        ...(launchTokenHash ? { launchTokenHash } : {})
      }
      const commitment = this.server.toAuthorityEvidence(payload, launchTokenHash as string | undefined)
      if (commitment && !conflictedCommitments.has(paneKey)) {
        const existing = authorityCommitments[paneKey]
        if (existing && !authorityCommitmentsMatch(existing as PersistedAgentHookAuthorityCommitment, commitment as PersistedAgentHookAuthorityCommitment)) {
          delete authorityCommitments[paneKey]
          conflictedCommitments.add(paneKey)
        } else {
          authorityCommitments[paneKey] = { ...commitment }
        }
      }
    }
    const file: LastStatusFile = {
      version: LAST_STATUS_FILE_VERSION,
      entries,
      authorityCommitments
    }
    return JSON.stringify(file)
  }

  private runStatusPersist(): void {
    if (!this.server.lastStatusFilePath || !this.server.endpointDir) {
      return
    }
    const json = this.serializeStatusFile()
    if (json === this.lastWrittenJson) {
      return
    }
    const tmpPath = join(this.server.endpointDir, `.last-status-${process.pid}-${randomUUID()}.tmp`)
    let tmpWritten = false
    try {
      mkdirSync(this.server.endpointDir, { recursive: true, mode: 0o700 })
      if (process.platform !== 'win32') {
        try {
          chmodSync(this.server.endpointDir, 0o700)
        } catch {
          // best-effort
        }
      }
      writeFileSync(tmpPath, json, { mode: 0o600 })
      tmpWritten = true
      renameSync(tmpPath, this.server.lastStatusFilePath)
      this.lastWrittenJson = json
    } catch (err) {
      console.warn('[agent-hooks] failed to write last-status file:', err)
      if (tmpWritten) {
        try {
          unlinkSync(tmpPath)
        } catch {
          // tmp already gone
        }
      }
    }
  }

  hydrateLastStatusFromDisk(HYDRATE_MAX_AGE_MS: number): void {
    if (!this.server.lastStatusFilePath) {
      return
    }
    this.server.state.lastStatusByPaneKey.clear()
    this.server.hydratedLaunchTokenHashByPaneKey.clear()
    this.server.persistedAuthorityCommitmentsByPaneKey.clear()
    let raw: string
    try {
      raw = readFileSync(this.server.lastStatusFilePath, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('[agent-hooks] failed to read last-status file:', err)
      }
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      console.warn('[agent-hooks] last-status file is not valid JSON; ignoring')
      return
    }
    if (typeof parsed !== 'object' || parsed === null) {
      console.warn('[agent-hooks] last-status file is not an object; ignoring')
      return
    }
    const file = parsed as Partial<LastStatusFile>
    if (file.version !== LAST_STATUS_FILE_VERSION) {
      console.warn(
        `[agent-hooks] last-status file version mismatch (${String(
          file.version
        )} != ${LAST_STATUS_FILE_VERSION}); ignoring`
      )
      return
    }
    const entries = file.entries
    if (typeof entries !== 'object' || entries === null) {
      console.warn('[agent-hooks] last-status file entries missing or wrong shape; ignoring')
      return
    }
    let hydrated = 0
    let dropped = 0
    let prunedLegacyClaudeSubagents = 0
    let scrubbedLegacyLaunchTokens = 0
    const ttlCutoff = Date.now() - HYDRATE_MAX_AGE_MS
    for (const [paneKey, rawEntry] of Object.entries(entries)) {
      const resolvedPaneKey = this.server.resolvePaneKeyAlias(paneKey)
      const rawResolvedEntry =
        resolvedPaneKey === paneKey || typeof rawEntry !== 'object' || rawEntry === null
          ? rawEntry
          : { ...(rawEntry as Record<string, unknown>), paneKey: resolvedPaneKey }
      const entry = sanitizeHydratedEntry(resolvedPaneKey, rawResolvedEntry)
      if (entry && entry.receivedAt >= ttlCutoff) {
        const launchTokenHash = readPersistedLaunchTokenHash(rawResolvedEntry)
        if (launchTokenHash) {
          this.server.hydratedLaunchTokenHashByPaneKey.set(resolvedPaneKey, launchTokenHash)
          const evidence = this.server.toAuthorityEvidence(entry, launchTokenHash)
          if (evidence) {
            this.server.persistedAuthorityCommitmentsByPaneKey.set(resolvedPaneKey, evidence)
          }
        }
        if (
          typeof rawResolvedEntry === 'object' &&
          rawResolvedEntry !== null &&
          typeof (rawResolvedEntry as Record<string, unknown>).launchToken === 'string'
        ) {
          scrubbedLegacyLaunchTokens += 1
        }
        const hydratedPayload = dropHydratedIdleClaudeSubagents(entry.payload)
        if (hydratedPayload !== entry.payload) {
          prunedLegacyClaudeSubagents +=
            (entry.payload.subagents?.length ?? 0) - (hydratedPayload.subagents?.length ?? 0)
          entry.payload = hydratedPayload
        }
        if (entry.payload.state !== 'done') {
          entry.restoredUnconfirmed = true
        }
        this.server.state.lastStatusByPaneKey.set(resolvedPaneKey, entry)
        if (entry.connectionId) {
          const previousWatermark = this.server.connectionTimestampWatermarkById.get(entry.connectionId)
          this.server.connectionTimestampWatermarkById.set(
            entry.connectionId,
            Math.max(previousWatermark ?? -1, entry.receivedAt)
          )
        }
        if (entry.payload.agentType === 'codex') {
          seedCodexStateFromSnapshot(this.server.state, resolvedPaneKey, entry.payload)
        } else if (entry.payload.agentType === 'claude') {
          seedClaudeLeadTurnFromPersistedStatus(this.server.state, resolvedPaneKey, entry, {
            childOnlyBoundary: entry.claudeLeadBoundaryChildOnly === true
          })
          if (entry.payload.subagents) {
            seedClaudeSubagentRosterFromSnapshots(
              this.server.state,
              resolvedPaneKey,
              entry.payload.subagents
            )
          }
        }
        hydrated += 1
      } else {
        dropped += 1
      }
    }
    for (const [paneKey, rawCommitment] of Object.entries(file.authorityCommitments ?? {})) {
      const resolvedPaneKey = this.server.resolvePaneKeyAlias(paneKey)
      const commitment = sanitizePersistedAuthorityCommitment(resolvedPaneKey, rawCommitment)
      if (!commitment || commitment.observedAt < ttlCutoff) {
        dropped += 1
        continue
      }
      const existing = this.server.persistedAuthorityCommitmentsByPaneKey.get(resolvedPaneKey)
      if (existing && !authorityCommitmentsMatch(existing as PersistedAgentHookAuthorityCommitment, commitment)) {
        this.server.persistedAuthorityCommitmentsByPaneKey.delete(resolvedPaneKey)
        this.server.hydratedLaunchTokenHashByPaneKey.delete(resolvedPaneKey)
        dropped += 1
        continue
      }
      this.server.persistedAuthorityCommitmentsByPaneKey.set(resolvedPaneKey, commitment)
      this.server.hydratedLaunchTokenHashByPaneKey.set(resolvedPaneKey, commitment.launchTokenHash)
    }
    if (dropped > 0) {
      console.warn(
        `[agent-hooks] last-status hydrate dropped ${dropped} entries (kept ${hydrated})`
      )
    }
    if (dropped > 0 || prunedLegacyClaudeSubagents > 0 || scrubbedLegacyLaunchTokens > 0) {
      this.runStatusPersist()
    } else if (hydrated > 0) {
      this.lastWrittenJson = raw
    }
  }

  stop(): void {
    if (this.statusPersistTimer) {
      clearTimeout(this.statusPersistTimer)
      this.statusPersistTimer = null
    }
    this.lastWrittenJson = null
  }
}

import type {
  PtyIncarnationHandleRecord,
  RuntimeLeafRecord,
  RuntimePtyWorktreeRecord
} from './orca-runtime'
import { randomUUID } from 'node:crypto'
import type { RuntimePtyWorktrees, RuntimePtyWorktreesDeps } from './runtime-pty-worktrees'

export class RuntimePtyIncarnationRegistry {
  constructor(
    private readonly host: RuntimePtyWorktrees,
    private readonly deps: RuntimePtyWorktreesDeps
  ) {}

  adoptControllerTerminalHandle(
    ptyId: string,
    handle: string | undefined,
    incarnationId?: string,
    options: { exactRestoredSurface?: boolean } = {}
  ): void {
    const trimmed = handle?.trim()
    if (!trimmed || !trimmed.startsWith('term_')) {
      return
    }
    const pty = this.deps.ptysById().get(ptyId)
    const changedIncarnation = Boolean(
      incarnationId && pty?.incarnationId && incarnationId !== pty.incarnationId
    )
    if (changedIncarnation) {
      const priorHandle = this.deps.handleByPtyId().get(ptyId)
      this.invalidateAllHandlesForPty(ptyId)
      pty!.tabId = null
      pty!.paneKey = null
      // Reusing an exported handle would make stale client metadata name the replacement process.
      if (priorHandle === trimmed) {
        return
      }
    }
    if (this.isTerminalHandleAdoptionBlocked(ptyId, trimmed)) {
      if (
        !options.exactRestoredSurface ||
        !this.replaceSyntheticTerminalHandlesForRestoredPty(ptyId, trimmed) ||
        this.isTerminalHandleAdoptionBlocked(ptyId, trimmed)
      ) {
        return
      }
    }
    // Why: after an app/runtime restart, the live PTY child still has its
    // original ORCA_TERMINAL_HANDLE, but the runtime's in-memory map is gone.
    this.registerPreAllocatedHandleForPty(ptyId, trimmed)
  }

  adoptFirstPtyForLeafHandle(
    leafKey: string,
    ptyId: string | null,
    ptyGeneration: number
  ): boolean {
    const handle = this.deps.handleByLeafKey().get(leafKey)
    const record = handle ? this.deps.handles().get(handle) : null
    if (!handle || !record || record.ptyId !== null || ptyId === null) {
      return false
    }
    this.deps.handles().set(handle, { ...record, ptyId, ptyGeneration })
    return true
  }

  adoptPreAllocatedHandle(leaf: RuntimeLeafRecord): string | null {
    if (!leaf.ptyId) {
      return null
    }
    const preAllocated = this.deps.handleByPtyId().get(leaf.ptyId)
    if (!preAllocated) {
      return null
    }
    const leafKey = this.deps.getLeafKey(leaf.tabId, leaf.leafId)
    this.deps.handles().set(preAllocated, {
      handle: preAllocated,
      runtimeId: this.deps.runtimeId(),
      rendererGraphEpoch: this.deps.rendererGraphEpoch(),
      worktreeId: leaf.worktreeId,
      tabId: leaf.tabId,
      leafId: leaf.leafId,
      ptyId: leaf.ptyId,
      ptyGeneration: leaf.ptyGeneration
    })
    this.deps.handleByLeafKey().set(leafKey, preAllocated)
    return preAllocated
  }

  bindPtyIncarnationHandle(retained: PtyIncarnationHandleRecord, leaf: RuntimeLeafRecord): void {
    const leafKey = this.deps.getLeafKey(leaf.tabId, leaf.leafId)
    if (retained.leafKey !== leafKey) {
      if (this.deps.handleByLeafKey().get(retained.leafKey) === retained.handle) {
        this.deps.handleByLeafKey().delete(retained.leafKey)
      }
      retained.leafKey = leafKey
    }
    this.deps.handles().set(retained.handle, {
      handle: retained.handle,
      runtimeId: this.deps.runtimeId(),
      rendererGraphEpoch: this.deps.rendererGraphEpoch(),
      worktreeId: leaf.worktreeId,
      tabId: leaf.tabId,
      leafId: leaf.leafId,
      ptyId: leaf.ptyId,
      ptyGeneration: leaf.ptyGeneration
    })
    this.deps.handleByLeafKey().set(leafKey, retained.handle)
  }

  clearPtyIncarnationHandles(): void {
    for (const retained of this.deps.handleByPtyIncarnation().values()) {
      this.deps.syntheticTerminalHandles().delete(retained.handle)
    }
    this.deps.handleByPtyIncarnation().clear()
  }

  createPreAllocatedTerminalHandle(): string {
    return `term_${randomUUID()}`
  }

  findHandleForPtyRecord(ptyId: string): string | null {
    for (const [handle, record] of this.deps.handles()) {
      if (
        record.runtimeId === this.deps.runtimeId() &&
        record.ptyId === ptyId &&
        record.tabId.startsWith('pty:')
      ) {
        return handle
      }
    }
    return null
  }

  invalidateAllHandlesForPty(ptyId: string): void {
    const incarnationHandle = this.deps.handleByPtyIncarnation().get(ptyId)?.handle
    const preallocatedHandle = this.deps.handleByPtyId().get(ptyId)
    this.invalidatePtyIncarnationHandle(ptyId)
    this.deps.handleByPtyId().delete(ptyId)
    const invalidated = new Set<string>()
    if (preallocatedHandle && preallocatedHandle !== incarnationHandle) {
      invalidated.add(preallocatedHandle)
    }
    for (const [handle, record] of this.deps.handles()) {
      if (record.ptyId === ptyId) {
        invalidated.add(handle)
        this.deps.handles().delete(handle)
      }
    }
    for (const handle of invalidated) {
      this.deps.handles().delete(handle)
      this.deps.syntheticTerminalHandles().delete(handle)
      this.host.rejectWaitersForHandle(handle, 'terminal_handle_stale')
    }
    for (const [leafKey, handle] of this.deps.handleByLeafKey()) {
      if (invalidated.has(handle)) {
        this.deps.handleByLeafKey().delete(leafKey)
      }
    }
  }

  invalidateLeafHandle(leafKey: string): void {
    const handle = this.deps.handleByLeafKey().get(leafKey)
    if (!handle) {
      return
    }
    const record = this.deps.handles().get(handle)
    if (record?.ptyId && this.deps.handleByPtyIncarnation().get(record.ptyId)?.handle === handle) {
      this.deps.handleByPtyIncarnation().delete(record.ptyId)
    }
    this.deps.handleByLeafKey().delete(leafKey)
    this.deps.handles().delete(handle)
    this.deps.syntheticTerminalHandles().delete(handle)
    this.host.rejectWaitersForHandle(handle, 'terminal_handle_stale')
  }

  invalidatePtyIncarnationHandle(ptyId: string): void {
    const retained = this.deps.handleByPtyIncarnation().get(ptyId)
    if (!retained) {
      return
    }
    this.deps.handleByPtyIncarnation().delete(ptyId)
    if (this.deps.handleByLeafKey().get(retained.leafKey) === retained.handle) {
      this.deps.handleByLeafKey().delete(retained.leafKey)
    }
    this.deps.handles().delete(retained.handle)
    this.deps.syntheticTerminalHandles().delete(retained.handle)
    this.host.rejectWaitersForHandle(retained.handle, 'terminal_handle_stale')
  }

  isTerminalHandleAdoptionBlocked(ptyId: string, handle: string): boolean {
    if (this.deps.handleByPtyId().get(ptyId) ?? this.findHandleForPtyRecord(ptyId)) {
      return true
    }
    for (const leaf of this.host.getLeavesForPty(ptyId)) {
      const issued = this.deps.handleByLeafKey().get(this.deps.getLeafKey(leaf.tabId, leaf.leafId))
      if (issued && issued !== handle) {
        return true
      }
    }
    const existingRecord = this.deps.handles().get(handle)
    if (existingRecord && existingRecord.ptyId !== ptyId) {
      return true
    }
    for (const [otherPtyId, otherHandle] of this.deps.handleByPtyId()) {
      if (otherHandle === handle && otherPtyId !== ptyId) {
        return true
      }
    }
    return false
  }

  issueHandle(leaf: RuntimeLeafRecord): string {
    const leafKey = this.deps.getLeafKey(leaf.tabId, leaf.leafId)
    const existingHandle = this.deps.handleByLeafKey().get(leafKey)
    if (existingHandle) {
      const existingRecord = this.deps.handles().get(existingHandle)
      if (
        existingRecord &&
        existingRecord.rendererGraphEpoch === this.deps.rendererGraphEpoch() &&
        existingRecord.ptyId === leaf.ptyId &&
        existingRecord.ptyGeneration === leaf.ptyGeneration
      ) {
        return existingHandle
      }
    }

    const preAllocatedHandle = this.adoptPreAllocatedHandle(leaf)
    if (preAllocatedHandle) {
      return preAllocatedHandle
    }
    const incarnationId = leaf.ptyId
      ? (this.deps.ptysById().get(leaf.ptyId)?.incarnationId ?? null)
      : null
    const retained = leaf.ptyId ? this.deps.handleByPtyIncarnation().get(leaf.ptyId) : undefined
    if (retained && leaf.ptyId && retained.incarnationId !== incarnationId) {
      this.invalidatePtyIncarnationHandle(leaf.ptyId)
    } else if (retained) {
      this.bindPtyIncarnationHandle(retained, leaf)
      return retained.handle
    }

    const handle = `term_${randomUUID()}`
    this.deps.syntheticTerminalHandles().add(handle)
    this.deps.handles().set(handle, {
      handle,
      runtimeId: this.deps.runtimeId(),
      rendererGraphEpoch: this.deps.rendererGraphEpoch(),
      worktreeId: leaf.worktreeId,
      tabId: leaf.tabId,
      leafId: leaf.leafId,
      ptyId: leaf.ptyId,
      ptyGeneration: leaf.ptyGeneration
    })
    this.deps.handleByLeafKey().set(leafKey, handle)
    if (leaf.ptyId && incarnationId) {
      this.deps.handleByPtyIncarnation().set(leaf.ptyId, { handle, incarnationId, leafKey })
    }
    return handle
  }

  issuePtyHandle(pty: RuntimePtyWorktreeRecord): string {
    const existingHandle =
      this.deps.handleByPtyId().get(pty.ptyId) ?? this.findHandleForPtyRecord(pty.ptyId)
    if (existingHandle) {
      const existingRecord = this.deps.handles().get(existingHandle)
      if (
        existingRecord &&
        existingRecord.runtimeId === this.deps.runtimeId() &&
        existingRecord.ptyId === pty.ptyId
      ) {
        this.deps.handleByPtyId().set(pty.ptyId, existingHandle)
        return existingHandle
      }
    }

    const handle = existingHandle ?? `term_${randomUUID()}`
    if (!existingHandle) {
      this.deps.syntheticTerminalHandles().add(handle)
    }
    const syntheticId = `pty:${pty.ptyId}`
    this.deps.handles().set(handle, {
      handle,
      runtimeId: this.deps.runtimeId(),
      rendererGraphEpoch: this.deps.rendererGraphEpoch(),
      worktreeId: pty.worktreeId,
      tabId: syntheticId,
      leafId: syntheticId,
      ptyId: pty.ptyId,
      ptyGeneration: 0
    })
    this.deps.handleByPtyId().set(pty.ptyId, handle)
    return handle
  }

  issueStructuredTuiPtyHandle(pty: RuntimePtyWorktreeRecord): string {
    const existingHandle = this.findHandleForPtyRecord(pty.ptyId)
    if (existingHandle) {
      this.deps.handleByPtyId().set(pty.ptyId, existingHandle)
      return existingHandle
    }
    const handle = `term_${randomUUID()}`
    const syntheticId = `pty:${pty.ptyId}`
    this.deps.syntheticTerminalHandles().add(handle)
    this.deps.handles().set(handle, {
      handle,
      runtimeId: this.deps.runtimeId(),
      rendererGraphEpoch: this.deps.rendererGraphEpoch(),
      worktreeId: pty.worktreeId,
      tabId: syntheticId,
      leafId: syntheticId,
      ptyId: pty.ptyId,
      ptyGeneration: 0
    })
    this.deps.handleByPtyId().set(pty.ptyId, handle)
    return handle
  }

  preAllocateHandleForPty(ptyId: string): string {
    const existing = this.deps.handleByPtyId().get(ptyId)
    if (existing) {
      return existing
    }
    const handle = this.createPreAllocatedTerminalHandle()
    this.deps.handleByPtyId().set(ptyId, handle)
    return handle
  }

  registerPreAllocatedHandleForPty(ptyId: string, handle: string): void {
    const retained = this.deps.handleByPtyIncarnation().get(ptyId)
    if (retained?.handle === handle) {
      this.deps.handleByPtyIncarnation().delete(ptyId)
    } else {
      this.invalidatePtyIncarnationHandle(ptyId)
    }
    this.deps.handleByPtyId().set(ptyId, handle)
    for (const leaf of this.host.getLeavesForPty(ptyId)) {
      this.adoptPreAllocatedHandle(leaf)
    }
  }

  reconcilePtyIncarnationHandles(): void {
    for (const [ptyId, retained] of this.deps.handleByPtyIncarnation()) {
      const pty = this.deps.ptysById().get(ptyId)
      const leaves = this.host.getLeavesForPty(ptyId)
      if (
        !pty?.incarnationId ||
        pty.incarnationId !== retained.incarnationId ||
        leaves.length !== 1 ||
        this.deps.handleByPtyId().has(ptyId)
      ) {
        this.invalidatePtyIncarnationHandle(ptyId)
        continue
      }
      this.bindPtyIncarnationHandle(retained, leaves[0])
    }
  }

  replaceSyntheticTerminalHandlesForRestoredPty(ptyId: string, controllerHandle: string): boolean {
    const boundHandles = new Set<string>()
    const directHandle = this.deps.handleByPtyId().get(ptyId)
    if (directHandle) {
      boundHandles.add(directHandle)
    }
    for (const [handle, record] of this.deps.handles()) {
      if (record.ptyId === ptyId) {
        boundHandles.add(handle)
      } else if (handle === controllerHandle) {
        return false
      }
    }
    for (const [otherPtyId, handle] of this.deps.handleByPtyId()) {
      if (otherPtyId !== ptyId && handle === controllerHandle) {
        return false
      }
    }
    for (const leaf of this.host.getLeavesForPty(ptyId)) {
      const handle = this.deps.handleByLeafKey().get(this.deps.getLeafKey(leaf.tabId, leaf.leafId))
      if (handle) {
        boundHandles.add(handle)
      }
    }
    if (
      boundHandles.size === 0 ||
      [...boundHandles].some(
        (handle) => handle === controllerHandle || !this.deps.syntheticTerminalHandles().has(handle)
      )
    ) {
      return false
    }
    this.invalidateAllHandlesForPty(ptyId)
    return true
  }
}

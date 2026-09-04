import type { RuntimeLeafRecord } from './runtime-leaf-record'
import type { TerminalHandleRecord } from './runtime-terminal-handle'
import type { PtyIncarnationHandleRecord } from './runtime-pty-incarnation'

/** Registry managing terminal handles, leaves, and their bidirectional indices.
 *  Consolidates 7 related fields: leaves, leavesByPtyId, handles, handleByLeafKey,
 *  handleByPtyId, handleByPtyIncarnation, detachedPreAllocatedLeaves */
export class TerminalHandleRegistry {
  private leaves = new Map<string, RuntimeLeafRecord>()
  private leavesByPtyId = new Map<string, RuntimeLeafRecord[]>()
  private handles = new Map<string, TerminalHandleRecord>()
  private handleByLeafKey = new Map<string, string>()
  private handleByPtyId = new Map<string, string>()
  private handleByPtyIncarnation = new Map<string, PtyIncarnationHandleRecord>()
  private detachedPreAllocatedLeaves = new Map<string, RuntimeLeafRecord>()

  // Getters for backward compatibility
  getLeaves(): ReadonlyMap<string, RuntimeLeafRecord> {
    return this.leaves
  }

  getLeavesByPtyId(): ReadonlyMap<string, RuntimeLeafRecord[]> {
    return this.leavesByPtyId
  }

  getHandles(): ReadonlyMap<string, TerminalHandleRecord> {
    return this.handles
  }

  getHandleByLeafKey(): ReadonlyMap<string, string> {
    return this.handleByLeafKey
  }

  getHandleByPtyId(): ReadonlyMap<string, string> {
    return this.handleByPtyId
  }

  getHandleByPtyIncarnation(): ReadonlyMap<string, PtyIncarnationHandleRecord> {
    return this.handleByPtyIncarnation
  }

  getDetachedPreAllocatedLeaves(): ReadonlyMap<string, RuntimeLeafRecord> {
    return this.detachedPreAllocatedLeaves
  }

  // Mutable access for internal state management
  addLeaf(leafKey: string, leaf: RuntimeLeafRecord): void {
    this.leaves.set(leafKey, leaf)
  }

  removeLeaf(leafKey: string): void {
    const leaf = this.leaves.get(leafKey)
    if (!leaf) {
      return
    }

    this.leaves.delete(leafKey)
    // Remove from ptyId index
    if (leaf.ptyId) {
      const leaves = this.leavesByPtyId.get(leaf.ptyId)
      if (leaves) {
        const idx = leaves.indexOf(leaf)
        if (idx !== -1) {
          leaves.splice(idx, 1)
        }
        if (leaves.length === 0) {
          this.leavesByPtyId.delete(leaf.ptyId)
        }
      }
    }
    // Remove handle associations
    const handle = this.handleByLeafKey.get(leafKey)
    if (handle) {
      this.handleByLeafKey.delete(leafKey)
      // Clean up handle record if no leaves reference it
    }
  }

  addHandle(handle: string, record: TerminalHandleRecord): void {
    this.handles.set(handle, record)
  }

  removeHandle(handle: string): void {
    this.handles.delete(handle)
  }

  setHandleForLeaf(leafKey: string, handle: string): void {
    this.handleByLeafKey.set(leafKey, handle)
  }

  setHandleForPty(ptyId: string, handle: string): void {
    this.handleByPtyId.set(ptyId, handle)
  }

  setIncarnationHandle(incarnationId: string, record: PtyIncarnationHandleRecord): void {
    this.handleByPtyIncarnation.set(incarnationId, record)
  }

  addPtyLeaves(ptyId: string, leaves: RuntimeLeafRecord[]): void {
    this.leavesByPtyId.set(ptyId, leaves)
  }

  addPreAllocatedLeaf(leafKey: string, leaf: RuntimeLeafRecord): void {
    this.detachedPreAllocatedLeaves.set(leafKey, leaf)
  }

  removePreAllocatedLeaf(leafKey: string): void {
    this.detachedPreAllocatedLeaves.delete(leafKey)
  }

  clear(): void {
    this.leaves.clear()
    this.leavesByPtyId.clear()
    this.handles.clear()
    this.handleByLeafKey.clear()
    this.handleByPtyId.clear()
    this.handleByPtyIncarnation.clear()
    this.detachedPreAllocatedLeaves.clear()
  }
}

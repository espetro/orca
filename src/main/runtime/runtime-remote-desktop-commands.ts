import type { RuntimeTerminalCluster } from './runtime-terminal-cluster-facade'
import { clampTerminalViewport } from './orca-runtime'

export type RuntimeRemoteDesktopCommandsDeps = {
  terminalClusterFacade: () => RuntimeTerminalCluster
  resolveDesktopRestoreTarget: (ptyId: string) => { cols: number; rows: number }
  getTerminalSize: (ptyId: string) => { cols: number; rows: number } | null
  remoteDesktopViewers: Map<
    string,
    Map<string, { clientId: string; cols: number; rows: number; activity: number }>
  >
  remoteDesktopOwners: Map<string, string>
  remoteDesktopActivity: number
  remoteDesktopHostReclaimTargets: Map<string, { cols: number; rows: number }>
  remoteDesktopViewerRevisions: Map<string, number>
}

export class RuntimeRemoteDesktopCommands {
  private readonly deps: RuntimeRemoteDesktopCommandsDeps

  constructor(deps: RuntimeRemoteDesktopCommandsDeps) {
    this.deps = deps
  }

  isRemoteDesktopResizeDriven(ptyId: string): boolean {
    return this.deps.remoteDesktopOwners.has(ptyId)
  }

  isRemoteDesktopViewerOwner(ptyId: string, subscriptionKey: string): boolean {
    return this.deps.terminalClusterFacade().isRemoteDesktopViewerOwner(ptyId, subscriptionKey)
  }

  getRemoteDesktopFitHold(
    ptyId: string,
    subscriptionKey: string
  ): { mode: 'remote-desktop-fit' | 'desktop-fit'; cols: number; rows: number } {
    return this.deps.terminalClusterFacade().getRemoteDesktopFitHold(ptyId, subscriptionKey)
  }

  hasRemoteDesktopViewers(ptyId: string): boolean {
    const viewers = this.deps.remoteDesktopViewers.get(ptyId)
    return viewers !== undefined && viewers.size > 0
  }

  activeRemoteDesktopViewport(ptyId: string): { cols: number; rows: number } | null {
    const owner = this.deps.remoteDesktopOwners.get(ptyId)
    return owner ? (this.deps.remoteDesktopViewers.get(ptyId)?.get(owner) ?? null) : null
  }

  resolveRemoteDesktopHostReclaimTarget(ptyId: string): { cols: number; rows: number } {
    const target = this.deps.remoteDesktopHostReclaimTargets.get(ptyId)
    if (target) {
      return target
    }
    // Why: a viewer can join while a phone owns the actual PTY size. The
    // mobile restore chain retains the pre-phone desktop geometry; current
    // PTY size alone would incorrectly capture the phone grid as host truth.
    return this.deps.resolveDesktopRestoreTarget(ptyId)
  }

  ensureRemoteDesktopHostReclaimTarget(ptyId: string): void {
    if (!this.deps.remoteDesktopHostReclaimTargets.has(ptyId)) {
      this.deps.remoteDesktopHostReclaimTargets.set(
        ptyId,
        this.resolveRemoteDesktopHostReclaimTarget(ptyId)
      )
    }
  }

  recordRemoteDesktopHostReclaimTarget(ptyId: string, cols: number, rows: number): void {
    // Why: phone presence also suppresses host resize, but must not seed the
    // separate remote-viewer cache when no desktop stream owns a width floor.
    if (!this.deps.remoteDesktopOwners.has(ptyId) || cols <= 0 || rows <= 0) {
      return
    }
    this.deps.remoteDesktopHostReclaimTargets.set(ptyId, { cols, rows })
  }

  hasRemoteDesktopLayoutState(ptyId: string): boolean {
    return this.deps.terminalClusterFacade().hasRemoteDesktopLayoutState(ptyId)
  }

  bumpRemoteDesktopViewerRevision(ptyId: string): number {
    const revision = (this.deps.remoteDesktopViewerRevisions.get(ptyId) ?? 0) + 1
    this.deps.remoteDesktopViewerRevisions.set(ptyId, revision)
    return revision
  }

  async applyRemoteDesktopLayout(ptyId: string): Promise<boolean> {
    return this.deps.terminalClusterFacade().applyRemoteDesktopLayout(ptyId)
  }

  async updateRemoteDesktopViewer(
    ptyId: string,
    subscriptionKey: string,
    clientId: string,
    cols: number,
    rows: number,
    claim = true
  ): Promise<boolean> {
    const viewport = clampTerminalViewport(cols, rows)
    if (claim) {
      this.ensureRemoteDesktopHostReclaimTarget(ptyId)
    }
    let viewers = this.deps.remoteDesktopViewers.get(ptyId)
    if (!viewers) {
      viewers = new Map<
        string,
        { clientId: string; cols: number; rows: number; activity: number }
      >()
      this.deps.remoteDesktopViewers.set(ptyId, viewers)
    }
    const prior = viewers.get(subscriptionKey)
    if (
      prior &&
      prior.cols === viewport.cols &&
      prior.rows === viewport.rows &&
      (!claim || this.deps.remoteDesktopOwners.get(ptyId) === subscriptionKey)
    ) {
      if (claim && this.deps.remoteDesktopOwners.get(ptyId) === subscriptionKey) {
        const size = this.deps.getTerminalSize(ptyId)
        if (size?.cols !== viewport.cols || size?.rows !== viewport.rows) {
          return this.applyRemoteDesktopLayout(ptyId)
        }
      }
      return true
    }
    const activity = claim ? ++this.deps.remoteDesktopActivity : (prior?.activity ?? 0)
    viewers.set(subscriptionKey, { clientId, cols: viewport.cols, rows: viewport.rows, activity })
    this.bumpRemoteDesktopViewerRevision(ptyId)
    if (claim) {
      this.deps.remoteDesktopOwners.set(ptyId, subscriptionKey)
      return this.applyRemoteDesktopLayout(ptyId)
    }
    return true
  }

  claimRemoteDesktopViewer(ptyId: string, subscriptionKey: string): Promise<boolean> {
    const viewer = this.deps.remoteDesktopViewers.get(ptyId)?.get(subscriptionKey)
    if (!viewer) {
      return Promise.resolve(false)
    }
    if (this.deps.remoteDesktopOwners.get(ptyId) === subscriptionKey) {
      const size = this.deps.getTerminalSize(ptyId)
      return size?.cols === viewer.cols && size?.rows === viewer.rows
        ? Promise.resolve(true)
        : this.applyRemoteDesktopLayout(ptyId)
    }
    this.ensureRemoteDesktopHostReclaimTarget(ptyId)
    viewer.activity = ++this.deps.remoteDesktopActivity
    this.deps.remoteDesktopOwners.set(ptyId, subscriptionKey)
    this.bumpRemoteDesktopViewerRevision(ptyId)
    return this.applyRemoteDesktopLayout(ptyId)
  }

  claimRemoteDesktopHost(ptyId: string, cols: number, rows: number): Promise<boolean> {
    if (!this.deps.remoteDesktopOwners.has(ptyId)) {
      // Why: disconnect can remove the owner before its queued host resize
      // lands. A host input in that window must join the reclaim, not pass it.
      return this.deps.remoteDesktopHostReclaimTargets.has(ptyId)
        ? this.applyRemoteDesktopLayout(ptyId)
        : Promise.resolve(true)
    }
    const viewport = clampTerminalViewport(cols, rows)
    this.deps.remoteDesktopHostReclaimTargets.set(ptyId, viewport)
    this.deps.remoteDesktopOwners.delete(ptyId)
    this.bumpRemoteDesktopViewerRevision(ptyId)
    return this.applyRemoteDesktopLayout(ptyId)
  }

  unregisterRemoteDesktopViewer(ptyId: string, subscriptionKey: string): Promise<boolean> {
    return this.unregisterRemoteDesktopViewers(ptyId, [subscriptionKey])
  }

  unregisterRemoteDesktopViewers(
    ptyId: string,
    subscriptionKeys: Iterable<string>
  ): Promise<boolean> {
    const viewers = this.deps.remoteDesktopViewers.get(ptyId)
    if (!viewers) {
      return Promise.resolve(false)
    }
    let changed = false
    let removedOwner = false
    for (const subscriptionKey of subscriptionKeys) {
      removedOwner = this.deps.remoteDesktopOwners.get(ptyId) === subscriptionKey || removedOwner
      changed = viewers.delete(subscriptionKey) || changed
    }
    if (!changed) {
      return Promise.resolve(false)
    }
    if (viewers.size === 0) {
      this.deps.remoteDesktopViewers.delete(ptyId)
    }
    if (removedOwner) {
      let fallback: { key: string; activity: number } | null = null
      for (const [key, viewer] of viewers) {
        if (viewer.activity > 0 && (!fallback || viewer.activity > fallback.activity)) {
          fallback = { key, activity: viewer.activity }
        }
      }
      if (fallback) {
        this.deps.remoteDesktopOwners.set(ptyId, fallback.key)
      } else {
        this.deps.remoteDesktopOwners.delete(ptyId)
      }
    }
    this.bumpRemoteDesktopViewerRevision(ptyId)
    return removedOwner ? this.applyRemoteDesktopLayout(ptyId) : Promise.resolve(true)
  }

  refreshRemoteDesktopViewer(
    ptyId: string,
    clientId: string,
    cols: number,
    rows: number,
    claim = false
  ): Promise<boolean> {
    const viewers = this.deps.remoteDesktopViewers.get(ptyId)
    if (!viewers) {
      return Promise.resolve(false)
    }
    const viewport = clampTerminalViewport(cols, rows)
    if (claim) {
      // Why: terminal.send may be the first activity while the stream is only
      // passively registered. Snapshot host truth before this refresh owns it.
      this.ensureRemoteDesktopHostReclaimTarget(ptyId)
    }
    let changed = false
    for (const [subscriptionKey, viewer] of viewers) {
      if (viewer.clientId === clientId) {
        const activity = claim ? ++this.deps.remoteDesktopActivity : viewer.activity
        viewers.set(subscriptionKey, {
          ...viewer,
          cols: viewport.cols,
          rows: viewport.rows,
          activity
        })
        if (claim) {
          this.deps.remoteDesktopOwners.set(ptyId, subscriptionKey)
        }
        changed = true
      }
    }
    if (!changed) {
      return Promise.resolve(false)
    }
    this.bumpRemoteDesktopViewerRevision(ptyId)
    return this.deps.remoteDesktopOwners.has(ptyId)
      ? this.applyRemoteDesktopLayout(ptyId)
      : Promise.resolve(true)
  }
}

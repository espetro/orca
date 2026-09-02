// Renderer globals for headless CI test scripts (browser evaluate callbacks only)

// eslint-disable @typescript-eslint/consistent-type-definitions
export interface OrcaPane {
  id?: string | null
  leafId?: string
  ptyId?: string
  title?: string
  terminal: {
    element?: Element | null
    focus(): void
    scrollToBottom(): void
    scrollLines?(n: number): void
    cols?: number
    rows?: number
    buffer: {
      active: {
        baseY: number
        viewportY: number
        cursorY: number
        cols: number
        rows: number
        length: number
      }
    }
  }
  container: {
    dataset: { ptyId?: string }
    querySelector(selector: string): Element | null
    isConnected?: boolean
  }
  serializeAddon?: { serialize(): string }
  getActivePane?(): OrcaPane
  getPanes?(): OrcaPane[]
  getRenderingDiagnostics?(): unknown
}
export interface OrcaTab {
  id: string
  ptyId?: string
  title?: string
  pendingActivationSpawn?: boolean
}
export interface OrcaRepo {
  id: string
}
export interface OrcaWorktree {
  id: string
}
export interface OrcaPaneLayout {
  activeLeafId?: string
  expandedLeafId?: string
  ptyIdsByLeafId?: Record<string, string>
  root?: unknown
}
export interface OrcaStore {
  getState(): OrcaState
}
export interface OrcaState {
  activeWorktreeId?: string | null
  activeTabId?: string | null
  activeTabType?: string | null
  activeRepoId?: string | null
  activeWorkspaceKey?: string | null
  activeTabIdByWorktree?: Record<string, string | null>
  repos?: OrcaRepo[]
  worktreesByRepo?: Record<string, OrcaWorktree[]>
  terminalLayoutsByTabId?: Record<string, OrcaPaneLayout>
  ptyIdsByTabId?: Record<string, string[]>
  workspaceSessionReady?: boolean
  hydrationSucceeded?: boolean
  fetchRepos(): Promise<void>
  fetchWorktrees(id: string, opts: { requireAuthoritative: boolean }): Promise<void>
  setActiveWorktree(id: string): void
  setActiveTab(id: string): void
  setActiveTabType(type: string): void
  tabsByWorktree: Record<string, OrcaTab[]>
  createTab(
    repoId: string,
    tabId: string | undefined,
    worktreeId: string | undefined,
    opts: object
  ): OrcaTab
}
// eslint-enable @typescript-eslint/consistent-type-definitions

// eslint-disable @typescript-eslint/consistent-type-definitions
declare global {
  interface Window {
    __store?: OrcaStore
    __paneManagers?: Map<string, OrcaPane>
    api?: {
      pty: {
        write(id: string, input: string): void
        listSessions?(): Promise<unknown>
        getRendererDeliveryDebugSnapshot?(): Promise<unknown>
      }
      repos?: {
        add(opts: {
          path: string
          kind: string
        }): Promise<{ repo?: { id: string }; error?: string }>
      }
    }
  }
}
// eslint-enable @typescript-eslint/consistent-type-definitions

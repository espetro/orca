/* eslint-disable max-lines -- Why: shared mock registrations and helpers for the split OrcaRuntimeService test suites */
import { createHash } from 'node:crypto'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../shared/project-group-types'
import type { TerminalLayoutSnapshot } from '../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import {
  addSparseWorktree,
  addWorktree,
  assertWorktreeCleanForRemoval,
  listWorktrees,
  listWorktreesStrict,
  removeWorktree
} from '../git/worktree'
import { getEffectiveHooks, hasHooksFile, loadHooks, parseOrcaYaml, runHook } from '../hooks'
import { createSetupRunnerScript, resolveSetupRunnerShell } from '../worktree-runner-script'
import {
  getEffectiveHooksFromConfig,
  getDefaultTabsLaunch,
  shouldRunSetupForCreate
} from '../effective-hook-config'
import type { OrchestrationDb } from './orchestration/db'
import type { MessagePriority, MessageRow, MessageType } from './orchestration/types'
import { OrcaRuntimeService } from './orca-runtime'
import { HeadlessEmulator } from '../daemon/headless-emulator'
import {
  buildAgentPromptPasteBytes,
  getTerminalPasteIngestMs
} from '../../shared/agent-prompt-injection'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { makePaneKey } from '../../shared/stable-pane-id'
import type { RpcRequest } from './rpc/core'
import { setWorktreeWatcherRemoval } from '../ipc/worktree-watcher-removal'
import { expect, vi } from 'vitest'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import { clearConfiguredWorktreeSharedDirectoriesCacheForTests } from '../git/worktree-shared-directories'
import { advertisedUrlWatcher } from '../ports/advertised-url-watcher'
import { setRuntimeTerminalUnavailableCause } from './native-terminal-availability'
import { RuntimeBrowserCommands } from './orca-runtime-browser'
import {
  setRuntimeBrowserCommandsFactory,
  setRuntimeBrowserUnavailableCause
} from './runtime-browser-commands-factory'
import { setRuntimeDesktopSurface } from './runtime-desktop-surface'
import { _resetTerminalViewAttributesForTest } from './terminal-view-attribute-store'
import { reviewHeadRemoteRefComponent } from '../../shared/review-head-tracking-ref'
import type * as GitUsernameModule from '../git/git-username'
import type { RuntimeMobileSessionTabsResult } from '../../shared/runtime-types'
export const ORIGINAL_PLATFORM = process.platform
const ORIGINAL_PLATFORM_DESCRIPTOR = Object.getOwnPropertyDescriptor(process, 'platform')
export const ORIGIN_REMOTE_URL = 'git@example.com:group/repo.git'
export const ORIGIN_HEAD_COMPONENT = reviewHeadRemoteRefComponent('origin', ORIGIN_REMOTE_URL)
const _removeWorktreeLinkedPathsMock = vi.hoisted(() => vi.fn())
const _findExistingWorktreeSymlinkPathsMock = vi.hoisted(() => vi.fn())
const _resolveLocalGitUsernameMock = vi.hoisted(() => vi.fn(async () => ''))

vi.mock('../ipc/worktree-symlinks', () => ({
  createWorktreeCopiedPaths: vi.fn(),
  createWorktreeLinkedPaths: vi.fn(),
  createWorktreeSharedPaths: vi.fn(),
  findExistingWorktreeSymlinkPaths: _findExistingWorktreeSymlinkPathsMock,
  removeWorktreeLinkedPaths: _removeWorktreeLinkedPathsMock
}))

export async function waitForMobileSessionTabsEvents(
  events: RuntimeMobileSessionTabsResult[],
  count: number
): Promise<void> {
  await vi.waitFor(() => expect(events).toHaveLength(count))
}

export function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: platform
  })
}

export function resetPlatform(): void {
  if (ORIGINAL_PLATFORM_DESCRIPTOR) {
    Object.defineProperty(process, 'platform', ORIGINAL_PLATFORM_DESCRIPTOR)
  }
}

export function acknowledgeAgentPromptSubmit(
  runtime: OrcaRuntimeService,
  ptyId: string,
  data: string
): void {
  if (data === '\r') {
    runtime.onPtyData(ptyId, '\x1b]0;Codex working\x07', Date.now())
  }
}

const _electronMocks = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void
  const listeners = new Map<string, Set<Listener>>()
  const ipcMain = {
    on: vi.fn((channel: string, listener: Listener) => {
      const existing = listeners.get(channel) ?? new Set<Listener>()
      existing.add(listener)
      listeners.set(channel, existing)
      return ipcMain
    }),
    removeListener: vi.fn((channel: string, listener: Listener) => {
      listeners.get(channel)?.delete(listener)
      return ipcMain
    }),
    emit: vi.fn((channel: string, ...args: unknown[]) => {
      for (const listener of listeners.get(channel) ?? []) {
        listener(...args)
      }
      return true
    })
  }
  return {
    BrowserWindow: { fromId: vi.fn((_id: number): unknown => null) },
    webContents: { fromId: vi.fn((_id: number): unknown => null) },
    ipcMain,
    app: { getPath: vi.fn(() => '/tmp'), isPackaged: false }
  }
})

const _closeLocalWatcherForWorktreePathMock = vi.hoisted(() => vi.fn())
const _closeRemoteWatcherForWorktreePathMock = vi.hoisted(() => vi.fn())
const _restoreLocalWatcherAfterFailedRemovalMock = vi.hoisted(() => vi.fn())
const _restoreRemoteWatcherAfterFailedRemovalMock = vi.hoisted(() => vi.fn())
const _forgetLocalWatcherRemovalSnapshotMock = vi.hoisted(() => vi.fn())
const _forgetRemoteWatcherRemovalSnapshotMock = vi.hoisted(() => vi.fn())
const _scanLocalRepoWorktreesForResolutionMock = vi.hoisted(() => vi.fn())

vi.mock('electron', () => _electronMocks)
// Why install the port instead of mocking ../ipc/filesystem-watcher: the runtime calls
// WorktreeWatcherRemoval now, so a module mock would be inert and every assertion below
// would silently pass against the inert default. Same mocks, same expectations.
setWorktreeWatcherRemoval({
  closeLocal: _closeLocalWatcherForWorktreePathMock,
  closeRemote: _closeRemoteWatcherForWorktreePathMock,
  restoreLocal: _restoreLocalWatcherAfterFailedRemovalMock,
  restoreRemote: _restoreRemoteWatcherAfterFailedRemovalMock,
  forgetLocal: _forgetLocalWatcherRemovalSnapshotMock,
  forgetRemote: _forgetRemoteWatcherRemovalSnapshotMock
})

const {
  _MOCK_GIT_WORKTREES,
  _addSparseWorktreeMock,
  _addWorktreeMock,
  _removeWorktreeMock,
  _forceDeleteLocalBranchMock,
  _computeWorktreePathMock,
  _ensurePathWithinWorkspaceMock,
  _sshGitProviders,
  _sshProviderGenerations,
  _getSshGitProviderMock,
  _getSshGitProviderGenerationMock,
  _registerSshGitProviderMock,
  _unregisterSshGitProviderMock,
  _getActiveMultiplexerMock,
  _muxRequestMock,
  _invalidateAuthorizedRootsCacheMock,
  _prepareLocalWorktreeRootForRepoMock,
  _createHostedReviewMock,
  _createStackedHostedReviewMock,
  _getHostedReviewCreationEligibilityMock,
  _getHostedReviewForBranchMock,
  _getPRForBranchMock,
  _getPRForBranchOutcomeMock,
  _getRepoSlugMock,
  _getRepoUpstreamMock,
  _getGitHubWorkItemMock,
  _getPullRequestPushTargetMock,
  _getGitHubWorkItemByOwnerRepoMock,
  _getGitHubWorkItemDetailsMock,
  _getGitHubPRFileContentsMock,
  _getGitHubPRChecksMock,
  _rerunGitHubPRChecksMock,
  _getGitHubPRCheckDetailsMock,
  _getGitHubPRCommentsMock,
  _resolveGitHubReviewThreadMock,
  _setGitHubPRFileViewedMock,
  _updateGitHubPRTitleMock,
  _updateGitHubPRDetailsMock,
  _mergeGitHubPRMock,
  _setGitHubPRAutoMergeMock,
  _updateGitHubPRStateMock,
  _requestGitHubPRReviewersMock,
  _removeGitHubPRReviewersMock,
  _addGitHubPRReviewCommentMock,
  _addGitHubPRReviewCommentReplyMock,
  _listGitHubIssuesMock,
  _listGitHubWorkItemsMock,
  _countGitHubWorkItemsMock,
  _createGitHubIssueMock,
  _updateGitHubIssueMock,
  _addGitHubIssueCommentMock,
  _listGitHubLabelsMock,
  _listGitHubAssignableUsersMock,
  _applyAgentStatusHooksEnabledMock,
  _detectInstalledAgentsWithShellPathHydrationMock,
  _detectRemoteAgentsMock,
  _markCodexProjectTrustedMock,
  _markCopilotFolderTrustedMock,
  _markCursorWorkspaceTrustedMock,
  _listGitLabMergeRequestsMock,
  _listGitLabWorkItemsMock,
  _listGitLabIssuesMock,
  _listGitLabLabelsMock,
  _listGitLabTodosMock,
  _getGitLabProjectRefForRemoteMock,
  _getGitLabWorkItemByProjectRefMock,
  _createGitLabIssueMock,
  _updateGitLabIssueMock,
  _addGitLabIssueCommentMock,
  _addGitLabMRCommentMock,
  _addGitLabMRInlineCommentMock,
  _resolveGitLabMRDiscussionMock,
  _getGitLabJobTraceMock,
  _retryGitLabJobMock,
  _mergeGitLabMRMock,
  _closeGitLabMRMock,
  _reopenGitLabMRMock,
  _updateGitLabMRMock,
  _getGlabKnownHostsMock,
  _getGitLabWorkItemDetailsMock,
  _updateGitLabMRReviewersMock,
  _getIssueMock,
  _deleteWorktreeHistoryDirMock
} = vi.hoisted(() => {
  // Why: SSH runtime tests register providers via the public dispatcher API, so the mock needs the same registry semantics as the real module.
  const _sshGitProviders = new Map<string, unknown>()
  const _sshProviderGenerations = new Map<string, number>()

  return {
    _MOCK_GIT_WORKTREES: [
      {
        path: '/tmp/worktree-a',
        head: 'abc',
        branch: 'feature/foo',
        isBare: false,
        isMainWorktree: false
      }
    ],
    _addSparseWorktreeMock: vi.fn(),
    _addWorktreeMock: vi.fn(),
    _removeWorktreeMock: vi.fn(),
    _forceDeleteLocalBranchMock: vi.fn(),
    _computeWorktreePathMock: vi.fn(),
    _ensurePathWithinWorkspaceMock: vi.fn(),
    _sshGitProviders,
    _sshProviderGenerations,
    _getSshGitProviderMock: vi.fn((connectionId: string) => _sshGitProviders.get(connectionId)),
    _getSshGitProviderGenerationMock: vi.fn(
      (connectionId: string) => _sshProviderGenerations.get(connectionId) ?? 0
    ),
    _registerSshGitProviderMock: vi.fn((connectionId: string, provider: unknown) => {
      _sshGitProviders.set(connectionId, provider)
      _sshProviderGenerations.set(
        connectionId,
        (_sshProviderGenerations.get(connectionId) ?? 0) + 1
      )
    }),
    _unregisterSshGitProviderMock: vi.fn((connectionId: string) => {
      if (_sshGitProviders.delete(connectionId)) {
        _sshProviderGenerations.set(
          connectionId,
          (_sshProviderGenerations.get(connectionId) ?? 0) + 1
        )
      }
    }),
    _getActiveMultiplexerMock: vi.fn(),
    _muxRequestMock: vi.fn(),
    _invalidateAuthorizedRootsCacheMock: vi.fn(),
    _prepareLocalWorktreeRootForRepoMock: vi.fn(),
    _createHostedReviewMock: vi.fn(),
    _createStackedHostedReviewMock: vi.fn(),
    _getHostedReviewCreationEligibilityMock: vi.fn(),
    _getHostedReviewForBranchMock: vi.fn(),
    _getPRForBranchMock: vi.fn().mockResolvedValue(null),
    _getPRForBranchOutcomeMock: vi.fn().mockResolvedValue({ kind: 'no-pr', fetchedAt: 0 }),
    _getRepoSlugMock: vi.fn().mockResolvedValue(null),
    _getRepoUpstreamMock: vi.fn().mockResolvedValue(null),
    _getGitHubWorkItemMock: vi.fn(),
    _getPullRequestPushTargetMock: vi.fn(),
    _getGitHubWorkItemByOwnerRepoMock: vi.fn(),
    _getGitHubWorkItemDetailsMock: vi.fn(),
    _getGitHubPRFileContentsMock: vi.fn(),
    _getGitHubPRChecksMock: vi.fn(),
    _rerunGitHubPRChecksMock: vi.fn(),
    _getGitHubPRCheckDetailsMock: vi.fn(),
    _getGitHubPRCommentsMock: vi.fn(),
    _resolveGitHubReviewThreadMock: vi.fn(),
    _setGitHubPRFileViewedMock: vi.fn(),
    _updateGitHubPRTitleMock: vi.fn(),
    _updateGitHubPRDetailsMock: vi.fn(),
    _mergeGitHubPRMock: vi.fn(),
    _setGitHubPRAutoMergeMock: vi.fn(),
    _updateGitHubPRStateMock: vi.fn(),
    _requestGitHubPRReviewersMock: vi.fn(),
    _removeGitHubPRReviewersMock: vi.fn(),
    _addGitHubPRReviewCommentMock: vi.fn(),
    _addGitHubPRReviewCommentReplyMock: vi.fn(),
    _listGitHubIssuesMock: vi.fn(),
    _listGitHubWorkItemsMock: vi.fn(),
    _countGitHubWorkItemsMock: vi.fn(),
    _createGitHubIssueMock: vi.fn(),
    _updateGitHubIssueMock: vi.fn(),
    _addGitHubIssueCommentMock: vi.fn(),
    _listGitHubLabelsMock: vi.fn(),
    _listGitHubAssignableUsersMock: vi.fn(),
    _applyAgentStatusHooksEnabledMock: vi.fn(),
    _detectInstalledAgentsWithShellPathHydrationMock: vi.fn(),
    _detectRemoteAgentsMock: vi.fn(),
    _markCodexProjectTrustedMock: vi.fn(),
    _markCopilotFolderTrustedMock: vi.fn(),
    _markCursorWorkspaceTrustedMock: vi.fn(),
    _listGitLabMergeRequestsMock: vi.fn(),
    _listGitLabWorkItemsMock: vi.fn(),
    _listGitLabIssuesMock: vi.fn(),
    _listGitLabLabelsMock: vi.fn(),
    _listGitLabTodosMock: vi.fn(),
    _getGitLabProjectRefForRemoteMock: vi.fn(),
    _getGitLabWorkItemByProjectRefMock: vi.fn(),
    _createGitLabIssueMock: vi.fn(),
    _updateGitLabIssueMock: vi.fn(),
    _addGitLabIssueCommentMock: vi.fn(),
    _addGitLabMRCommentMock: vi.fn(),
    _addGitLabMRInlineCommentMock: vi.fn(),
    _resolveGitLabMRDiscussionMock: vi.fn(),
    _getGitLabJobTraceMock: vi.fn(),
    _retryGitLabJobMock: vi.fn(),
    _mergeGitLabMRMock: vi.fn(),
    _closeGitLabMRMock: vi.fn(),
    _reopenGitLabMRMock: vi.fn(),
    _updateGitLabMRMock: vi.fn(),
    _getGlabKnownHostsMock: vi.fn(),
    _getGitLabWorkItemDetailsMock: vi.fn(),
    _updateGitLabMRReviewersMock: vi.fn(),
    _getIssueMock: vi.fn(),
    _deleteWorktreeHistoryDirMock: vi.fn()
  }
})

vi.mock('../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue(_MOCK_GIT_WORKTREES),
  listWorktreesStrict: vi.fn().mockResolvedValue(_MOCK_GIT_WORKTREES),
  assertWorktreeCleanForRemoval: vi.fn().mockResolvedValue(undefined),
  addSparseWorktree: _addSparseWorktreeMock,
  addWorktree: _addWorktreeMock,
  removeWorktree: _removeWorktreeMock,
  forceDeleteLocalBranch: _forceDeleteLocalBranchMock
}))

vi.mock('./repo-worktree-resolution-scan', () => ({
  scanLocalRepoWorktreesForResolution: _scanLocalRepoWorktreesForResolutionMock
}))

vi.mock('../terminal-history-deletion', () => ({
  deleteWorktreeHistoryDir: _deleteWorktreeHistoryDirMock
}))

vi.mock('../providers/ssh-git-dispatch', () => ({
  getSshGitProvider: _getSshGitProviderMock,
  getSshGitProviderGeneration: _getSshGitProviderGenerationMock,
  SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE:
    'Remote connection dropped. Click Reconnect on the SSH target before retrying.',
  requireSshGitProvider: (connectionId: string) => {
    const provider = _getSshGitProviderMock(connectionId)
    if (!provider) {
      throw new Error(
        'Remote connection dropped. Click Reconnect on the SSH target before retrying.'
      )
    }
    return provider
  },
  registerSshGitProvider: _registerSshGitProviderMock,
  unregisterSshGitProvider: _unregisterSshGitProviderMock
}))

vi.mock('../ssh/ssh-target-registry', () => ({
  getActiveMultiplexer: _getActiveMultiplexerMock,
  getRegisteredSshState: () => ({ remotePlatform: 'linux' })
}))

vi.mock('../preflight/agent-detection', () => ({
  detectInstalledAgentsWithShellPathHydration: _detectInstalledAgentsWithShellPathHydrationMock,
  detectRemoteAgents: _detectRemoteAgentsMock
}))

vi.mock('../agent-hooks/managed-agent-hook-controls', () => ({
  applyAgentStatusHooksEnabled: _applyAgentStatusHooksEnabledMock
}))

vi.mock('../agent-trust-presets', () => ({
  markCodexProjectTrusted: _markCodexProjectTrustedMock,
  markCopilotFolderTrusted: _markCopilotFolderTrustedMock,
  markCursorWorkspaceTrusted: _markCursorWorkspaceTrustedMock
}))

vi.mock('../hooks', () => ({
  getEffectiveHooks: vi.fn().mockReturnValue(null),
  loadHooks: vi.fn().mockReturnValue(null),
  runHook: vi.fn().mockResolvedValue({ success: true, output: '' }),
  hasHooksFile: vi.fn().mockReturnValue(false),
  parseOrcaYaml: vi.fn().mockReturnValue(null)
}))

vi.mock('../setup-runner-script-text', () => ({
  buildPosixRunnerScript: (script: string) => `#!/usr/bin/env bash\nset -e\n${script}\n`,
  buildWindowsRunnerScript: (script: string) => `@echo off\r\n${script}\r\n`
}))

vi.mock('../worktree-runner-script', () => ({
  createSetupRunnerScript: vi.fn(),
  resolveSetupRunnerShell: vi.fn().mockReturnValue(undefined)
}))

vi.mock('../setup-hook-env-vars', () => ({
  getSetupRunnerEnvVars: (_repo: never, worktreePath: string) => ({
    ORCA_ROOT_PATH: '/remote/repo',
    ORCA_WORKTREE_PATH: worktreePath
  })
}))

vi.mock('../effective-hook-config', () => ({
  getEffectiveHooksFromConfig: vi.fn().mockReturnValue(null),
  getDefaultTabCommandTrustContent: vi.fn(
    (hooks: { scripts?: { setup?: string } } | null) => hooks?.scripts?.setup?.trim() ?? ''
  ),
  getDefaultTabsLaunch: vi.fn().mockReturnValue(undefined),
  shouldRunSetupForCreate: vi
    .fn()
    .mockImplementation((_repo: never, decision: string) => decision === 'run'),
  getEffectiveSetupRunPolicy: vi.fn().mockReturnValue('auto')
}))

vi.mock('../ipc/worktree-logic', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    computeWorktreePath: _computeWorktreePathMock,
    ensurePathWithinWorkspace: _ensurePathWithinWorkspaceMock
  }
})

vi.mock('../ipc/filesystem-auth', () => ({
  resolveAuthorizedPath: vi.fn(async (pathValue: string) => pathValue)
}))

vi.mock('../ipc/registered-worktree-roots-cache', () => ({
  invalidateAuthorizedRootsCache: _invalidateAuthorizedRootsCacheMock
}))

vi.mock('../ipc/filesystem-path-containment', () => ({
  isENOENT: (error: unknown) =>
    Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}))

vi.mock('../worktree-root-preparation', () => ({
  prepareLocalWorktreeRootForRepo: _prepareLocalWorktreeRootForRepoMock
}))

vi.mock('../source-control/hosted-review-creation', () => ({
  createHostedReview: _createHostedReviewMock,
  getHostedReviewCreationEligibility: _getHostedReviewCreationEligibilityMock
}))

vi.mock('../source-control/stacked-hosted-review-creation', () => ({
  createStackedHostedReview: _createStackedHostedReviewMock
}))

vi.mock('../source-control/hosted-review', () => ({
  getHostedReviewForBranch: _getHostedReviewForBranchMock
}))

vi.mock('../github/client', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    getPRForBranch: _getPRForBranchMock,
    getPRForBranchOutcome: _getPRForBranchOutcomeMock,
    getRepoSlug: _getRepoSlugMock,
    getRepoUpstream: _getRepoUpstreamMock,
    getWorkItem: _getGitHubWorkItemMock,
    getPullRequestPushTarget: _getPullRequestPushTargetMock,
    getWorkItemByOwnerRepo: _getGitHubWorkItemByOwnerRepoMock,
    getPRChecks: _getGitHubPRChecksMock,
    rerunPRChecks: _rerunGitHubPRChecksMock,
    getPRCheckDetails: _getGitHubPRCheckDetailsMock,
    getPRComments: _getGitHubPRCommentsMock,
    resolveReviewThread: _resolveGitHubReviewThreadMock,
    setPRFileViewed: _setGitHubPRFileViewedMock,
    updatePRTitle: _updateGitHubPRTitleMock,
    updatePRDetails: _updateGitHubPRDetailsMock,
    mergePR: _mergeGitHubPRMock,
    setPRAutoMerge: _setGitHubPRAutoMergeMock,
    updatePRState: _updateGitHubPRStateMock,
    requestPRReviewers: _requestGitHubPRReviewersMock,
    removePRReviewers: _removeGitHubPRReviewersMock,
    addPRReviewComment: _addGitHubPRReviewCommentMock,
    addPRReviewCommentReply: _addGitHubPRReviewCommentReplyMock,
    listIssues: _listGitHubIssuesMock,
    listWorkItems: _listGitHubWorkItemsMock,
    countWorkItems: _countGitHubWorkItemsMock,
    getIssue: _getIssueMock,
    createIssue: _createGitHubIssueMock,
    updateIssue: _updateGitHubIssueMock,
    addIssueComment: _addGitHubIssueCommentMock,
    listLabels: _listGitHubLabelsMock,
    listAssignableUsers: _listGitHubAssignableUsersMock
  }
})

vi.mock('../gitlab/client', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    listMergeRequests: _listGitLabMergeRequestsMock,
    listWorkItems: _listGitLabWorkItemsMock,
    listIssues: _listGitLabIssuesMock,
    listLabels: _listGitLabLabelsMock,
    listTodos: _listGitLabTodosMock,
    getProjectRefForRemote: _getGitLabProjectRefForRemoteMock,
    getWorkItemByProjectRef: _getGitLabWorkItemByProjectRefMock,
    createIssue: _createGitLabIssueMock,
    updateIssue: _updateGitLabIssueMock,
    addIssueComment: _addGitLabIssueCommentMock,
    addMRComment: _addGitLabMRCommentMock,
    addMRInlineComment: _addGitLabMRInlineCommentMock,
    resolveMRDiscussion: _resolveGitLabMRDiscussionMock,
    getJobTrace: _getGitLabJobTraceMock,
    retryJob: _retryGitLabJobMock,
    mergeMR: _mergeGitLabMRMock,
    closeMR: _closeGitLabMRMock,
    reopenMR: _reopenGitLabMRMock,
    updateMR: _updateGitLabMRMock,
    updateMRReviewers: _updateGitLabMRReviewersMock
  }
})

vi.mock('../gitlab/gl-utils', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    getGlabKnownHosts: _getGlabKnownHostsMock
  }
})

vi.mock('../gitlab/work-item-details', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    getWorkItemDetails: _getGitLabWorkItemDetailsMock
  }
})

vi.mock('../github/work-item-details', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    getWorkItemDetails: _getGitHubWorkItemDetailsMock,
    getPRFileContents: _getGitHubPRFileContentsMock
  }
})

vi.mock('../github/issues', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    getIssue: _getIssueMock
  }
})

// Why: CLI worktree creation resolves a default against fabricated repo paths, so keep the async resolver deterministic.
vi.mock('../git/repo', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  const actualGetBaseRefDefault = actual.getBaseRefDefault as (
    path: string,
    options?: { wslDistro?: string }
  ) => Promise<string | null>
  return {
    ...actual,
    // Why: fabricated local test repos need a deterministic default, while WSL coverage must still exercise the real async Git-options path.
    getBaseRefDefault: vi
      .fn()
      .mockImplementation((path: string, options?: { wslDistro?: string }) =>
        options?.wslDistro ? actualGetBaseRefDefault(path, options) : Promise.resolve('origin/main')
      ),
    getBranchConflictKind: vi.fn().mockResolvedValue(null)
  }
})

vi.mock('../git/git-username', async () => {
  const actual = await vi.importActual<typeof GitUsernameModule>('../git/git-username')
  return { ...actual, resolveLocalGitUsername: _resolveLocalGitUsernameMock }
})

export function resetRuntimeTestMocks(): void {
  // Why: constructing the browser commands is what pulls the Chromium cluster in, so
  // production installs this at the Electron entry. A Node host installs none and the
  // browser RPCs reject rather than silently succeeding.
  setRuntimeBrowserCommandsFactory((host) => new RuntimeBrowserCommands(host))
  setRuntimeBrowserUnavailableCause(null)
  setRuntimeTerminalUnavailableCause(null)
  // Why: the runtime's notification, window lookup and tab-create-reply channel are
  // injected now, so the electron mock alone is inert. Back the surface with the same
  // mocks so every existing expectation still holds.
  setRuntimeDesktopSurface({
    showNotification: () => true,
    findWindowById: (id) => _electronMocks.BrowserWindow.fromId(id) as never,
    onIpc: (channel, listener) => _electronMocks.ipcMain.on(channel, listener as never),
    removeIpcListener: (channel, listener) =>
      _electronMocks.ipcMain.removeListener(channel, listener as never)
  })
  resetPlatform()
  _electronMocks.app.isPackaged = false
  // Why here and not the electron mock: the runtime reads paths and the packaged flag
  // through the AppEnvironment port now, so the electron mock alone is inert. Reading
  // _electronMocks.app keeps the existing per-test toggles below working unchanged.
  installFakeAppEnvironment({
    getPath: () => _electronMocks.app.getPath(),
    isPackaged: () => _electronMocks.app.isPackaged
  })
  clearConfiguredWorktreeSharedDirectoriesCacheForTests()
  _resetTerminalViewAttributesForTest()
  advertisedUrlWatcher.clear()
  _electronMocks.BrowserWindow.fromId.mockReset()
  _electronMocks.BrowserWindow.fromId.mockReturnValue(null)
  _electronMocks.webContents.fromId.mockReset()
  _electronMocks.webContents.fromId.mockReturnValue(null)
  _electronMocks.ipcMain.on.mockClear()
  _electronMocks.ipcMain.removeListener.mockClear()
  _electronMocks.ipcMain.emit.mockClear()
  _closeLocalWatcherForWorktreePathMock.mockReset().mockResolvedValue(undefined)
  _closeRemoteWatcherForWorktreePathMock.mockReset().mockResolvedValue(undefined)
  _restoreLocalWatcherAfterFailedRemovalMock.mockReset().mockResolvedValue(undefined)
  _restoreRemoteWatcherAfterFailedRemovalMock.mockReset().mockResolvedValue(undefined)
  _forgetLocalWatcherRemovalSnapshotMock.mockReset()
  _forgetRemoteWatcherRemovalSnapshotMock.mockReset()
  vi.mocked(listWorktrees).mockResolvedValue(_MOCK_GIT_WORKTREES)
  vi.mocked(listWorktreesStrict).mockResolvedValue(_MOCK_GIT_WORKTREES)
  _scanLocalRepoWorktreesForResolutionMock
    .mockReset()
    .mockImplementation(async (repoPath: string, options: { wslDistro?: string }) => {
      try {
        const worktrees = options.wslDistro
          ? await listWorktrees(repoPath, options)
          : await listWorktrees(repoPath)
        return { ok: true, worktrees }
      } catch {
        return { ok: false, worktrees: [] }
      }
    })
  vi.mocked(addWorktree).mockReset()
  vi.mocked(addSparseWorktree).mockReset()
  vi.mocked(assertWorktreeCleanForRemoval).mockReset()
  vi.mocked(assertWorktreeCleanForRemoval).mockResolvedValue(undefined)
  vi.mocked(removeWorktree).mockReset()
  _findExistingWorktreeSymlinkPathsMock.mockReset().mockResolvedValue([])
  _removeWorktreeLinkedPathsMock.mockReset()
  _resolveLocalGitUsernameMock.mockReset().mockResolvedValue('')
  vi.mocked(_forceDeleteLocalBranchMock).mockReset()
  vi.mocked(_forceDeleteLocalBranchMock).mockResolvedValue(undefined)
  _sshGitProviders.clear()
  _sshProviderGenerations.clear()
  _getSshGitProviderMock.mockReset()
  _getSshGitProviderMock.mockImplementation((connectionId: string) =>
    _sshGitProviders.get(connectionId)
  )
  _registerSshGitProviderMock.mockReset()
  _registerSshGitProviderMock.mockImplementation((connectionId: string, provider: unknown) => {
    _sshGitProviders.set(connectionId, provider)
    _sshProviderGenerations.set(connectionId, (_sshProviderGenerations.get(connectionId) ?? 0) + 1)
  })
  _unregisterSshGitProviderMock.mockReset()
  _unregisterSshGitProviderMock.mockImplementation((connectionId: string) => {
    if (_sshGitProviders.delete(connectionId)) {
      _sshProviderGenerations.set(
        connectionId,
        (_sshProviderGenerations.get(connectionId) ?? 0) + 1
      )
    }
  })
  _muxRequestMock.mockReset()
  _muxRequestMock.mockResolvedValue(undefined)
  _applyAgentStatusHooksEnabledMock.mockReset().mockResolvedValue([])
  _getActiveMultiplexerMock.mockReset()
  _getActiveMultiplexerMock.mockReturnValue({ request: _muxRequestMock, notify: vi.fn() })
  vi.mocked(createSetupRunnerScript).mockReset()
  vi.mocked(getEffectiveHooks).mockReset()
  vi.mocked(getEffectiveHooksFromConfig).mockReset()
  vi.mocked(getDefaultTabsLaunch).mockReset()
  vi.mocked(loadHooks).mockReset()
  vi.mocked(resolveSetupRunnerShell).mockReset()
  vi.mocked(hasHooksFile).mockReset()
  vi.mocked(parseOrcaYaml).mockReset()
  vi.mocked(runHook).mockReset()
  vi.mocked(shouldRunSetupForCreate).mockReset()
  vi.mocked(shouldRunSetupForCreate).mockImplementation((_repo, decision) => decision === 'run')
  vi.mocked(getEffectiveHooks).mockReturnValue(null)
  vi.mocked(getEffectiveHooksFromConfig).mockReturnValue(null)
  vi.mocked(getDefaultTabsLaunch).mockReturnValue(undefined)
  vi.mocked(loadHooks).mockReturnValue(null)
  vi.mocked(resolveSetupRunnerShell).mockReturnValue(undefined)
  vi.mocked(hasHooksFile).mockReturnValue(false)
  vi.mocked(parseOrcaYaml).mockReturnValue(null)
  _computeWorktreePathMock.mockReset()
  _ensurePathWithinWorkspaceMock.mockReset()
  _invalidateAuthorizedRootsCacheMock.mockReset()
  _prepareLocalWorktreeRootForRepoMock.mockReset().mockResolvedValue(undefined)
  _createHostedReviewMock.mockReset()
  _createHostedReviewMock.mockResolvedValue({
    ok: true,
    provider: 'github',
    number: 1,
    url: 'https://example.com/pull/1'
  })
  _createStackedHostedReviewMock.mockReset()
  _createStackedHostedReviewMock.mockResolvedValue({
    ok: true,
    number: 2,
    url: 'https://example.com/pull/2',
    stackNumber: 10,
    parentReview: { number: 1, url: 'https://example.com/pull/1' }
  })
  _getHostedReviewCreationEligibilityMock.mockReset()
  _getHostedReviewCreationEligibilityMock.mockResolvedValue({
    provider: 'github',
    review: null,
    canCreate: true,
    blockedReason: null,
    nextAction: null,
    defaultBaseRef: 'main',
    head: 'feature/foo',
    title: null,
    body: null
  })
  _getHostedReviewForBranchMock.mockReset()
  _getHostedReviewForBranchMock.mockResolvedValue(null)
  _getPRForBranchMock.mockReset()
  _getPRForBranchMock.mockResolvedValue(null)
  _getPRForBranchOutcomeMock.mockReset()
  _getPRForBranchOutcomeMock.mockResolvedValue({ kind: 'no-pr', fetchedAt: 0 })
  _getRepoSlugMock.mockReset()
  _getRepoSlugMock.mockResolvedValue(null)
  _getRepoUpstreamMock.mockReset()
  _getRepoUpstreamMock.mockResolvedValue(null)
  _getGitHubWorkItemMock.mockReset()
  _getGitHubWorkItemMock.mockResolvedValue(null)
  _getPullRequestPushTargetMock.mockReset()
  _getPullRequestPushTargetMock.mockResolvedValue(null)
  _getGitHubWorkItemByOwnerRepoMock.mockReset()
  _getGitHubWorkItemByOwnerRepoMock.mockResolvedValue(null)
  _getGitHubWorkItemDetailsMock.mockReset()
  _getGitHubWorkItemDetailsMock.mockResolvedValue(null)
  _getGitHubPRFileContentsMock.mockReset()
  _getGitHubPRFileContentsMock.mockResolvedValue({ original: '', modified: '' })
  _getGitHubPRChecksMock.mockReset()
  _getGitHubPRChecksMock.mockResolvedValue([])
  _rerunGitHubPRChecksMock.mockReset()
  _rerunGitHubPRChecksMock.mockResolvedValue({ ok: true, count: 0 })
  _getGitHubPRCheckDetailsMock.mockReset()
  _getGitHubPRCheckDetailsMock.mockResolvedValue(null)
  _getGitHubPRCommentsMock.mockReset()
  _getGitHubPRCommentsMock.mockResolvedValue([])
  _resolveGitHubReviewThreadMock.mockReset()
  _resolveGitHubReviewThreadMock.mockResolvedValue(true)
  _setGitHubPRFileViewedMock.mockReset()
  _setGitHubPRFileViewedMock.mockResolvedValue(true)
  _updateGitHubPRTitleMock.mockReset()
  _updateGitHubPRTitleMock.mockResolvedValue(true)
  _updateGitHubPRDetailsMock.mockReset()
  _updateGitHubPRDetailsMock.mockResolvedValue({ ok: true })
  _mergeGitHubPRMock.mockReset()
  _mergeGitHubPRMock.mockResolvedValue({ ok: true })
  _setGitHubPRAutoMergeMock.mockReset()
  _setGitHubPRAutoMergeMock.mockResolvedValue({ ok: true })
  _updateGitHubPRStateMock.mockReset()
  _updateGitHubPRStateMock.mockResolvedValue({ ok: true })
  _requestGitHubPRReviewersMock.mockReset()
  _requestGitHubPRReviewersMock.mockResolvedValue({ ok: true })
  _removeGitHubPRReviewersMock.mockReset()
  _removeGitHubPRReviewersMock.mockResolvedValue({ ok: true })
  _addGitHubPRReviewCommentMock.mockReset()
  _addGitHubPRReviewCommentMock.mockResolvedValue({ ok: true })
  _addGitHubPRReviewCommentReplyMock.mockReset()
  _addGitHubPRReviewCommentReplyMock.mockResolvedValue({ ok: true })
  _listGitHubIssuesMock.mockReset()
  _listGitHubIssuesMock.mockResolvedValue({ items: [] })
  _listGitHubWorkItemsMock.mockReset()
  _listGitHubWorkItemsMock.mockResolvedValue({ items: [] })
  _countGitHubWorkItemsMock.mockReset()
  _countGitHubWorkItemsMock.mockResolvedValue(0)
  _createGitHubIssueMock.mockReset()
  _createGitHubIssueMock.mockResolvedValue({ ok: true, number: 1, url: 'https://example.com/1' })
  _updateGitHubIssueMock.mockReset()
  _updateGitHubIssueMock.mockResolvedValue({ ok: true })
  _addGitHubIssueCommentMock.mockReset()
  _addGitHubIssueCommentMock.mockResolvedValue({ ok: true })
  _listGitHubLabelsMock.mockReset()
  _listGitHubLabelsMock.mockResolvedValue([])
  _listGitHubAssignableUsersMock.mockReset()
  _listGitHubAssignableUsersMock.mockResolvedValue([])
  _detectInstalledAgentsWithShellPathHydrationMock.mockReset()
  _detectInstalledAgentsWithShellPathHydrationMock.mockResolvedValue([])
  _detectRemoteAgentsMock.mockReset()
  _detectRemoteAgentsMock.mockResolvedValue([])
  _markCodexProjectTrustedMock.mockReset()
  _markCopilotFolderTrustedMock.mockReset()
  _markCursorWorkspaceTrustedMock.mockReset()
  _listGitLabMergeRequestsMock.mockReset()
  _listGitLabMergeRequestsMock.mockResolvedValue({ items: [] })
  _listGitLabWorkItemsMock.mockReset()
  _listGitLabWorkItemsMock.mockResolvedValue({ items: [] })
  _listGitLabIssuesMock.mockReset()
  _listGitLabIssuesMock.mockResolvedValue({ items: [] })
  _listGitLabLabelsMock.mockReset()
  _listGitLabLabelsMock.mockResolvedValue(['bug'])
  _listGitLabTodosMock.mockReset()
  _listGitLabTodosMock.mockResolvedValue([])
  _getGitLabProjectRefForRemoteMock.mockReset()
  _getGitLabProjectRefForRemoteMock.mockResolvedValue({
    host: 'gitlab.example',
    path: 'group/repo'
  })
  _getGlabKnownHostsMock.mockReset()
  _getGlabKnownHostsMock.mockResolvedValue(['gitlab.com'])
  _getGitLabWorkItemByProjectRefMock.mockReset()
  _getGitLabWorkItemByProjectRefMock.mockResolvedValue(null)
  _createGitLabIssueMock.mockReset()
  _createGitLabIssueMock.mockResolvedValue({
    ok: true,
    number: 1,
    url: 'https://gitlab.example/i/1'
  })
  _updateGitLabIssueMock.mockReset()
  _updateGitLabIssueMock.mockResolvedValue({ ok: true })
  _addGitLabIssueCommentMock.mockReset()
  _addGitLabIssueCommentMock.mockResolvedValue({ ok: true })
  _addGitLabMRCommentMock.mockReset()
  _addGitLabMRCommentMock.mockResolvedValue({ ok: true })
  _addGitLabMRInlineCommentMock.mockReset()
  _addGitLabMRInlineCommentMock.mockResolvedValue({ ok: true })
  _resolveGitLabMRDiscussionMock.mockReset()
  _resolveGitLabMRDiscussionMock.mockResolvedValue({ ok: true })
  _getGitLabJobTraceMock.mockReset()
  _getGitLabJobTraceMock.mockResolvedValue({ ok: true, trace: 'log' })
  _retryGitLabJobMock.mockReset()
  _retryGitLabJobMock.mockResolvedValue({ ok: true })
  _mergeGitLabMRMock.mockReset()
  _mergeGitLabMRMock.mockResolvedValue({ ok: true })
  _closeGitLabMRMock.mockReset()
  _closeGitLabMRMock.mockResolvedValue({ ok: true })
  _reopenGitLabMRMock.mockReset()
  _reopenGitLabMRMock.mockResolvedValue({ ok: true })
  _updateGitLabMRMock.mockReset()
  _updateGitLabMRMock.mockResolvedValue({ ok: true })
  _getGitLabWorkItemDetailsMock.mockReset()
  _getGitLabWorkItemDetailsMock.mockResolvedValue({ body: 'Details' })
  _updateGitLabMRReviewersMock.mockReset()
  _updateGitLabMRReviewersMock.mockResolvedValue({ ok: true, reviewers: [] })
  _getIssueMock.mockReset()
  _getIssueMock.mockResolvedValue(null)
}

export function syncSinglePty(
  runtime: OrcaRuntimeService,
  ptyId: string | null = 'pty-1',
  options: { tabTitle?: string | null; paneTitle?: string | null } = {}
): void {
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, {
    tabs: [
      {
        tabId: 'tab-1',
        worktreeId: TEST_WORKTREE_ID,
        title: options.tabTitle ?? 'Codex',
        activeLeafId: 'pane:1',
        layout: null
      }
    ],
    leaves: [
      {
        tabId: 'tab-1',
        worktreeId: TEST_WORKTREE_ID,
        leafId: 'pane:1',
        paneRuntimeId: 1,
        ptyId,
        paneTitle: options.paneTitle ?? null
      }
    ]
  })
}

export function makeDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

export function makeStatusFrame(index: number, first: boolean): string {
  const pad = '·'.repeat(60)
  const rows = [
    `✻ 执行任务中… (esc to interrupt) [${index}] ${pad}`,
    `  ⎿ 正在分析代码库结构与依赖关系，请稍候… ${pad}`,
    `  ⎿ tokens: ${1000 + index * 137} · elapsed: ${index}s ${pad}`
  ]
  return `${first ? '' : '\x1b[2A'}\r${rows.map((row) => `\x1b[K${row}`).join('\r\n')}\r`
}

export async function writeHeadless(emulator: HeadlessEmulator, data: string): Promise<void> {
  await emulator.write(data)
}

export function visibleNonEmptyLines(emulator: HeadlessEmulator): string[] {
  return emulator.getVisibleLines().filter((line) => line.length > 0)
}

export async function parseHeadlessSnapshotLines(
  snapshot: { data: string; cols: number; rows: number },
  display: { cols: number; rows: number }
): Promise<string[]> {
  const restored = new HeadlessEmulator({ cols: display.cols, rows: display.rows })
  try {
    restored.resize(snapshot.cols, snapshot.rows)
    await writeHeadless(restored, `\x1b[2J\x1b[3J\x1b[H${snapshot.data}`)
    restored.resize(display.cols, display.rows)
    return visibleNonEmptyLines(restored)
  } finally {
    restored.dispose()
  }
}

export async function referenceStatusFrameLines(
  spawn: { cols: number; rows: number },
  resized: { cols: number; rows: number }
): Promise<string[]> {
  const truth = new HeadlessEmulator({ cols: spawn.cols, rows: spawn.rows })
  try {
    await writeHeadless(truth, 'user@host % claude\r\n')
    truth.resize(resized.cols, resized.rows)
    for (let index = 0; index < 5; index += 1) {
      await writeHeadless(truth, makeStatusFrame(index, index === 0))
    }
    return visibleNonEmptyLines(truth)
  } finally {
    truth.dispose()
  }
}

export const TEST_WINDOW_ID = 1
// The inventory refresh forwards its own budget so a relay cannot outlive it (STA-517).
// These assertions are about which provider scope was asked, so the deadline stays loose.
export const LIST_PROVIDER_DEADLINE = expect.objectContaining({ deadlineMs: expect.any(Number) })
export const TEST_REPO_ID = 'repo-1'
export const TEST_REPO_PATH = '/tmp/repo'
export const TEST_WORKTREE_PATH = '/tmp/worktree-a'
export const TEST_WORKTREE_ID = `${TEST_REPO_ID}::${TEST_WORKTREE_PATH}`
/** The render gate's hard cap bounds the wait *after* the paste lands, so it carries the
 *  payload's ingest bound on top of the flat 8 s settlement budget. */
export function renderGateCapMs(prompt: string): number {
  return (
    8_000 +
    getTerminalPasteIngestMs(
      process.platform,
      Buffer.byteLength(buildAgentPromptPasteBytes(prompt), 'utf8')
    )
  )
}
export const TEST_FOLDER_PROJECT_GROUP_ID = 'folder-project-group-1'
export const TEST_FOLDER_WORKSPACE_ID = 'folder-workspace-1'
export const TEST_FOLDER_WORKSPACE_KEY = `folder:${TEST_FOLDER_WORKSPACE_ID}`
export const TEST_FOLDER_WORKSPACE_PATH = '/tmp/platform'
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
export const HEADLESS_LEAF_ID = '11111111-1111-4111-8111-111111111111'
export const HEADLESS_SECOND_LEAF_ID = '22222222-2222-4222-8222-222222222222'
export const HEADLESS_THIRD_LEAF_ID = '33333333-3333-4333-8333-333333333333'
export const RESTORED_AUTHORITY_TOKEN = 'restored-authority-secret'
export const RESTORED_AUTHORITY_TOKEN_HASH = createHash('sha256')
  .update(RESTORED_AUTHORITY_TOKEN)
  .digest('hex')

export function isOriginMainBaseRefProbe(args: string[]): boolean {
  return (
    args[0] === 'rev-parse' &&
    args[1] === '--verify' &&
    (args.includes('origin/main') ||
      args.includes('refs/remotes/origin/main') ||
      args.includes('refs/remotes/origin/main^{commit}'))
  )
}

export function antigravityReadyScreen(model = 'Gemini 3.5 Flash (High)'): string {
  return [
    'Antigravity CLI 1.0.3',
    'user@example.com (Antigravity Business)',
    model,
    '~/orca/workspaces/orca/agy-dispatch-issue',
    '>'
  ].join('\n')
}

export function antigravityPromptBeforeModelReadyScreen(model = 'Gemini 3.5 Flash (High)'): string {
  return [
    'Antigravity CLI 1.0.3',
    'user@example.com',
    '~/orca/workspaces/orca/agy-dispatch-issue',
    '',
    '',
    '',
    '',
    '>',
    '',
    '? for shortcuts',
    `\t\t  ${model}`,
    '~/orca/workspaces/orca/agy-dispatch-issue',
    '',
    model,
    ' (Antigravity Business)'
  ].join('\n')
}

// Why: verbatim cursor-agent 2026.07 idle screen; the matcher keys on the "→" glyph, not the placeholder (which changes after the first turn).
export function cursorReadyScreen(): string {
  return [
    'Cursor Agent',
    'v2026.07.09-a3815c0',
    'Tip: Use /plan to plan execution and reach the right outcome faster.',
    '→ Plan, search, build anything',
    'Composer 2.5 Fast                                          Run Everything',
    '~/Documents/projects/AutoGenie · main'
  ].join('\n')
}

export function cursorBusyScreen(): string {
  return [
    'Cursor Agent',
    'v2026.07.09-a3815c0',
    '⠰⠳ Thinking  28.61k tokens',
    '→ Plan, search, build anything',
    'Composer 2.5 Fast                                          Run Everything',
    '~/Documents/projects/AutoGenie · main'
  ].join('\n')
}

// Why: these tests only need message-queue semantics; real SQLite would make them fail on unrelated native runtime ABI drift.
export class InMemoryOrchestrationMessages {
  private sequence = 0

  private activeCoordinatorRun: { coordinator_handle: string } | null = null

  private messages: MessageRow[] = []

  private runs = new Map<
    string,
    { id: string; coordinator_handle: string | null; coordinator_pane_key: string | null }
  >()

  insertMessage(msg: {
    from: string
    to: string
    subject: string
    body?: string
    type?: MessageType
    priority?: MessagePriority
    threadId?: string
    payload?: string
  }): MessageRow {
    this.sequence += 1
    const row: MessageRow = {
      id: `msg_${this.sequence}`,
      run_id: 'run_test',
      from_handle: msg.from,
      to_handle: msg.to,
      subject: msg.subject,
      body: msg.body ?? '',
      type: msg.type ?? 'status',
      priority: msg.priority ?? 'normal',
      thread_id: msg.threadId ?? null,
      payload: msg.payload ?? null,
      read: 0,
      sequence: this.sequence,
      created_at: '1970-01-01 00:00:00',
      delivered_at: null,
      sender_pane_key: null
    }
    this.messages.push(row)
    return row
  }

  getUnreadMessages(toHandle: string, types?: MessageType[]): MessageRow[] {
    return this.messages
      .filter(
        (message) =>
          message.to_handle === toHandle &&
          message.read === 0 &&
          (!types || types.length === 0 || types.includes(message.type))
      )
      .sort((a, b) => a.sequence - b.sequence)
  }

  getUndeliveredUnreadMessages(toHandle: string, types?: MessageType[]): MessageRow[] {
    return this.getUnreadMessages(toHandle, types).filter((message) => !message.delivered_at)
  }

  getUndeliveredUnreadMailboxHandles(): string[] {
    return [
      ...new Set(
        this.messages
          .filter((message) => message.read === 0 && !message.delivered_at)
          .map((message) => message.to_handle)
      )
    ]
  }

  setActiveCoordinatorRun(run: { coordinator_handle: string } | null): void {
    this.activeCoordinatorRun = run
  }

  getActiveCoordinatorRun(): { coordinator_handle: string } | null {
    return this.activeCoordinatorRun
  }

  setRun(run: {
    id: string
    coordinator_handle: string | null
    coordinator_pane_key?: string | null
  }): void {
    this.runs.set(run.id, { coordinator_pane_key: null, ...run })
  }

  getRun(
    id: string
  ):
    | { id: string; coordinator_handle: string | null; coordinator_pane_key: string | null }
    | undefined {
    return this.runs.get(id)
  }

  getCurrentRunForPane(
    paneKey: string
  ):
    | { id: string; coordinator_handle: string | null; coordinator_pane_key: string | null }
    | undefined {
    return [...this.runs.values()].find((run) => run.coordinator_pane_key === paneKey)
  }

  listWorkerTerminalReleaseBacklog(): never[] {
    return []
  }

  hasUndeliveredDirectMessageForRun(runId: string, directHandle: string): boolean {
    return this.messages.some(
      (message) =>
        message.run_id === runId &&
        message.to_handle === directHandle &&
        message.read === 0 &&
        !message.delivered_at
    )
  }

  routeUnreadDirectMessagesToRunMailbox(
    runId: string,
    directHandle: string
  ): { routedCount: number; hasMore: boolean; types: MessageType[] } {
    const routed = this.messages.filter(
      (message) =>
        message.run_id === runId && message.to_handle === directHandle && message.read === 0
    )
    for (const message of routed) {
      message.to_handle = `run:${runId}`
    }
    return {
      routedCount: routed.length,
      hasMore: false,
      types: [...new Set(routed.map((message) => message.type))]
    }
  }

  areUnreadMessages(toHandle: string, ids: string[]): boolean {
    return ids.every((id) =>
      this.messages.some(
        (message) => message.id === id && message.to_handle === toHandle && message.read === 0
      )
    )
  }

  markAsDelivered(ids: string[]): void {
    const deliveredIds = new Set(ids)
    for (const message of this.messages) {
      if (deliveredIds.has(message.id)) {
        message.delivered_at = '1970-01-01 00:00:00'
      }
    }
  }

  markAsUndelivered(ids: string[]): void {
    const releasedIds = new Set(ids)
    for (const message of this.messages) {
      if (releasedIds.has(message.id) && message.read === 0) {
        message.delivered_at = null
      }
    }
  }

  close(): void {}
}

export function setInMemoryOrchestrationMessages(
  runtime: OrcaRuntimeService,
  db: InMemoryOrchestrationMessages
): void {
  runtime.setOrchestrationDb(db as unknown as OrchestrationDb)
}

export function pendingMailPointerRepoints(runtime: OrcaRuntimeService): number {
  const internals = runtime as unknown as {
    mailPointerRepointScheduler: { pendingCount: number }
  }
  return internals.mailPointerRepointScheduler.pendingCount
}

export function bindSinglePtyRun(
  db: InMemoryOrchestrationMessages,
  terminalHandle: string
): string {
  db.setRun({
    id: 'run_test',
    coordinator_handle: terminalHandle,
    coordinator_pane_key: 'tab-1:pane:1'
  })
  return 'run:run_test'
}

export function expectStablePaneKeyEnv(env: Record<string, string>): string {
  expect(env.ORCA_TAB_ID).toMatch(UUID_RE)
  const leafId = env.ORCA_PANE_KEY?.slice(`${env.ORCA_TAB_ID}:`.length)
  expect(leafId).toMatch(UUID_RE)
  expect(env.ORCA_PANE_KEY).toBe(`${env.ORCA_TAB_ID}:${leafId}`)
  return env.ORCA_PANE_KEY
}

export function createRuntime(): OrcaRuntimeService {
  return new OrcaRuntimeService(store)
}

export async function withPlatform<T>(
  platform: NodeJS.Platform,
  run: () => Promise<T>
): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: platform
  })
  try {
    return await run()
  } finally {
    if (original) {
      Object.defineProperty(process, 'platform', original)
    }
  }
}

export function makeFolderProjectGroup(overrides: Partial<ProjectGroup> = {}): ProjectGroup {
  return {
    id: TEST_FOLDER_PROJECT_GROUP_ID,
    name: 'Platform',
    parentPath: TEST_FOLDER_WORKSPACE_PATH,
    parentGroupId: null,
    createdFrom: 'folder-scan',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

export function makeFolderWorkspace(overrides: Partial<FolderWorkspace> = {}): FolderWorkspace {
  return {
    ...overrides,
    id: overrides.id ?? TEST_FOLDER_WORKSPACE_ID,
    projectGroupId: overrides.projectGroupId ?? TEST_FOLDER_PROJECT_GROUP_ID,
    name: overrides.name ?? 'Refund fix',
    folderPath: overrides.folderPath ?? TEST_FOLDER_WORKSPACE_PATH,
    linkedTask: overrides.linkedTask ?? null,
    comment: overrides.comment ?? '',
    isArchived: overrides.isArchived ?? false,
    isUnread: overrides.isUnread ?? false,
    isPinned: overrides.isPinned ?? false,
    sortOrder: overrides.sortOrder ?? 0,
    lastActivityAt: overrides.lastActivityAt ?? 1,
    createdAt: overrides.createdAt ?? 1,
    updatedAt: overrides.updatedAt ?? 1
  }
}

export function createFolderWorkspaceRuntimeStore(
  folderWorkspace: FolderWorkspace = makeFolderWorkspace(),
  projectGroup: ProjectGroup = makeFolderProjectGroup()
) {
  return {
    ...store,
    getProjectGroups: () => [projectGroup],
    getFolderWorkspaces: () => [folderWorkspace]
  }
}

export function makeRpcRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

export function makeWorktreeMeta(overrides: Partial<WorktreeMeta> = {}): WorktreeMeta {
  return {
    displayName: '',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    linkedGitLabMR: null,
    linkedGitLabIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

export function makeWorktreeInfo(
  path: string,
  head = 'head'
): {
  path: string
  head: string
  branch: string
  isBare: boolean
  isMainWorktree: boolean
} {
  return { path, head, branch: 'main', isBare: false, isMainWorktree: path.endsWith('/repo') }
}

export function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

export function createStaleRuntimeWorktreeStore(
  worktreeId: string,
  metaOverrides: Partial<WorktreeMeta> = {}
) {
  const metaById: Record<string, WorktreeMeta> = {
    [worktreeId]: makeWorktreeMeta(metaOverrides)
  }
  const removeWorktreeMeta = vi.fn((id: string) => {
    delete metaById[id]
  })
  const runtimeStore = {
    ...store,
    getAllWorktreeMeta: () => metaById,
    getWorktreeMeta: (id: string) => metaById[id],
    setWorktreeMeta: (id: string, meta: Partial<WorktreeMeta>) => {
      metaById[id] = { ...(metaById[id] ?? makeWorktreeMeta()), ...meta }
      return metaById[id]
    },
    removeWorktreeMeta
  }
  return { runtimeStore, removeWorktreeMeta }
}

export const store = {
  getRepo: (id: string) => store.getRepos().find((repo) => repo.id === id),
  getRepos: () => [
    {
      id: TEST_REPO_ID,
      path: TEST_REPO_PATH,
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 1
    }
  ],
  addRetiredWorktreeName: () => {},
  getRetiredWorktreeNameRegistry: () => ({ exhaustedTiers: 0, names: [] }),
  mergeRetiredWorktreeNames: () => false,
  addRepo: () => {},
  updateRepo: (id: string, updates: Record<string, unknown>) =>
    ({
      ...store.getRepo(id),
      ...updates
    }) as never,
  getAllWorktreeMeta: () => ({
    [TEST_WORKTREE_ID]: {
      displayName: 'foo',
      comment: '',
      linkedIssue: 123,
      linkedPR: null,
      linkedLinearIssue: null,
      linkedGitLabMR: null,
      linkedGitLabIssue: null,
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 0
    }
  }),
  getWorktreeMeta: (worktreeId: string) => store.getAllWorktreeMeta()[worktreeId],
  setWorktreeMeta: (_worktreeId: string, meta: Record<string, unknown>) =>
    ({
      ...store.getAllWorktreeMeta()[TEST_WORKTREE_ID],
      ...meta
    }) as never,
  removeWorktreeMeta: () => {},
  getSparsePresets: () => [],
  saveSparsePreset: (preset: unknown) => preset as never,
  getGitHubCache: () => undefined as never,
  getSettings: () => ({
    workspaceDir: '/tmp/workspaces',
    nestWorkspaces: false,
    refreshLocalBaseRefOnWorktreeCreate: false,
    branchPrefix: 'none',
    branchPrefixCustom: ''
  }),
  getProjects: () => []
}

export function createRuntimeWithSshLease(
  ptyId: string,
  tabId: string,
  state: 'expired' | 'terminated' = 'expired'
): OrcaRuntimeService {
  const now = Date.now()
  return new OrcaRuntimeService({
    ...store,
    getSshRemotePtyLeases: () => [
      {
        targetId: 'ssh-target',
        ptyId,
        worktreeId: TEST_WORKTREE_ID,
        tabId,
        leafId: HEADLESS_LEAF_ID,
        state,
        createdAt: now,
        updatedAt: now
      }
    ]
  })
}

export async function createExplicitAgentStatusHarness(options: {
  getForegroundProcess: (ptyId: string) => Promise<string | null>
  inspectProcess?: (
    ptyId: string
  ) => Promise<{ foregroundProcess: string | null; hasChildProcesses: boolean; unavailable?: true }>
  confirmForegroundProcess?: (ptyId: string) => Promise<string | null>
  title?: string
}): Promise<{
  runtime: OrcaRuntimeService
  handle: string
  syncPty: (ptyId: string | null) => void
}> {
  const leafId = '11111111-1111-4111-8111-111111111111'
  const paneKey = makePaneKey('tab-1', leafId)
  const runtime = new OrcaRuntimeService(store, undefined, {
    getAgentStatusSnapshot: () => [
      {
        paneKey,
        state: 'working',
        prompt: '',
        agentType: 'codex',
        connectionId: null,
        receivedAt: Date.now(),
        stateStartedAt: Date.now(),
        tabId: 'tab-1',
        worktreeId: TEST_WORKTREE_ID
      }
    ]
  })
  runtime.setPtyController({
    spawn: vi.fn().mockResolvedValue({ id: 'pty-1' }),
    write: () => true,
    kill: () => true,
    getForegroundProcess: options.getForegroundProcess,
    inspectProcess: options.inspectProcess,
    confirmForegroundProcess: options.confirmForegroundProcess
  })
  runtime.attachWindow(1)
  const syncPty = (ptyId: string | null): void => {
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: options.title ?? 'repo terminal',
          activeLeafId: leafId,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          leafId,
          paneRuntimeId: 1,
          ptyId
        }
      ]
    })
  }
  syncPty('pty-1')
  const [terminal] = (await runtime.listTerminals()).terminals
  return { runtime, handle: terminal.handle, syncPty }
}

export function makeHeadlessTerminalLayout(
  ptyIdsByLeafId: Record<string, string | undefined>
): TerminalLayoutSnapshot {
  const leafIds = Object.keys(ptyIdsByLeafId)
  const firstLeafId = leafIds[0] ?? HEADLESS_LEAF_ID
  return {
    root:
      leafIds.length > 1
        ? {
            type: 'split',
            direction: 'vertical',
            first: { type: 'leaf', leafId: leafIds[0]! },
            second: { type: 'leaf', leafId: leafIds[1]! }
          }
        : { type: 'leaf', leafId: firstLeafId },
    activeLeafId: firstLeafId,
    expandedLeafId: null,
    ptyIdsByLeafId: Object.fromEntries(
      Object.entries(ptyIdsByLeafId).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string'
      )
    )
  }
}

export function makeRuntimeStoreWithWorkspaceSession(
  initialSession: WorkspaceSessionState,
  // Why: sessions are partitioned by execution host, so the stub must answer for
  // one partition only — a loose stub lets a hardcoded host id pass unnoticed.
  ownerHostId = 'local'
): {
  runtimeStore: typeof store & {
    getWorkspaceSession: (hostId?: string) => WorkspaceSessionState
    setWorkspaceSession: ReturnType<typeof vi.fn>
    persistPtyBinding: ReturnType<typeof vi.fn>
  }
  getSession: () => WorkspaceSessionState
  setSession: (next: WorkspaceSessionState) => void
} {
  let session = initialSession
  const setSession = (next: WorkspaceSessionState): void => {
    session = next
  }
  const runtimeStore = {
    ...store,
    getWorkspaceSession: (hostId?: string) =>
      hostId === undefined || hostId === ownerHostId ? session : getDefaultWorkspaceSession(),
    setWorkspaceSession: vi.fn(setSession),
    persistPtyBinding: vi.fn(
      (args: { worktreeId: string; tabId: string; leafId: string; ptyId: string }) => {
        const tabs = session.tabsByWorktree[args.worktreeId] ?? []
        session = {
          ...session,
          tabsByWorktree: {
            ...session.tabsByWorktree,
            [args.worktreeId]: tabs.map((tab) =>
              tab.id === args.tabId ? { ...tab, ptyId: args.ptyId } : tab
            )
          },
          terminalLayoutsByTabId: {
            ...session.terminalLayoutsByTabId,
            [args.tabId]: {
              ...(session.terminalLayoutsByTabId[args.tabId] ?? {
                root: { type: 'leaf', leafId: args.leafId },
                activeLeafId: args.leafId,
                expandedLeafId: null
              }),
              ptyIdsByLeafId: {
                ...session.terminalLayoutsByTabId[args.tabId]?.ptyIdsByLeafId,
                [args.leafId]: args.ptyId
              }
            }
          }
        }
        return true
      }
    )
  }
  return { runtimeStore, getSession: () => session, setSession }
}

export function makeWorkspaceSessionWithHeadlessTerminal(
  overrides: Partial<WorkspaceSessionState> = {}
): WorkspaceSessionState {
  const layout = makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: 'persisted-pty' })
  return {
    ...getDefaultWorkspaceSession(),
    activeRepoId: TEST_REPO_ID,
    activeWorktreeId: TEST_WORKTREE_ID,
    activeTabId: 'host-tab',
    activeTabIdByWorktree: { [TEST_WORKTREE_ID]: 'host-tab' },
    tabsByWorktree: {
      [TEST_WORKTREE_ID]: [
        {
          id: 'host-tab',
          ptyId: 'persisted-pty',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Persisted Terminal',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    terminalLayoutsByTabId: { 'host-tab': layout },
    ...overrides
  }
}

_computeWorktreePathMock.mockImplementation(
  (
    sanitizedName: string,
    repoPath: string,
    settings: { nestWorkspaces: boolean; workspaceDir: string }
  ) => {
    if (settings.nestWorkspaces) {
      const repoName =
        repoPath
          .split(/[\\/]/)
          .at(-1)
          ?.replace(/\.git$/, '') ?? 'repo'
      return `${settings.workspaceDir}/${repoName}/${sanitizedName}`
    }
    return `${settings.workspaceDir}/${sanitizedName}`
  }
)
_ensurePathWithinWorkspaceMock.mockImplementation((targetPath: string) => targetPath)

// Why: the five #7587 mobile-create tests share one notifier factory so interface changes live in one place.
export function createMobileCreateTestNotifier(
  closeTerminal: (tabId: string, paneRuntimeId?: number) => void
) {
  return {
    focusTerminal: vi.fn(),
    worktreesChanged: vi.fn(),
    reposChanged: vi.fn(),
    activateWorktree: vi.fn(),
    createTerminal: vi.fn(),
    revealTerminalSession: vi.fn(),
    splitTerminal: vi.fn(),
    renameTerminal: vi.fn(),
    closeTerminal,
    closeSessionTab: vi.fn(),
    sleepWorktree: vi.fn(),
    terminalFitOverrideChanged: vi.fn(),
    terminalDriverChanged: vi.fn()
  }
}

export {
  _closeLocalWatcherForWorktreePathMock,
  _closeRemoteWatcherForWorktreePathMock,
  _electronMocks,
  _findExistingWorktreeSymlinkPathsMock,
  _forgetLocalWatcherRemovalSnapshotMock,
  _forgetRemoteWatcherRemovalSnapshotMock,
  _removeWorktreeLinkedPathsMock,
  _resolveLocalGitUsernameMock,
  _restoreLocalWatcherAfterFailedRemovalMock,
  _restoreRemoteWatcherAfterFailedRemovalMock,
  _scanLocalRepoWorktreesForResolutionMock
}

export const MOCK_GIT_WORKTREES = _MOCK_GIT_WORKTREES
export const addGitHubIssueCommentMock = _addGitHubIssueCommentMock
export const addGitHubPRReviewCommentMock = _addGitHubPRReviewCommentMock
export const addGitHubPRReviewCommentReplyMock = _addGitHubPRReviewCommentReplyMock
export const addGitLabIssueCommentMock = _addGitLabIssueCommentMock
export const addGitLabMRCommentMock = _addGitLabMRCommentMock
export const addGitLabMRInlineCommentMock = _addGitLabMRInlineCommentMock
export const addSparseWorktreeMock = _addSparseWorktreeMock
export const addWorktreeMock = _addWorktreeMock
export const applyAgentStatusHooksEnabledMock = _applyAgentStatusHooksEnabledMock
export const closeGitLabMRMock = _closeGitLabMRMock
export const closeLocalWatcherForWorktreePathMock = _closeLocalWatcherForWorktreePathMock
export const closeRemoteWatcherForWorktreePathMock = _closeRemoteWatcherForWorktreePathMock
export const computeWorktreePathMock = _computeWorktreePathMock
export const countGitHubWorkItemsMock = _countGitHubWorkItemsMock
export const createGitHubIssueMock = _createGitHubIssueMock
export const createGitLabIssueMock = _createGitLabIssueMock
export const createHostedReviewMock = _createHostedReviewMock
export const createStackedHostedReviewMock = _createStackedHostedReviewMock
export const deleteWorktreeHistoryDirMock = _deleteWorktreeHistoryDirMock
export const detectInstalledAgentsWithShellPathHydrationMock =
  _detectInstalledAgentsWithShellPathHydrationMock
export const detectRemoteAgentsMock = _detectRemoteAgentsMock
export const electronMocks = _electronMocks
export const ensurePathWithinWorkspaceMock = _ensurePathWithinWorkspaceMock
export const findExistingWorktreeSymlinkPathsMock = _findExistingWorktreeSymlinkPathsMock
export const forceDeleteLocalBranchMock = _forceDeleteLocalBranchMock
export const forgetLocalWatcherRemovalSnapshotMock = _forgetLocalWatcherRemovalSnapshotMock
export const forgetRemoteWatcherRemovalSnapshotMock = _forgetRemoteWatcherRemovalSnapshotMock
export const getActiveMultiplexerMock = _getActiveMultiplexerMock
export const getGitHubPRCheckDetailsMock = _getGitHubPRCheckDetailsMock
export const getGitHubPRChecksMock = _getGitHubPRChecksMock
export const getGitHubPRCommentsMock = _getGitHubPRCommentsMock
export const getGitHubPRFileContentsMock = _getGitHubPRFileContentsMock
export const getGitHubWorkItemByOwnerRepoMock = _getGitHubWorkItemByOwnerRepoMock
export const getGitHubWorkItemDetailsMock = _getGitHubWorkItemDetailsMock
export const getGitHubWorkItemMock = _getGitHubWorkItemMock
export const getGitLabJobTraceMock = _getGitLabJobTraceMock
export const getGitLabProjectRefForRemoteMock = _getGitLabProjectRefForRemoteMock
export const getGitLabWorkItemByProjectRefMock = _getGitLabWorkItemByProjectRefMock
export const getGitLabWorkItemDetailsMock = _getGitLabWorkItemDetailsMock
export const getGlabKnownHostsMock = _getGlabKnownHostsMock
export const getHostedReviewCreationEligibilityMock = _getHostedReviewCreationEligibilityMock
export const getHostedReviewForBranchMock = _getHostedReviewForBranchMock
export const getIssueMock = _getIssueMock
export const getPRForBranchMock = _getPRForBranchMock
export const getPRForBranchOutcomeMock = _getPRForBranchOutcomeMock
export const getPullRequestPushTargetMock = _getPullRequestPushTargetMock
export const getRepoSlugMock = _getRepoSlugMock
export const getRepoUpstreamMock = _getRepoUpstreamMock
export const getSshGitProviderGenerationMock = _getSshGitProviderGenerationMock
export const getSshGitProviderMock = _getSshGitProviderMock
export const invalidateAuthorizedRootsCacheMock = _invalidateAuthorizedRootsCacheMock
export const listGitHubAssignableUsersMock = _listGitHubAssignableUsersMock
export const listGitHubIssuesMock = _listGitHubIssuesMock
export const listGitHubLabelsMock = _listGitHubLabelsMock
export const listGitHubWorkItemsMock = _listGitHubWorkItemsMock
export const listGitLabIssuesMock = _listGitLabIssuesMock
export const listGitLabLabelsMock = _listGitLabLabelsMock
export const listGitLabMergeRequestsMock = _listGitLabMergeRequestsMock
export const listGitLabTodosMock = _listGitLabTodosMock
export const listGitLabWorkItemsMock = _listGitLabWorkItemsMock
export const markCodexProjectTrustedMock = _markCodexProjectTrustedMock
export const markCopilotFolderTrustedMock = _markCopilotFolderTrustedMock
export const markCursorWorkspaceTrustedMock = _markCursorWorkspaceTrustedMock
export const mergeGitHubPRMock = _mergeGitHubPRMock
export const mergeGitLabMRMock = _mergeGitLabMRMock
export const muxRequestMock = _muxRequestMock
export const prepareLocalWorktreeRootForRepoMock = _prepareLocalWorktreeRootForRepoMock
export const registerSshGitProviderMock = _registerSshGitProviderMock
export const removeGitHubPRReviewersMock = _removeGitHubPRReviewersMock
export const removeWorktreeLinkedPathsMock = _removeWorktreeLinkedPathsMock
export const removeWorktreeMock = _removeWorktreeMock
export const reopenGitLabMRMock = _reopenGitLabMRMock
export const requestGitHubPRReviewersMock = _requestGitHubPRReviewersMock
export const rerunGitHubPRChecksMock = _rerunGitHubPRChecksMock
export const resolveGitHubReviewThreadMock = _resolveGitHubReviewThreadMock
export const resolveGitLabMRDiscussionMock = _resolveGitLabMRDiscussionMock
export const resolveLocalGitUsernameMock = _resolveLocalGitUsernameMock
export const restoreLocalWatcherAfterFailedRemovalMock = _restoreLocalWatcherAfterFailedRemovalMock
export const restoreRemoteWatcherAfterFailedRemovalMock =
  _restoreRemoteWatcherAfterFailedRemovalMock
export const retryGitLabJobMock = _retryGitLabJobMock
export const scanLocalRepoWorktreesForResolutionMock = _scanLocalRepoWorktreesForResolutionMock
export const setGitHubPRAutoMergeMock = _setGitHubPRAutoMergeMock
export const setGitHubPRFileViewedMock = _setGitHubPRFileViewedMock
export const sshGitProviders = _sshGitProviders
export const sshProviderGenerations = _sshProviderGenerations
export const unregisterSshGitProviderMock = _unregisterSshGitProviderMock
export const updateGitHubIssueMock = _updateGitHubIssueMock
export const updateGitHubPRDetailsMock = _updateGitHubPRDetailsMock
export const updateGitHubPRStateMock = _updateGitHubPRStateMock
export const updateGitHubPRTitleMock = _updateGitHubPRTitleMock
export const updateGitLabIssueMock = _updateGitLabIssueMock
export const updateGitLabMRMock = _updateGitLabMRMock
export const updateGitLabMRReviewersMock = _updateGitLabMRReviewersMock

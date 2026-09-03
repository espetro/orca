import type { WebSessionTabsSyncState } from './web-session-tabs-sync-state'
import type { WebSessionTabsBatchContext } from './web-session-tabs-batch-records'
import { writableWebSessionTabsRecord } from './web-session-tabs-batch-records'
import type { WebSessionTabsFocusContext } from './web-session-tabs-apply-focus'
import {
  sameStringArray,
  sameBrowserPages,
  optionalRuntimeBrowserPlacementsEqual,
  browserCertificateFailureEqual
} from './web-session-tabs-mirrored-equality'
import { terminalLayoutEqual } from '@/lib/terminal-layout-equality'
import { markWebSessionBrowserPlacementAdopted } from './web-session-browser-placement'

export function buildWebSessionTabsPatchRecords(
  state: WebSessionTabsSyncState,
  ctx: WebSessionTabsFocusContext,
  environmentId: string,
  worktreeId: string,
  batchContext?: WebSessionTabsBatchContext
) {
  if (!ctx) {
    return null
  }
  const {
    exactProvisionalHandoffs,
    mirroredTerminalTabs,
    removedTerminalIds,
    removedTerminalResourceIds,
    mirroredBrowserTabs,
    removedBrowserWorkspaceIds,
    retainedBrowserTabs,
    nextBrowserTabs
  } = ctx

  let nextPtyIdsByTabId = state.ptyIdsByTabId
  for (const removedId of removedTerminalResourceIds) {
    if (nextPtyIdsByTabId[removedId]) {
      nextPtyIdsByTabId =
        nextPtyIdsByTabId === state.ptyIdsByTabId
          ? writableWebSessionTabsRecord(state, 'ptyIdsByTabId', batchContext)
          : nextPtyIdsByTabId
      delete nextPtyIdsByTabId[removedId]
    }
  }
  for (const { tab, ptyIds } of mirroredTerminalTabs) {
    if (ptyIds.length === 0) {
      if (nextPtyIdsByTabId[tab.id]) {
        nextPtyIdsByTabId =
          nextPtyIdsByTabId === state.ptyIdsByTabId
            ? writableWebSessionTabsRecord(state, 'ptyIdsByTabId', batchContext)
            : nextPtyIdsByTabId
        delete nextPtyIdsByTabId[tab.id]
      }
      continue
    }
    const current = nextPtyIdsByTabId[tab.id] ?? []
    if (!sameStringArray(current, ptyIds)) {
      nextPtyIdsByTabId =
        nextPtyIdsByTabId === state.ptyIdsByTabId
          ? writableWebSessionTabsRecord(state, 'ptyIdsByTabId', batchContext)
          : nextPtyIdsByTabId
      nextPtyIdsByTabId[tab.id] = ptyIds
    }
  }

  let nextTerminalLayoutsByTabId = state.terminalLayoutsByTabId
  for (const removedId of removedTerminalResourceIds) {
    if (nextTerminalLayoutsByTabId[removedId]) {
      nextTerminalLayoutsByTabId =
        nextTerminalLayoutsByTabId === state.terminalLayoutsByTabId
          ? writableWebSessionTabsRecord(state, 'terminalLayoutsByTabId', batchContext)
          : nextTerminalLayoutsByTabId
      delete nextTerminalLayoutsByTabId[removedId]
    }
  }
  for (const { tab, layout } of mirroredTerminalTabs) {
    if (!terminalLayoutEqual(nextTerminalLayoutsByTabId[tab.id], layout)) {
      nextTerminalLayoutsByTabId =
        nextTerminalLayoutsByTabId === state.terminalLayoutsByTabId
          ? writableWebSessionTabsRecord(state, 'terminalLayoutsByTabId', batchContext)
          : nextTerminalLayoutsByTabId
      nextTerminalLayoutsByTabId[tab.id] = layout
    }
  }

  let nextUnreadTerminalTabs = state.unreadTerminalTabs
  for (const removedId of removedTerminalIds) {
    if (nextUnreadTerminalTabs[removedId]) {
      nextUnreadTerminalTabs =
        nextUnreadTerminalTabs === state.unreadTerminalTabs
          ? writableWebSessionTabsRecord(state, 'unreadTerminalTabs', batchContext)
          : nextUnreadTerminalTabs
      delete nextUnreadTerminalTabs[removedId]
    }
  }

  const pendingStartupByTabId = state.pendingStartupByTabId ?? {}
  let nextPendingStartupByTabId = pendingStartupByTabId
  const automaticAgentResumeClaimsByTabId = state.automaticAgentResumeClaimsByTabId ?? {}
  let nextAutomaticAgentResumeClaimsByTabId = automaticAgentResumeClaimsByTabId
  for (const removedId of exactProvisionalHandoffs) {
    if (nextPendingStartupByTabId[removedId]) {
      nextPendingStartupByTabId =
        nextPendingStartupByTabId === pendingStartupByTabId
          ? writableWebSessionTabsRecord(state, 'pendingStartupByTabId', batchContext)
          : nextPendingStartupByTabId
      delete nextPendingStartupByTabId[removedId]
    }
    if (nextAutomaticAgentResumeClaimsByTabId[removedId]) {
      nextAutomaticAgentResumeClaimsByTabId =
        nextAutomaticAgentResumeClaimsByTabId === automaticAgentResumeClaimsByTabId
          ? writableWebSessionTabsRecord(state, 'automaticAgentResumeClaimsByTabId', batchContext)
          : nextAutomaticAgentResumeClaimsByTabId
      delete nextAutomaticAgentResumeClaimsByTabId[removedId]
    }
  }

  let nextBrowserPagesByWorkspace = state.browserPagesByWorkspace
  let nextRemoteBrowserPageHandlesByPageId = state.remoteBrowserPageHandlesByPageId
  let nextBrowserCertificateFailuresByPageId = state.browserCertificateFailuresByPageId
  if (removedBrowserWorkspaceIds.size > 0) {
    const nextBrowserWorkspaceIds = new Set(nextBrowserTabs?.map((tab) => tab.id) ?? [])
    const nextBrowserPageIds = new Set(mirroredBrowserTabs.map((entry) => entry.page.id))
    for (const workspace of retainedBrowserTabs) {
      for (const page of state.browserPagesByWorkspace[workspace.id] ?? []) {
        nextBrowserPageIds.add(page.id)
      }
    }
    for (const removedWorkspaceId of removedBrowserWorkspaceIds) {
      const pages = nextBrowserPagesByWorkspace[removedWorkspaceId] ?? []
      if (
        !nextBrowserWorkspaceIds.has(removedWorkspaceId) &&
        nextBrowserPagesByWorkspace[removedWorkspaceId]
      ) {
        nextBrowserPagesByWorkspace =
          nextBrowserPagesByWorkspace === state.browserPagesByWorkspace
            ? writableWebSessionTabsRecord(state, 'browserPagesByWorkspace', batchContext)
            : nextBrowserPagesByWorkspace
        delete nextBrowserPagesByWorkspace[removedWorkspaceId]
      }
      for (const page of pages) {
        if (nextBrowserPageIds.has(page.id)) {
          continue
        }
        if (nextBrowserCertificateFailuresByPageId[page.id]) {
          nextBrowserCertificateFailuresByPageId =
            nextBrowserCertificateFailuresByPageId === state.browserCertificateFailuresByPageId
              ? writableWebSessionTabsRecord(
                  state,
                  'browserCertificateFailuresByPageId',
                  batchContext
                )
              : nextBrowserCertificateFailuresByPageId
          delete nextBrowserCertificateFailuresByPageId[page.id]
        }
        if (nextRemoteBrowserPageHandlesByPageId[page.id]) {
          nextRemoteBrowserPageHandlesByPageId =
            nextRemoteBrowserPageHandlesByPageId === state.remoteBrowserPageHandlesByPageId
              ? writableWebSessionTabsRecord(
                  state,
                  'remoteBrowserPageHandlesByPageId',
                  batchContext
                )
              : nextRemoteBrowserPageHandlesByPageId
          delete nextRemoteBrowserPageHandlesByPageId[page.id]
        }
      }
    }
  }
  for (const { page, certificateFailure, remotePageId, placement } of mirroredBrowserTabs) {
    const current = nextBrowserPagesByWorkspace[page.workspaceId] ?? []
    if (!sameBrowserPages(current, [page])) {
      nextBrowserPagesByWorkspace =
        nextBrowserPagesByWorkspace === state.browserPagesByWorkspace
          ? writableWebSessionTabsRecord(state, 'browserPagesByWorkspace', batchContext)
          : nextBrowserPagesByWorkspace
      nextBrowserPagesByWorkspace[page.workspaceId] = [page]
    }
    const currentHandle = nextRemoteBrowserPageHandlesByPageId[page.id]
    if (
      currentHandle?.environmentId !== environmentId ||
      currentHandle.remotePageId !== remotePageId ||
      // Why: this snapshot is the host publishing the page, which is exactly what clears a
      // staged handle — without this the optimistic flag would survive every later snapshot.
      currentHandle.staged === true ||
      // Why separately: a host that puts a restored page back on the server publishes no
      // placement, so the handle is otherwise identical to the seed and the restored markers
      // would never be spent — leaving the row cull-proof and pinned to the client-hosted pane.
      currentHandle.restoredFromSession === true ||
      !optionalRuntimeBrowserPlacementsEqual(currentHandle.placement, placement)
    ) {
      nextRemoteBrowserPageHandlesByPageId =
        nextRemoteBrowserPageHandlesByPageId === state.remoteBrowserPageHandlesByPageId
          ? writableWebSessionTabsRecord(state, 'remoteBrowserPageHandlesByPageId', batchContext)
          : nextRemoteBrowserPageHandlesByPageId
      nextRemoteBrowserPageHandlesByPageId[page.id] = {
        environmentId,
        remotePageId,
        ...(placement ? { placement } : {})
      }
    }
    // Why here and not on the staged flag alone: the flag is cleared by this very block, so every
    // later snapshot in the create's materialization wait would see an un-spent record and move the
    // tab back to the group the create asked for. Both peeks (the group precedence and the
    // placementMoves repair) run earlier in this same pass by design: moving the mark ahead of them
    // would spend the intent before the pass that adopts the page can place it.
    markWebSessionBrowserPlacementAdopted({ environmentId, worktreeId, remotePageId })
    // Why: a client-hosted page's certificate failure is raised by the local guest webview and is
    // structurally absent from what the host publishes, so host snapshots must not own that record
    // — reconciling here would delete the local one on the next metadata update.
    if (
      placement?.kind !== 'client' &&
      !browserCertificateFailureEqual(
        nextBrowserCertificateFailuresByPageId[page.id],
        certificateFailure
      )
    ) {
      nextBrowserCertificateFailuresByPageId =
        nextBrowserCertificateFailuresByPageId === state.browserCertificateFailuresByPageId
          ? writableWebSessionTabsRecord(state, 'browserCertificateFailuresByPageId', batchContext)
          : nextBrowserCertificateFailuresByPageId
      if (certificateFailure) {
        nextBrowserCertificateFailuresByPageId[page.id] = certificateFailure
      } else {
        delete nextBrowserCertificateFailuresByPageId[page.id]
      }
    }
  }
  return {
    nextPtyIdsByTabId,
    nextTerminalLayoutsByTabId,
    nextUnreadTerminalTabs,
    nextPendingStartupByTabId,
    nextAutomaticAgentResumeClaimsByTabId,
    nextBrowserPagesByWorkspace,
    nextRemoteBrowserPageHandlesByPageId,
    nextBrowserCertificateFailuresByPageId,
    pendingStartupByTabId,
    automaticAgentResumeClaimsByTabId
  }
}

export type WebSessionTabsPatchRecords = ReturnType<typeof buildWebSessionTabsPatchRecords>

import type {
  AgentStatusEntry,
  ParsedAgentStatusPayload
} from '../../../../shared/agent-status-types'
import type { GeneratedTabTitleUpdate } from './terminal-tab-title-batch'
import type { AgentStatusGetFn } from './agent-status-action-context'
import { applyAgentStatusIngestPatch } from './agent-status-ingest-patch'

/** True when auto-title generation would no-op without replace (custom/quick/generated). */
function agentStatusTabAlreadyHasProtectedOrGeneratedTitle(
  state: AppState,
  tabId: string | null,
  worktreeId?: string | null
): boolean {
  if (!tabId) {
    return false
  }
  const ownerTabs = worktreeId ? state.tabsByWorktree[worktreeId] : undefined
  if (ownerTabs) {
    const tab = ownerTabs.find((candidate) => candidate.id === tabId)
    return Boolean(
      tab?.customTitle?.trim() || tab?.quickCommandLabel?.trim() || tab?.generatedTitle?.trim()
    )
  }
  for (const tabs of Object.values(state.tabsByWorktree)) {
    const tab = tabs.find((candidate) => candidate.id === tabId)
    if (!tab) {
      continue
    }
    return Boolean(
      tab.customTitle?.trim() || tab.quickCommandLabel?.trim() || tab.generatedTitle?.trim()
    )
  }
  return false
}

export function setAgentStatusAction(
  paneKey: string,
  payload: ParsedAgentStatusPayload,
  applyGeneratedTabTitleUpdate: (update: GeneratedTabTitleUpdate) => void,
  requestAgentStatusFreshness: (acceptedInBatch: boolean) => void,
  get: AgentStatusGetFn,
  set: AgentStatusSetFn,
  terminalTitle?: string,
  timing?: AgentStatusTiming,
  routing?: AgentStatusRouting,
  metadata?: AgentStatusMetadata
): void {
  paneKey = resolveAgentPaneAuthorityKey(paneKey)
  const updatedAt = timing?.updatedAt ?? Date.now()
  if (
    paneKey in get().recentlyRetiredAgentStatusPaneKeys ||
    // Why: a closed tab is no longer a valid destination for hook replays or late status events.
    isRecentlyClosedAgentStatusTab(
      get().recentlyClosedAgentStatusTabIds,
      getTabIdFromPaneKey(paneKey)
    )
  ) {
    return
  }
  const out = {
    completionRefreshWorktreeId: null as string | null,
    suppressedInheritedTerminalStatus: false,
    generatedTitleEntry: null as AgentStatusEntry | null
  }
  applyAgentStatusIngestPatch(
    paneKey,
    payload,
    terminalTitle,
    updatedAt,
    timing,
    routing,
    metadata,
    get,
    set,
    out
  )
  if (out.suppressedInheritedTerminalStatus) {
    return
  }
  const entryForGeneratedTitle = out.generatedTitleEntry
  if (entryForGeneratedTitle) {
    applyAgentStatusGeneratedTitleEffect(
      paneKey,
      entryForGeneratedTitle,
      get,
      applyGeneratedTabTitleUpdate
    )
  }
  // Why: batches coalesce accepted updates; standalone calls keep their existing deferred scheduling.
  requestAgentStatusFreshness(out.generatedTitleEntry !== null)
  if (out.completionRefreshWorktreeId) {
    const worktreeId = out.completionRefreshWorktreeId
    // Why: agents can create a PR via `gh pr create`, bypassing Orca's flow and leaving a stale "no PR" cache entry in place.
    queueMicrotask(() => get().refreshGitHubForWorktreeIfStale(worktreeId))
  }
}

function applyAgentStatusGeneratedTitleEffect(
  paneKey: string,
  entryForGeneratedTitle: AgentStatusEntry,
  get: AgentStatusGetFn,
  applyGeneratedTabTitleUpdate: (update: GeneratedTabTitleUpdate) => void
): void {
  // Why: sticky orchestration (~30m) can outlive the dispatch turn, so replace the title on matching labels or a re-dispatch's mismatched taskId.
  const hasMatchingOrchestrationLabels = Boolean(
    (entryForGeneratedTitle.orchestration?.displayName?.trim() ||
      entryForGeneratedTitle.orchestration?.taskTitle?.trim()) &&
    orchestrationLabelsMatchLiveDispatch(entryForGeneratedTitle)
  )
  const liveIsDispatchPrompt = isOrcaDispatchPrompt(entryForGeneratedTitle.prompt)
  const liveDispatchTaskId = liveIsDispatchPrompt
    ? getOrcaDispatchTaskId(entryForGeneratedTitle.prompt)
    : null
  const stickyOrchestrationTaskId = entryForGeneratedTitle.orchestration?.taskId?.trim() || null
  const isNewDispatchAgainstStickyOrchestration = Boolean(
    liveDispatchTaskId &&
    stickyOrchestrationTaskId &&
    liveDispatchTaskId !== stickyOrchestrationTaskId
  )
  const shouldReplaceGeneratedTitle =
    hasMatchingOrchestrationLabels || isNewDispatchAgainstStickyOrchestration
  // Why: setAgentStatus is high-frequency, so only parse dispatch preambles when a title write is actually possible.
  const mayWriteGeneratedTitle =
    get().settings?.tabAutoGenerateTitle === true &&
    (shouldReplaceGeneratedTitle ||
      !agentStatusTabAlreadyHasProtectedOrGeneratedTitle(
        get(),
        entryForGeneratedTitle.tabId ?? getTabIdFromPaneKey(paneKey),
        entryForGeneratedTitle.worktreeId
      ))
  const generatedTitlePrompt =
    liveIsDispatchPrompt && mayWriteGeneratedTitle
      ? getAgentRowGeneratedTitleText(entryForGeneratedTitle)
      : entryForGeneratedTitle.prompt
  if (shouldReplaceGeneratedTitle) {
    applyGeneratedTabTitleUpdate({
      paneKey,
      prompt: generatedTitlePrompt,
      options: {
        replaceExistingGeneratedTitle: true
      }
    })
  } else {
    applyGeneratedTabTitleUpdate({ paneKey, prompt: generatedTitlePrompt })
  }
}

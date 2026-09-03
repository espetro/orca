/* eslint-disable no-control-regex -- Why: terminal normalization must strip ANSI and OSC control sequences from PTY output. */

export function classifyLatestAgentTitle(
  ...titles: { title: string | null | undefined; updatedAt: number | null | undefined }[]
): 'agent' | 'management' | 'neutral' {
  return classifyAgentTitle(getLatestAgentCandidateTitle(...titles))
}

export function getLatestPtyTitle(pty: RuntimePtyWorktreeRecord): string | null {
  return getLatestAgentCandidateTitle(
    { title: pty.title, updatedAt: pty.titleUpdatedAt },
    { title: pty.lastOscTitle, updatedAt: pty.lastOscTitleAt }
  )
}

export function getLatestLeafTitle(leaf: RuntimeLeafRecord, tabTitle: string | null): string | null {
  return getLatestAgentCandidateTitle(
    { title: leaf.paneTitle, updatedAt: leaf.paneTitleUpdatedAt },
    { title: leaf.lastOscTitle, updatedAt: leaf.lastOscTitleAt },
    { title: tabTitle, updatedAt: 0 }
  )
}

// Why: an 'agent' title only proves an agent owns the pane when something other than a
// quarter-circle spinner carries it — those glyphs are generic progress frames (STA-4028).
export function agentTitleProvesAgentPresence(
  title: string | null,
  classification: 'agent' | 'management' | 'neutral'
): boolean {
  return (
    classification === 'agent' &&
    !isOpenCodeNativeTitle(title) &&
    !isQuarterCircleSpinnerOnlyAgentTitle(title)
  )
}

export function ptyTitleProvesAgentPresence(
  pty: RuntimePtyWorktreeRecord,
  title: string | null,
  classification: 'agent' | 'management' | 'neutral'
): boolean {
  return (
    agentTitleProvesAgentPresence(title, classification) ||
    (isQuarterCircleSpinnerOnlyAgentTitle(title) &&
      pty.launchAgent === 'claude' &&
      pty.launchToken !== null &&
      pty.launchIncarnationId === pty.incarnationId)
  )
}

export function classifyAgentTitle(title: string | null): 'agent' | 'management' | 'neutral' {
  if (!title) {
    return 'neutral'
  }
  if (isClaudeManagementTitle(title)) {
    return 'management'
  }
  return detectAgentStatusFromTitle(title) !== null ? 'agent' : 'neutral'
}

export function isTerminalSendSettlementAgent(
  agent: TuiAgent | null | undefined
): agent is 'claude' | 'codex' {
  return agent === 'claude' || agent === 'codex'
}

export function findLastCompleteOscTitleRange(data: string): { start: number; end: number } | null {
  // Why: one forward cursor keeps hostile unterminated OSC output linear-time.
  let last: { start: number; end: number } | null = null
  let searchFrom = 0
  while (searchFrom < data.length) {
    const start = data.indexOf('\x1b]', searchFrom)
    if (start === -1) {
      break
    }
    const command = data[start + 2]
    if ((command !== '0' && command !== '1' && command !== '2') || data[start + 3] !== ';') {
      searchFrom = start + 2
      continue
    }
    let cursor = start + 4
    for (; cursor < data.length; cursor += 1) {
      if (data[cursor] === '\x07') {
        last = { start, end: cursor + 1 }
        searchFrom = cursor + 1
        break
      }
      if (data[cursor] !== '\x1b') {
        continue
      }
      if (data[cursor + 1] === '\\') {
        last = { start, end: cursor + 2 }
        searchFrom = cursor + 2
      } else {
        searchFrom = cursor
      }
      break
    }
    if (cursor === data.length) {
      break
    }
  }
  return last
}

export function terminalTitleBlocksExplicitAgentStatus(title: string | null): boolean {
  if (!title) {
    return false
  }
  return isClaudeManagementTitle(title) || isShellProcess(title)
}

export function getLatestAgentCandidateTitle(
  ...titles: { title: string | null | undefined; updatedAt: number | null | undefined }[]
): string | null {
  return getLatestAgentCandidateTitleInfo(...titles)?.title ?? null
}

export function getLatestAgentCandidateTitleInfo(
  ...titles: { title: string | null | undefined; updatedAt: number | null | undefined }[]
): { title: string; updatedAt: number } | null {
  let latest: { title: string; updatedAt: number } | null = null
  for (const candidate of titles) {
    const title = candidate.title?.trim()
    if (!title) {
      continue
    }
    const updatedAt = candidate.updatedAt ?? 0
    if (!latest || updatedAt > latest.updatedAt) {
      latest = { title, updatedAt }
    }
  }
  return latest
}

export function getSavedTabWorktreeStatus(title: string, hasPty: boolean): RuntimeWorktreeStatus {
  return getDetectedWorktreeStatus(detectAgentStatusFromTitle(title), hasPty)
}

function getDetectedWorktreeStatus(
  detected: AgentStatus | null,
  hasPty: boolean
): RuntimeWorktreeStatus {
  if (detected === 'permission') {
    return 'permission'
  }
  if (detected === 'working') {
    return 'working'
  }
  return hasPty ? 'active' : 'inactive'
}

export function mapExplicitAgentStateToRuntimeTerminalStatus(
  state: AgentStatusEntry['state']
): NonNullable<RuntimeTerminalAgentStatus['status']> {
  switch (state) {
    case 'blocked':
    case 'waiting':
      return 'permission'
    case 'working':
      return 'working'
    case 'done':
      return 'idle'
  }
}

export function addRuntimeWorkingTerminalEvidence(
  evidenceByWorktreeId: Map<string, RuntimeWorkingTerminalEvidence[]>,
  worktreeId: string,
  evidence: RuntimeWorkingTerminalEvidence
): void {
  const existing = evidenceByWorktreeId.get(worktreeId)
  if (existing) {
    existing.push(evidence)
  } else {
    evidenceByWorktreeId.set(worktreeId, [evidence])
  }
}

export function runtimeWorkingTerminalEvidenceMatchesSource(
  evidence: RuntimeWorkingTerminalEvidence,
  source: RuntimeWorktreeAgentSource
): boolean {
  if (evidence.paneKey) {
    return (
      evidence.paneKey === source.paneKey ||
      Boolean(evidence.ptyId && source.ptyId && evidence.ptyId === source.ptyId)
    )
  }
  if (evidence.ptyId && source.ptyId) {
    return evidence.ptyId === source.ptyId
  }
  return Boolean(evidence.tabId && evidence.tabId === source.tabId)
}

export function mergeWorktreeSummaryStatus(
  summary: RuntimeWorktreePsSummary,
  next: RuntimeWorktreeStatus,
  nextWorkingMode?: RuntimeWorktreePsSummary['workingMode']
): void {
  const currentPriority = WORKTREE_STATUS_PRIORITY[summary.status]
  const nextPriority = WORKTREE_STATUS_PRIORITY[next]
  if (nextPriority > currentPriority) {
    summary.status = next
    if (next === 'working' && nextWorkingMode === 'monitoring') {
      summary.workingMode = 'monitoring'
    } else {
      delete summary.workingMode
    }
    return
  }
  if (nextPriority === currentPriority && next === 'working') {
    if (nextWorkingMode === 'monitoring') {
      summary.workingMode = 'monitoring'
    } else {
      delete summary.workingMode
    }
  }
}

export function normalizeTerminalChunk(
  chunk: string,
  pendingAnsi: string = ''
): { text: string; pendingAnsi: string } {
  // Why: skip full ANSI/OSC scanning for the common plain-text PTY chunk (perf on high-throughput streams).
  if (pendingAnsi.length === 0 && !terminalChunkNeedsNormalization(chunk)) {
    return { text: chunk, pendingAnsi: '' }
  }
  const combined = `${pendingAnsi}${chunk}`
  const parts: string[] = []
  let textStart = 0
  for (let index = 0; index < combined.length; index += 1) {
    const char = combined[index]
    if (char === '\x1b') {
      appendTerminalNormalizedSpan(parts, combined, textStart, index)
      if (index + 1 >= combined.length) {
        return { text: parts.join(''), pendingAnsi: combined.slice(index) }
      }
      const parsed = parseAnsiControlSequence(combined, index)
      if (!parsed) {
        return {
          text: parts.join(''),
          pendingAnsi: trimPendingAnsiControl(combined.slice(index))
        }
      }
      if (parsed.kind === 'csi' && isTerminalPreviewLineControl(parsed)) {
        // Why: Codex redraws status text with ANSI controls but no CR; keep them so the tail overwrites the prior frame.
        parts.push(combined.slice(index, parsed.endIndex + 1))
      }
      index = parsed.endIndex
      textStart = index + 1
      continue
    }
    if (char === '\r' && combined[index + 1] === '\n') {
      appendTerminalNormalizedSpan(parts, combined, textStart, index)
      parts.push('\n')
      index += 1
      textStart = index + 1
      continue
    }
    const code = combined.charCodeAt(index)
    if (code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0d) {
      appendTerminalNormalizedSpan(parts, combined, textStart, index)
      parts.push(char)
      textStart = index + 1
    } else if (!isTerminalPreviewPrintableCodeUnit(code)) {
      appendTerminalNormalizedSpan(parts, combined, textStart, index)
      textStart = index + 1
    }
  }
  appendTerminalNormalizedSpan(parts, combined, textStart, combined.length)
  return { text: parts.join(''), pendingAnsi: '' }
}

function appendTerminalNormalizedSpan(
  parts: string[],
  value: string,
  start: number,
  end: number
): void {
  if (end > start) {
    parts.push(value.slice(start, end))
  }
}

function isTerminalPreviewPrintableCodeUnit(code: number): boolean {
  return code >= 0x20 && code !== 0x7f && (code < 0x80 || code > 0x9f)
}

function terminalChunkNeedsNormalization(chunk: string): boolean {
  for (let index = 0; index < chunk.length; index++) {
    const code = chunk.charCodeAt(index)
    if (
      code === 0x1b ||
      code === 0x7f ||
      code === 0x0d ||
      code < 0x09 ||
      (code > 0x0a && code < 0x20) ||
      (code >= 0x80 && code <= 0x9f)
    ) {
      return true
    }
  }
  return false
}

function trimPendingAnsiControl(value: string): string {
  if (value.length <= MAX_TAIL_PENDING_ANSI_CHARS) {
    return value
  }
  const introducer = value.slice(0, Math.min(2, value.length))
  const suffixBudget = Math.max(0, MAX_TAIL_PENDING_ANSI_CHARS - introducer.length)
  return `${introducer}${value.slice(-suffixBudget)}`
}

function isTerminalPreviewLineControl(parsed: {
  final: string
  params: string
  firstParam: number | null
}): boolean {
  if (!hasCanonicalNumericCsiParams(parsed.params)) {
    return false
  }
  if (parsed.final === 'K') {
    const mode = parsed.firstParam ?? 0
    return mode === 0 || mode === 1 || mode === 2
  }
  return (
    parsed.final === 'A' ||
    parsed.final === 'G' ||
    parsed.final === '`' ||
    parsed.final === 'D' ||
    parsed.final === 'C'
  )
}

export function maxTimestamp(left: number | null, right: number | null): number | null {
  if (left === null) {
    return right
  }
  if (right === null) {
    return left
  }
  return Math.max(left, right)
}

export function compareWorktreePs(
  left: RuntimeWorktreePsSummary,
  right: RuntimeWorktreePsSummary
): number {
  // Pinned and unread worktrees sort above others so they survive truncation.
  if (left.isPinned !== right.isPinned) {
    return left.isPinned ? -1 : 1
  }
  if (left.unread !== right.unread) {
    return left.unread ? -1 : 1
  }
  // Why: worktree.ps is truncated for mobile, so host-visible activity must sort above inactive rows.
  if (left.hasHostSidebarActivity !== right.hasHostSidebarActivity) {
    return left.hasHostSidebarActivity ? -1 : 1
  }
  const leftLast = left.lastOutputAt ?? -1
  const rightLast = right.lastOutputAt ?? -1
  if (leftLast !== rightLast) {
    return rightLast - leftLast
  }
  if (left.liveTerminalCount !== right.liveTerminalCount) {
    return right.liveTerminalCount - left.liveTerminalCount
  }
  return left.path.localeCompare(right.path)
}

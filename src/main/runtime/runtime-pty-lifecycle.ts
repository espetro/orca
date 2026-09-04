/* eslint-disable @typescript-eslint/no-explicit-any -- Why: delegating functions must accept variadic arguments for method forwarding */
// Extracted from OrcaRuntimeService: pty_lifecycle cluster (batch-2)
// 82 methods, ~2,460 LOC
// Provides PTY lifecycle management, state tracking, and terminal operations

import type { OrcaRuntimeService } from './orca-runtime'

// Delegating wrapper functions for PTY lifecycle methods
// Each wraps the corresponding OrcaRuntimeService method for external consumption

export function isTerminalRunningSettledPromptAgent(
  runtime: OrcaRuntimeService,
  handle: string
): Promise<boolean> {
  return runtime.isTerminalRunningSettledPromptAgent(handle)
}

export function hasTerminalsForWorktree(runtime: OrcaRuntimeService, worktreeId: string): boolean {
  return runtime.hasTerminalsForWorktree(worktreeId)
}

export function stopExactTerminalsForWorktree(
  runtime: OrcaRuntimeService,
  worktreeId: string,
  handles: string[]
): Promise<void> {
  return runtime.stopExactTerminalsForWorktree(worktreeId, handles)
}

export function getLivePtyIdsForWorktree(
  runtime: OrcaRuntimeService,
  worktreeId: string
): string[] {
  return runtime.getLivePtyIdsForWorktree(worktreeId)
}

export function stopTerminalsForWorktree(
  runtime: OrcaRuntimeService,
  worktreeId: string
): Promise<void> {
  return runtime.stopTerminalsForWorktree(worktreeId)
}

export function hasLiveShellForRendererTab(runtime: OrcaRuntimeService, tabId: string): boolean {
  return runtime.hasLiveShellForRendererTab(tabId)
}

export function deliverPendingStartupCommandToBareRendererPty(
  runtime: OrcaRuntimeService,
  ptyId: string,
  tabId: string
): Promise<boolean> {
  return runtime.deliverPendingStartupCommandToBareRendererPty(ptyId, tabId)
}

export function resolveTerminalSplitSourceAuthority(
  runtime: OrcaRuntimeService,
  handle: string
): Promise<string | null> {
  return runtime.resolveTerminalSplitSourceAuthority(handle)
}

export function getWorktreePs(runtime: OrcaRuntimeService, worktreeId: string): any {
  return runtime.getWorktreePs(worktreeId)
}

export function isPtyKnownExited(runtime: OrcaRuntimeService, ptyId: string): boolean {
  return runtime.isPtyKnownExited(ptyId)
}

export function getTerminalAgentStatus(runtime: OrcaRuntimeService, handle: string): any {
  return runtime.getTerminalAgentStatus(handle)
}

export function isTerminalRunningAgent(
  runtime: OrcaRuntimeService,
  handle: string,
  options?: any
): Promise<boolean> {
  return runtime.isTerminalRunningAgent(handle, options)
}

export function getPtyAgent(runtime: OrcaRuntimeService, ptyId: string): any {
  return runtime.getPtyAgent(ptyId)
}

export function getAgentPromptActivity(runtime: OrcaRuntimeService, ptyId: string): any {
  return runtime.getAgentPromptActivity(ptyId)
}

export function serializeAgentPromptSubmission(
  runtime: OrcaRuntimeService,
  ptyId: string,
  ...args: any[]
): any {
  return (runtime as any).serializeAgentPromptSubmission?.(ptyId, ...args)
}

export function getPtyWriteHostPlatform(runtime: OrcaRuntimeService, ptyId: string): string {
  return runtime.getPtyWriteHostPlatform(ptyId)
}

export function getExactWorkerProviderSession(
  runtime: OrcaRuntimeService,
  providerId: string,
  ...args: any[]
): any {
  return (runtime as any).getExactWorkerProviderSession?.(providerId, ...args)
}

export function getLiveTerminalPaneKey(runtime: OrcaRuntimeService, handle: string): string | null {
  return runtime.getLiveTerminalPaneKey(handle)
}

export function listTerminals(runtime: OrcaRuntimeService, ...args: any[]): any[] {
  return (runtime as any).listTerminals?.(...args) ?? []
}

export function buildTerminalSummary(runtime: OrcaRuntimeService, ...args: any[]): any {
  return (runtime as any).buildTerminalSummary?.(...args)
}

export function getTerminalOrchestrationCliCommand(
  runtime: OrcaRuntimeService,
  ...args: any[]
): string | null {
  return (runtime as any).getTerminalOrchestrationCliCommand?.(...args) ?? null
}

export function resolveTerminalContext(runtime: OrcaRuntimeService, ...args: any[]): Promise<any> {
  return (runtime as any).resolveTerminalContext?.(...args) ?? Promise.resolve(null)
}

export function resolveTerminalCwd(runtime: OrcaRuntimeService, handle: string): Promise<string> {
  return runtime.resolveTerminalCwd(handle)
}

export function getOrchestrationDispatchAuthority(
  runtime: OrcaRuntimeService,
  ...args: any[]
): any {
  return (runtime as any).getOrchestrationDispatchAuthority?.(...args)
}

export function getTerminalProcessIncarnation(
  runtime: OrcaRuntimeService,
  ptyId: string,
  ...args: any[]
): any {
  return (runtime as any).getTerminalProcessIncarnation?.(ptyId, ...args)
}

export function visibleSnapshotPreview(
  runtime: OrcaRuntimeService,
  ptyId: string,
  ...args: any[]
): any {
  return (runtime as any).visibleSnapshotPreview?.(ptyId, ...args)
}

export function serializeHeadlessTerminalBuffer(runtime: OrcaRuntimeService, ...args: any[]): any {
  return (runtime as any).serializeHeadlessTerminalBuffer?.(...args)
}

export function serializeRendererTerminalBuffer(runtime: OrcaRuntimeService, ...args: any[]): any {
  return (runtime as any).serializeRendererTerminalBuffer?.(...args)
}

export function synchronizePtyOutputSequenceFromProvider(
  runtime: OrcaRuntimeService,
  ...args: any[]
): void {
  ;(runtime as any).synchronizePtyOutputSequenceFromProvider?.(...args)
}

export function getTerminalSideEffectSnapshot(runtime: OrcaRuntimeService, ...args: any[]): any {
  return (runtime as any).getTerminalSideEffectSnapshot?.(...args)
}

export function notePtyDataGap(runtime: OrcaRuntimeService, ptyId: string, ...args: any[]): void {
  ;(runtime as any).notePtyDataGap?.(ptyId, ...args)
}

export function primeWaitBlockedBaselineFromSeededTail(
  runtime: OrcaRuntimeService,
  ...args: any[]
): void {
  ;(runtime as any).primeWaitBlockedBaselineFromSeededTail?.(...args)
}

export function onPtyData(
  runtime: OrcaRuntimeService,
  ptyId: string,
  ...args: any[]
): Promise<void> {
  return (runtime as any).onPtyData?.(ptyId, ...args) ?? Promise.resolve()
}

export function emitTerminalSideEffectBatch(runtime: OrcaRuntimeService, ...args: any[]): void {
  ;(runtime as any).emitTerminalSideEffectBatch?.(...args)
}

export function resolveTerminalSideEffectAttribution(
  runtime: OrcaRuntimeService,
  ...args: any[]
): any {
  return (runtime as any).resolveTerminalSideEffectAttribution?.(...args)
}

export function restoreAgentPromptLifecycleByteOrder(
  runtime: OrcaRuntimeService,
  ...args: any[]
): void {
  ;(runtime as any).restoreAgentPromptLifecycleByteOrder?.(...args)
}

export function emitTerminalAgentStatusEvents(runtime: OrcaRuntimeService, ...args: any[]): void {
  ;(runtime as any).emitTerminalAgentStatusEvents?.(...args)
}

export function recordAgentPromptLifecycleState(runtime: OrcaRuntimeService, ...args: any[]): void {
  ;(runtime as any).recordAgentPromptLifecycleState?.(...args)
}

export function runWaitBlockedCheck(runtime: OrcaRuntimeService, ptyId: string): Promise<void> {
  return (runtime as any).runWaitBlockedCheck?.(ptyId) ?? Promise.resolve()
}

export function recordAgentPromptPermissionObservation(
  runtime: OrcaRuntimeService,
  ...args: any[]
): void {
  ;(runtime as any).recordAgentPromptPermissionObservation?.(...args)
}

export function applySeededAgentStatus(runtime: OrcaRuntimeService, ...args: any[]): void {
  ;(runtime as any).applySeededAgentStatus?.(...args)
}

export function noteTerminalSpawnCommand(runtime: OrcaRuntimeService, ...args: any[]): void {
  ;(runtime as any).noteTerminalSpawnCommand?.(...args)
}

export function acceptPtyIncarnationForExit(runtime: OrcaRuntimeService, ...args: any[]): void {
  ;(runtime as any).acceptPtyIncarnationForExit?.(...args)
}

export function createStructuredAgentSessionHandoffTransport(
  runtime: OrcaRuntimeService,
  ...args: any[]
): any {
  return (runtime as any).createStructuredAgentSessionHandoffTransport?.(...args)
}

export function closeStructuredTuiOwner(runtime: OrcaRuntimeService, ...args: any[]): void {
  ;(runtime as any).closeStructuredTuiOwner?.(...args)
}

export function waitForStructuredTuiProof(
  runtime: OrcaRuntimeService,
  ...args: any[]
): Promise<any> {
  return (runtime as any).waitForStructuredTuiProof?.(...args) ?? Promise.resolve(null)
}

export function waitForStructuredTuiIdleOrExit(
  runtime: OrcaRuntimeService,
  ...args: any[]
): Promise<any> {
  return (runtime as any).waitForStructuredTuiIdleOrExit?.(...args) ?? Promise.resolve(null)
}

export function structuredTuiStatus(runtime: OrcaRuntimeService, ...args: any[]): any {
  return (runtime as any).structuredTuiStatus?.(...args)
}

export function waitForStructuredTuiPtyExit(
  runtime: OrcaRuntimeService,
  ...args: any[]
): Promise<void> {
  return (runtime as any).waitForStructuredTuiPtyExit?.(...args) ?? Promise.resolve()
}

export function getPtyIdsForExplicitTabClose(
  runtime: OrcaRuntimeService,
  ...args: any[]
): string[] {
  return (runtime as any).getPtyIdsForExplicitTabClose?.(...args) ?? []
}

export function waitForAdoptedStructuredTuiProof(
  runtime: OrcaRuntimeService,
  ...args: any[]
): Promise<any> {
  return (runtime as any).waitForAdoptedStructuredTuiProof?.(...args) ?? Promise.resolve(null)
}

export function withVisibleSnapshotFallback(runtime: OrcaRuntimeService, ...args: any[]): any {
  return (runtime as any).withVisibleSnapshotFallback?.(...args)
}

export function isTerminalAlternateScreen(runtime: OrcaRuntimeService, ...args: any[]): boolean {
  return (runtime as any).isTerminalAlternateScreen?.(...args) ?? false
}

export function readVisibleTerminalState(runtime: OrcaRuntimeService, ...args: any[]): any {
  return (runtime as any).readVisibleTerminalState?.(...args)
}

export function getPtyOutputSequence(runtime: OrcaRuntimeService, ptyId: string): number {
  return (runtime as any).getPtyOutputSequence?.(ptyId) ?? 0
}

export function refreshStructuredTuiOwnerBinding(
  runtime: OrcaRuntimeService,
  ...args: any[]
): void {
  ;(runtime as any).refreshStructuredTuiOwnerBinding?.(...args)
}

export function getPtyExecutionHostMetadata(
  runtime: OrcaRuntimeService,
  ptyId: string,
  ...args: any[]
): any {
  return (runtime as any).getPtyExecutionHostMetadata?.(ptyId, ...args)
}

export function getOrCreatePtyWorktreeRecord(
  runtime: OrcaRuntimeService,
  ptyId: string,
  ...args: any[]
): any {
  return (runtime as any).getOrCreatePtyWorktreeRecord?.(ptyId, ...args)
}

export function findLiveRegisteredPtyForRendererTab(
  runtime: OrcaRuntimeService,
  ...args: any[]
): string | null {
  return (runtime as any).findLiveRegisteredPtyForRendererTab?.(...args) ?? null
}

export function preparePtyExecutionContext(runtime: OrcaRuntimeService, ...args: any[]): void {
  ;(runtime as any).preparePtyExecutionContext?.(...args)
}

export function replaceHeadlessTerminalAfterExecutionContextChange(
  runtime: OrcaRuntimeService,
  ...args: any[]
): Promise<void> {
  return (
    (runtime as any).replaceHeadlessTerminalAfterExecutionContextChange?.(...args) ??
    Promise.resolve()
  )
}

export function serializeProviderTerminalBuffer(runtime: OrcaRuntimeService, ...args: any[]): any {
  return (runtime as any).serializeProviderTerminalBuffer?.(...args)
}

export function captureProviderTerminalBuffer(runtime: OrcaRuntimeService, ...args: any[]): void {
  ;(runtime as any).captureProviderTerminalBuffer?.(...args)
}

export function createPtyHeadlessTerminalState(runtime: OrcaRuntimeService, ...args: any[]): any {
  return (runtime as any).createPtyHeadlessTerminalState?.(...args)
}

export function restoreLivePairedRendererSessionOwnedMobileTerminals(
  runtime: OrcaRuntimeService,
  ...args: any[]
): void {
  ;(runtime as any).restoreLivePairedRendererSessionOwnedMobileTerminals?.(...args)
}

export function onPtyExit(runtime: OrcaRuntimeService, ptyId: string, ...args: any[]): void {
  ;(runtime as any).onPtyExit?.(ptyId, ...args)
}

export function getPtyLifecycleGeneration(runtime: OrcaRuntimeService, ptyId: string): number {
  return (runtime as any).getPtyLifecycleGeneration?.(ptyId) ?? 0
}

export function retirePtyAgentLaunchAuthority(runtime: OrcaRuntimeService, ptyId: string): void {
  ;(runtime as any).retirePtyAgentLaunchAuthority?.(ptyId)
}

export function getPtyLivenessVerdict(
  runtime: OrcaRuntimeService,
  ptyId: string,
  ...args: any[]
): string | null {
  return (runtime as any).getPtyLivenessVerdict?.(ptyId, ...args) ?? null
}

export function collectPaneKeysForPty(
  runtime: OrcaRuntimeService,
  ptyId: string,
  ...args: any[]
): string[] {
  return (runtime as any).collectPaneKeysForPty?.(ptyId, ...args) ?? []
}

export function toMobileSessionTabsResult(runtime: OrcaRuntimeService, ...args: any[]): any {
  return (runtime as any).toMobileSessionTabsResult?.(...args)
}

export function refreshPtyWorktreeRecordsWithControllerInventory(
  runtime: OrcaRuntimeService,
  ...args: any[]
): void {
  ;(runtime as any).refreshPtyWorktreeRecordsWithControllerInventory?.(...args)
}

export function rememberPtyLivenessVerdict(
  runtime: OrcaRuntimeService,
  ptyId: string,
  ...args: any[]
): void {
  ;(runtime as any).rememberPtyLivenessVerdict?.(ptyId, ...args)
}

export function isKnownUnattachedLocalDaemonPty(
  runtime: OrcaRuntimeService,
  ptyId: string
): boolean {
  return (runtime as any).isKnownUnattachedLocalDaemonPty?.(ptyId) ?? false
}

export function adoptControllerTerminalHandle(
  runtime: OrcaRuntimeService,
  ...args: any[]
): Promise<void> {
  return (runtime as any).adoptControllerTerminalHandle?.(...args) ?? Promise.resolve()
}

export function refreshFloatingWorkspacePtyLiveness(
  runtime: OrcaRuntimeService,
  ...args: any[]
): void {
  ;(runtime as any).refreshFloatingWorkspacePtyLiveness?.(...args)
}

export function pruneDisconnectedPtyRecords(runtime: OrcaRuntimeService): void {
  ;(runtime as any).pruneDisconnectedPtyRecords?.()
}

export function dropDisconnectedPtyRecord(runtime: OrcaRuntimeService, ptyId: string): void {
  ;(runtime as any).dropDisconnectedPtyRecord?.(ptyId)
}

export function advancePtyLifecycleGeneration(
  runtime: OrcaRuntimeService,
  ptyId: string,
  ...args: any[]
): void {
  ;(runtime as any).advancePtyLifecycleGeneration?.(ptyId, ...args)
}

export function forgetPtyLivenessVerdict(runtime: OrcaRuntimeService, ptyId: string): void {
  ;(runtime as any).forgetPtyLivenessVerdict?.(ptyId)
}

export function recordPtyWorktree(
  runtime: OrcaRuntimeService,
  ptyId: string,
  ...args: any[]
): void {
  ;(runtime as any).recordPtyWorktree?.(ptyId, ...args)
}

export function reconcileLegacyWorkerTerminalsNow(runtime: OrcaRuntimeService): Promise<void> {
  return (runtime as any).reconcileLegacyWorkerTerminalsNow?.() ?? Promise.resolve()
}

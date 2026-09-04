// WP5: Mobile Session State
// Extracted methods for managing mobile session tabs, remote desktop state, and mobile UI

import type { OrcaRuntimeService } from './orca-runtime'

// Temporary delegation module - will be refactored to avoid tight coupling
// For now, these are convenience exports that delegate to the runtime instance

type RuntimeMethod = (...args: unknown[]) => unknown

function delegate(rt: OrcaRuntimeService, methodName: string): RuntimeMethod {
  return (...args: unknown[]): unknown => {
    const method = (rt as unknown as Record<string, unknown>)[methodName] as RuntimeMethod
    return method?.(...args)
  }
}

export function flushScheduledMobileSessionTabsChanged(
  rt: OrcaRuntimeService,
  worktreeId: string
): void {
  delegate(rt, 'flushScheduledMobileSessionTabsChanged')(worktreeId) as void
}

export function runCreateMobileSessionTerminal(
  rt: OrcaRuntimeService,
  ...args: unknown[]
): unknown {
  return delegate(rt, 'runCreateMobileSessionTerminal')(...args)
}

export function removeWorktreeMetadataAndHistory(rt: OrcaRuntimeService, ...args: unknown[]): void {
  delegate(rt, 'removeWorktreeMetadataAndHistory')(...args) as void
}

export function buildTerminalVisualLayouts(rt: OrcaRuntimeService, ...args: unknown[]): unknown {
  return delegate(rt, 'buildTerminalVisualLayouts')(...args)
}

export function onExternalPtyResize(rt: OrcaRuntimeService, ...args: unknown[]): void {
  delegate(rt, 'onExternalPtyResize')(...args) as void
}

export function updateMobileSubscriberViewport(
  rt: OrcaRuntimeService,
  ...args: unknown[]
): unknown {
  return delegate(rt, 'updateMobileSubscriberViewport')(...args)
}

export function setMobileDisplayMode(rt: OrcaRuntimeService, ...args: unknown[]): void {
  delegate(rt, 'setMobileDisplayMode')(...args) as void
}

export function isMobileSubscriberActive(rt: OrcaRuntimeService, ...args: unknown[]): boolean {
  return Boolean(delegate(rt, 'isMobileSubscriberActive')(...args))
}

export function beginMobileInputFloor(rt: OrcaRuntimeService, ...args: unknown[]): unknown {
  return delegate(rt, 'beginMobileInputFloor')(...args)
}

export function markMobileActor(rt: OrcaRuntimeService, ...args: unknown[]): void {
  delegate(rt, 'markMobileActor')(...args) as void
}

export function recordRendererGeometry(rt: OrcaRuntimeService, ...args: unknown[]): void {
  delegate(rt, 'recordRendererGeometry')(...args) as void
}

export function refreshRendererGeometry(rt: OrcaRuntimeService, ...args: unknown[]): void {
  delegate(rt, 'refreshRendererGeometry')(...args) as void
}

export function refreshRemoteDesktopViewer(rt: OrcaRuntimeService, ...args: unknown[]): unknown {
  return delegate(rt, 'refreshRemoteDesktopViewer')(...args)
}

export function unregisterRemoteDesktopViewers(
  rt: OrcaRuntimeService,
  ...args: unknown[]
): unknown {
  return delegate(rt, 'unregisterRemoteDesktopViewers')(...args)
}

export function claimRemoteDesktopHost(rt: OrcaRuntimeService, ...args: unknown[]): unknown {
  return delegate(rt, 'claimRemoteDesktopHost')(...args)
}

export function claimRemoteDesktopViewer(rt: OrcaRuntimeService, ...args: unknown[]): unknown {
  return delegate(rt, 'claimRemoteDesktopViewer')(...args)
}

export function updateRemoteDesktopViewer(rt: OrcaRuntimeService, ...args: unknown[]): unknown {
  return delegate(rt, 'updateRemoteDesktopViewer')(...args)
}

export function bumpRemoteDesktopViewerRevision(
  rt: OrcaRuntimeService,
  ...args: unknown[]
): number {
  return Number(delegate(rt, 'bumpRemoteDesktopViewerRevision')(...args))
}

export function hasRemoteDesktopLayoutState(rt: OrcaRuntimeService, ...args: unknown[]): boolean {
  return Boolean(delegate(rt, 'hasRemoteDesktopLayoutState')(...args))
}

export function recordRemoteDesktopHostReclaimTarget(
  rt: OrcaRuntimeService,
  ...args: unknown[]
): void {
  delegate(rt, 'recordRemoteDesktopHostReclaimTarget')(...args) as void
}

export function ensureRemoteDesktopHostReclaimTarget(
  rt: OrcaRuntimeService,
  ...args: unknown[]
): void {
  delegate(rt, 'ensureRemoteDesktopHostReclaimTarget')(...args) as void
}

export function isRemoteDesktopViewerOwner(rt: OrcaRuntimeService, ...args: unknown[]): boolean {
  return Boolean(delegate(rt, 'isRemoteDesktopViewerOwner')(...args))
}

export function isRemoteDesktopResizeDriven(rt: OrcaRuntimeService, ...args: unknown[]): boolean {
  return Boolean(delegate(rt, 'isRemoteDesktopResizeDriven')(...args))
}

export function onClientDisconnected(rt: OrcaRuntimeService, ...args: unknown[]): void {
  delegate(rt, 'onClientDisconnected')(...args) as void
}

export function applyRemoteDesktopLayout(rt: OrcaRuntimeService, ...args: unknown[]): unknown {
  return delegate(rt, 'applyRemoteDesktopLayout')(...args)
}

export function resolveRemoteDesktopHostReclaimTarget(
  rt: OrcaRuntimeService,
  ...args: unknown[]
): unknown {
  return delegate(rt, 'resolveRemoteDesktopHostReclaimTarget')(...args)
}

export function activeRemoteDesktopViewport(rt: OrcaRuntimeService, ...args: unknown[]): unknown {
  return delegate(rt, 'activeRemoteDesktopViewport')(...args)
}

export function hasRemoteDesktopViewers(rt: OrcaRuntimeService, ...args: unknown[]): boolean {
  return Boolean(delegate(rt, 'hasRemoteDesktopViewers')(...args))
}

export function getAllTerminalFitOverrides(rt: OrcaRuntimeService, ...args: unknown[]): unknown {
  return delegate(rt, 'getAllTerminalFitOverrides')(...args)
}

export function mobileTookFloor(rt: OrcaRuntimeService, ...args: unknown[]): unknown {
  return delegate(rt, 'mobileTookFloor')(...args)
}

export function applyMobileDisplayMode(rt: OrcaRuntimeService, ...args: unknown[]): unknown {
  return delegate(rt, 'applyMobileDisplayMode')(...args)
}

export function resolveDesktopRestoreTarget(rt: OrcaRuntimeService, ...args: unknown[]): unknown {
  return delegate(rt, 'resolveDesktopRestoreTarget')(...args)
}

export function getMobileDisplayMode(rt: OrcaRuntimeService, ...args: unknown[]): string {
  return String(delegate(rt, 'getMobileDisplayMode')(...args))
}

export function isMobileTerminalQueryReplyAuthority(
  rt: OrcaRuntimeService,
  ...args: unknown[]
): boolean {
  return Boolean(delegate(rt, 'isMobileTerminalQueryReplyAuthority')(...args))
}

export function publishStructuredAgentSessionTab(
  rt: OrcaRuntimeService,
  ...args: unknown[]
): unknown {
  return delegate(rt, 'publishStructuredAgentSessionTab')(...args)
}

export function findMobileTerminalSurfaceForPty(
  rt: OrcaRuntimeService,
  ...args: unknown[]
): unknown {
  return delegate(rt, 'findMobileTerminalSurfaceForPty')(...args)
}

export function resolveMobileMarkdownWorktreeId(
  rt: OrcaRuntimeService,
  ...args: unknown[]
): unknown {
  return delegate(rt, 'resolveMobileMarkdownWorktreeId')(...args)
}

export function setMobileSessionTabProps(rt: OrcaRuntimeService, ...args: unknown[]): unknown {
  return delegate(rt, 'setMobileSessionTabProps')(...args)
}

export function updateMobileSessionPaneLayout(rt: OrcaRuntimeService, ...args: unknown[]): unknown {
  return delegate(rt, 'updateMobileSessionPaneLayout')(...args)
}

export function moveMobileSessionTab(rt: OrcaRuntimeService, ...args: unknown[]): unknown {
  return delegate(rt, 'moveMobileSessionTab')(...args)
}

export function moveHeadlessMobileSessionTab(rt: OrcaRuntimeService, ...args: unknown[]): void {
  delegate(rt, 'moveHeadlessMobileSessionTab')(...args) as void
}

export function moveHeadlessMobileSessionTabToGroup(
  rt: OrcaRuntimeService,
  ...args: unknown[]
): void {
  delegate(rt, 'moveHeadlessMobileSessionTabToGroup')(...args) as void
}

export function splitHeadlessMobileSessionTabGroup(
  rt: OrcaRuntimeService,
  ...args: unknown[]
): void {
  delegate(rt, 'splitHeadlessMobileSessionTabGroup')(...args) as void
}

export function markHeadlessBrowserSessionTabActive(
  rt: OrcaRuntimeService,
  ...args: unknown[]
): void {
  delegate(rt, 'markHeadlessBrowserSessionTabActive')(...args) as void
}

export function closeMobileSessionTab(rt: OrcaRuntimeService, ...args: unknown[]): unknown {
  return delegate(rt, 'closeMobileSessionTab')(...args)
}

export function closeStructuredAgentSessionTab(
  rt: OrcaRuntimeService,
  ...args: unknown[]
): unknown {
  return delegate(rt, 'closeStructuredAgentSessionTab')(...args)
}

export function retireRuntimeOwnedBrowserSessionTab(
  rt: OrcaRuntimeService,
  ...args: unknown[]
): boolean {
  return Boolean(delegate(rt, 'retireRuntimeOwnedBrowserSessionTab')(...args))
}

export function closeHeadlessMobileTerminalTab(rt: OrcaRuntimeService, ...args: unknown[]): void {
  delegate(rt, 'closeHeadlessMobileTerminalTab')(...args) as void
}

export function republishMobileSessionTabsSnapshot(
  rt: OrcaRuntimeService,
  ...args: unknown[]
): void {
  delegate(rt, 'republishMobileSessionTabsSnapshot')(...args) as void
}

export function activateMobileSessionTab(rt: OrcaRuntimeService, ...args: unknown[]): unknown {
  return delegate(rt, 'activateMobileSessionTab')(...args)
}

export function activateHeadlessMobileSessionTerminalTab(
  rt: OrcaRuntimeService,
  ...args: unknown[]
): void {
  delegate(rt, 'activateHeadlessMobileSessionTerminalTab')(...args) as void
}

export function createRuntimeOwnedMobileSessionTerminal(
  rt: OrcaRuntimeService,
  ...args: unknown[]
): unknown {
  return delegate(rt, 'createRuntimeOwnedMobileSessionTerminal')(...args)
}

export function findMobileTerminalSurface(rt: OrcaRuntimeService, ...args: unknown[]): unknown {
  return delegate(rt, 'findMobileTerminalSurface')(...args)
}

export function collectAllMobileSessionTabs(rt: OrcaRuntimeService, ...args: unknown[]): unknown {
  return delegate(rt, 'collectAllMobileSessionTabs')(...args)
}

export function scheduleMobileSessionTabsChanged(rt: OrcaRuntimeService, ...args: unknown[]): void {
  delegate(rt, 'scheduleMobileSessionTabsChanged')(...args) as void
}

export function syncMobileSessionTabs(rt: OrcaRuntimeService, ...args: unknown[]): unknown {
  return delegate(rt, 'syncMobileSessionTabs')(...args)
}

export function publishPtyBackedMobileSessionTerminal(
  rt: OrcaRuntimeService,
  ...args: unknown[]
): void {
  delegate(rt, 'publishPtyBackedMobileSessionTerminal')(...args) as void
}

export function publishRecoveredSshMobileSessionTabs(
  rt: OrcaRuntimeService,
  ...args: unknown[]
): unknown {
  return delegate(rt, 'publishRecoveredSshMobileSessionTabs')(...args)
}

export function notifyMobileSessionTabsChanged(rt: OrcaRuntimeService, ...args: unknown[]): void {
  delegate(rt, 'notifyMobileSessionTabsChanged')(...args) as void
}

export function notifyMobileSessionTabsChangedNow(
  rt: OrcaRuntimeService,
  ...args: unknown[]
): void {
  delegate(rt, 'notifyMobileSessionTabsChangedNow')(...args) as void
}

export function cancelScheduledMobileSessionTabsChanged(
  rt: OrcaRuntimeService,
  ...args: unknown[]
): void {
  delegate(rt, 'cancelScheduledMobileSessionTabsChanged')(...args) as void
}

export function getMobileSessionTabsForWorktree(
  rt: OrcaRuntimeService,
  ...args: unknown[]
): unknown {
  return delegate(rt, 'getMobileSessionTabsForWorktree')(...args)
}

export function hydrateHeadlessMobileSessionTabsFromWorkspaceSession(
  rt: OrcaRuntimeService,
  ...args: unknown[]
): void {
  delegate(rt, 'hydrateHeadlessMobileSessionTabsFromWorkspaceSession')(...args) as void
}

export function hasRemoteTerminalViewSubscriber(
  rt: OrcaRuntimeService,
  ...args: unknown[]
): boolean {
  return Boolean(delegate(rt, 'hasRemoteTerminalViewSubscriber')(...args))
}

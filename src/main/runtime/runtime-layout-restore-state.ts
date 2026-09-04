// WP6: Layout Restore State
// Extracted methods for managing layout, resize events, and message waiters
/* eslint-disable no-explicit-any -- Why: delegation pattern requires unsafe casting to access private methods */
/* eslint-disable array-type -- Why: Array<T> is used for complex union types in method signatures */

import type { OrcaRuntimeService } from './orca-runtime'

// Message waiter methods (orchestration.check --wait support)
export function waitForMessage(
  rt: OrcaRuntimeService,
  handle: string,
  options?: {
    typeFilter?: string[]
    timeoutMs?: number
    signal?: AbortSignal
    exclusive?: boolean
  }
): ReturnType<OrcaRuntimeService['waitForMessage']> {
  return (rt as any).waitForMessage(handle, options)
}

export function cancelMessageWaiters(rt: OrcaRuntimeService, handle: string): void {
  return (rt as any).cancelMessageWaiters(handle)
}

export function removeMessageWaiter(rt: OrcaRuntimeService, waiter: any): void {
  return (rt as any).removeMessageWaiter(waiter)
}

// Resize event subscription
export function subscribeToTerminalResize(
  rt: OrcaRuntimeService,
  ptyId: string,
  listener: (event: {
    cols: number
    rows: number
    displayMode: string
    reason: string
    seq?: number
  }) => void
): () => void {
  return (rt as any).subscribeToTerminalResize(ptyId, listener)
}

// Layout state queries
export function getLastRendererSize(
  rt: OrcaRuntimeService,
  ptyId: string
): { cols: number; rows: number } | null {
  return (rt as any).getLastRendererSize(ptyId)
}

export function getLayout(rt: OrcaRuntimeService, ptyId: string): any {
  return (rt as any).getLayout(ptyId)
}

// Layout modifications
export function resizeForClient(
  rt: OrcaRuntimeService,
  ptyId: string,
  mode: 'mobile-fit' | 'restore',
  clientId: string,
  cols?: number,
  rows?: number
): Promise<{
  cols: number
  rows: number
  previousCols: number | null
  previousRows: number | null
  mode: 'mobile-fit' | 'desktop-fit'
}> {
  return (rt as any).resizeForClient(ptyId, mode, clientId, cols, rows)
}

export function updateDesktopViewport(
  rt: OrcaRuntimeService,
  ptyId: string,
  cols: number,
  rows: number
): Promise<boolean> {
  return (rt as any).updateDesktopViewport(ptyId, cols, rows)
}

export function updateMobileViewport(
  rt: OrcaRuntimeService,
  ptyId: string,
  clientId: string,
  cols: number,
  rows: number
): Promise<boolean> {
  return (rt as any).updateMobileViewport(ptyId, clientId, cols, rows)
}

export function reclaimTerminalForDesktop(
  rt: OrcaRuntimeService,
  ptyId: string
): Promise<boolean> {
  return (rt as any).reclaimTerminalForDesktop(ptyId)
}

export function handleMobileUnsubscribe(
  rt: OrcaRuntimeService,
  ptyId: string,
  clientId: string
): void {
  return (rt as any).handleMobileUnsubscribe(ptyId, clientId)
}

export function cancelAllPendingFitRestoreTimers(rt: OrcaRuntimeService): void {
  return (rt as any).cancelAllPendingFitRestoreTimers()
}

// Internal layout machinery (not part of public API but needed for internal coordination)
export function notifyTerminalResize(
  rt: OrcaRuntimeService,
  ptyId: string,
  event: { cols: number; rows: number; displayMode: string; reason: string; seq?: number }
): void {
  return (rt as any).notifyTerminalResize(ptyId, event)
}

export function handleMobileSubscribeInternal(
  rt: OrcaRuntimeService,
  ptyId: string,
  clientId: string,
  viewport: { cols: number; rows: number } | null,
  displayMode: string
): Promise<{ seq: number; mobileAutoRestoreFitMs: number | null }> {
  return (rt as any).handleMobileSubscribeInternal(ptyId, clientId, viewport, displayMode)
}

export function enqueueLayout(
  rt: OrcaRuntimeService,
  ptyId: string,
  target: any
): Promise<any> {
  return (rt as any).enqueueLayout(ptyId, target)
}

export function runLayoutSlot(
  rt: OrcaRuntimeService,
  ptyId: string,
  target: any,
  waiters: Array<(result: any) => void>
): Promise<void> {
  return (rt as any).runLayoutSlot(ptyId, target, waiters)
}

export function applyLayout(
  rt: OrcaRuntimeService,
  ptyId: string,
  target: any
): Promise<any> {
  return (rt as any).applyLayout(ptyId, target)
}

export function isFreshSubscribe(rt: OrcaRuntimeService, ptyId: string): boolean {
  return (rt as any).isFreshSubscribe(ptyId)
}

export function cancelPendingDriverMutations(rt: OrcaRuntimeService, ptyId: string): void {
  return (rt as any).cancelPendingDriverMutations(ptyId)
}

import type { IPty } from 'node-pty'
import type { ManagedPty } from './pty-handler'
import { forceKillPosixPtyProcessGroups } from '../main/pty/posix-pty-process-groups'
import { isProcessAlive } from './pty-shell-utils'

export const IMMEDIATE_PTY_EXIT_TIMEOUT_MS = 8_000
/** Longer than the 5s armed SIGKILL fallback, so the first sweep observes the post-kill state. */
export const SHUTDOWN_REAP_VERIFY_DELAY_MS = 6_000
export const SHUTDOWN_REAP_MAX_SWEEPS = 3
const PTY_FORCE_KILL_RETRY_DELAY_MS = 250
const PTY_FORCE_KILL_MAX_ATTEMPTS = 2

export type KillFallbackAction = 'terminate stale' | 'force-kill'

// Why: Windows ConPTY rejects signals; forward them only on POSIX.
export function killPtyProcess(pty: IPty, signal: string): void {
  if (process.platform === 'win32') {
    pty.kill()
    return
  }
  if (signal === 'SIGKILL') {
    forceKillPosixPtyProcessGroups(pty.pid, () => pty.kill(signal))
    return
  }
  pty.kill(signal)
}

type ReaperCallbacks = {
  getManaged: (id: string) => ManagedPty | undefined
  reapExitedPty: (managed: ManagedPty) => void
}

/** Owns the kill-escalation and post-shutdown reap machinery: graceful SIGTERM with a bounded
 *  SIGKILL fallback, and the retirement sweep that re-probes liveness instead of trusting the
 *  kill request. Verdict vocabulary: `reaped` = proven exited, retained = unverifiable. */
export class PtyShutdownReaper {
  constructor(private readonly callbacks: ReaperCallbacks) {}

  /** After a retirement, verify the host actually reaped the shell rather than trusting the kill
   *  request. Two outcomes matter and both are bookkeeping the relay previously never did:
   *
   * - the pid is gone but node-pty never produced `onExit` — retire the record here, so the entry
   *   and its agent-session owners stop being published by `pty.listProcesses`;
   * - the pid is still alive — re-issue the force kill instead of leaving a detached shell (and the
   *   agent inside it) outliving its tab for the life of the daemon.
   *
   * Bounded: after {@link SHUTDOWN_REAP_MAX_SWEEPS} the owner claim is deliberately *retained*.
   * Releasing a claim we cannot prove dead is what lets a reopened project spawn a second agent
   * over one transcript; keeping it makes the next `pty.spawn` adopt this PTY instead.
   */
  armShutdownReapSweep(managed: ManagedPty, attemptsRemaining: number): void {
    if (managed.reapTimer) {
      return
    }
    const timer = setTimeout(() => {
      managed.reapTimer = undefined
      if (this.callbacks.getManaged(managed.id) !== managed || managed.disposed) {
        return
      }
      const pid = managed.pty.pid
      if (pid && !isProcessAlive(pid)) {
        this.callbacks.reapExitedPty(managed)
        return
      }
      if (attemptsRemaining <= 0) {
        process.stderr.write(
          `[pty-handler] retired pane PTY ${managed.id} still alive after force kill; ownership retained as unverifiable\n`
        )
        return
      }
      // Why POSIX-only: a SIGKILL that returned success is not proof of death there — the group
      // probe can degrade to a root-pid kill, leaving the agent running under a shell nobody is
      // watching. On Windows ConPTY's kill is already force-final and closing its handle twice is
      // the hazard disposeManagedPty guards against, so the probe above is the whole sweep.
      if (process.platform !== 'win32') {
        managed.forceKillSent = false
        try {
          this.requestForceKill(managed)
        } catch {
          /* Re-probed on the next sweep; a transient failure must not end the escalation. */
        }
      }
      this.armShutdownReapSweep(managed, attemptsRemaining - 1)
    }, SHUTDOWN_REAP_VERIFY_DELAY_MS)
    timer.unref?.()
    managed.reapTimer = timer
  }

  requestGracefulKill(managed: ManagedPty, fallbackAction: KillFallbackAction): void {
    if (managed.gracefulKillSent) {
      return
    }
    managed.gracefulKillSent = true
    if (process.platform === 'win32') {
      // Why: ConPTY's bare kill is already force-final; block any later close of the handle.
      managed.forceKillSent = true
    }
    try {
      killPtyProcess(managed.pty, 'SIGTERM')
    } catch (error) {
      managed.gracefulKillSent = false
      managed.forceKillSent = false
      throw error
    }
    if (process.platform === 'win32') {
      return
    }
    // Why: POSIX children may ignore SIGTERM; arm a bounded SIGKILL fallback.
    this.armForceKillFallback(managed, fallbackAction, 5000, PTY_FORCE_KILL_MAX_ATTEMPTS)
  }

  private armForceKillFallback(
    managed: ManagedPty,
    fallbackAction: KillFallbackAction,
    delayMs: number,
    attemptsRemaining: number
  ): void {
    managed.killTimer = setTimeout(() => {
      managed.killTimer = undefined
      const still = this.callbacks.getManaged(managed.id)
      if (!still || still.disposed) {
        return
      }
      try {
        this.requestForceKill(still)
      } catch (error) {
        process.stderr.write(
          `[pty-handler] failed to ${fallbackAction} PTY ${managed.id}: ${error instanceof Error ? error.message : String(error)}\n`
        )
        // Why: a transient SIGKILL failure must not strand an unreachable remote shell.
        if (
          attemptsRemaining > 1 &&
          this.callbacks.getManaged(still.id) === still &&
          !still.disposed
        ) {
          this.armForceKillFallback(
            still,
            fallbackAction,
            PTY_FORCE_KILL_RETRY_DELAY_MS,
            attemptsRemaining - 1
          )
        }
      }
    }, delayMs)
  }

  requestForceKill(managed: ManagedPty): void {
    if (managed.forceKillSent || (process.platform === 'win32' && managed.gracefulKillSent)) {
      return
    }
    managed.forceKillSent = true
    try {
      killPtyProcess(managed.pty, 'SIGKILL')
    } catch (error) {
      managed.forceKillSent = false
      throw error
    }
  }

  waitForPhysicalExit(managed: ManagedPty, timeoutMs: number): Promise<void> {
    const physicalExit = managed.physicalExit
    if (!physicalExit) {
      return Promise.reject(new Error(`PTY "${managed.id}" exit tracking unavailable`))
    }
    return physicalExit.waitForExit(
      timeoutMs,
      () => new Error(`Timed out waiting for PTY process exit: ${managed.id}`)
    )
  }

  /** Retain the native owner until SIGKILL is accepted (one bounded retry) or onExit proves it gone. */
  async requestForceKillForRelayShutdown(managed: ManagedPty): Promise<void> {
    let lastError: unknown
    for (let attempt = 0; attempt < PTY_FORCE_KILL_MAX_ATTEMPTS; attempt++) {
      if (this.callbacks.getManaged(managed.id) !== managed || managed.disposed) {
        return
      }
      try {
        this.requestForceKill(managed)
        return
      } catch (error) {
        lastError = error
      }
      if (attempt + 1 < PTY_FORCE_KILL_MAX_ATTEMPTS) {
        const tracker = managed.physicalExit
        if (!tracker) {
          throw lastError
        }
        try {
          await tracker.waitForExit(
            PTY_FORCE_KILL_RETRY_DELAY_MS,
            () => new Error(`Retrying force-kill for PTY ${managed.id}`)
          )
          return
        } catch {
          // The bounded waiter detached; retry the still-owned native handle.
        }
      }
    }
    throw lastError
  }
}

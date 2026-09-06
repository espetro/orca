import type { ManagedPty } from './pty-handler'
import {
  createShellPromptReadinessProbe,
  type ShellPromptReadinessProbe
} from '../main/shell-prompt-readiness-probe'
import {
  drainShellStartupOutputScanState,
  scanShellStartupOutput,
  type ShellStartupOutputScanState
} from '../main/shell-startup-output-scanner'
import { SHELL_READY_MARKER_PREFIX } from '../main/shell-ready-marker-scanner'
import { buildStartupCommandSubmission } from '../shared/startup-command-submission'
import { readPtySlavePath } from '../shared/pty-slave-line-discipline-echo'

export const STARTUP_COMMAND_WRITE_DELAY_MS = 50
export const STARTUP_COMMAND_SHELL_READY_FALLBACK_MS = 1500
export const RENDERER_SHELL_READY_RETENTION_MS = 15_000

export type ManagedStartupCommand = {
  command: string | null
  providerDelivery: boolean
  delivered: boolean
  waitForShellReady: boolean
  outputScanState: ShellStartupOutputScanState | null
  shellPid: number | null
  promptProbe: ShellPromptReadinessProbe | null
  timer: ReturnType<typeof setTimeout> | null
}

/** Owns the startup-command lifecycle for a handler: arming the readiness probe, scanning shell
 *  output for the ready marker, and delivering the command to provider or renderer. */
export class PtyStartupCommandDelivery {
  constructor() {}

  clearStartupCommandTimer(managed: ManagedPty): void {
    if (managed.startupCommand?.timer) {
      clearTimeout(managed.startupCommand.timer)
      managed.startupCommand.timer = null
    }
  }

  releaseStartupCommand(managed: ManagedPty): void {
    this.clearStartupCommandTimer(managed)
    managed.startupCommand?.promptProbe?.dispose()
    managed.startupCommand = undefined
  }

  private drainStartupScanBytes(startup: ManagedStartupCommand): string {
    if (!startup.outputScanState) {
      return ''
    }
    const heldBytes = drainShellStartupOutputScanState(startup.outputScanState)
    startup.outputScanState = null
    return heldBytes
  }

  scheduleStartupCommandResolution(managed: ManagedPty, delayMs: number): void {
    const startup = managed.startupCommand
    if (!startup || startup.delivered || managed.disposed) {
      return
    }
    this.clearStartupCommandTimer(managed)
    startup.timer = setTimeout(() => {
      startup.timer = null
      if (startup.providerDelivery) {
        this.deliverStartupCommand(managed)
      } else {
        this.signalRendererShellReady(managed)
      }
    }, delayMs)
  }

  private deliverStartupCommand(managed: ManagedPty): void {
    const startup = managed.startupCommand
    if (!startup?.providerDelivery || !startup.command || startup.delivered || managed.disposed) {
      return
    }
    startup.delivered = true
    this.clearStartupCommandTimer(managed)
    startup.promptProbe?.dispose()
    const heldBytes = this.drainStartupScanBytes(startup)
    if (heldBytes) {
      managed.startupIngress?.accept(heldBytes)
    }
    const submit = process.platform === 'win32' ? '\r' : '\n'
    // Why: only the shell-ready wrapper arms bracketed-paste; other shells use raw submit so ESC[200~ markers aren't echoed.
    const payload = buildStartupCommandSubmission(startup.command, {
      submit,
      bracketedPasteSafe: startup.waitForShellReady
    })
    managed.startupCommand = undefined
    managed.pty.write(payload)
  }

  private signalRendererShellReady(managed: ManagedPty): void {
    const startup = managed.startupCommand
    if (!startup || startup.providerDelivery || startup.delivered || managed.disposed) {
      return
    }
    startup.delivered = true
    this.clearStartupCommandTimer(managed)
    startup.promptProbe?.dispose()
    managed.startupIngress?.accept(this.drainStartupScanBytes(startup))
    managed.startupIngress?.accept(`${SHELL_READY_MARKER_PREFIX}\x07`)
    managed.startupCommand = undefined
  }

  /** Arm the prompt-readiness probe for a PTY waiting on shell-ready. */
  armPromptProbe(managed: ManagedPty): void {
    const startup = managed.startupCommand
    if (!startup?.waitForShellReady) {
      return
    }
    startup.promptProbe = createShellPromptReadinessProbe({
      slavePath: readPtySlavePath(managed.pty),
      shellPath: managed.shellPath,
      shellCwd: managed.shellCwd,
      shellPathEnv: managed.shellPathEnv,
      getShellPid: () => startup.shellPid,
      onPromptReady: () => {
        if (startup.providerDelivery) {
          this.scheduleStartupCommandResolution(managed, STARTUP_COMMAND_WRITE_DELAY_MS)
        } else {
          this.signalRendererShellReady(managed)
        }
      }
    })
  }

  /** Scan one output chunk for the shell-ready marker; returns the (possibly stripped) remainder
   *  to feed the ingress. Resolves the startup command when readiness is detected. */
  scanStartupOutput(managed: ManagedPty, data: string): string {
    const startup = managed.startupCommand
    if (!startup?.waitForShellReady || !startup.outputScanState || startup.delivered) {
      return data
    }
    const scanned = scanShellStartupOutput(startup.outputScanState, data)
    if (scanned.shellPid) {
      startup.shellPid = scanned.shellPid
    }
    if (scanned.ready) {
      if (startup.providerDelivery) {
        this.scheduleStartupCommandResolution(managed, STARTUP_COMMAND_WRITE_DELAY_MS)
      } else {
        this.signalRendererShellReady(managed)
      }
    }
    return scanned.output
  }

  notifyStartupOutput(managed: ManagedPty, data: string): void {
    if (managed.startupCommand && !managed.startupCommand.delivered && data.length > 0) {
      managed.startupCommand.promptProbe?.notifyOutput(data)
    }
  }
}

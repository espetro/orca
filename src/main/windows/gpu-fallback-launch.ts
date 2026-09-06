import { app } from 'electron'
import type { BrowserWindow } from 'electron'
import {
  DEFAULT_GPU_CRASH_FALLBACK_THRESHOLD,
  DEFAULT_GPU_CRASH_FALLBACK_WINDOW_MS,
  GpuCrashFallbackTracker,
  isGpuFallbackCrashCandidate
} from '../crash-reporting/gpu-crash-fallback-decision'
import {
  clearGpuFallbackMarker,
  readActiveGpuFallbackMarker,
  writeGpuFallbackMarker,
  type GpuFallbackMarker,
  type GpuFallbackEnvironment,
  type WindowsGpuFallbackEnvironment
} from '../startup/gpu-fallback-marker'
import { GpuCrashDiagnosticsRecorder } from '../crash-reporting/gpu-crash-diagnostics'
import {
  handleGpuFallbackRecoveredLaunch,
  promptForGpuFallbackRecoveredLaunch
} from '../crash-reporting/gpu-fallback-recovered-launch'
import { engageGpuFallbackAfterCrashBurst } from '../crash-reporting/gpu-fallback-engagement'
import { promptForGpuFallbackRestart } from '../crash-reporting/gpu-fallback-restart-prompt'
import { applyGpuFallbackCommandLineSwitches } from '../startup/gpu-fallback-switches'
import { recordCrashBreadcrumb } from '../crash-reporting/crash-breadcrumb-store'
import { recordDurableCrashBreadcrumb } from '../crash-reporting/durable-crash-breadcrumb'
import { relaunchApp } from '../app-relaunch'
import { createGpuAccelerationAboutPanelOptions } from '../menu/gpu-acceleration-about-panel'
import { destroySystemTray } from '../tray/system-tray'

export type GpuFallbackLaunchDeps = {
  isServeMode: boolean
  getIsQuitting: () => boolean
  setQuitting: () => void
  getMainWindow: () => BrowserWindow | null
}

export function createGpuFallbackLaunchController(deps: GpuFallbackLaunchDeps) {
  const gpuCrashFallbackTracker = new GpuCrashFallbackTracker({
    windowMs: DEFAULT_GPU_CRASH_FALLBACK_WINDOW_MS,
    threshold: DEFAULT_GPU_CRASH_FALLBACK_THRESHOLD
  })
  let activeGpuFallbackMarker: GpuFallbackMarker | null = null
  let gpuFallbackActiveThisLaunch = false
  let gpuFeatureStatus: Electron.GPUFeatureStatus | null = null
  const gpuCrashDiagnostics =
    process.platform === 'win32'
      ? new GpuCrashDiagnosticsRecorder({
          provider: {
            getGPUInfo: (infoType) => app.getGPUInfo(infoType),
            getGPUFeatureStatus: () => app.getGPUFeatureStatus()
          },
          recordBreadcrumb: (data) => recordDurableCrashBreadcrumb('gpu_crash_hardware', data)
        })
      : null

  function updateGpuAccelerationAboutPanel(): void {
    app.setAboutPanelOptions(
      createGpuAccelerationAboutPanelOptions({
        appName: app.name,
        appVersion: app.getVersion(),
        platform: process.platform,
        gpuFallbackActive: gpuFallbackActiveThisLaunch,
        gpuFeatureStatus
      })
    )
  }

  function trackGpuInfoUpdate(): void {
    gpuFeatureStatus = app.getGPUFeatureStatus()
    gpuCrashDiagnostics?.warm()
    if (app.isReady()) {
      updateGpuAccelerationAboutPanel()
    }
  }

  function getGpuFallbackEnvironment(): GpuFallbackEnvironment {
    return {
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron ?? '',
      platform: process.platform
    }
  }

  function getWindowsGpuFallbackEnvironment(): WindowsGpuFallbackEnvironment | null {
    const environment = getGpuFallbackEnvironment()
    if (environment.platform !== 'win32') {
      return null
    }
    return { ...environment, platform: 'win32' }
  }

  // Writes both crash-time and post-recovery consent states through one build-scoped path.
  function persistGpuFallbackMarker(
    userDataPath: string,
    info: { engagedAt: number; crashesInWindow: number; userConfirmed: boolean }
  ): boolean {
    const environment = getWindowsGpuFallbackEnvironment()
    if (!environment) {
      return false
    }
    try {
      writeGpuFallbackMarker(userDataPath, info, environment)
      return true
    } catch (error) {
      console.warn('[gpu-fallback] failed to persist marker:', error)
      return false
    }
  }

  // Read before app.whenReady() so app.disableHardwareAcceleration() takes effect. Windows desktop only.
  function maybeApplyGpuFallbackForThisLaunch(): void {
    if (deps.isServeMode || process.platform !== 'win32') {
      return
    }
    const marker = readActiveGpuFallbackMarker(app.getPath('userData'), getGpuFallbackEnvironment())
    if (!marker) {
      return
    }
    activeGpuFallbackMarker = marker
    app.disableHardwareAcceleration()
    const appliedSwitches = applyGpuFallbackCommandLineSwitches(app.commandLine, process.platform)
    gpuFallbackActiveThisLaunch = true
    // Why: with no GPU child left, child-process-gone can't report a GPU fault, so
    // name the applied switches in the trail any later crash report carries.
    recordCrashBreadcrumb('gpu_fallback_applied', {
      crashesInWindow: marker.crashesInWindow,
      switches: appliedSwitches.join(',')
    })
  }

  async function presentGpuFallbackRecoveredLaunchPrompt(window: BrowserWindow): Promise<void> {
    const marker = activeGpuFallbackMarker
    if (!marker || marker.userConfirmed || window.isDestroyed() || deps.getIsQuitting()) {
      return
    }
    // One prompt per process. A failure leaves the on-disk marker unconfirmed so the next launch retries.
    activeGpuFallbackMarker = null
    const userDataPath = app.getPath('userData')
    await handleGpuFallbackRecoveredLaunch({
      isQuitting: () => deps.getIsQuitting(),
      prompt: () => promptForGpuFallbackRecoveredLaunch(window),
      confirmSafeGraphics: () => {
        persistGpuFallbackMarker(userDataPath, {
          engagedAt: marker.engagedAt,
          crashesInWindow: marker.crashesInWindow,
          userConfirmed: true
        })
      },
      clearSafeGraphics: () => clearGpuFallbackMarker(userDataPath),
      onPromptFailed: (error) =>
        console.warn('[gpu-fallback] failed to show recovered-launch prompt:', error),
      onSafeGraphicsKept: () =>
        recordDurableCrashBreadcrumb('gpu_fallback_safe_graphics_kept', {
          crashesInWindow: marker.crashesInWindow
        }),
      restartWithHardware: () => {
        deps.setQuitting()
        relaunchApp('gpu-fallback', {
          mode: 'hardware-retry',
          crashesInWindow: marker.crashesInWindow
        })
        destroySystemTray()
        app.exit(0)
      }
    })
  }

  // Why: a burst of GPU child crashes means HW acceleration is unusable — persist a build-scoped marker and offer software rendering.
  async function handleGpuChildCrash(
    reason: string,
    exitCode: number | null,
    crashedAt: number
  ): Promise<void> {
    // Software rendering already active or shutting down: nothing more to do.
    if (gpuFallbackActiveThisLaunch || deps.getIsQuitting() || deps.isServeMode) {
      return
    }
    const result = gpuCrashFallbackTracker.recordGpuCrash(crashedAt)
    if (!result.shouldEngageFallback) {
      return
    }
    const fallbackData = {
      processReason: reason,
      exitCode,
      crashesInWindow: result.crashesInWindow
    }
    const userDataPath = app.getPath('userData')
    await engageGpuFallbackAfterCrashBurst(
      { reason, exitCode, crashesInWindow: result.crashesInWindow, engagedAt: Date.now() },
      {
        isQuitting: () => deps.getIsQuitting(),
        onEngaged: (engagement) =>
          recordCrashBreadcrumb('gpu_fallback_engaged', {
            reason: engagement.reason,
            exitCode: engagement.exitCode,
            crashesInWindow: engagement.crashesInWindow
          }),
        persistMarker: (engagement) =>
          persistGpuFallbackMarker(userDataPath, {
            engagedAt: engagement.engagedAt,
            crashesInWindow: engagement.crashesInWindow,
            userConfirmed: false
          }),
        confirmMarker: (engagement) => {
          persistGpuFallbackMarker(userDataPath, {
            engagedAt: engagement.engagedAt,
            crashesInWindow: engagement.crashesInWindow,
            userConfirmed: true
          })
        },
        clearMarker: () => clearGpuFallbackMarker(userDataPath),
        promptForRestart: () =>
          promptForGpuFallbackRestart(
            deps.getMainWindow() && !deps.getMainWindow()!.isDestroyed()
              ? deps.getMainWindow()!
              : undefined
          ),
        onPromptFailed: (error) =>
          console.warn('[gpu-fallback] failed to show restart prompt:', error),
        onRestartDeferred: () =>
          recordDurableCrashBreadcrumb('gpu_fallback_restart_deferred', fallbackData),
        restartIntoSafeGraphics: () => {
          deps.setQuitting()
          relaunchApp('gpu-fallback', fallbackData)
          // Why: app.exit(0) skips before-quit, so destroy the Windows tray manually to avoid a stale icon.
          destroySystemTray()
          app.exit(0)
        }
      }
    )
  }

  function isGpuFallbackChildCrashCandidate(details: { type: string; reason: string }): boolean {
    return isGpuFallbackCrashCandidate({
      platform: process.platform,
      processType: details.type,
      reason: details.reason
    })
  }

  return {
    updateGpuAccelerationAboutPanel,
    trackGpuInfoUpdate,
    maybeApplyGpuFallbackForThisLaunch,
    presentGpuFallbackRecoveredLaunchPrompt,
    handleGpuChildCrash,
    isGpuFallbackChildCrashCandidate,
    isGpuFallbackActiveThisLaunch: () => gpuFallbackActiveThisLaunch,
    getGpuCrashDiagnostics: () => gpuCrashDiagnostics
  }
}

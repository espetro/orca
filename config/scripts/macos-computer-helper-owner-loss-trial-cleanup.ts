import { closeSync, existsSync, readFileSync, rmSync } from 'node:fs'
import {
  killRecordedAndMatchingProcesses,
  runBenchmarkCleanupStages,
  signalValidatedProcessGroup
} from './macos-computer-helper-owner-loss-processes.ts'

type CleanupOwnerLossTrialOptions = {
  failed?: boolean
  pid?: number
  marker?: string
  recordPath?: string
  helperPath?: string
  tempDir?: string
  stderrDescriptor?: number
  stdoutDescriptor?: number
  outputPaths?: (string | undefined)[]
  launcherDir?: string
}

type CleanupOwnerLossTrialResult = {
  error: unknown
  output: string
}

export function cleanupOwnerLossTrial(
  options: CleanupOwnerLossTrialOptions
): CleanupOwnerLossTrialResult {
  const groupState = { stopped: false, anchorPid: null }
  let error: unknown
  let output = ''
  try {
    runBenchmarkCleanupStages([
      () => {
        const pid = options.pid
        if (options.failed && pid !== undefined && Number.isInteger(pid) && options.marker) {
          signalValidatedProcessGroup(pid, options.marker, 'SIGSTOP', groupState)
        }
      },
      () => {
        const { recordPath, helperPath, tempDir } = options
        if (options.failed && recordPath && tempDir) {
          const recordedFragment = helperPath ?? tempDir
          killRecordedAndMatchingProcesses(recordPath, recordedFragment, [
            recordedFragment,
            tempDir
          ])
        }
      },
      () => {
        const pid = options.pid
        if (options.failed && pid !== undefined && Number.isInteger(pid) && options.marker) {
          signalValidatedProcessGroup(pid, options.marker, 'SIGKILL', groupState)
        }
      },
      () => {
        if (options.stderrDescriptor !== undefined) {
          closeSync(options.stderrDescriptor)
        }
      },
      () => {
        if (options.stdoutDescriptor !== undefined) {
          closeSync(options.stdoutDescriptor)
        }
      },
      () => {
        output = (options.outputPaths ?? [])
          .filter((outputPath): outputPath is string => {
            if (!outputPath) {
              return false
            }
            return existsSync(outputPath)
          })
          .map((outputPath) => readFileSync(outputPath, 'utf8'))
          .join('')
      },
      () => {
        if (options.launcherDir) {
          rmSync(options.launcherDir, { recursive: true, force: true })
        }
      },
      () => {
        if (options.tempDir) {
          rmSync(options.tempDir, { recursive: true, force: true })
        }
      }
    ])
  } catch (caught) {
    error = caught
  }
  return { error, output }
}

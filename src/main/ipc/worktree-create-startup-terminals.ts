import type { CreateWorktreeArgs, CreateWorktreeResult } from '../../shared/worktree/create-types'
import type { Worktree } from '../../shared/worktree/types'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { GlobalSettings } from '../../shared/global-settings-types'
import {
  buildSetupRunnerCommand,
  getSetupRunnerCommandPlatformForPath
} from '../../shared/setup-runner-command'
import { createSequencedSetupAgentCommands } from '../../shared/setup-agent-sequencing'
import { TUI_AGENT_CONFIG, isTuiAgent } from '../../shared/tui-agent-config'
import {
  markCodexProjectTrusted,
  markCopilotFolderTrusted,
  markCursorWorkspaceTrusted
} from '../agent-trust-presets'

export type StagedStartupResult = {
  startupTerminal?: CreateWorktreeResult['startupTerminal']
  activationSetup?: CreateWorktreeResult['setup']
  didSpawnSetup: boolean
  warning?: string
}

export function appendWorktreeCreateWarning(current: string | undefined, next: string): string {
  return current ? `${current} Also ${next[0]?.toLowerCase() ?? ''}${next.slice(1)}` : next
}

function getSetupRunnerCommandPlatformForLaunch(
  setup: CreateWorktreeResult['setup'],
  fallbackPlatform: 'windows' | 'posix'
): 'windows' | 'posix' {
  return getSetupRunnerCommandPlatformForPath(setup?.runnerScriptPath ?? '', fallbackPlatform)
}

export async function spawnLocalStartupAndSetupTerminals(args: {
  runtime: OrcaRuntimeService | undefined
  worktree: Pick<Worktree, 'id' | 'path'>
  startup: CreateWorktreeArgs['startup']
  setup: CreateWorktreeResult['setup']
  defaultTabs: CreateWorktreeResult['defaultTabs']
  settings: GlobalSettings
  createdWithAgent: CreateWorktreeArgs['createdWithAgent']
}): Promise<StagedStartupResult> {
  const { runtime, worktree, startup, setup, defaultTabs, settings, createdWithAgent } = args
  if (!runtime || !startup || defaultTabs?.tabs.length) {
    return { didSpawnSetup: false }
  }

  let warning: string | undefined
  let startupTerminalHandle: string | null = null
  let startupTerminal: CreateWorktreeResult['startupTerminal']

  let sequencedStartup = startup
  let wrappedSetupCommandStr: string | undefined
  if (startup && setup?.waitForAgentStartup === true) {
    const platform = getSetupRunnerCommandPlatformForLaunch(
      setup,
      process.platform === 'win32' ? 'windows' : 'posix'
    )
    const sequenced = createSequencedSetupAgentCommands({
      runnerScriptPath: setup.runnerScriptPath,
      startupCommand: startup.command,
      platform,
      shell: setup.shell
    })
    sequencedStartup = {
      ...startup,
      command: sequenced.startupCommand,
      ...(sequenced.startupEnv ? { env: { ...startup.env, ...sequenced.startupEnv } } : {})
    }
    wrappedSetupCommandStr = sequenced.setupCommand
  }

  try {
    // Why: only after `git worktree add` + metadata registration is the path safe for a runtime PTY to boot the agent while setup runs alongside.
    if (isTuiAgent(createdWithAgent)) {
      const preset = TUI_AGENT_CONFIG[createdWithAgent].preflightTrust
      try {
        if (preset === 'cursor') {
          markCursorWorkspaceTrusted(worktree.path)
        } else if (preset === 'copilot') {
          markCopilotFolderTrusted(worktree.path)
        } else if (preset === 'codex') {
          markCodexProjectTrusted(worktree.path)
        }
      } catch {
        // Best-effort: launch still proceeds and the agent can ask interactively.
      }
    }
    const terminal = await runtime.createTerminal(`id:${worktree.id}`, {
      command: sequencedStartup.command,
      ...(setup ? { claudeAgentTeamsSourceCommand: startup.command } : {}),
      env: sequencedStartup.env,
      ...(sequencedStartup.launchConfig ? { launchConfig: sequencedStartup.launchConfig } : {}),
      ...(isTuiAgent(createdWithAgent) ? { launchAgent: createdWithAgent } : {}),
      ...(sequencedStartup.viewMode ? { viewMode: sequencedStartup.viewMode } : {}),
      startupCommandDelivery: sequencedStartup.startupCommandDelivery,
      telemetry: sequencedStartup.telemetry,
      activate: true
    })
    startupTerminalHandle = terminal.handle
    startupTerminal = {
      spawned: true,
      surface: terminal.surface
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    warning = `Failed to create the startup terminal for ${worktree.path}: ${message}`
    console.warn(`[worktree-create] ${warning}`)
    return { didSpawnSetup: false, warning }
  }

  let didSpawnSetup = false
  if (setup) {
    try {
      const setupCommand =
        wrappedSetupCommandStr ??
        buildSetupRunnerCommand(
          setup.runnerScriptPath,
          getSetupRunnerCommandPlatformForLaunch(
            setup,
            process.platform === 'win32' ? 'windows' : 'posix'
          ),
          setup.shell
        )
      const setupLaunchMode =
        (settings as Partial<Pick<GlobalSettings, 'setupScriptLaunchMode'>>)
          .setupScriptLaunchMode ?? 'new-tab'
      if (setupLaunchMode === 'split-vertical' || setupLaunchMode === 'split-horizontal') {
        if (!startupTerminalHandle) {
          throw new Error('startup_terminal_missing')
        }
        await runtime.splitTerminal(startupTerminalHandle, {
          direction: setupLaunchMode === 'split-horizontal' ? 'horizontal' : 'vertical',
          command: setupCommand,
          env: setup.envVars,
          activate: false
        })
      } else {
        await runtime.createTerminal(`id:${worktree.id}`, {
          title: 'Setup',
          command: setupCommand,
          env: setup.envVars,
          activate: false
        })
      }
      didSpawnSetup = true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const nextWarning = `failed to create the setup terminal for ${worktree.path}: ${message}`
      warning = appendWorktreeCreateWarning(warning, nextWarning)
      console.warn(`[worktree-create] ${warning}`)
    }
  }

  return {
    ...(setup && !didSpawnSetup
      ? {
          activationSetup: {
            ...setup,
            ...(startupTerminalHandle && wrappedSetupCommandStr
              ? { command: wrappedSetupCommandStr }
              : {})
          }
        }
      : {}),
    ...(startupTerminal ? { startupTerminal } : {}),
    didSpawnSetup,
    ...(warning ? { warning } : {})
  }
}

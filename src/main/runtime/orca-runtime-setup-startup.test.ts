/* eslint-disable max-lines -- Why: split slice of the runtime behavior suite; mocks are duplicated per file because vi.mock is file-scoped */
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import {
  TEST_REPO_ID,
  UUID_RE,
  computeWorktreePathMock,
  detectInstalledAgentsWithShellPathHydrationMock,
  detectRemoteAgentsMock,
  ensurePathWithinWorkspaceMock,
  expectStablePaneKeyEnv,
  getActiveMultiplexerMock,
  isOriginMainBaseRefProbe,
  makeWorktreeMeta,
  muxRequestMock,
  resetRuntimeTestMocks,
  setPlatform,
  store
} from './orca-runtime-test-fixture'
import { OrcaRuntimeService } from './orca-runtime'
import {
  SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV,
  SETUP_AGENT_SEQUENCE_STARTUP_SCRIPT_ENV
} from '../../shared/setup-agent-sequencing'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import { getDefaultTabsLaunch, shouldRunSetupForCreate } from '../effective-hook-config'
import { addWorktree, listWorktrees } from '../git/worktree'
import { getEffectiveHooks, runHook } from '../hooks'
import {
  registerSshFilesystemProvider,
  unregisterSshFilesystemProvider
} from '../providers/ssh-filesystem-dispatch'
import { registerSshGitProvider, unregisterSshGitProvider } from '../providers/ssh-git-dispatch'
import { createSetupRunnerScript, resolveSetupRunnerShell } from '../worktree-runner-script'

beforeEach(resetRuntimeTestMocks)
afterEach(resetRuntimeTestMocks)

describe('OrcaRuntimeService', () => {
  it('returns a setup launch payload for CLI-created worktrees when hooks are explicitly enabled', async () => {
    const runtime = new OrcaRuntimeService(store)
    const activateWorktree = vi.fn()
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree,
      createTerminal: vi.fn(),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-hook-test')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-hook-test')
    vi.mocked(getEffectiveHooks).mockReturnValue({
      scripts: {
        setup: 'pnpm worktree:setup'
      }
    })
    vi.mocked(createSetupRunnerScript).mockReturnValue({
      runnerScriptPath: '/tmp/repo/.git/orca/setup-runner.sh',
      envVars: {
        ORCA_ROOT_PATH: '/tmp/repo',
        ORCA_WORKTREE_PATH: '/tmp/workspaces/runtime-hook-test'
      }
    })
    vi.mocked(listWorktrees).mockResolvedValueOnce([
      {
        path: '/tmp/workspaces/runtime-hook-test',
        head: 'def',
        branch: 'runtime-hook-test',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-hook-test',
      runHooks: true
    })

    expect(createSetupRunnerScript).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'repo-1', path: '/tmp/repo' }),
      '/tmp/workspaces/runtime-hook-test',
      'pnpm worktree:setup',
      undefined,
      undefined,
      undefined
    )
    expect(runHook).not.toHaveBeenCalled()
    expect(addWorktree).toHaveBeenCalledWith(
      '/tmp/repo',
      '/tmp/workspaces/runtime-hook-test',
      'runtime-hook-test',
      'origin/main',
      false
    )
    expect(result).toEqual({
      worktree: expect.objectContaining({
        repoId: 'repo-1',
        path: '/tmp/workspaces/runtime-hook-test',
        branch: 'runtime-hook-test'
      }),
      setup: {
        runnerScriptPath: '/tmp/repo/.git/orca/setup-runner.sh',
        envVars: {
          ORCA_ROOT_PATH: '/tmp/repo',
          ORCA_WORKTREE_PATH: '/tmp/workspaces/runtime-hook-test'
        }
      }
    })
    expect(activateWorktree).toHaveBeenCalledWith(
      'repo-1',
      expect.any(String),
      result.setup,
      undefined,
      undefined
    )
  })

  it('passes setup payloads through when explicitly activating CLI-created worktrees', async () => {
    const runtime = new OrcaRuntimeService(store)
    const activateWorktree = vi.fn()
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree,
      createTerminal: vi.fn(),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-hook-activate')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-hook-activate')
    vi.mocked(getEffectiveHooks).mockReturnValue({
      scripts: {
        setup: 'pnpm worktree:setup'
      }
    })
    vi.mocked(createSetupRunnerScript).mockReturnValue({
      runnerScriptPath: '/tmp/repo/.git/orca/setup-runner.sh',
      envVars: {
        ORCA_ROOT_PATH: '/tmp/repo',
        ORCA_WORKTREE_PATH: '/tmp/workspaces/runtime-hook-activate'
      }
    })
    vi.mocked(listWorktrees).mockResolvedValueOnce([
      {
        path: '/tmp/workspaces/runtime-hook-activate',
        head: 'def',
        branch: 'runtime-hook-activate',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-hook-activate',
      runHooks: true,
      activate: true
    })

    expect(activateWorktree).toHaveBeenCalledWith(
      'repo-1',
      expect.any(String),
      result.setup,
      undefined,
      undefined
    )
  })

  it('passes the selected Windows setup shell into runtime runner generation', async () => {
    setPlatform('win32')
    const runtimeStore = {
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        terminalWindowsShell: 'git-bash'
      })
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const activateWorktree = vi.fn()
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree,
      createTerminal: vi.fn(),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    computeWorktreePathMock.mockReturnValue('C:\\workspaces\\runtime-hook-activate')
    ensurePathWithinWorkspaceMock.mockReturnValue('C:\\workspaces\\runtime-hook-activate')
    vi.mocked(getEffectiveHooks).mockReturnValue({
      scripts: {
        setup: 'pnpm worktree:setup'
      }
    })
    vi.mocked(resolveSetupRunnerShell).mockReturnValue({ family: 'posix' })
    vi.mocked(createSetupRunnerScript).mockReturnValue({
      runnerScriptPath: 'C:\\repo\\.git\\orca\\setup-runner.sh',
      shell: { family: 'posix' },
      envVars: {
        ORCA_ROOT_PATH: 'C:\\repo',
        ORCA_WORKTREE_PATH: 'C:\\workspaces\\runtime-hook-activate'
      }
    })
    vi.mocked(listWorktrees).mockResolvedValueOnce([
      {
        path: 'C:/workspaces/runtime-hook-activate',
        head: 'def',
        branch: 'runtime-hook-activate',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-hook-activate',
      runHooks: true,
      activate: true
    })

    expect(createSetupRunnerScript).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'repo-1', path: '/tmp/repo' }),
      'C:\\workspaces\\runtime-hook-activate',
      'pnpm worktree:setup',
      undefined,
      { family: 'posix' },
      undefined
    )
    expect(result.setup).toMatchObject({
      runnerScriptPath: 'C:\\repo\\.git\\orca\\setup-runner.sh',
      shell: { family: 'posix' }
    })
    expect(activateWorktree).toHaveBeenCalledWith(
      'repo-1',
      expect.any(String),
      result.setup,
      undefined,
      undefined
    )
  })

  it('follows normal setup policy for CLI-created worktrees without activating them', async () => {
    const runtime = new OrcaRuntimeService(store)
    const activateWorktree = vi.fn()
    const revealTerminalSession = vi.fn().mockResolvedValue({ tabId: 'tab-created-worktree' })
    const spawn = vi
      .fn()
      .mockResolvedValueOnce({ id: 'pty-primary' })
      .mockResolvedValueOnce({ id: 'pty-setup' })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree,
      createTerminal: vi.fn(),
      revealTerminalSession,
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-hook-skip')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-hook-skip')
    vi.mocked(getEffectiveHooks).mockReturnValue({
      scripts: {
        setup: 'pnpm worktree:setup'
      }
    })
    vi.mocked(shouldRunSetupForCreate).mockReturnValue(true)
    vi.mocked(createSetupRunnerScript).mockReturnValue({
      runnerScriptPath: '/tmp/repo/.git/orca/setup-runner.sh',
      envVars: {
        ORCA_ROOT_PATH: '/tmp/repo',
        ORCA_WORKTREE_PATH: '/tmp/workspaces/runtime-hook-skip'
      }
    })
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: '/tmp/workspaces/runtime-hook-skip',
        head: 'def',
        branch: 'runtime-hook-skip',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-hook-skip'
    })

    expect(createSetupRunnerScript).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'repo-1', path: '/tmp/repo' }),
      '/tmp/workspaces/runtime-hook-skip',
      'pnpm worktree:setup',
      undefined,
      undefined,
      undefined
    )
    expect(runHook).not.toHaveBeenCalled()
    expect(result).toEqual({
      worktree: expect.objectContaining({
        repoId: 'repo-1',
        path: '/tmp/workspaces/runtime-hook-skip',
        branch: 'runtime-hook-skip'
      })
    })
    expect(result.setup).toBeUndefined()
    expect(activateWorktree).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2))
    expect(spawn).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        cwd: '/tmp/workspaces/runtime-hook-skip',
        command: undefined,
        worktreeId: result.worktree.id
      })
    )
    expect(spawn).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        cwd: '/tmp/workspaces/runtime-hook-skip',
        command: 'bash /tmp/repo/.git/orca/setup-runner.sh',
        // Why: createTerminal stamps ORCA_PANE_KEY/TAB_ID/WORKTREE_ID so hook-based agent status can attribute events to a stable pane.
        env: expect.objectContaining({
          ORCA_ROOT_PATH: '/tmp/repo',
          ORCA_WORKTREE_PATH: '/tmp/workspaces/runtime-hook-skip',
          ORCA_TAB_ID: expect.stringMatching(UUID_RE),
          ORCA_PANE_KEY: expect.any(String),
          ORCA_WORKTREE_ID: result.worktree.id
        }),
        worktreeId: result.worktree.id
      })
    )
    const setupSpawnEnv =
      (spawn.mock.calls[1]?.[0] as { env?: Record<string, string> } | undefined)?.env ?? {}
    expectStablePaneKeyEnv(setupSpawnEnv)
    const setupLeafId = setupSpawnEnv.ORCA_PANE_KEY.slice(`${setupSpawnEnv.ORCA_TAB_ID}:`.length)
    // Why: a background CLI create adopts its tabs silently — surfaceOwner:false
    // keeps the sidebar from scrolling to a workspace the user never asked for.
    expect(revealTerminalSession).toHaveBeenLastCalledWith(result.worktree.id, {
      ptyId: 'pty-setup',
      title: 'Setup',
      activate: false,
      surfaceOwner: false,
      tabId: setupSpawnEnv.ORCA_TAB_ID,
      leafId: setupLeafId
    })
  })

  it('uses returned WSL setup shell metadata when runtime spawns setup', async () => {
    setPlatform('win32')
    const runtime = new OrcaRuntimeService(store)
    const revealTerminalSession = vi.fn().mockResolvedValue({ tabId: 'tab-created-worktree' })
    const spawn = vi
      .fn()
      .mockResolvedValueOnce({ id: 'pty-primary' })
      .mockResolvedValueOnce({ id: 'pty-setup' })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession,
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    computeWorktreePathMock.mockReturnValue('C:\\workspaces\\runtime-hook-wsl')
    ensurePathWithinWorkspaceMock.mockReturnValue('C:\\workspaces\\runtime-hook-wsl')
    vi.mocked(getEffectiveHooks).mockReturnValue({
      scripts: {
        setup: 'pnpm worktree:setup'
      }
    })
    vi.mocked(shouldRunSetupForCreate).mockReturnValue(true)
    vi.mocked(createSetupRunnerScript).mockReturnValue({
      runnerScriptPath: 'C:\\repo\\.git\\orca\\setup-runner.sh',
      shell: { family: 'posix', executable: 'wsl.exe' },
      envVars: {
        ORCA_ROOT_PATH: 'C:\\repo',
        ORCA_WORKTREE_PATH: 'C:\\workspaces\\runtime-hook-wsl'
      }
    })
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: 'C:/workspaces/runtime-hook-wsl',
        head: 'def',
        branch: 'runtime-hook-wsl',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-hook-wsl'
    })

    expect(result.setup).toBeUndefined()
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2))
    expect(spawn).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        command: 'bash /mnt/c/repo/.git/orca/setup-runner.sh',
        env: expect.objectContaining({
          ORCA_ROOT_PATH: 'C:\\repo',
          ORCA_WORKTREE_PATH: 'C:\\workspaces\\runtime-hook-wsl',
          ORCA_TAB_ID: expect.stringMatching(UUID_RE),
          ORCA_PANE_KEY: expect.any(String),
          ORCA_WORKTREE_ID: result.worktree.id
        }),
        worktreeId: result.worktree.id
      })
    )
  })

  it('uses the shell-aware setup runner for windowless creates without a startup command', async () => {
    // Regression (C1): with no authoritative window and no startup command the
    // create fell back to runHook, which hardcodes cmd.exe on Windows and so ran
    // batch even when the configured terminal resolves to Git Bash.
    setPlatform('win32')
    const runtime = new OrcaRuntimeService(store)
    const revealTerminalSession = vi.fn().mockResolvedValue({ tabId: 'tab-windowless' })
    const spawn = vi
      .fn()
      .mockResolvedValueOnce({ id: 'pty-primary' })
      .mockResolvedValueOnce({ id: 'pty-setup' })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession,
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    // Deliberately no attachWindow: this is the windowless/CLI create path.

    computeWorktreePathMock.mockReturnValue('C:\\workspaces\\runtime-hook-windowless')
    ensurePathWithinWorkspaceMock.mockReturnValue('C:\\workspaces\\runtime-hook-windowless')
    vi.mocked(getEffectiveHooks).mockReturnValue({
      scripts: {
        setup: 'pnpm worktree:setup'
      }
    })
    vi.mocked(shouldRunSetupForCreate).mockReturnValue(true)
    vi.mocked(resolveSetupRunnerShell).mockReturnValue({ family: 'posix' })
    vi.mocked(createSetupRunnerScript).mockReturnValue({
      runnerScriptPath: 'C:\\repo\\.git\\orca\\setup-runner.sh',
      shell: { family: 'posix' },
      envVars: {
        ORCA_ROOT_PATH: 'C:\\repo',
        ORCA_WORKTREE_PATH: 'C:\\workspaces\\runtime-hook-windowless'
      }
    })
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: 'C:/workspaces/runtime-hook-windowless',
        head: 'def',
        branch: 'runtime-hook-windowless',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-hook-windowless',
      awaitTerminalProvisioning: true
    })

    expect(createSetupRunnerScript).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'repo-1' }),
      'C:\\workspaces\\runtime-hook-windowless',
      'pnpm worktree:setup',
      undefined,
      { family: 'posix' },
      undefined
    )
    expect(runHook).not.toHaveBeenCalled()
    expect(result.setupReceipt).toMatchObject({ state: 'running' })
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2))
    expect(spawn).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        command: 'bash /c/repo/.git/orca/setup-runner.sh',
        worktreeId: result.worktree.id
      })
    )
  })

  it('reports the in-process setup hook as running when nothing can launch the runner', async () => {
    // Regression (C1): the fire-and-forget hook is the last resort when there is
    // no PTY controller; reporting spawn_failed made callers retry a live hook.
    const runtime = new OrcaRuntimeService(store)
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-hook-no-pty')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-hook-no-pty')
    vi.mocked(getEffectiveHooks).mockReturnValue({
      scripts: {
        setup: 'pnpm worktree:setup'
      }
    })
    vi.mocked(shouldRunSetupForCreate).mockReturnValue(true)
    vi.mocked(runHook).mockResolvedValue({ success: true, output: '' })
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: '/tmp/workspaces/runtime-hook-no-pty',
        head: 'def',
        branch: 'runtime-hook-no-pty',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-hook-no-pty',
      awaitTerminalProvisioning: true
    })

    expect(createSetupRunnerScript).not.toHaveBeenCalled()
    expect(runHook).toHaveBeenCalledWith(
      'setup',
      '/tmp/workspaces/runtime-hook-no-pty',
      expect.objectContaining({ id: 'repo-1' }),
      '/tmp/workspaces/runtime-hook-no-pty',
      undefined
    )
    expect(result.setupReceipt).toMatchObject({ state: 'running' })
  })

  it('sequences setup before startup for opted-in local headless worktree creates', async () => {
    const waitRepo = {
      ...store.getRepo('repo-1')!,
      hookSettings: {
        mode: 'auto' as const,
        setupRunPolicy: 'run-by-default' as const,
        setupAgentStartupPolicy: 'wait-for-setup' as const,
        scripts: { setup: '', archive: '' }
      }
    }
    const runtimeStore = {
      ...store,
      getRepos: () => [waitRepo],
      getRepo: (id: string) => (id === 'repo-1' ? waitRepo : undefined)
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const createTerminal = vi.spyOn(runtime, 'createTerminal')
    const revealTerminalSession = vi.fn().mockResolvedValue({ tabId: 'tab-headless-startup' })
    const spawn = vi
      .fn()
      .mockResolvedValueOnce({ id: 'pty-headless-startup' })
      .mockResolvedValueOnce({ id: 'pty-headless-setup' })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession,
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-headless-startup-setup')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-headless-startup-setup')
    vi.mocked(getEffectiveHooks).mockReturnValue({
      scripts: {
        setup: 'pnpm worktree:setup'
      }
    })
    vi.mocked(shouldRunSetupForCreate).mockReturnValue(true)
    vi.mocked(createSetupRunnerScript).mockReturnValue({
      runnerScriptPath: 'C:\\tmp\\repo\\.git\\orca\\setup-runner.sh',
      shell: { family: 'posix', executable: 'wsl.exe' },
      envVars: {
        ORCA_ROOT_PATH: '/tmp/repo',
        ORCA_WORKTREE_PATH: '/tmp/workspaces/runtime-headless-startup-setup'
      },
      waitForAgentStartup: true
    })
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: '/tmp/workspaces/runtime-headless-startup-setup',
        head: 'def',
        branch: 'runtime-headless-startup-setup',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-headless-startup-setup',
      setupDecision: 'run',
      startup: { command: 'claude', viewMode: 'chat' }
    })

    expect(createSetupRunnerScript).toHaveBeenCalled()
    expect(runHook).not.toHaveBeenCalled()
    expect(createTerminal).toHaveBeenCalledWith(
      `id:${result.worktree.id}`,
      expect.objectContaining({ viewMode: 'chat' })
    )
    // Why: setup is provisioned fire-and-forget; the wait-for-setup guarantee comes from the shell nonce/marker, not JS spawn ordering.
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2))
    const startup = spawn.mock.calls[0]![0] as {
      command: string
      env: Record<string, string>
    }
    const startupCommand = startup.command
    const startupScript = startup.env[SETUP_AGENT_SEQUENCE_STARTUP_SCRIPT_ENV]!
    const setupCommand = (spawn.mock.calls[1]![0] as { command: string }).command
    const nonceMatch = startupScript.match(/if \[ "\$seen" = ([0-9a-f-]+) \]/)
    expect(nonceMatch?.[1]).toBeTruthy()
    expect(startupCommand.length).toBeLessThan(256)
    expect(startupScript).toContain('exec claude')
    expect(startupScript).toContain('/mnt/c/tmp/repo/.git/orca/setup-runner.sh')
    expect(setupCommand).toContain('bash /mnt/c/tmp/repo/.git/orca/setup-runner.sh')
    expect(setupCommand).toContain('printf')
    expect(setupCommand).toContain(`${nonceMatch![1]} "$status"`)
    expect(result.setup).toBeUndefined()
  })

  it('starts setup and startup side by side by default for local headless worktree creates', async () => {
    const runtime = new OrcaRuntimeService(store)
    const revealTerminalSession = vi.fn().mockResolvedValue({ tabId: 'tab-headless-parallel' })
    const spawn = vi
      .fn()
      .mockResolvedValueOnce({ id: 'pty-headless-parallel-startup' })
      .mockResolvedValueOnce({ id: 'pty-headless-parallel-setup' })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession,
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-headless-parallel')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-headless-parallel')
    vi.mocked(getEffectiveHooks).mockReturnValue({
      scripts: {
        setup: 'pnpm worktree:setup'
      }
    })
    vi.mocked(shouldRunSetupForCreate).mockReturnValue(true)
    vi.mocked(createSetupRunnerScript).mockReturnValue({
      runnerScriptPath: '/tmp/repo/.git/orca/setup-runner.sh',
      envVars: {
        ORCA_ROOT_PATH: '/tmp/repo',
        ORCA_WORKTREE_PATH: '/tmp/workspaces/runtime-headless-parallel'
      }
    })
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: '/tmp/workspaces/runtime-headless-parallel',
        head: 'def',
        branch: 'runtime-headless-parallel',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-headless-parallel',
      setupDecision: 'run',
      startup: { command: 'claude' },
      observeSetupCompletion: true,
      awaitTerminalProvisioning: true
    })

    // Why: setup now spawns fire-and-forget on a later tick; wait for both PTYs.
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2))
    expect(spawn).toHaveBeenNthCalledWith(1, expect.objectContaining({ command: 'claude' }))
    expect(spawn).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        command: expect.stringContaining('__ORCA_SETUP_COMPLETE__:')
      })
    )
    expect(result.setupReceipt).toMatchObject({
      state: 'running',
      terminalHandle: expect.stringMatching(/^term_/)
    })
  })

  it('observes setup completion through the launch shell the runner was written for', async () => {
    const runtime = new OrcaRuntimeService(store)
    const revealTerminalSession = vi.fn().mockResolvedValue({ tabId: 'tab-observed-wsl-shell' })
    const spawn = vi
      .fn()
      .mockResolvedValueOnce({ id: 'pty-observed-wsl-startup' })
      .mockResolvedValueOnce({ id: 'pty-observed-wsl-setup' })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession,
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-observed-wsl-shell')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-observed-wsl-shell')
    vi.mocked(getEffectiveHooks).mockReturnValue({
      scripts: {
        setup: 'pnpm worktree:setup'
      }
    })
    vi.mocked(shouldRunSetupForCreate).mockReturnValue(true)
    vi.mocked(createSetupRunnerScript).mockReturnValue({
      runnerScriptPath: 'C:\\tmp\\repo\\.git\\orca\\setup-runner.sh',
      shell: { family: 'posix', executable: 'wsl.exe' },
      envVars: {
        ORCA_ROOT_PATH: '/tmp/repo',
        ORCA_WORKTREE_PATH: '/tmp/workspaces/runtime-observed-wsl-shell'
      }
    })
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: '/tmp/workspaces/runtime-observed-wsl-shell',
        head: 'def',
        branch: 'runtime-observed-wsl-shell',
        isBare: false,
        isMainWorktree: false
      }
    ])

    await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-observed-wsl-shell',
      setupDecision: 'run',
      startup: { command: 'claude' },
      observeSetupCompletion: true,
      awaitTerminalProvisioning: true
    })

    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2))
    const setupCommand = (spawn.mock.calls[1]![0] as { command: string }).command
    expect(setupCommand).toContain('bash /mnt/c/tmp/repo/.git/orca/setup-runner.sh')
    expect(setupCommand).toContain('__ORCA_SETUP_COMPLETE__:')
  })

  it('creates the first terminal for CLI-created worktrees without activating them', async () => {
    const runtime = new OrcaRuntimeService(store)
    const activateWorktree = vi.fn()
    const revealTerminalSession = vi.fn().mockResolvedValue({ tabId: 'tab-created-worktree' })
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-created-worktree' })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree,
      createTerminal: vi.fn(),
      revealTerminalSession,
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-initial-terminal')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-initial-terminal')
    vi.mocked(getEffectiveHooks).mockReturnValue(null)
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: '/tmp/workspaces/runtime-initial-terminal',
        head: 'def',
        branch: 'runtime-initial-terminal',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-initial-terminal'
    })

    expect(activateWorktree).not.toHaveBeenCalled()
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/tmp/workspaces/runtime-initial-terminal',
        worktreeId: result.worktree.id,
        preAllocatedHandle: expect.stringMatching(/^term_/)
      })
    )
    const initialSpawnEnv =
      (spawn.mock.calls[0]?.[0] as { env?: Record<string, string> } | undefined)?.env ?? {}
    expectStablePaneKeyEnv(initialSpawnEnv)
    const initialLeafId = initialSpawnEnv.ORCA_PANE_KEY.slice(
      `${initialSpawnEnv.ORCA_TAB_ID}:`.length
    )
    // Why: the renderer treats a missing surfaceOwner as "reveal the owner", which
    // scrolled the sidebar to background CLI creates.
    expect(revealTerminalSession).toHaveBeenCalledWith(result.worktree.id, {
      ptyId: 'pty-created-worktree',
      title: null,
      activate: false,
      surfaceOwner: false,
      tabId: initialSpawnEnv.ORCA_TAB_ID,
      leafId: initialLeafId
    })
  })

  it('does not surface the new workspace when a background CLI create launches its agent', async () => {
    const runtime = new OrcaRuntimeService(store)
    const activateWorktree = vi.fn()
    const revealTerminalSession = vi.fn().mockResolvedValue({ tabId: 'tab-background-agent' })
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-background-agent' })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree,
      createTerminal: vi.fn(),
      revealTerminalSession,
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-background-agent')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-background-agent')
    vi.mocked(getEffectiveHooks).mockReturnValue(null)
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: '/tmp/workspaces/runtime-background-agent',
        head: 'def',
        branch: 'runtime-background-agent',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-background-agent',
      createdWithAgent: 'claude',
      startup: { command: 'claude' }
    })

    // `orca worktree create --agent claude` without --activate: the agent tab is
    // adopted, but the sidebar must stay on whatever the user was reading.
    expect(activateWorktree).not.toHaveBeenCalled()
    expect(revealTerminalSession).toHaveBeenCalledWith(
      result.worktree.id,
      expect.objectContaining({
        ptyId: 'pty-background-agent',
        activate: false,
        surfaceOwner: false
      })
    )
  })

  it('still surfaces the new workspace when the caller explicitly activates it', async () => {
    const runtime = new OrcaRuntimeService(store)
    const revealTerminalSession = vi.fn().mockResolvedValue({ tabId: 'tab-activated-agent' })
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-activated-agent' })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession,
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-activated-agent')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-activated-agent')
    vi.mocked(getEffectiveHooks).mockReturnValue(null)
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: '/tmp/workspaces/runtime-activated-agent',
        head: 'def',
        branch: 'runtime-activated-agent',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-activated-agent',
      activate: true,
      createdWithAgent: 'claude',
      startup: { command: 'claude' }
    })

    // No-regression guard: an explicit --activate still reveals the workspace, so
    // surfaceOwner must stay absent.
    const revealPayload = revealTerminalSession.mock.calls[0]?.[1] as
      | { surfaceOwner?: boolean }
      | undefined
    expect(revealTerminalSession).toHaveBeenCalledWith(
      result.worktree.id,
      expect.objectContaining({ ptyId: 'pty-activated-agent' })
    )
    expect(revealPayload).not.toHaveProperty('surfaceOwner')
  })

  it('still surfaces the new workspace when hooks run in the foreground', async () => {
    const runtime = new OrcaRuntimeService(store)
    const revealTerminalSession = vi.fn().mockResolvedValue({ tabId: 'tab-hooks-agent' })
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-hooks-agent' })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession,
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-hooks-agent')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-hooks-agent')
    vi.mocked(getEffectiveHooks).mockReturnValue(null)
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: '/tmp/workspaces/runtime-hooks-agent',
        head: 'def',
        branch: 'runtime-hooks-agent',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-hooks-agent',
      runHooks: true,
      createdWithAgent: 'claude',
      startup: { command: 'claude' }
    })

    const revealPayload = revealTerminalSession.mock.calls[0]?.[1] as
      | { surfaceOwner?: boolean }
      | undefined
    expect(revealTerminalSession).toHaveBeenCalledWith(
      result.worktree.id,
      expect.objectContaining({ ptyId: 'pty-hooks-agent' })
    )
    expect(revealPayload).not.toHaveProperty('surfaceOwner')
  })

  it('honors split setup placement for CLI-created worktrees without startup agents', async () => {
    const runtimeStore = {
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        setupScriptLaunchMode: 'split-vertical' as const
      })
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const activateWorktree = vi.fn()
    const revealTerminalSession = vi.fn().mockResolvedValue({ tabId: 'tab-cli-setup-split' })
    const spawn = vi
      .fn()
      .mockResolvedValueOnce({ id: 'pty-cli-setup-main' })
      .mockResolvedValueOnce({ id: 'pty-cli-setup-setup' })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree,
      createTerminal: vi.fn(),
      revealTerminalSession,
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-cli-setup-split')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-cli-setup-split')
    vi.mocked(getEffectiveHooks).mockReturnValue({
      scripts: {
        setup: 'pnpm install'
      }
    })
    vi.mocked(shouldRunSetupForCreate).mockReturnValue(true)
    vi.mocked(createSetupRunnerScript).mockReturnValue({
      runnerScriptPath: '/tmp/repo/.git/orca/setup-runner.sh',
      envVars: {
        ORCA_ROOT_PATH: '/tmp/repo',
        ORCA_WORKTREE_PATH: '/tmp/workspaces/runtime-cli-setup-split'
      }
    })
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: '/tmp/workspaces/runtime-cli-setup-split',
        head: 'def',
        branch: 'runtime-cli-setup-split',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-cli-setup-split',
      setupDecision: 'run'
    })

    expect(activateWorktree).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2))
    const mainEnv = (spawn.mock.calls[0]![0] as { env?: Record<string, string> }).env ?? {}
    const setupEnv = (spawn.mock.calls[1]![0] as { env?: Record<string, string> }).env ?? {}
    expectStablePaneKeyEnv(mainEnv)
    expectStablePaneKeyEnv(setupEnv)
    expect(setupEnv.ORCA_TAB_ID).toBe(mainEnv.ORCA_TAB_ID)
    const mainLeafId = mainEnv.ORCA_PANE_KEY!.slice(`${mainEnv.ORCA_TAB_ID!}:`.length)
    expect(revealTerminalSession).toHaveBeenLastCalledWith(
      result.worktree.id,
      expect.objectContaining({
        ptyId: 'pty-cli-setup-setup',
        tabId: mainEnv.ORCA_TAB_ID,
        activate: false,
        splitFromLeafId: mainLeafId,
        splitDirection: 'vertical'
      })
    )
  })

  it('does not surface the new workspace when a background create splits its setup pane', async () => {
    const runtimeStore = {
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        setupScriptLaunchMode: 'split-horizontal' as const
      })
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const activateWorktree = vi.fn()
    const revealTerminalSession = vi.fn().mockResolvedValue({ tabId: 'tab-bg-setup-split' })
    const spawn = vi
      .fn()
      .mockResolvedValueOnce({ id: 'pty-bg-split-main' })
      .mockResolvedValueOnce({ id: 'pty-bg-split-setup' })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree,
      createTerminal: vi.fn(),
      revealTerminalSession,
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-bg-split-setup')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-bg-split-setup')
    vi.mocked(getEffectiveHooks).mockReturnValue({ scripts: { setup: 'pnpm install' } })
    vi.mocked(shouldRunSetupForCreate).mockReturnValue(true)
    vi.mocked(createSetupRunnerScript).mockReturnValue({
      runnerScriptPath: '/tmp/repo/.git/orca/setup-runner.sh',
      envVars: {
        ORCA_ROOT_PATH: '/tmp/repo',
        ORCA_WORKTREE_PATH: '/tmp/workspaces/runtime-bg-split-setup'
      }
    })
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: '/tmp/workspaces/runtime-bg-split-setup',
        head: 'def',
        branch: 'runtime-bg-split-setup',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-bg-split-setup',
      setupDecision: 'run'
    })

    // Split launch modes reach the renderer through splitTerminal, not
    // createTerminal — that path must suppress owner surfacing too.
    expect(activateWorktree).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2))
    const mainEnv = (spawn.mock.calls[0]![0] as { env?: Record<string, string> }).env ?? {}
    await vi.waitFor(() =>
      expect(revealTerminalSession).toHaveBeenLastCalledWith(
        result.worktree.id,
        expect.objectContaining({
          ptyId: 'pty-bg-split-setup',
          tabId: mainEnv.ORCA_TAB_ID,
          activate: false,
          surfaceOwner: false,
          splitDirection: 'horizontal'
        })
      )
    )
  })

  it('still surfaces the new workspace when an activating create splits its setup pane', async () => {
    const runtimeStore = {
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        setupScriptLaunchMode: 'split-horizontal' as const
      })
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const revealTerminalSession = vi.fn().mockResolvedValue({ tabId: 'tab-active-setup-split' })
    const spawn = vi
      .fn()
      .mockResolvedValueOnce({ id: 'pty-active-split-main' })
      .mockResolvedValueOnce({ id: 'pty-active-split-setup' })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession,
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-active-split-setup')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-active-split-setup')
    vi.mocked(getEffectiveHooks).mockReturnValue({ scripts: { setup: 'pnpm install' } })
    vi.mocked(shouldRunSetupForCreate).mockReturnValue(true)
    vi.mocked(createSetupRunnerScript).mockReturnValue({
      runnerScriptPath: '/tmp/repo/.git/orca/setup-runner.sh',
      envVars: {
        ORCA_ROOT_PATH: '/tmp/repo',
        ORCA_WORKTREE_PATH: '/tmp/workspaces/runtime-active-split-setup'
      }
    })
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: '/tmp/workspaces/runtime-active-split-setup',
        head: 'def',
        branch: 'runtime-active-split-setup',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-active-split-setup',
      activate: true,
      setupDecision: 'run',
      createdWithAgent: 'claude',
      startup: { command: 'claude' }
    })

    // No-regression guard: an explicit --activate still reveals the workspace.
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2))
    await vi.waitFor(() =>
      expect(revealTerminalSession).toHaveBeenLastCalledWith(
        result.worktree.id,
        expect.objectContaining({
          ptyId: 'pty-active-split-setup',
          splitDirection: 'horizontal'
        })
      )
    )
    const splitRevealPayload = revealTerminalSession.mock.lastCall?.[1] as
      | { surfaceOwner?: boolean }
      | undefined
    expect(splitRevealPayload).not.toHaveProperty('surfaceOwner')
  })

  it('does not warn when setup is explicitly skipped for CLI-created worktrees', async () => {
    const metaById: Record<string, WorktreeMeta> = {}
    const runtimeStore = {
      ...store,
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      }
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-cli-setup-skip' })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession: vi.fn().mockResolvedValue({ tabId: 'tab-cli-setup-skip' }),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-cli-setup-skip')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-cli-setup-skip')
    vi.mocked(getEffectiveHooks).mockReturnValue({
      scripts: { setup: 'pnpm worktree:setup' }
    })
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: '/tmp/workspaces/runtime-cli-setup-skip',
        head: 'def',
        branch: 'runtime-cli-setup-skip',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-cli-setup-skip',
      setupDecision: 'skip',
      awaitTerminalProvisioning: true
    })

    expect(result.warning).toBeUndefined()
    expect(result.setupReceipt).toMatchObject({ requested: 'skip', state: 'skipped' })
    expect(createSetupRunnerScript).not.toHaveBeenCalled()
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('materializes default tabs for inactive local managed worktree creates', async () => {
    const metaById: Record<string, WorktreeMeta> = {}
    const runtimeStore = {
      ...store,
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      }
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const spawn = vi
      .fn()
      .mockResolvedValueOnce({ id: 'pty-default-dev' })
      .mockResolvedValueOnce({ id: 'pty-default-test' })
    const revealTerminalSession = vi
      .fn()
      .mockResolvedValueOnce({ tabId: 'tab-default-dev' })
      .mockResolvedValueOnce({ tabId: 'tab-default-test' })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession,
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-default-tabs')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-default-tabs')
    vi.mocked(getDefaultTabsLaunch).mockReturnValue({
      runCommands: true,
      tabs: [
        { title: 'Dev', command: 'pnpm dev' },
        { title: 'Test', command: 'pnpm test' }
      ]
    })
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: '/tmp/workspaces/runtime-default-tabs',
        head: 'def',
        branch: 'runtime-default-tabs',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-default-tabs',
      setupDecision: 'run'
    })

    expect(result.defaultTabs).toEqual({
      runCommands: true,
      tabs: [
        { title: 'Dev', command: 'pnpm dev' },
        { title: 'Test', command: 'pnpm test' }
      ]
    })
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2))
    expect(spawn.mock.calls[0]![0]).toMatchObject({ command: 'pnpm dev' })
    expect(spawn.mock.calls[1]![0]).toMatchObject({ command: 'pnpm test' })
    expect(revealTerminalSession).toHaveBeenNthCalledWith(
      1,
      result.worktree.id,
      expect.objectContaining({ title: 'Dev', activate: false })
    )
    expect(revealTerminalSession).toHaveBeenNthCalledWith(
      2,
      result.worktree.id,
      expect.objectContaining({ title: 'Test', activate: false })
    )
  })

  it('uses desktop task agent selection and bracketed-pastes startup drafts for local worktrees', async () => {
    vi.useFakeTimers()
    onTestFinished(() => {
      vi.useRealTimers()
    })
    detectInstalledAgentsWithShellPathHydrationMock.mockResolvedValue(['claude'])
    const metaById: Record<string, WorktreeMeta> = {}
    const runtimeStore = {
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        defaultTuiAgent: 'codex' as const,
        agentCmdOverrides: { codex: 'codex --profile work' }
      }),
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      }
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-startup-draft' })
    const write = vi.fn().mockReturnValue(true)
    runtime.setPtyController({
      spawn,
      write,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession: vi.fn().mockResolvedValue({ tabId: 'tab-startup-draft' }),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-startup-draft')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-startup-draft')
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: '/tmp/workspaces/runtime-startup-draft',
        head: 'def',
        branch: 'runtime-startup-draft',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const draftUrl = 'https://github.com/stablyai/orca/issues/123'
    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-startup-draft',
      startupDraft: draftUrl,
      activate: true
    })

    expect(detectInstalledAgentsWithShellPathHydrationMock).not.toHaveBeenCalled()
    expect(detectRemoteAgentsMock).not.toHaveBeenCalled()
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/tmp/workspaces/runtime-startup-draft',
        command: "codex --profile work '--dangerously-bypass-approvals-and-sandbox'",
        worktreeId: result.worktree.id
      })
    )
    expect(metaById[result.worktree.id]).toMatchObject({ createdWithAgent: 'codex' })

    runtime.onPtyData('pty-startup-draft', '\x1b[?2004h', Date.now())
    await vi.advanceTimersByTimeAsync(10_000)
    expect(write).not.toHaveBeenCalled()

    runtime.onPtyData('pty-startup-draft', '›', Date.now())
    await Promise.resolve()
    await Promise.resolve()

    expect(write).toHaveBeenCalledWith('pty-startup-draft', `\x1b[200~${draftUrl}\x1b[201~`)
  })

  it('keeps the 8s main-runtime startup readiness budget for non-Codex agents', async () => {
    vi.useFakeTimers()
    onTestFinished(() => {
      vi.useRealTimers()
    })
    const runtimeStore = {
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        defaultTuiAgent: 'opencode' as const,
        agentCmdOverrides: {}
      })
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-opencode-draft-timeout' })
    const write = vi.fn().mockReturnValue(true)
    runtime.setPtyController({
      spawn,
      write,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession: vi.fn().mockResolvedValue({ tabId: 'tab-opencode-draft-timeout' }),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-opencode-draft-timeout')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-opencode-draft-timeout')
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: '/tmp/workspaces/runtime-opencode-draft-timeout',
        head: 'def',
        branch: 'runtime-opencode-draft-timeout',
        isBare: false,
        isMainWorktree: false
      }
    ])

    await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-opencode-draft-timeout',
      startupDraft: 'https://github.com/stablyai/orca/issues/456'
    })

    await vi.advanceTimersByTimeAsync(7999)
    expect(write).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    runtime.onPtyData('pty-opencode-draft-timeout', '\x1b[?2004h\x1b[?25h', Date.now())
    await Promise.resolve()
    await Promise.resolve()

    expect(write).not.toHaveBeenCalled()
  })

  it('rejects explicit startup commands for disabled selected agents', async () => {
    const runtimeStore = {
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        disabledTuiAgents: ['codex' as const]
      })
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-disabled-startup' })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    await expect(
      runtime.createManagedWorktree({
        repoSelector: TEST_REPO_ID,
        name: 'disabled-startup',
        startup: { command: 'codex' },
        createdWithAgent: 'codex'
      })
    ).rejects.toThrow('Selected agent is disabled. Choose an enabled agent before creating.')

    expect(spawn).not.toHaveBeenCalled()
    expect(addWorktree).not.toHaveBeenCalled()
  })

  it('launches explicit startup agents with prompts for CLI-created worktrees', async () => {
    const metaById: Record<string, WorktreeMeta> = {}
    const runtimeStore = {
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        agentCmdOverrides: {}
      }),
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      }
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-cli-agent-startup' })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession: vi.fn().mockResolvedValue({ tabId: 'tab-cli-agent-startup' }),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-cli-agent-startup')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-cli-agent-startup')
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: '/tmp/workspaces/runtime-cli-agent-startup',
        head: 'def',
        branch: 'runtime-cli-agent-startup',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await runtime.createManagedWorktree({
      repoSelector: TEST_REPO_ID,
      name: 'runtime-cli-agent-startup',
      startupAgent: 'codex',
      startupPrompt: 'hi'
    })

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/tmp/workspaces/runtime-cli-agent-startup',
        command: "codex '--dangerously-bypass-approvals-and-sandbox' 'hi'",
        worktreeId: result.worktree.id
      })
    )
    expect(metaById[result.worktree.id]).toMatchObject({ createdWithAgent: 'codex' })
  })

  it('sends follow-up prompts for CLI-created stdin-after-start startup agents', async () => {
    const metaById: Record<string, WorktreeMeta> = {}
    const runtimeStore = {
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        agentCmdOverrides: {}
      }),
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      }
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-cli-aider-startup' })
    const write = vi.fn().mockReturnValue(true)
    runtime.setPtyController({
      spawn,
      write,
      kill: () => true,
      getForegroundProcess: async () => 'aider'
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession: vi.fn().mockResolvedValue({ tabId: 'tab-cli-aider-startup' }),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-cli-aider-startup')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-cli-aider-startup')
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: '/tmp/workspaces/runtime-cli-aider-startup',
        head: 'def',
        branch: 'runtime-cli-aider-startup',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await runtime.createManagedWorktree({
      repoSelector: TEST_REPO_ID,
      name: 'runtime-cli-aider-startup',
      startupAgent: 'aider',
      startupPrompt: 'fix it'
    })

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/tmp/workspaces/runtime-cli-aider-startup',
        command: "aider '--yes-always'",
        worktreeId: result.worktree.id
      })
    )
    await vi.waitFor(() => {
      expect(write).toHaveBeenCalledWith('pty-cli-aider-startup', 'fix it\r')
    })
  })

  it('does not send stdin-after-start prompts into a shell when the agent never starts', async () => {
    vi.useFakeTimers()
    try {
      const metaById: Record<string, WorktreeMeta> = {}
      const runtimeStore = {
        ...store,
        getSettings: () => ({
          ...store.getSettings(),
          agentCmdOverrides: {}
        }),
        getAllWorktreeMeta: () => metaById,
        getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
        setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
          metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
          return metaById[worktreeId]
        }
      }
      const runtime = new OrcaRuntimeService(runtimeStore as never)
      const write = vi.fn().mockReturnValue(true)
      runtime.setPtyController({
        spawn: vi.fn().mockResolvedValue({ id: 'pty-cli-aider-shell' }),
        write,
        kill: () => true,
        getForegroundProcess: async () => 'zsh',
        hasChildProcesses: vi.fn().mockResolvedValue(false)
      })
      runtime.setNotifier({
        worktreesChanged: vi.fn(),
        reposChanged: vi.fn(),
        activateWorktree: vi.fn(),
        createTerminal: vi.fn(),
        revealTerminalSession: vi.fn().mockResolvedValue({ tabId: 'tab-cli-aider-shell' }),
        splitTerminal: vi.fn(),
        renameTerminal: vi.fn(),
        focusTerminal: vi.fn(),
        closeTerminal: vi.fn(),
        sleepWorktree: vi.fn(),
        terminalFitOverrideChanged: vi.fn(),
        terminalDriverChanged: vi.fn()
      })
      runtime.attachWindow(1)

      computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-cli-aider-shell')
      ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-cli-aider-shell')
      vi.mocked(listWorktrees).mockResolvedValue([
        {
          path: '/tmp/workspaces/runtime-cli-aider-shell',
          head: 'def',
          branch: 'runtime-cli-aider-shell',
          isBare: false,
          isMainWorktree: false
        }
      ])

      await runtime.createManagedWorktree({
        repoSelector: TEST_REPO_ID,
        name: 'runtime-cli-aider-shell',
        startupAgent: 'aider',
        startupPrompt: 'fix it'
      })

      await vi.advanceTimersByTimeAsync(6000)

      expect(write).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('records the resolved fallback agent when the requested startup draft agent is disabled', async () => {
    detectInstalledAgentsWithShellPathHydrationMock.mockResolvedValue(['claude'])
    const metaById: Record<string, WorktreeMeta> = {}
    const runtimeStore = {
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        defaultTuiAgent: 'codex' as const,
        disabledTuiAgents: ['codex' as const],
        agentCmdOverrides: {}
      }),
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      }
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-fallback-draft' })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession: vi.fn().mockResolvedValue({ tabId: 'tab-fallback-draft' }),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-fallback-draft')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-fallback-draft')
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: '/tmp/workspaces/runtime-fallback-draft',
        head: 'def',
        branch: 'runtime-fallback-draft',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await runtime.createManagedWorktree({
      repoSelector: TEST_REPO_ID,
      name: 'runtime-fallback-draft',
      startupDraft: 'https://github.com/stablyai/orca/issues/456',
      createdWithAgent: 'codex',
      activate: true
    })

    expect(detectInstalledAgentsWithShellPathHydrationMock).toHaveBeenCalled()
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/tmp/workspaces/runtime-fallback-draft',
        command: expect.stringContaining('claude'),
        worktreeId: result.worktree.id
      })
    )
    expect(metaById[result.worktree.id]).toMatchObject({ createdWithAgent: 'claude' })
  })

  it('honors split setup placement for opted-in local startup-draft worktrees', async () => {
    const metaById: Record<string, WorktreeMeta> = {}
    const runtimeStore = {
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        defaultTuiAgent: 'codex' as const,
        setupScriptLaunchMode: 'split-vertical' as const
      }),
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      }
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const spawn = vi
      .fn()
      .mockResolvedValueOnce({ id: 'pty-startup-split-main' })
      .mockResolvedValueOnce({ id: 'pty-startup-split-setup' })
    const revealTerminalSession = vi.fn().mockResolvedValue({ tabId: 'tab-startup-split' })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession,
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-startup-setup-split')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-startup-setup-split')
    vi.mocked(getEffectiveHooks).mockReturnValue({
      scripts: {
        setup: 'pnpm worktree:setup'
      }
    })
    vi.mocked(shouldRunSetupForCreate).mockReturnValue(true)
    vi.mocked(createSetupRunnerScript).mockReturnValue({
      runnerScriptPath: '/tmp/repo/.git/orca/setup-runner.sh',
      envVars: {
        ORCA_ROOT_PATH: '/tmp/repo',
        ORCA_WORKTREE_PATH: '/tmp/workspaces/runtime-startup-setup-split'
      },
      waitForAgentStartup: true
    })
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: '/tmp/workspaces/runtime-startup-setup-split',
        head: 'def',
        branch: 'runtime-startup-setup-split',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-startup-setup-split',
      startupDraft: 'https://github.com/stablyai/orca/issues/123',
      setupDecision: 'run',
      activate: true,
      awaitTerminalProvisioning: true
    })

    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2))
    expect(spawn).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        cwd: '/tmp/workspaces/runtime-startup-setup-split',
        env: expect.objectContaining({
          [SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV]: expect.stringContaining('codex')
        }),
        worktreeId: result.worktree.id
      })
    )
    expect(spawn).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        cwd: '/tmp/workspaces/runtime-startup-setup-split',
        command: expect.stringContaining('bash /tmp/repo/.git/orca/setup-runner.sh'),
        env: expect.objectContaining({
          ORCA_ROOT_PATH: '/tmp/repo',
          ORCA_WORKTREE_PATH: '/tmp/workspaces/runtime-startup-setup-split',
          ORCA_WORKTREE_ID: result.worktree.id
        }),
        worktreeId: result.worktree.id
      })
    )
    const startup = spawn.mock.calls[0]![0] as {
      command: string
      env: Record<string, string>
    }
    const startupCommand = startup.command
    const startupScript = startup.env[SETUP_AGENT_SEQUENCE_STARTUP_SCRIPT_ENV]!
    const setupCommand = (spawn.mock.calls[1]![0] as { command: string }).command
    const nonceMatch = startupScript.match(/if \[ "\$seen" = ([0-9a-f-]+) \]/)
    expect(nonceMatch?.[1]).toBeTruthy()
    const markerPath = `/tmp/repo/.git/orca/setup-runner.sh.${nonceMatch![1]}.done`
    expect(startupCommand.length).toBeLessThan(256)
    expect(startupScript).toContain('--dangerously-bypass-approvals-and-sandbox')
    expect(setupCommand).toContain('printf')
    expect(setupCommand).toContain(`${nonceMatch![1]} "$status"`)
    expect(startupScript).toContain(markerPath)
    expect(setupCommand).toContain(markerPath)
    const mainEnv = (spawn.mock.calls[0]![0] as { env?: Record<string, string> }).env ?? {}
    const setupEnv = (spawn.mock.calls[1]![0] as { env?: Record<string, string> }).env ?? {}
    expect(result.setup).toBeUndefined()
    expect(result.setupReceipt).toMatchObject({
      state: 'running',
      terminalHandle: expect.stringMatching(/^term_/)
    })
    expect(mainEnv.ORCA_TAB_ID).toBeDefined()
    expect(mainEnv.ORCA_PANE_KEY).toBeDefined()
    expect(setupEnv.ORCA_TAB_ID).toBe(mainEnv.ORCA_TAB_ID)
    const mainLeafId = mainEnv.ORCA_PANE_KEY!.slice(`${mainEnv.ORCA_TAB_ID!}:`.length)
    expect(revealTerminalSession).toHaveBeenLastCalledWith(
      result.worktree.id,
      expect.objectContaining({
        ptyId: 'pty-startup-split-setup',
        tabId: mainEnv.ORCA_TAB_ID,
        activate: false,
        splitFromLeafId: mainLeafId,
        splitDirection: 'vertical'
      })
    )
  })

  it('passes the wrapped setup command to activation when startup spawned but setup did not', async () => {
    const runtime = new OrcaRuntimeService(store)
    const spawn = vi
      .fn()
      .mockResolvedValueOnce({ id: 'pty-startup-main' })
      .mockRejectedValueOnce(new Error('setup spawn failed'))
    const activateWorktree = vi.fn()
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree,
      createTerminal: vi.fn(),
      revealTerminalSession: vi.fn().mockResolvedValue({ tabId: 'tab-startup-main' }),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-startup-setup-retry')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-startup-setup-retry')
    vi.mocked(getEffectiveHooks).mockReturnValue({
      scripts: {
        setup: 'pnpm worktree:setup'
      }
    })
    vi.mocked(shouldRunSetupForCreate).mockReturnValue(true)
    vi.mocked(createSetupRunnerScript).mockReturnValue({
      runnerScriptPath: 'C:\\tmp\\repo\\.git\\orca\\setup-runner.sh',
      shell: { family: 'posix', executable: 'wsl.exe' },
      envVars: {
        ORCA_ROOT_PATH: '/tmp/repo',
        ORCA_WORKTREE_PATH: '/tmp/workspaces/runtime-startup-setup-retry'
      },
      waitForAgentStartup: true
    })
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: '/tmp/workspaces/runtime-startup-setup-retry',
        head: 'def',
        branch: 'runtime-startup-setup-retry',
        isBare: false,
        isMainWorktree: false
      }
    ])

    await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-startup-setup-retry',
      setupDecision: 'run',
      activate: true,
      startup: { command: 'claude' }
    })

    expect(spawn).toHaveBeenCalledTimes(2)
    expect(activateWorktree).toHaveBeenCalledWith(
      'repo-1',
      expect.any(String),
      expect.objectContaining({
        runnerScriptPath: 'C:\\tmp\\repo\\.git\\orca\\setup-runner.sh',
        command: expect.stringContaining('bash /mnt/c/tmp/repo/.git/orca/setup-runner.sh')
      }),
      undefined,
      undefined
    )
    const activationSetup = activateWorktree.mock.calls[0]?.[2] as { command?: string } | undefined
    expect(activationSetup?.command).toContain('printf')
  })

  it('lets explicit startup draft agents override the desktop default', async () => {
    detectInstalledAgentsWithShellPathHydrationMock.mockResolvedValue([])
    const metaById: Record<string, WorktreeMeta> = {}
    const runtimeStore = {
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        defaultTuiAgent: 'claude' as const,
        agentCmdOverrides: {}
      }),
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      }
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-explicit-draft' })
    const write = vi.fn().mockReturnValue(true)
    runtime.setPtyController({
      spawn,
      write,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession: vi.fn().mockResolvedValue({ tabId: 'tab-explicit-draft' }),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-explicit-draft')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-explicit-draft')
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: '/tmp/workspaces/runtime-explicit-draft',
        head: 'def',
        branch: 'runtime-explicit-draft',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const draftUrl = 'https://github.com/stablyai/orca/issues/789'
    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-explicit-draft',
      startupDraft: draftUrl,
      createdWithAgent: 'codex',
      activate: true
    })

    expect(detectInstalledAgentsWithShellPathHydrationMock).not.toHaveBeenCalled()
    expect(detectRemoteAgentsMock).not.toHaveBeenCalled()
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/tmp/workspaces/runtime-explicit-draft',
        command: "codex '--dangerously-bypass-approvals-and-sandbox'",
        worktreeId: result.worktree.id
      })
    )
    expect(metaById[result.worktree.id]).toMatchObject({ createdWithAgent: 'codex' })

    runtime.onPtyData('pty-explicit-draft', '\x1b[?2004h›', Date.now())
    await vi.waitFor(() => {
      expect(write).toHaveBeenCalledWith('pty-explicit-draft', `\x1b[200~${draftUrl}\x1b[201~`)
    })
  })

  it('does not auto-launch an agent for startup drafts when the default is blank', async () => {
    detectInstalledAgentsWithShellPathHydrationMock.mockResolvedValue(['claude', 'codex'])
    const metaById: Record<string, WorktreeMeta> = {}
    const runtimeStore = {
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        defaultTuiAgent: 'blank' as const,
        agentCmdOverrides: {}
      }),
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      }
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-blank-draft' })
    const activateWorktree = vi.fn()
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree,
      createTerminal: vi.fn(),
      revealTerminalSession: vi.fn().mockResolvedValue({ tabId: 'tab-blank-draft' }),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-blank-draft')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-blank-draft')
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: '/tmp/workspaces/runtime-blank-draft',
        head: 'def',
        branch: 'runtime-blank-draft',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-blank-draft',
      startupDraft: 'https://github.com/stablyai/orca/issues/123',
      activate: true
    })

    expect(detectInstalledAgentsWithShellPathHydrationMock).not.toHaveBeenCalled()
    expect(detectRemoteAgentsMock).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
    expect(metaById[result.worktree.id]?.createdWithAgent).toBeUndefined()
    expect(activateWorktree).toHaveBeenCalledWith(
      'repo-1',
      result.worktree.id,
      undefined,
      undefined,
      undefined
    )
  })

  it('forwards generated-name provenance while launching SSH startup drafts', async () => {
    detectRemoteAgentsMock.mockResolvedValue(['claude'])
    const created = {
      path: '/remote/repo-nautilus-2',
      head: 'def',
      branch: 'refs/heads/nautilus-2',
      isBare: false,
      isMainWorktree: false
    }
    const metaById: Record<string, WorktreeMeta> = {}
    const remoteStore = {
      ...store,
      getRepos: () => [
        {
          id: TEST_REPO_ID,
          path: '/remote/repo',
          displayName: 'repo',
          badgeColor: 'blue',
          addedAt: 1,
          connectionId: 'ssh-1'
        }
      ],
      getRepo: () => ({
        id: TEST_REPO_ID,
        path: '/remote/repo',
        displayName: 'repo',
        badgeColor: 'blue',
        addedAt: 1,
        connectionId: 'ssh-1'
      }),
      getSettings: () => ({
        ...store.getSettings(),
        defaultTuiAgent: null,
        agentCmdOverrides: {}
      }),
      getRetiredWorktreeNameRegistry: () => ({ exhaustedTiers: 0, names: ['nautilus'] }),
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      }
    }
    const provider = {
      exec: vi.fn(async (args: string[]) => {
        if (args[0] === 'config') {
          return { stdout: 'Remote User\n', stderr: '' }
        }
        if (args[0] === 'branch') {
          return { stdout: '', stderr: '' }
        }
        if (args[0] === 'symbolic-ref') {
          return { stdout: 'origin/main\n', stderr: '' }
        }
        if (isOriginMainBaseRefProbe(args)) {
          return { stdout: 'main-sha\n', stderr: '' }
        }
        if (args[0] === 'fetch') {
          return { stdout: '', stderr: '' }
        }
        throw new Error(`unexpected git call: ${args.join(' ')}`)
      }),
      addWorktree: vi.fn().mockResolvedValue(undefined),
      listWorktrees: vi.fn().mockResolvedValue([created])
    }
    registerSshGitProvider('ssh-1', provider as never)
    getActiveMultiplexerMock.mockReturnValue({ request: muxRequestMock, notify: vi.fn() })
    const runtime = new OrcaRuntimeService(remoteStore as never)
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-remote-startup-draft' })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    const draftUrl = 'https://github.com/stablyai/orca/pull/456'
    const result = await runtime.createManagedWorktree({
      repoSelector: TEST_REPO_ID,
      name: 'nautilus',
      nameWasGenerated: true,
      startupDraft: draftUrl
    })

    expect(detectRemoteAgentsMock).toHaveBeenCalledWith({ connectionId: 'ssh-1' })
    expect(detectInstalledAgentsWithShellPathHydrationMock).not.toHaveBeenCalled()
    expect(provider.addWorktree).toHaveBeenCalledWith(
      '/remote/repo',
      'nautilus-2',
      '/remote/repo-nautilus-2',
      expect.any(Object)
    )
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/remote/repo-nautilus-2',
        command: `claude '--dangerously-skip-permissions' --prefill '${draftUrl}'`,
        connectionId: 'ssh-1',
        worktreeId: result.worktree.id
      })
    )
    expect(metaById[result.worktree.id]).toMatchObject({ createdWithAgent: 'claude' })
  })

  it('pre-marks remote Codex workspaces trusted before pasting startup drafts', async () => {
    detectRemoteAgentsMock.mockResolvedValue(['codex'])
    muxRequestMock.mockResolvedValue({ resolvedPath: '/home/dev' })
    const created = {
      path: '/remote/mobile-codex-draft',
      head: 'def',
      branch: 'refs/heads/mobile-codex-draft',
      isBare: false,
      isMainWorktree: false
    }
    const metaById: Record<string, WorktreeMeta> = {}
    const remoteStore = {
      ...store,
      getRepos: () => [
        {
          id: TEST_REPO_ID,
          path: '/remote/repo',
          displayName: 'repo',
          badgeColor: 'blue',
          addedAt: 1,
          connectionId: 'ssh-1'
        }
      ],
      getRepo: () => ({
        id: TEST_REPO_ID,
        path: '/remote/repo',
        displayName: 'repo',
        badgeColor: 'blue',
        addedAt: 1,
        connectionId: 'ssh-1'
      }),
      getSettings: () => ({
        ...store.getSettings(),
        defaultTuiAgent: 'codex' as const,
        agentCmdOverrides: {}
      }),
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      }
    }
    const gitProvider = {
      exec: vi.fn(async (args: string[]) => {
        if (args[0] === 'config') {
          return { stdout: 'Remote User\n', stderr: '' }
        }
        if (args[0] === 'branch') {
          return { stdout: '', stderr: '' }
        }
        if (args[0] === 'symbolic-ref') {
          return { stdout: 'origin/main\n', stderr: '' }
        }
        if (isOriginMainBaseRefProbe(args)) {
          return { stdout: 'main-sha\n', stderr: '' }
        }
        if (args[0] === 'fetch') {
          return { stdout: '', stderr: '' }
        }
        throw new Error(`unexpected git call: ${args.join(' ')}`)
      }),
      addWorktree: vi.fn().mockResolvedValue(undefined),
      listWorktrees: vi.fn().mockResolvedValue([created])
    }
    const fsProvider = {
      realpath: vi.fn().mockResolvedValue('/remote/mobile-codex-draft'),
      readFile: vi.fn().mockRejectedValue(new Error('missing config')),
      createDir: vi.fn().mockResolvedValue(undefined),
      writeFile: vi.fn().mockResolvedValue(undefined)
    }
    registerSshGitProvider('ssh-1', gitProvider as never)
    registerSshFilesystemProvider('ssh-1', fsProvider as never)
    const runtime = new OrcaRuntimeService(remoteStore as never)
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-remote-codex-draft' })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    try {
      const result = await runtime.createManagedWorktree({
        repoSelector: TEST_REPO_ID,
        name: 'mobile-codex-draft',
        startupDraft: 'https://github.com/stablyai/orca/issues/789'
      })

      expect(detectRemoteAgentsMock).not.toHaveBeenCalled()
      expect(muxRequestMock).toHaveBeenCalledWith('session.resolveHome', { path: '~' })
      expect(fsProvider.createDir).toHaveBeenCalledWith('/home/dev/.codex')
      expect(fsProvider.writeFile).toHaveBeenCalledWith(
        '/home/dev/.codex/config.toml',
        expect.stringContaining('[projects."/remote/mobile-codex-draft"]')
      )
      expect(fsProvider.writeFile).toHaveBeenCalledWith(
        '/home/dev/.codex/config.toml',
        expect.stringContaining('trust_level = "trusted"')
      )
      expect(spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: '/remote/mobile-codex-draft',
          command: "codex '--dangerously-bypass-approvals-and-sandbox'",
          connectionId: 'ssh-1',
          worktreeId: result.worktree.id
        })
      )
      expect(fsProvider.writeFile.mock.invocationCallOrder[0]).toBeLessThan(
        spawn.mock.invocationCallOrder[0]!
      )
      expect(metaById[result.worktree.id]).toMatchObject({ createdWithAgent: 'codex' })
    } finally {
      unregisterSshFilesystemProvider('ssh-1')
      unregisterSshGitProvider('ssh-1')
    }
  })

  it('pre-marks remote Codex workspaces trusted before explicit startup commands', async () => {
    muxRequestMock.mockResolvedValue({ resolvedPath: '/home/dev' })
    const created = {
      path: '/remote/mobile-codex-command',
      head: 'def',
      branch: 'refs/heads/mobile-codex-command',
      isBare: false,
      isMainWorktree: false
    }
    const metaById: Record<string, WorktreeMeta> = {}
    const remoteStore = {
      ...store,
      getRepos: () => [
        {
          id: TEST_REPO_ID,
          path: '/remote/repo',
          displayName: 'repo',
          badgeColor: 'blue',
          addedAt: 1,
          connectionId: 'ssh-1'
        }
      ],
      getRepo: () => ({
        id: TEST_REPO_ID,
        path: '/remote/repo',
        displayName: 'repo',
        badgeColor: 'blue',
        addedAt: 1,
        connectionId: 'ssh-1'
      }),
      getSettings: () => store.getSettings(),
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      }
    }
    const gitProvider = {
      exec: vi.fn(async (args: string[]) => {
        if (args[0] === 'config') {
          return { stdout: 'Remote User\n', stderr: '' }
        }
        if (args[0] === 'branch') {
          return { stdout: '', stderr: '' }
        }
        if (args[0] === 'symbolic-ref') {
          return { stdout: 'origin/main\n', stderr: '' }
        }
        if (isOriginMainBaseRefProbe(args)) {
          return { stdout: 'main-sha\n', stderr: '' }
        }
        if (args[0] === 'fetch') {
          return { stdout: '', stderr: '' }
        }
        throw new Error(`unexpected git call: ${args.join(' ')}`)
      }),
      addWorktree: vi.fn().mockResolvedValue(undefined),
      listWorktrees: vi.fn().mockResolvedValue([created])
    }
    const fsProvider = {
      realpath: vi.fn().mockResolvedValue('/remote/mobile-codex-command'),
      readFile: vi.fn().mockRejectedValue(new Error('missing config')),
      createDir: vi.fn().mockResolvedValue(undefined),
      writeFile: vi.fn().mockResolvedValue(undefined)
    }
    registerSshGitProvider('ssh-1', gitProvider as never)
    registerSshFilesystemProvider('ssh-1', fsProvider as never)
    const runtime = new OrcaRuntimeService(remoteStore as never)
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-remote-codex-command' })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    try {
      const result = await runtime.createManagedWorktree({
        repoSelector: TEST_REPO_ID,
        name: 'mobile-codex-command',
        startup: { command: 'codex' },
        createdWithAgent: 'codex'
      })

      expect(detectRemoteAgentsMock).not.toHaveBeenCalled()
      expect(muxRequestMock).toHaveBeenCalledWith('session.resolveHome', { path: '~' })
      expect(fsProvider.writeFile).toHaveBeenCalledWith(
        '/home/dev/.codex/config.toml',
        expect.stringContaining('[projects."/remote/mobile-codex-command"]')
      )
      expect(fsProvider.writeFile).toHaveBeenCalledWith(
        '/home/dev/.codex/config.toml',
        expect.stringContaining('trust_level = "trusted"')
      )
      expect(spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: '/remote/mobile-codex-command',
          command: 'codex',
          connectionId: 'ssh-1',
          worktreeId: result.worktree.id
        })
      )
      expect(fsProvider.writeFile.mock.invocationCallOrder[0]).toBeLessThan(
        spawn.mock.invocationCallOrder[0]!
      )
      expect(metaById[result.worktree.id]).toMatchObject({ createdWithAgent: 'codex' })
    } finally {
      unregisterSshFilesystemProvider('ssh-1')
      unregisterSshGitProvider('ssh-1')
    }
  })
})

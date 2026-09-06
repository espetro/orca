import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TEST_FOLDER_WORKSPACE_KEY,
  TEST_REPO_ID,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  UUID_RE,
  createFolderWorkspaceRuntimeStore,
  electronMocks,
  makeFolderProjectGroup,
  makeFolderWorkspace,
  markCodexProjectTrustedMock,
  markCursorWorkspaceTrustedMock,
  resetRuntimeTestMocks,
  setPlatform,
  store
} from './orca-runtime-test-fixture'
import { OrcaRuntimeService } from './orca-runtime'
import type {
  AgentSessionExecutionClaim,
  AgentSessionSurfaceBinding
} from '../../shared/agent-session-host-authority'
import { registerSshGitProvider, unregisterSshGitProvider } from '../providers/ssh-git-dispatch'
import { setTerminalViewAttributes } from './terminal-view-attribute-store'
import { ipcMain } from 'electron'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

beforeEach(resetRuntimeTestMocks)
afterEach(resetRuntimeTestMocks)

describe('OrcaRuntimeService', () => {
  it('passes cached view colors to background agent spawns for source-owned startup replies', async () => {
    setTerminalViewAttributes({
      foreground: [0xff, 0xff, 0xff],
      background: [0x28, 0x2c, 0x34],
      cursor: [0xff, 0xff, 0xff],
      ansi: Array.from({ length: 256 }, () => [0, 0, 0] as [number, number, number]),
      colorSchemeMode: 'dark',
      cursorStyle: 'block',
      cursorBlink: false
    })
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-bg' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, { command: 'codex' })

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        terminalColorQueryReplies: {
          foreground: '#ffffff',
          background: '#282c34'
        }
      })
    )
  })

  it('does not register or publish a PTY incarnation that exited before spawn resolved', async () => {
    const runtime = new OrcaRuntimeService(store)
    const tabId = '11111111-1111-4111-8111-111111111111'
    const leafId = '22222222-2222-4222-8222-222222222222'
    runtime.setPtyController({
      spawn: vi.fn(async () => {
        runtime.beginPtyRegistration('pty-exited-during-start', 'incarnation-exited-during-start')
        runtime.onPtyExit('pty-exited-during-start', 0, 'incarnation-exited-during-start')
        return {
          id: 'pty-exited-during-start',
          incarnationId: 'incarnation-exited-during-start'
        }
      }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    await expect(
      runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
        command: 'codex',
        presentation: 'background',
        tabId,
        leafId
      })
    ).rejects.toThrow('agent_session_exited_during_start')
    await expect(runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)).resolves.toMatchObject({
      terminals: []
    })
    await expect(runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).resolves.toMatchObject({
      tabs: []
    })
    const internals = runtime as unknown as {
      handleByPtyId: Map<string, string>
      ptysById: Map<string, unknown>
    }
    expect(internals.handleByPtyId.has('pty-exited-during-start')).toBe(false)
    expect(internals.ptysById.has('pty-exited-during-start')).toBe(false)
  })

  it('adopts repeated structured OMP resumes while preserving the exact file locator', async () => {
    let canonicalOwner:
      | {
          claim: AgentSessionExecutionClaim
          generation: string
          phase: 'live'
          ptyId: string
          surface: AgentSessionSurfaceBinding
        }
      | undefined
    const spawn = vi.fn(async (options) => {
      const ensure = options.agentSessionEnsure
      expect(ensure).toBeDefined()
      canonicalOwner ??= {
        claim: ensure!.claim,
        generation: 'generation-1',
        phase: 'live',
        ptyId: 'pty-claimed',
        surface: ensure!.surface
      }
      return {
        id: 'pty-claimed',
        agentSessionEnsure: {
          disposition: spawn.mock.calls.length === 1 ? ('created' as const) : ('adopted' as const),
          owner: canonicalOwner
        }
      }
    })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    const request = {
      kind: 'explicit' as const,
      worktree: `id:${TEST_WORKTREE_ID}`,
      agent: 'omp' as const,
      providerSession: { key: 'session_id' as const, id: 'provider-session-1' },
      ompResumeFilePath: '/custom/omp/project/session.jsonl'
    }
    const first = await runtime.ensureAgentSession(request)
    const second = await runtime.ensureAgentSession(request)

    expect(first.disposition).toBe('created')
    expect(second.disposition).toBe('adopted')
    expect(second.terminal).toMatchObject({
      handle: first.terminal.handle,
      tabId: first.terminal.tabId,
      paneKey: first.terminal.paneKey
    })
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.stringContaining("'--resume' '/custom/omp/project/session.jsonl'"),
        agentSessionEnsure: expect.objectContaining({
          claim: expect.objectContaining({ agent: 'omp' })
        })
      })
    )
  })

  it('builds structured fresh drafts with supported launch preferences on the host', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-agent-draft' })
    const runtime = new OrcaRuntimeService({
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        disabledTuiAgents: [],
        agentCmdOverrides: { claude: 'host-claude' },
        agentDefaultArgs: { claude: '--host-default' },
        agentDefaultEnv: { claude: { HOST_PROFILE: 'true' } }
      })
    })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    await runtime.createAgentSession(
      {
        clientOperationId: `${Date.now()}-${'ab'.repeat(16)}`,
        worktree: `id:${TEST_WORKTREE_ID}`,
        agent: 'claude',
        prompt: 'review before sending',
        promptDelivery: 'draft',
        agentArgs: '--permission-mode plan',
        launchPreferences: { model: 'opus', effort: 'high' }
      },
      { clientId: 'renderer-1', clientKind: 'runtime' }
    )

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.stringMatching(
          /^host-claude '--model' 'opus'.*'--permission-mode' 'plan'.*--prefill 'review before sending'/
        ),
        env: expect.objectContaining({ HOST_PROFILE: 'true' })
      })
    )
    expect(spawn.mock.calls[0]?.[0]?.command).not.toContain('--host-default')
  })

  it('applies Settings agent defaults to bare agent command terminal creates', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-bg' })
    const runtimeStore = {
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        disabledTuiAgents: [],
        agentCmdOverrides: {},
        agentDefaultArgs: { codex: '--dangerously-bypass-approvals-and-sandbox' },
        agentDefaultEnv: { codex: { CODEX_PROFILE: 'captured' } }
      })
    }
    const runtime = new OrcaRuntimeService(runtimeStore)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'codex',
      title: 'worker'
    })

    const spawnCall = spawn.mock.calls[0]?.[0] as
      | { command?: string; env?: Record<string, string> }
      | undefined
    expect(spawnCall?.command).toBe("codex '--dangerously-bypass-approvals-and-sandbox'")
    expect(spawnCall?.env).toMatchObject({
      CODEX_PROFILE: 'captured',
      ORCA_WORKTREE_ID: TEST_WORKTREE_ID
    })
    expect(spawnCall?.env?.ORCA_AGENT_LAUNCH_TOKEN).toMatch(UUID_RE)
    expect(markCodexProjectTrustedMock).toHaveBeenCalledWith(TEST_WORKTREE_PATH)
    expect(markCodexProjectTrustedMock.mock.invocationCallOrder[0]).toBeLessThan(
      spawn.mock.invocationCallOrder[0]!
    )
  })

  // Why: `cursor` on PATH is the Cursor desktop launcher; only `cursor-agent` is
  // the CLI Orca can host (issue #11926).
  it('launches the configured agent CLI for a startupAgent id, not the raw id', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-bg' })
    const runtimeStore = {
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        disabledTuiAgents: [],
        agentCmdOverrides: {},
        agentDefaultArgs: { cursor: '--force' },
        agentDefaultEnv: { cursor: { CURSOR_PROFILE: 'captured' } }
      })
    }
    const runtime = new OrcaRuntimeService(runtimeStore)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      startupAgent: 'cursor',
      title: 'worker'
    })

    const spawnCall = spawn.mock.calls[0]?.[0] as
      | { command?: string; launchAgent?: string; env?: Record<string, string> }
      | undefined
    expect(spawnCall?.command).toBe("cursor-agent '--force'")
    expect(spawnCall?.launchAgent).toBe('cursor')
    expect(spawnCall?.env).toMatchObject({ CURSOR_PROFILE: 'captured' })
    expect(markCursorWorkspaceTrustedMock).toHaveBeenCalledWith(TEST_WORKTREE_PATH)
  })

  it('resolves a startupAgent to the CLI binary on Windows, where `cursor` is the IDE', async () => {
    setPlatform('win32')
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-bg' })
    const runtimeStore = {
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        disabledTuiAgents: [],
        terminalWindowsShell: 'cmd.exe',
        agentCmdOverrides: {},
        // Why: pin the arg here rather than inherit the shared yolo default, so
        // this test tracks Windows quoting and not an unrelated default's value.
        agentDefaultArgs: { cursor: '--force' },
        agentDefaultEnv: {}
      })
    }
    const runtime = new OrcaRuntimeService(runtimeStore)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, { startupAgent: 'cursor' })

    const spawnCall = spawn.mock.calls[0]?.[0] as { command?: string } | undefined
    // Why: assert the cmd.exe double quoting too — a platform-insensitive prefix
    // match would pass on any OS and prove nothing about the reported platform.
    expect(spawnCall?.command).toBe('cursor-agent "--force"')
  })

  // Why: claude-agent-teams is the only agent whose launcher name varies by
  // platform (launchCmdByPlatform), so it is what proves resolution is
  // platform-aware rather than a fixed string.
  it.each([
    { platform: 'win32' as const, expected: 'orca.cmd claude-teams' },
    { platform: 'linux' as const, expected: 'orca-ide claude-teams' },
    { platform: 'darwin' as const, expected: 'orca claude-teams' }
  ])(
    'resolves a startupAgent through the $platform launcher name',
    async ({ platform, expected }) => {
      setPlatform(platform)
      const spawn = vi.fn().mockResolvedValue({ id: 'pty-bg' })
      const runtime = new OrcaRuntimeService({
        ...store,
        getSettings: () => ({
          ...store.getSettings(),
          disabledTuiAgents: [],
          agentCmdOverrides: {},
          agentDefaultArgs: { 'claude-agent-teams': '' },
          agentDefaultEnv: {}
        })
      })
      runtime.setPtyController({
        spawn,
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null
      })

      await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
        startupAgent: 'claude-agent-teams'
      })

      const spawnCall = spawn.mock.calls[0]?.[0] as { command?: string } | undefined
      expect(spawnCall?.command).toBe(expected)
    }
  )

  // Why: a user who worked around this bug by pointing the override at their own
  // cursor-agent path must keep that override once the id resolves properly.
  it('honors an agentCmdOverrides entry for a startupAgent', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-bg' })
    const runtime = new OrcaRuntimeService({
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        disabledTuiAgents: [],
        agentCmdOverrides: { cursor: 'cursor-agent --beta' },
        agentDefaultArgs: { cursor: '--force' },
        agentDefaultEnv: {}
      })
    })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, { startupAgent: 'cursor' })

    const spawnCall = spawn.mock.calls[0]?.[0] as { command?: string } | undefined
    expect(spawnCall?.command).toBe("cursor-agent --beta '--force'")
  })

  // Why: with no selector the launch is never resolved, so a dropped startupAgent
  // would reach the renderer as a bare shell — the failure this option prevents.
  it('rejects a startupAgent create with no workspace selector', async () => {
    const runtime = new OrcaRuntimeService({
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        disabledTuiAgents: [],
        agentCmdOverrides: {}
      })
    })

    await expect(
      runtime.createTerminal(undefined, { startupAgent: 'cursor', rendererBacked: true })
    ).rejects.toThrow(/requires a workspace selector/)
  })

  // Why: folder workspaces have no repo, so command sniffing skipped them entirely
  // and spawned the bare string; an explicit agent must still resolve.
  it('resolves a startupAgent in a repo-less folder workspace', async () => {
    const folderPath = await mkdtemp(join(tmpdir(), 'orca-runtime-folder-startup-agent-'))
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-bg' })
    const folderWorkspace = makeFolderWorkspace({ folderPath })
    const projectGroup = makeFolderProjectGroup({ parentPath: folderPath })
    const runtime = new OrcaRuntimeService({
      ...createFolderWorkspaceRuntimeStore(folderWorkspace, projectGroup),
      getSettings: () => ({
        ...store.getSettings(),
        disabledTuiAgents: [],
        agentCmdOverrides: {},
        agentDefaultArgs: { cursor: '--force' },
        agentDefaultEnv: {}
      })
    } as never)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    await runtime.createTerminal(`id:${TEST_FOLDER_WORKSPACE_KEY}`, { startupAgent: 'cursor' })

    const spawnCall = spawn.mock.calls[0]?.[0] as
      | { command?: string; launchAgent?: string }
      | undefined
    expect(spawnCall?.command).toBe("cursor-agent '--force'")
    expect(spawnCall?.launchAgent).toBe('cursor')
  })

  // Why: silently returning the caller's opts would spawn a bare shell that can
  // only time out at agent readiness — the failure startupAgent exists to stop.
  it('rejects a startupAgent create that also supplies its own launch', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-bg' })
    const runtime = new OrcaRuntimeService({
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        disabledTuiAgents: [],
        agentCmdOverrides: {}
      })
    })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    for (const conflicting of [
      { env: { SOME_VAR: 'set' } },
      // Why: a raw command would be silently overwritten by the built launch.
      { command: 'cursor-agent --resume' },
      // Why: resume identity paired with a freshly built launch is incoherent.
      { resumeProviderSession: { key: 'session_id', id: 'prior-session' } as never },
      { launchAgent: 'cursor' as const },
      { launchConfig: { agentArgs: '', agentEnv: {} } as never },
      { startupCommandDelivery: 'provider' as never },
      { claudeAgentTeamsSourceCommand: 'claude' }
    ]) {
      await expect(
        runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
          startupAgent: 'cursor',
          ...conflicting
        })
      ).rejects.toThrow(/cannot combine/)
    }
    expect(spawn).not.toHaveBeenCalled()
  })

  it('rejects a startupAgent create for a disabled agent', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-bg' })
    const runtimeStore = {
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        disabledTuiAgents: ['cursor' as const],
        agentCmdOverrides: {}
      })
    }
    const runtime = new OrcaRuntimeService(runtimeStore)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    await expect(
      runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, { startupAgent: 'cursor' })
    ).rejects.toThrow(/disabled/)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('quotes local Windows bare agent command defaults for cmd.exe terminal creates', async () => {
    setPlatform('win32')
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-bg' })
    const runtimeStore = {
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        disabledTuiAgents: [],
        terminalWindowsShell: 'cmd.exe',
        agentCmdOverrides: {},
        agentDefaultArgs: { claude: '--dangerously-skip-permissions' },
        agentDefaultEnv: {}
      })
    }
    const runtime = new OrcaRuntimeService(runtimeStore)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'claude',
      title: 'worker'
    })

    const spawnCall = spawn.mock.calls[0]?.[0] as { command?: string } | undefined
    expect(spawnCall?.command).toBe('claude "--dangerously-skip-permissions"')
  })

  it('does not use the local Windows shell setting for remote Windows bare agent creates', async () => {
    const remoteRepo = {
      id: TEST_REPO_ID,
      path: 'C:/remote/repo',
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-1'
    }
    const remoteStore = {
      ...store,
      getRepos: () => [remoteRepo],
      getRepo: (id: string) => (id === TEST_REPO_ID ? remoteRepo : undefined),
      getSettings: () => ({
        ...store.getSettings(),
        disabledTuiAgents: [],
        terminalWindowsShell: 'cmd.exe',
        agentCmdOverrides: {},
        agentDefaultArgs: { claude: '--dangerously-skip-permissions' },
        agentDefaultEnv: {}
      })
    }
    const provider = {
      exec: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
      listWorktrees: vi.fn().mockResolvedValue([
        {
          path: 'C:/remote/repo',
          head: 'abc',
          branch: 'main',
          isBare: false,
          isMainWorktree: true
        }
      ])
    }
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-remote-windows-bare' })
    registerSshGitProvider('ssh-1', provider as never)
    const runtime = new OrcaRuntimeService(remoteStore as never)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    try {
      const terminal = await runtime.createTerminal('path:C:/remote/repo', {
        command: 'claude',
        title: 'worker'
      })

      const spawnCall = spawn.mock.calls[0]?.[0] as { command?: string } | undefined
      expect(spawnCall?.command).toBe("claude '--dangerously-skip-permissions'")
      expect(terminal).toMatchObject({
        executionHostId: 'ssh:ssh-1',
        hostPlatform: 'linux'
      })
    } finally {
      unregisterSshGitProvider('ssh-1')
    }
  })

  it('matches canonical bare agent commands when a command override is configured', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-bg' })
    const runtimeStore = {
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        disabledTuiAgents: [],
        agentCmdOverrides: { codex: 'codex --profile work' },
        agentDefaultArgs: { codex: '--dangerously-bypass-approvals-and-sandbox' },
        agentDefaultEnv: {}
      })
    }
    const runtime = new OrcaRuntimeService(runtimeStore)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'codex'
    })

    const spawnCall = spawn.mock.calls[0]?.[0] as { command?: string } | undefined
    expect(spawnCall?.command).toBe(
      "codex --profile work '--dangerously-bypass-approvals-and-sandbox'"
    )
  })

  it('keeps non-bare agent command terminal creates unchanged', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-bg' })
    const runtimeStore = {
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        disabledTuiAgents: [],
        agentCmdOverrides: {},
        agentDefaultArgs: { codex: '--dangerously-bypass-approvals-and-sandbox' },
        agentDefaultEnv: {}
      })
    }
    const runtime = new OrcaRuntimeService(runtimeStore)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'codex exec summarize'
    })

    const spawnCall = spawn.mock.calls[0]?.[0] as
      | { command?: string; env?: Record<string, string> }
      | undefined
    expect(spawnCall?.command).toBe('codex exec summarize')
    expect(spawnCall?.env?.ORCA_AGENT_LAUNCH_TOKEN).toBeUndefined()
  })

  it('keeps disabled bare agent command terminal creates unchanged', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-bg' })
    const runtimeStore = {
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        disabledTuiAgents: ['codex' as const],
        agentCmdOverrides: {},
        agentDefaultArgs: { codex: '--dangerously-bypass-approvals-and-sandbox' },
        agentDefaultEnv: {}
      })
    }
    const runtime = new OrcaRuntimeService(runtimeStore)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'codex'
    })

    const spawnCall = spawn.mock.calls[0]?.[0] as
      | { command?: string; env?: Record<string, string> }
      | undefined
    expect(spawnCall?.command).toBe('codex')
    expect(spawnCall?.env?.ORCA_AGENT_LAUNCH_TOKEN).toBeUndefined()
  })

  it('sends Settings agent defaults through renderer-backed bare agent terminal creates', async () => {
    const runtimeStore = {
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        disabledTuiAgents: [],
        agentCmdOverrides: {},
        agentDefaultArgs: { codex: '--dangerously-bypass-approvals-and-sandbox' },
        agentDefaultEnv: { codex: { CODEX_PROFILE: 'captured' } }
      })
    }
    const runtime = new OrcaRuntimeService(runtimeStore)

    const webContents = { send: vi.fn() }
    webContents.send.mockImplementation((_channel: string, payload: { requestId: string }) => {
      runtime.syncWindowGraph(1, {
        tabs: [],
        leaves: [
          {
            tabId: 'tab-renderer',
            worktreeId: TEST_WORKTREE_ID,
            leafId: 'pane:1',
            paneRuntimeId: 1,
            ptyId: 'pty-renderer',
            paneTitle: null
          }
        ]
      })
      ipcMain.emit(
        'terminal:tabCreateReply',
        { sender: webContents },
        { requestId: payload.requestId, tabId: 'tab-renderer', title: 'Codex' }
      )
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    electronMocks.BrowserWindow.fromId.mockReturnValue({
      isDestroyed: () => false,
      webContents
    })

    await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'codex',
      rendererBacked: true
    })

    expect(webContents.send).toHaveBeenCalledWith(
      'terminal:requestTabCreate',
      expect.objectContaining({
        worktreeId: TEST_WORKTREE_ID,
        command: "codex '--dangerously-bypass-approvals-and-sandbox'",
        env: { CODEX_PROFILE: 'captured' },
        launchAgent: 'codex',
        launchConfig: {
          agentCommand: "codex '--dangerously-bypass-approvals-and-sandbox'",
          agentArgs: '--dangerously-bypass-approvals-and-sandbox',
          agentEnv: { CODEX_PROFILE: 'captured' }
        }
      })
    )
    expect(markCodexProjectTrustedMock).toHaveBeenCalledWith(TEST_WORKTREE_PATH)
    expect(markCodexProjectTrustedMock.mock.invocationCallOrder[0]).toBeLessThan(
      webContents.send.mock.invocationCallOrder[0]!
    )
  })
})

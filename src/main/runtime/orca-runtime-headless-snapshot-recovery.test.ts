import type { RuntimeTerminalAgentStatusEvent } from './runtime-contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TEST_REPO_ID,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  createRuntime,
  expectStablePaneKeyEnv,
  resetRuntimeTestMocks,
  setPlatform,
  store,
  syncSinglePty
} from './orca-runtime-test-fixture'
import { OrcaRuntimeService } from './orca-runtime'

beforeEach(resetRuntimeTestMocks)
afterEach(resetRuntimeTestMocks)

describe('OrcaRuntimeService', () => {
  it('replaces suffix-only headless state with the recovered renderer snapshot', async () => {
    const runtime = createRuntime()
    syncSinglePty(runtime, 'pty-1')
    runtime.seedHeadlessTerminal('pty-1', 'suffix-only redraw', { cols: 80, rows: 24 })

    runtime.replaceHeadlessTerminalFromRendererSnapshotForRecovery('pty-1', {
      data: 'restored history\r\nprompt $ ',
      cols: 80,
      rows: 24,
      cwd: '/projects/restored'
    })
    runtime.onPtyData('pty-1', 'after recovery\r\n', 100)

    const snapshot = await runtime.serializeMainTerminalBuffer('pty-1', {
      scrollbackRows: 100
    })
    expect(snapshot?.data).toContain('restored history')
    expect(snapshot?.data).toContain('after recovery')
    expect(snapshot?.data).not.toContain('suffix-only redraw')
    expect(snapshot?.cwd).toBe('/projects/restored')
  })

  it('adopts OSC7 host metadata from seeded headless terminal scrollback', async () => {
    const runtime = createRuntime()
    syncSinglePty(runtime, 'pty-1')
    const [terminal] = (await runtime.listTerminals()).terminals

    runtime.seedHeadlessTerminal(
      'pty-1',
      '\x1b]7;file://remote-host/tmp\x07restored scrollback\n',
      { cols: 100, rows: 30 }
    )

    expect(runtime.resolveTerminalFileUriHostname(terminal.handle)).toBe('remote-host')
  })

  it('falls back to the renderer snapshot for hidden-output recovery without headless state', async () => {
    const serializeBuffer = vi.fn().mockResolvedValue({
      data: '\x1b[?1049hRenderer TUI\r\nStill running\r\n',
      cols: 100,
      rows: 30,
      lastTitle: 'Renderer working'
    })
    const runtime = createRuntime()
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      serializeBuffer,
      hasRendererSerializer: () => true
    })
    syncSinglePty(runtime, 'pty-1')

    const snapshot = await runtime.serializeHiddenOutputRecoveryBuffer('pty-1', {
      scrollbackRows: 5000
    })

    expect(snapshot).toEqual({
      data: '\x1b[?1049hRenderer TUI\r\nStill running\r\n',
      cols: 100,
      rows: 30,
      lastTitle: 'Renderer working',
      source: 'renderer'
    })
    expect(serializeBuffer).toHaveBeenCalledWith('pty-1', {
      scrollbackRows: 5000,
      altScreenForcesZeroRows: false
    })
  })

  it('binds shell ownership evidence to the headless snapshot sequence', async () => {
    const runtime = createRuntime()
    let resolveConfirmation: ((confirmed: boolean) => void) | undefined
    const confirmShellForeground = vi.fn(
      () => new Promise<boolean>((resolve) => void (resolveConfirmation = resolve))
    )
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      confirmShellForeground
    })
    syncSinglePty(runtime, 'pty-1')

    runtime.onPtyData('pty-1', '\x1b[?1049hTUI\x1b]133;D;137\x07shell-marker', 100)
    const shellSnapshotPromise = runtime.serializeHiddenOutputRecoveryBuffer('pty-1')
    await vi.waitFor(() => expect(confirmShellForeground).toHaveBeenCalledTimes(1))
    let snapshotSettled = false
    void shellSnapshotPromise.then(() => {
      snapshotSettled = true
    })
    await Promise.resolve()
    expect(snapshotSettled).toBe(false)

    resolveConfirmation?.(true)
    const shellSnapshot = await shellSnapshotPromise
    // Why alternateScreen stays true here: the mirror never rewrites its own
    // model — without a daemon barrier injecting the reset in-stream (direct
    // provider path), the snapshot publishes the poisoned mode alongside the
    // proof and the renderer's dead-TUI branch grounds the pane.
    expect(shellSnapshot).toMatchObject({
      alternateScreen: true,
      terminalOwner: 'shell',
      seq: '\x1b[?1049hTUI\x1b]133;D;137\x07shell-marker'.length
    })
    expect(confirmShellForeground).toHaveBeenCalledTimes(1)

    runtime.onPtyData('pty-1', '\x1b]133;C\x07\x1b[?1049hLIVE-TUI', 101)
    const liveSnapshot = await runtime.serializeHiddenOutputRecoveryBuffer('pty-1')

    expect(liveSnapshot?.alternateScreen).toBe(true)
    expect(liveSnapshot?.terminalOwner).toBeUndefined()
  })

  it('keeps an empty headless snapshot authoritative for hidden-output recovery', async () => {
    const serializeBuffer = vi.fn().mockResolvedValue({
      data: 'stale renderer content\r\n',
      cols: 80,
      rows: 24
    })
    const runtime = createRuntime()
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      serializeBuffer,
      hasRendererSerializer: () => true
    })
    type HeadlessStateForTest = {
      emulator: {
        isAlternateScreen: boolean
        getSnapshot: (opts: { scrollbackRows?: number }) => {
          rehydrateSequences: string
          snapshotAnsi: string
          cols: number
          rows: number
        }
      }
      outputSequence: number
      writeChain: Promise<void>
      ownership: { settle: () => Promise<void>; owner: undefined }
    }
    const runtimePrivate = runtime as unknown as {
      headlessTerminals: Map<string, HeadlessStateForTest>
    }
    runtimePrivate.headlessTerminals.set('pty-empty', {
      emulator: {
        isAlternateScreen: false,
        getSnapshot: () => ({ rehydrateSequences: '', snapshotAnsi: '', cols: 90, rows: 30 })
      },
      outputSequence: 17,
      writeChain: Promise.resolve(),
      ownership: { settle: async () => {}, owner: undefined }
    })

    await expect(runtime.serializeHiddenOutputRecoveryBuffer('pty-empty')).resolves.toEqual({
      data: '',
      cols: 90,
      rows: 30,
      seq: 17,
      source: 'headless',
      // Non-alt-screen reports alternateScreen=false so the renderer keeps its destructive scrollback clear on restore.
      alternateScreen: false
    })
    expect(serializeBuffer).not.toHaveBeenCalled()
  })

  it('advances the absolute output sequence across a daemon stream gap', () => {
    const runtime = createRuntime()
    runtime.onPtyData('pty-gap', 'before', Date.now())

    runtime.notePtyDataGap('pty-gap', 4096)
    runtime.onPtyData('pty-gap', 'after', Date.now())

    expect(runtime.getPtyOutputSequence('pty-gap')).toBe('before'.length + 4096 + 'after'.length)
  })

  it('emits explicit OSC 9999 agent status from runtime PTY data', () => {
    const statuses: RuntimeTerminalAgentStatusEvent[] = []
    const runtime = new OrcaRuntimeService(store, undefined, {
      onTerminalAgentStatus: (event) => statuses.push(event)
    })
    const leafId = '11111111-1111-4111-8111-111111111111'
    const paneKey = `tab-1:${leafId}`
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Terminal',
          activeLeafId: leafId,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          leafId,
          paneRuntimeId: 1,
          ptyId: 'pty-1'
        }
      ]
    })

    runtime.onPtyData(
      'pty-1',
      'before\x1b]9999;{"state":"working","prompt":"ship it","agentType":"codex"}\x07after',
      123
    )

    expect(statuses).toEqual([
      {
        ptyId: 'pty-1',
        source: 'mounted-leaf',
        paneKey,
        tabId: 'tab-1',
        worktreeId: TEST_WORKTREE_ID,
        connectionId: null,
        payload: {
          state: 'working',
          prompt: 'ship it',
          agentType: 'codex'
        }
      }
    ])
  })

  it('stamps SSH connection identity on runtime terminal status', () => {
    const statuses: RuntimeTerminalAgentStatusEvent[] = []
    const runtime = new OrcaRuntimeService(store, undefined, {
      onTerminalAgentStatus: (event) => statuses.push(event)
    })
    const leafId = '11111111-1111-4111-8111-111111111111'
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Terminal',
          activeLeafId: leafId,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          leafId,
          paneRuntimeId: 1,
          ptyId: 'pty-ssh'
        }
      ]
    })
    runtime.registerPty('pty-ssh', TEST_WORKTREE_ID, 'ssh-conn-1')

    runtime.onPtyData('pty-ssh', '\x1b]9999;{"state":"working","agentType":"codex"}\x07', 123)

    expect(statuses).toEqual([
      expect.objectContaining({
        ptyId: 'pty-ssh',
        source: 'mounted-leaf',
        connectionId: 'ssh-conn-1',
        payload: expect.objectContaining({
          state: 'working',
          agentType: 'codex'
        })
      })
    ])
  })

  it('keeps SSH OSC7 cwd POSIX when the desktop runtime is on Windows', async () => {
    setPlatform('win32')
    const runtime = new OrcaRuntimeService(store)
    runtime.preparePtyExecutionContext('pty-ssh', 'Ubuntu', { resetIncarnation: true })
    runtime.registerPty('pty-ssh', TEST_WORKTREE_ID, 'ssh-conn-1')

    runtime.onPtyData('pty-ssh', '\x1b]7;file://remote-host/home/me/repo/src\x07', 123)

    const internals = runtime as unknown as {
      terminalCwdByPtyId: Map<string, string>
      terminalFileUriHostnameByPtyId: Map<string, string>
      wslDistroByPtyId: Map<string, string>
    }
    expect(internals.terminalCwdByPtyId.get('pty-ssh')).toBe('/home/me/repo/src')
    expect(internals.terminalFileUriHostnameByPtyId.get('pty-ssh')).toBe('remote-host')
    expect(internals.wslDistroByPtyId.has('pty-ssh')).toBe(false)
  })

  it('uses per-incarnation WSL context before registration and across simultaneous distros', () => {
    setPlatform('win32')
    const runtime = new OrcaRuntimeService(store)
    runtime.preparePtyExecutionContext('pty-ubuntu', 'Ubuntu', { resetIncarnation: true })
    runtime.preparePtyExecutionContext('pty-debian', 'Debian', { resetIncarnation: true })
    runtime.registerPty('pty-ubuntu', TEST_WORKTREE_ID)
    runtime.registerPty('pty-debian', TEST_WORKTREE_ID)

    runtime.onPtyData('pty-ubuntu', '\x1b]7;file://DESKTOP/home/me/repo\x07', 1)
    runtime.onPtyData('pty-debian', '\x1b]7;file://DESKTOP/home/me/repo\x07', 1)

    const cwds = (runtime as unknown as { terminalCwdByPtyId: Map<string, string> })
      .terminalCwdByPtyId
    expect(cwds.get('pty-ubuntu')).toBe('\\\\wsl.localhost\\Ubuntu\\home\\me\\repo')
    expect(cwds.get('pty-debian')).toBe('\\\\wsl.localhost\\Debian\\home\\me\\repo')
  })

  it('does not retain WSL context when a PTY id is reused', () => {
    setPlatform('win32')
    const runtime = new OrcaRuntimeService(store)
    runtime.preparePtyExecutionContext('pty-reused', 'Ubuntu', { resetIncarnation: true })
    runtime.registerPty('pty-reused', TEST_WORKTREE_ID)
    runtime.onPtyExit('pty-reused', 0)

    runtime.preparePtyExecutionContext('pty-reused', null, { resetIncarnation: true })
    runtime.registerPty('pty-reused', TEST_WORKTREE_ID)
    runtime.onPtyData('pty-reused', '\x1b]7;file://server/share/repo\x07', 1)

    const cwds = (runtime as unknown as { terminalCwdByPtyId: Map<string, string> })
      .terminalCwdByPtyId
    expect(cwds.get('pty-reused')).toBe('\\\\server\\share\\repo')
  })

  it('preserves immutable context while a live daemon attach is unresolved', () => {
    setPlatform('win32')
    const runtime = new OrcaRuntimeService(store)
    runtime.preparePtyExecutionContext('pty-attached', 'Ubuntu', { resetIncarnation: true })
    runtime.registerPty('pty-attached', TEST_WORKTREE_ID)

    const changed = runtime.preparePtyExecutionContext('pty-attached', 'Debian', {
      preserveExisting: true
    })
    runtime.onPtyData('pty-attached', '\x1b]7;file://DESKTOP/home/me/repo\x07', 1)

    const cwd = (
      runtime as unknown as { terminalCwdByPtyId: Map<string, string> }
    ).terminalCwdByPtyId.get('pty-attached')
    expect(changed).toBe(false)
    expect(cwd).toBe('\\\\wsl.localhost\\Ubuntu\\home\\me\\repo')
  })

  it('replaces a cwd parsed before late WSL context with the provider cwd', async () => {
    setPlatform('win32')
    const runtime = new OrcaRuntimeService(store)
    const ptyId = 'pty-late-wsl-context'
    const providerCwd = '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo'
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      getSize: () => ({ cols: 80, rows: 24 }),
      serializeProviderBuffer: vi.fn().mockResolvedValue({
        data: 'restored screen',
        cols: 80,
        rows: 24,
        cwd: providerCwd,
        seq: 1,
        source: 'headless'
      })
    })
    runtime.registerPty(ptyId, TEST_WORKTREE_ID)
    runtime.seedHeadlessTerminal(ptyId, '\x1b]7;file://DESKTOP/home/me/repo\x07')

    const internals = runtime as unknown as {
      headlessTerminals: Map<string, { writeChain: Promise<void> }>
      terminalCwdByPtyId: Map<string, string>
    }
    await internals.headlessTerminals.get(ptyId)?.writeChain
    expect(internals.terminalCwdByPtyId.get(ptyId)).toBe('\\\\desktop\\home\\me\\repo')

    runtime.preparePtyExecutionContext(ptyId, 'Ubuntu')
    await internals.headlessTerminals.get(ptyId)?.writeChain

    expect(internals.terminalCwdByPtyId.get(ptyId)).toBe(providerCwd)
  })

  it('keeps a live WSL cwd that arrives during late-context snapshot recovery', async () => {
    setPlatform('win32')
    const runtime = new OrcaRuntimeService(store)
    const ptyId = 'pty-late-wsl-context-race'
    type ProviderSnapshot = {
      data: string
      cols: number
      rows: number
      cwd: string
      seq: number
      source: 'headless'
    }
    let resolveProviderSnapshot: ((snapshot: ProviderSnapshot) => void) | undefined
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      getSize: () => ({ cols: 80, rows: 24 }),
      serializeProviderBuffer: vi.fn(
        () =>
          new Promise<ProviderSnapshot>((resolve) => {
            resolveProviderSnapshot = resolve
          })
      )
    })
    runtime.registerPty(ptyId, TEST_WORKTREE_ID)
    runtime.seedHeadlessTerminal(ptyId, '\x1b]7;file://DESKTOP/home/me/old\x07')
    const internals = runtime as unknown as {
      headlessTerminals: Map<string, { writeChain: Promise<void> }>
      terminalCwdByPtyId: Map<string, string>
    }
    await internals.headlessTerminals.get(ptyId)?.writeChain

    runtime.preparePtyExecutionContext(ptyId, 'Ubuntu')
    await vi.waitFor(() => expect(resolveProviderSnapshot).toBeDefined())
    runtime.onPtyData(ptyId, '\x1b]7;file://DESKTOP/home/me/live\x07', 1)
    resolveProviderSnapshot?.({
      data: 'older restored screen',
      cols: 80,
      rows: 24,
      cwd: '\\\\wsl.localhost\\Ubuntu\\home\\me\\old',
      seq: 1,
      source: 'headless'
    })
    await internals.headlessTerminals.get(ptyId)?.writeChain

    expect(internals.terminalCwdByPtyId.get(ptyId)).toBe(
      '\\\\wsl.localhost\\Ubuntu\\home\\me\\live'
    )
  })

  it('infers local reconstructed WSL context from a WSL UNC worktree', () => {
    setPlatform('win32')
    const runtime = new OrcaRuntimeService(store)
    runtime.registerPty(
      'pty-reconstructed',
      `${TEST_REPO_ID}::\\\\wsl.localhost\\Ubuntu\\home\\me\\repo`
    )

    runtime.onPtyData('pty-reconstructed', '\x1b]7;file://DESKTOP/home/me/repo/src\x07', 1)

    const cwd = (
      runtime as unknown as { terminalCwdByPtyId: Map<string, string> }
    ).terminalCwdByPtyId.get('pty-reconstructed')
    expect(cwd).toBe('\\\\wsl.localhost\\Ubuntu\\home\\me\\repo\\src')
  })

  it('clears stale terminal file URI hostnames after empty-host OSC7 cwd updates', () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.registerPty('pty-ssh', TEST_WORKTREE_ID, 'ssh-conn-1')

    runtime.onPtyData('pty-ssh', '\x1b]7;file://remote-host/home/me/repo/src\x07', 123)
    runtime.onPtyData('pty-ssh', '\x1b]7;file:///home/me/repo/src\x07', 124)

    const internals = runtime as unknown as {
      terminalCwdByPtyId: Map<string, string>
      terminalFileUriHostnameByPtyId: Map<string, string>
    }
    expect(internals.terminalCwdByPtyId.get('pty-ssh')).toBe('/home/me/repo/src')
    expect(internals.terminalFileUriHostnameByPtyId.has('pty-ssh')).toBe(false)
  })

  it('serializes SSH headless OSC7 cwd as POSIX when the desktop runtime is on Windows', async () => {
    setPlatform('win32')
    const runtime = new OrcaRuntimeService(store)
    runtime.registerPty('pty-ssh', TEST_WORKTREE_ID, 'ssh-conn-1')

    runtime.onPtyData('pty-ssh', '\x1b]7;file://remote-host/home/me/repo/src\x07hello', 123)

    const snapshot = await (
      runtime as unknown as {
        serializeHeadlessTerminalBuffer: (
          ptyId: string,
          opts: { includeEmpty?: boolean }
        ) => Promise<{ cwd?: string | null } | null>
      }
    ).serializeHeadlessTerminalBuffer('pty-ssh', { includeEmpty: true })

    expect(snapshot?.cwd).toBe('/home/me/repo/src')
  })

  it('projects frame-independent live state through main buffer snapshots', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.registerPty('pty-frame-state', TEST_WORKTREE_ID)
    runtime.onPtyData('pty-frame-state', '\x1b[?1049h\x1b[?1004h\x1b[?25lSTATIC-FRAME', 123)

    const snapshot = await runtime.serializeMainTerminalBuffer('pty-frame-state')

    expect(snapshot?.frameRestoreAnsi).toContain('\x1b[?1004h')
    expect(snapshot?.frameRestoreAnsi).toContain('\x1b[?25l')
    expect(snapshot?.frameRestoreAnsi).not.toContain('STATIC-FRAME')
    expect(snapshot?.data).toContain('STATIC-FRAME')
  })

  it('keeps Windows SSH OSC7 cwd as a drive path when the desktop runtime is POSIX', () => {
    setPlatform('darwin')
    const runtime = new OrcaRuntimeService(store)
    runtime.registerPty('pty-ssh-win', `${TEST_REPO_ID}::C:/Users/me/repo`, 'ssh-conn-1')

    runtime.onPtyData('pty-ssh-win', '\x1b]7;file:///C:/Users/me/repo/src\x07', 123)

    const internals = runtime as unknown as {
      terminalCwdByPtyId: Map<string, string>
    }
    expect(internals.terminalCwdByPtyId.get('pty-ssh-win')).toBe('C:/Users/me/repo/src')
  })

  it('serializes Windows SSH headless OSC7 cwd as a drive path on POSIX desktops', async () => {
    setPlatform('darwin')
    const runtime = new OrcaRuntimeService(store)
    runtime.registerPty('pty-ssh-win', `${TEST_REPO_ID}::C:/Users/me/repo`, 'ssh-conn-1')

    runtime.onPtyData('pty-ssh-win', '\x1b]7;file:///C:/Users/me/repo/src\x07hello', 123)

    const snapshot = await (
      runtime as unknown as {
        serializeHeadlessTerminalBuffer: (
          ptyId: string,
          opts: { includeEmpty?: boolean }
        ) => Promise<{ cwd?: string | null } | null>
      }
    ).serializeHeadlessTerminalBuffer('pty-ssh-win', { includeEmpty: true })

    expect(snapshot?.cwd).toBe('C:/Users/me/repo/src')
  })

  it('infers restored SSH connection identity from app-scoped PTY ids', () => {
    const statuses: RuntimeTerminalAgentStatusEvent[] = []
    const runtime = new OrcaRuntimeService(store, undefined, {
      onTerminalAgentStatus: (event) => statuses.push(event)
    })
    const ptyId = 'ssh:ssh-restored@@relay-pty'
    const leafId = '11111111-1111-4111-8111-111111111111'
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Terminal',
          activeLeafId: leafId,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          leafId,
          paneRuntimeId: 1,
          ptyId
        }
      ]
    })

    runtime.onPtyData(ptyId, '\x1b]9999;{"state":"working","agentType":"codex"}\x07', 123)

    expect(statuses).toEqual([
      expect.objectContaining({
        ptyId,
        connectionId: 'ssh-restored',
        payload: expect.objectContaining({
          state: 'working',
          agentType: 'codex'
        })
      })
    ])
  })

  it('preserves OSC 9999 parser state for rendererless background PTYs', async () => {
    const statuses: RuntimeTerminalAgentStatusEvent[] = []
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-bg' })
    const runtime = new OrcaRuntimeService(store, undefined, {
      onTerminalAgentStatus: (event) => statuses.push(event)
    })
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
    const spawnedEnv =
      (spawn.mock.calls[0]?.[0] as { env?: Record<string, string> } | undefined)?.env ?? {}
    const paneKey = expectStablePaneKeyEnv(spawnedEnv)

    runtime.onPtyData('pty-bg', 'before\x1b]999', 123)
    runtime.onPtyData('pty-bg', '9;{"state":"done","prompt":"ok"}\x1b\\after', 124)

    expect(statuses).toEqual([
      {
        ptyId: 'pty-bg',
        source: 'pty-record',
        paneKey,
        tabId: spawnedEnv.ORCA_TAB_ID,
        worktreeId: TEST_WORKTREE_ID,
        connectionId: null,
        payload: {
          state: 'done',
          prompt: 'ok'
        }
      }
    ])
  })

  it('continues terminal agent status fanout when a callback throws', () => {
    const statuses: RuntimeTerminalAgentStatusEvent[] = []
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const runtime = new OrcaRuntimeService(store, undefined, {
      onTerminalAgentStatus: (event) => {
        statuses.push(event)
        if (statuses.length === 1) {
          throw new Error('status listener failed')
        }
      }
    })
    const leafId = '11111111-1111-4111-8111-111111111111'
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Terminal',
          activeLeafId: leafId,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          leafId,
          paneRuntimeId: 1,
          ptyId: 'pty-1'
        }
      ]
    })

    runtime.onPtyData(
      'pty-1',
      '\x1b]9999;{"state":"working","prompt":"one","agentType":"codex"}\x07' +
        '\x1b]9999;{"state":"done","prompt":"two","agentType":"codex"}\x07',
      123
    )

    expect(statuses.map((event) => event.payload.prompt)).toEqual(['one', 'two'])
    expect(errorSpy).toHaveBeenCalledWith(
      '[runtime] terminal agent status listener threw',
      expect.objectContaining({
        ptyId: 'pty-1',
        paneKey: `tab-1:${leafId}`,
        state: 'working',
        agentType: 'codex',
        err: expect.any(Error)
      })
    )
  })
})

import type { RuntimeTerminalAgentStatusEvent } from './runtime-contracts'
/* eslint-disable max-lines -- Why: split slice of the runtime behavior suite; mocks are duplicated per file because vi.mock is file-scoped */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  resetRuntimeTestMocks,
  HEADLESS_LEAF_ID,
  RESTORED_AUTHORITY_TOKEN,
  RESTORED_AUTHORITY_TOKEN_HASH,
  TEST_FOLDER_PROJECT_GROUP_ID,
  TEST_FOLDER_WORKSPACE_ID,
  TEST_FOLDER_WORKSPACE_KEY,
  TEST_REPO_ID,
  TEST_WINDOW_ID,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  UUID_RE,
  acknowledgeAgentPromptSubmit,
  antigravityPromptBeforeModelReadyScreen,
  antigravityReadyScreen,
  createExplicitAgentStatusHarness,
  createFolderWorkspaceRuntimeStore,
  createRuntime,
  cursorBusyScreen,
  cursorReadyScreen,
  deferred,
  electronMocks,
  expectStablePaneKeyEnv,
  makeDeferred,
  makeFolderProjectGroup,
  makeFolderWorkspace,
  makeHeadlessTerminalLayout,
  makeRuntimeStoreWithWorkspaceSession,
  makeStatusFrame,
  makeWorkspaceSessionWithHeadlessTerminal,
  markCodexProjectTrustedMock,
  markCursorWorkspaceTrustedMock,
  parseHeadlessSnapshotLines,
  referenceStatusFrameLines,
  renderGateCapMs,
  setPlatform,
  store,
  syncSinglePty
} from './orca-runtime-test-fixture'
import { OrcaRuntimeService, AUTHORITATIVE_TERMINAL_SNAPSHOT_TIMEOUT_MS } from './orca-runtime'
import type { TerminalSideEffectBatch } from '../../shared/terminal-side-effect-facts'
import type { RuntimeClientEvent } from '../../shared/runtime-client-events'
import type { IPtyProvider } from '../providers/types'
import type {
  AgentSessionExecutionClaim,
  AgentSessionSurfaceBinding
} from '../../shared/agent-session-host-authority'
import type { TuiAgent } from '../../shared/tui-agent'
import {
  AGENT_PROMPT_BRACKETED_PASTE_END,
  AGENT_PROMPT_BRACKETED_PASTE_START,
  buildAgentPromptPasteBytes,
  getAgentPromptSubmitDelayMs
} from '../../shared/agent-prompt-injection'
import { CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS } from '../../shared/clipboard-text'
import { FLOATING_TERMINAL_WORKTREE_ID, getDefaultWorkspaceSession } from '../../shared/constants'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../shared/runtime-types'
import { SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV } from '../../shared/setup-agent-sequencing'
import { makePaneKey } from '../../shared/stable-pane-id'
import {
  TERMINAL_INPUT_CHUNK_MAX_BYTES,
  TERMINAL_INPUT_MAX_BYTES,
  TERMINAL_INPUT_TOO_LARGE_ERROR
} from '../../shared/terminal-input'
import { TUI_AGENT_CONFIG } from '../../shared/tui-agent-config'
import type { HeadlessEmulator } from '../daemon/headless-emulator'
import { inspectPtyProviderProcess } from '../providers/pty-process-inspection'
import { registerSshGitProvider, unregisterSshGitProvider } from '../providers/ssh-git-dispatch'
import type { OrchestrationDb } from './orchestration/db'
import { setTerminalViewAttributes } from './terminal-view-attribute-store'
import { ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

beforeEach(resetRuntimeTestMocks)
afterEach(resetRuntimeTestMocks)

describe('OrcaRuntimeService', () => {
  describe('terminal side-effect fact channel', () => {
    function createSideEffectRuntime(): {
      runtime: OrcaRuntimeService
      batches: TerminalSideEffectBatch[]
    } {
      const batches: TerminalSideEffectBatch[] = []
      const runtime = new OrcaRuntimeService(store, undefined, {
        onTerminalSideEffects: (batch) => batches.push(batch)
      })
      return { runtime, batches }
    }

    it('defers desktop-only output scanners until a headless runtime is promoted', () => {
      const { runtime, batches } = createSideEffectRuntime()
      const trackerEntries = (
        runtime as unknown as {
          ptyTitleTrackersByPtyId: Map<string, { commandCodeDetector: unknown }>
        }
      ).ptyTitleTrackersByPtyId
      runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })

      runtime.onPtyData('pty-1', '\x07', 100)

      expect(batches).toEqual([])
      expect(trackerEntries.get('pty-1')?.commandCodeDetector).toBeNull()

      runtime.attachWindow(1)
      runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
      runtime.onPtyData('pty-1', '\x07', 101)

      expect(batches.flatMap((batch) => batch.facts)).toEqual([{ kind: 'bell' }])
      expect(trackerEntries.get('pty-1')?.commandCodeDetector).not.toBeNull()

      runtime.markGraphUnavailable(1)
      runtime.onPtyData('pty-1', '\x07', 102)

      expect(batches).toHaveLength(1)
      expect(trackerEntries.get('pty-1')?.commandCodeDetector).toBeNull()
    })

    it('forwards facts over the shared client-event stream without a desktop renderer', () => {
      const runtime = new OrcaRuntimeService(store)
      const events: RuntimeClientEvent[] = []
      runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
      const unsubscribe = runtime.onClientEvent((event) => events.push(event))

      runtime.onPtyData('pty-remote', '\x1b]0;Codex working\x07\x07', 100)

      expect(events).toEqual([
        {
          type: 'terminalSideEffects',
          batch: {
            ptyId: 'pty-remote',
            seq: 19,
            facts: [
              {
                kind: 'title',
                normalizedTitle: 'Codex working',
                rawTitle: 'Codex working'
              },
              { kind: 'agent-working' },
              { kind: 'bell' }
            ]
          }
        }
      ])

      unsubscribe()
      runtime.onPtyData('pty-remote', '\x07', 101)
      expect(events).toHaveLength(1)
    })

    it('bounds decorative title delivery per paired client without reducing local frames', () => {
      const { runtime, batches } = createSideEffectRuntime()
      const firstClientEvents: RuntimeClientEvent[] = []
      runtime.attachWindow(1)
      runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
      runtime.onClientEvent((event) => firstClientEvents.push(event))

      const ptyIds = Array.from({ length: 64 }, (_, index) => `pty-remote-${index}`)
      const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
      for (const ptyId of ptyIds) {
        runtime.ingestSyntheticTitleFrame(ptyId, `\x1b]0;${frames[0]} Cursor Agent\x07`)
      }
      firstClientEvents.length = 0

      for (const frame of frames.slice(1)) {
        for (const ptyId of ptyIds) {
          runtime.ingestSyntheticTitleFrame(ptyId, `\x1b]0;${frame} Cursor Agent\x07`)
        }
      }

      expect(firstClientEvents).toEqual([])
      expect(batches).toHaveLength(ptyIds.length * frames.length)

      const bellChunk = `\x1b]0;${frames.at(-1)} Cursor Agent\x07\x07`
      runtime.onPtyData(ptyIds[0], bellChunk, 1)
      expect(firstClientEvents).toEqual([
        expect.objectContaining({
          type: 'terminalSideEffects',
          batch: expect.objectContaining({ facts: [{ kind: 'bell' }] })
        })
      ])
      firstClientEvents.length = 0

      const secondClientEvents: RuntimeClientEvent[] = []
      runtime.onClientEvent((event) => secondClientEvents.push(event))
      for (const ptyId of ptyIds) {
        runtime.ingestSyntheticTitleFrame(ptyId, `\x1b]0;${frames[0]} Cursor Agent\x07`)
      }

      expect(firstClientEvents).toEqual([])
      expect(secondClientEvents).toHaveLength(ptyIds.length)

      for (const ptyId of ptyIds) {
        runtime.ingestSyntheticTitleFrame(ptyId, '\x1b]0;Cursor ready\x07')
      }
      expect(firstClientEvents).toHaveLength(ptyIds.length)
      expect(secondClientEvents).toHaveLength(ptyIds.length * 2)
    })

    it('omits terminalSideEffects from non-consuming listeners while other events still flow', () => {
      const runtime = new OrcaRuntimeService(store)
      const desktopEvents: RuntimeClientEvent[] = []
      const mobileEvents: RuntimeClientEvent[] = []
      runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
      runtime.onClientEvent((event) => desktopEvents.push(event))
      runtime.onClientEvent((event) => mobileEvents.push(event), {
        consumesTerminalSideEffects: false
      })

      runtime.onPtyData('pty-remote', '\x1b]0;Codex working\x07', 100)
      runtime.notifyBranchRenamed(TEST_REPO_ID)

      expect(desktopEvents.map((event) => event.type)).toEqual([
        'terminalSideEffects',
        'worktreesChanged'
      ])
      expect(mobileEvents.map((event) => event.type)).toEqual(['worktreesChanged'])
    })

    it('keeps a phone-only host producing title state without emitting batches to it', async () => {
      vi.useFakeTimers()
      try {
        const ptyId = `${TEST_REPO_ID}::/tmp/worktree-a@@pty-a`
        const runtime = new OrcaRuntimeService(store)
        const mobileEvents: RuntimeClientEvent[] = []
        const trackerEntries = (
          runtime as unknown as {
            ptyTitleTrackersByPtyId: Map<string, { commandCodeDetector: unknown }>
          }
        ).ptyTitleTrackersByPtyId
        runtime.setPtyController({
          write: () => true,
          kill: () => true,
          getForegroundProcess: async () => null,
          listProcesses: async () => [{ id: ptyId, cwd: '/tmp/worktree-a', title: 'shell' }]
        })
        runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
        runtime.onClientEvent((event) => mobileEvents.push(event), {
          consumesTerminalSideEffects: false
        })
        const unsubscribeDesktop = runtime.onClientEvent(() => {})

        runtime.onPtyData(ptyId, '\x1b]0;Codex working\x07', 100)
        runtime.onPtyData(ptyId, 'output without a title\r\n', 101)
        // The phone is still subscribed: disposing trackers on this edge would cancel
        // its armed stale-working-title timer and strand a 'working' spinner (#1437).
        unsubscribeDesktop()

        await vi.advanceTimersByTimeAsync(3_000)

        expect(trackerEntries.has(ptyId)).toBe(true)
        expect(trackerEntries.get(ptyId)?.commandCodeDetector).toBeNull()
        expect((await runtime.listTerminals()).terminals[0]).toMatchObject({ title: 'Codex' })
        expect(mobileEvents.some((event) => event.type === 'terminalSideEffects')).toBe(false)
      } finally {
        vi.useRealTimers()
      }
    })

    it('skips a listener unsubscribed mid-fan-out even with mobile exclusions active', () => {
      const runtime = new OrcaRuntimeService(store)
      const lateEvents: RuntimeClientEvent[] = []
      runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
      runtime.onClientEvent(() => {}, { consumesTerminalSideEffects: false })
      runtime.onClientEvent(() => {
        unsubscribeLate()
      })
      const unsubscribeLate = runtime.onClientEvent((event) => lateEvents.push(event))

      runtime.onPtyData('pty-remote', '\x1b]0;Codex working\x07', 100)

      expect(lateEvents).toEqual([])
    })

    it('emits one batched event per chunk with facts in byte order and attribution', () => {
      const { runtime, batches } = createSideEffectRuntime()
      syncSinglePty(runtime)

      const chunk = '\x1b]0;Codex working\x07response\x1b]0;Codex done\x07\x07'
      runtime.onPtyData('pty-1', chunk, 100)

      expect(batches).toHaveLength(1)
      expect(batches[0]).toMatchObject({
        ptyId: 'pty-1',
        seq: chunk.length,
        worktreeId: TEST_WORKTREE_ID,
        tabId: 'tab-1',
        paneKey: 'tab-1:1'
      })
      expect(batches[0].replay).toBeUndefined()
      expect(batches[0].facts).toEqual([
        { kind: 'title', normalizedTitle: 'Codex working', rawTitle: 'Codex working' },
        { kind: 'agent-working' },
        { kind: 'title', normalizedTitle: 'Codex done', rawTitle: 'Codex done' },
        { kind: 'agent-idle', title: 'Codex done' },
        { kind: 'bell' }
      ])
    })

    it('keeps per-PTY ordering across chunks and accumulates seq', () => {
      const { runtime, batches } = createSideEffectRuntime()
      syncSinglePty(runtime)

      runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07', 100)
      runtime.onPtyData('pty-1', '\x1b]0;Codex done\x07', 101)

      expect(batches.map((batch) => batch.facts[0]?.kind)).toEqual(['title', 'title'])
      expect(batches[0].seq).toBeLessThan(batches[1].seq)
    })

    it('emits only agent-status facts for status-only chunks', () => {
      const { runtime, batches } = createSideEffectRuntime()
      syncSinglePty(runtime)

      // Plain output and a BEL-terminated non-title OSC stay fact-free.
      runtime.onPtyData('pty-1', 'plain output\r\n', 100)
      runtime.onPtyData('pty-1', '\x1b]7;file://host', 101)
      runtime.onPtyData('pty-1', '/tmp\x07', 102)
      runtime.onPtyData('pty-1', '\x1b]9999;{"state":"working","agentType":"codex"}\x07', 103)

      expect(batches).toHaveLength(1)
      expect(batches[0].facts).toEqual([
        {
          kind: 'agent-status',
          payload: expect.objectContaining({ state: 'working', agentType: 'codex' })
        }
      ])
    })

    it('emits the stale-working-title rewrite as between-chunk fact batches', async () => {
      vi.useFakeTimers()
      try {
        const { runtime, batches } = createSideEffectRuntime()
        syncSinglePty(runtime)

        runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07', 100)
        runtime.onPtyData('pty-1', 'output without a title\r\n', 101)
        batches.length = 0

        await vi.advanceTimersByTimeAsync(3_000)

        // staleWorkingTitleClear tells the renderer to clear state without scheduling a task-complete notification the unthrottled timer didn't earn.
        expect(batches.flatMap((batch) => batch.facts)).toEqual([
          {
            kind: 'title',
            normalizedTitle: 'Codex',
            rawTitle: 'Codex',
            staleWorkingTitleClear: true
          },
          { kind: 'agent-idle', title: 'Codex', staleWorkingTitleClear: true }
        ])
      } finally {
        vi.useRealTimers()
      }
    })

    it('ingests synthetic title frames without touching the byte pipeline', () => {
      const { runtime, batches } = createSideEffectRuntime()
      syncSinglePty(runtime)

      runtime.ingestSyntheticTitleFrame('pty-1', '\x1b]0;⠋ Cursor Agent\x07')

      expect(batches).toHaveLength(1)
      expect(batches[0].facts).toEqual([
        { kind: 'title', normalizedTitle: '⠋ Cursor Agent', rawTitle: '⠋ Cursor Agent' },
        // Synthesized spinner classifies as working — agent facts derive from synthetic frames the same as from real bytes.
        { kind: 'agent-working' }
      ])
      // Synthetic frames are fabricated by main, so they must not advance the metered output sequence the renderer ACK budget uses.
      expect(runtime.getPtyOutputSequence('pty-1')).toBe(0)
    })

    it('emits live Cursor identity without storing it as liveness evidence', async () => {
      const { runtime, batches } = createSideEffectRuntime()
      syncSinglePty(runtime)

      runtime.onPtyData('pty-1', '\x1b]0;Cursor Agent\x07', 100)

      expect(batches.flatMap((batch) => batch.facts)).toEqual([
        { kind: 'title', normalizedTitle: 'Cursor Agent', rawTitle: 'Cursor Agent' }
      ])
      expect((await runtime.listTerminals()).terminals[0].title).not.toBe('Cursor Agent')
      expect(runtime.getTerminalSideEffectSnapshot('pty-1')).toMatchObject({
        facts: [{ kind: 'title', normalizedTitle: 'Cursor Agent', rawTitle: 'Cursor Agent' }]
      })
    })

    it('keeps live Cursor identity in mobile titles without making it agent liveness', async () => {
      const runtime = new OrcaRuntimeService(store)
      runtime.attachWindow(1)
      runtime.syncWindowGraph(1, {
        tabs: [
          {
            tabId: 'tab-1',
            worktreeId: TEST_WORKTREE_ID,
            title: 'Terminal 1',
            activeLeafId: 'pane:1',
            layout: null
          }
        ],
        leaves: [
          {
            tabId: 'tab-1',
            worktreeId: TEST_WORKTREE_ID,
            leafId: 'pane:1',
            paneRuntimeId: 1,
            ptyId: 'pty-1'
          }
        ],
        mobileSessionTabs: [
          {
            worktree: TEST_WORKTREE_ID,
            publicationEpoch: 'epoch-cursor',
            snapshotVersion: 1,
            activeGroupId: null,
            activeTabId: 'tab-1::pane:1',
            activeTabType: 'terminal',
            tabs: [
              {
                type: 'terminal',
                id: 'tab-1::pane:1',
                parentTabId: 'tab-1',
                leafId: 'pane:1',
                ptyId: 'pty-1',
                title: 'Terminal 1',
                isActive: true
              }
            ]
          }
        ]
      })

      runtime.onPtyData('pty-1', '\x1b]0;Cursor Agent\x07', 100)

      const terminal = (await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs[0]
      expect(terminal).toMatchObject({ type: 'terminal', title: 'Cursor Agent' })
      expect(terminal).not.toHaveProperty('agentStatus')
    })

    it('lets an explicit terminal rename override cached Cursor identity and restores it after clearing', async () => {
      const runtime = new OrcaRuntimeService(store)
      runtime.setPtyController({
        spawn: vi.fn().mockResolvedValue({ id: 'pty-1' }),
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null
      })
      const created = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`)

      runtime.onPtyData('pty-1', '\x1b]0;Cursor Agent\x07', 100)
      const mobileTerminal = (
        await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
      ).tabs.find((tab) => tab.type === 'terminal')
      if (mobileTerminal?.type !== 'terminal' || !mobileTerminal.terminal) {
        throw new Error('expected mobile terminal handle')
      }
      expect(mobileTerminal.terminal).toBe(created.handle)

      await runtime.renameTerminal(mobileTerminal.terminal, 'Pinned Cursor')
      expect((await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs[0]).toMatchObject(
        { type: 'terminal', title: 'Pinned Cursor' }
      )

      await runtime.renameTerminal(mobileTerminal.terminal, null)
      expect((await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs[0]).toMatchObject(
        { type: 'terminal', title: 'Cursor Agent' }
      )
    })

    it('confirms title-based agent exits against the foreground process', async () => {
      const { runtime, batches } = createSideEffectRuntime()
      syncSinglePty(runtime)

      runtime.ingestSyntheticTitleFrame('pty-1', '\x1b]0;Codex ready\x07')
      runtime.onPtyData('pty-1', '\x1b]0;⠋ bichir\x07', 100)
      runtime.ingestSyntheticTitleFrame('pty-1', '\x1b]0;Codex ready\x07')
      batches.length = 0

      const getForegroundProcess = vi.fn().mockResolvedValueOnce('codex')
      runtime.setPtyController({
        write: () => true,
        kill: () => true,
        getForegroundProcess
      })
      runtime.onPtyData('pty-1', '\x1b]0;bichir\x07', 101)

      await vi.waitFor(() => expect(getForegroundProcess).toHaveBeenCalledOnce())
      await vi.waitFor(() =>
        expect(batches.flatMap((batch) => batch.facts)).toEqual([
          { kind: 'title', normalizedTitle: 'bichir', rawTitle: 'bichir' }
        ])
      )
      await vi.waitFor(() =>
        expect(
          (
            runtime as unknown as {
              ptyForegroundProcessReads: Map<string, unknown>
            }
          ).ptyForegroundProcessReads.size
        ).toBe(0)
      )
      await Promise.resolve()

      getForegroundProcess.mockResolvedValueOnce('zsh')
      runtime.onPtyData('pty-1', '\x1b]0;other cwd\x07', 102)

      await vi.waitFor(() =>
        expect(batches.flatMap((batch) => batch.facts)).toContainEqual({ kind: 'agent-exited' })
      )
      expect(getForegroundProcess).toHaveBeenCalledTimes(2)
    })

    it('does not confirm an agent exit from a foreground read predating its title', async () => {
      const { runtime, batches } = createSideEffectRuntime()
      syncSinglePty(runtime)
      let resolveStaleRead!: (process: string) => void
      const staleRead = new Promise<string>((resolve) => {
        resolveStaleRead = resolve
      })
      const getForegroundProcess = vi
        .fn()
        .mockReturnValueOnce(staleRead)
        .mockResolvedValueOnce('zsh')
      runtime.setPtyController({
        write: () => true,
        kill: () => true,
        getForegroundProcess
      })

      runtime.ingestSyntheticTitleFrame('pty-1', '\x1b]0;Codex ready\x07')
      runtime.onPtyData('pty-1', '\x1b]0;bichir\x07', 100)
      expect(getForegroundProcess).toHaveBeenCalledOnce()

      resolveStaleRead('codex')

      await vi.waitFor(() => expect(getForegroundProcess).toHaveBeenCalledTimes(2))
      await vi.waitFor(() =>
        expect(batches.flatMap((batch) => batch.facts)).toContainEqual({ kind: 'agent-exited' })
      )
    })

    it('treats synchronous foreground read failures as unavailable', async () => {
      const { runtime, batches } = createSideEffectRuntime()
      syncSinglePty(runtime)
      runtime.ingestSyntheticTitleFrame('pty-1', '\x1b]0;Codex ready\x07')
      const getForegroundProcess = vi.fn(() => {
        throw new TypeError('getForegroundProcess is unavailable')
      })
      runtime.setPtyController({
        write: () => true,
        kill: () => true,
        getForegroundProcess
      })

      runtime.onPtyData('pty-1', '\x1b]0;bichir\x07', 100)

      await vi.waitFor(() =>
        expect(batches.flatMap((batch) => batch.facts)).toContainEqual({ kind: 'agent-exited' })
      )
      expect(getForegroundProcess).toHaveBeenCalledOnce()
    })

    it('aligns a restored session and pre-response bytes to the provider sequence', async () => {
      const { runtime } = createSideEffectRuntime()

      // Simulate a stream-socket byte winning the race with the spawn response.
      runtime.onPtyData('pty-restored', 'queued', 100)
      expect(
        runtime.synchronizePtyOutputSequenceFromProvider(
          'pty-restored',
          { value: 900, generation: 'continued' },
          0
        )
      ).toBe(906)
      runtime.onPtyData('pty-restored', 'fresh', 101)

      expect(runtime.getPtyOutputSequence('pty-restored')).toBe(911)
      await expect(runtime.serializeMainTerminalBuffer('pty-restored')).resolves.toMatchObject({
        data: expect.stringContaining('queuedfresh'),
        seq: 911,
        source: 'headless'
      })
    })

    it('does not double a fresh daemon sequence on same-main reattach', () => {
      const { runtime } = createSideEffectRuntime()

      expect(
        runtime.synchronizePtyOutputSequenceFromProvider(
          'pty-fresh',
          { value: 0, generation: 'reset' },
          0
        )
      ).toBe(0)
      runtime.onPtyData('pty-fresh', 'fresh output', 100)
      const sequenceBeforeReattach = runtime.getPtyOutputSequence('pty-fresh')

      expect(
        runtime.synchronizePtyOutputSequenceFromProvider(
          'pty-fresh',
          { value: sequenceBeforeReattach, generation: 'continued' },
          sequenceBeforeReattach
        )
      ).toBe(sequenceBeforeReattach)
    })

    it('does not jump ahead of delayed bytes covered by a reattach snapshot', () => {
      const { runtime } = createSideEffectRuntime()
      runtime.synchronizePtyOutputSequenceFromProvider(
        'pty-delayed',
        { value: 0, generation: 'reset' },
        0
      )
      runtime.onPtyData('pty-delayed', 'before', 100)
      const sequenceBeforeReattach = runtime.getPtyOutputSequence('pty-delayed')
      const delayedCoveredBytes = 'queued'

      expect(
        runtime.synchronizePtyOutputSequenceFromProvider(
          'pty-delayed',
          {
            value: sequenceBeforeReattach + delayedCoveredBytes.length,
            generation: 'continued'
          },
          sequenceBeforeReattach
        )
      ).toBe(sequenceBeforeReattach)
      runtime.onPtyData('pty-delayed', delayedCoveredBytes, 101)

      expect(runtime.getPtyOutputSequence('pty-delayed')).toBe(
        sequenceBeforeReattach + delayedCoveredBytes.length
      )
    })

    it('retains bytes emitted before a fresh daemon spawn resolves', async () => {
      const { runtime } = createSideEffectRuntime()
      const earlyOutput = '\x1b]0;Fresh shell\x07early prompt'
      runtime.onPtyData('pty-fresh', earlyOutput, 100)

      expect(
        runtime.synchronizePtyOutputSequenceFromProvider(
          'pty-fresh',
          { value: 0, generation: 'reset' },
          0
        )
      ).toBe(earlyOutput.length)

      await expect(runtime.serializeMainTerminalBuffer('pty-fresh')).resolves.toMatchObject({
        data: expect.stringContaining('early prompt'),
        lastTitle: 'Fresh shell',
        seq: earlyOutput.length
      })
    })

    it('drops stale headless state without rewinding the runtime sequence', async () => {
      const { runtime } = createSideEffectRuntime()
      runtime.synchronizePtyOutputSequenceFromProvider(
        'pty-restarted',
        { value: 0, generation: 'reset' },
        0
      )
      runtime.onPtyData('pty-restarted', 'old generation', 100)
      const sequenceBeforeRespawn = runtime.getPtyOutputSequence('pty-restarted')

      expect(
        runtime.synchronizePtyOutputSequenceFromProvider(
          'pty-restarted',
          { value: 0, generation: 'reset' },
          sequenceBeforeRespawn
        )
      ).toBe(sequenceBeforeRespawn)
      runtime.onPtyData('pty-restarted', 'new generation', 101)

      await expect(runtime.serializeMainTerminalBuffer('pty-restarted')).resolves.toMatchObject({
        data: expect.not.stringContaining('old generation'),
        seq: sequenceBeforeRespawn + 'new generation'.length
      })
    })

    it('keeps active listener sequences monotonic across a daemon reset', () => {
      const { runtime } = createSideEffectRuntime()
      runtime.synchronizePtyOutputSequenceFromProvider(
        'pty-reset',
        { value: 0, generation: 'reset' },
        0
      )
      runtime.onPtyData('pty-reset', 'old', 100)
      const sequenceBeforeRespawn = runtime.getPtyOutputSequence('pty-reset')
      const observedSequences: number[] = []
      runtime.subscribeToTerminalData('pty-reset', (_data, meta) => {
        if (typeof meta?.seq === 'number') {
          observedSequences.push(meta.seq)
        }
      })

      runtime.onPtyData('pty-reset', 'early', 101)
      runtime.synchronizePtyOutputSequenceFromProvider(
        'pty-reset',
        { value: 0, generation: 'reset' },
        sequenceBeforeRespawn
      )
      runtime.onPtyData('pty-reset', 'later', 102)

      expect(observedSequences).toEqual([
        sequenceBeforeRespawn + 'early'.length,
        sequenceBeforeRespawn + 'early'.length + 'later'.length
      ])
    })

    it('carries the synthetic permission BEL as a bell fact', () => {
      const { runtime, batches } = createSideEffectRuntime()
      syncSinglePty(runtime)

      runtime.ingestSyntheticTitleFrame('pty-1', '\x1b]0;Cursor needs your input\x07\x07')

      expect(batches[0].facts.at(0)).toMatchObject({ kind: 'title' })
      expect(batches[0].facts.at(-1)).toEqual({ kind: 'bell' })
    })

    it('emits command-finished facts with best-effort exit codes across chunk splits', () => {
      const { runtime, batches } = createSideEffectRuntime()
      syncSinglePty(runtime)

      runtime.onPtyData('pty-1', 'output\x1b]133;D;13', 100)
      expect(batches).toEqual([])
      runtime.onPtyData('pty-1', '0\x07prompt $ ', 101)
      runtime.onPtyData('pty-1', '\x1b]133;D\x07', 102)

      expect(batches.flatMap((batch) => batch.facts)).toEqual([
        { kind: 'command-finished', exitCode: 130 },
        { kind: 'command-finished', exitCode: null }
      ])
    })

    it('emits pr-link facts once per URL with batch attribution', () => {
      const { runtime, batches } = createSideEffectRuntime()
      syncSinglePty(runtime)

      runtime.onPtyData('pty-1', 'PR https://github.com/acme/orca/pull/4', 100)
      runtime.onPtyData('pty-1', '2\r\nand https://github.com/acme/orca/pull/43 done\r\n', 101)
      // Repeated URL: deduped per PTY, like the renderer byte detector.
      runtime.onPtyData('pty-1', 'again https://github.com/acme/orca/pull/42\r\n', 102)

      expect(batches).toHaveLength(1)
      expect(batches[0]).toMatchObject({
        ptyId: 'pty-1',
        worktreeId: TEST_WORKTREE_ID,
        tabId: 'tab-1'
      })
      expect(batches[0].facts).toEqual([
        {
          kind: 'pr-link',
          link: {
            url: 'https://github.com/acme/orca/pull/42',
            slug: { owner: 'acme', repo: 'orca', host: 'github.com' },
            number: 42
          }
        },
        {
          kind: 'pr-link',
          link: {
            url: 'https://github.com/acme/orca/pull/43',
            slug: { owner: 'acme', repo: 'orca', host: 'github.com' },
            number: 43
          }
        }
      ])
    })

    it('emits 2031-subscribe facts across chunk splits', () => {
      // Why: hidden-delivery-gated views never get the bytes, so this fact is their only cue to send the DECSET 2031 color-scheme reply.
      const { runtime, batches } = createSideEffectRuntime()
      syncSinglePty(runtime)

      runtime.onPtyData('pty-1', '\x1b[?20', 100)
      expect(batches).toEqual([])
      runtime.onPtyData('pty-1', '31h', 101)

      expect(batches.flatMap((batch) => batch.facts)).toEqual([{ kind: '2031-subscribe' }])
    })

    it('restores a provisional 2031 subscribe when daemon scan authority returns', () => {
      const { runtime, batches } = createSideEffectRuntime()
      syncSinglePty(runtime)

      runtime.setPtyTransientFactDelegation('pty-1', true)
      runtime.setPtyTransientFactDelegation('pty-1', false, '\x1b[?', true)
      runtime.onPtyData('pty-1', '25h', 100)

      expect(batches.flatMap((batch) => batch.facts)).toEqual([{ kind: '2031-subscribe' }])
    })

    it('prefers the tracked title over the renderer snapshot lastTitle', async () => {
      const { runtime } = createSideEffectRuntime()
      const serializeBuffer = vi.fn().mockResolvedValue({
        data: 'visible content',
        cols: 80,
        rows: 24,
        // Renderer xterm never saw the synthetic frame (no longer rides pty:data), so its serializer reports a stale title.
        lastTitle: 'stale shell title'
      })
      runtime.setPtyController({
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null,
        serializeBuffer,
        hasRendererSerializer: () => true,
        getSize: () => ({ cols: 80, rows: 24 })
      })
      syncSinglePty(runtime)

      runtime.ingestSyntheticTitleFrame('pty-1', '\x1b]0;⠋ Cursor Agent\x07')

      const snapshot = await runtime.serializeTerminalBuffer('pty-1', { scrollbackRows: 10 })
      expect(snapshot?.source).toBe('renderer')
      expect(snapshot?.lastTitle).toBe('⠋ Cursor Agent')
    })

    it('falls back to the provider snapshot for a restored PTY with no mounted renderer', async () => {
      const { runtime } = createSideEffectRuntime()
      const serializeBuffer = vi.fn()
      const serializeProviderBuffer = vi.fn().mockResolvedValue({
        data: 'restored screen\r\n',
        scrollbackAnsi: 'restored history\r\n',
        cols: 120,
        rows: 40,
        cwd: '/projects/restored',
        seq: 900,
        source: 'headless'
      })
      runtime.setPtyController({
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null,
        serializeBuffer,
        serializeProviderBuffer,
        hasRendererSerializer: () => false
      })

      const snapshot = await runtime.serializeTerminalBuffer('pty-restored', {
        scrollbackRows: 5000
      })

      expect(serializeBuffer).not.toHaveBeenCalled()
      expect(serializeProviderBuffer).toHaveBeenCalledWith('pty-restored', {
        scrollbackRows: 5000
      })
      expect(snapshot).toEqual({
        data: 'restored screen\r\n',
        scrollbackAnsi: 'restored history\r\n',
        cols: 120,
        rows: 40,
        cwd: '/projects/restored',
        seq: 900,
        source: 'headless'
      })
    })

    it('prefers provider history over a partial headless mirror for requested snapshots', async () => {
      const { runtime } = createSideEffectRuntime()
      const serializeProviderBuffer = vi.fn().mockResolvedValue({
        data: 'authoritative screen\r\n',
        scrollbackAnsi: 'deep provider history\r\n',
        cols: 120,
        rows: 40,
        seq: 900,
        source: 'headless'
      })
      runtime.setPtyController({
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null,
        serializeProviderBuffer,
        hasRendererSerializer: () => false
      })
      syncSinglePty(runtime)
      runtime.onPtyData('pty-1', 'partial current screen\r\n', 100)

      await expect(
        runtime.serializeAuthoritativeTerminalBuffer('pty-1', { scrollbackRows: 5000 })
      ).resolves.toMatchObject({
        data: 'authoritative screen\r\n',
        scrollbackAnsi: 'deep provider history\r\n',
        seq: 900
      })
      expect(serializeProviderBuffer).toHaveBeenCalledWith('pty-1', {
        scrollbackRows: 5000
      })
    })

    it('falls back to the available mirror when authoritative provider history is unavailable', async () => {
      const { runtime } = createSideEffectRuntime()
      const serializeProviderBuffer = vi.fn().mockResolvedValue(null)
      runtime.setPtyController({
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null,
        serializeProviderBuffer,
        hasRendererSerializer: () => false
      })
      syncSinglePty(runtime)
      runtime.onPtyData('pty-1', 'partial current screen\r\n', 100)

      await expect(
        runtime.serializeAuthoritativeTerminalBuffer('pty-1', { scrollbackRows: 5000 })
      ).resolves.toMatchObject({
        data: expect.stringContaining('partial current screen'),
        source: 'headless'
      })
      expect(serializeProviderBuffer).toHaveBeenCalledWith('pty-1', {
        scrollbackRows: 5000
      })
    })

    it('bounds a hung authoritative provider acquisition and reuses its fallback', async () => {
      vi.useFakeTimers()
      try {
        let releaseProvider: (value: null) => void = () => {}
        const hungProvider = new Promise<null>((resolve) => {
          releaseProvider = resolve
        })
        const serializeProviderBuffer = vi
          .fn()
          .mockReturnValueOnce(hungProvider)
          .mockResolvedValueOnce({
            data: 'provider recovered\r\n',
            cols: 100,
            rows: 30,
            seq: 200,
            source: 'headless'
          })
        const { runtime } = createSideEffectRuntime()
        runtime.setPtyController({
          write: () => true,
          kill: () => true,
          getForegroundProcess: async () => null,
          serializeProviderBuffer,
          hasRendererSerializer: () => false
        })
        syncSinglePty(runtime)
        runtime.onPtyData('pty-1', 'available mirror\r\n', 100)

        const firstSnapshot = runtime.serializeAuthoritativeTerminalBuffer('pty-1', {
          scrollbackRows: 5000
        })
        const concurrentSnapshot = runtime.serializeAuthoritativeTerminalBuffer('pty-1', {
          scrollbackRows: 5000
        })
        expect(serializeProviderBuffer).toHaveBeenCalledOnce()
        await vi.advanceTimersByTimeAsync(AUTHORITATIVE_TERMINAL_SNAPSHOT_TIMEOUT_MS)
        await expect(firstSnapshot).resolves.toMatchObject({
          data: expect.stringContaining('available mirror'),
          source: 'headless'
        })
        await expect(concurrentSnapshot).resolves.toMatchObject({
          data: expect.stringContaining('available mirror'),
          source: 'headless'
        })

        await expect(
          runtime.serializeAuthoritativeTerminalBuffer('pty-1', { scrollbackRows: 5000 })
        ).resolves.toMatchObject({
          data: expect.stringContaining('available mirror'),
          source: 'headless'
        })
        expect(serializeProviderBuffer).toHaveBeenCalledOnce()

        releaseProvider(null)
        await vi.advanceTimersByTimeAsync(0)
        await expect(
          runtime.serializeAuthoritativeTerminalBuffer('pty-1', { scrollbackRows: 5000 })
        ).resolves.toMatchObject({
          data: 'provider recovered\r\n',
          source: 'headless'
        })
        expect(serializeProviderBuffer).toHaveBeenCalledTimes(2)
      } finally {
        vi.useRealTimers()
      }
    })

    it('falls back to provider history when a mounted renderer has not hydrated yet', async () => {
      const { runtime } = createSideEffectRuntime()
      const serializeBuffer = vi.fn().mockResolvedValue({
        data: '',
        cols: 80,
        rows: 24
      })
      const serializeProviderBuffer = vi.fn().mockResolvedValue({
        data: '',
        scrollbackAnsi: 'restored history\r\n',
        cols: 120,
        rows: 40,
        seq: 900,
        source: 'headless'
      })
      runtime.setPtyController({
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null,
        serializeBuffer,
        serializeProviderBuffer,
        hasRendererSerializer: () => true
      })

      const snapshot = await runtime.serializeTerminalBuffer('pty-restored', {
        scrollbackRows: 5000
      })

      expect(serializeBuffer).toHaveBeenCalledOnce()
      expect(serializeProviderBuffer).toHaveBeenCalledWith('pty-restored', {
        scrollbackRows: 5000
      })
      expect(snapshot).toMatchObject({
        data: '',
        scrollbackAnsi: 'restored history\r\n',
        source: 'headless'
      })
    })

    it('keeps an empty renderer snapshot when the provider has no retained content', async () => {
      const { runtime } = createSideEffectRuntime()
      const serializeProviderBuffer = vi.fn().mockResolvedValue({
        data: '',
        scrollbackAnsi: '',
        cols: 120,
        rows: 40,
        seq: 0,
        source: 'headless'
      })
      runtime.setPtyController({
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null,
        serializeBuffer: vi.fn().mockResolvedValue({ data: '', cols: 51, rows: 40 }),
        serializeProviderBuffer,
        hasRendererSerializer: () => true
      })

      const snapshot = await runtime.serializeTerminalBuffer('pty-new')

      expect(serializeProviderBuffer).toHaveBeenCalledOnce()
      expect(snapshot).toMatchObject({ data: '', cols: 51, rows: 40, source: 'renderer' })
    })

    it('does not let pre-response bytes hide restored provider history', async () => {
      const { runtime } = createSideEffectRuntime()
      const serializeProviderBuffer = vi.fn().mockResolvedValue({
        data: 'restored history\r\nqueued',
        cols: 80,
        rows: 24,
        seq: 906,
        source: 'headless'
      })
      runtime.setPtyController({
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null,
        serializeProviderBuffer,
        hasRendererSerializer: () => false
      })
      runtime.onPtyData('pty-restored', 'queued', 100)
      runtime.synchronizePtyOutputSequenceFromProvider(
        'pty-restored',
        { value: 900, generation: 'continued' },
        0
      )

      const snapshot = await runtime.serializeTerminalBuffer('pty-restored', {
        scrollbackRows: 5000
      })

      expect(snapshot?.data).toContain('restored history')
      expect(serializeProviderBuffer).toHaveBeenCalledOnce()
    })

    it('keeps restored provider history authoritative after later live output', async () => {
      const { runtime } = createSideEffectRuntime()
      const serializeProviderBuffer = vi.fn().mockResolvedValue({
        data: 'restored history\r\nlater output',
        cols: 80,
        rows: 24,
        seq: 912,
        source: 'headless'
      })
      runtime.setPtyController({
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null,
        serializeProviderBuffer,
        hasRendererSerializer: () => false
      })
      runtime.synchronizePtyOutputSequenceFromProvider(
        'pty-restored',
        { value: 900, generation: 'continued' },
        0
      )
      runtime.onPtyData('pty-restored', 'later output', 100)

      const snapshot = await runtime.serializeTerminalBuffer('pty-restored')

      expect(snapshot?.data).toContain('restored history')
      expect(serializeProviderBuffer).toHaveBeenCalledOnce()
    })

    it('uses provider alternate-screen state while a partial model is unsafe', async () => {
      const { runtime } = createSideEffectRuntime()
      runtime.setPtyController({
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null,
        serializeProviderBuffer: vi.fn().mockResolvedValue({
          data: 'restored tui',
          cols: 80,
          rows: 24,
          seq: 903,
          source: 'headless',
          alternateScreen: true
        }),
        hasRendererSerializer: () => false
      })
      runtime.onPtyData('pty-tui', 'tui', 100)
      runtime.synchronizePtyOutputSequenceFromProvider(
        'pty-tui',
        { value: 900, generation: 'continued' },
        0
      )

      await runtime.serializeTerminalBuffer('pty-tui')

      expect(runtime.isTerminalAlternateScreen('pty-tui')).toBe(true)
    })

    it('tracks live alternate-screen transitions after a provider snapshot', async () => {
      const { runtime } = createSideEffectRuntime()
      const serializeProviderBuffer = vi.fn().mockResolvedValue({
        data: 'restored tui',
        cols: 80,
        rows: 24,
        seq: 900,
        source: 'headless',
        alternateScreen: true
      })
      runtime.setPtyController({
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null,
        serializeProviderBuffer,
        hasRendererSerializer: () => false
      })
      runtime.synchronizePtyOutputSequenceFromProvider(
        'pty-tui',
        { value: 900, generation: 'continued' },
        0
      )
      await runtime.serializeTerminalBuffer('pty-tui')
      expect(runtime.isTerminalAlternateScreen('pty-tui')).toBe(true)

      runtime.onPtyData('pty-tui', '\x1b[?1049l', 100)
      expect(runtime.isTerminalAlternateScreen('pty-tui')).toBe(false)
      runtime.onPtyData('pty-tui', '\x1b[?1049h', 101)
      expect(runtime.isTerminalAlternateScreen('pty-tui')).toBe(true)
    })

    it('keeps mode transitions that race a provider snapshot response', async () => {
      const { runtime } = createSideEffectRuntime()
      let resolveProviderSnapshot:
        | ((snapshot: {
            data: string
            cols: number
            rows: number
            seq: number
            source: 'headless'
            alternateScreen: boolean
          }) => void)
        | undefined
      const serializeProviderBuffer = vi.fn(
        () =>
          new Promise<{
            data: string
            cols: number
            rows: number
            seq: number
            source: 'headless'
            alternateScreen: boolean
          }>((resolve) => {
            resolveProviderSnapshot = resolve
          })
      )
      runtime.setPtyController({
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null,
        serializeProviderBuffer,
        hasRendererSerializer: () => false
      })
      runtime.synchronizePtyOutputSequenceFromProvider(
        'pty-tui-race',
        { value: 900, generation: 'continued' },
        0
      )

      const snapshotPromise = runtime.serializeTerminalBuffer('pty-tui-race')
      await vi.waitFor(() => expect(resolveProviderSnapshot).toBeDefined())
      runtime.onPtyData('pty-tui-race', '\x1b[?1049l', 100)
      resolveProviderSnapshot?.({
        data: 'captured alt screen',
        cols: 80,
        rows: 24,
        seq: 900,
        source: 'headless',
        alternateScreen: true
      })
      await snapshotPromise

      expect(runtime.isTerminalAlternateScreen('pty-tui-race')).toBe(false)
    })

    it('translates reset provider snapshots without retaining the old title', async () => {
      const { runtime } = createSideEffectRuntime()
      runtime.synchronizePtyOutputSequenceFromProvider(
        'pty-replaced',
        { value: 0, generation: 'reset' },
        0
      )
      runtime.onPtyData('pty-replaced', '\x1b]0;Old process\x07old', 100)
      const sequenceBeforeRespawn = runtime.getPtyOutputSequence('pty-replaced')
      runtime.setPtyController({
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null,
        serializeProviderBuffer: vi.fn().mockResolvedValue({
          data: 'new process',
          cols: 80,
          rows: 24,
          seq: 'new process'.length,
          source: 'headless',
          lastTitle: 'New process'
        }),
        hasRendererSerializer: () => false
      })
      runtime.synchronizePtyOutputSequenceFromProvider(
        'pty-replaced',
        { value: 0, generation: 'reset' },
        sequenceBeforeRespawn
      )

      await expect(runtime.serializeTerminalBuffer('pty-replaced')).resolves.toMatchObject({
        lastTitle: 'New process',
        seq: sequenceBeforeRespawn + 'new process'.length
      })
    })

    it('prefers the tracked title over the headless emulator lastTitle', async () => {
      const { runtime } = createSideEffectRuntime()
      syncSinglePty(runtime)

      runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07real output\r\n', 100)
      // Hook-driven idle frame lands only in main's tracker; the emulator never sees fabricated bytes (invariant 5).
      runtime.ingestSyntheticTitleFrame('pty-1', '\x1b]0;Codex ready\x07')

      const snapshot = await runtime.serializeMainTerminalBuffer('pty-1', { scrollbackRows: 10 })
      expect(snapshot?.source).toBe('headless')
      expect(snapshot?.lastTitle).toBe('Codex ready')
    })

    it('returns a title-only replay snapshot and never historical attention', () => {
      const { runtime } = createSideEffectRuntime()
      syncSinglePty(runtime)

      runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07\x07', 100)

      expect(runtime.getTerminalSideEffectSnapshot('pty-1')).toMatchObject({
        ptyId: 'pty-1',
        replay: true,
        facts: [{ kind: 'title', normalizedTitle: 'Codex working', rawTitle: 'Codex working' }]
      })
      expect(runtime.getTerminalSideEffectSnapshot('pty-unknown')).toBeNull()
    })

    it('keeps the cursor-agent literal in record-fallback snapshots only without a tracker title', () => {
      const { runtime } = createSideEffectRuntime()
      syncSinglePty(runtime)

      runtime.onPtyData('pty-1', 'plain output\n', 100)
      // Simulate a record title restored by a path that bypassed the tracker.
      const records = (
        runtime as unknown as {
          ptysById: Map<string, { lastOscTitle: string | null }>
        }
      ).ptysById
      records.get('pty-1')!.lastOscTitle = 'Cursor Agent'

      // Why: a hookless Cursor pane has no other identity to restore (#10258).
      expect(runtime.getTerminalSideEffectSnapshot('pty-1')).toMatchObject({
        facts: [{ kind: 'title', normalizedTitle: 'Cursor Agent', rawTitle: 'Cursor Agent' }]
      })

      // A synthesized Cursor title owns the pane; the bare literal must not replay over it.
      runtime.ingestSyntheticTitleFrame('pty-1', '\x1b]0;⠋ Cursor Agent\x07')

      expect(runtime.getTerminalSideEffectSnapshot('pty-1')).toMatchObject({
        facts: [{ kind: 'title', normalizedTitle: '⠋ Cursor Agent', rawTitle: '⠋ Cursor Agent' }]
      })
    })

    it('emits the chunk agentStatus events before its side-effect batch', () => {
      // Cross-channel contract order per chunk: status → titles → bell.
      const order: string[] = []
      const runtime = new OrcaRuntimeService(store, undefined, {
        onTerminalAgentStatus: () => order.push('agentStatus:set'),
        onTerminalSideEffects: () => order.push('pty:sideEffect')
      })
      syncSinglePty(runtime)

      runtime.onPtyData(
        'pty-1',
        '\x1b]9999;{"state":"working","agentType":"codex"}\x07\x1b]0;Codex working\x07\x07',
        100
      )

      expect(order).toEqual(['agentStatus:set', 'pty:sideEffect'])
    })

    it('still emits a throwing chunk’s facts under its own seq, not the next chunk’s', () => {
      const { runtime, batches } = createSideEffectRuntime()
      syncSinglePty(runtime)
      vi.spyOn(
        runtime as unknown as { applyTrackedPtyTitle: (ptyId: string, title: string) => boolean },
        'applyTrackedPtyTitle'
      ).mockImplementationOnce(() => {
        throw new Error('tracker boom')
      })

      const first = '\x1b]0;Codex working\x07'
      expect(() => runtime.onPtyData('pty-1', first, 100)).toThrow('tracker boom')
      runtime.onPtyData('pty-1', '\x1b]0;Codex done\x07', 101)

      expect(batches).toHaveLength(2)
      expect(batches[0].seq).toBe(first.length)
      expect(batches[0].facts).toEqual([
        { kind: 'title', normalizedTitle: 'Codex working', rawTitle: 'Codex working' }
      ])
      // Next chunk's batch carries only its own facts: the throw aborted the first chunk's tracker pass, so no working state kept.
      expect(batches[1].seq).toBeGreaterThan(batches[0].seq)
      expect(batches[1].facts).toEqual([
        { kind: 'title', normalizedTitle: 'Codex done', rawTitle: 'Codex done' }
      ])
    })

    it('parses synthetic frames statelessly so ticks cannot corrupt the bell detector', () => {
      const { runtime, batches } = createSideEffectRuntime()
      syncSinglePty(runtime)

      runtime.onPtyData('pty-1', '\x1b]0;split ti', 100)
      // An 80ms spinner tick lands between the two halves of the real OSC.
      runtime.ingestSyntheticTitleFrame('pty-1', '\x1b]0;⠋ Cursor Agent\x07')
      // Continuation: this BEL terminates the real OSC — it is NOT a bell.
      runtime.onPtyData('pty-1', 'tle\x07', 101)
      // A later standalone BEL is a real bell and must not be swallowed.
      runtime.onPtyData('pty-1', 'ready\x07', 102)

      expect(batches.flatMap((batch) => batch.facts)).toEqual([
        { kind: 'title', normalizedTitle: '⠋ Cursor Agent', rawTitle: '⠋ Cursor Agent' },
        { kind: 'agent-working' },
        { kind: 'title', normalizedTitle: 'split title', rawTitle: 'split title' },
        { kind: 'bell' }
      ])
    })

    it('touches mobile snapshots once for decorative spinner ticks, again on idle', () => {
      const { runtime } = createSideEffectRuntime()
      syncSinglePty(runtime)
      const touchSpy = vi.spyOn(
        runtime as unknown as { touchMobileSessionSnapshotsForPty: (ptyId: string) => void },
        'touchMobileSessionSnapshotsForPty'
      )

      for (const frame of ['⠋', '⠙', '⠹', '⠸', '⠼']) {
        runtime.ingestSyntheticTitleFrame('pty-1', `\x1b]0;${frame} Cursor Agent\x07`)
      }
      // Five ticks with the same de-spinnered title: one snapshot fan-out.
      expect(touchSpy).toHaveBeenCalledTimes(1)

      runtime.ingestSyntheticTitleFrame('pty-1', '\x1b]0;Cursor ready\x07')
      expect(touchSpy).toHaveBeenCalledTimes(2)
      // Raw record titles still track every frame for worktree ps/mobile tabs.
      expect(
        (
          runtime as unknown as {
            ptysById: Map<string, { lastOscTitle: string | null }>
          }
        ).ptysById.get('pty-1')?.lastOscTitle
      ).toBe('Cursor ready')
    })

    it('seeds the lazily created tracker from the daemon-snapshot title', async () => {
      const { runtime, batches } = createSideEffectRuntime()
      const serializeBuffer = vi.fn().mockResolvedValue({
        data: 'restored scrollback\n',
        cols: 80,
        rows: 24,
        lastTitle: 'Codex working'
      })
      runtime.setPtyController({
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null,
        serializeBuffer,
        hasRendererSerializer: () => true,
        getSize: () => ({ cols: 80, rows: 24 })
      })
      syncSinglePty(runtime)

      // First live chunk creates the tracker cold and kicks off hydration; the snapshot seed must land in that tracker.
      runtime.onPtyData('pty-1', 'plain output without a title\n', 100)
      await runtime.serializeMainTerminalBuffer('pty-1', { scrollbackRows: 10 })
      batches.length = 0

      runtime.onPtyData('pty-1', '\x1b]0;Codex done\x07', 101)

      // Without the seed the tracker never saw 'working', so this idle title could not produce a completion fact.
      expect(batches.flatMap((batch) => batch.facts)).toContainEqual({
        kind: 'agent-idle',
        title: 'Codex done'
      })
    })

    it('arms the stale-title timer for a seeded working title', async () => {
      vi.useFakeTimers()
      try {
        const { runtime, batches } = createSideEffectRuntime()
        const serializeBuffer = vi.fn().mockResolvedValue({
          data: 'restored scrollback\n',
          cols: 80,
          rows: 24,
          lastTitle: 'Codex working'
        })
        runtime.setPtyController({
          write: () => true,
          kill: () => true,
          getForegroundProcess: async () => null,
          serializeBuffer,
          hasRendererSerializer: () => true,
          getSize: () => ({ cols: 80, rows: 24 })
        })
        syncSinglePty(runtime)

        runtime.onPtyData('pty-1', 'plain output\n', 100)
        // Settle the async daemon-snapshot hydration that seeds the tracker.
        await vi.advanceTimersByTimeAsync(0)
        runtime.onPtyData('pty-1', 'still no title\n', 101)
        batches.length = 0

        await vi.advanceTimersByTimeAsync(3_000)

        expect(batches.flatMap((batch) => batch.facts)).toEqual([
          {
            kind: 'title',
            normalizedTitle: 'Codex',
            rawTitle: 'Codex',
            staleWorkingTitleClear: true
          },
          { kind: 'agent-idle', title: 'Codex', staleWorkingTitleClear: true }
        ])
      } finally {
        vi.useRealTimers()
      }
    })

    it('emits command-code-working facts only after the banner arms the scrape', () => {
      const { runtime, batches } = createSideEffectRuntime()
      syncSinglePty(runtime)

      // Generic status words without the Command Code banner must not arm.
      runtime.onPtyData('pty-1', '❯ Fix the spinner\r\nThinking...', 100)
      expect(batches.flatMap((batch) => batch.facts)).toEqual([])

      runtime.onPtyData('pty-1', '# Command Code v0.27.3\r\n', 101)
      runtime.onPtyData('pty-1', '❯ Fix the spinner\r\n\x1b[35m✻ Thinking...\x1b[0m', 102)

      expect(batches.at(-1)).toMatchObject({
        ptyId: 'pty-1',
        worktreeId: TEST_WORKTREE_ID,
        tabId: 'tab-1'
      })
      expect(batches.at(-1)?.facts).toEqual([
        { kind: 'command-code-working', prompt: 'Fix the spinner' }
      ])
    })

    it('emits a command-code-done fact when the idle composer returns', () => {
      const { runtime, batches } = createSideEffectRuntime()
      syncSinglePty(runtime)

      runtime.onPtyData('pty-1', '# Command Code v0.27.3\r\n', 100)
      runtime.onPtyData('pty-1', '❯ say hi\r\n✻ Thinking...', 101)
      runtime.onPtyData(
        'pty-1',
        '\r\n✻ Thought for 1 second\r\n:: Hi!\r\n❯ Ask your question...',
        102
      )

      expect(batches.at(-1)?.facts).toEqual([{ kind: 'command-code-done', prompt: 'say hi' }])
    })

    it('arms the Command Code scrape from the noted spawn command', () => {
      const { runtime, batches } = createSideEffectRuntime()
      syncSinglePty(runtime)

      // Mirrors the renderer detector's startupCommand fast-arm: no banner needed when main saw the launch command at spawn.
      runtime.noteTerminalSpawnCommand('pty-1', 'command-code --trust')
      runtime.onPtyData('pty-1', '❯ Fix the spinner\r\n✻ Thinking...', 100)

      expect(batches.flatMap((batch) => batch.facts)).toContainEqual({
        kind: 'command-code-working',
        prompt: 'Fix the spinner'
      })
    })

    it('prefers the tracked title over a stale renderer lastTitle in the hydration seed', async () => {
      const { runtime } = createSideEffectRuntime()
      const serializeBuffer = vi.fn().mockResolvedValue({
        data: 'renderer scrollback\n',
        cols: 80,
        rows: 24,
        // Renderer xterm never saw the synthetic hook frame (no longer rides pty:data), so its serializer reports the pre-agent title.
        lastTitle: 'stale shell title'
      })
      runtime.setPtyController({
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null,
        serializeBuffer,
        hasRendererSerializer: () => true,
        getSize: () => ({ cols: 80, rows: 24 })
      })
      syncSinglePty(runtime)

      runtime.ingestSyntheticTitleFrame('pty-1', '\x1b]0;⠋ Claude working\x07')
      // First live chunk kicks off renderer hydration; awaiting the snapshot below settles the seed write chain.
      runtime.onPtyData('pty-1', 'plain output\n', 100)
      await runtime.serializeMainTerminalBuffer('pty-1', { scrollbackRows: 10 })

      const leaves = (
        runtime as unknown as { leaves: Map<string, { lastOscTitle: string | null }> }
      ).leaves
      // The seed must not stomp the leaf record (worktree ps status source) back to the renderer's stale title.
      expect([...leaves.values()][0]?.lastOscTitle).toBe('⠋ Claude working')
    })
  })

  it('returns OSC titles from headless main terminal snapshots', async () => {
    const runtime = createRuntime()
    syncSinglePty(runtime, 'pty-1')

    runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07hello\n', 100)

    const snapshot = await runtime.serializeMainTerminalBuffer('pty-1', { scrollbackRows: 1000 })
    expect(snapshot).toMatchObject({
      source: 'headless',
      lastTitle: 'Codex working'
    })
  })

  it('resizes the headless mirror after an accepted desktop PTY resize', async () => {
    const spawn = { cols: 80, rows: 24 }
    const resized = { cols: 120, rows: 30 }
    let currentSize = spawn
    const runtime = createRuntime()
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      getSize: () => currentSize
    })
    syncSinglePty(runtime, 'pty-1')

    runtime.onPtyData('pty-1', 'user@host % claude\r\n', 100)
    currentSize = resized
    runtime.onExternalPtyResize('pty-1', resized.cols, resized.rows)
    for (let index = 0; index < 5; index += 1) {
      runtime.onPtyData('pty-1', makeStatusFrame(index, index === 0), 200 + index)
    }

    const snapshot = await runtime.serializeMainTerminalBuffer('pty-1', { scrollbackRows: 5000 })
    expect(snapshot).toMatchObject({ cols: resized.cols, rows: resized.rows, source: 'headless' })
    await expect(parseHeadlessSnapshotLines(snapshot!, resized)).resolves.toEqual(
      await referenceStatusFrameLines(spawn, resized)
    )
  })

  it('orders headless mirror resizes behind queued PTY writes', async () => {
    const spawn = { cols: 80, rows: 10 }
    const resized = { cols: 120, rows: 10 }
    let currentSize = spawn
    const runtime = createRuntime()
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      getSize: () => currentSize,
      resize: () => {
        currentSize = resized
        return true
      }
    })
    syncSinglePty(runtime, 'pty-1')
    runtime.onPtyData('pty-1', 'prompt\r\n', 100)
    await runtime.serializeMainTerminalBuffer('pty-1')

    type HeadlessStateForTest = {
      emulator: HeadlessEmulator
      writeChain: Promise<void>
    }
    const headless = (
      runtime as unknown as { headlessTerminals: Map<string, HeadlessStateForTest> }
    ).headlessTerminals.get('pty-1')
    expect(headless).toBeDefined()
    const originalWrite = headless!.emulator.write.bind(headless!.emulator)
    const queuedWriteStarted = makeDeferred()
    const releaseQueuedWrite = makeDeferred()
    headless!.emulator.write = async (data: string): Promise<void> => {
      queuedWriteStarted.resolve()
      await releaseQueuedWrite.promise
      await originalWrite(data)
    }

    try {
      runtime.onPtyData('pty-1', '\x1b[90GOLD', 200)
      await queuedWriteStarted.promise
      await runtime.updateDesktopViewport('pty-1', resized)
      runtime.onPtyData('pty-1', '\r\nNEXT', 300)
      releaseQueuedWrite.resolve()

      const snapshot = await runtime.serializeMainTerminalBuffer('pty-1', { scrollbackRows: 100 })
      expect(snapshot).toMatchObject({ cols: resized.cols, rows: resized.rows })
      await expect(parseHeadlessSnapshotLines(snapshot!, resized)).resolves.toEqual([
        'prompt',
        '                                                                               O',
        'LD',
        'NEXT'
      ])
    } finally {
      headless!.emulator.write = originalWrite
      releaseQueuedWrite.resolve()
    }
  })

  it('adopts renderer-seeded titles into headless main terminal snapshots', async () => {
    const artifactPath = '/tmp/renderer-seeded-artifact.json'
    const serializeBuffer = vi.fn().mockResolvedValue({
      data: `renderer scrollback\nwrote ${artifactPath}\n`,
      cols: 100,
      rows: 30,
      lastTitle: 'Renderer seeded Codex'
    })
    const runtime = createRuntime()
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      serializeBuffer,
      hasRendererSerializer: () => true,
      getSize: () => ({ cols: 100, rows: 30 })
    })
    syncSinglePty(runtime, 'pty-1')
    const [terminal] = (await runtime.listTerminals()).terminals

    runtime.onPtyData('pty-1', 'live output without title\n', 100)

    const snapshot = await runtime.serializeMainTerminalBuffer('pty-1', { scrollbackRows: 1000 })
    expect(snapshot).toMatchObject({
      source: 'headless',
      lastTitle: 'Renderer seeded Codex'
    })
    expect(serializeBuffer).toHaveBeenCalledWith('pty-1', {
      scrollbackRows: expect.any(Number),
      altScreenForcesZeroRows: true
    })
    expect(runtime.hasRecentTerminalOutputPath(terminal.handle, artifactPath, artifactPath)).toBe(
      true
    )
  })

  it('returns cwd metadata from seeded headless main terminal snapshots', async () => {
    const runtime = createRuntime()
    syncSinglePty(runtime, 'pty-1')
    const [terminal] = (await runtime.listTerminals()).terminals
    const artifactPath = '/tmp/restored-scrollback-artifact.json'

    runtime.seedHeadlessTerminal(
      'pty-1',
      `restored scrollback\nwrote ${artifactPath}\n`,
      { cols: 100, rows: 30 },
      {
        cwd: '/projects/restored'
      }
    )

    const snapshot = await runtime.serializeMainTerminalBuffer('pty-1', { scrollbackRows: 1000 })
    expect(snapshot).toMatchObject({
      source: 'headless',
      cwd: '/projects/restored'
    })
    expect(runtime.hasRecentTerminalOutputPath(terminal.handle, artifactPath, artifactPath)).toBe(
      true
    )
  })

  it('resolves paths without candidate activation via the lazy safety net', async () => {
    const runtime = createRuntime()
    syncSinglePty(runtime, 'pty-1')
    const [terminal] = (await runtime.listTerminals()).terminals
    const artifactPath = '/tmp/lazy-activation-artifact.json'

    runtime.onPtyData('pty-1', `wrote ${artifactPath}\n`, 100)

    // No mobile connect ever happened; the query itself must activate+backfill.
    expect(runtime.hasRecentTerminalOutputPath(terminal.handle, artifactPath, artifactPath)).toBe(
      true
    )
  })

  it('backfills candidates on activation so scrolled-off paths still resolve', async () => {
    const runtime = createRuntime()
    syncSinglePty(runtime, 'pty-1')
    const [terminal] = (await runtime.listTerminals()).terminals
    const artifactPath = '/tmp/backfilled-artifact.json'

    // Path arrives while tracking is inactive (desktop-only phase).
    runtime.onPtyData('pty-1', `wrote ${artifactPath}\n`, 100)
    // First mobile connect: backfill from the retained raw window.
    runtime.activateRecentPtyPathCandidateTracking()
    // Scroll the raw 64KB window past the path with pathless output.
    runtime.onPtyData('pty-1', 'x'.repeat(70 * 1024), 200)

    // Only the backfilled candidate tier can answer now.
    expect(runtime.hasRecentTerminalOutputPath(terminal.handle, artifactPath, artifactPath)).toBe(
      true
    )
  })

  it('backfills per retained chunk so chunk boundaries match the eager extractor', async () => {
    const runtime = createRuntime()
    syncSinglePty(runtime, 'pty-1')
    const [terminal] = (await runtime.listTerminals()).terminals
    const artifactPath = '/tmp/a.json'

    // Two chunks whose join would parse as one different candidate
    // (/tmp/a.jsonsuffix.txt). The eager per-chunk extractor kept /tmp/a.json.
    runtime.onPtyData('pty-1', `wrote ${artifactPath}`, 100)
    runtime.onPtyData('pty-1', 'suffix.txt', 150)
    runtime.activateRecentPtyPathCandidateTracking()
    // Scroll the raw 64KB window so only the backfilled candidates can answer.
    runtime.onPtyData('pty-1', 'x'.repeat(70 * 1024), 200)

    expect(runtime.hasRecentTerminalOutputPath(terminal.handle, artifactPath, artifactPath)).toBe(
      true
    )
  })

  it('extracts candidates per chunk after activation for scrolled-off paths', async () => {
    const runtime = createRuntime()
    syncSinglePty(runtime, 'pty-1')
    const [terminal] = (await runtime.listTerminals()).terminals
    const artifactPath = '/tmp/post-activation-artifact.json'

    runtime.activateRecentPtyPathCandidateTracking()
    // Idempotent: a second activation must not disturb live tracking.
    runtime.activateRecentPtyPathCandidateTracking()
    runtime.onPtyData('pty-1', `wrote ${artifactPath}\n`, 100)
    runtime.onPtyData('pty-1', 'x'.repeat(70 * 1024), 200)

    expect(runtime.hasRecentTerminalOutputPath(terminal.handle, artifactPath, artifactPath)).toBe(
      true
    )
  })

  it('does not retain pre-activation paths that scrolled past the raw window', async () => {
    const runtime = createRuntime()
    syncSinglePty(runtime, 'pty-1')
    const [terminal] = (await runtime.listTerminals()).terminals
    const artifactPath = '/tmp/pre-activation-scrolled-artifact.json'

    runtime.onPtyData('pty-1', `wrote ${artifactPath}\n`, 100)
    runtime.onPtyData('pty-1', 'x'.repeat(70 * 1024), 200)

    // Documented accepted loss: output that scrolled past the raw window
    // before the first-ever mobile connect yields no candidates.
    expect(runtime.hasRecentTerminalOutputPath(terminal.handle, artifactPath, artifactPath)).toBe(
      false
    )
  })

  it('backfill does not mint candidates from an over-limit line shortened by the window trim', async () => {
    const runtime = createRuntime()
    syncSinglePty(runtime, 'pty-1')
    const [terminal] = (await runtime.listTerminals()).terminals
    const artifactPath = '/tmp/result.json'

    // One chunk with a >4KiB line whose tail is the path: the eager
    // extractor skipped it under the line-length guard.
    runtime.onPtyData('pty-1', `${'a'.repeat(5000)} ${artifactPath}\n`, 100)
    // Newline-free filler trims the window to ~1KiB before the path, so a
    // trimmed-head replay would see an under-limit line ending in the path.
    runtime.onPtyData('pty-1', 'y'.repeat(64 * 1024 - 1000), 150)
    runtime.activateRecentPtyPathCandidateTracking()
    // Scroll the raw window so only backfilled candidates can answer.
    runtime.onPtyData('pty-1', 'x'.repeat(70 * 1024), 200)

    // Parity with eager extraction: the over-limit line never yielded a
    // candidate, so the grant must stay denied after the raw window scrolls.
    expect(runtime.hasRecentTerminalOutputPath(terminal.handle, artifactPath, artifactPath)).toBe(
      false
    )
  })

  it('backfill replays the full head chunk including its window-trimmed prefix', async () => {
    const runtime = createRuntime()
    syncSinglePty(runtime, 'pty-1')
    const [terminal] = (await runtime.listTerminals()).terminals
    const artifactPath = '/tmp/trimmed-prefix-artifact.json'

    // Path sits in the head chunk's prefix, which the window trim drops from
    // read() but the eager extractor saw at append time.
    runtime.onPtyData('pty-1', `wrote ${artifactPath}\n${'b'.repeat(3000)}\n`, 100)
    runtime.onPtyData('pty-1', 'y'.repeat(64 * 1024 - 1000), 150)
    runtime.activateRecentPtyPathCandidateTracking()
    runtime.onPtyData('pty-1', 'x'.repeat(70 * 1024), 200)

    // Parity with eager extraction: the append-time candidate outlived the
    // raw window, so backfill must recover it from the intact head chunk.
    expect(runtime.hasRecentTerminalOutputPath(terminal.handle, artifactPath, artifactPath)).toBe(
      true
    )
  })

  it('matches eager extraction exactly for a pre-sliced oversized chunk', async () => {
    const runtime = createRuntime()
    syncSinglePty(runtime, 'pty-1')
    const [terminal] = (await runtime.listTerminals()).terminals
    const cutLinePath = '/tmp/cut-line.json'
    const keptPath = '/tmp/kept-after-cut.json'

    // Single >64KiB append is stored pre-sliced, so its original text is
    // unrecoverable at activation time. Extraction runs eagerly at append
    // instead: cutLinePath sat on an over-4KiB line the extractor's line
    // guard rejects (and the slice leaves an under-4KiB tail of it that must
    // NOT mint a candidate later), while keptPath sat on a short line and
    // must survive the raw window scrolling.
    const keptLine = `wrote ${keptPath}\n`
    const afterFirstLine = `${keptLine}${'z'.repeat(62 * 1024 - keptLine.length)}`
    const oversized = `${'a'.repeat(5 * 1024)} ${cutLinePath}\n${afterFirstLine}`
    runtime.onPtyData('pty-1', oversized, 100)
    runtime.activateRecentPtyPathCandidateTracking()
    runtime.onPtyData('pty-1', 'x'.repeat(70 * 1024), 200)

    expect(runtime.hasRecentTerminalOutputPath(terminal.handle, cutLinePath, cutLinePath)).toBe(
      false
    )
    expect(runtime.hasRecentTerminalOutputPath(terminal.handle, keptPath, keptPath)).toBe(true)
  })

  it('keeps a candidate from the short first line of an oversized chunk after the window scrolls', async () => {
    const runtime = createRuntime()
    syncSinglePty(runtime, 'pty-1')
    const [terminal] = (await runtime.listTerminals()).terminals
    const artifactPath = '/tmp/result.json'

    // A short first line of a >64KiB chunk loses only its `wrote ` prefix to
    // the pre-slice; the path itself stays in the retained window. The old
    // eager extractor recorded it from the intact original chunk, so it must
    // stay authorized after the raw window scrolls — parity requires the
    // append-time extraction for oversized chunks, not backfill replay.
    const firstLine = `wrote ${artifactPath}\n`
    runtime.onPtyData('pty-1', `${firstLine}${'f'.repeat(64 * 1024 + 6 - firstLine.length)}`, 100)
    runtime.activateRecentPtyPathCandidateTracking()
    runtime.onPtyData('pty-1', 'x'.repeat(70 * 1024), 200)

    expect(runtime.hasRecentTerminalOutputPath(terminal.handle, artifactPath, artifactPath)).toBe(
      true
    )
  })

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

  it('reads bounded terminal output and writes through the PTY controller', async () => {
    const writes: string[] = []
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: (_ptyId, data) => {
        writes.push(data)
        return true
      },
      kill: () => true,
      getForegroundProcess: async () => null
    })

    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          title: 'Claude',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-1'
        }
      ]
    })
    runtime.onPtyData('pty-1', '\u001b[32mhello\u001b[0m\nworld\n', 123)

    const [terminal] = (await runtime.listTerminals()).terminals
    const read = await runtime.readTerminal(terminal.handle)
    expect(read).toMatchObject({
      handle: terminal.handle,
      status: 'running',
      tail: ['hello', 'world'],
      truncated: false,
      nextCursor: expect.any(String)
    })

    const send = await runtime.sendTerminal(terminal.handle, {
      text: 'continue',
      enter: true
    })
    expect(send).toMatchObject({
      handle: terminal.handle,
      accepted: true
    })
    expect(writes).toEqual(['continue', '\r'])
  })

  it('reports permission from blocked terminal wait text', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-1' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const leafId = '11111111-1111-4111-8111-111111111111'
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'repo terminal',
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
    runtime.onPtyData('pty-1', 'Hooks need review. Press enter to confirm\n', 123)

    const [terminal] = (await runtime.listTerminals()).terminals

    await expect(runtime.getTerminalAgentStatus(terminal.handle)).resolves.toEqual({
      handle: terminal.handle,
      isRunningAgent: true,
      status: 'permission'
    })
  })

  it('keeps blocked prompt text authoritative over an OpenCode marker', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-1' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'opencode'
    })
    const leafId = '11111111-1111-4111-8111-111111111111'
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'OC | Native session',
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
          ptyId: 'pty-1',
          paneTitle: 'OC | Native session'
        }
      ]
    })
    runtime.onPtyData(
      'pty-1',
      'Permission required\nThis command requires permission\nAllow once\nAllow always\nReject\n',
      123
    )
    const [terminal] = (await runtime.listTerminals()).terminals

    await expect(runtime.getTerminalAgentStatus(terminal.handle)).resolves.toEqual({
      handle: terminal.handle,
      isRunningAgent: true,
      status: 'permission'
    })
    await expect(
      runtime.waitForTerminal(terminal.handle, { condition: 'tui-idle', timeoutMs: 1_000 })
    ).resolves.toMatchObject({
      satisfied: false,
      blockedReason: 'codex-interactive-prompt'
    })
  })

  it('reports permission from blocked wait text over title-only working state', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-1' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const leafId = '11111111-1111-4111-8111-111111111111'
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Codex working',
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
    runtime.onPtyData('pty-1', 'Hooks need review. Press enter to confirm\n', 123)

    const [terminal] = (await runtime.listTerminals()).terminals

    await expect(runtime.getTerminalAgentStatus(terminal.handle)).resolves.toEqual({
      handle: terminal.handle,
      isRunningAgent: true,
      status: 'permission'
    })
  })

  it('lets a live non-permission title supersede stale blocked wait text', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-1' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const leafId = '11111111-1111-4111-8111-111111111111'
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'repo terminal',
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
    runtime.onPtyData('pty-1', 'Hooks need review. Press enter to confirm\n', 123)
    runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07', 124)

    const [terminal] = (await runtime.listTerminals()).terminals

    await expect(runtime.getTerminalAgentStatus(terminal.handle)).resolves.toEqual({
      handle: terminal.handle,
      isRunningAgent: true,
      status: 'working'
    })
  })

  it('maps fresh explicit waiting hook state to permission over a working title', async () => {
    const leafId = '11111111-1111-4111-8111-111111111111'
    const paneKey = makePaneKey('tab-1', leafId)
    const runtime = new OrcaRuntimeService(store, undefined, {
      getAgentStatusSnapshot: () => [
        {
          paneKey,
          state: 'waiting',
          prompt: '',
          agentType: 'codex',
          connectionId: null,
          receivedAt: Date.now(),
          stateStartedAt: Date.now(),
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID
        }
      ]
    })
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-1' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Codex working',
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

    const [terminal] = (await runtime.listTerminals()).terminals

    await expect(runtime.getTerminalAgentStatus(terminal.handle)).resolves.toEqual({
      handle: terminal.handle,
      isRunningAgent: true,
      status: 'permission'
    })
  })

  it('does not treat a restored-unconfirmed hook row as live terminal status', async () => {
    const leafId = '11111111-1111-4111-8111-111111111111'
    const paneKey = makePaneKey('tab-1', leafId)
    const runtime = new OrcaRuntimeService(store, undefined, {
      getAgentStatusSnapshot: () => [
        {
          paneKey,
          state: 'waiting',
          prompt: '',
          agentType: 'codex',
          connectionId: null,
          receivedAt: Date.now(),
          stateStartedAt: Date.now(),
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          restoredUnconfirmed: true
        }
      ]
    })
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-1' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'repo terminal',
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

    const [terminal] = (await runtime.listTerminals()).terminals

    await expect(runtime.getTerminalAgentStatus(terminal.handle)).resolves.toEqual({
      handle: terminal.handle,
      isRunningAgent: false,
      status: null
    })
  })

  it('does not let stale wait text override a fresh explicit working state', async () => {
    const leafId = '11111111-1111-4111-8111-111111111111'
    const paneKey = makePaneKey('tab-1', leafId)
    const runtime = new OrcaRuntimeService(store, undefined, {
      getAgentStatusSnapshot: () => [
        {
          paneKey,
          state: 'working',
          prompt: '',
          agentType: 'codex',
          connectionId: null,
          receivedAt: Date.now(),
          stateStartedAt: Date.now(),
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID
        }
      ]
    })
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-1' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Codex working',
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
    runtime.onPtyData('pty-1', 'Hooks need review. Press enter to confirm\n', 123)

    const [terminal] = (await runtime.listTerminals()).terminals

    await expect(runtime.getTerminalAgentStatus(terminal.handle)).resolves.toEqual({
      handle: terminal.handle,
      isRunningAgent: true,
      status: 'working'
    })
  })

  it('reports permission when blocked wait text is newer than explicit working state', async () => {
    const leafId = '11111111-1111-4111-8111-111111111111'
    const paneKey = makePaneKey('tab-1', leafId)
    const now = Date.now()
    const runtime = new OrcaRuntimeService(store, undefined, {
      getAgentStatusSnapshot: () => [
        {
          paneKey,
          state: 'working',
          prompt: '',
          agentType: 'codex',
          connectionId: null,
          receivedAt: now - 1000,
          stateStartedAt: now - 1000,
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID
        }
      ]
    })
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-1' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Codex working',
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
    runtime.onPtyData('pty-1', 'Hooks need review. Press enter to confirm\n', now)

    const [terminal] = (await runtime.listTerminals()).terminals

    await expect(runtime.getTerminalAgentStatus(terminal.handle)).resolves.toEqual({
      handle: terminal.handle,
      isRunningAgent: true,
      status: 'permission'
    })
  })

  it('timestamps blocked wait text when the prompt arrives across PTY chunks', async () => {
    const leafId = '11111111-1111-4111-8111-111111111111'
    const paneKey = makePaneKey('tab-1', leafId)
    const now = Date.now()
    const runtime = new OrcaRuntimeService(store, undefined, {
      getAgentStatusSnapshot: () => [
        {
          paneKey,
          state: 'working',
          prompt: '',
          agentType: 'codex',
          connectionId: null,
          receivedAt: now,
          stateStartedAt: now,
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID
        }
      ]
    })
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-1' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Codex working',
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
    runtime.onPtyData('pty-1', 'Hooks need review. ', now + 1000)
    runtime.onPtyData('pty-1', 'Press enter to confirm\n', now + 1001)

    const [terminal] = (await runtime.listTerminals()).terminals

    await expect(runtime.getTerminalAgentStatus(terminal.handle)).resolves.toEqual({
      handle: terminal.handle,
      isRunningAgent: true,
      status: 'permission'
    })
  })

  it('prefers newer explicit working state over older explicit permission state', async () => {
    const leafId = '11111111-1111-4111-8111-111111111111'
    const paneKey = makePaneKey('tab-1', leafId)
    const now = Date.now()
    const runtime = new OrcaRuntimeService(store, undefined, {
      getAgentStatusSnapshot: () => [
        {
          paneKey,
          state: 'waiting',
          prompt: '',
          agentType: 'codex',
          connectionId: null,
          receivedAt: now - 1000,
          stateStartedAt: now - 1000,
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID
        },
        {
          paneKey,
          state: 'working',
          prompt: '',
          agentType: 'codex',
          connectionId: null,
          receivedAt: now,
          stateStartedAt: now,
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID
        }
      ]
    })
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-1' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'repo terminal',
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

    const [terminal] = (await runtime.listTerminals()).terminals

    await expect(runtime.getTerminalAgentStatus(terminal.handle)).resolves.toEqual({
      handle: terminal.handle,
      isRunningAgent: true,
      status: 'working'
    })
  })

  it('prefers fresh explicit working state over a stale permission title', async () => {
    const leafId = '11111111-1111-4111-8111-111111111111'
    const paneKey = makePaneKey('tab-1', leafId)
    const runtime = new OrcaRuntimeService(store, undefined, {
      getAgentStatusSnapshot: () => [
        {
          paneKey,
          state: 'working',
          prompt: '',
          agentType: 'codex',
          connectionId: null,
          receivedAt: Date.now(),
          stateStartedAt: Date.now(),
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID
        }
      ]
    })
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-1' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Codex - action required',
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

    const [terminal] = (await runtime.listTerminals()).terminals

    await expect(runtime.getTerminalAgentStatus(terminal.handle)).resolves.toEqual({
      handle: terminal.handle,
      isRunningAgent: true,
      status: 'working'
    })
  })

  it('reports permission from a live title over fresh explicit working state', async () => {
    const leafId = '11111111-1111-4111-8111-111111111111'
    const paneKey = makePaneKey('tab-1', leafId)
    const runtime = new OrcaRuntimeService(store, undefined, {
      getAgentStatusSnapshot: () => [
        {
          paneKey,
          state: 'working',
          prompt: '',
          agentType: 'codex',
          connectionId: null,
          receivedAt: Date.now(),
          stateStartedAt: Date.now(),
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID
        }
      ]
    })
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-1' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'repo terminal',
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
          ptyId: 'pty-1',
          paneTitle: 'Codex - action required'
        }
      ]
    })

    const [terminal] = (await runtime.listTerminals()).terminals

    await expect(runtime.getTerminalAgentStatus(terminal.handle)).resolves.toEqual({
      handle: terminal.handle,
      isRunningAgent: true,
      status: 'permission'
    })
  })

  it('does not let fresh explicit hook state authorize a current shell terminal', async () => {
    const leafId = '11111111-1111-4111-8111-111111111111'
    const paneKey = makePaneKey('tab-1', leafId)
    const runtime = new OrcaRuntimeService(store, undefined, {
      getAgentStatusSnapshot: () => [
        {
          paneKey,
          state: 'working',
          prompt: '',
          agentType: 'codex',
          connectionId: null,
          receivedAt: Date.now(),
          stateStartedAt: Date.now(),
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID
        }
      ]
    })
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-1' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'zsh',
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

    const [terminal] = (await runtime.listTerminals()).terminals

    await expect(runtime.getTerminalAgentStatus(terminal.handle)).resolves.toEqual({
      handle: terminal.handle,
      isRunningAgent: false,
      status: null
    })
  })

  it('does not let fresh explicit hook state authorize a shell foreground process', async () => {
    const leafId = '11111111-1111-4111-8111-111111111111'
    const paneKey = makePaneKey('tab-1', leafId)
    const runtime = new OrcaRuntimeService(store, undefined, {
      getAgentStatusSnapshot: () => [
        {
          paneKey,
          state: 'working',
          prompt: '',
          agentType: 'codex',
          connectionId: null,
          receivedAt: Date.now(),
          stateStartedAt: Date.now(),
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID
        }
      ]
    })
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-1' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'zsh'
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'repo terminal',
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

    const [terminal] = (await runtime.listTerminals()).terminals

    await expect(runtime.getTerminalAgentStatus(terminal.handle)).resolves.toEqual({
      handle: terminal.handle,
      isRunningAgent: false,
      status: null
    })
  })

  it('uses strong provider confirmation to authorize fresh hook state over a shell foreground', async () => {
    const getForegroundProcess = vi.fn(async () => 'powershell.exe')
    const confirmForegroundProcess = vi.fn(async () => 'claude')
    const { runtime, handle } = await createExplicitAgentStatusHarness({
      getForegroundProcess,
      confirmForegroundProcess
    })

    await expect(runtime.getTerminalAgentStatus(handle)).resolves.toEqual({
      handle,
      isRunningAgent: true,
      status: 'working'
    })
    expect(getForegroundProcess).toHaveBeenCalledOnce()
    expect(getForegroundProcess).toHaveBeenCalledWith('pty-1')
    expect(confirmForegroundProcess).toHaveBeenCalledOnce()
    expect(confirmForegroundProcess).toHaveBeenCalledWith('pty-1')
  })

  it('preserves provider failure during completion-sensitive process inspection', async () => {
    const failure = new Error('daemon unavailable')
    const providerInspectProcess = vi.fn().mockRejectedValue(failure)
    const provider = { inspectProcess: providerInspectProcess } as unknown as IPtyProvider
    const inspectProcess = vi.fn((ptyId: string) => inspectPtyProviderProcess(provider, ptyId))
    const getForegroundProcess = vi.fn(async () => null)
    const { runtime, handle } = await createExplicitAgentStatusHarness({
      getForegroundProcess,
      inspectProcess
    })

    await expect(runtime.inspectTerminalProcess(handle)).rejects.toBe(failure)
    expect(inspectProcess).toHaveBeenCalledExactlyOnceWith('pty-1')
    expect(providerInspectProcess).toHaveBeenCalledExactlyOnceWith('pty-1')
    expect(getForegroundProcess).not.toHaveBeenCalled()
  })

  it('preserves provider unavailable results during process inspection', async () => {
    const inspection = {
      foregroundProcess: null,
      hasChildProcesses: true,
      unavailable: true as const
    }
    const inspectProcess = vi.fn(async () => inspection)
    const getForegroundProcess = vi.fn(async () => null)
    const { runtime, handle } = await createExplicitAgentStatusHarness({
      getForegroundProcess,
      inspectProcess
    })

    await expect(runtime.inspectTerminalProcess(handle)).resolves.toEqual(inspection)
    expect(inspectProcess).toHaveBeenCalledExactlyOnceWith('pty-1')
    expect(getForegroundProcess).not.toHaveBeenCalled()
  })

  it('calls foreground confirmation with its controller receiver', async () => {
    const getForegroundProcess = vi.fn(async () => 'powershell.exe')
    const confirmForegroundProcess = vi.fn(
      async function (this: { getForegroundProcess: typeof getForegroundProcess }) {
        return this.getForegroundProcess === getForegroundProcess ? 'codex' : null
      }
    )
    const { runtime, handle } = await createExplicitAgentStatusHarness({
      getForegroundProcess,
      confirmForegroundProcess
    })

    await expect(runtime.getTerminalAgentStatus(handle)).resolves.toMatchObject({
      isRunningAgent: true,
      status: 'working'
    })
    expect(confirmForegroundProcess).toHaveBeenCalledOnce()
  })

  it.each([
    ['shell', async () => 'pwsh.exe'],
    ['non-agent', async () => 'vim'],
    ['unavailable', async () => null],
    [
      'failure',
      async () => {
        throw new Error('provider unavailable')
      }
    ]
  ])('fails closed when shell-conflict confirmation returns %s', async (_case, confirm) => {
    const confirmForegroundProcess = vi.fn(confirm)
    const { runtime, handle } = await createExplicitAgentStatusHarness({
      getForegroundProcess: async () => 'zsh',
      confirmForegroundProcess
    })

    await expect(runtime.getTerminalAgentStatus(handle)).resolves.toEqual({
      handle,
      isRunningAgent: false,
      status: null
    })
    expect(confirmForegroundProcess).toHaveBeenCalledOnce()
  })

  it('fails closed on a shell conflict when the controller cannot confirm it', async () => {
    const { runtime, handle } = await createExplicitAgentStatusHarness({
      getForegroundProcess: async () => 'zsh'
    })

    await expect(runtime.getTerminalAgentStatus(handle)).resolves.toEqual({
      handle,
      isRunningAgent: false,
      status: null
    })
  })

  it('skips strong confirmation when ordinary foreground evidence recognizes an agent', async () => {
    const getForegroundProcess = vi.fn(async () => 'codex')
    const confirmForegroundProcess = vi.fn(async () => 'codex')
    const { runtime, handle } = await createExplicitAgentStatusHarness({
      getForegroundProcess,
      confirmForegroundProcess
    })

    await expect(runtime.getTerminalAgentStatus(handle)).resolves.toMatchObject({
      isRunningAgent: true,
      status: 'working'
    })
    expect(getForegroundProcess).toHaveBeenCalledOnce()
    expect(confirmForegroundProcess).not.toHaveBeenCalled()
  })

  it('skips both foreground reads when current title evidence blocks explicit hook state', async () => {
    const getForegroundProcess = vi.fn(async () => 'zsh')
    const confirmForegroundProcess = vi.fn(async () => 'codex')
    const { runtime, handle } = await createExplicitAgentStatusHarness({
      getForegroundProcess,
      confirmForegroundProcess,
      title: 'zsh'
    })

    await expect(runtime.getTerminalAgentStatus(handle)).resolves.toMatchObject({
      isRunningAgent: false,
      status: null
    })
    expect(getForegroundProcess).not.toHaveBeenCalled()
    expect(confirmForegroundProcess).not.toHaveBeenCalled()
  })

  it('skips foreground reads for permission title and blocked wait evidence', async () => {
    for (const blocked of ['title', 'wait'] as const) {
      const getForegroundProcess = vi.fn(async () => 'zsh')
      const confirmForegroundProcess = vi.fn(async () => 'codex')
      const { runtime, handle } = await createExplicitAgentStatusHarness({
        getForegroundProcess,
        confirmForegroundProcess
      })
      runtime.onPtyData(
        'pty-1',
        blocked === 'title'
          ? '\x1b]0;Codex waiting for permission\x07'
          : 'Hooks need review. Press enter to confirm\n',
        Date.now() + 1000
      )
      getForegroundProcess.mockClear()
      confirmForegroundProcess.mockClear()

      await expect(runtime.getTerminalAgentStatus(handle)).resolves.toMatchObject({
        isRunningAgent: true,
        status: 'permission'
      })
      expect(getForegroundProcess).not.toHaveBeenCalled()
      expect(confirmForegroundProcess).not.toHaveBeenCalled()
    }
  })

  it('rejects foreground evidence when the handle rebinds during the ordinary read', async () => {
    const foreground = deferred<string | null>()
    const getForegroundProcess = vi.fn(() => foreground.promise)
    const confirmForegroundProcess = vi.fn(async () => 'codex')
    const { runtime, handle, syncPty } = await createExplicitAgentStatusHarness({
      getForegroundProcess,
      confirmForegroundProcess
    })

    const status = runtime.getTerminalAgentStatus(handle)
    await vi.waitFor(() => expect(getForegroundProcess).toHaveBeenCalledWith('pty-1'))
    syncPty('pty-2')
    foreground.resolve('zsh')

    await expect(status).rejects.toThrow('terminal_handle_stale')
    expect(confirmForegroundProcess).not.toHaveBeenCalled()
  })

  it('rejects a handle rebind while a controller-less status check yields', async () => {
    const { runtime, handle, syncPty } = await createExplicitAgentStatusHarness({
      getForegroundProcess: async () => 'zsh'
    })
    runtime.setPtyController(null)

    const status = runtime.getTerminalAgentStatus(handle)
    syncPty('pty-2')

    await expect(status).rejects.toThrow('terminal_handle_stale')
  })

  it('rejects confirmation evidence when the handle rebinds during the fresh read', async () => {
    const confirmation = deferred<string | null>()
    const confirmForegroundProcess = vi.fn(() => confirmation.promise)
    const { runtime, handle, syncPty } = await createExplicitAgentStatusHarness({
      getForegroundProcess: async () => 'powershell.exe',
      confirmForegroundProcess
    })

    const status = runtime.getTerminalAgentStatus(handle)
    await vi.waitFor(() => expect(confirmForegroundProcess).toHaveBeenCalledWith('pty-1'))
    syncPty('pty-2')
    confirmation.resolve('codex')

    await expect(status).rejects.toThrow('terminal_handle_stale')
  })

  it('rejects confirmation evidence when the owning PTY exits', async () => {
    const confirmation = deferred<string | null>()
    const confirmForegroundProcess = vi.fn(() => confirmation.promise)
    const { runtime, handle } = await createExplicitAgentStatusHarness({
      getForegroundProcess: async () => 'powershell.exe',
      confirmForegroundProcess
    })

    const status = runtime.getTerminalAgentStatus(handle)
    await vi.waitFor(() => expect(confirmForegroundProcess).toHaveBeenCalledWith('pty-1'))
    runtime.onPtyExit('pty-1', 0)
    confirmation.resolve('codex')

    await expect(status).rejects.toThrow('terminal_exited')
  })

  it('reports permission from a title-derived action-required agent state', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-1' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const leafId = '11111111-1111-4111-8111-111111111111'
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Codex waiting for permission',
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

    const [terminal] = (await runtime.listTerminals()).terminals

    await expect(runtime.getTerminalAgentStatus(terminal.handle)).resolves.toEqual({
      handle: terminal.handle,
      isRunningAgent: true,
      status: 'permission'
    })
  })

  it('maps fresh explicit done hook state to idle for send readiness', async () => {
    const leafId = '11111111-1111-4111-8111-111111111111'
    const paneKey = makePaneKey('tab-1', leafId)
    const runtime = new OrcaRuntimeService(store, undefined, {
      getAgentStatusSnapshot: () => [
        {
          paneKey,
          state: 'done',
          prompt: '',
          agentType: 'codex',
          connectionId: null,
          receivedAt: Date.now(),
          stateStartedAt: Date.now(),
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID
        }
      ]
    })
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-1' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'repo terminal',
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

    const [terminal] = (await runtime.listTerminals()).terminals

    await expect(runtime.getTerminalAgentStatus(terminal.handle)).resolves.toEqual({
      handle: terminal.handle,
      isRunningAgent: true,
      status: 'idle'
    })
  })

  it('reports recognized foreground agents with unknown status as running with null status', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-1' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'codex'
    })
    const leafId = '11111111-1111-4111-8111-111111111111'
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'repo terminal',
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

    const [terminal] = (await runtime.listTerminals()).terminals

    await expect(runtime.getTerminalAgentStatus(terminal.handle)).resolves.toEqual({
      handle: terminal.handle,
      isRunningAgent: true,
      status: null
    })
  })

  it('keeps ordinary terminal send suffix failures on the existing not-writable contract', async () => {
    const writes: string[] = []
    const beforeWrite = vi.fn()
    const afterWrite = vi.fn()
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-1' }),
      write: (_ptyId: string, data: string) => {
        writes.push(data)
        return data !== '\r'
      },
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Codex ready',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-1'
        }
      ]
    })

    const [terminal] = (await runtime.listTerminals()).terminals

    await expect(
      runtime.sendTerminal(
        terminal.handle,
        { text: 'notes', enter: true },
        { beforeWrite, afterWrite }
      )
    ).rejects.toThrow('terminal_not_writable')
    expect(writes).toEqual(['notes', '\r'])
    expect(beforeWrite).toHaveBeenCalledTimes(2)
    expect(afterWrite).toHaveBeenCalledOnce()
  })

  it('creates visible terminal sessions without asking the renderer to focus a tab', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-bg' })
    const createTerminal = vi.fn()
    const revealTerminalSession = vi.fn().mockResolvedValue({ tabId: 'tab-bg' })
    const runtime = new OrcaRuntimeService(store)
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
      createTerminal,
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
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    const result = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'codex',
      launchConfig: {
        agentArgs: '--model gpt-5',
        agentEnv: { CODEX_PROFILE: 'captured' }
      },
      title: 'worker'
    })

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: TEST_WORKTREE_PATH,
        command: 'codex',
        commandDelivery: 'provider',
        worktreeId: TEST_WORKTREE_ID,
        preAllocatedHandle: expect.stringMatching(/^term_/)
      })
    )
    expect(result).toMatchObject({
      worktreeId: TEST_WORKTREE_ID,
      title: 'worker',
      surface: 'visible'
    })
    expect(result.handle).toMatch(/^term_/)
    expect(createTerminal).not.toHaveBeenCalled()
    // Why: agent status keys off `${tabId}:${leafId}`; main pre-allocates the tabId, env-stamps it before spawn, and reuses it for adoption.
    const spawnCall = spawn.mock.calls[0]?.[0] as { env?: Record<string, string> } | undefined
    const spawnedEnv = spawnCall?.env ?? {}
    expectStablePaneKeyEnv(spawnedEnv)
    const spawnedLeafId = spawnedEnv.ORCA_PANE_KEY.slice(`${spawnedEnv.ORCA_TAB_ID}:`.length)
    expect(spawnedEnv.ORCA_WORKTREE_ID).toBe(TEST_WORKTREE_ID)
    expect(spawnedEnv.ORCA_AGENT_LAUNCH_TOKEN).toMatch(UUID_RE)
    expect(revealTerminalSession).toHaveBeenCalledWith(TEST_WORKTREE_ID, {
      ptyId: 'pty-bg',
      title: 'worker',
      launchConfig: {
        agentArgs: '--model gpt-5',
        agentEnv: { CODEX_PROFILE: 'captured' }
      },
      launchToken: spawnedEnv.ORCA_AGENT_LAUNCH_TOKEN,
      activate: false,
      tabId: spawnedEnv.ORCA_TAB_ID,
      leafId: spawnedLeafId
    })
  })

  it('retires inherited launch authority when the agent command exits', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-authority', incarnationId: 'process-1' })
    const retireAuthority = vi.fn()
    const runtime = new OrcaRuntimeService(store, undefined, {
      attestAgentHookCompatibilityAuthority: (candidate) => ({
        paneKey: candidate.paneKey,
        source: 'current_hook'
      }),
      retireAgentHookCompatibilityAuthority: retireAuthority
    })
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
      revealTerminalSession: vi.fn().mockResolvedValue({ tabId: 'tab-authority' }),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    const terminal = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'codex',
      launchAgent: 'codex',
      launchConfig: { agentCommand: 'codex', agentArgs: '', agentEnv: {} }
    })
    const spawnEnv =
      (spawn.mock.calls[0]?.[0] as { env?: Record<string, string> } | undefined)?.env ?? {}
    const evidence = {
      terminalHandle: terminal.handle,
      paneKey: spawnEnv.ORCA_PANE_KEY,
      launchToken: spawnEnv.ORCA_AGENT_LAUNCH_TOKEN
    }

    expect(runtime.verifyOrchestrationCompatibilityCaller(evidence)).not.toBeNull()
    expect(
      runtime.getAgentStatusLaunchConfigForPaneKey(spawnEnv.ORCA_PANE_KEY, {
        launchToken: spawnEnv.ORCA_AGENT_LAUNCH_TOKEN
      })
    ).toBeDefined()
    expect((await runtime.listTerminals()).terminals).toEqual([
      expect.objectContaining({ handle: terminal.handle, agentIdentity: 'codex' })
    ])

    runtime.onPtyData('pty-authority', '\x1b]133;D;0\x07', 100)

    expect(retireAuthority).toHaveBeenCalledWith(spawnEnv.ORCA_PANE_KEY)
    expect(runtime.verifyOrchestrationCompatibilityCaller(evidence)).toBeNull()
    expect(
      runtime.getAgentStatusLaunchConfigForPaneKey(spawnEnv.ORCA_PANE_KEY, {
        launchToken: spawnEnv.ORCA_AGENT_LAUNCH_TOKEN
      })
    ).toBeUndefined()
    expect((await runtime.listTerminals()).terminals).toEqual([
      expect.not.objectContaining({ agentIdentity: expect.anything() })
    ])
  })

  it('retires only receipted restored PTY authority on command completion and exit', () => {
    const retireAuthority = vi.fn()
    const runtime = new OrcaRuntimeService(store, undefined, {
      retireAgentHookCompatibilityAuthority: retireAuthority
    })
    const internals = runtime as unknown as {
      recordPtyWorktree: (ptyId: string, worktreeId: string, state: Record<string, unknown>) => void
      restoredOrchestrationAuthorityByPtyId: Map<string, Record<string, unknown>>
    }
    const firstPane = '11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222'
    const secondPane = '33333333-3333-4333-8333-333333333333:44444444-4444-4444-8444-444444444444'
    internals.recordPtyWorktree('pty-restored-command', TEST_WORKTREE_ID, {
      connected: true,
      tabId: '11111111-1111-4111-8111-111111111111',
      paneKey: firstPane,
      incarnationId: 'restored-command'
    })
    internals.recordPtyWorktree('pty-restored-exit', TEST_WORKTREE_ID, {
      connected: true,
      tabId: '33333333-3333-4333-8333-333333333333',
      paneKey: secondPane,
      incarnationId: 'restored-exit'
    })
    internals.recordPtyWorktree('pty-ordinary-shell', TEST_WORKTREE_ID, {
      connected: true,
      tabId: '55555555-5555-4555-8555-555555555555',
      paneKey: '55555555-5555-4555-8555-555555555555:66666666-6666-4666-8666-666666666666',
      incarnationId: 'ordinary-shell'
    })
    internals.restoredOrchestrationAuthorityByPtyId.set('pty-restored-command', {
      ptyId: 'pty-restored-command',
      worktreeId: TEST_WORKTREE_ID,
      terminalHandle: 'term-restored-command',
      paneKey: firstPane,
      processIncarnation: 'pty-restored-command:restored-command',
      hostScope: { kind: 'local', hostId: 'local' }
    })
    internals.restoredOrchestrationAuthorityByPtyId.set('pty-restored-exit', {
      ptyId: 'pty-restored-exit',
      worktreeId: TEST_WORKTREE_ID,
      terminalHandle: 'term-restored-exit',
      paneKey: secondPane,
      processIncarnation: 'pty-restored-exit:restored-exit',
      hostScope: { kind: 'local', hostId: 'local' }
    })

    runtime.emitDaemonPtyTransientFact('pty-restored-command', {
      kind: 'command-finished',
      exitCode: 0
    })
    runtime.onPtyExit('pty-restored-exit', 0, 'restored-exit')
    runtime.onPtyExit('pty-ordinary-shell', 0, 'ordinary-shell')

    expect(retireAuthority).toHaveBeenCalledWith(firstPane)
    expect(retireAuthority).toHaveBeenCalledWith(secondPane)
    expect(retireAuthority).toHaveBeenCalledTimes(2)
  })

  it('restores a retained coordinator handle after a late controller inventory', async () => {
    const paneKey = makePaneKey('host-tab', HEADLESS_LEAF_ID)
    const incarnationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const session = makeWorkspaceSessionWithHeadlessTerminal({
      terminalPtyIncarnationsByPaneKey: { [paneKey]: incarnationId }
    })
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(session)
    const runtime = new OrcaRuntimeService(runtimeStore as never, undefined, {
      canRecoverPersistentLocalPtys: () => true,
      attestAgentHookCompatibilityAuthority: ({ paneKey: candidate, launchTokenHash }) =>
        candidate === paneKey && launchTokenHash === RESTORED_AUTHORITY_TOKEN_HASH
          ? { paneKey: candidate, source: 'hydrated_commitment' }
          : null
    })
    const controllerHandle = 'term_retained_coordinator'
    const listProcesses = vi
      .fn()
      .mockRejectedValueOnce(new Error('provider starting'))
      .mockResolvedValue([
        {
          id: 'persisted-pty',
          incarnationId,
          terminalHandle: controllerHandle,
          title: 'Coordinator',
          cwd: TEST_WORKTREE_PATH,
          worktreeId: TEST_WORKTREE_ID,
          wslDistro: null
        }
      ])
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses
    })

    await expect(runtime.refreshRestoredOrchestrationAuthority()).rejects.toThrow(
      'terminal_liveness_unavailable'
    )
    runtime.attachWindow(TEST_WINDOW_ID)
    runtime.syncWindowGraph(TEST_WINDOW_ID, {
      tabs: [
        {
          tabId: 'host-tab',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Coordinator',
          activeLeafId: HEADLESS_LEAF_ID,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'host-tab',
          worktreeId: TEST_WORKTREE_ID,
          leafId: HEADLESS_LEAF_ID,
          paneRuntimeId: 1,
          ptyId: 'persisted-pty'
        }
      ]
    })
    const syntheticHandle = runtime.getAgentStatusTerminalHandleForPaneKey(paneKey)
    expect(syntheticHandle).toMatch(/^term_/)
    expect(syntheticHandle).not.toBe(controllerHandle)

    await expect(runtime.refreshRestoredOrchestrationAuthority()).resolves.toBeUndefined()

    expect(runtime.getAgentStatusTerminalHandleForPaneKey(paneKey)).toBe(controllerHandle)
    expect(
      runtime.verifyOrchestrationCompatibilityCaller({
        terminalHandle: controllerHandle,
        paneKey,
        launchToken: RESTORED_AUTHORITY_TOKEN
      })
    ).toMatchObject({
      terminalHandle: controllerHandle,
      paneKey,
      processIncarnation: `persisted-pty:${incarnationId}`
    })
  })

  it('forgets synthetic handles when disconnected PTY records are pruned', () => {
    const runtime = new OrcaRuntimeService(store)
    const internals = runtime as unknown as {
      recordPtyWorktree: (
        ptyId: string,
        worktreeId: string,
        state: Record<string, unknown>
      ) => unknown
      issuePtyHandle: (pty: unknown) => string
      dropDisconnectedPtyRecord: (ptyId: string) => void
      syntheticTerminalHandles: Set<string>
    }
    const pty = internals.recordPtyWorktree('pty-pruned', TEST_WORKTREE_ID, {
      connected: false
    })
    const handle = internals.issuePtyHandle(pty)
    expect(internals.syntheticTerminalHandles.has(handle)).toBe(true)

    internals.dropDisconnectedPtyRecord('pty-pruned')

    expect(internals.syntheticTerminalHandles.has(handle)).toBe(false)
  })

  it('drops an out-of-order aggregate inventory after a newer SSH inventory', async () => {
    const targetId = 'ssh-1'
    const ptyId = `ssh:${targetId}@@persisted-pty`
    const paneKey = makePaneKey('host-tab', HEADLESS_LEAF_ID)
    const oldIncarnation = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const newIncarnation = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    const session = makeWorkspaceSessionWithHeadlessTerminal({
      tabsByWorktree: {
        [TEST_WORKTREE_ID]: [
          {
            id: 'host-tab',
            ptyId,
            worktreeId: TEST_WORKTREE_ID,
            title: 'Persisted Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      terminalLayoutsByTabId: {
        'host-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: ptyId })
      },
      terminalPtyIncarnationsByPaneKey: { [paneKey]: oldIncarnation }
    })
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(session)
    const runtime = new OrcaRuntimeService(runtimeStore as never, undefined, {
      attestAgentHookCompatibilityAuthority: ({ paneKey: candidate, launchTokenHash }) =>
        candidate === paneKey && launchTokenHash === RESTORED_AUTHORITY_TOKEN_HASH
          ? { paneKey: candidate, source: 'hydrated_commitment' }
          : null
    })
    const oldInventory = deferred<
      {
        id: string
        incarnationId: string
        terminalHandle: string
        worktreeId: string
        cwd: string
        title: string
        wslDistro: null
      }[]
    >()
    const newInventory =
      deferred<typeof oldInventory.promise extends Promise<infer T> ? T : never>()
    const listProcesses = vi
      .fn()
      .mockImplementationOnce(() => oldInventory.promise)
      .mockImplementationOnce(() => newInventory.promise)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses
    })
    const internals = runtime as unknown as {
      refreshPtyWorktreeRecordsWithControllerInventory: (
        worktrees: [],
        targetWorktreeId: string | null,
        deadline: number | undefined,
        connectionId: string | null | undefined
      ) => Promise<unknown>
      ptysById: Map<string, { incarnationId: string | null }>
      restoredOrchestrationAuthorityByPtyId: Map<string, unknown>
    }
    const host = runtime.registerOrchestrationCompatibilitySshAttachment(
      targetId,
      'connection-incarnation'
    )

    const staleRefresh = internals.refreshPtyWorktreeRecordsWithControllerInventory(
      [],
      null,
      undefined,
      undefined
    )
    const currentRefresh = internals.refreshPtyWorktreeRecordsWithControllerInventory(
      [],
      null,
      undefined,
      targetId
    )
    newInventory.resolve([
      {
        id: ptyId,
        incarnationId: newIncarnation,
        terminalHandle: 'term_new_process',
        worktreeId: TEST_WORKTREE_ID,
        cwd: TEST_WORKTREE_PATH,
        title: 'Replacement',
        wslDistro: null
      }
    ])
    await expect(currentRefresh).resolves.not.toBeNull()
    oldInventory.resolve([
      {
        id: ptyId,
        incarnationId: oldIncarnation,
        terminalHandle: 'term_old_process',
        worktreeId: TEST_WORKTREE_ID,
        cwd: TEST_WORKTREE_PATH,
        title: 'Retained coordinator',
        wslDistro: null
      }
    ])
    await expect(staleRefresh).resolves.toBeNull()

    expect(internals.ptysById.get(ptyId)?.incarnationId).toBe(newIncarnation)
    expect(internals.restoredOrchestrationAuthorityByPtyId.has(ptyId)).toBe(false)
    expect(
      runtime.verifyOrchestrationCompatibilityCaller({
        terminalHandle: 'term_old_process',
        paneKey,
        launchToken: RESTORED_AUTHORITY_TOKEN,
        host
      })
    ).toBeNull()
  })

  it('keeps restored receipts outside a targeted worktree scan', async () => {
    const secondWorktreeId = `${TEST_REPO_ID}::/tmp/worktree-b`
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        {
          id: 'pty-moved',
          incarnationId: 'inc-moved',
          terminalHandle: 'term_moved',
          title: 'Moved',
          cwd: '/tmp/worktree-b',
          worktreeId: secondWorktreeId,
          wslDistro: null
        },
        {
          id: 'pty-second',
          incarnationId: 'inc-second',
          terminalHandle: 'term_second',
          title: 'Second',
          cwd: '/tmp/worktree-b',
          worktreeId: secondWorktreeId,
          wslDistro: null
        }
      ]
    })
    const receipts = (
      runtime as unknown as {
        restoredOrchestrationAuthorityByPtyId: Map<string, Record<string, unknown>>
      }
    ).restoredOrchestrationAuthorityByPtyId
    receipts.set('pty-moved', {
      ptyId: 'pty-moved',
      worktreeId: TEST_WORKTREE_ID,
      terminalHandle: 'term_moved',
      paneKey: makePaneKey('moved-tab', HEADLESS_LEAF_ID),
      processIncarnation: 'pty-moved:inc-moved',
      hostScope: { kind: 'local', hostId: 'local' }
    })
    receipts.set('pty-second', {
      ptyId: 'pty-second',
      worktreeId: secondWorktreeId,
      terminalHandle: 'term_second',
      paneKey: makePaneKey('second-tab', HEADLESS_LEAF_ID),
      processIncarnation: 'pty-second:inc-second',
      hostScope: { kind: 'local', hostId: 'local' }
    })

    await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)

    expect(receipts.has('pty-moved')).toBe(false)
    expect(receipts.has('pty-second')).toBe(true)
  })

  it('preserves SSH dispatch authority commitment across transient relay loss', async () => {
    const targetId = 'ssh-1'
    const ptyId = `ssh:${targetId}@@pty-retained`
    const tabId = 'ssh-worker'
    const paneKey = makePaneKey(tabId, HEADLESS_LEAF_ID)
    const incarnationId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    const sshSession = makeWorkspaceSessionWithHeadlessTerminal({
      activeTabId: tabId,
      activeTabIdByWorktree: { [TEST_WORKTREE_ID]: tabId },
      tabsByWorktree: {
        [TEST_WORKTREE_ID]: [
          {
            id: tabId,
            ptyId,
            worktreeId: TEST_WORKTREE_ID,
            title: 'SSH worker',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      terminalLayoutsByTabId: {
        [tabId]: makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: ptyId })
      },
      terminalPtyIncarnationsByPaneKey: { [paneKey]: incarnationId }
    })
    const retireAuthority = vi.fn()
    const failDispatch = vi.fn()
    const runtime = new OrcaRuntimeService(
      {
        ...store,
        getWorkspaceSession: (hostId?: string | null) =>
          hostId === `ssh:${targetId}` ? sshSession : getDefaultWorkspaceSession()
      },
      undefined,
      {
        attestAgentHookCompatibilityAuthority: ({
          paneKey: candidate,
          launchTokenHash,
          connectionId
        }) =>
          candidate === paneKey &&
          launchTokenHash === RESTORED_AUTHORITY_TOKEN_HASH &&
          connectionId === targetId
            ? { paneKey: candidate, source: 'hydrated_commitment' }
            : null,
        retireAgentHookCompatibilityAuthority: retireAuthority
      }
    )
    runtime.setOrchestrationDb({
      getActiveDispatchForTerminal: (handle: string) =>
        handle === 'term_ssh_retained'
          ? { id: 'dispatch-ssh', task_id: 'task-ssh', status: 'dispatched' }
          : undefined,
      failDispatch,
      getActiveCoordinatorRun: () => undefined
    } as unknown as OrchestrationDb)
    runtime.attachWindow(TEST_WINDOW_ID)
    runtime.syncWindowGraph(TEST_WINDOW_ID, {
      tabs: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          title: 'SSH worker',
          activeLeafId: HEADLESS_LEAF_ID,
          layout: null
        }
      ],
      leaves: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          leafId: HEADLESS_LEAF_ID,
          paneRuntimeId: 1,
          ptyId
        }
      ]
    })
    const listProcesses = vi.fn(async () => [
      {
        id: ptyId,
        incarnationId,
        terminalHandle: 'term_ssh_retained',
        title: 'SSH worker',
        cwd: TEST_WORKTREE_PATH,
        worktreeId: TEST_WORKTREE_ID,
        wslDistro: null
      }
    ])
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses
    })
    const refreshInventory = (connectionId: string | undefined) =>
      (
        runtime as unknown as {
          refreshPtyWorktreeRecordsWithControllerInventory: (
            worktrees: [],
            targetWorktreeId: string | null,
            deadline: number | undefined,
            connectionId: string | undefined
          ) => Promise<unknown>
        }
      ).refreshPtyWorktreeRecordsWithControllerInventory([], null, undefined, connectionId)
    const host = runtime.registerOrchestrationCompatibilitySshAttachment(
      targetId,
      'connection-incarnation'
    )
    const evidence = {
      terminalHandle: 'term_ssh_retained',
      paneKey,
      launchToken: RESTORED_AUTHORITY_TOKEN,
      host
    } as const

    await expect(refreshInventory(targetId)).resolves.not.toBeNull()
    expect(runtime.verifyOrchestrationCompatibilityCaller(evidence)).not.toBeNull()
    await expect(refreshInventory(undefined)).resolves.not.toBeNull()
    expect(runtime.verifyOrchestrationCompatibilityCaller(evidence)).not.toBeNull()

    runtime.onPtyExit(ptyId, -1, incarnationId)

    expect(runtime.verifyOrchestrationCompatibilityCaller(evidence)).toBeNull()
    expect(retireAuthority).not.toHaveBeenCalled()
    expect(failDispatch).not.toHaveBeenCalled()

    await expect(refreshInventory(targetId)).resolves.not.toBeNull()

    expect(runtime.verifyOrchestrationCompatibilityCaller(evidence)).not.toBeNull()
    expect(listProcesses).toHaveBeenCalledTimes(3)
  })

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

  it('injects runtime hook receiver env into terminal sessions', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-hooked' })
    const runtime = new OrcaRuntimeService(store, undefined, {
      buildAgentHookPtyEnv: () => ({
        ORCA_AGENT_HOOK_PORT: '5678',
        ORCA_AGENT_HOOK_TOKEN: 'agent-token',
        ORCA_AGENT_HOOK_ENV: 'remote',
        ORCA_AGENT_HOOK_VERSION: '1'
      })
    })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'codex',
      env: {
        ORCA_AGENT_HOOK_PORT: '1111',
        ORCA_AGENT_HOOK_TOKEN: 'stale-token',
        ORCA_AGENT_HOOK_ENDPOINT: '/tmp/stale-endpoint.env'
      },
      envToDelete: ['CODEX_HOME', 'ORCA_CODEX_HOME']
    })

    const spawnCall = spawn.mock.calls[0]?.[0] as
      | { env?: Record<string, string>; envToDelete?: string[] }
      | undefined
    expect(spawnCall?.env).toEqual(
      expect.objectContaining({
        ORCA_AGENT_HOOK_PORT: '5678',
        ORCA_AGENT_HOOK_TOKEN: 'agent-token',
        ORCA_AGENT_HOOK_ENV: 'remote',
        ORCA_AGENT_HOOK_VERSION: '1',
        ORCA_PANE_KEY: expect.any(String),
        ORCA_TAB_ID: expect.any(String),
        ORCA_WORKTREE_ID: TEST_WORKTREE_ID
      })
    )
    expect(spawnCall?.env?.ORCA_AGENT_HOOK_ENDPOINT).toBeUndefined()
    expect(spawnCall?.envToDelete).toEqual(['CODEX_HOME', 'ORCA_CODEX_HOME'])
  })

  it.each([
    { label: 'canonical folder workspace selector', selector: TEST_FOLDER_WORKSPACE_KEY },
    { label: 'id-prefixed folder workspace selector', selector: `id:${TEST_FOLDER_WORKSPACE_KEY}` }
  ])('creates background terminal sessions for a $label', async ({ selector }) => {
    const folderPath = await mkdtemp(join(tmpdir(), 'orca-runtime-folder-workspace-'))
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-folder' })
    const folderWorkspace = makeFolderWorkspace({ folderPath })
    const projectGroup = makeFolderProjectGroup({ parentPath: folderPath })
    const runtime = new OrcaRuntimeService(
      createFolderWorkspaceRuntimeStore(folderWorkspace, projectGroup) as never
    )
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    await expect(
      runtime.createTerminal(selector, {
        command: 'codex',
        title: 'multi-repo worker'
      })
    ).resolves.toMatchObject({
      worktreeId: TEST_FOLDER_WORKSPACE_KEY,
      title: 'multi-repo worker',
      surface: 'background'
    })

    const spawnCall = spawn.mock.calls[0]?.[0] as
      | { cwd?: string; env?: Record<string, string>; worktreeId?: string }
      | undefined
    const spawnedEnv = spawnCall?.env ?? {}
    expect(spawnCall).toMatchObject({
      cwd: folderPath,
      worktreeId: TEST_FOLDER_WORKSPACE_KEY
    })
    expectStablePaneKeyEnv(spawnedEnv)
    expect(spawnedEnv.ORCA_WORKSPACE_ID).toBe(TEST_FOLDER_WORKSPACE_KEY)
    expect(spawnedEnv.ORCA_PROJECT_GROUP_ID).toBe(TEST_FOLDER_PROJECT_GROUP_ID)
    expect(spawnedEnv.ORCA_WORKSPACE_ROOT).toBe(folderPath)
    expect(spawnedEnv.ORCA_WORKTREE_ID).toBe(TEST_FOLDER_WORKSPACE_KEY)
  })

  it.each([
    { label: 'bare floating terminal sentinel', selector: FLOATING_TERMINAL_WORKTREE_ID },
    {
      label: 'id-prefixed floating terminal sentinel',
      selector: `id:${FLOATING_TERMINAL_WORKTREE_ID}`
    }
  ])('creates background terminal sessions for a $label', async ({ selector }) => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-floating' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    await expect(
      runtime.createTerminal(selector, {
        command: 'codex',
        title: 'floating worker'
      })
    ).resolves.toMatchObject({
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      title: 'floating worker',
      surface: 'background'
    })

    const spawnCall = spawn.mock.calls[0]?.[0] as
      | {
          cwd?: string
          connectionId?: string | null
          env?: Record<string, string>
          worktreeId?: string
        }
      | undefined
    expect(spawnCall).toMatchObject({
      cwd: homedir(),
      connectionId: null,
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID
    })
    expect(spawnCall?.env?.ORCA_WORKTREE_ID).toBe(FLOATING_TERMINAL_WORKTREE_ID)
    expect(spawnCall?.env?.ORCA_WORKSPACE_ID).toBeUndefined()
    expect(spawnCall?.env?.ORCA_PROJECT_GROUP_ID).toBeUndefined()
    expect(spawnCall?.env?.ORCA_WORKSPACE_ROOT).toBeUndefined()
  })

  it('rejects folder workspace terminal creation when the backing path is missing', async () => {
    const missingPath = join(tmpdir(), `orca-missing-folder-workspace-${randomUUID()}`)
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-folder' })
    const folderWorkspace = makeFolderWorkspace({ folderPath: missingPath })
    const projectGroup = makeFolderProjectGroup({ parentPath: missingPath })
    const runtime = new OrcaRuntimeService(
      createFolderWorkspaceRuntimeStore(folderWorkspace, projectGroup) as never
    )
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    await expect(runtime.createTerminal(TEST_FOLDER_WORKSPACE_KEY)).rejects.toThrow(
      'folder_workspace_path_missing'
    )
    expect(spawn).not.toHaveBeenCalled()
  })

  it('rejects folder workspace folderPath updates when the new path is missing', async () => {
    const missingPath = join(tmpdir(), `orca-missing-folder-update-${randomUUID()}`)
    const folderWorkspace = makeFolderWorkspace()
    const runtimeStore = {
      ...createFolderWorkspaceRuntimeStore(folderWorkspace),
      updateFolderWorkspace: vi.fn()
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    await expect(
      runtime.updateFolderWorkspace(TEST_FOLDER_WORKSPACE_ID, { folderPath: missingPath })
    ).rejects.toThrow('folder_workspace_path_missing')
    expect(runtimeStore.updateFolderWorkspace).not.toHaveBeenCalled()
  })

  it('enables Claude Agent Teams only for direct Claude launches when configured in-process', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-bg' })
    const runtimeStore = {
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        claudeAgentTeamsMode: 'in-process' as const
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
      command: "claude 'hello'"
    })
    await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: "echo ok; claude 'hello'"
    })
    await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'codex'
    })

    const directClaude = spawn.mock.calls[0]?.[0] as {
      command?: string
      env?: Record<string, string>
    }
    const compoundClaude = spawn.mock.calls[1]?.[0] as {
      command?: string
      env?: Record<string, string>
    }
    const normalAgent = spawn.mock.calls[2]?.[0] as {
      command?: string
      env?: Record<string, string>
    }

    expect(directClaude.command).toBe("claude --teammate-mode in-process 'hello'")
    expect(directClaude.env?.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe('1')
    expect(directClaude.env?.TMUX).toBeUndefined()

    expect(compoundClaude.command).toBe("echo ok; claude 'hello'")
    expect(compoundClaude.env?.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBeUndefined()
    expect(compoundClaude.env?.TMUX).toBeUndefined()

    expect(normalAgent.command).toBe("codex '--dangerously-bypass-approvals-and-sandbox'")
    expect(normalAgent.env?.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBeUndefined()
    expect(normalAgent.env?.TMUX).toBeUndefined()
  })

  it('reveals Claude Agent Teams launches with the rewritten launch config', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-bg' })
    const revealTerminalSession = vi.fn().mockResolvedValue({ tabId: 'tab-bg' })
    const runtimeStore = {
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        claudeAgentTeamsMode: 'in-process' as const
      })
    }
    const runtime = new OrcaRuntimeService(runtimeStore)
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
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: "claude 'hello'",
      launchAgent: 'claude',
      launchConfig: {
        agentCommand: 'claude',
        agentArgs: '',
        agentEnv: { CLAUDE_PROFILE: 'captured' }
      }
    })

    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ launchAgent: 'claude' }))

    const spawnCall = spawn.mock.calls[0]?.[0] as { env?: Record<string, string> } | undefined
    const spawnedEnv = spawnCall?.env ?? {}
    const spawnedLeafId = spawnedEnv.ORCA_PANE_KEY.slice(`${spawnedEnv.ORCA_TAB_ID}:`.length)
    expect(revealTerminalSession).toHaveBeenCalledWith(TEST_WORKTREE_ID, {
      ptyId: 'pty-bg',
      title: null,
      launchConfig: {
        agentCommand: 'claude --teammate-mode in-process',
        agentArgs: '',
        agentEnv: {
          CLAUDE_PROFILE: 'captured',
          CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1'
        }
      },
      launchToken: spawnedEnv.ORCA_AGENT_LAUNCH_TOKEN,
      launchAgent: 'claude',
      activate: false,
      tabId: spawnedEnv.ORCA_TAB_ID,
      leafId: spawnedLeafId
    })
  })

  it('preserves Claude Agent Teams for sequenced Claude launches', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-bg' })
    const runtimeStore = {
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        claudeAgentTeamsMode: 'in-process' as const
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
      command:
        'bash -lc \'echo Waiting for setup to finish before starting agent... >&2; exec claude "hello"\'',
      claudeAgentTeamsSourceCommand: 'claude "hello"',
      launchAgent: 'claude',
      launchConfig: {
        agentCommand: 'claude',
        agentArgs: '',
        agentEnv: { CLAUDE_PROFILE: 'captured' }
      }
    })

    const sequencedClaude = spawn.mock.calls[0]?.[0] as {
      command?: string
      env?: Record<string, string>
    }

    expect(sequencedClaude.command).toBe(
      'bash -lc \'echo Waiting for setup to finish before starting agent... >&2; exec claude "hello"\''
    )
    expect(sequencedClaude.env?.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe('1')
    expect(sequencedClaude.env?.[SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV]).toBe(
      'claude --teammate-mode in-process "hello"'
    )
  })

  it('restores captured native Claude Agent Teams mode with fresh service env', async () => {
    setPlatform('linux')
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-bg' })
    const revealTerminalSession = vi.fn().mockResolvedValue({ tabId: 'tab-bg' })
    const runtimeStore = {
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        claudeAgentTeamsMode: 'off' as const
      })
    }
    const runtime = new OrcaRuntimeService(runtimeStore)
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
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'claude --resume claude-session',
      env: {
        CLAUDE_PROFILE: 'captured',
        // Why: native panes need an absolute CLI; without one the plan degrades to in-process teammates.
        ORCA_AGENT_TEAMS_SHIM_BIN: '/opt/orca/bin/orca-ide',
        ORCA_AGENT_TEAMS_TEAM_ID: 'stale-team',
        ORCA_AGENT_TEAMS_TOKEN: 'stale-token',
        TMUX: '/tmp/orca-claude-agent-teams/stale-team,0,1'
      },
      launchAgent: 'claude',
      launchConfig: {
        agentCommand: 'claude',
        agentArgs: '--teammate-mode auto',
        agentEnv: {
          CLAUDE_PROFILE: 'captured',
          ORCA_AGENT_TEAMS_SHIM_BIN: '/opt/orca/bin/orca-ide',
          ORCA_AGENT_TEAMS_TEAM_ID: 'stale-team',
          ORCA_AGENT_TEAMS_TOKEN: 'stale-token',
          TMUX: '/tmp/orca-claude-agent-teams/stale-team,0,1'
        }
      }
    })

    const spawnCall = spawn.mock.calls[0]?.[0] as
      | { command?: string; env?: Record<string, string> }
      | undefined
    expect(spawnCall?.command).toBe('claude --teammate-mode auto --resume claude-session')
    expect(spawnCall?.env).toMatchObject({
      CLAUDE_PROFILE: 'captured',
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
      ORCA_AGENT_TEAMS_SHIM_BIN: '/opt/orca/bin/orca-ide',
      TMUX_PANE: '%1'
    })
    expect(spawnCall?.env?.ORCA_AGENT_TEAMS_TEAM_ID).toMatch(/^team-/)
    expect(spawnCall?.env?.ORCA_AGENT_TEAMS_TEAM_ID).not.toBe('stale-team')
    expect(spawnCall?.env?.ORCA_AGENT_TEAMS_TOKEN).not.toBe('stale-token')
    expect(spawnCall?.env?.TMUX).not.toBe('/tmp/orca-claude-agent-teams/stale-team,0,1')
    expect(revealTerminalSession).toHaveBeenCalledWith(
      TEST_WORKTREE_ID,
      expect.objectContaining({
        launchConfig: expect.objectContaining({
          agentCommand: 'claude --teammate-mode auto',
          agentEnv: expect.objectContaining({
            CLAUDE_PROFILE: 'captured',
            CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
            TMUX_PANE: '%1'
          })
        }),
        launchAgent: 'claude'
      })
    )
    const revealedLaunchConfig = revealTerminalSession.mock.calls[0]?.[1]?.launchConfig
    expect(revealedLaunchConfig?.agentEnv.ORCA_AGENT_TEAMS_TEAM_ID).not.toBe('stale-team')
    expect(revealedLaunchConfig?.agentEnv.ORCA_AGENT_TEAMS_TOKEN).not.toBe('stale-token')
  })

  it('does not apply current Agent Teams mode to captured plain Claude resumes', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-bg' })
    const revealTerminalSession = vi.fn().mockResolvedValue({ tabId: 'tab-bg' })
    const runtimeStore = {
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        claudeAgentTeamsMode: 'in-process' as const
      })
    }
    const runtime = new OrcaRuntimeService(runtimeStore)
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
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'claude --resume claude-session',
      launchAgent: 'claude',
      launchConfig: {
        agentCommand: 'claude',
        agentArgs: '',
        agentEnv: { CLAUDE_PROFILE: 'captured' }
      }
    })

    const spawnCall = spawn.mock.calls[0]?.[0] as
      | { command?: string; env?: Record<string, string> }
      | undefined
    expect(spawnCall?.command).toBe('claude --resume claude-session')
    expect(spawnCall?.env?.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBeUndefined()
    expect(revealTerminalSession).toHaveBeenCalledWith(
      TEST_WORKTREE_ID,
      expect.objectContaining({
        launchConfig: {
          agentCommand: 'claude',
          agentArgs: '',
          agentEnv: { CLAUDE_PROFILE: 'captured' }
        },
        launchAgent: 'claude'
      })
    )
  })

  it('adopts renderer pane identity for remote runtime terminal creates', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-bg' })
    const runtime = new OrcaRuntimeService(store)
    const tabId = 'tab-remote-runtime'
    const leafId = '11111111-1111-4111-8111-111111111111'
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      focus: false,
      tabId,
      leafId,
      env: {
        ORCA_PANE_KEY: `${tabId}:${leafId}`,
        ORCA_TAB_ID: tabId
      }
    })

    const spawnedEnv =
      (spawn.mock.calls[0]?.[0] as { env?: Record<string, string> } | undefined)?.env ?? {}
    expect(spawnedEnv.ORCA_TAB_ID).toBe(tabId)
    expect(spawnedEnv.ORCA_PANE_KEY).toBe(`${tabId}:${leafId}`)
  })

  it('does not adopt web mirror ids as host terminal ids', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-bg' })
    const runtime = new OrcaRuntimeService(store)
    const tabId = 'web-terminal-host-tab-1'
    const leafId = '11111111-1111-4111-8111-111111111111'
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      focus: false,
      tabId,
      leafId
    })

    const spawnedEnv =
      (spawn.mock.calls[0]?.[0] as { env?: Record<string, string> } | undefined)?.env ?? {}
    expect(spawnedEnv.ORCA_TAB_ID).not.toBe(tabId)
    expect(spawnedEnv.ORCA_TAB_ID).not.toMatch(/^web-terminal-/)
    expect(spawnedEnv.ORCA_PANE_KEY).toMatch(`${spawnedEnv.ORCA_TAB_ID}:`)
  })

  it('creates background terminal sessions while the renderer graph is unavailable', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-bg' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    await expect(runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)).resolves.toMatchObject({
      worktreeId: TEST_WORKTREE_ID,
      surface: 'background'
    })
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: TEST_WORKTREE_ID,
        persistHostSessionBinding: true
      })
    )
  })

  // Why (flipped by the aug20 "windows 2" incident): #8646 scoped the persisted
  // binding to windowless promotion, which left a host-initiated terminal on a
  // host running the full app with neither a persisted tab nor runtime
  // ownership — unclassifiable, so graph sync pruned the tab off a live agent.
  // The renderer adopts under the pre-minted tabId, so persisting early cannot
  // fork a second tab; it only makes the host's own create durable.
  it('persists the host session binding even when a window is attached', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-bg' })
    const runtime = new OrcaRuntimeService(store)
    const webContents = { send: vi.fn() }
    electronMocks.BrowserWindow.fromId.mockReturnValue({
      isDestroyed: () => false,
      webContents
    } as never)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)

    const spawnOptions = spawn.mock.calls[0]?.[0] as
      | { persistHostSessionBinding?: boolean }
      | undefined
    expect(spawnOptions?.persistHostSessionBinding).toBe(true)
  })

  it('falls back to background terminal creation for renderer-backed requests without a renderer window', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-bg' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    await expect(
      runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
        command: 'codex',
        rendererBacked: true
      })
    ).resolves.toMatchObject({
      worktreeId: TEST_WORKTREE_ID,
      surface: 'background'
    })
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "codex '--dangerously-bypass-approvals-and-sandbox'",
        cwd: TEST_WORKTREE_PATH,
        worktreeId: TEST_WORKTREE_ID
      })
    )
  })

  // Why (#10333): `orca serve` publishes a ready graph under
  // HEADLESS_RUNTIME_WINDOW_ID with no BrowserWindow behind it, so every
  // focus-requested create used to fall through to getAuthoritativeWindow().
  const wireHeadlessServeRuntime = (): OrcaRuntimeService => {
    const runtime = new OrcaRuntimeService(store)
    electronMocks.BrowserWindow.fromId.mockReturnValue(null as never)
    runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
    return runtime
  }

  it('spawns focus-requested CLI terminal creates in background on headless serve', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-focus-headless' })
    const runtime = wireHeadlessServeRuntime()
    const revealTerminalSession = vi.fn()
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
      resumeSleepingAgents: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    } as never)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    // `orca terminal create --worktree <wt> --command "echo test" --focus`
    await expect(
      runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
        command: 'echo test',
        focus: true
      })
    ).resolves.toMatchObject({
      worktreeId: TEST_WORKTREE_ID,
      handle: expect.stringMatching(/^term_/)
    })
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'echo test',
        cwd: TEST_WORKTREE_PATH,
        worktreeId: TEST_WORKTREE_ID,
        persistHostSessionBinding: true
      })
    )
    // Why: degrading the create must not silently drop the focus request — the
    // host still asks whatever surface exists to activate the new pane.
    expect(revealTerminalSession).toHaveBeenCalledWith(
      TEST_WORKTREE_ID,
      expect.objectContaining({ activate: true, presentation: 'focused' })
    )
  })

  it('spawns presentation:focused terminal creates in background on headless serve', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-presentation-headless' })
    const runtime = wireHeadlessServeRuntime()
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    // Paired desktop `+` button: clients send presentation:'focused', not focus.
    await expect(
      runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
        command: 'codex',
        presentation: 'focused'
      })
    ).resolves.toMatchObject({
      worktreeId: TEST_WORKTREE_ID,
      surface: 'background',
      handle: expect.stringMatching(/^term_/)
    })
    expect(spawn).toHaveBeenCalled()
  })

  it('spawns focused agent-session creates in background on headless serve', async () => {
    // Why: RPC only downgrades `focused` for clients that report a clientKind
    // (#10193), so loopback/CLI callers still reach the runtime asking for focus.
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-agent-headless' })
    const runtime = wireHeadlessServeRuntime()
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    await expect(
      runtime.createAgentSession({
        clientOperationId: `${Date.now()}-0123456789abcdef0123456789abcdef`,
        worktree: `path:${TEST_WORKTREE_PATH}`,
        agent: 'codex',
        prompt: 'hello',
        presentation: 'focused'
      })
    ).resolves.toMatchObject({
      disposition: 'created',
      terminal: expect.objectContaining({
        worktreeId: TEST_WORKTREE_ID,
        handle: expect.stringMatching(/^term_/)
      })
    })
    expect(spawn).toHaveBeenCalled()
  })

  it('activates the paired mobile session tab for a degraded focused headless create', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-focus-publish' })
    const runtime = wireHeadlessServeRuntime()
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    const created = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'echo test',
      focus: true
    })

    // Why: with no renderer notifier on a serve host, the session-tab publish is
    // the only channel a paired client learns about the terminal on — a degraded
    // focused create must still land there selected, or focus is silently lost.
    const tabs = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    const published = tabs.tabs.find(
      (tab) => tab.type === 'terminal' && tab.parentTabId === created.tabId
    )
    expect(published).toBeDefined()
    expect(published?.isActive).toBe(true)
    expect(tabs.activeTabId).toBe(published?.id)
  })

  it('keeps focus-requested terminal creates on the renderer when a window exists', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-should-not-spawn' })
    const webContents = { send: vi.fn() }
    const send = vi.fn((_channel: string, payload: { requestId: string }) => {
      runtime.syncWindowGraph(1, {
        tabs: [
          {
            tabId: 'tab-focused',
            worktreeId: TEST_WORKTREE_ID,
            title: 'Focused Terminal',
            activeLeafId: 'pane:1',
            layout: null
          }
        ],
        leaves: [
          {
            tabId: 'tab-focused',
            worktreeId: TEST_WORKTREE_ID,
            leafId: 'pane:1',
            paneRuntimeId: 1,
            ptyId: 'pty-focused',
            paneTitle: null
          }
        ]
      })
      ipcMain.emit(
        'terminal:tabCreateReply',
        { sender: webContents },
        { requestId: payload.requestId, tabId: 'tab-focused', title: 'Focused Terminal' }
      )
    })
    webContents.send = send
    const runtime = new OrcaRuntimeService(store)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    electronMocks.BrowserWindow.fromId.mockReturnValue({
      isDestroyed: () => false,
      webContents
    })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    await expect(
      runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
        command: 'echo test',
        focus: true
      })
    ).resolves.toMatchObject({
      tabId: 'tab-focused',
      worktreeId: TEST_WORKTREE_ID,
      surface: 'visible'
    })
    expect(send).toHaveBeenCalledWith(
      'terminal:requestTabCreate',
      expect.objectContaining({ activate: true, presentation: 'focused' })
    )
    expect(spawn).not.toHaveBeenCalled()
  })

  it('accepts renderer-backed terminal create replies only from the target renderer', async () => {
    const webContents = { send: vi.fn() }
    const send = vi.fn((_channel: string, payload: { requestId: string }) => {
      ipcMain.emit(
        'terminal:tabCreateReply',
        { sender: { send: vi.fn() } },
        { requestId: payload.requestId, error: 'spoofed renderer reply' }
      )
      runtime.syncWindowGraph(1, {
        tabs: [
          {
            tabId: 'tab-renderer',
            worktreeId: TEST_WORKTREE_ID,
            title: 'Renderer Terminal',
            activeLeafId: 'pane:1',
            layout: null
          }
        ],
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
        { requestId: payload.requestId, tabId: 'tab-renderer', title: 'Renderer Terminal' }
      )
    })
    webContents.send = send
    const runtime = new OrcaRuntimeService(store)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    electronMocks.BrowserWindow.fromId.mockReturnValue({
      isDestroyed: () => false,
      webContents
    })

    await expect(
      runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
        command: 'codex',
        rendererBacked: true,
        title: 'Renderer Terminal'
      })
    ).resolves.toMatchObject({
      handle: expect.stringMatching(/^term_/),
      tabId: 'tab-renderer',
      title: 'Renderer Terminal',
      worktreeId: TEST_WORKTREE_ID,
      surface: 'visible'
    })
    expect(send).toHaveBeenCalledWith(
      'terminal:requestTabCreate',
      expect.objectContaining({
        requestId: expect.any(String),
        worktreeId: TEST_WORKTREE_ID,
        command: "codex '--dangerously-bypass-approvals-and-sandbox'",
        title: 'Renderer Terminal'
      })
    )
    expect(electronMocks.ipcMain.removeListener).toHaveBeenCalledWith(
      'terminal:tabCreateReply',
      expect.any(Function)
    )
  })

  it('splits visible pty-backed terminal sessions through the parent renderer tab', async () => {
    const spawn = vi
      .fn()
      .mockResolvedValueOnce({ id: 'pty-source' })
      .mockResolvedValueOnce({ id: 'pty-split' })
    const revealTerminalSession = vi.fn().mockResolvedValue({ tabId: 'tab-bg' })
    const splitTerminal = vi.fn()
    const runtime = new OrcaRuntimeService(store)
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
      splitTerminal,
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
    const sourceEnv =
      (spawn.mock.calls[0]?.[0] as { env?: Record<string, string> } | undefined)?.env ?? {}
    const sourceLeafId = sourceEnv.ORCA_PANE_KEY.slice(`${sourceEnv.ORCA_TAB_ID}:`.length)

    await expect(runtime.splitTerminal(handle, { direction: 'vertical' })).resolves.toMatchObject({
      handle: expect.stringMatching(/^term_/),
      tabId: sourceEnv.ORCA_TAB_ID,
      paneRuntimeId: -1
    })

    const splitEnv =
      (spawn.mock.calls[1]?.[0] as { env?: Record<string, string> } | undefined)?.env ?? {}
    const splitLeafId = splitEnv.ORCA_PANE_KEY.slice(`${sourceEnv.ORCA_TAB_ID}:`.length)
    expect(splitTerminal).not.toHaveBeenCalled()
    expect(splitEnv.ORCA_TAB_ID).toBe(sourceEnv.ORCA_TAB_ID)
    expect(splitEnv.ORCA_WORKTREE_ID).toBe(TEST_WORKTREE_ID)
    expect(revealTerminalSession).toHaveBeenLastCalledWith(TEST_WORKTREE_ID, {
      ptyId: 'pty-split',
      title: null,
      activate: true,
      tabId: sourceEnv.ORCA_TAB_ID,
      leafId: splitLeafId,
      splitFromLeafId: sourceLeafId,
      splitDirection: 'vertical'
    })

    // Why: client renders the tab from one sibling's parentLayout, so all siblings must carry the direction or Split Right flips down.
    const publishedTabs = runtime['mobileSessionTabsByWorktree'].get(TEST_WORKTREE_ID)!.tabs
    const siblingSurfaces = publishedTabs.filter(
      (tab): tab is Extract<typeof tab, { type: 'terminal' }> =>
        tab.type === 'terminal' && tab.parentTabId === sourceEnv.ORCA_TAB_ID
    )
    expect(siblingSurfaces.length).toBe(2)
    for (const surface of siblingSurfaces) {
      expect(surface.parentLayout?.root).toMatchObject({ type: 'split', direction: 'vertical' })
    }
  })

  it('keeps a persisted split when mounted renderer adoption rejects', async () => {
    const tabId = 'persisted-mounted-tab'
    const ptyId = 'persisted-mounted-pty'
    const splitPtyId = 'persisted-mounted-split-pty'
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({
        tabsByWorktree: {
          [TEST_WORKTREE_ID]: [
            {
              id: tabId,
              ptyId,
              worktreeId: TEST_WORKTREE_ID,
              title: 'Persisted terminal',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        },
        terminalLayoutsByTabId: {
          [tabId]: makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: ptyId })
        }
      })
    )
    const revealTerminalSession = vi.fn().mockRejectedValue(new Error('renderer rejected'))
    const kill = vi.fn(() => true)
    let resolveSpawn!: (result: { id: string }) => void
    const spawn = vi.fn(
      (_args: unknown) =>
        new Promise<{ id: string }>((resolve) => {
          resolveSpawn = resolve
        })
    )
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({ revealTerminalSession } as never)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    runtime.registerPty(ptyId, TEST_WORKTREE_ID, null, {
      tabId,
      leafId: HEADLESS_LEAF_ID,
      incarnationId: 'live-source-incarnation'
    })
    const internals = runtime as unknown as {
      issuePtyHandle: (pty: unknown) => string
      ptysById: Map<string, unknown>
    }
    const handle = internals.issuePtyHandle(internals.ptysById.get(ptyId))
    const split = runtime.splitTerminal(handle, { direction: 'horizontal' })
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce())
    const splitSpawn = spawn.mock.calls[0]?.[0] as
      | { expectedSourceBinding?: { incarnationId?: string } }
      | undefined
    // Why: persistence never recorded an incarnation for this pane, so sending the live-only id
    // would make the store's fence reject every split from a restored session.
    expect(splitSpawn?.expectedSourceBinding).not.toHaveProperty('incarnationId')

    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          title: 'Persisted terminal',
          activeLeafId: HEADLESS_LEAF_ID,
          layout: { type: 'leaf', leafId: HEADLESS_LEAF_ID }
        }
      ],
      leaves: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          leafId: HEADLESS_LEAF_ID,
          paneRuntimeId: 1,
          ptyId
        }
      ]
    })
    resolveSpawn({ id: splitPtyId })

    await expect(split).resolves.toMatchObject({
      tabId,
      handle: expect.stringMatching(/^term_/)
    })

    expect(revealTerminalSession).toHaveBeenCalledOnce()
    expect(kill).not.toHaveBeenCalled()
    expect(getSession().terminalLayoutsByTabId[tabId]?.root).toMatchObject({
      type: 'split',
      direction: 'horizontal'
    })
  })

  it('rejects a persisted split closed during spawn without recreating its tab', async () => {
    const tabId = 'closing-persisted-tab'
    const ptyId = 'closing-persisted-pty'
    const { runtimeStore, getSession, setSession } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({
        tabsByWorktree: {
          [TEST_WORKTREE_ID]: [
            {
              id: tabId,
              ptyId,
              worktreeId: TEST_WORKTREE_ID,
              title: 'Closing terminal',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        },
        terminalLayoutsByTabId: {
          [tabId]: makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: ptyId })
        }
      })
    )
    let resolveSpawn!: (result: { id: string }) => void
    const spawn = vi.fn(
      (_args: unknown) =>
        new Promise<{ id: string }>((resolve) => {
          resolveSpawn = resolve
        })
    )
    const kill = vi.fn(() => false)
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill,
      getForegroundProcess: async () => null
    })
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    runtime.registerPty(ptyId, TEST_WORKTREE_ID, null, {
      tabId,
      leafId: HEADLESS_LEAF_ID
    })
    const internals = runtime as unknown as {
      issuePtyHandle: (pty: unknown) => string
      ptysById: Map<string, unknown>
    }
    const handle = internals.issuePtyHandle(internals.ptysById.get(ptyId))
    const split = runtime.splitTerminal(handle, { direction: 'vertical' })
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce())

    setSession(getDefaultWorkspaceSession())
    runtimeStore.persistPtyBinding.mockReturnValue(false)
    resolveSpawn({ id: 'rejected-split-pty' })

    await expect(split).rejects.toThrow('terminal_split_source_not_found')
    expect(spawn.mock.calls[0]?.[0]).toMatchObject({
      persistHostSessionBinding: true,
      expectedSourceBinding: {
        worktreeId: TEST_WORKTREE_ID,
        tabId,
        leafId: HEADLESS_LEAF_ID,
        ptyId
      }
    })
    expect(kill).toHaveBeenCalledWith('rejected-split-pty')
    expect(getSession().tabsByWorktree[TEST_WORKTREE_ID]).toBeUndefined()
    expect(getSession().terminalLayoutsByTabId[tabId]).toBeUndefined()
  })

  it('rejects a projected split retired during spawn before publishing the new pane', async () => {
    let resolveSplitSpawn!: (result: { id: string }) => void
    const spawn = vi
      .fn()
      .mockResolvedValueOnce({ id: 'projected-source-pty' })
      .mockImplementationOnce(
        () =>
          new Promise<{ id: string }>((resolve) => {
            resolveSplitSpawn = resolve
          })
      )
    const kill = vi.fn(() => true)
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill,
      getForegroundProcess: async () => null
    })
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
    const split = runtime.splitTerminal(handle, { direction: 'vertical' })
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2))

    runtime['mobileSessionTabsByWorktree'].delete(TEST_WORKTREE_ID)
    resolveSplitSpawn({ id: 'retired-projected-split-pty' })

    await expect(split).rejects.toThrow('terminal_split_source_not_found')
    expect(kill).toHaveBeenCalledWith('retired-projected-split-pty')
    expect(runtime['mobileSessionTabsByWorktree'].has(TEST_WORKTREE_ID)).toBe(false)
  })

  it('splits folder workspace pty-backed terminal sessions with folder cwd and env', async () => {
    const folderPath = await mkdtemp(join(tmpdir(), 'orca-runtime-folder-split-'))
    const spawn = vi
      .fn()
      .mockResolvedValueOnce({ id: 'pty-folder-source' })
      .mockResolvedValueOnce({ id: 'pty-folder-split' })
    const revealTerminalSession = vi.fn().mockResolvedValue({ tabId: 'tab-folder' })
    const folderWorkspace = makeFolderWorkspace({ folderPath })
    const projectGroup = makeFolderProjectGroup({ parentPath: folderPath })
    const runtime = new OrcaRuntimeService(
      createFolderWorkspaceRuntimeStore(folderWorkspace, projectGroup) as never
    )
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
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    const { handle } = await runtime.createTerminal(TEST_FOLDER_WORKSPACE_KEY)
    const sourceCall = spawn.mock.calls[0]?.[0] as
      | { cwd?: string; env?: Record<string, string>; worktreeId?: string }
      | undefined
    const sourceEnv = sourceCall?.env ?? {}
    const sourceLeafId = sourceEnv.ORCA_PANE_KEY.slice(`${sourceEnv.ORCA_TAB_ID}:`.length)

    await expect(runtime.splitTerminal(handle, { direction: 'vertical' })).resolves.toMatchObject({
      handle: expect.stringMatching(/^term_/),
      tabId: sourceEnv.ORCA_TAB_ID,
      paneRuntimeId: -1
    })

    const splitCall = spawn.mock.calls[1]?.[0] as
      | { cwd?: string; env?: Record<string, string>; worktreeId?: string }
      | undefined
    const splitEnv = splitCall?.env ?? {}
    const splitLeafId = splitEnv.ORCA_PANE_KEY.slice(`${sourceEnv.ORCA_TAB_ID}:`.length)
    expect(sourceCall).toMatchObject({
      cwd: folderPath,
      worktreeId: TEST_FOLDER_WORKSPACE_KEY
    })
    expect(splitCall).toMatchObject({
      cwd: folderPath,
      worktreeId: TEST_FOLDER_WORKSPACE_KEY
    })
    expectStablePaneKeyEnv(splitEnv)
    expect(splitEnv.ORCA_TAB_ID).toBe(sourceEnv.ORCA_TAB_ID)
    expect(splitEnv.ORCA_WORKSPACE_ID).toBe(TEST_FOLDER_WORKSPACE_KEY)
    expect(splitEnv.ORCA_PROJECT_GROUP_ID).toBe(TEST_FOLDER_PROJECT_GROUP_ID)
    expect(splitEnv.ORCA_WORKSPACE_ROOT).toBe(folderPath)
    expect(splitEnv.ORCA_WORKTREE_ID).toBe(TEST_FOLDER_WORKSPACE_KEY)
    expect(revealTerminalSession).toHaveBeenLastCalledWith(TEST_FOLDER_WORKSPACE_KEY, {
      ptyId: 'pty-folder-split',
      title: null,
      activate: true,
      tabId: sourceEnv.ORCA_TAB_ID,
      leafId: splitLeafId,
      splitFromLeafId: sourceLeafId,
      splitDirection: 'vertical'
    })
  })

  it('atomically admits persisted SSH splits in the SSH host partition', async () => {
    const tabId = 'ssh-split-tab'
    const sourcePtyId = 'ssh:ssh-1@@source-pty'
    const splitPtyId = 'ssh:ssh-1@@split-pty'
    const remoteRepo = { ...store.getRepo(TEST_REPO_ID)!, connectionId: 'ssh-1' }
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({
        tabsByWorktree: {
          [TEST_WORKTREE_ID]: [
            {
              id: tabId,
              ptyId: sourcePtyId,
              worktreeId: TEST_WORKTREE_ID,
              title: 'SSH terminal',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        },
        terminalLayoutsByTabId: {
          [tabId]: makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: sourcePtyId })
        }
      }),
      'ssh:ssh-1'
    )
    const spawn = vi.fn().mockResolvedValue({ id: splitPtyId })
    const runtime = new OrcaRuntimeService({
      ...runtimeStore,
      getRepos: () => [remoteRepo],
      getRepo: (id: string) => (id === TEST_REPO_ID ? remoteRepo : undefined)
    } as never)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    runtime.registerPty(sourcePtyId, TEST_WORKTREE_ID, 'ssh-1', {
      tabId,
      leafId: HEADLESS_LEAF_ID
    })
    const internals = runtime as unknown as {
      issuePtyHandle: (pty: unknown) => string
      ptysById: Map<string, unknown>
    }
    const handle = internals.issuePtyHandle(internals.ptysById.get(sourcePtyId))

    await expect(runtime.splitTerminal(handle, { direction: 'vertical' })).resolves.toMatchObject({
      tabId,
      handle: expect.stringMatching(/^term_/)
    })

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: 'ssh-1',
        worktreeId: TEST_WORKTREE_ID,
        persistHostSessionBinding: true,
        expectedSourceBinding: expect.objectContaining({
          worktreeId: TEST_WORKTREE_ID,
          tabId,
          leafId: HEADLESS_LEAF_ID,
          ptyId: sourcePtyId
        })
      })
    )
    expect(getSession().terminalLayoutsByTabId[tabId]?.root).toMatchObject({
      type: 'split',
      direction: 'vertical'
    })
  })

  it('returns an actionable discoverability warning when default adoption fails after spawn', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-bg' })
    const revealTerminalSession = vi.fn().mockRejectedValue(new Error('Renderer timed out'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const runtime = new OrcaRuntimeService(store)
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

    try {
      const created = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
      expect(created).toMatchObject({
        worktreeId: TEST_WORKTREE_ID,
        surface: 'background',
        handle: expect.stringMatching(/^term_/)
      })
      expect(created.warning).toContain('Renderer timed out')
      expect(created.warning).toContain('could not make it discoverable')
      expect(created.warning).toContain(`orca terminal focus --terminal ${created.handle}`)
      const spawnCall = spawn.mock.calls[0]?.[0] as { env?: Record<string, string> } | undefined
      const spawnedEnv = spawnCall?.env ?? {}
      expectStablePaneKeyEnv(spawnedEnv)
      const spawnedLeafId = spawnedEnv.ORCA_PANE_KEY.slice(`${spawnedEnv.ORCA_TAB_ID}:`.length)
      expect(revealTerminalSession).toHaveBeenCalledWith(TEST_WORKTREE_ID, {
        ptyId: 'pty-bg',
        title: null,
        activate: false,
        tabId: spawnedEnv.ORCA_TAB_ID,
        leafId: spawnedLeafId
      })
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('[terminal-create] failed to create inactive tab for pty-bg:'),
        expect.any(Error)
      )
    } finally {
      warn.mockRestore()
    }
  })

  it('returns an actionable warning when default discoverability has no renderer notifier', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-bg' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    const created = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)

    expect(created).toMatchObject({
      worktreeId: TEST_WORKTREE_ID,
      surface: 'background',
      handle: expect.stringMatching(/^term_/)
    })
    expect(created.warning).toContain('could not make it discoverable')
    expect(created.warning).toContain(`orca terminal focus --terminal ${created.handle}`)
  })

  it('does not warn when background presentation has no renderer notifier', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-bg' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    const created = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      presentation: 'background'
    })

    expect(created).toMatchObject({
      worktreeId: TEST_WORKTREE_ID,
      surface: 'background',
      handle: expect.stringMatching(/^term_/)
    })
    expect(created.warning).toBeUndefined()
  })

  it('waits for exit on background terminal handles', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)

    const waiting = runtime.waitForTerminal(handle, { condition: 'exit', timeoutMs: 1000 })
    runtime.onPtyExit('pty-bg', 7)

    await expect(waiting).resolves.toMatchObject({
      handle,
      condition: 'exit',
      status: 'exited',
      exitCode: 7
    })
    await expect(runtime.readTerminal(handle)).resolves.toMatchObject({
      status: 'exited'
    })
  })

  it('observes setup command completion without waiting for its interactive shell to exit', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-setup' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
    ;(
      runtime as unknown as { setupCompletionTokenByPtyId: Map<string, string> }
    ).setupCompletionTokenByPtyId.set('pty-setup', 'token-live')

    const waiting = runtime.waitForSetupTerminalCompletion(handle)
    runtime.onPtyData(
      'pty-setup',
      'setup failed\r\n__ORCA_SETUP_COMPLETE__:token-live:17\r\nPS>',
      100
    )

    await expect(waiting).resolves.toEqual({ exitCode: 17 })
    await expect(runtime.readTerminal(handle)).resolves.toMatchObject({ status: 'running' })
  })

  it('replays fast setup completion emitted before its observer is registered', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-fast-setup' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
    ;(
      runtime as unknown as { setupCompletionTokenByPtyId: Map<string, string> }
    ).setupCompletionTokenByPtyId.set('pty-fast-setup', 'token-fast')
    runtime.onPtyData(
      'pty-fast-setup',
      '__ORCA_SETUP_COMPLETE__:wrong:9\r\n__ORCA_SETUP_COMPLETE__:token-fast:0\r\n$',
      100
    )

    await expect(runtime.waitForSetupTerminalCompletion(handle)).resolves.toEqual({ exitCode: 0 })
  })

  it('falls back to setup terminal exit when no completion signal is available', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-legacy-setup' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)

    const waiting = runtime.waitForSetupTerminalCompletion(handle)
    runtime.onPtyExit('pty-legacy-setup', 9)

    await expect(waiting).resolves.toEqual({ exitCode: 9 })
  })

  it('keeps observing after an uncertain setup terminal status', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-uncertain-setup' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
    ;(
      runtime as unknown as { setupCompletionTokenByPtyId: Map<string, string> }
    ).setupCompletionTokenByPtyId.set('pty-uncertain-setup', 'token-uncertain')
    vi.spyOn(runtime, 'waitForTerminal').mockResolvedValue({
      handle,
      condition: 'exit',
      satisfied: false,
      status: 'unknown',
      exitCode: null
    })

    const waiting = runtime.waitForSetupTerminalCompletion(handle)
    await Promise.resolve()
    runtime.onPtyData('pty-uncertain-setup', '__ORCA_SETUP_COMPLETE__:token-uncertain:0\r\n', 100)

    await expect(waiting).resolves.toEqual({ exitCode: 0 })
  })

  it('drops retained PTY transcript memory when a background terminal exits', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)

    runtime.onPtyData(
      'pty-bg',
      `${Array.from({ length: 20 }, (_, i) => `line-${i}`).join('\n')}\nwrote /tmp/exited-result.json\n`,
      100
    )
    await expect(runtime.readTerminal(handle)).resolves.toMatchObject({
      status: 'running',
      tail: expect.arrayContaining(['line-0'])
    })

    runtime.onPtyExit('pty-bg', 0)

    const pty = (
      runtime as unknown as {
        ptysById: Map<
          string,
          {
            tailBuffer: string[]
            tailPartialLine: string
            tailLinesTotal: number
            tailTruncated: boolean
          }
        >
        recentPtyPathCandidatesById: Map<string, string[]>
      }
    ).ptysById.get('pty-bg')
    expect(pty).toMatchObject({
      tailBuffer: [],
      tailPartialLine: '',
      tailLinesTotal: 0,
      tailTruncated: false
    })
    await expect(runtime.readTerminal(handle)).resolves.toMatchObject({
      status: 'exited',
      tail: []
    })
    expect(
      (
        runtime as unknown as { recentPtyPathCandidatesById: Map<string, string[]> }
      ).recentPtyPathCandidatesById.has('pty-bg')
    ).toBe(false)
  })

  it('bounds disconnected background PTY records and their synthetic handles', async () => {
    let nextPtyIndex = 0
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockImplementation(async () => ({ id: `pty-bg-${nextPtyIndex++}` })),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    const handles: string[] = []
    for (let index = 0; index < 140; index += 1) {
      const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
      handles.push(handle)
      runtime.onPtyData(`pty-bg-${index}`, `wrote /tmp/result-${index}.json\n`, 100 + index)
      runtime.onPtyExit(`pty-bg-${index}`, 0)
    }

    const internals = runtime as unknown as {
      ptysById: Map<string, unknown>
      handles: Map<string, unknown>
      handleByPtyId: Map<string, string>
      recentPtyPathCandidatesById: Map<string, string[]>
    }
    expect(internals.ptysById.size).toBeLessThanOrEqual(128)
    expect(internals.ptysById.has('pty-bg-0')).toBe(false)
    expect(internals.ptysById.has('pty-bg-139')).toBe(true)
    expect(internals.handleByPtyId.has('pty-bg-0')).toBe(false)
    expect(internals.handles.has(handles[0]!)).toBe(false)
    expect(internals.recentPtyPathCandidatesById.has('pty-bg-0')).toBe(false)

    await expect(runtime.readTerminal(handles[0]!)).rejects.toThrow('terminal_handle_stale')
    await expect(runtime.readTerminal(handles.at(-1)!)).resolves.toMatchObject({
      status: 'exited'
    })
  })

  it('keeps retained PTY transcript memory when controller refresh omits a record', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => []
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    runtime.registerPty('daemon-pty-1', TEST_WORKTREE_ID)
    runtime.onPtyData('daemon-pty-1', 'still live\npartial', 100)

    await runtime.listTerminals()

    const pty = (
      runtime as unknown as {
        ptysById: Map<
          string,
          {
            connected: boolean
            tailBuffer: string[]
            tailPartialLine: string
            tailLinesTotal: number
          }
        >
      }
    ).ptysById.get('daemon-pty-1')
    expect(pty).toMatchObject({
      connected: false,
      tailBuffer: ['still live'],
      tailPartialLine: 'partial',
      tailLinesTotal: 1
    })
  })

  it('keeps retained PTY transcript memory when controller refresh fails', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => {
        throw new Error('controller unavailable')
      }
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    runtime.registerPty('daemon-pty-1', TEST_WORKTREE_ID)
    runtime.onPtyData('daemon-pty-1', 'still live\npartial', 100)

    await runtime.listTerminals()

    const pty = (
      runtime as unknown as {
        ptysById: Map<
          string,
          {
            connected: boolean
            tailBuffer: string[]
            tailPartialLine: string
            tailLinesTotal: number
          }
        >
      }
    ).ptysById.get('daemon-pty-1')
    expect(pty).toMatchObject({
      connected: true,
      tailBuffer: ['still live'],
      tailPartialLine: 'partial',
      tailLinesTotal: 1
    })
  })

  it('keeps retained PTY transcript memory when controller refresh times out', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      runtime.setPtyController({
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null,
        listProcesses: () => new Promise(() => {})
      })
      runtime.attachWindow(1)
      runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
      runtime.registerPty('daemon-pty-1', TEST_WORKTREE_ID)
      runtime.onPtyData('daemon-pty-1', 'still live\npartial', 100)

      const terminals = runtime.listTerminals()
      await vi.advanceTimersByTimeAsync(3_000)
      await terminals

      const pty = (
        runtime as unknown as {
          ptysById: Map<
            string,
            {
              connected: boolean
              tailBuffer: string[]
              tailPartialLine: string
              tailLinesTotal: number
            }
          >
        }
      ).ptysById.get('daemon-pty-1')
      expect(pty).toMatchObject({
        connected: true,
        tailBuffer: ['still live'],
        tailPartialLine: 'partial',
        tailLinesTotal: 1
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('resolves tui-idle for adopted background PTY handles from the renderer title', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)

    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-bg',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Codex ready',
          activeLeafId: 'pane-bg',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-bg',
          worktreeId: TEST_WORKTREE_ID,
          leafId: 'pane-bg',
          paneRuntimeId: 1,
          ptyId: 'pty-bg',
          paneTitle: null
        }
      ]
    })

    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 1_000 })
    ).resolves.toMatchObject({
      handle,
      condition: 'tui-idle',
      status: 'running'
    })
  })

  it('resolves live-leaf tui-idle from an OpenCode native title', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    syncSinglePty(runtime, 'remote:pty-1', {
      tabTitle: 'repo terminal',
      paneTitle: 'ssh build-host | OC | Native session'
    })
    const [terminal] = (await runtime.listTerminals()).terminals

    await expect(
      runtime.waitForTerminal(terminal.handle, { condition: 'tui-idle', timeoutMs: 1_000 })
    ).resolves.toMatchObject({
      handle: terminal.handle,
      condition: 'tui-idle',
      status: 'running'
    })
  })

  it('does not treat a Codex launch title as tui-idle readiness', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      const serializeProviderBuffer = vi.fn().mockResolvedValue({
        data: 'OpenAI Codex\r\nmodel: gpt-5.5\r\ndirectory: /repo\r\n',
        cols: 80,
        rows: 24,
        seq: 1
      })
      runtime.setPtyController({
        spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null,
        serializeProviderBuffer
      })
      const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)

      runtime.attachWindow(1)
      runtime.syncWindowGraph(1, {
        tabs: [
          {
            tabId: 'tab-bg',
            worktreeId: TEST_WORKTREE_ID,
            title: 'Codex YOLO',
            activeLeafId: 'pane-bg',
            layout: null
          }
        ],
        leaves: [
          {
            tabId: 'tab-bg',
            worktreeId: TEST_WORKTREE_ID,
            leafId: 'pane-bg',
            paneRuntimeId: 1,
            ptyId: 'pty-bg',
            paneTitle: null
          }
        ]
      })

      const waitPromise = runtime.waitForTerminal(handle, {
        condition: 'tui-idle',
        timeoutMs: 1_000
      })
      const timeoutAssertion = expect(waitPromise).rejects.toThrow('timeout')

      await vi.advanceTimersByTimeAsync(2_000)

      await timeoutAssertion
      expect(serializeProviderBuffer).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('resolves tui-idle from a Codex ready prompt preview', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
    runtime.onPtyData(
      'pty-bg',
      [
        ' >_ OpenAI Codex (v0.131.0)\n',
        ' model:       gpt-5.5 high   /model to change\n',
        ' directory:   ~/orca/workspaces/orca/cli-debug\n'
      ].join(''),
      Date.now()
    )

    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 1_000 })
    ).resolves.toMatchObject({
      handle,
      condition: 'tui-idle',
      status: 'running'
    })
  })

  it('resolves tui-idle from an Antigravity ready prompt preview', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
    runtime.onPtyData('pty-bg', antigravityReadyScreen('Gemini 4 Experimental (High)'), Date.now())

    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 1_000 })
    ).resolves.toMatchObject({
      handle,
      condition: 'tui-idle',
      status: 'running'
    })
  })

  it('resolves Antigravity ready prompts with newline-heavy pasted tails without splitting', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
    let pastedTail = ''
    for (let index = 0; index < 90; index += 1) {
      pastedTail += `${'pasted text '.repeat(25)}${index}\n`
    }
    const splitSpy = vi.spyOn(String.prototype, 'split')

    runtime.onPtyData(
      'pty-bg',
      [
        'Antigravity CLI 1.0.3\n',
        'user@example.com (Antigravity Business)\n',
        pastedTail,
        'Gemini 4 Experimental (High)\n',
        '~/orca/workspaces/orca/agy-dispatch-issue\n',
        '>'
      ].join(''),
      Date.now()
    )

    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 1_000 })
    ).resolves.toMatchObject({
      handle,
      condition: 'tui-idle',
      satisfied: true,
      status: 'running'
    })
    const splitReadyTail = splitSpy.mock.contexts.some((context) => {
      const value = typeof context === 'string' ? context : String(context)
      return value.includes('antigravity cli') && value.includes('pasted text pasted text')
    })
    expect(splitReadyTail).toBe(false)
  })

  it('resolves tui-idle from an Antigravity prompt before the model line', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
    runtime.onPtyData(
      'pty-bg',
      [
        'Do you trust this workspace directory?\n',
        'Press t to trust\n',
        antigravityPromptBeforeModelReadyScreen('Gemini 3.5 Flash (High)')
      ].join(''),
      Date.now()
    )

    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 1_000 })
    ).resolves.toMatchObject({
      handle,
      condition: 'tui-idle',
      satisfied: true,
      status: 'running'
    })
  })

  it('resolves live-leaf tui-idle from an Antigravity ready prompt preview', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Terminal',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-1',
          paneTitle: null
        }
      ]
    })
    runtime.onPtyData('pty-1', antigravityReadyScreen(), Date.now())
    const [terminal] = (await runtime.listTerminals()).terminals

    await expect(
      runtime.waitForTerminal(terminal.handle, { condition: 'tui-idle', timeoutMs: 1_000 })
    ).resolves.toMatchObject({
      handle: terminal.handle,
      condition: 'tui-idle',
      status: 'running'
    })
  })

  it('resolves tui-idle from a Codex ready prompt even when stale startup lines remain', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
    runtime.onPtyData(
      'pty-bg',
      [
        'Booting MCP server: computer-use(0s  esc to interrupt)\n',
        ' >_ OpenAI Codex (v0.132.0)\n',
        ' model:       gpt-5.5 high   /model to change\n',
        ' directory:   ~/orca/workspaces/orca/cli-debug\n',
        [
          'Starting MCP servers (0/2): codex_apps, computer-use (2s  esc to interrupt)',
          'Run /review on my current changes gpt-5.5 high ~/orca/workspaces/orca/cli-debug',
          'Run /review on my current changes gpt-5.5 high ~/orca/workspaces/orca/cli-debug',
          'Run /review on my current changes gpt-5.5 high ~/orca/workspaces/orca/cli-debug',
          'Run /review on my current changes gpt-5.5 high ~/orca/workspaces/orca/cli-debug\n'
        ].join('')
      ].join(''),
      Date.now()
    )

    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 1_000 })
    ).resolves.toMatchObject({
      handle,
      condition: 'tui-idle',
      satisfied: true,
      status: 'running'
    })
  })

  it('resolves tui-idle when a stale Codex prompt is followed by Antigravity readiness', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
    runtime.onPtyData(
      'pty-bg',
      [
        'Do you trust this workspace directory?\n',
        'Press t to trust\n',
        antigravityReadyScreen(),
        '\n'
      ].join(''),
      Date.now()
    )

    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 1_000 })
    ).resolves.toMatchObject({
      handle,
      condition: 'tui-idle',
      satisfied: true,
      status: 'running'
    })
  })

  it('resolves tui-idle when a stale Codex prompt is followed by the ready header', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
    runtime.onPtyData(
      'pty-bg',
      [
        'Choose working directory to resume this session\n',
        'Press enter to continue\n',
        ' >_ OpenAI Codex (v0.132.0)\n',
        ' model:       gpt-5.5 high   /model to change\n',
        ' directory:   ~/orca/workspaces/orca/cli-debug\n'
      ].join(''),
      Date.now()
    )

    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 1_000 })
    ).resolves.toMatchObject({
      handle,
      condition: 'tui-idle',
      satisfied: true,
      status: 'running'
    })
  })

  it('blocks tui-idle when a newer prompt follows a stale prompt and ready header', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'codex'
    })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
    runtime.onPtyData(
      'pty-bg',
      [
        'Update available! 0.131.0 -> 0.132.0\n',
        'Press enter to continue\n',
        ' >_ OpenAI Codex (v0.132.0)\n',
        ' model:       gpt-5.5 high   /model to change\n',
        ' directory:   ~/orca/workspaces/orca/cli-debug\n',
        'Hooks need review\n',
        'Press enter to confirm\n'
      ].join(''),
      Date.now()
    )

    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 1_000 })
    ).resolves.toMatchObject({
      handle,
      condition: 'tui-idle',
      satisfied: false,
      status: 'running',
      blockedReason: 'codex-hooks-review-prompt'
    })
  })

  it('returns a blocked wait result for Codex update prompts', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
    runtime.onPtyData(
      'pty-bg',
      [
        'Update available! 0.131.0 -> 0.132.0\n',
        '1. Update now\n',
        '2. Skip\n',
        'Press enter to continue\n'
      ].join(''),
      Date.now()
    )

    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 1_000 })
    ).resolves.toMatchObject({
      handle,
      condition: 'tui-idle',
      satisfied: false,
      status: 'running',
      blockedReason: 'codex-update-prompt'
    })
  })

  it('returns a blocked wait result for Codex workspace trust prompts', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
    runtime.onPtyData(
      'pty-bg',
      'Do you trust this workspace directory?\n1. Yes\n2. No\n',
      Date.now()
    )

    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 1_000 })
    ).resolves.toMatchObject({
      handle,
      condition: 'tui-idle',
      satisfied: false,
      status: 'running',
      blockedReason: 'codex-trust-workspace'
    })
  })

  it('resolves tui-idle for an idle Cursor lane past its dismissed trust dialog (#8210)', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'cursor-agent'
    })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
    // Cursor's dismissed trust dialog stays in scrollback; the later idle prompt must clear that stale hit and satisfy idle.
    runtime.onPtyData(
      'pty-bg',
      [
        // Trust dialog mentions "Cursor Agent" before the ready banner; lastIndexOf must pick the later banner, not this hit.
        'Cursor Agent\n',
        '⚠ Workspace Trust Required\n',
        'Do you trust the contents of this directory?\n',
        '  ▶ [a] Trust this workspace\n',
        '    [q] Quit\n',
        cursorReadyScreen()
      ].join(''),
      Date.now()
    )

    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 1_000 })
    ).resolves.toMatchObject({
      handle,
      condition: 'tui-idle',
      satisfied: true,
      status: 'running'
    })
  })

  it('does not block a mid-run Cursor lane on its dismissed trust dialog (#8210)', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'cursor-agent'
    })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
    runtime.onPtyData(
      'pty-bg',
      [
        // Same earlier "Cursor Agent" hit as the idle case — banner must win.
        'Cursor Agent\n',
        '⚠ Workspace Trust Required\n',
        'Do you trust the contents of this directory?\n',
        '  ▶ [a] Trust this workspace\n',
        '    [q] Quit\n',
        cursorBusyScreen()
      ].join(''),
      Date.now()
    )

    // Busy Cursor is neither blocked nor idle, so the wait times out honestly instead of returning a stale trust block.
    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 200 })
    ).rejects.toThrow('timeout')
  })

  it('returns a blocked wait result for Codex cwd selection prompts', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'codex'
    })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
    runtime.onPtyData(
      'pty-bg',
      [
        'Choose working directory to resume this session\n',
        '  Session = latest cwd recorded in the resumed session\n',
        '  Current = your current working directory\n',
        '  Press enter to continue\n'
      ].join(''),
      Date.now()
    )

    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 1_000 })
    ).resolves.toMatchObject({
      handle,
      condition: 'tui-idle',
      satisfied: false,
      status: 'running',
      blockedReason: 'codex-cwd-prompt'
    })
  })

  it('returns a blocked wait result for Codex model migration prompts', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'codex'
    })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
    runtime.onPtyData(
      'pty-bg',
      [
        'Codex just got an upgrade. Introducing gpt-5.1-codex-max.\n',
        'We recommend switching from gpt-5-codex to gpt-5.1-codex-max.\n',
        'Press enter to continue\n'
      ].join(''),
      Date.now()
    )

    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 1_000 })
    ).resolves.toMatchObject({
      handle,
      condition: 'tui-idle',
      satisfied: false,
      status: 'running',
      blockedReason: 'codex-model-migration-prompt'
    })
  })

  it('returns a blocked wait result for Codex startup hook review prompts', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'codex'
    })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
    runtime.onPtyData(
      'pty-bg',
      [
        'Hooks need review\n',
        '2 hooks are new or changed.\n',
        '1. Review hooks\n',
        '2. Trust all and continue\n',
        'Press enter to confirm or esc to go back\n'
      ].join(''),
      Date.now()
    )

    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 1_000 })
    ).resolves.toMatchObject({
      handle,
      condition: 'tui-idle',
      satisfied: false,
      status: 'running',
      blockedReason: 'codex-hooks-review-prompt'
    })
  })

  it('returns a blocked wait result for generic Codex interactive prompts', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'codex'
    })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
    runtime.onPtyData(
      'pty-bg',
      [
        'Would you like to grant these permissions?\n',
        '1. Yes, grant these permissions for this turn\n',
        '2. No, continue without permissions\n',
        'Press enter to confirm or esc to cancel\n'
      ].join(''),
      Date.now()
    )

    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 1_000 })
    ).resolves.toMatchObject({
      handle,
      condition: 'tui-idle',
      satisfied: false,
      status: 'running',
      blockedReason: 'codex-interactive-prompt'
    })
  })

  it('does not classify unrelated press-enter prompts as Codex blocked prompts', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      runtime.setPtyController({
        spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null
      })
      const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
      runtime.onPtyData('pty-bg', 'Press enter to continue\n', Date.now())

      const waitPromise = runtime.waitForTerminal(handle, {
        condition: 'tui-idle',
        timeoutMs: 1_000
      })
      const timeoutAssertion = expect(waitPromise).rejects.toThrow('timeout')

      await vi.advanceTimersByTimeAsync(2_000)

      await timeoutAssertion
    } finally {
      vi.useRealTimers()
    }
  })

  it('resolves tui-idle for quiet background PTY agents without OSC titles', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      runtime.setPtyController({
        spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => 'codex'
      })
      const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
      runtime.onPtyData('pty-bg', 'OpenAI Codex\n', Date.now())

      const waitPromise = runtime.waitForTerminal(handle, {
        condition: 'tui-idle',
        timeoutMs: 10_000
      })
      const waitAssertion = expect(waitPromise).resolves.toMatchObject({
        handle,
        condition: 'tui-idle',
        status: 'running'
      })

      await vi.advanceTimersByTimeAsync(6_000)

      await waitAssertion
    } finally {
      vi.useRealTimers()
    }
  })

  it('splits text and enter writes for background terminal handles', async () => {
    const writes: string[] = []
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: (_ptyId, data) => {
        writes.push(data)
        return true
      },
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)

    await runtime.sendTerminal(handle, { text: 'continue', enter: true })

    expect(writes).toEqual(['continue', '\r'])
  })

  it('sends agent prompts as bracketed paste before submit', async () => {
    vi.useFakeTimers()
    try {
      const writes: string[] = []
      const runtime = new OrcaRuntimeService(store)
      runtime.setPtyController({
        spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
        write: (_ptyId, data) => {
          writes.push(data)
          acknowledgeAgentPromptSubmit(runtime, 'pty-bg', data)
          return true
        },
        kill: () => true,
        getForegroundProcess: async () => null
      })
      const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
      const prompt = 'line one\nline two\x1b[201~'

      const sendPromise = runtime.sendTerminalAgentPrompt(handle, prompt)
      await vi.runAllTimersAsync()
      const result = await sendPromise

      const pasted = [
        AGENT_PROMPT_BRACKETED_PASTE_START,
        'line one\nline two<ESC>[201~',
        AGENT_PROMPT_BRACKETED_PASTE_END
      ].join('')
      expect(result).toMatchObject({
        handle,
        accepted: true,
        bytesWritten: Buffer.byteLength(`${pasted}\r`, 'utf8')
      })
      expect(writes).toEqual([pasted, '\r'])
    } finally {
      vi.useRealTimers()
    }
  })

  it.each(['claude', 'codex'] as const)(
    'waits for %s composer output frames to settle before one submit',
    async (agent) => {
      vi.useFakeTimers()
      try {
        const writes: string[] = []
        let composerReady = false
        let prematureEnters = 0
        let submissions = 0
        const runtime = new OrcaRuntimeService(store)
        runtime.setPtyController({
          spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
          write: (_ptyId, data) => {
            writes.push(data)
            if (data.includes(AGENT_PROMPT_BRACKETED_PASTE_END)) {
              setTimeout(() => {
                runtime.onPtyData('pty-bg', 'partial redraw without cursor', Date.now())
              }, 650)
              setTimeout(() => {
                runtime.onPtyData('pty-bg', '\x1b[?2', Date.now())
              }, 750)
              setTimeout(() => {
                runtime.onPtyData('pty-bg', '5h intermediate frame', Date.now())
              }, 751)
              setTimeout(() => {
                runtime.onPtyData('pty-bg', 'continued composer render', Date.now())
              }, 900)
              setTimeout(() => {
                composerReady = true
                runtime.onPtyData('pty-bg', 'final composer frame', Date.now())
              }, 1_000)
            }
            if (data === '\r') {
              if (composerReady) {
                submissions += 1
              } else {
                prematureEnters += 1
              }
              acknowledgeAgentPromptSubmit(runtime, 'pty-bg', data)
            }
            return true
          },
          kill: () => true,
          getForegroundProcess: async () => null
        })
        const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
          launchAgent: agent
        })
        const assertAuthority = vi.fn()

        const sendPromise = runtime.sendTerminalAgentPrompt(handle, 'review this change', {
          beforeWrite: assertAuthority
        })
        await vi.advanceTimersByTimeAsync(500)

        expect(writes).not.toContain('\r')
        await vi.advanceTimersByTimeAsync(150)
        expect(writes).not.toContain('\r')
        await vi.advanceTimersByTimeAsync(101)
        expect(writes).not.toContain('\r')
        await vi.advanceTimersByTimeAsync(1_748)
        expect(writes).not.toContain('\r')
        await vi.advanceTimersByTimeAsync(1)
        await sendPromise
        expect(prematureEnters).toBe(0)
        expect(submissions).toBe(1)
        expect(writes.filter((data) => data === '\r')).toHaveLength(1)
        expect(assertAuthority).toHaveBeenCalledTimes(2)
      } finally {
        vi.useRealTimers()
      }
    }
  )

  it.each(
    (Object.keys(TUI_AGENT_CONFIG) as TuiAgent[]).filter(
      (agent) => agent !== 'claude' && agent !== 'codex'
    )
  )('holds Enter for the full open-loop submit delay for %s', async (agent) => {
    vi.useFakeTimers()
    try {
      const writes: string[] = []
      const runtime = new OrcaRuntimeService(store)
      runtime.setPtyController({
        spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
        write: (_ptyId, data) => {
          writes.push(data)
          acknowledgeAgentPromptSubmit(runtime, 'pty-bg', data)
          return true
        },
        kill: () => true,
        getForegroundProcess: async () => null
      })
      const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
        launchAgent: agent
      })

      const submitDelayMs = getAgentPromptSubmitDelayMs(
        process.platform,
        Buffer.byteLength(buildAgentPromptPasteBytes('review this change'), 'utf8')
      )
      const sendPromise = runtime.sendTerminalAgentPrompt(handle, 'review this change')
      await vi.advanceTimersByTimeAsync(submitDelayMs - 1)
      expect(writes).not.toContain('\r')

      await vi.advanceTimersByTimeAsync(1)
      await sendPromise
      expect(writes.filter((data) => data === '\r')).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('settles a foreground Codex prompt when launch metadata has not arrived', async () => {
    vi.useFakeTimers()
    try {
      const writes: string[] = []
      let composerReady = false
      const runtime = new OrcaRuntimeService(store)
      runtime.setPtyController({
        spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
        write: (_ptyId, data) => {
          writes.push(data)
          if (data.includes(AGENT_PROMPT_BRACKETED_PASTE_END)) {
            setTimeout(() => {
              composerReady = true
              runtime.onPtyData('pty-bg', '\x1b[?25hcomposer rendered', Date.now())
            }, 1_200)
          }
          acknowledgeAgentPromptSubmit(runtime, 'pty-bg', data)
          return true
        },
        kill: () => true,
        getForegroundProcess: async () => 'codex'
      })
      const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)

      await expect(runtime.isTerminalRunningSettledPromptAgent(handle)).resolves.toBe(true)
      const sendPromise = runtime.sendTerminalAgentPrompt(handle, 'review this change')
      await vi.advanceTimersByTimeAsync(1_199)
      expect(writes).not.toContain('\r')
      await vi.advanceTimersByTimeAsync(1_500)
      expect(writes).not.toContain('\r')
      await vi.advanceTimersByTimeAsync(1)
      await sendPromise

      expect(composerReady).toBe(true)
      expect(writes.filter((data) => data === '\r')).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('submits a silent Claude composer once after the bounded render fallback', async () => {
    vi.useFakeTimers()
    try {
      const writes: string[] = []
      const runtime = new OrcaRuntimeService(store)
      runtime.setPtyController({
        spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
        write: (_ptyId, data) => {
          writes.push(data)
          acknowledgeAgentPromptSubmit(runtime, 'pty-bg', data)
          return true
        },
        kill: () => true,
        getForegroundProcess: async () => null
      })
      const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
        launchAgent: 'claude'
      })

      const sendPromise = runtime.sendTerminalAgentPrompt(handle, 'review this change')
      await vi.advanceTimersByTimeAsync(renderGateCapMs('review this change') - 1)
      expect(writes).not.toContain('\r')

      await vi.advanceTimersByTimeAsync(1)
      await sendPromise
      expect(writes.filter((data) => data === '\r')).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('gives a late Codex render marker a fresh quiescence window', async () => {
    vi.useFakeTimers()
    try {
      const writes: string[] = []
      let composerReady = false
      const runtime = new OrcaRuntimeService(store)
      runtime.setPtyController({
        spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
        write: (_ptyId, data) => {
          writes.push(data)
          if (data.includes(AGENT_PROMPT_BRACKETED_PASTE_END)) {
            setTimeout(() => runtime.onPtyData('pty-bg', '\x1b[?25h', Date.now()), 7_900)
            setTimeout(() => {
              composerReady = true
              runtime.onPtyData('pty-bg', 'final slow composer frame', Date.now())
            }, 8_100)
          }
          acknowledgeAgentPromptSubmit(runtime, 'pty-bg', data)
          return true
        },
        kill: () => true,
        getForegroundProcess: async () => null
      })
      const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
        launchAgent: 'codex'
      })

      const sendPromise = runtime.sendTerminalAgentPrompt(handle, 'review this change')
      await vi.advanceTimersByTimeAsync(8_000)
      expect(writes).not.toContain('\r')
      await vi.advanceTimersByTimeAsync(1_599)
      expect(writes).not.toContain('\r')
      await vi.advanceTimersByTimeAsync(1)
      await sendPromise
      expect(composerReady).toBe(true)
      expect(writes.filter((data) => data === '\r')).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('bounds a Claude render that never settles to one fallback submit', async () => {
    vi.useFakeTimers()
    try {
      const writes: string[] = []
      const runtime = new OrcaRuntimeService(store)
      runtime.setPtyController({
        spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
        write: (_ptyId, data) => {
          writes.push(data)
          if (data.includes(AGENT_PROMPT_BRACKETED_PASTE_END)) {
            setTimeout(() => runtime.onPtyData('pty-bg', '\x1b[?25h', Date.now()), 100)
            for (const delay of [1_000, 2_000, 3_000, 4_000, 5_000, 6_000, 7_000]) {
              setTimeout(
                () => runtime.onPtyData('pty-bg', `render frame ${delay}`, Date.now()),
                delay
              )
            }
          }
          acknowledgeAgentPromptSubmit(runtime, 'pty-bg', data)
          return true
        },
        kill: () => true,
        getForegroundProcess: async () => null
      })
      const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
        launchAgent: 'claude'
      })

      const sendPromise = runtime.sendTerminalAgentPrompt(handle, 'review this change')
      // The marker at 100 ms re-arms the cap, but the ingest term is absolute: a prompt this
      // small is already ingested by then, so the fallback is one flat render timeout later.
      await vi.advanceTimersByTimeAsync(100 + 8_000 - 1)
      expect(writes).not.toContain('\r')

      await vi.advanceTimersByTimeAsync(1)
      await sendPromise
      expect(writes.filter((data) => data === '\r')).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('chunks large agent prompt paste frames before delayed submit', async () => {
    vi.useFakeTimers()
    try {
      const writes: string[] = []
      const runtime = new OrcaRuntimeService(store)
      runtime.setPtyController({
        spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
        write: (_ptyId, data) => {
          writes.push(data)
          acknowledgeAgentPromptSubmit(runtime, 'pty-bg', data)
          return true
        },
        kill: () => true,
        getForegroundProcess: async () => null
      })
      const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
        launchAgent: 'claude'
      })
      const prompt = `${'x'.repeat(TERMINAL_INPUT_CHUNK_MAX_BYTES)}\ntail`

      const sendPromise = runtime.sendTerminalAgentPrompt(handle, prompt)
      await vi.runAllTimersAsync()
      const result = await sendPromise

      const pasteWrites = writes.slice(0, -1)
      expect(result.bytesWritten).toBe(
        Buffer.byteLength(`${buildAgentPromptPasteBytes(prompt)}\r`, 'utf8')
      )
      expect(writes.at(-1)).toBe('\r')
      expect(pasteWrites.length).toBeGreaterThan(1)
      expect(pasteWrites.join('')).toBe(buildAgentPromptPasteBytes(prompt))
      expect(pasteWrites[0]).toContain(AGENT_PROMPT_BRACKETED_PASTE_START)
      expect(pasteWrites.at(-1)).toContain(AGENT_PROMPT_BRACKETED_PASTE_END)
    } finally {
      vi.useRealTimers()
    }
  })

  it('closes an incomplete agent prompt paste when a later chunk write fails', async () => {
    vi.useFakeTimers()
    try {
      const writes: string[] = []
      let writeCount = 0
      const runtime = new OrcaRuntimeService(store)
      runtime.setPtyController({
        spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
        write: (_ptyId, data) => {
          writeCount += 1
          writes.push(data)
          return writeCount !== 2
        },
        kill: () => true,
        getForegroundProcess: async () => null
      })
      const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
        launchAgent: 'claude'
      })
      const prompt = 'x'.repeat(TERMINAL_INPUT_CHUNK_MAX_BYTES + 1)

      const sendPromise = runtime.sendTerminalAgentPrompt(handle, prompt)
      const sendRejection = expect(sendPromise).rejects.toThrow('terminal_not_writable')
      await vi.runAllTimersAsync()

      await sendRejection
      expect(writes[0]).toContain(AGENT_PROMPT_BRACKETED_PASTE_START)
      expect(writes.at(-1)).toBe(AGENT_PROMPT_BRACKETED_PASTE_END)
      expect(writes).not.toContain('\r')
    } finally {
      vi.useRealTimers()
    }
  })

  it('chunks large terminal.send text before provider writes', async () => {
    const writes: string[] = []
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: (_ptyId, data) => {
        writes.push(data)
        return true
      },
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
    const text = ['x'.repeat(TERMINAL_INPUT_CHUNK_MAX_BYTES), 'tail'].join('')

    const result = await runtime.sendTerminal(handle, { text })

    expect(result).toMatchObject({
      handle,
      accepted: true,
      bytesWritten: Buffer.byteLength(text, 'utf8')
    })
    expect(writes).toEqual(['x'.repeat(TERMINAL_INPUT_CHUNK_MAX_BYTES), 'tail'])
  })

  it('yields while validating accepted large terminal.send text before provider writes', async () => {
    const writes: string[] = []
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: (_ptyId, data) => {
        writes.push(data)
        return true
      },
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
    const text = 'é'.repeat(CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS + 1)

    vi.useFakeTimers()
    try {
      const sendPromise = runtime.sendTerminal(handle, { text })

      expect(writes).toEqual([])

      await vi.runAllTimersAsync()
      const result = await sendPromise

      expect(result).toMatchObject({
        handle,
        accepted: true,
        bytesWritten: Buffer.byteLength(text, 'utf8')
      })
      expect(writes.length).toBeGreaterThan(1)
      expect(writes.join('')).toBe(text)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects oversized terminal.send text before provider writes', async () => {
    const writes: string[] = []
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: (_ptyId, data) => {
        writes.push(data)
        return true
      },
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)

    await expect(
      runtime.sendTerminal(handle, { text: 'x'.repeat(TERMINAL_INPUT_MAX_BYTES + 1) })
    ).rejects.toThrow(TERMINAL_INPUT_TOO_LARGE_ERROR)
    expect(writes).toEqual([])
  })
})

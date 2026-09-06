import type { RuntimeMobileSessionTabsResult } from '../../shared/runtime-types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID,
  resetRuntimeTestMocks,
  store,
  syncSinglePty,
  waitForMobileSessionTabsEvents
} from './orca-runtime-test-fixture'
import { OrcaRuntimeService } from './orca-runtime'
import { detectAgentStatusFromTitle } from '../../shared/agent-detection'

beforeEach(resetRuntimeTestMocks)
afterEach(resetRuntimeTestMocks)

describe('OrcaRuntimeService', () => {
  it('republishes mobile session tabs with hook payloads for title-less OSC 9999 transitions', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'hook-only-pty' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const events: RuntimeMobileSessionTabsResult[] = []
    const unsubscribe = runtime.onMobileSessionTabsChanged((snapshot) => events.push(snapshot))

    await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'hook-tab',
      leafId: HEADLESS_LEAF_ID
    })
    events.length = 0

    runtime.onPtyData(
      'hook-only-pty',
      '\x1b]9999;{"state":"working","prompt":"fix the tests","agentType":"opencode"}\x07',
      100
    )

    await waitForMobileSessionTabsEvents(events, 1)
    expect(events).toHaveLength(1)
    expect(events[0]?.tabs[0]).toEqual(
      expect.objectContaining({
        type: 'terminal',
        agentStatus: expect.objectContaining({
          state: 'working',
          prompt: 'fix the tests',
          agentType: 'opencode'
        })
      })
    )

    runtime.onPtyData(
      'hook-only-pty',
      '\x1b]9999;{"state":"waiting","prompt":"fix the tests","agentType":"opencode"}\x07',
      101
    )

    await waitForMobileSessionTabsEvents(events, 2)
    expect(events).toHaveLength(2)
    expect(events[1]?.tabs[0]?.type === 'terminal' && events[1].tabs[0].agentStatus).toEqual(
      expect.objectContaining({ state: 'waiting' })
    )

    unsubscribe()
  })

  it('keeps an OMP hook labeled OMP when the wrapped pi child owns the foreground', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'omp-flicker-pty' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      // Why: the remote relay reads the deeper `pi` child of the omp process tree.
      getForegroundProcess: async () => 'pi'
    })
    const events: RuntimeMobileSessionTabsResult[] = []
    const unsubscribe = runtime.onMobileSessionTabsChanged((snapshot) => events.push(snapshot))

    await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'omp-tab',
      leafId: HEADLESS_LEAF_ID
    })
    // Restored/mirrored pane: no launchAgent, only the pi foreground read remains.
    const pty = (
      runtime as unknown as {
        ptysById: Map<string, { launchAgent: string | null; foregroundAgent: string | null }>
      }
    ).ptysById.get('omp-flicker-pty')!
    pty.launchAgent = null
    pty.foregroundAgent = 'pi'
    events.length = 0

    runtime.onPtyData(
      'omp-flicker-pty',
      '\x1b]0;⠋ Pi\x07' +
        '\x1b]9999;{"state":"working","prompt":"fix the bug","agentType":"omp"}\x07',
      100
    )

    await waitForMobileSessionTabsEvents(events, 1)
    expect(events[0]?.tabs[0]).toEqual(
      expect.objectContaining({
        type: 'terminal',
        title: '⠋ OMP',
        agentStatus: expect.objectContaining({
          state: 'working',
          agentType: 'omp',
          terminalTitle: '⠋ OMP'
        })
      })
    )

    unsubscribe()
  })

  it('does not republish mobile session tabs for repeated identical OSC 9999 payloads', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'hook-ping-pty' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const events: RuntimeMobileSessionTabsResult[] = []
    const unsubscribe = runtime.onMobileSessionTabsChanged((snapshot) => events.push(snapshot))

    await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'hook-ping-tab',
      leafId: HEADLESS_LEAF_ID
    })
    events.length = 0

    const payload = '\x1b]9999;{"state":"working","prompt":"same","agentType":"codex"}\x07'
    runtime.onPtyData('hook-ping-pty', payload, 100)
    runtime.onPtyData('hook-ping-pty', payload, 101)
    runtime.onPtyData('hook-ping-pty', payload, 102)

    await waitForMobileSessionTabsEvents(events, 1)
    expect(events).toHaveLength(1)

    unsubscribe()
  })

  it('suppresses a retained hook working status once the shell owns the pane title again', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'hook-exit-pty' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const events: RuntimeMobileSessionTabsResult[] = []
    const unsubscribe = runtime.onMobileSessionTabsChanged((snapshot) => events.push(snapshot))

    await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'hook-exit-tab',
      leafId: HEADLESS_LEAF_ID
    })
    events.length = 0

    runtime.onPtyData(
      'hook-exit-pty',
      '\x1b]9999;{"state":"working","prompt":"long task","agentType":"codex"}\x07',
      100
    )
    // Agent exits without a hook done event and the shell takes the title back; the stuck-spinner guard (#1437) must win over the retained hook row.
    runtime.onPtyData('hook-exit-pty', '\x1b]0;zsh\x07', 101)

    await waitForMobileSessionTabsEvents(events, 1)
    const last = events.at(-1)?.tabs[0]
    expect(last?.type).toBe('terminal')
    expect(last?.type === 'terminal' ? last.agentStatus : null).toBeFalsy()

    unsubscribe()
  })

  it('stores normalized Pi idle OSC titles that still classify as idle', async () => {
    const runtime = new OrcaRuntimeService(store)
    syncSinglePty(runtime)

    runtime.onPtyData('pty-1', '\x1b]0;π - my-project\x07', 100)
    const pty = (
      runtime as unknown as {
        ptysById: Map<string, { lastOscTitle: string | null; lastAgentStatus: string | null }>
      }
    ).ptysById.get('pty-1')
    expect(pty?.lastOscTitle).toBe('π - my-project')
    expect(pty?.lastAgentStatus).toBe('idle')
    // Why: worktree.ps / mobile re-detect from stored lastOscTitle, not the raw OSC frame; the preserved π title must still classify as idle after normalize.
    expect(detectAgentStatusFromTitle(pty?.lastOscTitle ?? '')).toBe('idle')
  })

  it('normalizes hydration-seeded Grok and Pi titles the same as live OSC frames', async () => {
    const runtime = new OrcaRuntimeService(store)
    syncSinglePty(runtime)

    ;(
      runtime as unknown as {
        applySeededAgentStatus: (ptyId: string, title: string) => void
      }
    ).applySeededAgentStatus('pty-1', '⠴ - Thinking - grok')
    const pty = (
      runtime as unknown as {
        ptysById: Map<string, { lastOscTitle: string | null; lastAgentStatus: string | null }>
      }
    ).ptysById.get('pty-1')
    expect(pty?.lastOscTitle).toBe('⠋ Grok')
    // Seed writes leaf status only; re-detect from the stored title must still report working so later live frames compare equal and don't thrash.
    expect(detectAgentStatusFromTitle(pty?.lastOscTitle ?? '')).toBe('working')

    ;(
      runtime as unknown as {
        applySeededAgentStatus: (ptyId: string, title: string) => void
      }
    ).applySeededAgentStatus('pty-1', 'π - my-project')
    expect(pty?.lastOscTitle).toBe('π - my-project')
    expect(detectAgentStatusFromTitle(pty?.lastOscTitle ?? '')).toBe('idle')
  })

  it('stores other-agent OSC titles that merely end in grok unchanged', async () => {
    const runtime = new OrcaRuntimeService(store)
    syncSinglePty(runtime)

    runtime.onPtyData('pty-1', '\x1b]0;⠋ wire up grok\x07', 100)
    const pty = (
      runtime as unknown as {
        ptysById: Map<string, { lastOscTitle: string | null }>
      }
    ).ptysById.get('pty-1')
    expect(pty?.lastOscTitle).toBe('⠋ wire up grok')

    // Claude/Codex braille + task ending " - grok" is not a Grok frame shape.
    runtime.onPtyData('pty-1', '\x1b]0;⠋ fix the flaky suite - grok\x07', 101)
    expect(pty?.lastOscTitle).toBe('⠋ fix the flaky suite - grok')
  })

  it('seeds newly synced leaves from PTY pending ANSI state', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.registerPty('pty-1', TEST_WORKTREE_ID)
    runtime.onPtyData('pty-1', 'Working\r\x1b[', 100)

    syncSinglePty(runtime)
    const [terminal] = (await runtime.listTerminals()).terminals
    runtime.onPtyData('pty-1', '38;2;190;210;223;49mDone\n', 101)

    const read = await runtime.readTerminal(terminal.handle)
    const retained = read.tail.join('\n')
    expect(retained).toContain('Done')
    expect(retained).not.toContain('38;2')
    expect(retained).not.toContain('49m')
  })

  it('normalizes large CRLF-heavy terminal chunks without regex replacement or line splits', async () => {
    const replaceSpy = vi.spyOn(String.prototype, 'replace')
    const splitSpy = vi.spyOn(String.prototype, 'split')
    const runtime = new OrcaRuntimeService(store)

    syncSinglePty(runtime)
    const [terminal] = (await runtime.listTerminals()).terminals
    runtime.onPtyData('pty-1', `${'line\r\n'.repeat(10_000)}tail`, 100)
    const read = await runtime.readTerminal(terminal.handle, { limit: 5 })
    const usedCrlfReplace = replaceSpy.mock.calls.some(
      ([pattern], index) =>
        pattern instanceof RegExp &&
        pattern.source === '\\r\\n' &&
        typeof replaceSpy.mock.contexts[index] === 'string' &&
        replaceSpy.mock.contexts[index].length > 10_000
    )
    const usedLineSplit = splitSpy.mock.calls.some(([separator], index) => {
      const splitSeparator = separator as unknown
      return (
        (splitSeparator === '\n' ||
          (splitSeparator instanceof RegExp && splitSeparator.source === '\\r?\\n')) &&
        typeof splitSpy.mock.contexts[index] === 'string' &&
        splitSpy.mock.contexts[index].length > 10_000
      )
    })

    expect(read.tail.at(-1)).toBe('tail')
    expect(usedCrlfReplace).toBe(false)
    expect(usedLineSplit).toBe(false)
  })

  it('bounds retained partial terminal output before preview reads', async () => {
    const runtime = new OrcaRuntimeService(store)

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

    const [terminal] = (await runtime.listTerminals()).terminals
    runtime.onPtyData(
      'pty-1',
      `${Array.from({ length: 2000 }, (_, index) => `line-${index}`).join('\n')}\n`,
      99
    )
    runtime.onPtyData('pty-1', `${'x'.repeat(40_000)}tail-marker-0`, 100)
    type RetainedTailState = {
      tailBuffer: string[]
      tailPartialLine: string
      tailTruncated: boolean
    }
    const cappedPartialState = (
      runtime as unknown as {
        ptysById: Map<string, RetainedTailState>
      }
    ).ptysById.get('pty-1')
    const retainedLineBuffer = cappedPartialState?.tailBuffer
    for (let index = 1; index < 5; index += 1) {
      runtime.onPtyData('pty-1', `${'x'.repeat(40_000)}tail-marker-${index}`, 100 + index)
    }

    const retained = (
      runtime as unknown as {
        ptysById: Map<string, RetainedTailState>
      }
    ).ptysById.get('pty-1')
    expect(retained?.tailBuffer).toBe(retainedLineBuffer)
    expect(retained?.tailPartialLine).toHaveLength(4000)
    expect(retained?.tailPartialLine.endsWith('tail-marker-4')).toBe(true)
    expect(retained?.tailTruncated).toBe(true)

    const preview = await runtime.readTerminal(terminal.handle)
    expect(preview.tail).toHaveLength(120)
    expect(preview.tail.at(-1)).toHaveLength(4000)
    expect(preview.tail.at(-1)?.endsWith('tail-marker-4')).toBe(true)
    expect(preview.truncated).toBe(true)
    expect(preview.nextCursor).toBe('2000')
  })
})

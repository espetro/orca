import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from './rpc/dispatcher'
import {
  makeRpcRequest,
  resetRuntimeTestMocks,
  store,
  syncSinglePty
} from './orca-runtime-test-fixture'
import { OrcaRuntimeService } from './orca-runtime'
import { TERMINAL_METHODS } from './rpc/methods/terminal'

beforeEach(resetRuntimeTestMocks)
afterEach(resetRuntimeTestMocks)

describe('OrcaRuntimeService', () => {
  it('keeps partial-line output readable across cursor-based pagination', async () => {
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
    runtime.onPtyData('pty-1', 'hel', 100)

    // Non-cursor reads include the partial line for UI display
    const firstRead = await runtime.readTerminal(terminal.handle)
    expect(firstRead.tail).toEqual(['hel'])
    expect(firstRead.nextCursor).toBe('0')

    runtime.onPtyData('pty-1', 'lo', 101)

    // Cursor reads exclude partial lines to prevent duplication (partial now, then completed line next read).
    const secondRead = await runtime.readTerminal(terminal.handle, {
      cursor: Number(firstRead.nextCursor)
    })
    expect(secondRead.tail).toEqual([])
    expect(secondRead.nextCursor).toBe('0')

    runtime.onPtyData('pty-1', '\nworld\n', 102)

    const thirdRead = await runtime.readTerminal(terminal.handle, {
      cursor: Number(secondRead.nextCursor)
    })
    expect(thirdRead.tail).toEqual(['hello', 'world'])
    expect(thirdRead.nextCursor).toBe('2')
  })

  it('paginates retained terminal output with explicit limits and truncation metadata', async () => {
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
      `${Array.from({ length: 150 }, (_, index) => `line-${index}`).join('\n')}\n`,
      100
    )

    const preview = await runtime.readTerminal(terminal.handle)
    expect(preview.tail).toHaveLength(120)
    expect(preview.tail[0]).toBe('line-30')
    expect(preview.limited).toBe(true)
    expect(preview.oldestCursor).toBe('0')
    expect(preview.latestCursor).toBe('150')

    const defaultCursorRead = await runtime.readTerminal(terminal.handle, { cursor: 0 })
    expect(defaultCursorRead.tail).toHaveLength(150)
    expect(defaultCursorRead.nextCursor).toBe('150')
    expect(defaultCursorRead.limited).toBe(false)

    const firstPage = await runtime.readTerminal(terminal.handle, { cursor: 0, limit: 50 })
    expect(firstPage.tail).toHaveLength(50)
    expect(firstPage.tail[0]).toBe('line-0')
    expect(firstPage.nextCursor).toBe('50')
    expect(firstPage.limited).toBe(true)
    expect(firstPage.truncated).toBe(false)

    const fractionalPage = await runtime.readTerminal(terminal.handle, { cursor: 0, limit: 0.5 })
    expect(fractionalPage.tail).toEqual(['line-0'])
    expect(fractionalPage.nextCursor).toBe('1')
    expect(fractionalPage.limited).toBe(true)

    const secondPage = await runtime.readTerminal(terminal.handle, {
      cursor: Number(firstPage.nextCursor),
      limit: 200
    })
    expect(secondPage.tail).toHaveLength(100)
    expect(secondPage.tail[0]).toBe('line-50')
    expect(secondPage.nextCursor).toBe('150')
    expect(secondPage.limited).toBe(false)

    runtime.onPtyData(
      'pty-1',
      `${Array.from({ length: 2100 }, (_, index) => `later-${index}`).join('\n')}\n`,
      101
    )

    const staleCursorRead = await runtime.readTerminal(terminal.handle, { cursor: 0, limit: 5 })
    expect(staleCursorRead.truncated).toBe(true)
    expect(staleCursorRead.oldestCursor).toBe('250')
    expect(staleCursorRead.tail).toEqual([
      'later-100',
      'later-101',
      'later-102',
      'later-103',
      'later-104'
    ])
    expect(staleCursorRead.nextCursor).toBe('255')

    const futureCursorRead = await runtime.readTerminal(terminal.handle, { cursor: 9999 })
    expect(futureCursorRead.tail).toEqual([])
    expect(futureCursorRead.nextCursor).toBe('2250')
    expect(futureCursorRead.limited).toBe(false)
  })

  it('keeps terminal read payloads bounded while retained output remains pageable', async () => {
    const runtime = new OrcaRuntimeService(store)
    syncSinglePty(runtime)

    const [terminal] = (await runtime.listTerminals()).terminals
    const linePayload = 'x'.repeat(24)
    const lines = Array.from(
      { length: 2000 },
      (_, index) => `line-${index.toString().padStart(4, '0')}-${linePayload}`
    )
    runtime.onPtyData('pty-1', `${lines.join('\n')}\n`, 100)

    const preview = await runtime.readTerminal(terminal.handle)
    expect(Buffer.byteLength(JSON.stringify(preview), 'utf8')).toBeLessThan(10_000)
    expect(preview.tail).toHaveLength(120)
    expect(preview.tail[0]).toBe(lines.at(-120))
    expect(preview.limited).toBe(true)
    expect(preview.oldestCursor).toBe('0')
    expect(preview.nextCursor).toBe('2000')
    expect(preview.latestCursor).toBe('2000')

    const collected: string[] = []
    let cursor = Number(preview.oldestCursor)
    const latestCursor = Number(preview.latestCursor)
    for (let pageIndex = 0; cursor < latestCursor; pageIndex += 1) {
      expect(pageIndex).toBeLessThan(10)
      const page = await runtime.readTerminal(terminal.handle, { cursor, limit: 333 })
      expect(Buffer.byteLength(JSON.stringify(page), 'utf8')).toBeLessThan(16_000)
      expect(page.tail.length).toBeGreaterThan(0)
      expect(page.tail.length).toBeLessThanOrEqual(333)
      expect(page.returnedLineCount).toBe(page.tail.length)

      collected.push(...page.tail)
      const nextCursor = Number(page.nextCursor)
      expect(nextCursor).toBeGreaterThan(cursor)
      cursor = nextCursor
    }

    expect(collected).toHaveLength(lines.length)
    expect(collected.findIndex((line, index) => line !== lines[index])).toBe(-1)
  })

  it('trims terminal read preview character budget without per-line array shifts', async () => {
    const runtime = new OrcaRuntimeService(store)
    syncSinglePty(runtime)

    const [terminal] = (await runtime.listTerminals()).terminals
    const lines = Array.from({ length: 120 }, (_, index) => `line-${index}-${'x'.repeat(400)}`)
    runtime.onPtyData('pty-1', `${lines.join('\n')}\n`, 100)
    // Why: xterm-headless uses Array.shift while draining writes; this test guards read-preview trimming, not emulator parsing.
    await runtime.serializeMainTerminalBuffer('pty-1')

    const originalShift = Array.prototype.shift
    let shiftCallCount = 0
    Array.prototype.shift = function (...args) {
      shiftCallCount += 1
      return originalShift.apply(this, args)
    }
    let preview: Awaited<ReturnType<typeof runtime.readTerminal>>
    try {
      preview = await runtime.readTerminal(terminal.handle)
    } finally {
      Array.prototype.shift = originalShift
    }

    expect(preview.limited).toBe(true)
    expect(preview.tail.at(-1)).toBe(lines.at(-1))
    expect(preview.tail.reduce((sum, line) => sum + line.length, 0)).toBeLessThanOrEqual(32 * 1024)
    expect(shiftCallCount).toBe(0)
  })

  it('falls back to renderer visible screen when uncursored TUI tail is blank', async () => {
    const serializeBuffer = vi.fn().mockResolvedValue({
      data: '\x1b[?1049hClaude Code\r\nWorking on fix\r\nTool: Read\r\n',
      cols: 80,
      rows: 24
    })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      hasRendererSerializer: () => true,
      serializeBuffer
    })
    syncSinglePty(runtime)

    const [terminal] = (await runtime.listTerminals()).terminals
    runtime.onPtyData('pty-1', `${Array.from({ length: 3000 }, () => '   ').join('\n')}\n`, 100)

    const read = await runtime.readTerminal(terminal.handle)

    expect(read.tail).toEqual(['Claude Code', 'Working on fix', 'Tool: Read'])
    expect(serializeBuffer).toHaveBeenCalledWith('pty-1', {
      scrollbackRows: 0,
      altScreenForcesZeroRows: false
    })
  })

  it('reads and shows the runtime-owned alternate-screen grid without serialization', async () => {
    const serializeBuffer = vi.fn()
    const serializeProviderBuffer = vi.fn()
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      serializeBuffer,
      serializeProviderBuffer
    })
    syncSinglePty(runtime)

    const [terminal] = (await runtime.listTerminals()).terminals
    runtime.onPtyData(
      'pty-1',
      'shell history\r\n\x1b[?1049h\x1b[2J\x1b[HClaude Code\r\nWorking on fix\r\nTool: Read\r\n',
      100
    )

    const read = await runtime.readTerminal(terminal.handle)
    const shown = await runtime.showTerminal(terminal.handle)

    expect(read.tail).toEqual(['Claude Code', 'Working on fix', 'Tool: Read'])
    expect(shown.preview).toBe('Claude Code\nWorking on fix\nTool: Read')
    expect(serializeBuffer).not.toHaveBeenCalled()
    expect(serializeProviderBuffer).not.toHaveBeenCalled()
  })

  it('separates composer draft text from rendered terminal output', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      hasRendererSerializer: () => false
    })
    syncSinglePty(runtime)
    runtime.onPtyData(
      'pty-1',
      '\x1b[?1049hBuild passed\r\n────────\r\n❯ \x1b[2mproceed with the release\r\n  and close the pull request\x1b[22m\x1b[1A\x1b[3G',
      100
    )
    const [terminal] = (await runtime.listTerminals()).terminals

    const read = await runtime.readTerminal(terminal.handle)

    expect(read).toMatchObject({
      source: 'screen',
      tail: ['Build passed', '────────', '❯'],
      draft: 'proceed with the release\nand close the pull request'
    })
  })

  it('keeps renderer-fallback composer drafts separate from terminal output', async () => {
    const serializeBuffer = vi.fn().mockResolvedValue({
      data: '\x1b[?1049hBuild passed\r\n────────\r\n❯ \x1b[2mproceed with the release\x1b[22m\x1b[3G',
      cols: 80,
      rows: 24
    })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      hasRendererSerializer: () => true,
      serializeBuffer
    })
    syncSinglePty(runtime)
    runtime.onPtyData('pty-1', `${Array.from({ length: 3000 }, () => '').join('\n')}\n`, 100)
    const [terminal] = (await runtime.listTerminals()).terminals

    const read = await runtime.readTerminal(terminal.handle)

    expect(read).toMatchObject({
      source: 'screen',
      tail: ['Build passed', '────────', '❯'],
      draft: 'proceed with the release'
    })
    expect(serializeBuffer).toHaveBeenCalledWith('pty-1', {
      scrollbackRows: 0,
      altScreenForcesZeroRows: false
    })
  })

  it('separates composer drafts from provider-owned terminal screens', async () => {
    const serializeProviderBuffer = vi.fn().mockResolvedValue({
      data: '\x1b[?1049hBuild passed\r\n────────\r\n❯ \x1b[2mproceed with the release\x1b[22m\x1b[3G',
      cols: 80,
      rows: 24,
      seq: 900,
      source: 'headless',
      alternateScreen: true
    })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      serializeProviderBuffer,
      hasRendererSerializer: () => false
    })
    syncSinglePty(runtime)
    runtime.synchronizePtyOutputSequenceFromProvider(
      'pty-1',
      { value: 900, generation: 'continued' },
      0
    )
    const [terminal] = (await runtime.listTerminals()).terminals

    const read = await runtime.readTerminal(terminal.handle)

    expect(read).toMatchObject({
      source: 'screen',
      tail: ['Build passed', '────────', '❯'],
      draft: 'proceed with the release'
    })
    expect(serializeProviderBuffer).toHaveBeenCalledOnce()
  })

  it('does not use renderer visible-screen fallback for cursor transcript reads', async () => {
    const serializeBuffer = vi.fn().mockResolvedValue({
      data: 'Visible TUI\n',
      cols: 80,
      rows: 24
    })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      hasRendererSerializer: () => true,
      serializeBuffer
    })
    syncSinglePty(runtime)

    const [terminal] = (await runtime.listTerminals()).terminals
    runtime.onPtyData('pty-1', '   \n', 100)

    const read = await runtime.readTerminal(terminal.handle, { cursor: 0 })

    expect(read.tail).toEqual([''])
    expect(serializeBuffer).not.toHaveBeenCalledWith('pty-1', {
      scrollbackRows: 0,
      altScreenForcesZeroRows: false
    })
  })

  it('does not use renderer visible-screen fallback for a short blank shell tail', async () => {
    const serializeBuffer = vi.fn().mockResolvedValue({
      data: 'shell prompt\n',
      cols: 80,
      rows: 24
    })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      hasRendererSerializer: () => true,
      serializeBuffer
    })
    syncSinglePty(runtime)

    const [terminal] = (await runtime.listTerminals()).terminals
    runtime.onPtyData('pty-1', '\n\n', 100)

    const read = await runtime.readTerminal(terminal.handle)

    expect(read.tail).toEqual(['', ''])
    expect(serializeBuffer).not.toHaveBeenCalledWith('pty-1', {
      scrollbackRows: 0,
      altScreenForcesZeroRows: false
    })
  })

  it('returns renderer visible screen lines through terminal.read RPC JSON result', async () => {
    const serializeBuffer = vi.fn().mockResolvedValue({
      data: '\x1b[?1049hClaude Code\r\nChecking files\r\nWaiting for input\r\n',
      cols: 80,
      rows: 24
    })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      hasRendererSerializer: () => true,
      serializeBuffer
    })
    syncSinglePty(runtime)

    const [terminal] = (await runtime.listTerminals()).terminals
    runtime.onPtyData('pty-1', `${Array.from({ length: 3000 }, () => '').join('\n')}\n`, 100)
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const response = await dispatcher.dispatch(
      makeRpcRequest('terminal.read', { terminal: terminal.handle })
    )

    expect(response.ok).toBe(true)
    if (!response.ok) {
      throw new Error(response.error.message)
    }
    expect(response.result).toMatchObject({
      terminal: {
        handle: terminal.handle,
        status: 'running',
        tail: ['Claude Code', 'Checking files', 'Waiting for input']
      }
    })
  })
})

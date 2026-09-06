import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createRuntime,
  makeDeferred,
  makeStatusFrame,
  parseHeadlessSnapshotLines,
  referenceStatusFrameLines,
  resetRuntimeTestMocks,
  syncSinglePty
} from './orca-runtime-test-fixture'
import type { HeadlessEmulator } from '../daemon/headless-emulator'

beforeEach(resetRuntimeTestMocks)
afterEach(resetRuntimeTestMocks)

describe('OrcaRuntimeService', () => {
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
})

/* eslint-disable max-lines -- Why: split slice of the runtime behavior suite; mocks are duplicated per file because vi.mock is file-scoped */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  InMemoryOrchestrationMessages,
  TEST_WORKTREE_ID,
  bindSinglePtyRun,
  pendingMailPointerRepoints,
  resetRuntimeTestMocks,
  setInMemoryOrchestrationMessages,
  store,
  syncSinglePty
} from './orca-runtime-test-fixture'
import { OrcaRuntimeService } from './orca-runtime'
import { OrchestrationDb } from './orchestration/db'
beforeEach(resetRuntimeTestMocks)
afterEach(resetRuntimeTestMocks)
describe('OrcaRuntimeService', () => {
  it('delivers pending mail via notifyMessageArrived when the recipient is already idle', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      const db = new InMemoryOrchestrationMessages()
      const write = vi.fn().mockReturnValue(true)
      setInMemoryOrchestrationMessages(runtime, db)
      runtime.setPtyController({
        write,
        kill: vi.fn(),
        getForegroundProcess: async () => null
      })
      syncSinglePty(runtime)

      const [terminal] = (await runtime.listTerminals()).terminals
      bindSinglePtyRun(db, terminal.handle)
      runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07', 100)
      runtime.onPtyData('pty-1', '\x1b]0;Codex done\x07', 101)
      await runtime.waitForTerminal(terminal.handle, { condition: 'tui-idle' })
      const message = db.insertMessage({
        from: 'sender',
        to: terminal.handle,
        subject: 'after wait'
      })

      // Why: notifyMessageArrived is the send-path hook; it must push-on-idle
      // without requiring another agent-status transition (#12536).
      runtime.notifyMessageArrived(terminal.handle, 'status')

      // The push is deferred one microtask so it lands behind any resolved check.
      await Promise.resolve()
      expect(write).toHaveBeenCalledWith(
        'pty-1',
        expect.stringContaining('You have 1 orchestration message')
      )
      expect(write).not.toHaveBeenCalledWith('pty-1', expect.stringContaining('after wait'))
      await vi.advanceTimersByTimeAsync(500)
      expect(write).toHaveBeenCalledWith('pty-1', '\r')
      expect(message.delivered_at).toEqual(expect.any(String))
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('points a Run mailbox at its live-idle coordinator without replaying pending rows', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      const db = new InMemoryOrchestrationMessages()
      const write = vi.fn().mockReturnValue(true)
      setInMemoryOrchestrationMessages(runtime, db)
      runtime.setPtyController({
        write,
        kill: vi.fn(),
        getForegroundProcess: async () => null
      })
      syncSinglePty(runtime)

      const [terminal] = (await runtime.listTerminals()).terminals
      db.setRun({
        id: 'run_mailbox',
        coordinator_handle: terminal.handle,
        coordinator_pane_key: `${terminal.tabId}:${terminal.leafId}`
      })
      runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07', 100)
      const message = db.insertMessage({
        from: 'term_worker',
        to: 'run:run_mailbox',
        subject: 'one P3 finding',
        body: 'private worker report',
        type: 'worker_done'
      })

      runtime.notifyMessageArrived('run:run_mailbox', 'worker_done')
      await Promise.resolve()
      expect(write).not.toHaveBeenCalled()

      runtime.onPtyData('pty-1', '\x1b]0;Codex done\x07', 101)
      expect(write).toHaveBeenCalledWith(
        'pty-1',
        '\nYou have 1 orchestration message. Run `orca orchestration check --run run_mailbox`.\n'
      )
      expect(write).not.toHaveBeenCalledWith(
        'pty-1',
        expect.stringContaining('private worker report')
      )
      await vi.advanceTimersByTimeAsync(500)
      expect(write).toHaveBeenCalledWith('pty-1', '\r')
      expect(message.delivered_at).toEqual(expect.any(String))

      runtime.notifyMessageArrived('run:run_mailbox', 'worker_done')
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(500)
      expect(
        write.mock.calls.filter(
          ([, payload]) =>
            typeof payload === 'string' && payload.includes('orca orchestration check')
        )
      ).toHaveLength(1)
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('repoints worker_done when a stale waiter wakes without consuming it', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      const db = new InMemoryOrchestrationMessages()
      const write = vi.fn().mockReturnValue(true)
      setInMemoryOrchestrationMessages(runtime, db)
      runtime.setPtyController({
        write,
        kill: vi.fn(),
        getForegroundProcess: async () => null
      })
      syncSinglePty(runtime)

      const [terminal] = (await runtime.listTerminals()).terminals
      db.setRun({
        id: 'run_stale_waiter',
        coordinator_handle: terminal.handle,
        coordinator_pane_key: `${terminal.tabId}:${terminal.leafId}`
      })
      runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07', 100)
      runtime.onPtyData('pty-1', '\x1b]0;Codex done\x07', 101)
      write.mockClear()

      const staleWait = runtime.waitForMessage('run:run_stale_waiter', {
        typeFilter: ['worker_done'],
        timeoutMs: 60_000
      })
      db.insertMessage({
        from: 'term_final_worker',
        to: 'run:run_stale_waiter',
        subject: 'final worker settled',
        type: 'worker_done'
      })
      runtime.notifyMessageArrived('run:run_stale_waiter', 'worker_done')

      await expect(staleWait).resolves.toBe('notified')
      expect(write).not.toHaveBeenCalled()

      db.insertMessage({
        from: 'term_other_worker',
        to: 'run:run_stale_waiter',
        subject: 'newer status',
        type: 'status'
      })
      runtime.deliverPendingMessagesForHandle('run:run_stale_waiter', new Set(['worker_done']))
      await vi.advanceTimersByTimeAsync(500)

      const pointers = () =>
        write.mock.calls.filter(
          ([, payload]) =>
            typeof payload === 'string' && payload.includes('orca orchestration check')
        )
      expect(pointers()).toHaveLength(1)
      expect(pointers()[0]?.[1]).toContain('You have 1 orchestration message')

      await vi.advanceTimersByTimeAsync(1_500)
      expect(pointers()).toHaveLength(2)
      expect(pointers()[1]?.[1]).toContain('You have 1 orchestration message')
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('repoints on the retry edge when live idle won the send race', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      const db = new InMemoryOrchestrationMessages()
      const write = vi.fn().mockReturnValue(true)
      setInMemoryOrchestrationMessages(runtime, db)
      runtime.setPtyController({
        write,
        kill: vi.fn(),
        getForegroundProcess: async () => null
      })
      syncSinglePty(runtime)

      const [terminal] = (await runtime.listTerminals()).terminals
      bindSinglePtyRun(db, terminal.handle)
      runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07', 100)
      db.insertMessage({
        from: 'term_worker',
        to: terminal.handle,
        subject: 'settled at idle edge',
        type: 'worker_done'
      })
      runtime.notifyMessageArrived(terminal.handle, 'worker_done')
      await Promise.resolve()
      expect(write).not.toHaveBeenCalled()

      const leaf = [
        ...(
          runtime as unknown as {
            leaves: Map<
              string,
              { lastAgentStatus: string | null; lastAgentStatusObservedLive: boolean }
            >
          }
        ).leaves.values()
      ][0]
      leaf.lastAgentStatus = 'idle'
      leaf.lastAgentStatusObservedLive = true

      await vi.advanceTimersByTimeAsync(2_000)
      expect(write).toHaveBeenCalledWith(
        'pty-1',
        expect.stringContaining('You have 1 orchestration message')
      )
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves later delivery to the idle edge instead of polling a working mailbox', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      const db = new InMemoryOrchestrationMessages()
      const pendingReads = vi.spyOn(db, 'getUndeliveredUnreadMessages')
      const write = vi.fn().mockReturnValue(true)
      setInMemoryOrchestrationMessages(runtime, db)
      runtime.setPtyController({
        write,
        kill: vi.fn(),
        getForegroundProcess: async () => null
      })
      syncSinglePty(runtime)

      const [terminal] = (await runtime.listTerminals()).terminals
      bindSinglePtyRun(db, terminal.handle)
      runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07', 100)
      db.insertMessage({
        from: 'term_worker',
        to: terminal.handle,
        subject: 'wait for idle'
      })
      runtime.notifyMessageArrived(terminal.handle, 'status')
      await Promise.resolve()

      await vi.advanceTimersByTimeAsync(20_000)
      expect(pendingReads).not.toHaveBeenCalled()
      expect(pendingMailPointerRepoints(runtime)).toBe(0)

      runtime.onPtyData('pty-1', '\x1b]0;Codex done\x07', 101)
      expect(pendingReads).toHaveBeenCalledTimes(1)
      expect(write).toHaveBeenCalledWith(
        'pty-1',
        expect.stringContaining('You have 1 orchestration message')
      )
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('points restored mail when a live-idle PTY remounts after the repair edge', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      const db = new InMemoryOrchestrationMessages()
      const write = vi.fn().mockReturnValue(true)
      runtime.setPtyController({
        write,
        kill: vi.fn(),
        getForegroundProcess: async () => null
      })
      syncSinglePty(runtime)

      const [terminal] = (await runtime.listTerminals()).terminals
      bindSinglePtyRun(db, terminal.handle)
      runtime.registerPreAllocatedHandleForPty('pty-1', terminal.handle)
      runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07', 100)
      runtime.onPtyData('pty-1', '\x1b]0;Codex done\x07', 101)
      runtime.markRendererReloading(1)
      db.insertMessage({
        from: 'term_worker',
        to: terminal.handle,
        subject: 'restored'
      })
      setInMemoryOrchestrationMessages(runtime, db)

      await vi.advanceTimersByTimeAsync(2_000)
      expect(write).not.toHaveBeenCalled()

      syncSinglePty(runtime)
      expect(write).toHaveBeenCalledWith(
        'pty-1',
        expect.stringContaining('You have 1 orchestration message')
      )
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not keep retrying when every pending row was already pointed', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      const db = new InMemoryOrchestrationMessages()
      const write = vi.fn().mockReturnValue(true)
      setInMemoryOrchestrationMessages(runtime, db)
      runtime.setPtyController({
        write,
        kill: vi.fn(),
        getForegroundProcess: async () => null
      })
      syncSinglePty(runtime)

      const [terminal] = (await runtime.listTerminals()).terminals
      bindSinglePtyRun(db, terminal.handle)
      runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07', 100)
      runtime.onPtyData('pty-1', '\x1b]0;Codex done\x07', 101)
      db.insertMessage({
        from: 'term_worker',
        to: terminal.handle,
        subject: 'once'
      })
      runtime.notifyMessageArrived(terminal.handle, 'status')
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(2_500)

      expect(
        write.mock.calls.filter(
          ([, payload]) =>
            typeof payload === 'string' && payload.includes('orca orchestration check')
        )
      ).toHaveLength(1)
      expect(pendingMailPointerRepoints(runtime)).toBe(0)
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('repoints pending rows restored with a live-idle coordinator', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      const db = new InMemoryOrchestrationMessages()
      const write = vi.fn().mockReturnValue(true)
      runtime.setPtyController({
        write,
        kill: vi.fn(),
        getForegroundProcess: async () => null
      })
      syncSinglePty(runtime)

      const [terminal] = (await runtime.listTerminals()).terminals
      bindSinglePtyRun(db, terminal.handle)
      runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07', 100)
      runtime.onPtyData('pty-1', '\x1b]0;Codex done\x07', 101)
      db.insertMessage({
        from: 'term_worker',
        to: terminal.handle,
        subject: 'survived restart',
        type: 'worker_done'
      })
      write.mockClear()

      setInMemoryOrchestrationMessages(runtime, db)
      await vi.advanceTimersByTimeAsync(2_000)

      expect(write).toHaveBeenCalledWith(
        'pty-1',
        expect.stringContaining('You have 1 orchestration message')
      )
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops a pending repoint after its database closes', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      const db = new OrchestrationDb(':memory:')
      const write = vi.fn().mockReturnValue(true)
      runtime.setOrchestrationDb(db)
      runtime.setPtyController({
        write,
        kill: vi.fn(),
        getForegroundProcess: async () => null
      })
      syncSinglePty(runtime)

      const [terminal] = (await runtime.listTerminals()).terminals
      runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07', 100)
      db.insertMessage({ from: 'term_worker', to: terminal.handle, subject: 'pending' })
      runtime.notifyMessageArrived(terminal.handle, 'status')
      db.close()

      await vi.advanceTimersByTimeAsync(2_000)
      expect(write).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('points already-idle Run mail after Codex replaces its completion title', async () => {
    const runtime = new OrcaRuntimeService(store)
    const db = new InMemoryOrchestrationMessages()
    const write = vi.fn().mockReturnValue(true)
    setInMemoryOrchestrationMessages(runtime, db)
    runtime.setPtyController({
      write,
      kill: vi.fn(),
      getForegroundProcess: async () => 'codex'
    })
    syncSinglePty(runtime)

    const [terminal] = (await runtime.listTerminals()).terminals
    db.setRun({
      id: 'run_codex_native_title',
      coordinator_handle: terminal.handle,
      coordinator_pane_key: `${terminal.tabId}:${terminal.leafId}`
    })
    runtime.ingestSyntheticTitleFrame('pty-1', '\x1b]0;Codex ready\x07')
    runtime.onPtyData('pty-1', '\x1b]0;fix-12953-orchestration-mail-pointer\x07', 101)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    db.insertMessage({
      from: 'term_worker',
      to: 'run:run_codex_native_title',
      subject: 'real-agent smoke complete',
      body: 'The package name is orca.',
      type: 'worker_done'
    })

    runtime.notifyMessageArrived('run:run_codex_native_title', 'worker_done')
    await Promise.resolve()

    await vi.waitFor(() => {
      expect(write).toHaveBeenCalledWith(
        'pty-1',
        '\nYou have 1 orchestration message. Run `orca orchestration check --run run_codex_native_title`.\n'
      )
    })
    db.close()
  })

  it('does not inject pending mail on notify when the recipient is still working', async () => {
    const runtime = new OrcaRuntimeService(store)
    const db = new InMemoryOrchestrationMessages()
    const write = vi.fn().mockReturnValue(true)
    setInMemoryOrchestrationMessages(runtime, db)
    runtime.setPtyController({
      write,
      kill: vi.fn(),
      getForegroundProcess: async () => null
    })
    syncSinglePty(runtime)

    const [terminal] = (await runtime.listTerminals()).terminals
    bindSinglePtyRun(db, terminal.handle)
    runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07', 100)
    const message = db.insertMessage({
      from: 'sender',
      to: terminal.handle,
      subject: 'while working'
    })
    write.mockClear()

    runtime.notifyMessageArrived(terminal.handle, 'status')
    await Promise.resolve()

    expect(write).not.toHaveBeenCalled()
    // Why: busy must leave the row undelivered so a later idle can push it;
    // a stamp-without-write would suppress later delivery (#12584 CodeRabbit).
    expect(message.delivered_at).toBeNull()
    db.close()
  })

  it('delivers on a first live idle frame that follows a seeded idle with no transition', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      const db = new InMemoryOrchestrationMessages()
      const write = vi.fn().mockReturnValue(true)
      setInMemoryOrchestrationMessages(runtime, db)
      runtime.setPtyController({
        write,
        kill: vi.fn(),
        getForegroundProcess: async () => null
      })
      syncSinglePty(runtime)

      const [terminal] = (await runtime.listTerminals()).terminals
      bindSinglePtyRun(db, terminal.handle)
      runtime.seedTerminalRestoreTail('pty-1', { lastTitle: 'Codex done' })
      const message = db.insertMessage({
        from: 'sender',
        to: terminal.handle,
        subject: 'restored idle'
      })
      runtime.notifyMessageArrived(terminal.handle, 'status')
      await Promise.resolve()
      write.mockClear()

      // Why no working frame: a resumed agent sitting at its prompt emits an
      // already-idle title first. The seed left lastAgentStatus 'idle', so there
      // is no transition — only the liveness edge can release the row (#12536).
      runtime.onPtyData('pty-1', '\x1b]0;Codex done\x07', 100)

      expect(write).toHaveBeenCalledWith(
        'pty-1',
        expect.stringContaining('You have 1 orchestration message')
      )
      await vi.advanceTimersByTimeAsync(600)
      expect(message.delivered_at).toEqual(expect.any(String))
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not push on a cold-restore seeded idle status with no live observation', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      const db = new InMemoryOrchestrationMessages()
      const write = vi.fn().mockReturnValue(true)
      setInMemoryOrchestrationMessages(runtime, db)
      runtime.setPtyController({
        write,
        kill: vi.fn(),
        getForegroundProcess: async () => null
      })
      syncSinglePty(runtime)

      const [terminal] = (await runtime.listTerminals()).terminals
      bindSinglePtyRun(db, terminal.handle)
      // Why: the persisted title is historical — the agent may have gone busy
      // across the relaunch, so a seeded 'idle' must not authorize a PTY write.
      runtime.seedTerminalRestoreTail('pty-1', { lastTitle: 'Codex done' })
      const message = db.insertMessage({
        from: 'sender',
        to: terminal.handle,
        subject: 'seeded idle'
      })
      write.mockClear()

      runtime.notifyMessageArrived(terminal.handle, 'status')
      await Promise.resolve()

      expect(write).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(600)
      expect(message.delivered_at).toBeNull()

      // The first live idle frame authorizes it and the row still delivers.
      runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07', 100)
      runtime.onPtyData('pty-1', '\x1b]0;Codex done\x07', 101)
      expect(write).toHaveBeenCalledWith(
        'pty-1',
        expect.stringContaining('You have 1 orchestration message')
      )
      await vi.advanceTimersByTimeAsync(600)
      expect(message.delivered_at).toEqual(expect.any(String))
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('lets a resolved check consume its rows before a later same-tick notify pushes', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      const db = new InMemoryOrchestrationMessages()
      const write = vi.fn().mockReturnValue(true)
      setInMemoryOrchestrationMessages(runtime, db)
      runtime.setPtyController({
        write,
        kill: vi.fn(),
        getForegroundProcess: async () => null
      })
      syncSinglePty(runtime)

      const [terminal] = (await runtime.listTerminals()).terminals
      const mailbox = bindSinglePtyRun(db, terminal.handle)
      runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07', 100)
      runtime.onPtyData('pty-1', '\x1b]0;Codex done\x07', 101)
      await runtime.waitForTerminal(terminal.handle, { condition: 'tui-idle' })
      write.mockClear()

      // Why: resolveMessageWaiter removes the waiter synchronously, but the check
      // handler marks its rows read a microtask later. Two sends resuming off one
      // shared in-flight promise put a no-waiter notify inside that window, so the
      // push must not inject rows the resolved check is about to return.
      const consumed = runtime
        .waitForMessage(mailbox, { timeoutMs: 5_000 })
        .then(() => db.getUnreadMessages(mailbox).map((row) => (row.read = 1)))
      const first = db.insertMessage({ from: 'sender', to: terminal.handle, subject: 'pulled' })
      runtime.notifyMessageArrived(terminal.handle, 'status')
      const second = db.insertMessage({
        from: 'sender',
        to: terminal.handle,
        subject: 'also pulled'
      })
      runtime.notifyMessageArrived(terminal.handle, 'status')

      await consumed
      await Promise.resolve()
      expect(write).not.toHaveBeenCalled()
      expect(first.delivered_at).toBeNull()
      expect(second.delivered_at).toBeNull()
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves rows a live filtered waiter reserved out of the pushed batch', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      const db = new InMemoryOrchestrationMessages()
      const write = vi.fn().mockReturnValue(true)
      setInMemoryOrchestrationMessages(runtime, db)
      runtime.setPtyController({
        write,
        kill: vi.fn(),
        getForegroundProcess: async () => null
      })
      syncSinglePty(runtime)

      const [terminal] = (await runtime.listTerminals()).terminals
      const mailbox = bindSinglePtyRun(db, terminal.handle)
      runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07', 100)
      runtime.onPtyData('pty-1', '\x1b]0;Codex done\x07', 101)
      await runtime.waitForTerminal(terminal.handle, { condition: 'tui-idle' })
      write.mockClear()

      // Why: the push reads every pending row, not just the one that woke it. A
      // `status` notify is unclaimed and pushes, but the worker_done row landing
      // in the same drain belongs to this waiter's check — injecting it too would
      // deliver that completion twice (pane + check return).
      const waitPromise = runtime.waitForMessage(mailbox, {
        typeFilter: ['worker_done'],
        timeoutMs: 5_000
      })
      const status = db.insertMessage({
        from: 'sender',
        to: terminal.handle,
        subject: 'unclaimed status',
        type: 'status'
      })
      runtime.notifyMessageArrived(terminal.handle, 'status')
      const done = db.insertMessage({
        from: 'sender',
        to: terminal.handle,
        subject: 'reserved completion',
        type: 'worker_done'
      })
      runtime.notifyMessageArrived(terminal.handle, 'worker_done')

      await expect(waitPromise).resolves.toBe('notified')
      await vi.advanceTimersByTimeAsync(600)
      const payloads = write.mock.calls
        .map(([, data]) => data)
        .filter((data): data is string => typeof data === 'string')
      expect(payloads).toContain(
        '\nYou have 1 orchestration message. Run `orca orchestration check --run run_test`.\n'
      )
      expect(payloads.some((data) => data.includes('reserved completion'))).toBe(false)
      expect(status.delivered_at).toEqual(expect.any(String))
      expect(done.delivered_at).toBeNull()
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('skips rows claimed by a waiter that registered after the notify', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      const db = new InMemoryOrchestrationMessages()
      const write = vi.fn().mockReturnValue(true)
      setInMemoryOrchestrationMessages(runtime, db)
      runtime.setPtyController({
        write,
        kill: vi.fn(),
        getForegroundProcess: async () => null
      })
      syncSinglePty(runtime)

      const [terminal] = (await runtime.listTerminals()).terminals
      const mailbox = bindSinglePtyRun(db, terminal.handle)
      runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07', 100)
      runtime.onPtyData('pty-1', '\x1b]0;Codex done\x07', 101)
      await runtime.waitForTerminal(terminal.handle, { condition: 'tui-idle' })
      write.mockClear()

      const message = db.insertMessage({
        from: 'sender',
        to: terminal.handle,
        subject: 'claimed late',
        type: 'status'
      })
      // Why: the notify snapshot is empty — no waiter existed yet. A check that
      // blocks before the deferred push runs still owns this row, so only the
      // push-time read of live waiters can keep it out of the pane.
      runtime.notifyMessageArrived(terminal.handle, 'status')
      const waitPromise = runtime.waitForMessage(mailbox, {
        typeFilter: ['status'],
        timeoutMs: 5_000
      })
      await Promise.resolve()

      expect(write).not.toHaveBeenCalled()
      expect(message.delivered_at).toBeNull()

      await vi.advanceTimersByTimeAsync(5_000)
      await expect(waitPromise).resolves.toBe('timed_out')
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not carry pty-record live authority into a rebuilt leaf after a same-id respawn', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      const db = new InMemoryOrchestrationMessages()
      const write = vi.fn().mockReturnValue(true)
      runtime.setPtyController({
        write,
        kill: vi.fn(),
        getForegroundProcess: async () => null
      })
      // Why a UUID leaf id: the retirement fence's pty-candidate clause compares
      // parsePaneKey(pty.paneKey).leafId to the republished leafId, and a non-UUID
      // id falls back to `tabId:paneRuntimeId`, so it is always fenced after exit.
      const leafId = '11111111-1111-1111-8111-111111111111'
      const syncUuidLeaf = (): void => {
        runtime.attachWindow(1)
        runtime.syncWindowGraph(1, {
          tabs: [
            {
              tabId: 'tab-1',
              worktreeId: TEST_WORKTREE_ID,
              title: 'Codex',
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
              paneTitle: null
            }
          ]
        })
      }
      syncUuidLeaf()

      const [terminal] = (await runtime.listTerminals()).terminals
      runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07', 100)
      runtime.onPtyData('pty-1', '\x1b]0;Codex done\x07', 101)
      await runtime.waitForTerminal(terminal.handle, { condition: 'tui-idle' })
      write.mockClear()

      runtime.onPtyExit('pty-1', 0)
      runtime.onPtySpawned('pty-1', undefined, { awaitsRegistration: false })
      // Drop the leaf, then republish it: the rebuilt record's tailSource is the
      // PTY record rather than the previous leaf, which is what pins the clear
      // onPtyExit applies at the pty level.
      runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
      syncUuidLeaf()

      const leaves = (
        runtime as unknown as {
          leaves: Map<
            string,
            { lastAgentStatus: string | null; lastAgentStatusObservedLive: boolean }
          >
        }
      ).leaves
      expect(leaves.size).toBeGreaterThan(0)
      const rebuilt = [...leaves.values()][0]
      expect(rebuilt.lastAgentStatus).toBe('idle')
      expect(rebuilt.lastAgentStatusObservedLive).toBe(false)

      setInMemoryOrchestrationMessages(runtime, db)
      const [republished] = (await runtime.listTerminals()).terminals
      bindSinglePtyRun(db, republished.handle)
      const message = db.insertMessage({
        from: 'sender',
        to: republished.handle,
        subject: 'rebuilt leaf'
      })
      runtime.notifyMessageArrived(republished.handle, 'status')
      await Promise.resolve()

      expect(write).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(600)
      expect(message.delivered_at).toBeNull()
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps live idle authority across a renderer graph republish', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      const db = new InMemoryOrchestrationMessages()
      const write = vi.fn().mockReturnValue(true)
      setInMemoryOrchestrationMessages(runtime, db)
      runtime.setPtyController({
        write,
        kill: vi.fn(),
        getForegroundProcess: async () => null
      })
      syncSinglePty(runtime)

      const [terminal] = (await runtime.listTerminals()).terminals
      bindSinglePtyRun(db, terminal.handle)
      runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07', 100)
      runtime.onPtyData('pty-1', '\x1b]0;Codex done\x07', 101)
      await runtime.waitForTerminal(terminal.handle, { condition: 'tui-idle' })
      write.mockClear()

      // Why: syncWindowGraph rebuilds every leaf record on any pane/tab change.
      // An idle agent emits no new title, so dropping the live-status carry here
      // would strand mail until the next OSC frame — the #12536 symptom.
      syncSinglePty(runtime)

      const [republished] = (await runtime.listTerminals()).terminals
      const message = db.insertMessage({
        from: 'sender',
        to: republished.handle,
        subject: 'after republish'
      })

      runtime.notifyMessageArrived(republished.handle, 'status')
      await Promise.resolve()

      expect(write).toHaveBeenCalledWith(
        'pty-1',
        expect.stringContaining('You have 1 orchestration message')
      )
      await vi.advanceTimersByTimeAsync(600)
      expect(message.delivered_at).toEqual(expect.any(String))
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not reuse the dead process live idle authority after a same-id respawn', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      const db = new InMemoryOrchestrationMessages()
      const write = vi.fn().mockReturnValue(true)
      runtime.setPtyController({
        write,
        kill: vi.fn(),
        getForegroundProcess: async () => null
      })
      syncSinglePty(runtime)

      const [terminal] = (await runtime.listTerminals()).terminals
      runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07', 100)
      runtime.onPtyData('pty-1', '\x1b]0;Codex done\x07', 101)
      await runtime.waitForTerminal(terminal.handle, { condition: 'tui-idle' })
      write.mockClear()

      // Why: a cold restore respawns under the same session id and makes the
      // leaf writable again before any new title. The dead process's live idle
      // must not authorize typing into its replacement mid-turn.
      runtime.onPtyExit('pty-1', 0)
      runtime.onPtySpawned('pty-1', undefined, { awaitsRegistration: false })
      setInMemoryOrchestrationMessages(runtime, db)
      bindSinglePtyRun(db, terminal.handle)
      const message = db.insertMessage({
        from: 'sender',
        to: terminal.handle,
        subject: 'after same id respawn'
      })

      runtime.notifyMessageArrived(terminal.handle, 'status')
      await Promise.resolve()

      expect(write).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(600)
      expect(message.delivered_at).toBeNull()

      // The replacement's first live idle frame re-authorizes delivery — with no
      // working frame, since exit keeps lastAgentStatus 'idle' for `ps` and the
      // replacement can come up straight at an idle prompt (no transition).
      runtime.onPtyData('pty-1', '\x1b]0;Codex done\x07', 200)
      expect(write).toHaveBeenCalledWith(
        'pty-1',
        expect.stringContaining('You have 1 orchestration message')
      )
      await vi.advanceTimersByTimeAsync(600)
      expect(message.delivered_at).toEqual(expect.any(String))
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('pushes to an idle pane when the only live waiter filters out the message type', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      const db = new InMemoryOrchestrationMessages()
      const write = vi.fn().mockReturnValue(true)
      setInMemoryOrchestrationMessages(runtime, db)
      runtime.setPtyController({
        write,
        kill: vi.fn(),
        getForegroundProcess: async () => null
      })
      syncSinglePty(runtime)

      const [terminal] = (await runtime.listTerminals()).terminals
      const mailbox = bindSinglePtyRun(db, terminal.handle)
      runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07', 100)
      runtime.onPtyData('pty-1', '\x1b]0;Codex done\x07', 101)
      await runtime.waitForTerminal(terminal.handle, { condition: 'tui-idle' })

      // Why: a `check --wait --types worker_done` waiter never returns a status
      // row — check re-reads under the same filter — so it is not the consumer
      // and treating it as one would strand the message (#12536).
      const waitPromise = runtime.waitForMessage(mailbox, {
        typeFilter: ['worker_done'],
        timeoutMs: 5_000
      })
      const message = db.insertMessage({
        from: 'sender',
        to: terminal.handle,
        subject: 'unfiltered status',
        type: 'status'
      })
      write.mockClear()

      runtime.notifyMessageArrived(terminal.handle, 'status')

      await Promise.resolve()
      expect(write).toHaveBeenCalledWith(
        'pty-1',
        expect.stringContaining('You have 1 orchestration message')
      )
      await vi.advanceTimersByTimeAsync(600)
      expect(message.delivered_at).toEqual(expect.any(String))

      // The filtered waiter stays blocked; the push did not consume its wake.
      await vi.advanceTimersByTimeAsync(5_000)
      await expect(waitPromise).resolves.toBe('timed_out')
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('resolves a registered waiter without PTY-injecting when the leaf is already idle', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      const db = new InMemoryOrchestrationMessages()
      const write = vi.fn().mockReturnValue(true)
      setInMemoryOrchestrationMessages(runtime, db)
      runtime.setPtyController({
        write,
        kill: vi.fn(),
        getForegroundProcess: async () => null
      })
      syncSinglePty(runtime)

      const [terminal] = (await runtime.listTerminals()).terminals
      const mailbox = bindSinglePtyRun(db, terminal.handle)
      runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07', 100)
      runtime.onPtyData('pty-1', '\x1b]0;Codex done\x07', 101)
      await runtime.waitForTerminal(terminal.handle, { condition: 'tui-idle' })
      const message = db.insertMessage({
        from: 'sender',
        to: terminal.handle,
        subject: 'for check wait'
      })
      write.mockClear()

      // Why: blocked orchestration.check --wait is an explicit pull; push must
      // not stamp delivered_at or type into the pane (double delivery, #12584).
      const waitPromise = runtime.waitForMessage(mailbox, { timeoutMs: 5_000 })
      runtime.notifyMessageArrived(terminal.handle, 'status')

      await expect(waitPromise).resolves.toBe('notified')
      expect(write).not.toHaveBeenCalled()
      expect(message.delivered_at).toBeNull()
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not re-inject the same message when notify fires again during Enter delay', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      const db = new InMemoryOrchestrationMessages()
      const write = vi.fn().mockReturnValue(true)
      setInMemoryOrchestrationMessages(runtime, db)
      runtime.setPtyController({
        write,
        kill: vi.fn(),
        getForegroundProcess: async () => null
      })
      syncSinglePty(runtime)

      const [terminal] = (await runtime.listTerminals()).terminals
      bindSinglePtyRun(db, terminal.handle)
      runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07', 100)
      runtime.onPtyData('pty-1', '\x1b]0;Codex done\x07', 101)
      await runtime.waitForTerminal(terminal.handle, { condition: 'tui-idle' })
      db.insertMessage({ from: 'sender', to: terminal.handle, subject: 'once only' })

      runtime.notifyMessageArrived(terminal.handle, 'status')
      await Promise.resolve()
      runtime.notifyMessageArrived(terminal.handle, 'status')
      await Promise.resolve()

      const pointerWrites = write.mock.calls.filter(
        ([, payload]) => typeof payload === 'string' && payload.includes('orca orchestration check')
      )
      expect(pointerWrites).toHaveLength(1)

      await vi.advanceTimersByTimeAsync(500)
      const enterWrites = write.mock.calls.filter(([, payload]) => payload === '\r')
      expect(enterWrites).toHaveLength(1)

      await vi.advanceTimersByTimeAsync(2_000)
      expect(
        write.mock.calls.filter(
          ([, payload]) =>
            typeof payload === 'string' && payload.includes('orca orchestration check')
        )
      ).toHaveLength(1)
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('delivers a second message parked during Enter delay once the flight settles', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      const db = new InMemoryOrchestrationMessages()
      const write = vi.fn().mockReturnValue(true)
      setInMemoryOrchestrationMessages(runtime, db)
      runtime.setPtyController({
        write,
        kill: vi.fn(),
        getForegroundProcess: async () => null
      })
      syncSinglePty(runtime)

      const [terminal] = (await runtime.listTerminals()).terminals
      bindSinglePtyRun(db, terminal.handle)
      runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07', 100)
      runtime.onPtyData('pty-1', '\x1b]0;Codex done\x07', 101)
      await runtime.waitForTerminal(terminal.handle, { condition: 'tui-idle' })
      const first = db.insertMessage({ from: 'sender', to: terminal.handle, subject: 'first' })
      runtime.notifyMessageArrived(terminal.handle, 'status')
      // Why the flush: the deferred push must actually arm its flight before the
      // second message arrives, or this exercises a plain batch instead.
      await Promise.resolve()

      // Why: mid-flight notify parks the leaf; flight settle re-runs delivery
      // so the second row is not lost and is not double-injected with the first.
      const second = db.insertMessage({ from: 'sender', to: terminal.handle, subject: 'second' })
      runtime.notifyMessageArrived(terminal.handle, 'status')
      await Promise.resolve()
      expect(
        write.mock.calls.filter(
          ([, payload]) =>
            typeof payload === 'string' && payload.includes('orca orchestration check')
        )
      ).toHaveLength(1)
      expect(second.delivered_at).toBeNull()

      // Why: release must not require another agent-status OSC — only the
      // delayed-Enter flight timer. Advancing 3s with no status output covers
      // timer-only settle (CodeRabbit settling-timeout gap, #12584).
      await vi.advanceTimersByTimeAsync(3_000)
      expect(write).toHaveBeenCalledWith('pty-1', '\r')
      expect(first.delivered_at).toEqual(expect.any(String))
      expect(
        write.mock.calls.filter(
          ([, payload]) =>
            typeof payload === 'string' && payload.includes('orca orchestration check')
        )
      ).toHaveLength(2)
      expect(write).toHaveBeenCalledWith(
        'pty-1',
        expect.stringContaining('You have 1 orchestration message')
      )
      expect(second.delivered_at).toEqual(expect.any(String))
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps already-idle status after tui-idle wait for immediate message delivery', async () => {
    const runtime = new OrcaRuntimeService(store)
    const db = new InMemoryOrchestrationMessages()
    const write = vi.fn().mockReturnValue(true)
    setInMemoryOrchestrationMessages(runtime, db)
    runtime.setPtyController({
      write,
      kill: vi.fn(),
      getForegroundProcess: async () => null
    })
    syncSinglePty(runtime)

    const [terminal] = (await runtime.listTerminals()).terminals
    bindSinglePtyRun(db, terminal.handle)
    runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07', 100)
    runtime.onPtyData('pty-1', '\x1b]0;Codex done\x07', 101)
    await runtime.waitForTerminal(terminal.handle, { condition: 'tui-idle' })
    db.insertMessage({ from: 'sender', to: terminal.handle, subject: 'after wait' })

    runtime.deliverPendingMessagesForHandle(terminal.handle)

    expect(write).toHaveBeenCalledWith(
      'pty-1',
      expect.stringContaining('You have 1 orchestration message')
    )
    db.close()
  })

  it('resolves message waiters when notifyMessageArrived is called', async () => {
    const runtime = new OrcaRuntimeService(store)

    const waitPromise = runtime.waitForMessage('term_abc', { timeoutMs: 5000 })
    runtime.notifyMessageArrived('term_abc')
    await expect(waitPromise).resolves.toBe('notified')
  })

  it('does not resolve type-filtered message waiters for unrelated message types', async () => {
    const runtime = new OrcaRuntimeService(store)

    const waitPromise = runtime.waitForMessage('term_abc', {
      typeFilter: ['worker_done', 'escalation'],
      timeoutMs: 5000
    })
    let settled = false
    void waitPromise.then(() => {
      settled = true
    })

    runtime.notifyMessageArrived('term_abc', 'heartbeat')
    await Promise.resolve()

    expect(settled).toBe(false)

    runtime.notifyMessageArrived('term_abc', 'worker_done')
    await waitPromise
    expect(settled).toBe(true)
  })

  it('removes message waiter abort listeners after message arrival', async () => {
    const runtime = new OrcaRuntimeService(store)
    const controller = new AbortController()
    const removeListenerSpy = vi.spyOn(controller.signal, 'removeEventListener')

    const waitPromise = runtime.waitForMessage('term_abc', {
      timeoutMs: 5000,
      signal: controller.signal
    })
    runtime.notifyMessageArrived('term_abc')
    await waitPromise

    expect(removeListenerSpy).toHaveBeenCalledWith('abort', expect.any(Function))
  })

  it('resolves message waiters on timeout when no message arrives', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      const wait = runtime.waitForMessage('term_abc', { timeoutMs: 100 })

      await vi.advanceTimersByTimeAsync(99)
      let settled = false
      void wait.then(() => {
        settled = true
      })
      await Promise.resolve()
      expect(settled).toBe(false)

      await vi.advanceTimersByTimeAsync(1)
      await expect(wait).resolves.toBe('timed_out')
    } finally {
      vi.useRealTimers()
    }
  })

  it('allows only one exclusive mailbox waiter and supports explicit cancellation', async () => {
    const runtime = new OrcaRuntimeService(store)
    const first = runtime.waitForMessage('run:run_1', {
      timeoutMs: 5000,
      exclusive: true
    })

    await expect(
      runtime.waitForMessage('run:run_1', { timeoutMs: 5000, exclusive: true })
    ).resolves.toBe('waiter_exists')
    runtime.cancelMessageWaiters('run:run_1')
    await expect(first).resolves.toBe('cancelled')
  })

  it('rejects leaf PTY waits when the request signal aborts', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      const controller = new AbortController()

      const waitPromise = runtime
        .waitForLeafPtyId('missing-handle', 60_000, controller.signal)
        .then(() => 'resolved')
        .catch((error: Error) => error.message)

      controller.abort()
      const outcomePromise = Promise.race([
        waitPromise,
        new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 0))
      ])
      await vi.advanceTimersByTimeAsync(0)

      expect(await outcomePromise).toBe('request_aborted')
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails terminal waits closed when the handle goes stale during reload', async () => {
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
    const waitPromise = runtime.waitForTerminal(terminal.handle, { timeoutMs: 1000 })
    runtime.markRendererReloading(1)

    await expect(waitPromise).rejects.toThrow('terminal_handle_stale')
  })

  it('tui-idle times out when PTY data has no agent OSC title transitions', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)

      runtime.attachWindow(1)
      runtime.syncWindowGraph(1, {
        tabs: [
          {
            tabId: 'tab-1',
            worktreeId: 'repo-1::/tmp/worktree-a',
            title: 'Terminal 1',
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
      runtime.onPtyData('pty-1', 'running migration step 4/9\n', 123)

      const [terminal] = (await runtime.listTerminals()).terminals
      const waitPromise = runtime.waitForTerminal(terminal.handle, {
        condition: 'tui-idle',
        timeoutMs: 1_000
      })
      const timeoutAssertion = expect(waitPromise).rejects.toThrow('timeout')

      await vi.advanceTimersByTimeAsync(12_000)

      await timeoutAssertion
    } finally {
      vi.useRealTimers()
    }
  })

  it('tui-idle resolves on agent working→idle OSC title transition', async () => {
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

    // Simulate agent starting work (braille spinner = working)
    runtime.onPtyData('pty-1', '\x1b]0;\u280b Working on task\x07output\n', 100)

    const [terminal] = (await runtime.listTerminals()).terminals
    const waitPromise = runtime.waitForTerminal(terminal.handle, {
      condition: 'tui-idle',
      timeoutMs: 5_000
    })

    // Simulate agent finishing (✳ = Claude Code idle)
    runtime.onPtyData('pty-1', '\x1b]0;\u2733 Task complete\x07done\n', 200)

    const result = await waitPromise
    expect(result.condition).toBe('tui-idle')
    expect(result.satisfied).toBe(true)
  })
})

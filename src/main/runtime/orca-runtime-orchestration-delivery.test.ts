import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  InMemoryOrchestrationMessages,
  bindSinglePtyRun,
  resetRuntimeTestMocks,
  setInMemoryOrchestrationMessages,
  store,
  syncSinglePty
} from './orca-runtime-test-fixture'
import { OrcaRuntimeService } from './orca-runtime'

beforeEach(resetRuntimeTestMocks)
afterEach(resetRuntimeTestMocks)

describe('OrcaRuntimeService', () => {
  it('delivers pending orchestration messages to an already-idle agent', async () => {
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
      db.setActiveCoordinatorRun({ coordinator_handle: 'term_other' })
      db.insertMessage({ from: 'term_sender', to: terminal.handle, subject: 'hello' })

      runtime.deliverPendingMessagesForHandle(terminal.handle)

      expect(write).toHaveBeenCalledWith(
        'pty-1',
        expect.stringContaining('You have 1 orchestration message')
      )
      await vi.advanceTimersByTimeAsync(500)
      expect(write).toHaveBeenCalledWith('pty-1', '\r')

      const unread = db.getUnreadMessages(mailbox)
      expect(unread).toHaveLength(1)
      expect(unread[0].read).toBe(0)
      expect(unread[0].delivered_at).toEqual(expect.any(String))
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('submits the mail pointer in an active coordinator pane', async () => {
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
      db.setActiveCoordinatorRun({ coordinator_handle: terminal.handle })
      db.insertMessage({
        from: 'term_sender',
        to: terminal.handle,
        subject: 'hello coordinator'
      })

      runtime.deliverPendingMessagesForHandle(terminal.handle)

      expect(write).toHaveBeenCalledWith(
        'pty-1',
        expect.stringContaining('You have 1 orchestration message')
      )
      await vi.advanceTimersByTimeAsync(500)
      const submitWrites = write.mock.calls.filter(
        ([ptyId, text]) => ptyId === 'pty-1' && text === '\r'
      )
      expect(submitWrites).toHaveLength(1)

      const unread = db.getUnreadMessages(mailbox)
      expect(unread).toHaveLength(1)
      expect(unread[0].read).toBe(0)
      expect(unread[0].delivered_at).toEqual(expect.any(String))
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('injects pending orchestration messages into Cursor Agent without auto-submitting', async () => {
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
      runtime.onPtyData('pty-1', '\x1b]0;\u280b Cursor Agent\x07', 100)
      runtime.onPtyData('pty-1', '\x1b]0;Cursor ready\x07', 101)
      db.insertMessage({ from: 'term_sender', to: terminal.handle, subject: 'hello cursor' })

      runtime.deliverPendingMessagesForHandle(terminal.handle)

      expect(write).toHaveBeenCalledWith(
        'pty-1',
        expect.stringContaining('You have 1 orchestration message')
      )
      await vi.advanceTimersByTimeAsync(500)
      const submitWrites = write.mock.calls.filter(
        ([ptyId, text]) => ptyId === 'pty-1' && text === '\r'
      )
      expect(submitWrites).toHaveLength(0)

      const unread = db.getUnreadMessages(mailbox)
      expect(unread).toHaveLength(1)
      expect(unread[0].read).toBe(0)
      expect(unread[0].delivered_at).toEqual(expect.any(String))
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('still auto-submits to a non-Cursor agent when its idle title mentions Cursor Agent', async () => {
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
      syncSinglePty(runtime, 'pty-1', { tabTitle: 'cursor-repro-branch' })

      const [terminal] = (await runtime.listTerminals()).terminals
      bindSinglePtyRun(db, terminal.handle)
      runtime.onPtyData('pty-1', '\x1b]0;. Investigate Cursor Agent\x07', 100)
      runtime.onPtyData('pty-1', '\x1b]0;* Investigate Cursor Agent\x07', 101)
      db.insertMessage({ from: 'term_sender', to: terminal.handle, subject: 'hello claude' })

      runtime.deliverPendingMessagesForHandle(terminal.handle)
      await vi.advanceTimersByTimeAsync(500)

      expect(write).toHaveBeenCalledWith(
        'pty-1',
        expect.stringContaining('You have 1 orchestration message')
      )
      expect(write).toHaveBeenCalledWith('pty-1', '\r')
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not replay an already-delivered message on a later idle transition', async () => {
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
      db.insertMessage({ from: 'term_sender', to: terminal.handle, subject: 'hello' })

      runtime.deliverPendingMessagesForHandle(terminal.handle)
      await vi.advanceTimersByTimeAsync(500)

      const firstInjections = write.mock.calls.filter(
        (c) => typeof c[1] === 'string' && c[1].includes('orca orchestration check')
      ).length
      expect(firstInjections).toBe(1)

      // The row remains pending, so the in-memory sequence watermark prevents replay.
      runtime.deliverPendingMessagesForHandle(terminal.handle)
      await vi.advanceTimersByTimeAsync(500)

      const totalInjections = write.mock.calls.filter(
        (c) => typeof c[1] === 'string' && c[1].includes('orca orchestration check')
      ).length
      expect(totalInjections).toBe(1)
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })
})

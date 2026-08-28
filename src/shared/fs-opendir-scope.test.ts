import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Dir } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { opendirMock } = vi.hoisted(() => ({ opendirMock: vi.fn() }))

vi.mock('node:fs/promises', () => ({ opendir: opendirMock }))

import { withDir, OpenedDirectory } from './fs-opendir-scope'

const realOpendir = (async () => {
  const actual = await vi.importActual('node:fs/promises')
  return (actual as { opendir: (path: string) => Promise<Dir> }).opendir
})()

beforeEach(() => {
  vi.clearAllMocks()
})

function createFakeDir() {
  const close = vi.fn().mockResolvedValue(undefined)
  return {
    close,
    async *[Symbol.asyncIterator]() {
      yield { name: 'a.txt' }
    }
  }
}

describe('withDir', () => {
  it('closes the handle on success and returns fn value', async () => {
    const dir = createFakeDir()
    opendirMock.mockResolvedValue(dir)
    await expect(withDir('/x', async () => 'value')).resolves.toBe('value')
    expect(dir.close).toHaveBeenCalledTimes(1)
  })

  it('closes the handle when fn throws and rethrows', async () => {
    const dir = createFakeDir()
    opendirMock.mockResolvedValue(dir)
    await expect(withDir('/x', () => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    expect(dir.close).toHaveBeenCalledTimes(1)
  })

  it('rejects without opening when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      withDir('/x', async () => 'value', { signal: controller.signal })
    ).rejects.toThrow()
    expect(opendirMock).not.toHaveBeenCalled()
  })

  it('rejects with signal reason on pre-abort', async () => {
    const controller = new AbortController()
    const reason = new Error('cancelled')
    controller.abort(reason)
    await expect(withDir('/x', async () => 'value', { signal: controller.signal })).rejects.toBe(
      reason
    )
  })

  it('closes even when aborted while fn runs', async () => {
    const dir = createFakeDir()
    opendirMock.mockResolvedValue(dir)
    const controller = new AbortController()
    await withDir(
      '/x',
      async () => {
        controller.abort()
      },
      { signal: controller.signal }
    )
    expect(dir.close).toHaveBeenCalledTimes(1)
  })

  it('swallows close errors from a rejecting handle', async () => {
    const dir = { close: vi.fn().mockRejectedValue(new Error('close failed')) }
    opendirMock.mockResolvedValue(dir)
    await expect(withDir('/x', async () => 'ok')).resolves.toBe('ok')
  })

  it('disposes via Symbol.asyncDispose when used directly with await using', async () => {
    const dir = createFakeDir()
    opendirMock.mockResolvedValue(dir)
    async function consume(): Promise<string[]> {
      await using directory = await OpenedDirectory.open('/proc')
      const names: string[] = []
      for await (const entry of directory.dir) {
        names.push(entry.name)
        break // consumer breaks out early, like a generator return()
      }
      return names
    }
    await expect(consume()).resolves.toEqual(['a.txt'])
    expect(dir.close).toHaveBeenCalledTimes(1)
  })

  it('works against a real temp directory', async () => {
    opendirMock.mockImplementation((path: string) => realOpendir.then((fn) => fn(path)))
    const tempDirectory = mkdtempSync(join(tmpdir(), 'withdir-'))
    try {
      const names = await withDir(tempDirectory, async (dir) => {
        const collected: string[] = []
        for await (const entry of dir) {
          collected.push(entry.name)
        }
        return collected
      })
      expect(names).toEqual([])
    } finally {
      rmSync(tempDirectory, { recursive: true, force: true })
    }
  })
})

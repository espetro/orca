import { opendir } from 'node:fs/promises'
import type { Dir } from 'node:fs'

/**
 * Opens a directory, runs `fn`, and always closes the handle.
 * If `signal` is already aborted, rejects without opening. Abort while `fn`
 * runs still closes the handle but does not interrupt it mid-use: `fn` should
 * observe the signal itself.
 */
export async function withDir<T>(
  path: string,
  fn: (dir: Dir) => Promise<T>,
  opts?: { signal?: AbortSignal }
): Promise<T> {
  if (opts?.signal?.aborted) {
    throw opts.signal.reason instanceof Error ? opts.signal.reason : new Error('Aborted')
  }
  const directory = await opendir(path)
  try {
    return await fn(directory)
  } finally {
    // Swallows close failures (and mock handles without close); harmless once work is done.
    try {
      await directory.close()
    } catch {
      // ignored
    }
  }
}

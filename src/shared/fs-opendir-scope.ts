import { opendir } from 'node:fs/promises'
import type { Dir } from 'node:fs'

/**
 * An opened directory handle that closes itself on disposal.
 * Usable directly with `await using` (e.g. inside generators) or via `withDir`.
 */
export class OpenedDirectory implements AsyncDisposable {
  private constructor(readonly dir: Dir) {}

  static async open(path: string, opts?: { signal?: AbortSignal }): Promise<OpenedDirectory> {
    if (opts?.signal?.aborted) {
      throw opts.signal.reason instanceof Error ? opts.signal.reason : new Error('Aborted')
    }
    return new OpenedDirectory(await opendir(path))
  }

  // Swallows close failures (and mock handles without close); harmless once work is done.
  async [Symbol.asyncDispose](): Promise<void> {
    try {
      await this.dir.close()
    } catch {
      // ignored
    }
  }
}

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
  await using directory = await OpenedDirectory.open(path, opts)
  return await fn(directory.dir)
}

import { extname, join } from 'node:path'
import { open, readdir, stat } from 'node:fs/promises'
import type { DirEntry, FsChangeEvent } from '../../shared/filesystem-entry-types'
import type { RuntimeFilePreviewResult, RuntimeFileReadChunkResult } from '../../shared/runtime-types'
import type { DocPreviewFileAccessRequest, DocPreviewFileAccessResult } from '../../shared/doc-preview-file-access'
import { readAuthorizedDocPreviewFile } from '../../shared/doc-preview-file-access'
import { sortDirEntries } from '../../shared/file-name-sort'
import { closeFileExplorerWatcherInWatcherProcess, watchFileExplorerInWatcherProcess } from './file-watcher-host'
import { NodeFileReadTooLargeError, readNodeFileWithinLimit } from '../../shared/node-bounded-file-reader'
import { readSshFileExplorerChunk } from './ssh-file-explorer-chunk-read'
import { beginWatcherInstall } from '../ipc/watcher-removal-gate'
import { resolveAuthorizedPath } from '../ipc/filesystem-auth'
import { getSshFilesystemProvider, SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE } from '../providers/ssh-filesystem-dispatch'
import {
  MOBILE_FILE_READ_MAX_BYTES,
  LOCAL_PREVIEWABLE_BINARY_MAX_BYTES,
  previewableBinaryByteLimit,
  readPreviewFileWithinCap,
  assertPreviewWithinTransportBudget,
  isBinaryBuffer,
  RUNTIME_PREVIEWABLE_BINARY_MIME_TYPES,
  type ResolvedRuntimeFileWorktree,
  type RuntimeFileCommandHost
} from './runtime-file-shared'
import {
  registerRuntimeFileWatcherRelease,
  runtimeWatcherReleaseKey,
  armSshFileExplorerWatchRearm,
  stopSshFileExplorerWatchRearms,
  runtimeFileWatcherLeasesByOwnerAndRoot
} from './runtime-file-watcher-leases'
import { watchWindowsRuntimeFileExplorer } from './runtime-file-windows-watcher'
import { joinWorktreeRelativePath, normalizeRuntimeRelativePath } from './runtime-relative-paths'

export class RuntimeFileExplorerReadCommands {
  constructor(private readonly host: RuntimeFileCommandHost) {}

  async readFileExplorerDir(worktreeSelector: string, relativePath: string): Promise<DirEntry[]> {
    const target = await this.resolveFileExplorerPath(worktreeSelector, relativePath)
    const provider = target.connectionId ? getSshFilesystemProvider(target.connectionId) : null
    if (target.connectionId) {
      if (!provider) {
        throw new Error(SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE)
      }
      // Why: re-sort locally — the remote relay may be an older build with
      // lexicographic ordering.
      return sortDirEntries(await provider.readDir(target.path))
    }

    const dirPath = await resolveAuthorizedPath(target.path, this.host.requireStore())
    const entries = await readdir(dirPath, { withFileTypes: true })
    const mapped = await Promise.all(
      entries.map(async (entry) => {
        const entryPath = join(dirPath, entry.name)
        return {
          name: entry.name,
          isDirectory: await isRuntimeDirectoryEntry(entry, entryPath),
          isSymlink: entry.isSymbolicLink()
        }
      })
    )
    return sortDirEntries(mapped)
  }


  async watchFileExplorer(
    worktreeSelector: string,
    callback: (events: FsChangeEvent[]) => void,
    onTerminalError: (error: Error) => void = () => undefined,
    signal?: AbortSignal
  ): Promise<() => Promise<void>> {
    const target = await this.resolveFileExplorerPath(worktreeSelector, '')
    const open = async (): Promise<{
      unsubscribe: () => Promise<void>
      rootPaths: string[]
    }> => {
      const finishInstall = beginWatcherInstall(target.path, target.connectionId)
      try {
        const provider = target.connectionId ? getSshFilesystemProvider(target.connectionId) : null
        if (target.connectionId) {
          if (!provider) {
            throw new Error(SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE)
          }
          // Why: the RPC layer already threads AbortSignal for local watches; SSH must cancel the remote fs.watch, not wait it out.
          const close = await provider.watch(target.path, callback, { signal, onTerminalError })
          const rearm = armSshFileExplorerWatchRearm({
            runtimeId: this.host.getRuntimeId(),
            connectionId: target.connectionId,
            rootPath: target.path,
            callback,
            onTerminalError,
            signal,
            initialUnwatch: close
          })
          return { unsubscribe: rearm.unsubscribe, rootPaths: [target.path] }
        }

        const rootPath = await resolveAuthorizedPath(target.path, this.host.requireStore())
        const rootStats = await stat(rootPath)
        if (!rootStats.isDirectory()) {
          throw new Error('not_a_directory')
        }
        if (process.platform === 'win32') {
          const close = watchWindowsRuntimeFileExplorer(rootPath, callback, onTerminalError)
          return { unsubscribe: close, rootPaths: [target.path, rootPath] }
        }
        // Why: the forked watcher keeps the blocking crawl and native faults out of the main/`serve` process (issues #5308, #8212).
        const dispose = await watchFileExplorerInWatcherProcess(
          rootPath,
          callback,
          onTerminalError,
          signal
        )
        return { unsubscribe: dispose, rootPaths: [target.path, rootPath] }
      } finally {
        finishInstall()
      }
    }
    const initial = await open()
    return registerRuntimeFileWatcherRelease(
      this.host.getRuntimeId(),
      target.connectionId,
      initial.rootPaths,
      initial.unsubscribe,
      async () => (await open()).unsubscribe,
      onTerminalError
    )
  }


  async closeFileExplorerWatchersForPath(rootPath: string, connectionId?: string): Promise<void> {
    const key = runtimeWatcherReleaseKey(this.host.getRuntimeId(), connectionId, rootPath)
    const leases = runtimeFileWatcherLeasesByOwnerAndRoot.get(key)
    if (leases) {
      await Promise.all(Array.from(leases, (lease) => lease.suspend()))
    }
    if (!connectionId) {
      // Why: setup can fail before registerRuntimeFileWatcherRelease publishes its callback while the child owner still lives.
      const resolvedRootPath = await resolveAuthorizedPath(rootPath, this.host.requireStore())
      await closeFileExplorerWatcherInWatcherProcess(resolvedRootPath)
    }
  }


  async restoreFileExplorerWatchersAfterFailedRemoval(
    rootPath: string,
    connectionId?: string
  ): Promise<void> {
    const key = runtimeWatcherReleaseKey(this.host.getRuntimeId(), connectionId, rootPath)
    const leases = runtimeFileWatcherLeasesByOwnerAndRoot.get(key)
    if (leases) {
      await Promise.all(Array.from(leases, (lease) => lease.resume()))
    }
  }


  forgetFileExplorerWatchersAfterRemoval(rootPath: string, connectionId?: string): void {
    const key = runtimeWatcherReleaseKey(this.host.getRuntimeId(), connectionId, rootPath)
    // Why: forget() never runs the lease's unsubscribe, so the re-arm would outlive a deleted
    // worktree and re-watch it on the next reconnect.
    stopSshFileExplorerWatchRearms(key)
    const leases = runtimeFileWatcherLeasesByOwnerAndRoot.get(key)
    if (leases) {
      for (const lease of Array.from(leases)) {
        lease.forget()
      }
    }
  }


  async readFileExplorerPreview(
    worktreeSelector: string,
    relativePath: string,
    maxContentBytes?: number
  ): Promise<RuntimeFilePreviewResult> {
    const binaryMaxBytes =
      maxContentBytes === undefined
        ? LOCAL_PREVIEWABLE_BINARY_MAX_BYTES
        : previewableBinaryByteLimit(maxContentBytes)
    const target = await this.resolveFileExplorerPath(worktreeSelector, relativePath)
    const provider = target.connectionId ? getSshFilesystemProvider(target.connectionId) : null
    if (target.connectionId) {
      if (!provider) {
        throw new Error(SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE)
      }
      const fileStats = await provider.stat(target.path)
      if (fileStats.size > binaryMaxBytes) {
        throw new Error('file_too_large')
      }
      const result = await readPreviewFileWithinCap(provider, target.path, {
        maxBinaryBytes: binaryMaxBytes,
        maxTextBytes: MOBILE_FILE_READ_MAX_BYTES
      })
      // Why: the stat gate sizes base64 binaries; text crosses the wire JSON-escaped (up to 6x), so
      // hold it to the same decoded limit the local branch enforces before reading.
      if (
        !result.isBinary &&
        Buffer.byteLength(result.content, 'utf8') > MOBILE_FILE_READ_MAX_BYTES
      ) {
        throw new Error('file_too_large')
      }
      if (
        result.isBinary &&
        maxContentBytes !== undefined &&
        Buffer.byteLength(result.content, 'utf8') > maxContentBytes
      ) {
        throw new Error('file_too_large')
      }
      return assertPreviewWithinTransportBudget(result, maxContentBytes)
    }

    const filePath = await resolveAuthorizedPath(target.path, this.host.requireStore())
    const mimeType = RUNTIME_PREVIEWABLE_BINARY_MIME_TYPES[extname(filePath).toLowerCase()]
    const maxBytes = mimeType ? binaryMaxBytes : MOBILE_FILE_READ_MAX_BYTES
    let buffer: Buffer
    try {
      buffer = (await readNodeFileWithinLimit(filePath, maxBytes)).buffer
    } catch (error) {
      if (error instanceof NodeFileReadTooLargeError) {
        throw new Error('file_too_large')
      }
      throw error
    }
    if (mimeType) {
      return assertPreviewWithinTransportBudget(
        {
          content: buffer.toString('base64'),
          isBinary: true,
          isImage: true,
          mimeType
        },
        maxContentBytes
      )
    }

    if (isBinaryBuffer(buffer)) {
      return assertPreviewWithinTransportBudget({ content: '', isBinary: true }, maxContentBytes)
    }
    return assertPreviewWithinTransportBudget(
      { content: buffer.toString('utf-8'), isBinary: false },
      maxContentBytes
    )
  }


  async readDocPreviewFile(
    worktreeSelector: string,
    relativePath: string,
    entryRelativePath: string,
    implicitRootRelativePath: string | null,
    authorizedRootRelativePaths: string[],
    maxContentBytes?: number
  ): Promise<DocPreviewFileAccessResult> {
    const relativePaths = [
      '',
      entryRelativePath,
      relativePath,
      ...(implicitRootRelativePath === null ? [] : [implicitRootRelativePath]),
      ...authorizedRootRelativePaths
    ]
    const [boundary, entry, target, ...authorityRoots] = await this.resolveFileExplorerPaths(
      worktreeSelector,
      relativePaths
    )
    const implicitRoot = implicitRootRelativePath === null ? null : authorityRoots[0]
    const authorizedRoots = authorityRoots.slice(implicitRoot === null ? 0 : 1)
    const binaryMaxBytes =
      maxContentBytes === undefined
        ? LOCAL_PREVIEWABLE_BINARY_MAX_BYTES
        : previewableBinaryByteLimit(maxContentBytes)
    const request: DocPreviewFileAccessRequest = {
      boundaryPath: boundary.path,
      entryPath: entry.path,
      implicitRootPath: implicitRoot?.path ?? null,
      authorizedRootPaths: authorizedRoots.map((root) => root.path),
      targetPath: target.path,
      maxTextBytes: MOBILE_FILE_READ_MAX_BYTES,
      maxBinaryBytes: binaryMaxBytes
    }
    const provider = target.connectionId ? getSshFilesystemProvider(target.connectionId) : null
    if (target.connectionId && !provider) {
      throw new Error(SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE)
    }
    if (target.connectionId && !provider?.readDocPreviewFile) {
      throw new Error('Secure document previews require a newer SSH relay')
    }
    const result = provider?.readDocPreviewFile
      ? await provider.readDocPreviewFile(request)
      : await readAuthorizedDocPreviewFile(request)
    return assertPreviewWithinTransportBudget(result, maxContentBytes)
  }


  async readFileExplorerChunk(
    worktreeSelector: string,
    relativePath: string,
    offset: number,
    length: number
  ): Promise<RuntimeFileReadChunkResult> {
    const target = await this.resolveFileExplorerPath(worktreeSelector, relativePath)
    const provider = target.connectionId ? getSshFilesystemProvider(target.connectionId) : null
    if (target.connectionId) {
      if (!provider) {
        throw new Error(SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE)
      }
      const fileStat = await provider.stat(target.path)
      if (fileStat.type === 'directory') {
        throw new Error('Cannot download a directory')
      }
      return readSshFileExplorerChunk(provider, target.path, fileStat.size, offset, length)
    }

    const filePath = await resolveAuthorizedPath(target.path, this.host.requireStore())
    const fileStats = await stat(filePath)
    if (fileStats.isDirectory()) {
      throw new Error('Cannot download a directory')
    }
    const handle = await open(filePath, 'r')
    try {
      const buffer = Buffer.alloc(Math.min(length, Math.max(0, fileStats.size - offset)))
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, offset)
      const chunk = buffer.subarray(0, bytesRead)
      return {
        contentBase64: chunk.toString('base64'),
        bytesRead,
        eof: offset + bytesRead >= fileStats.size
      }
    } finally {
      await handle.close()
    }
  }


  private async resolveFileExplorerPath(
    worktreeSelector: string,
    relativePath: string
  ): Promise<{ worktree: ResolvedRuntimeFileWorktree; path: string; connectionId?: string }> {
    const [target] = await this.resolveFileExplorerPaths(worktreeSelector, [relativePath])
    return target
  }

  private async resolveFileExplorerPaths(
    worktreeSelector: string,
    relativePaths: readonly string[]
  ): Promise<{ worktree: ResolvedRuntimeFileWorktree; path: string; connectionId?: string }[]> {
    const target = await this.host.resolveRuntimeFileTarget(worktreeSelector)
    return relativePaths.map((relativePath) => ({
      worktree: target.worktree,
      path: joinWorktreeRelativePath(
        target.worktree.path,
        normalizeRuntimeRelativePath(relativePath)
      ),
      connectionId: target.connectionId
    }))
  }
}

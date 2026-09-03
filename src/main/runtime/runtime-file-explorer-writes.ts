import { constants, copyFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { renameLocalPathSerializedByDestination } from '../destination-serialized-local-rename'
import { resolveAuthorizedPath } from '../ipc/filesystem-auth'
import { isENOENT } from '../ipc/filesystem-path-containment'
import { getSshFilesystemProvider, SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE } from '../providers/ssh-filesystem-dispatch'
import { assertRuntimeFileMutationExpectation } from './runtime-file-watcher-leases'
import type { RuntimeFileCommandHost } from './runtime-file-shared'

export class RuntimeFileExplorerWriteCommands {
  constructor(private readonly host: RuntimeFileCommandHost) {}

  async writeFileExplorerFile(
    worktreeSelector: string,
    relativePath: string,
    content: string,
    expectedSshConnectionGeneration?: number,
    expectedSshTargetId?: string,
    expectedExecutionHostId?: string
  ): Promise<{ ok: true }> {
    const target = await this.resolveFileExplorerPath(worktreeSelector, relativePath)
    assertRuntimeFileMutationExpectation(
      target.connectionId,
      expectedExecutionHostId,
      expectedSshTargetId,
      expectedSshConnectionGeneration
    )
    const provider = target.connectionId ? getSshFilesystemProvider(target.connectionId) : null
    if (target.connectionId) {
      if (!provider) {
        throw new Error(SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE)
      }
      await provider.writeFile(target.path, content)
      return { ok: true }
    }

    const filePath = await resolveAuthorizedPath(target.path, this.host.requireStore())
    try {
      const fileStats = await lstat(filePath)
      if (fileStats.isDirectory()) {
        throw new Error('Cannot write to a directory')
      }
    } catch (error) {
      if (!isENOENT(error)) {
        throw error
      }
    }
    await writeFile(filePath, content, 'utf-8')
    return { ok: true }
  }
  async writeFileExplorerFileBase64(
    worktreeSelector: string,
    relativePath: string,
    contentBase64: string,
    expectedSshConnectionGeneration?: number,
    expectedSshTargetId?: string,
    expectedExecutionHostId?: string
  ): Promise<{ ok: true }> {
    const target = await this.resolveFileExplorerPath(worktreeSelector, relativePath)
    assertRuntimeFileMutationExpectation(
      target.connectionId,
      expectedExecutionHostId,
      expectedSshTargetId,
      expectedSshConnectionGeneration
    )
    const provider = target.connectionId ? getSshFilesystemProvider(target.connectionId) : null
    const content = Buffer.from(contentBase64, 'base64')
    if (target.connectionId) {
      if (!provider) {
        throw new Error(SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE)
      }
      await provider.writeFileBase64(target.path, contentBase64)
      return { ok: true }
    }

    const filePath = await resolveAuthorizedPath(target.path, this.host.requireStore())
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, content, { flag: 'wx' })
    return { ok: true }
  }
  async writeFileExplorerFileBase64Chunk(
    worktreeSelector: string,
    relativePath: string,
    contentBase64: string,
    append: boolean,
    expectedSshConnectionGeneration?: number,
    expectedSshTargetId?: string,
    expectedExecutionHostId?: string
  ): Promise<{ ok: true }> {
    const target = await this.resolveFileExplorerPath(worktreeSelector, relativePath)
    assertRuntimeFileMutationExpectation(
      target.connectionId,
      expectedExecutionHostId,
      expectedSshTargetId,
      expectedSshConnectionGeneration
    )
    const provider = target.connectionId ? getSshFilesystemProvider(target.connectionId) : null
    const content = Buffer.from(contentBase64, 'base64')
    if (target.connectionId) {
      if (!provider) {
        throw new Error(SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE)
      }
      await provider.writeFileBase64Chunk(target.path, contentBase64, append)
      return { ok: true }
    }

    const filePath = await resolveAuthorizedPath(target.path, this.host.requireStore())
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, content, { flag: append ? 'a' : 'wx' })
    return { ok: true }
  }
  async createFileExplorerFile(
    worktreeSelector: string,
    relativePath: string,
    expectedSshConnectionGeneration?: number,
    expectedSshTargetId?: string,
    expectedExecutionHostId?: string
  ): Promise<{ ok: true }> {
    const target = await this.resolveFileExplorerPath(worktreeSelector, relativePath)
    assertRuntimeFileMutationExpectation(
      target.connectionId,
      expectedExecutionHostId,
      expectedSshTargetId,
      expectedSshConnectionGeneration
    )
    const provider = target.connectionId ? getSshFilesystemProvider(target.connectionId) : null
    if (target.connectionId) {
      if (!provider) {
        throw new Error(SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE)
      }
      await provider.createFile(target.path)
      return { ok: true }
    }

    const filePath = await resolveAuthorizedPath(target.path, this.host.requireStore())
    await mkdir(dirname(filePath), { recursive: true })
    try {
      await writeFile(filePath, '', { encoding: 'utf-8', flag: 'wx' })
    } catch (error) {
      rethrowRuntimeFileCreateError(error, filePath)
    }
    return { ok: true }
  }
  async createFileExplorerDir(
    worktreeSelector: string,
    relativePath: string,
    expectedSshConnectionGeneration?: number,
    expectedSshTargetId?: string,
    expectedExecutionHostId?: string
  ): Promise<{ ok: true }> {
    const target = await this.resolveFileExplorerPath(worktreeSelector, relativePath)
    assertRuntimeFileMutationExpectation(
      target.connectionId,
      expectedExecutionHostId,
      expectedSshTargetId,
      expectedSshConnectionGeneration
    )
    const provider = target.connectionId ? getSshFilesystemProvider(target.connectionId) : null
    if (target.connectionId) {
      if (!provider) {
        throw new Error(SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE)
      }
      await provider.createDir(target.path)
      return { ok: true }
    }

    const dirPath = await resolveAuthorizedPath(target.path, this.host.requireStore())
    await assertRuntimePathDoesNotExist(dirPath)
    await mkdir(dirPath, { recursive: false })
    return { ok: true }
  }
  async createFileExplorerDirNoClobber(
    worktreeSelector: string,
    relativePath: string,
    expectedSshConnectionGeneration?: number,
    expectedSshTargetId?: string,
    expectedExecutionHostId?: string
  ): Promise<{ ok: true }> {
    const target = await this.resolveFileExplorerPath(worktreeSelector, relativePath)
    assertRuntimeFileMutationExpectation(
      target.connectionId,
      expectedExecutionHostId,
      expectedSshTargetId,
      expectedSshConnectionGeneration
    )
    const provider = target.connectionId ? getSshFilesystemProvider(target.connectionId) : null
    if (target.connectionId) {
      if (!provider) {
        throw new Error(SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE)
      }
      await provider.createDirNoClobber(target.path)
      return { ok: true }
    }

    const dirPath = await resolveAuthorizedPath(target.path, this.host.requireStore())
    await mkdir(dirPath, { recursive: false })
    return { ok: true }
  }
  async commitFileExplorerUpload(
    worktreeSelector: string,
    tempRelativePath: string,
    finalRelativePath: string,
    expectedSshConnectionGeneration?: number,
    expectedSshTargetId?: string,
    expectedExecutionHostId?: string
  ): Promise<{ ok: true }> {
    const [tempTarget, finalTarget] = await this.resolveFileExplorerPaths(worktreeSelector, [
      tempRelativePath,
      finalRelativePath
    ])
    assertRuntimeFileMutationExpectation(
      tempTarget.connectionId,
      expectedExecutionHostId,
      expectedSshTargetId,
      expectedSshConnectionGeneration
    )
    const provider = tempTarget.connectionId
      ? getSshFilesystemProvider(tempTarget.connectionId)
      : null
    if (tempTarget.connectionId) {
      if (!provider) {
        throw new Error(SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE)
      }
      await provider.copy(tempTarget.path, finalTarget.path)
      await provider.deletePath(tempTarget.path, false).catch(() => {})
      return { ok: true }
    }

    const store = this.host.requireStore()
    const tempPath = await resolveAuthorizedPath(tempTarget.path, store)
    const finalPath = await resolveAuthorizedPath(finalTarget.path, store)
    await mkdir(dirname(finalPath), { recursive: true })
    await copyFile(tempPath, finalPath, constants.COPYFILE_EXCL)
    await rm(tempPath, { force: true })
    return { ok: true }
  }
  async renameFileExplorerPath(
    worktreeSelector: string,
    oldRelativePath: string,
    newRelativePath: string,
    expectedSshConnectionGeneration?: number,
    expectedSshTargetId?: string,
    expectedExecutionHostId?: string
  ): Promise<{ ok: true }> {
    const [oldTarget, newTarget] = await this.resolveFileExplorerPaths(worktreeSelector, [
      oldRelativePath,
      newRelativePath
    ])
    assertRuntimeFileMutationExpectation(
      oldTarget.connectionId,
      expectedExecutionHostId,
      expectedSshTargetId,
      expectedSshConnectionGeneration
    )
    const provider = oldTarget.connectionId
      ? getSshFilesystemProvider(oldTarget.connectionId)
      : null
    if (oldTarget.connectionId) {
      if (!provider) {
        throw new Error(SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE)
      }
      await provider.renameNoClobber(oldTarget.path, newTarget.path)
      return { ok: true }
    }

    const store = this.host.requireStore()
    const oldPath = await resolveAuthorizedPath(oldTarget.path, store, { preserveSymlink: true })
    const newPath = await resolveAuthorizedPath(newTarget.path, store, { preserveSymlink: true })
    await renameLocalPathSerializedByDestination(oldPath, newPath)
    return { ok: true }
  }
  async copyFileExplorerPath(
    worktreeSelector: string,
    sourceRelativePath: string,
    destinationRelativePath: string,
    expectedSshConnectionGeneration?: number,
    expectedSshTargetId?: string,
    expectedExecutionHostId?: string
  ): Promise<{ ok: true }> {
    const [sourceTarget, destinationTarget] = await this.resolveFileExplorerPaths(
      worktreeSelector,
      [sourceRelativePath, destinationRelativePath]
    )
    assertRuntimeFileMutationExpectation(
      sourceTarget.connectionId,
      expectedExecutionHostId,
      expectedSshTargetId,
      expectedSshConnectionGeneration
    )
    const provider = sourceTarget.connectionId
      ? getSshFilesystemProvider(sourceTarget.connectionId)
      : null
    if (sourceTarget.connectionId) {
      if (!provider) {
        throw new Error(SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE)
      }
      await provider.copy(sourceTarget.path, destinationTarget.path)
      return { ok: true }
    }

    const store = this.host.requireStore()
    const sourcePath = await resolveAuthorizedPath(sourceTarget.path, store, {
      preserveSymlink: true
    })
    const destinationPath = await resolveAuthorizedPath(destinationTarget.path, store, {
      preserveSymlink: true
    })
    await mkdir(dirname(destinationPath), { recursive: true })
    // Why: COPYFILE_EXCL preserves the no-clobber invariant of the local shell copy IPC (caller already deconflicts names).
    await copyFile(sourcePath, destinationPath, constants.COPYFILE_EXCL)
    return { ok: true }
  }
  async deleteFileExplorerPath(
    worktreeSelector: string,
    relativePath: string,
    recursive?: boolean,
    expectedSshConnectionGeneration?: number,
    expectedSshTargetId?: string,
    expectedExecutionHostId?: string
  ): Promise<{ ok: true }> {
    const target = await this.resolveFileExplorerPath(worktreeSelector, relativePath)
    assertRuntimeFileMutationExpectation(
      target.connectionId,
      expectedExecutionHostId,
      expectedSshTargetId,
      expectedSshConnectionGeneration
    )
    const provider = target.connectionId ? getSshFilesystemProvider(target.connectionId) : null
    if (target.connectionId) {
      if (!provider) {
        throw new Error(SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE)
      }
      await provider.deletePath(target.path, recursive)
      return { ok: true }
    }

    const targetPath = await resolveAuthorizedPath(target.path, this.host.requireStore(), {
      preserveSymlink: true
    })
    // Why: a non-local runtime has no client Trash; this delete is permanent, so the renderer confirms before calling.
    await rm(targetPath, { recursive: recursive === true, force: true })
    return { ok: true }
  }
}

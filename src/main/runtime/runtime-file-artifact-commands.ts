import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { chmod, constants, rename, rm, writeFile } from 'node:fs/promises'
import type { FileStat, IFilesystemProvider } from '../providers/types'
import type {
  RuntimeFilePreviewResult,
  RuntimeFileReadResult
} from '../../shared/runtime-types'
import {
  getSshFilesystemProvider,
  SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE
} from '../providers/ssh-filesystem-dispatch'
import {
  MOBILE_FILE_READ_MAX_BYTES,
  LOCAL_PREVIEWABLE_BINARY_MAX_BYTES,
  previewableBinaryByteLimit,
  assertPreviewWithinTransportBudget,
  isMobileBinaryPath,
  truncateMobileFilePreview,
  isBinaryBuffer,
  readFileHandleBufferBounded,
  terminalFileStatIdentity,
  assertTerminalFileGrantFresh,
  readLocalTerminalArtifactFileFromHandle,
  readLocalTerminalArtifactPreviewFromHandle,
  openLocalTerminalArtifactGrant,
  type TerminalFileGrant,
  type RuntimeFileCommandHost
} from './runtime-file-shared'
import type { RuntimeFileTerminalPathCommands } from './runtime-file-terminal-path-commands'

export class RuntimeFileArtifactCommands {
  constructor(
    private readonly host: RuntimeFileCommandHost,
    private readonly terminal: RuntimeFileTerminalPathCommands
  ) {}

  async readTerminalArtifactFile(
    worktreeSelector: string,
    grantId: string,
    absolutePath: string,
    clientId?: string
  ): Promise<RuntimeFileReadResult> {
    const { grant, target } = await this.terminal.requireTerminalFileGrant(
      worktreeSelector,
      grantId,
      absolutePath,
      clientId
    )
    if (isMobileBinaryPath(grant.absolutePath)) {
      throw new Error('binary_file')
    }
    let content: string
    if (grant.connectionId) {
      const provider = await this.assertRemoteTerminalFileGrantFreshForRead(grant)
      content = await this.readRemoteTerminalArtifactFile(
        provider,
        grant,
        MOBILE_FILE_READ_MAX_BYTES
      )
    } else {
      const handle = await openLocalTerminalArtifactGrant(grant, constants.O_RDONLY)
      try {
        content = await readLocalTerminalArtifactFileFromHandle(handle, grant)
      } finally {
        await handle.close()
      }
    }
    this.terminal.refreshTerminalFileGrant(grant)
    const truncated = truncateMobileFilePreview(content)

    return {
      worktree: target.worktree.id,
      relativePath: grant.absolutePath,
      content: truncated.content,
      truncated: truncated.truncated,
      byteLength: truncated.byteLength
    }
  }

  async readTerminalArtifactPreview(
    worktreeSelector: string,
    grantId: string,
    absolutePath: string,
    clientId?: string,
    maxContentBytes?: number
  ): Promise<RuntimeFilePreviewResult> {
    const { grant } = await this.terminal.requireTerminalFileGrant(
      worktreeSelector,
      grantId,
      absolutePath,
      clientId
    )
    if (grant.connectionId) {
      const provider = await this.assertRemoteTerminalFileGrantFreshForRead(grant)
      this.terminal.refreshTerminalFileGrant(grant)
      return assertPreviewWithinTransportBudget(
        await this.readRemoteTerminalArtifactPreview(provider, grant, maxContentBytes),
        maxContentBytes
      )
    }
    const handle = await openLocalTerminalArtifactGrant(grant, constants.O_RDONLY)
    try {
      const preview = await readLocalTerminalArtifactPreviewFromHandle(
        handle,
        grant,
        maxContentBytes
      )
      this.terminal.refreshTerminalFileGrant(grant)
      return assertPreviewWithinTransportBudget(preview, maxContentBytes)
    } finally {
      await handle.close()
    }
  }

  async writeTerminalArtifactFile(
    worktreeSelector: string,
    grantId: string,
    absolutePath: string,
    content: string,
    clientId?: string
  ): Promise<{ ok: true }> {
    if (Buffer.byteLength(content, 'utf8') > MOBILE_FILE_READ_MAX_BYTES) {
      throw new Error('file_too_large')
    }
    const { grant } = await this.terminal.requireTerminalFileGrant(
      worktreeSelector,
      grantId,
      absolutePath,
      clientId
    )
    if (grant.readOnly) {
      throw new Error('terminal_file_grant_read_only')
    }
    if (isMobileBinaryPath(grant.absolutePath)) {
      throw new Error('binary_file')
    }
    if (grant.connectionId) {
      const { provider, fileStat } = await this.assertRemoteTerminalFileGrantFresh(grant)
      if (fileStat.type === 'directory') {
        throw new Error('Cannot write to a directory')
      }
      if (fileStat.size > MOBILE_FILE_READ_MAX_BYTES) {
        throw new Error('file_too_large')
      }
      if (!provider.writeTerminalArtifact) {
        throw new Error('terminal_file_grant_unavailable')
      }
      const nextStat = await provider.writeTerminalArtifact(
        grant.absolutePath,
        content,
        this.terminalArtifactAccessOptions(grant, MOBILE_FILE_READ_MAX_BYTES)
      )
      grant.statIdentity = terminalFileStatIdentity(nextStat)
      this.terminal.refreshTerminalFileGrant(grant)
      return { ok: true }
    }

    let originalMode: number | null = null
    const handle = await openLocalTerminalArtifactGrant(grant, constants.O_RDONLY)
    try {
      const fileStats = await handle.stat()
      originalMode = fileStats.mode
      if (fileStats.isDirectory()) {
        throw new Error('Cannot write to a directory')
      }
      if (fileStats.size > MOBILE_FILE_READ_MAX_BYTES) {
        throw new Error('file_too_large')
      }
      assertTerminalFileGrantFresh(grant, fileStats)
      if (
        isBinaryBuffer(await readFileHandleBufferBounded(handle, MOBILE_FILE_READ_MAX_BYTES + 1))
      ) {
        throw new Error('binary_file')
      }
    } finally {
      await handle.close()
    }
    const tempPath = join(
      dirname(grant.absolutePath),
      `.${basename(grant.absolutePath)}.${randomUUID()}.tmp`
    )
    try {
      await writeFile(tempPath, content, { encoding: 'utf-8', flag: 'wx' })
      if (typeof originalMode === 'number') {
        await chmod(tempPath, originalMode & 0o7777)
      }
      const freshHandle = await openLocalTerminalArtifactGrant(grant, constants.O_RDONLY)
      try {
        assertTerminalFileGrantFresh(grant, await freshHandle.stat())
      } finally {
        await freshHandle.close()
      }
      await rename(tempPath, grant.absolutePath)
      grant.statIdentity = terminalFileStatIdentity(
        await this.terminal.statLocalTerminalPath(grant.absolutePath)
      )
      this.terminal.refreshTerminalFileGrant(grant)
      return { ok: true }
    } finally {
      await rm(tempPath, { force: true }).catch(() => {})
    }
  }

  async readRemoteTerminalArtifactPreview(
    provider: IFilesystemProvider,
    grant: TerminalFileGrant,
    maxContentBytes: number | undefined
  ): Promise<RuntimeFilePreviewResult> {
    const binaryMaxBytes =
      maxContentBytes === undefined
        ? LOCAL_PREVIEWABLE_BINARY_MAX_BYTES
        : previewableBinaryByteLimit(maxContentBytes)
    const preview = await this.readRemoteTerminalArtifact(provider, grant, binaryMaxBytes)
    if (
      !preview.isBinary &&
      Buffer.byteLength(preview.content, 'utf8') > MOBILE_FILE_READ_MAX_BYTES
    ) {
      throw new Error('file_too_large')
    }
    if (
      preview.isBinary &&
      maxContentBytes !== undefined &&
      Buffer.byteLength(preview.content, 'utf8') > maxContentBytes
    ) {
      throw new Error('file_too_large')
    }
    return preview
  }

  async readRemoteTerminalArtifactFile(
    provider: IFilesystemProvider,
    grant: TerminalFileGrant,
    maxBytes: number
  ): Promise<string> {
    const result = await this.readRemoteTerminalArtifact(provider, grant, maxBytes)
    if (result.isBinary) {
      throw new Error('binary_file')
    }
    return result.content
  }

  async readRemoteTerminalArtifact(
    provider: IFilesystemProvider,
    grant: TerminalFileGrant,
    maxBytes: number
  ): Promise<RuntimeFilePreviewResult> {
    if (!provider.readTerminalArtifact) {
      throw new Error('terminal_file_grant_unavailable')
    }
    return provider.readTerminalArtifact(
      grant.absolutePath,
      this.terminalArtifactAccessOptions(grant, maxBytes)
    )
  }

  terminalArtifactAccessOptions(
    grant: TerminalFileGrant,
    maxBytes: number
  ): { expectedRealPath: string; expectedStatIdentity: string | null; maxBytes: number } {
    return {
      expectedRealPath: grant.absolutePath,
      expectedStatIdentity: grant.statIdentity,
      maxBytes
    }
  }

  async assertRemoteTerminalFileGrantFreshForRead(
    grant: TerminalFileGrant
  ): Promise<IFilesystemProvider> {
    const { provider } = await this.assertRemoteTerminalFileGrantFresh(grant)
    return provider
  }

  async assertRemoteTerminalFileGrantFresh(
    grant: TerminalFileGrant
  ): Promise<{ provider: IFilesystemProvider; fileStat: FileStat }> {
    const provider = await this.assertRemoteTerminalFileGrantPathStillCanonical(grant)
    const fileStat = await provider.stat(grant.absolutePath)
    assertTerminalFileGrantFresh(grant, fileStat)
    return { provider, fileStat }
  }

  async assertRemoteTerminalFileGrantPathStillCanonical(
    grant: TerminalFileGrant
  ): Promise<IFilesystemProvider> {
    if (!grant.connectionId) {
      throw new Error('terminal_file_grant_mismatch')
    }
    const provider = getSshFilesystemProvider(grant.connectionId)
    if (!provider) {
      throw new Error(SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE)
    }
    const canonicalPath =
      grant.provenance === 'native-chat'
        ? await provider.realpath(grant.absolutePath)
        : await this.terminal.resolveAllowedRemoteTerminalArtifactPath(
            grant.absolutePath,
            grant.connectionId
          )
    // Why: relay I/O follows symlinks, so re-canonicalize after the remote process can mutate the path.
    if (canonicalPath !== grant.absolutePath) {
      throw new Error('terminal_file_grant_stale')
    }
    return provider
  }
}

import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { stat } from 'node:fs/promises'
import { isPathInsideOrEqual, relativePathInsideRoot, resolveRuntimePath } from '../../shared/cross-platform-path'
import type {
  RuntimeNativeChatFileContext,
  RuntimeTerminalPathResolution
} from '../../shared/runtime-types'
import { parseWslPath } from '../wsl'
import { resolveAuthorizedPath } from '../ipc/filesystem-auth'
import { isENOENT } from '../ipc/filesystem-path-containment'
import {
  getSshFilesystemProvider,
  SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE
} from '../providers/ssh-filesystem-dispatch'
import { getRuntimeFileTargetExecutionHostId } from './runtime-file-shared'
import type {
  RuntimeFileCommandHost,
  RuntimeFileStatLike,
  TerminalFileGrant
} from './runtime-file-shared'
import { isSafeMobileRelativePath } from './runtime-file-shared'
import { TERMINAL_FILE_GRANT_TTL_MS } from './runtime-file-shared'
import {
  resolveTerminalAbsolutePath,
  provenancePathCandidate,
  resolveAllowedLocalTerminalArtifactPath,
  assertLocalTerminalArtifactPathStillCanonical,
  canonicalPathForArtifactComparison,
  terminalFileStatIdentity,
  isTerminalArtifactHardLinked,
  assertTerminalArtifactNotHardLinked
} from './runtime-file-shared'
import type { RuntimeTerminalFileGrantStore } from './runtime-terminal-file-grant-store'

export class RuntimeFileTerminalPathCommands {
  constructor(
    private readonly host: RuntimeFileCommandHost,
    private readonly grantStore: RuntimeTerminalFileGrantStore
  ) {}

  private get terminalFileGrants(): Map<string, TerminalFileGrant> {
    return this.grantStore.grants
  }

  async resolveTerminalPath(
    worktreeSelector: string,
    pathText: string,
    cwd?: string | null,
    clientId?: string,
    terminalHandle?: string | null,
    crossWorkspace?: boolean,
    nativeChatContext?: RuntimeNativeChatFileContext | null
  ): Promise<RuntimeTerminalPathResolution> {
    const store = this.host.requireStore()
    const target = await this.host.resolveRuntimeFileTarget(worktreeSelector)
    const { worktree, connectionId } = target
    // Why: mobile may attach after OSC7 cwd was emitted; the runtime still owns the terminal's latest cwd to resolve the tap.
    const normalizedTerminalHandle =
      terminalHandle && terminalHandle.trim().length > 0 ? terminalHandle.trim() : null
    const terminalCwd = normalizedTerminalHandle
      ? await this.host.resolveTerminalCwd?.(normalizedTerminalHandle)
      : null
    const terminalFileUriHostname = normalizedTerminalHandle
      ? await this.host.resolveTerminalFileUriHostname?.(normalizedTerminalHandle)
      : null
    const base = terminalCwd || (cwd && cwd.trim().length > 0 ? cwd : worktree.path)

    const empty: RuntimeTerminalPathResolution = {
      worktree: worktree.id,
      relativePath: null,
      absolutePath: null,
      exists: false,
      isDirectory: false
    }

    // Why: SSH/WSL homes are unknown here; native-chat grants must not expand their ~/… paths against the local host home.
    const isTilde = pathText.startsWith('~/') || pathText.startsWith('~\\')
    if (isTilde && (connectionId || (nativeChatContext && parseWslPath(worktree.path)))) {
      return empty
    }
    const expanded = isTilde ? resolveRuntimePath(homedir(), pathText.slice(2)) : pathText
    const absolutePath = resolveTerminalAbsolutePath({
      base,
      expanded,
      worktreePath: worktree.path,
      connectionId,
      terminalFileUriHostname
    })
    const relativePath = relativePathInsideRoot(worktree.path, absolutePath)
    // Why: clients that predate crossWorkspace reuse their own worktree id for the
    // follow-up files.open, so retargeting to a sibling workspace must be opt-in.
    const knownWorkspaceTarget =
      crossWorkspace && relativePath === null
        ? await this.host.resolveKnownWorkspaceFileTarget?.(
            absolutePath,
            getRuntimeFileTargetExecutionHostId(target)
          )
        : null
    const ownedWorktree = knownWorkspaceTarget?.worktree ?? worktree
    const ownedConnectionId = knownWorkspaceTarget?.connectionId ?? connectionId
    const ownedRelativePath = knownWorkspaceTarget?.relativePath ?? relativePath

    try {
      if (
        ownedRelativePath !== null &&
        (ownedRelativePath === '' || isSafeMobileRelativePath(ownedRelativePath))
      ) {
        const stats = ownedConnectionId
          ? await this.statRemoteTerminalPath(absolutePath, ownedConnectionId)
          : await stat(await resolveAuthorizedPath(absolutePath, store))
        return {
          worktree: ownedWorktree.id,
          relativePath: ownedRelativePath,
          absolutePath,
          exists: true,
          isDirectory: stats.isDirectory(),
          openTarget: stats.isDirectory()
            ? undefined
            : {
                kind: 'worktree-file',
                provider: ownedConnectionId ? 'ssh' : 'local',
                relativePath: ownedRelativePath,
                absolutePath
              }
        }
      }

      if (
        nativeChatContext &&
        (await this.host.hasRecentNativeChatOutputPath?.(
          worktree.id,
          nativeChatContext,
          pathText,
          absolutePath
        ))
      ) {
        const artifactPath = await this.resolveNativeChatArtifactPath(absolutePath, connectionId)
        return await this.resolveAbsoluteFileGrant({
          worktreeId: worktree.id,
          artifactPath,
          connectionId,
          clientId,
          readOnly: true,
          provenance: 'native-chat'
        })
      }

      // Why: mobile taps may hit agent artifacts outside the worktree; grant the exact path, not arbitrary absolute paths.
      if (!normalizedTerminalHandle || !terminalCwd) {
        return { ...empty, relativePath, absolutePath }
      }
      const terminalContext = this.host.resolveTerminalContext?.(normalizedTerminalHandle)
      if (
        !terminalContext ||
        terminalContext.worktreeId !== worktree.id ||
        (terminalContext.connectionId ?? undefined) !== connectionId
      ) {
        return { ...empty, relativePath, absolutePath }
      }
      const artifactPath = await this.resolveAllowedTerminalArtifactPath({
        absolutePath,
        connectionId,
        worktreePath: worktree.path
      })
      if (!artifactPath) {
        return { ...empty, relativePath, absolutePath }
      }
      if (
        !(await this.host.hasRecentTerminalOutputPath?.(
          normalizedTerminalHandle,
          provenancePathCandidate(pathText, absolutePath),
          artifactPath
        ))
      ) {
        return { ...empty, relativePath, absolutePath }
      }
      return await this.resolveAbsoluteFileGrant({
        worktreeId: worktree.id,
        artifactPath,
        rejectedAbsolutePath: absolutePath,
        connectionId,
        clientId
      })
    } catch (error) {
      // Report genuine not-found as missing; let transport/permission errors surface so remote taps aren't all reported missing.
      if (
        isENOENT(error) ||
        (ownedConnectionId && RuntimeFileTerminalPathCommands.isRemoteNotFoundErrorMessage(error))
      ) {
        return {
          ...empty,
          worktree: ownedWorktree.id,
          relativePath: ownedRelativePath,
          absolutePath
        }
      }
      throw error
    }
  }

  // The mux drops ErrnoException.code, so match not-found by message shape (vs transport/permission/provider errors).
  static isRemoteNotFoundErrorMessage(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error)
    return /\bENOENT\b|no such file|not found|does not exist/i.test(message)
  }

  async statRemoteTerminalPath(
    absolutePath: string,
    connectionId: string
  ): Promise<RuntimeFileStatLike & { isDirectory: () => boolean }> {
    const provider = getSshFilesystemProvider(connectionId)
    if (!provider) {
      throw new Error(SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE)
    }
    const stats = await provider.stat(absolutePath)
    return { ...stats, isDirectory: () => stats.type === 'directory' }
  }

  async resolveAllowedTerminalArtifactPath(args: {
    absolutePath: string
    connectionId?: string
    worktreePath: string
  }): Promise<string | null> {
    if (args.connectionId) {
      return this.resolveAllowedRemoteTerminalArtifactPath(args.absolutePath, args.connectionId)
    }
    return resolveAllowedLocalTerminalArtifactPath(args.absolutePath, args.worktreePath)
  }

  async resolveNativeChatArtifactPath(
    absolutePath: string,
    connectionId?: string
  ): Promise<string> {
    if (!connectionId) {
      return canonicalPathForArtifactComparison(absolutePath)
    }
    const provider = getSshFilesystemProvider(connectionId)
    if (!provider) {
      throw new Error(SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE)
    }
    return provider.realpath(absolutePath)
  }

  async resolveAbsoluteFileGrant(args: {
    worktreeId: string
    artifactPath: string
    rejectedAbsolutePath?: string
    connectionId?: string
    clientId?: string
    readOnly?: boolean
    provenance?: TerminalFileGrant['provenance']
  }): Promise<RuntimeTerminalPathResolution> {
    const stats = args.connectionId
      ? await this.statRemoteTerminalPath(args.artifactPath, args.connectionId)
      : await this.statLocalTerminalPath(args.artifactPath)
    const isDirectory = stats.isDirectory()
    if (!isDirectory && isTerminalArtifactHardLinked(stats)) {
      return {
        worktree: args.worktreeId,
        relativePath: null,
        absolutePath: args.rejectedAbsolutePath ?? args.artifactPath,
        exists: false,
        isDirectory: false
      }
    }
    const grant = isDirectory
      ? null
      : this.createTerminalFileGrant({
          worktreeId: args.worktreeId,
          absolutePath: args.artifactPath,
          provider: args.connectionId ? 'ssh' : 'local',
          connectionId: args.connectionId,
          clientId: args.clientId,
          readOnly: args.readOnly === true,
          provenance: args.provenance ?? 'terminal-output',
          stats
        })
    return {
      worktree: args.worktreeId,
      relativePath: null,
      absolutePath: args.artifactPath,
      exists: true,
      isDirectory,
      openTarget: grant
        ? {
            kind: 'absolute-file',
            provider: grant.provider,
            absolutePath: args.artifactPath,
            grantId: grant.id,
            ...(grant.readOnly ? { readOnly: true } : {})
          }
        : undefined
    }
  }

  async resolveAllowedRemoteTerminalArtifactPath(
    absolutePath: string,
    connectionId: string
  ): Promise<string | null> {
    const provider = getSshFilesystemProvider(connectionId)
    if (!provider) {
      throw new Error(SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE)
    }
    const roots = ['/tmp', '/private/tmp']
    const providerTempDir = await provider.getTempDir?.().catch(() => null)
    if (providerTempDir) {
      roots.push(providerTempDir)
    }
    if (!roots.some((root) => isPathInsideOrEqual(root, absolutePath))) {
      return null
    }
    const [realArtifactPath, ...realRoots] = await Promise.all([
      provider.realpath(absolutePath),
      ...roots.map((root) => provider.realpath(root).catch(() => root))
    ])
    // Why: SSH I/O follows symlinks on the relay; grant the canonical target so a /tmp link can't escape the temp boundary.
    return realRoots.some((root) => isPathInsideOrEqual(root, realArtifactPath))
      ? realArtifactPath
      : null
  }

  async statLocalTerminalPath(
    absolutePath: string
  ): Promise<RuntimeFileStatLike & { isDirectory: () => boolean }> {
    await assertLocalTerminalArtifactPathStillCanonical(absolutePath)
    const handle = await open(absolutePath, 'r')
    try {
      return handle.stat()
    } finally {
      await handle.close()
    }
  }

  createTerminalFileGrant(args: {
    worktreeId: string
    absolutePath: string
    provider: 'local' | 'ssh'
    connectionId?: string
    clientId?: string
    readOnly?: boolean
    provenance: TerminalFileGrant['provenance']
    stats: RuntimeFileStatLike
  }): TerminalFileGrant {
    assertTerminalArtifactNotHardLinked(args.stats)
    const grant: TerminalFileGrant = {
      id: randomUUID(),
      worktreeId: args.worktreeId,
      absolutePath: args.absolutePath,
      provider: args.provider,
      ...(args.connectionId ? { connectionId: args.connectionId } : {}),
      ...(args.clientId ? { clientId: args.clientId } : {}),
      expiresAt: Date.now() + TERMINAL_FILE_GRANT_TTL_MS,
      statIdentity: terminalFileStatIdentity(args.stats),
      readOnly: args.readOnly === true,
      provenance: args.provenance
    }
    this.terminalFileGrants.set(grant.id, grant)
    this.scheduleTerminalFileGrantExpiry(grant)
    return grant
  }

  async requireTerminalFileGrant(
    worktreeSelector: string,
    grantId: string,
    absolutePath: string,
    clientId?: string
  ): Promise<{ grant: TerminalFileGrant; target: ResolvedRuntimeFileTarget }> {
    const target = await this.host.resolveRuntimeFileTarget(worktreeSelector)
    this.pruneExpiredTerminalFileGrants()
    const grant = this.terminalFileGrants.get(grantId)
    if (!grant) {
      throw new Error('terminal_file_grant_expired')
    }
    if (grant.expiresAt <= Date.now()) {
      this.releaseTerminalFileGrant(grantId, grant)
      throw new Error('terminal_file_grant_expired')
    }
    if (
      grant.worktreeId !== target.worktree.id ||
      grant.absolutePath !== absolutePath ||
      grant.connectionId !== target.connectionId ||
      grant.clientId !== clientId
    ) {
      throw new Error('terminal_file_grant_mismatch')
    }
    return { grant, target }
  }

  refreshTerminalFileGrant(grant: TerminalFileGrant): void {
    grant.expiresAt = Date.now() + TERMINAL_FILE_GRANT_TTL_MS
    this.scheduleTerminalFileGrantExpiry(grant)
  }

  pruneExpiredTerminalFileGrants(): void {
    const now = Date.now()
    for (const [id, grant] of this.terminalFileGrants) {
      if (grant.expiresAt <= now) {
        this.releaseTerminalFileGrant(id, grant)
      }
    }
  }

  revokeTerminalFileGrantsForClient(clientId: string): void {
    for (const [id, grant] of this.terminalFileGrants) {
      if (grant.clientId === clientId) {
        this.releaseTerminalFileGrant(id, grant)
      }
    }
  }

  releaseTerminalFileGrant(id: string, grant: TerminalFileGrant): void {
    this.terminalFileGrants.delete(id)
    if (grant.expiryTimer) {
      clearTimeout(grant.expiryTimer)
      grant.expiryTimer = undefined
    }
  }

  scheduleTerminalFileGrantExpiry(grant: TerminalFileGrant): void {
    if (grant.expiryTimer) {
      clearTimeout(grant.expiryTimer)
    }
    grant.expiryTimer = setTimeout(
      () => {
        if (this.terminalFileGrants.get(grant.id) === grant && grant.expiresAt <= Date.now()) {
          this.releaseTerminalFileGrant(grant.id, grant)
        }
      },
      Math.max(1, grant.expiresAt - Date.now())
    )
    grant.expiryTimer.unref?.()
  }
}

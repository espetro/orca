import type { AbortSignal } from 'node:abort-controller'
import type { RuntimeFileListResult, RuntimeFileOpenResult, RuntimeFileReadResult } from '../../shared/runtime-types'
import type { RuntimeFileCommandHost } from './runtime-file-shared'
import {
  MOBILE_FILE_LIST_LIMIT,
  MOBILE_FILE_PATH_SEARCH_CACHE_LIMIT,
  MOBILE_FILE_READ_MAX_BYTES,
  QUICK_OPEN_LEGACY_REMOTE_RESULT_LIMIT,
  isSafeMobileRelativePath,
  isMobileBinaryPath,
  isMobileMarkdownPath,
  isMobilePreviewableImagePath,
  basenameFromRelativePath,
  truncateMobileFilePreview,
  readLocalMobileFile
} from './runtime-file-shared'
import { rankRuntimeMobileFilePaths } from './runtime-mobile-file-path-search'
import type { RuntimeMobileFilePathSearchCache } from './runtime-mobile-file-path-search'
import { listQuickOpenFiles } from '../ipc/filesystem-list-files'
import { searchQuickOpenFilePaths as searchHostQuickOpenFilePaths } from '../ipc/filesystem-search-file-paths'
import { isQuickOpenQueryTooLarge, QuickOpenPathRanker } from '../../shared/quick-open-path-search'
import { getSshFilesystemProvider, SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE } from '../providers/ssh-filesystem-dispatch'
import { joinWorktreeRelativePath } from './runtime-relative-paths'
import type { RuntimeFileTerminalPathCommands } from './runtime-file-terminal-path-commands'

export class RuntimeFileMobileCommands {
  constructor(
    private readonly host: RuntimeFileCommandHost,
    private readonly terminal: RuntimeFileTerminalPathCommands,
    private readonly mobileFilePathSearchCache: RuntimeMobileFilePathSearchCache
  ) {}

  async listMobileFiles(
    worktreeSelector: string,
    options: { signal?: AbortSignal } = {}
  ): Promise<RuntimeFileListResult> {
    const store = this.host.requireStore()
    const target = await this.host.resolveRuntimeFileTarget(worktreeSelector)
    const { worktree, connectionId } = target
    const files = connectionId
      ? await this.listRemoteMobileFiles(worktree.path, connectionId, undefined, options.signal)
      : await listQuickOpenFiles(worktree.path, store, undefined, options.signal)
    const entries = files
      .filter((relativePath) => isSafeMobileRelativePath(relativePath))
      .sort((a, b) => a.localeCompare(b))
      .slice(0, MOBILE_FILE_LIST_LIMIT)
      .map((relativePath) => ({
        relativePath,
        basename: basenameFromRelativePath(relativePath),
        kind: isMobileBinaryPath(relativePath) ? ('binary' as const) : ('text' as const)
      }))

    return {
      worktree: worktree.id,
      rootPath: worktree.path,
      files: entries,
      totalCount: files.length,
      truncated: files.length > MOBILE_FILE_LIST_LIMIT
    }
  }
  async searchMobileFilePaths(
    worktreeSelector: string,
    query: string,
    limit: number
  ): Promise<RuntimeFileListResult> {
    const store = this.host.requireStore()
    const target = await this.host.resolveRuntimeFileTarget(worktreeSelector)
    const { worktree, connectionId } = target
    const cacheKey = `${connectionId ?? 'local'}:${worktree.id}:${worktree.path}`
    const inventory = await this.mobileFilePathSearchCache.get(cacheKey, async () => {
      const listed = connectionId
        ? await this.listRemoteMobileFiles(
            worktree.path,
            connectionId,
            MOBILE_FILE_PATH_SEARCH_CACHE_LIMIT + 1
          )
        : await listQuickOpenFiles(
            worktree.path,
            store,
            undefined,
            undefined,
            MOBILE_FILE_PATH_SEARCH_CACHE_LIMIT + 1
          )
      const safePaths = listed
        .filter((relativePath) => isSafeMobileRelativePath(relativePath))
        .sort((a, b) => a.localeCompare(b))
      return {
        paths: safePaths.slice(0, MOBILE_FILE_PATH_SEARCH_CACHE_LIMIT),
        totalCount: safePaths.length,
        truncated: safePaths.length > MOBILE_FILE_PATH_SEARCH_CACHE_LIMIT
      }
    })
    const matches = rankRuntimeMobileFilePaths(inventory.paths, query, limit)
    return {
      worktree: worktree.id,
      rootPath: worktree.path,
      files: matches.paths.map((relativePath) => ({
        relativePath,
        basename: basenameFromRelativePath(relativePath),
        kind: isMobileBinaryPath(relativePath) ? ('binary' as const) : ('text' as const)
      })),
      totalCount: matches.totalCount,
      truncated: inventory.truncated || matches.totalCount > limit
    }
  }
  async searchQuickOpenFilePaths(
    worktreeSelector: string,
    query: string,
    limit: number,
    excludePaths?: string[],
    signal?: AbortSignal
  ): Promise<RuntimeFileListResult> {
    const target = await this.host.resolveRuntimeFileTarget(worktreeSelector)
    const { worktree, connectionId } = target
    const result =
      !query.trim() || isQuickOpenQueryTooLarge(query)
        ? { paths: [], totalCount: 0, truncated: false }
        : connectionId
          ? await this.searchRemoteQuickOpenFilePaths(
              worktree.path,
              connectionId,
              query,
              limit,
              excludePaths,
              signal
            )
          : await searchHostQuickOpenFilePaths(worktree.path, this.host.requireStore(), {
              query,
              limit,
              excludePaths,
              signal
            })
    return {
      worktree: worktree.id,
      rootPath: worktree.path,
      files: result.paths.map((relativePath) => ({
        relativePath,
        basename: basenameFromRelativePath(relativePath),
        kind: isMobileBinaryPath(relativePath) ? ('binary' as const) : ('text' as const)
      })),
      totalCount: result.totalCount,
      truncated: result.truncated
    }
  }
  async openMobileFile(
    worktreeSelector: string,
    relativePath: string
  ): Promise<RuntimeFileOpenResult> {
    const { worktree, connectionId } = await this.host.resolveRuntimeFileTarget(worktreeSelector)
    if (!isSafeMobileRelativePath(relativePath)) {
      throw new Error('invalid_relative_path')
    }
    // Previewable images open like text (mobile renders via files.readPreview); other binaries stay unavailable on mobile.
    const kind = isMobilePreviewableImagePath(relativePath)
      ? 'image'
      : isMobileBinaryPath(relativePath)
        ? 'binary'
        : isMobileMarkdownPath(relativePath)
          ? 'markdown'
          : 'text'
    if (kind === 'binary') {
      return { worktree: worktree.id, relativePath, kind, opened: false }
    }
    const filePath = joinWorktreeRelativePath(worktree.path, relativePath)
    // Why: CLI/agents treat opened:true as success; stat first so missing paths fail the RPC instead of opening a ghost tab.
    await this.assertMobileOpenTargetExists(filePath, connectionId)
    // Why: the internal runtimeId isn't a valid env selector; pass undefined so openFile falls back to activeRuntimeEnvironmentId.
    this.host.openFile(worktree.id, filePath, relativePath, undefined)
    return { worktree: worktree.id, relativePath, kind, opened: true }
  }
  async openMobileDiff(
    worktreeSelector: string,
    relativePath: string,
    staged: boolean
  ): Promise<RuntimeFileOpenResult> {
    const { worktree } = await this.host.resolveRuntimeFileTarget(worktreeSelector)
    if (!isSafeMobileRelativePath(relativePath)) {
      throw new Error('invalid_relative_path')
    }
    const kind = isMobileBinaryPath(relativePath)
      ? 'binary'
      : isMobileMarkdownPath(relativePath)
        ? 'markdown'
        : 'text'
    const filePath = joinWorktreeRelativePath(worktree.path, relativePath)
    // Why: see openMobileFile; avoid stamping internal runtimeId as runtimeEnvironmentId.
    this.host.openDiff(worktree.id, filePath, relativePath, staged, undefined)
    return { worktree: worktree.id, relativePath, kind, opened: true }
  }
  async readMobileFile(
    worktreeSelector: string,
    relativePath: string
  ): Promise<RuntimeFileReadResult> {
    const store = this.host.requireStore()
    const target = await this.host.resolveRuntimeFileTarget(worktreeSelector)
    const { worktree, connectionId } = target
    if (!isSafeMobileRelativePath(relativePath)) {
      throw new Error('invalid_relative_path')
    }
    if (isMobileBinaryPath(relativePath)) {
      throw new Error('binary_file')
    }

    const filePath = joinWorktreeRelativePath(worktree.path, relativePath)
    const content = connectionId
      ? await this.readRemoteMobileFile(filePath, connectionId)
      : await readLocalMobileFile(filePath, store)
    const truncated = truncateMobileFilePreview(content)

    return {
      worktree: worktree.id,
      relativePath,
      content: truncated.content,
      truncated: truncated.truncated,
      byteLength: truncated.byteLength
    }
  }

  // Resolves a mobile terminal tap to a worktree-relative path; relatives resolve against cwd, else the worktree root.
  private async listRemoteMobileFiles(
    rootPath: string,
    connectionId: string,
    maxResults?: number,
    signal?: AbortSignal
  ): Promise<string[]> {
    const provider = getSshFilesystemProvider(connectionId)
    if (!provider) {
      return []
    }
    return provider.listFiles(rootPath, { maxResults, signal })
  }
  private async searchRemoteQuickOpenFilePaths(
    rootPath: string,
    connectionId: string,
    query: string,
    limit: number,
    excludePaths?: string[],
    signal?: AbortSignal
  ): Promise<{ paths: string[]; totalCount: number; truncated: boolean }> {
    const provider = getSshFilesystemProvider(connectionId)
    if (!provider) {
      return { paths: [], totalCount: 0, truncated: false }
    }
    if (!(await provider.supportsQuickOpenSearch?.({ signal }))) {
      // Old relays ignore searchQuery. Keep the compatibility request below the
      // 4 MiB frame ceiling even when legacy paths are near the 64 KiB path cap.
      const legacyFiles = await provider.listFiles(rootPath, {
        excludePaths,
        maxResults: QUICK_OPEN_LEGACY_REMOTE_RESULT_LIMIT,
        signal
      })
      const ranker = new QuickOpenPathRanker(query, limit)
      for (const file of legacyFiles) {
        ranker.consider(file)
      }
      const result = ranker.result()
      return {
        ...result,
        truncated:
          legacyFiles.length >= QUICK_OPEN_LEGACY_REMOTE_RESULT_LIMIT || result.totalCount > limit
      }
    }
    const files = await provider.listFiles(rootPath, {
      excludePaths,
      maxResults: limit + 1,
      searchQuery: query,
      signal
    })
    return {
      paths: files.slice(0, limit),
      totalCount: files.length,
      truncated: files.length > limit
    }
  }
  private async readRemoteMobileFile(filePath: string, connectionId: string): Promise<string> {
    const provider = getSshFilesystemProvider(connectionId)
    if (!provider) {
      throw new Error(SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE)
    }
    const fileStat = await provider.stat(filePath)
    // Why: no ranged reads over SSH here, so reject oversized previews instead of streaming a whole file just to trim it.
    if (fileStat.size > MOBILE_FILE_READ_MAX_BYTES) {
      throw new Error('file_too_large')
    }
    const result = await provider.readFile(filePath)
    if (result.isBinary) {
      throw new Error('binary_file')
    }
    return result.content
  }
}

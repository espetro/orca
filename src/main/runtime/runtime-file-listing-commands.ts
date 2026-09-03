import type { ChildProcess } from 'node:child_process'
import type { SearchOptions, SearchResult } from '../../shared/code-search-types'
import type { MarkdownDocument } from '../../shared/filesystem-entry-types'
import { limitQuickOpenFilesBySerializedBytes } from '../../shared/quick-open-transport-budget'
import { QUICK_OPEN_LISTING_MAX_RESULTS } from '../../shared/quick-open-listing-limits'
import { listQuickOpenFiles } from '../ipc/filesystem-list-files'
import { searchWithGitGrep } from '../ipc/filesystem-search-git'
import { getLocalGitOptionsForRegisteredWorktree } from '../ipc/local-worktree-runtime-options'
import { checkRgAvailable } from '../ipc/rg-availability'
import {
  absorbPendingRipgrepSpawnError,
  isRipgrepUnavailableExit,
  killSpawnedRipgrepProcess
} from '../../shared/ripgrep-process-availability'
import {
  listMarkdownDocuments,
  markdownDocumentsFromRelativePaths
} from '../ipc/markdown-documents'
import {
  buildRgArgs,
  createAccumulator,
  DEFAULT_SEARCH_MAX_RESULTS,
  finalize,
  ingestRgJsonLine,
  SEARCH_TIMEOUT_MS
} from '../../shared/text-search'
import { wslAwareSpawn, parseWslPath, toWindowsWslPath } from '../wsl'
import { resolveAuthorizedPath } from '../ipc/filesystem-auth'
import { getSshFilesystemProvider, SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE } from '../providers/ssh-filesystem-dispatch'
import type { RuntimeFileCommandHost } from './runtime-file-shared'
import type { RuntimeFileExplorerReadCommands } from './runtime-file-explorer-reads'

export class RuntimeFileListingCommands {
  private readonly activeRuntimeTextSearches = new Map<string, ChildProcess>()

  constructor(
    private readonly host: RuntimeFileCommandHost,
    private readonly explorer: RuntimeFileExplorerReadCommands
  ) {}

  async searchRuntimeFiles(
    worktreeSelector: string,
    options: Omit<SearchOptions, 'rootPath'>
  ): Promise<SearchResult> {
    const target = await this.host.resolveRuntimeFileTarget(worktreeSelector)
    const provider = target.connectionId ? getSshFilesystemProvider(target.connectionId) : null
    const rootPath = target.worktree.path
    const searchOptions = { ...options, rootPath }
    if (target.connectionId) {
      if (!provider) {
        throw new Error(SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE)
      }
      return provider.search(searchOptions)
    }
    return this.searchLocalRuntimeFiles(rootPath, searchOptions)
  }
  async listRuntimeFiles(
    worktreeSelector: string,
    options: {
      excludePaths?: string[]
      maxContentBytes?: number
      maxResults?: number
      signal?: AbortSignal
    } = {}
  ): Promise<string[]> {
    const target = await this.host.resolveRuntimeFileTarget(worktreeSelector)
    const provider = target.connectionId ? getSshFilesystemProvider(target.connectionId) : null
    if (target.connectionId) {
      if (!provider) {
        return []
      }
      const maxResults =
        options.maxResults ??
        (options.maxContentBytes === undefined ? undefined : QUICK_OPEN_LISTING_MAX_RESULTS)
      const files = await provider.listFiles(target.worktree.path, {
        excludePaths: options.excludePaths,
        maxResults,
        signal: options.signal
      })
      return options.maxContentBytes === undefined
        ? files
        : limitQuickOpenFilesBySerializedBytes(files, options.maxContentBytes)
    }
    return listQuickOpenFiles(
      target.worktree.path,
      this.host.requireStore(),
      options.excludePaths,
      options.signal,
      options.maxResults,
      options.maxContentBytes
    )
  }
  async listRuntimeMarkdownDocuments(worktreeSelector: string): Promise<MarkdownDocument[]> {
    const target = await this.host.resolveRuntimeFileTarget(worktreeSelector)
    const provider = target.connectionId ? getSshFilesystemProvider(target.connectionId) : null
    if (target.connectionId) {
      if (!provider) {
        throw new Error(SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE)
      }
      const relativePaths = await provider.listFiles(target.worktree.path)
      return markdownDocumentsFromRelativePaths(target.worktree.path, relativePaths)
    }
    return listMarkdownDocuments(target.worktree.path)
  }
  async statRuntimeFile(
    worktreeSelector: string,
    relativePath: string
  ): Promise<{ size: number; isDirectory: boolean; mtime: number }> {
    const target = await this.explorer.resolveFileExplorerPath(worktreeSelector, relativePath)
    const provider = target.connectionId ? getSshFilesystemProvider(target.connectionId) : null
    if (target.connectionId) {
      if (!provider) {
        throw new Error(SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE)
      }
      const fileStat = await provider.stat(target.path)
      return {
        size: fileStat.size,
        isDirectory: fileStat.type === 'directory',
        mtime: fileStat.mtime
      }
    }
    const filePath = await resolveAuthorizedPath(target.path, this.host.requireStore())
    const stats = await stat(filePath)
    return { size: stats.size, isDirectory: stats.isDirectory(), mtime: stats.mtimeMs }
  }
  private async searchLocalRuntimeFiles(
    rootPath: string,
    options: SearchOptions
  ): Promise<SearchResult> {
    const store = this.host.requireStore()
    const authorizedRootPath = await resolveAuthorizedPath(rootPath, store)
    const localGitOptions = getLocalGitOptionsForRegisteredWorktree(
      store,
      rootPath,
      authorizedRootPath
    )
    const maxResults = Math.max(
      1,
      Math.min(options.maxResults ?? DEFAULT_SEARCH_MAX_RESULTS, DEFAULT_SEARCH_MAX_RESULTS)
    )
    const wslInfo = parseWslPath(authorizedRootPath)
    if (
      (wslInfo || localGitOptions.wslDistro) &&
      !(await checkRgAvailable(authorizedRootPath, localGitOptions.wslDistro))
    ) {
      return searchWithGitGrep(authorizedRootPath, options, maxResults, localGitOptions)
    }

    return new Promise<SearchResult>((resolvePromise) => {
      const searchKey = `${this.host.getRuntimeId()}:${authorizedRootPath}`
      const rgArgs = buildRgArgs(options.query, authorizedRootPath, options)
      const previousChild = this.activeRuntimeTextSearches.get(searchKey)
      if (previousChild) {
        killSpawnedRipgrepProcess(previousChild)
      }

      const acc = createAccumulator()
      let stdoutBuffer = ''
      let resolved = false
      let processErrorObserved = false
      let unavailableExitObserved = false
      let child: ChildProcess | null = null
      const transformAbsPath = wslInfo
        ? (p: string): string => toWindowsWslPath(p, wslInfo.distro)
        : undefined

      const finish = (result: SearchResult | PromiseLike<SearchResult>): void => {
        if (resolved) {
          return
        }
        resolved = true
        if (this.activeRuntimeTextSearches.get(searchKey) === child) {
          this.activeRuntimeTextSearches.delete(searchKey)
        }
        cleanupListeners()
        resolvePromise(result)
      }
      const resolveOnce = (): void => finish(finalize(acc))
      const resolveWithoutRipgrep = (): void =>
        finish(searchWithGitGrep(authorizedRootPath, options, maxResults, localGitOptions))

      let killTimeout: ReturnType<typeof setTimeout> | null = null
      const cleanupListeners = (): void => {
        if (killTimeout) {
          clearTimeout(killTimeout)
          killTimeout = null
        }
        child?.stdout?.off('data', onStdoutData)
        child?.stderr?.off('data', onStderrData)
        child?.off('error', onError)
        child?.off('close', onClose)
        if (child) {
          absorbPendingRipgrepSpawnError(child, {
            errorObserved: processErrorObserved,
            unavailableExitObserved
          })
        }
      }

      const processLine = (line: string): void => {
        const verdict = ingestRgJsonLine(
          line,
          authorizedRootPath,
          acc,
          maxResults,
          transformAbsPath
        )
        if (verdict === 'stop' && child) {
          killSpawnedRipgrepProcess(child)
        }
      }

      const nextChild = wslAwareSpawn('rg', rgArgs, {
        cwd: authorizedRootPath,
        ...(localGitOptions.wslDistro ? { wslDistro: localGitOptions.wslDistro } : {}),
        stdio: ['ignore', 'pipe', 'pipe']
      })
      child = nextChild
      this.activeRuntimeTextSearches.set(searchKey, nextChild)

      nextChild.stdout!.setEncoding('utf-8')
      const onStdoutData = (chunk: string): void => {
        stdoutBuffer += chunk
        const lines = stdoutBuffer.split('\n')
        stdoutBuffer = lines.pop() ?? ''
        for (const line of lines) {
          processLine(line)
        }
      }
      const onStderrData = (): void => {
        // Drain stderr so rg cannot block on a full pipe.
      }
      const onError = (): void => {
        processErrorObserved = true
        if (child && isRipgrepUnavailableExit(child, null, null)) {
          resolveWithoutRipgrep()
          return
        }
        resolveOnce()
      }
      const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
        if (
          child &&
          isRipgrepUnavailableExit(child, code, signal, {
            classifyNativeLauncherExit: !(wslInfo || localGitOptions.wslDistro)
          })
        ) {
          unavailableExitObserved = true
          resolveWithoutRipgrep()
          return
        }
        if (stdoutBuffer) {
          processLine(stdoutBuffer)
        }
        resolveOnce()
      }

      nextChild.stdout!.on('data', onStdoutData)
      nextChild.stderr!.on('data', onStderrData)
      nextChild.once('error', onError)
      nextChild.once('close', onClose)

      killTimeout = setTimeout(() => {
        acc.truncated = true
        if (child) {
          killSpawnedRipgrepProcess(child)
        }
        resolveOnce()
      }, SEARCH_TIMEOUT_MS)
    })
  }
}

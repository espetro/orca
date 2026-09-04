import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { Repo } from '../../shared/repo-types'
import { isFolderRepo } from '../../shared/repo-kind'
import type { IFilesystemProvider } from '../providers/types'
import { getSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import { isENOENT } from '../ipc/filesystem-path-containment'
import {
  getEffectiveHooks,
  hasUnrecognizedOrcaYamlKeys,
  hasHooksFile,
  loadHooks,
  parseOrcaYaml
} from '../hooks'
import {
  getDefaultTabCommandTrustContent,
  getEffectiveSetupRunPolicy
} from '../effective-hook-config'
import { readIssueCommand, writeIssueCommand } from '../issue-command-file'
import { inspectSetupScriptImportCandidates } from '../../shared/setup-script-imports'
import { joinWorktreeRelativePath } from './runtime-relative-paths'
import type { RuntimeRepoGitCommandsDeps } from './runtime-repo-git-commands-deps'

// Why: narrow closure surface over OrcaRuntimeService so repo/git commands stay
// unit-testable without constructing the full runtime (pattern of runtime-linear-command-host).

export class RuntimeRepoSetupHookCommands {
  private readonly deps: RuntimeRepoGitCommandsDeps

  constructor(deps: RuntimeRepoGitCommandsDeps) {
    this.deps = deps
  }

  private get self() {
    return this
  }

  private getSetupHookTrustPayload(
    repo: Repo,
    scriptContentValue: string | undefined
  ): { contentHash: string; scriptContent: string } | undefined {
    const scriptContent = scriptContentValue?.trim()
    if (!scriptContent || repo.hookSettings?.commandSourcePolicy === 'local-only') {
      return undefined
    }
    return {
      contentHash: createHash('sha256').update(scriptContent).digest('hex'),
      scriptContent
    }
  }

  private getSharedSetupHookTrustPayload(
    repo: Repo,
    sharedSetupScript: string | undefined
  ): { contentHash: string; scriptContent: string } | undefined {
    if (repo.hookSettings?.commandSourcePolicy === 'local-only') {
      return undefined
    }
    return self.getSetupHookTrustPayload(repo, sharedSetupScript)
  }

  async getRepoHooks(repoSelector: string) {
    const repo = await self.deps.resolveRepoSelector(repoSelector)
    if (repo.connectionId) {
      const fsProvider = getSshFilesystemProvider(repo.connectionId)
      if (!fsProvider) {
        return {
          hasHooksFile: false,
          hooks: null,
          setupRunPolicy: getEffectiveSetupRunPolicy(repo),
          source: null
        }
      }
      try {
        const result = await fsProvider.readFile(joinWorktreeRelativePath(repo.path, 'orca.yaml'))
        const hooks = result.isBinary ? null : parseOrcaYaml(result.content)
        return {
          hasHooksFile: Boolean(hooks),
          hooks,
          setupRunPolicy: getEffectiveSetupRunPolicy(repo),
          source: hooks ? 'orca.yaml' : null,
          setupTrust: self.getSharedSetupHookTrustPayload(
            repo,
            getDefaultTabCommandTrustContent(hooks)
          )
        }
      } catch {
        return {
          hasHooksFile: false,
          hooks: null,
          setupRunPolicy: getEffectiveSetupRunPolicy(repo),
          source: null
        }
      }
    }
    const hasFile = hasHooksFile(repo.path)
    const hooks = getEffectiveHooks(repo)
    const sharedHooks = hasFile ? loadHooks(repo.path) : null
    const setupRunPolicy = getEffectiveSetupRunPolicy(repo)
    return {
      hasHooksFile: hasFile,
      hooks,
      setupRunPolicy,
      source: hasFile ? 'orca.yaml' : hooks ? 'legacy' : null,
      setupTrust: self.getSharedSetupHookTrustPayload(
        repo,
        getDefaultTabCommandTrustContent(sharedHooks)
      )
    }
  }

  async checkRepoHooks(repoSelector: string) {
    const repo = await self.deps.resolveRepoSelector(repoSelector)
    if (isFolderRepo(repo)) {
      return {
        status: 'ok' as const,
        hasHooks: false,
        hooks: null,
        mayNeedUpdate: false
      }
    }

    if (repo.connectionId) {
      const fsProvider = getSshFilesystemProvider(repo.connectionId)
      // Why: callers cache "no hooks" as authoritative, so an unreadable repo must fail
      // closed with an error status (mirrors the hooks:check IPC handler) instead of
      // pinning a false "no setup script" verdict until the client remounts.
      if (!fsProvider) {
        return {
          status: 'error' as const,
          hasHooks: false,
          hooks: null,
          mayNeedUpdate: false
        }
      }
      try {
        const result = await fsProvider.readFile(joinWorktreeRelativePath(repo.path, 'orca.yaml'))
        if (result.isBinary) {
          return {
            status: 'ok' as const,
            hasHooks: false,
            hooks: null,
            mayNeedUpdate: false
          }
        }
        return {
          status: 'ok' as const,
          hasHooks: true,
          hooks: parseOrcaYaml(result.content),
          mayNeedUpdate: false
        }
      } catch (error) {
        return {
          status: isENOENT(error) ? ('ok' as const) : ('error' as const),
          hasHooks: false,
          hooks: null,
          mayNeedUpdate: false
        }
      }
    }

    const has = hasHooksFile(repo.path)
    const hooks = has ? loadHooks(repo.path) : null
    return {
      status: 'ok' as const,
      hasHooks: has,
      hooks,
      mayNeedUpdate: has && !hooks && hasUnrecognizedOrcaYamlKeys(repo.path)
    }
  }

  async inspectRepoSetupScriptImports(repoSelector: string) {
    const repo = await self.deps.resolveRepoSelector(repoSelector)
    if (isFolderRepo(repo)) {
      return []
    }

    return inspectSetupScriptImportCandidates(async (relativePath) => {
      const filePath = joinWorktreeRelativePath(repo.path, relativePath)
      if (repo.connectionId) {
        const fsProvider = getSshFilesystemProvider(repo.connectionId)
        if (!fsProvider) {
          return null
        }
        try {
          const result = await fsProvider.readFile(filePath)
          return result.isBinary ? null : result.content
        } catch {
          return null
        }
      }

      try {
        return await readFile(filePath, 'utf-8')
      } catch (error) {
        if (!isENOENT(error)) {
          console.warn('[runtime] Failed to inspect setup script import candidate:', error)
        }
        return null
      }
    })
  }

  async readRepoIssueCommand(repoSelector: string) {
    const repo = await self.deps.resolveRepoSelector(repoSelector)
    if (isFolderRepo(repo)) {
      return {
        localContent: null,
        sharedContent: null,
        effectiveContent: null,
        localFilePath: '',
        source: 'none' as const
      }
    }

    if (repo.connectionId) {
      const issueCommandPath = joinWorktreeRelativePath(repo.path, '.orca/issue-command')
      const fsProvider = getSshFilesystemProvider(repo.connectionId)
      if (!fsProvider) {
        return {
          localContent: null,
          sharedContent: null,
          effectiveContent: null,
          localFilePath: issueCommandPath,
          source: 'none' as const
        }
      }
      const localContent = await self.readRemoteIssueCommandOverride(fsProvider, issueCommandPath)
      const sharedContent = await self.readRemoteSharedIssueCommand(fsProvider, repo.path)
      const effectiveContent = localContent ?? sharedContent
      return {
        localContent,
        sharedContent,
        effectiveContent,
        localFilePath: issueCommandPath,
        source: localContent
          ? ('local' as const)
          : sharedContent
            ? ('shared' as const)
            : ('none' as const)
      }
    }

    return readIssueCommand(repo.path)
  }

  private async readRemoteIssueCommandOverride(
    fsProvider: IFilesystemProvider,
    issueCommandPath: string
  ): Promise<string | null> {
    try {
      const result = await fsProvider.readFile(issueCommandPath)
      if (result.isBinary) {
        return null
      }
      return result.content.trim() || null
    } catch {
      return null
    }
  }

  private async readRemoteSharedIssueCommand(
    fsProvider: IFilesystemProvider,
    repoPath: string
  ): Promise<string | null> {
    try {
      const result = await fsProvider.readFile(joinWorktreeRelativePath(repoPath, 'orca.yaml'))
      if (result.isBinary) {
        return null
      }
      return parseOrcaYaml(result.content)?.issueCommand?.trim() || null
    } catch {
      return null
    }
  }

  async writeRepoIssueCommand(repoSelector: string, content: string): Promise<{ ok: true }> {
    const repo = await self.deps.resolveRepoSelector(repoSelector)
    if (isFolderRepo(repo)) {
      return { ok: true }
    }

    if (repo.connectionId) {
      const issueCommandPath = joinWorktreeRelativePath(repo.path, '.orca/issue-command')
      const fsProvider = getSshFilesystemProvider(repo.connectionId)
      if (!fsProvider) {
        return { ok: true }
      }
      const trimmed = content.trim()
      if (!trimmed) {
        await fsProvider.deletePath(issueCommandPath, false).catch((error: unknown) => {
          if (!isENOENT(error)) {
            throw error
          }
        })
        return { ok: true }
      }
      await fsProvider.createDir(joinWorktreeRelativePath(repo.path, '.orca'))
      await self.ensureRemoteOrcaDirIgnored(fsProvider, repo.path)
      await fsProvider.writeFile(issueCommandPath, `${trimmed}\n`)
      return { ok: true }
    }

    writeIssueCommand(repo.path, content)
    return { ok: true }
  }

  private async ensureRemoteOrcaDirIgnored(
    fsProvider: IFilesystemProvider,
    repoPath: string,
    options: { required?: boolean } = {}
  ): Promise<void> {
    const gitignorePath = joinWorktreeRelativePath(repoPath, '.gitignore')
    let result: Awaited<ReturnType<IFilesystemProvider['readFile']>>
    try {
      result = await fsProvider.readFile(gitignorePath)
    } catch (error) {
      if (!isENOENT(error)) {
        if (options.required) {
          throw error
        }
        console.warn('[runtime] Could not inspect remote .gitignore for .orca', error)
        return
      }
      try {
        await fsProvider.writeFile(gitignorePath, '.orca\n')
      } catch (writeError) {
        if (options.required) {
          throw writeError
        }
        console.warn('[runtime] Could not update remote .gitignore to exclude .orca', writeError)
      }
      return
    }
    if (result.isBinary) {
      if (options.required) {
        throw new Error('Remote .gitignore is binary; cannot verify .orca is ignored')
      }
      return
    }
    if (/^\.orca\/?$/m.test(result.content)) {
      return
    }
    const separator = result.content.endsWith('\n') ? '' : '\n'
    try {
      await fsProvider.writeFile(gitignorePath, `${result.content}${separator}.orca\n`)
    } catch (writeError) {
      if (options.required) {
        throw writeError
      }
      console.warn('[runtime] Could not update remote .gitignore to exclude .orca', writeError)
    }
  }
}

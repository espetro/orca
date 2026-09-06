/* eslint-disable max-lines -- Why: owns createRemoteWorktree/createLocalWorktree orchestration; remaining concerns extracted to sibling modules */
import type {
  CreateWorktreeResult,
  WorktreeCreateBaseFallback
} from '../../shared/worktree/create-types'
import type {
  OrcaRuntimeService,
  RemoteFetchResult,
  RemoteTrackingBase
} from '../runtime/orca-runtime'
import type { AddWorktreeOptions, AddWorktreeResult } from '../git/worktree'
import type { BrowserWindow } from 'electron'
import type { IFilesystemProvider } from '../providers/types'
import type { Repo } from '../../shared/repo-types'
import type { SetupAgentStartupPolicy } from '../../shared/orca-yaml-hook-types'
import type { SshGitProvider } from '../providers/ssh-git-provider'
import type { Store } from '../persistence'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import type { CreateWorktreeArgsWithSystemProvenance } from './worktrees/ipc-context-schemas'
import type { GitPushTarget, WorktreeHeadIdentity } from '../../shared/worktree/types'
import { buildPosixRunnerScript, buildWindowsRunnerScript } from '../setup-runner-script-text'
import { createSetupRunnerScript, resolveSetupRunnerShell } from '../worktree-runner-script'
import { createWorktreeCreateTimingRecorder } from '../worktree-create-timing'
import { existsSync } from 'node:fs'
import { findCreatedWorktree } from './created-worktree-reconciliation'
import { formatWorktreeIncludeCopyWarning } from './worktree-include-copy-budget'
import { getBranchConflictKind, resolveDefaultBaseRefWithLocalGit } from '../git/repo'
import type { getPRForBranch } from '../github/client'
import { getLocalGitHubPrForBranch } from '../runtime/runtime-worktree-git-shared'
import { configureCreatedWorktreePushTarget } from './worktree-push-target-commands'
import { configureCreatedWorktreePushTargetWithExec } from './worktree-push-target-setup'
import {
  createWorktreeCopiedPaths,
  createWorktreeLinkedPaths,
  createWorktreeSharedPaths
} from './worktree-symlinks'
import {
  getBranchNameOverrideCandidate,
  getGeneratedWorktreeCreateCandidate,
  getWorktreeCreateCandidate,
  isGeneratedWorktreeCreateName,
  WORKTREE_CREATE_MAX_SUFFIX_ATTEMPTS
} from '../worktree-create-candidates'
import {
  getDefaultTabsLaunch,
  getEffectiveHooksFromConfig,
  shouldRunSetupForCreate
} from '../effective-hook-config'
import {
  getLocalProjectGitExecOptions,
  getLocalProjectWorktreeGitOptions
} from '../project-runtime-git-options'
import { getProjectHostSetupWorktreeMeta } from '../../shared/project-host-setup-lookup'
import { getSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import { getSetupRunnerEnvVars } from '../setup-hook-env-vars'
import { gitExecFileAsync } from '../git/runner'
import { isENOENT } from './filesystem-path-containment'
import { isWindowsAbsolutePathLike } from '../../shared/cross-platform-path'
import { listWorktrees, addWorktree, addSparseWorktree } from '../git/worktree'
import { normalizeSparseDirectories } from './sparse-checkout-directories'
import { posix, win32 } from 'node:path'
import { randomUUID } from 'node:crypto'
import { registerWorktreeRootsForRepo } from './registered-worktree-roots-cache'
import { requireSshGitProvider } from '../providers/ssh-git-dispatch'
import { resolveLocalGitUsername, getSshGitUsername } from '../git/git-username'
import { resolveWorktreeCreateBase } from '../worktree-create-base'
import { resolveWorktreeIncludePaths } from '../git/worktree-include-file'
import { resolveWorktreeSharedDirectories } from '../git/worktree-shared-directories'
import { runWorktreeChangeInvalidators } from './worktree-change-invalidators'
import {
  computeRemoteWorktreePath,
  computeWorktreePath,
  computeWorkspaceRoot,
  ensurePathWithinWorkspace,
  getWorktreeCreationLayout,
  getWorktreePathSettings,
  hasRepoWorktreeBasePath,
  mergeWorktree,
  sanitizeWorktreeDisplayName,
  sanitizeWorktreeName,
  shouldSetDisplayName
} from './worktree-logic'
import { isTuiAgent } from '../../shared/tui-agent-config'
import { shouldWaitForSetupBeforeAgentStartup } from '../../shared/setup-agent-startup-policy'
import {
  prepareWorktreePushTarget,
  prepareWorktreePushTargetSsh
} from './worktree-push-target-commands'
import { getEffectiveHooks, loadHooks, parseOrcaYaml } from '../hooks'
import {
  failedWorktreeCreationNeedsRetirement,
  getRetiredNameRegistryForRepo,
  retireGeneratedWorktreeName
} from '../worktree-name-retirement'
import { createRetiredNameLookup } from '../../shared/worktree/retired-name-registry'
import { registerRequiredSshWorktreeCreateRoots } from './ssh-worktree-create-root-registration'
import {
  fetchRemoteForWorktreeCreate,
  refreshRemoteTrackingBaseForWorktreeCreate
} from './ssh-worktree-create-fetch-queue'
import {
  getOrStartRemoteWorktreeCreateBasePlan,
  getRemoteLocalBaseRefUpdateSuggestionForWorktreeCreate,
  refreshLocalBaseRefForRemoteWorktreeCreate
} from './ssh-worktree-create-base-plan'
import {
  canCheckoutExistingLocalBranch,
  canCheckoutExistingLocalBranchSsh,
  getSshBranchConflictKind,
  hasCommitRefSsh,
  hasLocalWorktreeBaseRefWithOptions,
  hasRemoteWorktreeBaseRef,
  resolveCreateBranchName,
  resolveCreateBranchNameSsh
} from './worktree-create-branch-resolution'
import {
  getSelectedHostedReviewForBranch,
  getSelectedReviewBranch,
  isAllowedPushTargetRemoteConflict,
  isMatchingSelectedGitHubPr
} from './worktree-create-review-branch'
import {
  assertAttachableParentWorkspace,
  recordWorkspaceLineageForCreatedWorktree
} from './created-worktree-lineage'
import {
  appendWorktreeCreateWarning,
  spawnLocalStartupAndSetupTerminals
} from './worktree-create-startup-terminals'
import { worktreeWorkspaceKey } from '../../shared/workspace-scope'
import { joinWorktreeRelativePath } from '../runtime/runtime-relative-paths'

// Why: bound the fallback `git fetch origin` so a Windows credential-manager GUI hang (STA-1292) can't wedge worktree creation forever.
const CREATE_BASE_FALLBACK_FETCH_TIMEOUT_MS = 60_000

export {
  assertAttachableParentWorkspace,
  recordWorkspaceLineageForCreatedWorktree
} from './created-worktree-lineage'
export {
  cleanupUnusedWorktreePushTargetRemote,
  cleanupUnusedWorktreePushTargetRemoteSsh,
  configureCreatedWorktreePushTarget,
  prepareWorktreePushTarget
} from './worktree-push-target-commands'
export { resetSshWorktreeCreateFetchCache as __resetSshWorktreeCreateFetchCacheForTests } from './ssh-worktree-create-fetch-queue'
export { prefetchRemoteWorktreeCreateBase } from './ssh-worktree-create-base-plan'

async function unsetRemoteWorktreeCreationBase(
  provider: SshGitProvider,
  worktreePath: string,
  branchName: string
): Promise<void> {
  try {
    await provider.exec(
      ['config', '--local', '--unset-all', `branch.${branchName}.base`],
      worktreePath
    )
  } catch {
    // Best-effort cleanup; keep the sparse setup error as the actionable failure.
  }
}

async function remotePathExists(
  fsProvider: IFilesystemProvider | null | undefined,
  pathValue: string
): Promise<boolean> {
  if (!fsProvider?.stat) {
    return false
  }
  try {
    await fsProvider.stat(pathValue)
    return true
  } catch (error) {
    if (isENOENT(error)) {
      return false
    }
    throw error
  }
}

async function readRemoteEffectiveHooks(
  repo: Repo,
  fsProvider: IFilesystemProvider,
  hooksRootPath: string
): Promise<ReturnType<typeof getEffectiveHooksFromConfig>> {
  return getEffectiveHooksFromConfig(repo, await readRemoteOrcaYaml(fsProvider, hooksRootPath))
}

async function readRemoteOrcaYaml(
  fsProvider: IFilesystemProvider,
  hooksRootPath: string
): Promise<ReturnType<typeof parseOrcaYaml>> {
  try {
    const result = await fsProvider.readFile(joinWorktreeRelativePath(hooksRootPath, 'orca.yaml'))
    return result.isBinary ? null : parseOrcaYaml(result.content)
  } catch {
    return null
  }
}

async function createRemoteSetupRunnerScript(
  repo: Repo,
  worktreePath: string,
  script: string,
  gitProvider: SshGitProvider,
  fsProvider: IFilesystemProvider,
  projectStartupPolicy?: SetupAgentStartupPolicy
): Promise<CreateWorktreeResult['setup']> {
  const useWindowsFormat = isWindowsAbsolutePathLike(worktreePath)
  // Why: SSH terminals choose their shell on the remote host; local Windows
  // preferences cannot safely select a remote runner format or launch command.
  const runnerRelativePath = useWindowsFormat ? 'orca/setup-runner.cmd' : 'orca/setup-runner.sh'
  const { stdout } = await gitProvider.exec(
    ['rev-parse', '--git-path', runnerRelativePath],
    worktreePath
  )
  const runnerScriptPath = stdout.trim()
  const runnerDir = useWindowsFormat
    ? win32.dirname(runnerScriptPath)
    : posix.dirname(runnerScriptPath)
  await fsProvider.createDir(runnerDir)
  await fsProvider.writeFile(
    runnerScriptPath,
    useWindowsFormat ? buildWindowsRunnerScript(script) : buildPosixRunnerScript(script)
  )
  return {
    runnerScriptPath,
    envVars: getSetupRunnerEnvVars(repo, worktreePath),
    ...(shouldWaitForSetupBeforeAgentStartup(
      repo.hookSettings?.setupAgentStartupPolicy,
      projectStartupPolicy
    )
      ? { waitForAgentStartup: true }
      : {})
  }
}

export function notifyWorktreesChanged(mainWindow: BrowserWindow, repoId: string): void {
  // Why: invalidate detected-worktree caches before renderer observers react, so follow-up listDetected sees post-change state.
  runWorktreeChangeInvalidators(repoId)
  if (!mainWindow.isDestroyed()) {
    mainWindow.webContents.send('worktrees:changed', { repoId })
  }
}

export function notifyWorktreeGitStatusMetadataChanged(
  mainWindow: BrowserWindow,
  repoId: string
): void {
  // Why: index churn is a Source Control freshness hint, not a graph mutation; leave structural caches and runtime/mobile events untouched.
  if (!mainWindow.isDestroyed()) {
    mainWindow.webContents.send('worktrees:gitStatusMetadataChanged', { repoId })
  }
}

export function notifyWorktreeHeadIdentitiesChanged(
  mainWindow: BrowserWindow,
  repoId: string,
  identities: WorktreeHeadIdentity[]
): void {
  // Why: background worktrees have no active status refresh, so metadata-detected head moves ride this targeted event instead of the structural fanout.
  if (!mainWindow.isDestroyed()) {
    mainWindow.webContents.send('worktrees:headIdentitiesChanged', { repoId, identities })
  }
}

// Why: two-phase spinner — fire 'fetching' before pre-create fetch and 'creating' before git worktree add so the renderer can swap its label.
export function emitCreateWorktreeProgress(
  mainWindow: BrowserWindow,
  phase: 'fetching' | 'creating',
  creationId?: string
): void {
  if (!mainWindow.isDestroyed()) {
    mainWindow.webContents.send('createWorktree:progress', { creationId, phase })
  }
}

export async function createRemoteWorktree(
  args: CreateWorktreeArgsWithSystemProvenance,
  repo: Repo,
  store: Store,
  mainWindow: BrowserWindow
): Promise<CreateWorktreeResult> {
  const timing = createWorktreeCreateTimingRecorder()
  const provider = requireSshGitProvider(repo.connectionId!)
  const fsProvider = getSshFilesystemProvider(repo.connectionId!)

  const settings = store.getSettings()
  const worktreePathSettings = getWorktreePathSettings(repo, settings)
  let effectiveRequestedName = args.name
  const sanitizedName = sanitizeWorktreeName(args.name)
  let effectiveSanitizedName = sanitizedName
  const requestedDisplayName = args.displayName
    ? sanitizeWorktreeDisplayName(args.displayName)
    : undefined

  // Why: base resolution probes refs via generic git.exec; register the repo root first so relays don't report a valid base as stale.
  await registerRequiredSshWorktreeCreateRoots(repo.connectionId!, [repo.path])

  // Why: explicit branches and non-username prefix modes never consume this; skipping the remote probe preserves the exact branch name.
  const username =
    !args.branchNameOverride && settings.branchPrefix === 'git-username'
      ? await getSshGitUsername(provider, repo.path)
      : ''

  const branchConflictSubject = args.branchNameOverride ? 'branch name' : 'worktree name'
  // Why: don't fall back to hardcoded 'origin/main'; it may not exist (master/develop) and yields an opaque git error, so fail clearly and let the UI prompt.
  const basePlan = await getOrStartRemoteWorktreeCreateBasePlan(provider, repo, args.baseBranch)
  if (!basePlan) {
    throw new Error(
      'Could not resolve a default base ref for this repo. Pick a base branch explicitly and try again.'
    )
  }
  let { baseBranch } = basePlan
  let { remoteTrackingBase } = basePlan
  let baseFallback: WorktreeCreateBaseFallback | undefined

  if (remoteTrackingBase) {
    const hasRemoteTrackingBaseRef = await hasCommitRefSsh(
      provider,
      repo.path,
      remoteTrackingBase.ref
    )
    const hasNamedLocalBaseRef = await hasRemoteWorktreeBaseRef(provider, repo.path, baseBranch)
    const hasFallbackLocalBaseRef =
      !hasNamedLocalBaseRef &&
      (await hasRemoteWorktreeBaseRef(provider, repo.path, remoteTrackingBase.branch))
    if (!hasRemoteTrackingBaseRef && (hasNamedLocalBaseRef || hasFallbackLocalBaseRef)) {
      // Why: branch reuse and conflict checks must see the local fallback too.
      if (hasFallbackLocalBaseRef) {
        baseBranch = remoteTrackingBase.branch
      }
      baseFallback = {
        requestedRef: remoteTrackingBase.base,
        localRef: baseBranch
      }
      remoteTrackingBase = null
    }
  }

  let branchName = ''
  let checkoutExistingBranch = false
  let remotePath = ''
  let selectedExistingLocalBranchName: string | null = null
  let lastBranchConflictKind: 'local' | 'remote' | null = null
  let remotePathResolved = false
  const shouldRetireGeneratedName =
    args.nameWasGenerated === true && isGeneratedWorktreeCreateName(sanitizedName)
  const retiredNameRegistry = shouldRetireGeneratedName
    ? await getRetiredNameRegistryForRepo(store, repo, store.getRepos(), settings)
    : null
  const isRetiredName = retiredNameRegistry ? createRetiredNameLookup(retiredNameRegistry) : null
  // Why: duplicate PR/MR checkouts still need a workspace; suffix branch/path while preserving review metadata and push target.
  for (let suffix = 1, attempts = 0; attempts < WORKTREE_CREATE_MAX_SUFFIX_ATTEMPTS; suffix += 1) {
    effectiveSanitizedName = shouldRetireGeneratedName
      ? getGeneratedWorktreeCreateCandidate(
          sanitizedName,
          suffix,
          retiredNameRegistry?.exhaustedTiers
        )
      : getWorktreeCreateCandidate(sanitizedName, suffix)
    effectiveRequestedName = shouldRetireGeneratedName
      ? effectiveSanitizedName
      : args.name.trim()
        ? getWorktreeCreateCandidate(args.name, suffix)
        : effectiveSanitizedName
    if (isRetiredName?.(effectiveSanitizedName)) {
      continue
    }
    attempts += 1
    branchName = await resolveCreateBranchNameSsh(
      provider,
      repo.path,
      selectedExistingLocalBranchName ??
        getBranchNameOverrideCandidate(args.branchNameOverride, suffix),
      effectiveSanitizedName,
      settings,
      username
    )
    checkoutExistingBranch = await canCheckoutExistingLocalBranchSsh(
      provider,
      repo.path,
      branchName,
      baseBranch
    )
    if (checkoutExistingBranch && !selectedExistingLocalBranchName) {
      // Why: once a user-selected branch is safe to reuse, path retries keep it exact instead of creating a sibling.
      selectedExistingLocalBranchName = branchName
    }
    lastBranchConflictKind = checkoutExistingBranch
      ? null
      : await getSshBranchConflictKind(provider, repo.path, branchName, baseBranch)
    if (lastBranchConflictKind) {
      const selectedReview = isAllowedPushTargetRemoteConflict(
        lastBranchConflictKind,
        branchName,
        args
      )
        ? await getSelectedHostedReviewForBranch(repo, branchName, args).catch(() => null)
        : null
      if (!selectedReview?.matchesSelected) {
        continue
      }
      lastBranchConflictKind = null
    }
    remotePath = computeRemoteWorktreePath(
      effectiveSanitizedName,
      repo.path,
      worktreePathSettings,
      {
        useConfiguredAbsolutePath: hasRepoWorktreeBasePath(repo)
      }
    )
    if (!(await remotePathExists(fsProvider, remotePath))) {
      remotePathResolved = true
      break
    }
  }
  if (!remotePathResolved) {
    if (lastBranchConflictKind) {
      throw new Error(
        `Branch "${branchName}" already exists ${lastBranchConflictKind === 'local' ? 'locally' : 'on a remote'}. Pick a different ${branchConflictSubject}.`
      )
    }
    throw new Error(
      `Could not find an available remote worktree path for "${sanitizedName}". Pick a different worktree name.`
    )
  }

  assertAttachableParentWorkspace(
    store,
    args.parentWorkspace,
    worktreeWorkspaceKey(`${repo.id}::${remotePath}`)
  )

  const sparseDirectories = args.sparseCheckout
    ? normalizeSparseDirectories(args.sparseCheckout.directories)
    : []
  if (args.sparseCheckout && sparseDirectories.length === 0) {
    throw new Error('Sparse checkout requires at least one repo-relative directory.')
  }
  let sparsePresetId: string | undefined
  if (args.sparseCheckout?.presetId) {
    const preset = store
      .getSparsePresets(repo.id)
      .find((entry) => entry.id === args.sparseCheckout?.presetId)
    if (preset?.repoId === repo.id) {
      try {
        const presetDirectories = normalizeSparseDirectories(preset.directories)
        const presetSet = new Set(presetDirectories)
        const directoriesMatch =
          presetDirectories.length === sparseDirectories.length &&
          sparseDirectories.every((entry) => presetSet.has(entry))
        sparsePresetId = directoriesMatch ? preset.id : undefined
      } catch {
        // Why: corrupt preset data should not block creation or falsely label the new worktree.
      }
    }
  }

  // Why: addWorktree/setup probes run inside the new path; older relays need that root registered before accepting git/fs ops there.
  await registerRequiredSshWorktreeCreateRoots(repo.connectionId!, [remotePath])

  if (remoteTrackingBase) {
    try {
      await refreshRemoteTrackingBaseForWorktreeCreate(provider, repo, remoteTrackingBase)
    } catch {
      // Why: a refresh failure shouldn't block create if a usable (stale) local base ref exists; probe after registerRoot and hard-fail only when none does.
      if (!(await hasCommitRefSsh(provider, repo.path, remoteTrackingBase.ref))) {
        throw new Error(
          `Could not refresh base ref "${baseBranch}" from "${remoteTrackingBase.remote}". Check your network and try again.`
        )
      }
    }
  } else if (!(await hasRemoteWorktreeBaseRef(provider, repo.path, baseBranch))) {
    // Why: non-remote-tracking bases keep the legacy best-effort fetch; verified PR/MR SHA bases already have the object, so a broad fetch is wasted.
    try {
      await fetchRemoteForWorktreeCreate(provider, repo, 'origin')
    } catch {
      /* best-effort */
    }
  }

  const localBaseRefRefresh =
    settings.refreshLocalBaseRefOnWorktreeCreate && !checkoutExistingBranch && remoteTrackingBase
      ? await refreshLocalBaseRefForRemoteWorktreeCreate(provider, repo.path, remoteTrackingBase)
      : undefined
  const localBaseRefUpdateSuggestion =
    !settings.refreshLocalBaseRefOnWorktreeCreate &&
    !settings.localBaseRefSuggestionDismissed &&
    !checkoutExistingBranch &&
    remoteTrackingBase
      ? await getRemoteLocalBaseRefUpdateSuggestionForWorktreeCreate(
          provider,
          repo.path,
          remoteTrackingBase
        )
      : undefined

  if (fsProvider) {
    const primaryHooks = await readRemoteEffectiveHooks(repo, fsProvider, repo.path)
    if (primaryHooks?.scripts.setup) {
      shouldRunSetupForCreate(repo, args.setupDecision)
    }
  }

  let preparedPushTarget: GitPushTarget | undefined
  if (args.pushTarget) {
    // Why: fork-PR SSH worktrees need contributor-remote setup before create, else Push/Sync target origin.
    preparedPushTarget = await prepareWorktreePushTargetSsh(
      provider,
      repo.path,
      args.pushTarget,
      store,
      repo.id
    )
  }

  try {
    await timing.time('git_worktree_add', async () =>
      provider.addWorktree(
        repo.path,
        branchName,
        remotePath,
        checkoutExistingBranch
          ? { checkoutExistingBranch }
          : { base: baseBranch, ...(sparseDirectories.length > 0 ? { noCheckout: true } : {}) }
      )
    )
  } catch (err) {
    if (
      err instanceof Error &&
      (err.message.includes('No workspace roots registered yet') ||
        err.message.includes('Path outside authorized workspace'))
    ) {
      // Why: only OLD relays (pre-allowlist-removal) throw these; surface an upgrade message. Remove after version floor moves (docs/relay-fs-allowlist-removal.md).
      throw new Error(
        `Older relay reported an authorization error; please reconnect to deploy the latest relay. (${err.message})`
      )
    }
    throw err
  }
  if (sparseDirectories.length > 0) {
    try {
      // Why: SSH providers expose generic git exec, so remote sparse mirrors local addSparseWorktree without a new relay method.
      await provider.exec(['sparse-checkout', 'init', '--cone'], remotePath)
      await provider.exec(['sparse-checkout', 'set', '--', ...sparseDirectories], remotePath)
      await provider.exec(['checkout', branchName], remotePath)
    } catch (err) {
      let rollbackSucceeded = false
      if (!checkoutExistingBranch) {
        try {
          await unsetRemoteWorktreeCreationBase(provider, remotePath, branchName)
        } catch (cleanupError) {
          console.warn(
            '[worktree-create] Failed to clear remote sparse creation base:',
            cleanupError
          )
        }
      }
      try {
        await provider.removeWorktree(remotePath, true, {
          deleteBranch: !checkoutExistingBranch,
          // Why: sparse setup failed before any work happened, so rollback removes the just-created remote branch.
          forceBranchDelete: !checkoutExistingBranch
        })
        rollbackSucceeded = true
      } catch (rollbackError) {
        console.warn('[worktree-create] Failed to roll back remote sparse worktree:', rollbackError)
      }
      if (!rollbackSucceeded && shouldRetireGeneratedName) {
        await retireGeneratedWorktreeName(store, repo, settings, effectiveSanitizedName)
      }
      throw err
    }
  }

  // Why: fallible metadata work after creation must not leave a real workspace name reusable.
  if (shouldRetireGeneratedName) {
    await retireGeneratedWorktreeName(store, repo, settings, effectiveSanitizedName)
  }

  // Re-list to get the created worktree info
  const gitWorktrees = await timing.time('list_created_worktree', async () =>
    provider.listWorktrees(repo.path)
  )
  const created = gitWorktrees.find(
    (gw) => gw.branch?.endsWith(branchName) || gw.path.endsWith(effectiveSanitizedName)
  )
  if (!created) {
    throw new Error('Worktree created but not found in listing')
  }

  const worktreeId = `${repo.id}::${created.path}`
  const now = Date.now()
  // Why: PR/MR worktrees start from a head ref/SHA but Source Control must compare against the review target branch.
  const metadataBaseRef = args.compareBaseRef ?? remoteTrackingBase?.ref ?? baseBranch
  let configuredPushTarget: GitPushTarget | undefined
  if (preparedPushTarget) {
    configuredPushTarget = await configureCreatedWorktreePushTargetWithExec(
      (args, cwd) => provider.exec(args, cwd),
      created.path,
      branchName,
      preparedPushTarget
    )
  }

  const metaUpdates: Partial<WorktreeMeta> = {
    // Why: path-derived IDs get reused after external deletion; rotate instance identity so stale lineage can't attach to the new occupant.
    instanceId: randomUUID(),
    ...(store.getProjectHostSetups
      ? getProjectHostSetupWorktreeMeta(store.getProjectHostSetups(), repo)
      : {}),
    lastActivityAt: now,
    // Why: grace window atop Recent so ambient PTY bumps on others during create don't bury the new worktree. See smart-sort.ts `CREATE_GRACE_MS`.
    createdAt: now,
    orcaCreatedAt: now,
    orcaCreationSource: 'ssh',
    creatorProvenance: { kind: 'host' },
    orcaCreationWorkspaceLayout: getWorktreeCreationLayout(repo, settings),
    ...(args.automationProvenance ? { automationProvenance: args.automationProvenance } : {}),
    ...(args.cliProvenance ? { cliProvenance: args.cliProvenance } : {}),
    baseRef: metadataBaseRef,
    ...(checkoutExistingBranch ? { preserveBranchOnDelete: true } : {}),
    ...(configuredPushTarget ? { pushTarget: configuredPushTarget } : {}),
    ...(requestedDisplayName
      ? { displayName: requestedDisplayName }
      : shouldSetDisplayName(effectiveRequestedName, branchName, effectiveSanitizedName)
        ? { displayName: effectiveRequestedName }
        : {}),
    ...(isTuiAgent(args.createdWithAgent) ? { createdWithAgent: args.createdWithAgent } : {}),
    ...(args.pendingFirstAgentMessageRename === true && isTuiAgent(args.createdWithAgent)
      ? { pendingFirstAgentMessageRename: true }
      : {}),
    ...(sparseDirectories.length > 0
      ? {
          sparseDirectories,
          sparseBaseRef: metadataBaseRef,
          sparsePresetId
        }
      : {}),
    ...(args.linkedIssue !== undefined ? { linkedIssue: args.linkedIssue } : {}),
    ...(args.linkedPR !== undefined ? { linkedPR: args.linkedPR } : {}),
    ...(args.linkedLinearIssue !== undefined ? { linkedLinearIssue: args.linkedLinearIssue } : {}),
    ...(args.linkedLinearIssueWorkspaceId !== undefined
      ? { linkedLinearIssueWorkspaceId: args.linkedLinearIssueWorkspaceId }
      : {}),
    ...(args.linkedLinearIssueOrganizationUrlKey !== undefined
      ? { linkedLinearIssueOrganizationUrlKey: args.linkedLinearIssueOrganizationUrlKey }
      : {}),
    ...(args.manualOrder !== undefined ? { manualOrder: args.manualOrder } : {}),
    ...(args.linkedGitLabIssue !== undefined ? { linkedGitLabIssue: args.linkedGitLabIssue } : {}),
    ...(args.linkedGitLabMR !== undefined ? { linkedGitLabMR: args.linkedGitLabMR } : {}),
    ...(args.linkedBitbucketPR !== undefined ? { linkedBitbucketPR: args.linkedBitbucketPR } : {}),
    ...(args.linkedAzureDevOpsPR !== undefined
      ? { linkedAzureDevOpsPR: args.linkedAzureDevOpsPR }
      : {}),
    ...(args.linkedGiteaPR !== undefined ? { linkedGiteaPR: args.linkedGiteaPR } : {}),
    ...(args.linkedWorkItem !== undefined ? { linkedWorkItem: args.linkedWorkItem } : {}),
    ...(args.linkedTaskSourceContext !== undefined
      ? { linkedTaskSourceContext: args.linkedTaskSourceContext }
      : {}),
    ...(args.workspaceStatus !== undefined ? { workspaceStatus: args.workspaceStatus } : {})
  }
  const { worktree } = timing.timeSync('persist_metadata', () => {
    const meta = store.setWorktreeMeta(worktreeId, metaUpdates)
    return { worktree: mergeWorktree(repo.id, created, meta) }
  })
  const { lineage: worktreeLineage, workspaceLineage } = recordWorkspaceLineageForCreatedWorktree(
    store,
    args,
    worktree,
    now
  )

  // Why: shared/symlink paths, `orca.yaml` shared directories, and `.worktreeinclude` copies are local-only; remote (SSH) support needs a new relay method + auth surface, so all are skipped here.

  let setup: CreateWorktreeResult['setup']
  let defaultTabs: CreateWorktreeResult['defaultTabs']
  if (fsProvider) {
    await timing.time('prepare_setup', async () => {
      const yamlHooks = await readRemoteOrcaYaml(fsProvider, created.path)
      const hooks = getEffectiveHooksFromConfig(repo, yamlHooks)
      try {
        defaultTabs = getDefaultTabsLaunch(yamlHooks, repo, args.setupDecision)
      } catch (error) {
        // Why: default tab commands share setup's run policy; without a renderer decision, create the tabs but don't run them.
        console.warn(`[hooks] default tab commands skipped for ${created.path}:`, error)
        defaultTabs = yamlHooks?.defaultTabs
          ? { tabs: yamlHooks.defaultTabs, runCommands: false }
          : undefined
      }
      const setupScript = hooks?.scripts.setup
      let shouldLaunchSetup = false
      if (setupScript) {
        try {
          shouldLaunchSetup = shouldRunSetupForCreate(repo, args.setupDecision)
        } catch (error) {
          // Why: worktree already exists; skip setup rather than fail a successful git create when the branch adds a hook without a renderer decision.
          console.warn(`[hooks] setup hook skipped for ${created.path}:`, error)
        }
      }
      if (setupScript && shouldLaunchSetup) {
        try {
          setup = await createRemoteSetupRunnerScript(
            repo,
            created.path,
            setupScript,
            provider,
            fsProvider,
            yamlHooks?.setupAgentStartupPolicy
          )
        } catch (error) {
          console.error(`[hooks] Failed to prepare setup runner for ${created.path}:`, error)
        }
      }
    })
  }

  notifyWorktreesChanged(mainWindow, repo.id)
  return {
    worktree: {
      ...worktree,
      workspaceLineage,
      ...(worktreeLineage
        ? { lineage: worktreeLineage, parentWorktreeId: worktreeLineage.parentWorktreeId }
        : {})
    },
    ...(worktreeLineage ? { lineage: worktreeLineage } : {}),
    ...(workspaceLineage ? { workspaceLineage } : {}),
    ...(setup ? { setup } : {}),
    ...(defaultTabs ? { defaultTabs } : {}),
    ...(localBaseRefRefresh ? { localBaseRefRefresh } : {}),
    ...(localBaseRefUpdateSuggestion ? { localBaseRefUpdateSuggestion } : {}),
    ...(baseFallback ? { baseFallback } : {}),
    timing: timing.finish()
  }
}

export async function createLocalWorktree(
  args: CreateWorktreeArgsWithSystemProvenance,
  repo: Repo,
  store: Store,
  mainWindow: BrowserWindow,
  runtime?: OrcaRuntimeService
): Promise<CreateWorktreeResult> {
  const timing = createWorktreeCreateTimingRecorder()
  const settings = store.getSettings()
  const worktreePathSettings = getWorktreePathSettings(repo, settings)
  const localGitExecOptions = getLocalProjectGitExecOptions(store, repo)
  const localWorktreeGitOptions = getLocalProjectWorktreeGitOptions(store, repo)
  const hasLocalWorktreeGitOptions = Object.keys(localWorktreeGitOptions).length > 0
  const localWorktreeGitOptionArgs: [] | [{ wslDistro?: string }] = hasLocalWorktreeGitOptions
    ? [localWorktreeGitOptions]
    : []
  const addProjectGitOptions = (options?: AddWorktreeOptions): AddWorktreeOptions | undefined => {
    if (!hasLocalWorktreeGitOptions) {
      return options
    }
    return { ...options, ...localWorktreeGitOptions }
  }

  const requestedName = args.name
  const sanitizedName = sanitizeWorktreeName(args.name)
  const requestedDisplayName = args.displayName
    ? sanitizeWorktreeDisplayName(args.displayName)
    : undefined
  // Why: explicit branches and non-username prefix modes never consume this; skipping the probe preserves the exact generated branch name.
  const username =
    !args.branchNameOverride && settings.branchPrefix === 'git-username'
      ? await resolveLocalGitUsername(repo.path)
      : ''

  let baseBranch = await resolveWorktreeCreateBase({
    requestedBaseBranch: args.baseBranch,
    repoWorktreeBaseRef: repo.worktreeBaseRef,
    resolveDefaultBaseRef: () => resolveDefaultBaseRefWithLocalGit(localGitExecOptions),
    isBaseUsable: async (baseBranchCandidate) => {
      if (runtime) {
        const remoteTrackingBase = await runtime.resolveRemoteTrackingBase(
          repo.path,
          baseBranchCandidate,
          ...localWorktreeGitOptionArgs
        )
        if (remoteTrackingBase) {
          if (
            await runtime.hasRemoteTrackingRef(
              repo.path,
              remoteTrackingBase,
              ...localWorktreeGitOptionArgs
            )
          ) {
            return true
          }
          return hasLocalWorktreeBaseRefWithOptions(
            repo.path,
            baseBranchCandidate,
            localGitExecOptions
          )
        }
      }
      return hasLocalWorktreeBaseRefWithOptions(repo.path, baseBranchCandidate, localGitExecOptions)
    }
  })
  if (!baseBranch) {
    // Why: no default base resolved; fail clearly rather than pass a hardcoded non-existent ref to git worktree add (opaque error) so the UI can prompt.
    throw new Error(
      'Could not resolve a default base ref for this repo. Pick a base branch explicitly and try again.'
    )
  }

  let remoteTrackingBase: RemoteTrackingBase | null = null
  let baseFallback: WorktreeCreateBaseFallback | undefined
  let remoteTrackingRefresh: {
    base: RemoteTrackingBase
    hadLocalBaseRef: boolean
    promise: Promise<RemoteFetchResult>
  } | null = null
  let legacyFetchPromise: Promise<void> | null = null

  if (runtime) {
    remoteTrackingBase = await runtime.resolveRemoteTrackingBase(
      repo.path,
      baseBranch,
      ...localWorktreeGitOptionArgs
    )
    if (remoteTrackingBase) {
      const hasRemoteTrackingBaseRef = await runtime.hasRemoteTrackingRef(
        repo.path,
        remoteTrackingBase,
        ...localWorktreeGitOptionArgs
      )
      const hasNamedLocalBaseRef = await hasLocalWorktreeBaseRefWithOptions(
        repo.path,
        baseBranch,
        localGitExecOptions
      )
      const hasFallbackLocalBaseRef =
        !hasNamedLocalBaseRef &&
        (await hasLocalWorktreeBaseRefWithOptions(
          repo.path,
          remoteTrackingBase.branch,
          localGitExecOptions
        ))
      const hasLocalBaseRef =
        hasRemoteTrackingBaseRef || hasNamedLocalBaseRef || hasFallbackLocalBaseRef
      if (!hasRemoteTrackingBaseRef && hasLocalBaseRef) {
        // Why: use the usable local branch when offline refresh cannot create its tracking ref.
        if (hasFallbackLocalBaseRef) {
          baseBranch = remoteTrackingBase.branch
        }
        baseFallback = {
          requestedRef: remoteTrackingBase.base,
          localRef: baseBranch
        }
        remoteTrackingBase = null
      } else {
        emitCreateWorktreeProgress(mainWindow, 'fetching', args.creationId)
        remoteTrackingRefresh = {
          base: remoteTrackingBase,
          hadLocalBaseRef: hasRemoteTrackingBaseRef,
          promise: runtime.getOrStartRemoteTrackingBaseRefresh(
            repo.path,
            remoteTrackingBase,
            ...localWorktreeGitOptionArgs
          )
        }
      }
    } else if (
      !(await hasLocalWorktreeBaseRefWithOptions(repo.path, baseBranch, localWorktreeGitOptions))
    ) {
      // Why: non-remote-prefix bases (plain main/master/local) keep the legacy best-effort fetch; verified PR SHA bases already have the object.
      legacyFetchPromise = runtime
        .fetchRemoteWithCache(repo.path, 'origin', ...localWorktreeGitOptionArgs)
        .then(() => undefined)
        .catch(() => undefined)
      emitCreateWorktreeProgress(mainWindow, 'fetching', args.creationId)
    }
  } else {
    if (
      !(await hasLocalWorktreeBaseRefWithOptions(repo.path, baseBranch, localWorktreeGitOptions))
    ) {
      legacyFetchPromise = gitExecFileAsync(['fetch', 'origin'], {
        ...localGitExecOptions,
        timeout: CREATE_BASE_FALLBACK_FETCH_TIMEOUT_MS
      })
        .then(() => undefined)
        .catch(() => undefined)
      emitCreateWorktreeProgress(mainWindow, 'fetching', args.creationId)
    }
  }
  const workspaceRoot = computeWorkspaceRoot(repo.path, worktreePathSettings)

  // Why: this validation doesn't depend on remote refs, so it can overlap a required remote-tracking base refresh.
  const primarySetupScript = getEffectiveHooks(repo)?.scripts.setup
  if (primarySetupScript) {
    shouldRunSetupForCreate(repo, args.setupDecision)
  }
  const sparseDirectories = args.sparseCheckout
    ? normalizeSparseDirectories(args.sparseCheckout.directories)
    : []
  if (args.sparseCheckout && sparseDirectories.length === 0) {
    throw new Error('Sparse checkout requires at least one repo-relative directory.')
  }
  let sparsePresetId: string | undefined
  if (args.sparseCheckout?.presetId) {
    const preset = store
      .getSparsePresets(repo.id)
      .find((entry) => entry.id === args.sparseCheckout?.presetId)
    if (preset?.repoId === repo.id) {
      try {
        const presetDirectories = normalizeSparseDirectories(preset.directories)
        // Why: Set-based compare so directory order doesn't affect attribution — matches renderer's sparseDirectoriesMatch.
        const presetSet = new Set(presetDirectories)
        const directoriesMatch =
          presetDirectories.length === sparseDirectories.length &&
          sparseDirectories.every((entry) => presetSet.has(entry))
        sparsePresetId = directoriesMatch ? preset.id : undefined
      } catch {
        // Why: corrupt preset data should not block creation or falsely label the new worktree.
      }
    }
  }

  let effectiveRequestedName = requestedName
  let effectiveSanitizedName = sanitizedName
  let branchName = ''
  let worktreePath = ''

  const branchConflictSubject = args.branchNameOverride ? 'branch name' : 'worktree name'
  let resolved = false
  let checkoutExistingBranch = false
  let selectedExistingLocalBranchName: string | null = null
  let lastBranchConflictKind: 'local' | 'remote' | null = null
  let lastExistingPR: Awaited<ReturnType<typeof getPRForBranch>> | null = null
  let lastExistingReviewNumber: number | null = null
  const shouldRetireGeneratedName =
    args.nameWasGenerated === true && isGeneratedWorktreeCreateName(sanitizedName)
  const retiredNameRegistry = shouldRetireGeneratedName
    ? await getRetiredNameRegistryForRepo(store, repo, store.getRepos(), settings)
    : null
  const isRetiredName = retiredNameRegistry ? createRetiredNameLookup(retiredNameRegistry) : null
  // Why: a create-from-review branch override may already exist locally; suffix both branch and path instead of blocking the user.
  for (let suffix = 1, attempts = 0; attempts < WORKTREE_CREATE_MAX_SUFFIX_ATTEMPTS; suffix += 1) {
    effectiveSanitizedName = shouldRetireGeneratedName
      ? getGeneratedWorktreeCreateCandidate(
          sanitizedName,
          suffix,
          retiredNameRegistry?.exhaustedTiers
        )
      : getWorktreeCreateCandidate(sanitizedName, suffix)
    effectiveRequestedName = shouldRetireGeneratedName
      ? effectiveSanitizedName
      : requestedName.trim()
        ? getWorktreeCreateCandidate(requestedName, suffix)
        : effectiveSanitizedName
    if (isRetiredName?.(effectiveSanitizedName)) {
      continue
    }
    attempts += 1
    lastExistingReviewNumber = null

    branchName = await resolveCreateBranchName(
      repo.path,
      selectedExistingLocalBranchName
        ? selectedExistingLocalBranchName
        : getBranchNameOverrideCandidate(args.branchNameOverride, suffix),
      effectiveSanitizedName,
      settings,
      username,
      localWorktreeGitOptions
    )
    checkoutExistingBranch = await canCheckoutExistingLocalBranch(
      repo.path,
      branchName,
      baseBranch,
      localWorktreeGitOptions
    )
    if (checkoutExistingBranch && !selectedExistingLocalBranchName) {
      // Why: suffix retries may need a new path, but an existing-branch checkout must keep the user-selected branch, not a sibling.
      selectedExistingLocalBranchName = branchName
    }
    lastBranchConflictKind = checkoutExistingBranch
      ? null
      : await getBranchConflictKind(repo.path, branchName, baseBranch, localWorktreeGitOptions)
    const allowedPushTargetRemoteConflict =
      lastBranchConflictKind &&
      isAllowedPushTargetRemoteConflict(lastBranchConflictKind, branchName, args)
    if (lastBranchConflictKind) {
      if (allowedPushTargetRemoteConflict) {
        lastExistingPR = null
        let lookupFailed = false
        const selectedReview = getSelectedReviewBranch(args)
        if (selectedReview?.provider === 'github') {
          try {
            lastExistingPR = await getLocalGitHubPrForBranch(
              repo.path,
              branchName,
              localWorktreeGitOptions
            )
          } catch {
            lookupFailed = true
          }
          if (!lookupFailed && isMatchingSelectedGitHubPr(lastExistingPR, args, branchName)) {
            lastBranchConflictKind = null
          } else if (lastExistingPR) {
            lastExistingReviewNumber = lastExistingPR.number
          }
        } else if (selectedReview) {
          let hostedReview: Awaited<ReturnType<typeof getSelectedHostedReviewForBranch>> = null
          try {
            hostedReview = await getSelectedHostedReviewForBranch(repo, branchName, args)
          } catch {
            lookupFailed = true
          }
          if (!lookupFailed && hostedReview?.matchesSelected) {
            lastBranchConflictKind = null
          } else if (hostedReview) {
            lastExistingReviewNumber = hostedReview.number
          }
        }
      }
    }
    if (lastBranchConflictKind) {
      continue
    }

    // Why: gh pr list is a ~1–3s network call; only probe PR conflicts after a branch collision (suffix > 1) so the common no-collision path skips it.
    if (suffix > 1 && !checkoutExistingBranch) {
      lastExistingPR = null
      try {
        lastExistingPR = await getLocalGitHubPrForBranch(
          repo.path,
          branchName,
          localWorktreeGitOptions
        )
      } catch {
        // GitHub API may be unreachable, rate-limited, or token missing
      }
      if (lastExistingPR && !isMatchingSelectedGitHubPr(lastExistingPR, args, branchName)) {
        lastExistingReviewNumber = lastExistingPR.number
        continue
      }
    }

    worktreePath = ensurePathWithinWorkspace(
      computeWorktreePath(effectiveSanitizedName, repo.path, worktreePathSettings),
      workspaceRoot
    )
    if (existsSync(worktreePath)) {
      continue
    }

    resolved = true
    break
  }

  if (!resolved) {
    // Why: every suffix collided; reject with a specific reason so the user sees why create failed instead of a generic error or hung spinner.
    if (lastExistingReviewNumber !== null) {
      throw new Error(
        `Branch "${branchName}" already has PR #${lastExistingReviewNumber}. Pick a different ${branchConflictSubject}.`
      )
    }
    if (lastBranchConflictKind) {
      throw new Error(
        `Branch "${branchName}" already exists ${lastBranchConflictKind === 'local' ? 'locally' : 'on a remote'}. Pick a different ${branchConflictSubject}.`
      )
    }
    throw new Error(
      `Could not find an available worktree name for "${sanitizedName}". Pick a different worktree name.`
    )
  }

  assertAttachableParentWorkspace(
    store,
    args.parentWorkspace,
    worktreeWorkspaceKey(`${repo.id}::${worktreePath}`)
  )

  if (remoteTrackingRefresh) {
    await timing.time('refresh_base_ref', async () => {
      const result = await remoteTrackingRefresh.promise
      if (!result.ok && !remoteTrackingRefresh.hadLocalBaseRef) {
        // Why: only block create when the refresh failed AND there's no local base ref; an existing (possibly stale) ref keeps worktree add viable.
        throw new Error(
          `Could not refresh base ref "${baseBranch}" from "${remoteTrackingRefresh.base.remote}". Check your network and try again.`
        )
      }
      if (
        !remoteTrackingRefresh.hadLocalBaseRef &&
        !(await runtime?.hasRemoteTrackingRef(
          repo.path,
          remoteTrackingRefresh.base,
          ...localWorktreeGitOptionArgs
        ))
      ) {
        throw new Error(`Base ref "${baseBranch}" was not found after fetching.`)
      }
    })
  }

  if (legacyFetchPromise) {
    await timing.time('refresh_base_ref', async () => {
      await legacyFetchPromise
    })
  }
  emitCreateWorktreeProgress(mainWindow, 'creating', args.creationId)

  let preparedPushTarget: GitPushTarget | undefined
  if (args.pushTarget) {
    // Why: validate/fetch the contributor remote before create so a failure doesn't leave a half-created worktree with conflicts on retry.
    preparedPushTarget = await prepareWorktreePushTarget(
      repo.path,
      args.pushTarget,
      store,
      repo.id,
      localWorktreeGitOptions
    )
  }

  const suggestLocalBaseRefUpdate =
    !settings.refreshLocalBaseRefOnWorktreeCreate &&
    !settings.localBaseRefSuggestionDismissed &&
    Boolean(remoteTrackingBase)
  const remoteTrackingBaseOption = remoteTrackingBase ? { remoteTrackingBase } : undefined
  const existingBranchOption = {
    checkoutExistingBranch,
    ...remoteTrackingBaseOption,
    ...(suggestLocalBaseRefUpdate ? { suggestLocalBaseRefUpdate } : {})
  }
  let addResult: AddWorktreeResult
  try {
    addResult =
      (await timing.time('git_worktree_add', async () => {
        if (sparseDirectories.length > 0) {
          if (checkoutExistingBranch) {
            return addSparseWorktree(
              repo.path,
              worktreePath,
              branchName,
              sparseDirectories,
              baseBranch,
              settings.refreshLocalBaseRefOnWorktreeCreate,
              addProjectGitOptions(existingBranchOption)
            )
          }
          if (suggestLocalBaseRefUpdate) {
            return addSparseWorktree(
              repo.path,
              worktreePath,
              branchName,
              sparseDirectories,
              baseBranch,
              settings.refreshLocalBaseRefOnWorktreeCreate,
              addProjectGitOptions({ ...remoteTrackingBaseOption, suggestLocalBaseRefUpdate })
            )
          }
          const sparseOptions = addProjectGitOptions(remoteTrackingBaseOption)
          return sparseOptions
            ? addSparseWorktree(
                repo.path,
                worktreePath,
                branchName,
                sparseDirectories,
                baseBranch,
                settings.refreshLocalBaseRefOnWorktreeCreate,
                sparseOptions
              )
            : addSparseWorktree(
                repo.path,
                worktreePath,
                branchName,
                sparseDirectories,
                baseBranch,
                settings.refreshLocalBaseRefOnWorktreeCreate
              )
        }

        if (checkoutExistingBranch) {
          return addWorktree(
            repo.path,
            worktreePath,
            branchName,
            baseBranch,
            settings.refreshLocalBaseRefOnWorktreeCreate,
            false,
            addProjectGitOptions(existingBranchOption)
          )
        }
        if (suggestLocalBaseRefUpdate) {
          return addWorktree(
            repo.path,
            worktreePath,
            branchName,
            baseBranch,
            settings.refreshLocalBaseRefOnWorktreeCreate,
            false,
            addProjectGitOptions({ ...remoteTrackingBaseOption, suggestLocalBaseRefUpdate })
          )
        }
        const worktreeOptions = addProjectGitOptions(remoteTrackingBaseOption)
        return worktreeOptions
          ? addWorktree(
              repo.path,
              worktreePath,
              branchName,
              baseBranch,
              settings.refreshLocalBaseRefOnWorktreeCreate,
              false,
              worktreeOptions
            )
          : addWorktree(
              repo.path,
              worktreePath,
              branchName,
              baseBranch,
              settings.refreshLocalBaseRefOnWorktreeCreate
            )
      })) ?? {}
  } catch (error) {
    if (shouldRetireGeneratedName && failedWorktreeCreationNeedsRetirement(error)) {
      await retireGeneratedWorktreeName(store, repo, settings, effectiveSanitizedName)
    }
    throw error
  }

  // Why: fallible metadata work after creation must not leave a real workspace name reusable.
  if (shouldRetireGeneratedName) {
    await retireGeneratedWorktreeName(store, repo, settings, effectiveSanitizedName)
  }

  let configuredPushTarget: GitPushTarget | undefined
  if (preparedPushTarget) {
    // Why: fork-PR review worktrees publish back to the PR author's branch; set upstream so Push/Sync use the contributor remote, not origin.
    configuredPushTarget = await configureCreatedWorktreePushTarget(
      worktreePath,
      branchName,
      preparedPushTarget,
      localWorktreeGitOptions
    )
  }

  // Re-list to get the freshly created worktree info
  const gitWorktrees = await timing.time('list_created_worktree', async () =>
    hasLocalWorktreeGitOptions
      ? listWorktrees(repo.path, localWorktreeGitOptions)
      : listWorktrees(repo.path)
  )
  // Why: Git may canonicalize a symlinked create path; its exact branch identifies the listed row.
  const created = findCreatedWorktree(gitWorktrees, worktreePath, branchName)
  if (!created) {
    throw new Error('Worktree created but not found in listing')
  }

  const worktreeId = `${repo.id}::${created.path}`
  const now = Date.now()
  // Why: PR/MR worktrees start from a head ref/SHA but Source Control must compare against the review target branch.
  const metadataBaseRef = args.compareBaseRef ?? remoteTrackingBase?.ref ?? baseBranch
  const metaUpdates: Partial<WorktreeMeta> = {
    // Why: path-derived IDs can be reused after external deletion; rotate instance identity so stale lineage can't attach to the new occupant.
    instanceId: randomUUID(),
    ...(store.getProjectHostSetups
      ? getProjectHostSetupWorktreeMeta(store.getProjectHostSetups(), repo)
      : {}),
    // Stamp activity so the worktree sorts into its final position immediately, avoiding a re-sort race with scroll-to-reveal.
    lastActivityAt: now,
    // createdAt protects the new worktree from ambient PTY bumps for CREATE_GRACE_MS (see createRemoteWorktree above).
    createdAt: now,
    orcaCreatedAt: now,
    orcaCreationSource: 'desktop',
    creatorProvenance: { kind: 'host' },
    orcaCreationWorkspaceLayout: getWorktreeCreationLayout(repo, settings),
    ...(args.automationProvenance ? { automationProvenance: args.automationProvenance } : {}),
    ...(args.cliProvenance ? { cliProvenance: args.cliProvenance } : {}),
    baseRef: metadataBaseRef,
    ...(checkoutExistingBranch ? { preserveBranchOnDelete: true } : {}),
    ...(configuredPushTarget ? { pushTarget: configuredPushTarget } : {}),
    ...(requestedDisplayName
      ? { displayName: requestedDisplayName }
      : shouldSetDisplayName(effectiveRequestedName, branchName, effectiveSanitizedName)
        ? { displayName: effectiveRequestedName }
        : {}),
    ...(sparseDirectories.length > 0
      ? {
          sparseDirectories,
          sparseBaseRef: metadataBaseRef,
          sparsePresetId
        }
      : {}),
    ...(isTuiAgent(args.createdWithAgent) ? { createdWithAgent: args.createdWithAgent } : {}),
    ...(args.pendingFirstAgentMessageRename === true && isTuiAgent(args.createdWithAgent)
      ? { pendingFirstAgentMessageRename: true }
      : {}),
    ...(args.linkedIssue !== undefined ? { linkedIssue: args.linkedIssue } : {}),
    ...(args.linkedPR !== undefined ? { linkedPR: args.linkedPR } : {}),
    ...(args.linkedLinearIssue !== undefined ? { linkedLinearIssue: args.linkedLinearIssue } : {}),
    ...(args.linkedLinearIssueWorkspaceId !== undefined
      ? { linkedLinearIssueWorkspaceId: args.linkedLinearIssueWorkspaceId }
      : {}),
    ...(args.linkedLinearIssueOrganizationUrlKey !== undefined
      ? { linkedLinearIssueOrganizationUrlKey: args.linkedLinearIssueOrganizationUrlKey }
      : {}),
    ...(args.manualOrder !== undefined ? { manualOrder: args.manualOrder } : {}),
    ...(args.linkedGitLabIssue !== undefined ? { linkedGitLabIssue: args.linkedGitLabIssue } : {}),
    ...(args.linkedGitLabMR !== undefined ? { linkedGitLabMR: args.linkedGitLabMR } : {}),
    ...(args.linkedBitbucketPR !== undefined ? { linkedBitbucketPR: args.linkedBitbucketPR } : {}),
    ...(args.linkedAzureDevOpsPR !== undefined
      ? { linkedAzureDevOpsPR: args.linkedAzureDevOpsPR }
      : {}),
    ...(args.linkedGiteaPR !== undefined ? { linkedGiteaPR: args.linkedGiteaPR } : {}),
    ...(args.linkedWorkItem !== undefined ? { linkedWorkItem: args.linkedWorkItem } : {}),
    ...(args.linkedTaskSourceContext !== undefined
      ? { linkedTaskSourceContext: args.linkedTaskSourceContext }
      : {}),
    ...(args.workspaceStatus !== undefined ? { workspaceStatus: args.workspaceStatus } : {})
  }
  const { worktree } = timing.timeSync('persist_metadata', () => {
    const meta = store.setWorktreeMeta(worktreeId, metaUpdates)
    return { worktree: mergeWorktree(repo.id, created, meta) }
  })
  const { lineage: worktreeLineage, workspaceLineage } = recordWorkspaceLineageForCreatedWorktree(
    store,
    args,
    worktree,
    now
  )
  // Why: reuse the roots creation already paid for via `git worktree list` so later IPC doesn't lazily rescan and trip macOS privacy prompts.
  registerWorktreeRootsForRepo(store, repo.id, [
    repo.path,
    ...gitWorktrees.map((worktree) => worktree.path)
  ])

  // Why: link user-configured shared paths (e.g. `node_modules`, `.env`) before setup runs so setup scripts see them in place.
  const symlinkPaths = repo.symlinkPaths ?? []
  if (symlinkPaths.length > 0) {
    await timing.time('create_symlinks', async () => {
      await createWorktreeLinkedPaths(repo.path, created.path, symlinkPaths)
    })
  }

  // Why: project-level `orca.yaml` shared directories add to (never replace) the per-user
  // setting, so a repo's shared dirs reach every teammate (issue #10451).
  const sharedDirectories = await timing.time('resolve_shared_directories', () =>
    resolveWorktreeSharedDirectories(repo.path, localWorktreeGitOptions)
  )
  if (sharedDirectories.length > 0) {
    await timing.time('create_shared_directories', async () => {
      await createWorktreeSharedPaths(repo.path, created.path, sharedDirectories)
    })
  }

  // Why: project-level `.worktreeinclude` travels with the repo (issue #7549); copy semantics
  // (never symlink) so each worktree owns its files. Paths already linked above are skipped.
  const includePaths = await timing.time('resolve_worktreeinclude', () =>
    resolveWorktreeIncludePaths(repo.path, localWorktreeGitOptions)
  )
  let includeCopyWarning: string | undefined
  if (includePaths.length > 0) {
    await timing.time('copy_worktreeinclude', async () => {
      const skippedIncludePaths = await createWorktreeCopiedPaths(
        repo.path,
        created.path,
        includePaths
      )
      includeCopyWarning = formatWorktreeIncludeCopyWarning(skippedIncludePaths)
      if (includeCopyWarning) {
        console.warn(`[worktree-include] ${includeCopyWarning}`)
      }
    })
  }

  // Why: the worktree's base-branch `orca.yaml` is authoritative; we don't re-gate on content parity with the primary checkout since benign divergence silently disabled setup (#1280).
  let setup: CreateWorktreeResult['setup']
  let defaultTabs: CreateWorktreeResult['defaultTabs']
  await timing.time('prepare_setup', async () => {
    const createdYamlHooks = loadHooks(worktreePath)
    const createdEffectiveHooks = getEffectiveHooksFromConfig(repo, createdYamlHooks)
    try {
      defaultTabs = getDefaultTabsLaunch(createdYamlHooks, repo, args.setupDecision)
    } catch (error) {
      // Why: default tab commands share setup's run policy; if the target branch adds commands without a renderer decision, create the tabs but don't run them.
      console.warn(`[hooks] default tab commands skipped for ${worktreePath}:`, error)
      defaultTabs = createdYamlHooks?.defaultTabs
        ? { tabs: createdYamlHooks.defaultTabs, runCommands: false }
        : undefined
    }
    const setupScript = createdEffectiveHooks?.scripts.setup
    let shouldLaunchSetup = false
    if (setupScript) {
      try {
        shouldLaunchSetup = shouldRunSetupForCreate(repo, args.setupDecision)
      } catch (error) {
        // Why: target branch may add setup hooks the renderer never collected a decision for; worktree exists, so skip setup rather than fail creation.
        console.warn(`[hooks] setup hook skipped for ${worktreePath}:`, error)
      }
    }
    if (setupScript && shouldLaunchSetup) {
      try {
        // Why: main only writes the runner script and must not execute setup itself, or we reintroduce the old hidden background-hook behavior.
        // Why: worktree already exists, so a runner-gen failure degrades to "created without setup launch" rather than failing creation.
        setup = createSetupRunnerScript(
          repo,
          worktreePath,
          setupScript,
          localWorktreeGitOptionArgs[0],
          resolveSetupRunnerShell(settings),
          createdYamlHooks?.setupAgentStartupPolicy
        )
      } catch (error) {
        console.error(`[hooks] Failed to prepare setup runner for ${worktreePath}:`, error)
      }
    }
  })

  const stagedStartup = await timing.time('spawn_startup_terminal', () =>
    spawnLocalStartupAndSetupTerminals({
      runtime,
      worktree,
      startup: args.startup,
      setup,
      defaultTabs,
      settings,
      createdWithAgent: args.createdWithAgent
    })
  )

  notifyWorktreesChanged(mainWindow, repo.id)
  return {
    worktree: {
      ...worktree,
      workspaceLineage,
      ...(worktreeLineage
        ? { lineage: worktreeLineage, parentWorktreeId: worktreeLineage.parentWorktreeId }
        : {})
    },
    ...(worktreeLineage ? { lineage: worktreeLineage } : {}),
    ...(workspaceLineage ? { workspaceLineage } : {}),
    ...(stagedStartup.activationSetup
      ? { setup: stagedStartup.activationSetup }
      : setup && !stagedStartup.didSpawnSetup
        ? { setup }
        : {}),
    ...(defaultTabs ? { defaultTabs } : {}),
    ...(addResult.localBaseRefRefresh
      ? { localBaseRefRefresh: addResult.localBaseRefRefresh }
      : {}),
    ...(addResult.localBaseRefUpdateSuggestion
      ? { localBaseRefUpdateSuggestion: addResult.localBaseRefUpdateSuggestion }
      : {}),
    ...(stagedStartup.startupTerminal ? { startupTerminal: stagedStartup.startupTerminal } : {}),
    ...(baseFallback ? { baseFallback } : {}),
    ...(stagedStartup.warning
      ? { warning: appendWorktreeCreateWarning(includeCopyWarning, stagedStartup.warning) }
      : includeCopyWarning
        ? { warning: includeCopyWarning }
        : {}),
    timing: timing.finish()
  }
}

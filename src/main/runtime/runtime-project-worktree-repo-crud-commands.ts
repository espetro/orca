import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { DEFAULT_REPO_BADGE_COLOR } from "../../shared/constants";
import {
  parseExecutionHostId,
  type ExecutionHostId,
} from "../../shared/execution-host";
import type { Repo } from "../../shared/repo-types";
import { isFolderRepo } from "../../shared/repo-kind";
import {
  claimCloneTarget,
  cleanupClaimedCloneTarget,
  deriveValidatedClonePath,
  getClonePathComparisonKey,
} from "../git/repo-clone-path";
import { getRepoName, isGitRepo } from "../git/repo";
import {
  awaitWindowsHostGitEnvironmentReady,
  gitExecFileAsync,
  gitSpawnAfterWindowsEnvironmentReady,
  nonInteractiveGitEnv,
} from "../git/runner";
import { runWithGitReadCacheInvalidation } from "../git/status";
import { detectRepoIconAndUpstream } from "../repo-icon-autodetect";
import { prepareLocalWorktreeRootForRepo } from "../worktree-root-preparation";
import { isENOENT } from "../ipc/filesystem-path-containment";
import { invalidateAuthorizedRootsCache } from "../ipc/registered-worktree-roots-cache";
import { runtimePathsEqual } from "./runtime-tail-projection";
import { normalizeSparseDirectories } from "../ipc/sparse-checkout-directories";
import type { RuntimeProjectWorktreeCommandsDeps } from "./runtime-project-worktree-commands";

function normalizeSparsePresetName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error("Preset name is required.");
  }
  if (trimmed.length > 80) {
    throw new Error("Preset name is too long.");
  }
  return trimmed;
}

function normalizeSparsePresetDirectoriesForSave(
  directories: string[],
): string[] {
  let normalized: string[];
  try {
    normalized = normalizeSparseDirectories(directories);
  } catch (err) {
    if (
      err instanceof Error &&
      err.message === "Sparse checkout directories must be repo-relative paths."
    ) {
      throw new Error("Preset directories must be repo-relative paths.");
    }
    throw err;
  }
  if (normalized.length === 0) {
    throw new Error("Preset must have at least one directory.");
  }
  return normalized;
}

export class RuntimeProjectWorktreeRepoCrudCommands {
  private readonly deps: RuntimeProjectWorktreeCommandsDeps;

  constructor(deps: RuntimeProjectWorktreeCommandsDeps) {
    this.deps = deps;
  }

  private get self() {
    return this;
  }

  async listSparsePresets(repoSelector: string) {
    if (!self.deps.store?.getSparsePresets) {
      throw new Error("runtime_unavailable");
    }
    const repo = await self.deps.resolveRepoSelector(repoSelector);
    return self.deps.store.getSparsePresets(repo.id);
  }

  async saveSparsePreset(
    repoSelector: string,
    args: { id?: string; name: string; directories: string[] },
  ) {
    if (
      !self.deps.store?.getSparsePresets ||
      !self.deps.store.saveSparsePreset
    ) {
      throw new Error("runtime_unavailable");
    }
    const repo = await self.deps.resolveRepoSelector(repoSelector);
    const name = normalizeSparsePresetName(args.name);
    const directories = normalizeSparsePresetDirectoriesForSave(
      args.directories,
    );
    const now = Date.now();
    const existing = args.id
      ? self.deps.store
          .getSparsePresets(repo.id)
          .find((preset) => preset.id === args.id)
      : undefined;
    return self.deps.store.saveSparsePreset({
      id: existing?.id ?? randomUUID(),
      repoId: repo.id,
      name,
      directories,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
  }

  async addRepo(
    path: string,
    kind: "git" | "folder" = "git",
    executionHostId?: ExecutionHostId | null,
  ): Promise<Repo> {
    if (!self.deps.store) {
      throw new Error("runtime_unavailable");
    }
    if (!isAbsolute(path)) {
      // Why: remote clients may run in a different cwd than the server. Require
      // server-side repo paths to be explicit so `orca serve` cwd is irrelevant.
      throw new Error("Project path must be an absolute path");
    }
    if (kind === "git") {
      await awaitWindowsHostGitEnvironmentReady({ cwd: path });
    }
    if (kind === "git" && !isGitRepo(path)) {
      throw new Error(`Not a valid git repository: ${path}`);
    }

    const existing = self.deps.store.getRepos().find((repo) => {
      if (!runtimePathsEqual(repo.path, path)) {
        return false;
      }
      return runtimeRepoMatchesExecutionHost(repo, executionHostId);
    });
    if (existing) {
      // Only a runtime host backfills a legacy unstamped repo. An unstamped repo is
      // indistinguishable from a genuine local repo (both have null executionHostId and
      // connectionId), so we never stamp local/ssh onto it — that would re-attribute a
      // real local project to the wrong host. Runtime is the only host that lost its
      // identity to the pre-#7018 path-only import and needs the backfill.
      if (
        existing.executionHostId == null &&
        parseExecutionHostId(executionHostId)?.kind === "runtime"
      ) {
        const adopted =
          self.deps.store.updateRepo(existing.id, { executionHostId }) ??
          ({ ...existing, executionHostId } as Repo);
        self.deps.invalidateResolvedWorktreeCache();
        self.deps.invalidateWorktreeScanCacheForRepo(existing.id);
        self.deps.notifyReposChanged();
        return adopted;
      }
      return existing;
    }

    const detected = await detectRepoIconAndUpstream({ repoPath: path, kind });
    const repo: Repo = {
      id: randomUUID(),
      path,
      displayName: getRepoName(path),
      badgeColor: DEFAULT_REPO_BADGE_COLOR,
      ...(executionHostId != null ? { executionHostId } : {}),
      ...detected,
      addedAt: Date.now(),
      kind,
      ...(kind === "git" ? { externalWorktreeVisibilityLegacy: false } : {}),
    };
    self.deps.store.addRepo(repo);
    await prepareLocalWorktreeRootForRepo(self.deps.store, repo);
    self.deps.invalidateResolvedWorktreeCache();
    self.deps.invalidateWorktreeScanCacheForRepo(repo.id);
    self.deps.notifyReposChanged();
    return self.deps.store.getRepo(repo.id) ?? repo;
  }

  async createRepo(
    parentPath: string,
    name: string,
    kind: "git" | "folder" = "git",
  ): Promise<{ repo: Repo } | { error: string }> {
    if (!self.deps.store) {
      throw new Error("runtime_unavailable");
    }
    const trimmedName = name.trim();
    const trimmedParentPath = parentPath.trim();
    const repoKind: "git" | "folder" = kind === "folder" ? "folder" : "git";
    if (!trimmedName) {
      return { error: "Name cannot be empty" };
    }
    if (
      /[\\/]/.test(trimmedName) ||
      trimmedName === "." ||
      trimmedName === ".."
    ) {
      return { error: 'Name cannot contain slashes or be "." / ".."' };
    }
    if (!trimmedParentPath) {
      return { error: "Parent directory is required" };
    }
    if (!isAbsolute(trimmedParentPath)) {
      return { error: "Parent directory must be an absolute path" };
    }

    const targetPath = join(trimmedParentPath, trimmedName);
    const existing = self.deps.store
      .getRepos()
      .find((repo) => runtimePathsEqual(repo.path, targetPath));
    if (existing) {
      return { repo: existing };
    }

    let createdDir = false;
    try {
      // Why: default create-project parents are host-home based and may not exist
      // before the first project is created on a fresh runtime.
      await mkdir(trimmedParentPath, { recursive: true });
      const existingStat = await stat(targetPath).catch((error: unknown) => {
        if (isENOENT(error)) {
          return null;
        }
        throw error;
      });
      if (existingStat) {
        if (!existingStat.isDirectory()) {
          return {
            error: `"${trimmedName}" already exists at this location and is not a folder.`,
          };
        }
        const entries = await readdir(targetPath);
        if (entries.length > 0) {
          return {
            error: `"${trimmedName}" already exists at this location and is not empty.`,
          };
        }
      } else {
        await mkdir(targetPath, { recursive: false });
        createdDir = true;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { error: `Failed to prepare directory: ${message}` };
    }

    if (repoKind === "git") {
      let step: "init" | "commit" = "init";
      try {
        await gitExecFileAsync(["init"], { cwd: targetPath });
        step = "commit";
        await gitExecFileAsync(
          ["commit", "--allow-empty", "-m", "Initial commit"],
          {
            cwd: targetPath,
          },
        );
      } catch (error) {
        if (createdDir) {
          await rm(targetPath, { recursive: true, force: true }).catch(
            () => {},
          );
        } else if (step === "commit") {
          await rm(join(targetPath, ".git"), {
            recursive: true,
            force: true,
          }).catch(() => {});
        }
        const message = error instanceof Error ? error.message : String(error);
        if (
          step === "commit" &&
          /Please tell me who you are|user\.name|user\.email/i.test(message)
        ) {
          return {
            error:
              'Git author identity is not configured. Run `git config --global user.name "Your Name"` and `git config --global user.email "you@example.com"`, then try again.',
          };
        }
        const stepLabel =
          step === "init"
            ? "Failed to initialize git repository"
            : "Failed to create initial commit";
        return { error: `${stepLabel}: ${message}` };
      }
    }

    const raceWinner = self.deps.store
      .getRepos()
      .find((repo) => runtimePathsEqual(repo.path, targetPath));
    if (raceWinner) {
      return { repo: raceWinner };
    }

    const detected = await detectRepoIconAndUpstream({
      repoPath: targetPath,
      kind: repoKind,
    });
    const repo: Repo = {
      id: randomUUID(),
      path: targetPath,
      displayName: trimmedName,
      badgeColor: DEFAULT_REPO_BADGE_COLOR,
      ...detected,
      addedAt: Date.now(),
      kind: repoKind,
      ...(repoKind === "git"
        ? { externalWorktreeVisibilityLegacy: false }
        : {}),
    };
    self.deps.store.addRepo(repo);
    await prepareLocalWorktreeRootForRepo(self.deps.store, repo);
    invalidateAuthorizedRootsCache();
    self.deps.invalidateResolvedWorktreeCache();
    self.deps.invalidateWorktreeScanCacheForRepo(repo.id);
    self.deps.notifyReposChanged();
    return { repo: self.deps.store.getRepo(repo.id) ?? repo };
  }

  async cloneRepo(
    url: string,
    destination: string,
    executionHostId?: ExecutionHostId | null,
  ): Promise<Repo> {
    if (!self.deps.store) {
      throw new Error("runtime_unavailable");
    }
    const trimmedUrl = url.trim();
    const trimmedDestination = destination.trim();
    if (!trimmedDestination) {
      throw new Error("Clone destination is required");
    }
    const clonePath = deriveValidatedClonePath({
      url: trimmedUrl,
      destination: trimmedDestination,
    });
    const clonePathKey = getClonePathComparisonKey(clonePath);
    const previous =
      self.deps.cloneInFlightByPath.get(clonePathKey) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(
      () => current,
      () => current,
    );
    self.deps.cloneInFlightByPath.set(clonePathKey, tail);

    try {
      await previous;
      return await runWithGitReadCacheInvalidation(() =>
        self.cloneRepoAfterPathLock(
          trimmedUrl,
          trimmedDestination,
          clonePath,
          clonePathKey,
          executionHostId,
        ),
      );
    } finally {
      release();
      if (self.deps.cloneInFlightByPath.get(clonePathKey) === tail) {
        self.deps.cloneInFlightByPath.delete(clonePathKey);
      }
    }
  }

  private async cloneRepoAfterPathLock(
    trimmedUrl: string,
    trimmedDestination: string,
    clonePath: string,
    clonePathKey: string,
    executionHostId?: ExecutionHostId | null,
  ): Promise<Repo> {
    if (!self.deps.store) {
      throw new Error("runtime_unavailable");
    }
    const existingBeforeClone = self.deps.store
      .getRepos()
      .find(
        (repo) =>
          getClonePathComparisonKey(repo.path) === clonePathKey &&
          runtimeRepoMatchesExecutionHost(repo, executionHostId),
      );
    if (existingBeforeClone && !isFolderRepo(existingBeforeClone)) {
      return existingBeforeClone;
    }

    await mkdir(trimmedDestination, { recursive: true });
    const claimedTarget = await claimCloneTarget(clonePath);
    let proc: Awaited<ReturnType<typeof gitSpawnAfterWindowsEnvironmentReady>>;
    try {
      proc = await gitSpawnAfterWindowsEnvironmentReady(
        ["clone", "--progress", "--", trimmedUrl, clonePath],
        {
          cwd: trimmedDestination,
          // Why: without the non-interactive guard, a clone that needs GitHub
          // auth makes Git Credential Manager pop its "Connect to GitHub" OAuth
          // window on Windows; in a network-restricted env the browser/device
          // flow can never complete and git's credential retry re-pops it
          // (issue #7652). Fail fast with a clear error instead.
          env: nonInteractiveGitEnv(),
          stdio: ["ignore", "ignore", "pipe"],
        },
      );
    } catch (err) {
      await cleanupClaimedCloneTarget(clonePath, claimedTarget);
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Clone failed: ${message}`);
    }
    await new Promise<void>((resolve, reject) => {
      let stderrTail = "";
      let settled = false;
      proc.stderr?.on("data", (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString()).slice(-4096);
      });
      const finishClone = async (
        code: number | null,
        signal: NodeJS.Signals | null,
        error?: Error,
      ) => {
        if (settled) {
          return;
        }
        settled = true;
        const cloneSucceeded = !error && code === 0 && !signal;
        if (!cloneSucceeded) {
          await cleanupClaimedCloneTarget(clonePath, claimedTarget);
        }

        if (error) {
          reject(new Error(`Clone failed: ${error.message}`));
        } else if (signal === "SIGTERM") {
          reject(new Error("Clone aborted"));
        } else if (code === 0) {
          resolve();
        } else {
          reject(
            new Error(
              `Clone failed: ${getGitCloneFailureMessage(stderrTail, { clonePath })}`,
            ),
          );
        }
      };
      proc.on("error", (error) => {
        void finishClone(null, null, error);
      });
      proc.on("close", (code, signal) => {
        void finishClone(code, signal);
      });
    });

    const existing = self.deps.store
      .getRepos()
      .find(
        (repo) =>
          getClonePathComparisonKey(repo.path) === clonePathKey &&
          runtimeRepoMatchesExecutionHost(repo, executionHostId),
      );
    if (existing) {
      if (isFolderRepo(existing)) {
        const updated = self.deps.store.updateRepo(existing.id, {
          kind: "git",
        });
        if (updated) {
          await prepareLocalWorktreeRootForRepo(self.deps.store, updated);
          invalidateAuthorizedRootsCache();
          self.deps.invalidateResolvedWorktreeCache();
          self.deps.invalidateWorktreeScanCacheForRepo(updated.id);
          self.deps.notifyReposChanged();
          return updated;
        }
      }
      return existing;
    }

    const detected = await detectRepoIconAndUpstream({
      repoPath: clonePath,
      kind: "git",
    });
    const repo: Repo = {
      id: randomUUID(),
      path: clonePath,
      displayName: getRepoName(clonePath),
      badgeColor: DEFAULT_REPO_BADGE_COLOR,
      ...(executionHostId != null ? { executionHostId } : {}),
      ...detected,
      addedAt: Date.now(),
      kind: "git",
      externalWorktreeVisibilityLegacy: false,
    };
    self.deps.store.addRepo(repo);
    await prepareLocalWorktreeRootForRepo(self.deps.store, repo);
    invalidateAuthorizedRootsCache();
    self.deps.invalidateResolvedWorktreeCache();
    self.deps.invalidateWorktreeScanCacheForRepo(repo.id);
    self.deps.notifyReposChanged();
    return self.deps.store.getRepo(repo.id) ?? repo;
  }
}

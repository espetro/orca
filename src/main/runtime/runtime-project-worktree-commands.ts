import type { Store } from "../persistence";
import type { FolderWorkspace } from "../../shared/folder-workspace-types";
import type { ProjectGroup } from "../../shared/project-group-types";
import { getProjectHostSetupForRepo } from "../../shared/project-host-setup-lookup";
import { getProjectIdForProviderIdentity } from "../../shared/project-host-setup-projection";
import type {
  Project,
  ProjectHostSetup,
  ProjectHostSetupCloneArgs,
  ProjectHostSetupCreateArgs,
  ProjectHostSetupCreateResult,
  ProjectHostSetupDeleteArgs,
  ProjectHostSetupDeleteResult,
  ProjectHostSetupExistingFolderArgs,
  ProjectHostSetupResult,
  ProjectHostSetupUpdateArgs,
  ProjectHostSetupUpdateResult,
  ProjectUpdateArgs,
} from "../../shared/project-types";
import type { Repo } from "../../shared/repo-types";
import { enrichMissingRepoGitRemoteIdentities } from "../repo-git-remote-identity-enrichment";
import { prepareLocalWorktreeRootForRepo } from "../worktree-root-preparation";
import { invalidateAuthorizedRootsCache } from "../ipc/registered-worktree-roots-cache";

type RuntimeProjectWorktreeCommandsDeps = {
  store: Pick<
    Store,
    | "addRepo"
    | "createFolderWorkspace"
    | "createProjectGroup"
    | "createProjectHostSetup"
    | "deleteProjectGroup"
    | "deleteProjectHostSetup"
    | "getFolderWorkspaces"
    | "getProjectGroups"
    | "getProjectHostSetups"
    | "getProjects"
    | "getRepo"
    | "getRepos"
    | "getSparsePresets"
    | "moveProjectToGroup"
    | "removeFolderWorkspace"
    | "removeProject"
    | "saveSparsePreset"
    | "updateFolderWorkspace"
    | "updateProject"
    | "updateProjectGroup"
    | "updateProjectHostSetup"
    | "updateRepo"
  > | null;
  notifyReposChanged: () => void;
  invalidateResolvedWorktreeCache: () => void;
  invalidateWorktreeScanCacheForRepo: (repoId: string) => void;
  listProjectHostSetups: () => ProjectHostSetup[];
  resolveRepoSelector: (selector: string) => Promise<Repo>;
  cloneInFlightByPath: Map<string, Promise<void>>;
};

export class RuntimeProjectWorktreeCommands {
  private readonly deps: RuntimeProjectWorktreeCommandsDeps;
  private readonly onRepoGitRemoteIdentitiesChanged: () => void;
  private readonly projectWorkspaceCommands: RuntimeProjectWorktreeProjectWorkspaceCommands;
  private readonly repoCrudCommands: RuntimeProjectWorktreeRepoCrudCommands;

  constructor(deps: RuntimeProjectWorktreeCommandsDeps) {
    this.deps = deps;
    this.projectWorkspaceCommands =
      new RuntimeProjectWorktreeProjectWorkspaceCommands(deps);
    this.repoCrudCommands = new RuntimeProjectWorktreeRepoCrudCommands(deps);
    // Why a stable callback identity: enrichment dedupes coalesced callers by callback identity,
    // so a fresh closure per call would stack up for the length of a slow sweep.
    this.onRepoGitRemoteIdentitiesChanged = () => {
      this.deps.invalidateResolvedWorktreeCache();
      this.deps.notifyReposChanged();
    };
  }

  private get self() {
    return this;
  }

  listRepos(): Repo[] {
    return self.deps.store?.getRepos() ?? [];
  }

  // Why a stable field and not a per-call closure: enrichment dedupes coalesced callers by callback
  // identity, so a fresh closure per call would stack up for the length of a slow sweep.

  enrichMissingRepoGitRemoteIdentities(): void {
    if (!self.deps.store) {
      return;
    }
    enrichMissingRepoGitRemoteIdentities(self.deps.store, {
      onChanged: this.onRepoGitRemoteIdentitiesChanged,
    });
  }

  listProjects(): Project[] {
    return self.deps.store?.getProjects?.() ?? [];
  }

  updateProject(
    projectId: string,
    updates: ProjectUpdateArgs["updates"],
  ): Project {
    if (!self.deps.store?.updateProject) {
      throw new Error("runtime_unavailable");
    }
    const project = self.deps.store.updateProject(projectId, updates);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }
    self.deps.invalidateResolvedWorktreeCache();
    self.deps.notifyReposChanged();
    return project;
  }

  listProjectHostSetups(): ProjectHostSetup[] {
    return self.deps.store?.getProjectHostSetups?.() ?? [];
  }

  createProjectHostSetup(
    args: ProjectHostSetupCreateArgs,
  ): ProjectHostSetupCreateResult {
    if (!self.deps.store?.createProjectHostSetup) {
      throw new Error("runtime_unavailable");
    }
    const result = self.deps.store.createProjectHostSetup(args);
    if (!result) {
      throw new Error(`Project not found: ${args.projectId}`);
    }
    return result;
  }

  async setupProjectExistingFolder(
    args: ProjectHostSetupExistingFolderArgs,
  ): Promise<ProjectHostSetupResult> {
    if (!self.deps.store) {
      throw new Error("runtime_unavailable");
    }
    assertProjectHostSetupHostIsSupported(args.hostId);
    const knownRepoIds = new Set(self.listRepos().map((repo) => repo.id));
    const repo = await self.addRepo(
      args.path,
      args.kind === "folder" ? "folder" : "git",
      args.hostId,
    );
    return self.completeProjectHostSetup(
      args,
      repo,
      !knownRepoIds.has(repo.id),
    );
  }

  async setupProjectClone(
    args: ProjectHostSetupCloneArgs,
  ): Promise<ProjectHostSetupResult> {
    // Why: guard before cloneRepo, which would otherwise clone to the local disk.
    assertProjectHostSetupHostIsSupported(args.hostId);
    const knownRepoIds = new Set(self.listRepos().map((repo) => repo.id));
    const repo = await self.cloneRepo(args.url, args.destination, args.hostId);
    return self.completeProjectHostSetup(
      { ...args, path: repo.path, kind: "git", setupMethod: "cloned" },
      repo,
      !knownRepoIds.has(repo.id),
    );
  }

  private completeProjectHostSetup(
    args: ProjectHostSetupExistingFolderArgs,
    initialRepo: Repo,
    repoWasCreated: boolean,
  ): ProjectHostSetupResult {
    try {
      return self.linkRepoToProjectHostSetup(args, initialRepo);
    } catch (err) {
      if (repoWasCreated) {
        // Why: a failed link must not leave a new repo registration or stale host caches behind.
        self.deps.store?.removeProject?.(initialRepo.id);
        self.deps.invalidateResolvedWorktreeCache();
        self.deps.invalidateWorktreeScanCacheForRepo(initialRepo.id);
        invalidateAuthorizedRootsCache();
        self.deps.notifyReposChanged();
      }
      throw err;
    }
  }

  private linkRepoToProjectHostSetup(
    args: ProjectHostSetupExistingFolderArgs,
    initialRepo: Repo,
  ): ProjectHostSetupResult {
    if (!self.deps.store) {
      throw new Error("runtime_unavailable");
    }
    let repo = initialRepo;
    let setup = getProjectHostSetupForRepo(
      self.deps.listProjectHostSetups(),
      repo,
    );
    if (setup.projectId !== args.projectId) {
      const existingProject = self
        .listProjects()
        .find((project) => project.id === args.projectId);
      // Why: the selected project can exist only on the source host, so its structured identity travels with the request.
      const identity =
        existingProject?.providerIdentity ?? args.projectProviderIdentity;
      if (
        !identity ||
        getProjectIdForProviderIdentity(identity) !== args.projectId
      ) {
        throw new Error(
          "Imported folder does not match the selected project identity.",
        );
      }
      const updated = self.deps.store.updateRepo(repo.id, {
        upstream: {
          owner: identity.owner,
          repo: identity.repo,
          ...(identity.host ? { host: identity.host } : {}),
        },
      });
      if (!updated) {
        throw new Error(
          `Project setup repo disappeared before it could be linked: ${repo.id}`,
        );
      }
      repo = updated;
      setup = getProjectHostSetupForRepo(
        self.deps.listProjectHostSetups(),
        repo,
      );
    }
    const setupMethod = args.setupMethod ?? "imported-existing-folder";
    const updated = self.deps.store.updateRepo(repo.id, {
      projectHostSetupMethod: setupMethod,
    });
    if (!updated) {
      throw new Error(
        `Project setup repo disappeared before setup metadata could be linked: ${repo.id}`,
      );
    }
    repo = updated;
    setup = getProjectHostSetupForRepo(self.deps.listProjectHostSetups(), repo);
    const project = self
      .listProjects()
      .find((entry) => entry.id === setup.projectId);
    if (!project) {
      throw new Error(
        `Project setup was created without a project record: ${setup.projectId}`,
      );
    }
    return { project, setup, repo };
  }

  updateProjectHostSetup(
    args: ProjectHostSetupUpdateArgs,
  ): ProjectHostSetupUpdateResult {
    if (!self.deps.store?.updateProjectHostSetup) {
      throw new Error("runtime_unavailable");
    }
    const result = self.deps.store.updateProjectHostSetup(args);
    if (!result) {
      throw new Error(`Project host setup not found: ${args.setupId}`);
    }
    if ("worktreeBasePath" in args.updates && result.repo) {
      void prepareLocalWorktreeRootForRepo(self.deps.store, result.repo);
      invalidateAuthorizedRootsCache();
    }
    return result;
  }

  deleteProjectHostSetup(
    args: ProjectHostSetupDeleteArgs,
  ): ProjectHostSetupDeleteResult {
    if (!self.deps.store?.deleteProjectHostSetup) {
      throw new Error("runtime_unavailable");
    }
    const result = self.deps.store.deleteProjectHostSetup(args);
    if (!result) {
      throw new Error(`Project host setup not found: ${args.setupId}`);
    }
    return result;
  }

  listProjectGroups(): ProjectGroup[] {
    return self.deps.store?.getProjectGroups?.() ?? [];
  }

  listFolderWorkspaces(): FolderWorkspace[] {
    return self.deps.store?.getFolderWorkspaces?.() ?? [];
  }

  async createProjectGroup(input: {
    name: string;
    parentPath?: string | null;
    connectionId?: string | null;
    parentGroupId?: string | null;
    createdFrom?: ProjectGroup["createdFrom"];
  }): Promise<ProjectGroup> {
    if (!self.deps.store?.createProjectGroup) {
      throw new Error("runtime_unavailable");
    }
    const group = self.deps.store.createProjectGroup({
      name: input.name,
      parentPath: input.parentPath ?? null,
      connectionId: input.connectionId ?? null,
      parentGroupId: input.parentGroupId ?? null,
      createdFrom: input.createdFrom ?? "manual",
    });
    self.deps.notifyReposChanged();
    return group;
  }

  async updateProjectGroup(
    groupId: string,
    updates: Partial<
      Pick<ProjectGroup, "name" | "isCollapsed" | "tabOrder" | "color">
    >,
  ): Promise<ProjectGroup | null> {
    if (!self.deps.store?.updateProjectGroup) {
      throw new Error("runtime_unavailable");
    }
    const updated = self.deps.store.updateProjectGroup(groupId, updates);
    if (updated) {
      self.deps.notifyReposChanged();
    }
    return updated;
  }
}

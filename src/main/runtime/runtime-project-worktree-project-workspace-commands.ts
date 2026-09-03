import { readdir, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { DEFAULT_REPO_BADGE_COLOR } from "../../shared/constants";
import type {
  DirEntry,
  FilesystemPathFlavor,
} from "../../shared/filesystem-entry-types";
import type {
  FolderWorkspacePathStatus,
  FolderWorkspacePathStatusRequest,
} from "../../shared/folder-workspace-path-status";
import type { FolderWorkspace } from "../../shared/folder-workspace-types";
import { sortDirEntries } from "../../shared/file-name-sort";
import type {
  NestedRepoScanResult,
  ProjectGroupImportMode,
  ProjectGroupImportResult,
} from "../../shared/project-group-types";
import type { Repo } from "../../shared/repo-types";
import {
  assertFolderWorkspacePathUsable,
  getFolderWorkspacePathStatus,
  getFolderWorkspacePathStatusForPath,
} from "../project-groups/folder-workspace-path-status";
import { scanNestedRepos } from "../project-groups/nested-repo-discovery";
import {
  createNestedProjectGroupResolver,
  resolveNestedRepoSelection,
} from "../project-groups/nested-repo-import";
import { createNestedRepoImportTargetResolver } from "../project-groups/nested-repo-import-target";
import { getRepoName, isGitRepo } from "../git/repo";
import {
  awaitWindowsHostGitEnvironmentReady,
  gitExecFileAsync,
} from "../git/runner";
import { getSshFilesystemProvider } from "../providers/ssh-filesystem-dispatch";
import {
  isServerDriveListRequest,
  listWindowsDrives,
} from "./windows-drive-listing";
import type { RuntimeProjectWorktreeCommandsDeps } from "./runtime-project-worktree-commands";

function sanitizeNestedRepoRuntimeImportError(
  context: string,
  error: unknown,
): string {
  console.warn(`[project-groups] ${context}`, error);
  return "Repository could not be imported";
}

export class RuntimeProjectWorktreeProjectWorkspaceCommands {
  private readonly deps: RuntimeProjectWorktreeCommandsDeps;

  constructor(deps: RuntimeProjectWorktreeCommandsDeps) {
    this.deps = deps;
  }

  private get self() {
    return this;
  }

  async deleteProjectGroup(groupId: string): Promise<{ deleted: boolean }> {
    if (!self.deps.store?.deleteProjectGroup) {
      throw new Error("runtime_unavailable");
    }
    const deleted = self.deps.store.deleteProjectGroup(groupId);
    if (deleted) {
      self.deps.notifyReposChanged();
    }
    return { deleted };
  }

  async moveProjectToGroup(
    repoSelector: string,
    groupId: string | null,
    order?: number,
  ): Promise<Repo> {
    if (!self.deps.store?.moveProjectToGroup) {
      throw new Error("runtime_unavailable");
    }
    const repo = await self.deps.resolveRepoSelector(repoSelector);
    const moved = self.deps.store.moveProjectToGroup(repo.id, groupId, order);
    if (!moved) {
      throw new Error("repo_not_found");
    }
    self.deps.notifyReposChanged();
    return moved;
  }

  async createFolderWorkspace(input: {
    projectGroupId: string;
    name?: string;
    folderPath?: string | null;
    connectionId?: string | null;
    creatorProvenance?: FolderWorkspace["creatorProvenance"];
    linkedTask?: FolderWorkspace["linkedTask"];
    linkedTaskSourceContext?: FolderWorkspace["linkedTaskSourceContext"];
    createdWithAgent?: FolderWorkspace["createdWithAgent"];
    pendingFirstAgentMessageRename?: boolean;
  }): Promise<FolderWorkspace> {
    if (!self.deps.store?.createFolderWorkspace) {
      throw new Error("runtime_unavailable");
    }
    const projectGroups = self.deps.store.getProjectGroups?.() ?? [];
    const group = projectGroups.find(
      (entry) => entry.id === input.projectGroupId,
    );
    const folderPath =
      typeof input.folderPath === "string" && input.folderPath.trim().length > 0
        ? input.folderPath
        : group?.parentPath;
    if (!group || !folderPath) {
      throw new Error("folder_workspace_project_group_not_found");
    }
    const status = await getFolderWorkspacePathStatusForPath(
      {
        folderPath,
        projectGroupId: group.id,
        connectionId: input.connectionId ?? group.connectionId ?? null,
        projectGroups,
        repos: self.deps.store.getRepos(),
      },
      { getSshFilesystemProvider },
    );
    assertFolderWorkspacePathUsable(status);
    const workspace = self.deps.store.createFolderWorkspace({
      ...input,
      creatorProvenance: input.creatorProvenance ?? { kind: "host" },
    });
    self.deps.notifyReposChanged();
    return workspace;
  }

  async getFolderWorkspacePathStatus(
    request: FolderWorkspacePathStatusRequest,
  ): Promise<FolderWorkspacePathStatus> {
    if (!self.deps.store) {
      throw new Error("runtime_unavailable");
    }
    return getFolderWorkspacePathStatus(self.deps.store, request, {
      getSshFilesystemProvider,
    });
  }

  async updateFolderWorkspace(
    folderWorkspaceId: string,
    updates: Partial<
      Pick<
        FolderWorkspace,
        | "name"
        | "folderPath"
        | "linkedTask"
        | "linkedTaskSourceContext"
        | "comment"
        | "isArchived"
        | "isUnread"
        | "isPinned"
        | "sortOrder"
        | "manualOrder"
        | "workspaceStatus"
        | "createdWithAgent"
        | "pendingFirstAgentMessageRename"
        | "firstAgentMessageRenameError"
        | "lastActivityAt"
        | "diffComments"
      >
    >,
  ): Promise<FolderWorkspace | null> {
    if (!self.deps.store?.updateFolderWorkspace) {
      throw new Error("runtime_unavailable");
    }
    if (
      typeof updates.folderPath === "string" &&
      updates.folderPath.trim().length > 0
    ) {
      const workspace = self.deps.store
        .getFolderWorkspaces?.()
        .find((entry) => entry.id === folderWorkspaceId);
      if (!workspace) {
        return null;
      }
      const projectGroups = self.deps.store.getProjectGroups?.() ?? [];
      const status = await getFolderWorkspacePathStatusForPath(
        {
          folderPath: updates.folderPath,
          projectGroupId: workspace.projectGroupId,
          connectionId:
            workspace.connectionId ??
            projectGroups.find((entry) => entry.id === workspace.projectGroupId)
              ?.connectionId ??
            null,
          projectGroups,
          repos: self.deps.store.getRepos(),
        },
        { getSshFilesystemProvider },
      );
      assertFolderWorkspacePathUsable(status);
    }
    const updated = self.deps.store.updateFolderWorkspace(
      folderWorkspaceId,
      updates,
    );
    if (updated) {
      self.deps.notifyReposChanged();
    }
    return updated;
  }

  async deleteFolderWorkspace(
    folderWorkspaceId: string,
  ): Promise<{ deleted: boolean }> {
    if (!self.deps.store?.removeFolderWorkspace) {
      throw new Error("runtime_unavailable");
    }
    const deleted = self.deps.store.removeFolderWorkspace(folderWorkspaceId);
    if (deleted) {
      self.deps.notifyReposChanged();
    }
    return { deleted };
  }

  async scanNestedRepos(path: string): Promise<NestedRepoScanResult> {
    if (!isAbsolute(path)) {
      throw new Error("Project path must be an absolute path");
    }
    await awaitWindowsHostGitEnvironmentReady({ cwd: path });
    return scanNestedRepos({ path, options: { timeoutMs: 15_000 } });
  }

  async browseServerDir(pathValue: string): Promise<{
    resolvedPath: string;
    entries: DirEntry[];
    pathFlavor: FilesystemPathFlavor;
  }> {
    // Windows resolves `/` to the current drive, so expose drive roots instead.
    if (isServerDriveListRequest(pathValue)) {
      return listWindowsDrives();
    }
    const dirPath = resolveServerBrowsePath(pathValue);
    const dirStat = await stat(dirPath);
    if (!dirStat.isDirectory()) {
      throw new Error(`${dirPath} is not a directory`);
    }
    const entries = await readdir(dirPath, { withFileTypes: true });
    const mapped = entries
      .filter((entry) => entry.name !== "." && entry.name !== "..")
      .map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
        isSymlink: entry.isSymbolicLink(),
      }));
    sortDirEntries(mapped);
    return {
      resolvedPath: dirPath,
      entries: mapped,
      pathFlavor: process.platform === "win32" ? "win32" : "posix",
    };
  }

  async isGitAvailable(): Promise<boolean> {
    try {
      await gitExecFileAsync(["--version"], {
        cwd: process.cwd(),
        timeout: 3000,
      });
      return true;
    } catch {
      return false;
    }
  }

  async importNestedRepos(args: {
    parentPath: string;
    groupName: string;
    projectPaths: string[];
    mode: ProjectGroupImportMode;
  }): Promise<ProjectGroupImportResult> {
    await awaitWindowsHostGitEnvironmentReady({ cwd: args.parentPath });
    if (
      !self.deps.store?.createProjectGroup ||
      !self.deps.store?.moveProjectToGroup
    ) {
      throw new Error("runtime_unavailable");
    }
    if (!isAbsolute(args.parentPath)) {
      throw new Error("Project path must be an absolute path");
    }
    const scan = await scanNestedRepos({
      path: args.parentPath,
      options: { timeoutMs: 15_000 },
    });
    const selection = resolveNestedRepoSelection({
      scan,
      projectPaths: args.projectPaths,
    });
    const groupResolver = createNestedProjectGroupResolver({
      parentPath: args.parentPath,
      groupName: args.groupName,
      mode: args.mode,
      connectionId: null,
      repoPaths: selection.selectedPaths,
      createGroup: (input) => self.deps.store!.createProjectGroup!(input),
    });
    const results: ProjectGroupImportResult["projects"] =
      selection.rejectedPaths.map((repoPath) => ({
        path: repoPath,
        status: "failed",
        error: "Repository was not found in the nested repo scan result",
      }));
    const importedProjectIdsByRepoPath = new Map<string, string>();
    const importTargetResolver = createNestedRepoImportTargetResolver();
    for (const [
      projectGroupOrder,
      repoPath,
    ] of selection.selectedPaths.entries()) {
      try {
        await awaitWindowsHostGitEnvironmentReady({ cwd: repoPath });
        if (!isGitRepo(repoPath)) {
          results.push({
            path: repoPath,
            status: "failed",
            error: "Not a valid git repository",
          });
          continue;
        }
        const importRepoPath =
          await importTargetResolver.resolveLocal(repoPath);
        const normalizedImportRepoPath =
          normalizeRuntimePathForComparison(importRepoPath);
        const alreadyImportedProjectId = importedProjectIdsByRepoPath.get(
          normalizedImportRepoPath,
        );
        if (alreadyImportedProjectId) {
          results.push({
            path: repoPath,
            projectId: alreadyImportedProjectId,
            status: "already-known",
          });
          continue;
        }
        const existing = self.deps.store
          .getRepos()
          .find(
            (repo) =>
              normalizeRuntimePathForComparison(repo.path) ===
              normalizedImportRepoPath,
          );
        const group = groupResolver.getGroupForRepo(repoPath);
        if (existing) {
          if (group) {
            self.deps.store.moveProjectToGroup(
              existing.id,
              group.id,
              projectGroupOrder,
            );
          }
          importedProjectIdsByRepoPath.set(
            normalizedImportRepoPath,
            existing.id,
          );
          results.push({
            path: repoPath,
            projectId: existing.id,
            status: "already-known",
          });
          continue;
        }
        const repo: Repo = {
          id: randomUUID(),
          path: importRepoPath,
          displayName: getRepoName(importRepoPath),
          badgeColor: DEFAULT_REPO_BADGE_COLOR,
          addedAt: Date.now(),
          kind: "git",
          externalWorktreeVisibilityLegacy: false,
          ...(group
            ? {
                projectGroupId: group.id,
                projectGroupOrder,
              }
            : {}),
        };
        self.deps.store.addRepo(repo);
        importedProjectIdsByRepoPath.set(normalizedImportRepoPath, repo.id);
        results.push({
          path: repoPath,
          projectId: repo.id,
          status: "imported",
        });
      } catch (error) {
        results.push({
          path: repoPath,
          status: "failed",
          error: sanitizeNestedRepoRuntimeImportError(
            "Failed to import nested repository in runtime",
            error,
          ),
        });
      }
    }
    const importedCount = results.filter(
      (entry) => entry.status === "imported",
    ).length;
    const alreadyKnownCount = results.filter(
      (entry) => entry.status === "already-known",
    ).length;
    const failedCount = results.filter(
      (entry) => entry.status === "failed",
    ).length;
    if (importedCount + alreadyKnownCount === 0) {
      for (const group of groupResolver.getCreatedGroups().toReversed()) {
        self.deps.store.deleteProjectGroup?.(group.id);
      }
    }
    self.deps.invalidateResolvedWorktreeCache();
    for (const project of results) {
      if (project.projectId) {
        self.deps.invalidateWorktreeScanCacheForRepo(project.projectId);
      }
    }
    self.deps.notifyReposChanged();
    const rootGroup = groupResolver.getRootGroup();
    return {
      ...(rootGroup && importedCount + alreadyKnownCount > 0
        ? { group: rootGroup }
        : {}),
      projects: results,
      importedCount,
      alreadyKnownCount,
      failedCount,
    };
  }
}

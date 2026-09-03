// Facade: re-exports the split runtime file command collaborators; public API unchanged.
export type {
  ResolvedRuntimeFileTarget,
  ResolvedRuntimeFileWorktree,
  RuntimeFileCommandHost,
  RuntimeFileStatLike,
  TerminalFileGrant
} from './runtime-file-shared'
export {
  getRuntimeFileTargetExecutionHostId,
  RUNTIME_PREVIEWABLE_BINARY_MAX_BYTES,
  WINDOWS_RUNTIME_FILE_WATCH_CLOSE_DEADLINE_MS,
  WINDOWS_RUNTIME_FILE_WATCH_CLOSE_DEADLINE_MS,
  awaitRuntimeFileWatcherUnsubscribes,
  _getRuntimeFileWatcherReleaseCountForTests,
  _resetRuntimeFileWatcherLeasesForTests
} from './runtime-file-shared'
export { awaitRuntimeFileWatcherUnsubscribes as _awaitRuntimeFileWatcherUnsubscribes } from './runtime-file-watcher-leases'
export { RuntimeTerminalFileGrantStore } from './runtime-terminal-file-grant-store'
export { RuntimeFileTerminalPathCommands } from './runtime-file-terminal-path-commands'
export { RuntimeFileArtifactCommands } from './runtime-file-artifact-commands'
export { RuntimeFileExplorerReadCommands } from './runtime-file-explorer-reads'
export { RuntimeFileExplorerWriteCommands } from './runtime-file-explorer-writes'
export { RuntimeFileMobileCommands } from './runtime-file-mobile-commands'
export { RuntimeFileListingCommands } from './runtime-file-listing-commands'

import { RuntimeFileTerminalPathCommands } from './runtime-file-terminal-path-commands'
import { RuntimeFileArtifactCommands } from './runtime-file-artifact-commands'
import { RuntimeFileExplorerReadCommands } from './runtime-file-explorer-reads'
import { RuntimeFileExplorerWriteCommands } from './runtime-file-explorer-writes'
import { RuntimeFileMobileCommands } from './runtime-file-mobile-commands'
import { RuntimeFileListingCommands } from './runtime-file-listing-commands'
import type { RuntimeFileCommandHost } from './runtime-file-shared'
import { RuntimeTerminalFileGrantStore } from './runtime-terminal-file-grant-store'
import { RuntimeMobileFilePathSearchCache } from './runtime-mobile-file-path-search'
import {
  MOBILE_FILE_PATH_SEARCH_CACHE_ENTRIES,
  MOBILE_FILE_PATH_SEARCH_CACHE_TTL_MS
} from './runtime-file-shared'

/**
 * Public facade preserved from the original monolithic RuntimeFileCommands.
 * Each domain group delegates to its collaborator.
 */
export class RuntimeFileCommands {
  private readonly grants = new RuntimeTerminalFileGrantStore()
  private readonly terminal: RuntimeFileTerminalPathCommands
  private readonly artifact: RuntimeFileArtifactCommands
  private readonly explorerRead: RuntimeFileExplorerReadCommands
  private readonly explorerWrite: RuntimeFileExplorerWriteCommands
  private readonly mobile: RuntimeFileMobileCommands
  private readonly listing: RuntimeFileListingCommands
  private readonly mobileFilePathSearchCache = new RuntimeMobileFilePathSearchCache(
    MOBILE_FILE_PATH_SEARCH_CACHE_ENTRIES,
    MOBILE_FILE_PATH_SEARCH_CACHE_TTL_MS
  )

  constructor(private readonly host: RuntimeFileCommandHost) {
    this.terminal = new RuntimeFileTerminalPathCommands(host, this.grants)
    this.artifact = new RuntimeFileArtifactCommands(host, this.terminal)
    this.explorerRead = new RuntimeFileExplorerReadCommands(host)
    this.explorerWrite = new RuntimeFileExplorerWriteCommands(host)
    this.mobile = new RuntimeFileMobileCommands(host, this.terminal, this.mobileFilePathSearchCache)
    this.listing = new RuntimeFileListingCommands(host, this.explorerRead)
  }

  listMobileFiles: RuntimeFileMobileCommands['listMobileFiles'] = (...args) =>
    this.mobile.listMobileFiles(...(args as Parameters<RuntimeFileMobileCommands['listMobileFiles']>))
  searchMobileFilePaths: RuntimeFileMobileCommands['searchMobileFilePaths'] = (...args) =>
    this.mobile.searchMobileFilePaths(...(args as Parameters<RuntimeFileMobileCommands['searchMobileFilePaths']>))
  searchQuickOpenFilePaths: RuntimeFileMobileCommands['searchQuickOpenFilePaths'] = (...args) =>
    this.mobile.searchQuickOpenFilePaths(...(args as Parameters<RuntimeFileMobileCommands['searchQuickOpenFilePaths']>))
  openMobileFile: RuntimeFileMobileCommands['openMobileFile'] = (...args) =>
    this.mobile.openMobileFile(...(args as Parameters<RuntimeFileMobileCommands['openMobileFile']>))
  openMobileDiff: RuntimeFileMobileCommands['openMobileDiff'] = (...args) =>
    this.mobile.openMobileDiff(...(args as Parameters<RuntimeFileMobileCommands['openMobileDiff']>))
  readMobileFile: RuntimeFileMobileCommands['readMobileFile'] = (...args) =>
    this.mobile.readMobileFile(...(args as Parameters<RuntimeFileMobileCommands['readMobileFile']>))
  resolveTerminalPath: RuntimeFileTerminalPathCommands['resolveTerminalPath'] = (...args) =>
    this.terminal.resolveTerminalPath(...(args as Parameters<RuntimeFileTerminalPathCommands['resolveTerminalPath']>))
  readTerminalArtifactFile: RuntimeFileArtifactCommands['readTerminalArtifactFile'] = (...args) =>
    this.artifact.readTerminalArtifactFile(...(args as Parameters<RuntimeFileArtifactCommands['readTerminalArtifactFile']>))
  readTerminalArtifactPreview: RuntimeFileArtifactCommands['readTerminalArtifactPreview'] = (...args) =>
    this.artifact.readTerminalArtifactPreview(...(args as Parameters<RuntimeFileArtifactCommands['readTerminalArtifactPreview']>))
  writeTerminalArtifactFile: RuntimeFileArtifactCommands['writeTerminalArtifactFile'] = (...args) =>
    this.artifact.writeTerminalArtifactFile(...(args as Parameters<RuntimeFileArtifactCommands['writeTerminalArtifactFile']>))
  revokeTerminalFileGrantsForClient: RuntimeFileTerminalPathCommands['revokeTerminalFileGrantsForClient'] = (
    ...args
  ) =>
    this.terminal.revokeTerminalFileGrantsForClient(...(args as Parameters<RuntimeFileTerminalPathCommands['revokeTerminalFileGrantsForClient']>))
  readFileExplorerDir: RuntimeFileExplorerReadCommands['readFileExplorerDir'] = (...args) =>
    this.explorerRead.readFileExplorerDir(...(args as Parameters<RuntimeFileExplorerReadCommands['readFileExplorerDir']>))
  watchFileExplorer: RuntimeFileExplorerReadCommands['watchFileExplorer'] = (...args) =>
    this.explorerRead.watchFileExplorer(...(args as Parameters<RuntimeFileExplorerReadCommands['watchFileExplorer']>))
  closeFileExplorerWatchersForPath: RuntimeFileExplorerReadCommands['closeFileExplorerWatchersForPath'] = (...args) =>
    this.explorerRead.closeFileExplorerWatchersForPath(...(args as Parameters<RuntimeFileExplorerReadCommands['closeFileExplorerWatchersForPath']>))
  restoreFileExplorerWatchersAfterFailedRemoval: RuntimeFileExplorerReadCommands['restoreFileExplorerWatchersAfterFailedRemoval'] = (...args) =>
    this.explorerRead.restoreFileExplorerWatchersAfterFailedRemoval(...(args as Parameters<RuntimeFileExplorerReadCommands['restoreFileExplorerWatchersAfterFailedRemoval']>))
  forgetFileExplorerWatchersAfterRemoval: RuntimeFileExplorerReadCommands['forgetFileExplorerWatchersAfterRemoval'] = (...args) =>
    this.explorerRead.forgetFileExplorerWatchersAfterRemoval(...(args as Parameters<RuntimeFileExplorerReadCommands['forgetFileExplorerWatchersAfterRemoval']>))
  readFileExplorerPreview: RuntimeFileExplorerReadCommands['readFileExplorerPreview'] = (...args) =>
    this.explorerRead.readFileExplorerPreview(...(args as Parameters<RuntimeFileExplorerReadCommands['readFileExplorerPreview']>))
  readDocPreviewFile: RuntimeFileExplorerReadCommands['readDocPreviewFile'] = (...args) =>
    this.explorerRead.readDocPreviewFile(...(args as Parameters<RuntimeFileExplorerReadCommands['readDocPreviewFile']>))
  readFileExplorerChunk: RuntimeFileExplorerReadCommands['readFileExplorerChunk'] = (...args) =>
    this.explorerRead.readFileExplorerChunk(...(args as Parameters<RuntimeFileExplorerReadCommands['readFileExplorerChunk']>))
  writeFileExplorerFile: RuntimeFileExplorerWriteCommands['writeFileExplorerFile'] = (...args) =>
    this.explorerWrite.writeFileExplorerFile(...(args as Parameters<RuntimeFileExplorerWriteCommands['writeFileExplorerFile']>))
  writeFileExplorerFileBase64: RuntimeFileExplorerWriteCommands['writeFileExplorerFileBase64'] = (...args) =>
    this.explorerWrite.writeFileExplorerFileBase64(...(args as Parameters<RuntimeFileExplorerWriteCommands['writeFileExplorerFileBase64']>))
  writeFileExplorerFileBase64Chunk: RuntimeFileExplorerWriteCommands['writeFileExplorerFileBase64Chunk'] = (...args) =>
    this.explorerWrite.writeFileExplorerFileBase64Chunk(...(args as Parameters<RuntimeFileExplorerWriteCommands['writeFileExplorerFileBase64Chunk']>))
  createFileExplorerFile: RuntimeFileExplorerWriteCommands['createFileExplorerFile'] = (...args) =>
    this.explorerWrite.createFileExplorerFile(...(args as Parameters<RuntimeFileExplorerWriteCommands['createFileExplorerFile']>))
  createFileExplorerDir: RuntimeFileExplorerWriteCommands['createFileExplorerDir'] = (...args) =>
    this.explorerWrite.createFileExplorerDir(...(args as Parameters<RuntimeFileExplorerWriteCommands['createFileExplorerDir']>))
  createFileExplorerDirNoClobber: RuntimeFileExplorerWriteCommands['createFileExplorerDirNoClobber'] = (...args) =>
    this.explorerWrite.createFileExplorerDirNoClobber(...(args as Parameters<RuntimeFileExplorerWriteCommands['createFileExplorerDirNoClobber']>))
  commitFileExplorerUpload: RuntimeFileExplorerWriteCommands['commitFileExplorerUpload'] = (...args) =>
    this.explorerWrite.commitFileExplorerUpload(...(args as Parameters<RuntimeFileExplorerWriteCommands['commitFileExplorerUpload']>))
  renameFileExplorerPath: RuntimeFileExplorerWriteCommands['renameFileExplorerPath'] = (...args) =>
    this.explorerWrite.renameFileExplorerPath(...(args as Parameters<RuntimeFileExplorerWriteCommands['renameFileExplorerPath']>))
  copyFileExplorerPath: RuntimeFileExplorerWriteCommands['copyFileExplorerPath'] = (...args) =>
    this.explorerWrite.copyFileExplorerPath(...(args as Parameters<RuntimeFileExplorerWriteCommands['copyFileExplorerPath']>))
  deleteFileExplorerPath: RuntimeFileExplorerWriteCommands['deleteFileExplorerPath'] = (...args) =>
    this.explorerWrite.deleteFileExplorerPath(...(args as Parameters<RuntimeFileExplorerWriteCommands['deleteFileExplorerPath']>))
  searchRuntimeFiles: RuntimeFileListingCommands['searchRuntimeFiles'] = (...args) =>
    this.listing.searchRuntimeFiles(...(args as Parameters<RuntimeFileListingCommands['searchRuntimeFiles']>))
  listRuntimeFiles: RuntimeFileListingCommands['listRuntimeFiles'] = (...args) =>
    this.listing.listRuntimeFiles(...(args as Parameters<RuntimeFileListingCommands['listRuntimeFiles']>))
  listRuntimeMarkdownDocuments: RuntimeFileListingCommands['listRuntimeMarkdownDocuments'] = (...args) =>
    this.listing.listRuntimeMarkdownDocuments(...(args as Parameters<RuntimeFileListingCommands['listRuntimeMarkdownDocuments']>))
  statRuntimeFile: RuntimeFileListingCommands['statRuntimeFile'] = (...args) =>
    this.listing.statRuntimeFile(...(args as Parameters<RuntimeFileListingCommands['statRuntimeFile']>))
}

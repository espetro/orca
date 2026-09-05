import type { OrcaRuntimeService } from './orca-runtime'
import type { RuntimeGitCommands } from './orca-runtime-git'
import type { RuntimeEmulatorCommands } from './orca-runtime-emulator'

type BrowserOrEmulatorCommands = RuntimeBrowserScreencastForwarders | RuntimeEmulatorCommands

// Kept loose: the screencast class holds ~80 field-style forwarders typed against RuntimeBrowserCommands.
// oxlint-disable typescript/consistent-indexed-object-style -- dynamic method-name indexing is the point
type RuntimeBrowserScreencastForwarders = Record<string, (...args: never[]) => unknown>
// oxlint-enable typescript/consistent-indexed-object-style

const BROWSER_METHOD_NAMES = [
  'browserSnapshot',
  'browserClick',
  'browserGoto',
  'browserFill',
  'browserType',
  'browserSelect',
  'browserScroll',
  'browserBack',
  'browserReload',
  'browserScreenshot',
  'browserEval',
  'browserTabList',
  'browserProceedCertificate',
  'browserTabShow',
  'browserTabCurrent',
  'browserTabSwitch',
  'browserHover',
  'browserDrag',
  'browserUpload',
  'browserWait',
  'browserCheck',
  'browserFocus',
  'browserClear',
  'browserSelectAll',
  'browserKeypress',
  'browserPdf',
  'browserFullScreenshot',
  'browserCookieGet',
  'browserCookieSet',
  'browserCookieDelete',
  'browserSetViewport',
  'browserSetGeolocation',
  'browserInterceptEnable',
  'browserInterceptDisable',
  'browserInterceptList',
  'browserCaptureStart',
  'browserCaptureStop',
  'browserConsoleLog',
  'browserNetworkLog',
  'browserDblclick',
  'browserForward',
  'browserScrollIntoView',
  'browserGet',
  'browserIs',
  'browserKeyboardInsertText',
  'browserMouseMove',
  'browserMouseDown',
  'browserMouseClick',
  'browserMouseUp',
  'browserMouseWheel',
  'browserFind',
  'browserSetDevice',
  'browserSetOffline',
  'browserSetHeaders',
  'browserSetCredentials',
  'browserSetMedia',
  'browserClipboardRead',
  'browserClipboardWrite',
  'browserDialogAccept',
  'browserDialogDismiss',
  'browserStorageLocalGet',
  'browserStorageLocalSet',
  'browserStorageLocalClear',
  'browserStorageSessionGet',
  'browserStorageSessionSet',
  'browserStorageSessionClear',
  'browserDownload',
  'browserHighlight',
  'browserExec',
  'browserTabCreate',
  'browserTabSetProfile',
  'browserTabProfileShow',
  'browserTabProfileClone',
  'browserProfileList',
  'browserProfileCreate',
  'browserProfileDelete',
  'browserProfileDetectBrowsers',
  'browserProfileImportFromBrowser',
  'browserProfileClearDefaultCookies',
  'browserTabClose',
  'browserScreencast'
] as const

const EMULATOR_METHOD_NAMES = [
  'emulatorTap',
  'emulatorType',
  'emulatorRotate',
  'emulatorExec',
  'emulatorList',
  'emulatorShutdown',
  'emulatorListSimulators',
  'emulatorAvailability',
  'emulatorListDevices',
  'emulatorInstall',
  'emulatorLaunch',
  'emulatorPermissions',
  'emulatorAx',
  'emulatorUnregisterActive',
  'emulatorAttach',
  'emulatorGesture',
  'emulatorButton',
  'emulatorLogcat',
  'emulatorKill'
] as const

/**
 * Why: OrcaRuntimeService previously carried ~640 lines of `(...args) => target.method.apply(target, args)`
 * trampolines so RPC method handlers could call `runtime.browserX(...)` / `runtime.emulatorX(...)`.
 * This installs the identical pass-throughs onto the prototype once, preserving receiver binding.
 */
export function installBrowserEmulatorCommandDelegations(
  serviceClass: abstract new (...args: never[]) => OrcaRuntimeService,
  getScreencastCommands: (service: OrcaRuntimeService) => RuntimeBrowserScreencastForwarders,
  getEmulatorCommands: (service: OrcaRuntimeService) => RuntimeEmulatorCommands
): void {
  const proto = serviceClass.prototype as unknown as Record<string, unknown>

  for (const method of BROWSER_METHOD_NAMES) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic pass-through by design
    proto[method] = function (this: OrcaRuntimeService, ...args: any[]) {
      return (
        getScreencastCommands(this) as unknown as Record<string, (...a: unknown[]) => unknown>
      )[method](...args)
    }
  }

  for (const method of EMULATOR_METHOD_NAMES) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic pass-through by design
    proto[method] = function (this: OrcaRuntimeService, ...args: any[]) {
      return (getEmulatorCommands(this) as unknown as Record<string, (...a: unknown[]) => unknown>)[
        method
      ](...args)
    }
  }
}

export type { BrowserOrEmulatorCommands }

const LINEAR_METHOD_NAMES = [
  'linearConnect',
  'linearDisconnect',
  'linearSelectWorkspace',
  'linearStatus',
  'linearTestConnection',
  'linearSearchIssues',
  'linearSearchForAgents',
  'linearIssueContext',
  'linearTeamListForAgents',
  'linearTeamMembersForAgents',
  'linearTeamStatesForAgents',
  'linearTeamLabelsForAgents',
  'linearProjectListForAgents',
  'linearIssueListForAgents',
  'linearMcpIssueList',
  'linearResolveCurrentIssue',
  'linearListIssues',
  'linearCreateIssue',
  'linearGetIssue',
  'linearUpdateIssue',
  'linearAddIssueComment',
  'linearIssueSetState',
  'linearIssueRelationWrite',
  'linearSaveIssue',
  'linearIssueUpdateTask',
  'linearIssueAddComment',
  'linearIssueAttachLink',
  'linearIssueCreate',
  'linearIssueComments',
  'linearListTeams',
  'linearListProjects',
  'linearCreateProject',
  'linearGetProject',
  'linearListProjectIssues',
  'linearListCustomViews',
  'linearGetCustomView',
  'linearListCustomViewIssues',
  'linearListCustomViewProjects',
  'linearTeamStates',
  'linearTeamLabels',
  'linearTeamMembers',
  'jiraConnect',
  'jiraDisconnect',
  'jiraSelectSite',
  'jiraStatus',
  'jiraReadStatus',
  'jiraTestConnection',
  'jiraSearchIssues',
  'jiraListIssues',
  'jiraCreateIssue',
  'jiraGetIssue',
  'jiraLookupIssueSummary',
  'jiraUpdateIssue',
  'jiraAddIssueComment',
  'jiraIssueComments',
  'jiraListProjects',
  'jiraListIssueTypes',
  'jiraListCreateFields',
  'jiraListPriorities',
  'jiraListAssignableUsers',
  'jiraListTransitions',
  'jiraGetProjectStatusOrder'
] as const

export function installLinearCommandDelegations(
  serviceClass: abstract new (...args: never[]) => OrcaRuntimeService,
  // oxlint-disable-next-line typescript/no-explicit-any -- mirrors other delegation groups
  getLinearCommands: (service: OrcaRuntimeService) => Record<string, (...a: never[]) => unknown>
): void {
  const proto = serviceClass.prototype as unknown as Record<string, unknown>
  for (const method of LINEAR_METHOD_NAMES) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic pass-through by design
    proto[method] = function (this: OrcaRuntimeService, ...args: any[]) {
      return (getLinearCommands(this)[method] as (...a: any[]) => unknown)(...args)
    }
  }
}

const GIT_METHOD_NAMES = [
  'getRuntimeGitStatus',
  'getRuntimeGitSubmoduleStatus',
  'checkRuntimeGitIgnoredPaths',
  'getRuntimeGitHistory',
  'getRuntimeGitConflictOperation',
  'abortRuntimeGitMerge',
  'abortRuntimeGitRebase',
  'checkoutRuntimeGitBranch',
  'listRuntimeGitLocalBranches',
  'getRuntimeGitDiff',
  'getRuntimeGitBranchCompare',
  'getRuntimeGitCommitCompare',
  'getRuntimeGitUpstreamStatus',
  'fetchRuntimeGit',
  'syncRuntimeGitForkDefaultBranch',
  'pullRuntimeGit',
  'fastForwardRuntimeGit',
  'rebaseRuntimeGitFromBase',
  'pushRuntimeGit',
  'getRuntimeGitBranchDiff',
  'getRuntimeGitCommitDiff',
  'commitRuntimeGit',
  'generateRuntimeCommitMessage',
  'discoverRuntimeCommitMessageModels',
  'cancelRuntimeGenerateCommitMessage',
  'generateRuntimePullRequestFields',
  'cancelRuntimeGeneratePullRequestFields',
  'stageRuntimeGitPath',
  'unstageRuntimeGitPath',
  'bulkStageRuntimeGitPaths',
  'bulkUnstageRuntimeGitPaths',
  'bulkDiscardRuntimeGitPaths',
  'discardRuntimeGitPath',
  'getRuntimeGitRemoteFileUrl',
  'getRuntimeGitRemoteCommitUrl'
] as const

export function installGitCommandDelegations(
  serviceClass: abstract new (...args: never[]) => OrcaRuntimeService,
  getGitCommands: (service: OrcaRuntimeService) => RuntimeGitCommands
): void {
  const proto = serviceClass.prototype as unknown as Record<string, unknown>
  for (const method of GIT_METHOD_NAMES) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic pass-through by design
    proto[method] = function (this: OrcaRuntimeService, ...args: any[]) {
      return (getGitCommands(this) as unknown as Record<string, (...a: any[]) => unknown>)[method](
        ...args
      )
    }
  }
}

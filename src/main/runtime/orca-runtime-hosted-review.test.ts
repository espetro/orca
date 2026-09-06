/* eslint-disable max-lines -- Why: split slice of the runtime behavior suite; mocks are duplicated per file because vi.mock is file-scoped */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  resetRuntimeTestMocks,
  TEST_REPO_ID,
  TEST_REPO_PATH,
  addGitHubPRReviewCommentMock,
  addGitHubPRReviewCommentReplyMock,
  getGitHubPRCheckDetailsMock,
  getGitHubPRChecksMock,
  getGitHubPRCommentsMock,
  getGitHubPRFileContentsMock,
  getGitHubWorkItemByOwnerRepoMock,
  getGitHubWorkItemDetailsMock,
  getGitHubWorkItemMock,
  getPRForBranchOutcomeMock,
  mergeGitHubPRMock,
  removeGitHubPRReviewersMock,
  requestGitHubPRReviewersMock,
  rerunGitHubPRChecksMock,
  resolveGitHubReviewThreadMock,
  setGitHubPRAutoMergeMock,
  setGitHubPRFileViewedMock,
  setPlatform,
  store,
  updateGitHubPRDetailsMock,
  updateGitHubPRStateMock,
  updateGitHubPRTitleMock
} from './orca-runtime-test-fixture'

import { OrcaRuntimeService } from './orca-runtime'

beforeEach(resetRuntimeTestMocks)
afterEach(resetRuntimeTestMocks)

describe('OrcaRuntimeService', () => {
  it('routes runtime GitHub PR details and actions through the selected WSL project runtime', async () => {
    setPlatform('win32')
    const runtimeStore = {
      ...store,
      getProjects: () => [
        {
          id: 'project-1',
          displayName: 'repo',
          badgeColor: 'blue',
          sourceRepoIds: [TEST_REPO_ID],
          localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' },
          createdAt: 0,
          updatedAt: 0
        }
      ],
      getSettings: () => ({
        ...store.getSettings(),
        localWindowsRuntimeDefault: { kind: 'windows-host' }
      })
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const localGitOptions = { wslDistro: 'Ubuntu' }
    const prRepo = { owner: 'acme', repo: 'orca', host: 'github.acme.test' }
    const checkDetailsSignal = new AbortController().signal

    await runtime.getRepoPRForBranch('id:repo-1', 'feature/wsl', 42, 43)
    await runtime.getRepoWorkItem('id:repo-1', 42, 'pr')
    await runtime.getRepoWorkItemByOwnerRepo('id:repo-1', prRepo, 42, 'pr')
    await runtime.getRepoWorkItemDetails('id:repo-1', 42, 'pr')
    await runtime.getRepoPRChecks('id:repo-1', 42, 'head-sha', prRepo, { noCache: true })
    await runtime.rerunRepoPRChecks('id:repo-1', 42, {
      headSha: 'head-sha',
      failedOnly: true,
      prRepo
    })
    await runtime.getRepoPRCheckDetails(
      'id:repo-1',
      {
        checkRunId: 9,
        workflowRunId: 8,
        checkName: 'lint',
        url: 'https://example.com/check',
        prRepo
      },
      checkDetailsSignal
    )
    await runtime.getRepoPRComments('id:repo-1', 42, prRepo, { noCache: true })
    await runtime.getRepoPRFileContents('id:repo-1', {
      prNumber: 42,
      prRepo,
      path: 'src/app.ts',
      status: 'modified',
      headSha: 'head-sha',
      baseSha: 'base-sha'
    })
    await runtime.resolveRepoReviewThread('id:repo-1', 'thread-1', true, prRepo)
    await runtime.setRepoPRFileViewed('id:repo-1', {
      prRepo,
      pullRequestId: 'PR_kw',
      path: 'src/app.ts',
      viewed: true
    })
    await runtime.updateRepoPRTitle('id:repo-1', 42, 'New title', prRepo)
    await runtime.updateRepoPRDetails('id:repo-1', 42, { body: 'New body' }, prRepo)
    await runtime.mergeRepoPR('id:repo-1', 42, 'squash', prRepo)
    await runtime.setRepoPRAutoMerge('id:repo-1', 42, true, 'squash', prRepo)
    await runtime.updateRepoPRState('id:repo-1', 42, { state: 'closed' }, prRepo)
    await runtime.requestRepoPRReviewers('id:repo-1', 42, ['octo'], prRepo)
    await runtime.removeRepoPRReviewers('id:repo-1', 42, ['octo'], prRepo)
    await runtime.addRepoPRReviewComment('id:repo-1', {
      prNumber: 42,
      prRepo,
      body: 'Inline',
      commitId: 'head-sha',
      path: 'src/app.ts',
      line: 10
    })
    await runtime.addRepoPRReviewCommentReply('id:repo-1', {
      prNumber: 42,
      commentId: 11,
      body: 'Reply',
      threadId: 'thread-1',
      path: 'src/app.ts',
      line: 10,
      prRepo
    })

    expect(getPRForBranchOutcomeMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      'feature/wsl',
      42,
      null,
      null,
      {
        localGitExecOptions: localGitOptions
      }
    )
    expect(getGitHubWorkItemMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      42,
      'pr',
      null,
      localGitOptions,
      undefined
    )
    expect(getGitHubWorkItemByOwnerRepoMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      prRepo,
      42,
      'pr',
      null,
      localGitOptions
    )
    expect(getGitHubWorkItemDetailsMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      42,
      'pr',
      null,
      localGitOptions,
      undefined
    )
    expect(getGitHubPRChecksMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      42,
      'head-sha',
      prRepo,
      { noCache: true },
      null,
      localGitOptions
    )
    expect(rerunGitHubPRChecksMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      42,
      { headSha: 'head-sha', failedOnly: true, prRepo },
      null,
      localGitOptions
    )
    expect(getGitHubPRCheckDetailsMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      {
        checkRunId: 9,
        workflowRunId: 8,
        checkName: 'lint',
        url: 'https://example.com/check',
        prRepo
      },
      null,
      localGitOptions,
      checkDetailsSignal
    )
    expect(getGitHubPRCommentsMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      42,
      { noCache: true, prRepo },
      null,
      localGitOptions
    )
    expect(getGitHubPRFileContentsMock).toHaveBeenCalledWith(
      expect.objectContaining({ repoPath: TEST_REPO_PATH, localGitOptions, prRepo })
    )
    expect(resolveGitHubReviewThreadMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      'thread-1',
      true,
      null,
      prRepo,
      localGitOptions
    )
    expect(setGitHubPRFileViewedMock).toHaveBeenCalledWith(
      expect.objectContaining({ repoPath: TEST_REPO_PATH, localGitOptions, prRepo })
    )
    expect(updateGitHubPRTitleMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      42,
      'New title',
      null,
      prRepo,
      localGitOptions
    )
    expect(updateGitHubPRDetailsMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      42,
      { body: 'New body' },
      null,
      prRepo,
      localGitOptions
    )
    expect(mergeGitHubPRMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      42,
      'squash',
      null,
      prRepo,
      localGitOptions
    )
    expect(setGitHubPRAutoMergeMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      42,
      true,
      'squash',
      null,
      prRepo,
      localGitOptions
    )
    expect(updateGitHubPRStateMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      42,
      { state: 'closed' },
      null,
      prRepo,
      localGitOptions
    )
    expect(requestGitHubPRReviewersMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      42,
      ['octo'],
      null,
      prRepo,
      localGitOptions
    )
    expect(removeGitHubPRReviewersMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      42,
      ['octo'],
      null,
      prRepo,
      localGitOptions
    )
    expect(addGitHubPRReviewCommentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        repoPath: TEST_REPO_PATH,
        localGitOptions,
        prRepo,
        body: 'Inline'
      })
    )
    expect(addGitHubPRReviewCommentReplyMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      42,
      11,
      'Reply',
      'thread-1',
      'src/app.ts',
      10,
      null,
      prRepo,
      localGitOptions
    )
  })
})

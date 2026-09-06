/* eslint-disable max-lines -- Why: split slice of the runtime behavior suite; mocks are duplicated per file because vi.mock is file-scoped */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  resetRuntimeTestMocks,
  TEST_REPO_ID,
  TEST_REPO_PATH,
  addGitHubIssueCommentMock,
  countGitHubWorkItemsMock,
  createGitHubIssueMock,
  getGitHubPRCheckDetailsMock,
  getGitHubWorkItemByOwnerRepoMock,
  getGitHubWorkItemDetailsMock,
  getGitHubWorkItemMock,
  getIssueMock,
  getRepoSlugMock,
  getRepoUpstreamMock,
  listGitHubAssignableUsersMock,
  listGitHubIssuesMock,
  listGitHubLabelsMock,
  listGitHubWorkItemsMock,
  setPlatform,
  store,
  updateGitHubIssueMock
} from './orca-runtime-test-fixture'

import { OrcaRuntimeService } from './orca-runtime'

beforeEach(resetRuntimeTestMocks)
afterEach(resetRuntimeTestMocks)

describe('OrcaRuntimeService', () => {
  it('routes runtime GitHub repo identity helpers through the selected WSL project runtime', async () => {
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
    getRepoSlugMock.mockResolvedValueOnce({ owner: 'acme', repo: 'orca' })
    getRepoUpstreamMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })

    await expect(runtime.getRepoSlug('id:repo-1')).resolves.toEqual({
      owner: 'acme',
      repo: 'orca'
    })
    await expect(runtime.getRepoUpstream('id:repo-1')).resolves.toEqual({
      owner: 'stablyai',
      repo: 'orca'
    })

    const runtimeOptions = { localGitExecOptions: { wslDistro: 'Ubuntu' } }
    expect(getRepoSlugMock).toHaveBeenCalledWith(TEST_REPO_PATH, null, runtimeOptions)
    expect(getRepoUpstreamMock).toHaveBeenCalledWith(TEST_REPO_PATH, null, runtimeOptions)
  })

  it('routes runtime GitHub issue and work-item actions through the selected WSL project runtime', async () => {
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
    const issueFields = { labels: ['bug'], assignees: ['octo'] }
    const issueUpdates = { body: 'Updated body' }
    listGitHubWorkItemsMock.mockResolvedValueOnce({ items: [] })
    countGitHubWorkItemsMock.mockResolvedValueOnce(0)
    listGitHubIssuesMock.mockResolvedValueOnce({ items: [] })
    getIssueMock.mockResolvedValueOnce(null)
    createGitHubIssueMock.mockResolvedValueOnce({
      ok: true,
      number: 12,
      url: 'https://github.com/acme/orca/issues/12'
    })
    updateGitHubIssueMock.mockResolvedValueOnce({ ok: true })
    addGitHubIssueCommentMock.mockResolvedValueOnce({ ok: true })
    listGitHubLabelsMock.mockResolvedValueOnce([])
    listGitHubAssignableUsersMock.mockResolvedValueOnce([])

    await runtime.listRepoWorkItems('id:repo-1', 7, 'is:open', 1, true)
    await runtime.countRepoWorkItems('id:repo-1', 'is:issue')
    await runtime.listRepoIssues('id:repo-1', 5)
    await runtime.getRepoIssue('id:repo-1', 12)
    await runtime.createRepoIssue('id:repo-1', 'Title', 'Body', issueFields)
    await runtime.updateRepoIssue('id:repo-1', 12, issueUpdates)
    await runtime.addRepoIssueComment('id:repo-1', 12, 'Comment')
    await runtime.listRepoLabels('id:repo-1')
    await runtime.listRepoAssignableUsers('id:repo-1')

    expect(listGitHubWorkItemsMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      7,
      'is:open',
      1,
      undefined,
      null,
      true,
      localGitOptions
    )
    expect(countGitHubWorkItemsMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      'is:issue',
      undefined,
      null,
      localGitOptions
    )
    expect(listGitHubIssuesMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      5,
      undefined,
      null,
      localGitOptions
    )
    expect(getIssueMock).toHaveBeenCalledWith(TEST_REPO_PATH, 12, null, localGitOptions)
    expect(createGitHubIssueMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      'Title',
      'Body',
      undefined,
      null,
      issueFields,
      localGitOptions
    )
    expect(updateGitHubIssueMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      12,
      issueUpdates,
      null,
      localGitOptions
    )
    expect(addGitHubIssueCommentMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      12,
      'Comment',
      null,
      null,
      localGitOptions
    )
    expect(listGitHubLabelsMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      undefined,
      null,
      localGitOptions
    )
    expect(listGitHubAssignableUsersMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      undefined,
      null,
      localGitOptions
    )
  })

  it('pins explicit origin preference on runtime open-by-number work item lookups', async () => {
    const originRepo = {
      id: TEST_REPO_ID,
      path: TEST_REPO_PATH,
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 1,
      issueSourcePreference: 'origin' as const
    }
    const runtime = new OrcaRuntimeService({
      ...store,
      getRepos: () => [originRepo],
      getRepo: (id: string) => (id === originRepo.id ? originRepo : undefined)
    } as never)
    const prRepo = { owner: 'acme', repo: 'orca' }

    await runtime.getRepoWorkItem('id:repo-1', 42, 'pr')
    await runtime.getRepoWorkItemDetails('id:repo-1', 42, 'pr')
    await runtime.getRepoWorkItemByOwnerRepo('id:repo-1', prRepo, 42, 'pr')

    expect(getGitHubWorkItemMock).toHaveBeenCalledWith(TEST_REPO_PATH, 42, 'pr', null, {}, 'origin')
    expect(getGitHubWorkItemDetailsMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      42,
      'pr',
      null,
      {},
      'origin'
    )
    // Why: explicit owner/repo already pins identity, so it stays preference-free.
    expect(getGitHubWorkItemByOwnerRepoMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      prRepo,
      42,
      'pr',
      null
    )
  })

  it('forwards check-details cancellation without local Git overrides', async () => {
    const runtime = new OrcaRuntimeService(store)
    const signal = new AbortController().signal

    await runtime.getRepoPRCheckDetails('id:repo-1', { checkRunId: 9 }, signal)

    expect(getGitHubPRCheckDetailsMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      {
        checkRunId: 9,
        prRepo: null
      },
      null,
      {},
      signal
    )
  })
})

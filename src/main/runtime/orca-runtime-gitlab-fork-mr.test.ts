/* eslint-disable max-lines -- Why: split slice of the runtime behavior suite; mocks are duplicated per file because vi.mock is file-scoped */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ORIGIN_HEAD_COMPONENT,
  ORIGIN_REMOTE_URL,
  TEST_REPO_ID,
  TEST_REPO_PATH,
  addGitLabIssueCommentMock,
  addGitLabMRCommentMock,
  addGitLabMRInlineCommentMock,
  closeGitLabMRMock,
  createGitLabIssueMock,
  getGitLabJobTraceMock,
  getGitLabProjectRefForRemoteMock,
  getGitLabWorkItemByProjectRefMock,
  getGitLabWorkItemDetailsMock,
  getGlabKnownHostsMock,
  getPullRequestPushTargetMock,
  isOriginMainBaseRefProbe,
  listGitLabIssuesMock,
  listGitLabLabelsMock,
  listGitLabMergeRequestsMock,
  listGitLabTodosMock,
  listGitLabWorkItemsMock,
  mergeGitLabMRMock,
  reopenGitLabMRMock,
  resetRuntimeTestMocks,
  resolveGitLabMRDiscussionMock,
  retryGitLabJobMock,
  setPlatform,
  store,
  updateGitLabIssueMock,
  updateGitLabMRMock,
  updateGitLabMRReviewersMock
} from './orca-runtime-test-fixture'
import { OrcaRuntimeService } from './orca-runtime'
import { REVIEW_HEAD_FETCH_TIMEOUT_MS } from '../../shared/review-head-tracking-ref'
import { registerSshGitProvider } from '../providers/ssh-git-dispatch'
import * as gitRunner from '../git/runner'

beforeEach(resetRuntimeTestMocks)
afterEach(resetRuntimeTestMocks)

describe('OrcaRuntimeService', () => {
  it('passes SSH connection ids through GitLab task operations', async () => {
    listGitLabMergeRequestsMock.mockResolvedValue({ items: [] })
    listGitLabWorkItemsMock.mockResolvedValue({ items: [] })
    listGitLabIssuesMock.mockResolvedValue({
      items: [
        {
          number: 7,
          title: 'Issue title',
          state: 'opened',
          url: 'https://gitlab.example/issues/7',
          labels: ['bug'],
          updatedAt: '2026-05-22T00:00:00Z',
          author: 'alex'
        }
      ],
      totalPages: 3
    })
    listGitLabTodosMock.mockResolvedValue([])
    listGitLabLabelsMock.mockResolvedValue(['bug', 'frontend'])
    getGitLabWorkItemByProjectRefMock.mockResolvedValue({
      id: 'gitlab-issue-7',
      type: 'issue',
      number: 7
    })
    createGitLabIssueMock.mockResolvedValue({
      ok: true,
      number: 1,
      url: 'https://gitlab.example/issues/1'
    })
    updateGitLabIssueMock.mockResolvedValue({ ok: true })
    addGitLabIssueCommentMock.mockResolvedValue({ ok: true })
    addGitLabMRCommentMock.mockResolvedValue({ ok: true })
    addGitLabMRInlineCommentMock.mockResolvedValue({ ok: true })
    resolveGitLabMRDiscussionMock.mockResolvedValue({ ok: true })
    getGitLabJobTraceMock.mockResolvedValue({ ok: true, trace: 'log' })
    retryGitLabJobMock.mockResolvedValue({ ok: true })
    mergeGitLabMRMock.mockResolvedValue({ ok: true })
    closeGitLabMRMock.mockResolvedValue({ ok: true })
    reopenGitLabMRMock.mockResolvedValue({ ok: true })
    getGitLabWorkItemDetailsMock.mockResolvedValue({ body: 'Details' })
    updateGitLabMRReviewersMock.mockResolvedValue({ ok: true, reviewers: [] })

    const remoteRepo = {
      id: TEST_REPO_ID,
      path: '/remote/repo',
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-1',
      issueSourcePreference: 'origin' as const
    }
    const runtimeStore = {
      ...store,
      getRepos: () => [remoteRepo],
      getRepo: (id: string) => (id === remoteRepo.id ? remoteRepo : undefined)
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    await runtime.listGitLabRepoMRs(TEST_REPO_ID, 'closed', 2, 25, 'ambiguous selector')
    await runtime.listGitLabRepoWorkItems(TEST_REPO_ID, 'closed', 2, 25, 'ambiguous selector')
    const issues = await runtime.listGitLabRepoIssues(TEST_REPO_ID, 'opened', '@me', 50, 3)
    await runtime.listGitLabRepoTodos(TEST_REPO_ID)
    await runtime.listGitLabRepoLabels(TEST_REPO_ID)
    await runtime.createGitLabRepoIssue(TEST_REPO_ID, 'New issue', 'Body')
    await runtime.updateGitLabRepoIssue(TEST_REPO_ID, 7, { state: 'closed' })
    await runtime.addGitLabRepoIssueComment(TEST_REPO_ID, 7, 'Looks good')
    await runtime.addGitLabRepoMRComment(TEST_REPO_ID, 8, 'Ship it')
    const inlineCommentInput = {
      body: 'please fix',
      path: 'src/app.ts',
      line: 12,
      baseSha: 'base',
      startSha: 'start',
      headSha: 'head'
    }
    await runtime.addGitLabRepoMRInlineComment(TEST_REPO_ID, 8, inlineCommentInput)
    await runtime.resolveGitLabRepoMRDiscussion(TEST_REPO_ID, 8, 'discussion-1', true)
    await runtime.getGitLabRepoJobTrace(TEST_REPO_ID, 99)
    await runtime.retryGitLabRepoJob(TEST_REPO_ID, 99)
    await runtime.mergeGitLabRepoMR(TEST_REPO_ID, 8, 'squash')
    await runtime.updateGitLabRepoMRState(TEST_REPO_ID, 8, 'closed')
    await runtime.updateGitLabRepoMRState(TEST_REPO_ID, 8, 'opened')
    await runtime.getGitLabRepoWorkItemDetails(TEST_REPO_ID, 8, 'mr')
    await runtime.updateGitLabRepoMRReviewers(TEST_REPO_ID, 8, [1, 2])
    await runtime.getGitLabRepoWorkItemByPath(
      TEST_REPO_ID,
      { host: 'gitlab.example.com', path: 'group/project' },
      7,
      'issue'
    )

    expect(listGitLabMergeRequestsMock).toHaveBeenCalledWith(
      '/remote/repo',
      'closed',
      2,
      25,
      'origin',
      'ambiguous selector',
      'ssh-1'
    )
    expect(listGitLabWorkItemsMock).toHaveBeenCalledWith(
      '/remote/repo',
      'closed',
      2,
      25,
      'origin',
      'ambiguous selector',
      'ssh-1'
    )
    expect(listGitLabIssuesMock).toHaveBeenCalledWith(
      '/remote/repo',
      50,
      'origin',
      'opened',
      '@me',
      'ssh-1',
      {},
      3
    )
    expect(issues.items).toEqual([
      {
        id: `gitlab-issue-${TEST_REPO_ID}-7`,
        type: 'issue',
        number: 7,
        title: 'Issue title',
        state: 'opened',
        url: 'https://gitlab.example/issues/7',
        labels: ['bug'],
        updatedAt: '2026-05-22T00:00:00Z',
        author: 'alex',
        repoId: TEST_REPO_ID
      }
    ])
    expect(issues).toMatchObject({ totalPages: 3 })
    expect(listGitLabTodosMock).toHaveBeenCalledWith('/remote/repo', 'ssh-1')
    expect(listGitLabLabelsMock).toHaveBeenCalledWith('/remote/repo', 'origin', 'ssh-1')
    expect(createGitLabIssueMock).toHaveBeenCalledWith(
      '/remote/repo',
      'New issue',
      'Body',
      'origin',
      'ssh-1'
    )
    expect(updateGitLabIssueMock).toHaveBeenCalledWith(
      '/remote/repo',
      7,
      { state: 'closed' },
      'origin',
      'ssh-1',
      undefined
    )
    expect(addGitLabIssueCommentMock).toHaveBeenCalledWith(
      '/remote/repo',
      7,
      'Looks good',
      'origin',
      'ssh-1',
      undefined
    )
    expect(addGitLabMRCommentMock).toHaveBeenCalledWith(
      '/remote/repo',
      8,
      'Ship it',
      'origin',
      'ssh-1',
      undefined
    )
    expect(addGitLabMRInlineCommentMock).toHaveBeenCalledWith(
      '/remote/repo',
      8,
      inlineCommentInput,
      'origin',
      'ssh-1',
      undefined
    )
    expect(resolveGitLabMRDiscussionMock).toHaveBeenCalledWith(
      '/remote/repo',
      8,
      'discussion-1',
      true,
      'origin',
      'ssh-1',
      undefined
    )
    expect(getGitLabJobTraceMock).toHaveBeenCalledWith(
      '/remote/repo',
      99,
      'origin',
      'ssh-1',
      undefined
    )
    expect(retryGitLabJobMock).toHaveBeenCalledWith(
      '/remote/repo',
      99,
      'origin',
      'ssh-1',
      undefined
    )
    expect(mergeGitLabMRMock).toHaveBeenCalledWith(
      '/remote/repo',
      8,
      'squash',
      'origin',
      'ssh-1',
      undefined
    )
    expect(closeGitLabMRMock).toHaveBeenCalledWith('/remote/repo', 8, 'origin', 'ssh-1', undefined)
    expect(reopenGitLabMRMock).toHaveBeenCalledWith('/remote/repo', 8, 'origin', 'ssh-1', undefined)
    expect(getGitLabWorkItemDetailsMock).toHaveBeenCalledWith(
      '/remote/repo',
      8,
      'mr',
      'origin',
      'ssh-1',
      undefined
    )
    expect(updateGitLabMRReviewersMock).toHaveBeenCalledWith(
      '/remote/repo',
      8,
      [1, 2],
      'origin',
      'ssh-1',
      undefined
    )
    expect(getGitLabWorkItemByProjectRefMock).toHaveBeenCalledWith(
      '/remote/repo',
      { host: 'gitlab.example.com', path: 'group/project' },
      7,
      'issue',
      'ssh-1'
    )
  })

  it('routes runtime GitLab issue, MR, work-item, and todo actions through the selected WSL project runtime', async () => {
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
    listGitLabMergeRequestsMock.mockResolvedValue({ items: [] })
    listGitLabWorkItemsMock.mockResolvedValue({ items: [] })
    listGitLabIssuesMock.mockResolvedValue({ items: [] })
    listGitLabTodosMock.mockResolvedValue([])
    listGitLabLabelsMock.mockResolvedValue([])
    createGitLabIssueMock.mockResolvedValue({
      ok: true,
      number: 7,
      url: 'https://gitlab.example/issues/7'
    })
    updateGitLabIssueMock.mockResolvedValue({ ok: true })
    addGitLabIssueCommentMock.mockResolvedValue({ ok: true })

    await runtime.listGitLabRepoMRs(TEST_REPO_ID, 'opened', 1, 20)
    await runtime.listGitLabRepoWorkItems(TEST_REPO_ID, 'opened', 1, 20)
    await runtime.listGitLabRepoIssues(TEST_REPO_ID, 'opened', undefined, 20)
    await runtime.listGitLabRepoTodos(TEST_REPO_ID)
    await runtime.listGitLabRepoLabels(TEST_REPO_ID)
    await runtime.createGitLabRepoIssue(TEST_REPO_ID, 'Title', 'Body')
    await runtime.updateGitLabRepoIssue(TEST_REPO_ID, 7, { body: 'Updated' })
    await runtime.addGitLabRepoIssueComment(TEST_REPO_ID, 7, 'Comment')

    expect(listGitLabMergeRequestsMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      'opened',
      1,
      20,
      undefined,
      undefined,
      null,
      localGitOptions
    )
    expect(listGitLabWorkItemsMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      'opened',
      1,
      20,
      undefined,
      undefined,
      null,
      localGitOptions
    )
    expect(listGitLabIssuesMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      20,
      undefined,
      'opened',
      undefined,
      null,
      localGitOptions,
      1
    )
    expect(listGitLabTodosMock).toHaveBeenCalledWith(TEST_REPO_PATH, null, localGitOptions)
    expect(listGitLabLabelsMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      undefined,
      null,
      localGitOptions
    )
    expect(createGitLabIssueMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      'Title',
      'Body',
      undefined,
      null,
      localGitOptions
    )
    expect(updateGitLabIssueMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      7,
      { body: 'Updated' },
      undefined,
      null,
      undefined,
      localGitOptions
    )
    expect(addGitLabIssueCommentMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      7,
      'Comment',
      undefined,
      null,
      undefined,
      localGitOptions
    )
  })

  it('routes runtime GitLab MR details, review-management, job, and pasted URL actions through the selected WSL project runtime', async () => {
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
    const inlineInput = {
      body: 'Inline',
      path: 'src/app.ts',
      line: 12,
      baseSha: 'base',
      startSha: 'start',
      headSha: 'head'
    }
    getGitLabWorkItemDetailsMock.mockResolvedValue({ body: 'Details' })
    updateGitLabMRMock.mockResolvedValue({ ok: true })
    updateGitLabMRReviewersMock.mockResolvedValue({ ok: true, reviewers: [] })
    addGitLabMRCommentMock.mockResolvedValue({ ok: true })
    addGitLabMRInlineCommentMock.mockResolvedValue({ ok: true })
    resolveGitLabMRDiscussionMock.mockResolvedValue({ ok: true })
    getGitLabJobTraceMock.mockResolvedValue({ ok: true, trace: 'trace' })
    retryGitLabJobMock.mockResolvedValue({ ok: true })
    mergeGitLabMRMock.mockResolvedValue({ ok: true })
    closeGitLabMRMock.mockResolvedValue({ ok: true })
    reopenGitLabMRMock.mockResolvedValue({ ok: true })
    getGitLabWorkItemByProjectRefMock.mockResolvedValue({ type: 'mr', number: 8 })

    await runtime.getGitLabRepoWorkItemDetails(TEST_REPO_ID, 8, 'mr')
    await runtime.updateGitLabRepoMR(TEST_REPO_ID, 8, { title: 'Renamed' })
    await runtime.updateGitLabRepoMRReviewers(TEST_REPO_ID, 8, [1])
    await runtime.addGitLabRepoMRComment(TEST_REPO_ID, 8, 'Comment')
    await runtime.addGitLabRepoMRInlineComment(TEST_REPO_ID, 8, inlineInput)
    await runtime.resolveGitLabRepoMRDiscussion(TEST_REPO_ID, 8, 'discussion-1', true)
    await runtime.getGitLabRepoJobTrace(TEST_REPO_ID, 99)
    await runtime.retryGitLabRepoJob(TEST_REPO_ID, 99)
    await runtime.mergeGitLabRepoMR(TEST_REPO_ID, 8, 'squash')
    await runtime.updateGitLabRepoMRState(TEST_REPO_ID, 8, 'closed')
    await runtime.updateGitLabRepoMRState(TEST_REPO_ID, 8, 'opened')
    await runtime.getGitLabRepoWorkItemByPath(
      TEST_REPO_ID,
      { host: 'gitlab.com', path: 'g/p' },
      8,
      'mr'
    )

    expect(getGitLabWorkItemDetailsMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      8,
      'mr',
      undefined,
      null,
      undefined,
      localGitOptions
    )
    expect(updateGitLabMRMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      8,
      { title: 'Renamed' },
      undefined,
      null,
      undefined,
      localGitOptions
    )
    expect(updateGitLabMRReviewersMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      8,
      [1],
      undefined,
      null,
      undefined,
      localGitOptions
    )
    expect(addGitLabMRCommentMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      8,
      'Comment',
      undefined,
      null,
      undefined,
      localGitOptions
    )
    expect(addGitLabMRInlineCommentMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      8,
      inlineInput,
      undefined,
      null,
      undefined,
      localGitOptions
    )
    expect(resolveGitLabMRDiscussionMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      8,
      'discussion-1',
      true,
      undefined,
      null,
      undefined,
      localGitOptions
    )
    expect(getGitLabJobTraceMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      99,
      undefined,
      null,
      undefined,
      localGitOptions
    )
    expect(retryGitLabJobMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      99,
      undefined,
      null,
      undefined,
      localGitOptions
    )
    expect(mergeGitLabMRMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      8,
      'squash',
      undefined,
      null,
      undefined,
      localGitOptions
    )
    expect(closeGitLabMRMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      8,
      undefined,
      null,
      undefined,
      localGitOptions
    )
    expect(reopenGitLabMRMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      8,
      undefined,
      null,
      undefined,
      localGitOptions
    )
    expect(getGitLabWorkItemByProjectRefMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      { host: 'gitlab.com', path: 'g/p' },
      8,
      'mr',
      null,
      localGitOptions
    )
  })

  it('normalizes runtime GitLab issue list arguments like the desktop IPC path', async () => {
    const runtime = new OrcaRuntimeService(store as never)

    await runtime.listGitLabRepoIssues(
      TEST_REPO_ID,
      'closed',
      'someone-else' as never,
      250.8,
      20_000
    )
    await runtime.listGitLabRepoIssues(TEST_REPO_ID, 'all', '@me', 0.7, 0)
    await runtime.listGitLabRepoIssues(
      TEST_REPO_ID,
      'unexpected' as never,
      '@me',
      Number.NaN,
      Number.NaN
    )

    expect(listGitLabIssuesMock).toHaveBeenNthCalledWith(
      1,
      TEST_REPO_PATH,
      100,
      undefined,
      'closed',
      undefined,
      null,
      {},
      10_000
    )
    expect(listGitLabIssuesMock).toHaveBeenNthCalledWith(
      2,
      TEST_REPO_PATH,
      1,
      undefined,
      'all',
      '@me',
      null,
      {},
      1
    )
    expect(listGitLabIssuesMock).toHaveBeenNthCalledWith(
      3,
      TEST_REPO_PATH,
      20,
      undefined,
      'opened',
      '@me',
      null,
      {},
      1
    )
  })

  it('records GitLab pasted-project recents only after successful runtime lookup', async () => {
    let settings = {
      ...store.getSettings(),
      gitlabProjects: {
        pinned: [{ host: 'gitlab.example.com', path: 'group/pinned' }],
        recent: []
      }
    }
    const updateSettings = vi.fn((updates: Record<string, unknown>) => {
      settings = { ...settings, ...updates } as typeof settings
    })
    const runtimeStore = {
      ...store,
      getSettings: () => settings,
      updateSettings
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    getGitLabWorkItemByProjectRefMock.mockResolvedValueOnce({
      id: 'gitlab-issue-7',
      type: 'issue',
      number: 7
    })
    await runtime.getGitLabRepoWorkItemByPath(
      TEST_REPO_ID,
      { host: 'gitlab.example.com', path: 'group/project' },
      7,
      'issue'
    )

    expect(updateSettings).toHaveBeenCalledWith({
      gitlabProjects: {
        pinned: [{ host: 'gitlab.example.com', path: 'group/pinned' }],
        recent: [
          expect.objectContaining({
            host: 'gitlab.example.com',
            path: 'group/project',
            lastOpenedAt: expect.any(String)
          })
        ]
      }
    })

    updateSettings.mockClear()
    getGitLabWorkItemByProjectRefMock.mockResolvedValueOnce(null)
    await runtime.getGitLabRepoWorkItemByPath(
      TEST_REPO_ID,
      { host: 'gitlab.example.com', path: 'group/missing' },
      404,
      'issue'
    )

    expect(updateSettings).not.toHaveBeenCalled()
  })

  it('threads explicit origin preference through runtime WSL PR base resolution', async () => {
    setPlatform('win32')
    const localRepo = {
      id: TEST_REPO_ID,
      path: TEST_REPO_PATH,
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 1,
      issueSourcePreference: 'origin' as const
    }
    const runtimeStore = {
      ...store,
      getRepos: () => [localRepo],
      getRepo: (id: string) => (id === localRepo.id ? localRepo : undefined),
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
    const gitSpy = vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args) => {
      if (args[0] === 'symbolic-ref') {
        return { stdout: 'refs/remotes/origin/main\n', stderr: '' }
      }
      if (isOriginMainBaseRefProbe(args)) {
        return { stdout: 'main-sha\n', stderr: '' }
      }
      if (args[0] === 'config') {
        return { stdout: 'origin\n', stderr: '' }
      }
      if (args[0] === 'remote' && args[1] === 'get-url') {
        if (args[2] !== 'origin' && args[2] !== 'upstream') {
          throw new Error(`unexpected remote: ${String(args[2])}`)
        }
        const url =
          args[2] === 'origin'
            ? 'git@github.com:org/repo.git'
            : 'git@github.com:org/upstream-repo.git'
        return { stdout: `${url}\n`, stderr: '' }
      }
      if (args[0] === 'remote') {
        return { stdout: 'origin\nupstream\n', stderr: '' }
      }
      if (args[0] === 'fetch') {
        return { stdout: '', stderr: '' }
      }
      if (
        args[0] === 'rev-parse' &&
        args[1] === '--verify' &&
        args[2] === 'origin/feature/add-feature'
      ) {
        return { stdout: 'pr-head-sha\n', stderr: '' }
      }
      throw new Error(`unexpected git call: ${args.join(' ')}`)
    })
    gitSpy.mockClear()
    try {
      const result = await runtime.resolveManagedPrBase({
        repoSelector: 'id:repo-1',
        prNumber: 42,
        headRefName: 'feature/add-feature',
        isCrossRepository: false
      })

      expect(result).toMatchObject({
        baseBranch: 'pr-head-sha',
        headSha: 'pr-head-sha',
        branchNameOverride: 'feature/add-feature'
      })
      expect(gitSpy).toHaveBeenCalledWith(
        [
          'fetch',
          'origin',
          '+refs/heads/feature/add-feature:refs/remotes/origin/feature/add-feature'
        ],
        { cwd: TEST_REPO_PATH, wslDistro: 'Ubuntu' }
      )
      expect(gitSpy).toHaveBeenCalledWith(['rev-parse', '--verify', 'origin/feature/add-feature'], {
        cwd: TEST_REPO_PATH,
        wslDistro: 'Ubuntu'
      })
      // Why: the explicit origin preference must short-circuit before any
      // identity probe, so no remote — not just upstream — gets a get-url.
      expect(gitSpy).not.toHaveBeenCalledWith(
        ['remote', 'get-url', expect.anything()],
        expect.anything()
      )
    } finally {
      gitSpy.mockRestore()
    }
  })

  it('resolves SSH GitHub fork PR heads through the write-capable fetch RPC', async () => {
    const remoteRepo = {
      id: TEST_REPO_ID,
      path: '/remote/repo',
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-1',
      issueSourcePreference: 'origin' as const
    }
    const runtimeStore = {
      ...store,
      getRepos: () => [remoteRepo],
      getRepo: (id: string) => (id === remoteRepo.id ? remoteRepo : undefined)
    }
    const provider = {
      exec: vi.fn(async (args: string[]) => {
        if (args[0] === 'remote' && args[1] === 'get-url') {
          return { stdout: `${ORIGIN_REMOTE_URL}\n`, stderr: '' }
        }
        if (args[0] === 'remote') {
          return { stdout: 'origin\nupstream\n', stderr: '' }
        }
        if (
          args[0] === 'rev-parse' &&
          args[2] === `refs/orca/pull/${ORIGIN_HEAD_COMPONENT}/42^{commit}`
        ) {
          return { stdout: 'remote-fork-pr-sha\n', stderr: '' }
        }
        throw new Error(`unexpected git call: ${args.join(' ')}`)
      }),
      fetchGitHubPullRequestHead: vi
        .fn()
        .mockResolvedValue(`refs/orca/pull/${ORIGIN_HEAD_COMPONENT}/42`),
      fetchRemoteTrackingRef: vi.fn().mockResolvedValue(undefined)
    }
    registerSshGitProvider('ssh-1', provider as never)
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    const result = await runtime.resolveManagedPrBase({
      repoSelector: 'id:repo-1',
      prNumber: 42,
      headRefName: 'contributor/fix',
      isCrossRepository: true
    })

    expect(result).toEqual({
      baseBranch: 'remote-fork-pr-sha',
      headSha: 'remote-fork-pr-sha',
      branchNameOverride: 'contributor/fix'
    })
    expect(provider.fetchGitHubPullRequestHead).toHaveBeenCalledWith('/remote/repo', 'origin', 42)
    expect(getPullRequestPushTargetMock).toHaveBeenCalledWith(
      '/remote/repo',
      42,
      'ssh-1',
      {},
      'origin'
    )
    expect(provider.exec).not.toHaveBeenCalledWith(
      expect.arrayContaining(['fetch']),
      '/remote/repo'
    )
  })

  it('resolves local GitLab fork MR bases from the target project MR head ref', async () => {
    const localRepo = {
      id: TEST_REPO_ID,
      path: TEST_REPO_PATH,
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 1,
      issueSourcePreference: 'origin' as const
    }
    const runtimeStore = {
      ...store,
      getRepos: () => [localRepo],
      getRepo: (id: string) => (id === localRepo.id ? localRepo : undefined)
    }
    getGitLabProjectRefForRemoteMock.mockResolvedValue({
      host: 'gitlab.example',
      path: 'group/repo'
    })
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const gitSpy = vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args) => {
      if (args[0] === 'remote' && args[1] === 'get-url') {
        return { stdout: `${ORIGIN_REMOTE_URL}\n`, stderr: '' }
      }
      if (args[0] === 'fetch') {
        return { stdout: '', stderr: '' }
      }
      if (
        args[0] === 'rev-parse' &&
        args[1] === '--verify' &&
        args[2] === `refs/orca/merge-requests/${ORIGIN_HEAD_COMPONENT}/42^{commit}`
      ) {
        return { stdout: 'fork-mr-sha\n', stderr: '' }
      }
      throw new Error(`unexpected git call: ${args.join(' ')}`)
    })
    gitSpy.mockClear()
    try {
      const result = await runtime.resolveManagedMrBase({
        repoSelector: 'id:repo-1',
        mrIid: 42,
        sourceBranch: 'contrib/fix',
        targetBranch: 'main',
        isCrossRepository: true
      })

      expect(result).toEqual({
        baseBranch: 'fork-mr-sha',
        compareBaseRef: 'refs/remotes/origin/main'
      })
      expect(gitSpy).toHaveBeenCalledWith(
        [
          'fetch',
          '--no-tags',
          'origin',
          `+refs/merge-requests/42/head:refs/orca/merge-requests/${ORIGIN_HEAD_COMPONENT}/42`
        ],
        { cwd: TEST_REPO_PATH, timeout: REVIEW_HEAD_FETCH_TIMEOUT_MS }
      )
      expect(gitSpy).toHaveBeenCalledWith(
        ['fetch', 'origin', '+refs/heads/main:refs/remotes/origin/main'],
        { cwd: TEST_REPO_PATH }
      )
      expect(gitSpy).toHaveBeenCalledWith(
        ['rev-parse', '--verify', `refs/orca/merge-requests/${ORIGIN_HEAD_COMPONENT}/42^{commit}`],
        { cwd: TEST_REPO_PATH }
      )
    } finally {
      gitSpy.mockRestore()
    }
  })

  it('captures the fork MR head from a dedicated ref, not the shared FETCH_HEAD', async () => {
    const localRepo = {
      id: TEST_REPO_ID,
      path: TEST_REPO_PATH,
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 1,
      issueSourcePreference: 'origin' as const
    }
    const runtimeStore = {
      ...store,
      getRepos: () => [localRepo],
      getRepo: (id: string) => (id === localRepo.id ? localRepo : undefined)
    }
    getGitLabProjectRefForRemoteMock.mockResolvedValue({
      host: 'gitlab.example',
      path: 'group/repo'
    })
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    // Why: simulate a concurrent `git fetch origin` clobbering FETCH_HEAD with the
    // default-branch tip. The resolved base must come from the durable Orca MR ref.
    const gitSpy = vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args) => {
      if (args[0] === 'remote' && args[1] === 'get-url') {
        return { stdout: `${ORIGIN_REMOTE_URL}\n`, stderr: '' }
      }
      if (args[0] === 'fetch') {
        return { stdout: '', stderr: '' }
      }
      if (args[0] === 'rev-parse') {
        const ref = args.at(-1)
        if (ref === 'FETCH_HEAD') {
          return { stdout: 'mainbranchtip000\n', stderr: '' }
        }
        if (ref === `refs/orca/merge-requests/${ORIGIN_HEAD_COMPONENT}/42^{commit}`) {
          return { stdout: 'mrheadsha111\n', stderr: '' }
        }
        throw new Error(`unexpected rev-parse ref: ${ref}`)
      }
      throw new Error(`unexpected git call: ${args.join(' ')}`)
    })
    gitSpy.mockClear()
    try {
      const result = await runtime.resolveManagedMrBase({
        repoSelector: 'id:repo-1',
        mrIid: 42,
        sourceBranch: 'contrib/fix',
        targetBranch: 'main',
        isCrossRepository: true
      })

      expect(result).toEqual({
        baseBranch: 'mrheadsha111',
        compareBaseRef: 'refs/remotes/origin/main'
      })
      expect(gitSpy).not.toHaveBeenCalledWith(
        ['rev-parse', '--verify', 'FETCH_HEAD'],
        expect.anything()
      )
    } finally {
      gitSpy.mockRestore()
    }
  })

  it('keeps the durable MR head when the head fetch fails but the local ref resolves', async () => {
    // Why: mirror compare-base soft-keep — a transient fetch failure must not
    // fail the resolve when a prior fetch already pinned refs/orca/merge-requests/<iid>.
    const localRepo = {
      id: TEST_REPO_ID,
      path: TEST_REPO_PATH,
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 1,
      issueSourcePreference: 'origin' as const
    }
    const runtimeStore = {
      ...store,
      getRepos: () => [localRepo],
      getRepo: (id: string) => (id === localRepo.id ? localRepo : undefined)
    }
    getGitLabProjectRefForRemoteMock.mockResolvedValue({
      host: 'gitlab.example',
      path: 'group/repo'
    })
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const gitSpy = vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args) => {
      if (args[0] === 'remote' && args[1] === 'get-url') {
        return { stdout: `${ORIGIN_REMOTE_URL}\n`, stderr: '' }
      }
      if (args[0] === 'fetch' && args[1] === '--no-tags') {
        throw new Error('fatal: unable to access repo: Could not resolve host: gitlab.example')
      }
      if (args[0] === 'fetch') {
        return { stdout: '', stderr: '' }
      }
      if (
        args[0] === 'rev-parse' &&
        args[2] === `refs/orca/merge-requests/${ORIGIN_HEAD_COMPONENT}/42^{commit}`
      ) {
        return { stdout: 'pinned-mr-sha\n', stderr: '' }
      }
      throw new Error(`unexpected git call: ${args.join(' ')}`)
    })
    gitSpy.mockClear()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const result = await runtime.resolveManagedMrBase({
        repoSelector: 'id:repo-1',
        mrIid: 42,
        sourceBranch: 'contrib/fix',
        targetBranch: 'main',
        isCrossRepository: true
      })

      expect(result).toEqual({
        baseBranch: 'pinned-mr-sha',
        compareBaseRef: 'refs/remotes/origin/main'
      })
    } finally {
      warnSpy.mockRestore()
      gitSpy.mockRestore()
    }
  })

  it.each([
    ["fatal: couldn't find remote ref refs/merge-requests/42/head", 'deleted MR / cleaned fork'],
    ['Authentication failed. Check your remote credentials.', 'auth failure'],
    [
      'This SSH host is running an older Orca relay that cannot fetch merge request heads. Reconnect to deploy the latest relay, then try again.',
      'stale relay'
    ]
  ])('fails hard instead of soft-keeping the durable MR head on: %s', async (message) => {
    // Why: soft-keep on a non-transient failure would check out a dead or
    // unauthorized tip (or mask the reconnect prompt) with a success UX.
    const localRepo = {
      id: TEST_REPO_ID,
      path: TEST_REPO_PATH,
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 1,
      issueSourcePreference: 'origin' as const
    }
    const runtimeStore = {
      ...store,
      getRepos: () => [localRepo],
      getRepo: (id: string) => (id === localRepo.id ? localRepo : undefined)
    }
    getGitLabProjectRefForRemoteMock.mockResolvedValue({
      host: 'gitlab.example',
      path: 'group/repo'
    })
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const gitSpy = vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args) => {
      if (args[0] === 'remote' && args[1] === 'get-url') {
        return { stdout: `${ORIGIN_REMOTE_URL}\n`, stderr: '' }
      }
      if (args[0] === 'fetch' && args[1] === '--no-tags') {
        throw new Error(message)
      }
      if (args[0] === 'fetch') {
        return { stdout: '', stderr: '' }
      }
      if (
        args[0] === 'rev-parse' &&
        args[2] === `refs/orca/merge-requests/${ORIGIN_HEAD_COMPONENT}/42^{commit}`
      ) {
        return { stdout: 'pinned-mr-sha\n', stderr: '' }
      }
      throw new Error(`unexpected git call: ${args.join(' ')}`)
    })
    gitSpy.mockClear()
    try {
      const result = await runtime.resolveManagedMrBase({
        repoSelector: 'id:repo-1',
        mrIid: 42,
        sourceBranch: 'contrib/fix',
        targetBranch: 'main',
        isCrossRepository: true
      })

      expect(result).toEqual({
        error: `Failed to fetch refs/merge-requests/42/head: ${message}`
      })
      expect(gitSpy).not.toHaveBeenCalledWith(
        ['rev-parse', '--verify', `refs/orca/merge-requests/${ORIGIN_HEAD_COMPONENT}/42^{commit}`],
        expect.anything()
      )
    } finally {
      gitSpy.mockRestore()
    }
  })

  it('routes runtime GitLab fork MR base git calls through the selected WSL project runtime', async () => {
    setPlatform('win32')
    const localRepo = {
      id: TEST_REPO_ID,
      path: TEST_REPO_PATH,
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 1,
      issueSourcePreference: 'origin' as const
    }
    const runtimeStore = {
      ...store,
      getRepos: () => [localRepo],
      getRepo: (id: string) => (id === localRepo.id ? localRepo : undefined),
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
    const gitSpy = vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args) => {
      if (args[0] === 'remote' && args[1] === 'get-url') {
        return { stdout: `${ORIGIN_REMOTE_URL}\n`, stderr: '' }
      }
      if (args[0] === 'fetch') {
        return { stdout: '', stderr: '' }
      }
      if (
        args[0] === 'rev-parse' &&
        args[1] === '--verify' &&
        args[2] === `refs/orca/merge-requests/${ORIGIN_HEAD_COMPONENT}/42^{commit}`
      ) {
        return { stdout: 'fork-mr-sha\n', stderr: '' }
      }
      throw new Error(`unexpected git call: ${args.join(' ')}`)
    })
    gitSpy.mockClear()
    getGlabKnownHostsMock.mockResolvedValue(['gitlab.com', 'git.internal'])
    try {
      const result = await runtime.resolveManagedMrBase({
        repoSelector: 'id:repo-1',
        mrIid: 42,
        sourceBranch: 'contrib/fix',
        isCrossRepository: true
      })

      expect(result).toEqual({ baseBranch: 'fork-mr-sha' })
      expect(getGitLabProjectRefForRemoteMock).toHaveBeenCalledWith(
        TEST_REPO_PATH,
        'origin',
        ['gitlab.com', 'git.internal'],
        null,
        { wslDistro: 'Ubuntu' }
      )
      expect(gitSpy).toHaveBeenCalledWith(['remote', 'get-url', 'origin'], {
        cwd: TEST_REPO_PATH,
        wslDistro: 'Ubuntu'
      })
      expect(gitSpy).toHaveBeenCalledWith(
        [
          'fetch',
          '--no-tags',
          'origin',
          `+refs/merge-requests/42/head:refs/orca/merge-requests/${ORIGIN_HEAD_COMPONENT}/42`
        ],
        { cwd: TEST_REPO_PATH, wslDistro: 'Ubuntu', timeout: REVIEW_HEAD_FETCH_TIMEOUT_MS }
      )
      expect(gitSpy).toHaveBeenCalledWith(
        ['rev-parse', '--verify', `refs/orca/merge-requests/${ORIGIN_HEAD_COMPONENT}/42^{commit}`],
        { cwd: TEST_REPO_PATH, wslDistro: 'Ubuntu' }
      )
    } finally {
      gitSpy.mockRestore()
    }
  })

  it('resolves SSH GitLab fork MR bases from the target project MR head ref', async () => {
    const remoteRepo = {
      id: TEST_REPO_ID,
      path: '/remote/repo',
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-1',
      issueSourcePreference: 'origin' as const
    }
    const runtimeStore = {
      ...store,
      getRepos: () => [remoteRepo],
      getRepo: (id: string) => (id === remoteRepo.id ? remoteRepo : undefined)
    }
    const provider = {
      exec: vi.fn(async (args: string[]) => {
        if (args[0] === 'remote' && args[1] === 'get-url') {
          return { stdout: `${ORIGIN_REMOTE_URL}\n`, stderr: '' }
        }
        if (
          args[0] === 'rev-parse' &&
          args[1] === '--verify' &&
          args[2] === `refs/orca/merge-requests/${ORIGIN_HEAD_COMPONENT}/77^{commit}`
        ) {
          return { stdout: 'remote-fork-mr-sha\n', stderr: '' }
        }
        throw new Error(`unexpected git call: ${args.join(' ')}`)
      }),
      fetchGitLabMergeRequestHead: vi
        .fn()
        .mockResolvedValue(`refs/orca/merge-requests/${ORIGIN_HEAD_COMPONENT}/77`),
      fetchRemoteTrackingRef: vi.fn().mockResolvedValue(undefined)
    }
    registerSshGitProvider('ssh-1', provider as never)
    getGlabKnownHostsMock.mockResolvedValue(['gitlab.com', 'git.internal'])
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    const result = await runtime.resolveManagedMrBase({
      repoSelector: 'id:repo-1',
      mrIid: 77,
      sourceBranch: 'contrib/remote-fix',
      targetBranch: 'main',
      isCrossRepository: true
    })

    expect(result).toEqual({
      baseBranch: 'remote-fork-mr-sha',
      compareBaseRef: 'refs/remotes/origin/main'
    })
    expect(provider.fetchGitLabMergeRequestHead).toHaveBeenCalledWith('/remote/repo', 'origin', 77)
    expect(provider.fetchRemoteTrackingRef).toHaveBeenCalledWith(
      '/remote/repo',
      'origin',
      'main',
      'refs/remotes/origin/main'
    )
    expect(provider.exec).toHaveBeenCalledWith(
      ['rev-parse', '--verify', `refs/orca/merge-requests/${ORIGIN_HEAD_COMPONENT}/77^{commit}`],
      '/remote/repo'
    )
    expect(getGitLabProjectRefForRemoteMock).toHaveBeenCalledWith(
      '/remote/repo',
      'origin',
      ['gitlab.com', 'git.internal'],
      'ssh-1'
    )
  })

  it('resolves SSH GitLab same-repo MR bases through remote-tracking fetches', async () => {
    const remoteRepo = {
      id: TEST_REPO_ID,
      path: '/remote/repo',
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-1',
      issueSourcePreference: 'origin' as const
    }
    const runtimeStore = {
      ...store,
      getRepos: () => [remoteRepo],
      getRepo: (id: string) => (id === remoteRepo.id ? remoteRepo : undefined)
    }
    const provider = {
      exec: vi.fn(async (args: string[]) => {
        if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === 'origin/feature/fix') {
          return { stdout: 'same-repo-mr-sha\n', stderr: '' }
        }
        throw new Error(`unexpected git call: ${args.join(' ')}`)
      }),
      fetchGitLabMergeRequestHead: vi.fn().mockResolvedValue(undefined),
      fetchRemoteTrackingRef: vi.fn().mockResolvedValue(undefined)
    }
    registerSshGitProvider('ssh-1', provider as never)
    getGlabKnownHostsMock.mockResolvedValue(['gitlab.com', 'git.internal'])
    getGitLabProjectRefForRemoteMock.mockResolvedValue({
      host: 'gitlab.example',
      path: 'group/repo'
    })
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    const result = await runtime.resolveManagedMrBase({
      repoSelector: 'id:repo-1',
      mrIid: 78,
      sourceBranch: 'feature/fix',
      targetBranch: 'main'
    })

    expect(result).toEqual({
      baseBranch: 'origin/feature/fix',
      compareBaseRef: 'refs/remotes/origin/main',
      pushTarget: { remoteName: 'origin', branchName: 'feature/fix' }
    })
    expect(provider.fetchRemoteTrackingRef).toHaveBeenCalledWith(
      '/remote/repo',
      'origin',
      'feature/fix',
      'refs/remotes/origin/feature/fix'
    )
    expect(provider.fetchRemoteTrackingRef).toHaveBeenCalledWith(
      '/remote/repo',
      'origin',
      'main',
      'refs/remotes/origin/main'
    )
    expect(provider.fetchGitLabMergeRequestHead).not.toHaveBeenCalled()
    expect(provider.exec).toHaveBeenCalledWith(
      ['rev-parse', '--verify', 'origin/feature/fix'],
      '/remote/repo'
    )
  })

  it('keeps the MR source base when the optional compare-base fetch fails', async () => {
    // Why (#6263): a merged MR's target ref may be deleted; a failed compare-base fetch must not drop the worktree onto the default branch.
    const localRepo = {
      id: TEST_REPO_ID,
      path: TEST_REPO_PATH,
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 1,
      issueSourcePreference: 'origin' as const
    }
    const runtimeStore = {
      ...store,
      getRepos: () => [localRepo],
      getRepo: (id: string) => (id === localRepo.id ? localRepo : undefined)
    }
    getGitLabProjectRefForRemoteMock.mockResolvedValue({
      host: 'gitlab.example',
      path: 'group/repo'
    })
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const gitSpy = vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args) => {
      if (
        args[0] === 'fetch' &&
        args[2] === '+refs/heads/feature/fix:refs/remotes/origin/feature/fix'
      ) {
        return { stdout: '', stderr: '' }
      }
      if (args[0] === 'fetch' && args[2] === '+refs/heads/main:refs/remotes/origin/main') {
        // Target branch was deleted on the remote (merged MR).
        throw new Error("couldn't find remote ref refs/heads/main")
      }
      if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === 'origin/feature/fix') {
        return { stdout: 'same-repo-mr-sha\n', stderr: '' }
      }
      throw new Error(`unexpected git call: ${args.join(' ')}`)
    })
    gitSpy.mockClear()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const result = await runtime.resolveManagedMrBase({
        repoSelector: 'id:repo-1',
        mrIid: 79,
        sourceBranch: 'feature/fix',
        targetBranch: 'main'
      })

      expect(result).toEqual({
        baseBranch: 'origin/feature/fix',
        pushTarget: { remoteName: 'origin', branchName: 'feature/fix' }
      })
      expect(result).not.toHaveProperty('compareBaseRef')
      expect(result).not.toHaveProperty('error')
    } finally {
      warnSpy.mockRestore()
      gitSpy.mockRestore()
    }
  })

  it('keeps the MR compare base when the fetch fails but the local ref resolves', async () => {
    // Why: a transient fetch failure must not drop a compare base we already have on disk.
    const localRepo = {
      id: TEST_REPO_ID,
      path: TEST_REPO_PATH,
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 1,
      issueSourcePreference: 'origin' as const
    }
    const runtimeStore = {
      ...store,
      getRepos: () => [localRepo],
      getRepo: (id: string) => (id === localRepo.id ? localRepo : undefined)
    }
    getGitLabProjectRefForRemoteMock.mockResolvedValue({
      host: 'gitlab.example',
      path: 'group/repo'
    })
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const gitSpy = vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args) => {
      if (
        args[0] === 'fetch' &&
        args[2] === '+refs/heads/feature/fix:refs/remotes/origin/feature/fix'
      ) {
        return { stdout: '', stderr: '' }
      }
      if (args[0] === 'fetch' && args[2] === '+refs/heads/main:refs/remotes/origin/main') {
        throw new Error('fatal: unable to access repo: Could not resolve host: gitlab.example')
      }
      if (args[0] === 'rev-parse' && args[2] === 'origin/feature/fix') {
        return { stdout: 'same-repo-mr-sha\n', stderr: '' }
      }
      if (args[0] === 'rev-parse' && args[2] === 'refs/remotes/origin/main^{commit}') {
        return { stdout: 'base-commit-sha\n', stderr: '' }
      }
      throw new Error(`unexpected git call: ${args.join(' ')}`)
    })
    gitSpy.mockClear()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const result = await runtime.resolveManagedMrBase({
        repoSelector: 'id:repo-1',
        mrIid: 80,
        sourceBranch: 'feature/fix',
        targetBranch: 'main'
      })

      expect(result).toEqual({
        baseBranch: 'origin/feature/fix',
        compareBaseRef: 'refs/remotes/origin/main',
        pushTarget: { remoteName: 'origin', branchName: 'feature/fix' }
      })
    } finally {
      warnSpy.mockRestore()
      gitSpy.mockRestore()
    }
  })

  it('keeps a cross-repo fork MR compare base when the fetch fails but the local ref resolves', async () => {
    // Why: mirror the GitHub fork soft-fail-keep — a transient compare-base fetch
    // failure must not drop a base we already have on disk onto the fork MR head SHA.
    const remoteRepo = {
      id: TEST_REPO_ID,
      path: '/remote/repo',
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-1',
      issueSourcePreference: 'origin' as const
    }
    const runtimeStore = {
      ...store,
      getRepos: () => [remoteRepo],
      getRepo: (id: string) => (id === remoteRepo.id ? remoteRepo : undefined)
    }
    const durableLocalRef = `refs/orca/merge-requests/${ORIGIN_HEAD_COMPONENT}/77`
    const provider = {
      exec: vi.fn(async (args: string[]) => {
        if (args[0] === 'rev-parse' && args[2] === `${durableLocalRef}^{commit}`) {
          return { stdout: 'remote-fork-mr-sha\n', stderr: '' }
        }
        if (args[0] === 'rev-parse' && args[2] === 'refs/remotes/origin/main^{commit}') {
          return { stdout: 'base-commit-sha\n', stderr: '' }
        }
        throw new Error(`unexpected git call: ${args.join(' ')}`)
      }),
      fetchGitLabMergeRequestHead: vi.fn().mockResolvedValue(durableLocalRef),
      fetchRemoteTrackingRef: vi.fn(async () => {
        throw new Error('fatal: unable to access repo: Could not resolve host: gitlab.example')
      })
    }
    registerSshGitProvider('ssh-1', provider as never)
    getGlabKnownHostsMock.mockResolvedValue(['gitlab.com', 'git.internal'])
    getGitLabProjectRefForRemoteMock.mockResolvedValue({
      host: 'gitlab.example',
      path: 'group/repo'
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    try {
      const result = await runtime.resolveManagedMrBase({
        repoSelector: 'id:repo-1',
        mrIid: 77,
        sourceBranch: 'contrib/remote-fix',
        targetBranch: 'main',
        isCrossRepository: true
      })

      expect(result).toEqual({
        baseBranch: 'remote-fork-mr-sha',
        compareBaseRef: 'refs/remotes/origin/main'
      })
      expect(provider.exec).toHaveBeenCalledWith(
        ['rev-parse', '--verify', 'refs/remotes/origin/main^{commit}'],
        '/remote/repo'
      )
    } finally {
      warnSpy.mockRestore()
    }
  })
})

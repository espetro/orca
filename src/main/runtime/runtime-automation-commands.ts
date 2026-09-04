import type {
  AutomationChangeSelector,
  AutomationListParams,
  AutomationListResult
} from '../../shared/automation-list-scope'
import type {
  AutomationDestination,
  AutomationOwnerFenceOperation,
  AutomationOwnerPrecondition
} from '../../shared/automation-owner-precondition'
import type {
  Automation,
  AutomationCreateInput,
  AutomationRun,
  AutomationUpdateInput,
  AutomationWorkspaceMode
} from '../../shared/automations-types'
import type { Repo } from '../../shared/repo-types'
import type {
  AutomationsChangedPayload,
  RuntimeClientEvent
} from '../../shared/runtime-client-events'
import type { RuntimeNotifier } from '../../shared/runtime-notifier-types'
import { runAutomationNowFenced } from '../automations/refused-manual-run'
import type { AutomationService } from '../automations/service'
import type {
  RuntimeAutomationCreateInput,
  RuntimeAutomationUpdateInput,
  RuntimeStore
} from './orca-runtime'

export type RuntimeAutomationCommandsDeps = {
  store: RuntimeStore | null
  automationService: () => AutomationService | null
  notifier: () => RuntimeNotifier | null
  emitClientEvent: (event: RuntimeClientEvent) => void
  showRepo: (repoSelector: string) => Promise<Repo>
  showManagedWorktree: (worktreeSelector: string) => Promise<unknown>
}

export class RuntimeAutomationCommands {
  private readonly deps: RuntimeAutomationCommandsDeps

  constructor(deps: RuntimeAutomationCommandsDeps) {
    this.deps = deps
  }

  listAutomations(): Automation[] {
    if (!this.deps.store?.listAutomations) {
      throw new Error('runtime_unavailable')
    }
    return this.deps.store.listAutomations()
  }

  public underExternalProbePriority<T>(run: () => T): T {
    const wrap = this.deps.automationService()?.externalProbePriority
    return wrap ? wrap(run) : run()
  }

  listAutomationsForScope(params: AutomationListParams): AutomationListResult {
    const store = this.deps.store
    if (!store?.listAutomationsForScope) {
      throw new Error('runtime_unavailable')
    }
    return this.underExternalProbePriority(() => store.listAutomationsForScope!(params))
  }

  public fenceAutomationOwner(
    id: string,
    expectedOwner: AutomationOwnerPrecondition | undefined,
    operation: AutomationOwnerFenceOperation
  ): void {
    if (!this.deps.store?.assertAutomationOwnerFence) {
      if (expectedOwner) {
        throw new Error('runtime_unavailable')
      }
      return
    }
    this.deps.store.assertAutomationOwnerFence({ id, expectedOwner, operation })
  }

  listAutomationRuns(
    automationId?: string,
    expectedOwner?: AutomationOwnerPrecondition
  ): AutomationRun[] {
    const store = this.deps.store
    if (!store?.listAutomationRuns) {
      throw new Error('runtime_unavailable')
    }
    if (expectedOwner && !automationId) {
      throw new Error('An expected owner requires an automation id.')
    }
    return this.underExternalProbePriority(() => {
      if (automationId) {
        this.fenceAutomationOwner(automationId, expectedOwner, 'read')
      }
      return store.listAutomationRuns!(automationId)
    })
  }

  automationOwnerPrecondition(id: string): AutomationOwnerPrecondition | null {
    return this.deps.store?.automationOwnerPrecondition?.(id) ?? null
  }

  showAutomation(id: string, expectedOwner?: AutomationOwnerPrecondition): Automation {
    const automation = this.listAutomations().find((entry) => entry.id === id)
    if (!automation) {
      throw new Error('Automation not found.')
    }
    this.fenceAutomationOwner(id, expectedOwner, 'read')
    return automation
  }

  async createAutomation(input: RuntimeAutomationCreateInput): Promise<Automation> {
    if (!this.deps.store?.createAutomation) {
      throw new Error('runtime_unavailable')
    }
    const target = await this.resolveAutomationTarget(input)
    assertAutomationRunContextMatchesRepo(input.runContext, target.repo)
    if (input.reuseSession && target.workspaceMode !== 'existing') {
      throw new Error('Session reuse requires an existing workspace target.')
    }
    const createInput: AutomationCreateInput = {
      creationKey: input.creationKey,
      name: input.name,
      prompt: input.prompt,
      precheck: input.precheck,
      agentId: input.agentId,
      runContext: input.runContext,
      sourceContext: input.sourceContext,
      projectId: target.projectId,
      workspaceMode: target.workspaceMode,
      workspaceId: target.workspaceId,
      baseBranch: input.baseBranch,
      setupDecision: input.setupDecision,
      reuseSession: input.reuseSession,
      timezone: input.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      rrule: input.rrule,
      dtstart: input.dtstart,
      enabled: input.enabled,
      missedRunGraceMinutes: input.missedRunGraceMinutes
    }
    return this.underExternalProbePriority(() => {
      const created = this.deps.store!.createAutomation!(
        createInput,
        input.destination ? { destination: input.destination } : undefined
      )
      const selector = this.automationChangeSelector(created.id)
      this.publishAutomationDefinitionChange(selector, selector)
      return created
    })
  }

  public automationChangeSelector(id: string): AutomationChangeSelector | null {
    return this.deps.store?.automationChangeSelector?.(id) ?? null
  }

  public publishAutomationDefinitionChange(
    before: AutomationChangeSelector | null,
    after: AutomationChangeSelector | null
  ): void {
    for (const selector of automationChangePublications(before, after)) {
      this.notifyAutomationsChanged({ reason: 'definition', ...(selector ? { selector } : {}) })
    }
  }

  async updateAutomation(
    id: string,
    updates: RuntimeAutomationUpdateInput,
    options?: { expectedOwner?: AutomationOwnerPrecondition; destination?: AutomationDestination }
  ): Promise<Automation> {
    if (!this.deps.store?.updateAutomation) {
      throw new Error('runtime_unavailable')
    }
    const current = this.showAutomation(id)
    const patch: AutomationUpdateInput = {}
    if (hasRuntimeAutomationUpdateValue(updates, 'name')) {
      patch.name = updates.name
    }
    if (hasRuntimeAutomationUpdateValue(updates, 'prompt')) {
      patch.prompt = updates.prompt
    }
    if (hasRuntimeAutomationUpdateValue(updates, 'precheck')) {
      patch.precheck = updates.precheck
    }
    if (hasRuntimeAutomationUpdateValue(updates, 'agentId')) {
      patch.agentId = updates.agentId
    }
    if (hasRuntimeAutomationUpdateValue(updates, 'runContext')) {
      patch.runContext = updates.runContext
    }
    if (hasRuntimeAutomationUpdateValue(updates, 'sourceContext')) {
      patch.sourceContext = updates.sourceContext
    }
    if (hasRuntimeAutomationUpdateValue(updates, 'baseBranch')) {
      patch.baseBranch = updates.baseBranch
    }
    if (hasRuntimeAutomationUpdateValue(updates, 'setupDecision')) {
      patch.setupDecision = updates.setupDecision
    }
    if (hasRuntimeAutomationUpdateValue(updates, 'reuseSession')) {
      patch.reuseSession = updates.reuseSession
    }
    if (hasRuntimeAutomationUpdateValue(updates, 'timezone')) {
      patch.timezone = updates.timezone
    }
    if (hasRuntimeAutomationUpdateValue(updates, 'rrule')) {
      patch.rrule = updates.rrule
    }
    if (hasRuntimeAutomationUpdateValue(updates, 'dtstart')) {
      patch.dtstart = updates.dtstart
    }
    if (hasRuntimeAutomationUpdateValue(updates, 'enabled')) {
      patch.enabled = updates.enabled
    }
    if (hasRuntimeAutomationUpdateValue(updates, 'missedRunGraceMinutes')) {
      patch.missedRunGraceMinutes = updates.missedRunGraceMinutes
    }
    const targetChanged =
      hasRuntimeAutomationUpdateValue(updates, 'repo') ||
      hasRuntimeAutomationUpdateValue(updates, 'workspace') ||
      hasRuntimeAutomationUpdateValue(updates, 'workspaceMode')
    if (targetChanged) {
      const target = await this.resolveAutomationTarget(updates, current)
      assertAutomationRunContextMatchesRepo(updates.runContext, target.repo)
      if (patch.reuseSession === true && target.workspaceMode !== 'existing') {
        throw new Error('Session reuse requires an existing workspace target.')
      }
      patch.projectId = target.projectId
      patch.workspaceMode = target.workspaceMode
      patch.workspaceId = target.workspaceId
      if (target.workspaceMode !== 'existing') {
        patch.reuseSession = false
      }
    } else if (hasRuntimeAutomationUpdateValue(updates, 'runContext') && current.projectId) {
      const currentRepo = await this.deps.showRepo(`id:${current.projectId}`)
      assertAutomationRunContextMatchesRepo(updates.runContext, currentRepo)
    }
    if (!targetChanged && patch.reuseSession && current.workspaceMode !== 'existing') {
      throw new Error('Session reuse requires an existing workspace target.')
    }
    return this.underExternalProbePriority(() => {
      // Captured first: an update may move the record to another host.
      const before = this.automationChangeSelector(id)
      const updated = this.deps.store!.updateAutomation!(id, patch, options)
      this.publishAutomationDefinitionChange(before, this.automationChangeSelector(id))
      return updated
    })
  }

  deleteAutomation(
    id: string,
    expectedOwner?: AutomationOwnerPrecondition
  ): { removed: boolean; id: string } {
    if (!this.deps.store?.deleteAutomation) {
      throw new Error('runtime_unavailable')
    }
    return this.underExternalProbePriority(() => {
      this.showAutomation(id)
      const before = this.automationChangeSelector(id)
      this.deps.store!.deleteAutomation!(id, expectedOwner ? { expectedOwner } : undefined)
      this.publishAutomationDefinitionChange(before, before)
      return { removed: true, id }
    })
  }

  async runAutomationNow(
    id: string,
    expectedOwner?: AutomationOwnerPrecondition
  ): Promise<AutomationRun> {
    const service = this.deps.automationService()
    if (!service) {
      throw new Error('runtime_unavailable')
    }
    // Why: an orphan or re-registered host must be refused before dispatch, not
    // after a session starts. The lease spans the whole dispatch promise, so
    // queued external probes stay parked until the run the user is waiting on settles.
    return await this.underExternalProbePriority(() =>
      runAutomationNowFenced({
        fence: () => this.fenceAutomationOwner(id, expectedOwner, 'execute'),
        service,
        automationId: id
      })
    )
  }

  public async resolveAutomationTarget(
    input: {
      repo?: string
      workspace?: string
      workspaceMode?: AutomationWorkspaceMode
      baseBranch?: string | null
    },
    current?: Automation
  ): Promise<{
    projectId: string
    workspaceMode: AutomationWorkspaceMode
    workspaceId?: string | null
    repo: Repo | null
  }> {
    const hasRepo = input.repo !== undefined
    const hasWorkspace = input.workspace !== undefined
    if (
      current?.workspaceMode === 'existing' &&
      hasRepo &&
      !hasWorkspace &&
      input.workspaceMode !== 'new_per_run'
    ) {
      throw new Error(
        'Repo updates for existing-workspace automation require workspaceMode new_per_run.'
      )
    }
    const workspace = input.workspace ? await this.deps.showManagedWorktree(input.workspace) : null
    const repoSelector =
      input.repo ??
      (workspace?.repoId
        ? `id:${workspace.repoId}`
        : current?.projectId
          ? `id:${current.projectId}`
          : null)
    const repo = repoSelector ? await this.deps.showRepo(repoSelector) : null
    const workspaceMode =
      input.workspaceMode ??
      (workspace
        ? 'existing'
        : input.repo && !current
          ? 'new_per_run'
          : (current?.workspaceMode ?? 'new_per_run'))
    if (workspaceMode === 'existing') {
      const workspaceId = workspace?.id ?? current?.workspaceId
      const projectId = workspace?.repoId ?? current?.projectId
      if (repo && repo.id !== projectId) {
        throw new Error('Selected workspace belongs to a different repo.')
      }
      if (!workspaceId || !projectId) {
        throw new Error('Existing-workspace automation requires --workspace.')
      }
      return { projectId, workspaceMode, workspaceId, repo }
    }
    const projectId = repo?.id ?? workspace?.repoId ?? current?.projectId
    if (!projectId) {
      throw new Error('Automation requires --repo or --workspace.')
    }
    return { projectId, workspaceMode: 'new_per_run', workspaceId: null, repo }
  }

  notifyAutomationsChanged(payload: AutomationsChangedPayload = {}): void {
    this.deps.notifier()?.automationsChanged?.(payload)
    this.deps.emitClientEvent({ type: 'automationsChanged', ...payload })
  }
}

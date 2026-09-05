import { isAgentSkillSharingEnabled } from '../../shared/agent-skill-sharing-gate'
import { isArtifactSharingEnabled } from '../../shared/artifact-sharing-gate'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { RuntimeStore } from './orca-runtime'
import { TASK_PROVIDERS } from '../../shared/task-providers'
import { haveSameDisabledTuiAgents } from '../../shared/tui-agent-selection'

export type RuntimeClientConnectionCommandsDeps = {
  store: RuntimeStore | null
  notifyReposChanged: () => void
  reconcileManagedAgentHooks: () => Promise<void>
}

export class RuntimeClientConnectionCommands {
  private readonly deps: RuntimeClientConnectionCommandsDeps

  constructor(deps: RuntimeClientConnectionCommandsDeps) {
    this.deps = deps
  }

  getClientSettings(): Pick<
    GlobalSettings,
    | 'worktreeVisibilityDefaults'
    | 'defaultTuiAgent'
    | 'disabledTuiAgents'
    | 'agentCmdOverrides'
    | 'agentDefaultArgs'
    | 'agentDefaultEnv'
    | 'agentStatusHooksEnabled'
    | 'defaultTaskSource'
    | 'defaultTaskViewPreset'
    | 'visibleTaskProviders'
    | 'defaultRepoSelection'
    | 'defaultLinearTeamSelection'
    | 'githubProjects'
    | 'experimentalNewWorktreeCardStyle'
    | 'compactWorktreeCards'
    | 'minimaxGroupId'
    | 'minimaxUsageModels'
    | 'prBotAuthorOverrides'
    // Read-only on purpose: clients preflight the publish capability here, but SettingsUpdate
    // still omits the key so no RPC caller can grant it to itself.
    | 'artifactSharingEnabled'
    | 'agentSkillSharingEnabled'
  > {
    if (!this.deps.store?.getSettings) {
      throw new Error('runtime_unavailable')
    }
    const settings = this.deps.store.getSettings()
    return {
      worktreeVisibilityDefaults: settings.worktreeVisibilityDefaults ?? { external: 'hide' },
      defaultTuiAgent: settings.defaultTuiAgent ?? null,
      disabledTuiAgents: settings.disabledTuiAgents ?? [],
      agentCmdOverrides: settings.agentCmdOverrides ?? {},
      agentDefaultArgs: settings.agentDefaultArgs ?? {},
      agentDefaultEnv: settings.agentDefaultEnv ?? {},
      agentStatusHooksEnabled: settings.agentStatusHooksEnabled !== false,
      defaultTaskSource: settings.defaultTaskSource ?? 'github',
      defaultTaskViewPreset: settings.defaultTaskViewPreset ?? 'issues',
      visibleTaskProviders: settings.visibleTaskProviders ?? [...TASK_PROVIDERS],
      defaultRepoSelection: settings.defaultRepoSelection ?? null,
      defaultLinearTeamSelection: settings.defaultLinearTeamSelection ?? null,
      githubProjects: settings.githubProjects,
      experimentalNewWorktreeCardStyle: settings.experimentalNewWorktreeCardStyle === true,
      compactWorktreeCards: settings.compactWorktreeCards === true,
      minimaxGroupId: settings.minimaxGroupId ?? '',
      minimaxUsageModels: settings.minimaxUsageModels ?? 'general',
      prBotAuthorOverrides: settings.prBotAuthorOverrides ?? [],
      artifactSharingEnabled: isArtifactSharingEnabled(settings),
      agentSkillSharingEnabled: isAgentSkillSharingEnabled(settings)
    }
  }

  async updateClientSettings(
    updates: Pick<
      Partial<GlobalSettings>,
      | 'worktreeVisibilityDefaults'
      | 'agentStatusHooksEnabled'
      | 'defaultTuiAgent'
      | 'disabledTuiAgents'
      | 'agentDefaultArgs'
      | 'agentDefaultEnv'
      | 'defaultTaskSource'
      | 'defaultTaskViewPreset'
      | 'visibleTaskProviders'
      | 'defaultRepoSelection'
      | 'defaultLinearTeamSelection'
      | 'githubProjects'
      | 'experimentalNewWorktreeCardStyle'
      | 'compactWorktreeCards'
      | 'minimaxGroupId'
      | 'minimaxUsageModels'
      | 'prBotAuthorOverrides'
    >
  ): Promise<
    Pick<
      GlobalSettings,
      | 'worktreeVisibilityDefaults'
      | 'defaultTuiAgent'
      | 'disabledTuiAgents'
      | 'agentCmdOverrides'
      | 'agentDefaultArgs'
      | 'agentDefaultEnv'
      | 'agentStatusHooksEnabled'
      | 'defaultTaskSource'
      | 'defaultTaskViewPreset'
      | 'visibleTaskProviders'
      | 'defaultRepoSelection'
      | 'defaultLinearTeamSelection'
      | 'githubProjects'
      | 'experimentalNewWorktreeCardStyle'
      | 'compactWorktreeCards'
      | 'minimaxGroupId'
      | 'minimaxUsageModels'
      | 'prBotAuthorOverrides'
    >
  > {
    if (!this.deps.store?.getSettings || !this.deps.store.updateSettings) {
      throw new Error('runtime_unavailable')
    }
    const beforeSettings = this.deps.store.getSettings()
    const before = beforeSettings.agentStatusHooksEnabled !== false
    this.deps.store.updateSettings(updates, { notifyListeners: true })
    const settings = this.deps.store.getSettings()
    if (updates.worktreeVisibilityDefaults !== undefined) {
      this.deps.notifyReposChanged()
    }
    if (
      (typeof updates.agentStatusHooksEnabled === 'boolean' &&
        before !== updates.agentStatusHooksEnabled) ||
      (updates.disabledTuiAgents !== undefined &&
        !haveSameDisabledTuiAgents(beforeSettings.disabledTuiAgents, settings.disabledTuiAgents))
    ) {
      await this.deps.reconcileManagedAgentHooks()
    }
    return this.getClientSettings()
  }
}

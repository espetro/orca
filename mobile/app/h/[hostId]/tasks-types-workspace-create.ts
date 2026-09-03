import type { WorkspaceAgentChoice } from '../../../src/tasks/workspace-agent-selection'
import type { SparsePreset } from '../../../../src/shared/worktree/create-types'
import type { ActionableTaskItem, SetupDecision } from './tasks-types-core'

export type SetupPrompt = {
  item: ActionableTaskItem
  repoIdOverride?: string
  agentOverride?: WorkspaceAgentChoice
  workspaceNameOverride?: string
  noteOverride?: string
  baseBranchOverride?: string
  branchNameOverride?: string
  sparseCheckoutOverride?: { directories: string[]; presetId?: string }
  repoName: string
  command: string
  source: string | null
}

export type WorkspaceCreateArgs = {
  item: ActionableTaskItem
  repoIdOverride?: string
  setupOverride?: Exclude<SetupDecision, 'inherit'>
  agentOverride?: WorkspaceAgentChoice
  workspaceNameOverride?: string
  noteOverride?: string
  baseBranchOverride?: string
  branchNameOverride?: string
  sparseCheckoutOverride?: { directories: string[]; presetId?: string }
}

export type OrcaYamlTrustPrompt = WorkspaceCreateArgs & {
  repoId: string
  repoName: string
  scriptContent: string
  contentHash: string
  previouslyApproved: boolean
}

export type WorkspaceCreateDraft = {
  item: ActionableTaskItem
  repoIdOverride?: string
}

export type WorkspaceSparseDraft = {
  mode: 'new' | 'edit'
  presetId?: string
  name: string
  directoriesText: string
}

export function sortSparsePresetsByName(presets: SparsePreset[]): SparsePreset[] {
  return [...presets].sort((left, right) => left.name.localeCompare(right.name))
}

export function workspaceAgentIconId(agent: WorkspaceAgentChoice): string {
  return agent === 'blank' ? '__blank__' : agent
}

export type ProjectRepoNotInOrcaPrompt = {
  owner: string
  repo: string
  url: string | null
}

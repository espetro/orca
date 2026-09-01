import { parse } from 'yaml'

/**
 * Workflow shapes these contract tests rely on. Parsed YAML is cast once inside
 * parseWorkflow; fields a given workflow omits simply read as undefined at
 * runtime while staying typed here.
 */
export type WorkflowStep = {
  name?: string
  run?: string
  uses?: string
  with: Record<string, unknown>
  env?: Record<string, string>
  if?: string
  'working-directory'?: string
  shell?: string
  'continue-on-error'?: boolean
  'timeout-minutes'?: number
}

export type WorkflowJob = {
  uses?: string
  with?: Record<string, unknown>
  name?: string
  'runs-on'?: string | string[]
  needs?: string | string[]
  if?: string
  steps: WorkflowStep[]
  strategy?: { matrix?: Record<string, unknown> }
  outputs?: Record<string, string>
  env?: Record<string, string>
  permissions?: Record<string, string>
  concurrency?: { group: string; 'cancel-in-progress'?: boolean | string }
  container?: { image: string; options?: string }
  services?: Record<string, unknown>
  defaults?: { run?: { 'working-directory'?: string; shell?: string } }
  'timeout-minutes'?: number
}

export type WorkflowTrigger = {
  pull_request?: {
    paths?: string[]
    'paths-ignore'?: string[]
    branches?: string[]
    types?: string[]
  }
  push?: { branches?: string[]; tags?: string[] }
  schedule?: { cron: string }[]
  workflow_dispatch?: { inputs?: Record<string, WorkflowInput> } | null
  workflow_call?: { inputs?: Record<string, WorkflowInput> } | null
  release?: { types?: string[] }
  issues?: { types?: string[] }
  issue_comment?: { types?: string[] }
  pull_request_review?: { types?: string[] }
  pull_request_target?: { paths?: string[]; branches?: string[]; types?: string[] }
}

export type WorkflowInput = { description?: string; default?: string; required?: boolean }

export type Workflow = {
  name?: string
  on?: WorkflowTrigger
  jobs: Record<string, WorkflowJob>
  env?: Record<string, string>
  permissions?: Record<string, string>
  concurrency?: { group: string; 'cancel-in-progress'?: boolean | string }
  defaults?: { run?: { 'working-directory'?: string; shell?: string } }
}

/** A reusable/composite GitHub Actions workflow or action. */
export type ReusableWorkflow = Workflow & {
  runs?: { steps: WorkflowStep[]; using?: string; shell?: string }
  inputs?: Record<string, WorkflowInput>
  outputs?: Record<string, { value: string }>
}

/**
 * Parse a workflow or composite action YAML, casting once to the shape the
 * contract tests rely on. Actions additionally expose runs/inputs/outputs.
 */
export function parseWorkflow(source: string): ReusableWorkflow {
  return parse(source) as ReusableWorkflow
}

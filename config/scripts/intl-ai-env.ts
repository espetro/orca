import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import dotenv from 'dotenv'

export const OPENROUTER_API_KEY_ENV_VAR = 'OPENROUTER_API_KEY'
export const ORCA_STASH_ENV_PATH = '/Users/josocjoq/Documents/prjcts/_own/stash/.env'

export type EnvKeyResolution =
  | { kind: 'found'; source: 'shell' | 'stash' }
  | { kind: 'missing'; reason: string }

async function readStashShellExports(stashPath: string): Promise<Record<string, string>> {
  let content: string
  try {
    content = await fs.readFile(stashPath, 'utf8')
  } catch {
    return {}
  }
  const env: Record<string, string> = {}
  const parsed = dotenv.parse(content)
  for (const [key, value] of Object.entries(parsed)) {
    env[key] = value
  }
  return env
}

export async function resolveOpenRouterApiKey(
  shellEnv: NodeJS.ProcessEnv = process.env,
  stashPath: string = ORCA_STASH_ENV_PATH
): Promise<EnvKeyResolution> {
  const shellValue = shellEnv[OPENROUTER_API_KEY_ENV_VAR]
  if (typeof shellValue === 'string' && shellValue.trim().length > 0) {
    return { kind: 'found', source: 'shell' }
  }
  const stashEnv = await readStashShellExports(stashPath)
  const stashValue = stashEnv[OPENROUTER_API_KEY_ENV_VAR]
  if (typeof stashValue === 'string' && stashValue.trim().length > 0) {
    return { kind: 'found', source: 'stash' }
  }
  return {
    kind: 'missing',
    reason:
      `${OPENROUTER_API_KEY_ENV_VAR} not found in shell env or in ${path.resolve(stashPath)}. ` +
      `Set it in the shell or add ${OPENROUTER_API_KEY_ENV_VAR} to the stash .env file.`
  }
}

export function formatMissingKeyError(resolution: EnvKeyResolution): string {
  return resolution.kind === 'missing' ? resolution.reason : ''
}

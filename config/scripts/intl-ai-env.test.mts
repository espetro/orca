import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  OPENROUTER_API_KEY_ENV_VAR,
  ORCA_STASH_ENV_PATH,
  resolveOpenRouterApiKey
} from './intl-ai-env.mts'

async function makeTempStashEnv(keyValue: string | null): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'intl-ai-env-test-'))
  const filePath = path.join(dir, '.env')
  if (keyValue !== null) {
    await fs.writeFile(filePath, `${OPENROUTER_API_KEY_ENV_VAR}=${keyValue}\n`, 'utf8')
  }
  return filePath
}

const tempDirs: string[] = []
afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })))
  tempDirs.length = 0
})

describe('intl-ai env key resolution', () => {
  it('prefers the shell env over the stash .env', async () => {
    const stashPath = await makeTempStashEnv('stash-key')
    tempDirs.push(path.dirname(stashPath))
    const resolution = await resolveOpenRouterApiKey(
      { [OPENROUTER_API_KEY_ENV_VAR]: 'shell-key' },
      stashPath
    )
    expect(resolution).toEqual({ kind: 'found', source: 'shell' })
  })

  it('falls back to the stash .env when the shell env is empty', async () => {
    const stashPath = await makeTempStashEnv('stash-key')
    tempDirs.push(path.dirname(stashPath))
    const resolution = await resolveOpenRouterApiKey({}, stashPath)
    expect(resolution).toEqual({ kind: 'found', source: 'stash' })
  })

  it('fails loud naming the stash path when no key exists', async () => {
    const stashPath = await makeTempStashEnv(null)
    tempDirs.push(path.dirname(stashPath))
    const resolution = await resolveOpenRouterApiKey({}, stashPath)
    expect(resolution.kind).toBe('missing')
    if (resolution.kind === 'missing') {
      expect(resolution.reason).toContain(OPENROUTER_API_KEY_ENV_VAR)
      expect(resolution.reason).toContain(stashPath)
    }
  })

  it('treats a whitespace-only shell value as absent', async () => {
    const stashPath = await makeTempStashEnv('stash-key')
    tempDirs.push(path.dirname(stashPath))
    const resolution = await resolveOpenRouterApiKey(
      { [OPENROUTER_API_KEY_ENV_VAR]: '   ' },
      stashPath
    )
    expect(resolution).toEqual({ kind: 'found', source: 'stash' })
  })

  it('points at the real stash path by default', () => {
    expect(ORCA_STASH_ENV_PATH).toContain('/stash/.env')
  })

  it('never embeds a literal key value in wrapper sources', async () => {
    // Why: the key must stay in env/secret files, never in code.
    const { readdir } = await import('node:fs/promises')
    const scriptDir = path.dirname(new URL(import.meta.url).pathname)
    const wrapperSources = (await readdir(scriptDir))
      .filter((name) => name.startsWith('intl-ai-') && name.endsWith('.mts'))
      .filter((name) => !name.endsWith('.test.mts'))
    const keyPattern = /(sk-or-v1-|OPENROUTER_API_KEY\s*=\s*['"][^'"]{8,})/
    for (const fileName of wrapperSources) {
      const content = await fs.readFile(path.join(scriptDir, fileName), 'utf8')
      expect(content, `${fileName} must not embed a key`).not.toMatch(keyPattern)
    }
  })
})

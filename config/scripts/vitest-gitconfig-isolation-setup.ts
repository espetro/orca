import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'vitest'

// Why: fixtures run real git against temp repos; a developer's core.excludesFile
// (e.g. a global `*.log` rule) makes `git add keep.log` fail even with :(literal)
// pathspecs. Point every fixture at an empty global config and skip the system one.
const gitConfigRoot = mkdtempSync(join(tmpdir(), 'orca-vitest-gitconfig-'))
writeFileSync(join(gitConfigRoot, 'global.gitconfig'), '')
const previous = {
  GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
  GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM
}
process.env.GIT_CONFIG_GLOBAL = join(gitConfigRoot, 'global.gitconfig')
process.env.GIT_CONFIG_NOSYSTEM = '1'

afterAll(() => {
  for (const name of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'] as const) {
    if (previous[name] === undefined) {
      delete process.env[name]
    } else {
      process.env[name] = previous[name]
    }
  }
  rmSync(gitConfigRoot, { recursive: true, force: true })
})

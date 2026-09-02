import type * as ChildProcess from 'node:child_process'

// Why: dev machines often ignore *.log/node_modules globally; fixtures must not inherit that.
export function gitFixtureExecOptions(cwd: string): ChildProcess.ExecFileSyncOptions & {
  encoding: 'utf8'
} {
  return {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: osDevNull(),
      GIT_CONFIG_SYSTEM: osDevNull()
    }
  }
}

function osDevNull(): string {
  return process.platform === 'win32' ? 'NUL' : '/dev/null'
}

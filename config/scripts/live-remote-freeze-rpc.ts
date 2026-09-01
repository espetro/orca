import { spawn, spawnSync } from 'node:child_process'
import path from 'node:path'

export const MAX_ORCA_RPC_OUTPUT_BYTES = 20 * 1024 * 1024

export type OrcaRpcOutput = {
  output: string
  bytes: number
  exceeded: boolean
}

export function appendOrcaRpcOutput(
  output: string,
  chunk: string,
  bytes: number,
  limit = MAX_ORCA_RPC_OUTPUT_BYTES
): OrcaRpcOutput {
  const nextBytes = bytes + Buffer.byteLength(chunk)
  return {
    output: nextBytes > limit ? output : output + chunk,
    bytes: nextBytes,
    exceeded: nextBytes > limit
  }
}

type CliEnv = {
  ORCA_CLI_COMMAND?: string
  ORCA_DEV_REPO_ROOT?: string
  APPDATA?: string
  USERPROFILE?: string
  ORCA_USER_DATA_PATH?: string
  ORCA_DEV_USER_DATA_PATH?: string
  ORCA_APP_EXECUTABLE?: string
  [key: string]: string | undefined
}

export function resolveOrcaCliCommand({
  env = process.env as CliEnv,
  platform = process.platform
}: { env?: CliEnv; platform?: string } = {}) {
  if (env.ORCA_CLI_COMMAND?.trim()) {
    return env.ORCA_CLI_COMMAND.trim()
  }
  if (env.ORCA_DEV_REPO_ROOT) {
    return 'orca-dev'
  }
  return platform === 'linux' ? 'orca-ide' : 'orca'
}

export type OrcaCliInvocation = {
  command: string
  prefixArgs: string[]
  env?: NodeJS.ProcessEnv
}

export function resolveOrcaCliInvocation({
  env = process.env as CliEnv,
  platform = process.platform,
  nodeExecutable = process.execPath
}: { env?: CliEnv; platform?: string; nodeExecutable?: string } = {}): OrcaCliInvocation {
  const command = resolveOrcaCliCommand({ env, platform })
  const commandName = platform === 'win32' ? path.win32.basename(command).toLowerCase() : command
  if (
    platform === 'win32' &&
    env.ORCA_DEV_REPO_ROOT &&
    (commandName === 'orca-dev' || commandName === 'orca-dev.cmd')
  ) {
    const defaultUserDataPath = path.win32.join(
      env.APPDATA ?? path.win32.join(env.USERPROFILE ?? '', 'AppData', 'Roaming'),
      'orca-dev'
    )
    return {
      command: nodeExecutable,
      prefixArgs: [path.win32.join(env.ORCA_DEV_REPO_ROOT, 'out', 'cli', 'index.js')],
      env: {
        ...env,
        ORCA_USER_DATA_PATH:
          env.ORCA_USER_DATA_PATH ?? env.ORCA_DEV_USER_DATA_PATH ?? defaultUserDataPath,
        ORCA_DEV_CLI_INVOCATION: '1',
        ORCA_APP_EXECUTABLE:
          env.ORCA_APP_EXECUTABLE ??
          path.win32.join(
            env.ORCA_DEV_REPO_ROOT,
            'node_modules',
            'electron',
            'dist',
            'electron.exe'
          ),
        ORCA_APP_EXECUTABLE_NEEDS_APP_ROOT: '1'
      }
    }
  }
  return { command, prefixArgs: [] }
}

export function createOrcaRpc({
  envName,
  cliCommand,
  env = process.env,
  platform = process.platform
}: {
  envName: string
  cliCommand?: string
  env?: NodeJS.ProcessEnv
  platform?: string
}) {
  const cliInvocation = cliCommand
    ? { command: cliCommand, prefixArgs: [] }
    : resolveOrcaCliInvocation({ env, platform })
  const commandLabel = cliCommand ?? resolveOrcaCliCommand({ env, platform })
  const commandArgs = (args: string[], local?: boolean) => [
    ...cliInvocation.prefixArgs,
    ...args,
    ...(local ? [] : ['--environment', envName]),
    '--json'
  ]

  type OrcaJsonOptions = {
    local?: boolean
    timeoutMs?: number
  }

  type OrcaJsonResult = {
    parsed: { ok?: boolean; result?: unknown; [key: string]: unknown }
    elapsedMs: number
    result: unknown
  }

  function orcaJsonSync(args: string[], opts: OrcaJsonOptions = {}): OrcaJsonResult {
    const started = performance.now()
    const result = spawnSync(cliInvocation.command, commandArgs(args, opts.local), {
      encoding: 'utf8',
      env: cliInvocation.env,
      maxBuffer: MAX_ORCA_RPC_OUTPUT_BYTES,
      timeout: opts.timeoutMs ?? 120_000
    })
    const elapsedMs = performance.now() - started
    if (result.error) {
      throw new Error(`${commandLabel} ${args.join(' ')} failed to start: ${String(result.error)}`)
    }
    if (result.status !== 0) {
      throw new Error(
        `${commandLabel} ${args.join(' ')} failed (${result.status}): ${result.stderr || result.stdout}`
      )
    }
    const parsed: { ok?: boolean; result?: unknown; [key: string]: unknown } = JSON.parse(
      result.stdout
    )
    if (parsed.ok === false) {
      throw new Error(`${commandLabel} ${args.join(' ')} ok=false: ${JSON.stringify(parsed)}`)
    }
    return { parsed, elapsedMs, result: parsed.result }
  }

  function orcaJsonAsync(args: string[], opts: OrcaJsonOptions = {}): Promise<OrcaJsonResult> {
    const started = performance.now()
    return new Promise<OrcaJsonResult>((resolve, reject) => {
      const child = spawn(cliInvocation.command, commandArgs(args, opts.local), {
        env: cliInvocation.env,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      let stdout = ''
      let stderr = ''
      let outputBytes = 0
      let settled = false
      let timer: NodeJS.Timeout | undefined
      const fail = (error: Error) => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timer)
        reject(error)
      }
      const append = (stream: string, chunk: string): string => {
        if (settled) {
          return stream
        }
        const appended = appendOrcaRpcOutput(stream, chunk, outputBytes)
        outputBytes = appended.bytes
        if (appended.exceeded) {
          child.kill('SIGKILL')
          fail(new Error(`${commandLabel} ${args.join(' ')} exceeded 20 MiB output limit`))
          return stream
        }
        return appended.output
      }
      timer = setTimeout(() => {
        child.kill('SIGKILL')
        fail(
          new Error(
            `${commandLabel} ${args.join(' ')} timed out after ${opts.timeoutMs ?? 120_000}ms`
          )
        )
      }, opts.timeoutMs ?? 120_000)
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk) => {
        stdout = append(stdout, chunk)
      })
      child.stderr.on('data', (chunk) => {
        stderr = append(stderr, chunk)
      })
      child.on('error', fail)
      child.on('close', (code) => {
        if (settled) {
          return
        }
        clearTimeout(timer)
        const elapsedMs = performance.now() - started
        if (code !== 0) {
          fail(
            new Error(
              `${commandLabel} ${args.join(' ')} failed (${code}): ${stderr || stdout}`.slice(
                0,
                800
              )
            )
          )
          return
        }
        try {
          const parsed: { ok?: boolean; result?: unknown; [key: string]: unknown } =
            JSON.parse(stdout)
          if (parsed.ok === false) {
            fail(
              new Error(
                `${commandLabel} ${args.join(' ')} ok=false: ${JSON.stringify(parsed)}`.slice(
                  0,
                  800
                )
              )
            )
            return
          }
          settled = true
          resolve({ parsed, elapsedMs, result: parsed.result })
        } catch (error) {
          fail(
            new Error(
              `${commandLabel} parse failed: ${String(error)}; stdout=${stdout.slice(0, 400)}`
            )
          )
        }
      })
    })
  }

  async function runReconnectRefreshStorm(notes: string[]) {
    const started = performance.now()
    const jobs = [
      () => orcaJsonAsync(['status'], { timeoutMs: 90_000 }),
      () => orcaJsonAsync(['worktree', 'list'], { timeoutMs: 120_000 }),
      () => orcaJsonAsync(['terminal', 'list'], { timeoutMs: 120_000 }),
      () => orcaJsonAsync(['status'], { local: true, timeoutMs: 60_000 }),
      () => orcaJsonAsync(['worktree', 'list'], { timeoutMs: 120_000 }),
      () => orcaJsonAsync(['terminal', 'list'], { timeoutMs: 120_000 })
    ]
    const results = await Promise.all(
      jobs.map(async (job, index) => {
        try {
          const result = await job()
          return { index, ok: true, ms: result.elapsedMs }
        } catch (error) {
          notes.push(`reconnect-refresh job ${index} failed: ${String(error).slice(0, 200)}`)
          return { index, ok: false, ms: null, error: String(error) }
        }
      })
    )
    const wallMs = performance.now() - started
    const maxJobMs = Math.max(0, ...results.map((result) => result.ms || 0))
    notes.push(
      `reconnect-refresh wall=${wallMs.toFixed(0)}ms maxJob=${maxJobMs.toFixed(0)}ms ok=${results.filter((result) => result.ok).length}/${results.length}`
    )
    return { wallMs, maxJobMs, results }
  }

  async function runRestartProxy(notes) {
    const started = performance.now()
    try {
      const opened = await orcaJsonAsync(['open'], { local: true, timeoutMs: 120_000 })
      notes.push(`orca open ms=${opened.elapsedMs.toFixed(0)}`)
    } catch (error) {
      notes.push(`orca open failed: ${String(error).slice(0, 200)}`)
    }
    const storm = await runReconnectRefreshStorm(notes)
    return { wallMs: performance.now() - started, storm }
  }

  return { orcaJsonSync, orcaJsonAsync, runReconnectRefreshStorm, runRestartProxy }
}

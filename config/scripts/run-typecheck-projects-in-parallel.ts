import { spawn } from 'node:child_process'
import { availableParallelism, totalmem } from 'node:os'
import { fileURLToPath } from 'node:url'

// The projects overlap heavily in src/shared but have no build dependency on
// each other, so tsc can check them concurrently instead of in a `&&` chain.
const projects = [
  'tsconfig.node.json',
  'tsconfig.tc.cli.json',
  'tsconfig.tc.web.json',
  'tsconfig.scripts.json'
]
const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const tsc = fileURLToPath(new URL('../../node_modules/typescript/bin/tsc', import.meta.url))

// Why serialize on a single-core runner: three tsc processes there thrash rather than overlap.
const concurrent = availableParallelism() > 1
// Why cap workers: each tsc peaks near 4 GB; on small-RAM machines concurrent
// checks swap instead of speeding anything up. Budget ~2 GB per worker.
const memGb = totalmem() / 2 ** 30
const maxWorkers = Math.max(1, Math.min(projects.length, Math.floor(memGb / 4)))
const workerLimit = Math.min(concurrent ? maxWorkers : 1, projects.length)

function checkProject(project) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [tsc, '--noEmit', '-p', `config/${project}`], {
      cwd: repoRoot,
      stdio: 'inherit'
    })

    child.on('error', reject)
    child.on('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`tsc ${project} exited with signal ${signal}`))
      } else if (code !== 0) {
        reject(new Error(`tsc ${project} exited with code ${code}`))
      } else {
        resolve()
      }
    })
  })
}

async function runWithWorkerLimit() {
  const pending = new Set<Promise<void>>()
  let failures: unknown[] = []
  const queue = [...projects]
  await Promise.all(
    Array.from({ length: workerLimit }, async () => {
      for (let project = queue.shift(); project; project = queue.shift()) {
        const run = checkProject(project)
        pending.add(run)
        try {
          await run
        } catch (error) {
          failures.push(error)
        }
      }
    })
  )
  return failures
}

let failures: unknown[] = []
if (workerLimit > 1) {
  failures = await runWithWorkerLimit()
} else {
  for (const project of projects) {
    try {
      await checkProject(project)
    } catch (error) {
      failures.push(error)
    }
  }
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(
      typeof failure === 'object' && failure !== null && 'message' in failure
        ? failure.message
        : failure
    )
  }
  process.exit(1)
}

import { spawn } from 'node:child_process'
import { availableParallelism, totalmem } from 'node:os'
import { fileURLToPath } from 'node:url'

// The three projects overlap heavily in src/shared but have no build dependency on
// each other, so tsc can check them concurrently instead of in a `&&` chain.
const projects = ['tsconfig.node.json', 'tsconfig.tc.cli.json', 'tsconfig.tc.web.json']
const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const tsc = fileURLToPath(new URL('../../node_modules/typescript/bin/tsc', import.meta.url))

// Worker budget: each tsc process peaks near 4 GB and wants multiple cores. Default
// caps at 1 because concurrent projects swap and thrash on 8 GB machines; set
// ORCA_TC_WORKERS=<n> (or 0 for auto: one worker per 4 GB of RAM, also bounded by
// cores/2) on machines with more headroom to overlap projects.
function resolveWorkerLimit() {
  const override = Number(process.env.ORCA_TC_WORKERS ?? '')
  if (Number.isInteger(override) && override > 0) {
    return Math.min(override, projects.length)
  }
  if (override === 0) {
    // Why 6 GB per worker, not 4: peak RSS is ~4 GB but the OS, editors, and dev
    // servers need headroom; 8 GB machines then honestly resolve to 1.
    const memGb = totalmem() / 2 ** 30
    const memWorkers = Math.max(1, Math.floor((memGb - 2) / 6))
    const coreWorkers = Math.max(1, availableParallelism() >> 1)
    return Math.min(memWorkers, coreWorkers, projects.length)
  }
  return 1
}
function checkProject(project) {
  return new Promise((resolve, reject) => {
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

async function runWithWorkerLimit(workerLimit) {
  const queue = [...projects]
  const failures = []
  await Promise.all(
    Array.from({ length: workerLimit }, async () => {
      for (let project = queue.shift(); project; project = queue.shift()) {
        try {
          await checkProject(project)
        } catch (error) {
          failures.push(error)
        }
      }
    })
  )
  return failures
}

const failures = await runWithWorkerLimit(resolveWorkerLimit())

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(failure.message ?? failure)
  }
  process.exit(1)
}

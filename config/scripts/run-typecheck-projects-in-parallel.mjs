import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// The three projects overlap heavily in src/shared but have no build dependency on
// each other, so tsc can check them concurrently instead of in a `&&` chain.
const projects = ['tsconfig.node.json', 'tsconfig.tc.cli.json', 'tsconfig.tc.web.json']
const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const tsc = fileURLToPath(new URL('../../node_modules/typescript/bin/tsc', import.meta.url))

// Why sequential: each tsc process peaks near 4 GB and wants multiple cores, so
// concurrent projects swap and thrash on 8 GB machines instead of speeding anything up.
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

let failures = []
for (const project of projects) {
  try {
    await checkProject(project)
  } catch (error) {
    failures.push(error)
  }
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(failure.message ?? failure)
  }
  process.exit(1)
}

import {
  execFileSync,
  spawnSync,
  type SpawnSyncOptionsWithStringEncoding
} from 'node:child_process'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'

const PROCESS_EXIT_TIMEOUT_MS = 2_000
const PROCESS_POLL_MS = 25
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4))

const processIdentityOperations = {
  executePs: execFileSync as (
    file: string,
    args: readonly string[],
    options: { encoding: string }
  ) => string,
  signalProcess: process.kill.bind(process) as (pid: number, signal: number) => void
}

export type ProcessIdentity = {
  pid: number
  pgid: number
  command: string
}

export function processIdentity(
  pid: number,
  operations: {
    executePs: (file: string, args: readonly string[], options: { encoding: string }) => string
    signalProcess: (pid: number, signal: number) => void
  } = processIdentityOperations
): ProcessIdentity | null {
  if (!Number.isInteger(pid) || pid <= 0) {
    return null
  }
  try {
    const output = operations
      .executePs('ps', ['-p', String(pid), '-o', 'pid=,pgid=,command='], {
        encoding: 'utf8'
      })
      .trim()
    const match = output.match(/^(\d+)\s+(\d+)\s+(.+)$/)
    if (!match) {
      throw new Error(`Could not parse process identity for ${pid}`)
    }
    return { pid: Number(match[1]), pgid: Number(match[2]), command: match[3] }
  } catch (error) {
    try {
      operations.signalProcess(pid, 0)
    } catch (lookupError) {
      if (
        lookupError &&
        typeof lookupError === 'object' &&
        'code' in lookupError &&
        lookupError.code === 'ESRCH'
      ) {
        return null
      }
    }
    throw error
  }
}

function matchingDetachedProcesses(
  identities: ProcessIdentity[],
  expectedCommandFragments: string[]
): ProcessIdentity[] {
  return identities.filter(
    (identity) =>
      identity.pgid === identity.pid &&
      expectedCommandFragments.every((fragment) => identity.command.includes(fragment))
  )
}

const matchingProcessOperations = {
  processIdentities,
  signalProcessIdentity,
  waitForIdentityExit
}

export function killProcessMatchingCommand(
  expectedCommandFragments: string[],
  operations: {
    processIdentities: (includeEnvironment?: boolean) => ProcessIdentity[]
    signalProcessIdentity: (
      identity: ProcessIdentity,
      fragment: string,
      signal: NodeJS.Signals
    ) => boolean
    waitForIdentityExit: (identity: ProcessIdentity) => boolean
  } = matchingProcessOperations
) {
  const matches = matchingDetachedProcesses(
    operations.processIdentities(),
    expectedCommandFragments
  )
  if (matches.length === 0) {
    return false
  }
  const errors: unknown[] = []
  for (const match of matches) {
    try {
      if (operations.signalProcessIdentity(match, expectedCommandFragments[0], 'SIGKILL')) {
        operations.waitForIdentityExit(match)
      }
    } catch (error) {
      errors.push(error)
    }
  }
  try {
    const remaining = matchingDetachedProcesses(
      operations.processIdentities(),
      expectedCommandFragments
    )
    if (remaining.length > 0) {
      errors.push(
        new Error(
          `Benchmark helper cleanup left matching processes: ${remaining
            .map((identity) => identity.pid)
            .join(', ')}`
        )
      )
    }
  } catch (error) {
    errors.push(error)
  }
  if (errors.length === 1) {
    throw errors[0]
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, 'Benchmark exact-command cleanup failed')
  }
  return true
}

function sleepSync(milliseconds: number) {
  Atomics.wait(sleepBuffer, 0, 0, milliseconds)
}

function validateDetachedIdentity(
  identity: ProcessIdentity | null | undefined,
  expectedCommandFragment: string
): void {
  if (
    identity === null ||
    identity === undefined ||
    !Number.isInteger(identity.pid) ||
    identity.pid <= 0 ||
    identity.pgid !== identity.pid ||
    typeof identity.command !== 'string' ||
    !identity.command.includes(expectedCommandFragment)
  ) {
    throw new Error('Recorded benchmark helper identity is invalid')
  }
}

function sameIdentity(left?: ProcessIdentity | null, right?: ProcessIdentity | null) {
  return left?.pid === right?.pid && left?.pgid === right?.pgid && left?.command === right?.command
}

function processIdentities(includeEnvironment = false): ProcessIdentity[] {
  const args = includeEnvironment
    ? ['eww', '-axo', 'pid=,pgid=,command=']
    : ['-axo', 'pid=,pgid=,command=']
  const output = execFileSync('ps', args, {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024
  })
  return output
    .split('\n')
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map((match) => ({
      pid: Number(match[1]),
      pgid: Number(match[2]),
      command: match[3]
    }))
}

function waitForIdentityExit(identity: ProcessIdentity) {
  const deadline = Date.now() + PROCESS_EXIT_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (!processIdentityIsCurrent(identity)) {
      return true
    }
    sleepSync(PROCESS_POLL_MS)
  }
  throw new Error(`Recorded benchmark helper ${identity.pid} did not exit`)
}

export function spawnBenchmarkProcess(
  executable: string,
  args: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding
) {
  return spawnSync(executable, args, {
    ...options,
    detached: true,
    killSignal: 'SIGKILL'
  } as SpawnSyncOptionsWithStringEncoding)
}

export function runBenchmarkCleanupStages(stages: (() => void)[]) {
  const errors: unknown[] = []
  for (const stage of stages) {
    try {
      stage()
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length === 1) {
    throw errors[0]
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, 'Benchmark trial cleanup failed')
  }
}

export function throwBenchmarkTrialFailures(trialError: unknown, cleanupError: unknown) {
  if (trialError && cleanupError) {
    throw new AggregateError([trialError, cleanupError], 'Electron trial and cleanup failed')
  }
  if (trialError) {
    throw trialError
  }
  if (cleanupError) {
    throw cleanupError
  }
}

export function parseBenchmarkTrialResult(serializedResult: string): unknown {
  return JSON.parse(serializedResult)
}

export function benchmarkTrialNeedsCleanup(
  spawnResult: { status: number | null } | null | undefined,
  parsedResultAvailable: boolean
) {
  return spawnResult?.status !== 0 || !parsedResultAvailable
}

const processGroupSignalOperations = {
  processIdentities,
  signalProcess: process.kill.bind(process)
}

type ProcessGroupState = {
  stopped: boolean
  anchorPid: number | null
}

type GroupSignalOperations = {
  processIdentities: (includeEnvironment?: boolean) => ProcessIdentity[]
  signalProcess: (pid: number, signal: NodeJS.Signals | number) => void
}

function isEsrch(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH'
}

function compensateStoppedGroup(
  pgid: number,
  groupState: ProcessGroupState,
  operations: GroupSignalOperations
): unknown[] {
  const errors: unknown[] = []
  const targets = [
    groupState.stopped ? ([-pgid, 'stopped'] as const) : null,
    groupState.anchorPid ? ([groupState.anchorPid, 'anchorPid'] as const) : null
  ].filter((target): target is readonly [number, 'stopped' | 'anchorPid'] => target !== null)
  for (const [pid, stateKey] of targets) {
    try {
      operations.signalProcess(pid, 'SIGCONT')
      if (stateKey === 'stopped') {
        groupState.stopped = false
      } else {
        groupState.anchorPid = null
      }
    } catch (error) {
      if (isEsrch(error)) {
        if (stateKey === 'stopped') {
          groupState.stopped = false
        } else {
          groupState.anchorPid = null
        }
      } else {
        errors.push(error)
      }
    }
  }
  return errors
}

export function signalValidatedProcessGroup(
  pgid: number,
  environmentFragment: string,
  signal: NodeJS.Signals,
  groupState: ProcessGroupState = { stopped: false, anchorPid: null },
  operations: GroupSignalOperations = processGroupSignalOperations
): boolean {
  if (!Number.isInteger(pgid) || pgid <= 0) {
    return false
  }
  let members
  try {
    members = operations.processIdentities(true).filter((identity) => identity.pgid === pgid)
  } catch (error) {
    const recoveryErrors = compensateStoppedGroup(pgid, groupState, operations)
    if (recoveryErrors.length > 0) {
      throw new AggregateError(
        [error, ...recoveryErrors],
        'Benchmark process group recovery failed before validation'
      )
    }
    throw error
  }
  if (members.length === 0) {
    const recoveryErrors = compensateStoppedGroup(pgid, groupState, operations)
    if (recoveryErrors.length > 0) {
      throw new AggregateError(recoveryErrors, 'Benchmark missing process group recovery failed')
    }
    return false
  }
  if (members.some((identity) => !identity.command.includes(environmentFragment))) {
    const ownershipError = new Error('Benchmark process group no longer belongs to this trial')
    const recoveryErrors = compensateStoppedGroup(pgid, groupState, operations)
    if (recoveryErrors.length > 0) {
      throw new AggregateError(
        [ownershipError, ...recoveryErrors],
        'Benchmark process group authority recovery failed'
      )
    }
    throw ownershipError
  }
  if (groupState.anchorPid) {
    try {
      operations.signalProcess(groupState.anchorPid, 'SIGCONT')
      groupState.anchorPid = null
    } catch (error) {
      if (isEsrch(error)) {
        groupState.anchorPid = null
      } else {
        throw new AggregateError([error], 'Benchmark pending anchor recovery failed')
      }
    }
  }
  const anchor = members[0]
  try {
    operations.signalProcess(anchor.pid, 'SIGSTOP')
    groupState.anchorPid = anchor.pid
    const stoppedAnchor = operations
      .processIdentities(true)
      .find((identity) => identity.pid === anchor.pid)
    if (!sameIdentity(stoppedAnchor, anchor)) {
      throw new Error('Benchmark process group anchor changed before signaling')
    }
    operations.signalProcess(-pgid, 'SIGSTOP')
    groupState.stopped = true
    groupState.anchorPid = null
    const stoppedMembers = operations
      .processIdentities(true)
      .filter((identity) => identity.pgid === pgid)
    if (
      stoppedMembers.length === 0 ||
      stoppedMembers.some((identity) => !identity.command.includes(environmentFragment))
    ) {
      throw new Error('Benchmark process group changed before signaling')
    }
    if (signal !== 'SIGSTOP') {
      operations.signalProcess(-pgid, signal)
      if (signal !== 'SIGKILL') {
        operations.signalProcess(-pgid, 'SIGCONT')
      }
      groupState.stopped = false
      groupState.anchorPid = null
    }
    return true
  } catch (error) {
    const recoveryErrors = compensateStoppedGroup(pgid, groupState, operations)
    if (recoveryErrors.length > 0) {
      throw new AggregateError(
        [error, ...recoveryErrors],
        'Benchmark process group signal recovery failed'
      )
    }
    if (isEsrch(error)) {
      return false
    }
    throw error
  }
}

export function writeProcessRecord(recordPath: string, processIdentity: ProcessIdentity) {
  const temporaryPath = `${recordPath}.${process.pid}.tmp`
  writeFileSync(temporaryPath, JSON.stringify(processIdentity))
  renameSync(temporaryPath, recordPath)
}

export function processIdentityIsCurrent(identity: ProcessIdentity) {
  return sameIdentity(processIdentity(identity.pid), identity)
}

const processSignalOperations = {
  processIdentity,
  signalProcess: process.kill.bind(process)
}

type IdentitySignalOperations = {
  processIdentity: (pid: number) => ProcessIdentity | null
  signalProcess: (pid: number, signal: NodeJS.Signals | number) => void
}

export function signalProcessIdentity(
  identity: ProcessIdentity,
  expectedCommandFragment: string,
  signal: NodeJS.Signals,
  operations: IdentitySignalOperations = processSignalOperations
): boolean {
  validateDetachedIdentity(identity, expectedCommandFragment)
  const currentIdentity = operations.processIdentity(identity.pid)
  if (!currentIdentity) {
    return false
  }
  if (!sameIdentity(currentIdentity, identity)) {
    throw new Error('Recorded benchmark helper PID now belongs to another process')
  }
  let stopped = false
  try {
    operations.signalProcess(identity.pid, 'SIGSTOP')
    stopped = true
    const stoppedIdentity = operations.processIdentity(identity.pid)
    if (!sameIdentity(stoppedIdentity, identity)) {
      throw new Error('Recorded benchmark helper PID changed before signaling')
    }
    operations.signalProcess(-identity.pgid, signal)
    if (signal !== 'SIGKILL') {
      operations.signalProcess(-identity.pgid, 'SIGCONT')
    }
    stopped = false
    return true
  } catch (error) {
    let resumeError: unknown
    if (stopped) {
      try {
        operations.signalProcess(identity.pid, 'SIGCONT')
      } catch (caught) {
        if (!isEsrch(caught)) {
          resumeError = caught
        }
      }
    }
    if (resumeError) {
      throw new AggregateError([error, resumeError], 'Benchmark helper signal recovery failed')
    }
    if (isEsrch(error)) {
      return false
    }
    throw error
  }
}

export function killRecordedProcess(recordPath: string, expectedCommandFragment: string): boolean {
  if (!existsSync(recordPath)) {
    return false
  }
  const record: unknown = JSON.parse(readFileSync(recordPath, 'utf8'))
  if (!signalProcessIdentity(record as ProcessIdentity, expectedCommandFragment, 'SIGKILL')) {
    return false
  }
  return waitForIdentityExit(record as ProcessIdentity)
}

export function killRecordedAndMatchingProcesses(
  recordPath: string,
  recordedCommandFragment: string,
  matchingCommandFragments: string[]
): void {
  const errors: unknown[] = []
  try {
    killRecordedProcess(recordPath, recordedCommandFragment)
  } catch (error) {
    errors.push(error)
  }
  try {
    killProcessMatchingCommand(matchingCommandFragments)
  } catch (error) {
    errors.push(error)
  }
  if (errors.length === 1) {
    throw errors[0]
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, 'Benchmark helper cleanup failed')
  }
}

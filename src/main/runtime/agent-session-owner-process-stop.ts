import { probeAgentSessionProcessIdentity } from './agent-session-process-identity-probe'
import type { AgentSessionRecord } from '../../shared/agent-session-record'

export async function stopStructuredSessionProcess(record: AgentSessionRecord): Promise<void> {
  const identity = record.lease.ownerProcess
  if (!identity) {
    return
  }
  const proof = await probeAgentSessionProcessIdentity({ identity })
  if (proof.outcome === 'pid-absent' || proof.outcome === 'identity-mismatch') {
    return
  }
  if (proof.outcome !== 'identity-matched' || proof.matchedOn.length === 0) {
    throw new Error('The recovered owner process could not be stopped safely.')
  }
  try {
    process.kill(identity.pid, 'SIGTERM')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      throw error
    }
    return
  }
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const current = await probeAgentSessionProcessIdentity({ identity })
    if (current.outcome === 'pid-absent' || current.outcome === 'identity-mismatch') {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  // SIGTERM is only a request. Escalate once, then require an independent
  // absence probe before allowing the lease transition to proceed.
  try {
    process.kill(identity.pid, 'SIGKILL')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      throw error
    }
    return
  }
  const forcedDeadline = Date.now() + 5_000
  while (Date.now() < forcedDeadline) {
    const current = await probeAgentSessionProcessIdentity({ identity })
    if (current.outcome === 'pid-absent' || current.outcome === 'identity-mismatch') {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('The recovered owner process did not exit after forced termination.')
}

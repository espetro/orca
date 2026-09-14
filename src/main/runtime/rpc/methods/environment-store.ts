// Why: the browser runtime-environments API (`window.api.runtimeEnvironments`) is local-only
// by design — the browser keeps its own pairing registry in localStorage. Saved servers live
// server-side in orca-environments.json, so the web UI needs a separate read/write surface
// onto that store. These are that surface: same environment records, different storage owner.
// The store takes a userDataPath argument instead of process globals, so both a thin test
// harness and future callers stay hermetic.
import { z } from 'zod'
import { defineMethod } from '../core'
import { getAppEnvironment } from '../../../../shared/app-environment'
import { parsePairingCode } from '../../../../shared/pairing'
import {
  RuntimeEnvironmentStoreError,
  addEnvironmentFromPairingCode,
  listEnvironments,
  removeEnvironment
} from '../../../../shared/runtime-environment-store'

const EnvironmentSelectorParams = z.object({
  selector: z.string().min(1)
})

const AddEnvironmentParams = z.object({
  name: z.string().min(1),
  pairingCode: z.string().min(1)
})

// Why: the browser needs the full connection material (endpoint, device token, public key)
// to open its own WebSocket, so unlike `orca environment list --json` these responses are
// NOT redacted. The caller is already past runtime-scoped auth on this socket, which is the
// same credential the stored environment itself would present.
export const ENVIRONMENT_STORE_METHODS = [
  defineMethod({
    name: 'environmentStore.list',
    params: null,
    handler: () => listEnvironments(getUserDataPath())
  }),
  defineMethod({
    name: 'environmentStore.add',
    params: AddEnvironmentParams,
    handler: ({ name, pairingCode }) => {
      assertParseablePairingCode(pairingCode)
      return addEnvironmentFromPairingCode(getUserDataPath(), { name, pairingCode })
    }
  }),
  defineMethod({
    name: 'environmentStore.remove',
    params: EnvironmentSelectorParams,
    handler: ({ selector }) => removeEnvironment(getUserDataPath(), selector)
  })
]

function getUserDataPath(): string {
  return getAppEnvironment().getPath('userData')
}

// Why: addEnvironmentFromPairingCode already validates the code, but a store-level duplicate
// name rejection would otherwise surface as "already exists" even when the code itself is
// garbage. Parsing here keeps the invalid-code error message in front of the name conflict.
function assertParseablePairingCode(pairingCode: string): void {
  if (!parsePairingCode(pairingCode)) {
    throw new RuntimeEnvironmentStoreError('invalid_argument', 'Invalid Orca pairing code.')
  }
}

/**
 * Windows backend for the memory dashboard's host-wide sweep.
 *
 * Reads the shared native process table (Toolhelp32, ~30ms) instead of
 * forking powershell.exe on every two-second poll (#16905). The table's own
 * absence-only CIM fallback applies; this module spawns no child process.
 *
 * What the native snapshot cannot supply (see
 * docs/reference/windows-process-enumeration.md): committed private bytes and
 * cumulative CPU times. privateMemory therefore stays absent — the snapshot
 * contract treats absence as unknown, never zero — and cpu starts at zero
 * until the addon grows those counters.
 */

import { readWindowsProcessTable } from '../windows/windows-process-table'
import {
  parseNativeProcessRows,
  type WindowsProcessResourceRow
} from './windows-process-sample-parsing'

export type { WindowsProcessResourceRow } from './windows-process-sample-parsing'

export async function enumerateWindowsProcessResources(): Promise<WindowsProcessResourceRow[]> {
  try {
    return parseNativeProcessRows(await readWindowsProcessTable())
  } catch (err) {
    console.warn('[memory] native process table read failed', err)
    return []
  }
}

import { execFile as nodeExecFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ExecFileFn } from '../resource-recorder-types'

/**
 * Promise-based execFile for main-process callers that must not import
 * node:child_process directly (see run-process.ts header). Keep this the only
 * exporter of the promisified form.
 */
export const execFileAsync: ExecFileFn = (file, args) =>
  promisify(nodeExecFile)(file, args) as unknown as Promise<{ stdout: string; stderr: string }>

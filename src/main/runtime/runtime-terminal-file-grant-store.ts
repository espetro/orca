// Mutable terminal file-grant state shared by the terminal-path and artifact collaborators.
import type { TerminalFileGrant } from './runtime-file-shared'

export class RuntimeTerminalFileGrantStore {
  readonly grants = new Map<string, TerminalFileGrant>()
}

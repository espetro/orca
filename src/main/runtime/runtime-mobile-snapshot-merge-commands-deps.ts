export type RuntimeMobileSnapshotMergeDeps = {
  store: {
    getMobileClientTabSelections?: () => Record<string, unknown> | undefined
    setMobileClientTabSelections?: (selections: Record<string, unknown>) => unknown
  }
  emitClientEvent: (event: unknown) => void
}

// V8 heap-snapshot capture + aggregation for the release-memory benchmark.
// Split out of run-release-memory-benchmark.mjs to keep that file under the
// 600-line limit; the harness re-exports both names.

// Aggregate a V8 heap snapshot (already-parsed object with snapshot.meta +
// nodes + strings) into total heap size plus self-size per constructor.
export function aggregateHeapSnapshotRetainedByConstructor(snapshot, topN = 10) {
  const meta = snapshot?.snapshot?.meta
  const nodes = snapshot?.nodes
  const strings = snapshot?.strings
  if (!Array.isArray(nodes) || !Array.isArray(strings) || !meta?.node_fields) {
    throw new Error('Invalid V8 heap snapshot: missing nodes/strings/meta')
  }
  const fields = meta.node_fields
  const fieldTypes = meta.node_types ?? []
  const typeIndex = fields.indexOf('type')
  const nameIndex = fields.indexOf('name')
  const selfSizeIndex = fields.indexOf('self_size')
  const nodeWidth = fields.length
  const objectTypeIndex = Array.isArray(fieldTypes[typeIndex])
    ? fieldTypes[typeIndex].indexOf('object')
    : -1
  const byConstructor = new Map()
  let totalSelfBytes = 0
  for (let offset = 0; offset + nodeWidth <= nodes.length; offset += nodeWidth) {
    if (objectTypeIndex !== -1 && nodes[offset + typeIndex] !== objectTypeIndex) {
      continue
    }
    const selfBytes = nodes[offset + selfSizeIndex] ?? 0
    totalSelfBytes += selfBytes
    const name = strings[nodes[offset + nameIndex]] ?? '(unknown)'
    byConstructor.set(name, (byConstructor.get(name) ?? 0) + selfBytes)
  }
  const topConstructors = [...byConstructor.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, topN)
    .map(([name, selfSizeBytes]) => ({ name, selfSizeBytes }))
  return { totalSelfBytes, nodeWidth, topConstructors }
}

// HeapProfiler.takeHeapSnapshot streams chunked JSON; assemble, then aggregate
// retained/self size by constructor. reportProgress off keeps it one-shot.
export async function takeHeapSnapshotSummary(cdpSession, { topN = 10 } = {}) {
  const chunks = []
  cdpSession.on('HeapProfiler.addHeapSnapshotChunk', (event) => {
    chunks.push(event.chunk)
  })
  try {
    await cdpSession.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false })
  } catch (error) {
    // Renderer crash / page close mid-snapshot must degrade to null, not throw
    // (a thrown runOnce used to leak the whole Electron tree).
    try {
      await cdpSession.detach()
    } catch {
      /* already detached */
    }
    console.warn(
      `[release-memory] heap snapshot failed (degraded to null): ${error?.message ?? error}`
    )
    return null
  }
  const snapshot = JSON.parse(chunks.join(''))
  const summary = aggregateHeapSnapshotRetainedByConstructor(snapshot, topN)
  return { takenAt: new Date().toISOString(), ...summary }
}

import {
  Project,
  SyntaxKind,
  type ClassDeclaration,
  type PropertyAccessExpression,
  type CallExpression,
  type BinaryExpression
} from 'ts-morph'
import * as fs from 'node:fs'

type FieldAccessInfo = {
  read: boolean
  write: boolean
}

function isLhsOfAssignment(node: PropertyAccessExpression): boolean {
  const parent = node.getParent()
  if (!parent) {
    return false
  }

  const parentKind = parent.getKind()
  if (parentKind === SyntaxKind.BinaryExpression) {
    const binaryParent = parent as BinaryExpression
    if (binaryParent.getLeft() === node) {
      const op = binaryParent.getOperatorToken().getKind()
      return op === SyntaxKind.EqualsToken
    }
  }

  return false
}

function isInCompoundAssignment(node: PropertyAccessExpression): boolean {
  const parent = node.getParent()
  if (!parent) {
    return false
  }

  const parentKind = parent.getKind()
  if (parentKind === SyntaxKind.BinaryExpression) {
    const binaryParent = parent as BinaryExpression
    const op = binaryParent.getOperatorToken().getKind()
    return (
      op === SyntaxKind.PlusEqualsToken ||
      op === SyntaxKind.MinusEqualsToken ||
      op === SyntaxKind.AsteriskEqualsToken ||
      op === SyntaxKind.SlashEqualsToken
    )
  }

  return false
}

function extractFieldAccessMatrix(
  classDecl: ClassDeclaration
): Record<string, Record<string, FieldAccessInfo>> {
  const matrix: Record<string, Record<string, FieldAccessInfo>> = {}
  const classMembers = new Set<string>()

  classDecl.getMembers().forEach((member) => {
    const name = member.getName?.()
    if (name) {
      classMembers.add(name)
    }
  })

  classDecl.getMethods().forEach((method) => {
    const methodName = method.getName()
    if (!methodName) {
      return
    }

    const accesses: Record<string, FieldAccessInfo> = {}

    method.forEachDescendant((node) => {
      if (node.getKind() === SyntaxKind.PropertyAccessExpression) {
        const propAccess = node as PropertyAccessExpression
        const expr = propAccess.getExpression()
        if (expr.getText() === 'this') {
          const fieldName = propAccess.getName()
          if (classMembers.has(fieldName)) {
            if (!accesses[fieldName]) {
              accesses[fieldName] = { read: false, write: false }
            }

            const isWrite = isLhsOfAssignment(propAccess)
            const isRead = !isWrite || isInCompoundAssignment(propAccess)

            if (isRead) {
              accesses[fieldName].read = true
            }
            if (isWrite) {
              accesses[fieldName].write = true
            }
          }
        }
      }
    })

    matrix[methodName] = accesses
  })

  return matrix
}

function extractCallGraph(classDecl: ClassDeclaration): Record<string, { calls: string[] }> {
  const graph: Record<string, { calls: string[] }> = {}
  const methodNames = new Set<string>()

  classDecl.getMethods().forEach((method) => {
    const name = method.getName()
    if (name) {
      methodNames.add(name)
    }
  })

  classDecl.getMethods().forEach((method) => {
    const methodName = method.getName()
    if (!methodName) {
      return
    }

    const calledMethods = new Set<string>()

    method.forEachDescendant((node) => {
      if (node.getKind() === SyntaxKind.CallExpression) {
        const callExpr = node as CallExpression
        const expr = callExpr.getExpression()
        if (expr.getKind() === SyntaxKind.PropertyAccessExpression) {
          const propAccess = expr as PropertyAccessExpression
          if (propAccess.getExpression().getText() === 'this') {
            const calledName = propAccess.getName()
            if (methodNames.has(calledName)) {
              calledMethods.add(calledName)
            }
          }
        }
      }
    })

    graph[methodName] = { calls: Array.from(calledMethods) }
  })

  return graph
}

function tarjanSCC(graph: Record<string, { calls: string[] }>): string[][] {
  const nodes = Object.keys(graph)
  const index: Record<string, number> = {}
  const lowlink: Record<string, number> = {}
  const onStack = new Set<string>()
  const stack: string[] = []
  const sccs: string[][] = []
  let nextIndex = 0

  function strongconnect(node: string): void {
    index[node] = nextIndex
    lowlink[node] = nextIndex
    nextIndex += 1
    stack.push(node)
    onStack.add(node)

    const successors = graph[node]?.calls || []
    for (const successor of successors) {
      if (!(successor in index)) {
        strongconnect(successor)
        lowlink[node] = Math.min(lowlink[node], lowlink[successor])
      } else if (onStack.has(successor)) {
        lowlink[node] = Math.min(lowlink[node], index[successor])
      }
    }

    if (lowlink[node] === index[node]) {
      const scc: string[] = []
      let w: string | undefined
      do {
        w = stack.pop()
        onStack.delete(w!)
        scc.push(w!)
      } while (w !== node)
      sccs.push(scc)
    }
  }

  for (const node of nodes) {
    if (!(node in index)) {
      strongconnect(node)
    }
  }

  return sccs
}

function findFeedbackArcCut(
  cycle: string[],
  graph: Record<string, { calls: string[] }>
): { from: string; to: string } | null {
  const cycleSet = new Set(cycle)
  let minEdge: { from: string; to: string } | null = null

  for (const node of cycle) {
    const calls = graph[node]?.calls || []
    for (const target of calls) {
      if (cycleSet.has(target)) {
        if (!minEdge) {
          minEdge = { from: node, to: target }
        }
      }
    }
  }

  return minEdge
}

async function analyzeOrcaRuntime(): Promise<void> {
  const project = new Project()
  const sourceFile = project.addSourceFileAtPath('src/main/runtime/orca-runtime.ts')

  const classDecl = sourceFile.getClass('OrcaRuntimeService')
  if (!classDecl) {
    console.error('❌ Could not find OrcaRuntimeService class')
    process.exit(1)
  }

  console.log('📊 Stage 0 Analyzer: OrcaRuntimeService\n')

  const fields: { name: string; type: string; accessibility: string; readonly: boolean }[] = []
  const methods: { name: string; signature: string; accessibility: string; isAsync: boolean }[] = []

  classDecl.getMembers().forEach((member) => {
    if (member.getKind() === SyntaxKind.PropertyDeclaration) {
      const name = member.getName()
      if (name) {
        fields.push({
          name,
          type: 'field',
          accessibility: 'private',
          readonly: false
        })
      }
    }
  })

  classDecl.getMethods().forEach((method) => {
    const name = method.getName()
    if (name) {
      methods.push({
        name,
        signature: 'method',
        accessibility: 'public',
        isAsync: method.isAsync()
      })
    }
  })

  console.log(`✓ Extracted ${fields.length} fields`)
  console.log(`✓ Extracted ${methods.length} methods`)

  const fieldAccessMatrix = extractFieldAccessMatrix(classDecl)
  console.log(`✓ Built field-access matrix`)

  const callGraph = extractCallGraph(classDecl)
  console.log(`✓ Built call graph`)

  const sccs = tarjanSCC(callGraph)
  const cycles = sccs.filter((c) => c.length > 1)
  const acyclicMethods = sccs.filter((c) => c.length === 1).flat()

  const cycleReports = cycles.map((cycle, idx) => {
    const arc = findFeedbackArcCut(cycle, callGraph)
    return {
      id: `cycle-${idx + 1}`,
      members: cycle.sort(),
      feedback_arc_cut: arc,
      consequence: arc
        ? `Remove call from ${arc.from} to ${arc.to} to break cycle`
        : 'No edges found'
    }
  })

  const result = {
    skeleton: { fields, methods },
    fieldAccessMatrix,
    callGraph,
    sccReport: {
      cycles: cycleReports,
      acyclic_methods: acyclicMethods,
      topological_sort: acyclicMethods.toReversed()
    }
  }

  fs.writeFileSync('/tmp/orca-runtime-analysis.json', JSON.stringify(result, null, 2))
  console.log(`✓ Saved analysis to /tmp/orca-runtime-analysis.json\n`)

  printSummary(result)
}

type AnalysisResult = {
  skeleton: {
    fields: { name: string }[]
    methods: { name: string }[]
  }
  fieldAccessMatrix: Record<string, Record<string, FieldAccessInfo>>
  sccReport: {
    cycles: { members: string[]; feedback_arc_cut: { from: string; to: string } | null }[]
  }
}

function printSummary(result: AnalysisResult): void {
  const { skeleton, fieldAccessMatrix, sccReport } = result

  let totalAccesses = 0
  const fieldStats: Record<string, { methods: Set<string>; reads: number; writes: number }> = {}

  Object.values(fieldAccessMatrix).forEach((accesses) => {
    Object.entries(accesses).forEach(([fieldName, access]) => {
      if (!fieldStats[fieldName]) {
        fieldStats[fieldName] = { methods: new Set(), reads: 0, writes: 0 }
      }
      if (access.read) {
        fieldStats[fieldName].reads += 1
      }
      if (access.write) {
        fieldStats[fieldName].writes += 1
      }
      totalAccesses += access.read ? 1 : 0
      totalAccesses += access.write ? 1 : 0
    })
  })

  const hottest = Object.entries(fieldStats)
    .map(([name, data]) => ({
      name,
      total_accesses: data.reads + data.writes,
      read_count: data.reads,
      write_count: data.writes
    }))
    .sort((a, b) => b.total_accesses - a.total_accesses)
    .slice(0, 10)

  const cycles = sccReport.cycles.filter((c) => c.members.length > 1)

  console.log('='.repeat(60))
  console.log('SKELETON SUMMARY')
  console.log('='.repeat(60))
  console.log(`• ${skeleton.fields.length} fields analyzed`)
  console.log(`• ${skeleton.methods.length} methods analyzed`)
  console.log(`• ${totalAccesses} total field accesses`)
  console.log(`• ${(totalAccesses / skeleton.methods.length).toFixed(1)} avg accesses per method\n`)

  console.log('='.repeat(60))
  console.log('CYCLE REPORT')
  console.log('='.repeat(60))
  if (cycles.length === 0) {
    console.log('✓ No cycles detected! Call graph is acyclic.\n')
  } else {
    console.log(`• ${cycles.length} cycles detected`)
    const largestCycle = Math.max(...cycles.map((c) => c.members.length))
    console.log(`• Largest cycle: ${largestCycle} methods\n`)
    sccReport.cycles.slice(0, 3).forEach((cycleReport, idx) => {
      const cycle = cycleReport.members
      console.log(
        `  cycle-${idx + 1}: ${cycle.slice(0, 3).join(' → ')}${cycle.length > 3 ? ' → ...' : ' (closed loop)'}`
      )
      const arc = cycleReport.feedback_arc_cut
      if (arc) {
        console.log(`    Cut: ${arc.from} → ${arc.to}`)
      }
    })
    if (cycles.length > 3) {
      console.log(`  ... and ${cycles.length - 3} more cycles`)
    }
    console.log()
  }

  console.log('='.repeat(60))
  console.log('TOP 10 HOTTEST FIELDS (most-accessed)')
  console.log('='.repeat(60))
  hottest.forEach((field, idx) => {
    console.log(
      `${idx + 1}. ${field.name}: ${field.total_accesses} accesses (read: ${field.read_count}, write: ${field.write_count})`
    )
  })
  console.log()
}

void analyzeOrcaRuntime().catch((err) => {
  console.error('Error:', err)
  process.exit(1)
})

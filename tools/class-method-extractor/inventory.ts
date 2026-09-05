// Inventory of OrcaRuntimeService members: LOC, kind, fan-in (calls from other
// members), fan-out (calls to other members). Output: JSON to stdout.
// Run: node tools/class-method-extractor/inventory.ts > /tmp/runtime-inventory.json
import { writeFileSync } from 'node:fs'
import { Project, SyntaxKind, type MethodDeclaration, type PropertyDeclaration } from 'ts-morph'

const FILE = 'src/main/runtime/orca-runtime.ts'
const CLASS = 'OrcaRuntimeService'

const project = new Project({
  skipAddingFilesFromTsConfig: true,
  skipFileDependencyResolution: true,
  manipulationSettings: { indentationText: 'TwoSpaces', quoteKind: 'single' }
})
const sf = project.addSourceFileAtPath(FILE)
const cls = sf.getClassOrThrow(CLASS)

const methods = cls.getMethods()
const fields = cls.getProperties()

const memberNames = new Set([...methods.map((m) => m.getName()), ...fields.map((f) => f.getName())])

function loc(node: MethodDeclaration | PropertyDeclaration): number {
  const start = node.getStartLineNumber()
  const end = node.getEndLineNumber()
  return end - start + 1
}

type MemberInfo = {
  name: string
  kind: 'method' | 'field'
  visibility: string
  isStatic: boolean
  loc: number
  startLine: number
  fanIn: number
  fanOut: string[]
}

const infos: MemberInfo[] = []

// Pre-extract per-method body text for fan-in counting.
const methodBodies = new Map<string, string>()
for (const m of methods) {
  methodBodies.set(m.getName(), m.getText())
}

for (const m of methods) {
  const body = methodBodies.get(m.getName()) ?? ''
  const fanOut: string[] = []
  for (const name of memberNames) {
    if (name === m.getName()) {
      continue
    }
    if (new RegExp(`this\\.${name}\\b`).test(body)) {
      fanOut.push(name)
    }
  }
  let fanIn = 0
  for (const [other, otherBody] of methodBodies) {
    if (other === m.getName()) {
      continue
    }
    if (new RegExp(`this\\.${m.getName()}\\b`).test(otherBody)) {
      fanIn++
    }
  }
  infos.push({
    name: m.getName(),
    kind: 'method',
    visibility: m.hasModifier(SyntaxKind.PrivateKeyword)
      ? 'private'
      : m.hasModifier(SyntaxKind.ProtectedKeyword)
        ? 'protected'
        : 'public',
    isStatic: m.isStatic(),
    loc: loc(m),
    startLine: m.getStartLineNumber(),
    fanIn,
    fanOut
  })
}

for (const f of fields) {
  infos.push({
    name: f.getName(),
    kind: 'field',
    visibility: f.hasModifier(SyntaxKind.PrivateKeyword)
      ? 'private'
      : f.hasModifier(SyntaxKind.ProtectedKeyword)
        ? 'protected'
        : 'public',
    isStatic: f.isStatic(),
    loc: loc(f),
    startLine: f.getStartLineNumber(),
    fanIn: [...methodBodies.values()].filter((b) => new RegExp(`this\\.${f.getName()}\\b`).test(b))
      .length,
    fanOut: []
  })
}

// Module-level functions in the same file (candidates for plain file splits).
const moduleFns = sf.getFunctions().map((fn) => ({
  name: fn.getName() ?? '(anon)',
  loc: fn.getEndLineNumber() - fn.getStartLineNumber() + 1,
  startLine: fn.getStartLineNumber(),
  exported: fn.isExported()
}))

const totalMethodLoc = infos.filter((i) => i.kind === 'method').reduce((acc, i) => acc + i.loc, 0)
const totalFieldLoc = infos.filter((i) => i.kind === 'field').reduce((acc, i) => acc + i.loc, 0)
const totalFnLoc = moduleFns.reduce((acc, f) => acc + f.loc, 0)

const report = {
  file: FILE,
  classLoc: sf.getEndLineNumber(),
  classMemberLoc: totalMethodLoc + totalFieldLoc,
  moduleFunctionLoc: totalFnLoc,
  methodCount: methods.length,
  fieldCount: fields.length,
  functionCount: moduleFns.length,
  members: infos.sort((a, b) => b.loc - a.loc),
  moduleFunctions: moduleFns.sort((a, b) => b.loc - a.loc)
}

writeFileSync('/tmp/runtime-inventory.json', JSON.stringify(report, null, 2))
console.log(
  `class members: ${report.methodCount} methods (${totalMethodLoc} LOC), ${report.fieldCount} fields (${totalFieldLoc} LOC)`
)
console.log(`module functions: ${report.functionCount} (${totalFnLoc} LOC)`)
console.log(`written to /tmp/runtime-inventory.json`)

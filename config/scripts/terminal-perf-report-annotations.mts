import { readFileSync } from 'node:fs'

export function readJsonReport(path) {
  const raw = readFileSync(path, 'utf8')
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end <= start) {
    throw new Error(`${path}: no JSON object found`)
  }
  return JSON.parse(raw.slice(start, end + 1))
}

export function parseAnnotationDescription(description: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const part of description.split(/\s+/)) {
    const index = part.indexOf('=')
    if (index === -1) {
      continue
    }
    values[part.slice(0, index)] = part.slice(index + 1)
  }
  return values
}

export function collectTerminalPerfRows(
  report: unknown,
  source: string,
  options: { typePrefix?: string } = {}
): Record<string, string>[] {
  const { typePrefix = 'opencode-' } = options
  const rows: Record<string, string>[] = []
  const visitSuite = (suite) => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        for (const annotation of test.annotations ?? []) {
          if (!annotation.type.startsWith(typePrefix)) {
            continue
          }
          rows.push({
            ...parseAnnotationDescription(annotation.description ?? ''),
            // Why: annotation descriptions are artifact-controlled; keep the
            // trusted report source and annotation type from being relabeled.
            source,
            scenario: annotation.type
          })
        }
      }
    }
    for (const child of suite.suites ?? []) {
      visitSuite(child)
    }
  }
  for (const suite of report.suites ?? []) {
    visitSuite(suite)
  }
  return rows
}

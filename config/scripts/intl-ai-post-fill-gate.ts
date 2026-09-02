import fs from 'node:fs/promises'
import path from 'node:path'

import {
  collectStringLeaves,
  repairCatalog,
  type LocaleCatalog
} from './locale-translation-policy.ts'

// orca-only: imports the overrides polish layer. The identical-to-en flagging and
// key-count gate themselves are portable-upstream (plan: upstream contribution 2).

export type CatalogLeaf = { key: string; enValue: string; localeValue: string }
export type IdenticalToEnEntry = { key: string; value: string }

export type PostFillGateReport = {
  locale: string
  keyCountEn: number
  keyCountLocale: number
  overridesApplied: number
  identicalToEn: IdenticalToEnEntry[]
  errors: string[]
  passed: boolean
}

export function findIdenticalToEn(
  enCatalog: LocaleCatalog,
  localeCatalog: LocaleCatalog
): IdenticalToEnEntry[] {
  const localeLeaves = new Map(
    collectStringLeaves(localeCatalog).map((leaf) => [leaf.key, leaf.value])
  )
  const enLeaves = collectStringLeaves(enCatalog)
  const identical: IdenticalToEnEntry[] = []
  for (const leaf of enLeaves) {
    const localeValue = localeLeaves.get(leaf.key)
    if (localeValue === leaf.value && leaf.value.trim().length > 0) {
      identical.push({ key: leaf.key, value: leaf.value })
    }
  }
  return identical
}

export function countKeys(catalog: Record<string, unknown>): number {
  return collectStringLeaves(catalog).length
}

export function runPostFillGate(options: {
  locale: string
  enCatalog: LocaleCatalog
  localeCatalog: LocaleCatalog
}): PostFillGateReport {
  const { locale, enCatalog, localeCatalog } = options
  const errors: string[] = []

  const keyCountEn = countKeys(enCatalog)
  const keyCountLocale = countKeys(localeCatalog)
  if (keyCountEn !== keyCountLocale) {
    errors.push(`Key count mismatch: en=${keyCountEn}, ${locale}=${keyCountLocale}`)
  }

  // Why: repairCatalog only rewrites values that already exist, so a missing-key
  // catalog would silently pass the polish step; the count gate above catches it.
  const overridesApplied = repairCatalog(enCatalog, localeCatalog, locale)

  const identicalToEn = findIdenticalToEn(enCatalog, localeCatalog)

  return {
    locale,
    keyCountEn,
    keyCountLocale,
    overridesApplied,
    identicalToEn,
    errors,
    passed: errors.length === 0
  }
}

export function renderReportMarkdown(report: PostFillGateReport): string {
  const lines = [
    `# intl-ai post-fill gate: ${report.locale}`,
    '',
    `- Keys: en=${report.keyCountEn}, ${report.locale}=${report.keyCountLocale}`,
    `- Overrides polish applied: ${report.overridesApplied} leaf updates`,
    `- Identical-to-en: ${report.identicalToEn.length} (written, flagged for review)`,
    `- Result: ${report.passed ? 'PASS' : 'FAIL'}`,
    ''
  ]
  for (const error of report.errors) {
    lines.push(`- ERROR: ${error}`)
  }
  if (report.identicalToEn.length > 0) {
    lines.push('', '## Identical to English (review: brand terms ok, untranslated prose not)')
    for (const entry of report.identicalToEn.slice(0, 200)) {
      lines.push(`- \`${entry.key}\`: ${entry.value}`)
    }
    if (report.identicalToEn.length > 200) {
      lines.push(`- ... ${report.identicalToEn.length - 200} more`)
    }
  }
  return `${lines.join('\n')}\n`
}

export async function writeReport(report: PostFillGateReport, localesDir: string): Promise<string> {
  const reportPath = path.join(localesDir, `.intl-ai-report-${report.locale}.md`)
  await fs.writeFile(reportPath, renderReportMarkdown(report), 'utf8')
  return reportPath
}

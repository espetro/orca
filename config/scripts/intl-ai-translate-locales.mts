import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import { runCheck, runFill, type ResolvedIntlAiConfig } from '@intl-ai/api'
import dotenv from 'dotenv'

import {
  INTL_AI_LOCALES_DIR,
  buildIntlAiConfig,
  INTL_AI_TARGET_LOCALES
} from './intl-ai.config.mts'
import type { LocaleCatalog } from './locale-translation-policy.mts'
import { resolveOpenRouterApiKey } from './intl-ai-env.mts'
import { resolveModelPolicy } from './intl-ai-model-policy.mts'
import { runPostFillGate, writeReport } from './intl-ai-post-fill-gate.mts'

type CliFlags = {
  locale?: string
  all: boolean
  check: boolean
  dryRun: boolean
  force: boolean
  model?: string
  allowPaid: boolean
}

function parseFlags(argv: readonly string[]): CliFlags {
  const flags: CliFlags = {
    all: false,
    check: false,
    dryRun: false,
    force: false,
    allowPaid: false
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--locale') {
      flags.locale = argv[index + 1]
      index += 1
    } else if (arg === '--all') {
      flags.all = true
    } else if (arg === '--check') {
      flags.check = true
    } else if (arg === '--force') {
      flags.force = true
    } else if (arg === '--allow-paid') {
      flags.allowPaid = true
    } else if (arg === '--model') {
      flags.model = argv[index + 1]
      index += 1
    }
  }
  // Why: dry-run defaults ON for fill; a bare `intl-ai:translate` must never write.
  if (!flags.check && !flags.all && !flags.locale) {
    flags.dryRun = true
  }
  if (argv.includes('--dry-run')) {
    flags.dryRun = true
  }
  return flags
}

export function isIntlAiDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.INTL_AI_DISABLED === '1'
}

async function loadCatalog(locale: string): Promise<LocaleCatalog> {
  const raw: unknown = JSON.parse(
    await fs.readFile(path.join(INTL_AI_LOCALES_DIR, `${locale}.json`), 'utf8')
  )
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${locale}.json is not a JSON object`)
  }
  return raw as LocaleCatalog
}

async function loadStashKey(): Promise<{ value: string }> {
  // Read the stash .env directly (same file intl-ai-env resolves) without logging it.
  const { ORCA_STASH_ENV_PATH } = await import('./intl-ai-env.mts')
  const content = await fs.readFile(ORCA_STASH_ENV_PATH, 'utf8')
  const parsed = dotenv.parse(content)
  return { value: parsed.OPENROUTER_API_KEY ?? '' }
}

async function resolveConfig(flags: CliFlags): Promise<ResolvedIntlAiConfig> {
  const model = flags.model ?? buildIntlAiConfig().model
  const policy = resolveModelPolicy(model, flags.allowPaid)
  if (policy.kind === 'refused') {
    throw new Error(policy.reason)
  }
  const key = await resolveOpenRouterApiKey()
  if (key.kind === 'missing') {
    throw new Error(key.reason)
  }
  // resolveOpenRouterApiKey only probes env values; pull the final value here.
  const apiKey =
    key.source === 'shell' ? (process.env.OPENROUTER_API_KEY ?? '') : (await loadStashKey()).value
  if (apiKey.trim().length === 0) {
    throw new Error('OPENROUTER_API_KEY resolved but empty; refusing to run.')
  }
  const config = buildIntlAiConfig({ model })
  return { ...config, apiKey } as ResolvedIntlAiConfig
}

async function runCheckMode(config: ResolvedIntlAiConfig, locale: string): Promise<number> {
  const result = await runCheck(config, { locale })
  const localeResult = result.results[0]
  if (!localeResult) {
    console.log(`intl-ai check: no results for ${locale}`)
    return 0
  }
  console.log(
    `intl-ai check ${locale}: missing=${localeResult.missing.length} stale=${localeResult.stale.length} extra=${localeResult.extra.length}`
  )
  return result.hasIssues ? 1 : 0
}

async function runFillMode(
  config: ResolvedIntlAiConfig,
  locale: string,
  flags: CliFlags
): Promise<number> {
  if (flags.dryRun) {
    // runCheck is read-only and makes zero fetches: the dry-run contract.
    return runCheckMode(config, locale)
  }
  const result = await runFill(config, { locale, force: flags.force })
  console.log(
    `intl-ai fill ${locale}: translated=${result.translated} skipped=${result.skipped} errors=${result.errors} needsReview=${result.needsReview}`
  )
  for (const failure of result.failures.slice(0, 20)) {
    console.error(`  FAILURE ${failure.key}: ${failure.error}`)
  }

  const enCatalog = await loadCatalog('en')
  const localeCatalog = await loadCatalog(locale)
  const report = runPostFillGate({ locale, enCatalog, localeCatalog })
  const reportPath = await writeReport(report, INTL_AI_LOCALES_DIR)
  console.log(`Post-fill gate: ${report.passed ? 'PASS' : 'FAIL'}; report at ${reportPath}`)
  for (const error of report.errors) {
    console.error(`  GATE ERROR: ${error}`)
  }
  return report.passed && result.errors === 0 ? 0 : 1
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  if (isIntlAiDisabled()) {
    console.log('intl-ai is disabled (INTL_AI_DISABLED=1); exiting 0 with zero writes.')
    return 0
  }
  const flags = parseFlags(argv)
  const locales = flags.all ? [...INTL_AI_TARGET_LOCALES] : flags.locale ? [flags.locale] : ['zh']

  for (const locale of locales) {
    if (locale === 'en') {
      console.error('en is the source locale; nothing to translate.')
      return 1
    }
  }

  try {
    const config = await resolveConfig(flags)
    let exitCode = 0
    for (const locale of locales) {
      const code = flags.check
        ? await runCheckMode(config, locale)
        : await runFillMode(config, locale, flags)
      exitCode = exitCode !== 0 ? exitCode : code
    }
    if (!flags.dryRun && !flags.check) {
      console.log('AI output is written but NOT committed; review `git diff` before staging.')
    }
    return exitCode
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }
}

if (process.argv[1]?.endsWith('intl-ai-translate-locales.mts')) {
  main().then((code) => {
    process.exitCode = code
  })
}

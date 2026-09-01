import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

import { repairCatalog } from './locale-translation-policy.mts'

const LOCALES_DIR = path.join('src', 'renderer', 'src', 'i18n', 'locales')

const LOCALES = ['ko', 'zh', 'ja', 'es']

function parseLocaleArg(argv) {
  const localeFlagIndex = argv.indexOf('--locale')
  if (localeFlagIndex !== -1 && argv[localeFlagIndex + 1]) {
    return argv[localeFlagIndex + 1]
  }
  return undefined
}

export async function repairLocale(root, locale) {
  const enPath = path.join(root, LOCALES_DIR, 'en.json')
  const localePath = path.join(root, LOCALES_DIR, `${locale}.json`)

  const enCatalog = JSON.parse(await fs.readFile(enPath, 'utf8'))
  const localeCatalog = JSON.parse(await fs.readFile(localePath, 'utf8'))

  const catalogRepairs = repairCatalog(enCatalog, localeCatalog, locale)

  await fs.writeFile(localePath, `${JSON.stringify(localeCatalog, null, 2)}\n`, 'utf8')

  console.log(`Repaired ${locale}.json (${catalogRepairs} leaf updates)`)
  return { catalogRepairs }
}

export async function main(root = process.cwd(), locale = parseLocaleArg(process.argv)) {
  const locales = locale ? [locale] : LOCALES
  const unsupported = locales.filter((code) => !LOCALES.includes(code))
  if (unsupported.length > 0) {
    console.error(`Unsupported locale(s): ${unsupported.join(', ')}`)
    return 1
  }

  for (const code of locales) {
    await repairLocale(root, code)
  }

  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main())
}

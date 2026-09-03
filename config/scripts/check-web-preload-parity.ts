#!/usr/bin/env node
/**
 * Contract ratchet verifying web preload parity against Electron preload.
 *
 * Checks that 100% of properties defined on `PreloadApi` in src/preload/api-types.ts
 * are explicitly implemented in createWebPreloadApi() in src/renderer/src/web/web-preload-api.ts.
 *
 * Usage: node config/scripts/check-web-preload-parity.ts
 */
import ts from 'typescript-api'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const ROOT = path.join(import.meta.dirname, '..', '..')
const API_TYPES_PATH = path.join(ROOT, 'src', 'preload', 'api-types.ts')
const WEB_PRELOAD_API_PATH = path.join(ROOT, 'src', 'renderer', 'src', 'web', 'web-preload-api.ts')

export function getExpectedPreloadProperties(filePath = API_TYPES_PATH): string[] {
  const content = readFileSync(filePath, 'utf8')
  const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true)
  const properties: string[] = []

  function visit(node: ts.Node): void {
    if (ts.isTypeAliasDeclaration(node) && node.name.text === 'PreloadApi') {
      if (ts.isTypeLiteralNode(node.type)) {
        for (const member of node.type.members) {
          if (ts.isPropertySignature(member) && member.name) {
            properties.push(member.name.getText(sourceFile))
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return properties.sort()
}

export function getImplementedWebPreloadProperties(filePath = WEB_PRELOAD_API_PATH): string[] {
  const content = readFileSync(filePath, 'utf8')
  const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true)
  const properties: string[] = []

  function visit(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'createWebPreloadApi') {
      function findReturn(inner: ts.Node): void {
        if (
          ts.isReturnStatement(inner) &&
          inner.expression &&
          ts.isObjectLiteralExpression(inner.expression)
        ) {
          for (const prop of inner.expression.properties) {
            if (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) {
              properties.push(prop.name.getText(sourceFile))
            }
          }
        }
        ts.forEachChild(inner, findReturn)
      }
      findReturn(node)
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return properties.sort()
}

export function verifyPreloadParity(
  apiTypesPath = API_TYPES_PATH,
  webPreloadPath = WEB_PRELOAD_API_PATH
): {
  missing: string[]
  extra: string[]
  totalExpected: number
  totalImplemented: number
} {
  const expected = getExpectedPreloadProperties(apiTypesPath)
  const implemented = getImplementedWebPreloadProperties(webPreloadPath)
  const implementedSet = new Set(implemented)
  const expectedSet = new Set(expected)

  const missing = expected.filter((p) => !implementedSet.has(p))
  const extra = implemented.filter((p) => !expectedSet.has(p))

  return {
    missing,
    extra,
    totalExpected: expected.length,
    totalImplemented: implemented.length
  }
}

async function main(): Promise<void> {
  const { missing, extra, totalExpected } = verifyPreloadParity()

  if (missing.length > 0) {
    const missingLines = missing.map((m) => `  - ${m}`).join('\n')
    console.error(
      `[web-preload-parity] ${missing.length} property/properties on PreloadApi missing from createWebPreloadApi():\n${missingLines}\n\nEvery PreloadApi property must have an implementation or explicit degradation stub.`
    )
    process.exitCode = 1
    return
  }

  if (extra.length > 0) {
    const extraLines = extra.map((e) => `  + ${e}`).join('\n')
    console.warn(
      `[web-preload-parity] ${extra.length} extra property/properties in createWebPreloadApi() not on PreloadApi:\n${extraLines}`
    )
  }

  console.log(
    `[web-preload-parity] ok — 100% parity: all ${totalExpected} PreloadApi properties implemented in web preload.`
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}

// Boundary rule: raw fs opendir/opendirSync must stay inside the handle-lifetime
// scope module. Everywhere else, use withDir from src/shared/fs-opendir-scope.
// Allowlisted files are pre-existing try/finally-safe sites pending migration
// to withDir in a follow-up. Do not add new entries.
const ALLOWLIST = new Set([
  'src/relay/workspace-space-scan.ts',
  'src/main/codex/codex-session-file-listing.ts',
  'src/main/daemon/history-reader.ts',
  'src/main/skills/skill-package-identity.ts',
  'src/main/skills/skill-plugin-cache-scan.ts',
  'src/main/skills/skill-upload-staging-ownership.ts',
  'src/main/warp-themes/theme-file-scanner.ts',
  'src/main/window/clipboard-remote-file-cleanup.bench.test.ts',
  'src/main/window/clipboard-remote-file-staging.ts',
  'src/main/workspace-space-local-scan.ts',
  'src/shared/agent-hook-endpoint-temp-cleanup.ts',
  'src/shared/fs-opendir-scope.ts',
  'src/shared/grok-session-paths.ts',
  'src/shared/linux-proc-socket-owner-scanner.ts',
  'src/shared/node-markdown-document-discovery.ts'
])

const MESSAGE =
  'Raw opendir/opendirSync leaks directory handles. Use withDir from src/shared/fs-opendir-scope instead.'

function isAllowed(context) {
  const filename = (context.physicalPath ?? context.filename ?? '')
    .replaceAll('\\', '/')
    .replace(/.*?(src\/)/, 'src/')
  return ALLOWLIST.has(filename)
}

function isOpendirName(name) {
  return name === 'opendir' || name === 'opendirSync'
}

export default {
  meta: { name: 'fs-opendir-boundary' },
  rules: {
    'no-raw-opendir': {
      create(context) {
        if (isAllowed(context)) {
          return {}
        }
        return {
          ImportSpecifier(node) {
            const parent = node.parent
            if (!parent || parent.type !== 'ImportDeclaration') {
              return
            }
            const source = parent.source?.value
            if (
              isOpendirName(node.imported?.name ?? node.imported?.value) &&
              (source === 'node:fs/promises' ||
                source === 'fs/promises' ||
                source === 'node:fs' ||
                source === 'fs')
            ) {
              context.report({ node, message: MESSAGE })
            }
          },
          CallExpression(node) {
            const callee = node.callee
            if (callee.type !== 'MemberExpression') {
              return
            }
            const prop = callee.property?.name
            if (!isOpendirName(prop)) {
              return
            }
            const obj = callee.object
            const objName = obj.type === 'Identifier' ? obj.name : null
            const isPromisesNamespace =
              objName === 'promises' ||
              (obj.type === 'MemberExpression' &&
                obj.property?.name === 'promises' &&
                (obj.object?.name === 'fs' || obj.object?.name === 'nodeFs'))
            if (
              isPromisesNamespace ||
              objName === 'fs' ||
              objName === 'nodeFs' ||
              objName === 'fsp'
            ) {
              context.report({ node, message: MESSAGE })
            }
          }
        }
      }
    }
  }
}

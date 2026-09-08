// pnpm 12's npm_execpath is a native binary; feeding it to node broke hourly/adhoc macOS builds.

const JS_CLI_EXTENSION = /\.[cm]?js$/i

// Why: when vitest itself is launched through npm/npx, npm_execpath points at npm's
// own CLI (npm-cli.js / npx-cli.js). Trusting it then runs npm where pnpm is meant,
// which fails on pnpm-only flags and lockfile semantics.
const NPM_CLI_SEGMENT = /[/\\]npm[/\\](?:bin[/\\])?npm-cli\.[cm]?js$/i
const NPX_CLI_SEGMENT = /[/\\]npm[/\\]bin[/\\]npx-cli\.[cm]?js$/i

export function resolvePnpmCliInvocation({
  npmExecPath = process.env.npm_execpath,
  nodeExecPath = process.execPath,
  platform = process.platform
} = {}) {
  if (
    typeof npmExecPath === 'string' &&
    npmExecPath.length > 0 &&
    !NPM_CLI_SEGMENT.test(npmExecPath) &&
    !NPX_CLI_SEGMENT.test(npmExecPath)
  ) {
    if (JS_CLI_EXTENSION.test(npmExecPath)) {
      return { command: nodeExecPath, prefixArgs: [npmExecPath], shell: false }
    }
    return {
      command: npmExecPath,
      prefixArgs: [],
      shell: platform === 'win32' && /\.(cmd|bat)$/i.test(npmExecPath)
    }
  }

  return {
    command: platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    prefixArgs: [],
    shell: platform === 'win32'
  }
}

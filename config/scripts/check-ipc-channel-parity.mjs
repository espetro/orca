import fs from 'node:fs'
import path from 'node:path'
import { parse as parseJsonc } from 'jsonc-parser'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

// Parity gate between preload IPC call sites and main IPC registrations.
//
// Scans `src/preload/**` for `ipcRenderer.invoke/send/sendSync/on/once/removeListener`
// and `src/main/**` for `ipcMain.handle/on` (plus the `handleMainWindowSkillIpc`
// wrapper) and asserts both sides reference the same channel set. A channel
// renamed on one side only fails here instead of passing both typechecks.

/**
 * @typedef {'preload-invoke' | 'preload-send' | 'preload-listen'} PreloadCallKind
 * @typedef {'main-handle' | 'main-listen'} MainRegistrationKind
 * @typedef {{ channel: string, file: string, line: number, kind: PreloadCallKind | MainRegistrationKind }} ChannelSite
 * @typedef {{ reason: string }} AllowlistEntry
 * @typedef {{ pattern: string, reason: string }} AllowlistPattern
 * @typedef {{ patterns: AllowlistPattern[], channels: Record<string, AllowlistEntry> }} Allowlist
 * @typedef {{ preloadOnly: ChannelSite[], mainOnly: ChannelSite[] }} ParityReport
 */

const ROOT = process.cwd()
const PRELOAD_DIR = 'src/preload'
const MAIN_DIR = 'src/main'
const SHARED_DIR = 'src/shared'
const ALLOWLIST_PATH = 'config/ipc-channel-parity-allowlist.json'

/** @param {string} dir @returns {string[]} */
function listTsFiles(dir) {
  const absolute = path.join(ROOT, dir)
  if (!fs.existsSync(absolute)) {
    return []
  }
  return fs.readdirSync(absolute, { recursive: true, withFileTypes: false })
    .map((entry) => path.join(dir, String(entry)))
    .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file) && !/test-harness/.test(file))
}

/**
 * Constants whose string value is an IPC channel, collected so call sites can
 * name them instead of inlining the literal.
 * @param {string[]} files @returns {Map<string, string>}
 */
function collectChannelConstants(files) {
  /** @type {Map<string, string>} */
  const constants = new Map()
  for (const file of files) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8')
    for (const match of source.matchAll(/(?:const|let)\s+(\w+)\s*=\s*'([a-zA-Z][\w-]*:[\w:-]+)'/g)) {
      constants.set(/** @type {string} */ (match[1]), /** @type {string} */ (match[2]))
    }
  }
  return constants
}

/**
 * First argument of a call: a quoted literal or an identifier resolvable via
 * known channel constants. Returns null when the argument is dynamic.
 * @param {string} args
 * @param {Map<string, string>} constants
 * @returns {string | null}
 */
/** Exported for the module's own unit tests. */
export function resolveChannelArgForTest(args, constants) {
  return resolveChannelArg(args, constants)
}

function resolveChannelArg(args, constants) {
  const literal = args.match(/^'([a-zA-Z][\w-]*:[\w:-]+)'/)
  if (literal) {
    return literal[1]
  }
  // Channel captured without surrounding quotes (send-helper patterns).
  const bare = args.match(/^([a-zA-Z][\w-]*:[\w:-]+)$/)
  if (bare) {
    return bare[1]
  }
  const identifier = args.match(/^([A-Za-z_]\w*)\b/)
  if (identifier) {
    return constants.get(/** @type {string} */ (identifier[1])) ?? null
  }
  return null
}

/**
 * `send('domain:action', ...)` push sends: bare helpers, qualified receivers
 * like `renderer.send(...)`, and named helpers taking a channel constant.
 * @param {string} file @param {string} source @param {RegExp} pattern
 * @param {Map<string, string>} constants @returns {ChannelSite[]}
 */
function extractSendHelperSites(file, source, pattern, constants) {
  /** @type {ChannelSite[]} */
  const sites = []
  for (const match of source.matchAll(pattern)) {
    const line = source.slice(0, /** @type {number} */ (match.index)).split('\n').length
    const channel = resolveChannelArg(String(match[1] ?? ''), constants)
    if (channel) {
      sites.push({ channel, file, line, kind: 'main-listen' })
    }
  }
  return sites
}

/**
 * @param {string} file @param {string} source @param {RegExp} callPattern
 * @param {string} kind @param {Map<string, string>} constants @returns {ChannelSite[]}
 */
function extractCallSites(file, source, callPattern, kind, constants) {
  /** @type {ChannelSite[]} */
  const sites = []
  for (const match of source.matchAll(callPattern)) {
    const line = source.slice(0, /** @type {number} */ (match.index)).split('\n').length
    const channel = resolveChannelArg(String(match[1] ?? ''), constants)
    if (channel) {
      sites.push({ channel, file, line, kind: /** @type {PreloadCallKind | MainRegistrationKind} */ (kind) })
    }
  }
  return sites
}

const PRELOAD_CALLS = [
  ['invoke', 'preload-invoke'],
  ['sendSync', 'preload-send'],
  ['send', 'preload-send'],
  ['once', 'preload-listen'],
  ['on', 'preload-listen'],
  ['removeListener', 'preload-listen']
]

const MAIN_CALLS = [
  ['handle', 'main-handle'],
  ['on', 'main-listen']
]

// Push sends to the renderer (webContents/sender.send and the send helper
// they back) are the main-side counterpart of ipcRenderer.on/once listeners.
const MAIN_PUSH_PATTERN = /(?:webContents|sender)\.send\(\s*([^)]*)/g
const MAIN_PUSH_HELPER_PATTERN = /(?<![\w.])send\(\s*'([a-zA-Z][\w-]*:[\w:-]+)'/g
const MAIN_PUSH_QUALIFIED_PATTERN = /\b\w+\??\.??\.send\(\s*'([a-zA-Z][\w-]*:[\w:-]+)'/g
// Same call shape but with a channel-constant identifier as first argument.
const MAIN_PUSH_QUALIFIED_CONST_PATTERN = /\b\w+\??\.??\.send\(\s*([A-Za-z_]\w*)\b/g
// Named send helpers that take the channel as their first argument.
const MAIN_PUSH_NAMED_HELPER_PATTERN = /\b(?:sendToTrustedUIRenderer|sendToRenderer)\(\s*'([a-zA-Z][\w-]*:[\w:-]+)'/g

/** @returns {{ preloadSites: ChannelSite[], mainSites: ChannelSite[] }} */
export function scanChannelSites() {
  const preloadFiles = listTsFiles(PRELOAD_DIR)
  const mainFiles = listTsFiles(MAIN_DIR)
  const constants = collectChannelConstants([...preloadFiles, ...mainFiles, ...listTsFiles(SHARED_DIR)])

  /** @type {ChannelSite[]} */
  const preloadSites = []
  for (const file of preloadFiles) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8')
    for (const [method, kind] of PRELOAD_CALLS) {
      preloadSites.push(...extractCallSites(file, source, new RegExp(`ipcRenderer\\.${method}\\(\\s*([^)]*)`, 'g'), kind, constants))
      // runtime-environment-subscriptions.ts routes through an `ipc` wrapper object.
      preloadSites.push(...extractCallSites(file, source, new RegExp(`\\bipc\\.${method}\\(\\s*([^)]*)`, 'g'), kind, constants))
    }
  }

  /** @type {ChannelSite[]} */
  const mainSites = []
  for (const file of mainFiles) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8')
    for (const [method, kind] of MAIN_CALLS) {
      mainSites.push(...extractCallSites(file, source, new RegExp(`ipcMain\\.${method}\\(\\s*([^)]*)`, 'g'), kind, constants))
    }
    // Wrapper in src/main/ipc/skill-ipc-main-window.ts registers via ipcMain.handle.
    mainSites.push(...extractCallSites(file, source, /handleMainWindowSkillIpc\(\s*([^)]*)/g, 'main-handle', constants))
    mainSites.push(...extractCallSites(file, source, MAIN_PUSH_PATTERN, 'main-listen', constants))
    mainSites.push(...extractSendHelperSites(file, source, MAIN_PUSH_HELPER_PATTERN, constants))
    mainSites.push(...extractSendHelperSites(file, source, MAIN_PUSH_QUALIFIED_PATTERN, constants))
    mainSites.push(...extractSendHelperSites(file, source, MAIN_PUSH_QUALIFIED_CONST_PATTERN, constants))
    mainSites.push(...extractSendHelperSites(file, source, MAIN_PUSH_NAMED_HELPER_PATTERN, constants))
  }

  return { preloadSites, mainSites }
}

/** @returns {Allowlist} */
export function loadAllowlist() {
  const absolute = path.join(ROOT, ALLOWLIST_PATH)
  if (!fs.existsSync(absolute)) {
    return { patterns: [], channels: {} }
  }
  return /** @type {Allowlist} */ (parseJsonc(fs.readFileSync(absolute, 'utf8')))
}

/**
 * @param {string} channel @param {Allowlist} allowlist @returns {boolean}
 */
export function isAllowlisted(channel, allowlist) {
  if (allowlist.channels[channel]) {
    return true
  }
  return allowlist.patterns.some((entry) => new RegExp(entry.pattern).test(channel))
}

/**
 * @param {ChannelSite[]} preloadSites @param {ChannelSite[]} mainSites @param {Allowlist} allowlist
 * @returns {ParityReport}
 */
export function computeParity(preloadSites, mainSites, allowlist) {
  const mainChannels = new Set(mainSites.map((site) => site.channel))
  const preloadChannels = new Set(preloadSites.map((site) => site.channel))
  const preloadOnly = preloadSites.filter(
    (site) => !mainChannels.has(site.channel) && !isAllowlisted(site.channel, allowlist)
  )
  const mainOnly = mainSites.filter(
    (site) => !preloadChannels.has(site.channel) && !isAllowlisted(site.channel, allowlist)
  )
  return { preloadOnly, mainOnly }
}

/** @returns {ParityReport} */
export function runParityCheck() {
  const { preloadSites, mainSites } = scanChannelSites()
  const report = computeParity(preloadSites, mainSites, loadAllowlist())
  const preloadCount = new Set(preloadSites.map((site) => site.channel)).size
  const mainCount = new Set(mainSites.map((site) => site.channel)).size
  console.log(`ipc channel parity: preload channels ${preloadCount}, main channels ${mainCount}`)
  console.log(`ipc channel parity: preload-only violations ${report.preloadOnly.length}, main-only violations ${report.mainOnly.length}`)
  for (const site of report.preloadOnly) {
    console.log(`  preload-only: ${site.channel} (${site.kind}) at ${site.file}:${site.line}`)
  }
  for (const site of report.mainOnly) {
    console.log(`  main-only: ${site.channel} (${site.kind}) at ${site.file}:${site.line}`)
  }
  return report
}

const isMainModule = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url
if (isMainModule) {
  const report = runParityCheck()
  if (report.preloadOnly.length > 0 || report.mainOnly.length > 0) {
    process.exitCode = 1
  }
}

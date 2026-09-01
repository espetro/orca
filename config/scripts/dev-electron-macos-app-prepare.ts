import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'
import {
  DEV_BUNDLE_ID,
  getDevBundlePlistPatches,
  getDevHelperPlistPatches
} from './dev-electron-bundle-identity.ts'
import { isDevBundleInUse } from './dev-electron-bundle-cache.ts'
import {
  DEV_BUNDLE_MARKER_FILE,
  getDevBundleProcessTable,
  pruneStaleDevBundles
} from './dev-electron-bundle-cache-gc.ts'

function setPlistValue(plistPath: string, key: string, value: string): void {
  execFileSync('/usr/bin/plutil', ['-replace', key, '-string', value, plistPath])
}

function sanitizeMacAppBundleName(value: string): string {
  return (
    Array.from(value, (char: string) => {
      const code = char.charCodeAt(0)
      return code < 32 || code === 127 || char === '/' || char === '\\' ? '-' : char
    })
      .join('')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || 'Orca'
  )
}

function isSymlink(filePath: string): boolean {
  try {
    return lstatSync(filePath).isSymbolicLink()
  } catch {
    return false
  }
}

function ensureRelativeSymlink(linkPath: string, target: string): void {
  if (isSymlink(linkPath)) {
    try {
      if (readlinkSync(linkPath) === target) {
        return
      }
    } catch {}
  }

  const targetPath = path.join(path.dirname(linkPath), target)
  if (!existsSync(targetPath)) {
    return
  }

  rmSync(linkPath, { recursive: true, force: true })
  symlinkSync(target, linkPath)
}

function restoreElectronFrameworkSymlinks(appPath: string): void {
  const frameworkPath = path.join(appPath, 'Contents', 'Frameworks', 'Electron Framework.framework')
  const versionsPath = path.join(frameworkPath, 'Versions')
  if (!existsSync(path.join(versionsPath, 'A'))) {
    return
  }

  // Why: some Electron installs have framework symlinks flattened into
  // duplicate directories. Recreate the relative bundle links after copying so
  // Chromium resolves resources through the canonical macOS framework layout.
  ensureRelativeSymlink(path.join(versionsPath, 'Current'), 'A')
  for (const entry of ['Electron Framework', 'Resources', 'Libraries', 'Helpers']) {
    ensureRelativeSymlink(path.join(frameworkPath, entry), `Versions/Current/${entry}`)
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Copies (or reuses) a branch-invariant signed Electron.app under out/electron-dev and points
 * ELECTRON_EXEC_PATH at it. See dev-electron-bundle-identity.ts for why plist values must not
 * vary per branch.
 */
export function prepareMacDevElectronApp(repoRoot: string): void {
  if (process.platform !== 'darwin') {
    return
  }

  const sourceAppPath = path.join(repoRoot, 'node_modules', 'electron', 'dist', 'Electron.app')
  const electronPackagePath = path.join(repoRoot, 'node_modules', 'electron', 'package.json')
  if (!existsSync(sourceAppPath)) {
    return
  }

  let electronVersion: string | null = null
  try {
    const parsed: unknown = JSON.parse(readFileSync(electronPackagePath, 'utf8'))
    if (typeof parsed === 'object' && parsed !== null && 'version' in parsed) {
      const { version } = parsed as { version?: unknown }
      electronVersion = typeof version === 'string' ? version : null
    }
  } catch {}

  const title = process.env.ORCA_DEV_DOCK_TITLE || 'Orca: dev'
  const identityKey = process.env.ORCA_DEV_INSTANCE_KEY || repoRoot
  // v11: stop patching the branch title into Info.plist so every dev bundle signs to one cdhash.
  // A stale copy only emits extra fields the parser ignores, so narrowing its schema needs no bump.
  const bundleLayoutVersion = 'stable-cdhash-dock-name-from-bundle-dir-v11'
  const hash = createHash('sha1')
    .update(
      `${sourceAppPath}\0${electronVersion ?? ''}\0${title}\0${identityKey}\0${bundleLayoutVersion}`
    )
    .digest('hex')
    .slice(0, 12)
  const distDir = path.join(repoRoot, 'out', 'electron-dev', hash)
  // Why: macOS Dock hover uses the bundle's filesystem display name for electron-vite's direct
  // binary launch path. This is what carries the per-branch name now that Info.plist no longer does,
  // and it sits outside the code signature, so varying it does not disturb the cdhash.
  const appBundleName = `${sanitizeMacAppBundleName(title)}.app`
  const appPath = path.join(distDir, appBundleName)
  const markerPath = path.join(distDir, DEV_BUNDLE_MARKER_FILE)
  // Why: one stable id for every dev instance. Per-instance ids registered a
  // new macOS Notification Settings entry for each branch × Electron version,
  // piling up "Orca: <branch>" rows forever and breaking the notification
  // settings deep-link (System Settings can't resolve an id it has no entry
  // for and falls back to the root list). macOS keys notification permission
  // by bundle id, so a single id also means granting notifications to one dev
  // instance covers all of them. Trade-off: when two dev instances run at
  // once, macOS may route a notification click to the other instance —
  // Electron drops clicks for notification ids it didn't create, so the
  // click is lost, not misdirected.
  const bundleId = DEV_BUNDLE_ID
  process.env.ORCA_DEV_MACOS_BUNDLE_ID = bundleId
  // Why the patches are in the marker: bundleLayoutVersion alone does not cover them, so a cache
  // built before a patch value changed would be reused and keep presenting the old identity.
  const expectedMarker = JSON.stringify(
    {
      title,
      appBundleName,
      bundleId,
      sourceAppPath,
      electronVersion,
      bundleLayoutVersion,
      plistPatches: [...getDevBundlePlistPatches(), ...getDevHelperPlistPatches()]
    },
    null,
    2
  )
  const executablePath = path.join(appPath, 'Contents', 'MacOS', 'Electron')
  // Split by consequence: without this Chromium blank-crashes, so it gates whether the bundle can
  // run at all. The keyboard-layout helper below is optional -- swiftc builds it non-fatally, so on
  // a Mac without full Xcode it is simply absent and only a keyboard feature degrades.
  const chromiumResourcePath = path.join(
    appPath,
    'Contents',
    'Frameworks',
    'Electron Framework.framework',
    'Resources',
    'icudtl.dat'
  )
  const requiredResourcePaths = [
    chromiumResourcePath,
    path.join(appPath, 'Contents', 'MacOS', 'orca-keyboard-layout')
  ]

  function copiedAppIsUsable(): boolean {
    if (!existsSync(markerPath) || !existsSync(appPath)) {
      return false
    }
    try {
      if (readFileSync(markerPath, 'utf8') !== expectedMarker) {
        return false
      }
    } catch {
      return false
    }
    // Why: a previous interrupted copy can leave the marker and executable
    // present but miss Chromium framework resources, causing a blank crash.
    return (
      existsSync(executablePath) &&
      requiredResourcePaths.every((resourcePath) => existsSync(resourcePath))
    )
  }

  if (copiedAppIsUsable()) {
    pruneStaleDevBundles(distDir)
    process.env.ELECTRON_EXEC_PATH = executablePath
    return
  }

  // Why this guard: a rebuild replaces this exact directory, and making the marker conditional on a
  // successful sign means an unsigned bundle is a permanent cache miss -- so every later run would
  // reach this rmSync while another instance is still running from it, deleting its app mid-session.
  // Reusing what is there matches what the runner did before the marker became conditional.
  const rebuildProcessTable = getDevBundleProcessTable()
  if (
    rebuildProcessTable !== null &&
    isDevBundleInUse(distDir, rebuildProcessTable) &&
    // Why a runnability check: a bundle missing Chromium's resources blank-crashes, and its
    // orphaned crashpad helper still matches the process table -- so without this the runner would
    // reuse a broken bundle forever and never rebuild itself out. Deliberately narrower than
    // copiedAppIsUsable, which also demands the optional keyboard-layout helper: gating on that
    // would strand every Mac without swiftc back on the rmSync path this guard exists to avoid.
    existsSync(executablePath) &&
    existsSync(chromiumResourcePath)
  ) {
    console.warn(
      `[orca-dev] Another dev instance is running from this bundle; reusing it instead of rebuilding. Quit the other instance (or delete ${distDir}) to force a rebuild.`
    )
    process.env.ELECTRON_EXEC_PATH = executablePath
    return
  }

  rmSync(distDir, { recursive: true, force: true })
  mkdirSync(distDir, { recursive: true })
  // Why: Electron.framework uses relative symlinks for its bundle resources;
  // resolving them to pnpm-store absolutes breaks Chromium's bundle lookup.
  cpSync(sourceAppPath, appPath, { recursive: true, verbatimSymlinks: true })
  restoreElectronFrameworkSymlinks(appPath)

  const plistPath = path.join(appPath, 'Contents', 'Info.plist')
  const helperPlistPath = path.join(
    appPath,
    'Contents',
    'Frameworks',
    'Electron Helper.app',
    'Contents',
    'Info.plist'
  )
  // Why every value here is constant: Info.plist is inside the signature seal, so a branch-varying
  // value (these keys used to carry the branch title) changed the ad-hoc cdhash per branch, and
  // macOS Keychain ACLs match on that cdhash — every branch read as a different app and re-prompted.
  // Patching these keys is fine; varying them is not. The Dock takes its label from the .app
  // directory name (see appBundleName), which is outside the signature, so per-branch names survive.
  for (const { key, value } of getDevBundlePlistPatches()) {
    setPlistValue(plistPath, key, value)
  }
  for (const { key, value } of getDevHelperPlistPatches()) {
    setPlistValue(helperPlistPath, key, value)
  }

  // Why: the notification-status helper reads the app's real macOS
  // notification authorization (UNUserNotificationCenter has no Electron
  // API). It must live inside the bundle and carry the dev bundle id as its
  // embedded/code-sign identifier — macOS keys notification records to the
  // signing identifier. Non-fatal: without swiftc the permission card falls
  // back to delivery-probe heuristics.
  try {
    execFileSync(
      process.execPath,
      [
        path.join(repoRoot, 'config', 'scripts', 'build-notification-status-macos.ts'),
        '--bundle-id',
        bundleId,
        '--single-arch',
        '--output',
        path.join(appPath, 'Contents', 'MacOS', 'orca-notification-status')
      ],
      { stdio: 'inherit' }
    )
  } catch (error) {
    console.warn(
      `[orca-dev] notification-status helper build failed (permission card falls back to probes): ${errorMessage(error)}`
    )
  }

  try {
    execFileSync(
      process.execPath,
      [
        path.join(repoRoot, 'config', 'scripts', 'build-keyboard-layout-macos.ts'),
        '--single-arch',
        '--output',
        path.join(appPath, 'Contents', 'MacOS', 'orca-keyboard-layout')
      ],
      { stdio: 'inherit' }
    )
  } catch (error) {
    console.warn(
      `[orca-dev] keyboard-layout helper build failed (shifted Option composition stays conservative): ${errorMessage(error)}`
    )
  }

  // Why: the plist edits above (and the copy itself) break the bundle's
  // ad-hoc seal, and macOS refuses Notification Center registration for
  // invalidly-signed apps — every dev notification fails with UNErrorDomain
  // error 1 and the app never appears in System Settings > Notifications.
  // An ad-hoc re-sign restores delivery, the permission prompt, and the
  // notification-settings deep link for dev builds. Non-fatal: a signing
  // failure should not block `pnpm dev`.
  let signed = true
  try {
    execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', appPath])
  } catch (error) {
    signed = false
    console.warn(
      `[orca-dev] ad-hoc codesign failed (dev notifications will not deliver): ${errorMessage(error)}`
    )
  }
  // Why only when signed: the marker is what marks this bundle reusable. Writing it after a failed
  // sign cached an unsigned bundle permanently -- the warning above scrolled past once and every
  // later launch silently reused it, losing notification delivery and the stable cdhash that keeps
  // safeStorage from re-prompting. Leaving it unwritten costs a re-copy per launch until signing
  // works, and still does not block `pnpm dev`.
  if (signed) {
    writeFileSync(markerPath, expectedMarker, 'utf8')
  }
  pruneStaleDevBundles(distDir)
  process.env.ELECTRON_EXEC_PATH = executablePath
}

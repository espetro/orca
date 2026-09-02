import { constants } from 'node:fs'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { isDeepStrictEqual } from 'node:util'

import {
  collectGitPackageFiles,
  collectGitSkillTreeEntries,
  describeFile,
  gitTreeSha,
  packageDigest,
  readGitBlobs,
  sortManifestFiles
} from './skill-bundle-git-ops.ts'

// Why: the three artifacts version independently — bumping one shape must not
// rewrite the others or bypass the registry's schema-gated append-only guard.
const CURRENT_MANIFEST_SCHEMA_VERSION = 2
const SNAPSHOT_REGISTRY_SCHEMA_VERSION = 1
const RELEASE_MAPPING_SCHEMA_VERSION = 1
const SCRIPT_DIR = import.meta.dirname
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..')
const SKILLS_ROOT = path.join(REPO_ROOT, 'skills')
const OUTPUT_ROOT = path.join(REPO_ROOT, 'resources', 'skills')
const CURRENT_MANIFEST_PATH = path.join(OUTPUT_ROOT, 'current-manifest.json')
const SNAPSHOT_REGISTRY_PATH = path.join(OUTPUT_ROOT, 'snapshot-registry.json')
const RELEASE_MAPPING_PATH = path.join(OUTPUT_ROOT, 'release-mapping.json')
const CONTENT_ADDRESSED_PATHS = [CURRENT_MANIFEST_PATH, SNAPSHOT_REGISTRY_PATH]
const ALL_ARTIFACT_PATHS = [...CONTENT_ADDRESSED_PATHS, RELEASE_MAPPING_PATH]

type SnapshotRegistry = { schemaVersion: number; skills: Record<string, unknown[]> }
type ReleaseMapping = {
  schemaVersion: number
  releases: { appVersion: string; skills: Record<string, number> }[]
}

// Why: kept in step with isOsMetadataSkillEntryName in src/main/skills/skill-package-identity.ts.
// The scanner ignores these because the OS writes them into a live install; the generator
// ignores them so a stray one in a working tree cannot be committed into the manifest as
// content no user could ever match. Skipped rather than rejected: the file is not the
// developer's doing, so failing the build over it would be hostile.
const OS_METADATA_FILE_NAMES = new Set(['.ds_store', 'thumbs.db', 'ehthumbs.db', 'desktop.ini'])

function isOsMetadataSkillEntryName(name: string) {
  const folded = name.toLocaleLowerCase('en-US')
  return OS_METADATA_FILE_NAMES.has(folded) || folded.startsWith('._')
}

function assertSafeRelativePath(relativePath: string) {
  if (
    path.isAbsolute(relativePath) ||
    relativePath === '..' ||
    relativePath.startsWith(`..${path.sep}`)
  ) {
    throw new Error(`Unsafe skill package path: ${relativePath}`)
  }
}

async function collectPackageFiles(packageRoot: string) {
  const { lstat, readdir: readDir } = await import('node:fs/promises')
  const { compareCodeUnits } = await import('./skill-bundle-git-ops.ts')
  const files: ReturnType<typeof describeFile>[] = []
  const caseFoldedPaths = new Map<string, string>()

  async function visit(directory: string) {
    const entries = await readDir(directory, { withFileTypes: true })
    entries.sort((left, right) => compareCodeUnits(left.name, right.name))
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name)
      const fileStat = await lstat(absolutePath)
      if (isOsMetadataSkillEntryName(entry.name) && fileStat.isFile()) {
        continue
      }
      const relativePath = path.relative(packageRoot, absolutePath)
      assertSafeRelativePath(relativePath)
      const manifestPath = relativePath.split(path.sep).join('/')
      const foldedPath = manifestPath.toLocaleLowerCase('en-US')
      const collision = caseFoldedPaths.get(foldedPath)
      if (collision && collision !== manifestPath) {
        throw new Error(`Case-colliding skill paths: ${collision} and ${manifestPath}`)
      }
      caseFoldedPaths.set(foldedPath, manifestPath)
      if (fileStat.isSymbolicLink()) {
        throw new Error(`Symlink is not allowed in a shipped skill: ${manifestPath}`)
      }
      if (fileStat.isDirectory()) {
        await visit(absolutePath)
        continue
      }
      if (!fileStat.isFile()) {
        throw new Error(`Special file is not allowed in a shipped skill: ${manifestPath}`)
      }
      if ((fileStat.mode & 0o111) !== 0) {
        throw new Error(`Executable file is not allowed in a shipped skill: ${manifestPath}`)
      }
      const fileContent = await readFile(absolutePath)
      files.push(describeFile(manifestPath, fileContent, false))
    }
  }

  await visit(packageRoot)
  return sortManifestFiles(files)
}

function compareCodeUnits(left: string, right: string) {
  return left === right ? 0 : left < right ? -1 : 1
}

function releaseTags() {
  const { execFileSync } = require('node:child_process')
  return execFileSync(
    'git',
    ['for-each-ref', '--sort=creatordate', '--format=%(refname:short)', 'refs/tags/v*'],
    { encoding: 'utf8' }
  )
    .split('\n')
    .filter((tag: string) => /^v\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.-]+)?$/.test(tag))
}

function skillsTreeShasAtRefs(refs: string[]) {
  const { execFileSync } = require('node:child_process')
  if (refs.length === 0) {
    return []
  }
  const output = execFileSync('git', ['cat-file', '--batch-check=%(objectname) %(objecttype)'], {
    input: `${refs.map((ref) => `${ref}:skills`).join('\n')}\n`,
    encoding: 'utf8'
  })
  const lines = output.trimEnd().split('\n')
  if (lines.length !== refs.length) {
    throw new Error(`Expected ${refs.length} skills tree identities, received ${lines.length}`)
  }
  return lines.map((line: string, index: number) => {
    if (line.endsWith(' missing')) {
      return null
    }
    const match = /^([a-f0-9]+) tree$/.exec(line)
    if (!match) {
      throw new Error(`Unexpected skills tree identity at ${refs[index]}: ${line}`)
    }
    return match[1]
  })
}

function buildReleasedHistory() {
  const registry: { schemaVersion: number; skills: Record<string, unknown[]> } = {
    schemaVersion: SNAPSHOT_REGISTRY_SCHEMA_VERSION,
    skills: {}
  }
  const mapping: {
    schemaVersion: number
    releases: { appVersion: string; skills: Record<string, number> }[]
  } = { schemaVersion: RELEASE_MAPPING_SCHEMA_VERSION, releases: [] }
  const tags: string[] = releaseTags()
  const treeShas: (string | null)[] = skillsTreeShasAtRefs(tags)
  const distinctTreeShas: string[] = [
    ...new Set(treeShas.filter((sha): sha is string => sha !== null))
  ]
  const packagesByTree = new Map(
    distinctTreeShas.map((treeSha) => [treeSha, collectGitSkillTreeEntries(treeSha)])
  )
  const blobs = readGitBlobs(
    [...packagesByTree.values()].flatMap((packages) =>
      [...packages.values()].flatMap((entries) => entries.map((entry) => entry.objectSha))
    )
  )
  let previousSkillsTreeSha: string | null = null
  for (const [index, tag] of tags.entries()) {
    const skillsTreeSha = treeShas[index]
    if (!skillsTreeSha || skillsTreeSha === previousSkillsTreeSha) {
      continue
    }
    previousSkillsTreeSha = skillsTreeSha
    const revisions: Record<string, number> = {}
    const packages = packagesByTree.get(skillsTreeSha)
    if (!packages) {
      throw new Error(`Missing released skill tree ${skillsTreeSha} at ${tag}`)
    }
    for (const name of [...packages.keys()].sort(compareCodeUnits)) {
      const entries = packages.get(name)!
      const filesWithGitHashes = collectGitPackageFiles(skillsTreeSha, name, entries, blobs)
      if (!filesWithGitHashes.some((file) => file.path === 'SKILL.md')) {
        continue
      }
      const digest = packageDigest(filesWithGitHashes)
      const snapshots: {
        releaseRevision: number
        packageDigest: string
        gitTreeSha: string
        files: unknown[]
      }[] = (registry.skills[name] ?? []) as {
        releaseRevision: number
        packageDigest: string
        gitTreeSha: string
        files: unknown[]
      }[]
      const latest = snapshots.at(-1)
      if (!latest || latest.packageDigest !== digest) {
        const files = filesWithGitHashes.map(({ gitBlobSha: _gitBlobSha, ...file }) => file)
        snapshots.push({
          releaseRevision: (latest?.releaseRevision ?? 0) + 1,
          packageDigest: digest,
          gitTreeSha: gitTreeSha(filesWithGitHashes),
          files
        })
        registry.skills[name] = snapshots
      }
      revisions[name] = snapshots.at(-1)!.releaseRevision
    }
    if (Object.keys(revisions).length > 0) {
      mapping.releases.push({ appVersion: tag.slice(1), skills: revisions })
    }
  }
  return { registry, mapping }
}

function releasedHistoryFromCommitted(committedRegistry: unknown, committedMapping: unknown) {
  const registry: { schemaVersion: number; skills: Record<string, unknown[]> } = {
    schemaVersion: SNAPSHOT_REGISTRY_SCHEMA_VERSION,
    skills: {}
  }
  const releasedSnapshotCounts: Record<string, number> = {}
  const mapping =
    committedMapping &&
    (committedMapping as { schemaVersion: number }).schemaVersion === RELEASE_MAPPING_SCHEMA_VERSION
      ? structuredClone(committedMapping as ReleaseMapping)
      : {
          schemaVersion: RELEASE_MAPPING_SCHEMA_VERSION,
          releases: [] as { appVersion: string; skills: Record<string, number> }[]
        }
  if (
    committedRegistry &&
    (committedRegistry as { schemaVersion: number }).schemaVersion ===
      SNAPSHOT_REGISTRY_SCHEMA_VERSION
  ) {
    const mappedCounts = releasedSnapshotCountsFromMapping(mapping)
    for (const [name, snapshots] of Object.entries(
      (committedRegistry as { skills: unknown }).skills ?? {}
    ) as [string, unknown[]][]) {
      const releasedCount = mappedCounts?.[name] ?? Math.max(0, snapshots.length - 1)
      registry.skills[name] = snapshots.slice(0, releasedCount) as unknown[]
      releasedSnapshotCounts[name] = releasedCount
    }
  }
  return { registry, mapping, releasedSnapshotCounts }
}

function releasedHistoryFromTags() {
  const { registry, mapping } = buildReleasedHistory()
  const releasedSnapshotCounts = Object.fromEntries(
    Object.entries(registry.skills).map(([name, snapshots]: [string, unknown[]]) => [
      name,
      snapshots.length
    ])
  ) as Record<string, number>
  return { registry, mapping, releasedSnapshotCounts }
}

function appendReleaseRow(
  artifacts: {
    currentManifest: { skills: { name: string; releaseRevision: number }[] }
    releaseMapping: { releases: { appVersion: string; skills: Record<string, number> }[] }
  },
  version: string
) {
  const appVersion = version.startsWith('v') ? version.slice(1) : version
  const currentRevisions: Record<string, number> = {}
  for (const skill of artifacts.currentManifest.skills) {
    currentRevisions[skill.name] = skill.releaseRevision
  }
  const releases = artifacts.releaseMapping.releases
  const last = releases.at(-1)
  if (last && isDeepStrictEqual(last.skills, currentRevisions)) {
    return
  }
  if (last?.appVersion === appVersion) {
    releases[releases.length - 1] = { appVersion, skills: currentRevisions }
    return
  }
  if (releases.some((release) => release.appVersion === appVersion)) {
    throw new Error(`Release mapping already has a row for ${appVersion}.`)
  }
  releases.push({ appVersion, skills: currentRevisions })
}

async function buildArtifacts(releasedHistory: {
  registry: { schemaVersion: number; skills: Record<string, unknown[]> }
  mapping: {
    schemaVersion: number
    releases: { appVersion: string; skills: Record<string, number> }[]
  }
  releasedSnapshotCounts: Record<string, number>
}) {
  const { registry, mapping, releasedSnapshotCounts } = releasedHistory
  const { readdir: readDir } = await import('node:fs/promises')
  const { compareCodeUnits } = await import('./skill-bundle-git-ops.ts')
  const skillDirectories = (await readDir(SKILLS_ROOT, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort(compareCodeUnits)
  const currentSkills: {
    name: string
    sourcePath: string
    releaseRevision: number
    packageDigest: string
    gitTreeSha: string
    files: unknown[]
  }[] = []
  for (const name of skillDirectories) {
    const filesWithGitHashes = await collectPackageFiles(path.join(SKILLS_ROOT, name))
    if (!filesWithGitHashes.some((file) => file.path === 'SKILL.md')) {
      throw new Error(`Skill package ${name} has no top-level SKILL.md`)
    }
    const digest = packageDigest(filesWithGitHashes)
    const snapshots: {
      releaseRevision: number
      packageDigest: string
      gitTreeSha: string
      files: unknown[]
    }[] = (registry.skills[name] ?? []) as {
      releaseRevision: number
      packageDigest: string
      gitTreeSha: string
      files: unknown[]
    }[]
    const latest = snapshots.at(-1)
    let snapshot = latest
    if (!latest || latest.packageDigest !== digest) {
      const files = filesWithGitHashes.map(({ gitBlobSha: _gitBlobSha, ...file }) => file)
      snapshot = {
        releaseRevision: (latest?.releaseRevision ?? 0) + 1,
        packageDigest: digest,
        gitTreeSha: gitTreeSha(filesWithGitHashes),
        files
      }
      snapshots.push(snapshot)
      registry.skills[name] = snapshots
    }
    currentSkills.push({ name, sourcePath: `skills/${name}`, ...snapshot! })
  }
  return {
    currentManifest: { schemaVersion: CURRENT_MANIFEST_SCHEMA_VERSION, skills: currentSkills },
    snapshotRegistry: registry,
    releaseMapping: mapping,
    releasedSnapshotCounts
  }
}

function releasedSnapshotCountsFromMapping(
  releaseMapping: {
    schemaVersion: number
    releases: { appVersion: string; skills: Record<string, number> }[]
  } | null
) {
  if (!releaseMapping || releaseMapping.schemaVersion !== RELEASE_MAPPING_SCHEMA_VERSION) {
    return null
  }
  const counts: Record<string, number> = {}
  for (const release of releaseMapping.releases ?? []) {
    for (const [name, revision] of Object.entries(release.skills ?? {})) {
      counts[name] = Math.max(counts[name] ?? 0, revision)
    }
  }
  return counts
}

function assertReleasedHistoryPreserved(
  committedRegistry: unknown,
  artifacts: {
    releasedSnapshotCounts: Record<string, number>
    snapshotRegistry: { skills: Record<string, unknown[]> }
  },
  committedReleaseMapping: ReleaseMapping | null
) {
  if (
    !committedRegistry ||
    (committedRegistry as { schemaVersion: number }).schemaVersion !==
      SNAPSHOT_REGISTRY_SCHEMA_VERSION
  ) {
    return
  }
  const committedReleasedCounts = releasedSnapshotCountsFromMapping(committedReleaseMapping)
  for (const [name, committedSnapshots] of Object.entries(
    (committedRegistry as { skills: unknown }).skills ?? {}
  ) as [string, unknown[]][]) {
    const releasedCount = artifacts.releasedSnapshotCounts[name] ?? 0
    const regenerated = artifacts.snapshotRegistry.skills[name] ?? []
    const minimumReleasedCount =
      committedReleasedCounts?.[name] ?? Math.max(0, committedSnapshots.length - 1)
    if (releasedCount < minimumReleasedCount) {
      throw new Error(
        `Released snapshot history is incomplete for ${name}. Fetch all release tags before regenerating skill artifacts.`
      )
    }
    const protectedCount = committedReleasedCounts
      ? (committedReleasedCounts[name] ?? 0)
      : Math.min(committedSnapshots.length, releasedCount)
    for (let index = 0; index < protectedCount; index += 1) {
      const committed = committedSnapshots[index] as { releaseRevision: number }
      const rebuilt = regenerated[index]
      if (!rebuilt || !isDeepStrictEqual(rebuilt, committed)) {
        throw new Error(
          `Released snapshot history changed for ${name} at revision ${committed.releaseRevision}. Released snapshots are append-only; a deliberate identity migration must update this check.`
        )
      }
    }
  }
}

async function readCommittedRegistry(): Promise<SnapshotRegistry | null> {
  try {
    return JSON.parse(await readFile(SNAPSHOT_REGISTRY_PATH, 'utf8')) as SnapshotRegistry
  } catch {
    return null
  }
}

async function readCommittedReleaseMapping(): Promise<ReleaseMapping | null> {
  try {
    return JSON.parse(await readFile(RELEASE_MAPPING_PATH, 'utf8')) as ReleaseMapping
  } catch {
    return null
  }
}

function serialized(value: unknown) {
  return `${JSON.stringify(value, null, 2)}\n`
}

async function writeArtifacts(
  artifacts: { currentManifest: unknown; snapshotRegistry: unknown; releaseMapping: unknown },
  paths = ALL_ARTIFACT_PATHS
) {
  const values = new Map([
    [CURRENT_MANIFEST_PATH, artifacts.currentManifest],
    [SNAPSHOT_REGISTRY_PATH, artifacts.snapshotRegistry],
    [RELEASE_MAPPING_PATH, artifacts.releaseMapping]
  ])
  await mkdir(OUTPUT_ROOT, { recursive: true })
  await Promise.all(paths.map((filePath) => writeFile(filePath, serialized(values.get(filePath)))))
}

function isToleratedReleaseMappingPrefix(
  committedText: string,
  artifacts: {
    releaseMapping: {
      schemaVersion: number
      releases: { appVersion: string; skills: Record<string, number> }[]
    }
    currentManifest: { skills: { name: string; releaseRevision: number }[] }
  }
) {
  let committed: { releases?: { appVersion: string; skills: Record<string, number> }[] }
  try {
    committed = JSON.parse(committedText)
  } catch {
    return false
  }
  const derived = artifacts.releaseMapping
  const committedCount = Array.isArray(committed?.releases) ? committed.releases.length : -1
  if (committedCount < 0 || committedCount >= derived.releases.length) {
    return false
  }
  const prefix = {
    schemaVersion: derived.schemaVersion,
    releases: derived.releases.slice(0, committedCount)
  }
  if (committedText !== serialized(prefix)) {
    return false
  }
  const currentRevisions = Object.fromEntries(
    artifacts.currentManifest.skills.map((skill) => [skill.name, skill.releaseRevision])
  )
  return derived.releases
    .slice(committedCount)
    .every((release) => isDeepStrictEqual(release.skills, currentRevisions))
}

async function verifyArtifacts(
  artifacts: {
    snapshotRegistry: unknown
    releaseMapping: ReleaseMapping
    currentManifest: { skills: { name: string; releaseRevision: number }[] }
  },
  paths = ALL_ARTIFACT_PATHS
) {
  type ArtifactExpectation = [
    path: string,
    value: unknown,
    tolerated: ((text: string, arts: unknown) => boolean) | null
  ]
  const expected = (
    [
      [CURRENT_MANIFEST_PATH, artifacts.currentManifest, null],
      [SNAPSHOT_REGISTRY_PATH, artifacts.snapshotRegistry, null],
      [RELEASE_MAPPING_PATH, artifacts.releaseMapping, isToleratedReleaseMappingPrefix]
    ] as ArtifactExpectation[]
  ).filter(([filePath]) => paths.includes(filePath))
  const stale: string[] = []
  for (const [filePath, value, tolerated] of expected) {
    try {
      await access(filePath, constants.R_OK)
      const committedText = await readFile(filePath, 'utf8')
      if (committedText !== serialized(value) && !tolerated?.(committedText, artifacts)) {
        stale.push(filePath)
      }
    } catch {
      stale.push(filePath)
    }
  }
  if (stale.length > 0) {
    throw new Error(
      `Generated skill artifacts are stale:\n${stale.map((filePath) => path.relative(REPO_ROOT, filePath)).join('\n')}\nRun pnpm generate:skill-bundle-manifest.`
    )
  }
}

async function main() {
  const argv = process.argv.slice(2)
  const rebuildFromTags = argv.includes('--rebuild-from-tags')
  const releaseIndex = argv.indexOf('--release')
  const releaseVersion = releaseIndex !== -1 ? argv[releaseIndex + 1] : null
  if (releaseIndex !== -1 && !releaseVersion) {
    throw new Error('--release requires a version argument, e.g. --release 1.4.160')
  }

  const committedRegistry = await readCommittedRegistry()
  const committedMapping = await readCommittedReleaseMapping()
  const releasedHistory = rebuildFromTags
    ? releasedHistoryFromTags()
    : releasedHistoryFromCommitted(committedRegistry, committedMapping)
  const artifacts = await buildArtifacts(releasedHistory)

  if (releaseVersion) {
    await verifyArtifacts(artifacts, CONTENT_ADDRESSED_PATHS)
    appendReleaseRow(artifacts, releaseVersion)
  }

  assertReleasedHistoryPreserved(committedRegistry, artifacts, committedMapping)

  const shouldWrite = releaseVersion !== null || argv.includes('--write')
  const writePaths = releaseVersion ? [RELEASE_MAPPING_PATH] : ALL_ARTIFACT_PATHS
  await (shouldWrite ? writeArtifacts(artifacts, writePaths) : verifyArtifacts(artifacts))
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}

export {
  appendReleaseRow,
  assertReleasedHistoryPreserved,
  buildArtifacts,
  buildReleasedHistory,
  collectPackageFiles,
  describeFile,
  gitTreeSha,
  isToleratedReleaseMappingPrefix,
  packageDigest,
  readGitBlobs,
  releasedHistoryFromCommitted,
  sortManifestFiles,
  verifyArtifacts,
  writeArtifacts
}

export { classifyFile, normalizeText } from './skill-bundle-git-ops.ts'

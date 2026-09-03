// Shared constants, types, and pure helpers for the runtime file command collaborators.
import type {
  RuntimeFilePreviewResult,
  RuntimeNativeChatFileContext
} from '../../shared/runtime-types'
import type { GitWorktreeInfo, Worktree } from '../../shared/worktree/types'
import {
  REMOTE_RPC_MAX_CONTENT_BYTES,
  remoteRpcResultExceedsContentBudget
} from '../../shared/remote-rpc-content-budget'
import type { FileReadLimits, IFilesystemProvider } from '../providers/types'
import { FileReadCapExceededError } from '../ssh/ssh-filesystem-stream-reader'
import { toSshExecutionHostId, type ExecutionHostId } from '../../shared/execution-host'

export const MOBILE_FILE_LIST_LIMIT = 5000
// Legacy SSH relays cannot enforce a byte budget; 32 max-length paths stay under one 4 MiB frame.
export const QUICK_OPEN_LEGACY_REMOTE_RESULT_LIMIT = 32
export const MOBILE_FILE_PATH_SEARCH_CACHE_LIMIT = 20_000
export const MOBILE_FILE_PATH_SEARCH_CACHE_ENTRIES = 8
export const MOBILE_FILE_PATH_SEARCH_CACHE_TTL_MS = 30_000
export const MOBILE_FILE_READ_MAX_BYTES = 512 * 1024
export const TERMINAL_FILE_GRANT_TTL_MS = 10 * 60 * 1000

export const LOCAL_PREVIEWABLE_BINARY_MAX_BYTES = 10 * 1024 * 1024
const PREVIEWABLE_BINARY_EMPTY_RESULT_BYTES = Buffer.byteLength(
  JSON.stringify({
    content: '',
    isBinary: true,
    isImage: true,
    mimeType: 'application/octet-stream'
  }),
  'utf8'
)
const PREVIEW_CONTENT_FIELDS = ['content'] as const

export function previewableBinaryByteLimit(maxContentBytes: number): number {
  const base64Bytes = Math.max(0, maxContentBytes - PREVIEWABLE_BINARY_EMPTY_RESULT_BYTES)
  return Math.floor(base64Bytes / 4) * 3
}

// Why: the stream reader aborts an over-cap read with a raw protocol message; clients key on
// `file_too_large`, so translate it here rather than surfacing internal stream wording.
export async function readPreviewFileWithinCap(
  provider: IFilesystemProvider,
  filePath: string,
  limits: FileReadLimits
): Promise<RuntimeFilePreviewResult> {
  try {
    return await provider.readFile(filePath, limits)
  } catch (error) {
    if (error instanceof FileReadCapExceededError) {
      throw new Error('file_too_large')
    }
    throw error
  }
}

export function assertPreviewWithinTransportBudget(
  result: RuntimeFilePreviewResult,
  maxContentBytes: number | undefined
): RuntimeFilePreviewResult {
  if (
    maxContentBytes !== undefined &&
    remoteRpcResultExceedsContentBudget(result, maxContentBytes, PREVIEW_CONTENT_FIELDS)
  ) {
    throw new Error('file_too_large')
  }
  return result
}

// Why: previews are reachable only over RPC and base64 inflates them 4/3, so derive the cap from the
// transport ceiling — a hardcoded 10 MiB serializes past the outbound envelope and kills the socket.
export const RUNTIME_PREVIEWABLE_BINARY_MAX_BYTES = previewableBinaryByteLimit(
  REMOTE_RPC_MAX_CONTENT_BYTES
)

const MOBILE_BINARY_EXTENSIONS = new Set([
  '.avif',
  '.bmp',
  '.gif',
  '.heic',
  '.ico',
  '.jpeg',
  '.jpg',
  '.mov',
  '.mp3',
  '.mp4',
  '.pdf',
  '.png',
  '.webp',
  '.zip'
])
// Mirror of mobile classifyMobileArtifact's image set; SVG/PDF excluded because RN <Image> can't decode those data URIs.
const MOBILE_PREVIEWABLE_IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.ico'
])

export type RuntimeFileStatLike = {
  size?: number
  dev?: number
  ino?: number
  nlink?: number
  mtime?: number | Date
  mtimeMs?: number
  isDirectory?: () => boolean
}

export type TerminalFileGrant = {
  id: string
  worktreeId: string
  absolutePath: string
  provider: 'local' | 'ssh'
  connectionId?: string
  clientId?: string
  expiresAt: number
  statIdentity: string | null
  readOnly: boolean
  provenance: 'terminal-output' | 'native-chat'
  expiryTimer?: ReturnType<typeof setTimeout>
}

export function isMobilePreviewableImagePath(relativePath: string): boolean {
  const basename = basenameFromRelativePath(relativePath)
  const dotIndex = basename.lastIndexOf('.')
  if (dotIndex <= 0) {
    return false
  }
  return MOBILE_PREVIEWABLE_IMAGE_EXTENSIONS.has(basename.slice(dotIndex).toLowerCase())
}

export const RUNTIME_PREVIEWABLE_BINARY_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf'
}


export function isSafeMobileRelativePath(relativePath: string): boolean {
  if (!relativePath || relativePath.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(relativePath)) {
    return false
  }
  const parts = relativePath.replace(/\\/g, '/').split('/')
  return parts.every((part) => part !== '' && part !== '.' && part !== '..')
}

export function isMobileMarkdownPath(relativePath: string): boolean {
  return /\.(md|mdx|markdown)$/i.test(relativePath)
}

export function isMobileBinaryPath(relativePath: string): boolean {
  const basename = basenameFromRelativePath(relativePath)
  const dotIndex = basename.lastIndexOf('.')
  if (dotIndex <= 0) {
    return false
  }
  return MOBILE_BINARY_EXTENSIONS.has(basename.slice(dotIndex).toLowerCase())
}

export function basenameFromRelativePath(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/')
  return normalized.slice(normalized.lastIndexOf('/') + 1)
}

export function isBinaryBuffer(buffer: Buffer): boolean {
  const len = Math.min(buffer.length, 8192)
  for (let i = 0; i < len; i += 1) {
    if (buffer[i] === 0) {
      return true
    }
  }
  return false
}

export async function readLocalTerminalArtifactFileFromHandle(
  handle: FileHandle,
  grant: TerminalFileGrant
): Promise<string> {
  const fileStat = await handle.stat()
  if (fileStat.isDirectory()) {
    throw new Error('Cannot read a directory')
  }
  if (fileStat.size > MOBILE_FILE_READ_MAX_BYTES) {
    throw new Error('file_too_large')
  }
  assertTerminalFileGrantFresh(grant, fileStat)
  const buffer = await readFileHandleBufferBounded(handle, MOBILE_FILE_READ_MAX_BYTES + 1)
  if (isBinaryBuffer(buffer)) {
    throw new Error('binary_file')
  }
  return buffer.toString('utf8')
}

export async function readLocalTerminalArtifactPreviewFromHandle(
  handle: FileHandle,
  grant: TerminalFileGrant,
  maxContentBytes: number | undefined
): Promise<RuntimeFilePreviewResult> {
  const fileStats = await handle.stat()
  if (fileStats.isDirectory()) {
    throw new Error('Cannot preview a directory')
  }
  assertTerminalFileGrantFresh(grant, fileStats)
  const mimeType = RUNTIME_PREVIEWABLE_BINARY_MIME_TYPES[extname(grant.absolutePath).toLowerCase()]
  if (mimeType) {
    const binaryMaxBytes =
      maxContentBytes === undefined
        ? LOCAL_PREVIEWABLE_BINARY_MAX_BYTES
        : previewableBinaryByteLimit(maxContentBytes)
    if (fileStats.size > binaryMaxBytes) {
      throw new Error('file_too_large')
    }
    const buffer = await readFileHandleBufferBounded(handle, binaryMaxBytes + 1)
    if (buffer.byteLength > binaryMaxBytes) {
      throw new Error('file_too_large')
    }
    return {
      content: buffer.toString('base64'),
      isBinary: true,
      isImage: true,
      mimeType
    }
  }

  const content = await readLocalTerminalArtifactFileFromHandle(handle, grant)
  return { content, isBinary: false }
}

export async function assertLocalTerminalArtifactPathStillCanonical(filePath: string): Promise<void> {
  const currentPath = await canonicalPathForArtifactComparison(filePath)
  if (currentPath !== filePath) {
    throw new Error('terminal_file_grant_stale')
  }
}

export async function openLocalTerminalArtifactGrant(
  grant: TerminalFileGrant,
  flags: number
): Promise<FileHandle> {
  await assertLocalTerminalArtifactPathStillCanonical(grant.absolutePath)
  try {
    return await open(grant.absolutePath, flags | OPEN_NOFOLLOW)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new Error('terminal_file_grant_stale')
    }
    throw error
  }
}

export function resolveTerminalAbsolutePath(args: {
  base: string
  expanded: string
  worktreePath: string
  connectionId?: string
  terminalFileUriHostname?: string | null
}): string {
  const expanded = normalizeTerminalFileUriAuthorityPath(
    args.expanded,
    args.connectionId,
    args.terminalFileUriHostname,
    args.worktreePath
  )
  const absolutePath = isRuntimePathAbsolute(expanded)
    ? expanded
    : resolveRuntimePath(args.base, expanded)
  if (args.connectionId) {
    return normalizeLeadingSlashDrivePath(absolutePath, args.worktreePath)
  }
  const wsl = parseWslPath(args.worktreePath)
  if (wsl && absolutePath.startsWith('/') && !absolutePath.startsWith('//')) {
    return toWindowsWslPath(absolutePath, wsl.distro)
  }
  return absolutePath
}

export function normalizeTerminalFileUriAuthorityPath(
  pathText: string,
  connectionId?: string,
  terminalFileUriHostname?: string | null,
  worktreePath?: string
): string {
  if (!pathText.startsWith('//')) {
    return pathText
  }
  const match = /^\/\/([^/\\]+)([/\\].*)$/.exec(pathText)
  if (!match) {
    return pathText
  }
  const host = match[1]!.toLowerCase()
  if (terminalFileUriHostname && host === terminalFileUriHostname.toLowerCase() && connectionId) {
    return normalizeLeadingSlashDrivePath(match[2]!, worktreePath)
  }
  if (isLoopbackFileUriHostname(host) && (connectionId || process.platform !== 'win32')) {
    return normalizeLeadingSlashDrivePath(match[2]!, worktreePath)
  }
  // Why: without a verified host match, stripping the file-URI authority could open a same-path artifact on the wrong machine.
  return pathText
}

export function provenancePathCandidate(pathText: string, absolutePath: string): string {
  return pathText.startsWith('//') ? pathText : absolutePath
}

export function isLoopbackFileUriHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
}

export function normalizeLeadingSlashDrivePath(pathText: string, worktreePath?: string): string {
  return worktreePath &&
    isWindowsAbsolutePathLike(worktreePath) &&
    /^\/[A-Za-z]:[\\/]/.test(pathText)
    ? pathText.slice(1)
    : pathText
}

export async function resolveAllowedLocalTerminalArtifactPath(
  absolutePath: string,
  worktreePath: string
): Promise<string | null> {
  const roots = await localTerminalArtifactRoots(worktreePath)
  const canonicalPath = await canonicalPathForArtifactComparison(absolutePath)
  return roots.some((root) => isPathInsideOrEqual(root, canonicalPath)) ? canonicalPath : null
}

export async function localTerminalArtifactRoots(worktreePath: string): Promise<string[]> {
  const roots = new Set<string>([tmpdir()])
  if (process.platform !== 'win32') {
    roots.add('/tmp')
    roots.add('/private/tmp')
  }
  const wsl = parseWslPath(worktreePath)
  if (wsl) {
    roots.add(toWindowsWslPath('/tmp', wsl.distro))
  }
  const canonicalRoots = await Promise.all(
    Array.from(roots).map((root) => canonicalPathForArtifactComparison(root))
  )
  return Array.from(new Set([...roots, ...canonicalRoots]))
}

export async function canonicalPathForArtifactComparison(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    return path
  }
}

export async function readFileHandleBufferBounded(handle: FileHandle, limit: number): Promise<Buffer> {
  const buffer = Buffer.alloc(limit)
  const { bytesRead } = await handle.read(buffer, 0, limit, 0)
  return buffer.subarray(0, bytesRead)
}

export function terminalFileStatIdentity(stats: RuntimeFileStatLike): string | null {
  const dev = typeof stats.dev === 'number' ? stats.dev : null
  const ino = typeof stats.ino === 'number' ? stats.ino : null
  const nlink = typeof stats.nlink === 'number' ? stats.nlink : null
  const size = typeof stats.size === 'number' ? stats.size : null
  const mtimeMs =
    typeof stats.mtimeMs === 'number'
      ? stats.mtimeMs
      : typeof stats.mtime === 'number'
        ? stats.mtime
        : null
  if (dev !== null && ino !== null && size !== null && mtimeMs !== null) {
    return `${dev}:${ino}:${nlink ?? 'unknown'}:${size}:${mtimeMs}`
  }
  if (size !== null && mtimeMs !== null) {
    return `${size}:${mtimeMs}`
  }
  return null
}

export function assertTerminalFileGrantFresh(grant: TerminalFileGrant, stats: RuntimeFileStatLike): void {
  assertTerminalArtifactNotHardLinked(stats)
  const nextIdentity = terminalFileStatIdentity(stats)
  if (grant.statIdentity !== null && nextIdentity !== null && grant.statIdentity !== nextIdentity) {
    throw new Error('terminal_file_grant_stale')
  }
}

export function assertTerminalArtifactNotHardLinked(stats: RuntimeFileStatLike): void {
  if (isTerminalArtifactHardLinked(stats)) {
    throw new Error('terminal_file_grant_stale')
  }
}

export function isTerminalArtifactHardLinked(stats: RuntimeFileStatLike): boolean {
  return typeof stats.nlink === 'number' && stats.nlink > 1
}

export function truncateMobileFilePreview(content: string): {
  content: string
  truncated: boolean
  byteLength: number
} {
  const buffer = Buffer.from(content, 'utf8')
  if (buffer.byteLength <= MOBILE_FILE_READ_MAX_BYTES) {
    return { content, truncated: false, byteLength: buffer.byteLength }
  }
  return {
    content: buffer.subarray(0, MOBILE_FILE_READ_MAX_BYTES).toString('utf8'),
    truncated: true,
    byteLength: buffer.byteLength
  }
}

export type ResolvedRuntimeFileWorktree = Worktree & { git: GitWorktreeInfo }
export type ResolvedRuntimeFileTarget = {
  worktree: ResolvedRuntimeFileWorktree
  connectionId?: string
}

export function getRuntimeFileTargetExecutionHostId(
  target: ResolvedRuntimeFileTarget
): ExecutionHostId {
  return (
    target.worktree.hostId ??
    (target.connectionId ? toSshExecutionHostId(target.connectionId) : 'local')
  )
}

export type RuntimeFileCommandHost = {
  getRuntimeId(): string
  requireStore(): Store
  resolveWorktreeSelector(selector: string): Promise<ResolvedRuntimeFileWorktree>
  resolveRuntimeFileTarget(selector: string): Promise<ResolvedRuntimeFileTarget>
  resolveKnownWorkspaceFileTarget?(
    absolutePath: string,
    executionHostId: ExecutionHostId
  ): Promise<(ResolvedRuntimeFileTarget & { relativePath: string }) | null>
  resolveTerminalCwd?(terminalHandle: string): string | null | Promise<string | null>
  resolveTerminalContext?(
    terminalHandle: string
  ): { worktreeId: string; connectionId: string | null } | null
  resolveTerminalFileUriHostname?(terminalHandle: string): string | null | Promise<string | null>
  hasRecentTerminalOutputPath?(
    terminalHandle: string,
    pathText: string,
    absolutePath: string
  ): boolean | Promise<boolean>
  hasRecentNativeChatOutputPath?(
    worktreeId: string,
    context: RuntimeNativeChatFileContext,
    pathText: string,
    absolutePath: string
  ): boolean | Promise<boolean>
  resolveRuntimeGitTarget(
    selector: string
  ): Promise<{ worktree: ResolvedRuntimeFileWorktree; connectionId?: string }>
  openFile(
    worktreeId: string,
    filePath: string,
    relativePath: string,
    runtimeEnvironmentId?: string | null
  ): void
  openDiff(
    worktreeId: string,
    filePath: string,
    relativePath: string,
    staged: boolean,
    runtimeEnvironmentId?: string | null
  ): void
}

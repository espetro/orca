// Pure Git operations for skill bundle manifest generation.
// Extracted to keep generate-skill-bundle-manifest.mts under the 600-line budget.

import { execFileSync } from 'node:child_process'

import type { DirNode } from './skill-bundle-manifest-types.mts'

export type SkillFileEntry = {
  path: string
  size: number
  executable: boolean
  classification: string
  exactSha256: string
  textNormalizedSha256: string | null
  identitySha256: string
  gitBlobSha: string
}

export type GitPackageFilesResult = {
  files: SkillFileEntry[]
  caseFoldedPaths: Map<string, string>
}

export function describeFile(manifestPath: string, bytes: Uint8Array, executable: boolean) {
  const classification = bytes.includes(0) ? 'binary' : 'text'
  const textNormalizedSha256 = classification === 'text' ? sha256(normalizeText(bytes)) : null
  const exactSha256 = sha256(bytes)
  return {
    path: manifestPath,
    size: bytes.length,
    executable,
    classification,
    exactSha256,
    textNormalizedSha256,
    identitySha256: classification === 'text' && !executable ? textNormalizedSha256! : exactSha256,
    gitBlobSha: gitObjectSha('blob', bytes).toString('hex')
  }
}

function sha256(bytes: Uint8Array | Buffer) {
  const { createHash } = require('node:crypto')
  return createHash('sha256').update(bytes).digest('hex')
}

function gitObjectSha(kind: string, bytes: Uint8Array | Buffer) {
  const { createHash } = require('node:crypto')
  return createHash('sha1').update(`${kind} ${bytes.length}\0`).update(bytes).digest()
}

function normalizeText(bytes: Uint8Array | Buffer) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  return Buffer.from(text.replace(/\r\n/g, '\n').replace(/\r/g, '\n'), 'utf8')
}

export function gitTreeSha(entries: { path: string; executable?: boolean }[]): string {
  const root: DirNode = { directories: new Map(), files: [] }
  for (const entry of entries) {
    const parts = entry.path.split('/')
    const filename = parts.pop()!
    let directory = root
    for (const part of parts) {
      let child = directory.directories.get(part)
      if (!child) {
        child = { directories: new Map<string, DirNode>(), files: [] }
        directory.directories.set(part, child)
      }
      directory = child
    }
    directory.files.push({ filename, ...entry })
  }

  function hashDirectory(directory: DirNode) {
    const children = [
      ...[...directory.directories].map(([name, child]) => ({
        mode: '40000',
        name,
        hash: hashDirectory(child)
      })),
      ...directory.files.map((file) => ({
        mode: file.executable ? '100755' : '100644',
        name: file.filename,
        hash: Buffer.from(file.gitBlobSha, 'hex')
      }))
    ].sort((left, right) => {
      const leftName = left.mode === '40000' ? `${left.name}/` : left.name
      const rightName = right.mode === '40000' ? `${right.name}/` : right.name
      return Buffer.from(leftName).compare(Buffer.from(rightName))
    })
    const body = Buffer.concat(
      children.map(({ mode, name, hash }) =>
        Buffer.concat([Buffer.from(`${mode} ${name}\0`, 'utf8'), hash])
      )
    )
    return gitObjectSha('tree', body)
  }

  return hashDirectory(root).toString('hex')
}

function compareCodeUnits(left: string, right: string) {
  return left === right ? 0 : left < right ? -1 : 1
}

export function compareManifestPaths(left: string, right: string) {
  const leftParts = left.split('/')
  const rightParts = right.split('/')
  const shared = Math.min(leftParts.length, rightParts.length)
  for (let index = 0; index < shared; index += 1) {
    const order = compareCodeUnits(leftParts[index], rightParts[index])
    if (order !== 0) {
      return order
    }
  }
  return leftParts.length - rightParts.length
}

export function sortManifestFiles(files: SkillFileEntry[]): SkillFileEntry[] {
  return [...files].sort((left, right) => compareManifestPaths(left.path, right.path))
}

export function packageDigest(files: SkillFileEntry[]) {
  return sha256(
    Buffer.from(
      JSON.stringify(
        files.map((file) => ({
          path: file.path,
          executable: file.executable,
          classification: file.classification,
          identitySha256: file.identitySha256
        }))
      ),
      'utf8'
    )
  )
}

export async function collectGitPackageFiles(
  treeSha: string,
  name: string,
  entries: { mode: string; type: string; objectSha: string; manifestPath: string }[],
  blobs: Map<string, Buffer>
) {
  const caseFoldedPaths = new Map<string, string>()
  const files = entries.map(({ mode, type, objectSha, manifestPath }) => {
    if (type !== 'blob' || (mode !== '100644' && mode !== '100755')) {
      throw new Error(`Unsupported shipped skill entry in ${treeSha}: ${name}/${manifestPath}`)
    }
    const foldedPath = manifestPath.toLocaleLowerCase('en-US')
    const collision = caseFoldedPaths.get(foldedPath)
    if (collision && collision !== manifestPath) {
      throw new Error(`Case-colliding skill paths in ${treeSha}: ${collision} and ${manifestPath}`)
    }
    caseFoldedPaths.set(foldedPath, manifestPath)
    const bytes = blobs.get(objectSha)
    if (!bytes) {
      throw new Error(`Missing git blob ${objectSha} for ${name}/${manifestPath}`)
    }
    return describeFile(manifestPath, bytes, mode === '100755')
  })
  return sortManifestFiles(files)
}

export function collectGitSkillTreeEntries(treeSha: string) {
  const output = execFileSync('git', ['ls-tree', '-r', '-z', treeSha])
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
  const packages = new Map<
    string,
    { mode: string; type: string; objectSha: string; manifestPath: string }[]
  >()
  for (const line of output) {
    const match = /^(\d+) (\w+) ([a-f0-9]+)\t(.+)$/.exec(line)
    if (!match) {
      throw new Error(`Unexpected git tree entry in ${treeSha}: ${line}`)
    }
    const [, mode, type, objectSha, sourcePath] = match
    const separator = sourcePath.indexOf('/')
    if (separator <= 0 || separator === sourcePath.length - 1) {
      throw new Error(`Unsupported shipped skill path in ${treeSha}: ${sourcePath}`)
    }
    const pkgName = sourcePath.slice(0, separator)
    const manifestPath = sourcePath.slice(separator + 1)
    const pkgEntries = packages.get(pkgName) ?? []
    pkgEntries.push({ mode, type, objectSha, manifestPath })
    packages.set(pkgName, pkgEntries)
  }
  return packages
}

export function readGitBlobs(objectShas: string[]) {
  const uniqueShas = [...new Set(objectShas)]
  if (uniqueShas.length === 0) {
    return new Map<string, Buffer>()
  }
  const output = execFileSync('git', ['cat-file', '--batch'], {
    input: `${uniqueShas.join('\n')}\n`,
    maxBuffer: 64 * 1024 * 1024
  })
  const blobs = new Map<string, Buffer>()
  let offset = 0
  for (const requestedSha of uniqueShas) {
    const headerEnd = output.indexOf(10, offset)
    if (headerEnd === -1) {
      throw new Error(`Missing git cat-file header for ${requestedSha}`)
    }
    const header = output.subarray(offset, headerEnd).toString('utf8')
    const match = /^([a-f0-9]+) blob (\d+)$/.exec(header)
    if (!match || match[1] !== requestedSha) {
      throw new Error(`Unexpected git cat-file header for ${requestedSha}: ${header}`)
    }
    const size = Number(match[2])
    const contentStart = headerEnd + 1
    const contentEnd = contentStart + size
    if (contentEnd >= output.length || output[contentEnd] !== 10) {
      throw new Error(`Truncated git blob for ${requestedSha}`)
    }
    blobs.set(requestedSha, Buffer.from(output.subarray(contentStart, contentEnd)))
    offset = contentEnd + 1
  }
  return blobs
}

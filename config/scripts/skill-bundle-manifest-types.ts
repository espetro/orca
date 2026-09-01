// Shared types for skill bundle manifest generation.
// Extracted to keep generate-skill-bundle-manifest.ts under the 600-line budget.

export type SkillTreeEntry = {
  path: string
  executable?: boolean
}

export type DirNode = {
  directories: Map<string, DirNode>
  files: (SkillTreeEntry & { filename: string; gitBlobSha?: string })[]
}

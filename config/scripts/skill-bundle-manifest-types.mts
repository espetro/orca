// Shared types for skill bundle manifest generation.
// Extracted to keep generate-skill-bundle-manifest.mts under the 600-line budget.

export type SkillTreeEntry = {
  path: string
  executable?: boolean
}

export type DirNode = {
  directories: Map<string, DirNode>
  files: { filename: string; path: string; executable?: boolean }[]
}

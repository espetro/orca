import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// Generate yellow-tinted canary icon from the stable icon without modifying committed assets.

const defaultRepoRoot = resolve(import.meta.dirname, '../..')

if (process.platform !== 'darwin') {
  console.error('Error: this script requires macOS (iconutil and sips are macOS-only)')
  process.exit(1)
}

// Canary yellow; high colorize keeps a clearly yellow icon while retaining the logo's shading.
const CANARY_FILL = '#ffd400'
const CANARY_COLORIZE = '80%'

function applyYellowTint(pngPath: string): void {
  // -channel RGB ... +channel would skip colorize; -colorize already leaves alpha untouched.
  execFileSync('magick', [pngPath, '-fill', CANARY_FILL, '-colorize', CANARY_COLORIZE, pngPath])
}

function findLargestSlot(iconsetDir: string): string {
  const slots = readdirSync(iconsetDir).filter((f) => f.endsWith('.png'))
  // Assume largest slot name contains the highest pixel count (e.g., _512x512@2x.png).
  slots.sort()
  const largest = slots.at(-1)
  if (!largest) {
    throw new Error(`No .png slots found in ${iconsetDir}`)
  }
  return join(iconsetDir, largest)
}

export function main(root = defaultRepoRoot): number {
  const inputIconPath = join(root, 'resources/build/icon.icns')
  const outputIconPath = join(root, 'resources/build/icon-canary.icns')
  const outputPngPath = join(root, 'resources/icon-canary.png')

  // Verify input exists before any work.
  if (!existsSync(inputIconPath)) {
    console.error(`Error: input icon not found: ${inputIconPath}`)
    return 1
  }

  const workDir = mkdtempSync(join(tmpdir(), 'orca-canary-icon-'))

  try {
    const iconsetDir = join(workDir, 'icon.iconset')

    // Explode icns to iconset dir.
    execFileSync('iconutil', ['-c', 'iconset', inputIconPath, '-o', iconsetDir])

    // Apply yellow tint to each PNG slot in place.
    const slots = readdirSync(iconsetDir).filter((f) => f.endsWith('.png'))
    for (const slot of slots) {
      applyYellowTint(join(iconsetDir, slot))
    }

    // Repackage as icns.
    execFileSync('iconutil', ['-c', 'icns', iconsetDir, '-o', outputIconPath])

    // Emit tray PNG from the largest (already-tinted) slot.
    const largestSlot = findLargestSlot(iconsetDir)
    execFileSync('sips', ['-z', '512', '512', largestSlot, '--out', outputPngPath])

    console.log(outputIconPath)
    console.log(outputPngPath)
    return 0
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`Error generating canary icon: ${message}`)
    return 1
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main())
}

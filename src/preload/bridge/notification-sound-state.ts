// Why: cache one shared Audio + blob URL per sound path so we don't re-read 10MB from disk and re-transfer over IPC on every notification.
let cachedNotificationSound: {
  path: string
  blobUrl: string
  audio: HTMLAudioElement
} | null = null
let isNotificationSoundPlaying = false
// Why: audio.play() can reject before ended/error fires — cleanup hook prevents leaked listeners on the cached Audio.
let cleanupNotificationSoundPlayback: (() => void) | null = null

export function isNotificationSoundActive(): boolean {
  return isNotificationSoundPlaying
}

export function getCachedNotificationSound(): {
  path: string
  blobUrl: string
  audio: HTMLAudioElement
} | null {
  return cachedNotificationSound
}

export function setCachedNotificationSound(
  entry: { path: string; blobUrl: string; audio: HTMLAudioElement } | null
): void {
  cachedNotificationSound = entry
}

export function setCleanupHook(cleanup: (() => void) | null): void {
  cleanupNotificationSoundPlayback = cleanup
}

export function getCleanupHook(): (() => void) | null {
  return cleanupNotificationSoundPlayback
}

export function isCurrentCleanup(cleanup: () => void): boolean {
  return cleanupNotificationSoundPlayback === cleanup
}

export function clearNotificationSoundPlaybackState(): void {
  cleanupNotificationSoundPlayback?.()
  cleanupNotificationSoundPlayback = null
  isNotificationSoundPlaying = false
}

export function setNotificationSoundPlaying(v: boolean): void {
  isNotificationSoundPlaying = v
}

export function disposeCachedNotificationSound(): void {
  if (cachedNotificationSound) {
    clearNotificationSoundPlaybackState()
    cachedNotificationSound.audio.pause()
    cachedNotificationSound.audio.src = ''
    URL.revokeObjectURL(cachedNotificationSound.blobUrl)
    cachedNotificationSound = null
  }
}

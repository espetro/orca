import { toast } from 'sonner'

export function showClientCreationActionError(error: unknown): void {
  toast.error(error instanceof Error ? error.message : String(error))
}

export function getKeybindingContext(target: EventTarget | null): 'terminal' | 'app' {
  return target instanceof HTMLElement && target.classList.contains('xterm-helper-textarea')
    ? 'terminal'
    : 'app'
}

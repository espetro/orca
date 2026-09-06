// Pure helpers for agent-browser command construction and result translation: focus/edit JS
// expressions, argv parsing, CDP mouse plumbing, and CLI result decoding.
import type { WebContents } from 'electron'
import { BrowserError } from './cdp-bridge'
import { EMBEDDED_NAVIGATION_TIMEOUT_MS } from './agent-browser-command-constants'

export type BrowserMouseModifier = 'cmd' | 'ctrl' | 'alt' | 'shift'

export function focusedValueSetExpression(
  valueExpression: string,
  options?: { append?: boolean; dispatchEvents?: boolean }
): string {
  const nextValue = options?.append
    ? ["String(target.value ?? '') + ", valueExpression].join('')
    : valueExpression
  const dispatchEvents = options?.dispatchEvents
    ? " target.dispatchEvent(new Event('input', { bubbles: true })); target.dispatchEvent(new Event('change', { bubbles: true }));"
    : ''
  return [
    '(() => { const el = document.activeElement; if (el) {',
    // Why: ARIA spinbutton wrappers can hold focus while a contained or controlled input owns the value.
    " const editableSelector = \"input:not([type='hidden']):not([type='button']):not([type='checkbox']):not([type='radio']):not([type='file']):not([type='image']):not([type='reset']):not([type='submit']), textarea\";",
    " const isEditable = (node) => !!node && (node.matches?.(editableSelector) ?? (node.tagName === 'TEXTAREA' || (node.tagName === 'INPUT' && !/^(hidden|button|checkbox|radio|file|image|reset|submit)$/i.test(node.getAttribute?.('type') ?? ''))));",
    ' const findEditable = (root) => root?.querySelector?.(editableSelector) ?? null;',
    ' let target = el;',
    " if (!isEditable(target) && target.getAttribute?.('role') === 'spinbutton') {",
    "   const controls = target.getAttribute('aria-controls');",
    '   if (controls) { for (const id of controls.split(/\\s+/)) { if (!id) continue; const controlled = document.getElementById(id); if (isEditable(controlled)) { target = controlled; break; } const descendant = findEditable(controlled); if (descendant) { target = descendant; break; } } }',
    '   if (target === el) { const descendant = findEditable(target); if (descendant) target = descendant; }',
    ' }',
    " const nativeSetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(target), 'value')?.set;",
    ' const nextValue = ',
    nextValue,
    '; if (nativeSetter) { nativeSetter.call(target, nextValue); } else { target.value = nextValue; }',
    dispatchEvents,
    ' } })()'
  ].join('')
}

// Why: rich editors reconcile only real browser edit transactions; a direct-DOM fallback can leave their model stale.
export function focusedRichTextEditExpression(
  valueExpression: string,
  options?: { selectAll?: boolean }
): string {
  const selectAll = options?.selectAll ? 'true' : 'false'
  return [
    '(() => {',
    ' const target = document.activeElement;',
    ' const value = ',
    valueExpression,
    ';',
    ` const selectAll = ${selectAll};`,
    " const isEditable = target?.isContentEditable === true || /^(|true|plaintext-only)$/i.test(target?.getAttribute?.('contenteditable') ?? 'false');",
    " if (!target || target === document.body || !isEditable) { throw new Error('Focused rich-text target is unavailable'); }",
    ' if (selectAll) {',
    "   if (typeof window.getSelection !== 'function') { throw new Error('Rich-text selection is unavailable'); }",
    '   const selection = window.getSelection();',
    "   if (!selection) { throw new Error('Rich-text selection is unavailable'); }",
    '   selection.selectAllChildren(target);',
    ' }',
    " const editCommand = selectAll && value.length === 0 ? 'delete' : 'insertText';",
    ' let edited = false;',
    ' try {',
    '   edited = document.execCommand(editCommand, false, value) === true;',
    ' } catch { edited = false; }',
    " if (!edited) { throw new Error('Browser rich-text editing command failed'); }",
    ' })()'
  ].join('')
}

export function isExplicitContentEditableResult(result: unknown): boolean {
  const value =
    result && typeof result === 'object' ? (result as { value?: unknown }).value : undefined
  return typeof value === 'string' && /^(|true|plaintext-only)$/i.test(value)
}

export function parseShellArgs(input: string): string[] {
  const args: string[] = []
  let current = ''
  let inDouble = false
  let inSingle = false

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble
    } else if (ch === "'" && !inDouble) {
      inSingle = !inSingle
    } else if (ch === ' ' && !inDouble && !inSingle) {
      if (current) {
        args.push(current)
        current = ''
      }
    } else {
      current += ch
    }
  }
  if (current) {
    args.push(current)
  }
  return args
}

export function stripAgentBrowserTargetArgs(args: string[]): string[] {
  const stripped: string[] = []
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--cdp' || arg === '--session') {
      index++
      continue
    }
    if (arg.startsWith('--cdp=') || arg.startsWith('--session=')) {
      continue
    }
    stripped.push(arg)
  }
  return stripped
}

// Why: agent-browser returns generic errors for stale/unknown refs; map to a specific code so agents can detect and re-snapshot.
export function classifyErrorCode(message: string): string {
  if (/unknown ref|ref not found|element not found: @e/i.test(message)) {
    return 'browser_stale_ref'
  }
  return 'browser_error'
}

export function isAbortedNavigationError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false
  }
  const { code, errno } = error as { code?: unknown; errno?: unknown }
  return code === 'ERR_ABORTED' || errno === -3
}

export function isWebContentsLoading(wc: WebContents): boolean {
  try {
    return wc.isLoading()
  } catch {
    // Why: destruction races are resolved against the authoritative page registration after the wait.
    return false
  }
}

export function waitForAbortedNavigationReplacement(
  wc: WebContents,
  browserPageId: string,
  timeoutMs: number
): Promise<void> {
  if (!isWebContentsLoading(wc)) {
    return Promise.resolve()
  }

  return new Promise((resolve, reject) => {
    let settled = false
    let timeout: ReturnType<typeof setTimeout> | null = null
    const finish = (error?: BrowserError): void => {
      if (settled) {
        return
      }
      settled = true
      wc.removeListener('did-stop-loading', onDidStopLoading)
      wc.removeListener('destroyed', onDestroyed)
      if (timeout) {
        clearTimeout(timeout)
      }
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    }
    const onDidStopLoading = (): void => finish()
    const onDestroyed = (): void => finish()

    wc.on('did-stop-loading', onDidStopLoading)
    wc.on('destroyed', onDestroyed)
    timeout = setTimeout(
      () =>
        finish(
          new BrowserError(
            'browser_error',
            `Failed to navigate browser page ${browserPageId}: Browser navigation timed out after ${EMBEDDED_NAVIGATION_TIMEOUT_MS}ms`
          )
        ),
      timeoutMs
    )
    timeout.unref?.()

    // Why: the replacement can finish between loadURL rejecting and listener attachment.
    if (!isWebContentsLoading(wc)) {
      finish()
    }
  })
}

export function isTabClosedTransportError(message: string): boolean {
  return /session destroyed while command|session destroyed while commands|connection refused|cdp discovery methods failed|websocket connect failed/i.test(
    message
  )
}

export function pageUnavailableMessageForSession(sessionName: string): string {
  const prefix = 'orca-tab-'
  const browserPageId = sessionName.startsWith(prefix) ? sessionName.slice(prefix.length) : null
  return browserPageId
    ? `Browser page ${browserPageId} is no longer available`
    : 'Browser tab is no longer available'
}

export type CdpMouseButton = 'left' | 'middle' | 'right'

export type BrowserClickPoint = {
  x: number
  y: number
  adjusted: boolean
  handled: boolean
}

export function normalizeCdpMouseButton(button?: string): CdpMouseButton {
  return button === 'middle' || button === 'right' ? button : 'left'
}

export function cdpMouseButtonMask(button: CdpMouseButton): number {
  if (button === 'right') {
    return 2
  }
  if (button === 'middle') {
    return 4
  }
  return 1
}

export function cdpMouseModifierMask(modifiers: BrowserMouseModifier[] | undefined): number {
  if (!modifiers || modifiers.length === 0) {
    return 0
  }
  let mask = 0
  for (const modifier of modifiers) {
    if (modifier === 'alt') {
      mask |= 1
    } else if (modifier === 'ctrl') {
      mask |= 2
    } else if (modifier === 'cmd') {
      mask |= 4
    } else if (modifier === 'shift') {
      mask |= 8
    }
  }
  return mask
}

export function readClickPoint(value: unknown, fallback: BrowserClickPoint): BrowserClickPoint {
  const point = value && typeof value === 'object' ? (value as Record<string, unknown>) : null
  const x = point?.x
  const y = point?.y
  if (
    typeof x !== 'number' ||
    !Number.isFinite(x) ||
    typeof y !== 'number' ||
    !Number.isFinite(y)
  ) {
    return fallback
  }
  return { x, y, adjusted: point?.adjusted === true, handled: point?.handled === true }
}

export function mobileTouchClickExpression(
  x: number,
  y: number,
  radius: number,
  allowDomActivation: boolean
): string {
  return `(() => {
    const inputX = ${JSON.stringify(x)};
    const inputY = ${JSON.stringify(y)};
    const radius = ${JSON.stringify(radius)};
    const allowDomActivation = ${JSON.stringify(allowDomActivation)};
    const selector = [
      'a[href]',
      'button',
      'input',
      'textarea',
      'select',
      'summary',
      'label',
      '[role="button"]',
      '[role="link"]',
      '[role="menuitem"]',
      '[role="tab"]',
      '[role="checkbox"]',
      '[role="radio"]',
      '[role="switch"]',
      '[onclick]',
      '[tabindex]:not([tabindex="-1"])'
    ].join(',');
    const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
    const isUsable = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' &&
        style.visibility !== 'hidden' && style.pointerEvents !== 'none';
    };
    const dispatchClick = (target, clickX, clickY) => {
      try {
        if (typeof target.focus === 'function') {
          target.focus({ preventScroll: true });
        }
      } catch {
        try { target.focus(); } catch {}
      }
      if (typeof target.click === 'function') {
        target.click();
        return true;
      }
      const init = {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        clientX: clickX,
        clientY: clickY,
        screenX: clickX,
        screenY: clickY,
        button: 0,
        buttons: 1
      };
      try {
        if (typeof PointerEvent === 'function') {
          target.dispatchEvent(new PointerEvent('pointerdown', { ...init, pointerType: 'touch', pointerId: 1 }));
          target.dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0, pointerType: 'touch', pointerId: 1 }));
        }
      } catch {}
      target.dispatchEvent(new MouseEvent('mousedown', init));
      target.dispatchEvent(new MouseEvent('mouseup', { ...init, buttons: 0 }));
      target.dispatchEvent(new MouseEvent('click', { ...init, buttons: 0 }));
      return true;
    };
    const clickableFor = (el) => {
      for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
        if (node.matches(selector)) return node;
        if (window.getComputedStyle(node).cursor === 'pointer') return node;
      }
      return null;
    };
    const offsets = [[0, 0]];
    for (const distance of [radius * 0.45, radius, radius * 1.35]) {
      for (const angle of [0, Math.PI / 4, Math.PI / 2, Math.PI * 3 / 4, Math.PI,
        Math.PI * 5 / 4, Math.PI * 3 / 2, Math.PI * 7 / 4]) {
        offsets.push([Math.cos(angle) * distance, Math.sin(angle) * distance]);
      }
    }
    let best = null;
    for (const [dx, dy] of offsets) {
      const px = inputX + dx;
      const py = inputY + dy;
      if (px < 0 || py < 0 || px > window.innerWidth || py > window.innerHeight) continue;
      for (const el of document.elementsFromPoint(px, py)) {
        const target = clickableFor(el);
        if (!target || !isUsable(target)) continue;
        const rect = target.getBoundingClientRect();
        const clickX = clamp(inputX, rect.left + 1, rect.right - 1);
        const clickY = clamp(inputY, rect.top + 1, rect.bottom - 1);
        const score = Math.hypot(clickX - inputX, clickY - inputY) + Math.hypot(dx, dy) * 0.25;
        if (!best || score < best.score) best = { score, x: clickX, y: clickY, target };
        break;
      }
    }
    if (best && allowDomActivation && dispatchClick(best.target, best.x, best.y)) {
      return { x: best.x, y: best.y, adjusted: true, handled: true };
    }
    if (best) {
      return { x: best.x, y: best.y, adjusted: true, handled: false };
    }
    return { x: inputX, y: inputY, adjusted: false, handled: false };
  })()`
}

export async function resolveMobileTouchClickPoint(
  dbg: WebContents['debugger'],
  x: number,
  y: number,
  radius: number | undefined,
  allowDomActivation: boolean
): Promise<BrowserClickPoint> {
  const fallback = { x, y, adjusted: false, handled: false }
  if (typeof radius !== 'number' || !Number.isFinite(radius) || radius <= 0) {
    return fallback
  }
  try {
    const result = await dbg.sendCommand('Runtime.evaluate', {
      expression: mobileTouchClickExpression(x, y, radius, allowDomActivation),
      returnByValue: true,
      silent: true
    })
    const raw = result && typeof result === 'object' ? (result as Record<string, unknown>) : null
    const evaluated = raw?.result && typeof raw.result === 'object' ? raw.result : null
    return readClickPoint((evaluated as Record<string, unknown> | null)?.value, fallback)
  } catch {
    return fallback
  }
}

export function translateResult(
  stdout: string
): { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } } {
  let parsed: { success?: boolean; data?: unknown; error?: string }
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return {
      ok: false,
      error: {
        code: 'browser_error',
        message: `Unexpected output from agent-browser: ${stdout.slice(0, 1000)}`
      }
    }
  }
  if (parsed.success) {
    return { ok: true, result: parsed.data }
  }
  const message = parsed.error ?? 'Unknown browser error'
  return {
    ok: false,
    error: {
      code: classifyErrorCode(message),
      message
    }
  }
}

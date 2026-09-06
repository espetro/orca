import { useRef } from 'react'

export function useStatusBarMenuFocusHandoff(): {
  reset: () => void
  onPointerDownOutside: () => void
  onCloseAutoFocus: (event: Event) => void
} {
  const skipCloseAutoFocusRef = useRef(false)
  return {
    reset: () => {
      skipCloseAutoFocusRef.current = false
    },
    onPointerDownOutside: () => {
      skipCloseAutoFocusRef.current = true
    },
    onCloseAutoFocus: (event) => {
      if (!skipCloseAutoFocusRef.current) {
        return
      }
      skipCloseAutoFocusRef.current = false
      // Why: Radix trigger restoration steals the first click from surfaces such as xterm.
      event.preventDefault()
    }
  }
}

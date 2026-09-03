import { useCallback, useRef, useState } from 'react'
import type { SearchState } from './keyboard-handlers'
import { useAppStore } from '../../store'

export type UseTerminalPaneSearchKeyboardReturn = {
  searchOpen: boolean
  setSearchOpen: (open: boolean) => void
  searchOpenRef: React.MutableRefObject<boolean>
  searchStateRef: React.MutableRefObject<SearchState>
  handleSearchSelectedText: (selectedText: string) => void
}

export function useTerminalPaneSearchKeyboard(): UseTerminalPaneSearchKeyboardReturn {
  const [searchOpen, setSearchOpen] = useState(false)
  const searchOpenRef = useRef(false)
  searchOpenRef.current = searchOpen
  const searchStateRef = useRef<SearchState>({ query: '', caseSensitive: false, regex: false })

  const handleSearchSelectedText = useCallback((selectedText: string): void => {
    const state = useAppStore.getState()
    state.showRightSidebarSearch({ query: selectedText })
  }, [])

  return {
    searchOpen,
    setSearchOpen,
    searchOpenRef,
    searchStateRef,
    handleSearchSelectedText
  }
}

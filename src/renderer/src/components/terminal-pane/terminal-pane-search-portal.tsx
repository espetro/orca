import { createPortal } from 'react-dom'
import TerminalSearch from '@/components/TerminalSearch'
import type { SearchState } from './keyboard-handlers'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager'

type TerminalPaneSearchPortalProps = {
  activePane: ManagedPane
  searchOpen: boolean
  setSearchOpen: (open: boolean) => void
  searchStateRef: React.RefObject<SearchState>
}

/** Portals the terminal search bar into the active pane container. */
export function TerminalPaneSearchPortal({
  activePane,
  searchOpen,
  setSearchOpen,
  searchStateRef
}: TerminalPaneSearchPortalProps): React.JSX.Element {
  return createPortal(
    <TerminalSearch
      isOpen={searchOpen}
      onClose={() => setSearchOpen(false)}
      searchAddon={activePane.searchAddon ?? null}
      searchStateRef={searchStateRef}
    />,
    activePane.container
  )
}

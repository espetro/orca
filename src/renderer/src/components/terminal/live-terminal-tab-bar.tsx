import React from 'react'
import TabBar from '../tab-bar/TabBar'
import { useAppStore } from '../../store'
import type { TerminalTab } from '../../../shared/terminal-tab-types'

const EMPTY_TERMINAL_TABS: TerminalTab[] = []

// Why: titlebar fallback strip reads only this worktree's terminal tabs, so unrelated store writes don't re-render it.
export function LiveTerminalTabBar(
  props: Omit<React.ComponentProps<typeof TabBar>, 'tabs'>
): React.JSX.Element {
  const tabs = useAppStore((state) => state.tabsByWorktree[props.worktreeId] ?? EMPTY_TERMINAL_TABS)
  return <TabBar {...props} tabs={tabs} />
}

import { createPortal } from 'react-dom'
import NativeChatView from '../native-chat/NativeChatView'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { canContinueAgentSessionInNewSession } from '../native-chat/native-chat-send-eligibility'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager'
import type { TerminalMenuState } from './use-terminal-pane-context-menu'

type TerminalPaneNativeChatPortalProps = {
  chatPane: ManagedPane
  tabId: string
  isRendererVisible: boolean
  structuredSessionId: string | null
  structuredChatAgent: string | null
  structuredChatTarget: string | null | undefined
  chatPanePtyId: string | null
  chatPaneLaunchAgent: TuiAgent | null
  chatPaneResolvedAgent: string | null
  chatPaneDispatchStatus: string | undefined
  unifiedTabId: string | null | undefined
  expandedPaneId: number | null
  managedPanesCount: number
  contextMenu: TerminalMenuState
  switchNativeChatToTerminal: () => void
  readNativeChatTerminalScreen: () => string | null
  resolveAgentForLeaf: (leafId: string | null) => string | null
}

/** Portals the native chat surface over the chat-replaced pane container. */
export function TerminalPaneNativeChatPortal({
  chatPane,
  tabId,
  isRendererVisible,
  structuredSessionId,
  structuredChatAgent,
  structuredChatTarget,
  chatPanePtyId,
  chatPaneLaunchAgent,
  chatPaneResolvedAgent,
  chatPaneDispatchStatus,
  unifiedTabId,
  expandedPaneId,
  managedPanesCount,
  contextMenu,
  switchNativeChatToTerminal,
  readNativeChatTerminalScreen,
  resolveAgentForLeaf
}: TerminalPaneNativeChatPortalProps): React.JSX.Element {
  return createPortal(
    <div className="native-chat-pane-shell absolute inset-0 z-10 flex min-h-0 min-w-0 bg-background">
      {structuredSessionId && structuredChatAgent ? (
        <NativeChatView
          mode="structured"
          tabId={unifiedTabId ?? tabId}
          sessionId={structuredSessionId}
          agent={structuredChatAgent}
          isVisible={isRendererVisible}
          target={structuredChatTarget}
          allowFileUriLinks
          orchestrationDispatchStatus={chatPaneDispatchStatus}
        />
      ) : (
        <NativeChatView
          terminalTabId={tabId}
          isVisible={isRendererVisible}
          paneKey={makePaneKey(tabId, chatPane.leafId)}
          targetPtyId={chatPanePtyId}
          launchAgent={chatPaneLaunchAgent}
          resolvedAgent={chatPaneResolvedAgent}
          onSwitchToTerminal={switchNativeChatToTerminal}
          readTerminalScreen={readNativeChatTerminalScreen}
          contextMenuActions={{
            onSplitRight: () => contextMenu.runForPane(chatPane.id, contextMenu.onSplitRight),
            onSplitDown: () => contextMenu.runForPane(chatPane.id, contextMenu.onSplitDown),
            canEqualizePaneSizes: managedPanesCount > 1 && expandedPaneId === null,
            onEqualizePaneSizes: () =>
              contextMenu.runForPane(chatPane.id, contextMenu.onEqualizePaneSizes),
            canExpandPane: managedPanesCount > 1,
            isPaneExpanded: expandedPaneId === chatPane.id,
            onToggleExpand: () => contextMenu.runForPane(chatPane.id, contextMenu.onToggleExpand),
            canContinueAgentSessionInNewSession: canContinueAgentSessionInNewSession(
              resolveAgentForLeaf(chatPane.leafId)
            ),
            onContinueAgentSessionInNewSession: () =>
              contextMenu.runForPane(chatPane.id, contextMenu.onContinueAgentSessionInNewSession),
            onForkAgentSession: () =>
              void contextMenu.runForPane(chatPane.id, contextMenu.onForkAgentSession),
            onSetTitle: () => contextMenu.runForPane(chatPane.id, contextMenu.onSetTitle),
            onCopyTerminalId: () =>
              void contextMenu.runForPane(chatPane.id, contextMenu.onCopyTerminalId),
            onCopyPaneId: () =>
              void contextMenu.runForPane(chatPane.id, contextMenu.onCopyPaneId),
            canClosePane: managedPanesCount > 1,
            onClosePane: () => contextMenu.runForPane(chatPane.id, contextMenu.onClosePane)
          }}
          orchestrationDispatchStatus={chatPaneDispatchStatus}
        />
      )}
    </div>,
    chatPane.container,
    `native-chat-${tabId}-${chatPane.leafId}`
  )
}

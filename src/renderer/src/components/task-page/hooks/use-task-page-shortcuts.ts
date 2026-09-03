import { useEffect } from 'react'
import type { RefObject } from 'react'

type GithubSearchFocusDeps = {
  taskSource: string
  githubMode: string
  dialogWorkItem: unknown
  newIssueOpen: boolean
  newLinearProjectOpen: boolean
  newLinearIssueOpen: boolean
  newJiraIssueOpen: boolean
  activeModal: string
  taskSearchInputRef: RefObject<HTMLInputElement | null>
}

// Why: Cmd/Ctrl+F focuses the GitHub task search only when the list chrome is active and no dialog owns input.
export function useTaskPageGithubSearchFocusShortcut(deps: GithubSearchFocusDeps): void {
  const {
    taskSource,
    githubMode,
    dialogWorkItem,
    newIssueOpen,
    newLinearProjectOpen,
    newLinearIssueOpen,
    newJiraIssueOpen,
    activeModal,
    taskSearchInputRef
  } = deps

  useEffect(() => {
    if (
      taskSource !== 'github' ||
      githubMode !== 'items' ||
      dialogWorkItem ||
      newIssueOpen ||
      newLinearProjectOpen ||
      newLinearIssueOpen ||
      newJiraIssueOpen ||
      activeModal !== 'none'
    ) {
      return
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      const isMac = navigator.userAgent.includes('Mac')
      const modifierPressed = isMac ? event.metaKey : event.ctrlKey
      if (!modifierPressed || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'f') {
        return
      }

      const input = taskSearchInputRef.current
      if (!input) {
        return
      }
      const target = event.target
      if (
        target instanceof HTMLElement &&
        target !== input &&
        (target instanceof HTMLInputElement ||
          target instanceof HTMLTextAreaElement ||
          target.isContentEditable)
      ) {
        return
      }

      event.preventDefault()
      event.stopPropagation()
      input.focus()
      input.select()
    }

    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [
    activeModal,
    dialogWorkItem,
    githubMode,
    newIssueOpen,
    newLinearProjectOpen,
    newLinearIssueOpen,
    newJiraIssueOpen,
    taskSource,
    taskSearchInputRef
  ])
}

type EscapeCloseDeps = {
  dialogWorkItem: unknown
  selectedJiraIssue: unknown
  selectedLinearIssue: unknown
  newIssueOpen: boolean
  newLinearIssueOpen: boolean
  newJiraIssueOpen: boolean
  activeModal: string
  closeTaskPage: () => void
}

// Why: Esc blurs a focused input first; only closes the page once focus is outside an input and no Radix overlay owns it.
export function useTaskPageEscapeCloseShortcut(deps: EscapeCloseDeps): void {
  const {
    dialogWorkItem,
    selectedJiraIssue,
    selectedLinearIssue,
    newIssueOpen,
    newLinearIssueOpen,
    newJiraIssueOpen,
    activeModal,
    closeTaskPage
  } = deps

  useEffect(() => {
    // Why: when a modal is open, let it own Esc dismissal.
    if (
      dialogWorkItem ||
      selectedJiraIssue ||
      selectedLinearIssue ||
      newIssueOpen ||
      newLinearIssueOpen ||
      newJiraIssueOpen ||
      activeModal !== 'none'
    ) {
      return
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') {
        return
      }

      const target = event.target
      if (!(target instanceof HTMLElement)) {
        return
      }

      // Why: open menus/popovers/selects own Esc; capture-phase leave would steal it from Radix.
      if (
        document.querySelector(
          '[data-slot="dropdown-menu-content"], [data-slot="popover-content"], [data-slot="select-content"], [role="menu"]'
        )
      ) {
        return
      }

      // Why: Esc first blurs a focused input so it doesn't accidentally close the whole page; only closes once focus is outside an input.
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        target.isContentEditable
      ) {
        event.preventDefault()
        target.blur()
        return
      }

      event.preventDefault()
      closeTaskPage()
    }

    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [
    activeModal,
    closeTaskPage,
    dialogWorkItem,
    newIssueOpen,
    newLinearIssueOpen,
    newJiraIssueOpen,
    selectedLinearIssue,
    selectedJiraIssue
  ])
}

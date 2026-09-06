import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { PersistedUIState } from '../../../../shared/persisted-ui-state-types'
import {
  getContextualTour,
  normalizeContextualTourIds,
  type ContextualTourId
} from '../../../../shared/contextual-tours'
import {
  normalizeFeatureInteractions,
  type FeatureInteractionId,
  type FeatureInteractionState
} from '../../../../shared/feature-interactions'
import {
  getContextualTourRequestDecision,
  hasContextualTourTarget,
  getNextVisibleContextualTourStepIndex,
  getPreviousVisibleContextualTourStepIndex
} from '../../components/contextual-tours/contextual-tour-gate'
import type { FeatureTipId } from '../../../../shared/feature-tips'
import { hasFeatureInteraction } from '../../../../shared/feature-interactions'

export function mergeFeatureInteractionState(
  current: FeatureInteractionState,
  incoming: PersistedUIState['featureInteractions']
): FeatureInteractionState {
  const currentNormalized = normalizeFeatureInteractions(current)
  const incomingNormalized = normalizeFeatureInteractions(incoming)
  const merged: FeatureInteractionState = { ...currentNormalized }
  for (const [id, incomingRecord] of Object.entries(incomingNormalized)) {
    const featureId = id as FeatureInteractionId
    const currentRecord = currentNormalized[featureId]
    merged[featureId] = currentRecord
      ? {
          firstInteractedAt: Math.min(
            currentRecord.firstInteractedAt,
            incomingRecord.firstInteractedAt
          ),
          interactionCount: Math.max(
            currentRecord.interactionCount,
            incomingRecord.interactionCount
          )
        }
      : incomingRecord
  }
  return merged
}

export function mergeContextualTourSeenIds(
  current: readonly ContextualTourId[],
  incoming: PersistedUIState['contextualToursSeenIds']
): ContextualTourId[] {
  const merged = new Set<ContextualTourId>(normalizeContextualTourIds(current))
  for (const id of normalizeContextualTourIds(incoming)) {
    merged.add(id)
  }
  return [...merged]
}

export function getContextualTourProgressionForFeatureInteraction(
  state: AppState,
  id: FeatureInteractionId
): 'advance' | 'complete' | 'reveal-sidebar-and-advance' | null {
  if (!state.activeContextualTourId) {
    return null
  }
  const tour = getContextualTour(state.activeContextualTourId)
  const step = tour.steps[state.activeContextualTourStepIndex]
  if (step?.advanceOnFeatureInteraction !== id) {
    return null
  }
  const nextStepIndex = getNextVisibleContextualTourStepIndex({
    tour,
    currentStepIndex: state.activeContextualTourStepIndex,
    targetExists: hasContextualTourTarget
  })
  if (nextStepIndex !== null) {
    return 'advance'
  }
  if (
    state.activeContextualTourId === 'workspace-agent-sessions' &&
    state.activeContextualTourStepIndex === 0 &&
    id === 'terminal-pane-split' &&
    !state.sidebarOpen
  ) {
    return 'reveal-sidebar-and-advance'
  }
  return 'complete'
}

export type UIContextualToursSlice = {
  featureTipsSeenIds: FeatureTipId[]
  markFeatureTipsSeen: (ids: FeatureTipId[]) => void
  featureInteractions: FeatureInteractionState
  recordFeatureInteraction: (id: FeatureInteractionId) => Promise<void>
  contextualToursSeenIds: ContextualTourId[]
  contextualToursAutoEligible: boolean | null
  activeContextualTourId: ContextualTourId | null
  activeContextualTourStepIndex: number
  activeContextualTourSource: string | null
  activeContextualTourSourceDetached: boolean
  activeContextualTourWasFeaturePreviouslyInteracted: boolean
  contextualTourNavigationInteractionSnapshot: Partial<Record<ContextualTourId, boolean>>
  activeContextualTourSuppressed: boolean
  contextualTourShownThisSession: boolean
  contextualToursOnboardingVisible: boolean
  contextualToursBlockingSurfaceVisible: boolean
  lastCompletedContextualTourId: ContextualTourId | null
  setContextualToursAutoEligible: (eligible: boolean) => void
  setContextualToursOnboardingVisible: (visible: boolean) => void
  setContextualToursBlockingSurfaceVisible: (visible: boolean) => void
  requestContextualTour: (
    id: ContextualTourId,
    source: string,
    wasFeaturePreviouslyInteracted?: boolean,
    options?: { force?: boolean }
  ) => void
  suppressContextualTour: (id: ContextualTourId, source: string) => void
  detachContextualTourSource: (id: ContextualTourId, source: string) => void
  advanceContextualTour: () => void
  regressContextualTour: () => void
  dismissContextualTour: (id?: ContextualTourId) => void
  completeContextualTour: (id?: ContextualTourId) => void
  cancelContextualTour: (id?: ContextualTourId) => void
  markContextualToursSeen: (ids: ContextualTourId[]) => void
}

export const createUIContextualToursSlice: StateCreator<
  AppState,
  [],
  [],
  UIContextualToursSlice
> = (set, get) => ({
  featureTipsSeenIds: [],
  markFeatureTipsSeen: (ids) =>
    set((s) => {
      if (ids.length === 0) {
        return s
      }
      const current = new Set(s.featureTipsSeenIds)
      let changed = false
      for (const id of ids) {
        if (!current.has(id)) {
          current.add(id)
          changed = true
        }
      }
      if (!changed) {
        return s
      }
      const next = [...current]
      window.api.ui.set({ featureTipsSeenIds: next }).catch(console.error)
      return { featureTipsSeenIds: next }
    }),
  featureInteractions: {},
  recordFeatureInteraction: (id) => {
    let tourProgression: ReturnType<typeof getContextualTourProgressionForFeatureInteraction> = null
    let persistPromise = Promise.resolve()
    set((s) => {
      if (!s.persistedUIReady) {
        return s
      }
      tourProgression = getContextualTourProgressionForFeatureInteraction(s, id)
      const existing = s.featureInteractions[id]
      const next: FeatureInteractionState = {
        ...s.featureInteractions,
        [id]: {
          firstInteractedAt: existing?.firstInteractedAt ?? Date.now(),
          interactionCount: (existing?.interactionCount ?? 0) + 1
        }
      }
      if (typeof window !== 'undefined') {
        const recordInteraction = window.api.ui.recordFeatureInteraction
        const persist = recordInteraction
          ? recordInteraction(id).then((ui) => {
              set((current) => ({
                featureInteractions: mergeFeatureInteractionState(
                  current.featureInteractions,
                  ui.featureInteractions
                ),
                contextualToursSeenIds: mergeContextualTourSeenIds(
                  current.contextualToursSeenIds,
                  ui.contextualToursSeenIds
                )
              }))
            })
          : window.api.ui.set({ featureInteractions: next })
        persistPromise = persist.catch(console.error)
      }
      if (tourProgression === 'reveal-sidebar-and-advance') {
        // Why: split can fire from keyboard/menu with the sidebar closed, but the next tour target lives in the sidebar.
        return {
          featureInteractions: next,
          sidebarOpen: true,
          activeContextualTourStepIndex: s.activeContextualTourStepIndex + 1
        }
      }
      return { featureInteractions: next }
    })
    if (tourProgression === 'complete') {
      get().completeContextualTour()
    } else if (tourProgression === 'advance') {
      get().advanceContextualTour()
    }
    return persistPromise
  },
  contextualToursSeenIds: [],
  contextualToursAutoEligible: null,
  activeContextualTourId: null,
  activeContextualTourStepIndex: 0,
  activeContextualTourSource: null,
  activeContextualTourSourceDetached: false,
  activeContextualTourWasFeaturePreviouslyInteracted: false,
  contextualTourNavigationInteractionSnapshot: {},
  activeContextualTourSuppressed: false,
  contextualTourShownThisSession: false,
  contextualToursOnboardingVisible: false,
  contextualToursBlockingSurfaceVisible: false,
  lastCompletedContextualTourId: null,
  setContextualToursAutoEligible: (eligible) =>
    set((s) => {
      if (s.contextualToursAutoEligible === eligible) {
        return s
      }
      if (typeof window !== 'undefined') {
        window.api.ui.set({ contextualToursAutoEligible: eligible }).catch(console.error)
      }
      return { contextualToursAutoEligible: eligible }
    }),
  setContextualToursOnboardingVisible: (visible) =>
    set((s) =>
      s.contextualToursOnboardingVisible === visible
        ? s
        : { contextualToursOnboardingVisible: visible }
    ),
  setContextualToursBlockingSurfaceVisible: (visible) =>
    set((s) =>
      s.contextualToursBlockingSurfaceVisible === visible
        ? s
        : { contextualToursBlockingSurfaceVisible: visible }
    ),
  requestContextualTour: (id, source, wasFeaturePreviouslyInteracted, options) =>
    set((s) => {
      const tour = getContextualTour(id)
      const decision = getContextualTourRequestDecision({
        tour,
        persistedUIReady: s.persistedUIReady,
        autoEligible: options?.force === true || s.contextualToursAutoEligible === true,
        onboardingVisible: s.contextualToursOnboardingVisible,
        seenIds: options?.force === true ? [] : s.contextualToursSeenIds,
        sessionConsumed: options?.force === true ? false : s.contextualTourShownThisSession,
        activeTourId: s.activeContextualTourId,
        activeModal: s.activeModal,
        blockingSurfaceVisible: s.contextualToursBlockingSurfaceVisible,
        targetExists: hasContextualTourTarget
      })
      if (decision.kind !== 'start') {
        if (s.contextualTourNavigationInteractionSnapshot[id] === undefined) {
          return s
        }
        const { [id]: _consumed, ...remainingNavigationSnapshot } =
          s.contextualTourNavigationInteractionSnapshot
        void _consumed
        return { contextualTourNavigationInteractionSnapshot: remainingNavigationSnapshot }
      }
      const navigationSnapshot = s.contextualTourNavigationInteractionSnapshot[id]
      const { [id]: _consumed, ...remainingNavigationSnapshot } =
        s.contextualTourNavigationInteractionSnapshot
      void _consumed
      return {
        activeContextualTourId: id,
        activeContextualTourStepIndex: decision.stepIndex,
        activeContextualTourSource: source,
        activeContextualTourSourceDetached: false,
        activeContextualTourWasFeaturePreviouslyInteracted:
          wasFeaturePreviouslyInteracted ??
          navigationSnapshot ??
          hasFeatureInteraction(s.featureInteractions, id),
        contextualTourNavigationInteractionSnapshot: remainingNavigationSnapshot,
        activeContextualTourSuppressed: false,
        contextualTourShownThisSession: true,
        lastCompletedContextualTourId: null
      }
    }),
  suppressContextualTour: (id, source) =>
    set((s) => {
      if (
        s.activeContextualTourId !== id ||
        s.activeContextualTourSource !== source ||
        s.activeContextualTourSourceDetached
      ) {
        return s
      }
      return s.activeContextualTourSuppressed ? s : { activeContextualTourSuppressed: true }
    }),
  detachContextualTourSource: (id, source) =>
    set((s) => {
      if (s.activeContextualTourId !== id || s.activeContextualTourSource !== source) {
        return s
      }
      return s.activeContextualTourSourceDetached ? s : { activeContextualTourSourceDetached: true }
    }),
  advanceContextualTour: () =>
    set((s) => {
      if (!s.activeContextualTourId) {
        return s
      }
      const tour = getContextualTour(s.activeContextualTourId)
      const nextStepIndex = getNextVisibleContextualTourStepIndex({
        tour,
        currentStepIndex: s.activeContextualTourStepIndex,
        targetExists: hasContextualTourTarget
      })
      if (nextStepIndex !== null) {
        return { activeContextualTourStepIndex: nextStepIndex }
      }
      // Why: browser step 3's target lives in a closed menu until that step is active.
      if (
        s.activeContextualTourId === 'browser' &&
        s.activeContextualTourStepIndex + 1 < tour.steps.length
      ) {
        return { activeContextualTourStepIndex: s.activeContextualTourStepIndex + 1 }
      }
      return s
    }),
  regressContextualTour: () =>
    set((s) => {
      if (!s.activeContextualTourId) {
        return s
      }
      const previousStepIndex = getPreviousVisibleContextualTourStepIndex({
        tour: getContextualTour(s.activeContextualTourId),
        currentStepIndex: s.activeContextualTourStepIndex,
        targetExists: hasContextualTourTarget
      })
      if (previousStepIndex === null) {
        return s
      }
      return { activeContextualTourStepIndex: previousStepIndex }
    }),
  dismissContextualTour: (id) => {
    const activeTourId = get().activeContextualTourId
    if (id && activeTourId !== id) {
      return
    }
    const tourId = id ?? activeTourId
    if (tourId) {
      get().markContextualToursSeen([tourId])
    }
    set((s) => {
      if (id && s.activeContextualTourId !== id) {
        return s
      }
      return {
        activeContextualTourId: null,
        activeContextualTourStepIndex: 0,
        activeContextualTourSource: null,
        activeContextualTourSourceDetached: false,
        activeContextualTourWasFeaturePreviouslyInteracted: false,
        activeContextualTourSuppressed: false,
        lastCompletedContextualTourId: null
      }
    })
  },
  completeContextualTour: (id) => {
    const activeTourId = get().activeContextualTourId
    if (id && activeTourId !== id) {
      return
    }
    const tourId = id ?? activeTourId
    if (tourId) {
      get().markContextualToursSeen([tourId])
    }
    set((s) => {
      if (id && s.activeContextualTourId !== id) {
        return s
      }
      return {
        activeContextualTourId: null,
        activeContextualTourStepIndex: 0,
        activeContextualTourSource: null,
        activeContextualTourSourceDetached: false,
        activeContextualTourWasFeaturePreviouslyInteracted: false,
        activeContextualTourSuppressed: false,
        lastCompletedContextualTourId: tourId ?? null
      }
    })
  },
  cancelContextualTour: (id) =>
    set((s) => {
      const activeTourId = s.activeContextualTourId
      const tourId = id ?? activeTourId
      if (!tourId || (id && activeTourId !== id)) {
        return s
      }
      const alreadyShown = s.contextualToursSeenIds.includes(tourId)
      return {
        activeContextualTourId: null,
        activeContextualTourStepIndex: 0,
        activeContextualTourSource: null,
        activeContextualTourSourceDetached: false,
        activeContextualTourWasFeaturePreviouslyInteracted: false,
        activeContextualTourSuppressed: false,
        lastCompletedContextualTourId: null,
        contextualTourShownThisSession: alreadyShown ? s.contextualTourShownThisSession : false
      }
    }),
  markContextualToursSeen: (ids) =>
    set((s) => {
      if (ids.length === 0) {
        return s
      }
      const current = new Set(s.contextualToursSeenIds)
      let changed = false
      for (const id of ids) {
        if (!current.has(id)) {
          current.add(id)
          changed = true
        }
      }
      if (!changed) {
        return s
      }
      const next = [...current]
      if (typeof window !== 'undefined') {
        window.api.ui.set({ contextualToursSeenIds: next }).catch(console.error)
      }
      return { contextualToursSeenIds: next }
    })
})

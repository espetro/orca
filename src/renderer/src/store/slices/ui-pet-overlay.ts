import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { CustomPet } from '../../../../shared/pet-types'
import { PET_SIZE_DEFAULT, PET_SIZE_MAX, PET_SIZE_MIN } from '../../../../shared/pet-types'
import { DEFAULT_PET_ID } from '../../components/pet/pet-models'
import { revokeCustomPetBlobUrl } from '../../components/pet/pet-blob-cache'
import type { UISlice } from './ui'

function clampPetSize(size: number): number {
  if (!Number.isFinite(size)) {
    return PET_SIZE_DEFAULT
  }
  return Math.max(PET_SIZE_MIN, Math.min(PET_SIZE_MAX, Math.round(size)))
}

export { clampPetSize }

export type UIPetOverlaySlice = {
  petVisible: boolean
  setPetVisible: (v: boolean) => void
  petId: string
  setPetId: (id: string) => void
  /** Pet overlay size in CSS pixels (square). User-adjustable so an oversized imported sprite isn't stuck on screen. */
  petSize: number
  setPetSize: (size: number) => void
  customPets: CustomPet[]
  addCustomPet: (model: CustomPet) => void
  removeCustomPet: (id: string) => void
}

export const createUIPetOverlaySlice: StateCreator<AppState, [], [], UIPetOverlaySlice> = (
  set
) => ({
  // Why: default true so enabling experimentalPet shows the pet immediately (persisted; "Hide pet" flips it false).
  petVisible: true,
  setPetVisible: (v) => {
    window.api.ui.set({ petVisible: v }).catch(console.error)
    set({ petVisible: v })
  },

  petId: DEFAULT_PET_ID,
  setPetId: (id) => {
    window.api.ui.set({ petId: id }).catch(console.error)
    set({ petId: id })
  },

  petSize: PET_SIZE_DEFAULT,
  setPetSize: (size) => {
    const clamped = clampPetSize(size)
    window.api.ui.set({ petSize: clamped }).catch(console.error)
    set({ petSize: clamped })
  },

  customPets: [],
  addCustomPet: (model) =>
    set((s) => {
      const next = [...s.customPets.filter((m) => m.id !== model.id), model]
      window.api.ui.set({ customPets: next }).catch(console.error)
      return { customPets: next }
    }),
  removeCustomPet: (id) =>
    set((s) => {
      const target = s.customPets.find((m) => m.id === id)
      if (!target) {
        return s
      }
      const next = s.customPets.filter((m) => m.id !== id)
      // Why: removing the active custom pet falls back to bundled default so the overlay isn't empty.
      const fallback = s.petId === id ? DEFAULT_PET_ID : s.petId
      // Why: single combined IPC update so customPets and petId persist atomically.
      const ipcPayload: { customPets: CustomPet[]; petId?: string } = {
        customPets: next
      }
      if (fallback !== s.petId) {
        ipcPayload.petId = fallback
      }
      window.api.ui.set(ipcPayload).catch(console.error)
      // Why: revoke the cached blob: URL so the Blob is released, not leaked for the session.
      revokeCustomPetBlobUrl(id)
      // Why: best-effort delete — bytes owned by main; fresh-UUID imports mean an orphaned file is never re-referenced.
      window.api.pet.delete(id, target.fileName, target.kind).catch(console.error)
      const partial: Partial<UISlice> = { customPets: next }
      if (fallback !== s.petId) {
        partial.petId = fallback
      }
      return partial
    })
})

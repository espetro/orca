// Mobile dictation session + speech model lifecycle. Owns the mobileDictation state.
import type { RuntimeSpeechModelSummary } from '../../shared/runtime-worktree-contracts'
import type { VoiceSettings } from '../../shared/speech-types'
import type { RuntimeSpeechSetupState } from '../../shared/runtime-worktree-contracts'
import { SPEECH_MODEL_CATALOG, getCatalogModel, isLocalSpeechModel } from '../speech/model-catalog'
import {
  deleteLocalSpeechModel,
  getSpeechModelDeletionErrorCode
} from '../speech/speech-model-deletion'
import { getDefaultVoiceSettings } from '../../shared/constants'
import { getSpeechModelManager, getSpeechSttService } from '../speech/speech-runtime-service'
import type { RuntimeMobileSessionFacadeCtx } from './runtime-mobile-session-facade-ctx'
export async function configureMobileDictation(
  ctx: RuntimeMobileSessionFacadeCtx,
  params: {
    enabled?: boolean
    modelId?: string
    dictationMode?: 'toggle' | 'hold'
  }
): Promise<RuntimeSpeechSetupState> {
  const store = ctx.deps.store()
  if (!store?.getSettings || !store.updateSettings) {
    throw new Error('voice_dictation_unavailable')
  }
  const current = store.getSettings().voice ?? getDefaultVoiceSettings()
  // An explicit '' clears the selected model (the OptionalString RPC schema
  // maps '' → undefined, so this only matters for direct callers); any other
  // non-empty modelId must be a known catalog entry.
  if (params.modelId !== undefined && params.modelId !== '' && !getCatalogModel(params.modelId)) {
    throw new Error('voice_model_unknown')
  }
  const nextVoice: VoiceSettings = {
    ...current,
    ...(params.enabled !== undefined ? { enabled: params.enabled } : {}),
    ...(params.modelId !== undefined ? { sttModel: params.modelId } : {}),
    ...(params.dictationMode !== undefined ? { dictationMode: params.dictationMode } : {})
  }
  ctx.deps.store()!.updateSettings?.({ voice: nextVoice }, { notifyListeners: true })
  return listMobileSpeechModels(ctx)
}

export async function startMobileDictation(
  ctx: RuntimeMobileSessionFacadeCtx,
  params: {
    dictationId: string
    modelId?: string
    clientId?: string
    connectionId?: string
  }
): Promise<{
  dictationId: string
  modelId: string
}> {
  const store = ctx.deps.store()
  if (!store) {
    throw new Error('voice_dictation_unavailable')
  }

  const voice = store.getSettings().voice ?? getDefaultVoiceSettings()
  if (!voice.enabled) {
    throw new Error('voice_dictation_disabled')
  }

  const modelId = params.modelId || voice.sttModel
  if (!modelId) {
    throw new Error('voice_model_not_selected')
  }

  const modelState = await getSpeechModelManager(store).getModelState(modelId)
  if (modelState.status !== 'ready') {
    throw new Error(`voice_model_not_ready:${modelState.status}`)
  }

  if (!params.clientId) {
    throw new Error('dictation_requires_mobile_client')
  }

  if (ctx.mobileDictation) {
    throw new Error('dictation_already_active')
  }

  const owner = `mobile:${params.dictationId}`
  ctx.mobileDictation = {
    id: params.dictationId,
    owner,
    clientId: params.clientId,
    connectionId: params.connectionId,
    state: 'starting',
    partialText: '',
    finalTexts: [],
    errors: []
  }

  try {
    await getSpeechSttService(store).startDictation(
      modelId,
      (event) => {
        const session = ctx.mobileDictation
        if (!session || session.id !== params.dictationId) {
          return
        }
        if (event.type === 'partial') {
          session.partialText = event.text ?? ''
        } else if (event.type === 'final') {
          const text = event.text?.trim()
          if (text) {
            session.finalTexts.push(text)
            session.partialText = ''
          }
        } else if (event.type === 'error') {
          session.errors.push(event.error ?? 'Speech worker error')
        }
      },
      undefined,
      owner
    )
    if (ctx.mobileDictation?.id !== params.dictationId) {
      throw new Error('dictation_canceled')
    }
    ctx.mobileDictation.state = 'active'
  } catch (error) {
    if (ctx.mobileDictation?.id === params.dictationId) {
      ctx.mobileDictation = null
    }
    throw error
  }

  return { dictationId: params.dictationId, modelId }
}

export function feedMobileDictation(
  ctx: RuntimeMobileSessionFacadeCtx,
  params: {
    dictationId: string
    audioBase64: string
    sampleRate: number
    clientId?: string
    connectionId?: string
  }
): {
  dictationId: string
} {
  const session = ctx.mobileDictation
  if (!session || session.id !== params.dictationId) {
    throw new Error('dictation_stream_not_started')
  }
  if (!params.clientId || session.clientId !== params.clientId) {
    throw new Error('dictation_owner_mismatch')
  }
  if (session.connectionId && session.connectionId !== params.connectionId) {
    throw new Error('dictation_owner_mismatch')
  }
  if (session.state !== 'active') {
    throw new Error('dictation_stream_closing')
  }
  if (session.errors.length > 0) {
    throw new Error(session.errors[0])
  }

  const pcm = Buffer.from(params.audioBase64, 'base64')
  const samples = new Float32Array(Math.floor(pcm.length / 2))
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = pcm.readInt16LE(i * 2) / 32768
  }
  getSpeechSttService(ctx.deps.store()!).feedAudio(samples, params.sampleRate, session.owner)
  return { dictationId: params.dictationId }
}

export async function finishMobileDictation(
  ctx: RuntimeMobileSessionFacadeCtx,
  params: {
    dictationId: string
    clientId?: string
    connectionId?: string
  }
): Promise<{
  dictationId: string
  text: string
}> {
  const session = ctx.mobileDictation
  if (!session || session.id !== params.dictationId) {
    throw new Error('dictation_stream_not_started')
  }
  if (!params.clientId || session.clientId !== params.clientId) {
    throw new Error('dictation_owner_mismatch')
  }
  if (session.connectionId && session.connectionId !== params.connectionId) {
    throw new Error('dictation_owner_mismatch')
  }
  session.state = 'closing'
  try {
    await getSpeechSttService(ctx.deps.store()!).stopDictation(session.owner)
    if (session.errors.length > 0) {
      throw new Error(session.errors[0])
    }
    const text = [...session.finalTexts, session.partialText].join(' ').trim()
    return { dictationId: params.dictationId, text }
  } finally {
    if (ctx.mobileDictation?.id === session.id) {
      ctx.mobileDictation = null
    }
  }
}

export async function cancelMobileDictation(
  ctx: RuntimeMobileSessionFacadeCtx,
  params: {
    dictationId: string
    clientId?: string
    connectionId?: string
  }
): Promise<{ dictationId: string }> {
  const session = ctx.mobileDictation
  if (
    session?.id === params.dictationId &&
    params.clientId &&
    session.clientId === params.clientId &&
    (!session.connectionId || session.connectionId === params.connectionId)
  ) {
    session.state = 'closing'
    try {
      await getSpeechSttService(ctx.deps.store()!).stopDictation(session.owner)
    } finally {
      if (ctx.mobileDictation?.id === session.id) {
        ctx.mobileDictation = null
      }
    }
  }
  return { dictationId: params.dictationId }
}

export function cancelMobileDictationSession(
  ctx: RuntimeMobileSessionFacadeCtx,
  session: NonNullable<typeof ctx.mobileDictation>
): void {
  if (session.state === 'closing') {
    return
  }
  session.state = 'closing'
  void getSpeechSttService(ctx.deps.store()!)
    .stopDictation(session.owner)
    .finally(() => {
      if (ctx.mobileDictation?.id === session.id) {
        ctx.mobileDictation = null
      }
    })
}

export function cancelMobileDictationForConnection(
  ctx: RuntimeMobileSessionFacadeCtx,
  connectionId: string
): void {
  const session = ctx.mobileDictation
  if (!session || session.connectionId !== connectionId) {
    return
  }
  cancelMobileDictationSession(ctx, session)
}

export function cancelMobileDictationForClient(
  ctx: RuntimeMobileSessionFacadeCtx,
  clientId: string
): void {
  const session = ctx.mobileDictation
  if (!session || session.clientId !== clientId) {
    return
  }
  cancelMobileDictationSession(ctx, session)
}

export async function listMobileSpeechModels(
  ctx: RuntimeMobileSessionFacadeCtx
): Promise<RuntimeSpeechSetupState> {
  const store = ctx.deps.store()
  if (!store) {
    throw new Error('voice_dictation_unavailable')
  }
  const voice = store.getSettings().voice ?? getDefaultVoiceSettings()
  const states = await getSpeechModelManager(store).getModelStates()
  const stateById = new Map(states.map((state) => [state.id, state]))
  const models: RuntimeSpeechModelSummary[] = SPEECH_MODEL_CATALOG.map((manifest) => {
    const state = stateById.get(manifest.id)
    return {
      id: manifest.id,
      label: manifest.label,
      provider: manifest.provider === 'openai' ? 'openai' : 'local',
      sizeBytes: manifest.sizeBytes ?? null,
      recommended: manifest.recommended === true,
      status: state?.status ?? 'not-downloaded',
      progress: state?.progress ?? null
    }
  })
  return {
    enabled: voice.enabled === true,
    selectedModelId: voice.sttModel ?? '',
    dictationMode: voice.dictationMode === 'hold' ? 'hold' : 'toggle',
    models
  }
}

export async function downloadMobileSpeechModel(
  ctx: RuntimeMobileSessionFacadeCtx,
  modelId: string
): Promise<{ started: true }> {
  const store = ctx.deps.store()
  if (!store) {
    throw new Error('voice_dictation_unavailable')
  }
  const manifest = getCatalogModel(modelId)
  if (!manifest || !isLocalSpeechModel(manifest)) {
    throw new Error('voice_model_not_downloadable')
  }
  // Why: do not await — downloads run for tens of seconds; the call returns
  // immediately and mobile polls for progress/ready.
  void getSpeechModelManager(store)
    .downloadModel(modelId)
    .catch((err) => {
      console.error('[runtime] mobile speech model download failed', { modelId, err })
    })
  return { started: true }
}

export async function deleteMobileSpeechModel(
  ctx: RuntimeMobileSessionFacadeCtx,
  modelId: string
): Promise<RuntimeSpeechSetupState> {
  const store = ctx.deps.store()
  if (!store?.getSettings || !store.updateSettings) {
    throw new Error('voice_dictation_unavailable')
  }
  try {
    // The runtime store is adapted to the minimal speech settings contract used by deletion.
    await deleteLocalSpeechModel({
      store: {
        getSettings: () => store.getSettings(),
        updateSettings: (updates, options) => store.updateSettings?.(updates, options)
      },
      modelManager: getSpeechModelManager(store),
      sttService: getSpeechSttService(store),
      modelId
    })
  } catch (error) {
    throw new Error(getSpeechModelDeletionErrorCode(error) ?? 'voice_model_delete_failed')
  }
  return listMobileSpeechModels(ctx)
}

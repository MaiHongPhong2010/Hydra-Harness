/**
 * Generic pi-ai-backed implementation of the Harness LLM seam.
 *
 * Each resolution produces one **immutable** snapshot — the profiles plus a
 * `Models` collection holding the `Provider` each route built — and an
 * operation captures a whole snapshot before its first `await`. A
 * configuration change builds a *new* collection rather than mutating the one
 * in use, because `Models.streamSimple()` is lazy: it resolves the provider
 * when the stream is first consumed, which is after the credential await, so a
 * mutated collection would let a request that started under one configuration
 * finish under another — or fail with a provider that no longer exists. This is
 * what makes the seam's per-step call freeze (`llm.prepareCall()`) hold all the
 * way down: switching models mid-reply takes effect on the next step, never
 * inside the one in flight.
 *
 * A route naming a credential reference still resolves it through the harness
 * seam and passes it as the request's `apiKey` option, which pi-ai treats as
 * the highest-priority auth override — that is what keeps the fail-loud
 * reference semantics. Everything that override does not cover reaches pi-ai
 * through the collection's own auth: the credential store holds the records a
 * login wrote and a refresh rotates, and the auth context answers the ambient
 * questions a provider asks while resolving. Both are stable across snapshots,
 * so a configuration change rebuilds the collection without forgetting who is
 * signed in.
 *
 * @module hydra-llm-pi-ai/adapter
 */

import { streamWithApiKeys } from '@hydraharness/harness-llm'
import { createModels, getSupportedThinkingLevels } from '@earendil-works/pi-ai'
import type {
  Api,
  AuthContext,
  CredentialStore,
  Model,
  Models,
  ModelThinkingLevel,
  MutableModels,
  SimpleStreamOptions,
  ThinkingLevel,
} from '@earendil-works/pi-ai'
import {
  attributionHeaders,
  contentHasImage,
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
  supportsConversation,
  isGenerationRejection,
  imageAspectRatio,
} from '@hydraharness/harness-llm'
import { withHttpProxy, fetchWithHttpProxy } from '@hydraharness/harness-llm/proxy'
import { completeVideoGeneration } from './video-generation.ts'
import type {
  GenerateOptions,
  MediaGenerationOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  ReasoningEffortId as ReasoningEffortIdType,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@hydraharness/harness-llm'
import type { AttachmentStore } from '@hydraharness/harness-attachment'
import { idleWatchdog, timeoutOf } from '@hydraharness/harness-timeout'
import type { ResolvedPiAiProviderProfile } from './config.ts'
import { toPiContext } from './context.ts'
import { toStreamChunks } from './stream.ts'

/** One resolution's frozen view: the profiles and the collection built from them. */
interface PiAiSnapshot {
  /** The resolved profiles this collection was built from, used as its identity. */
  profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile>
  /** Providers for exactly those profiles; never mutated once published. */
  models: Models
}

/** Constructor options for {@link PiAiAdapter}: the two resolution hooks the plugin owns. */
export interface PiAiAdapterOptions {
  /** Current validated profiles by provider route; called once per operation. */
  profiles: () => ReadonlyMap<string, ResolvedPiAiProviderProfile>
  /**
   * Resolve the credential for one already-resolved profile; called once per
   * stream call and frozen for that call. `undefined` defers to the route's own
   * pi-ai auth, which for an installed catalog route is its provider-native
   * ambient discovery; the plugin allows that only for a profile naming no
   * credential at all, because a named reference that misses throws `LlmError`
   * `MISSING_CREDENTIAL` rather than falling back.
   */
  resolveApiKey: (provider: string, profile: ResolvedPiAiProviderProfile) => Promise<string | undefined>
  /**
   * How every collection this adapter builds resolves auth the request-level
   * `apiKey` override does not cover. Required rather than optional: a
   * collection built without them gets pi-ai's in-memory default store, which
   * is empty at every boot and discarded on every configuration change, so a
   * route whose only method is a login would report itself unconfigured on
   * every request no matter how often the human signed in.
   */
  auth: PiAiAuthInjection
  /** Resolve the optional durable attachment service at request time. */
  resolveAttachments?: () => AttachmentStore | undefined
  /**
   * Observe one assistant history message degrading to provider-neutral
   * conversion because its stored replay state is unusable by this build.
   */
  onReplayDegrade?: (detail: { provider: string; model: string; reason: string }) => void
}

/** The two auth injectables a pi-ai collection is built with. */
export interface PiAiAuthInjection {
  /** Durable storage for credentials pi-ai itself writes: logins, and the refreshes it runs under its own lock. */
  credentials: CredentialStore
  /** Ambient lookups a provider performs while resolving its own auth. */
  authContext: AuthContext
}

/** Copy profile stream knobs into pi-ai's common option vocabulary. */
function profileOptions(
  profile: ResolvedPiAiProviderProfile,
  reasoning: ModelThinkingLevel | undefined,
  apiKey: string | undefined,
): SimpleStreamOptions {
  const enabledReasoning: ThinkingLevel | undefined = reasoning === 'off' ? undefined : reasoning
  return {
    ...apiKey === undefined ? {} : { apiKey },
    ...enabledReasoning === undefined ? {} : { reasoning: enabledReasoning },
    ...profile.thinkingBudgets === undefined ? {} : { thinkingBudgets: profile.thinkingBudgets },
    ...profile.cacheRetention === undefined ? {} : { cacheRetention: profile.cacheRetention },
    ...profile.transport === undefined ? {} : { transport: profile.transport },
    ...profile.proxy === undefined ? {} : {
      // Bedrock and Codex read proxy environment from their request options;
      // SDKs using fetch are scoped by withHttpProxy() below.
      env: { HTTP_PROXY: profile.proxy, HTTPS_PROXY: profile.proxy },
    },
    ...profile.timeoutMs === undefined ? {} : { timeoutMs: profile.timeoutMs },
    ...profile.websocketConnectTimeoutMs === undefined ? {} : { websocketConnectTimeoutMs: profile.websocketConnectTimeoutMs },
    // The agent recovery layer owns visible attempts; one adapter call is one SDK attempt.
    maxRetries: 0,
  }
}

/**
 * The profile default this exact model can actually take, for DESCRIBING it.
 * A configured level the model does not support yields none rather than
 * throwing: `resolveModel` builds the model catalog, and a catalog that fails
 * takes its whole provider out of every picker — so one mis-set profile field
 * would hide every model on the route, including the ones that support the
 * level. The request path still refuses, which is where a bad configuration
 * belongs: describing what a model can do must not fail because a deployment
 * asked it for something it cannot.
 * @param model - the resolved model descriptor.
 * @param effort - the profile's configured level, if any.
 * @returns the level when this model supports it, otherwise undefined.
 */
function describableReasoningLevel(
  model: Model<Api>,
  effort: ReasoningEffortIdType | ModelThinkingLevel | undefined,
): ModelThinkingLevel | undefined {
  if (effort === undefined) return undefined
  return getSupportedThinkingLevels(model).some(level => level === effort)
    ? effort as ModelThinkingLevel
    : undefined
}

/**
 * Remove SDK-derived output caps from protocols that accept their omission.
 * Required-cap protocols keep pi-ai's model capacity and context fitting.
 * @param payload - the request assembled by the selected pi-ai protocol.
 * @param model - the model whose API determines the request fields.
 * @returns undefined to keep the modified request.
 */
function omitDefaultOutputCap(payload: unknown, model: Model<Api>): undefined {
  switch (model.api) {
    case 'openai-completions':
    case 'azure-openai-completions':
    case 'openai-responses':
    case 'azure-openai-responses':
    case 'openai-codex-responses': {
      const request = payload as { max_tokens?: number; max_completion_tokens?: number; max_output_tokens?: number }
      delete request.max_tokens
      delete request.max_completion_tokens
      delete request.max_output_tokens
      break
    }
    case 'google-generative-ai':
    case 'google-vertex': {
      const request = payload as { config: { maxOutputTokens?: number } }
      delete request.config.maxOutputTokens
      break
    }
    default:
      // Other APIs retain their protocol's output-cap requirements.
      break
  }
  return undefined
}

/** Validate an explicit Harness/profile effort without invoking pi-ai's clamp. */
function resolveReasoningLevel(
  model: Model<Api>,
  effort: ReasoningEffortIdType | ModelThinkingLevel | undefined,
): ModelThinkingLevel | undefined {
  if (effort === undefined) return undefined
  const supported = getSupportedThinkingLevels(model)
  if (supported.some(level => level === effort)) return effort as ModelThinkingLevel
  throw new LlmError(
    `pi-ai provider "${model.provider}" model "${model.id}" does not support reasoning effort "${effort}"`,
    'UNSUPPORTED_REASONING_EFFORT',
  )
}

/** Pick the cheapest reasoning mode the exact model advertises for a title. */
function resolveTitleReasoningLevel(model: Model<Api>): ModelThinkingLevel {
  const supported = getSupportedThinkingLevels(model)
  if (supported.includes('off')) return 'off'
  if (supported.includes('minimal')) return 'minimal'
  throw new LlmError(
    `pi-ai provider "${model.provider}" model "${model.id}" has no low-reasoning mode for session titles`,
    'UNSUPPORTED_REASONING_EFFORT',
  )
}

/**
 * Selectable reasoning efforts for one model, or nothing at all.
 *
 * A model that carries no reasoning metadata — every hand-declared one, and
 * every catalog model pi-ai marks as non-reasoning — is reported by pi-ai as
 * supporting the single level `off`. Passing that through would offer a control
 * that cannot do what it says: `off` is translated to *omitting* the reasoning
 * option, which for such a model is byte-for-byte the same request as naming no
 * effort — so a provider whose own default is to think would keep thinking with
 * `off` selected. Omitting `reasoning` entirely is the seam's way of saying the
 * capability is unavailable, which leaves the surface offering only the
 * provider's default.
 * @param model - the resolved model descriptor.
 * @param defaultLevel - the profile's configured effort, already validated.
 * @returns the `reasoning` field, or an empty object when none can be offered.
 */
function reasoningInfo(
  model: Model<Api>,
  defaultLevel: ModelThinkingLevel | undefined,
): Pick<LlmResolvedModelInfo, 'reasoning'> | Record<string, never> {
  if (!model.reasoning) return {}
  const levels = getSupportedThinkingLevels(model)
  return {
    reasoning: {
      efforts: levels.map(level => ({
        id: ReasoningEffortId(level),
        name: `${level.charAt(0).toUpperCase()}${level.slice(1)}`,
      })),
      ...defaultLevel === undefined ? {} : { defaultEffort: ReasoningEffortId(defaultLevel) },
    },
  }
}

/** Merge deployment headers while removing case-insensitive attribution collisions. */
function requestHeaders(headers: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const attribution = attributionHeaders()
  const reserved = new Set(Object.keys(attribution).map(name => name.toLowerCase()))
  return {
    ...Object.fromEntries(Object.entries(headers ?? {}).filter(([name]) => !reserved.has(name.toLowerCase()))),
    ...attribution,
  }
}

/**
 * pi-ai-backed multi-provider adapter. Each operation reads the current
 * profiles, so a configuration change reaches the next request without a
 * restart; model descriptors come from the collection those profiles built.
 */
export class PiAiAdapter extends LlmAdapter {
  private snapshot: PiAiSnapshot | undefined

  constructor(private readonly config: PiAiAdapterOptions) {
    super()
  }

  /**
   * The snapshot for the current profiles. Resolution memoizes its result, so
   * an unchanged configuration is recognized by identity; a changed one gets a
   * brand-new collection, leaving any snapshot an operation already captured
   * untouched for as long as that operation holds it.
   */
  private current(): PiAiSnapshot {
    const profiles = this.config.profiles()
    if (this.snapshot?.profiles === profiles) return this.snapshot
    const models: MutableModels = createModels(this.config.auth)
    for (const profile of profiles.values()) models.setProvider(profile.piProvider)
    this.snapshot = { profiles, models }
    return this.snapshot
  }

  /** The profile for one route within one snapshot, or the not-owned failure. */
  private profileOf(snapshot: PiAiSnapshot, provider: string): ResolvedPiAiProviderProfile {
    const profile = snapshot.profiles.get(provider)
    if (profile === undefined) {
      throw new LlmError(`pi-ai adapter does not own provider "${provider}"`, 'NO_ADAPTER')
    }
    return profile
  }

  /** The configured descriptor for one exact route/model pair within one snapshot. */
  private modelOf(snapshot: PiAiSnapshot, provider: string, model: string): Model<Api> {
    this.profileOf(snapshot, provider)
    const resolved = snapshot.models.getModel(provider, model)
    if (resolved === undefined) {
      throw new LlmError(`pi-ai provider "${provider}" has no configured model "${model}"`, 'UNKNOWN_MODEL')
    }
    return resolved
  }

  override providerInfo(provider: string): LlmProviderInfo {
    // The configured name, not the route key: `displayName` exists so a
    // deployment can label a route, and a label only the configuration surface
    // reads would leave every selector showing the raw key.
    return { id: provider, name: this.current().profiles.get(provider)?.displayName ?? provider }
  }

  override providerRetryPolicy(provider: string): ResolvedRetryPolicy | undefined {
    return this.current().profiles.get(provider)?.retryPolicy
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve().then(() => {
      const snapshot = this.current()
      const profile = this.profileOf(snapshot, provider)
      return snapshot.models.getModels(provider).map((model) => {
        const endpoints = profile.modelEndpoints.get(model.id)
        return {
          provider,
          id: model.id,
          name: model.name,
          inputModalities: [...model.input],
          ...endpoints === undefined ? {} : { endpoints: [...endpoints] },
        }
      })
    })
  }

  override resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    return Promise.resolve().then(() => {
      const snapshot = this.current()
      const profile = this.profileOf(snapshot, provider)
      const resolvedModel = this.modelOf(snapshot, provider, model)
      const defaultLevel = describableReasoningLevel(resolvedModel, profile.reasoning)
      // Only a cap the deployment configured is a request default; the
      // catalog's `maxTokens` sizes the model and stops there.
      const configuredMaxTokens = profile.configuredMaxTokens.get(model)
      const endpoints = profile.modelEndpoints.get(model)
      return {
        provider,
        id: model,
        name: resolvedModel.name,
        inputModalities: [...resolvedModel.input],
        ...endpoints === undefined ? {} : { endpoints: [...endpoints] },
        context: { contextWindow: resolvedModel.contextWindow },
        ...configuredMaxTokens === undefined ? {} : { defaultMaxTokens: configuredMaxTokens },
        ...reasoningInfo(resolvedModel, defaultLevel),
      }
    })
  }

  override async requestGeneration(options: MediaGenerationOptions & { provider: string; model: string }): Promise<Response> {
    if (options.body['referenceImages'] !== undefined) {
      throw new LlmError('Reference-image video generation is currently supported by Gemini Web only.', 'UNSUPPORTED_GENERATION')
    }
    const snapshot = this.current()
    const profile = this.profileOf(snapshot, options.provider)
    const model = this.modelOf(snapshot, options.provider, options.model)
    if (!profile.modelEndpoints.get(model.id)?.includes(options.endpoint)) {
      throw new LlmError(`Model ${options.provider}/${model.id} does not serve ${options.endpoint}.`, 'UNSUPPORTED_GENERATION')
    }
    const google = model.api === 'google-generative-ai'
    const xaiImage = options.endpoint === 'images/generations' && /(?:^|\/)(grok-imagine-image|grok-2-image)(?:[.-]|$)/i.test(model.id)
    const xaiVideo = options.endpoint === 'videos' && /(?:^|\/)grok-imagine-video(?:[.-]|$)/i.test(model.id)
    const chatImages = options.endpoint === 'images/generations' && !google && (
      /(?:^|\/)gemini-[a-z0-9.-]*image(?:-|$)/i.test(model.id)
      || profile.modelEndpoints.get(model.id)?.includes('chat/completions') === true
    )
    const aspectRatio = google || chatImages || xaiImage || xaiVideo ? imageAspectRatio(options.body['size']) : undefined
    if (xaiImage && ((options.body['background'] !== undefined && options.body['background'] !== 'auto')
      || ![undefined, 'auto', 'low', 'medium'].includes(options.body['quality'] as string | undefined))) throw new LlmError('xAI images support automatic backgrounds and auto, low, or medium quality.', 'UNSUPPORTED_GENERATION')
    const duration = xaiVideo && options.body['seconds'] !== undefined ? Number(options.body['seconds']) : undefined
    if (duration !== undefined && (!Number.isFinite(duration) || duration < 1 || duration > 15)) throw new LlmError('xAI video duration must be between 1 and 15 seconds.', 'INVALID_GENERATION')
    const googleVideo = google && options.endpoint === 'videos'
    if (google && !googleVideo && options.body['n'] !== undefined && options.body['n'] !== 1) {
      throw new LlmError('Gemini generateContent supports one image request; video requires a video provider endpoint.', 'UNSUPPORTED_GENERATION')
    }
    if (googleVideo && options.body['seconds'] !== undefined && ![4, 6, 8].includes(Number(options.body['seconds']))) throw new LlmError('Veo video duration must be 4, 6, or 8 seconds.', 'INVALID_GENERATION')
    const endpoint = new URL(`${model.baseUrl.replace(/\/+$/, '')}/${google ? `models/${encodeURIComponent(model.id)}:${googleVideo ? 'predictLongRunning' : 'generateContent'}` : chatImages ? 'chat/completions' : xaiVideo ? 'videos/generations' : options.endpoint}`)
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash
      || (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)))) {
      throw new LlmError('Generation baseURL must use HTTPS or loopback HTTP without credentials, query, or fragment.', 'INVALID_GENERATION_ENDPOINT')
    }
    const refs = [...profile.apiKeyEnv === undefined ? [] : [profile.apiKeyEnv], ...profile.apiKeyFallbackEnvs]
    let failure: unknown
    for (let index = 0; index < Math.max(1, refs.length); index++) {
      options.signal.throwIfAborted()
      let apiKey: string | undefined
      try {
        apiKey = await this.config.resolveApiKey(options.provider, {
          ...profile, ...refs[index] === undefined ? {} : { apiKeyEnv: refs[index] },
        })
      } catch (error: unknown) {
        if (!(error instanceof LlmError) || error.code !== 'MISSING_CREDENTIAL') throw error
        failure = error
        continue
      }
      const auth = apiKey === undefined ? (await snapshot.models.getAuth(options.provider))?.auth : undefined
      apiKey ??= auth?.apiKey
      const fields = xaiImage || xaiVideo ? {
        model: model.id, prompt: options.body['prompt'],
        ...aspectRatio === undefined ? {} : { aspect_ratio: aspectRatio },
        ...xaiImage ? { response_format: 'b64_json', ...options.body['n'] === undefined ? {} : { n: options.body['n'] },
          ...options.body['quality'] === undefined || options.body['quality'] === 'auto' ? {} : { quality: options.body['quality'] } }
          : { ...duration === undefined ? {} : { duration } },
      } : googleVideo ? {
        instances: [{ prompt: options.body['prompt'] }], parameters: {
          sampleCount: 1, ...aspectRatio === undefined ? {} : { aspectRatio },
          ...options.body['seconds'] === undefined ? {} : { durationSeconds: Number(options.body['seconds']) },
        },
      } : google ? {
        contents: [{ role: 'user', parts: [{ text: options.body['prompt'] }] }],
        generationConfig: { responseModalities: ['IMAGE'], ...aspectRatio === undefined ? {} : { imageConfig: { aspectRatio } } },
      } : chatImages ? {
        model: model.id, stream: false,
        messages: [{ role: 'user', content: options.body['prompt'] }],
        modalities: ['image', 'text'],
        ...options.body['n'] === undefined ? {} : { n: options.body['n'] },
        ...aspectRatio === undefined ? {} : { image_config: { aspect_ratio: aspectRatio } },
      } : { ...options.body, model: model.id }
      const form = options.endpoint === 'videos' && !xaiVideo && !googleVideo ? new FormData() : undefined
      if (form !== undefined) {
        for (const [key, value] of Object.entries(fields)) {
          if (typeof value !== 'string' && typeof value !== 'number') throw new LlmError(`Video field ${key} must be text or a number.`, 'INVALID_GENERATION')
          form.set(key, typeof value === 'number' ? String(value) : value)
        }
      }
      const response = await fetchWithHttpProxy(endpoint, {
        method: 'POST', redirect: 'error', signal: options.signal,
        headers: {
          ...requestHeaders(profile.headers),
          ...auth?.headers,
          ...form === undefined ? { 'Content-Type': 'application/json' } : {},
          ...apiKey === undefined ? {} : google ? { 'x-goog-api-key': apiKey } : { Authorization: `Bearer ${apiKey}` },
        },
        body: form ?? JSON.stringify(fields),
      }, profile.proxy)
      if (options.endpoint === 'videos' && response.ok && options.pollIntervalMs !== undefined) {
        const headers = {
          ...requestHeaders(profile.headers), ...auth?.headers,
          ...apiKey === undefined ? {} : google ? { 'x-goog-api-key': apiKey } : { Authorization: `Bearer ${apiKey}` },
        }
        return completeVideoGeneration(response, { protocol: google ? 'google' : xaiVideo ? 'xai' : 'openai', baseURL: model.baseUrl },
          (url, authenticated) => fetchWithHttpProxy(url, { method: 'GET', redirect: 'manual', signal: options.signal, ...authenticated ? { headers } : {} }, profile.proxy),
          { ...options, pollIntervalMs: options.pollIntervalMs })
      }
      if (xaiImage && response.ok) return this.normalizeXaiImages(response, options)
      if (!isGenerationRejection(response.status) || index + 1 >= refs.length) return response
      await response.body?.cancel()
    }
    throw failure
  }

  private async normalizeXaiImages(response: Response, options: MediaGenerationOptions): Promise<Response> {
    if (response.body === null) throw new LlmError('xAI image response has no body.', 'MALFORMED_RESPONSE')
    let count = 0
    const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(bytes, controller) {
      count += bytes.byteLength
      if (count > options.maxResponseBytes) throw new LlmError('xAI image response exceeds maxResponseBytes.', 'MALFORMED_RESPONSE')
      controller.enqueue(bytes)
    } }))
    const payload: unknown = await new Response(body).json()
    const data = typeof payload === 'object' && payload !== null && 'data' in payload ? payload.data : undefined
    if (!Array.isArray(data) || data.length === 0) throw new LlmError('xAI returned no inline images.', 'MALFORMED_RESPONSE')
    const parts = data.map((entry: unknown) => {
      const encoded = typeof entry === 'object' && entry !== null && 'b64_json' in entry ? entry.b64_json : undefined
      if (typeof encoded !== 'string' || encoded === '') throw new LlmError('xAI returned an invalid inline image.', 'MALFORMED_RESPONSE')
      const bytes = Buffer.from(encoded.slice(0, 24), 'base64')
      const mimeType = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png'
        : bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255])) ? 'image/jpeg'
          : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP' ? 'image/webp' : undefined
      if (mimeType === undefined) throw new LlmError('xAI returned an unsupported image format.', 'MALFORMED_RESPONSE')
      return { inlineData: { mimeType, data: encoded } }
    })
    options.signal.throwIfAborted()
    return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts } }] })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.stop !== undefined) {
      throw new LlmError('llm-pi-ai does not support GenerateOptions.stop', 'UNSUPPORTED_OPTION')
    }
    // One capture per stream call, taken before any await: the profile, the
    // model descriptor, and the collection all come from the same immutable
    // snapshot, and the credential freezes with them. A configuration change
    // mid-request builds a separate snapshot, so this request finishes under
    // the one it started with and the next call picks up the new one.
    const snapshot = this.current()
    const profile = this.profileOf(snapshot, options.provider)
    if (!supportsConversation(profile.modelEndpoints.get(options.model))) {
      throw new LlmError(`Model ${options.provider}/${options.model} requires a generation tool, not conversation streaming.`, 'UNSUPPORTED_MODEL_ENDPOINT')
    }
    const refs = [...profile.apiKeyEnv === undefined ? [] : [profile.apiKeyEnv], ...profile.apiKeyFallbackEnvs]
    yield* streamWithApiKeys(options, Math.max(1, refs.length), index => this.streamAttempt(options, snapshot, {
      ...profile, ...refs[index] === undefined ? {} : { apiKeyEnv: refs[index] },
    }))
  }

  private async * streamAttempt(
    options: GenerateOptions,
    snapshot: PiAiSnapshot,
    profile: ResolvedPiAiProviderProfile,
  ): AsyncIterable<StreamChunk> {
    const model = this.modelOf(snapshot, options.provider, options.model)
    const reasoning = options.purpose === 'session-title'
      ? resolveTitleReasoningLevel(model)
      : resolveReasoningLevel(model, options.reasoningEffort ?? profile.reasoning)
    const apiKey = await this.config.resolveApiKey(options.provider, profile)

    const consumer = new AbortController()
    const upstream = options.signal === undefined
      ? consumer.signal
      : AbortSignal.any([options.signal, consumer.signal])
    const streamIdleTimeoutMs = profile.streamIdleTimeoutMs
    using watchdog = idleWatchdog(upstream, streamIdleTimeoutMs, 'LLM_STREAM_IDLE_TIMEOUT')

    try {
      const containsImage = options.messages.some(message => contentHasImage(message.content))
      if (containsImage && !model.input.includes('image')) {
        throw new LlmError(`pi-ai model "${model.id}" does not support image input`, 'UNSUPPORTED_CONTENT')
      }
      const attachments = containsImage ? this.config.resolveAttachments?.() : undefined
      if (containsImage && attachments === undefined) {
        throw new LlmError('pi-ai image input requires the durable attachment service', 'UNSUPPORTED_CONTENT')
      }
      const onReplayDegrade = (reason: string): void => {
        this.config.onReplayDegrade?.({ provider: options.provider, model: options.model, reason })
      }
      const context = attachments === undefined
        ? toPiContext(options, undefined, onReplayDegrade)
        : await toPiContext(options, attachments, onReplayDegrade, profile.maxRequestImageBytes)
      // pi-ai starts its lazy setup synchronously here. Keep that setup in the
      // route context so an SDK that captures fetch during client creation
      // inherits this profile's proxy for the whole request.
      const streamOptions = {
        ...profileOptions(profile, reasoning, apiKey),
        ...options.temperature === undefined ? {} : { temperature: options.temperature },
        ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
        ...options.maxTokens === undefined ? { onPayload: omitDefaultOutputCap } : {},
        ...options.sessionId === undefined ? {} : { sessionId: String(options.sessionId) },
        signal: watchdog.signal,
        // Profile headers are deployment-owned; attribution names are
        // Harness-owned and therefore win collisions.
        headers: requestHeaders(profile.headers),
      }
      const events = withHttpProxy(profile.proxy, () => {
        // pi-ai's simple Codex adapter omits reasoning for `off`, while the
        // Codex endpoint defaults omitted reasoning to model-selected effort.
        // Its typed API exposes `none`, so use that explicit control for titles.
        if (options.purpose === 'session-title'
          && model.api === 'openai-codex-responses'
          && reasoning === 'off') {
          return snapshot.models.stream(model, context, {
            ...streamOptions,
            reasoningEffort: 'none',
            reasoningSummary: 'off',
          })
        }
        return snapshot.models.streamSimple(model, context, streamOptions)
      })
      const iterator = toStreamChunks(events, model.contextWindow)[Symbol.asyncIterator]()
      let exhausted = false
      try {
        while (true) {
          const result = await watchdog.next(iterator)
          const timeout = timeoutOf(watchdog.signal, 'LLM_STREAM_IDLE_TIMEOUT')
          if (timeout !== undefined) throw timeout
          if (result.done) {
            exhausted = true
            return
          }
          yield result.value
        }
      } finally {
        if (!exhausted) {
          consumer.abort('pi-ai stream consumer stopped')
          try {
            await iterator.return(undefined)
          } catch (_abortedSdkTeardown) {
            // The stable signal already owns SDK termination; return-time abort cannot add an outcome.
          }
        }
      }
    } catch (error: unknown) {
      if (timeoutOf(watchdog.signal, 'LLM_STREAM_IDLE_TIMEOUT') !== undefined) {
        throw new LlmError(`pi-ai stream idle timeout after ${streamIdleTimeoutMs}ms`, 'TIMEOUT', { cause: error })
      }
      if (options.signal?.aborted) {
        throw new LlmError('pi-ai request aborted by caller', 'ABORTED', { cause: error })
      }
      throw error
    } finally {
      consumer.abort('pi-ai stream consumer stopped')
    }
  }
}

/** Account-aware LLM adapters for native SDK and Antigravity routes. */

import type { Credential } from '@earendil-works/pi-ai'
import type { AntigravityCredentials } from './antigravity-oauth.ts'
import { chatGptCredential, discoverChatGptModels, requestChatGptImage } from './chatgpt.ts'
import { emptyAuthContext, type AccountPool } from './accounts.ts'
import { ACCOUNT_PROVIDER_LABELS, type AccountModelProfile, type AccountProviderProfile, type AccountProvider } from './config.ts'
import {
  deepFreeze,
  freezeMessage,
  LlmAdapter,
  LlmError,
  inferModelEndpoints,
  isGenerationRejection,
  type GenerateOptions,
  type LlmDiscoveredModel,
  type LlmFailure,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type Message,
  type MediaGenerationOptions,
  type ResolvedRetryPolicy,
  type StreamChunk,
  resolveRetryPolicy,
} from '@hydraharness/harness-llm'
import type { PiAiAdapter, ResolvedPiAiProviderProfile } from '@hydraharness/harness-llm-pi-ai'

/** A provider profile lookup that follows live settings changes. */
export type AccountProfileLookup = () => AccountProviderProfile | undefined

/** Inputs for a native pi-ai account adapter. */
export interface PiAiAccountAdapterOptions {
  /** Native account route bound to every request and credential operation. */
  provider: 'chatgpt' | import('./sdk-accounts.ts').SdkAccountProvider
  /** Pool owning the selected account and pi-ai credential store. */
  pool: AccountPool
  /** Current resolved native pi-ai profile. */
  profile: () => ResolvedPiAiProviderProfile | undefined
  /** Build the current profile on first model use. */
  loadProfile?: () => Promise<ResolvedPiAiProviderProfile | undefined>
  /** Resolve the optional durable attachment service. */
  resolveAttachments?: () => import('@hydraharness/harness-attachment').AttachmentStore | undefined
}

/** Inputs for the Antigravity account adapter. */
export interface AntigravityAdapterOptions {
  /** Pool owning the selected account. */
  pool: AccountPool
  /** Current settings profile. */
  profile: AccountProfileLookup
  /** Resolve the optional durable attachment service. */
  resolveAttachments?: () => import('@hydraharness/harness-attachment').AttachmentStore | undefined
}

function visible(chunk: StreamChunk): boolean {
  return chunk.type === 'text-delta'
    || chunk.type === 'reasoning-delta'
    || chunk.type === 'tool-call-delta'
}

function accountCredential(value: Credential | undefined): AntigravityCredentials | undefined {
  if (value?.type !== 'oauth') return undefined
  const candidate = value as Credential & Partial<AntigravityCredentials>
  if (typeof candidate.access !== 'string' || candidate.access.length === 0
    || typeof candidate.refresh !== 'string' || candidate.refresh.length === 0
    || typeof candidate.expires !== 'number' || !Number.isFinite(candidate.expires)
    || typeof candidate.projectId !== 'string' || candidate.projectId.length === 0) return undefined
  return {
    access: candidate.access,
    refresh: candidate.refresh,
    expires: candidate.expires,
    projectId: candidate.projectId,
    ...(typeof candidate.email === 'string' && candidate.email.length > 0 ? { email: candidate.email } : {}),
  }
}

function thrownCode(error: unknown): unknown {
  if (typeof error !== 'object' || error === null) return undefined
  return (error as { code?: unknown }).code
}

function abortIfNeeded(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new LlmError('Model request canceled', 'ABORTED', { cause: signal.reason })
  }
}

function antigravityOAuthOptions(profile: AccountProviderProfile): {
  callbackPort?: number
  callbackPath?: string
  onboardingAttempts?: number
  onboardingDelayMs?: number
} {
  return {
    ...(profile.callbackPort === undefined ? {} : { callbackPort: profile.callbackPort }),
    ...(profile.callbackPath === undefined ? {} : { callbackPath: profile.callbackPath }),
    ...(profile.onboardingAttempts === undefined ? {} : { onboardingAttempts: profile.onboardingAttempts }),
    ...(profile.onboardingDelayMs === undefined ? {} : { onboardingDelayMs: profile.onboardingDelayMs }),
  }
}

/* jscpd:ignore-start -- account routing reuses the core replay sanitization intentionally. */
function withoutAccountReplay(options: GenerateOptions): GenerateOptions {
  const messages = options.messages.map((message): Message => {
    const source = message.source
    if (message.role !== 'assistant' || source.kind !== 'model' || source.replayState === undefined) return message
    return freezeMessage({
      ...message,
      source: { kind: 'model', provider: source.provider, model: source.model },
    })
  })
  if (messages.every((message, index) => message === options.messages[index])) return options
  const filtered = { ...options, messages }
  return Object.isFrozen(options) ? deepFreeze(filtered) : filtered
}
/* jscpd:ignore-end */

/**
 * Run one account order and retry only failures seen before visible output.
 * The order is captured once for this adapter call, so every account is tried
 * at most once before the caller's normal request-recovery policy runs.
 * @param options - captured model request and cancellation.
 * @param provider - account route owning the pool.
 * @param pool - request-local account selector.
 * @param source - one account's native stream.
 * @returns the first completed stream, without retrying after visible output.
 */
export async function* streamAccounts(
  options: GenerateOptions,
  provider: AccountProvider,
  pool: AccountPool,
  source: (accountId: string, options: GenerateOptions) => AsyncIterable<StreamChunk>,
): AsyncGenerator<StreamChunk> {
  const order = await pool.selector.ordered(provider)
  if (order.length === 0) throw new LlmError(`${provider} has no connected account`, 'MISSING_CREDENTIAL')
  // Account rotation is request-local and the next request may select a
  // different identity. Provider replay ids and signatures belong to the
  // account that produced them, so never carry that opaque state into an
  // account-backed request.
  const accountOptions = withoutAccountReplay(options)
  let lastFailure: LlmFailure | undefined
  let lastThrown: unknown
  for (const entry of order) {
    const attemptOptions = accountOptions
    if (attemptOptions.signal?.aborted) throw new LlmError('Model request canceled', 'ABORTED', { cause: attemptOptions.signal.reason })
    let emitted = false
    let finished = false
    let retry = false
    const buffered: StreamChunk[] = []
    try {
      for await (const chunk of pool.selector.stream(provider, entry.id, () => source(entry.id, attemptOptions))) {
        attemptOptions.signal?.throwIfAborted()
        if (chunk.type === 'finish') {
          finished = true
          if (chunk.reason.kind === 'aborted') {
            for (const held of buffered) yield held
            yield chunk
            return
          }
          if (chunk.reason.kind === 'error' && !emitted) {
            lastFailure = chunk.reason.failure
            retry = true
            break
          }
        }
        if (!emitted && visible(chunk)) {
          emitted = true
          for (const held of buffered) yield held
          buffered.length = 0
        }
        if (emitted) yield chunk
        else buffered.push(chunk)
      }
    } catch (error: unknown) {
      if (attemptOptions.signal?.aborted || thrownCode(error) === 'ABORTED') throw error
      if (emitted) throw error
      // A later account's thrown failure is the final outcome. Do not let a
      // prior account's provider finish mask it with a synthetic finish.
      lastFailure = undefined
      lastThrown = error
      retry = true
    }
    if (retry) continue
    if (!finished) {
      if (emitted) throw new LlmError(`${provider} stream ended without a finish chunk`, 'STREAM_CLOSED')
      lastFailure = undefined
      lastThrown = new LlmError(`${provider} stream ended without a finish chunk`, 'STREAM_CLOSED')
      continue
    }
    for (const held of buffered) yield held
    return
  }
  if (lastFailure !== undefined) {
    yield { type: 'finish', reason: { kind: 'error', failure: lastFailure } }
    return
  }
  if (lastThrown instanceof Error) throw lastThrown
  if (lastThrown !== undefined) {
    throw new LlmError(`${provider} account request failed`, 'TRANSPORT', { cause: lastThrown })
  }
  throw new LlmError(`${provider} account request failed`, 'TRANSPORT')
}

/** pi-ai adapter that binds every request to one native subscription account. */
export class PiAiAccountAdapter extends LlmAdapter {
  private delegatePromise: Promise<PiAiAdapter> | undefined
  private loadedProfile: ResolvedPiAiProviderProfile | undefined
  private profilePromise: Promise<ResolvedPiAiProviderProfile | undefined> | undefined

  constructor(private readonly config: PiAiAccountAdapterOptions) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: ACCOUNT_PROVIDER_LABELS[this.config.provider] }
  }

  override providerRetryPolicy(provider: string): ResolvedRetryPolicy | undefined {
    const profile = this.config.profile() ?? this.loadedProfile
    return profile?.provider === provider ? profile.retryPolicy : undefined
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const delegate = await this.ensureDelegate()
    return delegate.listModels(provider)
  }

  /**
   * Fetch the selected account's native catalog in the discovery seam's detached form.
   * @param signal - optional cancellation for catalog resolution.
   * @returns model metadata suitable for the LLM discovery seam.
   */
  async discoverModels(signal?: AbortSignal): Promise<LlmDiscoveredModel[]> {
    signal?.throwIfAborted()
    const accounts = await this.config.pool.accounts.list()
    const account = accounts[0]
    if (account === undefined) throw new LlmError(`${this.config.provider} has no connected account`, 'MISSING_CREDENTIAL')
    if (this.config.provider !== 'chatgpt') {
      const { discoverSdkAccountModels } = await import('./sdk-accounts.ts')
      return discoverSdkAccountModels(this.config.provider, this.config.pool, await this.ensureProfile(), signal)
    }
    return this.config.pool.withAccount(account.id, async () => {
      signal?.throwIfAborted()
      const profile = await this.ensureProfile()
      const stored = await chatGptCredential(this.config.pool, profile, signal)
      return discoverChatGptModels({
        accessToken: stored.access,
        accountId: stored.accountId,
        ...profile.baseURL === undefined ? {} : { baseURL: profile.baseURL },
        ...(signal === undefined ? {} : { signal }),
      })
    })
  }

  override async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const delegate = await this.ensureDelegate()
    return delegate.resolveModel(provider, model, signal)
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const delegate = await this.ensureDelegate()
    yield* streamAccounts(options, this.config.provider, this.config.pool, (_accountId, attemptOptions) => delegate.stream(attemptOptions))
  }

  override async requestGeneration(options: MediaGenerationOptions & { provider: string; model: string }): Promise<Response> {
    const delegate = await this.ensureDelegate()
    const accounts = await this.config.pool.selector.ordered(this.config.provider)
    let lastFailure: LlmError | undefined
    for (const [index, account] of accounts.entries()) {
      options.signal.throwIfAborted()
      let response: Response
      try { response = await this.config.pool.withAccount(account.id, async () => {
        const credential = await this.config.pool.credentials.read(this.config.provider)
        if (credential?.type !== 'oauth') throw new LlmError(`${this.config.provider} account has no OAuth grant.`, 'MISSING_CREDENTIAL')
        return this.config.provider === 'chatgpt'
          ? requestChatGptImage(options, this.config.pool, await this.ensureProfile())
          : delegate.requestGeneration(options)
      }) } catch (error: unknown) {
        if (options.signal.aborted || !(error instanceof LlmError) || !['MISSING_CREDENTIAL', 'INVALID_CREDENTIAL', 'ACCOUNT_GONE'].includes(error.code)) throw error
        lastFailure = error
        continue
      }
      if (!isGenerationRejection(response.status) || index + 1 === accounts.length) return response
      await response.body?.cancel()
    }
    if (lastFailure !== undefined) throw lastFailure
    throw new LlmError(`${this.config.provider} has no connected account`, 'MISSING_CREDENTIAL')
  }

  private async ensureProfile(): Promise<ResolvedPiAiProviderProfile> {
    const current = this.config.profile()
    if (current !== undefined) {
      this.loadedProfile = current
      return current
    }
    if (this.config.loadProfile === undefined) {
      throw new LlmError(`${this.config.provider} account route has no profile`, 'NO_ADAPTER')
    }
    this.profilePromise ??= this.config.loadProfile()
    const loaded = await this.profilePromise
    if (loaded === undefined) throw new LlmError(`${this.config.provider} account route has no profile`, 'NO_ADAPTER')
    this.loadedProfile = loaded
    return loaded
  }

  private async ensureDelegate(): Promise<PiAiAdapter> {
    await this.ensureProfile()
    this.delegatePromise ??= import('@hydraharness/harness-llm-pi-ai').then(({ PiAiAdapter }) => new PiAiAdapter({
      profiles: () => {
        const profile = this.config.profile() ?? this.loadedProfile
        /* v8 ignore next -- ensureProfile stores a profile before creating the delegate and loadedProfile is never cleared. */
        return profile === undefined
          ? new Map<string, ResolvedPiAiProviderProfile>()
          : new Map([[profile.provider, profile]])
      },
      resolveApiKey: () => Promise.resolve(undefined),
      auth: { credentials: this.config.pool.credentials, authContext: emptyAuthContext },
      ...(this.config.resolveAttachments === undefined
        ? {}
        : { resolveAttachments: this.config.resolveAttachments }),
    }))
    return this.delegatePromise
  }
}

/** Direct native Antigravity adapter bound to the selected account pool. */
export class AntigravityAccountAdapter extends LlmAdapter {
  private nativeModulePromise: Promise<typeof import('./antigravity.ts')> | undefined
  private catalog?: {
    profile: AccountProviderProfile
    accountId: string
    models: readonly AntigravityCatalogModel[]
  }
  private catalogPromise?: {
    profile: AccountProviderProfile
    accountId: string
    promise: Promise<readonly AntigravityCatalogModel[]>
  } | undefined

  constructor(private readonly config: AntigravityAdapterOptions) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Google Antigravity' }
  }

  override providerRetryPolicy(provider: string): ResolvedRetryPolicy | undefined {
    const profile = this.config.profile()
    if (profile === undefined) return undefined
    return resolveRetryPolicy(profile.retryPolicy, `llm-account-auth: ${provider} retryPolicy`)
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const models = await this.models()
    return models.map(model => ({
      provider,
      id: model.id,
      name: model.name,
      ...model.endpoints === undefined ? {} : { endpoints: [...model.endpoints] },
      ...(model.supportsImages === undefined
        ? {}
        : { inputModalities: model.supportsImages ? ['text', 'image'] as const : ['text'] as const }),
    }))
  }

  /**
   * Return the account-authenticated Antigravity catalog, independent of saved model selections.
   * @param signal - optional cancellation for account refresh and discovery.
   * @returns model metadata suitable for the LLM discovery seam.
   */
  async discoverModels(signal?: AbortSignal): Promise<LlmDiscoveredModel[]> {
    const models = await this.models(signal, false)
    signal?.throwIfAborted()
    return models.map(model => ({
      id: model.id,
      name: model.name,
      ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
      ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
      ...model.endpoints === undefined ? {} : { endpoints: [...model.endpoints] },
    }))
  }

  override async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const known = (await this.models(signal)).find(candidate => candidate.id === model)
    const endpoints = known?.endpoints ?? inferModelEndpoints(model)
    return {
      provider,
      id: model,
      name: known?.name ?? model,
      ...endpoints === undefined ? {} : { endpoints: [...endpoints] },
      ...(known?.supportsImages === undefined
        ? {}
        : { inputModalities: known.supportsImages ? ['text', 'image'] as const : ['text'] as const }),
      ...(known?.contextWindow === undefined ? {} : { context: { contextWindow: known.contextWindow } }),
      ...(known?.maxTokens === undefined ? {} : { defaultMaxTokens: known.maxTokens }),
    }
  }

  override async requestGeneration(options: MediaGenerationOptions & { provider: string; model: string }): Promise<Response> {
    const profile = this.config.profile()
    if (profile === undefined) throw new LlmError('Antigravity account route has no profile', 'NO_ADAPTER')
    const { AntigravityAdapter } = await this.nativeModule()
    const accounts = await this.config.pool.selector.ordered('antigravity')
    let failure: LlmError | undefined
    for (const [index, account] of accounts.entries()) {
      options.signal.throwIfAborted()
      const delegate = new AntigravityAdapter({
        resolveCredentials: () => this.selectedCredentials(account.id, profile, options.signal),
        ...profile.endpoint === undefined ? {} : { endpoint: profile.endpoint },
      })
      let response: Response
      try {
        response = await delegate.requestGeneration(options)
      } catch (error: unknown) {
        options.signal.throwIfAborted()
        if (!(error instanceof LlmError) || error.code !== 'MISSING_CREDENTIAL') throw error
        failure = error
        continue
      }
      if (!isGenerationRejection(response.status) || index + 1 === accounts.length) return response
      await response.body?.cancel()
    }
    throw failure ?? new LlmError('Google Antigravity has no connected account', 'MISSING_CREDENTIAL')
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const profile = this.config.profile()
    if (profile === undefined) throw new LlmError('Antigravity account route has no profile', 'NO_ADAPTER')
    yield* streamAccounts(options, 'antigravity', this.config.pool,
      (accountId, attemptOptions) => this.streamAccount(attemptOptions, profile, accountId))
  }

  private async *streamAccount(
    options: GenerateOptions,
    profile: AccountProviderProfile,
    accountId: string,
  ): AsyncIterable<StreamChunk> {
    const credentials = await this.selectedCredentials(accountId, profile, options.signal)
    const { AntigravityAdapter } = await this.nativeModule()
    const delegate = new AntigravityAdapter({
      resolveCredentials: () => Promise.resolve(credentials),
      ...(profile.models === undefined ? {} : { models: profile.models }),
      ...(profile.endpoint === undefined ? {} : { endpoint: profile.endpoint }),
      ...(profile.streamIdleTimeoutMs === undefined ? {} : { streamIdleTimeoutMs: profile.streamIdleTimeoutMs }),
      ...(this.config.resolveAttachments === undefined
        ? {}
        : { resolveAttachments: this.config.resolveAttachments }),
    })
    yield* delegate.stream(options)
  }

  private async models(
    signal?: AbortSignal,
    useConfigured = true,
  ): Promise<readonly AntigravityCatalogModel[]> {
    const profile = this.config.profile()
    if (profile === undefined) throw new LlmError('Antigravity account route has no profile', 'NO_ADAPTER')
    if (useConfigured && profile.models !== undefined) return profile.models.map((model) => {
      const endpoints = model.endpoints ?? inferModelEndpoints(model.id)
      return { ...model, name: model.name ?? model.id, ...endpoints === undefined ? {} : { endpoints: [...endpoints] } }
    })
    const accounts = await this.config.pool.accounts.list()
    const account = accounts[0]
    if (account === undefined) return []
    if (this.catalog?.profile === profile && this.catalog.accountId === account.id) return this.catalog.models
    const pending = this.catalogPromise
    if (pending?.profile === profile && pending.accountId === account.id) return pending.promise
    const promise = this.discover(profile, account.id, signal)
    const pendingState = { profile, accountId: account.id, promise }
    this.catalogPromise = pendingState
    try {
      const models = await promise
      if (this.config.profile() === profile) this.catalog = { profile, accountId: account.id, models }
      return models
    } finally {
      if (this.catalogPromise === pendingState) this.catalogPromise = undefined
    }
  }

  private async discover(
    profile: AccountProviderProfile,
    accountId: string,
    signal?: AbortSignal,
  ): Promise<readonly AntigravityCatalogModel[]> {
    const credentials = await this.selectedCredentials(accountId, profile, signal)
    const { discoverAntigravityModels } = await this.nativeModule()
    const models = await discoverAntigravityModels({
      accessToken: credentials.access,
      projectId: credentials.projectId,
      ...(signal === undefined ? {} : { signal }),
      ...(profile.endpoint === undefined ? {} : { endpoint: profile.endpoint }),
    })
    return models
      .filter(model => !model.internal)
      .map(model => ({
        id: model.id,
        name: model.name,
        ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
        ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
        supportsImages: model.supportsImages,
        supportsThinking: model.supportsThinking,
        ...model.endpoints === undefined ? {} : { endpoints: [...model.endpoints] },
      }))
  }

  private async selectedCredentials(
    accountId: string,
    profile: AccountProviderProfile,
    signal?: AbortSignal,
  ): Promise<AntigravityCredentials> {
    const { refreshAntigravity } = await import('./antigravity-oauth.ts')
    return this.config.pool.withAccount(accountId, async () => {
      abortIfNeeded(signal)
      let selected: AntigravityCredentials | undefined
      await this.config.pool.credentials.modify('antigravity', async (current) => {
        abortIfNeeded(signal)
        if (current?.type === 'oauth' && current.quotaProjectId !== undefined) {
          const { googleCredential, refreshGoogle } = await import('./google-oauth.ts')
          const shared = googleCredential(current)
          if (shared.expires > Date.now()) { selected = shared; return undefined }
          const deadline = AbortSignal.timeout(profile.timeoutMs ?? 30_000)
          const bounded = signal === undefined ? deadline : AbortSignal.any([signal, deadline])
          const refreshed = await refreshGoogle(shared, bounded)
          bounded.throwIfAborted()
          selected = refreshed
          return refreshed
        }
        const credentials = accountCredential(current)
        if (credentials === undefined) {
          throw new LlmError(`antigravity account "${accountId}" has invalid credentials`, 'INVALID_CREDENTIAL')
        }
        if (credentials.expires > Date.now()) {
          selected = credentials
          return undefined
        }
        const refreshed = await refreshAntigravity(credentials, antigravityOAuthOptions(profile), signal)
        abortIfNeeded(signal)
        selected = refreshed
        return { type: 'oauth', ...refreshed }
      })
      if (selected === undefined) {
        throw new LlmError(`antigravity account "${accountId}" has no credentials`, 'MISSING_CREDENTIAL')
      }
      return selected
    })
  }

  private async nativeModule(): Promise<typeof import('./antigravity.ts')> {
    this.nativeModulePromise ??= import('./antigravity.ts')
    return this.nativeModulePromise
  }
}

interface AntigravityCatalogModel extends AccountModelProfile {
  name: string
  supportsImages?: boolean
  supportsThinking?: boolean
}

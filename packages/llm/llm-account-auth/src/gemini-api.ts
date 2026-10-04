/** Gemini API OAuth catalog, OpenAI-compatible conversation streams, and native image requests. */
import type { Provider } from '@earendil-works/pi-ai'
import type { AttachmentStore } from '@hydraharness/harness-attachment'
import { LlmAdapter, LlmError, imageAspectRatio, inferModelEndpoints, isGenerationRejection, resolveRetryPolicy,
  type GenerateOptions, type LlmDiscoveredModel, type LlmModelInfo, type LlmProviderInfo,
  type LlmResolvedModelInfo, type MediaGenerationOptions, type StreamChunk } from '@hydraharness/harness-llm'
import { PiAiAdapter, resolveProfiles, type ResolvedPiAiProviderProfile } from '@hydraharness/harness-llm-pi-ai'
import { emptyAuthContext, type AccountPool } from './accounts.ts'
import { streamAccounts } from './adapter.ts'
import { ACCOUNT_PROVIDER_LABELS, type AccountProviderProfile } from './config.ts'
import { googleCredential, refreshGoogle, selectedGoogleCredential } from './google-oauth.ts'
import { accountJson } from './json-response.ts'

const PROVIDER = 'gemini-api'
const DEFAULT_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta'

function baseURL(profile: AccountProviderProfile): string {
  return (profile.endpoint ?? DEFAULT_ENDPOINT).replace(/\/+$/, '')
}

function requestSignal(profile: AccountProviderProfile, signal?: AbortSignal): AbortSignal {
  const deadline = AbortSignal.timeout(profile.timeoutMs ?? 30_000)
  return signal === undefined ? deadline : AbortSignal.any([signal, deadline])
}

function modelRow(value: unknown): LlmDiscoveredModel {
  if (typeof value !== 'object' || value === null || !('name' in value)
    || typeof value.name !== 'string' || !/^models\/[a-zA-Z0-9._-]+$/.test(value.name)) {
    throw new LlmError('Gemini API returned an invalid model resource.', 'DISCOVERY_FAILED')
  }
  const row = value as Record<string, unknown>
  const id = value.name.slice('models/'.length)
  const methods = row['supportedGenerationMethods']
  if (methods !== undefined && (!Array.isArray(methods) || methods.some(method => typeof method !== 'string' || !/^[A-Za-z][A-Za-z0-9]*$/.test(method)))) {
    throw new LlmError('Gemini API returned invalid generation methods.', 'DISCOVERY_FAILED')
  }
  const hints = inferModelEndpoints(id)
  const endpoints = hints ?? (Array.isArray(methods) ? methods.map((method: string) => method === 'generateContent' ? 'chat/completions'
    : method === 'predictLongRunning' ? 'videos' : method === 'predict' ? 'images/generations' : method) : undefined)
  const capacity = (field: string): number | undefined => {
    const result = row[field]
    return typeof result === 'number' && Number.isSafeInteger(result) && result > 0 ? result : undefined
  }
  const contextWindow = capacity('inputTokenLimit')
  const maxTokens = capacity('outputTokenLimit')
  return { id,
    ...typeof row['displayName'] === 'string' && row['displayName'].trim() !== '' ? { name: row['displayName'] } : {},
    ...contextWindow === undefined ? {} : { contextWindow },
    ...maxTokens === undefined ? {} : { maxTokens },
    ...endpoints === undefined || endpoints.length === 0 ? {} : { endpoints: [...new Set(endpoints)] } }
}

/** Gemini Developer API route sharing its Host Google grant with Antigravity. */
export class GeminiApiAccountAdapter extends LlmAdapter {
  private delegatePromise: Promise<PiAiAdapter> | undefined

  constructor(private readonly pool: AccountPool, private readonly profile: AccountProviderProfile,
    private readonly resolveAttachments?: () => AttachmentStore | undefined) { super() }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: ACCOUNT_PROVIDER_LABELS[PROVIDER] }
  }

  /**
   * Fetch every models.list page with a refreshed bearer grant and quota project.
   * @param signal - catalog cancellation.
   * @returns live metadata without editing the configured catalog.
   */
  async discoverModels(signal?: AbortSignal): Promise<LlmDiscoveredModel[]> {
    const bounded = requestSignal(this.profile, signal)
    const account = (await this.pool.accounts.list())[0]
    if (account === undefined) throw new LlmError('Google Gemini API has no connected account.', 'MISSING_CREDENTIAL')
    return this.pool.withAccount(account.id, async () => {
      const grant = await selectedGoogleCredential(this.pool, PROVIDER, bounded)
      const url = new URL(`${baseURL(this.profile)}/models`)
      url.searchParams.set('pageSize', '1000')
      const result = new Map<string, LlmDiscoveredModel>()
      const cursors = new Set<string>()
      for (;;) {
        const response = await fetch(url, { redirect: 'error', signal: bounded,
          headers: { Authorization: `Bearer ${grant.access}`, 'x-goog-user-project': grant.quotaProjectId } })
        if (!response.ok) { await response.body?.cancel(); throw new LlmError(`Gemini API model discovery failed (HTTP ${response.status}).`, 'DISCOVERY_FAILED', { status: response.status }) }
        const payload = await accountJson(response, bounded)
        if (!Array.isArray(payload['models'])) throw new LlmError('Gemini API model listing has no models.', 'DISCOVERY_FAILED')
        for (const value of payload['models'] as unknown[]) {
          const row = modelRow(value)
          result.set(row.id, row)
        }
        const next = payload['nextPageToken']
        if (next === undefined || next === '') return [...result.values()]
        if (typeof next !== 'string' || cursors.has(next)) throw new LlmError('Gemini API model pagination is invalid.', 'DISCOVERY_FAILED')
        cursors.add(next)
        url.searchParams.set('pageToken', next)
      }
    })
  }

  private delegate(signal?: AbortSignal): Promise<PiAiAdapter> {
    this.delegatePromise ??= this.createDelegate(signal).catch((error: unknown) => {
      this.delegatePromise = undefined
      throw error
    })
    return this.delegatePromise
  }

  private async createDelegate(signal?: AbortSignal): Promise<PiAiAdapter> {
    const models = this.profile.models ?? await this.discoverModels(signal)
    const resolved = resolveProfiles({ [PROVIDER]: { models, api: 'openai-completions', baseURL: `${baseURL(this.profile)}/openai`,
      ...this.profile.defaultContextWindow === undefined ? {} : { defaultContextWindow: this.profile.defaultContextWindow },
      ...this.profile.defaultMaxTokens === undefined ? {} : { defaultMaxTokens: this.profile.defaultMaxTokens },
      ...this.profile.streamIdleTimeoutMs === undefined ? {} : { streamIdleTimeoutMs: this.profile.streamIdleTimeoutMs },
      ...this.profile.timeoutMs === undefined ? {} : { timeoutMs: this.profile.timeoutMs },
      ...this.profile.retryPolicy === undefined ? {} : { retryPolicy: this.profile.retryPolicy },
      ...this.profile.reasoning === undefined ? {} : { reasoning: this.profile.reasoning },
      ...this.profile.thinkingBudgets === undefined ? {} : { thinkingBudgets: this.profile.thinkingBudgets },
      ...this.profile.cacheRetention === undefined ? {} : { cacheRetention: this.profile.cacheRetention },
      ...this.profile.transport === undefined ? {} : { transport: this.profile.transport },
      ...this.profile.websocketConnectTimeoutMs === undefined ? {} : { websocketConnectTimeoutMs: this.profile.websocketConnectTimeoutMs },
      ...this.profile.maxRequestImageBytes === undefined ? {} : { maxRequestImageBytes: this.profile.maxRequestImageBytes },
      compat: { supportsDeveloperRole: false, supportsStore: false, supportsStrictMode: false, maxTokensField: 'max_tokens' },
    } }).get(PROVIDER) as ResolvedPiAiProviderProfile
    const piProvider: Provider = { ...resolved.piProvider, auth: { oauth: {
      name: ACCOUNT_PROVIDER_LABELS[PROVIDER],
      login: () => Promise.reject(new LlmError('Use the Host Google sign-in flow.', 'INVALID_AUTH_CONFIG')),
      refresh: (credential, cancellation) => refreshGoogle(credential, requestSignal(this.profile, cancellation)),
      toAuth: (credential) => {
        const grant = googleCredential(credential)
        return Promise.resolve({ apiKey: grant.access, headers: { 'x-goog-user-project': grant.quotaProjectId } })
      },
    } } }
    const profiles = new Map([[PROVIDER, { ...resolved, piProvider }]])
    return new PiAiAdapter({ profiles: () => profiles,
      resolveApiKey: () => Promise.resolve(undefined), auth: { credentials: this.pool.credentials, authContext: emptyAuthContext },
      ...this.resolveAttachments === undefined ? {} : { resolveAttachments: this.resolveAttachments } })
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return (await this.delegate()).listModels(provider)
  }

  override async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    return (await this.delegate(signal)).resolveModel(provider, model, signal)
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const delegate = await this.delegate(options.signal)
    yield* streamAccounts(options, PROVIDER, this.pool, (_account, attempt) => this.streamAccount(delegate, attempt))
  }

  private async *streamAccount(delegate: PiAiAdapter, options: GenerateOptions): AsyncIterable<StreamChunk> {
    await selectedGoogleCredential(this.pool, PROVIDER, requestSignal(this.profile, options.signal))
    yield* delegate.stream(options)
  }

  override providerRetryPolicy() {
    return resolveRetryPolicy(this.profile.retryPolicy, 'llm-account-auth: gemini-api retryPolicy')
  }

  override async requestGeneration(options: MediaGenerationOptions & { provider: string; model: string }): Promise<Response> {
    const model = await this.resolveModel(PROVIDER, options.model, options.signal)
    if (options.endpoint !== 'images/generations' || !options.model.startsWith('gemini-') || !model.endpoints?.includes(options.endpoint)) {
      throw new LlmError('Gemini API OAuth currently supports native image generation; this endpoint is unavailable.', 'UNSUPPORTED_GENERATION')
    }
    if (options.body['n'] !== undefined && options.body['n'] !== 1) throw new LlmError('Gemini API supports one image request.', 'UNSUPPORTED_GENERATION')
    const ratio = imageAspectRatio(options.body['size'])
    const signal = requestSignal(this.profile, options.signal)
    const accounts = await this.pool.selector.ordered(PROVIDER)
    for (const [index, account] of accounts.entries()) {
      const response = await this.pool.withAccount(account.id, async () => {
        const grant = await selectedGoogleCredential(this.pool, PROVIDER, signal)
        return fetch(`${baseURL(this.profile)}/models/${encodeURIComponent(options.model)}:generateContent`, {
          method: 'POST', redirect: 'error', signal,
          headers: { Authorization: `Bearer ${grant.access}`, 'x-goog-user-project': grant.quotaProjectId, 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: options.body['prompt'] }] }],
            generationConfig: { responseModalities: ['IMAGE'], ...ratio === undefined ? {} : { imageConfig: { aspectRatio: ratio } } } }),
        })
      })
      if (!isGenerationRejection(response.status) || index + 1 === accounts.length) return response
      await response.body?.cancel()
    }
    throw new LlmError('Google Gemini API has no connected account.', 'MISSING_CREDENTIAL')
  }
}

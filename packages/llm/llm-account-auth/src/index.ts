/** Native account routes; provider SDKs load only for login or model operations. */
import type { Context } from '@hydraharness/cordis'
import { installSettingsSection, settingsNamespace } from '@hydraharness/harness-settings'
import {
  LlmAdapter, LlmError,
  type AdapterRegistrationHandle, type GenerateOptions, type LlmDiscoveredModel,
  type LlmModelInfo, type LlmProviderInfo, type LlmResolvedModelInfo, type StreamChunk,
  type MediaGenerationOptions,
} from '@hydraharness/harness-llm'
import { accountRecordKey, createAccountPool, type AccountPool } from './accounts.ts'
import {
  ACCOUNT_PROVIDER_LABELS, ACCOUNT_PROVIDERS, Config, resolveProfiles,
  type AccountProvider, type AccountProviderProfile,
} from './config.ts'
import { GeminiWebAdapter } from './gemini-web.ts'

export const name = 'llm-account-auth'
export const inject = ['llm']
export { Config } from './config.ts'
export type { AccountModelProfile, AccountProviderProfile } from './config.ts'

const NS = settingsNamespace(name)
const emptyProfile: AccountProviderProfile = {}
type AccountRuntime = import('./adapter.ts').PiAiAccountAdapter | import('./adapter.ts').AntigravityAccountAdapter | import('./kiro.ts').KiroAccountAdapter | import('./gemini-api.ts').GeminiApiAccountAdapter

/** One lazy delegate per settings snapshot; active requests retain their own delegate. */
class AccountAdapter extends LlmAdapter {
  private previous: AccountProviderProfile | undefined
  private pending: Promise<AccountRuntime> | undefined

  constructor(
    private readonly ctx: Context,
    private readonly provider: AccountProvider,
    private readonly pool: AccountPool,
    private readonly profile: () => AccountProviderProfile,
  ) { super() }

  invalidate(): void { this.pending = undefined }

  override async requestGeneration(options: MediaGenerationOptions & { provider: string; model: string }): Promise<Response> {
    return (await this.load()).requestGeneration(options)
  }

  private load(): Promise<AccountRuntime> {
    const profile = this.profile()
    if (profile === this.previous && this.pending !== undefined) return this.pending
    this.previous = profile
    const pending = this.create(profile)
    this.pending = pending
    void pending.catch(() => {
      if (this.pending === pending) this.pending = undefined
    })
    return pending
  }

  private async create(profile: AccountProviderProfile): Promise<AccountRuntime> {
    const runtime = await import('./adapter.ts')
    const common = { pool: this.pool, resolveAttachments: () => this.ctx.get('attachments') }
    if (this.provider === 'gemini-api') {
      const { GeminiApiAccountAdapter } = await import('./gemini-api.ts')
      return new GeminiApiAccountAdapter(this.pool, profile, common.resolveAttachments)
    }
    if (this.provider === 'antigravity') {
      return new runtime.AntigravityAccountAdapter({ ...common, profile: () => profile })
    }
    if (this.provider === 'claude' || this.provider === 'xai-account' || this.provider === 'kimi') {
      const { buildSdkAccountProfile } = await import('./sdk-accounts.ts')
      const resolved = await buildSdkAccountProfile(this.provider, profile)
      return new runtime.PiAiAccountAdapter({ ...common, provider: this.provider, profile: () => resolved })
    }
    if (this.provider === 'kiro') {
      const { KiroAccountAdapter } = await import('./kiro.ts')
      return new KiroAccountAdapter(this.pool, profile)
    }
    if (this.provider !== 'chatgpt') throw new LlmError(`${this.provider} native transport is unavailable.`, 'NO_ADAPTER')
    const { buildChatGptProfile } = await import('./chatgpt.ts')
    const resolved = await buildChatGptProfile(profile)
    return new runtime.PiAiAccountAdapter({ ...common, provider: this.provider, profile: () => resolved })
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: ACCOUNT_PROVIDER_LABELS[this.provider] }
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return (await this.load()).listModels(provider)
  }

  override async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    return (await this.load()).resolveModel(provider, model, signal)
  }

  override async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    options.signal?.throwIfAborted()
    const delegate = await this.load()
    options.signal?.throwIfAborted()
    yield* delegate.stream(options)
  }

  async discover(signal?: AbortSignal): Promise<LlmDiscoveredModel[]> {
    signal?.throwIfAborted()
    const delegate = await this.load()
    return delegate.discoverModels(signal)
  }
}

/**
 * Offer account login and configure live routes without starting provider work.
 * @param ctx - plugin context owning all registrations.
 * @param config - base account-provider settings.
 */
export function apply(ctx: Context, config: Config): void {
  let source = (): Config => config
  let previous: Config | undefined
  let resolved: ReadonlyMap<AccountProvider, AccountProviderProfile> = new Map()
  const profiles = (): ReadonlyMap<AccountProvider, AccountProviderProfile> => {
    const raw = source()
    if (raw !== previous) {
      resolved = resolveProfiles(raw.providers)
      previous = raw
    }
    return resolved
  }
  profiles()
  const geminiWeb = new GeminiWebAdapter(ctx, () => source().geminiWeb)
  ctx.effect(function* () { yield () => geminiWeb.dispose() })

  const pools = new Map<string, AccountPool>()
  const routes = ACCOUNT_PROVIDERS.filter(provider => provider !== 'gemini-web').map((provider) => {
    const key = accountRecordKey(provider)
    const google = provider === 'antigravity' || provider === 'gemini-api'
    let pool = pools.get(key)
    if (pool === undefined) {
      pool = createAccountPool({ ctx, key, providerId: provider,
        ...google ? { providerAliases: ['antigravity', 'gemini-api'] } : {},
        providerLabel: google ? 'Google' : ACCOUNT_PROVIDER_LABELS[provider] })
      pools.set(key, pool)
    }
    return {
      provider, key, pool,
      adapter: new AccountAdapter(ctx, provider, pool, () => profiles().get(provider) ?? emptyProfile),
      registration: undefined as AdapterRegistrationHandle | undefined,
    }
  })

  ctx.llm.registerConfigurableProviders(ACCOUNT_PROVIDERS.map(provider => ({
    provider, displayName: ACCOUNT_PROVIDER_LABELS[provider], settingsNs: NS,
    settingsPath: ['providers', provider],
  })))
  ctx.llm.registerModelDiscovery(NS, async (request) => {
    if (request.provider === 'gemini-web') return geminiWeb.discover(request.signal)
    const route = routes.find(candidate => candidate.provider === request.provider)
    if (route === undefined) throw new LlmError('Select an account sign-in provider to discover models', 'INVALID_DISCOVERY')
    return route.adapter.discover(request.signal)
  })

  ctx.inject(['authorization'], (authorized) => {
    const registered = new Set<string>()
    for (const { provider, key, pool } of routes) {
      if (registered.has(key)) continue
      registered.add(key)
      const google = provider === 'antigravity' || provider === 'gemini-api'
      authorized.authorization.registerFlow({
        key, label: google ? 'Google' : ACCOUNT_PROVIDER_LABELS[provider],
        accounts: {
          ...pool.accounts,
          async usage(id, signal) {
            const { readAccountUsage } = await import('./usage.ts')
            return readAccountUsage(pool, id, provider, profiles().get(provider) ?? emptyProfile,
              /* v8 ignore next -- Config supplies usageTimeoutMs through its schema default. */
              source().usageTimeoutMs ?? 15_000, signal)
          },
        },
        methods: google ? [
          { id: 'oauth', label: 'Sign in with Google for Antigravity' },
          { id: 'gemini-api', label: 'Connect Gemini API with a Cloud project' },
        ] : [{ id: 'oauth', label: provider === 'kiro' ? 'Sign in with AWS Builder ID' : 'Sign in with ' + ACCOUNT_PROVIDER_LABELS[provider] }],
        async run(session) {
          if (google) {
            const { loginGoogle } = await import('./google-oauth.ts')
            await loginGoogle(session, pool, profiles().get('antigravity') ?? emptyProfile,
              profiles().get('gemini-api') ?? emptyProfile)
            return
          }
          if (provider === 'chatgpt') {
            const { loginChatGpt } = await import('./chatgpt.ts')
            await loginChatGpt(session, pool)
            return
          }
          if (provider === 'claude' || provider === 'xai-account' || provider === 'kimi') {
            const { loginSdkAccount } = await import('./sdk-accounts.ts')
            await loginSdkAccount(provider, session, pool)
            return
          }
          const { loginCursor, loginKiro } = await import('./native-login.ts')
          await (provider === 'cursor' ? loginCursor : loginKiro)(session, pool, profiles().get(provider) ?? emptyProfile)
        },
      })
    }
  })

  geminiWeb.registerAuthorization()
  const register = (): void => {
    geminiWeb.configure(profiles().has('gemini-web'), profiles().get('gemini-web')?.models)
    for (const route of routes) {
      const enabled = route.provider !== 'cursor' && profiles().has(route.provider)
      if (route.registration !== undefined) route.registration.replace(enabled ? [route.provider] : [])
      else if (enabled) route.registration = ctx.llm.registerAdapter([route.provider], route.adapter)
    }
  }
  register()
  ctx.on('credentials/record-updated', (key) => {
    for (const route of routes.filter(candidate => candidate.key === key)) {
      route.adapter.invalidate()
      if (route.registration !== undefined && profiles().has(route.provider)) route.registration.replace([route.provider])
    }
  })
  installSettingsSection(ctx, NS, Config, config, {
    validate: (value) => { resolveProfiles(value.providers) },
    setSource: (next) => { source = next },
    onChange: register,
  })
}

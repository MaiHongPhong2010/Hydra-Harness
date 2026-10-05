/** Settings for native account-backed provider routes. */

import z from '@hydraharness/schemastery'
import { MAX_TIMER_DELAY_MS } from '@hydraharness/harness-timeout'
import type { CacheRetention, ModelThinkingLevel, ThinkingBudgets, Transport } from '@earendil-works/pi-ai'
import type { RetryPolicyConfig } from '@hydraharness/harness-llm'
import { RetryPolicySchema, inferModelEndpoints } from '@hydraharness/harness-llm'
import { GeminiWebConfig } from './gemini-web.ts'

/** One optional model override for an account-backed route. */
export interface AccountModelProfile {
  /** Provider model id sent on requests. */
  id: string
  /** Selector label; defaults to the provider catalog's name. */
  name?: string
  /** Combined input and output context capacity. */
  contextWindow?: number
  /** Maximum output token capability. */
  maxTokens?: number
  /** Generation or conversation endpoint families; omission uses known model family hints. */
  endpoints?: string[]
}

/** One account-backed provider's settings. */
export interface AccountProviderProfile {
  /**
   * Replacement model catalog. Omission and an empty list are the same
   * request, as they are for a pi-ai route: the route then serves its live
   * catalog — the adapter's installed models, or the ones discovered from the
   * signed-in account — so a profile left to "Fetch available models" needs no
   * list stored here.
   */
  models?: AccountModelProfile[]
  /** Fallback context capacity for a model with no provider metadata. */
  defaultContextWindow?: number
  /** Fallback output capacity for a model with no provider metadata. */
  defaultMaxTokens?: number
  /** Maximum idle interval while one provider stream read is outstanding. */
  streamIdleTimeoutMs?: number
  /** Default provider-neutral reasoning level for ChatGPT requests. */
  reasoning?: ModelThinkingLevel
  /** Token budgets for reasoning levels supported by the provider. */
  thinkingBudgets?: ThinkingBudgets
  /** Prompt-cache retention preference for ChatGPT requests. */
  cacheRetention?: CacheRetention
  /** Streaming transport preference for ChatGPT requests. */
  transport?: Transport
  /** Provider SDK request timeout in milliseconds. */
  timeoutMs?: number
  /** WebSocket connection timeout in milliseconds. */
  websocketConnectTimeoutMs?: number
  /** Retry policy for provider request failures. */
  retryPolicy?: RetryPolicyConfig
  /** Maximum base64-encoded image payload accepted in one request. */
  maxRequestImageBytes?: number
  /** Native API base URL; HTTPS or loopback HTTP without credentials, query, or fragment. */
  endpoint?: string
  /** Loopback callback port used by Google OAuth; zero asks the OS for a free port. */
  callbackPort?: number
  /** Loopback callback path used by Google OAuth. */
  callbackPath?: string
  /** Number of Antigravity onboarding attempts. */
  onboardingAttempts?: number
  /** Delay between incomplete Antigravity onboarding attempts. */
  onboardingDelayMs?: number
  /** AWS region used by Kiro Builder ID login and requests. */
  region?: string
  /** AWS IAM Identity Center start URL; omission uses AWS Builder ID. */
  startURL?: string
  /** AWS IAM Identity Center issuer used for Kiro's scoped client registration. */
  issuerURL?: string
  /** Kiro profile ARN returned by the provider; omission uses the token's profile when supplied. */
  profileArn?: string
  /** Maximum duration of a Google, Cursor, or Kiro login attempt. */
  loginTimeoutMs?: number
  /** Interval between Cursor login polling requests. */
  loginPollIntervalMs?: number
}

/** Plugin settings keyed by account provider route. */
export interface Config {
  /** Managed-browser and HTTP deadlines for the independent Gemini Web route. */
  geminiWeb?: GeminiWebConfig
  /** Maximum time for one account usage request, including credential refresh. */
  usageTimeoutMs?: number
  /** Enabled account-backed routes. An empty map leaves routes dormant. */
  providers?: Record<string, AccountProviderProfile>
}

const modelProfile: z<AccountModelProfile> = z.object({
  id: z.string().required(),
  name: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
  endpoints: z.array(z.string()),
})

const providerProfile: z<AccountProviderProfile> = z.object({
  models: z.array(modelProfile),
  defaultContextWindow: z.number().step(1).min(1),
  defaultMaxTokens: z.number().step(1).min(1),
  streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS),
  reasoning: z.union(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']),
  thinkingBudgets: z.object({ minimal: z.number(), low: z.number(), medium: z.number(), high: z.number() }),
  cacheRetention: z.union(['none', 'short', 'long']),
  transport: z.union(['sse', 'websocket', 'websocket-cached', 'auto']),
  timeoutMs: z.natural(),
  websocketConnectTimeoutMs: z.natural(),
  retryPolicy: RetryPolicySchema,
  maxRequestImageBytes: z.number().step(1).min(1),
  endpoint: z.string(),
  callbackPort: z.natural().max(65535),
  callbackPath: z.string(),
  onboardingAttempts: z.natural().min(1),
  onboardingDelayMs: z.number().step(1).min(0),
  region: z.string(),
  startURL: z.string(),
  issuerURL: z.string(),
  profileArn: z.string(),
  loginTimeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS),
  loginPollIntervalMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS),
})

/** Schema used by the settings section and composition loader. */
export const Config: z<Config> = z.object({
  geminiWeb: GeminiWebConfig.default({}),
  usageTimeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(15_000),
  providers: z.dict(providerProfile).default({}),
})

/** The routes owned by this package, in UI and registration order. */
export const ACCOUNT_PROVIDERS = ['chatgpt', 'antigravity', 'gemini-api', 'claude', 'xai-account', 'kimi', 'cursor', 'kiro', 'gemini-web'] as const

/** Provider route type owned by this package. */
export type AccountProvider = (typeof ACCOUNT_PROVIDERS)[number]

/** User-facing labels for the owned routes. */
export const ACCOUNT_PROVIDER_LABELS: Readonly<Record<AccountProvider, string>> = {
  chatgpt: 'ChatGPT',
  antigravity: 'Google Antigravity',
  'gemini-api': 'Google Gemini API OAuth',
  'gemini-web': 'Gemini Web',
  claude: 'Claude',
  'xai-account': 'xAI',
  kimi: 'Kimi Code',
  cursor: 'Cursor',
  kiro: 'Kiro',
}

/**
 * Resolve and detach account-provider settings.
 * @param providers - raw provider profiles from the composition or settings section.
 * @returns validated profiles keyed by known route.
 * @throws Error when an unknown route or invalid model override is supplied.
 */
export function resolveProfiles(
  providers: Readonly<Record<string, AccountProviderProfile>> | undefined,
): Map<AccountProvider, AccountProviderProfile> {
  const resolved = new Map<AccountProvider, AccountProviderProfile>()
  for (const [provider, profile] of Object.entries(providers ?? {})) {
    if (!(ACCOUNT_PROVIDERS as readonly string[]).includes(provider)) {
      throw new Error(`llm-account-auth: unknown provider "${provider}"`)
    }
    if (provider === 'gemini-web') {
      for (const field of Object.keys(profile)) {
        const value = profile[field as keyof AccountProviderProfile]
        if (value === undefined || (typeof value === 'object' && Object.values(value).every(entry => entry === undefined))) continue
        if (field !== 'models') throw new Error(`llm-account-auth: Gemini Web does not support ${field}`)
      }
      for (const model of profile.models ?? []) {
        const endpoint = model.id === 'gemini-web-image' ? 'images/generations' : model.id === 'gemini-web-video' ? 'videos' : undefined
        if (endpoint === undefined || model.endpoints?.some(value => value !== endpoint)
          || model.contextWindow !== undefined || model.maxTokens !== undefined) throw new Error('llm-account-auth: Gemini Web supports only its verified image and video aliases')
      }
    }
    if (profile.region !== undefined && !/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(profile.region)) throw new Error(`llm-account-auth: provider "${provider}" has an invalid AWS region`)
    for (const field of ['startURL', 'issuerURL'] as const) {
      if (profile[field] === undefined) continue
      const url = new URL(profile[field])
      if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error(`llm-account-auth: provider "${provider}" ${field} must use HTTPS without credentials or fragment`)
    }
    for (const field of ['loginTimeoutMs', 'loginPollIntervalMs'] as const) {
      const value = profile[field]
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > MAX_TIMER_DELAY_MS)) throw new Error(`llm-account-auth: provider "${provider}" ${field} must be a positive timer interval`)
    }
    if (profile.endpoint !== undefined && profile.endpoint.trim().length === 0) {
      throw new Error(`llm-account-auth: provider "${provider}" has an empty endpoint`)
    }
    if (profile.endpoint !== undefined) {
      const url = new URL(profile.endpoint)
      if (url.username || url.password || url.search || url.hash
        || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) throw new Error(`llm-account-auth: provider "${provider}" endpoint must use HTTPS or loopback HTTP without credentials, query, or fragment`)
    }
    if (provider === 'kiro') {
      for (const field of ['defaultMaxTokens', 'reasoning', 'thinkingBudgets', 'cacheRetention', 'transport', 'websocketConnectTimeoutMs', 'retryPolicy', 'maxRequestImageBytes'] as const) {
        const value = profile[field]
        if (value === undefined || (typeof value === 'object' && Object.values(value).every(entry => entry === undefined))) continue
        throw new Error(`llm-account-auth: Kiro does not support ${field}`)
      }
      if (profile.timeoutMs !== undefined && (!Number.isSafeInteger(profile.timeoutMs) || profile.timeoutMs <= 0 || profile.timeoutMs > MAX_TIMER_DELAY_MS)) throw new Error('llm-account-auth: Kiro timeoutMs must be a positive timer interval')
      if (profile.models?.some(model => model.maxTokens !== undefined)) throw new Error('llm-account-auth: Kiro models do not support maxTokens')
    }
    if (profile.callbackPath !== undefined
      && (!profile.callbackPath.startsWith('/') || profile.callbackPath.includes('?'))) {
      throw new Error(`llm-account-auth: provider "${provider}" callbackPath must be an absolute path`)
    }
    if (profile.callbackPort !== undefined
      && (!Number.isSafeInteger(profile.callbackPort) || profile.callbackPort < 0 || profile.callbackPort > 65535)) {
      throw new Error(`llm-account-auth: provider "${provider}" callbackPort must be an integer from 0 through 65535`)
    }
    if (profile.onboardingAttempts !== undefined
      && (!Number.isSafeInteger(profile.onboardingAttempts) || profile.onboardingAttempts < 1)) {
      throw new Error(`llm-account-auth: provider "${provider}" onboardingAttempts must be a positive integer`)
    }
    if (profile.onboardingDelayMs !== undefined
      && (!Number.isFinite(profile.onboardingDelayMs) || profile.onboardingDelayMs < 0)) {
      throw new Error(`llm-account-auth: provider "${provider}" onboardingDelayMs must be non-negative`)
    }
    if (profile.defaultContextWindow !== undefined
      && (!Number.isSafeInteger(profile.defaultContextWindow) || profile.defaultContextWindow <= 0)) {
      throw new Error(`llm-account-auth: provider "${provider}" defaultContextWindow must be a positive integer`)
    }
    if (profile.defaultMaxTokens !== undefined
      && (!Number.isSafeInteger(profile.defaultMaxTokens) || profile.defaultMaxTokens <= 0)) {
      throw new Error(`llm-account-auth: provider "${provider}" defaultMaxTokens must be a positive integer`)
    }
    if (profile.streamIdleTimeoutMs !== undefined
      && (!Number.isFinite(profile.streamIdleTimeoutMs)
        || profile.streamIdleTimeoutMs <= 0
        || profile.streamIdleTimeoutMs > MAX_TIMER_DELAY_MS)) {
      throw new Error(
        `llm-account-auth: provider "${provider}" streamIdleTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`,
      )
    }
    if (profile.maxRequestImageBytes !== undefined
      && (!Number.isSafeInteger(profile.maxRequestImageBytes) || profile.maxRequestImageBytes <= 0)) {
      throw new Error(`llm-account-auth: provider "${provider}" maxRequestImageBytes must be a positive integer`)
    }
    const { models, ...rest } = profile
    // An absent list and an empty one are the same request: the schema
    // materializes `[]` for the absent case, and a route with no catalog of
    // its own is served its live one — the adapter's installed models, or what
    // the signed-in account discovers. Only a non-empty list replaces that, so
    // the key is detached rather than stored empty, which the adapters read as
    // a deliberate empty catalog.
    if (models === undefined || models.length === 0) {
      resolved.set(provider as AccountProvider, { ...rest })
      continue
    }
    const seen = new Set<string>()
    const detached = models.map((model) => {
      if (model.id.length === 0) throw new Error(`llm-account-auth: provider "${provider}" has an empty model id`)
      if (seen.has(model.id)) throw new Error(`llm-account-auth: provider "${provider}" repeats model "${model.id}"`)
      seen.add(model.id)
      if (model.name !== undefined && model.name.length === 0) {
        throw new Error(`llm-account-auth: provider "${provider}" model "${model.id}" has an empty name`)
      }
      for (const [field, value] of [
        ['contextWindow', model.contextWindow],
        ['maxTokens', model.maxTokens],
      ] as const) {
        if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
          throw new Error(`llm-account-auth: provider "${provider}" model "${model.id}" ${field} must be a positive integer`)
        }
      }
      /* jscpd:ignore-start -- account profile and runtime discovery use the same normalized model row. */
      const endpoints = model.endpoints?.length ? [...model.endpoints] : inferModelEndpoints(model.id)
      if (endpoints?.some(path => path.includes('://') || !/^[a-zA-Z][a-zA-Z0-9/{}:._-]*$/.test(path))) {
        throw new Error(`llm-account-auth: provider "${provider}" model "${model.id}" has invalid endpoints`)
      }
      return {
        id: model.id,
        ...model.name === undefined ? {} : { name: model.name },
        ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
        ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
        ...endpoints === undefined ? {} : { endpoints },
      }
      /* jscpd:ignore-end */
    })
    resolved.set(provider as AccountProvider, {
      ...rest,
      models: detached,
    })
  }
  return resolved
}

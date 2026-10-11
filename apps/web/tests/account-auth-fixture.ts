/** Test-only account-backed providers for the assembled authorization browser lane. */
import type { Context } from '@hydraharness/cordis'
import Schema from '@hydraharness/schemastery'
import { credentialKey } from '@hydraharness/harness-credentials'
import { authorizationAccountId } from '@hydraharness/harness-authorization'
import type {
  AuthorizationAccount,
  AuthorizationAccounts,
  AuthorizationFlow,
  AuthorizationUsage,
} from '@hydraharness/harness-authorization'
import { LlmAdapter } from '@hydraharness/harness-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@hydraharness/harness-llm'
import { settingsNamespace } from '@hydraharness/harness-settings'

/** Loader identity of the deterministic account-auth replacement plugin. */
export const name = 'llm-account-auth-fixture'

/** Services required by this fixture's registrations. */
export const inject = ['llm', 'settings', 'credentials', 'authorization']

/** Settings namespace used by the account-backed test providers. */
export const ACCOUNT_AUTH_NAMESPACE = settingsNamespace('llm-account-auth')

/** The deterministic model directory exposed by this fixture. */
export const ACCOUNT_AUTH_PROVIDERS = [
  { provider: 'chatgpt', displayName: 'ChatGPT', model: 'gpt-5-test', modelName: 'GPT-5 Test' },
  {
    provider: 'antigravity',
    displayName: 'Google Antigravity',
    model: 'gemini-2.5-test',
    modelName: 'Gemini 2.5 Test',
  },
] as const

const AccountAuthConfig = Schema.object({
  providers: Schema.dict(Schema.object({
    models: Schema.array(Schema.object({ id: Schema.string() })),
  })),
})

type AccountEntry = AuthorizationAccount

function entriesFromRecord(record: unknown): AccountEntry[] {
  if (typeof record !== 'object' || record === null || Array.isArray(record)) return []
  const candidate = (record as { kind?: unknown; payload?: unknown })
  if (candidate.kind !== 'grant' || typeof candidate.payload !== 'object'
    || candidate.payload === null || Array.isArray(candidate.payload)) return []
  const accounts = (candidate.payload as { accounts?: unknown }).accounts
  if (!Array.isArray(accounts)) return []
  return accounts.flatMap((account): AccountEntry[] => {
    if (typeof account !== 'object' || account === null || Array.isArray(account)) return []
    const { id, label } = account as { id?: unknown; label?: unknown }
    return typeof id === 'string' && id.length > 0 && typeof label === 'string' && label.length > 0
      ? [{ id: authorizationAccountId(id), label }]
      : []
  })
}

function usageFor(provider: (typeof ACCOUNT_AUTH_PROVIDERS)[number], accountId: string, reconnected: boolean): AuthorizationUsage {
  if (provider.provider === 'chatgpt') {
    const bob = accountId === 'chatgpt-2'
    return {
      planType: bob ? 'Codex Pro' : 'Codex Plus',
      limits: [
        { name: 'Codex', windowMinutes: 300, usedPercent: bob ? 75 : 25,
          resetsAt: bob ? 1_800_100_000 : 1_800_000_000 },
        { name: 'Codex', windowMinutes: 10_080, usedPercent: bob ? 12 : 55,
          resetsAt: bob ? 1_801_000_000 : 1_800_500_000 },
      ],
      bankedResetCount: bob ? 0 : 2,
      fetchedAt: 1_800_000_000,
    }
  }
  return {
    planType: reconnected ? 'Google AI Ultra' : 'Google AI Pro',
    limits: [
      { name: 'Gemini 3.1 Flash', group: 'Gemini models', window: 'weekly', windowMinutes: 10_080,
        usedPercent: reconnected ? 7 : 18, remainingAmount: reconnected ? 930 : 820, resetsAt: 1_800_000_000 },
      { name: 'Gemini 3.1 Pro', group: 'Gemini models', window: '5 hours', windowMinutes: 300,
        usedPercent: 32, remainingAmount: 680, resetsAt: 1_800_060_000 },
      { name: 'Claude 3.7 Sonnet', group: 'Claude and GPT models', window: 'weekly', windowMinutes: 10_080,
        usedPercent: 40, remainingAmount: 600, resetsAt: 1_800_120_000 },
      { name: 'GPT-4.1', group: 'Claude and GPT models', window: '5 hours', windowMinutes: 300,
        usedPercent: 12, remainingAmount: 880, resetsAt: 1_800_180_000 },
    ],
    credits: [{ tier: 'g1', creditType: 'GOOGLE_ONE_AI', creditAmount: 1200, minimumCreditAmountForUsage: 100 }],
    fetchedAt: 1_800_000_000,
  }
}

function accountStore(
  ctx: Context,
  key: ReturnType<typeof credentialKey>,
  provider: (typeof ACCOUNT_AUTH_PROVIDERS)[number],
  reconnected: () => boolean,
): AuthorizationAccounts {
  return {
    async list(): Promise<readonly AccountEntry[]> {
      return entriesFromRecord(await ctx.credentials.readRecord(key))
    },
    async remove(id: string): Promise<void> {
      await ctx.credentials.modifyRecord(key, async (current) => {
        const accounts = entriesFromRecord(current).filter(account => account.id !== id)
        return { kind: 'grant', payload: { accounts } }
      })
    },
    async usage(id, signal): Promise<AuthorizationUsage> {
      signal?.throwIfAborted()
      return usageFor(provider, String(id), reconnected())
    },
  }
}

/** Adapter metadata is real; a model stream is intentionally out of scope for this settings/auth test. */
class AccountAuthAdapter extends LlmAdapter {
  override providerInfo(provider: string): LlmProviderInfo {
    const entry = ACCOUNT_AUTH_PROVIDERS.find(candidate => candidate.provider === provider)
    return { id: provider, name: entry?.displayName ?? provider }
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const entry = ACCOUNT_AUTH_PROVIDERS.find(candidate => candidate.provider === provider)
    return Promise.resolve(entry === undefined ? [] : [{
      provider,
      id: entry.model,
      name: entry.modelName,
    }])
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const entry = ACCOUNT_AUTH_PROVIDERS.find(candidate => candidate.provider === provider)
    return Promise.resolve({
      provider,
      id: model,
      name: entry?.model === model ? entry.modelName : model,
      context: { contextWindow: 128_000 },
    })
  }

  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    throw new Error('account auth browser fixture: model generation is not part of this test')
  }
}

function flowFor(ctx: Context, provider: (typeof ACCOUNT_AUTH_PROVIDERS)[number]): AuthorizationFlow {
  const key = credentialKey('llm-account-auth', provider.provider)
  let completedLogins = 0
  return {
    key,
    label: provider.displayName,
    methods: [{ id: 'oauth', label: `Sign in with ${provider.displayName}` }],
    accounts: accountStore(ctx, key, provider, () => completedLogins > 1),
    async run(session) {
      // The browser sees a normal provider notice and a safe HTTPS link, but
      // the test never leaves the local process to perform OAuth.
      session.notify({
        message: `Continue signing in to ${provider.displayName} in your browser.`,
        url: `https://auth.example.test/${provider.provider}`,
      })
      await ctx.credentials.modifyRecord(key, async (current) => {
        const accounts = entriesFromRecord(current)
        const index = Math.max(completedLogins, accounts.length)
        const id = provider.provider === 'antigravity' ? 'antigravity-1' : `${provider.provider}-${String(index + 1)}`
        const labels = provider.provider === 'chatgpt'
          ? ['alice@example.test', 'bob@example.test', 'carol@example.test']
          : ['google@example.test']
        const label = labels[provider.provider === 'antigravity' ? 0 : index]
          ?? `${provider.provider}-${String(index + 1)}@example.test`
        const next = accounts.some(account => account.id === id)
          ? accounts.map(account => account.id === id ? { id, label } : account)
          : [...accounts, { id, label }]
        return { kind: 'grant', payload: { accounts: next } }
      })
      completedLogins += 1
    },
  }
}

/** Mount the deterministic account-auth replacement through the fixture fiber. */
export function apply(ctx: Context): void {
  ctx.settings.register(ACCOUNT_AUTH_NAMESPACE, AccountAuthConfig, {
    base: {
      providers: {},
    },
  })
  ctx.llm.registerConfigurableProviders(ACCOUNT_AUTH_PROVIDERS.map(provider => ({
    provider: provider.provider,
    displayName: provider.displayName,
    settingsNs: ACCOUNT_AUTH_NAMESPACE,
    settingsPath: ['providers', provider.provider],
  })))
  ctx.llm.registerAdapter(ACCOUNT_AUTH_PROVIDERS.map(provider => provider.provider), new AccountAuthAdapter())
  for (const provider of ACCOUNT_AUTH_PROVIDERS) ctx.authorization.registerFlow(flowFor(ctx, provider))
}

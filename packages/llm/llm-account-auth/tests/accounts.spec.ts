import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { Context } from '@hydraharness/cordis'
import { CredentialProvider, credentialKey } from '@hydraharness/harness-credentials'
import type { Credential } from '@earendil-works/pi-ai'
import type {
  CredentialInfo,
  CredentialKey,
  CredentialRecord,
  CredentialRecordEntry,
  CredentialRecordInfo,
  CredentialRef,
  ResolvedCredential,
} from '@hydraharness/harness-credentials'
import { createAccountPool, emptyAuthContext, parseAccountPool } from '../src/accounts.ts'
import { readAccountUsage as readUsage } from '../src/usage.ts'
import type { StreamChunk } from '@hydraharness/harness-llm'

const usageMocks = vi.hoisted(() => ({ chatgptRefresh: vi.fn(), antigravityRefresh: vi.fn(), oauthAvailable: true }))

async function readAccountUsage(...args: Parameters<typeof readUsage>) {
  const usage = await readUsage(...args)
  if (usage === undefined) throw new Error('expected provider-reported usage')
  return usage
}
vi.mock('@earendil-works/pi-ai/providers/openai-codex', async (load) => {
  const original = await load<typeof import('@earendil-works/pi-ai/providers/openai-codex')>()
  return {
    ...original,
    openaiCodexProvider: () => {
      const provider = original.openaiCodexProvider()
      return { ...provider, auth: { ...provider.auth,
        oauth: !usageMocks.oauthAvailable ? undefined : { ...provider.auth.oauth, refresh: usageMocks.chatgptRefresh } } }
    },
  }
})
vi.mock('../src/antigravity-oauth.ts', async load => ({
  ...await load<typeof import('../src/antigravity-oauth.ts')>(), refreshAntigravity: usageMocks.antigravityRefresh,
}))

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  usageMocks.chatgptRefresh.mockReset()
  usageMocks.antigravityRefresh.mockReset()
  usageMocks.oauthAvailable = true
})

class MemoryCredentials extends CredentialProvider {
  private readonly records = new Map<CredentialKey, CredentialRecord>()

  override resolve(_ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    return Promise.resolve(undefined)
  }

  override describe(_ref: CredentialRef): Promise<CredentialInfo> {
    return Promise.resolve({ configured: false, writable: true })
  }

  override set(_ref: CredentialRef, _value: string): Promise<void> {
    return Promise.resolve()
  }

  override unset(_ref: CredentialRef): Promise<void> {
    return Promise.resolve()
  }

  override readRecord(key: CredentialKey): Promise<CredentialRecord | undefined> {
    return Promise.resolve(this.records.get(key))
  }

  override describeRecord(key: CredentialKey): Promise<CredentialRecordInfo> {
    const record = this.records.get(key)
    return Promise.resolve(record === undefined
      ? { configured: false, writable: true }
      : { configured: true, kind: record.kind, writable: true })
  }

  override listRecords(): Promise<readonly CredentialRecordEntry[]> {
    return Promise.resolve([...this.records].map(([key, record]) => ({ key, kind: record.kind })))
  }

  override async modifyRecord(
    key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    const current = this.records.get(key)
    const next = await mutate(current)
    if (next !== undefined) this.records.set(key, next)
    return next ?? current
  }

  override deleteRecord(key: CredentialKey): Promise<void> {
    this.records.delete(key)
    return Promise.resolve()
  }
}

async function fixture(provider: 'chatgpt' | 'antigravity' = 'chatgpt'): Promise<{ ctx: Context; pool: ReturnType<typeof createAccountPool> }> {
  const ctx = new Context()
  await ctx.plugin(MemoryCredentials)
  return {
    ctx,
    pool: createAccountPool({
      ctx,
      key: credentialKey('llm-account-auth', provider),
      providerId: provider,
      providerLabel: provider === 'chatgpt' ? 'ChatGPT' : 'Antigravity',
    }),
  }
}

describe('account pools', () => {
  it('has no ambient credential access and fails without a credentials provider', async () => {
    await expect(emptyAuthContext.env('TOKEN')).resolves.toBeUndefined()
    await expect(emptyAuthContext.fileExists('file')).resolves.toBe(false)
    const pool = createAccountPool({ ctx: new Context(), key: credentialKey('test', 'test'), providerId: 'test', providerLabel: 'Test' })
    await expect(pool.accounts.list()).rejects.toMatchObject({ code: 'NO_CREDENTIAL_STORE' })
  })

  it('rejects a credential provider that never invokes its write callback', async () => {
    const { ctx, pool } = await fixture()
    try {
      vi.spyOn(ctx.credentials, 'modifyRecord').mockResolvedValue(undefined)
      await expect(pool.add(undefined, { type: 'api_key', key: 'key' })).rejects.toThrow('did not commit')
    } finally { await ctx.fiber.dispose() }
  })

  it('isolates unknown providers, unselected reads, refreshes, and selected deletions', async () => {
    const { ctx, pool } = await fixture()
    try {
      await expect(pool.selector.ordered('other')).resolves.toEqual([])
      await expect(pool.selector.ordered('chatgpt')).resolves.toEqual([])
      await expect(pool.credentials.list()).resolves.toEqual([])
      await expect(pool.credentials.read('other')).resolves.toBeUndefined()
      const key = { type: 'api_key', key: 'secret', accountId: 'first' } as const
      await expect(pool.credentials.modify('other', async current => current)).resolves.toBeUndefined()
      await pool.withLoginLabel(' First ', () => pool.credentials.modify('chatgpt', async () => key))
      const first = (await pool.accounts.list())[0]!
      await expect(pool.credentials.list()).resolves.toEqual([{ providerId: 'chatgpt', type: 'api_key' }])
      await expect(pool.credentials.read('chatgpt')).resolves.toBeUndefined()
      await pool.credentials.modify('chatgpt', async () => ({ ...key, key: 'replaced' }))
      await pool.credentials.modify('chatgpt', async () => ({ type: 'api_key', key: 'generated' }))
      await pool.credentials.modify('chatgpt', async () => ({ ...key, key: 'duplicate' }))
      await pool.withAccount(first.id, async () => {
        await expect(pool.credentials.read('chatgpt')).resolves.toMatchObject({ key: 'duplicate' })
        await expect(pool.credentials.modify('chatgpt', async () => undefined)).resolves.toBeUndefined()
        await expect(pool.credentials.read('chatgpt')).resolves.toMatchObject({ key: 'duplicate' })
      })
      await pool.add(undefined, { ...key, accountId: 'second' } as Credential & Record<string, unknown>)
      await pool.withAccount(first.id, () => pool.credentials.modify('chatgpt', async () => ({ ...key, key: 'refreshed' })))
      await pool.credentials.delete('other')
      expect(await pool.accounts.list()).toHaveLength(3)
      await pool.withAccount(first.id, () => pool.credentials.delete('chatgpt'))
      expect(await pool.accounts.list()).toHaveLength(2)
      await expect(pool.accounts.remove(first.id)).rejects.toMatchObject({ code: 'ACCOUNT_GONE' })
      await pool.credentials.delete('chatgpt')
      expect(await pool.accounts.list()).toEqual([])
    } finally { await ctx.fiber.dispose() }
  })

  it('keeps account selection active through stream iteration and early cleanup', async () => {
    const { ctx, pool } = await fixture()
    try {
      const first = await pool.add('First', { type: 'api_key', key: 'first' })
      const reads: unknown[] = []
      const source = async function* (): AsyncIterable<StreamChunk> {
        try {
          reads.push(await pool.credentials.read('chatgpt'))
          yield { type: 'text', text: 'first' } as unknown as StreamChunk
          reads.push(await pool.credentials.read('chatgpt'))
        } finally { reads.push(await pool.credentials.read('chatgpt')) }
      }
      for await (const _chunk of pool.selector.stream('chatgpt', first.id, source)) { /* consume to completion */ }
      expect(reads).toEqual(Array.from({ length: 3 }, () => ({ type: 'api_key', key: 'first' })))
      reads.length = 0
      for await (const _chunk of pool.selector.stream('chatgpt', first.id, source)) break
      expect(reads).toEqual(Array.from({ length: 2 }, () => ({ type: 'api_key', key: 'first' })))
      const iterator = pool.selector.stream('other', first.id, source)[Symbol.asyncIterator]()
      await expect(iterator.next()).rejects.toMatchObject({ code: 'ACCOUNT_PROVIDER' })
      const cleanupFailure = async function* (): AsyncIterable<StreamChunk> {
        try { yield { type: 'text', text: 'first' } as unknown as StreamChunk }
        finally { throw new Error('cleanup failed') }
      }
      for await (const _chunk of pool.selector.stream('chatgpt', first.id, cleanupFailure)) break
      const noReturn: AsyncIterable<StreamChunk> = {
        [Symbol.asyncIterator]: () => ({ next: async () => ({ done: false, value: { type: 'text', text: 'first' } as unknown as StreamChunk }) }),
      }
      for await (const _chunk of pool.selector.stream('chatgpt', first.id, () => noReturn)) break
      await expect(pool.credentials.read('chatgpt')).resolves.toBeUndefined()
    } finally { await ctx.fiber.dispose() }
  })

  it.each([
    [{ workspaceId: 'workspace', userId: 'user' }, 'workspace:user'],
    [{ workspaceId: 'workspace' }, 'workspace'],
    [{ userId: 'user' }, 'user'],
    [{ emailAddress: 'user@example.test' }, 'user@example.test'],
    [{ id: 'id' }, 'id'],
  ])('uses credential identity fields %j', async (fields, identity) => {
    const { ctx, pool } = await fixture()
    try {
      await expect(pool.add(undefined, { type: 'api_key', key: 'key', ...fields }))
        .resolves.toMatchObject({ id: identity })
    } finally { await ctx.fiber.dispose() }
  })

  it.each([
    [{ email: 'token@example.test', sub: 'user' }, 'token@example.test'],
    [{ userId: 'user' }, 'user'],
    [{ 'https://api.openai.com/auth': { email: 'auth@example.test' } }, 'auth@example.test'],
    [{ 'https://api.openai.com/auth': { userId: 'auth-user' } }, 'auth-user'],
    [{ 'https://api.openai.com/profile': { name: 'Profile name' } }, 'Profile name'],
  ])('uses token labels and identities %j without browser globals', async (claims, label) => {
    const { ctx, pool } = await fixture()
    try {
      vi.stubGlobal('atob', undefined)
      const access = `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`
      await expect(pool.add(undefined, { type: 'oauth', access, refresh: 'refresh', expires: 1 })).resolves.toMatchObject({ label })
    } finally { await ctx.fiber.dispose() }
  })

  it('ignores malformed access-token claims when deriving a display label', async () => {
    const { ctx, pool } = await fixture()
    try {
      await expect(pool.add(undefined, { type: 'oauth', access: 'header.invalid.signature', refresh: 'refresh', expires: 1 }))
        .resolves.toMatchObject({ label: 'ChatGPT account 1' })
    } finally { await ctx.fiber.dispose() }
  })

  it('derives labels from provider identity when no label is supplied', async () => {
    const { ctx, pool } = await fixture()
    try {
      const email = await pool.add(undefined, {
        type: 'oauth', access: 'access-email', refresh: 'refresh-email', expires: 1,
        email: 'user@example.test',
      })
      const payload = Buffer.from(JSON.stringify({
        'https://api.openai.com/auth': { chatgpt_account_id: 'account-from-claim' },
      })).toString('base64url')
      const claim = await pool.add(undefined, {
        type: 'oauth', access: `header.${payload}.signature`, refresh: 'refresh-claim', expires: 1,
      })
      const fallback = await pool.add(undefined, {
        type: 'oauth', access: 'access-fallback', refresh: 'refresh-fallback', expires: 1,
      })
      expect([email.label, claim.label, fallback.label]).toEqual([
        'user@example.test', 'account-from-claim', 'ChatGPT account 3',
      ])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('persists labels, isolates account reads, and rotates selection', async () => {
    const { ctx, pool } = await fixture()
    try {
      const first = await pool.add(' first ', {
        type: 'oauth', access: 'access-1', refresh: 'refresh-1', expires: 1,
      })
      const second = await pool.add('second', {
        type: 'oauth', access: 'access-2', refresh: 'refresh-2', expires: 2,
      })
      expect(await pool.accounts.list()).toEqual([
        { id: first.id, label: 'first' },
        { id: second.id, label: 'second' },
      ])
      await pool.withAccount(first.id, async () => {
        await expect(pool.credentials.read('chatgpt')).resolves.toMatchObject({ access: 'access-1' })
      })
      await pool.withAccount(second.id, async () => {
        await expect(pool.credentials.read('chatgpt')).resolves.toMatchObject({ access: 'access-2' })
      })
      await expect(pool.selector.ordered('chatgpt')).resolves.toEqual([{ id: first.id }, { id: second.id }])
      await expect(pool.selector.ordered('chatgpt')).resolves.toEqual([{ id: second.id }, { id: first.id }])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('checks cancellation inside the serialized add mutation', async () => {
    const { ctx, pool } = await fixture()
    try {
      const controller = new AbortController()
      controller.abort('cancelled')
      await expect(pool.add('cancelled', {
        type: 'oauth', access: 'access', refresh: 'refresh', expires: 1,
      }, controller.signal)).rejects.toMatchObject({ code: 'ABORTED' })
      await expect(pool.accounts.list()).resolves.toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('normalizes the official ChatGPT windows and banked reset credits', async () => {
    const { ctx, pool } = await fixture()
    try {
      const account = await pool.add('ChatGPT', {
        type: 'oauth', access: 'access', refresh: 'refresh', expires: Date.now() + 60_000,
        accountId: 'account-1',
      })
      const requests: Array<{ url: string; init?: RequestInit }> = []
      vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        requests.push({ url, ...(init === undefined ? {} : { init }) })
        return new Response(JSON.stringify(url.endsWith('/usage')
          ? { plan_type: 'plus', rate_limit: {
            primary_window: { used_percent: 25, limit_window_seconds: 18_000, reset_at: 1_800_000_000 },
            secondary_window: { used_percent: 50, limit_window_seconds: 604_800, reset_at: 1_800_500_000 },
          } } : { available_count: 2 }), { status: 200, headers: { 'content-type': 'application/json' } })
      }))
      const usage = await readAccountUsage(pool, account.id, 'chatgpt', {}, 5_000)
      expect(usage.planType).toBe('plus')
      expect(usage.limits.map(limit => [limit.name, limit.windowMinutes, limit.usedPercent])).toEqual([
        ['Codex', 300, 25], ['Codex', 10_080, 50],
      ])
      expect(usage.bankedResetCount).toBe(2)
      expect(requests.map(request => request.url)).toEqual([
        'https://chatgpt.com/backend-api/wham/usage',
        'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits',
      ])
      expect(requests[0]?.init?.headers).toMatchObject({
        accept: 'application/json', authorization: 'Bearer access', 'chatgpt-account-id': 'account-1',
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('keeps usage when the optional banked reset endpoint is unavailable', async () => {
    const { ctx, pool } = await fixture()
    try {
      const account = await pool.add('ChatGPT', {
        type: 'oauth', access: 'access', refresh: 'refresh', expires: Date.now() + 60_000,
        accountId: 'account-2',
      })
      vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        return url.endsWith('/usage')
          ? Response.json({ plan_type: 'plus', rate_limit: { primary_window: { used_percent: 0 } } })
          : new Response('missing', { status: 404 })
      }))
      const usage = await readAccountUsage(pool, account.id, 'chatgpt', {}, 5_000)
      expect(usage.limits).toEqual([{ name: 'Codex', usedPercent: 0 }])
      expect(usage.bankedResetCount).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('covers optional ChatGPT usage windows and malformed provider responses', async () => {
    const { ctx, pool } = await fixture()
    try {
      const account = await pool.add('ChatGPT', {
        type: 'oauth', access: 'access', refresh: 'refresh', expires: Date.now() + 60_000,
        accountId: 'account-optional',
      })
      const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        if (url.endsWith('/usage')) return Response.json({ rate_limit: { primary_window: { used_percent: 1 } },
          code_review_rate_limit: { primary_window: { used_percent: 2, limit_window_seconds: 60 } },
          additional_rate_limits: [
            { limit_name: 'Tools', rate_limit: { primary_window: { used_percent: 3 } } },
            { metered_feature: 'Search', rate_limit: { primary_window: { used_percent: 4 } } },
          ], rate_limit_reset_credits: { credits: ['one'] } })
        return Response.json({})
      })
      vi.stubGlobal('fetch', fetch)
      const usage = await readAccountUsage(pool, account.id, 'chatgpt', {}, 5_000)
      expect(usage.limits.map(limit => limit.name)).toEqual(['Codex', 'Code review', 'Tools', 'Search'])
      expect(usage.bankedResetCount).toBe(1)
      await expect(readAccountUsage(pool, account.id, 'chatgpt', {}, 5_000)).resolves.toBeDefined()

      fetch.mockResolvedValue(Response.json({ plan_type: 'plus', additional_rate_limits: {} }))
      await expect(readAccountUsage(pool, account.id, 'chatgpt', {}, 5_000)).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
      fetch.mockResolvedValue(Response.json({ plan_type: 'plus', rate_limit: { primary_window: { used_percent: 101 } } }))
      await expect(readAccountUsage(pool, account.id, 'chatgpt', {}, 5_000)).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
      fetch.mockResolvedValue(Response.json({ plan_type: 'plus', rate_limit: { primary_window: { used_percent: 0 } }, additional_rate_limits: [{ rate_limit: {} }] }))
      await expect(readAccountUsage(pool, account.id, 'chatgpt', {}, 5_000)).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
      fetch.mockResolvedValue(Response.json({ nope: true }))
      await expect(readAccountUsage(pool, account.id, 'chatgpt', {}, 5_000)).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
      fetch.mockResolvedValue(new Response('bad', { status: 503 }))
      await expect(readAccountUsage(pool, account.id, 'chatgpt', {}, 5_000)).rejects.toMatchObject({ code: 'USAGE_UNAVAILABLE' })
    } finally { await ctx.fiber.dispose() }
  })

  it('maps usage transport failures and preserves caller cancellation', async () => {
    const { ctx, pool } = await fixture()
    try {
      const account = await pool.add('ChatGPT', {
        type: 'oauth', access: 'access', refresh: 'refresh', expires: Date.now() + 60_000,
        accountId: 'account-transport',
      })
      vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
      await expect(readAccountUsage(pool, account.id, 'chatgpt', {}, 5_000))
        .rejects.toMatchObject({ code: 'USAGE_UNAVAILABLE' })

      const controller = new AbortController()
      const cancelled = new Error('cancelled')
      vi.stubGlobal('fetch', vi.fn(async () => {
        controller.abort()
        throw cancelled
      }))
      await expect(readAccountUsage(pool, account.id, 'chatgpt', {}, 5_000, controller.signal)).rejects.toBe(cancelled)
    } finally { await ctx.fiber.dispose() }
  })

  it('refreshes expired ChatGPT and Antigravity grants before reading usage', async () => {
    const { ctx, pool } = await fixture()
    try {
      usageMocks.chatgptRefresh.mockResolvedValue({ type: 'oauth', access: 'fresh-chatgpt', refresh: 'refresh', expires: Date.now() + 60_000, accountId: 'refresh-chatgpt' })
      const chatgpt = await pool.add('ChatGPT', { type: 'oauth', access: 'old', refresh: 'refresh', expires: 1, accountId: 'refresh-chatgpt' })
      vi.stubGlobal('fetch', vi.fn(async () => Response.json({ plan_type: 'plus', rate_limit: { primary_window: { used_percent: 0 } } })))
      await expect(readAccountUsage(pool, chatgpt.id, 'chatgpt', {}, 5_000)).resolves.toMatchObject({ planType: 'plus' })
      expect(usageMocks.chatgptRefresh).toHaveBeenCalledOnce()
    } finally { await ctx.fiber.dispose() }

    const antigravityFixture = await fixture('antigravity')
    try {
      usageMocks.antigravityRefresh.mockResolvedValue({ access: 'fresh-antigravity', expires: Date.now() + 60_000 })
      const antigravity = await antigravityFixture.pool.add('Antigravity', { type: 'oauth', access: 'old', refresh: 'refresh', expires: 1, projectId: 'project-refresh' })
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input
        return url.includes('fetchAvailableModels')
          ? Response.json({ models: { gemini: { quotaInfo: { remainingFraction: 1 } } } })
          : Response.json({ currentTier: { id: 'free' } })
      }))
      await expect(readAccountUsage(antigravityFixture.pool, antigravity.id, 'antigravity', { endpoint: 'https://fixture.test' }, 5_000))
        .resolves.toMatchObject({ planType: 'free' })
      expect(usageMocks.antigravityRefresh).toHaveBeenCalledOnce()
    } finally { await antigravityFixture.ctx.fiber.dispose() }
  })

  it('rejects malformed and oversized ChatGPT quota responses', async () => {
    const { ctx, pool } = await fixture()
    try {
      const account = await pool.add('ChatGPT', { type: 'oauth', access: 'access', refresh: 'refresh', expires: Date.now() + 60_000, accountId: 'validation' })
      const window = { used_percent: 0 }
      for (const body of [
        [], { rate_limit: [] }, { rate_limit: { primary_window: [] } },
        { rate_limit: { primary_window: { ...window, reset_at: 'invalid' } } },
        { rate_limit: { primary_window: { ...window, limit_window_seconds: 0 } } },
        { rate_limit: {}, additional_rate_limits: [null] },
        { rate_limit: {}, rate_limit_reset_credits: { available_count: 0 }, additional_rate_limits: Array.from({ length: 257 }, () => ({ limit_name: 'Quota', rate_limit: { primary_window: window } })) },
      ]) {
        vi.stubGlobal('fetch', vi.fn(async () => Response.json(body)))
        await expect(readAccountUsage(pool, account.id, 'chatgpt', {}, 5_000)).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
      }
    } finally { await ctx.fiber.dispose() }
  })

  it('retains Antigravity quota when tier discovery fails and validates model data', async () => {
    const { ctx, pool } = await fixture('antigravity')
    try {
      const account = await pool.add('Antigravity', { type: 'oauth', access: 'access', refresh: 'refresh', expires: Date.now() + 60_000, projectId: 'project' })
      vi.stubGlobal('fetch', vi.fn(async input => String(input).endsWith(':fetchAvailableModels')
        ? Response.json({ models: { gemini: { quotaInfo: { remainingFraction: 1 } } } })
        : new Response(null, { status: 503 })))
      await expect(readAccountUsage(pool, account.id, 'antigravity', {}, 5_000, new AbortController().signal))
        .resolves.toMatchObject({ limits: [{ name: 'gemini', usedPercent: 0 }] })
      const invalidModels = [
        null,
        { '': { quotaInfo: { remainingFraction: 1 } } },
        Object.fromEntries(Array.from({ length: 257 }, (_, i) => [String(i), { quotaInfo: { remainingFraction: 1 } }])),
      ]
      for (const models of invalidModels) {
        vi.stubGlobal('fetch', vi.fn(async input => String(input).endsWith(':retrieveUserQuotaSummary')
          ? new Response(null, { status: 503 }) : Response.json({ models })))
        await expect(readAccountUsage(pool, account.id, 'antigravity', {}, 5_000)).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
      }
    } finally { await ctx.fiber.dispose() }
  })

  it('rejects disconnected grants and missing provider identities before fetching usage', async () => {
    for (const provider of ['chatgpt', 'antigravity'] as const) {
      const { ctx, pool } = await fixture(provider)
      try {
        const apiKey = await pool.add('API key', { type: 'api_key', key: 'secret' })
        await expect(readAccountUsage(pool, apiKey.id, provider, {}, 5_000)).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
        const account = await pool.add('Missing identity', { type: 'oauth', access: 'access', refresh: 'refresh', expires: Date.now() + 60_000 })
        await expect(readAccountUsage(pool, account.id, provider, {}, 5_000)).rejects.toMatchObject({ code: 'INVALID_CREDENTIAL' })
        const expired = await pool.add('Expired', { type: 'oauth', access: 'expired', refresh: 'refresh', expires: 1 })
        usageMocks.oauthAvailable = false
        await expect(readAccountUsage(pool, expired.id, provider, {}, 5_000)).rejects.toMatchObject({ code: 'INVALID_CREDENTIAL' })
        vi.spyOn(pool.credentials, 'modify').mockResolvedValue(undefined)
        await expect(readAccountUsage(pool, account.id, provider, {}, 5_000)).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
      } finally { await ctx.fiber.dispose() }
    }
  })

  it('reads Antigravity quota and tier through the configured endpoint', async () => {
    const { ctx, pool } = await fixture('antigravity')
    const server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', chunk => chunks.push(Buffer.from(String(chunk))))
      request.on('end', () => {
        const body = Buffer.concat(chunks).toString()
        if (request.url === '/v1internal:retrieveUserQuotaSummary') {
          expect(request.method).toBe('POST')
          expect(request.headers.authorization).toBe('Bearer access')
          expect(JSON.parse(body)).toEqual({ project: 'project-1' })
          response.setHeader('content-type', 'application/json')
          response.end(JSON.stringify({ groups: [{ displayName: 'Gemini Models', description: 'Gemini pool', buckets: [{
            bucketId: 'gemini-weekly', displayName: 'Weekly Limit Remaining', description: 'Weekly quota', window: 'WEEKLY',
            remainingFraction: 0.75, remainingAmount: '42', disabled: false, resetTime: '2026-09-27T00:00:00Z',
          }] }] }))
          return
        }
        if (request.url === '/v1internal:fetchAvailableModels') {
          expect(request.method).toBe('POST')
          expect(request.headers.authorization).toBe('Bearer access')
          expect(JSON.parse(body)).toEqual({ project: 'project-1' })
          response.setHeader('content-type', 'application/json')
          response.end(JSON.stringify({ models: {
            gemini: { displayName: 'Gemini', quotaInfo: { remainingFraction: 0.75, resetTime: '2026-09-27T00:00:00Z' } },
            internal: { isInternal: true, quotaInfo: { remainingFraction: 0.1 } },
          } }))
          return
        }
        expect(request.url).toBe('/v1internal:loadCodeAssist')
        expect(request.method).toBe('POST')
        expect(request.headers.authorization).toBe('Bearer access')
        expect(JSON.parse(body)).toMatchObject({ cloudaicompanionProject: 'project-1' })
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ paidTier: {
          name: 'Pro', availableCredits: {
            creditType: 'GOOGLE_ONE_AI', creditAmount: '42', minimumCreditAmountForUsage: '1',
          },
        } }))
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    try {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('test server did not expose a port')
      const account = await pool.add('Antigravity', {
        type: 'oauth', access: 'access', refresh: 'refresh', expires: Date.now() + 60_000,
        projectId: 'project-1',
      })
      const usage = await readAccountUsage(pool, account.id, 'antigravity', {
        endpoint: `http://127.0.0.1:${address.port}`,
      }, 5_000)
      expect(usage.planType).toBe('Pro')
      expect(usage.limits).toEqual([{
        name: 'Weekly Limit Remaining', group: 'Gemini Models', window: 'WEEKLY', description: 'Weekly quota',
        windowMinutes: 10_080, usedPercent: 25, remainingAmount: 42, disabled: false,
        resetsAt: Math.floor(Date.parse('2026-09-27T00:00:00Z') / 1000),
      }])
      expect(usage.credits).toEqual([{ tier: 'paid', creditType: 'GOOGLE_ONE_AI', creditAmount: 42, minimumCreditAmountForUsage: 1 }])
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      }))
      await ctx.fiber.dispose()
    }
  })

  it('reports unavailable Antigravity quotas and rejects invalid fractions', async () => {
    const read = async (models: Record<string, unknown>) => {
      const { ctx, pool } = await fixture('antigravity')
      const server = createServer((request, response) => {
        request.resume()
        request.on('end', () => {
          if (request.url?.endsWith(':retrieveUserQuotaSummary')) {
            response.statusCode = 503
            response.end()
            return
          }
          response.setHeader('content-type', 'application/json')
          response.end(JSON.stringify(request.url?.endsWith(':fetchAvailableModels')
            ? { models } : {}))
        })
      })
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
      })
      try {
        const address = server.address()
        if (address === null || typeof address === 'string') throw new Error('test server did not expose a port')
        const account = await pool.add('Antigravity', {
          type: 'oauth', access: 'access', refresh: 'refresh', expires: Date.now() + 60_000,
          projectId: 'project-2',
        })
        return await readAccountUsage(pool, account.id, 'antigravity', {
          endpoint: `http://127.0.0.1:${address.port}`,
        }, 5_000)
      } finally {
        await new Promise<void>((resolve, reject) => server.close((error) => {
          if (error === undefined) resolve()
          else reject(error)
        }))
        await ctx.fiber.dispose()
      }
    }
    const unavailable = await read({ gemini: { displayName: 'Gemini' } })
    expect(unavailable.limits).toEqual([])
    expect(unavailable.planType).toBeUndefined()
    await expect(read({ gemini: { quotaInfo: { remainingFraction: 2 } } })).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })

  it('covers Antigravity quota fields, fallback buckets, and credit variants', async () => {
    const { ctx, pool } = await fixture('antigravity')
    try {
      const account = await pool.add('Antigravity', {
        type: 'oauth', access: 'access', refresh: 'refresh', expires: Date.now() + 60_000,
        projectId: 'project-fields',
      })
      let loadBody: unknown = {
        currentTier: { availableCredits: { creditAmount: '5' } },
        paidTier: { availableCredits: { minimumCreditAmountForUsage: '2' } },
        g1Tier: { availableCredits: { creditType: 'G1' } },
      }
      vi.stubGlobal('fetch', vi.fn(async (input) => {
        const url = String(input)
        if (url.endsWith(':retrieveUserQuotaSummary')) return Response.json({ groups: [
          { displayName: '', buckets: [
            { bucketId: 'five-hour', remainingFraction: 0, window: 'five hours' },
            { bucketId: 'unknown-window', remainingFraction: 0.5, window: 'mystery', description: '', remainingAmount: 0 },
            { bucketId: 'null-fields', remainingFraction: 0.25, window: null, description: null },
            { bucketId: 'ignored' },
          ] },
          { displayName: 'no-buckets' },
        ] })
        if (url.endsWith(':loadCodeAssist')) return Response.json(loadBody)
        return Response.json({})
      }))
      const usage = await readAccountUsage(pool, account.id, 'antigravity', {}, 5_000)
      expect(usage.limits.map(limit => [limit.name, limit.windowMinutes, limit.window, limit.remainingAmount])).toEqual([
        ['five-hour', 300, 'five hours', undefined],
        ['unknown-window', undefined, 'mystery', 0],
        ['null-fields', undefined, undefined, undefined],
      ])
      expect(usage.credits).toEqual([
        { tier: 'current', creditAmount: 5 },
        { tier: 'paid', minimumCreditAmountForUsage: 2 },
        { tier: 'g1', creditType: 'G1' },
      ])

      loadBody = { currentTier: { availableCredits: {} } }
      const emptyCredits = await readAccountUsage(pool, account.id, 'antigravity', {}, 5_000)
      expect(emptyCredits.credits).toBeUndefined()
      loadBody = { currentTier: { availableCredits: { creditType: null, creditAmount: '0' } } }
      await expect(readAccountUsage(pool, account.id, 'antigravity', {}, 5_000)).resolves.toMatchObject({
        credits: [{ tier: 'current', creditAmount: 0 }],
      })

      vi.stubGlobal('fetch', vi.fn(async input => String(input).endsWith(':retrieveUserQuotaSummary')
        ? Response.json({ groups: [], buckets: [{ bucketId: 'fallback', remainingFraction: 0.5 }, { bucketId: 'ignored' }] })
        : Response.json({})))
      const fallback = await readAccountUsage(pool, account.id, 'antigravity', {}, 5_000)
      expect(fallback.limits).toEqual([{ name: 'fallback', usedPercent: 50 }])
    } finally { await ctx.fiber.dispose() }
  })

  it('rejects malformed Antigravity summaries, buckets, and oversized lists', async () => {
    const { ctx, pool } = await fixture('antigravity')
    try {
      const account = await pool.add('Antigravity', {
        type: 'oauth', access: 'access', refresh: 'refresh', expires: Date.now() + 60_000,
        projectId: 'project-invalid',
      })
      const validBucket = { bucketId: 'valid', remainingFraction: 0.5 }
      const invalidBodies: unknown[] = [
        { groups: {} }, { buckets: {} }, { groups: [null] }, { groups: [{ buckets: {} }] },
        { groups: [{ buckets: [null] }] },
        { groups: [{ buckets: [{ ...validBucket, remainingFraction: 2 }] }] },
        { groups: [{ buckets: [{ remainingFraction: 0 }] }] },
        { groups: [{ buckets: [{ ...validBucket, window: 1 }] }] },
        { groups: [{ buckets: [{ ...validBucket, description: 1 }] }] },
        { groups: [{ buckets: [{ ...validBucket, remainingAmount: null }] }] },
        { groups: [{ buckets: [{ ...validBucket, remainingAmount: 'bad' }] }] },
        { groups: [{ buckets: [{ ...validBucket, disabled: 1 }] }] },
        { groups: [{ buckets: [{ ...validBucket, resetTime: 'invalid' }] }] },
      ]
      for (const body of invalidBodies) {
        vi.stubGlobal('fetch', vi.fn(async input => String(input).endsWith(':retrieveUserQuotaSummary')
          ? Response.json(body) : Response.json({})))
        await expect(readAccountUsage(pool, account.id, 'antigravity', {}, 5_000))
          .rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
      }
      vi.stubGlobal('fetch', vi.fn(async input => String(input).endsWith(':retrieveUserQuotaSummary')
        ? Response.json({ groups: Array.from({ length: 257 }, () => ({ buckets: [validBucket] })) })
        : Response.json({})))
      await expect(readAccountUsage(pool, account.id, 'antigravity', {}, 5_000))
        .rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
      vi.stubGlobal('fetch', vi.fn(async input => String(input).endsWith(':retrieveUserQuotaSummary')
        ? Response.json({ groups: [], buckets: Array.from({ length: 257 }, () => validBucket) })
        : Response.json({})))
      await expect(readAccountUsage(pool, account.id, 'antigravity', {}, 5_000))
        .rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
    } finally { await ctx.fiber.dispose() }
  })

  it('covers model quota resets, optional credit failures, and non-usage errors', async () => {
    const { ctx, pool } = await fixture('antigravity')
    try {
      const account = await pool.add('Antigravity', {
        type: 'oauth', access: 'access', refresh: 'refresh', expires: Date.now() + 60_000,
        projectId: 'project-models',
      })
      let loadBody: unknown = { currentTier: { id: 'Free' } }
      vi.stubGlobal('fetch', vi.fn(async (input) => {
        const url = String(input)
        if (url.endsWith(':retrieveUserQuotaSummary')) return new Response(null, { status: 503 })
        if (url.endsWith(':fetchAvailableModels')) return Response.json({ models: {
          named: { displayName: 'Named', quotaInfo: { remainingFraction: 0.25, resetTime: '2026-09-27T00:00:00Z' } },
          internal: { isInternal: true, quotaInfo: { remainingFraction: 0.1 } },
          missing: {},
        } })
        return Response.json(loadBody)
      }))
      const usage = await readAccountUsage(pool, account.id, 'antigravity', {}, 5_000)
      expect(usage.planType).toBe('Free')
      expect(usage.limits).toEqual([{
        name: 'Named', usedPercent: 75, resetsAt: Math.floor(Date.parse('2026-09-27T00:00:00Z') / 1000),
      }])

      for (const credits of [
        { creditType: 1 }, { creditAmount: 'bad' }, { minimumCreditAmountForUsage: 'bad' },
        { creditAmount: null }, { minimumCreditAmountForUsage: null }, [],
      ]) {
        loadBody = { currentTier: { availableCredits: credits } }
        const optional = await readAccountUsage(pool, account.id, 'antigravity', {}, 5_000)
        expect(optional.limits).toHaveLength(1)
        expect(optional.credits).toBeUndefined()
      }

      vi.stubGlobal('fetch', vi.fn(async () => Response.json({ groups: {} })))
      await expect(readAccountUsage(pool, account.id, 'antigravity', {}, 5_000))
        .rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
    } finally { await ctx.fiber.dispose() }
  })

  it('hashes oversized combined token identities without collapsing users', async () => {
    const { ctx, pool } = await fixture()
    try {
      const account = 'a'.repeat(200)
      const firstUser = 'u'.repeat(200)
      const secondUser = 'v'.repeat(200)
      const grant = (userId: string) => ({
        type: 'oauth',
        access: 'access',
        refresh: 'refresh',
        expires: 1,
        accountId: account,
        userId,
      }) as Credential & Record<string, unknown>
      const added = await pool.add('first identity', grant(firstUser))
      const second = await pool.add('second identity', grant(secondUser))
      const relogged = await pool.add('first identity updated', grant(firstUser))
      expect(added.id).not.toBe(account)
      expect(added.id).not.toBe(second.id)
      expect(added.id).toBe(relogged.id)
      expect(added.id.length).toBeLessThanOrEqual(256)
      await expect(pool.accounts.list()).resolves.toEqual([
        { id: added.id, label: 'first identity updated' },
        { id: second.id, label: 'second identity' },
      ])
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('stored account pool validation', () => {
  const valid = { id: 'account', label: 'Account', credential: { type: 'oauth', access: 'access', refresh: 'refresh', expires: 1 } }
  const record = (accounts: unknown): CredentialRecord => ({ kind: 'grant', payload: { version: 1, accounts } })

  it.each([undefined, null, [], 'entry', { ...valid, id: '' }, { ...valid, id: 'x'.repeat(257) },
    { ...valid, label: '' }, { ...valid, label: 'x'.repeat(513) },
  ])('rejects a malformed persisted account: %j', (entry) => {
    expect(() => parseAccountPool(record([entry]))).toThrow('invalid account entry')
  })

  it.each([undefined, null, [], {}, { type: 'other' },
    { ...valid.credential, access: '' }, { ...valid.credential, access: 1 },
    { ...valid.credential, refresh: '' }, { ...valid.credential, refresh: 1 },
    { ...valid.credential, expires: '1' }, { ...valid.credential, expires: Infinity },
    { type: 'api_key', key: '' }, { type: 'api_key', key: 1 },
    { type: 'api_key', env: [] }, { type: 'api_key', env: { KEY: 1 } },
  ])('rejects malformed stored credentials: %j', (credential) => {
    expect(() => parseAccountPool(record([{ ...valid, credential }]))).toThrow('invalid account entry')
  })

  it('rejects invalid envelopes, duplicate identities, and non-cloneable credentials', () => {
    expect(() => parseAccountPool({ kind: 'secret', value: 'key' } as never)).toThrow('grant record')
    for (const payload of [null, [], { version: 2, accounts: [] }, { version: 1, accounts: {} }]) {
      expect(() => parseAccountPool({ kind: 'grant', payload })).toThrow('invalid account-pool payload')
    }
    expect(() => parseAccountPool(record([valid, valid]))).toThrow('duplicate account ids')
    expect(() => parseAccountPool(record([{ ...valid, credential: { ...valid.credential, callback() {} } }])))
      .toThrow('invalid account entry')
  })

  it('accepts OAuth and environment-backed credentials and detaches stored data', () => {
    const input = record([valid, { ...valid, id: 'api', credential: { type: 'api_key', env: { KEY: 'value' } } }])
    const parsed = parseAccountPool(input)
    expect(parsed.accounts).toHaveLength(2)
    expect(parsed.accounts[0]?.credential).toEqual(valid.credential)
    expect(parsed.accounts[0]?.credential).not.toBe(valid.credential)
  })
})

it('refreshes shared Google grants for Antigravity usage while retaining the quota project', async () => {
  const { ctx, pool } = await fixture('antigravity')
  try {
    const account = await pool.add('Google', { type: 'oauth', access: 'old', refresh: 'refresh', expires: 0, projectId: 'assist-project', quotaProjectId: 'fixture-project' })
    usageMocks.antigravityRefresh.mockResolvedValue({ access: 'fresh', refresh: 'refresh', expires: Date.now() + 60_000, projectId: 'assist-project' })
    const fetcher = vi.fn(async (_input: unknown, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fresh')
      return Response.json({ models: {} })
    })
    vi.stubGlobal('fetch', fetcher)
    expect(await readAccountUsage(pool, account.id, 'antigravity', {}, 1000)).toMatchObject({ limits: [] })
    expect(usageMocks.antigravityRefresh).toHaveBeenCalledOnce()
    expect(await pool.withAccount(account.id, () => pool.credentials.read('antigravity'))).toMatchObject({ access: 'fresh', quotaProjectId: 'fixture-project' })
  } finally {
    await ctx.fiber.dispose()
  }
})

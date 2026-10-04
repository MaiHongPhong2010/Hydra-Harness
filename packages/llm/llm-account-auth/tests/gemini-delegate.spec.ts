/** Gemini conversation delegation, OAuth refresh, and profile propagation. */
import { Context } from '@hydraharness/cordis'
import type { StreamChunk } from '@hydraharness/harness-llm'
import type { PiAiAdapterOptions } from '@hydraharness/harness-llm-pi-ai'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MemoryCredentials } from '../../../credentials/authorization/tests/memory.ts'
import { accountRecordKey, createAccountPool } from '../src/accounts.ts'
import { GeminiApiAccountAdapter } from '../src/gemini-api.ts'

const sdk = vi.hoisted(() => ({ create: vi.fn() }))
vi.mock('@hydraharness/harness-llm-pi-ai', async load => ({
  ...await load<typeof import('@hydraharness/harness-llm-pi-ai')>(),
  PiAiAdapter: sdk.create,
}))
const contexts: Context[] = []
const grant = { type: 'oauth' as const, access: 'access', refresh: 'refresh', expires: Date.now() + 60_000,
  projectId: 'code-assist', quotaProjectId: 'fixture-project', email: 'person@example.test' }
const finish: StreamChunk = { type: 'finish', reason: { kind: 'stop' } }
const delegate = {
  listModels: vi.fn(async () => [{ provider: 'gemini-api', id: 'gemini-fixture' }]),
  resolveModel: vi.fn(async () => ({ provider: 'gemini-api', id: 'gemini-fixture' })),
  stream: vi.fn(async function* () { yield finish }),
}
beforeEach(() => {
  vi.clearAllMocks()
  sdk.create.mockImplementation(function() { return delegate })
})
afterEach(async () => {
  vi.unstubAllGlobals()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})
async function pool() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(MemoryCredentials)
  const accounts = createAccountPool({ ctx, key: accountRecordKey('gemini-api'), providerId: 'gemini-api', providerAliases: ['antigravity'], providerLabel: 'Google' })
  await accounts.add('person', grant)
  return accounts
}

it.each([false, true])('reuses its delegate, forwards OAuth and conversation options: %s', async (configured) => {
  const accounts = await pool()
  const attachments = () => undefined
  vi.stubGlobal('fetch', async () => Response.json({ models: [{ name: 'models/gemini-fixture' }] }))
  const adapter = new GeminiApiAccountAdapter(accounts, configured ? {
    models: [{ id: 'gemini-fixture' }], defaultContextWindow: 4096, defaultMaxTokens: 512,
    streamIdleTimeoutMs: 1000, timeoutMs: 1000, retryPolicy: { mode: 'normal', maxRetries: 0 }, reasoning: 'off',
    thinkingBudgets: { minimal: 1, low: 2, medium: 3, high: 4 }, cacheRetention: 'short', transport: 'sse',
    websocketConnectTimeoutMs: 500, maxRequestImageBytes: 4096,
  } : {}, configured ? attachments : undefined)
  expect(adapter.providerInfo('gemini-api')).toEqual({ id: 'gemini-api', name: 'Google Gemini API OAuth' })
  expect(await adapter.listModels('gemini-api')).toEqual([{ provider: 'gemini-api', id: 'gemini-fixture' }])
  expect(await adapter.resolveModel('gemini-api', 'gemini-fixture')).toEqual({ provider: 'gemini-api', id: 'gemini-fixture' })
  const chunks = []
  for await (const chunk of adapter.stream({ provider: 'gemini-api', model: 'gemini-fixture', messages: [] })) chunks.push(chunk)
  expect(chunks).toEqual([finish])
  expect(delegate.stream).toHaveBeenCalledOnce()
  expect(sdk.create).toHaveBeenCalledOnce()
  const options = sdk.create.mock.calls[0]?.[0] as PiAiAdapterOptions
  const profile = options.profiles().get('gemini-api')!
  expect(options.resolveAttachments).toBe(configured ? attachments : undefined)
  await expect(options.resolveApiKey('gemini-api', profile)).resolves.toBeUndefined()
  const oauth = profile.piProvider.auth.oauth!
  await expect(oauth.login({ signal: new AbortController().signal, notify: vi.fn(), prompt: vi.fn() })).rejects.toMatchObject({ code: 'INVALID_AUTH_CONFIG' })
  await expect(oauth.toAuth(grant)).resolves.toEqual({ apiKey: 'access', headers: { 'x-goog-user-project': 'fixture-project' } })
  vi.stubGlobal('fetch', async () => Response.json({ access_token: 'fresh', expires_in: 3600 }))
  await expect(oauth.refresh(grant, configured ? new AbortController().signal : undefined)).resolves.toMatchObject({ access: 'fresh', email: grant.email })
  expect(adapter.providerRetryPolicy()).toMatchObject({ mode: 'normal' })
  if (configured) expect(profile).toMatchObject({ streamIdleTimeoutMs: 1000, maxRequestImageBytes: 4096, reasoning: 'off', cacheRetention: 'short', transport: 'sse' })
})

it('retries delegate construction after failed model discovery', async () => {
  const accounts = await pool()
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValueOnce(Response.json({ models: [{ name: 'models/gemini-fixture' }] }))
  vi.stubGlobal('fetch', fetcher)
  const adapter = new GeminiApiAccountAdapter(accounts, {})
  await expect(adapter.listModels('gemini-api')).rejects.toMatchObject({ code: 'DISCOVERY_FAILED' })
  expect(await adapter.listModels('gemini-api')).toEqual([{ provider: 'gemini-api', id: 'gemini-fixture' }])
  expect(fetcher).toHaveBeenCalledTimes(2)
  expect(sdk.create).toHaveBeenCalledOnce()
})

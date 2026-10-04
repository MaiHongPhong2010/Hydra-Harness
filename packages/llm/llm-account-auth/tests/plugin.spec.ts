import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Context } from '@hydraharness/cordis'
import Authorization, { type AuthorizationSession } from '@hydraharness/harness-authorization'
import { credentialKey } from '@hydraharness/harness-credentials'
import Llm, { type GenerateOptions, type StreamChunk } from '@hydraharness/harness-llm'
import { MemoryCredentials } from '../../../credentials/authorization/tests/memory.ts'
import * as AccountAuth from '../src/index.ts'
import type { Config } from '../src/config.ts'
import type { AntigravityAdapterOptions, PiAiAccountAdapterOptions } from '../src/adapter.ts'

const runtime = vi.hoisted(() => ({
  chatgpt: vi.fn(), antigravity: vi.fn(), gemini: vi.fn(), profile: vi.fn(), loginChatGpt: vi.fn(), loginGoogle: vi.fn(),
  sdkProfile: vi.fn(), sdkLogin: vi.fn(), cursorLogin: vi.fn(), kiroLogin: vi.fn(), kiro: vi.fn(),
}))
vi.mock('../src/adapter.ts', () => ({
  PiAiAccountAdapter: runtime.chatgpt,
  AntigravityAccountAdapter: runtime.antigravity,
}))
vi.mock('../src/chatgpt.ts', () => ({
  buildChatGptProfile: runtime.profile,
  loginChatGpt: runtime.loginChatGpt,
}))
vi.mock('../src/google-oauth.ts', () => ({ loginGoogle: runtime.loginGoogle }))
vi.mock('../src/gemini-api.ts', () => ({ GeminiApiAccountAdapter: runtime.gemini }))
vi.mock('../src/sdk-accounts.ts', () => ({ buildSdkAccountProfile: runtime.sdkProfile, loginSdkAccount: runtime.sdkLogin }))
vi.mock('../src/native-login.ts', () => ({ loginCursor: runtime.cursorLogin, loginKiro: runtime.kiroLogin }))
vi.mock('../src/kiro.ts', () => ({ KiroAccountAdapter: runtime.kiro }))

const finish: StreamChunk = { type: 'finish', reason: { kind: 'stop' } }
const delegate = {
  requestGeneration: vi.fn(async () => Response.json({ result: 'generated' })),
  listModels: vi.fn(async () => [{ id: 'model', provider: 'chatgpt', name: 'Model' }]),
  resolveModel: vi.fn(async () => ({ provider: 'chatgpt', id: 'model', contextWindow: 1000 })),
  discoverModels: vi.fn(async () => [{ id: 'discovered' }]),
  stream: vi.fn(async function* (_options: GenerateOptions) { yield finish }),
}
const contexts: Context[] = []

beforeEach(() => {
  vi.clearAllMocks()
  runtime.profile.mockImplementation(async (profile: unknown) => profile)
  runtime.sdkProfile.mockImplementation(async (_provider: string, profile: unknown) => profile)
  runtime.kiro.mockImplementation(function() { return delegate })
  runtime.gemini.mockImplementation(function() { return delegate })
  runtime.chatgpt.mockImplementation(function(options: PiAiAccountAdapterOptions) {
    options.profile()
    options.resolveAttachments?.()
    return delegate
  })
  runtime.antigravity.mockImplementation(function(options: AntigravityAdapterOptions) {
    options.profile()
    options.resolveAttachments?.()
    return delegate
  })
})

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  vi.restoreAllMocks()
})

async function fixture(config: Config = { providers: { chatgpt: {}, antigravity: {} } }) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Llm)
  await ctx.plugin(MemoryCredentials)
  await ctx.plugin(Authorization)
  const registrations = vi.spyOn(ctx.llm, 'registerAdapter')
  const flows = vi.spyOn(ctx.authorization, 'registerFlow')
  await ctx.plugin(AccountAuth, config)
  const adapter = (provider: string) => {
    const found = registrations.mock.calls.find(([providers]) => providers.includes(provider))?.[1]
    if (found === undefined) throw new Error(`missing ${provider} adapter`)
    return found
  }
  return { ctx, adapter, flows }
}

it('offers all native account flows while keeping Cursor out of callable chat providers', async () => {
  const providers = ['chatgpt', 'antigravity', 'gemini-api', 'claude', 'xai-account', 'kimi', 'cursor', 'kiro']
  const { ctx, flows } = await fixture({ providers: Object.fromEntries(providers.map(provider => [provider, {}])) })
  expect(flows.mock.calls.map(([flow]) => flow.key)).toEqual(providers.filter(provider => provider !== 'gemini-api').map(provider => `llm-account-auth/${provider}`))
  expect(flows.mock.calls.find(([flow]) => flow.label === 'Google')?.[0].methods).toEqual([
    { id: 'oauth', label: 'Sign in with Google for Antigravity' },
    { id: 'gemini-api', label: 'Connect Gemini API with a Cloud project' },
  ])
  expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(providers.filter(provider => provider !== 'cursor'))
  const login: AuthorizationSession = { method: 'oauth', signal: new AbortController().signal, notify: vi.fn(), prompt: vi.fn(async () => '') }
  for (const [flow] of flows.mock.calls) {
    if (flow.key.endsWith('/chatgpt') || flow.key.endsWith('/antigravity')) continue
    await flow.run(login)
  }
  for (const provider of ['claude', 'xai-account', 'kimi']) expect(runtime.sdkLogin).toHaveBeenCalledWith(provider, login, expect.objectContaining({ key: `llm-account-auth/${provider}` }))
  expect(runtime.cursorLogin).toHaveBeenCalledWith(login, expect.objectContaining({ key: 'llm-account-auth/cursor' }), expect.any(Object))
  expect(runtime.kiroLogin).toHaveBeenCalledWith(login, expect.objectContaining({ key: 'llm-account-auth/kiro' }), expect.any(Object))
  await expect(ctx.llm.discoverModels('llm-account-auth', { provider: 'cursor' })).rejects.toMatchObject({ code: 'NO_ADAPTER' })
})

it.each(['gemini-api', 'kiro', 'claude', 'xai-account', 'kimi'])('loads the configured %s adapter and forwards media generation', async (provider) => {
  const { adapter } = await fixture({ providers: { [provider]: {} } })
  const route = adapter(provider)
  expect(await route.listModels(provider)).toEqual([{ id: 'model', provider: 'chatgpt', name: 'Model' }])
  const options = { provider, model: 'image', endpoint: 'images/generations' as const, body: { prompt: 'a cat' }, maxResponseBytes: 1024, signal: new AbortController().signal }
  expect(await (await route.requestGeneration(options)).json()).toEqual({ result: 'generated' })
  expect(delegate.requestGeneration).toHaveBeenLastCalledWith(options)
})

it('offers Google and native login flows before their routes are configured', async () => {
  const { flows } = await fixture({ providers: {} })
  const session: AuthorizationSession = { method: 'oauth', signal: new AbortController().signal, notify: vi.fn(), prompt: vi.fn(async () => '') }
  for (const [flow] of flows.mock.calls) await flow.run(session)
  expect(runtime.loginGoogle).toHaveBeenCalledWith(session, expect.any(Object), {}, {})
  expect(runtime.cursorLogin).toHaveBeenCalledWith(session, expect.any(Object), {})
  expect(runtime.kiroLogin).toHaveBeenCalledWith(session, expect.any(Object), {})
})

it('reuses lazy delegates and invalidates only the changed account route', async () => {
  const { ctx, adapter } = await fixture()
  const chatgpt = adapter('chatgpt')
  expect(chatgpt.providerInfo('chatgpt')).toEqual({ id: 'chatgpt', name: 'ChatGPT' })
  expect(adapter('antigravity').providerInfo('antigravity').name).toBe('Google Antigravity')
  expect(await chatgpt.listModels('chatgpt')).toEqual(await chatgpt.listModels('chatgpt'))
  expect(runtime.chatgpt).toHaveBeenCalledOnce()
  const signal = new AbortController().signal
  await chatgpt.resolveModel('chatgpt', 'model', signal)
  expect(delegate.resolveModel).toHaveBeenCalledWith('chatgpt', 'model', signal)
  for (const requestSignal of [undefined, signal]) {
    const options = { provider: 'chatgpt', model: 'model', messages: [], ...(requestSignal === undefined ? {} : { signal: requestSignal }) }
    const chunks: StreamChunk[] = []
    for await (const chunk of chatgpt.stream(options)) chunks.push(chunk)
    expect(chunks).toEqual([finish])
    expect(delegate.stream).toHaveBeenLastCalledWith(options)
  }
  ctx.emit('credentials/record-updated', credentialKey('other', 'provider'))
  await chatgpt.listModels('chatgpt')
  expect(runtime.chatgpt).toHaveBeenCalledOnce()
  ctx.emit('credentials/record-updated', credentialKey('llm-account-auth', 'chatgpt'))
  await chatgpt.listModels('chatgpt')
  expect(runtime.chatgpt).toHaveBeenCalledTimes(2)
})

it('discovers dormant routes without enabling them and rejects unknown providers', async () => {
  const { ctx, flows } = await fixture({ providers: {} })
  const signal = new AbortController().signal
  for (const provider of ['chatgpt', 'antigravity']) {
    expect(await ctx.llm.discoverModels('llm-account-auth', { provider, signal })).toEqual([{ id: 'discovered' }])
    expect(delegate.discoverModels).toHaveBeenLastCalledWith(signal)
    ctx.emit('credentials/record-updated', credentialKey('llm-account-auth', provider))
  }
  expect(ctx.llm.listProviders()).toEqual([])
  await expect(ctx.llm.discoverModels('llm-account-auth', { provider: 'unknown' }))
    .rejects.toMatchObject({ code: 'INVALID_DISCOVERY' })
  await expect(ctx.llm.discoverModels('llm-account-auth', {
    provider: 'chatgpt', signal: AbortSignal.abort(new Error('cancel discovery')),
  })).rejects.toThrow('cancel discovery')
  await ctx.llm.discoverModels('llm-account-auth', { provider: 'antigravity' })
  for (const [flow] of flows.mock.calls) {
    if (flow.accounts?.usage === undefined) continue
    await expect(flow.accounts.usage('missing' as never)).rejects.toMatchObject({ code: 'ACCOUNT_GONE' })
  }
})

it('passes a configured account-usage timeout to the reader', async () => {
  const defaultFixture = await fixture({ providers: { chatgpt: {} } })
  const defaultFlow = defaultFixture.flows.mock.calls[0]?.[0]
  if (defaultFlow?.accounts?.usage === undefined) throw new Error('account usage flow was not registered')
  await expect(defaultFlow.accounts.usage('missing' as never)).rejects.toMatchObject({ code: 'ACCOUNT_GONE' })

  const { flows } = await fixture({ providers: { chatgpt: {} }, usageTimeoutMs: 1 })
  const flow = flows.mock.calls[0]?.[0]
  if (flow?.accounts?.usage === undefined) throw new Error('account usage flow was not registered')
  await expect(flow.accounts.usage('missing' as never)).rejects.toMatchObject({ code: 'ACCOUNT_GONE' })
})

it('retries rejected lazy loads without evicting a newer credential snapshot', async () => {
  const { ctx, adapter } = await fixture()
  runtime.profile.mockRejectedValueOnce(new Error('profile unavailable'))
  await expect(adapter('chatgpt').listModels('chatgpt')).rejects.toThrow('profile unavailable')
  await adapter('chatgpt').listModels('chatgpt')
  expect(runtime.profile).toHaveBeenCalledTimes(2)

  ctx.emit('credentials/record-updated', credentialKey('llm-account-auth', 'chatgpt'))
  const pending = Promise.withResolvers<never>()
  runtime.profile.mockReturnValueOnce(pending.promise)
  const first = adapter('chatgpt').listModels('chatgpt')
  const rejected = expect(first).rejects.toThrow('old profile')
  await vi.waitFor(() => { expect(runtime.profile).toHaveBeenCalledTimes(3) })
  ctx.emit('credentials/record-updated', credentialKey('llm-account-auth', 'chatgpt'))
  await adapter('chatgpt').listModels('chatgpt')
  pending.reject(new Error('old profile'))
  await rejected
  await adapter('chatgpt').listModels('chatgpt')
  expect(runtime.profile).toHaveBeenCalledTimes(4)
})

it('honors stream cancellation before and during delegate creation', async () => {
  const { adapter } = await fixture()
  const options = { provider: 'chatgpt', model: 'model', messages: [] }
  const canceled = adapter('chatgpt').stream({ ...options, signal: AbortSignal.abort(new Error('before load')) })
  await expect(canceled[Symbol.asyncIterator]().next()).rejects.toThrow('before load')
  expect(runtime.chatgpt).not.toHaveBeenCalled()
  const controller = new AbortController()
  runtime.profile.mockImplementationOnce(async (profile: unknown) => {
    controller.abort(new Error('during load'))
    return profile
  })
  const pending = adapter('chatgpt').stream({ ...options, signal: controller.signal })
  await expect(pending[Symbol.asyncIterator]().next()).rejects.toThrow('during load')
  expect(delegate.stream).not.toHaveBeenCalled()
})

it.each([{}, { callbackPort: 1234, callbackPath: '/callback', onboardingAttempts: 2, onboardingDelayMs: 5 }])(
  'passes both Google profiles to their one shared login: %j', async (profile) => {
    const { flows } = await fixture({ providers: { antigravity: profile } })
    const session: AuthorizationSession = {
      method: 'oauth', signal: new AbortController().signal, notify: vi.fn(), prompt: vi.fn(async () => ''),
    }
    for (const [flow] of flows.mock.calls) {
      if (flow.key === 'llm-account-auth/chatgpt' || flow.key === 'llm-account-auth/antigravity') await flow.run(session)
    }
    expect(runtime.loginChatGpt).toHaveBeenCalledWith(session, expect.objectContaining({ key: 'llm-account-auth/chatgpt' }))
    expect(runtime.loginGoogle).toHaveBeenCalledWith(session, expect.objectContaining({ key: 'llm-account-auth/antigravity' }), expect.objectContaining(profile), {})
  },
)

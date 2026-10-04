/** Shared Google PKCE, locked token refresh, and Gemini API requests through real account pools. */
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@hydraharness/cordis'
import type { AuthorizationSession } from '@hydraharness/harness-authorization'
import { LocalCredentialProvider } from '@hydraharness/harness-credentials-local'
import { afterEach, expect, it, vi } from 'vitest'
import { MemoryCredentials } from '../../../credentials/authorization/tests/memory.ts'
import { accountRecordKey, createAccountPool } from '../src/accounts.ts'
import { ANTIGRAVITY_CLIENT_ID, ANTIGRAVITY_CLIENT_SECRET } from '../src/antigravity-oauth.ts'
import { GeminiApiAccountAdapter } from '../src/gemini-api.ts'
import { loginGoogle, refreshGoogle, selectedGoogleCredential, type GoogleCredential } from '../src/google-oauth.ts'

const contexts: Context[] = []
const temporaryHomes: string[] = []
const realFetch = globalThis.fetch
const grant: GoogleCredential = { type: 'oauth', access: 'fixture-access', refresh: 'fixture-refresh',
  expires: Date.now() + 3600_000, projectId: 'code-assist-project', quotaProjectId: 'fixture-project' }

afterEach(async () => {
  vi.unstubAllGlobals()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const directory of temporaryHomes.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function pool() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(MemoryCredentials)
  return createAccountPool({ ctx, key: accountRecordKey('gemini-api'), providerId: 'gemini-api', providerAliases: ['antigravity'], providerLabel: 'Google Gemini API OAuth' })
}

it.each(['oauth', 'gemini-api'])('opens %s login before any API project prompt, validates the callback, and closes the listener', async (method) => {
  const accounts = await pool()
  let auth: URL | undefined
  let redirect = ''
  const requests = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString()
    if (url === 'https://oauth2.googleapis.com/token') {
      const fields = new URLSearchParams(init?.body as URLSearchParams)
      expect(fields.get('code')).toBe('fixture-code')
      expect(fields.get('client_id')).toBe(ANTIGRAVITY_CLIENT_ID)
      expect(fields.get('client_secret')).toBe(ANTIGRAVITY_CLIENT_SECRET)
      expect(fields.get('redirect_uri')).toBe(redirect)
      expect(createHash('sha256').update(fields.get('code_verifier')!).digest('base64url')).toBe(auth!.searchParams.get('code_challenge'))
      return Response.json({ access_token: grant.access, refresh_token: grant.refresh, expires_in: 3600, token_type: 'Bearer' })
    }
    if (url.endsWith('/v1internal:loadCodeAssist')) return Response.json({ cloudaicompanionProject: grant.projectId })
    if (url.includes('/models?pageSize=1')) {
      expect(new Headers(init?.headers).get('x-goog-user-project')).toBe(grant.quotaProjectId)
      return Response.json({ models: [{ name: 'models/gemini-test' }] })
    }
    expect(url).toBe('https://www.googleapis.com/oauth2/v2/userinfo?alt=json')
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${grant.access}`)
    return Response.json({ id: 'google-user', email: 'person@example.test' })
  })
  vi.stubGlobal('fetch', requests)
  const session: AuthorizationSession = {
    method, signal: new AbortController().signal,
    notify: ({ url }) => {
      if (url === undefined) return
      auth = new URL(url)
      redirect = auth.searchParams.get('redirect_uri')!
      expect(auth.searchParams.get('code_challenge_method')).toBe('S256')
      expect(auth.searchParams.get('scope')).toContain('cloud-platform')
    },
    prompt: async (question) => {
      if (question.kind === 'text') {
        expect(method).toBe('gemini-api')
        expect(auth).toBeDefined()
        return grant.quotaProjectId
      }
      const callback = new URL(redirect)
      callback.searchParams.set('state', 'wrong-state')
      callback.searchParams.set('code', 'fixture-code')
      expect((await realFetch(callback)).status).toBe(400)
      expect(requests).not.toHaveBeenCalled()
      callback.searchParams.set('state', auth!.searchParams.get('state')!)
      expect((await realFetch(callback)).status).toBe(200)
      return await new Promise<string>((_resolve, reject) => {
        question.signal!.addEventListener('abort', () => { reject(new Error('Callback received')) }, { once: true })
      })
    },
  }
  await loginGoogle(session, accounts, { callbackPort: 0 }, {})
  const id = method === 'gemini-api' ? 'person@example.test:fixture-project' : 'person@example.test'
  expect(await accounts.accounts.list()).toEqual([
    { id, label: method === 'gemini-api' ? 'person@example.test · fixture-project' : 'person@example.test' },
  ])
  const stored = await accounts.withAccount(id, () => accounts.credentials.read('antigravity'))
  expect(stored).toMatchObject({ projectId: grant.projectId, access: grant.access, refresh: grant.refresh })
  if (stored?.type !== 'oauth') throw new Error('expected a stored OAuth grant')
  expect(stored.quotaProjectId).toBe(method === 'gemini-api' ? grant.quotaProjectId : undefined)
  expect(requests.mock.calls.filter(([input]) => (input instanceof Request ? input.url : input.toString()).includes('/models')))
    .toHaveLength(method === 'gemini-api' ? 1 : 0)
  await expect(realFetch(redirect)).rejects.toThrow()
})

it.each(['', 'bad_project', 'abc'])(
  'opens Google login first and rejects invalid API quota project %j without storing credentials', async (value) => {
    const accounts = await pool()
    let auth: URL | undefined
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input.toString()
      if (url.includes('/token')) return Response.json({ access_token: grant.access, refresh_token: grant.refresh, expires_in: 3600 })
      if (url.includes('/userinfo')) return Response.json({ email: 'person@example.test' })
      expect(url).toContain(':loadCodeAssist')
      return Response.json({ cloudaicompanionProject: grant.projectId })
    })
    const session: AuthorizationSession = { method: 'gemini-api', signal: new AbortController().signal,
      notify: (notice) => { if (notice.url !== undefined) auth = new URL(notice.url) },
      prompt: async (question) => {
        expect(auth).toBeDefined()
        if (question.kind === 'text') return value
        const callback = new URL(auth!.searchParams.get('redirect_uri')!)
        callback.searchParams.set('state', auth!.searchParams.get('state')!)
        callback.searchParams.set('code', 'fixture-code')
        return callback.href
      } }
    await expect(loginGoogle(session, accounts, { callbackPort: 0 }, {})).rejects.toMatchObject({ code: 'INVALID_AUTH_CONFIG' })
    expect(await accounts.accounts.list()).toEqual([])
  },
)

it.each(['denied', 'malformed', 'canceled'])(
  'keeps existing grants when Gemini access validation is %s', async (result) => {
    const accounts = await pool()
    const existing = await accounts.add('existing', { ...grant, accountId: 'existing' })
    const controller = new AbortController()
    let auth: URL | undefined
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input.toString()
      if (url.includes('/token')) return Response.json({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 })
      if (url.includes('/userinfo')) return Response.json({ email: 'new@example.test' })
      if (url.endsWith(':loadCodeAssist')) return Response.json({ cloudaicompanionProject: grant.projectId })
      if (result === 'canceled') controller.abort(new Error('canceled before commit'))
      return result === 'denied' ? new Response('new-access new-refresh', { status: 403 }) : Response.json({})
    })
    const session: AuthorizationSession = { method: 'gemini-api', signal: controller.signal,
      notify: (notice) => { if (notice.url !== undefined) auth = new URL(notice.url) },
      prompt: (question) => {
        if (question.kind === 'text') return Promise.resolve(grant.quotaProjectId)
        const callback = new URL(auth!.searchParams.get('redirect_uri')!)
        callback.searchParams.set('state', auth!.searchParams.get('state')!)
        callback.searchParams.set('code', 'new-code')
        return Promise.resolve(callback.href)
      } }
    await expect(loginGoogle(session, accounts, { callbackPort: 0 }, {})).rejects.toThrow()
    expect(await accounts.accounts.list()).toEqual([existing])
    expect(await accounts.withAccount(existing.id, () => accounts.credentials.read('antigravity'))).toMatchObject({ access: grant.access })
  },
)

it('serializes simultaneous refreshes and retains a refresh token omitted by Google', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hydra-gemini-oauth-'))
  temporaryHomes.push(directory)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LocalCredentialProvider, { hydraHome: directory, watch: false })
  const accounts = createAccountPool({ ctx, key: accountRecordKey('gemini-api'), providerId: 'gemini-api', providerAliases: ['antigravity'], providerLabel: 'Google Gemini API OAuth' })
  const account = await accounts.add('person', { ...grant, expires: 1 })
  const fetcher = vi.fn(async (_url: unknown, init: RequestInit) => {
    expect(new URLSearchParams(init.body as URLSearchParams).get('refresh_token')).toBe(grant.refresh)
    return Response.json({ access_token: 'fresh-access', expires_in: 3600, token_type: 'Bearer' })
  })
  vi.stubGlobal('fetch', fetcher)
  const signal = new AbortController().signal
  const results = await Promise.all((['antigravity', 'gemini-api'] as const).map(provider => accounts.withAccount(account.id, () => selectedGoogleCredential(accounts, provider, signal))))
  expect(results.map(value => value.access)).toEqual(['fresh-access', 'fresh-access'])
  expect(fetcher).toHaveBeenCalledOnce()
  expect(await accounts.withAccount(account.id, () => accounts.credentials.read('gemini-api'))).toMatchObject({ projectId: grant.projectId, quotaProjectId: grant.quotaProjectId, refresh: grant.refresh })
})

it('keeps refresh errors sanitized and refuses Gemini API access without a quota project', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('fixture-client-secret fixture-refresh', { status: 400 })))
  await expect(refreshGoogle(grant, new AbortController().signal)).rejects.toMatchObject({ message: 'Antigravity token refresh failed with HTTP 400', code: 'INVALID_REQUEST' })
  const accounts = await pool()
  const account = await accounts.add('foreign', { type: 'oauth', access: 'antigravity-token', refresh: 'refresh', expires: Date.now() + 3600_000, projectId: 'code-assist-project' })
  await expect(accounts.withAccount(account.id, () => selectedGoogleCredential(accounts, 'gemini-api', new AbortController().signal))).rejects.toMatchObject({ code: 'INVALID_CREDENTIAL' })
})

it('follows every models.list page with bearer auth and a quota project, preserving unnamed and media entries', async () => {
  const accounts = await pool()
  await accounts.add('person', grant)
  const fetcher = vi.fn(async (input: unknown, init: RequestInit) => {
    const url = new URL(String(input))
    expect(url.pathname).toBe('/v1beta/models')
    expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${grant.access}`)
    expect(new Headers(init.headers).get('x-goog-user-project')).toBe(grant.quotaProjectId)
    expect(new Headers(init.headers).has('x-goog-api-key')).toBe(false)
    return Response.json(url.searchParams.has('pageToken') ? { models: [
      { name: 'models/veo-3.1-generate-preview', supportedGenerationMethods: ['predictLongRunning'] },
    ] } : { models: [
      { name: 'models/gemini-3.8-flash', displayName: 'Gemini Flash', inputTokenLimit: 1000, outputTokenLimit: 200, supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-3.1-flash-image', supportedGenerationMethods: ['generateContent'] },
    ], nextPageToken: 'next' })
  })
  vi.stubGlobal('fetch', fetcher)
  const adapter = new GeminiApiAccountAdapter(accounts, { endpoint: 'https://fixture.test/v1beta' })
  expect(await adapter.discoverModels()).toEqual([
    { id: 'gemini-3.8-flash', name: 'Gemini Flash', contextWindow: 1000, maxTokens: 200, endpoints: ['chat/completions'] },
    { id: 'gemini-3.1-flash-image', endpoints: ['images/generations'] },
    { id: 'veo-3.1-generate-preview', endpoints: ['videos'] },
  ])
  expect(fetcher).toHaveBeenCalledTimes(2)
})

it('uses the selected OAuth account for native Gemini image requests', async () => {
  const accounts = await pool()
  await accounts.add('person', grant)
  const fetcher = vi.fn(async (url: unknown, init: RequestInit) => {
    expect(String(url)).toBe('https://fixture.test/v1beta/models/gemini-3.1-flash-image:generateContent')
    expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${grant.access}`)
    expect(new Headers(init.headers).get('x-goog-user-project')).toBe(grant.quotaProjectId)
    expect(JSON.parse(init.body as string)).toMatchObject({ contents: [{ role: 'user', parts: [{ text: 'a cat' }] }],
      generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '3:2' } } })
    return Response.json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'fixture' } }] } }] })
  })
  vi.stubGlobal('fetch', fetcher)
  const adapter = new GeminiApiAccountAdapter(accounts, { endpoint: 'https://fixture.test/v1beta', models: [{ id: 'gemini-3.1-flash-image' }] })
  const request = { endpoint: 'images/generations' as const, provider: 'gemini-api', model: 'gemini-3.1-flash-image',
    body: { prompt: 'a cat', n: 1, size: '1536x1024' }, maxResponseBytes: 4096, signal: new AbortController().signal }
  expect((await adapter.requestGeneration(request)).ok).toBe(true)
  await expect(adapter.requestGeneration({ ...request, endpoint: 'videos' })).rejects.toMatchObject({ code: 'UNSUPPORTED_GENERATION' })
})

it.each([
  null, {}, { models: [null] }, { models: [{ name: 'bad' }] },
  { models: [{ name: 'models/unknown', supportedGenerationMethods: 1 }] },
  { models: [{ name: 'models/unknown', supportedGenerationMethods: [1] }] },
  { models: [{ name: 'models/unknown', supportedGenerationMethods: ['bad method'] }] },
  { models: [], nextPageToken: 1 }, { models: [], nextPageToken: 'repeated' },
])('rejects malformed model catalogs and repeated page tokens: %j', async (payload) => {
  const accounts = await pool()
  await accounts.add('person', grant)
  vi.stubGlobal('fetch', async () => Response.json(payload))
  const adapter = new GeminiApiAccountAdapter(accounts, {})
  await expect(adapter.discoverModels()).rejects.toMatchObject({ code: payload === null ? 'MALFORMED_RESPONSE' : 'DISCOVERY_FAILED' })
})

it('preserves unknown generation methods and models without endpoint metadata', async () => {
  const accounts = await pool()
  await accounts.add('person', grant)
  vi.stubGlobal('fetch', async () => Response.json({ models: [
    { name: 'models/custom', supportedGenerationMethods: ['generateContent', 'predictLongRunning', 'predict', 'embedContent'] },
    { name: 'models/no-methods' }, { name: 'models/empty-methods', supportedGenerationMethods: [] },
  ], nextPageToken: '' }))
  expect(await new GeminiApiAccountAdapter(accounts, {}).discoverModels()).toEqual([
    { id: 'custom', endpoints: ['chat/completions', 'videos', 'images/generations', 'embedContent'] },
    { id: 'no-methods' }, { id: 'empty-methods' },
  ])
})

it.each([true, false])('rejects failed discovery with and without a response body: %s', async (body) => {
  const accounts = await pool()
  await accounts.add('person', grant)
  vi.stubGlobal('fetch', async () => new Response(body ? 'denied' : null, { status: 403 }))
  await expect(new GeminiApiAccountAdapter(accounts, {}).discoverModels()).rejects.toMatchObject({ code: 'DISCOVERY_FAILED', message: 'Gemini API model discovery failed (HTTP 403).' })
})

it('rejects discovery and generation without an account', async () => {
  const accounts = await pool()
  const adapter = new GeminiApiAccountAdapter(accounts, { models: [{ id: 'gemini-3.1-flash-image' }] })
  await expect(adapter.discoverModels()).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
  await expect(adapter.requestGeneration({ provider: 'gemini-api', model: 'gemini-3.1-flash-image', endpoint: 'images/generations',
    body: { prompt: 'a cat' }, maxResponseBytes: 4096, signal: new AbortController().signal })).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
})

it.each([true, false])('tries the next account only after an explicit generation rejection and keeps the final response: %s', async (body) => {
  const accounts = await pool()
  await accounts.add('first', { ...grant, access: 'first', accountId: 'first' })
  await accounts.add('second', { ...grant, access: 'second', accountId: 'second' })
  const fetcher = vi.fn(async () => new Response(body ? 'denied' : null, { status: 429 }))
  vi.stubGlobal('fetch', fetcher)
  const adapter = new GeminiApiAccountAdapter(accounts, { models: [{ id: 'gemini-3.1-flash-image' }] })
  const request = { provider: 'gemini-api', model: 'gemini-3.1-flash-image', endpoint: 'images/generations' as const,
    body: { prompt: 'a cat' }, maxResponseBytes: 4096, signal: new AbortController().signal }
  const response = await adapter.requestGeneration(request)
  expect(response.status).toBe(429)
  expect(fetcher).toHaveBeenCalledTimes(2)
  expect(await response.text()).toBe(body ? 'denied' : '')
  await expect(adapter.requestGeneration({ ...request, body: { ...request.body, n: 2 } })).rejects.toMatchObject({ code: 'UNSUPPORTED_GENERATION' })
})

it.each(['', '\n', undefined, 1])('rejects stored Google grants without a Code Assist project: %j', async (projectId) => {
  const accounts = await pool()
  const account = await accounts.add('Broken', { ...grant, projectId })
  await expect(accounts.withAccount(account.id, () => selectedGoogleCredential(accounts, 'gemini-api', new AbortController().signal)))
    .rejects.toMatchObject({ code: 'INVALID_CREDENTIAL' })
})

it('rejects a selected non-OAuth Google credential', async () => {
  const accounts = await pool()
  const account = await accounts.add('API key', { type: 'api_key', key: 'fixture' })
  await expect(accounts.withAccount(account.id, () => selectedGoogleCredential(accounts, 'gemini-api', new AbortController().signal)))
    .rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
})

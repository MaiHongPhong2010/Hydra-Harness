import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Credential } from '@earendil-works/pi-ai'
import { credentialKey } from '@hydraharness/harness-credentials'
import { LlmError } from '@hydraharness/harness-llm'
import type { AccountPool } from '../src/accounts.ts'
import { AntigravityAccountAdapter } from '../src/adapter.ts'
import { AntigravityAdapter } from '../src/antigravity.ts'
import { ANTIGRAVITY_TOKEN_ENDPOINT } from '../src/antigravity-oauth.ts'
import type { GenerateOptions, MediaGenerationOptions, StreamChunk } from '@hydraharness/harness-llm'

interface TestAccount {
  readonly id: string
  credential: Credential
}

interface TestPoolOptions {
  readonly accounts: TestAccount[]
  readonly order?: () => readonly string[]
  readonly stream?: (
    accountId: string,
    source: () => AsyncIterable<StreamChunk>,
  ) => AsyncIterable<StreamChunk>
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

function accountPool(options: TestPoolOptions): AccountPool {
  let selected: string | undefined
  const records = new Map(options.accounts.map(account => [account.id, account]))
  const order = options.order ?? (() => options.accounts.map(account => account.id))
  const selector = {
    ordered: vi.fn(async () => order().map(id => ({ id }))),
    stream: async function* (
      _provider: string,
      accountId: string,
      source: () => AsyncIterable<StreamChunk>,
    ): AsyncIterable<StreamChunk> {
      if (options.stream !== undefined) {
        yield* options.stream(accountId, source)
        return
      }
      yield* source()
    },
  }
  const credentials = {
    async read(provider: string): Promise<Credential | undefined> {
      return provider === 'antigravity' ? records.get(selected ?? '')?.credential : undefined
    },
    async list() { return [] },
    async modify(provider: string, callback: (current: Credential | undefined) => Promise<Credential | undefined>) {
      if (provider !== 'antigravity') return callback(undefined)
      const account = records.get(selected ?? '')
      const next = await callback(account?.credential)
      if (next !== undefined && account !== undefined) account.credential = next
      return next ?? account?.credential
    },
    async delete() { return undefined },
  }
  return {
    key: credentialKey('llm-account-auth', 'antigravity'),
    credentials,
    accounts: {
      list: async () => options.accounts.map(({ id }) => ({ id: id as never, label: id })),
      remove: async () => undefined,
    },
    selector,
    add: async () => ({ id: 'unused' as never, label: 'unused' }),
    withLoginLabel: async (_label, operation) => operation(),
    withAccount: async (id, operation) => {
      const previous = selected
      selected = String(id)
      try {
        return await operation()
      } finally {
        selected = previous
      }
    },
  }
}

function credentials(access: string, expires = Date.now() + 60_000): Extract<Credential, { type: 'oauth' }> {
  return {
    type: 'oauth',
    access,
    refresh: `refresh-${access}`,
    expires,
    projectId: 'project-fixture',
  }
}

function request(extra: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'antigravity',
    model: 'gemini-test',
    messages: [{
      id: 'message-1' as never,
      role: 'user',
      content: [{ type: 'text', text: 'hello' }],
      source: { kind: 'user' },
    }],
    ...extra,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

function imageRequest(extra: Partial<MediaGenerationOptions> = {}): MediaGenerationOptions & { provider: string; model: string } {
  return { provider: 'antigravity', model: 'gemini-3.1-flash-image', endpoint: 'images/generations',
    body: { prompt: 'A tree', n: 1, size: '1024x1536' }, maxResponseBytes: 32768, signal: new AbortController().signal, ...extra }
}

function imageStream(): Response {
  return new Response(`data: ${JSON.stringify({ response: { candidates: [{ finishReason: 'STOP', content: { parts: [] } }] } })}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } })
}

describe('Antigravity image transport', () => {
  it('retains output metadata across discovery and sends the native image envelope with the selected account', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(imageStream())
    const pool = accountPool({ accounts: [{ id: 'first', credential: credentials('first-access') }] })
    const adapter = new AntigravityAccountAdapter({ pool, profile: () => ({
      endpoint: 'http://localhost:1234', models: [{ id: 'gemini-3.1-flash-image' }, { id: 'vision-chat' }],
    }) })
    expect(await adapter.listModels('antigravity')).toEqual([
      { provider: 'antigravity', id: 'gemini-3.1-flash-image', name: 'gemini-3.1-flash-image', endpoints: ['images/generations'] },
      { provider: 'antigravity', id: 'vision-chat', name: 'vision-chat' },
    ])
    fetchSpy.mockResolvedValueOnce(Response.json({ models: {
      'gemini-3.1-flash-image': {}, 'remote-only': {},
    } }))
    const discovered = await adapter.discoverModels()
    expect(discovered[0]?.endpoints).toEqual(['images/generations'])
    expect(discovered.map(model => model.id)).toContain('remote-only')
    expect((await adapter.listModels('antigravity')).map(model => model.id)).not.toContain('remote-only')
    expect((await adapter.resolveModel('antigravity', 'gemini-3.1-flash-image')).endpoints).toEqual(['images/generations'])
    const result = await adapter.requestGeneration(imageRequest())
    expect(result.ok).toBe(true)
    const [url, init] = fetchSpy.mock.calls[1]!
    expect(url).toBe('http://localhost:1234/v1internal:streamGenerateContent?alt=sse')
    expect(init).toMatchObject({ redirect: 'error', method: 'POST', headers: { Authorization: 'Bearer first-access' } })
    expect(JSON.parse(init!.body as string)).toEqual({
      project: 'project-fixture', model: 'gemini-3.1-flash-image', requestType: 'image_gen', userAgent: 'antigravity',
      requestId: expect.stringMatching(/^image_gen\/\d+\/[a-f0-9-]+\/12$/) as string,
      request: { contents: [{ role: 'user', parts: [{ text: 'A tree' }] }],
        generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '2:3' } } },
    })
  })
  it.each([401, 404, 429])('tries a later account only after HTTP %i rejects generation', async (status) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('private rejection', { status }))
      .mockResolvedValueOnce(imageStream())
    const pool = accountPool({ accounts: [
      { id: 'first', credential: credentials('first-access') }, { id: 'second', credential: credentials('second-access') },
    ] })
    const adapter = new AntigravityAccountAdapter({ pool, profile: () => ({ endpoint: 'https://fixture.test' }) })
    expect((await adapter.requestGeneration(imageRequest())).ok).toBe(true)
    expect(fetchSpy.mock.calls.map(call => (call[1]!.headers as Record<string, string>)['Authorization']))
      .toEqual(['Bearer first-access', 'Bearer second-access'])
  })
  it.each([403, 408, 500, 503])('stops account selection on HTTP %i without another generation', async (status) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status }))
    const pool = accountPool({ accounts: [
      { id: 'first', credential: credentials('first-access') }, { id: 'second', credential: credentials('second-access') },
    ] })
    const adapter = new AntigravityAccountAdapter({ pool, profile: () => ({ endpoint: 'https://fixture.test' }) })
    expect((await adapter.requestGeneration(imageRequest())).status).toBe(status)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
  it('does not rotate accounts after a lost response, cancellation, or unsupported request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('lost response'))
    const pool = accountPool({ accounts: [
      { id: 'first', credential: credentials('first-access') }, { id: 'second', credential: credentials('second-access') },
    ] })
    const adapter = new AntigravityAccountAdapter({ pool, profile: () => ({ endpoint: 'https://fixture.test' }) })
    await expect(adapter.requestGeneration(imageRequest())).rejects.toThrow('lost response')
    const controller = new AbortController()
    controller.abort()
    await expect(adapter.requestGeneration(imageRequest({ signal: controller.signal }))).rejects.toThrow()
    await expect(adapter.requestGeneration(imageRequest({ endpoint: 'videos' }))).rejects.toMatchObject({ code: 'UNSUPPORTED_GENERATION' })
    await expect(adapter.requestGeneration(imageRequest({ body: { prompt: 'A tree', n: 2 } }))).rejects.toMatchObject({ code: 'UNSUPPORTED_GENERATION' })
    await expect(adapter.requestGeneration(imageRequest({ body: { prompt: ' ' } }))).rejects.toMatchObject({ code: 'INVALID_GENERATION' })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const absent = new AntigravityAccountAdapter({ pool: accountPool({ accounts: [] }), profile: () => ({}) })
    await expect(absent.requestGeneration(imageRequest())).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
  })
  it('tries native hosts after endpoint 404 only and retains the response stream for bounded tool parsing', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(imageStream())
    const adapter = new AntigravityAdapter({ resolveCredentials: async () => ({ access: 'fixture', refresh: 'fixture', expires: Date.now() + 60_000, projectId: 'project' }) })
    const response = await adapter.requestGeneration(imageRequest({ body: { prompt: 'A tree' } }))
    expect(fetchSpy.mock.calls.map(call => requestUrl(call[0]))).toEqual([
      'https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse', 'https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse',
    ])
    expect(await response.json()).toEqual({ candidates: [{ finishReason: 'STOP', content: { parts: [] } }] })
  })
  it('combines streamed image parts and the terminal finish reason without rotating accepted requests', async () => {
    const frames = [
      { response: { candidates: [{ content: { parts: [{ thought: true, text: 'private reasoning' }] } }] } },
      { response: { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'fixture-pixels' } }] } }] } },
      { response: { candidates: [{ finishReason: 'STOP' }] } },
    ]
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('')))
    const adapter = new AntigravityAccountAdapter({ pool: accountPool({ accounts: [
      { id: 'first', credential: credentials('first-access') }, { id: 'second', credential: credentials('second-access') },
    ] }), profile: () => ({ endpoint: 'https://fixture.test' }) })
    const result = await adapter.requestGeneration(imageRequest())
    expect(await result.json()).toEqual({ candidates: [{ finishReason: 'STOP', content: { parts: [
      { thought: true, text: 'private reasoning' }, { inlineData: { mimeType: 'image/png', data: 'fixture-pixels' } },
    ] } }] })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
  it.each(['oversized', 'malformed', 'provider-error', 'multiple-candidates', 'invalid-parts'] as const)('stops after an accepted %s image stream fails', async (kind) => {
    const payload = kind === 'provider-error' ? { error: { message: 'private provider error' } }
      : kind === 'multiple-candidates' ? { response: { candidates: [{}, {}] } }
        : { response: { candidates: [{ content: { parts: 'wrong' } }] } }
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(kind === 'oversized' ? imageStream()
      : new Response(`data: ${kind === 'malformed' ? '{broken' : JSON.stringify(payload)}\n\n`))
    const adapter = new AntigravityAccountAdapter({ pool: accountPool({ accounts: [
      { id: 'first', credential: credentials('first-access') }, { id: 'second', credential: credentials('second-access') },
    ] }), profile: () => ({ endpoint: 'https://fixture.test' }) })
    await expect(adapter.requestGeneration(imageRequest({ maxResponseBytes: kind === 'oversized' ? 1 : 32768 }))).rejects.toThrow()
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
})

describe('account-backed Antigravity adapter', () => {
  it('resolves configured and missing model metadata without account discovery', async () => {
    const pool = accountPool({ accounts: [] })
    const adapter = new AntigravityAccountAdapter({ pool, profile: () => ({ models: [
      { id: 'plain' }, { id: 'rich', name: 'Rich', contextWindow: 1000, maxTokens: 200 },
    ] }) })
    expect(adapter.providerInfo('antigravity')).toEqual({ id: 'antigravity', name: 'Google Antigravity' })
    expect(adapter.providerRetryPolicy('antigravity')).toBeDefined()
    expect(await adapter.listModels('antigravity')).toEqual([
      { provider: 'antigravity', id: 'plain', name: 'plain' },
      { provider: 'antigravity', id: 'rich', name: 'Rich' },
    ])
    expect(await adapter.discoverModels()).toEqual([])
    expect(await adapter.resolveModel('antigravity', 'rich')).toMatchObject({
      name: 'Rich', context: { contextWindow: 1000 }, defaultMaxTokens: 200,
    })
    expect(await adapter.resolveModel('antigravity', 'unknown')).toEqual({
      provider: 'antigravity', id: 'unknown', name: 'unknown',
    })
    const disabled = new AntigravityAccountAdapter({ pool, profile: () => undefined })
    expect(disabled.providerRetryPolicy('antigravity')).toBeUndefined()
    await expect(disabled.listModels('antigravity')).rejects.toMatchObject({ code: 'NO_ADAPTER' })
    await expect(disabled.stream(request())[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: 'NO_ADAPTER' })
    const empty = new AntigravityAccountAdapter({ pool, profile: () => ({}) })
    expect(await empty.listModels('antigravity')).toEqual([])
    await expect(empty.stream(request())[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
  })

  it.each([
    { type: 'api_key', key: 'fixture' },
    { type: 'oauth', access: '', refresh: 'r', expires: 1, projectId: 'p' },
    { type: 'oauth', access: 'a', refresh: '', expires: 1, projectId: 'p' },
    { type: 'oauth', access: 'a', refresh: 'r', expires: Number.NaN, projectId: 'p' },
    { type: 'oauth', access: 'a', refresh: 'r', expires: 1, projectId: '' },
  ] satisfies Credential[])('rejects unusable stored grants before discovery: %j', async (credential) => {
    const adapter = new AntigravityAccountAdapter({
      pool: accountPool({ accounts: [{ id: 'invalid', credential }] }), profile: () => ({}),
    })
    await expect(adapter.discoverModels()).rejects.toMatchObject({ code: 'INVALID_CREDENTIAL' })
  })

  it('rejects a credential store that never invokes its modifier', async () => {
    const pool = accountPool({ accounts: [{ id: 'first', credential: credentials('valid') }] })
    vi.spyOn(pool.credentials, 'modify').mockResolvedValue(undefined)
    const adapter = new AntigravityAccountAdapter({ pool, profile: () => ({}) })
    await expect(adapter.discoverModels()).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
  })

  it.each([
    ['empty', [], 'STREAM_CLOSED'],
    ['unfinished visible output', [{ type: 'text-delta', index: 0, text: 'partial' }], 'STREAM_CLOSED'],
    ['provider failure', [{ type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH', message: 'denied' } } }], undefined],
    ['aborted finish', [{ type: 'usage', usage: { inputTokens: 1, outputTokens: 0 } }, { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'cancelled' } } }], undefined],
    ['invisible success', [{ type: 'usage', usage: { inputTokens: 1, outputTokens: 0 } }, { type: 'finish', reason: { kind: 'stop' } }], undefined],
  ] satisfies [string, StreamChunk[], string | undefined][])('preserves the outcome of %s', async (_label, chunks, errorCode) => {
    const pool = accountPool({
      accounts: [{ id: 'first', credential: credentials('access') }],
      stream: async function* () { yield* chunks },
    })
    const adapter = new AntigravityAccountAdapter({ pool, profile: () => ({}) })
    const seen: StreamChunk[] = []
    const consume = async () => {
      for await (const chunk of adapter.stream(request())) seen.push(chunk)
    }
    if (errorCode === undefined) await consume()
    else await expect(consume()).rejects.toMatchObject({ code: errorCode })
    expect(seen).toEqual(chunks)
  })

  it.each([new Error('transport failure'), 'transport failure', undefined])(
    'surfaces the final thrown account error: %j', async (failure) => {
      const pool = accountPool({
        accounts: [{ id: 'first', credential: credentials('access') }],
        stream: async function* () { throw failure },
      })
      const adapter = new AntigravityAccountAdapter({ pool, profile: () => ({}) })
      const first = adapter.stream(request())[Symbol.asyncIterator]().next()
      if (failure instanceof Error) await expect(first).rejects.toBe(failure)
      else await expect(first).rejects.toMatchObject({ code: 'TRANSPORT' })
    },
  )

  it('never rotates accounts after visible output or cancellation', async () => {
    const failure = new Error('after visible output')
    const pool = accountPool({
      accounts: [{ id: 'first', credential: credentials('access') }],
      stream: async function* () {
        yield { type: 'text-delta', index: 0, text: 'partial' }
        throw failure
      },
    })
    const adapter = new AntigravityAccountAdapter({ pool, profile: () => ({}) })
    const stream = adapter.stream(request())[Symbol.asyncIterator]()
    expect((await stream.next()).value).toMatchObject({ text: 'partial' })
    await expect(stream.next()).rejects.toBe(failure)
    await expect(adapter.stream(request({ signal: AbortSignal.abort() }))[Symbol.asyncIterator]().next())
      .rejects.toMatchObject({ code: 'ABORTED' })
  })

  it('refreshes one expired account, preserves siblings, and caches its catalog', async () => {
    const first: TestAccount = { id: 'first', credential: { ...credentials('old-access', 0), email: 'user@example.test' } }
    const sibling: TestAccount = { id: 'sibling', credential: credentials('sibling-access') }
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = requestUrl(input)
      if (url === ANTIGRAVITY_TOKEN_ENDPOINT) {
        return Response.json({ access_token: 'new-access', expires_in: 3600 })
      }
      expect(url).toBe('https://fixture.test/v1internal:fetchAvailableModels')
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer new-access' })
      return Response.json({ models: {
        gemini: { displayName: 'Gemini', maxTokens: 8192, maxOutputTokens: 1024, supportsImages: true },
        internal: { isInternal: true },
      } })
    })
    const pool = accountPool({ accounts: [first, sibling] })
    const profile = {
      endpoint: 'https://fixture.test', callbackPort: 0, callbackPath: '/callback',
      onboardingAttempts: 1, onboardingDelayMs: 0,
    }
    const adapter = new AntigravityAccountAdapter({ pool, profile: () => profile })

    await expect(adapter.discoverModels()).resolves.toEqual([{
      id: 'gemini', name: 'Gemini', contextWindow: 8192, maxTokens: 1024,
    }])
    await expect(adapter.listModels('antigravity')).resolves.toEqual([{
      provider: 'antigravity', id: 'gemini', name: 'Gemini', inputModalities: ['text', 'image'],
    }])
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(await adapter.resolveModel('antigravity', 'gemini')).toMatchObject({ inputModalities: ['text', 'image'] })
    expect(first.credential).toMatchObject({ access: 'new-access' })
    expect(sibling.credential).toMatchObject({ access: 'sibling-access' })
  })

  it('invalidates discovery when the profile or selected account changes', async () => {
    const first: TestAccount = { id: 'first', credential: credentials('first-access') }
    const second: TestAccount = { id: 'second', credential: credentials('second-access') }
    let profile = { endpoint: 'https://one.test' }
    let selected = ['first']
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = requestUrl(input)
      return Response.json({ models: { [url.includes('one.test') ? 'one' : 'two']: {} } })
    })
    const adapter = new AntigravityAccountAdapter({
      pool: accountPool({ accounts: [first, second], order: () => selected }),
      profile: () => profile,
    })

    await expect(adapter.discoverModels()).resolves.toMatchObject([{ id: 'one' }])
    selected = ['second']
    profile = { endpoint: 'https://two.test' }
    await expect(adapter.discoverModels()).resolves.toMatchObject([{ id: 'two' }])
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it.each([false, true])('shares pending discovery and preserves a newer catalog after replacement: %s', async (changeProfile) => {
    const accounts: TestAccount[] = [
      { id: 'first', credential: { ...credentials('first'), email: '' } },
      { id: 'second', credential: credentials('second') },
    ]
    let profile = {}
    const responses = [Promise.withResolvers<Response>(), Promise.withResolvers<Response>()]
    const fetch = vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(async () => responses[0]!.promise)
      .mockImplementationOnce(async () => responses[1]!.promise)
    const adapter = new AntigravityAccountAdapter({ pool: accountPool({ accounts }), profile: () => profile })
    const signal = new AbortController().signal
    const first = adapter.discoverModels(signal)
    const shared = adapter.discoverModels(signal)
    await vi.waitFor(() => { expect(fetch).toHaveBeenCalledOnce() })
    if (changeProfile) profile = {}
    else accounts.reverse()
    const next = adapter.discoverModels(signal)
    await vi.waitFor(() => { expect(fetch).toHaveBeenCalledTimes(2) })
    responses[0]!.resolve(Response.json({ models: { old: {} } }))
    expect(await first).toMatchObject([{ id: 'old' }])
    expect(await shared).toMatchObject([{ id: 'old' }])
    responses[1]!.resolve(Response.json({ models: { latest: { supportsImages: false } } }))
    expect(await next).toMatchObject([{ id: 'latest' }])
    expect(await adapter.listModels('antigravity')).toMatchObject([{ id: 'latest', inputModalities: ['text'] }])
    expect(await adapter.resolveModel('antigravity', 'latest')).toMatchObject({ inputModalities: ['text'] })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('streams a configured model through the default endpoint and attachment resolver', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response([
      'data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}]}}', '', '',
    ].join('\n')))
    const adapter = new AntigravityAccountAdapter({
      pool: accountPool({ accounts: [{ id: 'first', credential: credentials('access') }] }),
      profile: () => ({ models: [{ id: 'gemini-test' }], streamIdleTimeoutMs: 1000 }),
      resolveAttachments: () => undefined,
    })
    const chunks: StreamChunk[] = []
    for await (const chunk of adapter.stream(request())) chunks.push(chunk)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('fails over before visible output and strips replay state on every account request', async () => {
    const first: TestAccount = { id: 'first', credential: credentials('first-access') }
    const second: TestAccount = { id: 'second', credential: credentials('second-access') }
    const seenContents: unknown[] = []
    const pool = accountPool({
      accounts: [first, second],
      stream: async function* (accountId, source) {
        if (accountId === 'first') {
          yield { type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH', message: 'first failed' } } }
          return
        }
        yield* source()
      },
    })
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '') as { request?: { contents?: unknown } }
      seenContents.push(body.request?.contents)
      return new Response([
        `data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: 'ok' }] } }] } })}`,
        `data: ${JSON.stringify({ response: { candidates: [{ finishReason: 'STOP' }] } })}`,
        '',
      ].join('\n\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    })
    const replaying = Object.freeze(request({ messages: [{
      id: 'assistant-1' as never,
      role: 'assistant',
      content: [{ type: 'text', text: 'prior' }],
      source: {
        kind: 'model',
        provider: 'antigravity',
        model: 'gemini-test',
        replayState: { response: { responseId: 'prior' }, blocks: [{ thoughtSignature: 'AQ==' }] },
      },
    }] }))
    const chunks: StreamChunk[] = []
    for await (const chunk of new AntigravityAccountAdapter({
      pool,
      profile: () => ({ endpoint: 'https://fixture.test' }),
    }).stream(replaying)) chunks.push(chunk)
    expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: 'ok' })
    expect(fetch).toHaveBeenCalledOnce()
    expect(JSON.stringify(seenContents[0])).not.toContain('thoughtSignature')
  })

  it('drops the prior account replay state when the next request rotates accounts', async () => {
    const first: TestAccount = { id: 'first', credential: credentials('first-access') }
    const second: TestAccount = { id: 'second', credential: credentials('second-access') }
    let requestNumber = 0
    const seen: Array<{ authorization: string; body: string }> = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      seen.push({
        authorization: new Headers(init?.headers).get('Authorization') ?? '',
        body: typeof init?.body === 'string' ? init.body : '',
      })
      return new Response([
        `data: ${JSON.stringify({ response: { responseId: 'response', candidates: [{ content: { parts: [{ text: 'ok', thoughtSignature: 'AQ==' }] } }] } })}`,
        `data: ${JSON.stringify({ response: { candidates: [{ finishReason: 'STOP' }] } })}`,
        '',
      ].join('\n\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    })
    const pool = accountPool({
      accounts: [first, second],
      order: () => [requestNumber++ === 0 ? 'first' : 'second'],
    })
    const adapter = new AntigravityAccountAdapter({
      pool,
      profile: () => ({ endpoint: 'https://fixture.test' }),
    })
    const firstChunks: StreamChunk[] = []
    for await (const chunk of adapter.stream(request())) firstChunks.push(chunk)
    const finish = firstChunks.find((chunk): chunk is Extract<StreamChunk, { type: 'finish' }> => chunk.type === 'finish')
    if (finish?.replayState === undefined) throw new Error('fixture response did not produce replay state')
    const secondChunks: StreamChunk[] = []
    for await (const chunk of adapter.stream(request({ messages: [{
      id: 'assistant-1' as never,
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      source: { kind: 'model', provider: 'antigravity', model: 'gemini-test', replayState: finish.replayState },
    }] }))) secondChunks.push(chunk)
    expect(secondChunks).toContainEqual({ type: 'text-delta', index: 0, text: 'ok' })
    expect(seen).toHaveLength(2)
    expect(seen[0]?.authorization).toBe('Bearer first-access')
    expect(seen[1]?.authorization).toBe('Bearer second-access')
    expect(seen[1]?.body).not.toContain('thoughtSignature')
  })

  it('does not commit a refresh that completes after cancellation', async () => {
    const first: TestAccount = { id: 'first', credential: credentials('old-access', 0) }
    const controller = new AbortController()
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      expect(requestUrl(input)).toBe(ANTIGRAVITY_TOKEN_ENDPOINT)
      controller.abort('cancelled after token response')
      return Response.json({ access_token: 'new-access', expires_in: 3600 })
    })
    const pool = accountPool({ accounts: [first] })
    const adapter = new AntigravityAccountAdapter({ pool, profile: () => ({}) })
    await expect(async () => {
      for await (const _chunk of adapter.stream(request({ signal: controller.signal }))) { /* cancellation is terminal */ }
    }).rejects.toMatchObject({ code: 'ABORTED' })
    expect(fetch).toHaveBeenCalledOnce()
    expect(first.credential).toMatchObject({ access: 'old-access' })
  })

  it('treats an ABORTED account error as terminal without trying a sibling', async () => {
    const orderCalls = { count: 0 }
    const pool = accountPool({
      accounts: [
        { id: 'first', credential: credentials('first-access') },
        { id: 'second', credential: credentials('second-access') },
      ],
      order: () => {
        orderCalls.count += 1
        return ['first', 'second']
      },
      stream: async function* () {
        throw new LlmError('cancelled', 'ABORTED')
      },
    })
    const adapter = new AntigravityAccountAdapter({ pool, profile: () => ({}) })
    await expect(async () => {
      for await (const _chunk of adapter.stream(request())) { /* terminal error */ }
    }).rejects.toMatchObject({ code: 'ABORTED' })
    expect(orderCalls.count).toBe(1)
  })
})

it('uses a catalog id when discovered Antigravity models have no display name', async () => {
  const pool = accountPool({ accounts: [{ id: 'first', credential: credentials('first') }] })
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ models: { 'remote-model': {} } }))
  const adapter = new AntigravityAccountAdapter({ pool, profile: () => ({}) })
  expect(await adapter.discoverModels()).toContainEqual({ id: 'remote-model', name: 'remote-model' })
})

it('rejects unconfigured generation and preserves a credential lost during selection', async () => {
  const pool = accountPool({ accounts: [{ id: 'first', credential: credentials('first') }] })
  await expect(new AntigravityAccountAdapter({ pool, profile: () => undefined }).requestGeneration(imageRequest()))
    .rejects.toMatchObject({ code: 'NO_ADAPTER' })
  const adapter = new AntigravityAccountAdapter({ pool, profile: () => ({}) })
  vi.spyOn(AntigravityAdapter.prototype, 'requestGeneration').mockRejectedValue(new LlmError('Account disconnected', 'MISSING_CREDENTIAL'))
  await expect(adapter.requestGeneration(imageRequest())).rejects.toThrow('Account disconnected')
})

it.each([false, true])('shares fresh and expired Google credentials between streaming and generation: explicit controls %s', async (explicit) => {
  for (const expired of [false, true]) {
    const account = { id: 'shared', credential: { ...credentials('shared', expired ? 0 : Date.now() + 60_000), quotaProjectId: 'fixture-project', email: 'user@example.test' } }
    const pool = accountPool({ accounts: [account] })
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (requestUrl(input) === ANTIGRAVITY_TOKEN_ENDPOINT) return Response.json({ access_token: 'fresh', expires_in: 3600, token_type: 'Bearer' })
      return new Response(`data: ${JSON.stringify({ response: { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'Hello' }] } }] } })}\n\n`)
    })
    const adapter = new AntigravityAccountAdapter({ pool, profile: () => explicit ? { timeoutMs: 1000 } : {} })
    const chunks: StreamChunk[] = []
    for await (const chunk of adapter.stream(request(explicit ? { signal: new AbortController().signal } : {}))) chunks.push(chunk)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    if (expired) account.credential.expires = 0
    expect((await adapter.requestGeneration(imageRequest())).ok).toBe(true)
    expect(fetcher.mock.calls.filter(([input]) => requestUrl(input) === ANTIGRAVITY_TOKEN_ENDPOINT)).toHaveLength(expired ? 2 : 0)
    expect(account.credential).toMatchObject({ quotaProjectId: 'fixture-project', projectId: 'project-fixture', email: 'user@example.test' })
  }
})

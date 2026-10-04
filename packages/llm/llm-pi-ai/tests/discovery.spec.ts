import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@hydraharness/cordis'
import LlmRuntime, { userAgent } from '@hydraharness/harness-llm'
import * as LlmPiAi from '@hydraharness/harness-llm-pi-ai'
import { discoverModels } from '../src/discovery.ts'
import * as Catalog from '../src/catalog.ts'

const servers: Server[] = []
/** Credential variables a test set, cleared so the next one starts unset. */
const touchedEnv: string[] = []

afterEach(async () => {
  // A no-op when the test never stubbed `fetch`; only 'probe key format'
  // below installs one.
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const name of touchedEnv.splice(0)) Reflect.deleteProperty(process.env, name)
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))))
})

interface ListingServer {
  url: string
  paths: string[]
  headers: IncomingMessage['headers'][]
}

/**
 * A stand-in provider that answers one scripted `GET /models`. `chunks` writes
 * without a declared length, which is how a real streamed reply arrives.
 */
async function listingServer(behavior: {
  status?: number
  body?: string
  pages?: Record<string, string>
  chunks?: string[]
  holdOpenMs?: number
}): Promise<ListingServer> {
  const paths: string[] = []
  const headers: IncomingMessage['headers'][] = []
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    paths.push(request.url ?? '')
    headers.push(request.headers)
    if (behavior.chunks !== undefined) {
      // No declared length: the ceiling has to hold on what is read.
      response.writeHead(behavior.status ?? 200, { 'content-type': 'application/json' })
      for (const chunk of behavior.chunks) response.write(chunk)
      if (behavior.holdOpenMs === undefined) { response.end(); return }
      // Left open so a caller's cancellation lands while the body is still
      // being read rather than after it completed.
      setTimeout(() => { response.end() }, behavior.holdOpenMs)
      return
    }
    const body = behavior.pages?.[request.url ?? ''] ?? behavior.body ?? '{}'
    response.writeHead(behavior.status ?? 200, {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body)),
    })
    response.end(body)
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return { url: `http://127.0.0.1:${address.port}`, paths, headers }
}

/** A bare dormant mount: discovery is offered whether or not a route exists. */
async function harness(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LlmPiAi, {})
  return ctx
}

describe('catalog-route model discovery', () => {
  it('gets every Gemini page without filtering by generation method', async () => {
    const server = await listingServer({ pages: {
      '/models': JSON.stringify({ models: [{ name: 'models/chat', displayName: 'Chat', supportedGenerationMethods: ['generateContent'] }, {}], nextPageToken: 'second page' }),
      '/models?pageToken=second+page': JSON.stringify({ models: [
        { name: 'models/gemini-3.1-flash-image', inputTokenLimit: 65536, outputTokenLimit: 8192, supportedGenerationMethods: ['generateContent'] },
        { name: 'models/unknown-video', supportedGenerationMethods: ['predictLongRunning'] },
        { name: 'models/unknown-image', supportedGenerationMethods: ['predict'] },
      ] }),
    } })
    expect(await discoverModels({ baseURL: server.url, api: 'google-generative-ai', apiKey: 'fixture' })).toEqual([
      { id: 'chat', name: 'Chat', endpoints: ['generateContent'] },
      { id: 'gemini-3.1-flash-image', contextWindow: 65536, maxTokens: 8192, endpoints: ['images/generations'] },
      { id: 'unknown-video', endpoints: ['videos'] },
      { id: 'unknown-image', endpoints: ['images/generations'] },
    ])
    expect(server.paths).toEqual(['/models', '/models?pageToken=second+page'])
    expect(server.headers.every(headers => headers['x-goog-api-key'] === 'fixture' && headers.authorization === undefined)).toBe(true)
  })
  it.each([{ models: {} }, { models: [], nextPageToken: 1 }, { models: [], nextPageToken: 'loop' }])('rejects malformed Gemini pages and repeated tokens: %j', async (body) => {
    const server = await listingServer({ body: JSON.stringify(body) })
    await expect(discoverModels({ baseURL: server.url, api: 'google-generative-ai' })).rejects.toMatchObject({ code: 'DISCOVERY_FAILED' })
  })
  it('rejects malformed generation methods even for a known image family', async () => {
    const server = await listingServer({ body: JSON.stringify({ models: [
      { name: 'models/gemini-future-image', supportedGenerationMethods: [7] },
    ] }) })
    await expect(discoverModels({ baseURL: server.url, api: 'google-generative-ai' })).rejects.toMatchObject({ code: 'DISCOVERY_FAILED' })
  })
  it('fetches a supplied endpoint instead of returning the installed catalog', async () => {
    const server = await listingServer({ body: JSON.stringify({ data: [{ id: 'from-the-endpoint' }] }) })
    const ctx = await harness()

    const models = await ctx.llm.discoverModels('llm-pi-ai', { provider: 'deepseek', baseURL: server.url })

    expect(models).toEqual([{ id: 'from-the-endpoint' }])
    expect(server.paths).toEqual(['/models'])
  })

  it.each(['openai', 'google'] as const)('fetches new %s image/video ids from its default endpoint and protocol', async (provider) => {
    const ids = provider === 'openai' ? ['fresh-chat', 'gpt-image-new-release', 'sora-new-release']
      : ['fresh-chat', 'gemini-future-image', 'future-video']
    const server = await listingServer({ body: JSON.stringify(provider === 'google'
      ? { models: ids.map(id => ({ name: `models/${id}`, supportedGenerationMethods: [id === 'future-video' ? 'predictLongRunning' : 'generateContent'] })) }
      : { data: ids.map(id => ({ id })) }) })
    const installed = Catalog.catalogProvider(provider)!
    vi.spyOn(Catalog, 'catalogProvider').mockReturnValue({ ...installed, baseUrl: `${server.url}/v1` })
    const ctx = await harness()
    const rows = await ctx.llm.discoverModels('llm-pi-ai', { provider, apiKey: 'fixture' })
    expect(rows.map(row => row.id)).toEqual(ids)
    expect(server.paths).toEqual(['/v1/models'])
    expect(server.headers[0]?.[provider === 'google' ? 'x-goog-api-key' : 'authorization']).toBe(provider === 'google' ? 'fixture' : 'Bearer fixture')
  })

  it('gets xAI media catalogs and classifies unknown ids by their source resource', async () => {
    const server = await listingServer({ pages: {
      '/v1/models': JSON.stringify({ data: [{ id: 'fresh-chat' }, { id: 'unrecognizable-raster', name: 'Raster' }] }),
      '/v1/image-generation-models': JSON.stringify({ models: [{ id: 'unrecognizable-raster' }, { id: 'fresh-image' }] }),
      '/v1/video-generation-models': JSON.stringify({ models: [{ id: 'fresh-video' }] }),
    } })
    const installed = Catalog.catalogProvider('xai')!
    vi.spyOn(Catalog, 'catalogProvider').mockReturnValue({ ...installed, baseUrl: `${server.url}/v1` })
    expect(await discoverModels({ provider: 'xai', apiKey: 'fixture' })).toEqual([
      { id: 'fresh-chat' }, { id: 'unrecognizable-raster', name: 'Raster', endpoints: ['images/generations'] },
      { id: 'fresh-image', endpoints: ['images/generations'] }, { id: 'fresh-video', endpoints: ['videos'] },
    ])
    expect(server.paths).toEqual(['/v1/models', '/v1/image-generation-models', '/v1/video-generation-models'])
    expect(server.headers.every(headers => headers.authorization === 'Bearer fixture')).toBe(true)
  })

  it('reports default endpoint failure instead of substituting installed models', async () => {
    const server = await listingServer({ status: 401 })
    const installed = Catalog.catalogProvider('openai')!
    vi.spyOn(Catalog, 'catalogProvider').mockReturnValue({ ...installed, baseUrl: server.url })
    await expect(discoverModels({ provider: 'openai' })).rejects.toMatchObject({ code: 'DISCOVERY_FAILED' })
  })

  it('requires an explicit protocol when a provider mixes unrelated listing APIs', async () => {
    const installed = Catalog.catalogProvider('openai')!
    const google = Catalog.catalogProvider('google')!
    vi.spyOn(Catalog, 'catalogProvider').mockReturnValue({ ...installed, getModels: () => [...installed.getModels(), ...google.getModels()] })
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    await expect(discoverModels({ provider: 'openai' })).rejects.toMatchObject({ code: 'DISCOVERY_UNSUPPORTED' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('reports an unreadable xAI media resource without returning a partial catalog', async () => {
    const server = await listingServer({ pages: {
      '/models': JSON.stringify({ data: [{ id: 'chat' }] }), '/image-generation-models': '{}',
    } })
    const installed = Catalog.catalogProvider('xai')!
    vi.spyOn(Catalog, 'catalogProvider').mockReturnValue({ ...installed, baseUrl: server.url })
    await expect(discoverModels({ provider: 'xai' })).rejects.toMatchObject({ code: 'DISCOVERY_FAILED' })
  })

  it('says where a route the catalog does not describe must get its models', async () => {
    const ctx = await harness()
    await expect(ctx.llm.discoverModels('llm-pi-ai', { provider: 'acme-gateway' }))
      .rejects.toThrow(/set a baseURL/)
    // A form that cleared the field says the same thing as one that never had it.
    await expect(ctx.llm.discoverModels('llm-pi-ai', { provider: 'acme-gateway', baseURL: '' }))
      .rejects.toThrow(/set a baseURL/)
    // The seam refuses a request naming neither, so the module's own guard for
    // that shape is only reachable by calling it directly.
    await expect(discoverModels({})).rejects.toThrow(/set a baseURL/)
  })
})

describe('draft-provider model discovery', () => {
  it('keeps endpoint metadata and infers dedicated image/video families without generating', async () => {
    const server = await listingServer({ body: JSON.stringify({ data: [
      { id: 'gpt-image-2' }, { id: 'gpt-image-1.5' }, { id: 'sora-2' },
      { id: 'alias', supported_endpoint_types: ['/v1/images/generations', 'image-generation'] },
      { id: 'vision-chat', supported_endpoints: ['/v1/responses'], input_modalities: ['text', 'image'] },
      { id: 'gpt-image-proxy-chat', endpoints: ['chat/completions'] },
    ] }) })
    const ctx = await harness()
    const models = await ctx.llm.discoverModels('llm-pi-ai', { baseURL: server.url })
    expect(models).toEqual([
      { id: 'gpt-image-2', endpoints: ['images/generations', 'images/edits'] },
      { id: 'gpt-image-1.5', endpoints: ['images/generations', 'images/edits'] },
      { id: 'sora-2', endpoints: ['videos'] },
      { id: 'alias', endpoints: ['images/generations'] },
      { id: 'vision-chat', endpoints: ['responses'] },
      { id: 'gpt-image-proxy-chat', endpoints: ['chat/completions'] },
    ])
    expect(server.paths).toEqual(['/models'])
  })

  it.each([null, [], [''], [42], 'images/generations', ['/v1/'], ['https://other.test/videos'], ['videos?key=value']])('refuses malformed endpoint metadata %j', async (endpoints) => {
    const server = await listingServer({ body: JSON.stringify({ data: [{ id: 'm', endpoints }] }) })
    await expect(discoverModels({ baseURL: server.url })).rejects.toThrow('invalid endpoint metadata')
  })

  it('reads an OpenAI-compatible listing and keeps the capacities it discloses', async () => {
    const server = await listingServer({
      body: JSON.stringify({
        data: [
          { id: 'acme-large', display_name: 'Acme Large', context_length: 65_536, max_output_tokens: 4096 },
          { id: 'acme-small' },
        ],
      }),
    })
    const ctx = await harness()

    const models = await ctx.llm.discoverModels('llm-pi-ai', { baseURL: `${server.url}/v1`, apiKey: 'probe-key' })

    expect(models).toEqual([
      { id: 'acme-large', name: 'Acme Large', contextWindow: 65_536, maxTokens: 4096 },
      { id: 'acme-small' },
    ])
    expect(server.paths).toEqual(['/v1/models'])
    expect(server.headers[0]?.authorization).toBe('Bearer probe-key')
    expect(server.headers[0]?.['user-agent']).toBe(userAgent())
  })

  it('keeps a deployment path instead of resolving it away', async () => {
    const server = await listingServer({ body: JSON.stringify({ data: [{ id: 'm' }] }) })
    const ctx = await harness()

    await ctx.llm.discoverModels('llm-pi-ai', { baseURL: `${server.url}/openai/v1/` })

    expect(server.paths).toEqual(['/openai/v1/models'])
  })

  it('offers no credential when the draft names none', async () => {
    const server = await listingServer({ body: JSON.stringify({ data: [{ id: 'm' }] }) })
    const ctx = await harness()

    await ctx.llm.discoverModels('llm-pi-ai', { baseURL: server.url })

    expect(server.headers[0]?.authorization).toBeUndefined()
  })

  it('authenticates a configured route the draft cannot supply a key for', async () => {
    // What the Models page actually sends after a key is saved: the form holds
    // the redacted descriptor, so the draft names the route and the endpoint
    // and no credential at all. Interrogating unauthenticated would answer 401
    // and read as a wrong key.
    const server = await listingServer({ body: JSON.stringify({ data: [{ id: 'm' }] }) })
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    process.env['ACME_GATEWAY_KEY'] = 'stored-key'
    touchedEnv.push('ACME_GATEWAY_KEY')
    await ctx.plugin(LlmPiAi, {
      providers: {
        'acme-gateway': {
          apiKeyEnv: 'ACME_GATEWAY_KEY',
          api: 'openai-completions',
          baseURL: server.url,
          models: [{ id: 'acme-large' }],
        },
      },
    })

    await ctx.llm.discoverModels('llm-pi-ai', { provider: 'acme-gateway', baseURL: server.url })
    // A key typed into the form is the one being tested — possibly the
    // replacement for the stored one — so it wins.
    await ctx.llm.discoverModels('llm-pi-ai', { provider: 'acme-gateway', baseURL: server.url, apiKey: 'typed' })
    // A route no profile declares yet is the create case: nothing is stored.
    await ctx.llm.discoverModels('llm-pi-ai', { provider: 'not-declared-yet', baseURL: server.url })

    expect(server.headers.map(headers => headers.authorization))
      .toEqual(['Bearer stored-key', 'Bearer typed', undefined])
  })

  it('reports an absent saved credential before contacting the default endpoint', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    Reflect.deleteProperty(process.env, 'ABSENT_FOR_DISCOVERY')
    await ctx.plugin(LlmPiAi, { providers: { deepseek: { apiKeyEnv: 'ABSENT_FOR_DISCOVERY' } } })

    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    await expect(ctx.llm.discoverModels('llm-pi-ai', { provider: 'deepseek' })).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('uses native provider authentication when no credential reference is configured', async () => {
    const server = await listingServer({ body: JSON.stringify({ data: [{ id: 'fresh-raster-alias', endpoints: ['images/generations'] }] }) })
    vi.stubEnv('OPENAI_API_KEY', 'fixture-native-key')
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, { providers: { openai: { baseURL: server.url } } })
    expect(await ctx.llm.discoverModels('llm-pi-ai', { provider: 'openai' })).toEqual([
      { id: 'fresh-raster-alias', endpoints: ['images/generations'] },
    ])
    expect(server.headers[0]?.authorization).toBe('Bearer fixture-native-key')
    await ctx.fiber.dispose()
  })

  it('drops unusable rows rather than failing the whole listing', async () => {
    const server = await listingServer({
      body: JSON.stringify({
        data: [
          { id: 'good' },
          { id: '' },
          { name: 'no id at all' },
          null,
          { id: 'good' },
          { id: 'zero-capacity', context_length: 0, max_tokens: -1 },
        ],
      }),
    })
    const ctx = await harness()

    expect(await ctx.llm.discoverModels('llm-pi-ai', { baseURL: server.url }))
      .toEqual([{ id: 'good' }, { id: 'zero-capacity' }])
  })

  it('points at the credential for a rejected one, and only then', async () => {
    const ctx = await harness()

    for (const status of [401, 403]) {
      const refused = await listingServer({ status, body: '{"error":"nope"}' })
      await expect(ctx.llm.discoverModels('llm-pi-ai', { baseURL: refused.url, apiKey: 'wrong' }))
        .rejects.toThrow(new RegExp(`answered ${status}; check the API key`))
    }

    // A server fault is not a credential problem, so it must not send the user
    // off to re-check a key that is fine.
    const broken = await listingServer({ status: 500, body: '{"error":"boom"}' })
    await expect(ctx.llm.discoverModels('llm-pi-ai', { baseURL: broken.url, apiKey: 'fine' }))
      .rejects.toThrow(/answered 500$/)
  })

  it('reports a reply that is not a model listing', async () => {
    const server = await listingServer({ body: '{"models":[]}' })
    const ctx = await harness()

    await expect(ctx.llm.discoverModels('llm-pi-ai', { baseURL: server.url }))
      .rejects.toThrow(/no "data" array; enter this provider's models by hand/)

    const broken = await listingServer({ body: 'not json at all' })
    await expect(ctx.llm.discoverModels('llm-pi-ai', { baseURL: broken.url }))
      .rejects.toThrow(/did not answer with JSON/)
  })

  it('refuses an oversized reply, whether its length is declared or streamed', async () => {
    const ctx = await harness()
    // Just over the four-megabyte ceiling, as one padded model row.
    const oversized = `{"data":[{"id":"m","pad":"${'x'.repeat(4 * 1024 * 1024)}"}]}`

    const declared = await listingServer({ body: oversized })
    await expect(ctx.llm.discoverModels('llm-pi-ai', { baseURL: declared.url }))
      .rejects.toThrow(/answered with more than 4194304 bytes/)

    // A streamed reply declares no length, so the ceiling has to hold on the
    // body the harness actually read.
    const streamed = await listingServer({ chunks: ['{"data":[{"id":"m","pad":"', 'x'.repeat(4 * 1024 * 1024), '"}]}'] })
    await expect(ctx.llm.discoverModels('llm-pi-ai', { baseURL: streamed.url }))
      .rejects.toThrow(/answered with more than 4194304 bytes/)
  })

  it('reports an unreachable endpoint instead of an empty catalog', async () => {
    const ctx = await harness()
    // Port 9 is the discard service: nothing accepts a connection there.
    await expect(ctx.llm.discoverModels('llm-pi-ai', { baseURL: 'http://127.0.0.1:9/v1' }))
      .rejects.toMatchObject({ code: 'DISCOVERY_FAILED' })
  })

  it.each(['anthropic-messages', 'azure-openai-responses', 'openai-codex-responses'])(
    'says it cannot interrogate %s rather than guessing a shape',
    async (api) => {
      // Azure authenticates with an `api-key` header and an `api-version`
      // query despite its OpenAI lineage, and Codex uses OAuth; guessing at
      // either would report an auth failure as a provider with no models.
      const ctx = await harness()
      await expect(ctx.llm.discoverModels('llm-pi-ai', { baseURL: 'https://gateway.example/v1', api }))
        .rejects.toMatchObject({ code: 'DISCOVERY_UNSUPPORTED' })
    },
  )

  it('reports cancellation during the body read as an abort, not a raw reason', async () => {
    const ctx = await harness()
    const controller = new AbortController()
    const bodyRead = Promise.withResolvers<undefined>()
    vi.stubGlobal('fetch', async (_url: string | URL, init?: RequestInit) => {
      const signal = init?.signal
      if (signal === undefined || signal === null) throw new Error('expected a discovery signal')
      return new Response(new ReadableStream<Uint8Array>({
        pull(stream) {
          bodyRead.resolve(undefined)
          return new Promise<void>((resolve) => {
            signal.addEventListener('abort', () => {
              stream.error(signal.reason)
              resolve()
            }, { once: true })
          })
        },
      }))
    })
    const probe = ctx.llm.discoverModels('llm-pi-ai', {
      baseURL: 'https://slow.example/v1',
      signal: controller.signal,
    })
    await bodyRead.promise
    controller.abort('test cancellation')

    await expect(probe).rejects.toMatchObject({ code: 'ABORTED' })
  })

  it('honors caller cancellation', async () => {
    const ctx = await harness()
    const aborted = AbortSignal.abort('test cancellation')
    await expect(ctx.llm.discoverModels('llm-pi-ai', {
      baseURL: 'http://127.0.0.1:9/v1',
      signal: aborted,
    })).rejects.toMatchObject({ code: 'ABORTED' })
  })

  it('is offered for the namespace, and refuses one it does not serve', async () => {
    const ctx = await harness()
    vi.stubGlobal('fetch', async () => Response.json({ data: [{ id: 'live-model' }] }))

    await expect(ctx.llm.discoverModels('llm-pi-ai', { provider: 'openai' })).resolves.not.toHaveLength(0)
    await expect(ctx.llm.discoverModels('llm-deepseek', { baseURL: 'https://api.deepseek.com' }))
      .rejects.toMatchObject({ code: 'NO_DISCOVERY' })
    await expect(ctx.llm.discoverModels('llm-pi-ai', { baseURL: '' }))
      .rejects.toMatchObject({ code: 'INVALID_DISCOVERY' })
  })

  it('withdraws the offer when the plugin unloads', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const fiber = await ctx.plugin(LlmPiAi, {})
    vi.stubGlobal('fetch', async () => Response.json({ data: [{ id: 'live-model' }] }))
    await expect(ctx.llm.discoverModels('llm-pi-ai', { provider: 'openai' })).resolves.not.toHaveLength(0)

    await fiber.dispose()

    await expect(ctx.llm.discoverModels('llm-pi-ai', { provider: 'openai' }))
      .rejects.toMatchObject({ code: 'NO_DISCOVERY' })
  })
})

describe('probe key format', () => {
  it('reports an illegal probe key as a credential fault, not an unreachable endpoint', async () => {
    await expect(discoverModels({
      baseURL: 'https://acme.test',
      api: 'openai-completions',
      apiKey: 'sk-\u{1F600}',
    })).rejects.toMatchObject({ code: 'INVALID_CREDENTIAL' })
  })

  it('reports a blank probe key as a credential fault too', async () => {
    // The Models page omits `apiKey` entirely for a cleared field rather than
    // sending '', so this pins the contract for every other caller: a supplied
    // key is judged, and only an absent one probes unauthenticated. '' means
    // "I have a key" and is answered as the empty key it is.
    await expect(discoverModels({
      baseURL: 'https://acme.test',
      api: 'openai-completions',
      apiKey: '',
    })).rejects.toMatchObject({ code: 'INVALID_CREDENTIAL' })
  })

  it('leaves a probe with no key unauthenticated', async () => {
    // The file's other cases capture headers through a real local HTTP server
    // (`listingServer`); this one has no route or stored key to resolve, so
    // the smallest real double is a `fetch` stub, scoped to this test and
    // unstubbed by the shared `afterEach` above.
    const requests: RequestInit[] = []
    vi.stubGlobal('fetch', async (_url: string | URL, init?: RequestInit) => {
      requests.push(init ?? {})
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })

    await discoverModels({ baseURL: 'https://acme.test', api: 'openai-completions' })

    const headers = new Headers(requests[0]?.headers)
    expect(headers.has('authorization')).toBe(false)
  })
})

it('tries configured fallback keys for discovery and keeps an explicit draft key isolated', async () => {
  process.env['DISCOVERY_FIRST'] = 'first'
  process.env['DISCOVERY_SECOND'] = 'second'
  touchedEnv.push('DISCOVERY_FIRST', 'DISCOVERY_SECOND')
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LlmPiAi, { providers: { 'acme-gateway': {
    api: 'openai-completions', baseURL: 'https://listing.test', models: [{ id: 'test' }],
    apiKeyEnv: 'DISCOVERY_FIRST', apiKeyFallbackEnvs: ['DISCOVERY_SECOND'],
  } } })
  const sent: string[] = []
  vi.stubGlobal('fetch', (_url: string, options: RequestInit) => {
    const auth = new Headers(options.headers).get('authorization') ?? ''
    sent.push(auth)
    return Promise.resolve(auth === 'Bearer second'
      ? new Response('{"data":[{"id":"found"}]}', { status: 200 })
      : new Response('{}', { status: 401 }))
  })
  try {
    await expect(ctx.llm.discoverModels('llm-pi-ai', { provider: 'acme-gateway', baseURL: 'https://listing.test' }))
      .resolves.toEqual([{ id: 'found' }])
    expect(sent).toEqual(['Bearer first', 'Bearer second'])
    await expect(ctx.llm.discoverModels('llm-pi-ai', { provider: 'acme-gateway', baseURL: 'https://listing.test', apiKey: 'draft' }))
      .rejects.toMatchObject({ code: 'DISCOVERY_FAILED' })
    expect(sent).toEqual(['Bearer first', 'Bearer second', 'Bearer draft'])
  } finally {
    await ctx.fiber.dispose()
  }
})

it('discovers models for fallback-only and native-auth profiles', async () => {
  const server = await listingServer({ body: '{"data":[{"id":"found"}]}' })
  process.env['ONLY_FALLBACK'] = 'only-key'
  touchedEnv.push('ONLY_FALLBACK')
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LlmPiAi, { providers: {
    fallback: { api: 'openai-completions', baseURL: server.url, models: [{ id: 'test' }], apiKeyFallbackEnvs: ['ONLY_FALLBACK'] },
    native: { api: 'openai-completions', baseURL: server.url, models: [{ id: 'test' }] },
  } })
  try {
    for (const provider of ['fallback', 'native']) {
      await expect(ctx.llm.discoverModels('llm-pi-ai', { provider })).resolves.toEqual([{ id: 'found' }])
    }
    expect(server.headers.map(headers => headers.authorization)).toEqual(['Bearer only-key', undefined])
  } finally {
    await ctx.fiber.dispose()
  }
})

it('classifies cancellation while waiting for discovery headers', async () => {
  const controller = new AbortController()
  vi.stubGlobal('fetch', () => {
    controller.abort('stop')
    return Promise.reject(new Error('aborted transport'))
  })
  await expect(discoverModels({ baseURL: 'https://listing.test', signal: controller.signal }))
    .rejects.toMatchObject({ code: 'ABORTED' })
})

it('discovers a configured keyless route without inventing a credential reference', async () => {
  const server = await listingServer({ body: JSON.stringify({ data: [{ id: 'm' }] }) })
  const ctx = new Context()
  try {
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, { providers: { 'keyless': { api: 'openai-completions', baseURL: server.url, models: [{ id: 'm' }] } } })
    expect(await ctx.llm.discoverModels('llm-pi-ai', { provider: 'keyless' })).toEqual([{ id: 'm' }])
    expect(server.headers[0]?.authorization).toBeUndefined()
  } finally { await ctx.fiber.dispose() }
})

it('inherits the saved HTTP proxy for provider discovery', async () => {
  const tunnels: string[] = []
  const proxy = createServer()
  servers.push(proxy)
  proxy.on('connect', (request, socket) => {
    tunnels.push(request.url!)
    socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n')
  })
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve))
  const address = proxy.address()
  if (address === null || typeof address === 'string') throw new Error('missing proxy address')
  const ctx = new Context()
  try {
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, { providers: { fixture: {
      api: 'openai-completions', baseURL: 'https://listing.test/v1',
      proxy: `http://127.0.0.1:${address.port}`, models: [{ id: 'm' }],
    } } })
    await expect(ctx.llm.discoverModels('llm-pi-ai', { provider: 'fixture' }))
      .rejects.toMatchObject({ code: 'DISCOVERY_FAILED' })
    expect(tunnels).toEqual(['listing.test:443'])
  } finally { await ctx.fiber.dispose() }
})

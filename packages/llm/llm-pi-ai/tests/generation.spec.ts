/** Real HTTP discovery and generation over the configured adapter and credential fallback. */
import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@hydraharness/cordis'
import LlmRuntime, { createUserMessage, userAgent } from '@hydraharness/harness-llm'
import * as PiAi from '../src/index.ts'
import { Config } from '../src/config.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
  vi.unstubAllEnvs()
})

async function harness(status: (model: string, authorization: string | undefined) => number = () => 200, config: {
  models?: Array<{ id: string; endpoints?: string[] }>
  key?: string
  fallbackKeys?: string[]
  imageModel?: string
  videoModel?: string
  api?: 'openai-completions' | 'google-generative-ai'
  hang?: boolean
  broken?: boolean
  completeVideo?: boolean
  videoStatus?: number
  videoFailed?: boolean
} = {}) {
  const listing = config.models ?? [{ id: 'gpt-image-2' }, { id: 'gpt-image-1.5' }, { id: 'sora-2' }, { id: 'chat-model' }]
  const calls: Array<{ method: string; path: string; model: string; auth?: string; raw: string }> = []
  const server: Server = createServer((request, response) => { void (async () => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array))
    const raw = Buffer.concat(chunks).toString()
    const json = request.headers['content-type']?.startsWith('application/json') ? JSON.parse(raw) as { model: string } : undefined
    const model = json?.model ?? /models\/([^:]+):(?:generateContent|predictLongRunning)/.exec(request.url!)?.[1] ?? /name="model"\r\n\r\n([^\r]+)/.exec(raw)?.[1] ?? ''
    const auth = request.headers.authorization ?? request.headers['x-goog-api-key']
    calls.push({
      method: request.method!, path: request.url!, model,
      ...typeof auth === 'string' ? { auth } : {}, raw,
    })
    if (config.broken && request.method === 'POST') { response.destroy(); return }
    if (config.hang && request.method === 'POST') return
    if (config.completeVideo && request.method === 'GET' && !request.url?.endsWith('/models')) {
      if (request.url?.endsWith('/content') || request.url?.endsWith(':download') || request.url?.endsWith('fixture.mp4')) {
        response.writeHead(200, { 'Content-Type': 'video/mp4' }); response.end(new Uint8Array([1, 2, 3])); return
      }
      response.writeHead(config.videoStatus ?? 200, { 'Content-Type': 'application/json' })
      const name = `models/${listing[0]!.id}/operations/accepted-job`
      response.end(JSON.stringify(config.api === 'google-generative-ai' ? config.videoFailed
        ? { name, done: true, error: { message: 'private provider failure' } }
        : { name, done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: `${baseURL}/files/video:download` } }] } } }
        : listing[0]!.id.startsWith('grok-') ? { status: 'done', video: { url: `${baseURL}/assets/fixture.mp4` } }
          : { id: 'accepted-job', status: config.videoFailed ? 'failed' : 'completed' }))
      return
    }
    response.writeHead(request.method === 'GET' ? 200 : status(model, request.headers.authorization), { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(request.method === 'GET'
      ? config.api === 'google-generative-ai' ? { models: listing.map(model => ({ name: `models/${model.id}`, supportedGenerationMethods: ['generateContent'] })) } : { data: listing }
      : config.completeVideo ? config.api === 'google-generative-ai' ? { name: `models/${model}/operations/accepted-job` }
        : model.startsWith('grok-') ? { request_id: 'accepted-job' } : { id: 'accepted-job', status: 'queued' }
        : { id: 'accepted-job', data: [] }))
    if (request.method === 'POST') expect(request.headers['user-agent']).toBe(userAgent())
  })().catch((error: unknown) => { response.destroy(error instanceof Error ? error : new Error(String(error))) }) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => { resolve() })) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('No fixture HTTP port')
  const baseURL = `http://127.0.0.1:${address.port}/gateway/v1`
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  const dormant = await ctx.plugin(PiAi, {})
  const models = await ctx.llm.discoverModels('llm-pi-ai', { baseURL, ...config.api === undefined ? {} : { api: config.api } })
  await dormant.dispose()
  await ctx.plugin(PiAi, new Config({ providers: { fixture: {
    api: config.api ?? 'openai-completions', baseURL, models: models.map(model => ({ ...model, ...model.endpoints === undefined ? {} : { endpoints: [...model.endpoints] } })),
    ...config.key === undefined ? {} : { apiKeyEnv: config.key }, apiKeyFallbackEnvs: config.fallbackKeys ?? [],
  } },
  ...config.imageModel === undefined ? {} : { imageModel: { provider: 'fixture', model: config.imageModel } },
  ...config.videoModel === undefined ? {} : { videoModel: { provider: 'fixture', model: config.videoModel } },
  }))
  const generate = (extra: Partial<Parameters<typeof ctx.llm.generateMedia>[0]> = {}) => ctx.llm.generateMedia({
    endpoint: 'images/generations', body: { prompt: 'A tree' }, maxResponseBytes: 32768, signal: new AbortController().signal, ...extra,
  })
  return { ctx, calls, generate }
}

describe('configured generation models', () => {
  it('refuses unsupported reference images before submitting a video', async () => {
    const h = await harness(undefined, { videoModel: 'sora-2' })
    await expect(h.generate({ endpoint: 'videos', body: { prompt: 'Animate', referenceImages: [] } }))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_GENERATION' })
    expect(h.calls.filter(call => call.method === 'POST')).toHaveLength(0)
  })
  it.each(['veo-3.1-generate-preview', 'grok-imagine-video', 'gateway-video'] as const)('downloads completed %s video on the accepted route', async (id) => {
    const google = id.startsWith('veo-')
    vi.stubEnv('GENERATION_VIDEO_KEY', 'video-fixture-key')
    const h = await harness(undefined, { completeVideo: true, api: google ? 'google-generative-ai' : 'openai-completions',
      key: 'GENERATION_VIDEO_KEY', models: [{ id, endpoints: ['videos'] }], videoModel: id,
    })
    const result = await h.generate({ endpoint: 'videos', pollIntervalMs: 1, body: { prompt: 'A tree', seconds: 6, size: '720x1280' } })
    expect(result).toMatchObject({ provider: 'fixture', model: id })
    expect(new Uint8Array(await result!.response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
    expect(h.calls.filter(call => call.method === 'POST')).toHaveLength(1)
    expect(h.calls.slice(1).every(call => call.auth === (google ? 'video-fixture-key' : 'Bearer video-fixture-key'))).toBe(true)
    if (google) {
      expect(JSON.parse(h.calls[1]!.raw)).toEqual({ instances: [{ prompt: 'A tree' }], parameters: { sampleCount: 1, aspectRatio: '9:16', durationSeconds: 6 } })
      await expect(h.generate({ endpoint: 'videos', body: { prompt: 'A tree', seconds: 5 } })).rejects.toMatchObject({ code: 'INVALID_GENERATION' })
      expect(h.calls.filter(call => call.method === 'POST')).toHaveLength(1)
    }
  })

  it.each([true, false])('does not submit another model after an accepted video job fails %#', async (videoFailed) => {
    const h = await harness(undefined, { completeVideo: true, videoFailed, ...videoFailed ? {} : { videoStatus: 429 },
      models: [{ id: 'veo-3.1-generate-preview', endpoints: ['videos'] }, { id: 'veo-other', endpoints: ['videos'] }],
      api: 'google-generative-ai', videoModel: 'veo-3.1-generate-preview',
    })
    await expect(h.generate({ endpoint: 'videos', pollIntervalMs: 1 })).rejects.toThrow('accepted job was not resubmitted')
    expect(h.calls.filter(call => call.method === 'POST')).toHaveLength(1)
  })

  it.each([
    { id: 'gemini-3.1-flash-image' },
    { id: 'google/gemini-3.1-flash-image' },
    { id: 'image-alias', endpoints: ['images/generations', 'chat/completions'] },
  ])('uses Chat Completions image output for a proxy model $id', async (model) => {
    const h = await harness(undefined, { models: [model] })
    const result = await h.generate({ body: { prompt: 'A tree', n: 1, size: '1024x1536' } })
    expect(result?.model).toBe(model.id)
    await result?.response.body?.cancel()
    expect(h.calls[1]?.path).toBe('/gateway/v1/chat/completions')
    expect(JSON.parse(h.calls[1]!.raw)).toEqual({
      model: model.id, stream: false, messages: [{ role: 'user', content: 'A tree' }],
      modalities: ['image', 'text'], n: 1, image_config: { aspect_ratio: '2:3' },
    })
  })
  it('routes the selected Gemini image model through native generateContent and refuses unsupported endpoints or batching before HTTP', async () => {
    vi.stubEnv('GENERATION_GEMINI_KEY', 'gemini-fixture-key')
    const h = await harness(undefined, { api: 'google-generative-ai', key: 'GENERATION_GEMINI_KEY', models: [{ id: 'gemini-3.1-flash-image' }], imageModel: 'gemini-3.1-flash-image' })
    const result = await h.generate()
    expect(result?.model).toBe('gemini-3.1-flash-image')
    await result?.response.body?.cancel()
    expect(h.calls[1]).toMatchObject({ path: '/gateway/v1/models/gemini-3.1-flash-image:generateContent', auth: 'gemini-fixture-key' })
    expect(JSON.parse(h.calls[1]!.raw)).toEqual({ contents: [{ role: 'user', parts: [{ text: 'A tree' }] }], generationConfig: { responseModalities: ['IMAGE'] } })
    expect(await h.generate({ endpoint: 'videos' })).toBeUndefined()
    await expect(h.generate({ body: { prompt: 'A tree', n: 2 } })).rejects.toMatchObject({ code: 'UNSUPPORTED_GENERATION' })
    await expect(h.ctx.llm.resolveCallConfig({ provider: 'fixture', model: 'gemini-3.1-flash-image' }))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_MODEL_ENDPOINT' })
    expect(h.calls).toHaveLength(2)
  })
  it('uses saved image/video choices before tool hints, including models with no endpoint metadata', async () => {
    const h = await harness(model => model === 'future-image' ? 404 : 200, {
      models: [{ id: 'gpt-image-1.5' }, { id: 'future-image' }, { id: 'future-video' }, { id: 'chat-model' }],
      imageModel: 'future-image', videoModel: 'future-video',
    })
    const image = await h.generate({ model: 'gpt-image-1.5' })
    expect(image?.model).toBe('gpt-image-1.5')
    await image?.response.body?.cancel()
    const video = await h.generate({ endpoint: 'videos' })
    expect(video?.model).toBe('future-video')
    await video?.response.body?.cancel()
    expect(h.calls.filter(call => call.method === 'POST').map(call => [call.path, call.model])).toEqual([
      ['/gateway/v1/images/generations', 'future-image'],
      ['/gateway/v1/images/generations', 'gpt-image-1.5'],
      ['/gateway/v1/videos', 'future-video'],
    ])
  })
  it('stops before another model on invalid credentials, invalid video fields, or a lost response', async () => {
    vi.stubEnv('GENERATION_INVALID_KEY', 'invalid\nheader')
    const invalid = await harness(undefined, { key: 'GENERATION_INVALID_KEY' })
    await expect(invalid.generate()).rejects.toMatchObject({ code: 'INVALID_CREDENTIAL' })
    expect(invalid.calls).toHaveLength(1)

    const video = await harness()
    await expect(video.generate({ endpoint: 'videos', body: { reference: {} } })).rejects.toMatchObject({ code: 'INVALID_GENERATION' })
    expect(video.calls).toHaveLength(1)

    const broken = await harness(undefined, { broken: true })
    await expect(broken.generate()).rejects.toThrow()
    expect(broken.calls).toHaveLength(2)
  })
  it.each([401, 404, 429])('fetches, materializes and falls back after HTTP %i using the provider credential', async (status) => {
    vi.stubEnv('GENERATION_FIXTURE_KEY', 'fixture-key')
    const h = await harness(model => model === 'gpt-image-2' ? status : 200, { key: 'GENERATION_FIXTURE_KEY' })
    expect((await h.ctx.llm.listModels('fixture')).find(model => model.id === 'sora-2')?.endpoints).toEqual(['videos'])
    const result = await h.generate()
    expect(result).toMatchObject({ provider: 'fixture', model: 'gpt-image-1.5' })
    expect(await result!.response.json()).toEqual({ id: 'accepted-job', data: [] })
    expect(h.calls.map(call => [call.method, call.path, call.model, call.auth])).toEqual([
      ['GET', '/gateway/v1/models', '', undefined],
      ['POST', '/gateway/v1/images/generations', 'gpt-image-2', 'Bearer fixture-key'],
      ['POST', '/gateway/v1/images/generations', 'gpt-image-1.5', 'Bearer fixture-key'],
    ])
  })

  it('prefers an explicitly selected model and never posts when no matching endpoint exists', async () => {
    const h = await harness()
    const result = await h.generate({ model: 'gpt-image-1.5' })
    expect(result?.model).toBe('gpt-image-1.5')
    await result?.response.body?.cancel()
    expect(await h.generate({ provider: 'absent' })).toBeUndefined()
    expect(h.calls).toHaveLength(2)
  })

  it('tries configured keys before moving to another model, including missing references', async () => {
    vi.stubEnv('GENERATION_MISSING_KEY', '')
    vi.stubEnv('GENERATION_BAD_KEY', 'bad-fixture-key')
    vi.stubEnv('GENERATION_GOOD_KEY', 'good-fixture-key')
    const h = await harness((_model, auth) => auth === 'Bearer good-fixture-key' ? 200 : 401, {
      key: 'GENERATION_MISSING_KEY', fallbackKeys: ['GENERATION_BAD_KEY', 'GENERATION_GOOD_KEY'],
    })
    const result = await h.generate()
    expect(result?.model).toBe('gpt-image-2')
    await result?.response.body?.cancel()
    expect(h.calls.filter(call => call.method === 'POST').map(call => call.auth)).toEqual(['Bearer bad-fixture-key', 'Bearer good-fixture-key'])
  })

  it('does not send a generation or conversation request with missing generation credentials', async () => {
    vi.stubEnv('GENERATION_MISSING_KEY', '')
    const h = await harness(undefined, { key: 'GENERATION_MISSING_KEY' })
    await expect(h.generate()).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
    await expect(h.ctx.llm.resolveCallConfig({ provider: 'fixture', model: 'gpt-image-2' })).rejects.toMatchObject({ code: 'UNSUPPORTED_MODEL_ENDPOINT' })
    const chunks = []
    for await (const chunk of h.ctx.llm.stream({ provider: 'fixture', model: 'sora-2', system: '', messages: [createUserMessage({ content: [{ type: 'text', text: 'A tree' }], source: { kind: 'plugin', plugin: 'test' } })], tools: [] })) chunks.push(chunk)
    expect(chunks).toMatchObject([{ type: 'finish', reason: { kind: 'error', failure: { code: 'UNSUPPORTED_MODEL_ENDPOINT' } } }])
    expect(h.calls).toHaveLength(1)
  })

  it.each([400, 403, 408, 500, 503])('stops on HTTP %i without submitting another generation', async (status) => {
    const h = await harness(() => status)
    await expect(h.generate()).rejects.toMatchObject({ failure: { status } })
    expect(h.calls).toHaveLength(2)
  })

  it('returns an accepted video job and preserves multipart model routing', async () => {
    const h = await harness(undefined, { models: [{ id: 'sora-2' }, { id: 'sora-2-pro' }, { id: 'gpt-image-2' }] })
    const result = await h.generate({ endpoint: 'videos', body: { prompt: 'A swaying tree', seconds: 4, size: '720x1280' } })
    expect(result?.model).toBe('sora-2')
    expect(await result!.response.json()).toMatchObject({ id: 'accepted-job' })
    expect(h.calls[1]).toMatchObject({ path: '/gateway/v1/videos', model: 'sora-2' })
    expect(h.calls[1]?.raw).toContain('name="seconds"\r\n\r\n4')
    expect(h.calls).toHaveLength(2)
  })

  it('falls back between video models only after a rejected submission', async () => {
    const h = await harness(model => model === 'sora-2' ? 404 : 200, { models: [{ id: 'sora-2' }, { id: 'sora-2-pro' }] })
    const result = await h.generate({ endpoint: 'videos' })
    expect(result?.model).toBe('sora-2-pro')
    await result?.response.body?.cancel()
    expect(h.calls.filter(call => call.method === 'POST').map(call => call.path)).toEqual(['/gateway/v1/videos', '/gateway/v1/videos'])
  })

  it('cancels the complete sequence and never falls back after a timeout', async () => {
    const h = await harness(undefined, { hang: true })
    await expect(h.generate({ signal: AbortSignal.timeout(150) })).rejects.toThrow()
    expect(h.calls).toHaveLength(2)
    const controller = new AbortController()
    controller.abort()
    await expect(h.generate({ signal: controller.signal })).rejects.toThrow()
    expect(h.calls).toHaveLength(2)
  })
})

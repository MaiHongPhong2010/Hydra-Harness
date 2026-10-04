/** Native generation request fields and response validation. */
import { afterEach, expect, it, vi } from 'vitest'
import { PiAiAdapter } from '../src/adapter.ts'
import { resolveProfiles } from '../src/config.ts'
import { memoryAuth } from './auth-double.ts'
const request = (model: string, body: Record<string, unknown> = { prompt: 'Tree' }) => ({ provider: 'fixture', model, endpoint: 'images/generations' as const, body, maxResponseBytes: 4096, signal: new AbortController().signal })
function adapter(id: string, google = false, videos = false) {
  const profiles = resolveProfiles({ fixture: { api: google ? 'google-generative-ai' : 'openai-completions', baseURL: 'http://127.0.0.1:1234/v1beta', models: [{ id, endpoints: [videos ? 'videos' : 'images/generations', ...videos ? [] : ['chat/completions']] }] } })
  return new PiAiAdapter({ profiles: () => profiles, resolveApiKey: async () => undefined, auth: memoryAuth() })
}
afterEach(() => vi.unstubAllGlobals())
const png = Buffer.from([137,80,78,71,13,10,26,10]).toString('base64')
it.each([{ prompt: 'Tree' }, { prompt: 'Tree', n: 1, size: '1024x1536', quality: 'auto' }, { prompt: 'Tree', n: 2, quality: 'medium' }])('sends xAI image controls and normalizes inline PNGs: %j', async (body) => {
  const fetcher = vi.fn<typeof globalThis.fetch>(async () => Response.json({ data: [{ b64_json: png }] }))
  vi.stubGlobal('fetch', fetcher)
  const response = await adapter('grok-imagine-image').requestGeneration(request('grok-imagine-image', body))
  expect(await response.json()).toMatchObject({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: png } }] } }] })
  const fields = JSON.parse(fetcher.mock.calls[0]![1]!.body as string) as Record<string, unknown>
  expect(fields).toMatchObject({ model: 'grok-imagine-image', prompt: 'Tree', response_format: 'b64_json' })
  expect(fields.quality).toBe(body.quality === 'auto' ? undefined : body.quality)
})
it.each([
  [null, 'no body'], [Response.json(null), 'no inline images'], [Response.json({}), 'no inline images'], [Response.json({ data: [] }), 'no inline images'],
  [Response.json({ data: [null] }), 'invalid inline image'], [Response.json({ data: [{}] }), 'invalid inline image'],
  [Response.json({ data: [{ b64_json: '' }] }), 'invalid inline image'], [Response.json({ data: [{ b64_json: 1 }] }), 'invalid inline image'],
  [Response.json({ data: [{ b64_json: Buffer.from('unsupported').toString('base64') }] }), 'unsupported image format'],
])('rejects malformed xAI image responses %#', async (response, message) => {
  vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(async () => response ?? new Response(null)))
  await expect(adapter('grok-imagine-image').requestGeneration(request('grok-imagine-image'))).rejects.toThrow(message)
})
it('bounds the xAI response body', async () => {
  vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(async () => Response.json({ data: [{ b64_json: png }] })))
  await expect(adapter('grok-imagine-image').requestGeneration({ ...request('grok-imagine-image'), maxResponseBytes: 1 })).rejects.toThrow('maxResponseBytes')
})
it.each([
  [Buffer.from([255,216,255]), 'image/jpeg'], [Buffer.from('RIFF1234WEBP'), 'image/webp'],
])('recognizes inline image format %s', async (bytes, mimeType) => {
  vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(async () => Response.json({ data: [{ b64_json: bytes.toString('base64') }] })))
  expect(await (await adapter('grok-imagine-image').requestGeneration(request('grok-imagine-image'))).json()).toMatchObject({ candidates: [{ content: { parts: [{ inlineData: { mimeType } }] } }] })
})
it.each(['grok-imagine-video', 'veo-3.1-generate-preview'])('omits unset native video controls and polling credentials for %s', async (model) => {
  const google = model.startsWith('veo')
  const fetcher = vi.fn<typeof globalThis.fetch>(async () => new Response(new Uint8Array([1]), { headers: { 'Content-Type': 'video/mp4' } }))
  vi.stubGlobal('fetch', fetcher)
  await adapter(model, google, true).requestGeneration({ ...request(model), endpoint: 'videos', pollIntervalMs: 1 })
  const fields = JSON.parse(fetcher.mock.calls[0]![1]!.body as string) as Record<string, unknown>
  expect(fields).toEqual(google ? { instances: [{ prompt: 'Tree' }], parameters: { sampleCount: 1 } } : { model, prompt: 'Tree' })
})
it('omits unset proxy image controls', async () => {
  const fetcher = vi.fn<typeof globalThis.fetch>(async () => Response.json({ choices: [] }))
  vi.stubGlobal('fetch', fetcher)
  await adapter('gemini-3.1-flash-image').requestGeneration(request('gemini-3.1-flash-image'))
  expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).toEqual({ model: 'gemini-3.1-flash-image', stream: false, messages: [{ role: 'user', content: 'Tree' }], modalities: ['image','text'] })
})
it('rejects non-text multipart fields before sending a video', async () => {
  const fetcher = vi.fn()
  vi.stubGlobal('fetch', fetcher)
  await expect(adapter('sora-2', false, true).requestGeneration({ ...request('sora-2', { prompt: 'Tree', invalid: false }), endpoint: 'videos' })).rejects.toThrow('must be text or a number')
  expect(fetcher).not.toHaveBeenCalled()
})
it('downloads a signed Google asset without route authorization', async () => {
  const fetcher = vi.fn()
    .mockResolvedValueOnce(Response.json({ name: 'models/veo/operations/job', done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: 'http://127.0.0.1:1234/v1beta/files/video:download' } }] } } }))
    .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://storage.googleapis.com/video.mp4?signature=test' } }))
    .mockResolvedValueOnce(new Response(new Uint8Array([1]), { headers: { 'Content-Type': 'video/mp4' } }))
  vi.stubGlobal('fetch', fetcher)
  const response = await adapter('veo-3.1-generate-preview', true, true).requestGeneration({ ...request('veo-3.1-generate-preview'), endpoint: 'videos', pollIntervalMs: 1 })
  expect(await response.arrayBuffer()).toHaveProperty('byteLength', 1)
  expect(fetcher.mock.calls[2]![1]).not.toHaveProperty('headers')
})

it('forwards a native Google image aspect ratio when requested', async () => {
  const fetcher = vi.fn<typeof globalThis.fetch>(async () => Response.json({ candidates: [] }))
  vi.stubGlobal('fetch', fetcher)
  await adapter('gemini-3.1-flash-image', true).requestGeneration(request('gemini-3.1-flash-image', { prompt: 'Tree', size: '1024x1536' }))
  expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).toMatchObject({ generationConfig: { imageConfig: { aspectRatio: '2:3' } } })
})

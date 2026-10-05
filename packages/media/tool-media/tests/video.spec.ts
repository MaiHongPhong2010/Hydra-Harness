/** Video storage bounds, credential-independent routing, and shared media disposal. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@hydraharness/cordis'
import { CallId, createUserMessage, createToolResultMessage, type MediaGenerationOptions } from '@hydraharness/harness-llm'
import { Session, SessionId } from '@hydraharness/harness-session'
import Tools, { type ToolExecutionToken } from '@hydraharness/harness-tools'
import SystemPrompt from '@hydraharness/harness-system-prompt'
import AttachmentStore from '@hydraharness/harness-attachment-local'
import Credentials from '@hydraharness/harness-credentials-local'
import { toolVideoReferences, toolImageReferences } from '@hydraharness/harness-attachment'
import * as Media from '../src/index.ts'
import { admitGeneratedImages } from '../src/generated-images.ts'
import { registerGeminiWebRetrieve } from '../src/gemini-web-retrieve.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })

async function harness(config: Media.Config = {}, response?: () => Response | undefined) {
  const home = await mkdtemp(join(tmpdir(), 'hydra-tool-media-'))
  cleanups.push(() => rm(home, { recursive: true, force: true }))
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(AttachmentStore, { hydraHome: home })
  await ctx.plugin(Credentials, { path: join(home, 'credentials.yml'), hydraHome: home, watch: false })
  const calls: MediaGenerationOptions[] = []
  if (response !== undefined) ctx.provide('llm', { generateMedia: async (options: MediaGenerationOptions) => {
    calls.push(options)
    const body = response()
    return body === undefined ? undefined : { provider: 'fixture', model: 'video-fixture', response: body }
  } } as never)
  const fiber = await ctx.plugin(Media, config)
  return { ctx, fiber, calls, call: (args: unknown = { prompt: 'A tree' }, signal = new AbortController().signal, parent?: ToolExecutionToken) =>
    ctx.tools.execute({ name: 'video_generate', callId: CallId('video-test'), arguments: args, signal, ...parent === undefined ? {} : { parent } }) }
}

it('stores exact video bytes, labels the accepted route, and disposes every media tool', async () => {
  const bytes = new Uint8Array([1, 2, 3])
  const h = await harness({ video: { provider: 'fixture', model: 'hint', maxVideoBytes: 3, pollIntervalMs: 1 } }, () => new Response(bytes, { headers: { 'Content-Type': 'video/webm; charset=binary' } }))
  const result = await h.call({ prompt: 'A tree', seconds: 6, size: '720x1280' })
  expect(result.isError).toBe(false)
  expect(result.content).toEqual([{ type: 'text', text: 'Generated video with fixture (video-fixture).' }])
  expect(h.calls).toMatchObject([{ endpoint: 'videos', provider: 'fixture', model: 'hint', body: { prompt: 'A tree', seconds: 6, size: '720x1280' }, pollIntervalMs: 1 }])
  const videos = toolVideoReferences(result.meta)
  expect(videos).toMatchObject([{ bytes: 3, mediaType: 'video/webm', name: 'generated-video.webm' }])
  const stored: number[] = []
  for await (const chunk of h.ctx.attachments.readFileStream(videos[0]!)) stored.push(...chunk)
  expect(stored).toEqual([...bytes])
  const tool = h.ctx.tools.get('video_generate')!
  expect(tool.presentCall?.({ prompt: 'A tree', size: '720x1280' })).toMatchObject({ aspectRatio: 9 / 16 })
  expect(tool.presentCall?.({ prompt: 'A tree', size: '1280x720' })).toMatchObject({ aspectRatio: 16 / 9 })
  expect(tool.presentCall?.({ prompt: 'A tree' })).not.toHaveProperty('aspectRatio')
  expect(tool.presentResult?.({ prompt: 'A tree' }, result)).toMatchObject({ card: 'media', kind: 'video', content: [{ type: 'video', attachment: videos[0] }] })
  expect(tool.presentResult?.({ prompt: 'A tree' }, { content: [], isError: true })).toBeUndefined()
  await h.fiber.dispose()
  for (const name of ['image_generate', 'image_generate_google', 'video_generate']) expect(h.ctx.tools.get(name)).toBeUndefined()
})

it('uses MP4 naming and default request fields', async () => {
  const h = await harness({}, () => new Response(new Uint8Array([1]), { headers: { 'Content-Type': 'video/mp4' } }))
  const result = await h.call()
  expect(toolVideoReferences(result.meta)[0]?.name).toBe('generated-video.mp4')
  expect(h.calls).toMatchObject([{ body: { prompt: 'A tree' }, pollIntervalMs: 10000, maxResponseBytes: 1048576 }])
})

it('recovers a saved Gemini Web video without a prompt and keeps the recovery id in presentation', async () => {
  const jobId = '00000000-0000-4000-8000-000000000001'
  const h = await harness({}, () => new Response(new Uint8Array([1]), { headers: { 'Content-Type': 'video/mp4', 'x-hydra-job-id': jobId } }))
  const result = await h.ctx.tools.execute({ name: 'gemini_web_retrieve', callId: CallId('retrieve'),
    arguments: { jobId, kind: 'video' }, signal: new AbortController().signal })
  expect(result.isError).toBe(false)
  expect(h.calls).toMatchObject([{ provider: 'gemini-web', model: 'gemini-web-video', endpoint: 'videos', body: { jobId } }])
  expect(h.calls[0]!.body).not.toHaveProperty('prompt')
  expect(result.meta).toMatchObject({ kind: 'tool-videos', jobId })
  expect(toolVideoReferences(result.meta)).toHaveLength(1)
})

it('rejects invalid or nested saved-task recovery before requesting media', async () => {
  const h = await harness({}, content)
  for (const request of [
    { arguments: { jobId: '../other', kind: 'video' } },
    { arguments: { jobId: '00000000-0000-4000-8000-000000000001', kind: 'video' }, parent: Symbol('nested') as ToolExecutionToken },
  ]) {
    expect((await h.ctx.tools.execute({ name: 'gemini_web_retrieve', callId: CallId('retrieve'),
      signal: new AbortController().signal, ...request })).isError).toBe(true)
  }
  expect(h.calls).toHaveLength(0)
})

it('retains the recovery id when video attachment admission fails', async () => {
  const jobId = '00000000-0000-4000-8000-000000000001'
  const h = await harness({ video: { maxVideoBytes: 1 } }, () => new Response(new Uint8Array([1, 2]), {
    headers: { 'Content-Type': 'video/mp4', 'x-hydra-job-id': jobId },
  }))
  const result = await h.call()
  expect(result.isError).toBe(true)
  expect(JSON.stringify(result.content)).toContain(`jobId=${jobId}`)
  expect(toolVideoReferences(result.meta)).toHaveLength(0)
  expect(h.calls).toHaveLength(1)
})

it.each([
  [() => Response.json({ id: 'pending-job' }), 'completed MP4 or WebM'],
  [() => new Response(null, { headers: { 'Content-Type': 'video/mp4' } }), 'no video bytes'],
  [() => new Response(new Uint8Array(), { headers: { 'Content-Type': 'video/mp4' } }), 'Unable to persist attachment'],
  [() => new Response(new Uint8Array([1, 2, 3, 4]), { headers: { 'Content-Type': 'video/mp4' } }), 'Unable to persist attachment'],
] as const)('publishes no references for invalid or oversized video response %#', async (reply, error) => {
  const h = await harness({ video: { maxVideoBytes: 3 } }, reply)
  const result = await h.call()
  expect(result.isError).toBe(true)
  expect(JSON.stringify(result.content)).toContain(error)
  expect(toolVideoReferences(result.meta)).toEqual([])
  expect(h.calls).toHaveLength(1)
})

it.each([undefined, () => undefined])('requires a configured video route %#', async (reply) => {
  const h = await harness({}, reply)
  expect(JSON.stringify((await h.call()).content)).toContain('Configure a video model')
})

it.each([{ timeoutMs: 0 }, { pollIntervalMs: -1 }, { maxVideoBytes: 0 }, { maxResponseBytes: 0 }, { maxPromptChars: 0 }, { model: '' }, { provider: '' }, { timeoutMs: 2147483648 }, { pollIntervalMs: 2147483648 }])('rejects invalid video settings %j', async (video) => {
  await expect(harness({ video })).rejects.toThrow()
})

it('rejects invalid prompts and prior cancellation before generation', async () => {
  const h = await harness({ video: { maxPromptChars: 3 } }, () => Response.json({}))
  for (const prompt of [' ', 'long']) expect((await h.call({ prompt })).isError).toBe(true)
  const controller = new AbortController()
  controller.abort()
  expect((await h.call({ prompt: 'ok' }, controller.signal)).isError).toBe(true)
  expect(h.calls).toEqual([])
})

it('refuses nested execution before submitting a billable video request', async () => {
  const h = await harness({}, content)
  const result = await h.call(undefined, undefined, Symbol('parent') as ToolExecutionToken)
  expect(result.isError).toBe(true)
  expect(JSON.stringify(result.content)).toContain('requires Native tool mode')
  expect(h.calls).toEqual([])
})

function content(): Response {
  return new Response(new Uint8Array([1]), { headers: { 'Content-Type': 'video/mp4' } })
}

const JOB = '00000000-0000-4000-8000-000000000001'
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
it.each(['generated', 'uploaded', 'inline'] as const)('animates the durable %s image from an earlier turn', async (source) => {
  const h = await harness({}, content)
  const ref = await h.ctx.attachments.saveImage({ data: Buffer.from(PNG, 'base64'), mediaType: 'image/png' })
  const session = Session.create(SessionId('prior-image'))
  session.append('assistant/message', { turn: 1, step: 1, message: {
    id: 'unused' as never, role: 'assistant', source: { kind: 'model', provider: 'fixture', model: 'fixture' }, content: [],
  } }, { surfaceOp: 'append' })
  if (source === 'uploaded') session.append('user/message', createUserMessage({ source: { kind: 'user' },
    content: [{ type: 'text', text: 'Animate this' }, { type: 'image', attachment: ref }] }), { surfaceOp: 'append' })
  else session.append('tool/result', { turn: 1, step: 1,
    message: createToolResultMessage({ callId: CallId('prior-image'), isError: false,
      content: source === 'inline' ? [{ type: 'image', attachment: ref }] : [{ type: 'text', text: 'Generated an image.' }] }),
    ...source === 'generated' ? { meta: { kind: 'tool-images', images: [{ ...ref }] } } : {},
  }, { surfaceOp: 'append' })
  const result = await h.ctx.tools.execute({ name: 'video_generate', callId: CallId('animate'),
    arguments: { prompt: 'Animate the tree', reference_image_ids: [source === 'generated' ? 'latest' : ref.attachmentId], size: '720x1280' },
    agent: { session } as never, signal: new AbortController().signal })
  expect(result.isError).toBe(false)
  expect(h.calls).toMatchObject([{ body: { size: '720x1280', referenceImages: [{ mimeType: 'image/png' }] } }])
  const images = h.calls[0]!.body['referenceImages'] as Array<{ data: Uint8Array }>
  expect(Buffer.from(images[0]!.data)).toEqual(Buffer.from(PNG, 'base64'))
  expect(h.calls).toHaveLength(1)
  expect(JSON.stringify(session.events)).not.toContain(PNG)
})

it('refuses references outside the calling conversation and invalid batches before generation', async () => {
  const h = await harness({}, content)
  const session = Session.create(SessionId('empty-conversation'))
  for (const reference_image_ids of [[], ['latest', 'latest'], new Array(6).fill('unknown'), ['latest'], ['unknown']]) {
    const result = await h.ctx.tools.execute({ name: 'video_generate', callId: CallId('bad-reference'),
      arguments: { prompt: 'Animate', reference_image_ids }, agent: { session } as never, signal: new AbortController().signal })
    expect(result.isError).toBe(true)
  }
  expect((await h.call({ prompt: 'Animate', reference_image_ids: ['latest'] })).isError).toBe(true)
  expect(h.calls).toHaveLength(0)
})
function recoveredImage(): Response {
  return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ inlineData: { data: PNG, mimeType: 'image/png' } }] } }] },
    { headers: { 'x-hydra-job-id': JOB } })
}

it('recovers an image into durable references and renders both native media cards', async () => {
  const h = await harness({ google: { maxResponseBytes: 1024 }, video: { maxResponseBytes: 1024, timeoutMs: 1000 } }, recoveredImage)
  const args = { jobId: JOB, kind: 'image' as const }
  const result = await h.ctx.tools.execute({ name: 'gemini_web_retrieve', callId: CallId('image-retrieve'), arguments: args,
    signal: new AbortController().signal })
  expect(result.isError).toBe(false)
  expect(JSON.stringify(result.content)).toContain(`Retrieved Gemini Web image. jobId=${JOB}.`)
  expect(JSON.stringify(result.content)).toContain(toolImageReferences(result.meta)[0]?.attachmentId)
  expect(toolImageReferences(result.meta)).toMatchObject([{ width: 1, height: 1, mediaType: 'image/png' }])
  expect(h.calls[0]).toMatchObject({ body: { jobId: JOB }, maxResponseBytes: 1024, endpoint: 'images/generations' })
  const tool = h.ctx.tools.get('gemini_web_retrieve')!
  expect(tool.presentCall?.(args)).toMatchObject({ card: 'media', kind: 'image', prompt: `Job ${JOB}` })
  expect(tool.presentResult?.(args, result)).toMatchObject({ card: 'media', content: [{ type: 'image' }] })
  expect(tool.presentResult?.({ ...args, kind: 'video' }, { ...result, meta: { kind: 'tool-videos', videos: [] } })).toMatchObject({ content: [] })
  expect(tool.presentResult?.(args, { content: [], isError: true })).toBeUndefined()
})

it.each([undefined, () => undefined])('requires a Gemini Web recovery route %#', async (response) => {
  const h = await harness({}, response)
  const result = await h.ctx.tools.execute({ name: 'gemini_web_retrieve', callId: CallId('missing-retrieve'),
    arguments: { jobId: JOB, kind: 'image' }, signal: new AbortController().signal })
  expect(JSON.stringify(result.content)).toContain('Apply Gemini Web')
})

it.each([
  [() => new Response(null), 1024, 'no image bytes'],
  [recoveredImage, 1, 'response limit'],
  [() => Response.json({ candidates: [] }), 1024, 'Too small'],
])('refuses incomplete or excessive recovered image bytes %#', async (response, limit, message) => {
  const h = await harness({ google: { maxResponseBytes: limit } }, response)
  const result = await h.ctx.tools.execute({ name: 'gemini_web_retrieve', callId: CallId('invalid-retrieve'),
    arguments: { jobId: JOB, kind: 'image' }, signal: new AbortController().signal })
  expect(result.isError).toBe(true)
  expect(JSON.stringify(result.content)).toContain(message)
  expect(toolImageReferences(result.meta)).toEqual([])
})

it.each(['image_generate', 'image_generate_google', 'video_generate'] as const)('keeps the accepted job id for %s success', async (name) => {
  const h = await harness({}, name === 'video_generate' ? () => new Response(new Uint8Array([1]), {
    headers: { 'content-type': 'video/mp4', 'x-hydra-job-id': JOB },
  }) : recoveredImage)
  const result = await h.ctx.tools.execute({ name, callId: CallId('generated-job'), arguments: { prompt: 'Boat' },
    signal: new AbortController().signal })
  expect(result.isError).toBe(false)
  expect(result.meta).toMatchObject({ jobId: JOB })
})

it('keeps a saved image job recoverable after attachment storage fails', async () => {
  const h = await harness({}, recoveredImage)
  vi.spyOn(h.ctx.attachments, 'saveImage').mockRejectedValue(new Error('Disk full'))
  const result = await h.ctx.tools.execute({ name: 'gemini_web_retrieve', callId: CallId('disk-full'),
    arguments: { jobId: JOB, kind: 'image' }, signal: new AbortController().signal })
  expect(JSON.stringify(result.content)).toContain(`jobId=${JOB}`)
  for (const id of [undefined, null, 'invalid']) await expect(admitGeneratedImages(h.ctx.attachments,
    [{ data: PNG, mimeType: 'image/png' }], id)).rejects.toThrow('Disk full')
})

it('applies recovery defaults and presents a persisted video card', async () => {
  const h = await harness({}, content); await h.fiber.dispose()
  registerGeminiWebRetrieve(h.ctx, {}, {})
  const args = { jobId: JOB, kind: 'video' as const }
  const result = await h.ctx.tools.execute({ name: 'gemini_web_retrieve', callId: CallId('default-video-retrieve'),
    arguments: args, signal: new AbortController().signal })
  expect(result.isError).toBe(false)
  expect(h.calls[0]).toMatchObject({ pollIntervalMs: 10000, maxResponseBytes: 1048576 })
  expect(h.ctx.tools.get('gemini_web_retrieve')!.presentResult?.(args, result)).toMatchObject({ content: [{ type: 'video' }] })
})

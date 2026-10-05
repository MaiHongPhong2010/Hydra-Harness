/** Gemini HTTP parsing, durable images, billing guards, and registration disposal. */
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@hydraharness/cordis'
import { CallId, type MediaGenerationOptions } from '@hydraharness/harness-llm'
import Tools, { type ToolExecutionToken } from '@hydraharness/harness-tools'
import SystemPrompt from '@hydraharness/harness-system-prompt'
import AttachmentStore from '@hydraharness/harness-attachment-local'
import Credentials from '@hydraharness/harness-credentials-local'
import { credentialRef } from '@hydraharness/harness-credentials'
import { toolImageReferences } from '@hydraharness/harness-attachment'
import Invariants from '@hydraharness/harness-invariants'
import * as ImageTool from '../src/image-google.ts'
import * as MediaTool from '../src/index.ts'
import * as Companion from '../src/invariant.ts'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
const image = { inlineData: { mimeType: 'image/png', data: PNG } }
const success = (parts: unknown[] = [image]) => ({ candidates: [{ finishReason: 'STOP', content: { parts } }] })
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })

async function harness(config: ImageTool.GoogleImageConfig = {}, credential = true) {
  const home = await mkdtemp(join(tmpdir(), 'hydra-image-google-'))
  cleanups.push(() => rm(home, { recursive: true, force: true }))
  const requests: Array<{ url: string; key: string | string[] | undefined; body: unknown }> = []
  let response: { status: number; body: unknown; hang?: boolean; raw?: string } = { status: 200, body: success() }
  const server = createServer((request, reply) => { void (async () => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array))
    requests.push({ url: request.url!, key: request.headers['x-goog-api-key'], body: JSON.parse(Buffer.concat(chunks).toString()) as unknown })
    if (response.hang) return
    reply.writeHead(response.status, { 'Content-Type': 'application/json' })
    reply.end(response.raw ?? JSON.stringify(response.body))
  })().catch((error: unknown) => { reply.destroy(error instanceof Error ? error : new Error(String(error))) }) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => { server.close(() => { resolve() }) }) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('HTTP server has no port')
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(AttachmentStore, { hydraHome: home })
  await ctx.plugin(Credentials, { path: join(home, 'credentials.yml'), hydraHome: home, watch: false })
  if (credential) await ctx.credentials.set(credentialRef('HYDRA_GOOGLE_IMAGE_TEST_KEY'), 'fixture-only-key')
  const fiber = await ctx.plugin(MediaTool, { google: Object.assign({ baseURL: `http://127.0.0.1:${address.port}/v1`, apiKeyEnv: 'HYDRA_GOOGLE_IMAGE_TEST_KEY' }, config) })
  return {
    ctx, fiber, requests,
    respond: (next: typeof response) => { response = next },
    call: (args: unknown = { prompt: 'A tiny test image' }, signal = new AbortController().signal, parent?: ToolExecutionToken) =>
      ctx.tools.execute({ name: 'image_generate_google', callId: CallId('image-google-test'), arguments: args, signal, ...parent === undefined ? {} : { parent } }),
  }
}

describe('Google image tool', () => {
  it.each(['antigravity', 'chat-completions'] as const)('admits final %s images and rejects incomplete or remote-only output', async (format) => {
    const h = await harness()
    const reply = format === 'antigravity' ? { response: success() }
      : { choices: [{ finish_reason: 'stop', message: { images: [{ image_url: { url: `data:image/png;base64,${PNG}` } }] } }] }
    h.respond({ status: 200, body: reply })
    const result = await h.call()
    expect(result.isError).toBe(false)
    expect(toolImageReferences(result.meta)).toHaveLength(1)
    expect(JSON.stringify(result)).not.toContain(PNG)
    for (const body of [
      { choices: [{ finish_reason: 'length', message: { images: [{ image_url: { url: `data:image/png;base64,${PNG}` } }] } }] },
      { choices: [{ finish_reason: 'stop', message: { images: [{ image_url: { url: 'https://fixture.test/image.png' } }] } }] },
      { response: { candidates: [{ finishReason: 'SAFETY' }] } },
    ]) {
      h.respond({ status: 200, body })
      expect((await h.call()).isError).toBe(true)
    }
    expect(h.requests).toHaveLength(4)
  })
  it.each(['gemini', 'openai'] as const)('uses the selected %s provider without standalone credentials', async (provider) => {
    const h = await harness(provider === 'gemini' ? { provider } : {}, false)
    const calls: MediaGenerationOptions[] = []
    h.ctx.provide('llm', { generateMedia: (request: MediaGenerationOptions) => {
      calls.push(request)
      return Promise.resolve({ provider, model: 'selected-image', response: Response.json(provider === 'gemini' ? success() : { data: [{ b64_json: PNG }] }) })
    } } as never)
    const result = await h.call()
    expect(result.isError).toBe(false)
    expect(result.meta).toMatchObject({ provider, model: 'selected-image' })
    expect(calls).toMatchObject([{ ...provider === 'gemini' ? { provider } : {}, endpoint: 'images/generations', body: { prompt: 'A tiny test image', n: 1 } }])
    expect(h.requests).toEqual([])
  })
  it('refuses a selected provider with no image models and permits explicit standalone use', async () => {
    const missing = await harness({ provider: 'missing' })
    expect((await missing.call()).isError).toBe(true)
    expect(missing.requests).toEqual([])
    const standalone = await harness({ useProviderModels: false })
    expect((await standalone.call()).isError).toBe(false)
    expect(standalone.requests).toHaveLength(1)
  })
  it('saves final images in order and excludes thought images, text, and signatures', async () => {
    const h = await harness()
    h.respond({ status: 200, body: success([
      { thought: true, inlineData: { mimeType: 'image/png', data: 'invalid thought pixels' } },
      { text: 'provider-private-text' }, { ...image, thoughtSignature: 'provider-private-signature' }, image,
    ]) })
    const result = await h.call()
    expect(result.isError).toBe(false)
    expect(h.requests).toEqual([{
      url: '/v1/models/gemini-3.1-flash-image:generateContent', key: 'fixture-only-key',
      body: { contents: [{ role: 'user', parts: [{ text: 'A tiny test image' }] }], generationConfig: { responseModalities: ['IMAGE'] } },
    }])
    const images = toolImageReferences(result.meta)
    expect(images.map(image => image.name)).toEqual(['generated-1.png', 'generated-2.png'])
    for (const ref of images) expect((await h.ctx.attachments.readImage(ref)).data).toEqual(new Uint8Array(Buffer.from(PNG, 'base64')))
    expect(result.content).toEqual([{ type: 'text', text: 'Generated 2 image(s) with Google (gemini-3.1-flash-image).\nImage attachments: '
      + JSON.stringify(images.map(({ attachmentId, mediaType, width, height }) => ({ attachmentId, mediaType, width, height }))) }])
    expect(JSON.stringify(result)).not.toMatch(/provider-private|fixture-only-key|inlineData/)
    const tool = h.ctx.tools.get('image_generate_google')!
    expect(tool.presentCall?.({ prompt: 'test' })).toMatchObject({ card: 'media', kind: 'image', title: 'Generate image with Google', prompt: 'test' })
    expect(tool.presentResult?.({ prompt: 'test' }, result)).toMatchObject({ card: 'media', kind: 'image', model: 'gemini-3.1-flash-image', content: images.map(attachment => ({ type: 'image', attachment })) })
    expect(tool.presentResult?.({ prompt: 'test' }, { content: [], isError: true })).toBeUndefined()
    await h.fiber.dispose()
    expect(h.ctx.tools.get('image_generate_google')).toBeUndefined()
  })

  it('uses the configured model and re-resolves credentials for each call', async () => {
    const h = await harness({ model: 'gemini-3-pro-image' })
    await h.call()
    await h.ctx.credentials.set(credentialRef('HYDRA_GOOGLE_IMAGE_TEST_KEY'), 'rotated-fixture-key')
    await h.call()
    expect(h.requests[0]?.url).toBe('/v1/models/gemini-3-pro-image:generateContent')
    expect(h.requests[1]?.key).toBe('rotated-fixture-key')
  })

  it('refuses missing credentials, invalid prompts, and nested calls before billing', async () => {
    const h = await harness({ maxPromptChars: 8 }, false)
    for (const args of [{ prompt: 'valid' }, { prompt: '' }, { prompt: '   ' }, { prompt: 'too long prompt' }, {}]) {
      expect((await h.call(args)).isError).toBe(true)
    }
    expect((await h.call({ prompt: 'valid' }, undefined, Symbol('parent') as ToolExecutionToken)).isError).toBe(true)
    expect(h.requests).toEqual([])
  })

  it('does not retry or expose provider error bodies and keys', async () => {
    const h = await harness()
    h.respond({ status: 429, body: { error: 'fixture-only-key private-provider-error' } })
    const result = await h.call()
    expect(JSON.stringify(result)).toContain('HTTP 429')
    expect(JSON.stringify(result)).not.toMatch(/fixture-only-key|private-provider-error/)
    expect(result.meta).toBeUndefined()
    expect(h.requests).toHaveLength(1)
  })

  it('rejects blocked, incomplete, text-only, oversized, and malformed responses without publishing images', async () => {
    const h = await harness({ maxImages: 1, maxResponseBytes: 1024 })
    for (const body of [{ promptFeedback: { blockReason: 'SAFETY' } }, { candidates: [] },
      { candidates: [{ finishReason: 'SAFETY' }] }, { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [image] } }] },
      { candidates: [{ finishReason: 'STOP' }] }, success([]), success([{ text: 'private text-only reply' }]),
      success([{ ...image, thought: true }]), success([image, image]), success([{ inlineData: {} }]),
      success([{ inlineData: { mimeType: 'image/png', data: 'not base64!' } }]),
      success([{ inlineData: { mimeType: 'image/png', data: Buffer.from('not a raster').toString('base64') } }]),
      success([{ inlineData: { mimeType: 'image/jpeg', data: PNG } }]), success([{ inlineData: { mimeType: 'text/plain', data: PNG } }]),
      { ...success(), padding: 'x'.repeat(1024) }]) {
      h.respond({ status: 200, body })
      const result = await h.call()
      expect(result.isError, JSON.stringify(body)).toBe(true)
      expect(result.meta).toBeUndefined()
      expect(JSON.stringify(result)).not.toContain('private text-only reply')
    }
    h.respond({ status: 200, body: null, raw: 'not JSON' })
    expect((await h.call()).isError).toBe(true)
  })

  it('cancels pending HTTP work and bounds the deadline without retrying', async () => {
    const h = await harness({ timeoutMs: 150 })
    h.respond({ status: 200, body: null, hang: true })
    const controller = new AbortController()
    const pending = h.call(undefined, controller.signal)
    await expect.poll(() => h.requests.length, { interval: 5 }).toBe(1)
    controller.abort(new Error('image cancelled'))
    expect((await pending).isError).toBe(true)
    expect((await h.call()).isError).toBe(true)
    expect(h.requests).toHaveLength(2)
  })

  it.each([{ timeoutMs: 0 }, { maxResponseBytes: -1 }, { maxPromptChars: 0.5 }, { maxImages: 0 }, { model: '' },
    { model: '../secret?key=value' }, { baseURL: 'http://example.com/v1' }, { baseURL: 'https://key@example.com/v1' },
    { baseURL: 'https://example.com/v1?q=1' }, { apiKeyEnv: 'bad-key' }])('rejects invalid deployment configuration %j', async (config) => {
    await expect(harness(config)).rejects.toThrow()
  })

  it('releases invariant ownership on companion disposal', async () => {
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    await ctx.plugin(Invariants)
    const fiber = await ctx.plugin(Companion)
    await fiber.dispose()
    expect(() => ctx.invariants.register('@hydraharness/harness-tool-media', () => {})).not.toThrow()
  })
})

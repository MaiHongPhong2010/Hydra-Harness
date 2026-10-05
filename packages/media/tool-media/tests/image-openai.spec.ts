/** Real HTTP generation, credential resolution, attachment admission, and tool lifecycle. */
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
import * as ImageTool from '../src/image-openai.ts'
import * as MediaTool from '../src/index.ts'
import Invariants from '@hydraharness/harness-invariants'
import * as Companion from '../src/invariant.ts'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })

async function harness(config: ImageTool.OpenAIImageConfig = {}, credential = true) {
  const home = await mkdtemp(join(tmpdir(), 'hydra-image-openai-'))
  cleanups.push(() => rm(home, { recursive: true, force: true }))
  const requests: Array<{ url: string; authorization: string | undefined; body: unknown }> = []
  let response: { status: number; body: unknown; hang?: boolean; raw?: string } = { status: 200, body: { data: [{ b64_json: PNG }] } }
  const server = createServer((request, reply) => { void (async () => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array))
    requests.push({ url: request.url!, authorization: request.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString()) })
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
  if (credential) await ctx.credentials.set(credentialRef('HYDRA_IMAGE_TEST_KEY'), 'test-only-key')
  const fiber = await ctx.plugin(MediaTool, { openai: Object.assign({ baseURL: `http://127.0.0.1:${address.port}/v1`, apiKeyEnv: 'HYDRA_IMAGE_TEST_KEY' }, config) })
  return {
    ctx, fiber, requests,
    respond: (next: typeof response) => { response = next },
    call: (args: unknown = { prompt: 'A tiny test image' }, signal = new AbortController().signal, parent?: ToolExecutionToken) =>
      ctx.tools.execute({ name: 'image_generate', callId: CallId('image-test'), arguments: args, signal, ...parent === undefined ? {} : { parent } }),
  }
}

describe('OpenAI image tool', () => {
  it.each(['antigravity', 'chat-completions'] as const)('admits final %s images and rejects incomplete or remote-only output', async (format) => {
    const h = await harness()
    const reply = format === 'antigravity'
      ? { response: { candidates: [{ finishReason: 'STOP', content: { parts: [{ inlineData: { mimeType: 'image/png', data: PNG } }] } }] } }
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
  it('releases invariant ownership when its companion is disposed', async () => {
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    await ctx.plugin(Invariants)
    const fiber = await ctx.plugin(Companion)
    await fiber.dispose()
    expect(() => ctx.invariants.register('@hydraharness/harness-tool-media', () => {})).not.toThrow()
  })
  it('saves ordered images and presents them without putting pixels in model content', async () => {
    const h = await harness()
    h.respond({ status: 200, body: { data: [{ b64_json: PNG }, { b64_json: PNG }] } })
    const result = await h.call({ prompt: 'A tiny test image', count: 2, size: '1024x1024', quality: 'low', format: 'png', background: 'transparent' })
    expect(result.isError).toBe(false)
    expect(h.requests).toEqual([{
      url: '/v1/images/generations', authorization: 'Bearer test-only-key',
      body: { model: 'gpt-image-1.5', prompt: 'A tiny test image', n: 2, size: '1024x1024', quality: 'low', output_format: 'png', background: 'transparent' },
    }])
    const images = toolImageReferences(result.meta)
    expect(images.map(image => image.name)).toEqual(['generated-1.png', 'generated-2.png'])
    for (const image of images) expect((await h.ctx.attachments.readImage(image)).data).toEqual(new Uint8Array(Buffer.from(PNG, 'base64')))
    expect(result.content).toEqual([{ type: 'text', text: 'Generated 2 image(s) with OpenAI (gpt-image-1.5).\nImage attachments: '
      + JSON.stringify(images.map(({ attachmentId, mediaType, width, height }) => ({ attachmentId, mediaType, width, height }))) }])
    const tool = h.ctx.tools.get('image_generate')!
    expect(tool.presentCall?.({ prompt: 'A tiny test image' })).toMatchObject({ card: 'media', kind: 'image', prompt: 'A tiny test image' })
    for (const [size, aspectRatio] of [['1024x1024', 1], ['1536x1024', 1.5], ['1024x1536', 2 / 3]] as const) {
      expect(tool.presentCall?.({ prompt: 'test', size })).toMatchObject({ aspectRatio })
    }
    expect(tool.presentCall?.({ prompt: 'test', size: 'auto' })).not.toHaveProperty('aspectRatio')
    expect(tool.presentResult?.({ prompt: 'test' }, result)).toMatchObject({ card: 'media', kind: 'image', model: 'gpt-image-1.5', content: images.map(attachment => ({ type: 'image', attachment })) })
    expect(tool.presentResult?.({ prompt: 'test' }, { content: [], isError: true })).toBeUndefined()
    await h.fiber.dispose()
    expect(h.ctx.tools.get('image_generate')).toBeUndefined()
  })

  it('resolves omitted request fields and rotated credentials for the next call', async () => {
    const h = await harness()
    await h.call()
    await h.ctx.credentials.set(credentialRef('HYDRA_IMAGE_TEST_KEY'), 'rotated-test-key')
    await h.call()
    expect(h.requests[0]?.body).toEqual({ model: 'gpt-image-1.5', prompt: 'A tiny test image', n: 1, size: 'auto', quality: 'auto', output_format: 'png', background: 'auto' })
    expect(h.requests[1]?.authorization).toBe('Bearer rotated-test-key')
  })

  it('refuses missing credentials, invalid arguments, and unsupported nested presentation before billing', async () => {
    const h = await harness({ maxPromptChars: 8 }, false)
    expect((await h.call({ prompt: 'valid' })).isError).toBe(true)
    for (const args of [{ prompt: '' }, { prompt: '   ' }, { prompt: 'too long prompt' }, { prompt: 'valid', count: 0 },
      { prompt: 'valid', count: 5 }, { prompt: 'valid', format: 'jpeg', background: 'transparent' }]) {
      expect((await h.call(args)).isError).toBe(true)
    }
    expect((await h.call({ prompt: 'valid' }, undefined, Symbol('parent') as ToolExecutionToken)).isError).toBe(true)
    expect(h.requests).toEqual([])
  })

  it('does not retry or expose provider error bodies', async () => {
    const h = await harness()
    h.respond({ status: 429, body: { error: 'test-only-key provider-secret-body' } })
    const result = await h.call()
    expect(JSON.stringify(result)).toContain('HTTP 429')
    expect(JSON.stringify(result)).not.toContain('provider-secret-body')
    expect(JSON.stringify(result)).not.toContain('test-only-key')
    expect(h.requests).toHaveLength(1)
  })

  it('tries each standalone fallback once after rejection and stops on ambiguous failures', async () => {
    const h = await harness({ useProviderModels: false, fallbackModels: ['gpt-image-1.5', 'gpt-image-2', 'gpt-image-2'] })
    h.respond({ status: 404, body: { error: 'missing-model-secret-body' } })
    const result = await h.call()
    expect(result.isError).toBe(true)
    expect(h.requests.map(request => (request.body as { model: string }).model)).toEqual(['gpt-image-1.5', 'gpt-image-2'])
    expect(JSON.stringify(result)).not.toContain('missing-model-secret-body')
    h.respond({ status: 503, body: {} })
    await h.call()
    expect(h.requests).toHaveLength(3)
  })

  it('refuses a named provider without image models before issuing a standalone request', async () => {
    const h = await harness({ provider: 'missing' })
    expect((await h.call()).isError).toBe(true)
    expect(h.requests).toHaveLength(0)
  })

  it.each([undefined, 'images'])('presents the selected provider model for %s without standalone credentials', async (provider) => {
    const h = await harness({ ...provider === undefined ? {} : { provider } }, false)
    const calls: MediaGenerationOptions[] = []
    h.ctx.provide('llm', {
      generateMedia: (request: MediaGenerationOptions) => {
        calls.push(request)
        return Promise.resolve({ provider: 'images', model: 'gpt-image-2', response: Response.json({ data: [{ b64_json: PNG }] }) })
      },
    } as never)
    const result = await h.call()
    expect(result.isError).toBe(false)
    expect(calls).toMatchObject([{ ...provider === undefined ? {} : { provider }, model: 'gpt-image-1.5', endpoint: 'images/generations' }])
    expect(result.meta).toMatchObject({ kind: 'tool-images', provider: 'images', model: 'gpt-image-2' })
    expect((await h.ctx.attachments.readImage(toolImageReferences(result.meta)[0]!)).data).toEqual(new Uint8Array(Buffer.from(PNG, 'base64')))
    expect(h.requests).toEqual([])
  })

  it('rejects malformed, oversized, mismatched, and invalid raster batches without publishing references', async () => {
    const h = await harness({ maxResponseBytes: 1024 })
    for (const body of [{ data: [] }, { data: [{}] }, { data: [{ b64_json: 'not base64!' }] },
      { data: [{ b64_json: Buffer.from('not a raster').toString('base64') }] },
      { data: [{ b64_json: PNG }], padding: 'x'.repeat(1024) }]) {
      h.respond({ status: 200, body })
      const result = await h.call()
      expect(result.isError).toBe(true)
      expect(result.meta).toBeUndefined()
    }
    h.respond({ status: 200, body: null, raw: 'not JSON' })
    expect((await h.call()).isError).toBe(true)
  })

  it('admits final Gemini images with their actual format through a selected provider', async () => {
    const h = await harness({ provider: 'gemini' }, false)
    h.ctx.provide('llm', { generateMedia: () => Promise.resolve({
      provider: 'gemini', model: 'gemini-3.1-flash-image', response: Response.json({ candidates: [{
        finishReason: 'STOP', content: { parts: [{ text: 'Done' }, { thought: true, inlineData: { mimeType: 'image/png', data: PNG } }, { inlineData: { mimeType: 'image/png', data: PNG } }] },
      }] }),
    }) } as never)
    const result = await h.call({ prompt: 'A tree', format: 'jpeg' })
    expect(result.isError).toBe(false)
    expect(JSON.stringify(result.content)).toContain('Generated 1 image(s) with gemini (gemini-3.1-flash-image).')
    expect(JSON.stringify(result.content)).toContain(toolImageReferences(result.meta)[0]?.attachmentId)
    expect(toolImageReferences(result.meta)).toMatchObject([{ mediaType: 'image/png', name: 'generated-1.png' }])
    expect(h.requests).toEqual([])
  })

  it('aborts a pending HTTP request and applies the configured deadline without retrying', async () => {
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

  it.each([{ timeoutMs: 0 }, { maxResponseBytes: -1 }, { maxPromptChars: 0.5 }, { maxImages: 11 }, { model: '' },
    { baseURL: 'http://example.com/v1' }, { baseURL: 'https://key@example.com/v1' }, { baseURL: 'https://example.com/v1?q=1' },
    { apiKeyEnv: 'bad-key' }, { fallbackModels: [''] }])('rejects invalid deployment configuration %j', async (config) => {
    await expect(harness(config)).rejects.toThrow()
  })
})

/** Kiro event-stream framing, tool history, cancellation, and native catalog requests. */
import { afterEach, expect, it, vi } from 'vitest'
import { EventStreamCodec } from '@smithy/core/event-streams'
import { Context } from '@hydraharness/cordis'
import { CallId, createUserMessage, createAssistantMessage, createToolResultMessage, type GenerateOptions, type StreamChunk } from '@hydraharness/harness-llm'
import { MemoryCredentials } from '../../../credentials/authorization/tests/memory.ts'
import { accountRecordKey, createAccountPool } from '../src/accounts.ts'
import { KiroAccountAdapter, buildKiroRequest } from '../src/kiro.ts'

const contexts: Context[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

const codec = new EventStreamCodec((value: Uint8Array) => new TextDecoder().decode(value), value => new TextEncoder().encode(value))
function frame(type: string, payload: object, messageType = 'event'): Uint8Array {
  return codec.encode({ headers: {
    ':event-type': { type: 'string', value: type }, ':message-type': { type: 'string', value: messageType },
  }, body: new TextEncoder().encode(JSON.stringify(payload)) })
}
function reply(...frames: Uint8Array[]): Response {
  return new Response(Buffer.concat(frames), { headers: { 'Content-Type': 'application/vnd.amazon.eventstream' } })
}
async function adapter(profile: ConstructorParameters<typeof KiroAccountAdapter>[1] = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(MemoryCredentials)
  const pool = createAccountPool({ ctx, key: accountRecordKey('kiro'), providerId: 'kiro', providerLabel: 'Kiro' })
  await pool.add('One', { type: 'oauth', access: 'first', refresh: 'refresh', expires: Date.now() + 60_000 })
  await pool.add('Two', { type: 'oauth', access: 'second', refresh: 'refresh2', expires: Date.now() + 60_000 })
  return { pool, adapter: new KiroAccountAdapter(pool, profile) }
}
const user = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
const options = (): GenerateOptions => ({ provider: 'kiro', model: 'claude-sonnet-4.5', messages: [user('A tree')] })
async function collect(source: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of source) chunks.push(chunk)
  return chunks
}

it('projects split AWS frames and streamed tool arguments into durable blocks', async () => {
  const h = await adapter()
  const bytes = Buffer.concat([
    frame('assistantResponseEvent', { content: '' }), frame('assistantResponseEvent', { content: 'Creating ' }), frame('assistantResponseEvent', { content: 'a tree.' }),
    frame('toolUseEvent', { toolUseId: 'call-tree', name: 'image', input: '{"prompt":' }), frame('toolUseEvent', { toolUseId: 'call-tree', input: '"A tree"}', stop: true }),
  ])
  const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer first')
    return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(bytes.subarray(0, 7))
      controller.enqueue(bytes.subarray(7, 37))
      controller.enqueue(bytes.subarray(37))
      controller.close()
    } }))
  })
  vi.stubGlobal('fetch', fetcher)
  const chunks = await collect(h.adapter.stream(options()))
  expect(chunks.filter(chunk => chunk.type === 'block-start')).toHaveLength(2)
  expect(chunks.filter(chunk => chunk.type === 'block-end')).toEqual([
    { type: 'block-end', index: 0, block: { type: 'text', text: 'Creating a tree.' } },
    { type: 'block-end', index: 1, block: { type: 'tool-call', id: CallId('call-tree'), name: 'image', arguments: '{"prompt":"A tree"}' } },
  ])
  expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
  expect(fetcher).toHaveBeenCalledOnce()
})

it('maps logged system text, tools, calls, and tool results without invented assistant messages', () => {
  const tools = [{ name: 'image', description: 'Create an image', parameters: { type: 'object', properties: { prompt: { type: 'string' } } } }]
  expect(buildKiroRequest({ ...options(), tools })).toMatchObject({ conversationState: {
    currentMessage: { userInputMessage: { userInputMessageContext: { tools: [{ toolSpecification: { name: 'image' } }] } } },
  } })
  const request = buildKiroRequest({ ...options(), system: 'Follow the user.', messages: [
    user('A tree'),
    createAssistantMessage({ content: [{ type: 'tool-call', id: CallId('image-1'), name: 'image', arguments: '{"prompt":"A tree"}' }], source: { provider: 'kiro', model: 'claude-sonnet-4.5' } }),
    createToolResultMessage({ callId: CallId('image-1'), content: [{ type: 'text', text: 'Created tree.png' }], isError: false }),
  ], tools })
  expect(request).toMatchObject({ conversationState: {
    history: [ { userInputMessage: { content: 'Follow the user.\n\nA tree' } }, { assistantResponseMessage: { content: '', toolUses: [{ toolUseId: 'image-1', name: 'image', input: { prompt: 'A tree' } }] } } ],
    currentMessage: { userInputMessage: { content: ' ', userInputMessageContext: {
      tools: [{ toolSpecification: { name: 'image' } }], toolResults: [{ toolUseId: 'image-1', content: [{ text: 'Created tree.png' }], status: 'success' }],
    } } },
  } })
  expect(JSON.stringify(request)).not.toContain('I will follow')
})

it('rotates accounts before output and stops retrying after visible text', async () => {
  const h = await adapter()
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, { status: 401 }))
    .mockResolvedValueOnce(reply(frame('assistantResponseEvent', { content: 'Second account' })))
  vi.stubGlobal('fetch', fetcher)
  expect((await collect(h.adapter.stream(options()))).at(-1)).toMatchObject({ reason: { kind: 'stop' } })
  expect(fetcher).toHaveBeenCalledTimes(2)
  fetcher.mockClear().mockResolvedValue(reply(frame('assistantResponseEvent', { content: 'Partial' }), frame('errorEvent', {}, 'exception')))
  await expect(collect(h.adapter.stream(options()))).rejects.toMatchObject({ code: 'TRANSPORT' })
  expect(fetcher).toHaveBeenCalledOnce()
})

it.each([
  ['partial frame', () => new Response(Buffer.from(frame('assistantResponseEvent', { content: 'Tree' }).subarray(0, 8))), 'MALFORMED_RESPONSE'],
  ['invalid frame length', () => new Response(Uint8Array.of(255, 255, 255, 255)), 'MALFORMED_RESPONSE'],
  ['empty output', () => reply(frame('meteringEvent', { credits: 1 })), 'EMPTY_RESPONSE'],
  ['incomplete tool arguments', () => reply(frame('toolUseEvent', { toolUseId: 'call', name: 'image', input: '{' })), 'MALFORMED_RESPONSE'],
] as const)('rejects %s', async (_label, response, code) => {
  const h = await adapter()
  vi.stubGlobal('fetch', vi.fn(async () => response()))
  await expect(collect(h.adapter.stream(options()))).rejects.toMatchObject({ code })
})

it('cancels the response reader when the stream consumer stops', async () => {
  const h = await adapter()
  const canceled = vi.fn()
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(frame('assistantResponseEvent', { content: 'Tree' }))
  }, cancel: canceled }))))
  const iterator = h.adapter.stream(options())
  await iterator.next()
  await iterator.return(undefined)
  expect(canceled).toHaveBeenCalledOnce()
})

it('times out a stalled stream and rejects unsupported request controls before HTTP', async () => {
  const h = await adapter({ streamIdleTimeoutMs: 10 })
  const fetcher = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ start() {} })))
  vi.stubGlobal('fetch', fetcher)
  await expect(collect(h.adapter.stream({ ...options(), maxTokens: 100 }))).rejects.toMatchObject({ code: 'UNSUPPORTED_OPTION' })
  expect(fetcher).not.toHaveBeenCalled()
  await expect(collect(h.adapter.stream(options()))).rejects.toMatchObject({ code: 'TIMEOUT' })
})

it('fetches every Kiro catalog page with its real route spelling and profile', async () => {
  const h = await adapter({ profileArn: 'arn:aws:codewhisperer:us-east-1:123456789012:profile/test', models: [{ id: 'custom', contextWindow: 64000 }] })
  const calls: URL[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: URL) => {
    calls.push(new URL(url.href))
    return calls.length === 1 ? Response.json({ models: [{ modelId: 'claude-sonnet-4.5', modelName: 'Sonnet' }], nextToken: 'page2' })
      : Response.json({ models: [{ modelId: 'kimi-k2.5', modelName: 'Kimi' }] })
  }))
  expect(await h.adapter.discoverModels()).toEqual([{ id: 'claude-sonnet-4.5', name: 'Sonnet' }, { id: 'kimi-k2.5', name: 'Kimi' }])
  expect(calls[0]!.origin + calls[0]!.pathname).toBe('https://q.us-east-1.amazonaws.com/ListAvailableModels')
  expect(calls[1]!.searchParams.get('nextToken')).toBe('page2')
  expect(calls[0]!.searchParams.get('profileArn')).toContain('profile/test')
  expect(await h.adapter.resolveModel('kiro', 'custom')).toMatchObject({ context: { contextWindow: 64000 } })
  expect(await h.adapter.listModels('kiro')).toMatchObject([{ id: 'custom', inputModalities: ['text'] }])
})

it('propagates generation classification and rejects unsupported transport before HTTP', async () => {
  const h = await adapter({ models: [{ id: 'alias', endpoints: ['images/generations', 'videos'] }] })
  const fetcher = vi.fn()
  vi.stubGlobal('fetch', fetcher)
  expect(await h.adapter.listModels('kiro')).toMatchObject([{ id: 'alias', endpoints: ['images/generations', 'videos'] }])
  expect(await h.adapter.resolveModel('kiro', 'alias')).toMatchObject({ endpoints: ['images/generations', 'videos'] })
  await expect(collect(h.adapter.stream({ ...options(), model: 'alias' }))).rejects.toMatchObject({ code: 'UNSUPPORTED_MODEL_ENDPOINT' })
  await expect(h.adapter.requestGeneration({
    endpoint: 'images/generations', provider: 'kiro', model: 'alias', body: { prompt: 'A tree' },
    maxResponseBytes: 1024, signal: new AbortController().signal,
  }))
    .rejects.toMatchObject({ code: 'UNSUPPORTED_GENERATION' })
  expect(fetcher).not.toHaveBeenCalled()
})

it('exposes configured and fallback text models without inventing context capacities', async () => {
  const fallback = await adapter()
  expect(fallback.adapter.providerInfo('kiro')).toEqual({ id: 'kiro', name: 'Kiro' })
  expect(await fallback.adapter.listModels('kiro')).toMatchObject([{ id: 'auto', name: 'Auto', inputModalities: ['text'] }])
  expect(await fallback.adapter.resolveModel('kiro', 'auto')).toMatchObject({ context: { contextWindow: 131072 } })
  const configured = await adapter({ defaultContextWindow: 64000, models: [{ id: 'custom', name: 'Custom' }] })
  expect(await configured.adapter.listModels('kiro')).toMatchObject([{ id: 'custom', name: 'Custom' }])
  expect(await configured.adapter.resolveModel('kiro', 'custom')).toMatchObject({ name: 'Custom', context: { contextWindow: 64000 } })
})

it('serializes plain assistant history and error results and refuses missing current input', () => {
  expect(() => buildKiroRequest({ ...options(), messages: [] })).toThrow('current user message')
  const request = buildKiroRequest({ ...options(), messages: [
    createAssistantMessage({ content: [{ type: 'text', text: 'Previous response' }], source: { provider: 'kiro', model: 'auto' } }),
    createToolResultMessage({ callId: CallId('failed-call'), content: [{ type: 'text', text: 'Failed' }], isError: true }),
  ], tools: [] })
  expect(request).toMatchObject({ conversationState: { history: [{ assistantResponseMessage: { content: 'Previous response' } }],
    currentMessage: { userInputMessage: { userInputMessageContext: { toolResults: [{ status: 'error' }] } } } } })
  expect(() => buildKiroRequest({ ...options(), messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'image',
    attachment: { attachmentId: 'image' as never, mediaType: 'image/png', width: 1, height: 1, bytes: 1 } }] })] })).toThrow('does not accept image')
})

it('uses a configured regional endpoint and a granted profile for generation and discovery', async () => {
  const h = await adapter({ endpoint: 'http://127.0.0.1:9999', timeoutMs: 1000 })
  const account = (await h.pool.accounts.list())[0]!
  await h.pool.withAccount(account.id, () => h.pool.credentials.modify('kiro', async current => ({ ...current!, profileArn: 'arn:granted:profile' })))
  vi.stubGlobal('fetch', vi.fn(async (url: URL | string, init: RequestInit) => {
    if (typeof url === 'string') {
      expect(url).toBe('http://127.0.0.1:9999/generateAssistantResponse')
      expect(JSON.parse(init.body as string)).toMatchObject({ profileArn: 'arn:granted:profile' })
      return reply(frame('assistantResponseEvent', { content: 'Tree' }))
    }
    expect(url.searchParams.get('profileArn')).toBe('arn:granted:profile')
    return Response.json({ models: [{ modelId: 'custom' }], nextToken: '' })
  }))
  const signal = new AbortController().signal
  expect(await h.adapter.discoverModels(signal)).toEqual([{ id: 'custom' }])
  expect((await collect(h.adapter.stream({ ...options(), signal }))).at(-1)).toMatchObject({ reason: { kind: 'stop' } })
})

it('rejects a remote plaintext endpoint before sending account credentials', async () => {
  const h = await adapter({ endpoint: 'http://remote.test' })
  const fetcher = vi.fn()
  vi.stubGlobal('fetch', fetcher)
  await expect(h.adapter.discoverModels()).rejects.toMatchObject({ code: 'INVALID_ENDPOINT' })
  await expect(collect(h.adapter.stream(options()))).rejects.toMatchObject({ code: 'INVALID_ENDPOINT' })
  expect(fetcher).not.toHaveBeenCalled()
})

it('rejects catalog requests after every connected account is removed', async () => {
  const h = await adapter()
  for (const account of await h.pool.accounts.list()) await h.pool.accounts.remove(account.id)
  await expect(h.adapter.discoverModels()).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
})

it.each([
  [() => new Response('private provider body', { status: 403 }), 'DISCOVERY_FAILED'],
  [() => Response.json({}), 'DISCOVERY_FAILED'],
  [() => Response.json({ models: [null] }), 'MALFORMED_RESPONSE'],
  [() => Response.json({ models: [{ modelId: '' }] }), 'DISCOVERY_FAILED'],
  [() => Response.json({ models: [], nextToken: 5 }), 'DISCOVERY_FAILED'],
  [() => Response.json({ models: [], nextToken: 'repeat' }), 'DISCOVERY_FAILED'],
] as const)('rejects invalid or repeating Kiro catalog replies %#', async (response, code) => {
  const h = await adapter()
  vi.stubGlobal('fetch', vi.fn(async () => response()))
  await expect(h.adapter.discoverModels()).rejects.toMatchObject({ code })
})

it.each([
  ['empty body', () => new Response(null)],
  ['missing event type', () => reply(codec.encode({ headers: {}, body: new TextEncoder().encode('{}') }))],
  ['invalid JSON', () => reply(codec.encode({ headers: { ':event-type': { type: 'string', value: 'assistantResponseEvent' } }, body: new TextEncoder().encode('{') }))],
  ['non-object event', () => reply(frame('assistantResponseEvent', []))],
  ['invalid text', () => reply(frame('assistantResponseEvent', { content: 1 }))],
  ['invalid tool id', () => reply(frame('toolUseEvent', { toolUseId: '', name: 'image' }))],
  ['invalid tool name', () => reply(frame('toolUseEvent', { toolUseId: 'call', name: '' }))],
  ['non-object tool input', () => reply(frame('toolUseEvent', { toolUseId: 'call', name: 'image', input: [] }))],
  ['non-object tool JSON', () => reply(frame('toolUseEvent', { toolUseId: 'call', name: 'image', input: '[]' }))],
] as const)('rejects malformed Kiro stream %s', async (_label, response) => {
  const h = await adapter()
  vi.stubGlobal('fetch', vi.fn(async () => response()))
  await expect(collect(h.adapter.stream(options()))).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
})

it('accepts native object tool arguments and defaults an omitted tool input to an empty object', async () => {
  const h = await adapter()
  vi.stubGlobal('fetch', vi.fn(async () => reply(
    frame('toolUseEvent', { toolUseId: 'call-one', name: 'image', input: { prompt: 'Tree' } }),
    frame('toolUseEvent', { toolUseId: 'call-two', name: 'status' }),
  )))
  const chunks = await collect(h.adapter.stream(options()))
  expect(chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block)).toEqual([
    { type: 'tool-call', id: CallId('call-one'), name: 'image', arguments: '{"prompt":"Tree"}' },
    { type: 'tool-call', id: CallId('call-two'), name: 'status', arguments: '{}' },
  ])
})

it('preserves provider read failures when canceling an errored stream', async () => {
  const h = await adapter()
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ pull(controller) { controller.error(new Error('lost stream')) } }))))
  await expect(collect(h.adapter.stream(options()))).rejects.toThrow('lost stream')
})

it('aborts a stalled response when native cancellation rejects', async () => {
  const h = await adapter({ streamIdleTimeoutMs: 10 })
  const canceled = vi.fn(async () => { throw new Error('provider already disconnected') })
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ cancel: canceled }))))
  await expect(collect(h.adapter.stream(options()))).rejects.toMatchObject({ code: 'TIMEOUT' })
  expect(canceled).toHaveBeenCalled()
})

it('treats an empty endpoint selection as an unrestricted Kiro conversation model', async () => {
  const h = await adapter({ models: [{ id: options().model, endpoints: [] }] })
  vi.stubGlobal('fetch', vi.fn(async () => reply(frame('assistantResponseEvent', { content: 'Hello' }))))
  expect((await collect(h.adapter.stream(options()))).at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
})

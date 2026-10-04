import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AttachmentStore } from '@hydraharness/harness-attachment'
import { CallId, MessageId, ReasoningEffortId, errorChain } from '@hydraharness/harness-llm'
import type { ContentBlock, GenerateOptions, Message } from '@hydraharness/harness-llm'
import { SessionId } from '@hydraharness/harness-session'
import {
  AntigravityAdapter,
  buildAntigravityRequest,
  discoverAntigravityModels,
  parseAntigravitySse,
  serializeAntigravityMessages,
  streamAntigravity,
} from '../src/antigravity.ts'
import type { AntigravityCredentials } from '../src/antigravity-oauth.ts'

const credentials: AntigravityCredentials = {
  access: 'access-token-fixture',
  refresh: 'refresh-token-fixture',
  expires: Date.now() + 60_000,
  projectId: 'project-fixture',
  email: 'user@example.test',
}

function message(id: string, role: Message['role'], content: ContentBlock[], source: Message['source']): Message {
  return { id: MessageId(id), role, content, source }
}

function user(id: string, content: ContentBlock[]): Message {
  return message(id, 'user', content, { kind: 'user' })
}

function assistant(id: string, content: ContentBlock[], replayState?: unknown): Message {
  return message(id, 'assistant', content, {
    kind: 'model',
    provider: 'antigravity',
    model: 'gemini-test',
    ...(replayState === undefined ? {} : { replayState }),
  })
}

function options(messages: Message[], extra: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'antigravity',
    model: 'gemini-test',
    messages,
    ...extra,
  }
}

function sseBody(events: readonly string[], splitAt?: number): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(events.map(event => `data: ${event}\n\n`).join(''))
  const split = splitAt ?? Math.max(1, Math.floor(bytes.length / 2))
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.slice(0, split))
      controller.enqueue(bytes.slice(split))
      controller.close()
    },
  })
}

function sseBodyWithoutFinalBlank(event: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${event}\n`))
      controller.close()
    },
  })
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = []
  for await (const item of items) result.push(item)
  return result
}

const frame = (parts: unknown[], finishReason?: string) => ({
  candidates: [{ content: { parts }, ...finishReason === undefined ? {} : { finishReason } }],
})
const streamed = (events: unknown[], extra: Partial<GenerateOptions> = {}) => collect(streamAntigravity(
  options([user('input', [{ type: 'text', text: 'Inspect' }])], extra), credentials,
  async () => new Response(sseBody(events.map(event => typeof event === 'string' ? event : JSON.stringify(event)))),
))

describe('Antigravity history and schema variants', () => {
  it('separates system text, omits empty assistant blocks and keeps empty user turns', async () => {
    const request = await buildAntigravityRequest(options([
      message('system', 'system', [{ type: 'text', text: 'Policy' }, { type: 'reasoning', text: ' context' },
        { type: 'tool-call', id: CallId('system-call'), name: 'unused', arguments: '{}' }], { kind: 'plugin', plugin: 'test' }),
      message('empty-system', 'system', [], { kind: 'plugin', plugin: 'test' }),
      assistant('empty', [{ type: 'text', text: '' }, { type: 'reasoning', text: '' }]),
      assistant('result-only', [{ type: 'tool-result', toolCallId: CallId('ignored'), content: [], isError: false }]),
      user('empty-user', [{ type: 'text', text: '' }, { type: 'reasoning', text: 'private' }]),
    ], { system: '', tools: [] }), credentials)
    expect(request.request.systemInstruction?.parts).toEqual([{ text: 'Policy context' }])
    expect(request.request.contents).toEqual([{ role: 'user', parts: [{ text: '' }] }])
    expect(request.request.tools).toBeUndefined()
  })

  it('accepts only provider-owned valid replay signatures', async () => {
    const messages = [
      assistant('signed', [{ type: 'text', text: 'Visible' }, { type: 'reasoning', text: 'Thought' }], { blocks: [{ signature: 'YQ==' }, { thoughtSignature: 'Yg==' }] }),
      assistant('unsigned', [{ type: 'reasoning', text: 'Thought' }], { blocks: [{ thoughtSignature: 'invalid!' }] }),
      message('plugin', 'assistant', [{ type: 'text', text: 'Plugin' }], { kind: 'plugin', plugin: 'test' }),
      message('foreign', 'assistant', [{ type: 'text', text: 'Foreign' }], { kind: 'model', provider: 'other', model: 'test', replayState: { blocks: [{ signature: 'YQ==' }] } }),
      message('alias', 'assistant', [{ type: 'text', text: 'Alias' }], { kind: 'model', provider: 'google-antigravity', model: 'test', replayState: { blocks: [{ signature: 'YQ==' }] } }),
    ]
    const result = await serializeAntigravityMessages(messages, 'gemini')
    expect(result.map(turn => turn.parts)).toEqual([
      [{ text: 'Visible', thoughtSignature: 'YQ==' }, { text: 'Thought', thought: true, thoughtSignature: 'Yg==' }],
      [{ text: 'Thought', thought: true }], [{ text: 'Plugin' }], [{ text: 'Foreign' }], [{ text: 'Alias', thoughtSignature: 'YQ==' }],
    ])
  })

  it('normalizes damaged historical tool arguments and orphaned error results', async () => {
    const result = await serializeAntigravityMessages([
      assistant('calls', ['{broken', 'null'].map((arguments_, index) => ({ type: 'tool-call', id: CallId(index === 0 ? '' : 'other'), name: 'execute_code', arguments: arguments_ }))),
      user('results', [
        { type: 'tool-result', toolCallId: CallId('orphan'), isError: true, content: [] },
        { type: 'tool-result', toolCallId: CallId('other'), isError: true, content: [{ type: 'text', text: 'failed' }] },
      ]),
    ], 'claude')
    expect(result[0]?.parts.map(part => part.functionCall)).toEqual([
      { name: 'external_execute_code', id: 'call', args: {} }, { name: 'external_execute_code', id: 'other', args: {} },
    ])
    expect(result[1]?.parts.map(part => part.functionResponse)).toEqual([
      { name: 'unknown', id: 'orphan', response: { error: 'Tool execution failed' } },
      { name: 'external_execute_code', id: 'other', response: { error: 'failed' } },
    ])
  })

  it('carries nested tool images and reports attachment cancellation and read failures', async () => {
    const ref = { attachmentId: 'image' as never, mediaType: 'image/png' as const, bytes: 1, width: 1, height: 1 }
    const image: ContentBlock = { type: 'image', attachment: ref }
    const readImage = vi.fn(async () => ({ ref, data: Uint8Array.of(1) }))
    const attachments = { readImage } as unknown as AttachmentStore
    const messages = [user('result', [{ type: 'tool-result', toolCallId: CallId('image'), isError: false, content: [image] }])]
    const result = await serializeAntigravityMessages(messages, 'gemini', attachments)
    expect(result[0]?.parts[0]?.functionResponse?.parts).toEqual([{ inlineData: { mimeType: 'image/png', data: 'AQ==' } }])
    await expect(serializeAntigravityMessages(messages, 'gemini', attachments, AbortSignal.abort())).rejects.toMatchObject({ code: 'ABORTED' })
    readImage.mockRejectedValueOnce(new Error('file disappeared'))
    await expect(serializeAntigravityMessages(messages, 'gemini', attachments)).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
    const controller = new AbortController()
    readImage.mockImplementationOnce(async () => { controller.abort(); throw new Error('cancelled') })
    await expect(serializeAntigravityMessages(messages, 'gemini', attachments, controller.signal)).rejects.toMatchObject({ code: 'ABORTED' })
  })

  it('rewrites nested item schemas and refuses a missing project', async () => {
    const request = await buildAntigravityRequest(options([], { tools: [{ name: 'schema', description: '', parameters: {
      type: 'object', properties: { tuple: { items: [{ const: 'x' }, null] }, list: { items: { const: 1 } } },
    } }] }), credentials)
    expect(request.request.tools?.[0]?.functionDeclarations[0]?.parameters).toEqual({
      type: 'object', properties: { tuple: { items: [{ enum: ['x'] }, {}] }, list: { items: { enum: [1] } } },
    })
    await expect(buildAntigravityRequest(options([]), { projectId: '' })).rejects.toMatchObject({ code: 'INVALID_CREDENTIAL' })
  })
})

describe('Antigravity catalog failures', () => {
  it('ignores malformed catalog entries and accepts MIME arrays', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ models: {
      '': {}, invalid: null, vision: { supportedMimeTypes: [null, 'text/plain', 'image/png'] }, explicit: { supportsImages: true },
      text: { supportedMimeTypes: { 'text/plain': true }, maxTokens: -1 },
    } }))
    vi.stubGlobal('fetch', fetch)
    const result = await discoverAntigravityModels({ accessToken: 'token', endpoint: 'https://fixture.test/' })
    expect(result.map(model => [model.id, model.supportsImages])).toEqual([['explicit', true], ['text', false], ['vision', true]])
  })

  it('rejects a missing token, endpoint, catalog or unreadable HTTP body', async () => {
    await expect(discoverAntigravityModels({ accessToken: '' })).rejects.toMatchObject({ code: 'INVALID_CREDENTIAL' })
    await expect(discoverAntigravityModels({ accessToken: 'token', endpoint: '' })).rejects.toMatchObject({ code: 'TRANSPORT' })
    await expect(discoverAntigravityModels({ accessToken: 'token', fetch: async () => Response.json({}) })).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
    const response = new Response('unreadable', { status: 403 })
    vi.spyOn(response, 'text').mockRejectedValue(new Error('read failed'))
    await expect(discoverAntigravityModels({ accessToken: 'token', endpoint: 'https://fixture.test', fetch: async () => response })).rejects.toMatchObject({ code: 'AUTH' })
  })

  it('retries a transport failure and stops promptly on cancellation', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(Response.json({ models: {} }))
    await expect(discoverAntigravityModels({ accessToken: 'token', fetch })).resolves.toEqual([])
    expect(fetch).toHaveBeenCalledTimes(2)
    await expect(discoverAntigravityModels({ accessToken: 'token', signal: AbortSignal.abort(), fetch: async () => { throw new Error('aborted') } }))
      .rejects.toMatchObject({ code: 'ABORTED' })
  })
})

describe('Antigravity stream edge cases', () => {
  it.each([undefined, 5])('enforces the idle deadline when bytes arrive at expiry (%s)', async (streamIdleTimeoutMs) => {
    vi.useFakeTimers()
    let source: ReadableStreamDefaultController<Uint8Array> | undefined
    const body = new ReadableStream<Uint8Array>({ start(controller) { source = controller } })
    const result = collect(streamAntigravity(options([]), credentials, async () => new Response(body),
      streamIdleTimeoutMs === undefined ? {} : { streamIdleTimeoutMs }))
    const rejected = expect(result).rejects.toMatchObject({ code: 'TIMEOUT' })
    await vi.advanceTimersByTimeAsync(0)
    source!.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(frame([{ text: 'late' }]))}\n\n`))
    vi.advanceTimersByTime(streamIdleTimeoutMs ?? 300_000)
    await rejected
  })

  it.each(['MAX_TOKENS', 'LENGTH', 'SAFETY', 'RECITATION', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'IMAGE_SAFETY', 'OTHER'])(
    'preserves the provider finish reason %s', async (reason) => {
      const chunks = await streamed([frame([{ text: 'answer' }], reason), '[DONE]'])
      expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: ['MAX_TOKENS', 'LENGTH'].includes(reason) ? 'max-tokens' : 'error' } })
    },
  )

  it.each(['TOOL_CALL', 'TOOL_USE', undefined])('ends completed tools with %s', async (finish) => {
    const chunks = await streamed([frame([{ functionCall: {} }], finish)])
    expect(chunks).toContainEqual({ type: 'block-end', index: 0, block: { type: 'tool-call', id: CallId('call-0'), name: '', arguments: '{}' } })
    expect(chunks.at(-1)).toMatchObject({ reason: { kind: 'tool-calls' } })
  })

  it('updates late signatures and replaces non-prefix argument snapshots', async () => {
    const chunks = await streamed([
      frame([{ text: '' }, null, { text: 'First' }]),
      frame([{ text: ' second', thoughtSignature: 'YQ==' }]), frame([{ text: ' third', thoughtSignature: 'Yg==' }]),
      frame([{ thought: true, text: 'Reason' }]), frame([{ thought: true, text: ' more' }]),
      frame([{ functionCall: { id: 'tool', name: 'external_read_file', args: '{' } }]),
      frame([{ functionCall: { id: 'tool', args: '{"x":1}' }, thoughtSignature: 'YQ==' }]),
      frame([{ functionCall: { id: 'tool', args: '{"x":1}' } }]),
      frame([{ functionCall: { id: 'tool', args: '{"x":2}' }, thoughtSignature: 'Yg==' }]),
      frame([{ functionCall: { id: 'empty', name: 'noop', args: '' }, thoughtSignature: 'YQ==' }], 'STOP'),
    ])
    expect(chunks.filter(chunk => chunk.type === 'tool-call-delta').map(chunk => chunk.argumentsDelta)).toEqual(['{', '"x":1}', '{"x":2}'])
    expect(chunks).toContainEqual({ type: 'block-end', index: 2, block: { type: 'tool-call', id: CallId('tool'), name: 'read_file', arguments: '{"x":2}' } })
    expect(chunks.at(-1)).toMatchObject({ replayState: { blocks: [{ thoughtSignature: 'YQ==' }, {}, { thoughtSignature: 'YQ==' }, { thoughtSignature: 'YQ==' }] } })
  })

  it.each([
    [{ code: 403 }, 'AUTH'], [{ status: 429 }, 'RATE_LIMIT'], [{ status: 'RESOURCE_EXHAUSTED' }, 'QUOTA'],
    [{ code: -1, status: 'OTHER' }, 'SERVER'],
  ])('classifies provider error %j', async (error, code) => {
    await expect(streamed([{ error }])).rejects.toMatchObject({ code })
  })

  it.each([
    [401, 'denied', 'AUTH'], [429, 'slow down', 'RATE_LIMIT'], [400, 'invalid', 'INVALID_REQUEST'],
    [500, 'failed', 'SERVER'], [302, 'timeout', 'TIMEOUT'], [302, 'redirect', 'TRANSPORT'],
  ])('classifies HTTP %s without disclosing the response', async (status, body, code) => {
    await expect(collect(streamAntigravity(options([]), credentials, async () => new Response(body, { status }), { endpoint: 'https://fixture.test' })))
      .rejects.toMatchObject({ code })
  })

  it('falls back before output and classifies an unreadable final error response', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(new Response(sseBody([JSON.stringify(frame([{ text: 'ok' }], 'STOP'))])))
    expect((await collect(streamAntigravity(options([]), credentials, fetch))).at(-1)).toMatchObject({ reason: { kind: 'stop' } })
    const response = new Response('failed', { status: 404 })
    vi.spyOn(response, 'text').mockRejectedValue(new Error('unreadable'))
    await expect(collect(streamAntigravity({ ...options([]), endpoint: 'https://fixture.test/' }, credentials, async () => response)))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })

  it('rejects invalid credentials, missing bodies, malformed frames and empty streams', async () => {
    await expect(collect(streamAntigravity(options([]), { ...credentials, access: '' }))).rejects.toMatchObject({ code: 'INVALID_CREDENTIAL' })
    await expect(collect(streamAntigravity(options([]), credentials, async () => new Response(null)))).rejects.toMatchObject({ code: 'STREAM_CLOSED' })
    for (const event of ['broken JSON', 'null', '[]']) await expect(streamed([event])).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
    await expect(streamed([{}])).rejects.toMatchObject({ code: 'STREAM_CLOSED' })
    expect((await streamed([{ usageMetadata: { promptTokenCount: 1 } }])).at(-1)).toMatchObject({ reason: { kind: 'error', failure: { code: 'EMPTY_RESPONSE' } } })
    expect((await streamed([{ usageMetadata: { candidatesTokenCount: 1 } }])).at(-1)).toMatchObject({ reason: { kind: 'error' } })
    expect((await streamed([frame([], 'MAX_TOKENS')])).at(-1)).toMatchObject({ reason: { kind: 'max-tokens' } })
  })

  it('cancels a stream while the consumer holds visible output', async () => {
    const controller = new AbortController()
    const stream = streamAntigravity(options([], { signal: controller.signal }), credentials,
      async () => new Response(sseBody([JSON.stringify(frame([{ text: 'visible' }], 'STOP'))])))
    expect((await stream.next()).value).toMatchObject({ type: 'block-start' })
    controller.abort()
    await expect(collect(stream)).rejects.toMatchObject({ code: 'ABORTED' })
  })

  it('projects configured and unknown models and requires a connected account', async () => {
    const adapter = new AntigravityAdapter({ resolveCredentials: async () => undefined, models: [
      { id: 'named', name: 'Named', contextWindow: 100, maxTokens: 10 }, { id: 'plain' },
    ] })
    expect(adapter.providerInfo('alias')).toEqual({ id: 'alias', name: 'Google Antigravity' })
    expect(await adapter.listModels('alias')).toEqual([{ provider: 'alias', id: 'named', name: 'Named' }, { provider: 'alias', id: 'plain', name: 'plain' }])
    expect(await adapter.resolveModel('alias', 'named')).toMatchObject({ context: { contextWindow: 100 }, defaultMaxTokens: 10 })
    expect(await adapter.resolveModel('alias', 'missing')).toEqual({ provider: 'alias', id: 'missing', name: 'missing' })
    await expect(collect(adapter.stream(options([])))).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
    const empty = new AntigravityAdapter({ resolveCredentials: async () => credentials, resolveAttachments: () => ({}) as AttachmentStore })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(sseBody([JSON.stringify(frame([{ text: 'ok' }], 'STOP'))]))))
    expect(await empty.listModels('alias')).toEqual([])
    expect(await empty.resolveModel('alias', 'plain')).toMatchObject({ name: 'plain' })
    expect((await collect(empty.stream(options([])))).at(-1)).toMatchObject({ reason: { kind: 'stop' } })
  })
})

describe('Antigravity parser cancellation', () => {
  it('handles CRLF, comments, data without a space and repeated leading BOMs', async () => {
    const bytes = new TextEncoder().encode('\uFEFF\uFEFF: comment\r\n\r\ndata:value\r\n\r\n')
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close() } })
    expect(await collect(parseAntigravitySse(body))).toEqual(['value'])
  })

  it.each([false, true])('classifies a failed read with cancellation=%s', async (aborted) => {
    const controller = new AbortController()
    const body = new ReadableStream<Uint8Array>({ pull(source) {
      source.error(new Error('reader failed'))
      if (aborted) controller.abort()
    } })
    await expect(collect(parseAntigravitySse(body, controller.signal))).rejects.toMatchObject({ code: aborted ? 'ABORTED' : 'TRANSPORT' })
  })
})

describe('Antigravity request serialization', () => {
  it('keeps caller context, maps tool calls/results, images, and session metadata', async () => {
    const toolCall = {
      type: 'tool-call' as const,
      id: CallId('call|long-id'),
      name: 'read_file',
      arguments: '{"path":"README.md"}',
    }
    const messages = [
      user('u1', [{ type: 'text', text: 'Inspect this file.' }]),
      assistant('a1', [toolCall], {
        blocks: [{ thoughtSignature: 'YWJjZA==' }],
      }),
      user('u2', [{
        type: 'tool-result',
        toolCallId: toolCall.id,
        content: [{ type: 'text', text: 'file contents' }],
        isError: false,
      }]),
    ]

    const serialized = await serializeAntigravityMessages(messages, 'claude-test')
    expect(serialized).toEqual([
      { role: 'user', parts: [{ text: 'Inspect this file.' }] },
      {
        role: 'model',
        parts: [{
          functionCall: {
            name: 'external_read_file',
            args: { path: 'README.md' },
            id: 'call_long-id',
          },
          thoughtSignature: 'YWJjZA==',
        }],
      },
      {
        role: 'user',
        parts: [{
          functionResponse: {
            name: 'external_read_file',
            response: { output: 'file contents' },
            id: 'call_long-id',
          },
        }],
      },
    ])

    const request = await buildAntigravityRequest(options(messages, {
      system: 'Follow the project instructions.',
      sessionId: SessionId('session-fixture'),
      reasoningEffort: ReasoningEffortId('high'),
      temperature: 0.2,
      maxTokens: 200,
      stop: ['END'],
      tools: [{ name: 'read_file', description: 'Read a file', parameters: { type: 'object' } }],
    }), credentials)
    expect(request.project).toBe('project-fixture')
    expect(request.request.sessionId).toBe('session-fixture')
    expect(request.request.systemInstruction).toEqual({
      role: 'user',
      parts: [{ text: 'Follow the project instructions.' }],
    })
    expect(request.request.generationConfig).toEqual({
      temperature: 0.2,
      maxOutputTokens: 200,
      stopSequences: ['END'],
      thinkingConfig: { includeThoughts: true },
    })
    expect(request.request.tools?.[0]?.functionDeclarations[0]?.name).toBe('external_read_file')
    const retry = await buildAntigravityRequest(options(messages, { sessionId: SessionId('session-fixture') }), credentials)
    expect(request.requestId).toMatch(/^agent-/u)
    expect(retry.requestId).toMatch(/^agent-/u)
    expect(retry.requestId).not.toBe(request.requestId)
    expect(retry.request.sessionId).toBe(request.request.sessionId)
  })

  it('does not enable thinking for the none reasoning effort', async () => {
    const request = await buildAntigravityRequest(options([
      user('u1', [{ type: 'text', text: 'Hello' }]),
    ], { reasoningEffort: ReasoningEffortId('none') }), credentials)
    expect(request.request.generationConfig).toBeUndefined()
  })

  it('does not enable thinking for session-title requests', async () => {
    const request = await buildAntigravityRequest(options([
      user('u1', [{ type: 'text', text: 'Hello' }]),
    ], { purpose: 'session-title', reasoningEffort: ReasoningEffortId('high') }), credentials)
    expect(request.request.generationConfig).toBeUndefined()
  })

  it('rewrites a tool schema literal into the shape Gemini validates', async () => {
    // The shape here is the one the wire actually carries, taken from a
    // shipped tool: `required` is already a list of names, while `const`
    // survives compilation inside oneOf branches.
    const request = await buildAntigravityRequest(options([
      user('u1', [{ type: 'text', text: 'Define a package.' }]),
    ], {
      tools: [{
        name: 'cordis_define',
        description: 'Define a Cordis package',
        parameters: {
          type: 'object',
          properties: {
            plugin: {
              oneOf: [
                {
                  type: 'object',
                  additionalProperties: false,
                  properties: { kind: { type: 'string', const: 'new' } },
                  required: ['kind'],
                },
                {
                  type: 'object',
                  additionalProperties: false,
                  properties: { kind: { type: 'string', const: 'existing' }, pluginId: { type: 'string' } },
                  required: ['kind'],
                },
              ],
            },
            name: { type: 'string' },
          },
          required: ['plugin', 'name'],
        },
      }],
    }), credentials)
    // Gemini has no `const` field and refuses a whole request that carries one
    // ("Unknown name \"const\""), so a literal becomes the one-value enum that
    // says the same. Everything else the enforced subset allows — the name
    // list, oneOf, nested objects, additionalProperties — is Gemini's own
    // vocabulary and travels untouched.
    expect(request.request.tools?.[0]?.functionDeclarations[0]?.parameters).toEqual({
      type: 'object',
      properties: {
        plugin: {
          oneOf: [
            {
              type: 'object',
              additionalProperties: false,
              properties: { kind: { type: 'string', enum: ['new'] } },
              required: ['kind'],
            },
            {
              type: 'object',
              additionalProperties: false,
              properties: { kind: { type: 'string', enum: ['existing'] }, pluginId: { type: 'string' } },
              required: ['kind'],
            },
          ],
        },
        name: { type: 'string' },
      },
      required: ['plugin', 'name'],
    })
  })

  it('bypasses Gemini signature validation only for the first unsigned parallel tool call', async () => {
    const serialized = await serializeAntigravityMessages([
      assistant('a1', [
        { type: 'tool-call', id: CallId('call-1'), name: 'read_file', arguments: '{}' },
        { type: 'tool-call', id: CallId('call-2'), name: 'write_file', arguments: '{}' },
      ]),
    ], 'gemini-test')
    expect(serialized).toEqual([{
      role: 'model',
      parts: [
        {
          functionCall: { name: 'external_read_file', args: {}, id: 'call-1' },
          thoughtSignature: 'skip_thought_signature_validator',
        },
        { functionCall: { name: 'external_write_file', args: {}, id: 'call-2' } },
      ],
    }])
  })

  it('rejects image input without an attachment service', async () => {
    await expect(serializeAntigravityMessages([
      user('u1', [{
        type: 'image',
        attachment: { attachmentId: 'missing' as never, mediaType: 'image/png', bytes: 1, width: 1, height: 1 },
      }],
      )], 'gemini-test')).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
  })

  it('resolves durable images into inline Gemini data', async () => {
    const ref = { attachmentId: 'image-1' as never, mediaType: 'image/png' as const, bytes: 3, width: 1, height: 1 }
    const readImage = vi.fn(async () => ({ ref, data: Uint8Array.of(1, 2, 3) }))
    const attachments = { readImage } as unknown as AttachmentStore
    await expect(serializeAntigravityMessages([
      user('u1', [{ type: 'image', attachment: ref }]),
    ], 'gemini-test', attachments)).resolves.toEqual([{
      role: 'user',
      parts: [{ inlineData: { mimeType: 'image/png', data: 'AQID' } }],
    }])
    expect(readImage).toHaveBeenCalledWith(ref, undefined)
  })
})

describe('Antigravity model discovery', () => {
  it('normalizes the live catalog and derives image capability', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({
      models: {
        zeta: { displayName: 'Zeta', maxTokens: 1000, maxOutputTokens: 200, supportsThinking: true },
        alpha: { displayName: 'Alpha', maxTokens: 2000, supportedMimeTypes: { 'image/png': true } },
        internal: { isInternal: true },
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    await expect(discoverAntigravityModels({ accessToken: credentials.access, projectId: credentials.projectId, fetch })).resolves.toEqual([
      {
        id: 'alpha', name: 'Alpha', contextWindow: 2000, supportsImages: true,
        supportsThinking: false, internal: false,
      },
      {
        id: 'internal', name: 'internal', supportsImages: false,
        supportsThinking: false, internal: true,
      },
      {
        id: 'zeta', name: 'Zeta', contextWindow: 1000, maxTokens: 200,
        supportsImages: false, supportsThinking: true, internal: false,
      },
    ])
    const init = fetch.mock.calls[0]?.[1]
    expect(init?.headers).toMatchObject({ Authorization: `Bearer ${credentials.access}` })
    expect(init?.body).toBe(JSON.stringify({ project: credentials.projectId }))
    expect(JSON.stringify(init?.body)).not.toContain(credentials.refresh)
  })

  it('uses the production and sandbox catalog endpoints only after a capability miss', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response('missing', { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ models: { gemini: {} } }), { status: 200 }))
    await expect(discoverAntigravityModels({ accessToken: credentials.access, fetch })).resolves.toMatchObject([
      { id: 'gemini', name: 'gemini' },
    ])
    expect(fetch.mock.calls.map(([input]) => typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)).toEqual([
      'https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels',
      'https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels',
    ])
  })
  it('marks fetched Gemini image output without treating vision input as image generation', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ models: {
      'gemini-3.1-flash-image': { displayName: 'Gemini image', supportsImages: true },
      'gemini-3.1-pro': { supportsImages: true },
    } }))
    const models = await discoverAntigravityModels({ accessToken: credentials.access, fetch })
    expect(models.find(model => model.id === 'gemini-3.1-flash-image')?.endpoints).toEqual(['images/generations'])
    expect(models.find(model => model.id === 'gemini-3.1-pro')?.endpoints).toBeUndefined()
    expect(models.every(model => model.supportsImages)).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('classifies catalog failures without exposing provider response text', async () => {
    const leaked = `credentials=${credentials.access}`
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ error: { message: leaked } }), { status: 400 }))
    let rejection: unknown
    try {
      await discoverAntigravityModels({ accessToken: credentials.access, fetch })
    } catch (error: unknown) {
      rejection = error
    }
    expect(rejection).toMatchObject({ code: 'INVALID_REQUEST', failure: { status: 400 } })
    expect(String(rejection)).not.toContain(credentials.access)
    expect(String(rejection)).not.toContain(leaked)
  })

  it('does not retain credential-bearing fetch or JSON errors as causes', async () => {
    const leaked = credentials.access
    const fetchFailure = vi.fn<typeof globalThis.fetch>(async () => {
      throw new Error(`network failure ${leaked}`)
    })
    let fetchRejection: unknown
    try {
      await discoverAntigravityModels({
        accessToken: leaked,
        fetch: fetchFailure,
        endpoint: 'https://fixture.test',
      })
    } catch (error: unknown) {
      fetchRejection = error
    }
    expect(errorChain(fetchRejection)).not.toContain(leaked)

    const response = new Response('{}', { status: 200 })
    vi.spyOn(response, 'json').mockRejectedValue(new Error(`invalid payload ${leaked}`))
    let jsonRejection: unknown
    try {
      await discoverAntigravityModels({
        accessToken: leaked,
        fetch: vi.fn<typeof globalThis.fetch>(async () => response),
        endpoint: 'https://fixture.test',
      })
    } catch (error: unknown) {
      jsonRejection = error
    }
    expect(errorChain(jsonRejection)).not.toContain(leaked)

    const streamFailure = vi.fn<typeof globalThis.fetch>(async () => {
      throw new Error(`stream failure ${leaked}`)
    })
    let streamRejection: unknown
    try {
      for await (const _chunk of streamAntigravity(
        options([user('u1', [{ type: 'text', text: 'Hello' }])]),
        credentials,
        streamFailure,
        { endpoint: 'https://fixture.test' },
      )) { /* empty */ }
    } catch (error: unknown) {
      streamRejection = error
    }
    expect(errorChain(streamRejection)).not.toContain(leaked)
  })
})

describe('Antigravity SSE transport', () => {
  it('handles fragmented UTF-8 frames and emits reasoning, text, tool, usage, and finish chunks', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(sseBody([
      JSON.stringify({ response: { responseId: 'response-1', candidates: [{ content: { parts: [{ thought: true, text: 'Suy nghĩ 😊', thoughtSignature: 'YWJjZA==' }] } }] } }),
      JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: 'Kết quả' }] } }] } }),
      JSON.stringify({ response: { candidates: [{ content: { parts: [{ functionCall: { name: 'read_file', id: 'call-1', args: { path: 'README.md' } } }] } }] } }),
      JSON.stringify({ response: { usageMetadata: { promptTokenCount: 12, cachedContentTokenCount: 2, candidatesTokenCount: 5, thoughtsTokenCount: 3 }, candidates: [{ finishReason: 'STOP' }] } }),
    ], 17), { status: 200, headers: { 'content-type': 'text/event-stream' } }))
    const chunks = []
    for await (const chunk of streamAntigravity(options([user('u1', [{ type: 'text', text: 'Hello' }])]), credentials, fetch, { endpoint: 'https://fixture.test' })) {
      chunks.push(chunk)
    }
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'Suy nghĩ 😊' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'Suy nghĩ 😊' } },
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, text: 'Kết quả' },
      { type: 'block-end', index: 1, block: { type: 'text', text: 'Kết quả' } },
      { type: 'block-start', index: 2, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 2, id: CallId('call-1'), name: 'read_file', argumentsDelta: '{"path":"README.md"}' },
      { type: 'block-end', index: 2, block: { type: 'tool-call', id: CallId('call-1'), name: 'read_file', arguments: '{"path":"README.md"}' } },
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 8, cacheReadTokens: 2, reasoningTokens: 3 } },
      {
        type: 'finish',
        reason: { kind: 'tool-calls' },
        replayState: {
          response: { responseId: 'response-1', finishReason: 'STOP' },
          blocks: [{ thoughtSignature: 'YWJjZA==' }, {}, {}],
        },
      },
    ])
    expect(fetch).toHaveBeenCalledWith(
      'https://fixture.test/v1internal:streamGenerateContent?alt=sse',
      expect.objectContaining({ method: 'POST', signal: null }),
    )
  })

  it('continues a tool call after replay metadata is removed', async () => {
    let requestNumber = 0
    const requestContents: unknown[] = []
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '') as { request?: { contents?: unknown } }
      requestContents.push(body.request?.contents)
      if (requestNumber++ === 0) {
        return new Response(sseBody([
          JSON.stringify({ response: { responseId: 'response-tool', candidates: [{ content: { parts: [{ functionCall: { name: 'read_file', id: 'call-1', args: { path: 'README.md' } } }] } }] } }),
          JSON.stringify({ response: { candidates: [{ finishReason: 'STOP' }] } }),
        ]), { status: 200, headers: { 'content-type': 'text/event-stream' } })
      }
      return new Response(sseBody([
        JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: 'done' }] } }] } }),
        JSON.stringify({ response: { candidates: [{ finishReason: 'STOP' }] } }),
      ]), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    })
    const firstChunks: unknown[] = []
    for await (const chunk of streamAntigravity(options([
      user('u1', [{ type: 'text', text: 'Inspect this file.' }]),
    ]), credentials, fetch, { endpoint: 'https://fixture.test' })) {
      firstChunks.push(chunk)
    }
    expect(firstChunks).toContainEqual({
      type: 'tool-call-delta',
      index: 0,
      id: CallId('call-1'),
      name: 'read_file',
      argumentsDelta: '{"path":"README.md"}',
    })
    expect(firstChunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'tool-calls' },
      replayState: { blocks: [{}] },
    })

    const secondChunks: unknown[] = []
    for await (const chunk of streamAntigravity(options([
      user('u1', [{ type: 'text', text: 'Inspect this file.' }]),
      assistant('a1', [{ type: 'tool-call', id: CallId('call-1'), name: 'read_file', arguments: '{"path":"README.md"}' }]),
      user('u2', [{
        type: 'tool-result',
        toolCallId: CallId('call-1'),
        content: [{ type: 'text', text: 'file contents' }],
        isError: false,
      }]),
    ]), credentials, fetch, { endpoint: 'https://fixture.test' })) {
      secondChunks.push(chunk)
    }
    expect(secondChunks).toContainEqual({ type: 'text-delta', index: 0, text: 'done' })
    expect(requestContents).toHaveLength(2)
    expect(requestContents[1]).toEqual([
      { role: 'user', parts: [{ text: 'Inspect this file.' }] },
      {
        role: 'model',
        parts: [{
          functionCall: {
            name: 'external_read_file',
            args: { path: 'README.md' },
            id: 'call-1',
          },
          thoughtSignature: 'skip_thought_signature_validator',
        }],
      },
      {
        role: 'user',
        parts: [{
          functionResponse: {
            name: 'external_read_file',
            response: { output: 'file contents' },
            id: 'call-1',
          },
        }],
      },
    ])
  })

  it('accepts a complete final data line when upstream omits the SSE blank separator and finish reason', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(sseBodyWithoutFinalBlank(JSON.stringify({
      response: {
        responseId: 'response-no-finish',
        candidates: [{ content: { parts: [{ text: 'done' }] } }],
        usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1 },
      },
    })), { status: 200, headers: { 'content-type': 'text/event-stream' } }))
    const chunks = []
    for await (const chunk of streamAntigravity(options([user('u1', [{ type: 'text', text: 'Hello' }])]), credentials, fetch, { endpoint: 'https://fixture.test' })) {
      chunks.push(chunk)
    }
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('keeps stream provider errors generic even when the response includes a token', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(sseBody([JSON.stringify({
      error: { code: 401, message: `authorization ${credentials.access}` },
    })]), { status: 200, headers: { 'content-type': 'text/event-stream' } }))
    let rejection: unknown
    try {
      for await (const _chunk of streamAntigravity(options([user('u1', [{ type: 'text', text: 'Hello' }])]), credentials, fetch, { endpoint: 'https://fixture.test' })) { /* empty */ }
    } catch (error: unknown) {
      rejection = error
    }
    expect(rejection).toMatchObject({ code: 'AUTH', failure: { status: 401 } })
    expect(String(rejection)).not.toContain(credentials.access)
  })

  it('falls back on endpoint misses but surfaces quota without leaking token bodies', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response('not found', { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { message: `quota exhausted for ${credentials.access}` },
      }), { status: 429 }))
    let rejection: unknown
    try {
      for await (const _chunk of streamAntigravity(options([user('u1', [{ type: 'text', text: 'Hello' }])]), credentials, fetch)) {
        // The first request fails before a stream is exposed.
      }
    } catch (error: unknown) {
      rejection = error
    }
    expect(rejection).toMatchObject({ code: 'QUOTA', failure: { status: 429 } })
    expect(String(rejection)).not.toContain(credentials.access)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('maps cancellation while reading the response to ABORTED', async () => {
    const controller = new AbortController()
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      controller.abort('cancelled')
      init?.signal?.throwIfAborted()
      return new Response(sseBody([]), { status: 200 })
    })
    await expect(async () => {
      for await (const _chunk of streamAntigravity(options([user('u1', [{ type: 'text', text: 'Hello' }])], { signal: controller.signal }), credentials, fetch, { endpoint: 'https://fixture.test' })) { /* empty */ }
    }).rejects.toMatchObject({ code: 'ABORTED' })
  })

  it('honors the adapter idle timeout and cancels its response reader', async () => {
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({ cancel })
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(body, { status: 200 }))
    const adapter = new AntigravityAdapter({
      resolveCredentials: () => Promise.resolve(credentials),
      fetch,
      endpoint: 'https://fixture.test',
      streamIdleTimeoutMs: 5,
    })
    await expect(async () => {
      for await (const _chunk of adapter.stream(
        options([user('u1', [{ type: 'text', text: 'Hello' }])]),
      )) { /* empty */ }
    }).rejects.toMatchObject({ code: 'TIMEOUT' })
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('cancels an open reader after the terminal DONE event', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
      },
      cancel() {
        cancelled = true
      },
    })
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(body, { status: 200 }))
    const chunks = []
    for await (const chunk of streamAntigravity(options([user('u1', [{ type: 'text', text: 'Hello' }])]), credentials, fetch, { endpoint: 'https://fixture.test' })) {
      chunks.push(chunk)
    }
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'EMPTY_RESPONSE' } } })
    expect(cancelled).toBe(true)
  })

  it('does not retry another endpoint after visible output starts', async () => {
    const first = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode([
          `data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: 'visible' }] } }] } })}`,
          'data: {broken',
        ].join('\n\n')))
        controller.close()
      },
    })
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(first, { status: 200 }))
      .mockResolvedValueOnce(new Response(sseBody(['[DONE]']), { status: 200 }))
    let rejection: unknown
    try {
      for await (const _chunk of streamAntigravity(options([user('u1', [{ type: 'text', text: 'Hello' }])]), credentials, fetch)) { /* empty */ }
    } catch (error: unknown) {
      rejection = error
    }
    expect(rejection).toMatchObject({ code: 'MALFORMED_RESPONSE' })
    expect(fetch).toHaveBeenCalledOnce()
  })
})

describe('Antigravity SSE parser', () => {
  it('joins multiline data fields and rejects an unterminated event', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"a":\n'))
        controller.enqueue(new TextEncoder().encode('data: 1}\n\n'))
        controller.close()
      },
    })
    const events = []
    for await (const event of parseAntigravitySse(stream)) events.push(event)
    expect(events).toEqual(['{"a":\n1}'])

    const broken = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"broken":true}'))
        controller.close()
      },
    })
    await expect(async () => {
      for await (const _event of parseAntigravitySse(broken)) { /* empty */ }
    }).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })
})

it('keeps declared native model endpoints in both list and resolved metadata', async () => {
  const adapter = new AntigravityAdapter({ resolveCredentials: async () => credentials, models: [{ id: 'image', endpoints: ['images/generations'] }] })
  expect((await adapter.listModels('antigravity'))[0]?.endpoints).toEqual(['images/generations'])
  expect((await adapter.resolveModel('antigravity', 'image')).endpoints).toEqual(['images/generations'])
})

it('requires a connected account for native image generation', async () => {
  const adapter = new AntigravityAdapter({ resolveCredentials: async () => undefined })
  await expect(adapter.requestGeneration({ provider: 'antigravity', model: 'image', endpoint: 'images/generations', body: { prompt: 'tree' }, maxResponseBytes: 4096, signal: new AbortController().signal }))
    .rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
})

it.each(['https://user@example.test', 'https://:pass@example.test', 'https://example.test?query=1', 'https://example.test#fragment', 'http://example.test', 'ftp://example.test'])('rejects unsafe native generation endpoint %s', async (endpoint) => {
  const fetch = vi.fn()
  const adapter = new AntigravityAdapter({ resolveCredentials: async () => credentials, endpoint, fetch })
  await expect(adapter.requestGeneration({ provider: 'antigravity', model: 'image', endpoint: 'images/generations', body: { prompt: 'tree' }, maxResponseBytes: 4096, signal: new AbortController().signal }))
    .rejects.toMatchObject({ code: 'INVALID_GENERATION_ENDPOINT' })
  expect(fetch).not.toHaveBeenCalled()
})

it.each([null, sseBody([JSON.stringify({ response: { error: { message: 'denied' } } })])])('rejects missing bodies and nested image-stream errors', async (body) => {
  const adapter = new AntigravityAdapter({ resolveCredentials: async () => credentials, fetch: vi.fn(async () => new Response(body)) })
  await expect(adapter.requestGeneration({ provider: 'antigravity', model: 'image', endpoint: 'images/generations', body: { prompt: 'tree' }, maxResponseBytes: 4096, signal: new AbortController().signal }))
    .rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
})

it('ignores heartbeat events and stops at the image stream completion marker', async () => {
  const body = sseBody(['{}', JSON.stringify({ response: { candidates: [{ finishReason: 'STOP' }] } }), '[DONE]', 'invalid-json'])
  const adapter = new AntigravityAdapter({ resolveCredentials: async () => credentials, fetch: vi.fn(async () => new Response(body)) })
  const response = await adapter.requestGeneration({ provider: 'antigravity', model: 'image', endpoint: 'images/generations', body: { prompt: 'tree' }, maxResponseBytes: 4096, signal: new AbortController().signal })
  expect(await response.json()).toEqual({ candidates: [{ finishReason: 'STOP', content: { parts: [] } }] })
})

import { expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@hydraharness/cordis'
import AgentRegistry, { Inbox, type Agent } from '@hydraharness/harness-agent'
import { createUserMessage, type ContentBlock } from '@hydraharness/harness-llm'
import SessionStore, { SessionId, ORIGINAL_SESSION_VERSION, type SessionEvent, type TurnEndReason } from '@hydraharness/harness-session'
import { WorkspaceId } from '@hydraharness/harness-workspace'
import { createPromptReviser } from '../src/prompt-revisions.ts'
import type { PromptRevisionRequest } from '../src/api/sessions.ts'

type Dependencies = Parameters<typeof createPromptReviser>[1]
const sourceId = SessionId('original')
const workspaceId = WorkspaceId('project')
const text = (value: string): ContentBlock[] => [{ type: 'text', text: value }]
const request = (edit: PromptRevisionRequest['edit'] = { messageSeq: 1, text: 'edited' }): PromptRevisionRequest => ({
  sessionId: sourceId, workspaceId, idempotencyKey: 'operation', ...edit === undefined ? {} : { edit },
})
function user(content: ContentBlock[], seq: number): SessionEvent {
  return { type: 'user/message', seq, time: seq, surfaceOp: 'append', data: createUserMessage({ content, source: { kind: 'user' } }) }
}
const seed: SessionEvent[] = [
  { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } }, user(text('original'), 1),
  { type: 'turn/end', seq: 2, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
]
async function harness(events = seed, origin?: 'subagent') {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  const session = ctx.sessions.create(sourceId, { seed: events, meta: { cwd: process.cwd(), ...origin === undefined ? {} : { origin } } })
  const calls: string[] = []
  const workspace = { id: workspaceId, sessionIds: [sourceId], attachSession: vi.fn() }
  ctx.provide('workspaceRegistry', { list: () => [workspace] } as never)
  const readImage = vi.fn(async () => ({ data: new Uint8Array(5) }))
  const imageLimits = { maxImagesPerMessage: 2, maxMessageImageBytes: 10 }
  ctx.provide('attachments', { readImage, imageLimits } as never)
  const flush = vi.spyOn(ctx.sessions, 'flush').mockImplementation(async () => { calls.push('flush'); return true })
  const inbox = new Inbox(session, { inserted() {}, discarded() {}, claimed() {} })
  const state = { reason: 'completed' as 'completed' | 'error' | 'aborted' | 'interrupted' | 'blocked', running: false }
  const implementation = {
    id: session.id, session, ctx, inbox,
    get status() { return state.running ? 'running' : 'idle' },
    send: vi.fn<Agent['send']>((message, target) => { calls.push('park'); inbox.append(target, message) }),
    followup: vi.fn<Agent['followup']>((message) => {
      calls.push('followup')
      const turn = (session.activeEvents.findLast(event => event.type === 'turn/start')?.data.turn ?? 0) + 1
      session.append('turn/start', { turn })
      session.append('user/message', message, { surfaceOp: 'append' })
      const reason: TurnEndReason = state.reason === 'aborted' ? { kind: 'aborted', reason: { kind: 'user' } }
        : state.reason === 'error' ? { kind: 'error', error: { code: 'UNKNOWN', message: 'generation failed' } }
          : { kind: state.reason }
      session.append('turn/end', { turn, reason })
    }),
    cancel: vi.fn(() => { state.running = false; inbox.clear() }), whenIdle: vi.fn(async () => undefined),
  }
  const agent = implementation as unknown as Agent
  ctx.agents.register(agent)
  const create = vi.spyOn(ctx.agents, 'create')
  const deps = {
    read: vi.fn<Dependencies['read']>(async () => ({ id: session.id, header: session.header, events: [...session.events] })),
    resume: vi.fn<Dependencies['resume']>(async () => agent),
    serialize: <T>(_agent: Agent, operation: () => Promise<T>) => operation(),
    validateModel: vi.fn<Dependencies['validateModel']>(async () => undefined),
  }
  return { ctx, session, agent, send: implementation.send, followup: implementation.followup,
    deps, create, workspace, flush, readImage, imageLimits, calls, state, revise: createPromptReviser(ctx, deps) }
}

it('stores edits and retries in one session, preserving the original log prefix and Agent', async () => {
  const h = await harness()
  const before = h.session.events
  const pending = h.revise(request())
  expect(h.revise(request())).toBe(pending)
  await expect(h.revise({ ...request(), edit: { messageSeq: 1, text: 'conflict' } })).rejects.toThrow('being admitted')
  const result = await pending
  expect(result.sessionId).toBe(sourceId)
  expect(result.revision.previousVersionId).toBe(ORIGINAL_SESSION_VERSION)
  expect(h.session.events.slice(0, before.length)).toEqual(before)
  expect(h.ctx.agents.get(sourceId)).toBe(h.agent)
  expect(h.create).not.toHaveBeenCalled()
  expect(h.workspace.attachSession).not.toHaveBeenCalled()
  expect(h.session.versions.ids).toHaveLength(2)
  expect(JSON.stringify(h.session.deriveMessages())).toContain('edited')
  expect(JSON.stringify(h.session.deriveMessages())).not.toContain('original')
  await expect(h.revise(request())).resolves.toEqual(result)
  expect(h.followup).toHaveBeenCalledOnce()
  await expect(h.revise({ ...request(), edit: { messageSeq: 1, text: 'other' } })).rejects.toThrow('idempotency key')
})

it('recovers a parked admission after a durability failure without duplicating the version', async () => {
  const h = await harness()
  h.flush.mockRejectedValueOnce(new Error('storage offline'))
  await expect(h.revise(request())).rejects.toThrow('storage offline')
  expect(h.agent.inbox.nextTurn).toHaveLength(1)
  expect(h.followup).not.toHaveBeenCalled()
  await h.revise(request())
  expect(h.send).toHaveBeenCalledOnce()
  expect(h.followup).toHaveBeenCalledOnce()
  expect(h.session.versions.ids).toHaveLength(2)
  expect(h.agent.inbox.nextTurn).toEqual([])
})

it('resumes the same cold session and does not rerun an already consumed admission', async () => {
  const h = await harness()
  await h.revise(request())
  vi.spyOn(h.ctx.agents, 'get').mockReturnValue(undefined)
  await h.revise(request())
  expect(h.deps.resume).toHaveBeenCalledWith(sourceId)
  expect(h.followup).toHaveBeenCalledOnce()
})

it('keeps the latest model header while excluding downstream messages', async () => {
  const h = await harness()
  h.session.append('request/header', { header: { config: { provider: 'fixture', model: 'latest' } }, reason: 'initial' })
  await h.revise(request())
  expect(h.session.requestHeader()?.config.model).toBe('latest')
  h.session.append('session/version-selected', { versionId: ORIGINAL_SESSION_VERSION })
  expect(JSON.stringify(h.session.deriveMessages())).toContain('original')
})

it.each(['workspace', 'missing', 'empty', 'subagent', 'non-user', 'no-turn', 'ended-turn'])('rejects %s edits before creating a version', async (invalid) => {
  const events = invalid === 'no-turn' ? [user(text('original'), 0)] : [...seed]
  if (invalid === 'non-user') events[1] = { type: 'user/message', seq: 1, time: 1, surfaceOp: 'append', data: createUserMessage({ content: text('tool'), source: { kind: 'tool', callId: 'call' as never } }) }
  if (invalid === 'ended-turn') events.push(user(text('late'), 3))
  const h = await harness(events, invalid === 'subagent' ? 'subagent' : undefined)
  const input = request()
  if (invalid === 'workspace') input.workspaceId = WorkspaceId('other')
  if (invalid === 'missing') input.edit = { messageSeq: 99, text: 'edit' }
  if (invalid === 'empty') input.edit = { messageSeq: 1, text: '  ' }
  if (invalid === 'no-turn') input.edit = { messageSeq: 0, text: 'edit' }
  if (invalid === 'ended-turn') input.edit = { messageSeq: 3, text: 'edit' }
  await expect(h.revise(input)).rejects.toThrow()
  expect(h.session.versions.ids).toEqual([ORIGINAL_SESSION_VERSION])
  expect(h.create).not.toHaveBeenCalled()
})

const imageBlock = { type: 'image', attachment: { attachmentId: 'image' as never, mediaType: 'image/png', bytes: 5, width: 1, height: 1 } } satisfies ContentBlock
it('preserves image-only prompts and validates retained attachments', async () => {
  const h = await harness([seed[0]!, user([imageBlock], 1), seed[2]!])
  const result = await h.revise(request({ messageSeq: 1, text: '' }))
  expect(result.revision.admission!.message.content).toEqual([imageBlock, { type: 'text', text: '' }])
  expect(h.deps.validateModel.mock.calls[0]![1]).toBe(true)
  expect(h.readImage).toHaveBeenCalledWith(imageBlock.attachment)
})

it.each(['count', 'bytes', 'missing', 'model'])('rejects %s image admission without altering the version graph', async (reason) => {
  const h = await harness([seed[0]!, user(reason === 'count' ? [imageBlock, imageBlock, imageBlock] : [imageBlock], 1), seed[2]!])
  if (reason === 'bytes') h.readImage.mockResolvedValue({ data: new Uint8Array(11) })
  if (reason === 'missing') h.readImage.mockRejectedValue(new Error('missing attachment'))
  if (reason === 'model') h.deps.validateModel.mockRejectedValue(new Error('unsupported model'))
  await expect(h.revise(request())).rejects.toThrow()
  expect(h.session.versions.ids).toHaveLength(1)
})

it.each(['error', 'aborted', 'interrupted', 'blocked'] as const)('retries %s generation with the exact admitted prompt in the same session', async (reason) => {
  const h = await harness()
  h.state.reason = reason
  const first = await h.revise(request())
  const second = await h.revise({ sessionId: sourceId, workspaceId, idempotencyKey: 'retry' })
  expect(second.sessionId).toBe(sourceId)
  expect(second.revision.admission!.message).toEqual(first.revision.admission!.message)
  expect(second.revision).toMatchObject({ previousVersionId: first.revision.versionId, attempt: 2, createdAt: first.revision.createdAt })
  expect(h.session.versions.ids).toHaveLength(3)
  expect(h.create).not.toHaveBeenCalled()
})

it('rejects successful-generation retry and prompts outside the selected version', async () => {
  const h = await harness()
  await h.revise(request())
  await expect(h.revise({ sessionId: sourceId, workspaceId, idempotencyKey: 'retry' })).rejects.toThrow('Only a failed')
  await expect(h.revise({ ...request(), idempotencyKey: 'inactive' })).rejects.toThrow('not a user message')
})

it('closes a steering prefix and clears inherited pending input before admission', async () => {
  const h = await harness([seed[0]!, user(text('initial'), 1), user(text('steering'), 2)])
  const queued = createUserMessage({ content: text('queued'), source: { kind: 'user' } })
  h.agent.inbox.append('next-turn', queued)
  const result = await h.revise(request({ messageSeq: 2, text: 'replacement steer' }))
  const path = h.session.versions.events(result.revision.versionId)
  expect(path.find(event => event.type === 'turn/end')?.data.reason.kind).toBe('interrupted')
  expect(h.agent.inbox.hasPending).toBe(false)
  expect(JSON.stringify(h.session.deriveMessages())).toContain('initial')
  expect(JSON.stringify(h.session.deriveMessages())).not.toContain('"text":"steering"')
})

it('does not restart an admitted turn whose user event has not yet been observed', async () => {
  const h = await harness()
  h.followup.mockImplementation(() => { h.session.append('turn/start', { turn: 1 }) })
  await h.revise(request())
  await h.revise(request())
  expect(h.followup).toHaveBeenCalledOnce()
})
it('rejects recovery of an unconsumed admission from another selected version', async () => {
  const h = await harness()
  h.flush.mockRejectedValueOnce(new Error('offline'))
  await expect(h.revise(request())).rejects.toThrow('offline')
  h.session.append('session/version-selected', { versionId: ORIGINAL_SESSION_VERSION })
  await expect(h.revise(request())).rejects.toThrow('another version')
})
it('admits workspace-free sessions only with a null workspace address', async () => {
  const h = await harness()
  vi.spyOn(h.ctx.workspaceRegistry, 'list').mockReturnValue([])
  await expect(h.revise({ ...request(), workspaceId: null })).resolves.toHaveProperty('sessionId', sourceId)
})
it('rejects editing non-preservable user content', async () => {
  const h = await harness([seed[0]!, user([{ type: 'tool-call', id: 'tool' as never, name: 'tool', arguments: '{}' }], 1), seed[2]!])
  await expect(h.revise(request())).rejects.toThrow('cannot preserve')
})
it('rejects retries before an admission and after a later user continuation', async () => {
  const h = await harness()
  await expect(h.revise({ sessionId: sourceId, workspaceId, idempotencyKey: 'retry' })).rejects.toThrow('no admitted')
  h.state.reason = 'error'
  await h.revise(request())
  h.session.append('user/message', createUserMessage({ content: text('continued'), source: { kind: 'user' } }), { surfaceOp: 'append' })
  await expect(h.revise({ sessionId: sourceId, workspaceId, idempotencyKey: 'retry' })).rejects.toThrow('later user prompt')
})
it('rejects a version changed during model admission', async () => {
  const h = await harness()
  h.deps.validateModel.mockImplementation(async () => { h.session.append('session/version', { versionId: 'changed' as never, parentVersionId: ORIGINAL_SESSION_VERSION, beforeSeq: 0 }) })
  await expect(h.revise(request())).rejects.toThrow('changed before admission')
})
it('closes both the interrupted step and turn for an edited steering prefix', async () => {
  const h = await harness([seed[0]!, user(text('initial'), 1), { type: 'step/start', seq: 2, time: 2, data: { turn: 1, step: 1 } }, user(text('steer'), 3)])
  await h.revise(request({ messageSeq: 3, text: 'replacement' }))
  expect(h.session.activeEvents.map(event => event.type)).toContain('step/end')
})
it('retries a durable admission lacking an optional attempt count', async () => {
  const h = await harness()
  h.state.reason = 'error'
  const first = await h.revise(request())
  const { attempt: _attempt, ...revision } = first.revision
  h.session.append('session/revision', revision)
  const next = await h.revise({ sessionId: sourceId, workspaceId, idempotencyKey: 'retry' })
  expect(next.revision.attempt).toBe(2)
})

it('retries an image-bearing admitted prompt with its retained attachment', async () => {
  const h = await harness([seed[0]!, user([imageBlock], 1), seed[2]!])
  h.state.reason = 'error'
  await h.revise(request())
  await h.revise({ sessionId: sourceId, workspaceId, idempotencyKey: 'retry-image' })
  expect(h.readImage).toHaveBeenCalledTimes(2)
})

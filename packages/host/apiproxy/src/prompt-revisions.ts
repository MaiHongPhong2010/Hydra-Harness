/** Durable prompt versions within one session; prefixes share immutable log entries. */
import { createHash } from 'node:crypto'
import type { Context } from '@hydraharness/cordis'
import type { Agent } from '@hydraharness/harness-agent'
import { createUserMessage } from '@hydraharness/harness-llm'
import { SessionVersionId, sessionVersions, interruptedTurnClosers } from '@hydraharness/harness-session'
import type { SessionEvent, SessionHeader, SessionId } from '@hydraharness/harness-session'
import type { ConversationRevision, PromptRevisionRequest, RevisionMessage } from './api/sessions.ts'
import { conversationRevisionSchema } from './api/sessions.schema.ts'

type Source = { id: SessionId; header: SessionHeader; events: SessionEvent[] }
type Receipt = { sessionId: SessionId; revision: ConversationRevision }

/** Host visibility, resume, and model-admission policy. */
interface PromptRevisionDependencies {
  read(id: SessionId): Promise<Source>
  resume(id: SessionId): Promise<Agent>
  serialize<T>(agent: Agent, operation: () => Promise<T>): Promise<T>
  validateModel(source: Source, images: boolean): Promise<void>
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/**
 * Admit edits and generation retries to the addressed session's version graph.
 * Receipts survive restart; one session can admit only one revision at a time.
 * @param ctx - Composed Host services.
 * @param deps - Session visibility and model policy.
 * @returns Admission after the version and parked prompt are durable.
 */
export function createPromptReviser(ctx: Context, deps: PromptRevisionDependencies): (input: PromptRevisionRequest) => Promise<Receipt> {
  const pending = new Map<SessionId, { key: string; fingerprint: string; promise: Promise<Receipt> }>()

  async function start(agent: Agent, revision: ConversationRevision, admission: NonNullable<ConversationRevision['admission']>): Promise<void> {
    const message = admission.message
    const path = agent.session.versions.events(revision.versionId)
    const receipt = path.findLast(event => event.type === 'session/revision' && event.data.versionId === revision.versionId)
    if (path.some(event => event.type === 'user/message' && event.data.id === message.id)) return
    if (receipt !== undefined && path.some(event => event.type === 'turn/start' && event.seq > receipt.seq)) return
    if (agent.session.versions.current !== revision.versionId) throw new Error('This admitted prompt belongs to another version.')
    if (!agent.inbox.nextTurn.some(item => item.id === message.id)) agent.send(message, 'next-turn', false)
    await ctx.sessions.flush(agent.session)
    agent.inbox.remove(message.id)
    agent.followup(message)
  }

  async function admit(input: PromptRevisionRequest, fingerprint: string): Promise<Receipt> {
    const agent = ctx.agents.get(input.sessionId) ?? await deps.resume(input.sessionId)
    return deps.serialize(agent, () => admitLocked(agent, input, fingerprint))
  }

  async function admitLocked(agent: Agent, input: PromptRevisionRequest, fingerprint: string): Promise<Receipt> {
    const source = await deps.read(input.sessionId)
    if (source.header.origin === 'subagent') throw new Error('Subagent messages must be controlled by their owning session.')
    const workspace = ctx.workspaceRegistry.list().find(item => item.sessionIds.includes(source.id))
    if ((workspace?.id ?? null) !== input.workspaceId) throw new Error('The message does not belong to the addressed workspace.')
    const versionId = SessionVersionId(`version-${digest([input.sessionId, input.idempotencyKey])}`)
    const existing = source.events.find(event => event.type === 'session/revision' && event.data.versionId === versionId)
    if (existing !== undefined) {
      const revision = conversationRevisionSchema.parse(existing.data)
      if (revision.admission?.fingerprint !== fingerprint) throw new Error('This idempotency key has already been used for a different edit.')
      await start(agent, revision, revision.admission)
      return { sessionId: source.id, revision }
    }
    const versions = sessionVersions(source.events)
    const path = versions.events()
    const previousEvent = path.findLast(event => event.type === 'session/revision')
    const previous = previousEvent === undefined ? undefined : conversationRevisionSchema.parse(previousEvent.data)
    let message: RevisionMessage
    let beforeSeq: number
    let turn: number
    let steering = false
    if (input.edit !== undefined) {
      const { messageSeq, text } = input.edit
      const original = path.find(event => event.seq === messageSeq)
      if (original?.type !== 'user/message' || original.data.source.kind !== 'user') throw new Error('The selected event is not a user message in this version.')
      const opening = path.findLast(event => event.type === 'turn/start' && event.seq < messageSeq)
      if (opening?.type !== 'turn/start' || path.some(event => event.seq > opening.seq && event.seq < messageSeq && event.type === 'turn/end')) throw new Error('The selected user prompt has no owning turn.')
      if (original.data.content.some(block => block.type !== 'text' && block.type !== 'image')) throw new Error('This prompt contains content that the editor cannot preserve.')
      const retained = original.data.content.filter(block => block.type === 'image')
      if (text.trim() === '' && retained.length === 0) throw new Error('Enter a message.')
      await deps.validateModel(source, retained.length > 0)
      const stored = await Promise.all(retained.map(block => ctx.attachments.readImage(block.attachment)))
      if (retained.length > ctx.attachments.imageLimits.maxImagesPerMessage) throw new Error('Too many images in this prompt.')
      if (stored.reduce((sum, image) => sum + image.data.byteLength, 0) > ctx.attachments.imageLimits.maxMessageImageBytes) throw new Error('Images exceed the message byte limit.')
      const content: RevisionMessage['content'] = [...retained, { type: 'text', text }]
      message = { ...createUserMessage({ content, source: { kind: 'user' } }), content, source: { kind: 'user' } }
      steering = path.some(event => event.seq > opening.seq && event.seq < messageSeq && event.type === 'user/message' && event.data.source.kind === 'user')
      turn = opening.data.turn + (steering ? 1 : 0)
      beforeSeq = steering ? messageSeq : opening.seq
    } else {
      if (previous?.admission === undefined || previous.versionId === undefined || previousEvent === undefined) throw new Error('This version has no admitted prompt revision to retry.')
      const latestUser = path.findLast(event => event.seq > previousEvent.seq && event.type === 'user/message' && event.data.source.kind === 'user')
      if (latestUser?.type === 'user/message' && latestUser.data.id !== previous.admission.messageId) throw new Error('A later user prompt has already continued this revision.')
      const tail = path.findLast(event => event.seq > previousEvent.seq && event.type === 'turn/end')
      if (agent.status === 'running' || (tail?.type === 'turn/end' && !['error', 'aborted', 'interrupted', 'blocked'].includes(tail.data.reason.kind))) throw new Error('Only a failed or interrupted revision can be retried.')
      message = previous.admission.message
      await deps.validateModel(source, message.content.some(block => block.type === 'image'))
      await Promise.all(message.content.flatMap(block => block.type === 'image' ? [ctx.attachments.readImage(block.attachment)] : []))
      turn = previous.turn
      beforeSeq = previousEvent.seq
    }
    agent.cancel({ kind: 'user' })
    await agent.whenIdle()
    if (agent.session.versions.current !== versions.current) throw new Error('The selected version changed before admission.')
    const header = agent.session.requestHeader()
    const retry = input.edit === undefined ? previous : undefined
    const admission = { fingerprint, messageId: message.id, message }
    const revision: ConversationRevision = {
      sessionId: source.id, conversationId: source.id, previousSessionId: source.id,
      versionId, previousVersionId: versions.current, beforeSeq,
      turn, createdAt: retry?.createdAt ?? Date.now(),
      revisionId: retry?.revisionId ?? source.id,
      attempt: retry === undefined ? 1 : (retry.attempt ?? 1) + 1,
      admission,
    }
    agent.session.append('session/version', { versionId, parentVersionId: versions.current, beforeSeq })
    agent.inbox.clear()
    if (steering) for (const event of interruptedTurnClosers(agent.session.activeEvents)) {
      if (event.type === 'step/end') agent.session.append('step/end', event.data)
      if (event.type === 'turn/end') agent.session.append('turn/end', event.data)
    }
    if (header !== undefined) agent.session.append('request/header', { header, reason: 'initial' })
    agent.session.append('session/revision', revision)
    await start(agent, revision, admission)
    return { sessionId: source.id, revision }
  }

  return (input) => {
    const fingerprint = digest([input.sessionId, input.workspaceId, input.edit ?? null])
    const inflight = pending.get(input.sessionId)
    if (inflight !== undefined) return inflight.key === input.idempotencyKey && inflight.fingerprint === fingerprint
      ? inflight.promise : Promise.reject(new Error('Another prompt version is being admitted for this session.'))
    const promise = admit(input, fingerprint).finally(() => { pending.delete(input.sessionId) })
    pending.set(input.sessionId, { key: input.idempotencyKey, fingerprint, promise })
    return promise
  }
}

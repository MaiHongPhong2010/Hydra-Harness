import { describe, expect, it, vi } from 'vitest'
import { Context } from '@hydraharness/cordis'
import AgentRegistry from '@hydraharness/harness-agent'
import type { Agent } from '@hydraharness/harness-agent'
import SessionStore from '@hydraharness/harness-session'
import type { Session, SessionEvent, SessionHeader, SessionId } from '@hydraharness/harness-session'
import { createApiRemoteAgentResolver } from '@hydraharness/harness-api-remotes'
import { TypertLookupFailure } from '@hydraharness/harness-typert-protocol'
import TypertRegistry from '@hydraharness/harness-typert-registry'

const sid = (value: string): SessionId => value as SessionId

function header(id: SessionId): SessionHeader {
  return { version: 0, id, createdAt: 1, cwd: '/proj' }
}

async function createContext(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  return ctx
}

function provideSession(
  ctx: Context,
  meta: SessionHeader,
  inspect: () => Promise<{ meta: SessionHeader; events: SessionEvent[] }>,
): void {
  ctx.provide('sessionPersistence', {
    list: () => Promise.resolve([meta]),
    inspect,
    locate: () => undefined,
  } as never)
}

function stubAgent(ctx: Context, session: Session): Agent {
  return { id: session.id, session, status: 'idle', ctx } as Agent
}

describe('API Remote Agent resolver races', () => {
  it('prepares an ordinary hot Agent once before deduplicated cold resume', async () => {
    const ctx = await createContext()
    const sessionId = sid('retired-project')
    const meta = header(sessionId)
    const session = ctx.sessions.create(sessionId, { meta: { cwd: '/proj' } })
    const live = stubAgent(ctx, session)
    const detach = ctx.agents.register(live)
    provideSession(ctx, meta, () => Promise.resolve({ meta, events: [] }))
    const ready = Promise.withResolvers<undefined>()
    const prepareLive = vi.fn(async () => { detach(); await ready.promise; return undefined })
    const resumed = stubAgent(ctx.extend(), session)
    const resume = vi.spyOn(ctx.agents, 'resume').mockImplementation(async () => ({ agent: resumed, dispose: async () => {} }))
    const resolver = createApiRemoteAgentResolver(ctx, { prepareLive })
    const first = resolver(sessionId)
    await vi.waitFor(() => { expect(prepareLive).toHaveBeenCalledOnce() })
    expect(ctx.agents.get(sessionId)).toBeUndefined()
    const pending = [first, resolver(sessionId)]
    await Promise.resolve()
    expect(resume).not.toHaveBeenCalled()
    ready.resolve(undefined)
    expect(await Promise.all(pending)).toEqual([{ agent: resumed }, { agent: resumed }])
    expect(resume).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })

  it('leaves an active retired Agent attached when preparation rejects routing', async () => {
    const ctx = await createContext()
    const sessionId = sid('retired-busy')
    const session = ctx.sessions.create(sessionId, { meta: { cwd: '/proj' } })
    const live = stubAgent(ctx, session)
    ctx.agents.register(live)
    const error = { code: 'agent-busy', message: 'Active turn', details: { reason: 'running' } } as const
    const resume = vi.spyOn(ctx.agents, 'resume')
    const resolver = createApiRemoteAgentResolver(ctx, { prepareLive: async () => error })
    expect(await resolver(sessionId)).toEqual({ error })
    expect(ctx.agents.get(sessionId)).toBe(live)
    expect(resume).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('fences owned subagents before live preparation and maps preparation failures', async () => {
    const ctx = await createContext()
    const childId = sid('owned-no-prepare')
    const child = ctx.sessions.create(childId, { meta: { cwd: '/proj', origin: 'subagent' } })
    ctx.agents.register(stubAgent(ctx, child))
    const prepareLive = vi.fn(async () => { throw new Error('flush failed') })
    const resolver = createApiRemoteAgentResolver(ctx, { prepareLive })
    expect(await resolver(childId)).toMatchObject({ error: { code: 'agent-busy' } })
    expect(prepareLive).not.toHaveBeenCalled()
    const ordinaryId = sid('prepare-failure')
    ctx.agents.register(stubAgent(ctx, ctx.sessions.create(ordinaryId, { meta: { cwd: '/proj' } })))
    const failed = await resolver(ordinaryId)
    expect(failed).toMatchObject({ error: { code: 'internal' } })
    if (!('error' in failed)) throw new Error('expected a preparation failure')
    expect(failed.error.message).toContain('flush failed')
    await ctx.fiber.dispose()
  })

  it('drains preparation and rechecks Host deletion before cold resume', async () => {
    const ctx = await createContext()
    const sessionId = sid('preparing-delete')
    const session = ctx.sessions.create(sessionId, { meta: { cwd: '/proj' } })
    const detach = ctx.agents.register(stubAgent(ctx, session))
    const ready = Promise.withResolvers<undefined>()
    let deleting = false
    const error = { code: 'agent-busy', message: 'Deleting', details: { reason: 'deleting' } } as const
    const resolver = createApiRemoteAgentResolver(ctx, {
      prepareLive: async () => { await ready.promise; detach(); return undefined },
      unavailable: () => deleting ? error : undefined,
    })
    const resume = vi.spyOn(ctx.agents, 'resume')
    const resolving = resolver(sessionId)
    const drained = vi.fn()
    const settling = resolver.settle(sessionId).then(drained)
    deleting = true
    await Promise.resolve()
    expect(drained).not.toHaveBeenCalled()
    ready.resolve(undefined)
    expect(await resolving).toEqual({ error })
    await settling
    expect(drained).toHaveBeenCalledOnce()
    expect(resume).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('awaits session-specific defaults before resuming a cold Agent', async () => {
    const ctx = await createContext()
    const sessionId = sid('workspace-defaults')
    const meta = header(sessionId)
    const inspected = { meta, events: [] as SessionEvent[] }
    provideSession(ctx, meta, () => Promise.resolve(inspected))
    const ready = Promise.withResolvers<{ provider: string; model: string }>()
    const defaults = vi.fn(() => ready.promise)
    const resume = vi.spyOn(ctx.agents, 'resume').mockImplementation(async () => {
      const session = ctx.sessions.create(sessionId, { meta: { cwd: '/proj' } })
      return { agent: stubAgent(ctx, session), dispose: () => Promise.resolve() }
    })
    const resolving = createApiRemoteAgentResolver(ctx, { agentOptions: defaults })(sessionId)
    await vi.waitFor(() => { expect(defaults).toHaveBeenCalledWith(inspected) })
    expect(resume).not.toHaveBeenCalled()
    ready.resolve({ provider: 'workspace', model: 'local' })
    expect(await resolving).toMatchObject({ agent: { id: sessionId } })
    expect(resume).toHaveBeenCalledWith({ resumeSessionId: sessionId, agentOptions: { provider: 'workspace', model: 'local' } })
    await ctx.fiber.dispose()
  })

  it('rejects routing during a Host mutation without resuming the session', async () => {
    const ctx = await createContext()
    const sessionId = sid('deleting')
    const error = { code: 'agent-busy', message: 'Session deletion in progress', details: { reason: 'deleting' } } as const
    const resume = vi.spyOn(ctx.agents, 'resume')
    const unavailable = vi.fn(() => error)
    const resolver = createApiRemoteAgentResolver(ctx, { unavailable })
    expect(await resolver(sessionId)).toEqual({ error })
    expect(unavailable).toHaveBeenCalledWith(sessionId)
    expect(resume).not.toHaveBeenCalled()
    await resolver.settle(sessionId)
    await ctx.fiber.dispose()
  })

  it.each([false, true])('drains a pending resume before mutation, failed=%s', async (failed) => {
    const ctx = await createContext()
    const sessionId = sid('drain-resume')
    const meta = header(sessionId)
    const inspected = Promise.withResolvers<{ meta: SessionHeader; events: SessionEvent[] }>()
    provideSession(ctx, meta, () => inspected.promise)
    vi.spyOn(ctx.agents, 'resume').mockImplementation(async () => {
      const session = ctx.sessions.create(sessionId, { meta: { cwd: '/proj' } })
      return { agent: stubAgent(ctx, session), dispose: () => Promise.resolve() }
    })
    const resolver = createApiRemoteAgentResolver(ctx, {})
    const resolving = resolver(sessionId)
    const drained = vi.fn()
    const settling = resolver.settle(sessionId).then(drained)
    await Promise.resolve()
    expect(drained).not.toHaveBeenCalled()
    if (failed) inspected.reject(new Error('persistence unavailable'))
    else inspected.resolve({ meta, events: [] })
    expect(await resolving).toMatchObject(failed ? { error: { code: 'internal' } } : { agent: { id: sessionId } })
    await settling
    expect(drained).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })

  it('maps an inspected session without a cwd to session-not-found', async () => {
    const ctx = await createContext()
    const sessionId = sid('missing-after-inspect')
    const meta = header(sessionId)
    provideSession(ctx, meta, () => Promise.resolve({
      meta: { ...meta, cwd: undefined } as unknown as SessionHeader,
      events: [],
    }))

    const result = await createApiRemoteAgentResolver(ctx, {})(sessionId)

    expect(result).toMatchObject({ error: { code: 'session-not-found', details: { sessionId } } })
    await ctx.fiber.dispose()
  })

  it('resumes through a concurrently attached ordinary Session without optional defaults', async () => {
    const ctx = await createContext()
    const sessionId = sid('ordinary-attach-race')
    const meta = header(sessionId)
    let published: Session | undefined
    provideSession(ctx, meta, () => {
      published = ctx.sessions.create(sessionId, { meta: { cwd: '/proj' } })
      return Promise.resolve({ meta, events: [] })
    })
    const resume = vi.spyOn(ctx.agents, 'resume').mockImplementation(async () => {
      if (published === undefined) throw new Error('Session was not published')
      return { agent: stubAgent(ctx, published), dispose: () => Promise.resolve() }
    })

    const result = await createApiRemoteAgentResolver(ctx, {})(sessionId)

    expect(result).toMatchObject({ agent: { id: sessionId } })
    expect(resume).toHaveBeenCalledWith({ resumeSessionId: sessionId })
    await ctx.fiber.dispose()
  })

  it('rejects a subagent Session published after durable inspection', async () => {
    const ctx = await createContext()
    const sessionId = sid('owned-attach-race')
    const meta = header(sessionId)
    provideSession(ctx, meta, () => {
      ctx.sessions.create(sessionId, { meta: { cwd: '/proj', origin: 'subagent' } })
      return Promise.resolve({ meta, events: [] })
    })
    const resume = vi.spyOn(ctx.agents, 'resume')

    const result = await createApiRemoteAgentResolver(ctx, {})(sessionId)

    expect(result).toMatchObject({ error: { code: 'agent-busy' } })
    expect(resume).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('reclassifies failed resumes after a live or attached subagent wins publication', async () => {
    for (const winner of ['agent', 'session'] as const) {
      const ctx = await createContext()
      const sessionId = sid(`owned-${winner}-resume-race`)
      const meta = header(sessionId)
      provideSession(ctx, meta, () => Promise.resolve({ meta, events: [] }))
      vi.spyOn(ctx.agents, 'resume').mockImplementationOnce(async () => {
        const session = ctx.sessions.create(sessionId, { meta: { cwd: '/proj', origin: 'subagent' } })
        if (winner === 'agent') ctx.agents.register(stubAgent(ctx, session))
        throw new Error('session id already published')
      })

      const result = await createApiRemoteAgentResolver(ctx, {})(sessionId)

      expect(result).toMatchObject({ error: { code: 'agent-busy' } })
      await ctx.fiber.dispose()
    }
  })

  it('uses the shared cold-resume policy for the Agent Host Context', async () => {
    const ctx = await createContext()
    const sessionId = sid('context-cold-resume')
    const meta = header(sessionId)
    let published: Session | undefined
    provideSession(ctx, meta, () => {
      published = ctx.sessions.create(sessionId, { meta: { cwd: '/proj' } })
      return Promise.resolve({ meta, events: [] })
    })
    const agentCtx = ctx.extend()
    vi.spyOn(ctx.agents, 'resume').mockImplementation(async () => {
      if (published === undefined) throw new Error('Session was not published')
      return { agent: stubAgent(agentCtx, published), dispose: () => Promise.resolve() }
    })
    const defaultProvider = ctx.typert.contexts.getHost('agent')
    createApiRemoteAgentResolver(ctx, {})
    await vi.waitFor(() => { expect(ctx.typert.contexts.getHost('agent')).not.toBe(defaultProvider) })
    const provider = ctx.typert.contexts.getHost('agent')
    if (provider === undefined) throw new Error('Agent Host Context provider was not mounted')

    await expect(provider.resolve(sessionId)).resolves.toBe(agentCtx)
    await ctx.fiber.dispose()
  })

  it('applies the subagent ownership fence to the Agent Host Context', async () => {
    const ctx = await createContext()
    const sessionId = sid('context-owned-subagent')
    const session = ctx.sessions.create(sessionId, { meta: { cwd: '/proj', origin: 'subagent' } })
    ctx.agents.register(stubAgent(ctx.extend(), session))
    const defaultProvider = ctx.typert.contexts.getHost('agent')
    createApiRemoteAgentResolver(ctx, {})
    await vi.waitFor(() => { expect(ctx.typert.contexts.getHost('agent')).not.toBe(defaultProvider) })
    const provider = ctx.typert.contexts.getHost('agent')
    if (provider === undefined) throw new Error('Agent Host Context provider was not mounted')

    const resolution = provider.resolve(sessionId)
    await expect(resolution).rejects.toBeInstanceOf(TypertLookupFailure)
    await expect(resolution).rejects.toMatchObject({ failure: { code: 'agent-busy' } })
    await ctx.fiber.dispose()
  })
})

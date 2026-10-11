/** Real workspace compositions and durable API session recovery after trust changes. */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@hydraharness/cordis'
import Loader from '@hydraharness/cordis-plugin-loader'
import Include from '@hydraharness/cordis-plugin-include'
import AgentRegistry from '@hydraharness/harness-agent'
import AgentLoop from '@hydraharness/harness-agent-loop'
import AgentDefaultModel from '@hydraharness/harness-agent-default-model'
import AgentPresets, { resolveSessionPreset } from '@hydraharness/harness-agent-presets'
import LlmRuntime, { LlmAdapter, createUserMessage, type GenerateOptions, type StreamChunk } from '@hydraharness/harness-llm'
import PermissionPresets from '@hydraharness/harness-permission-presets'
import SessionStore, { SessionId } from '@hydraharness/harness-session'
import JsonlSessionPersistence from '@hydraharness/harness-session-persistence-jsonl'
import { settingsNamespace } from '@hydraharness/harness-settings'
import FileSettingsProvider from '@hydraharness/harness-settings-file'
import Storage from '@hydraharness/harness-storage'
import { DomainFacility } from '@hydraharness/harness-storage-domain'
import SystemPrompt from '@hydraharness/harness-system-prompt'
import SubagentRuntime from '@hydraharness/harness-subagent'
import * as SubagentSpawn from '@hydraharness/harness-subagent-spawn-in-process'
import ToolRuntime from '@hydraharness/harness-tools'
import UserApproval from '@hydraharness/harness-user-approval'
import UserQuestions from '@hydraharness/harness-user-questions'
import SuggestedPrompts from '@hydraharness/harness-suggested-prompts'
import LocalFileSystem from '@hydraharness/harness-fs-local'
import CommandRuntime from '@hydraharness/harness-commands'
import * as Toys from '@hydraharness/harness-toys'
import WorkspaceRegistry from '@hydraharness/harness-workspace'
import WorkspaceConfig from '@hydraharness/harness-workspace-config'
import type { RpcRequest } from '@hydraharness/harness-host-apiproxy/api/rpc'
import { RpcId } from '@hydraharness/harness-host-apiproxy/api/rpc'
import { createApiProxy } from '../src/api-proxy.ts'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'

const contexts: Context[] = []
const directories: string[] = []
let requestCounter = 0

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true })
})

function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`workspace-resume-${String(requestCounter++)}`), payload }
}

function value<T>(response: { result: { ok: true; value: T } | { ok: false; error: { message: string } } }): T {
  if (!response.result.ok) throw new Error(response.result.error.message)
  return response.result.value
}

function liveAgent(ctx: Context, sessionId: SessionId) {
  const agent = ctx.agents.get(sessionId)
  if (agent === undefined) throw new Error(`expected live Agent ${sessionId}`)
  return agent
}

class FixtureAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  hold: Promise<void> | undefined

  override resolveModel(provider: string, model: string) {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    await this.hold
    yield { type: 'block-start', index: 0, blockType: 'text' }
    const text = options.system?.startsWith('Return a JSON array') === true ? '["Explain this project", "Run its tests"]' : 'retained'
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function harness(withPermissions = true) {
  const root = await mkdtemp(join(tmpdir(), 'hydra-api-workspace-resume-'))
  directories.push(root)
  const home = join(root, 'home')
  const system = join(root, 'system', 'standard')
  await mkdir(home)
  await mkdir(system, { recursive: true })
  await writeFile(join(home, 'settings.yaml'), '{}\n')
  await writeFile(join(system, 'agent.cordis.yml'), '- name: fixture-tool\n  config: { name: inherited_tool }\n')
  const pool = new MemoryMediaPool()
  const memory = {
    inject: ['storage'],
    apply(ctx: Context) {
      ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
      const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
      ctx.storage.mount('domain', facility)
      ctx.provide('storageDomain', facility)
    },
  }
  const shell = { apply(ctx: Context) { ctx.provide('shell', { sandboxMode: 'workspace-write' } as never) } }
  const tool = {
    inject: ['tools'],
    apply(ctx: Context, config: { name: string }) {
      ctx.tools.register({
        name: config.name, description: 'Workspace fixture tool.', parameters: { type: 'object', properties: {} },
        output: { schema: { type: 'object' }, render: () => [{ type: 'text', text: 'available' }] },
        execute: async () => ({ available: true }),
      })
    },
  }
  const modules = new Map<string, unknown>([
    ['storage', Storage], ['memory', memory], ['workspace', WorkspaceRegistry],
    ['settings', FileSettingsProvider], ['system-prompt', SystemPrompt], ['tools', ToolRuntime], ['shell', shell],
    ['model', AgentDefaultModel], ['sessions', SessionStore], ['persistence', JsonlSessionPersistence],
    ['agents', AgentRegistry], ['llm', LlmRuntime], ['loop', AgentLoop],
    ['presets', AgentPresets], ['workspace-config', WorkspaceConfig], ['fixture-tool', tool],
    ['approval', UserApproval], ['permissions', PermissionPresets], ['questions', UserQuestions],
  ])
  const config = new Map<string, object>([
    ['settings', { path: join(home, 'settings.yaml'), watch: false }], ['system-prompt', { persona: '' }],
    ['model', { provider: 'fixture', model: 'initial' }], ['persistence', { root: join(home, 'sessions'), compression: 'none' }],
    ['loop', { agents: [] }], ['presets', { default: 'standard', roots: [{ path: join(root, 'system'), trust: 'system' }], includeUserRoot: false }],
    ['workspace-config', { hydraHome: home, watch: false }],
  ])
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, JSON.stringify([...modules.keys()].filter(name => name !== 'fixture-tool' && (withPermissions || name !== 'permissions'))
    .map(name => ({ name, ...config.has(name) ? { config: config.get(name) } : {} }))))
  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.internal = {
    version: 'v2',
    async import(name: string) {
      if (!modules.has(name)) throw new Error(`unexpected fixture module ${name}`)
      return modules.get(name)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  const adapter = new FixtureAdapter()
  ctx.llm.registerAdapter(['fixture'], adapter)
  const path = join(root, 'project')
  await mkdir(path)
  const workspace = await ctx.workspaceRegistry.create(path)
  const preset = join(path, '.hydra', 'agent-presets', 'project', 'agent.cordis.yml')
  await mkdir(join(path, '.hydra', 'agent-presets', 'project'), { recursive: true })
  await writeFile(preset, '- name: fixture-tool\n  config: { name: original_tool }\n')
  await ctx.workspaceConfig.setTrusted(workspace.id, true)
  const api = createApiProxy(ctx, { defaultModelSelection: () => ({ provider: 'fixture', model: 'fallback' }), cwd: path })
  const created = value(await api.sessions.create(request({ workspaceId: workspace.id, agentPreset: 'project' })))
  const agent = liveAgent(ctx, created.sessionId)
  return { ctx, workspace, preset, adapter, api, agent }
}

describe('workspace trust recovery through real API sessions', () => {
  it('generates one logged, bounded batch for an empty real chat and only repeats on refresh', async () => {
    const { ctx, adapter, agent, api, workspace } = await harness()
    await ctx.plugin(LocalFileSystem)
    await ctx.plugin(SuggestedPrompts, { maxInputBytes: 200 })
    await ctx.loader.await()
    await writeFile(join(workspace.path, 'README.md'), 'A small test project.')
    expect(ctx.get('suggestedPrompts')).toBeDefined()
    expect(agent.status).toBe('idle')
    const setEnabled = (enabled: boolean) => ctx.settings.update(settingsNamespace('suggested-prompts'), { enabled })
    await setEnabled(true)
    const response = value(await api.sessions.suggestions(request({ sessionId: agent.id })))
    expect(response.items).toEqual(['Explain this project', 'Run its tests'])
    expect(value(await api.sessions.suggestions(request({ sessionId: agent.id })))).toEqual(response)
    expect(adapter.requests).toHaveLength(1)
    const event = agent.session.events.find(event => event.type === 'suggestions/request')
    expect(event).toBeDefined()
    expect(Buffer.byteLength((event?.data as { context: string }).context)).toBeLessThanOrEqual(200)
    expect(agent.session.events.some(event => event.type === 'user/message')).toBe(false)
    await api.sessions.suggestions(request({ sessionId: agent.id, refresh: true }))
    expect(adapter.requests).toHaveLength(2)
    await setEnabled(false)
    expect(value(await api.sessions.suggestions(request({ sessionId: agent.id }))).items).toEqual([])
  })

  it('fires confetti for an enabled human command and never on transcript reads', async () => {
    const { ctx, api, agent } = await harness()
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(Toys)
    await ctx.loader.await()
    const effect = vi.fn()
    ctx.on('toys/confetti', effect)
    const signal = new AbortController().signal
    expect((await ctx.commands.execute(agent, '/confetti', [], signal))?.result.kind).toBe('error')
    await ctx.settings.update(settingsNamespace('toys'), { confetti: true })
    expect((await ctx.commands.execute(agent, '/confetti', [], signal))?.result.kind).toBe('success')
    expect(effect).toHaveBeenCalledOnce()
    await api.sessions.history(request({ sessionId: agent.id }))
    expect(effect).toHaveBeenCalledOnce()
  })
  it('broadcasts accepted permissions to live sessions and reports failures without changing archived chats', async () => {
    const { ctx, workspace, api, agent } = await harness()
    const second = liveAgent(ctx, value(await api.sessions.create(request({ workspaceId: workspace.id }))).sessionId)
    const archived = liveAgent(ctx, value(await api.sessions.create(request({ workspaceId: workspace.id }))).sessionId)
    await ctx.workspaceRegistry.archiveSession(archived.id)
    const archivedEvents = [...archived.session.events]
    const original = ctx.permissionPresets.setLive.bind(ctx.permissionPresets)
    const setter = vi.spyOn(ctx.permissionPresets, 'setLive').mockImplementation((target, preset) => {
      if (target === second) throw new Error('fixture unavailable session')
      original(target, preset)
    })
    const result = value(await api.settings.mutate(request({ ns: settingsNamespace('permission'),
      ops: [{ op: 'set', path: ['defaultPreset'], value: 'danger-full-access' }], applyPermissionToOpenSessions: true })))
    expect(result.permissionResults).toEqual(expect.arrayContaining([
      { sessionId: agent.id, ok: true }, { sessionId: second.id, ok: false, error: 'fixture unavailable session' },
    ]))
    expect(result.permissionResults).toHaveLength(2)
    expect(ctx.permissionPresets.current(agent.session.events)).toBe('danger-full-access')
    expect(archived.session.events).toEqual(archivedEvents)
    setter.mockRestore()
    const retry = value(await api.settings.mutate(request({ ns: settingsNamespace('permission'),
      ops: [{ op: 'set', path: ['defaultPreset'], value: 'danger-full-access' }], applyPermissionToOpenSessions: true })))
    expect(retry.permissionResults?.every(item => item.ok)).toBe(true)
    expect(ctx.permissionPresets.current(second.session.events)).toBe('danger-full-access')
  })

  it('leaves a truly blank chat attached when no durable artifact can reconstruct it', async () => {
    const { ctx, workspace, api, agent } = await harness(false)
    expect(agent.session.events).toEqual([])
    await ctx.workspaceConfig.setTrusted(workspace.id, false)
    await ctx.workspaceConfig.setTrusted(workspace.id, true)
    expect((await api.sessions.models(request({ sessionId: agent.id }))).result).toMatchObject({
      ok: false, error: { code: 'agent-busy', details: { reason: 'session has no durable record' } },
    })
    expect(ctx.agents.get(agent.id)).toBe(agent)
    expect(agent.status).toBe('idle')
  })

  it('rebuilds a hot idle chat once after retrust while preserving durable selections and the recorded preset', async () => {
    const { ctx, workspace, preset, adapter, api, agent } = await harness()
    value(await api.sessions.selectModel(request({ sessionId: agent.id, provider: 'fixture', model: 'recorded-model' })))
    ctx.permissionPresets.set(agent.session, 'danger-full-access')
    agent.options.maxTokens = 37
    value(await api.sessions.prompt(request({ sessionId: agent.id, mode: 'queue', content: [{ type: 'text', text: 'persist this chat' }] })))
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    await agent.whenIdle()
    const events = [...agent.session.events]
    await ctx.settings.update(settingsNamespace('agent-default-model'), { model: 'new-default' })
    await (await ctx.workspaceConfig.settingsFor(workspace.id)).update(settingsNamespace('permission'), { defaultPreset: 'workspace-write' })
    await writeFile(preset, '- name: fixture-tool\n  config: { name: refreshed_tool }\n')
    await ctx.workspaceConfig.setTrusted(workspace.id, false)
    await ctx.workspaceConfig.setTrusted(workspace.id, true)
    const environment = await ctx.workspaceConfig.environmentFor(workspace.id)
    const presets = environment.presets
    if (presets === undefined) throw new Error('expected workspace presets')
    expect(presets.isRetiredProjectContext(agent.ctx, workspace.path)).toBe(true)
    const resume = vi.spyOn(ctx.agents, 'resume')
    const results = await Promise.all([
      api.sessions.models(request({ sessionId: agent.id })),
      api.sessions.create(request({ workspaceId: workspace.id, sessionId: agent.id })),
    ])
    expect(results.map(result => result.result.ok)).toEqual([true, true])
    expect(resume).toHaveBeenCalledOnce()
    const recovered = liveAgent(ctx, agent.id)
    expect(recovered).not.toBe(agent)
    expect(recovered.session.events.slice(0, events.length)).toEqual(events)
    expect(recovered.options.maxTokens).toBe(37)
    expect(resolveSessionPreset(recovered.session)).toBe('project')
    expect(ctx.permissionPresets.current(recovered.session.events)).toBe('danger-full-access')
    expect(value(await api.sessions.models(request({ sessionId: recovered.id }))).current).toEqual({ provider: 'fixture', model: 'recorded-model' })
    expect(ctx.tools.schemas(recovered).map(tool => tool.name)).toContain('refreshed_tool')
    expect(presets.isRetiredProjectContext(recovered.ctx, workspace.path)).toBe(false)
    expect((await ctx.sessionPersistence.inspect(recovered.id)).events.slice(0, events.length)).toEqual(events)
    const forked = value(await api.sessions.fork(request({ sessionId: recovered.id })))
    const child = liveAgent(ctx, forked.sessionId)
    expect(resolveSessionPreset(child.session)).toBe('project')
    expect(ctx.permissionPresets.current(child.session.events)).toBe('danger-full-access')
    expect(value(await api.sessions.models(request({ sessionId: child.id }))).current).toEqual({ provider: 'fixture', model: 'recorded-model' })
    value(await api.sessions.prompt(request({ sessionId: recovered.id, mode: 'queue', content: [{ type: 'text', text: 'continue after retrust' }] })))
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(2) })
    await recovered.whenIdle()
    expect(adapter.requests[1]?.model).toBe('recorded-model')
    expect(adapter.requests[1]?.tools?.map(tool => tool.name)).toContain('refreshed_tool')
  })

  it('retains an unlogged explicit model selection when rebuilding a blank chat', async () => {
    const { ctx, workspace, api, agent } = await harness()
    value(await api.sessions.selectModel(request({ sessionId: agent.id, provider: 'fixture', model: 'picked-before-prompt' })))
    await ctx.settings.update(settingsNamespace('agent-default-model'), { model: 'new-default' })
    await ctx.workspaceConfig.setTrusted(workspace.id, false)
    await ctx.workspaceConfig.setTrusted(workspace.id, true)
    expect(value(await api.sessions.models(request({ sessionId: agent.id }))).current.model).toBe('picked-before-prompt')
    expect(ctx.agents.get(agent.id)).not.toBe(agent)
  })

  it('rejects retrusted hot routing during an active turn and rebuilds after the turn settles', async () => {
    const { ctx, workspace, adapter, api, agent } = await harness()
    value(await api.sessions.selectModel(request({ sessionId: agent.id, provider: 'fixture', model: 'active-model' })))
    const stream = Promise.withResolvers<undefined>()
    adapter.hold = stream.promise
    try {
      value(await api.sessions.prompt(request({ sessionId: agent.id, mode: 'queue', content: [{ type: 'text', text: 'active turn' }] })))
      await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
      await ctx.workspaceConfig.setTrusted(workspace.id, false)
      await ctx.workspaceConfig.setTrusted(workspace.id, true)
      const response = await api.sessions.models(request({ sessionId: agent.id }))
      expect(response.result).toMatchObject({ ok: false, error: { code: 'agent-busy' } })
      expect(ctx.agents.get(agent.id)).toBe(agent)
    } finally {
      stream.resolve(undefined)
      await agent.whenIdle()
    }
    expect((await api.sessions.models(request({ sessionId: agent.id }))).result.ok).toBe(true)
    expect(ctx.agents.get(agent.id)).not.toBe(agent)
  })

  it('preserves subagent ownership and refuses parent rebuilding while a descendant runs', async () => {
    const { ctx, workspace, adapter, api, agent } = await harness()
    const child = await agent.ctx.agents.create({
      sessionId: SessionId('active-child'),
      agentOptions: { provider: 'fixture', model: 'child-model' },
      meta: { cwd: workspace.path, origin: 'subagent', parentSession: agent.id },
    })
    const stream = Promise.withResolvers<undefined>()
    adapter.hold = stream.promise
    try {
      child.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'child turn' }], source: { kind: 'user' } }))
      await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
      await ctx.workspaceConfig.setTrusted(workspace.id, false)
      await ctx.workspaceConfig.setTrusted(workspace.id, true)
      expect((await api.sessions.models(request({ sessionId: agent.id }))).result).toMatchObject({
        ok: false, error: { code: 'agent-busy', details: { reason: 'an owned subagent is still active' } },
      })
      expect((await api.sessions.models(request({ sessionId: child.agent.id }))).result).toMatchObject({
        ok: false, error: { code: 'agent-busy', details: { reason: 'use subagent delivery for this child session' } },
      })
      expect(ctx.agents.get(agent.id)).toBe(agent)
      expect(ctx.agents.get(child.agent.id)).toBe(child.agent)
    } finally {
      stream.resolve(undefined)
      await child.agent.whenIdle()
      await child.dispose()
    }
    expect((await api.sessions.models(request({ sessionId: agent.id }))).result.ok).toBe(true)
  })

  it('refuses parent rebuilding while a real continuable activation without registry ownership runs', async () => {
    const { ctx, workspace, adapter, api, agent } = await harness()
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
    const stream = Promise.withResolvers<undefined>()
    adapter.hold = stream.promise
    const started = await ctx.subagents.startContinuable({
      provider: 'spawn', label: 'continuable child',
      request: { prompt: [{ type: 'text', text: 'child work' }], parent: agent },
      signal: new AbortController().signal,
    })
    try {
      await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
      expect(ctx.agents.isOwnedBy(started.childId, agent)).toBe(false)
      expect(ctx.agents.get(started.childId)?.session.header.parentSession).toBe(agent.id)
      await ctx.workspaceConfig.setTrusted(workspace.id, false)
      await ctx.workspaceConfig.setTrusted(workspace.id, true)
      expect((await api.sessions.models(request({ sessionId: agent.id }))).result).toMatchObject({
        ok: false, error: { code: 'agent-busy', details: { reason: 'an owned subagent is still active' } },
      })
      expect(ctx.agents.get(agent.id)).toBe(agent)
      expect(ctx.agents.get(started.childId)?.status).toBe('running')
    } finally {
      stream.resolve(undefined)
      await vi.waitFor(() => { expect(ctx.agents.get(started.childId)).toBeUndefined() })
      await agent.whenIdle()
    }
  })

  it('leaves the original Agent attached if its durability flush fails and permits a retry', async () => {
    const { ctx, workspace, api, agent } = await harness()
    await ctx.workspaceConfig.setTrusted(workspace.id, false)
    await ctx.workspaceConfig.setTrusted(workspace.id, true)
    vi.spyOn(ctx.sessions, 'flush').mockRejectedValueOnce(new Error('disk unavailable'))
    const failed = (await api.sessions.models(request({ sessionId: agent.id }))).result
    expect(failed).toMatchObject({ ok: false, error: { code: 'internal' } })
    if (failed.ok) throw new Error('expected a durability failure')
    expect(failed.error.message).toContain('disk unavailable')
    expect(ctx.agents.get(agent.id)).toBe(agent)
    expect(agent.status).toBe('idle')
    expect((await api.sessions.models(request({ sessionId: agent.id }))).result.ok).toBe(true)
    expect(ctx.agents.get(agent.id)).not.toBe(agent)
  })

  it('keeps captured options and a pending selection when reopening after a failed recovery', async () => {
    const { ctx, workspace, api, agent } = await harness()
    agent.options.maxTokens = 53
    value(await api.sessions.selectModel(request({ sessionId: agent.id, provider: 'fixture', model: 'pending-selection' })))
    await ctx.workspaceConfig.setTrusted(workspace.id, false)
    await ctx.workspaceConfig.setTrusted(workspace.id, true)
    vi.spyOn(ctx.agents, 'resume').mockRejectedValueOnce(new Error('preset temporarily unavailable'))
    expect((await api.sessions.models(request({ sessionId: agent.id }))).result).toMatchObject({ ok: false, error: { code: 'internal' } })
    expect(ctx.agents.get(agent.id)).toBeUndefined()
    value(await api.sessions.create(request({ workspaceId: workspace.id, sessionId: agent.id })))
    expect(ctx.agents.get(agent.id)?.options.maxTokens).toBe(53)
    expect(value(await api.sessions.models(request({ sessionId: agent.id }))).current.model).toBe('pending-selection')
  })
})

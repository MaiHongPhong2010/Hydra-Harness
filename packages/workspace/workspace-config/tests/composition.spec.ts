import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@hydraharness/cordis'
import z from '@hydraharness/schemastery'
import Loader from '@hydraharness/cordis-plugin-loader'
import Include from '@hydraharness/cordis-plugin-include'
import Storage from '@hydraharness/harness-storage'
import { DomainFacility } from '@hydraharness/harness-storage-domain'
import WorkspaceRegistry, { WorkspaceId } from '@hydraharness/harness-workspace'
import FileSettingsProvider from '@hydraharness/harness-settings-file'
import { settingsNamespace } from '@hydraharness/harness-settings'
import SystemPrompt from '@hydraharness/harness-system-prompt'
import ToolRuntime from '@hydraharness/harness-tools'
import Shell from '@hydraharness/harness-shell'
import McpServerRegistry from '@hydraharness/harness-mcp-registry'
import InvariantRegistry from '@hydraharness/harness-invariants'
import AgentDefaultModel from '@hydraharness/harness-agent-default-model'
import AgentPresets from '@hydraharness/harness-agent-presets'
import AgentRegistry, { type Agent } from '@hydraharness/harness-agent'
import AgentLoop from '@hydraharness/harness-agent-loop'
import SessionStore, { SessionId } from '@hydraharness/harness-session'
import LlmRuntime, { CallId } from '@hydraharness/harness-llm'
import { scopeOf, scopeTarget } from '@hydraharness/harness-scope'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import WorkspaceConfigService from '../src/index.ts'
import * as WorkspaceConfigInvariant from '../src/invariant.ts'
import type { WorkspaceConfigLayer } from '../src/types.ts'

const contexts: Context[] = []
const directories: string[] = []
const MODEL = settingsNamespace('agent-default-model')
const PERMISSION = settingsNamespace('permission')

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true })
})

async function harness(watch = false, withPresets = true): Promise<{ ctx: Context; root: string; home: string }> {
  const root = await mkdtemp(join(tmpdir(), 'hydra-workspace-composition-'))
  directories.push(root)
  const home = join(root, 'home')
  const presets = join(root, 'presets')
  await mkdir(join(presets, 'standard'), { recursive: true })
  await writeFile(join(presets, 'standard', 'agent.cordis.yml'), '- name: test-tool\n  config: { name: inherited }\n')
  await mkdir(home)
  await writeFile(join(home, 'settings.yaml'), 'agent-default-model:\n  model: user\n')
  const pool = new MemoryMediaPool()
  const memory = {
    name: 'workspace-test-storage',
    inject: ['storage'],
    apply(ctx: Context) {
      ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
      const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
      ctx.storage.mount('domain', facility)
      ctx.provide('storageDomain', facility)
      ctx.provide('sessionPersistence', { list: async () => [] } as never)
    },
  }
  const fixtureTool = {
    name: 'workspace-test-tool',
    inject: ['tools'],
    apply(ctx: Context, config: { name: string }) {
      ctx.tools.register({
        name: config.name,
        description: 'Fixture tool.',
        parameters: { type: 'object', properties: {} },
        output: { schema: { type: 'object' }, render: () => [{ type: 'text', text: 'ok' }] },
        execute: async () => ({ ok: true }),
      })
    },
  }
  const modules = new Map<string, unknown>([
    ['test-storage', Storage], ['test-memory', memory], ['test-workspaces', WorkspaceRegistry],
    ['test-settings', FileSettingsProvider], ['test-system-prompt', SystemPrompt], ['test-tools', ToolRuntime],
    ['test-shell', Shell], ['test-model', AgentDefaultModel], ['test-presets', AgentPresets],
    ['test-workspace-config', WorkspaceConfigService], ['test-tool', fixtureTool],
    ['test-sessions', SessionStore], ['test-agents', AgentRegistry], ['test-loop', AgentLoop], ['test-llm', LlmRuntime],
  ])
  const rows = [
    { name: 'test-storage' }, { name: 'test-memory' }, { name: 'test-workspaces' },
    { name: 'test-settings', config: { path: join(home, 'settings.yaml'), watch } },
    { name: 'test-system-prompt', config: { persona: '' } }, { name: 'test-tools' }, { name: 'test-shell' },
    { name: 'test-model', config: { provider: 'fixture', model: 'base' } },
    { name: 'test-sessions' }, { name: 'test-agents' }, { name: 'test-llm' },
    { name: 'test-loop', config: { agents: [] } },
    ...withPresets ? [{ name: 'test-presets', config: { default: 'standard', roots: [{ path: presets, trust: 'system' }], includeUserRoot: false } }] : [],
    { name: 'test-workspace-config', config: { hydraHome: home, watch, debounceMs: 10 } },
    { name: 'test-tool', config: { name: 'global_check' } },
  ]
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, JSON.stringify(rows))
  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected module ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  ctx.settings.register(PERMISSION, z.object({ defaultPreset: z.string().default('workspace-write') }))
  return { ctx, root, home }
}

async function workspace(ctx: Context, root: string, name: string) {
  const path = join(root, name)
  await mkdir(path)
  return await ctx.workspaceRegistry.create(path)
}

async function agent(ctx: Context, id: string, cwd: string, preset?: string): Promise<Agent> {
  const environment = await ctx.workspaceConfig.environment(cwd)
  return (await ctx.agents.create({
    sessionId: SessionId(id), meta: { cwd },
    setup: async (agentCtx) => { await environment.presets!.mount(agentCtx, preset) },
  })).agent
}

describe('workspace-config Loader composition', () => {
  it.each(['agent-default-model', 'llm-pi-ai', 'llm-account-auth', 'credentials'])(
    'rejects global namespace %s in project files and workspace writes', async (namespace) => {
      const { ctx, root } = await harness()
      const work = await workspace(ctx, root, 'work')
      const environment = await ctx.workspaceConfig.environmentFor(work.id)
      await expect(environment.settings.update(settingsNamespace(namespace), {})).rejects.toThrow('not registered')
      const shared = await workspace(ctx, root, 'shared')
      const path = join(shared.path, '.hydra', 'settings.yaml')
      await writeFile(path, JSON.stringify({ [namespace]: {} }))
      await expect(ctx.workspaceConfig.environmentFor(shared.id)).rejects.toThrow(`namespace "${namespace}" is not allowed`)
      const other = await workspace(ctx, root, 'other')
      await writeFile(join(other.path, '.hydra', 'settings.local.yaml'), JSON.stringify({ [namespace]: {} }))
      await expect(ctx.workspaceConfig.environmentFor(other.id)).rejects.toThrow(`namespace "${namespace}" is not allowed`)
      expect(await readFile(path, 'utf8')).toBe(JSON.stringify({ [namespace]: {} }))
      expect(ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'fixture', model: 'user' })
    },
  )

  it('initializes before registry publication and rejects failed preparation without a durable record', async () => {
    const { ctx, root } = await harness()
    const valid = await workspace(ctx, root, 'valid')
    expect(await readFile(join(valid.path, '.hydra', '.gitignore'), 'utf8')).toContain('settings.local.yaml')
    const invalid = join(root, 'invalid')
    await mkdir(join(invalid, '.hydra', 'settings.yaml'), { recursive: true })
    await expect(ctx.workspaceRegistry.create(invalid)).rejects.toThrow()
    expect(ctx.workspaceRegistry.list().map(item => item.id)).toEqual([valid.id])
    await expect(ctx.workspaceConfig.environmentFor(WorkspaceId('missing'))).rejects.toThrow('unknown workspace')
  })

  it('isolates two workspaces, layers and resets overrides, and remembers canonical descendants', async () => {
    const { ctx, root, home } = await harness()
    const first = await workspace(ctx, root, 'first')
    const second = await workspace(ctx, root, 'second')
    await mkdir(join(first.path, 'nested'))
    await writeFile(join(first.path, '.hydra', 'settings.yaml'), 'permission:\n  defaultPreset: read-only\n')
    await writeFile(join(first.path, '.hydra', 'settings.local.yaml'), 'permission:\n  defaultPreset: danger-full-access\n')
    await writeFile(join(second.path, '.hydra', 'settings.yaml'), 'permission:\n  defaultPreset: workspace-write\n')
    const a = await ctx.workspaceConfig.environment(join(first.path, 'nested'))
    const b = await ctx.workspaceConfig.environmentFor(second.id)
    expect(a.root).toBe(first.path)
    expect(ctx.workspaceConfig.currentEnvironment(join(first.path, 'nested'))).toBe(a)
    expect(a.settings.get(PERMISSION)).toEqual({ defaultPreset: 'workspace-write' })
    expect(a.settings.get(MODEL)).toBeUndefined()
    expect(ctx.workspaceConfig.hasTrustDecision(first.id)).toBe(false)
    expect(await ctx.workspaceConfig.hasProjectConfig(first.id)).toBe(true)
    await ctx.workspaceConfig.setTrusted(first.id, true)
    await ctx.workspaceConfig.setTrusted(second.id, true)
    expect(a.settings.get(PERMISSION)).toEqual({ defaultPreset: 'danger-full-access' })
    expect(b.settings.get(PERMISSION)).toEqual({ defaultPreset: 'workspace-write' })
    await (await ctx.workspaceConfig.settingsFor(first.id)).replace(PERMISSION, {})
    expect(a.settings.get(PERMISSION)).toEqual({ defaultPreset: 'read-only' })
    await ctx.settings.update(PERMISSION, { defaultPreset: 'danger-full-access' })
    await ctx.settings.update(MODEL, { provider: 'updated-user' })
    expect(a.settings.get(PERMISSION)).toEqual({ defaultPreset: 'read-only' })
    expect(b.settings.get(PERMISSION)).toEqual({ defaultPreset: 'workspace-write' })
    expect(ctx.settings.get(MODEL)).toEqual({ provider: 'updated-user', model: 'user' })
    expect(await readFile(join(home, 'settings.yaml'), 'utf8')).toContain('trustedRoots')
    await ctx.workspaceConfig.setTrusted(first.id, false)
    expect(a.settings.get(PERMISSION)).toEqual({ defaultPreset: 'danger-full-access' })
    expect(a.settings.get(MODEL)).toBeUndefined()
    expect(ctx.workspaceConfig.hasTrustDecision(first.id)).toBe(true)
    expect(ctx.workspaceConfig.isTrusted(first.id)).toBe(false)
    await ctx.workspaceRegistry.delete(first.id)
    expect(ctx.workspaceConfig.currentEnvironment(first.path)).toBe(a)
    expect(await readFile(join(first.path, '.hydra', 'settings.yaml'), 'utf8')).toContain('read-only')
  })

  it('keeps same-name MCP and hook records private and inherits current Host records', async () => {
    const { ctx, root } = await harness()
    const first = await workspace(ctx, root, 'first')
    const second = await workspace(ctx, root, 'second')
    const a = await ctx.workspaceConfig.environmentFor(first.id)
    const b = await ctx.workspaceConfig.environmentFor(second.id)
    await ctx.workspaceConfig.setTrusted(first.id, true)
    await ctx.workspaceConfig.setTrusted(second.id, true)
    const mcp = settingsNamespace('mcp-servers')
    await (await ctx.workspaceConfig.settingsFor(first.id)).update(mcp, { servers: [{ name: 'same', command: 'node', args: ['a'], enabled: false }] })
    await (await ctx.workspaceConfig.settingsFor(second.id)).update(mcp, { servers: [{ name: 'same', command: 'node', args: ['b'], enabled: false }] })
    expect(a.ctx.get('mcpServers')!.list().servers[0]?.args).toEqual(['a'])
    expect(b.ctx.get('mcpServers')!.list().servers[0]?.args).toEqual(['b'])
    expect(ctx.get('mcpServers')!.list().servers).toEqual([])
    const hooks = settingsNamespace('hooks')
    const record = { name: 'same', dialect: 'claude-code', config: { Stop: [{ hooks: [{ type: 'command', command: 'echo test' }] }] }, enabled: false }
    await a.settings.update(hooks, { records: [record] })
    await b.settings.update(hooks, { records: [record] })
    expect(a.ctx.get('hookRecords')!.list().records.map(item => item.name)).toEqual(['same'])
    expect(b.ctx.get('hookRecords')!.list().records.map(item => item.name)).toEqual(['same'])
    expect(ctx.get('hookRecords')!.list().records).toEqual([])
    await ctx.workspaceConfig.setTrusted(first.id, false)
    expect(a.ctx.get('mcpServers')!.list().servers).toEqual([])
    expect(b.ctx.get('mcpServers')!.list().servers[0]?.args).toEqual(['b'])
  })

  it('updates only the owning workspace when files change and reports inherited base changes under overrides', async () => {
    const { ctx, root } = await harness(true)
    const first = await workspace(ctx, root, 'first')
    const second = await workspace(ctx, root, 'second')
    const a = await ctx.workspaceConfig.environmentFor(first.id)
    const b = await ctx.workspaceConfig.environmentFor(second.id)
    await ctx.workspaceConfig.setTrusted(first.id, true)
    await ctx.workspaceConfig.setTrusted(second.id, true)
    const changes: Array<{ id: string; layer: WorkspaceConfigLayer }> = []
    ctx.on('workspace-config/updated', (id, layer) => { changes.push({ id, layer }) })
    await writeFile(join(first.path, '.hydra', 'settings.yaml'), 'permission:\n  defaultPreset: read-only\n')
    await vi.waitFor(() => { expect(a.settings.get(PERMISSION)).toEqual({ defaultPreset: 'read-only' }) }, { timeout: 5000 })
    expect(b.settings.get(PERMISSION)).toEqual({ defaultPreset: 'workspace-write' })
    expect(changes.some(change => change.id === first.id && change.layer === 'shared')).toBe(true)
    expect(changes.some(change => change.id === second.id)).toBe(false)
    await a.settings.update(PERMISSION, { defaultPreset: 'danger-full-access' })
    changes.length = 0
    await ctx.settings.update(PERMISSION, { defaultPreset: 'read-only' })
    expect(a.settings.get(PERMISSION)).toEqual({ defaultPreset: 'danger-full-access' })
    expect(changes.some(change => change.id === first.id && change.layer === 'local')).toBe(true)
  })

  it.each([false, true])('retains a preset selected by shared settings before deleting it (personal override: %s)', async (personal) => {
    const { ctx, root } = await harness()
    const work = await workspace(ctx, root, 'work')
    const projectPreset = join(work.path, '.hydra', 'agent-presets', 'project')
    await mkdir(projectPreset, { recursive: true })
    await writeFile(join(projectPreset, 'agent.cordis.yml'), '- name: test-tool\n  config: { name: project_tool }\n')
    const shared = await ctx.workspaceConfig.settingsFor(work.id, 'shared')
    await shared.update(settingsNamespace('agent-presets'), { default: 'project' })
    await ctx.workspaceConfig.setTrusted(work.id, true)
    const environment = await ctx.workspaceConfig.environmentFor(work.id)
    if (personal) await environment.settings.update(settingsNamespace('agent-presets'), { default: 'project' })
    await expect(environment.presets!.remove('project')).rejects.toThrow('inherited default')
    expect((await environment.presets!.resolve()).id).toBe('project')
    expect(await readFile(join(projectPreset, 'agent.cordis.yml'), 'utf8')).toContain('project_tool')
    await shared.update(settingsNamespace('agent-presets'), { default: 'standard' })
    await environment.presets!.remove('project')
    expect((await environment.presets!.resolve()).id).toBe('standard')
    await expect(readFile(join(projectPreset, 'agent.cordis.yml'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('revokes project generation execution while inherited generations and alternate tool dispatch remain guarded', async () => {
    const { ctx, root } = await harness()
    const work = await workspace(ctx, root, 'work')
    const projectPreset = join(work.path, '.hydra', 'agent-presets', 'project')
    await mkdir(projectPreset, { recursive: true })
    await writeFile(join(projectPreset, 'agent.cordis.yml'), '- name: test-tool\n  config: { name: project_tool }\n')
    const inherited = await agent(ctx, 'inherited', work.path)
    await ctx.workspaceConfig.setTrusted(work.id, true)
    const project = await agent(ctx, 'project', work.path, 'project')
    expect(ctx.tools.schemas(project).map(tool => tool.name)).toContain('project_tool')
    await ctx.workspaceConfig.setTrusted(work.id, false)
    const execute = (subject: Agent) => ctx.tools.execute({
      callId: CallId('test'), name: 'global_check', arguments: {}, agent: subject, signal: new AbortController().signal,
    })
    const denied = await execute(project)
    expect(denied.isError).toBe(true)
    expect(denied.error?.message).toContain('trust was revoked')
    expect((await execute(inherited)).isError).toBe(false)
    const preStep = await ctx.waterfall(scopeTarget(project, scopeOf(project.ctx)), 'agent/pre-step', {
      agent: project, messages: [], turn: 1, step: 1, signal: new AbortController().signal,
    }, async () => ({ kind: 'enter' as const, messages: [] }))
    expect(preStep).toEqual({ kind: 'reject' })
    const resumed = await agent(ctx, 'new-inherited', work.path)
    expect((await execute(resumed)).isError).toBe(false)
    await ctx.workspaceConfig.setTrusted(work.id, true)
    expect((await execute(project)).error?.message).toContain('Start a new chat or restart Hydra')
    const fresh = await agent(ctx, 'fresh-project', work.path, 'project')
    expect(ctx.tools.schemas(fresh).map(tool => tool.name)).toContain('project_tool')
    expect((await execute(fresh)).isError).toBe(false)
  })

  it('allows standalone project presets only with an explicit trusted default and preserves historical revoke guards', async () => {
    const { ctx, root } = await harness(false, false)
    const work = await workspace(ctx, root, 'work')
    const projectPreset = join(work.path, '.hydra', 'agent-presets', 'project')
    await mkdir(projectPreset, { recursive: true })
    await writeFile(join(projectPreset, 'agent.cordis.yml'), '- name: test-tool\n  config: { name: project_tool }\n')
    await writeFile(join(work.path, '.hydra', 'settings.yaml'), 'agent-presets:\n  default: project\n')
    const environment = await ctx.workspaceConfig.environmentFor(work.id)
    expect(environment.presets).toBeUndefined()
    await ctx.workspaceConfig.setTrusted(work.id, true)
    expect(environment.presets?.defaultId).toBe('project')
    const project = await agent(ctx, 'project', work.path)
    expect(ctx.tools.schemas(project).map(tool => tool.name)).toContain('project_tool')
    await ctx.workspaceConfig.setTrusted(work.id, false)
    expect(environment.presets).toBeUndefined()
    const result = await ctx.tools.execute({ callId: CallId('denied'), name: 'global_check', arguments: {}, agent: project, signal: new AbortController().signal })
    expect(result.isError).toBe(true)
  })

  it('contains an invalid workspace file and retries after correction without affecting another environment', async () => {
    const { ctx, root } = await harness()
    const first = await workspace(ctx, root, 'invalid')
    const second = await workspace(ctx, root, 'valid')
    await writeFile(join(first.path, '.hydra', 'settings.yaml'), 'permission: [\n')
    await expect(ctx.workspaceConfig.environmentFor(first.id)).rejects.toThrow('invalid document')
    const valid = await ctx.workspaceConfig.environmentFor(second.id)
    expect(valid.settings.get(PERMISSION)).toEqual({ defaultPreset: 'workspace-write' })
    await writeFile(join(first.path, '.hydra', 'settings.yaml'), 'permission:\n  defaultPreset: read-only\n')
    await ctx.workspaceConfig.environmentFor(first.id)
    await ctx.workspaceConfig.setTrusted(first.id, true)
    const corrected = await ctx.workspaceConfig.environmentFor(first.id)
    expect(corrected.settings.get(PERMISSION)).toEqual({ defaultPreset: 'read-only' })
    expect(valid.settings.get(PERMISSION)).toEqual({ defaultPreset: 'workspace-write' })
  })

  it('reuses the canonical environment through a directory alias and initializes registered legacy roots on selection', async () => {
    const { ctx, root } = await harness()
    const work = await workspace(ctx, root, 'work')
    await rm(join(work.path, '.hydra'), { recursive: true })
    const alias = join(root, 'alias')
    await symlink(work.path, alias, process.platform === 'win32' ? 'junction' : 'dir')
    try {
      const environment = await ctx.workspaceConfig.environment(alias)
      expect(environment.root).toBe(work.path)
      expect(ctx.workspaceConfig.currentEnvironment(alias)).toBe(environment)
      expect(await readFile(join(work.path, '.hydra', 'settings.local.yaml'), 'utf8')).toBe('')
    } finally {
      await unlink(alias)
    }
  })

  it('runs same-name enabled MCP processes per workspace and falls back to inherited user records after revoke', async () => {
    const { ctx, root } = await harness()
    const first = await workspace(ctx, root, 'first')
    const second = await workspace(ctx, root, 'second')
    const a = await ctx.workspaceConfig.environmentFor(first.id)
    const b = await ctx.workspaceConfig.environmentFor(second.id)
    const fixture = fileURLToPath(new URL('../../../mcp/mcp-client/tests/fixture-server.ts', import.meta.url))
    const record = { name: 'same', transport: 'stdio', command: process.execPath, args: ['--import', import.meta.resolve('tsx/esm'), fixture], enabled: true }
    await ctx.settings.update(settingsNamespace('mcp-servers'), { servers: [{ ...record, name: 'user' }] })
    await ctx.get('mcpServers')!.settle()
    await a.ctx.get('mcpServers')!.settle()
    await b.ctx.get('mcpServers')!.settle()
    await a.settings.update(settingsNamespace('mcp-servers'), { servers: [record] })
    await b.settings.update(settingsNamespace('mcp-servers'), { servers: [record] })
    await ctx.workspaceConfig.setTrusted(first.id, true)
    await ctx.workspaceConfig.setTrusted(second.id, true)
    const agentA = await agent(ctx, 'agent-a', first.path)
    const agentB = await agent(ctx, 'agent-b', second.path)
    expect(a.ctx.get('mcpServers')!.list().servers[0]?.status).toBe('started')
    expect(b.ctx.get('mcpServers')!.list().servers[0]?.status).toBe('started')
    expect(ctx.tools.schemas(agentA).map(tool => tool.name)).toContain('mcp__same__add')
    expect(ctx.tools.schemas().map(tool => tool.name)).not.toContain('mcp__same__add')
    const call = (subject: Agent) => ctx.tools.execute({ callId: CallId('add'), name: 'mcp__same__add', arguments: { a: 2, b: 3 }, agent: subject, signal: new AbortController().signal })
    expect((await call(agentA)).content).toEqual([{ type: 'text', text: '5' }])
    expect((await call(agentB)).content).toEqual([{ type: 'text', text: '5' }])
    await ctx.workspaceConfig.setTrusted(first.id, false)
    expect(a.ctx.get('mcpServers')!.list().servers.map(server => server.name)).toEqual(['user'])
    expect(ctx.tools.schemas(agentA).map(tool => tool.name)).not.toContain('mcp__same__add')
    expect(ctx.tools.schemas(agentA).map(tool => tool.name)).toContain('mcp__user__add')
    expect((await call(agentB)).isError).toBe(false)
  }, 20_000)

  it('preserves a parent workspace scope in child and forked compositions while another workspace stays separate', async () => {
    const { ctx, root } = await harness()
    const first = await workspace(ctx, root, 'first')
    const second = await workspace(ctx, root, 'second')
    const a = await ctx.workspaceConfig.environmentFor(first.id)
    const b = await ctx.workspaceConfig.environmentFor(second.id)
    await ctx.workspaceConfig.setTrusted(first.id, true)
    await ctx.workspaceConfig.setTrusted(second.id, true)
    const projectPreset = join(first.path, '.hydra', 'agent-presets', 'project')
    await mkdir(projectPreset, { recursive: true })
    await writeFile(join(projectPreset, 'agent.cordis.yml'), '- name: test-tool\n  config: { name: private_a }\n')
    const parent = await agent(ctx, 'parent', first.path, 'project')
    const child = (await ctx.agents.create({
      sessionId: SessionId('child'), meta: { cwd: first.path },
      setup: async (childContext) => { a.presets!.composeFrom(childContext, parent.ctx) },
    })).agent
    const fork = (await ctx.agents.create({
      sessionId: SessionId('fork'), seed: parent.session.events, meta: { cwd: parent.session.header.cwd! },
      setup: async (forkContext) => { await a.presets!.mount(forkContext, 'project') },
    })).agent
    const other = await agent(ctx, 'other', second.path)
    expect(ctx.tools.schemas(child).map(tool => tool.name)).toContain('private_a')
    expect(ctx.tools.schemas(fork).map(tool => tool.name)).toContain('private_a')
    expect(ctx.tools.schemas(other).map(tool => tool.name)).not.toContain('private_a')
    expect(b.root).toBe(second.path)
    await ctx.workspaceConfig.setTrusted(first.id, false)
    const denied = (subject: Agent) => ctx.tools.execute({ callId: CallId('guard'), name: 'global_check', arguments: {}, agent: subject, signal: new AbortController().signal })
    expect((await denied(child)).isError).toBe(true)
    expect((await denied(fork)).isError).toBe(true)
    expect((await denied(other)).isError).toBe(false)
  })

  it('unloads workspace settings watchers and runtime services with the owning plugin', async () => {
    const { ctx, root } = await harness(true)
    const work = await workspace(ctx, root, 'work')
    const environment = await ctx.workspaceConfig.environmentFor(work.id)
    await ctx.workspaceConfig.setTrusted(work.id, true)
    const changes: string[] = []
    ctx.on('workspace-config/updated', (id) => { changes.push(id) })
    const fiber = [...ctx.registry.get(WorkspaceConfigService)!.fibers][0]!
    await fiber.dispose()
    expect(environment.ctx.get('mcpServers')).toBeUndefined()
    expect(environment.ctx.get('hookRecords')).toBeUndefined()
    expect(environment.ctx.get('settings')).toBeUndefined()
    expect(ctx.registry.get(FileSettingsProvider)!.fibers).toHaveLength(1)
    await writeFile(join(work.path, '.hydra', 'settings.yaml'), 'permission: {defaultPreset: read-only}\n')
    expect(changes).toEqual([])
  })

  it('prevents project process startup when trust is revoked during workspace construction', async () => {
    const { ctx, root } = await harness()
    const work = await workspace(ctx, root, 'work')
    const marker = join(work.path, 'project-started')
    await writeFile(join(work.path, '.hydra', 'settings.yaml'), JSON.stringify({
      'mcp-servers': { servers: [{
        name: 'project', command: process.execPath, enabled: true,
        args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`],
      }] },
    }))
    const trust = settingsNamespace('workspace-config')
    await ctx.settings.update(trust, { trustedRoots: { [work.path]: true } })
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    // The protected lifecycle hook is delayed to exercise trust changes during provider startup.
    const prototype = McpServerRegistry.prototype as unknown as { [Service.init]: (this: McpServerRegistry) => Promise<void> }
    const original = prototype[Service.init]
    const delay = vi.spyOn(prototype, Service.init).mockImplementation(async function (this: McpServerRegistry) {
      entered.resolve(undefined)
      await release.promise
      await original.call(this)
    })
    const pending = ctx.workspaceConfig.environmentFor(work.id)
    try {
      await entered.promise
      await ctx.workspaceConfig.setTrusted(work.id, false)
      expect(ctx.workspaceConfig.isTrusted(work.id)).toBe(false)
      release.resolve(undefined)
      const environment = await pending
      expect(environment.trusted).toBe(false)
      expect(environment.settings.get(MODEL)).toBeUndefined()
      expect(ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'fixture', model: 'user' })
      expect(environment.ctx.get('mcpServers')!.list().servers).toEqual([])
      await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      release.resolve(undefined)
      delay.mockRestore()
    }
  })

  it('rejects a fabricated trust notification against the actual Host settings decision', async () => {
    const { ctx, root } = await harness()
    const work = await workspace(ctx, root, 'work')
    await ctx.plugin(InvariantRegistry)
    const companion = await ctx.plugin(WorkspaceConfigInvariant)
    await ctx.workspaceConfig.setTrusted(work.id, true)
    expect(ctx.settings.get(settingsNamespace('workspace-config'))).toEqual({ trustedRoots: { [work.path]: true } })
    expect(() => { ctx.emit('workspace-config/trust-updated', work.id, false) }).toThrow('Host-owned decision')
    expect(() => { ctx.emit('workspace-config/trust-updated', work.id, true) }).not.toThrow()
    await companion.dispose()
    expect(() => { ctx.emit('workspace-config/trust-updated', work.id, false) }).not.toThrow()
  })

  it('announces the current Host decision when a later commit supersedes pending trust reconciliation', async () => {
    const { ctx, root } = await harness()
    const work = await workspace(ctx, root, 'work')
    const environment = await ctx.workspaceConfig.environmentFor(work.id)
    await environment.settings.update(settingsNamespace('mcp-servers'), { servers: [{ name: 'project', command: 'node', enabled: false }] })
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(WorkspaceConfigInvariant)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    // oxlint-disable-next-line typescript/unbound-method -- The spy invokes the original with the registry receiver.
    const original = McpServerRegistry.prototype.settle
    const delayed = vi.spyOn(McpServerRegistry.prototype, 'settle').mockImplementation(async function (this: McpServerRegistry) {
      if (this.list().servers[0]?.name === 'project') {
        entered.resolve(undefined)
        await release.promise
      }
      await original.call(this)
    })
    const notifications: boolean[] = []
    ctx.on('workspace-config/trust-updated', (_id, trusted) => { notifications.push(trusted) })
    const accepted = ctx.workspaceConfig.setTrusted(work.id, true)
    try {
      await entered.promise
      await ctx.settings.update(settingsNamespace('workspace-config'), { trustedRoots: { [work.path]: false } })
      release.resolve(undefined)
      await accepted
      await vi.waitFor(() => {
        expect(environment.trusted).toBe(false)
        expect(notifications).toContain(false)
      })
      expect(notifications).not.toContain(true)
      expect(notifications).toContain(false)
    } finally {
      release.resolve(undefined)
      delayed.mockRestore()
    }
  })
})

/**
 * Settings-backed hook record storage and bridge mount reconciliation. Both
 * bridges need `ctx.shell` to run a hook; nothing here executes one, so a stub
 * executor stands in and keeps the suite platform-independent.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@hydraharness/cordis'
import FileSettingsProvider from '@hydraharness/harness-settings-file'
import { SettingsConflictError } from '@hydraharness/harness-settings'
import { createScope, scopeOf, scopeTarget } from '@hydraharness/harness-scope'
import type { Agent } from '@hydraharness/harness-agent'
import type ToolRuntime from '@hydraharness/harness-tools'
import type { ToolExecution } from '@hydraharness/harness-tools'
import HookRecordRegistry, { HOOKS_SETTINGS_NAMESPACE } from '@hydraharness/harness-hooks-registry/src/index.ts'
import type { HookRecordSnapshot } from '@hydraharness/harness-hooks-registry/src/types.ts'
import * as CodexHooks from '@hydraharness/harness-hooks-codex'

vi.mock('@hydraharness/harness-hooks-codex', async (importOriginal) => {
  const original = await importOriginal<typeof import('@hydraharness/harness-hooks-codex')>()
  return { ...original, apply: vi.fn(original.apply) }
})

const contexts: Context[] = []
const directories: string[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

/** Shell stub that captures bridge requests without starting a process. */
class StubShell extends Service {
  constructor(ctx: Context) {
    super(ctx, 'shell')
  }

  resolve(request: { command: string }): { command: string } {
    return request
  }

  run(_request: { command: string; signal?: AbortSignal; workdir?: string }):
  Promise<{ stdout: { text: string }; stderr: { text: string }; exitCode: number }> {
    return Promise.resolve({ stdout: { text: '' }, stderr: { text: '' }, exitCode: 0 })
  }
}

const CLAUDE_HOOKS = {
  PreToolUse: [{ matcher: '^Bash$', hooks: [{ type: 'command', command: 'guard.sh' }] }],
  Stop: [{ hooks: [{ type: 'command', command: 'notify.sh' }] }],
}

async function mount(root: string): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(StubShell)
  await ctx.plugin(FileSettingsProvider, { path: join(root, 'settings.yaml'), watch: false })
  await ctx.plugin(HookRecordRegistry, { hydraHome: root })
  return ctx
}

async function harness(): Promise<{ ctx: Context; registry: HookRecordRegistry; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'hydra-hooks-registry-'))
  directories.push(root)
  const ctx = await mount(root)
  return { ctx, registry: ctx.get('hookRecords') as HookRecordRegistry, root }
}

/**
 * An external document write returns as soon as the section is committed; the
 * mounts it implies follow on the registry's own chain, and
 * `hooks-registry/reconciled` is that settled edge.
 */
function nextReconciliation(ctx: Context): Promise<HookRecordSnapshot> {
  const settled: PromiseWithResolvers<HookRecordSnapshot> = Promise.withResolvers()
  const off = ctx.on('hooks-registry/reconciled', (snapshot) => {
    off()
    settled.resolve(snapshot)
  })
  return settled.promise
}

describe('stored records', () => {
  it.each(['claude-code', 'codex'] as const)('aborts and drains an active blocking %s hook when its project layer is revoked', async (dialect) => {
    const { ctx, registry } = await harness()
    const entered = Promise.withResolvers<undefined>()
    const aborted = Promise.withResolvers<undefined>()
    const exited = Promise.withResolvers<{ stdout: { text: string }; stderr: { text: string }; exitCode: number }>()
    const run = vi.spyOn(ctx.get('shell') as unknown as StubShell, 'run').mockImplementation((request) => {
      request.signal!.addEventListener('abort', () => { aborted.resolve(undefined) }, { once: true })
      entered.resolve(undefined)
      return exited.promise
    })
    await registry.define({ mode: 'create', name: 'blocking', dialect, enabled: true,
      config: { PreToolUse: [{ hooks: [{ type: 'command', command: 'blocking-command' }, { type: 'command', command: 'later-command' }] }] },
    })
    const active = ctx.waterfall(scopeTarget(ctx as unknown as ToolRuntime, undefined), 'tools/pre-execute',
      { name: 'blocked', arguments: {}, signal: new AbortController().signal } as ToolExecution,
      () => Promise.resolve({ kind: 'allow' as const }))
    await entered.promise
    ctx.settings.setLayerEnabled(false)
    const revoked = registry.settle()
    let settled = false
    void revoked.then(() => { settled = true })
    await aborted.promise
    await Promise.resolve()
    expect(settled).toBe(false)
    exited.resolve({ stdout: { text: '' }, stderr: { text: '' }, exitCode: 0 })
    await revoked
    await active
    expect(run).toHaveBeenCalledTimes(1)
    expect(registry.list().records).toEqual([])
  })

  it('reads relative hook documents and runs commands from its owning workspace while retaining Host inline storage', async () => {
    const { ctx, root } = await harness()
    const workspace = join(root, 'project')
    await mkdir(workspace)
    const owner = createScope(ctx, { workspace: 'paths' }).ctx.isolate('settings').isolate('hookRecords')
    await owner.plugin(FileSettingsProvider, { path: join(workspace, 'settings.yaml'), watch: false })
    await owner.plugin(HookRecordRegistry, { hydraHome: join(root, 'private'), cwd: workspace })
    await writeFile(join(workspace, 'hooks.json'), JSON.stringify({ PreToolUse: [{ hooks: [{ type: 'command', command: './guard' }] }] }))
    const registry = owner.get('hookRecords')!
    await registry.define({ mode: 'create', name: 'relative', dialect: 'codex', configPath: 'hooks.json', enabled: true })
    expect(registry.list().records[0]).toMatchObject({ status: 'started', configPath: 'hooks.json' })
    const run = vi.spyOn(ctx.get('shell') as unknown as StubShell, 'run')
    await ctx.waterfall(scopeTarget(ctx as unknown as ToolRuntime, scopeOf(owner)), 'tools/pre-execute',
      { name: 'guarded', arguments: {}, signal: new AbortController().signal } as ToolExecution,
      () => Promise.resolve({ kind: 'allow' as const }))
    expect(run.mock.calls[0]?.[0]).toMatchObject({ command: './guard', workdir: workspace })
    await registry.define({ mode: 'create', name: 'inline', dialect: 'codex', config: CLAUDE_HOOKS, enabled: true })
    expect(await readFile(join(root, 'private', 'hooks', 'inline.json'), 'utf8')).toContain('guard.sh')
    await expect(owner.isolate('hookRecords').plugin(HookRecordRegistry, { cwd: 'relative' })).rejects.toThrow('cwd must be absolute')
  })

  it('writes shared hooks without copying local definitions or removing a still-effective inline document', async () => {
    const { ctx, registry, root } = await harness()
    await registry.define({ mode: 'create', name: 'guardrails', dialect: 'codex',
      config: { SessionStart: [{ hooks: [{ type: 'command', command: 'global' }] }] },
    })
    const sharedScope = createScope(ctx, { layer: 'shared' })
    const localScope = createScope(ctx, { layer: 'local' })
    const sharedCtx = sharedScope.ctx.isolate('settings')
    const localCtx = localScope.ctx.isolate('settings').isolate('hookRecords')
    await sharedCtx.plugin(FileSettingsProvider, { path: join(root, 'shared.yaml'), watch: false })
    await localCtx.plugin(FileSettingsProvider, { path: join(root, 'local.yaml'), watch: false })
    const shared = sharedCtx.get('settings')!
    const local = localCtx.get('settings')!
    shared.inherit(ctx.get('settings')!, [HOOKS_SETTINGS_NAMESPACE])
    local.inherit(shared, [HOOKS_SETTINGS_NAMESPACE])
    await localCtx.plugin(HookRecordRegistry, { hydraHome: join(root, 'runtime') })
    const runtime = localCtx.get('hookRecords')!
    await runtime.define({ mode: 'replace', name: 'guardrails', dialect: 'codex',
      config: { SessionStart: [{ hooks: [{ type: 'command', command: 'shared' }] }] },
    }, shared)
    await runtime.define({ mode: 'replace', name: 'guardrails', dialect: 'codex', enabled: true,
      config: { SessionStart: [{ hooks: [{ type: 'command', command: 'local' }] }] },
    }, local)
    const inlinePath = join(root, 'runtime', 'hooks', 'guardrails.json')
    expect(runtime.list(shared).records[0]).toMatchObject({ status: 'stopped', events: [], hookCount: 0 })
    const localBefore = await readFile(join(root, 'local.yaml'), 'utf8')
    shared.setLayerEnabled(false)
    await runtime.setEnabled({ name: 'guardrails', enabled: true }, shared)
    expect(await readFile(join(root, 'shared.yaml'), 'utf8')).toContain('command: shared')
    expect(await readFile(join(root, 'shared.yaml'), 'utf8')).not.toContain('command: local')
    expect(await readFile(join(root, 'local.yaml'), 'utf8')).toBe(localBefore)
    await runtime.remove('guardrails', shared)
    await runtime.settle()
    expect(runtime.list().records[0]?.status).toBe('started')
    expect(await readFile(inlinePath, 'utf8')).toContain('local')
  })

  it('isolates same-name workspace hooks, inline documents, caller writes, and lifecycle events', async () => {
    const { ctx, root } = await harness()
    await ctx.settings.replace(HOOKS_SETTINGS_NAMESPACE, { records: [] })
    const before = await readFile(join(root, 'settings.yaml'), 'utf8')
    const run = vi.spyOn(ctx.get('shell') as unknown as StubShell, 'run')
    const first = createScope(ctx, { workspace: 'first' })
    const second = createScope(ctx, { workspace: 'second' })
    const ownerA = first.ctx.isolate('settings').isolate('hookRecords')
    const ownerB = second.ctx.isolate('settings').isolate('hookRecords')
    for (const [index, owner] of [ownerA, ownerB].entries()) {
      const home = join(root, String(index))
      await owner.plugin(FileSettingsProvider, { path: join(home, 'settings.yaml'), watch: false })
      await owner.plugin(HookRecordRegistry, { hydraHome: home })
      await owner.get('hookRecords')!.define({ mode: 'create', name: 'startup', dialect: 'codex', enabled: true,
        config: { SessionStart: [{ hooks: [{ type: 'command', command: `workspace-${String(index)}` }] }] },
      })
      expect(await readFile(join(home, 'hooks', 'startup.json'), 'utf8')).toContain(`workspace-${String(index)}`)
    }
    const agent = { session: { header: { id: 'workspace-agent', cwd: root } }, inject: vi.fn() } as unknown as Agent
    ctx.emit(scopeTarget(agent, scopeOf(first.ctx)), 'agent/session-start', { agent, source: 'startup' })
    await vi.waitFor(() => { expect(run).toHaveBeenCalledTimes(1) })
    expect(run.mock.calls[0]?.[0].command).toBe('workspace-0')

    const caller = ctx.isolate('hookRecords', ownerA[Context.isolate].hookRecords)
    await caller.plugin({
      inject: ['hookRecords'],
      async apply(apiCtx) { await apiCtx.hookRecords.setEnabled({ name: 'startup', enabled: false }) },
    })
    expect(await readFile(join(root, 'settings.yaml'), 'utf8')).toBe(before)
    expect(ownerB.get('hookRecords')!.list().records[0]?.status).toBe('started')

    await first.dispose()
    ctx.emit(scopeTarget(agent, scopeOf(first.ctx)), 'agent/session-start', { agent, source: 'startup' })
    ctx.emit(scopeTarget(agent, scopeOf(second.ctx)), 'agent/session-start', { agent, source: 'startup' })
    await vi.waitFor(() => { expect(run).toHaveBeenCalledTimes(2) })
    expect(run.mock.calls[1]?.[0].command).toBe('workspace-1')
    await second.dispose()
  })

  it('rejects a fifty-first record before updating the document', async () => {
    const { ctx, registry } = await harness()
    const reconciled = nextReconciliation(ctx)
    await ctx.settings.replace(HOOKS_SETTINGS_NAMESPACE, {
      records: Array.from({ length: 50 }, (_, index) => ({ name: `record-${index}`, dialect: 'claude-code', config: CLAUDE_HOOKS })),
    })
    await reconciled
    await expect(registry.define({ mode: 'create', name: 'overflow', dialect: 'claude-code', config: CLAUDE_HOOKS }))
      .rejects.toThrow('at most 50 records')
    expect(registry.list().records).toHaveLength(50)
  })

  it.each(['create', 'replace', 'setEnabled', 'remove'] as const)(
    'refuses a stale %s without restoring another deleted hook, then accepts a refreshed retry', async (mode) => {
      const { registry, root } = await harness()
      const definition = { mode: 'create' as const, name: 'kept', dialect: 'claude-code' as const, config: CLAUDE_HOOKS }
      await registry.define(definition)
      await registry.define({ ...definition, name: 'removed' })
      const peer = await mount(root)
      await registry.remove('removed')
      const before = await readFile(join(root, 'settings.yaml'), 'utf8')
      const write = () => mode === 'setEnabled'
        ? peer.hookRecords.setEnabled({ name: 'kept', enabled: false })
        : mode === 'remove' ? peer.hookRecords.remove('kept')
          : peer.hookRecords.define({ ...definition, mode, name: mode === 'create' ? 'added' : 'kept', defaultTimeoutMs: 12000 })

      await expect(write()).rejects.toBeInstanceOf(SettingsConflictError)
      expect(await readFile(join(root, 'settings.yaml'), 'utf8')).toBe(before)
      expect(peer.hookRecords.list().records.map(record => record.name)).toEqual(['kept'])
      const accepted = await write()
      expect(accepted.records.map(record => record.name)).toEqual(mode === 'remove' ? [] : mode === 'create' ? ['kept', 'added'] : ['kept'])
      if (mode === 'replace') expect(await readFile(join(root, 'settings.yaml'), 'utf8')).toContain('defaultTimeoutMs: 12000')
      const restarted = await mount(root)
      expect(restarted.hookRecords.list()).toEqual(accepted)
    })

  it.each(['codex', 'claude-code'] as const)('refuses inert %s definitions and bounds UTF-8 bytes', async (dialect) => {
    const { registry } = await harness()
    await expect(registry.define({ mode: 'create', name: 'inert', dialect, config: { Stop: [] } }))
      .rejects.toThrow('no supported synchronous command hooks')
    await expect(registry.define({ mode: 'create', name: 'oversized', dialect,
      config: { Stop: [{ hooks: [{ command: 'echo ' + '界'.repeat(90_000) }] }] },
    })).rejects.toThrow('exceed')
    expect(registry.list().records).toEqual([])
  })

  it('rejects duplicate creates without changing the active hook definitions', async () => {
    const { registry, root } = await harness()
    await registry.define({ mode: 'create', name: 'guardrails', dialect: 'claude-code', config: CLAUDE_HOOKS, enabled: true })
    const path = join(root, 'hooks', 'guardrails.json')
    const before = await readFile(path, 'utf8')
    await expect(registry.define({ mode: 'create', name: 'guardrails', dialect: 'codex', config: {} }))
      .rejects.toThrow('already exists')
    expect(await readFile(path, 'utf8')).toBe(before)
    expect(registry.list().records[0]).toMatchObject({ enabled: true, dialect: 'claude-code', status: 'started' })
  })

  it('serializes competing creates and refuses replacing a removed record', async () => {
    const { registry } = await harness()
    const definition = { mode: 'create' as const, name: 'guardrails', dialect: 'claude-code' as const, config: CLAUDE_HOOKS }
    const results = await Promise.allSettled([registry.define(definition), registry.define(definition)])
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected'])
    await registry.remove('guardrails')
    await expect(registry.define({ ...definition, mode: 'replace' })).rejects.toThrow('not configured')
    expect(registry.list().records).toEqual([])
  })
  it('persists an inline record into the settings document', async () => {
    const { registry, root } = await harness()

    const snapshot = await registry.define({ mode: 'create',
      name: 'guardrails',
      dialect: 'claude-code',
      config: CLAUDE_HOOKS,
    })

    expect(snapshot.records).toEqual([{
      name: 'guardrails',
      dialect: 'claude-code',
      source: 'inline',
      enabled: false,
      status: 'stopped',
      events: [],
      hookCount: 0,
    }])
    const document = await readFile(join(root, 'settings.yaml'), 'utf8')
    expect(document).toContain('hooks:')
    expect(document).toContain('name: guardrails')
    expect(document).toContain('command: guard.sh')
  })

  it('stores a file record by absolute path without copying its document', async () => {
    const { registry, root } = await harness()
    const configPath = join(root, 'hooks.json')
    await writeFile(configPath, JSON.stringify(CLAUDE_HOOKS))

    const snapshot = await registry.define({ mode: 'create', name: 'project', dialect: 'claude-code', configPath })

    expect(snapshot.records[0]).toMatchObject({ source: 'file', configPath })
  })

  it('refuses a definition it could not mount before anything persists', async () => {
    const { registry, root } = await harness()

    await expect(registry.define({ mode: 'create', name: 'no name', dialect: 'codex', config: CLAUDE_HOOKS }))
      .rejects.toThrow('record name must match')
    await expect(registry.define({ mode: 'create', name: 'empty', dialect: 'claude-code' }))
      .rejects.toThrow('needs either a configPath or inline hook definitions')
    await expect(registry.define({ mode: 'create',
      name: 'both', dialect: 'claude-code', configPath: join(root, 'hooks.json'), config: CLAUDE_HOOKS,
    })).rejects.toThrow('declares both a configPath and inline hook definitions')
    await expect(registry.define({ mode: 'create', name: 'relative', dialect: 'claude-code', configPath: 'hooks.json' }))
      .rejects.toThrow('configPath must be absolute')
    await expect(registry.define({ mode: 'create',
      name: 'codex-roots', dialect: 'codex', config: CLAUDE_HOOKS, pluginRoot: 'C:\\plugin',
    })).rejects.toThrow('substitution roots apply to claude-code records only')
    await expect(registry.define({ mode: 'create',
      name: 'missing', dialect: 'claude-code', configPath: join(root, 'absent.json'),
    })).rejects.toThrow('cannot read')

    await expect(readFile(join(root, 'settings.yaml'), 'utf8')).rejects.toThrow()
    expect(registry.list().records).toEqual([])
  })

  it('refuses a stored section that declares one name twice', async () => {
    const { ctx } = await harness()

    await expect(ctx.settings.replace(HOOKS_SETTINGS_NAMESPACE, {
      records: [
        { name: 'guardrails', dialect: 'claude-code', config: CLAUDE_HOOKS },
        { name: 'guardrails', dialect: 'codex', config: CLAUDE_HOOKS },
      ],
    })).rejects.toThrow('is declared more than once')
  })

  it('drops one record with the document it materialized', async () => {
    const { registry, root } = await harness()
    await registry.define({ mode: 'create', name: 'guardrails', dialect: 'claude-code', config: CLAUDE_HOOKS, enabled: true })
    const materialized = join(root, 'hooks', 'guardrails.json')
    expect(await readFile(materialized, 'utf8')).toContain('guard.sh')

    await expect(registry.remove('guardrails')).resolves.toEqual({ records: [] })

    await expect(readFile(materialized, 'utf8')).rejects.toThrow()
    await expect(registry.remove('guardrails')).rejects.toThrow('record guardrails is not configured')
  })
})

describe('mount reconciliation', () => {
  it('mounts Codex hooks and retains Claude substitution roots in the projection', async () => {
    const { registry, root } = await harness()
    await registry.define({ mode: 'create', name: 'codex', dialect: 'codex',
      config: { Stop: [{ hooks: [{ command: 'echo stopped' }] }] }, enabled: true })
    await registry.define({ mode: 'create', name: 'claude', dialect: 'claude-code',
      config: CLAUDE_HOOKS, pluginRoot: root, projectDir: root, enabled: true })
    expect(registry.list().records).toMatchObject([
      { name: 'codex', status: 'started', events: ['Stop'] },
      { name: 'claude', status: 'started', pluginRoot: root, projectDir: root },
    ])
  })

  it('does not mount a pending write after the registry starts disposing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hydra-hooks-disposing-'))
    directories.push(root)
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(StubShell)
    await ctx.plugin(FileSettingsProvider, { path: join(root, 'settings.yaml'), watch: false })
    const fiber = ctx.plugin(HookRecordRegistry, { hydraHome: root })
    await fiber
    const registry = ctx.hookRecords
    const entered: PromiseWithResolvers<void> = Promise.withResolvers()
    const release: PromiseWithResolvers<void> = Promise.withResolvers()
    const update = ctx.settings.update.bind(ctx.settings)
    vi.spyOn(ctx.settings, 'update').mockImplementationOnce(async (...args) => {
      await update(...args)
      entered.resolve()
      await release.promise
    })
    const pending = registry.define({ mode: 'create', name: 'pending', dialect: 'claude-code', config: CLAUDE_HOOKS, enabled: true })
    await entered.promise
    const disposing = fiber.dispose()
    release.resolve()
    await pending
    await disposing
    expect(registry.list().records).toMatchObject([{ name: 'pending', enabled: true, status: 'stopped' }])
  })

  it.each([new Error('bridge failed'), 'bridge failed'])('reports a bridge startup rejection: %s', async (error) => {
    const { registry } = await harness()
    vi.mocked(CodexHooks.apply).mockImplementationOnce(function () { throw error })
    await registry.define({ mode: 'create', name: 'failed', dialect: 'codex',
      config: { Stop: [{ hooks: [{ command: 'echo stopped' }] }] }, enabled: true })
    expect(registry.list().records).toMatchObject([{ name: 'failed', status: 'failed', detail: 'bridge failed' }])
  })

  it('mounts an enabled record and reports what its definitions cover', async () => {
    const { registry } = await harness()
    await registry.define({ mode: 'create', name: 'guardrails', dialect: 'claude-code', config: CLAUDE_HOOKS })

    const enabled = await registry.setEnabled({ name: 'guardrails', enabled: true })

    expect(enabled.records[0]).toMatchObject({
      enabled: true,
      status: 'started',
      events: ['PreToolUse', 'Stop'],
      hookCount: 2,
    })

    const disabled = await registry.setEnabled({ name: 'guardrails', enabled: false })

    expect(disabled.records[0]).toMatchObject({ enabled: false, status: 'stopped', events: [], hookCount: 0 })
  })

  it('mounts every enabled record the document already carried at startup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hydra-hooks-registry-startup-'))
    directories.push(root)
    await writeFile(join(root, 'settings.yaml'), [
      'hooks:',
      '  records:',
      '    - name: guardrails',
      '      dialect: claude-code',
      '      enabled: true',
      '      config:',
      '        Stop:',
      '          - hooks:',
      '              - type: command',
      '                command: notify.sh',
      '',
    ].join('\n'))

    const ctx = await mount(root)

    expect((ctx.get('hookRecords') as HookRecordRegistry).list().records[0]).toMatchObject({
      name: 'guardrails',
      enabled: true,
      status: 'started',
      events: ['Stop'],
      hookCount: 1,
    })
  })

  it('materializes the inline document again on every mount, so an edit reaches the bridge', async () => {
    const { registry, root } = await harness()
    await registry.define({ mode: 'create', name: 'guardrails', dialect: 'claude-code', config: CLAUDE_HOOKS, enabled: true })

    await registry.define({ mode: 'replace',
      name: 'guardrails',
      dialect: 'claude-code',
      enabled: true,
      config: { Stop: [{ hooks: [{ type: 'command', command: 'replaced.sh' }] }] },
    })

    const materialized = await readFile(join(root, 'hooks', 'guardrails.json'), 'utf8')
    expect(materialized).toContain('replaced.sh')
    expect(materialized).not.toContain('guard.sh')
    expect(registry.list().records[0]).toMatchObject({ events: ['Stop'], hookCount: 1 })
  })

  it('reports a stored record it refuses to mount without stopping its sibling', async () => {
    const { ctx, registry } = await harness()

    const reconciled = nextReconciliation(ctx)
    await ctx.settings.replace(HOOKS_SETTINGS_NAMESPACE, {
      records: [
        { name: 'broken', dialect: 'claude-code', configPath: join('relative', 'hooks.json'), enabled: true },
        { name: 'guardrails', dialect: 'claude-code', config: CLAUDE_HOOKS, enabled: true },
      ],
    })
    await reconciled

    const [broken, guardrails] = registry.list().records
    expect(broken).toMatchObject({ name: 'broken', enabled: true, status: 'invalid' })
    expect(broken?.detail).toContain('configPath must be absolute')
    expect(guardrails).toMatchObject({ name: 'guardrails', status: 'started', hookCount: 2 })
  })

  it('reports hand-edited inert definitions as invalid while mounting their sibling', async () => {
    const { ctx, registry } = await harness()
    const reconciled = nextReconciliation(ctx)
    await ctx.settings.replace(HOOKS_SETTINGS_NAMESPACE, {
      records: [
        { name: 'empty', dialect: 'codex', config: { Stop: [] }, enabled: true },
        { name: 'guardrails', dialect: 'claude-code', config: CLAUDE_HOOKS, enabled: true },
      ],
    })
    await reconciled
    expect(registry.list().records).toMatchObject([
      { name: 'empty', status: 'invalid' },
      { name: 'guardrails', status: 'started', hookCount: 2 },
    ])
    expect(registry.list().records[0]?.detail).toContain('no supported synchronous command hooks')
  })

  it('reports a file record whose document stopped being readable', async () => {
    const { ctx, registry, root } = await harness()
    const configPath = join(root, 'hooks.json')
    await writeFile(configPath, JSON.stringify(CLAUDE_HOOKS))
    await registry.define({ mode: 'create', name: 'project', dialect: 'claude-code', configPath })

    await rm(configPath)
    const reconciled = nextReconciliation(ctx)
    await ctx.settings.replace(HOOKS_SETTINGS_NAMESPACE, {
      records: [{ name: 'project', dialect: 'claude-code', configPath, enabled: true }],
    })
    await reconciled

    expect(registry.list().records[0]).toMatchObject({ status: 'invalid' })
    expect(registry.list().records[0]?.detail).toContain('cannot read')
  })

  it('reports a file record whose document is not valid JSON', async () => {
    const { ctx, registry, root } = await harness()
    const configPath = join(root, 'hooks.json')
    await writeFile(configPath, '{ not json')

    const reconciled = nextReconciliation(ctx)
    await ctx.settings.replace(HOOKS_SETTINGS_NAMESPACE, {
      records: [{ name: 'project', dialect: 'claude-code', configPath, enabled: true }],
    })
    await reconciled

    expect(registry.list().records[0]?.detail).toContain('not valid JSON')
  })

  it('refuses to change a record that is not configured', async () => {
    const { registry } = await harness()

    await expect(registry.setEnabled({ name: 'absent', enabled: true }))
      .rejects.toThrow('record absent is not configured')
  })

  it('unmounts every live record when the fiber disposes', async () => {
    const { ctx, registry } = await harness()
    await registry.define({ mode: 'create', name: 'guardrails', dialect: 'claude-code', config: CLAUDE_HOOKS, enabled: true })
    expect(registry.list().records[0]).toMatchObject({ status: 'started' })

    await ctx.fiber.dispose()

    expect(ctx.get('hookRecords')).toBeUndefined()
  })
})

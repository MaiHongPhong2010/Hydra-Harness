/**
 * The default preset is a user setting. `config.default` is the deployment's
 * engineering default; the settings document overrides it and is hot-reloaded,
 * so a person can change which preset new sessions get without a restart.
 */

import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@hydraharness/cordis'
import Loader from '@hydraharness/cordis-plugin-loader'
import Include from '@hydraharness/cordis-plugin-include'
import LlmRuntime from '@hydraharness/harness-llm'
import SessionStore, { SessionId } from '@hydraharness/harness-session'
import SystemPrompt from '@hydraharness/harness-system-prompt'
import ToolRuntime from '@hydraharness/harness-tools'
import AgentRegistry from '@hydraharness/harness-agent'
import AgentLoop from '@hydraharness/harness-agent-loop'
import FileSettingsProvider from '@hydraharness/harness-settings-file'
import { settingsNamespace } from '@hydraharness/harness-settings'
import { createScope } from '@hydraharness/harness-scope'
import { describe, expect, it, vi } from 'vitest'
import AgentPresets, { COMPOSITION_FILE, SETTINGS_NAMESPACE } from '@hydraharness/harness-agent-presets'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const ROOTS = [{ path: join(FIXTURES, 'system'), trust: 'system' as const }]
const NS = settingsNamespace(SETTINGS_NAMESPACE)

/**
 * A composition with a real file-backed settings provider. `settingsFiber` is
 * the provider's own handle, so a test can take it away the way a reload does.
 */
async function harness(
  extraRoots: readonly { path: string; trust: 'system' | 'user' }[] = [],
): Promise<{ ctx: Context; settingsFile: string; settingsFiber: { dispose: () => unknown } }> {
  const home = await mkdtemp(join(tmpdir(), 'hydra-preset-settings-'))
  const settingsFile = join(home, 'settings.yaml')
  await writeFile(settingsFile, '{}\n')

  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(FIXTURES).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  const settingsFiber = ctx.plugin(FileSettingsProvider, { path: settingsFile, watch: false })
  await settingsFiber
  await ctx.plugin(AgentPresets, { default: 'standard', roots: [...ROOTS, ...extraRoots], includeUserRoot: false })
  return { ctx, settingsFile, settingsFiber }
}

const toolNames = (ctx: Context, agent?: unknown): string[] =>
  ctx.tools.schemas(agent as never).map(schema => schema.name).sort()

describe('the default preset as a user setting', () => {
  it('writes only the selected shared preset leaf without copying local overrides', async () => {
    const { ctx, settingsFile } = await harness()
    const sharedScope = createScope(ctx, { settings: 'shared' })
    const localScope = createScope(ctx, { settings: 'local' })
    const sharedCtx = sharedScope.ctx.isolate('settings')
    const localCtx = localScope.ctx.isolate('settings')
    await sharedCtx.plugin(FileSettingsProvider, { path: `${settingsFile}.shared.yaml`, watch: false })
    await localCtx.plugin(FileSettingsProvider, { path: `${settingsFile}.local.yaml`, watch: false })
    const shared = sharedCtx.get('settings')!
    const local = localCtx.get('settings')!
    shared.inherit(ctx.get('settings')!, [NS])
    local.inherit(shared, [NS])
    try {
      await ctx.agentPresets.setPluginEnabled('agent-preset:standard:alpha', false, shared)
      await ctx.agentPresets.setPluginEnabled('agent-preset:standard:alpha', true, local)
      await ctx.agentPresets.setPluginEnabled('agent-preset:minimal:beta', false, local)
      const before = await readFile(`${settingsFile}.local.yaml`, 'utf8')
      expect((await ctx.agentPresets.listPluginEntries(shared)).find(entry => entry.rowId === 'alpha')?.enabled).toBe(false)
      expect((await ctx.agentPresets.listPluginEntries(local)).find(entry => entry.rowId === 'alpha')?.enabled).toBe(true)
      shared.setLayerEnabled(false)
      await ctx.agentPresets.setPluginEnabled('agent-preset:standard:alpha', true, shared)
      expect(await readFile(`${settingsFile}.shared.yaml`, 'utf8')).toContain('alpha: true')
      expect(await readFile(`${settingsFile}.shared.yaml`, 'utf8')).not.toContain('beta:')
      expect(await readFile(`${settingsFile}.local.yaml`, 'utf8')).toBe(before)
      expect(ctx.settings.get(NS)).toMatchObject({ pluginEnablement: {} })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('lists nested leaves, skips broken presets, and restores inherited enablement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hydra-preset-leaves-'))
    await mkdir(join(root, 'grouped'))
    await mkdir(join(root, 'broken'))
    await writeFile(join(root, 'grouped', COMPOSITION_FILE), [
      '- name: group', '  group: true', '  config:',
      '    - id: nested', '      name: fixture', '      disabled: true',
      '    - name: anonymous', '',
    ].join('\n'))
    const { ctx } = await harness([{ path: root, trust: 'user' }])
    try {
      const leaves = await ctx.agentPresets.listPluginEntries()
      expect(leaves.filter(entry => entry.presetId === 'grouped')).toEqual([
        { entryId: 'agent-preset:grouped:nested', presetId: 'grouped', rowId: 'nested', moduleName: 'fixture', enabled: false },
      ])
      await ctx.agentPresets.setPluginEnabled('agent-preset:grouped:nested', false)
      await expect(ctx.agentPresets.setPluginEnabled('missing', true)).rejects.toThrow('was not found')
      await ctx.agentPresets.setPluginEnabled('agent-preset:grouped:nested', true)
      await ctx.settings.update(NS, { default: 'minimal' })
      await ctx.settings.replace(NS, {})
      expect((await ctx.agentPresets.listPluginEntries()).find(entry => entry.rowId === 'nested')?.enabled).toBe(false)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it.each(['{}\n', ': invalid: ['])('omits a composition changed after discovery: %s', async (content) => {
    const root = await mkdtemp(join(tmpdir(), 'hydra-preset-race-'))
    await mkdir(join(root, 'changing'))
    const path = join(root, 'changing', COMPOSITION_FILE)
    await writeFile(path, '- id: leaf\n  name: fixture\n')
    const { ctx } = await harness([{ path: root, trust: 'user' }])
    const list = ctx.agentPresets.list.bind(ctx.agentPresets)
    vi.spyOn(ctx.agentPresets, 'list').mockImplementationOnce(async () => {
      const entries = await list()
      await writeFile(path, content)
      return entries
    })
    try {
      expect((await ctx.agentPresets.listPluginEntries()).some(entry => entry.presetId === 'changing')).toBe(false)
    } finally {
      vi.restoreAllMocks()
      await ctx.fiber.dispose()
    }
  })

  it('falls back to the composition default while the user set none', async () => {
    const { ctx } = await harness()

    expect(ctx.agentPresets.defaultId).toBe('standard')
  })

  it('takes the user default over the composition default', async () => {
    const { ctx } = await harness()

    await ctx.settings.update(NS, { default: 'minimal' })

    expect(ctx.agentPresets.defaultId).toBe('minimal')
  })

  it('composes a new session from the user default', async () => {
    const { ctx } = await harness()
    await ctx.settings.update(NS, { default: 'minimal' })

    const handle = await ctx.agents.create({
      sessionId: SessionId('settings-default'),
      setup: async (agentCtx: Context) => void await ctx.agentPresets.mount(agentCtx),
    })
    try {
      expect(toolNames(ctx, handle.agent)).toEqual(['beta'])
    } finally {
      await handle.dispose()
    }
  })

  it('leaves a running session on the preset it was composed from', async () => {
    const { ctx } = await harness()
    const running = await ctx.agents.create({
      sessionId: SessionId('settings-running'),
      setup: async (agentCtx: Context) => void await ctx.agentPresets.mount(agentCtx),
    })
    try {
      expect(toolNames(ctx, running.agent)).toEqual(['alpha'])

      // Changing the default mid-flight must not reach an agent that already
      // composed: its history was produced under `standard`'s tools.
      await ctx.settings.update(NS, { default: 'minimal' })

      expect(ctx.agentPresets.defaultId).toBe('minimal')
      expect(toolNames(ctx, running.agent)).toEqual(['alpha'])
    } finally {
      await running.dispose()
    }
  })

  it('applies a preset leaf switch only to sessions created afterwards', async () => {
    const { ctx } = await harness()
    const running = await ctx.agents.create({
      sessionId: SessionId('settings-plugin-running'),
      setup: async (agentCtx: Context) => void await ctx.agentPresets.mount(agentCtx),
    })
    try {
      const alpha = (await ctx.agentPresets.listPluginEntries())
        .find(entry => entry.presetId === 'standard' && entry.rowId === 'alpha')
      expect(alpha).toMatchObject({ enabled: true })

      await ctx.agentPresets.setPluginEnabled(alpha!.entryId, false)
      expect(ctx.settings.get(NS)).toMatchObject({
        pluginEnablement: { standard: { alpha: false } },
      })
      expect(toolNames(ctx, running.agent)).toEqual(['alpha'])

      const later = await ctx.agents.create({
        sessionId: SessionId('settings-plugin-later'),
        setup: async (agentCtx: Context) => void await ctx.agentPresets.mount(agentCtx),
      })
      try {
        expect(toolNames(ctx, later.agent)).toEqual([])
      } finally {
        await later.dispose()
      }
    } finally {
      await running.dispose()
    }
  })

  it('re-inherits the composition default when the user setting is cleared', async () => {
    const { ctx } = await harness()
    await ctx.settings.update(NS, { default: 'minimal' })
    expect(ctx.agentPresets.defaultId).toBe('minimal')

    await ctx.settings.replace(NS, {})

    expect(ctx.agentPresets.defaultId).toBe('standard')
  })

  it('clears a user default it has just deleted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hydra-preset-authored-'))
    await mkdir(join(root, 'mine'))
    await writeFile(
      join(root, 'mine', COMPOSITION_FILE),
      `- id: only\n  name: ${join(FIXTURES, 'plugins', 'contribute.js')}\n  config:\n    tool: only\n`,
    )
    const { ctx } = await harness([{ path: root, trust: 'user' as const }])
    await ctx.settings.update(NS, { default: 'mine' })
    expect(ctx.agentPresets.defaultId).toBe('mine')

    await ctx.agentPresets.remove('mine')

    // Nothing will ever supply that id again, so leaving the setting pointed at
    // it would fail every session created without an explicit pick. Clearing it
    // exposes the deployment's own default underneath.
    expect(ctx.agentPresets.defaultId).toBe('standard')
    expect((await ctx.agentPresets.resolve()).id).toBe('standard')
  })

  it('reports an unknown user default only when a session tries to use it', async () => {
    const { ctx } = await harness()

    // Storing it succeeds — the roster is a live directory, so a name that is
    // absent now may exist by the time a session asks for it.
    await ctx.settings.update(NS, { default: 'no-such-preset' })

    await expect(ctx.agentPresets.resolve())
      .rejects.toThrow(/preset "no-such-preset" not found/)
  })
})

describe('a settings provider that goes away', () => {
  it('falls back to the composition default when the provider unloads', async () => {
    const { ctx, settingsFiber } = await harness()
    await ctx.settings.update(NS, { default: 'minimal' })
    expect(ctx.agentPresets.defaultId).toBe('minimal')

    // Unloading the provider takes the user layer with it; the roster keeps
    // working on its composition default rather than holding a stale override.
    await settingsFiber.dispose()

    expect(ctx.agentPresets.defaultId).toBe('standard')
    const entries = await ctx.agentPresets.listPluginEntries()
    expect(entries.find(entry => entry.rowId === 'alpha')).toMatchObject({ enabled: true })
    await expect(ctx.agentPresets.setPluginEnabled('agent-preset:standard:alpha', false)).rejects.toThrow('settings are unavailable')
  })
})

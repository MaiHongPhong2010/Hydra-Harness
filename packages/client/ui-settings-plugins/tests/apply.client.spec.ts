/** What the browser half registers, and that it all leaves with the fiber. */

import { Context } from '@hydraharness/cordis'
import { describe, expect, it, vi } from 'vitest'
import { resolveSlotLabel } from '@hydraharness/harness-client-ui-slots'
import { SlotRegistry } from '@hydraharness/harness-client-runtime/client'
import { LocaleRuntime } from '@hydraharness/harness-client-locale/client'
import { TestRemote } from '@hydraharness/harness-client-test-runtime'
import { apply as settingsApply, inject as settingsInject } from '@hydraharness/harness-client-ui-settings/client'
import { apply, inject } from '@hydraharness/harness-client-ui-settings-plugins/client'
import type {
  ConfigurablePluginsTabFace, PluginsSettingsSectionInjected, HooksSettingsFace,
} from '@hydraharness/harness-client-ui-settings-plugins/client'
import type { ImportedMcpSettingsFace, NativeMcpSettingsFace, UserMcpSettingsFace } from '../src/client/McpSettingsTab.tsx'

/**
 * @param served - namespaces the Host describes; omitted answers a failed read,
 * which is what most of these specs want (no card has anything to render).
 */
async function bench(served?: string[], isLoopback = true) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  const describeCredentials = vi.fn(() => Promise.resolve({ rpcId: 'c', result: { ok: false, error: {} } }))
  const describeSettings = vi.fn(() => Promise.resolve(served === undefined
    ? { rpcId: 's', result: { ok: false, error: {} } }
    : {
      rpcId: 's',
      result: {
        ok: true,
        value: {
          writable: true,
          hasDocument: true,
          namespaces: served.map(ns => ({
            ns, schema: {}, value: {}, applies: 'live', secrets: [], revision: 0,
          })),
        },
      },
    }))
  // The section binds its scopes through the Settings surface's service, and
  // forwarded Host events reach it through the same `$dispatch` handoff the
  // connection sink makes.
  new TestRemote(ctx)
  const inventory = { entries: [] }
  const imported = { plugins: [] }
  const listInventory = vi.fn(async () => ({ ok: true as const, value: inventory }))
  const setInventoryEnabled = vi.fn(async () => ({ ok: true as const, value: inventory }))
  const listImported = vi.fn(async () => ({ ok: true as const, value: imported }))
  const setImportedEnabled = vi.fn(async () => ({ ok: true as const, value: imported }))
  const setImportedToolApproval = vi.fn(async () => ({ ok: true as const, value: imported }))
  const pluginInventory = {
    list: listInventory,
    setEnabled: setInventoryEnabled,
    listImportedPlugins: listImported,
    setPluginMcpServerEnabled: setImportedEnabled,
    setPluginMcpToolApproval: setImportedToolApproval,
    listMcpServers: vi.fn(async () => ({ ok: true as const, value: { servers: [] } })),
    defineMcpServer: vi.fn(async () => ({ ok: true as const, value: { servers: [] } })),
    setMcpServerEnabled: vi.fn(async () => ({ ok: true as const, value: { servers: [] } })),
    removeMcpServer: vi.fn(async () => ({ ok: true as const, value: { servers: [] } })),
    listHookRecords: vi.fn(async () => ({ ok: true as const, value: { records: [] } })),
    defineHookRecord: vi.fn(async () => ({ ok: true as const, value: { records: [] } })),
    setHookRecordEnabled: vi.fn(async () => ({ ok: true as const, value: { records: [] } })),
    removeHookRecord: vi.fn(async () => ({ ok: true as const, value: { records: [] } })),
  }
  ctx.provide('remote.pluginInventory', pluginInventory as never)
  const remote = ctx.get('remote') as unknown as { pluginInventory?: typeof pluginInventory }
  remote.pluginInventory = pluginInventory
  ctx.provide('connection', {
    isLoopback,
    api: {
      settings: { describe: describeSettings },
      credentials: { describe: describeCredentials },
      webSearch: { providers: async () => ({ result: { ok: true, value: { providers: [{ id: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'web-search-deepseek', credentialRef: 'DEEPSEEK_API_KEY', fields: [{ key: 'apiKeyEnv', kind: 'text' }] }] } } }) },
    },
  } as never)
  await ctx.plugin({ inject: [...settingsInject], apply: settingsApply }).await()
  return {
    ctx, slots: ctx.get('slots') as SlotRegistry, describeCredentials, describeSettings,
    listInventory, setInventoryEnabled,
    pluginInventory,
  }
}

function declareRoot(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: { 'settings.section': { kind: 'list', scope: 'root' } },
  } as never, () => null)
}

describe('ui-settings-plugins apply', () => {
  it.each([false, true])('routes local registry controls and preserves Host errors (failure: %s)', async (failure) => {
    const { ctx, slots, pluginInventory } = await bench()
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    const mcp = (slots.entries('settings.plugins.tab').find(entry => entry.options.id === 'mcp')!.inject as unknown as
      () => ImportedMcpSettingsFace & NativeMcpSettingsFace & UserMcpSettingsFace)()
    const hooks = (slots.entries('settings.plugins.tab').find(entry => entry.options.id === 'hooks')!.inject as unknown as () => HooksSettingsFace)()
    if (failure) for (const method of Object.values(pluginInventory)) method.mockResolvedValue({ ok: false, error: { code: 'unavailable', message: 'Host unavailable' } } as never)
    const requests: Array<[() => Promise<unknown>, keyof typeof pluginInventory, unknown]> = [
      [() => mcp.importedMcp!.list(), 'listImportedPlugins', undefined],
      [() => mcp.importedMcp!.setEnabled('plugin', 'server', true), 'setPluginMcpServerEnabled', { identity: 'plugin', server: 'server', enabled: true }],
      [() => mcp.importedMcp!.setToolApproval!('plugin', 'server', 'mcp__plugin__read', 'deny'), 'setPluginMcpToolApproval', { identity: 'plugin', server: 'server', tool: 'mcp__plugin__read', approval: 'deny' }],
      [() => mcp.nativeMcp!.list(), 'list', {}],
      [() => mcp.userMcp!.list(), 'listMcpServers', {}],
      [() => mcp.userMcp!.define({ mode: 'create', name: 'server', transport: 'stdio', command: 'node' }), 'defineMcpServer', { mode: 'create', name: 'server', transport: 'stdio', command: 'node' }],
      [() => mcp.userMcp!.setEnabled('server', true), 'setMcpServerEnabled', { name: 'server', enabled: true }],
      [() => mcp.userMcp!.remove('server'), 'removeMcpServer', 'server'],
      [() => hooks.userHooks!.list(), 'listHookRecords', {}],
      [() => hooks.userHooks!.define({ mode: 'create', name: 'hook', dialect: 'codex', config: {} }), 'defineHookRecord', { mode: 'create', name: 'hook', dialect: 'codex', config: {} }],
      [() => hooks.userHooks!.setEnabled('hook', false), 'setHookRecordEnabled', { name: 'hook', enabled: false }],
      [() => hooks.userHooks!.remove('hook'), 'removeHookRecord', 'hook'],
    ]
    for (const [call, method, payload] of requests) {
      if (failure) await expect(call()).rejects.toThrow(`pluginInventory.${method} failed: unavailable: Host unavailable`)
      else await expect(call()).resolves.toBeDefined()
      if (payload === undefined) expect(pluginInventory[method]).toHaveBeenCalledWith()
      else expect(pluginInventory[method]).toHaveBeenCalledWith(payload)
    }
    await ctx.fiber.dispose()
  })

  it('withholds local MCP and hook management on remote connections', async () => {
    const { ctx, slots } = await bench(undefined, false)
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    const mcp = (slots.entries('settings.plugins.tab').find(entry => entry.options.id === 'mcp')!.inject as unknown as () => UserMcpSettingsFace)()
    const hooks = (slots.entries('settings.plugins.tab').find(entry => entry.options.id === 'hooks')!.inject as unknown as () => HooksSettingsFace)()
    expect(mcp).not.toHaveProperty('userMcp')
    expect(mcp).not.toHaveProperty('nativeMcp')
    expect(mcp).not.toHaveProperty('importedMcp')
    expect(hooks.userHooks).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('declares the services it uses', () => {
    expect(inject).toEqual(['slots', 'locale', 'connection', 'remote', 'remote.pluginInventory', 'settingsScope'])
  })

  it('registers one Plugins section and declares the tab and card slots', async () => {
    const { ctx, slots } = await bench()
    declareRoot(slots)

    await ctx.plugin({ inject: [...inject], apply }).await()

    const section = slots.entries('settings.section').find(entry => entry.options.id === 'plugins')!
    expect(section.options).toMatchObject({ id: 'plugins', order: 15 })
    // The nav label is a locale-following thunk; owners resolve it at read time.
    expect(resolveSlotLabel(section.options.label)).toBe('Plugins')
    expect(slots.spec('settings.plugins.tab')).toMatchObject({ kind: 'list', scope: 'root' })
    const tabs = slots.entries('settings.plugins.tab')
    expect(tabs[0]?.options).toMatchObject({ id: 'configurable', order: 0 })
    expect(resolveSlotLabel(tabs[0]!.options.label)).toBe('Configuration')
    expect(tabs[1]?.options).toMatchObject({ id: 'mcp', order: 5 })
    expect(resolveSlotLabel(tabs[1]!.options.label)).toBe('MCP')
    expect(tabs[2]?.options).toMatchObject({ id: 'hooks', order: 25 })
    expect(resolveSlotLabel(tabs[2]!.options.label)).toBe('Hooks')
    // The Hooks tab declares and renders the imported catalogs' child slot.
    expect(slots.spec('settings.plugins.hooks.item')).toMatchObject({ kind: 'list', scope: 'root' })
    expect(slots.spec('settings.plugin.item')).toMatchObject({ kind: 'keyed', scope: 'root' })
    const search = slots.entries('settings.section').find(entry => entry.options.id === 'web-search')!
    expect(resolveSlotLabel(search.options.label)).toBe('Web Search')
    expect((search.inject as unknown as () => { hooks: object })().hooks).toHaveProperty('webSearchCard')
    slots.register({ name: 'settings.plugins.tab', id: 'unordered' } as never, () => null)
    const face = (section.inject as unknown as () => PluginsSettingsSectionInjected)()
    expect(face.hooks.tabs.getSnapshot()).toContainEqual({ id: 'unordered', order: 0, label: '' })
  })


  it('injects a live tab projection, the card directory, and one business face per card', async () => {
    const { ctx, slots, listInventory, setInventoryEnabled } = await bench()
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()

    const section = slots.entries('settings.section').find(entry => entry.options.id === 'plugins')!
    const sectionFace = (section.inject as unknown as () => PluginsSettingsSectionInjected)()
    const initialTabs = sectionFace.hooks.tabs.getSnapshot()
    expect(initialTabs).toEqual([
      { id: 'configurable', order: 0, label: 'Configuration' },
      { id: 'mcp', order: 5, label: 'MCP' },
      { id: 'hooks', order: 25, label: 'Hooks' },
    ])
    expect(sectionFace.hooks.tabs.getSnapshot()).toBe(initialTabs)

    const mcp = slots.entries('settings.plugins.tab').find(entry => entry.options.id === 'mcp')!
    const mcpFace = (mcp.inject as unknown as () => {
      nativeMcp?: { list: () => Promise<unknown> }
    })()
    if (mcpFace.nativeMcp === undefined) throw new Error('expected local native MCP controls')
    await expect(mcpFace.nativeMcp.list()).resolves.toEqual({ entries: [] })
    expect(listInventory).toHaveBeenCalledOnce()
    expect(setInventoryEnabled).not.toHaveBeenCalled()

    const listener = vi.fn()
    const unsubscribe = sectionFace.hooks.tabs.subscribe(listener)
    slots.register({ name: 'settings.plugins.tab', id: 'plain', order: 30 } as never, () => null)
    expect(sectionFace.hooks.tabs.getSnapshot()).toEqual([
      { id: 'configurable', order: 0, label: 'Configuration' },
      { id: 'mcp', order: 5, label: 'MCP' },
      { id: 'hooks', order: 25, label: 'Hooks' },
      { id: 'plain', order: 30, label: '' },
    ])
    unsubscribe()

    const tab = slots.entries('settings.plugins.tab')[0]!
    const tabFace = (tab.inject as unknown as () => ConfigurablePluginsTabFace)()
    expect(Object.keys(tabFace.hooks)).toEqual(['configurablePlugins'])
    for (const entry of slots.entries('settings.plugin.item')) {
      const face = (entry as { inject?: () => unknown }).inject?.() as { hooks: Record<string, unknown> }
      // Each card injects exactly one snapshot store plus its own actions.
      expect(Object.keys(face.hooks)).toHaveLength(1)
    }
  })

  it('keys each card it ships on the settings namespace that card edits', async () => {
    const { ctx, slots } = await bench()
    declareRoot(slots)

    await ctx.plugin({ inject: [...inject], apply }).await()

    expect(slots.entries('settings.plugin.item').map(entry => entry.options.key))
      .toEqual(['shell', 'agent-loop', 'page-memory'])
  })

  it('dispatches the served namespaces its cards claim, and no others', async () => {
    // ui-theme is served but belongs to another surface, and a deployment
    // composing no PowerShell/POSIX executor serves no `bash` at all.
    const { ctx, slots } = await bench(['agent-loop', 'ui-theme', 'web-search-deepseek'])
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()

    const tab = slots.entries('settings.plugins.tab')[0]!
    const face = (tab.inject as unknown as () => ConfigurablePluginsTabFace)()
    await vi.waitFor(() => {
      expect(face.hooks.configurablePlugins.getSnapshot().namespaces)
        .toEqual(['agent-loop'])
    })
  })

  it('re-reads the served namespaces when the Host commits a settings document', async () => {
    // Which namespaces the Host serves is a registration fact the wire never
    // announces on its own, so the tab rides the invalidation that can
    // accompany a changed composition.
    const { ctx, slots, describeSettings } = await bench(['bash'])
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    await vi.waitFor(() => { expect(describeSettings).toHaveBeenCalled() })
    describeSettings.mockClear()

    ctx.remote.$dispatch('settings/document-updated', ['bash', 1])

    await vi.waitFor(() => { expect(describeSettings).toHaveBeenCalled() })
  })

  it('re-reads the served namespaces after a reconnect', async () => {
    const { ctx, slots, describeSettings } = await bench(['bash'])
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    await vi.waitFor(() => { expect(describeSettings).toHaveBeenCalled() })
    describeSettings.mockClear()

    ctx.emit('connection/reset')

    await vi.waitFor(() => { expect(describeSettings).toHaveBeenCalled() })
  })

  it('re-reads the credential when the Host reports the watched reference changed', async () => {
    const { ctx, slots, describeCredentials } = await bench()
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    await vi.waitFor(() => { expect(describeCredentials).toHaveBeenCalled() })
    describeCredentials.mockClear()

    // A key written on another surface changes no settings section, so this
    // event is the only thing that reaches the card.
    ctx.remote.$dispatch('credentials/reference-updated', ['DEEPSEEK_API_KEY'])

    await vi.waitFor(() => { expect(describeCredentials).toHaveBeenCalledTimes(1) })
  })

  it('re-reads the Obsidian credential from the MCP tab', async () => {
    const { ctx, slots, describeCredentials } = await bench()
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    await vi.waitFor(() => { expect(describeCredentials).toHaveBeenCalled() })
    describeCredentials.mockClear()

    ctx.remote.$dispatch('credentials/reference-updated', ['OBSIDIAN_API_KEY'])

    await vi.waitFor(() => { expect(describeCredentials).toHaveBeenCalledTimes(1) })
  })

  it('ignores a credential change for a reference no card watches', async () => {
    const { ctx, slots, describeCredentials } = await bench()
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    await vi.waitFor(() => { expect(describeCredentials).toHaveBeenCalled() })
    describeCredentials.mockClear()

    ctx.remote.$dispatch('credentials/reference-updated', ['SOME_OTHER_KEY'])
    await Promise.resolve()

    expect(describeCredentials).not.toHaveBeenCalled()
  })

  it('registers into a declaration that arrives after apply', async () => {
    const { ctx, slots } = await bench()
    await ctx.plugin({ inject: [...inject], apply }).await()

    declareRoot(slots)

    await vi.waitFor(() => { expect(slots.entries('settings.section')).toHaveLength(2) })
  })

  it('collapses every contribution on teardown', async () => {
    const { ctx, slots } = await bench()
    declareRoot(slots)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(slots.entries('settings.plugin.item')).toHaveLength(3)

    await fiber.dispose()

    expect(slots.entries('settings.section')).toHaveLength(0)
    expect(slots.spec('settings.plugins.tab')).toBeUndefined()
    expect(slots.spec('settings.plugin.item')).toBeUndefined()
  })
})

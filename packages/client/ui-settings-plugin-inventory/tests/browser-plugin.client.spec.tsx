// @vitest-environment jsdom
import { Context } from '@hydraharness/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { LocaleRuntime } from '@hydraharness/harness-client-locale/client'
import { createSnapshotStore, SlotRegistry, type ISessions } from '@hydraharness/harness-client-runtime/client'
import type { ConnectionHandle, ImportedPluginSnapshot, PluginInventorySnapshot } from '@hydraharness/harness-api-remotes/client'
import type { SettingsTarget } from '@hydraharness/harness-client-ui-settings/client'
import { resolveSlotLabel } from '@hydraharness/harness-client-ui-slots'
import { usePinnedBrowserLanguages, stubSettingsScope } from '@hydraharness/harness-client-test-runtime'
import { TestRemote } from '@hydraharness/harness-client-test-runtime'
import { apply, inject } from '../src/client/index.ts'
import { ImportedPluginCapabilitiesTab, type ImportedPluginCapabilitiesTabInjected } from '../src/client/ImportedPluginCapabilitiesTab.tsx'
import { MarketplaceSettingsTab } from '../src/client/MarketplaceSettingsTab.tsx'
import type { MarketplaceSettingsTabInjected } from '../src/client/MarketplaceSettingsTab.tsx'
import { PluginInventorySettingsTab } from '../src/client/PluginInventorySettingsTab.tsx'
import type { PluginInventorySettingsTabInjected } from '../src/client/PluginInventorySettingsTab.tsx'

usePinnedBrowserLanguages('en-US')
afterEach(cleanup)

const EMPTY_MARKETPLACES = { marketplaces: [] }
const EMPTY_IMPORTED: ImportedPluginSnapshot = { plugins: [] }
const EMPTY_NATIVE: PluginInventorySnapshot = { entries: [] }
type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

async function bench(isLoopback = true) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  const events = new TestRemote(ctx)
  const list = vi.fn<() => Promise<Result<typeof EMPTY_NATIVE>>>().mockResolvedValue({ ok: true, value: EMPTY_NATIVE })
  const setEnabled = vi.fn<() => Promise<Result<{ snapshot: PluginInventorySnapshot; restartRequired: boolean }>>>()
    .mockResolvedValue({ ok: true, value: { snapshot: EMPTY_NATIVE, restartRequired: false } })
  const listMarketplaces = vi.fn<() => Promise<Result<typeof EMPTY_MARKETPLACES>>>()
    .mockResolvedValue({ ok: true, value: EMPTY_MARKETPLACES })
  const addMarketplace = vi.fn<() => Promise<Result<typeof EMPTY_MARKETPLACES>>>()
    .mockResolvedValue({ ok: true, value: EMPTY_MARKETPLACES })
  const removeMarketplace = vi.fn<() => Promise<Result<typeof EMPTY_MARKETPLACES>>>()
    .mockResolvedValue({ ok: true, value: EMPTY_MARKETPLACES })
  const setMarketplaceEnabled = vi.fn<() => Promise<Result<typeof EMPTY_MARKETPLACES>>>()
    .mockResolvedValue({ ok: true, value: EMPTY_MARKETPLACES })
  const listImportedPlugins = vi.fn<() => Promise<Result<typeof EMPTY_IMPORTED>>>().mockResolvedValue({ ok: true, value: EMPTY_IMPORTED })
  const importPlugin = vi.fn<() => Promise<Result<typeof EMPTY_IMPORTED>>>().mockResolvedValue({ ok: true, value: EMPTY_IMPORTED })
  const enablePlugin = vi.fn<() => Promise<Result<typeof EMPTY_IMPORTED>>>().mockResolvedValue({ ok: true, value: EMPTY_IMPORTED })
  const disablePlugin = vi.fn<() => Promise<Result<typeof EMPTY_IMPORTED>>>().mockResolvedValue({ ok: true, value: EMPTY_IMPORTED })
  const trustPlugin = vi.fn<() => Promise<Result<typeof EMPTY_IMPORTED>>>().mockResolvedValue({ ok: true, value: EMPTY_IMPORTED })
  const untrustPlugin = vi.fn<() => Promise<Result<typeof EMPTY_IMPORTED>>>().mockResolvedValue({ ok: true, value: EMPTY_IMPORTED })
  const removePlugin = vi.fn<() => Promise<Result<typeof EMPTY_IMPORTED>>>().mockResolvedValue({ ok: true, value: EMPTY_IMPORTED })
  ctx.provide('connection', { isLoopback, api: { skills: { list: vi.fn(async () => ({ result: { ok: true, value: { skills: [] } } })) } } } as never)
  ctx.provide('sessions', {
    list: { getSnapshot: () => ({ current: undefined }), subscribe: () => () => {} },
    subagentAddress: vi.fn(() => undefined),
  } as never)
  const remote = { list, setEnabled, listMarketplaces, addMarketplace, removeMarketplace, setMarketplaceEnabled,
    listImportedPlugins, importPlugin, enablePlugin, disablePlugin, trustPlugin, untrustPlugin, removePlugin }
  ctx.provide('remote.pluginInventory', remote)
  Object.assign(events, { pluginInventory: remote })
  const selection = createSnapshotStore({ target: {}, loading: false, error: null })
  const policy = stubSettingsScope<{ enabled: boolean }>()
  policy.publish({ value: { enabled: true }, status: 'ready', writable: true })
  const settingsScope = { bind: () => policy.scope, selection: () => selection, describe: () => ({ ensure: async () => {},
    getSnapshot: () => ({ view: { namespaces: [] } }), acceptView: () => {} }) }
  ctx.provide('settingsScope', settingsScope as never)
  return { ctx, slots: ctx.get('slots') as SlotRegistry, locale, selection, settingsScope, ...remote }
}

function declare(slots: SlotRegistry): () => void {
  return slots.register({ name: 'root', children: {
    'settings.plugins.tab': { kind: 'list', scope: 'root' },
    // The real owner of this key is the Hooks tab in ui-settings-plugins; the
    // root stub declares it so this package's contribution has a seat.
    'settings.plugins.hooks.item': { kind: 'list', scope: 'root' },
  } } as never, () => null)
}

describe('ui-settings-plugin-inventory browser plugin', () => {
  it('captures workspace enablement writes and resets only its selected document', async () => {
    const b = await bench()
    const entryId = 'agent-preset:standard:tool' as never
    const target: SettingsTarget = { workspaceId: 'workspace-a' as never, layer: 'shared' }
    let namespace = { ...target, ns: 'agent-presets', revision: 3, user: { pluginEnablement: { standard: { tool: false } } } as unknown }
    const mirror = { ensure: async () => {}, getSnapshot: () => ({ view: { namespaces: [namespace] } }),
      acceptView: (view: typeof namespace) => { namespace = view } }
    Object.assign(b.settingsScope, { describe: () => mirror })
    const mutate = vi.fn(async () => ({ rpcId: 'r', result: { ok: true, value: { ...namespace, revision: 4, user: undefined } } }))
    Object.assign((b.ctx.get('connection') as ConnectionHandle).api, { settings: { mutate } })
    const snapshot = { entries: [{ entryId, presetId: 'standard', presetRowId: 'tool', moduleName: 'tool',
      enabled: true, toggleable: true, restartRequired: false, fiberPhase: null }] }
    b.list.mockResolvedValue({ ok: true, value: snapshot })
    b.setEnabled.mockResolvedValue({ ok: true, value: { snapshot, restartRequired: false } })
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    b.selection.set({ target, loading: false, error: null })
    const entry = b.slots.entries('settings.plugins.tab').find(entry => entry.options.id === 'all')!
    const face = (entry.inject as unknown as () => PluginInventorySettingsTabInjected)()
    await face.nativePlugins!.list()
    expect(b.list).toHaveBeenLastCalledWith(target)
    await face.nativePlugins!.setEnabled(entryId, false)
    await face.savePlugins()
    expect(b.setEnabled).toHaveBeenLastCalledWith({ ...target, entryId, enabled: false })
    expect(face.nativePlugins!.overridden?.(entryId)).toBe(true)
    await face.nativePlugins!.reset!(entryId)
    expect(mutate).toHaveBeenCalledWith({ ...target, ns: 'agent-presets', expectedRevision: 3,
      ops: [{ op: 'unset', path: ['pluginEnablement', 'standard', 'tool'] }] })
    expect(face.nativePlugins!.overridden?.(entryId)).toBe(false)
    expect(face.importedPlugins).toBeUndefined()
    b.selection.set({ target: { workspaceId: 'workspace-b' as never, layer: 'local' }, loading: false, error: null })
    const other = (entry.inject as unknown as () => PluginInventorySettingsTabInjected)()
    await other.nativePlugins!.list()
    expect(b.list).toHaveBeenLastCalledWith({ workspaceId: 'workspace-b', layer: 'local' })
    await b.ctx.fiber.dispose()
  })
  it.each([false, true])('routes marketplace and imported-plugin controls (failure: %s)', async (failure) => {
    const b = await bench()
    declare(b.slots)
    let earlyPending: boolean | undefined
    const stop = b.slots.subscribe('settings.plugins.tab', () => {
      const entry = b.slots.entries('settings.plugins.tab').find(entry => entry.options.id === 'marketplace')
      if (entry !== undefined) {
        earlyPending = (entry.inject as unknown as () => MarketplaceSettingsTabInjected)().hasPendingImportedChanges?.()
      }
    })
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    stop()
    const market = (b.slots.entries('settings.plugins.tab').find(entry => entry.options.id === 'marketplace')!.inject as unknown as () => MarketplaceSettingsTabInjected)()
    const hooks = (b.slots.entries('settings.plugins.hooks.item')[0]!.inject as unknown as () => ImportedPluginCapabilitiesTabInjected)()
    expect(earlyPending).toBe(false)
    expect(market.hasPendingImportedChanges?.()).toBe(false)
    const requests: Array<[() => Promise<unknown>, keyof typeof b, unknown]> = [
      [() => market.listMarketplaces(), 'listMarketplaces', undefined],
      [() => market.addMarketplace({ source: 'owner/repo' }), 'addMarketplace', { source: 'owner/repo' }],
      [() => market.removeMarketplace('owner/repo'), 'removeMarketplace', 'owner/repo'],
      [() => market.setMarketplaceEnabled({ source: 'owner/repo', enabled: false }), 'setMarketplaceEnabled', { source: 'owner/repo', enabled: false }],
      [() => market.importedPlugins.list(), 'listImportedPlugins', undefined],
      [() => market.importedPlugins.import('owner/repo'), 'importPlugin', 'owner/repo'],
      [() => market.importedPlugins.enable('plugin'), 'enablePlugin', 'plugin'],
      [() => market.importedPlugins.disable('plugin'), 'disablePlugin', 'plugin'],
      [() => market.importedPlugins.remove('plugin'), 'removePlugin', 'plugin'],
      [() => hooks.trust!('plugin'), 'trustPlugin', 'plugin'],
      [() => hooks.untrust!('plugin'), 'untrustPlugin', 'plugin'],
    ]
    for (const [call, key, payload] of requests) {
      const method = b[key]
      if (!vi.isMockFunction(method)) throw new Error(`missing mock ${key}`)
      if (failure) method.mockResolvedValueOnce({ ok: false, error: { code: 'unavailable', message: 'Host unavailable' } })
      if (failure) await expect(call()).rejects.toThrow(`pluginInventory.${key} failed: unavailable: Host unavailable`)
      else await expect(call()).resolves.toBeDefined()
      if (payload === undefined) expect(method).toHaveBeenCalledWith()
      else expect(method).toHaveBeenCalledWith(payload)
    }
    await b.ctx.fiber.dispose()
  })

  it.each([false, true])('saves native drafts through the Host and exposes failures (failure: %s)', async (failure) => {
    const b = await bench()
    b.list.mockResolvedValue({ ok: true, value: { entries: [{ entryId: 'native' as never, moduleName: 'native',
      enabled: true, toggleable: true, restartRequired: false, fiberPhase: 'active' }] } })
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const face = (b.slots.entries('settings.plugins.tab').find(entry => entry.options.id === 'all')!.inject as unknown as () => PluginInventorySettingsTabInjected)()
    await face.nativePlugins!.list()
    await face.nativePlugins!.setEnabled('native' as never, false)
    if (failure) b.setEnabled.mockResolvedValueOnce({ ok: false, error: { code: 'unavailable', message: 'Host unavailable' } })
    await face.savePlugins()
    expect(b.setEnabled).toHaveBeenCalledWith({ entryId: 'native', enabled: false })
    expect(face.hooks.pluginDrafts.getSnapshot().error).toBe(failure ? 'pluginInventory.setEnabled failed: unavailable: Host unavailable' : null)
    face.discardPluginChanges()
    b.list.mockResolvedValueOnce({ ok: false, error: { code: 'unavailable', message: 'Host unavailable' } })
    await expect(face.nativePlugins!.list()).rejects.toThrow('pluginInventory.list failed')
    await b.ctx.fiber.dispose()
  })

  it('loads native skills only for a selected root session and propagates RPC failures', async () => {
    const b = await bench()
    const sessions = b.ctx.get('sessions') as ISessions
    const selection = createSnapshotStore({ current: 's' as never })
    Object.assign(sessions, { list: selection })
    const api = (b.ctx.get('connection') as ConnectionHandle).api
    const skills = vi.spyOn(api.skills, 'list').mockResolvedValue({ rpcId: 'r' as never, result: { ok: true, value: { skills: [{ name: 'test', description: 'Test', modelInvocable: true }] } } })
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const face = (b.slots.entries('settings.plugins.tab').find(entry => entry.options.id === 'skills')!.inject as unknown as () => ImportedPluginCapabilitiesTabInjected)()
    expect(await face.nativeSkills!.list()).toMatchObject({ sessionId: 's', skills: [{ name: 'test' }] })
    skills.mockResolvedValueOnce({ rpcId: 'r' as never, result: { ok: false, error: { code: 'internal', message: 'unavailable', details: {} } } })
    await expect(face.nativeSkills!.list()).rejects.toThrow('skill.list failed: internal: unavailable')
    vi.spyOn(sessions, 'subagentAddress').mockReturnValue({ parentSessionId: 'p' as never, childSessionId: 's' as never, mode: 'one-shot' })
    expect(await face.nativeSkills!.list()).toEqual({ skills: [] })
    await b.ctx.fiber.dispose()
  })

  it('declares only the services used by the Settings Remote contribution', () => {
    expect(inject).toEqual(['slots', 'locale', 'connection', 'sessions', 'remote', 'remote.pluginInventory', 'settingsScope'])
  })

  it('registers separate Plugins, Skills, and Marketplace tabs plus the Hooks child catalog', async () => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()

    const entries = b.slots.entries('settings.plugins.tab')
    expect(entries.map(entry => entry.options.id)).toEqual(['all', 'skills', 'marketplace'])
    expect(entries.find(entry => entry.options.id === 'all')?.component).toBe(PluginInventorySettingsTab)
    expect(entries.find(entry => entry.options.id === 'skills')?.component).toBe(ImportedPluginCapabilitiesTab)
    const marketplace = entries.find(entry => entry.options.id === 'marketplace')
    expect(marketplace?.component).toBe(MarketplaceSettingsTab)
    expect(resolveSlotLabel(entries[0]?.options.label)).toBe('Plugins')
    expect(resolveSlotLabel(entries.find(entry => entry.options.id === 'skills')?.options.label)).toBe('Skills')
    expect(resolveSlotLabel(marketplace?.options.label)).toBe('Marketplace')

    // The imported hooks catalog contributes to the Hooks tab's child slot.
    const hookItems = b.slots.entries('settings.plugins.hooks.item')
    expect(hookItems.map(entry => entry.options.id)).toEqual(['imported-hooks'])
    expect(hookItems[0]?.component).toBe(ImportedPluginCapabilitiesTab)

    const plugins = (entries.find(entry => entry.options.id === 'all')?.inject as unknown as () => PluginInventorySettingsTabInjected)()
    if (plugins.nativePlugins === undefined) throw new Error('expected local native plugin controls')
    await expect(plugins.nativePlugins.list()).resolves.toEqual(EMPTY_NATIVE)
    expect(b.list).toHaveBeenCalledOnce()
    expect(b.list).toHaveBeenCalledWith({})
    if (plugins.importedPlugins === undefined) throw new Error('expected local imported plugin controls')
    await expect(plugins.importedPlugins.list()).resolves.toEqual(EMPTY_IMPORTED)
    expect(b.listImportedPlugins).toHaveBeenCalledOnce()

    const skills = (entries.find(entry => entry.options.id === 'skills')?.inject as unknown as () => { nativeSkills?: { list: () => Promise<unknown> } })()
    await expect(skills.nativeSkills?.list()).resolves.toEqual({ skills: [] })

    const marketplaceInjected = marketplace?.inject as unknown as () => MarketplaceSettingsTabInjected
    const marketplaceControls = marketplaceInjected()
    await expect(marketplaceControls.importedPlugins.import('https://github.com/example/plugin.git')).resolves.toEqual(EMPTY_IMPORTED)
    expect(b.importPlugin).toHaveBeenCalledWith('https://github.com/example/plugin.git')
    await expect(marketplaceControls.removeMarketplace('https://github.com/example/plugins.git')).resolves.toEqual(EMPTY_MARKETPLACES)
    expect(b.removeMarketplace).toHaveBeenCalledWith('https://github.com/example/plugins.git')
    await b.ctx.fiber.dispose()
  })

  it('does not expose local marketplace or plugin controls over a remote connection', async () => {
    const b = await bench(false)
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const stop = declare(b.slots)
    await vi.waitFor(() => { expect(b.slots.entries('settings.plugins.tab')).toHaveLength(1) })
    expect(b.slots.entries('settings.plugins.tab')[0]?.options.id).toBe('all')
    expect(resolveSlotLabel(b.slots.entries('settings.plugins.tab')[0]?.options.label)).toBe('Plugins')
    const face = (b.slots.entries('settings.plugins.tab')[0]!.inject as unknown as () => PluginInventorySettingsTabInjected)()
    expect(face.nativePlugins).toBeUndefined()
    expect(face.importedPlugins).toBeUndefined()
    stop()
    await fiber.dispose()
    await b.ctx.fiber.dispose()
  })
})

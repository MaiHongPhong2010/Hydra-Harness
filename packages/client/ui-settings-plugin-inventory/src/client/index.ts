/** Host plugin inventory and enablement controls registered into Web Settings. */

import type {} from '@hydraharness/harness-client-locale/client'
import type { ClientContext, ISessions } from '@hydraharness/harness-client-runtime/client'
import { createSnapshotStore } from '@hydraharness/harness-client-runtime/client'
import type { ConnectionHandle } from '@hydraharness/harness-client-connection/client'
import type { HostObservable } from '@hydraharness/harness-client-ui-slots'
import type { SettingsTarget } from '@hydraharness/harness-client-ui-settings/client'
import { MarketplaceSettingsTab, type MarketplaceSettingsTabInjected } from './MarketplaceSettingsTab.tsx'
import { ImportedPluginCapabilitiesTab, type ImportedPluginCapabilitiesTabInjected, type NativeSkillControls } from './ImportedPluginCapabilitiesTab.tsx'
import {
  PluginInventorySettingsTab,
  type ImportedPluginControls,
  type NativePluginControls,
} from './PluginInventorySettingsTab.tsx'
import { en, type PluginInventoryLocaleKey } from './locales.ts'
import { PluginInventoryController } from './inventory-controller.ts'
import { OptionalPluginsRow, type OptionalPluginsRowInjected } from './OptionalPluginsRow.tsx'

export type {
  ImportedPluginControls,
  NativePluginControls,
  PluginInventorySettingsTabProps,
} from './PluginInventorySettingsTab.tsx'
export type { ImportedPluginCapabilitiesTabInjected, ImportedPluginCapabilitiesTabProps, NativeSkillControls } from './ImportedPluginCapabilitiesTab.tsx'
export type { MarketplaceSettingsTabInjected, MarketplaceSettingsTabProps } from './MarketplaceSettingsTab.tsx'
export type { PluginInventoryLocaleKey } from './locales.ts'

declare module '@hydraharness/harness-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Host plugin inventory copy and mutation labels. */
    'settings.pluginInventory': PluginInventoryLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.pluginInventory'

/** Services required by the Settings registration and generated Remote face. */
export const inject = ['slots', 'locale', 'connection', 'sessions', 'remote', 'remote.pluginInventory', 'settingsScope']

/** Contribute the lazy plugin and marketplace tabs to the Plugins settings section. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { en }), 'ui-settings-plugin-inventory: dictionaries')

  const t = ctx.locale.bind(NS)
  const policy = ctx.settingsScope.bind<{ enabled: boolean }>({ namespace: 'optional-plugins' })
  ctx.slots.inject('settings.general.general.item', () => ctx.slots.register({
    name: 'settings.general.general.item', id: 'optional-plugins', order: 90, label: () => t('optional.title'), locale: NS,
    inject: (): OptionalPluginsRowInjected => ({ save: async (enabled) => {
      if (!policy.getSnapshot().writable) throw new Error('Settings are read only')
      await policy.set('enabled', enabled)
      if (policy.getSnapshot().value?.enabled !== enabled) throw new Error('Could not save plugin policy. Try again.')
    }, hooks: { policy } }),
  }, OptionalPluginsRow))
  const connection = ctx.get('connection') as ConnectionHandle
  const sessions = ctx.get('sessions') as ISessions
  const currentSession: HostObservable<{ readonly current: string | undefined }> = sessions.list
  const nativeSkills: NativeSkillControls = {
    currentSession,
    list: async () => {
      const sessionId = sessions.list.getSnapshot().current
      if (sessionId === undefined || sessions.subagentAddress(sessionId) !== undefined) return { skills: [] }
      const { result } = await connection.api.skills.list({ sessionId })
      if (!result.ok) throw new Error(`skill.list failed: ${result.error.code}: ${result.error.message}`)
      return { sessionId, skills: result.value.skills }
    },
  }
  let nativePlugins: NativePluginControls | undefined
  let importedPluginsControls: ImportedPluginControls | undefined
  const inventoryRef: { current?: PluginInventoryController } = {}
  if (connection.isLoopback) {
    const listPlugins = async (target: SettingsTarget = {}) => {
      const result = await ctx.remote.pluginInventory.list(target)
      if (!result.ok) throw new Error(`pluginInventory.list failed: ${result.error.code}: ${result.error.message}`)
      return result.value
    }
    const setPluginEnabled = async (entryId: Parameters<NativePluginControls['setEnabled']>[0], enabled: boolean, target: SettingsTarget = {}) => {
      const result = await ctx.remote.pluginInventory.setEnabled({ entryId, enabled, ...target })
      if (!result.ok) throw new Error(`pluginInventory.setEnabled failed: ${result.error.code}: ${result.error.message}`)
      return result.value
    }
    const listMarketplaces: MarketplaceSettingsTabInjected['listMarketplaces'] = async () => {
      const result = await ctx.remote.pluginInventory.listMarketplaces()
      if (!result.ok) {
        throw new Error(`pluginInventory.listMarketplaces failed: ${result.error.code}: ${result.error.message}`)
      }
      return result.value
    }
    const addMarketplace: MarketplaceSettingsTabInjected['addMarketplace'] = async (request) => {
      const result = await ctx.remote.pluginInventory.addMarketplace(request)
      if (!result.ok) {
        throw new Error(`pluginInventory.addMarketplace failed: ${result.error.code}: ${result.error.message}`)
      }
      return result.value
    }
    const removeMarketplace: MarketplaceSettingsTabInjected['removeMarketplace'] = async (source) => {
      const result = await ctx.remote.pluginInventory.removeMarketplace(source)
      if (!result.ok) throw new Error(`pluginInventory.removeMarketplace failed: ${result.error.code}: ${result.error.message}`)
      return result.value
    }
    const setMarketplaceEnabled: MarketplaceSettingsTabInjected['setMarketplaceEnabled'] = async (request) => {
      const result = await ctx.remote.pluginInventory.setMarketplaceEnabled(request)
      if (!result.ok) {
        throw new Error(`pluginInventory.setMarketplaceEnabled failed: ${result.error.code}: ${result.error.message}`)
      }
      return result.value
    }
    const listImportedPlugins: ImportedPluginControls['list'] = async () => {
      const result = await ctx.remote.pluginInventory.listImportedPlugins()
      if (!result.ok) throw new Error(`pluginInventory.listImportedPlugins failed: ${result.error.code}: ${result.error.message}`)
      return result.value
    }
    const importPlugin: ImportedPluginControls['import'] = async (source) => {
      const result = await ctx.remote.pluginInventory.importPlugin(source)
      if (!result.ok) throw new Error(`pluginInventory.importPlugin failed: ${result.error.code}: ${result.error.message}`)
      return result.value
    }
    const enablePlugin: ImportedPluginControls['enable'] = async (identity) => {
      const result = await ctx.remote.pluginInventory.enablePlugin(identity)
      if (!result.ok) throw new Error(`pluginInventory.enablePlugin failed: ${result.error.code}: ${result.error.message}`)
      return result.value
    }
    const disablePlugin: ImportedPluginControls['disable'] = async (identity) => {
      const result = await ctx.remote.pluginInventory.disablePlugin(identity)
      if (!result.ok) throw new Error(`pluginInventory.disablePlugin failed: ${result.error.code}: ${result.error.message}`)
      return result.value
    }
    const trustPlugin: NonNullable<ImportedPluginCapabilitiesTabInjected['trust']> = async (identity) => {
      const result = await ctx.remote.pluginInventory.trustPlugin(identity)
      if (!result.ok) throw new Error(`pluginInventory.trustPlugin failed: ${result.error.code}: ${result.error.message}`)
      return result.value
    }
    const untrustPlugin: NonNullable<ImportedPluginCapabilitiesTabInjected['untrust']> = async (identity) => {
      const result = await ctx.remote.pluginInventory.untrustPlugin(identity)
      if (!result.ok) throw new Error(`pluginInventory.untrustPlugin failed: ${result.error.code}: ${result.error.message}`)
      return result.value
    }
    const removePlugin: ImportedPluginControls['remove'] = async (identity) => {
      const result = await ctx.remote.pluginInventory.removePlugin(identity)
      if (!result.ok) throw new Error(`pluginInventory.removePlugin failed: ${result.error.code}: ${result.error.message}`)
      return result.value
    }
    nativePlugins = { list: listPlugins, setEnabled: setPluginEnabled }
    const importedPlugins: ImportedPluginControls = {
      list: listImportedPlugins,
      import: importPlugin,
      enable: enablePlugin,
      disable: disablePlugin,
      remove: removePlugin,
    }
    importedPluginsControls = importedPlugins
    const marketplaceInjected = (): MarketplaceSettingsTabInjected => ({
      addMarketplace,
      importedPlugins,
      listMarketplaces,
      removeMarketplace,
      setMarketplaceEnabled,
      /* v8 ignore next -- apply initializes the controller before consumers receive the injected face. */
      hasPendingImportedChanges: () => inventoryRef.current?.hasPendingImportedChanges() ?? false,
    })
    ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
      name: 'settings.plugins.tab',
      id: 'marketplace',
      order: 20,
      label: () => t('marketplaceTab'),
      locale: NS,
      inject: marketplaceInjected,
    }, MarketplaceSettingsTab))
    const capabilitiesInjected = (capability: ImportedPluginCapabilitiesTabInjected['capability']): ImportedPluginCapabilitiesTabInjected => ({
      capability,
      list: listImportedPlugins,
      nativeSkills,
      trust: trustPlugin,
      untrust: untrustPlugin,
    })
    ctx.slots.inject('settings.plugins.tab', function* () {
      yield ctx.slots.register({
        name: 'settings.plugins.tab',
        id: 'skills',
        order: 15,
        label: () => t('skillsTab'),
        locale: NS,
        inject: () => capabilitiesInjected('skills'),
      }, ImportedPluginCapabilitiesTab)
    })
    // The imported bundles' hook catalog rides the Hooks tab's child slot
    // rather than owning a tab of its own: the tab stacks the user's own
    // records above it, and the slot contract keeps this package from
    // depending on the tab owner.
    ctx.slots.inject('settings.plugins.hooks.item', () => ctx.slots.register({
      name: 'settings.plugins.hooks.item',
      id: 'imported-hooks',
      order: 10,
      locale: NS,
      inject: () => capabilitiesInjected('hooks'),
    }, ImportedPluginCapabilitiesTab))
  }

  const pluginInventory = new PluginInventoryController(nativePlugins, importedPluginsControls)
  inventoryRef.current = pluginInventory
  const selection = ctx.settingsScope.selection()
  const controllers = new Map<string, PluginInventoryController>([['global:', pluginInventory]])
  const addressed = () => {
    const { target } = selection.getSnapshot()
    const key = `${target.workspaceId ?? 'global'}:${target.layer ?? ''}`
    let controller = controllers.get(key)
    if (controller === undefined) {
      const mirror = ctx.settingsScope.describe(target)
      let entries: Awaited<ReturnType<NativePluginControls['list']>>['entries'] = []
      const entryPath = (entryId: Parameters<NativePluginControls['setEnabled']>[0]) => {
        const entry = entries.find(candidate => candidate.entryId === entryId)
        return entry?.presetId === undefined || entry.presetRowId === undefined
          ? undefined : ['pluginEnablement', entry.presetId, entry.presetRowId]
      }
      const native: NativePluginControls | undefined = !connection.isLoopback ? undefined : {
        list: async () => {
          await mirror.ensure()
          const result = await ctx.remote.pluginInventory.list(target)
          if (!result.ok) throw new Error(`pluginInventory.list failed: ${result.error.code}: ${result.error.message}`)
          entries = result.value.entries
          return result.value
        },
        setEnabled: async (entryId, enabled) => {
          const result = await ctx.remote.pluginInventory.setEnabled({ entryId, enabled, ...target })
          if (!result.ok) throw new Error(`pluginInventory.setEnabled failed: ${result.error.code}: ${result.error.message}`)
          return result.value
        },
        overridden: (entryId) => {
          const path = entryPath(entryId)
          if (path === undefined) return false
          let value: unknown = mirror.getSnapshot().view?.namespaces.find(view => view.ns === 'agent-presets')?.user
          for (const field of path) {
            if (typeof value !== 'object' || value === null || !Object.prototype.hasOwnProperty.call(value, field)) return false
            value = (value as Record<string, unknown>)[field]
          }
          return true
        },
        reset: async (entryId) => {
          const path = entryPath(entryId)
          const namespace = mirror.getSnapshot().view?.namespaces.find(view => view.ns === 'agent-presets')
          if (path === undefined || namespace === undefined) throw new Error('The preset plugin is no longer available.')
          const response = await connection.api.settings.mutate({ ...target, ns: 'agent-presets', expectedRevision: namespace.revision,
            ops: [{ op: 'unset', path }] })
          if (!response.result.ok) throw new Error(response.result.error.message)
          mirror.acceptView(response.result.value)
          const result = await ctx.remote.pluginInventory.list(target)
          if (!result.ok) throw new Error(`pluginInventory.list failed: ${result.error.code}: ${result.error.message}`)
          entries = result.value.entries
          return result.value
        },
      }
      controller = new PluginInventoryController(native)
      controllers.set(key, controller)
    }
    return controller
  }
  let current = addressed()
  const drafts = createSnapshotStore(current.store.getSnapshot())
  let stopCurrent = current.store.subscribe(() => { drafts.set(current.store.getSnapshot()) })
  ctx.effect(() => {
    const stop = selection.subscribe(() => {
      const next = addressed()
      if (next === current) return
      stopCurrent()
      current = next
      drafts.set(current.store.getSnapshot())
      stopCurrent = current.store.subscribe(() => { drafts.set(current.store.getSnapshot()) })
    })
    const updated = ctx.remote.$on('workspace-config/updated', (workspaceId) => {
      for (const [key, controller] of controllers) if (key.startsWith(`${workspaceId}:`)) controller.invalidate()
    })
    const trusted = ctx.remote.$on('workspace-config/trust-updated', (workspaceId) => {
      for (const [key, controller] of controllers) if (key.startsWith(`${workspaceId}:`)) controller.invalidate()
    })
    return () => { stop(); updated(); trusted(); stopCurrent(); for (const controller of controllers.values()) controller.dispose() }
  }, 'ui-settings-plugin-inventory: addressed drafts')
  const injected = () => ({
    hooks: { pluginDrafts: drafts },
    savePlugins: () => current.save(),
    discardPluginChanges: () => { current.discard() },
    ...(current.nativePlugins === undefined ? {} : { nativePlugins: current.nativePlugins }),
    ...(current.importedPlugins === undefined ? {} : { importedPlugins: current.importedPlugins }),
  })
  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'all',
    order: 10,
    label: () => t('tab'),
    locale: NS,
    inject: injected,
  }, PluginInventorySettingsTab))
}

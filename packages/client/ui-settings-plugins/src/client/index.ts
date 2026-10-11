/**
 * Plugins settings surface, browser half — one section whose feature-owned
 * tabs include configurable Host plugin cards and read-only inventory.
 *
 * The section declares `settings.plugins.tab`; its own `configurable` tab then
 * declares `settings.plugin.item` and renders the generic Host plugin cards.
 * Web search contributes to the desktop Browser page when present and falls
 * back to plugin configuration in a Web-only deployment.
 */

import type { ConnectionHandle } from '@hydraharness/harness-client-connection/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@hydraharness/harness-client-locale/client'
// Type-only: the settings shell's SlotMap merge (the 'settings.section' entry)
// and the ctx.settingsScope Context merge. Cross-plugin collaboration goes
// through the service, never a value import (client bundle purity gate).
import type {} from '@hydraharness/harness-client-ui-settings/client'
import type { ClientContext } from '@hydraharness/harness-client-runtime/client'
import { resolveSlotLabel } from '@hydraharness/harness-client-ui-slots'
// Type-only: the ctx.remote Context merge and the forwarded-event key face.
import type {} from '@hydraharness/harness-api-remotes/client'
import { AgentLoopCard } from './AgentLoopCard.tsx'
import { BashCard } from './BashCard.tsx'
import { ConfigurablePluginsTab } from './ConfigurablePluginsTab.tsx'
import { McpSettingsTab, type ImportedMcpSettingsFace, type NativeMcpSettingsFace, type UserMcpSettingsFace } from './McpSettingsTab.tsx'
import { PluginsSettingsSection } from './PluginsSettingsSection.tsx'
import type { PluginsSettingsSectionInjected, PluginsSettingsTabEntry } from './PluginsSettingsSection.tsx'
import { HooksSettingsTab, type HooksSettingsFace } from './HooksSettingsTab.tsx'
import { PageMemoryCard } from './PageMemoryCard.tsx'
import { WebSearchCard } from './WebSearchCard.tsx'
import { AGENT_LOOP_NS, AgentLoopCardController } from './agent-loop-card-controller.ts'
import { SHELL_NS, BashCardController } from './bash-card-controller.ts'
import { ConfigurablePluginsTabController } from './tab-store.ts'
import { MCP_SETTINGS_NS, McpSettingsController } from './mcp-settings-controller.ts'
import { WEB_SEARCH_NS, WebSearchCardController } from './web-search-card-controller.ts'
import { PAGE_MEMORY_NS, PageMemoryCardController } from './page-memory-card-controller.ts'
import { en } from './locales.ts'

export type { PluginsSettingsSectionInjected, PluginsSettingsSectionProps } from './PluginsSettingsSection.tsx'
export type { ConfigurablePluginsTabProps } from './ConfigurablePluginsTab.tsx'
export type { ConfigurablePluginsTabFace, ConfigurablePluginsTabState } from './tab-store.ts'
export type { PluginCardProps } from './PluginCard.tsx'
export type { SettingsPluginItemOwnerProps } from './slot-contract.ts'
export type { FieldProps } from './fields.tsx'
export type {
  CardActions, CardFieldSpec, CardFieldState, CardSecretSpec, CardShell,
} from './card-form.ts'
export type { AgentLoopCardFace, AgentLoopCardState } from './agent-loop-card-controller.ts'
export type { BashCardFace, BashCardState } from './bash-card-controller.ts'
export type { WebSearchCardFace, WebSearchCardState } from './web-search-card-controller.ts'
export type { PageMemoryCardFace, PageMemoryCardState, PageMemorySettings } from './page-memory-card-controller.ts'
export type { UserMcpControls } from './McpServerCatalog.tsx'
export type { UserHookControls } from './HookRecordCatalog.tsx'
export type { UserMcpSettingsFace } from './McpSettingsTab.tsx'
export type { HooksSettingsFace, HooksSettingsTabProps } from './HooksSettingsTab.tsx'

/** Dictionary namespace owned by this plugin. */
const NS = 'settings.plugins'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'connection', 'remote', 'remote.pluginInventory', 'settingsScope']

/**
 * Mount the plugin configuration section and the cards this package ships.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const connection = ctx.get('connection') as ConnectionHandle
  const { api } = connection
  const t = ctx.locale.bind(NS)
  const selectedTarget = () => ctx.settingsScope.selection().getSnapshot().target
  ctx.effect(() => ctx.locale.register(NS, { en }), 'ui-settings-plugins: section dictionaries')

  const bash = new BashCardController(ctx.settingsScope.bind({ namespace: SHELL_NS }))
  const agentLoop = new AgentLoopCardController(ctx.settingsScope.bind({ namespace: AGENT_LOOP_NS }))
  const webSearch = new WebSearchCardController(
    ctx.settingsScope.bind({ namespace: WEB_SEARCH_NS }), api, namespace => ctx.settingsScope.bind({ namespace }),
  )
  const pageMemory = new PageMemoryCardController(ctx.settingsScope.bind({ namespace: PAGE_MEMORY_NS }))
  const mcp = new McpSettingsController(ctx.settingsScope.bind({ namespace: MCP_SETTINGS_NS }), api)
  const importedMcp: ImportedMcpSettingsFace['importedMcp'] = connection.isLoopback ? {
    list: async () => {
      const result = await ctx.remote.pluginInventory.listImportedPlugins()
      if (!result.ok) throw new Error(`pluginInventory.listImportedPlugins failed: ${result.error.code}: ${result.error.message}`)
      return result.value
    },
    setEnabled: async (identity, server, enabled) => {
      const result = await ctx.remote.pluginInventory.setPluginMcpServerEnabled({ identity, server, enabled })
      if (!result.ok) throw new Error(`pluginInventory.setPluginMcpServerEnabled failed: ${result.error.code}: ${result.error.message}`)
      return result.value
    },
    setToolApproval: async (identity, server, tool, approval) => {
      const result = await ctx.remote.pluginInventory.setPluginMcpToolApproval({ identity, server, tool, approval })
      if (!result.ok) throw new Error(`pluginInventory.setPluginMcpToolApproval failed: ${result.error.code}: ${result.error.message}`)
      return result.value
    },
  } : undefined
  const nativeMcp: NativeMcpSettingsFace['nativeMcp'] = connection.isLoopback ? {
    list: async () => {
      const result = await ctx.remote.pluginInventory.list({})
      if (!result.ok) throw new Error(`pluginInventory.list failed: ${result.error.code}: ${result.error.message}`)
      return result.value
    },
  } : undefined
  // The user's own MCP and hook records are loopback-only for the same reason
  // the rest of plugin management is: they name Host filesystem paths and start
  // Host processes, which a remote browser must not do.
  const userMcp: UserMcpSettingsFace['userMcp'] = connection.isLoopback ? {
    list: async () => {
      const target = selectedTarget()
      const result = await ctx.remote.pluginInventory.listMcpServers(target)
      if (!result.ok) throw new Error(`pluginInventory.listMcpServers failed: ${result.error.code}: ${result.error.message}`)
      return result.value
    },
    define: async (request) => {
      const result = await ctx.remote.pluginInventory.defineMcpServer({ ...request, ...selectedTarget() })
      if (!result.ok) throw new Error(`pluginInventory.defineMcpServer failed: ${result.error.code}: ${result.error.message}`)
      return result.value
    },
    setEnabled: async (name, enabled) => {
      const result = await ctx.remote.pluginInventory.setMcpServerEnabled({ name, enabled, ...selectedTarget() })
      if (!result.ok) throw new Error(`pluginInventory.setMcpServerEnabled failed: ${result.error.code}: ${result.error.message}`)
      return result.value
    },
    remove: async (name) => {
      const target = selectedTarget()
      const result = await ctx.remote.pluginInventory.removeMcpServer(target.workspaceId === undefined ? name : { name, ...target })
      if (!result.ok) throw new Error(`pluginInventory.removeMcpServer failed: ${result.error.code}: ${result.error.message}`)
      return result.value
    },
  } : undefined
  const userHooks: HooksSettingsFace['userHooks'] = connection.isLoopback ? {
    list: async () => {
      const target = selectedTarget()
      const result = await ctx.remote.pluginInventory.listHookRecords(target)
      if (!result.ok) throw new Error(`pluginInventory.listHookRecords failed: ${result.error.code}: ${result.error.message}`)
      return result.value
    },
    define: async (request) => {
      const result = await ctx.remote.pluginInventory.defineHookRecord({ ...request, ...selectedTarget() })
      if (!result.ok) throw new Error(`pluginInventory.defineHookRecord failed: ${result.error.code}: ${result.error.message}`)
      return result.value
    },
    setEnabled: async (name, enabled) => {
      const result = await ctx.remote.pluginInventory.setHookRecordEnabled({ name, enabled, ...selectedTarget() })
      if (!result.ok) throw new Error(`pluginInventory.setHookRecordEnabled failed: ${result.error.code}: ${result.error.message}`)
      return result.value
    },
    remove: async (name) => {
      const target = selectedTarget()
      const result = await ctx.remote.pluginInventory.removeHookRecord(target.workspaceId === undefined ? name : { name, ...target })
      if (!result.ok) throw new Error(`pluginInventory.removeHookRecord failed: ${result.error.code}: ${result.error.message}`)
      return result.value
    },
  } : undefined

  // The credential a card reports is not part of any settings section, so its
  // scope publishes nothing when one is written. This is the only signal that
  // a key written on another surface reached the Host.
  ctx.effect(
    () => ctx.remote.$on('credentials/reference-updated', (ref) => {
      webSearch.refreshCredential(ref)
      mcp.refreshCredential(ref)
    }),
    'ui-settings-plugins: credential invalidations',
  )

  // Which namespaces the Host serves comes from the shared describe mirror,
  // whose owning plugin already refreshes it on document commits and
  // reconnects — the tab only derives.
  const configurable = new ConfigurablePluginsTabController(
    ctx.settingsScope.describe('selected'), () => ctx.slots.entries('settings.plugin.item'))
  ctx.effect(() => () => { configurable.dispose() }, 'ui-settings-plugins: tab directory')
  // A card registered after the first read joins the list without a wire call.
  ctx.effect(
    () => ctx.slots.subscribe('settings.plugin.item', () => { configurable.refresh() }),
    'ui-settings-plugins: card ledger',
  )

  let tabsVersion = -1
  let tabsRevision = -1
  let tabs: readonly PluginsSettingsTabEntry[] = []
  const sectionInjected = (): PluginsSettingsSectionInjected => ({
    hooks: {
      selection: ctx.settingsScope.selection(),
      tabs: {
        getSnapshot: () => {
          const version = ctx.slots.getVersion('settings.plugins.tab')
          const revision = ctx.locale.getSnapshot().revision
          if (version !== tabsVersion || revision !== tabsRevision) {
            tabsVersion = version
            tabsRevision = revision
            tabs = ctx.slots.entries('settings.plugins.tab')
              .map(entry => ({
                /* v8 ignore next -- list-slot registration requires id */
                id: entry.options.id ?? '',
                order: entry.options.order ?? 0,
                label: resolveSlotLabel(entry.options.label) ?? '',
              }))
              .sort((a, b) => a.order - b.order)
          }
          return tabs
        },
        subscribe: (listener) => {
          const offLedger = ctx.slots.subscribe('settings.plugins.tab', listener)
          const offLocale = ctx.locale.subscribe(listener)
          return () => {
            offLedger()
            offLocale()
          }
        },
      },
    },
  })

  // This package owns the one Plugins navigation entry and the tab chrome;
  // feature plugins contribute pages without competing for Settings nav rows.
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'plugins',
    order: 15,
    label: () => t('nav'),
    locale: NS,
    inject: sectionInjected,
    children: { 'settings.plugins.tab': { kind: 'list', scope: 'root' } },
  }, PluginsSettingsSection))

  // The existing configuration page is one ordinary tab. It keeps ownership
  // of the generic card slot and the two generic contributions below.
  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'configurable',
    order: 0,
    label: () => t('configurableTab'),
    locale: NS,
    inject: () => configurable.inject(),
    children: { 'settings.plugin.item': { kind: 'keyed', scope: 'root' } },
  }, ConfigurablePluginsTab))

  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'mcp',
    order: 5,
    label: () => t('mcpTab'),
    locale: NS,
    inject: () => ({
      ...mcp.inject(),
      workspace: selectedTarget().workspaceId !== undefined,
      ...(importedMcp === undefined || selectedTarget().workspaceId !== undefined ? {} : { importedMcp }),
      ...(nativeMcp === undefined || selectedTarget().workspaceId !== undefined ? {} : { nativeMcp }),
      ...(userMcp === undefined ? {} : { userMcp }),
    }),
  }, McpSettingsTab))

  // The Hooks tab stacks the two hook catalogs: the user's own records, which
  // this package edits, and the imported bundles' hook lists, contributed
  // through the child slot so the inventory plugin never depends on this one.
  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'hooks',
    order: 25,
    label: () => t('hooksTab'),
    locale: NS,
    inject: () => ({ workspace: selectedTarget().workspaceId !== undefined, ...(userHooks === undefined ? {} : { userHooks }) }),
    children: { 'settings.plugins.hooks.item': { kind: 'list', scope: 'root' } },
  }, HooksSettingsTab))

  ctx.slots.inject('settings.plugin.item', function* () {
    yield ctx.slots.register({
      name: 'settings.plugin.item',
      key: SHELL_NS,
      locale: NS,
      inject: () => bash.inject(),
    }, BashCard)
    yield ctx.slots.register({
      name: 'settings.plugin.item',
      key: AGENT_LOOP_NS,
      locale: NS,
      inject: () => agentLoop.inject(),
    }, AgentLoopCard)
    yield ctx.slots.register({
      name: 'settings.plugin.item',
      key: PAGE_MEMORY_NS,
      locale: NS,
      inject: () => pageMemory.inject(),
    }, PageMemoryCard)
  })

  ctx.effect(() => () => { webSearch.dispose() }, 'ui-settings-plugins: search lifecycle')
  ctx.effect(() => () => { pageMemory.dispose() }, 'ui-settings-plugins: page-memory lifecycle')
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'web-search', order: 11,
    label: () => t('webSearchTitle'), locale: NS,
    inject: () => webSearch.inject(),
  }, WebSearchCard))
}

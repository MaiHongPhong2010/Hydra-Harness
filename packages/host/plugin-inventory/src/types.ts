import type { Branded } from '@hydraharness/harness-brand'
import type { SettingsTarget } from '@hydraharness/harness-workspace-config/types'
export type { SettingsTarget } from '@hydraharness/harness-workspace-config/types'
export type { ImportedPluginEntry, ImportedPluginSnapshot, PluginImportSource } from '@hydraharness/harness-plugin-runtime/types'
export type {
  McpServerDefinitionRequest, McpServerEnablementRequest, McpServerSnapshot,
  McpServerStatus, McpServerTransport, McpServerView,
} from '@hydraharness/harness-mcp-registry/types'
export type {
  HookDialect, HookRecordDefinitionRequest, HookRecordEnablementRequest, HookRecordSnapshot,
  HookRecordStatus, HookRecordView, HookSourceKind,
} from '@hydraharness/harness-hooks-registry/types'

/** Stable Loader-tree identity of one configured plugin entry. */
export type PluginEntryId = Branded<'PluginEntryId'>

/** Lifecycle state of an entry's root Fiber, or null when it has no live root Fiber. */
export type PluginFiberPhase =
  | 'pending'
  | 'loading'
  | 'active'
  | 'failed'
  | 'unloading'
  | null

/** One non-group Loader entry exposed to trusted clients. */
export interface PluginInventoryEntry {
  /** Functionality or dependency protected from optional-plugin suspension, separately from restart semantics. */
  readonly required?: boolean
  readonly entryId: PluginEntryId
  /** Exact module specifier imported by the Loader entry. */
  readonly moduleName: string
  /** Package-authored summary from package.json description. */
  readonly description?: string
  /** Package-authored usage guidance from package.json hydra.plugin.application. */
  readonly application?: string
  /** Core entries are saved for the next app start; omitted means normal. */
  readonly pluginType?: 'core' | 'normal'
  /** Modules with the same declared function, controlled by this entry. */
  readonly relatedModules?: readonly string[]
  /** Members currently have different desired states; either toggle value changes the group. */
  readonly mixedEnabled?: boolean
  /** Enablement at Host start; null means grouped entries started with different states. */
  readonly initialEnabled?: boolean | null
  /** Whether any saved member differs from its enablement at Host start. */
  readonly changedSinceStart?: boolean
  /** Effective Loader enablement, including disabled ancestor groups. */
  readonly enabled: boolean
  /** Agent preset that owns this entry, when it is not a Host entry. */
  readonly presetId?: string
  /** Leaf row within {@link presetId}; identifies its settings override. */
  readonly presetRowId?: string
  /** Whether a changed preset entry affects only sessions created afterwards. */
  readonly newSessionsOnly?: boolean
  /** Desired root-entry enablement waiting for the next profile start. */
  readonly pendingEnabled?: boolean
  /** Whether the persisted desired state differs from the live Loader state. */
  readonly restartRequired: boolean
  /** Whether this app can persistently change the entry's enablement. */
  readonly toggleable: boolean
  readonly fiberPhase: PluginFiberPhase
}

/** Requested persistent enablement for one Loader entry. */
export interface PluginEnablementRequest extends SettingsTarget {
  readonly entryId: PluginEntryId
  readonly enabled: boolean
}

/** Point-in-time inventory returned by the plugin inventory Remote. */
export interface PluginInventorySnapshot extends SettingsTarget {
  readonly entries: readonly PluginInventoryEntry[]
}

/** Result of changing one native plugin's desired state. */
export interface PluginEnablementResult {
  readonly snapshot: PluginInventorySnapshot
  /** Whether this specific mutation waits for the next profile start. */
  readonly restartRequired: boolean
}

/** Persist one Git-backed or local marketplace root. */
export interface AddPluginMarketplaceRequest {
  readonly source: string
  readonly gitRef?: string
  readonly sparsePaths?: readonly string[]
}

/** Host-normalized source fields shared by every marketplace state. */
export interface PluginMarketplaceSourceView {
  readonly source: string
  readonly gitRef?: string
  readonly sparsePaths: readonly string[]
  /** Marketplace slot state; disabling or removing it cascades to its imported plugins. */
  readonly enabled: boolean
}

/** Toggle one marketplace slot; disabling cascades to disable its imported plugins. */
export interface SetPluginMarketplaceEnablementRequest {
  readonly source: string
  readonly enabled: boolean
}

/** One persisted marketplace and its latest Host-side load result. */
export type PluginMarketplaceView = PluginMarketplaceSourceView & (
  | {
    readonly status: 'ready'
  }
  | {
    readonly status: 'unavailable'
  }
)

/** Point-in-time marketplace catalog returned by the plugin inventory Remote. */
export interface PluginMarketplaceSnapshot {
  readonly marketplaces: readonly PluginMarketplaceView[]
}

/** Enable or disable one imported plugin MCP server. */
export interface ImportedPluginMcpServerEnablementRequest {
  readonly identity: string
  readonly server: string
  readonly enabled: boolean
}

/** Set one imported MCP tool's approval mode. */
export interface ImportedPluginMcpToolApprovalRequest {
  readonly identity: string
  readonly server: string
  /** Raw MCP name or its host-qualified public tool name. */
  readonly tool: string
  readonly approval: 'ask' | 'allow' | 'deny'
}

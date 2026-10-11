/** Plugin enablement drafts survive Settings remounts and apply through one Save action. */

import { createSnapshotStore } from '@hydraharness/harness-client-runtime/client'
import type { PluginInventorySnapshot, ImportedPluginSnapshot } from '@hydraharness/harness-api-remotes/client'
import type { NativePluginControls, ImportedPluginControls } from './PluginInventorySettingsTab.tsx'

/** Shared viewing state for the Plugins tab's staged enablement. */
export interface InventoryDraftState {
  saving: boolean
  error: string | null
  revision: number
  dirtyNative: string[]
  dirtyImported: string[]
  changedNative: string[]
  changedImported: string[]
}

/** Owns draft enablement and sequential saves independently of mounted Settings components. */
export class PluginInventoryController {
  /** Observable draft summary bound by the Settings slot renderer. */
  readonly store = createSnapshotStore<InventoryDraftState>({
    saving: false, error: null, revision: 0,
    dirtyNative: [], dirtyImported: [], changedNative: [], changedImported: [],
  })

  /** Native catalog controls that stage changes until Save. */
  readonly nativePlugins: NativePluginControls | undefined
  /** Imported catalog controls; uninstall remains an explicit immediate action. */
  readonly importedPlugins: ImportedPluginControls | undefined
  private native: PluginInventorySnapshot = { entries: [] }
  private imported: ImportedPluginSnapshot = { plugins: [] }
  private readonly nativeDrafts = new Map<string, boolean>()
  private readonly importedDrafts = new Map<string, boolean>()
  private readonly nativeInitial = new Map<string, boolean>()
  private readonly importedInitial = new Map<string, boolean>()
  private disposed = false
  private generation = 0
  private nativeRead = 0
  private importedRead = 0

  constructor(private readonly nativeApi?: NativePluginControls, private readonly importedApi?: ImportedPluginControls) {
    const resetNative = nativeApi?.reset?.bind(nativeApi)
    if (nativeApi !== undefined) this.nativePlugins = {
      list: async () => {
        const generation = this.generation
        const request = ++this.nativeRead
        const snapshot = await nativeApi.list()
        if (!this.isDisposed() && generation === this.generation && request === this.nativeRead) this.receiveNative(snapshot)
        return this.projectNative()
      },
      setEnabled: (id, enabled) => {
        if (!this.isDisposed() && !this.store.getSnapshot().saving) {
          const entry = this.native.entries.find(candidate => candidate.entryId === id)
          if (entry?.toggleable) {
            if (!entry.mixedEnabled && enabled === (entry.pendingEnabled ?? entry.enabled)) this.nativeDrafts.delete(id)
            else this.nativeDrafts.set(id, enabled)
            this.publish()
          }
        }
        return Promise.resolve({ snapshot: this.projectNative(), restartRequired: false })
      },
      ...nativeApi.overridden === undefined ? {} : { overridden: nativeApi.overridden },
      ...resetNative === undefined ? {} : { reset: async (id: Parameters<NativePluginControls['setEnabled']>[0]) => {
        const snapshot = await resetNative(id)
        if (!this.isDisposed()) {
          this.nativeDrafts.delete(id)
          this.receiveNative(snapshot)
          this.store.update((state) => { state.revision++ })
        }
        return this.projectNative()
      } },
    }
    if (importedApi !== undefined) {
      const stage = (identity: string, enabled: boolean): Promise<ImportedPluginSnapshot> => {
        if (!this.isDisposed() && !this.store.getSnapshot().saving) {
          const plugin = this.imported.plugins.find(candidate => candidate.identity === identity)
          if (plugin !== undefined) {
            if (enabled === plugin.enabled) this.importedDrafts.delete(identity)
            else this.importedDrafts.set(identity, enabled)
            this.publish()
          }
        }
        return Promise.resolve(this.projectImported())
      }
      this.importedPlugins = {
        ...importedApi,
        list: async () => {
          const generation = this.generation
          const request = ++this.importedRead
          const snapshot = await importedApi.list()
          if (!this.isDisposed() && generation === this.generation && request === this.importedRead) this.receiveImported(snapshot)
          return this.projectImported()
        },
        enable: identity => stage(identity, true),
        disable: identity => stage(identity, false),
        remove: async (identity) => {
          if (this.isDisposed() || this.store.getSnapshot().saving) return this.projectImported()
          this.generation++
          this.store.update((state) => { state.saving = true })
          try {
            const snapshot = await importedApi.remove(identity)
            if (!this.isDisposed()) this.receiveImported(snapshot)
            return this.projectImported()
          } finally {
            if (!this.isDisposed()) {
              this.generation++
              this.store.update((state) => { state.saving = false; state.revision++ })
            }
          }
        },
      }
    }
  }

  private receiveNative(snapshot: PluginInventorySnapshot): void {
    this.native = snapshot
    for (const id of this.nativeDrafts.keys()) {
      if (!snapshot.entries.some(entry => entry.entryId === id)) this.nativeDrafts.delete(id)
    }
    for (const entry of snapshot.entries) {
      if (!this.nativeInitial.has(entry.entryId)) this.nativeInitial.set(entry.entryId, entry.enabled)
      if (!entry.mixedEnabled && this.nativeDrafts.get(entry.entryId) === (entry.pendingEnabled ?? entry.enabled)) {
        this.nativeDrafts.delete(entry.entryId)
      }
    }
    this.publish()
  }

  private receiveImported(snapshot: ImportedPluginSnapshot): void {
    this.imported = snapshot
    for (const identity of this.importedDrafts.keys()) {
      if (!snapshot.plugins.some(plugin => plugin.identity === identity)) this.importedDrafts.delete(identity)
    }
    for (const plugin of snapshot.plugins) {
      if (!this.importedInitial.has(plugin.identity)) this.importedInitial.set(plugin.identity, plugin.enabled)
      if (this.importedDrafts.get(plugin.identity) === plugin.enabled) this.importedDrafts.delete(plugin.identity)
    }
    this.publish()
  }

  private projectNative(): PluginInventorySnapshot {
    return { entries: this.native.entries.map((entry) => {
      const pendingEnabled = this.nativeDrafts.get(entry.entryId)
      return pendingEnabled === undefined ? entry : {
        ...entry,
        pendingEnabled,
        mixedEnabled: false,
        restartRequired: entry.restartRequired || entry.pluginType === 'core',
      }
    }) }
  }

  private projectImported(): ImportedPluginSnapshot {
    return { plugins: this.imported.plugins.map((plugin) => {
      const enabled = this.importedDrafts.get(plugin.identity)
      return enabled === undefined ? plugin : { ...plugin, enabled }
    }) }
  }

  private publish(): void {
    this.store.update((state) => {
      state.dirtyNative = [...this.nativeDrafts.keys()]
      state.dirtyImported = [...this.importedDrafts.keys()]
      state.changedNative = this.projectNative().entries
        .filter(entry => !this.nativeDrafts.has(entry.entryId) && entry.changedSinceStart !== undefined
          ? entry.changedSinceStart
          : (entry.pendingEnabled ?? entry.enabled) !== (
            entry.initialEnabled === undefined ? this.nativeInitial.get(entry.entryId) : entry.initialEnabled
          ))
        .map(entry => entry.entryId)
      state.changedImported = this.projectImported().plugins
        .filter(plugin => !this.importedDrafts.has(plugin.identity)
          && plugin.enabled !== (plugin.initialEnabled ?? this.importedInitial.get(plugin.identity)))
        .map(plugin => plugin.identity)
    })
  }

  /** Save every draft, retain failed/unsubmitted edits, and refresh both catalogs after settlement. */
  async save(): Promise<void> {
    if (this.isDisposed() || this.store.getSnapshot().saving) return
    this.generation++
    this.store.update((state) => { state.saving = true; state.error = null })
    try {
      if (this.nativeApi !== undefined) for (const [id, enabled] of this.nativeDrafts) {
        const entry = this.native.entries.find(candidate => candidate.entryId === id)
        /* v8 ignore if -- receiveNative removes absent ids from nativeDrafts before any save can iterate them. */
        if (entry === undefined) throw new Error(`Plugin ${id} is no longer available.`)
        const result = await this.nativeApi.setEnabled(entry.entryId, enabled)
        if (this.isDisposed()) return
        this.nativeDrafts.delete(id)
        this.receiveNative(result.snapshot)
      }
      if (this.importedApi !== undefined) for (const [identity, enabled] of this.importedDrafts) {
        const snapshot = await (enabled ? this.importedApi.enable(identity) : this.importedApi.disable(identity))
        if (this.isDisposed()) return
        this.importedDrafts.delete(identity)
        this.receiveImported(snapshot)
      }
    } catch (error: unknown) {
      if (!this.isDisposed()) this.store.update((state) => { state.error = error instanceof Error ? error.message : String(error) })
    } finally {
      if (!this.isDisposed()) {
        this.generation++
        this.store.update((state) => { state.saving = false; state.revision++ })
        this.publish()
      }
    }
  }

  /** Discard unsaved edits while preserving saved changes and the app-start comparison. */
  discard(): void {
    if (this.isDisposed() || this.store.getSnapshot().saving) return
    this.nativeDrafts.clear()
    this.importedDrafts.clear()
    this.store.update((state) => { state.error = null; state.revision++ })
    this.publish()
  }

  /** Refresh mounted catalogs after a matching Host settings invalidation. */
  invalidate(): void {
    if (!this.isDisposed()) this.store.update((state) => { state.revision++ })
  }

  /** Whether an imported plugin save would still write a pending enablement.
   * @returns True when an imported plugin draft is pending.
   */
  hasPendingImportedChanges(): boolean {
    return this.store.getSnapshot().saving || this.importedDrafts.size > 0
  }

  /** Suppress late publications after the plugin unloads. */
  dispose(): void { this.disposed = true }

  private isDisposed(): boolean { return this.disposed }
}

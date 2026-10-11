/**
 * Host transport for the settings-namespace scope contract. The contract types
 * live in `@hydraharness/harness-client-runtime` (the common dependency of every feature that
 * owns a preference); this file owns the per-namespace derivation over the
 * shared {@link SettingsDescribeMirror} and the serialized write path, both of
 * which are Settings-surface concerns. Reads never touch the wire here: the
 * mirror is the one `settings.describe` reader, and every scope is a selector
 * over its snapshot.
 */

import { Service } from '@hydraharness/cordis'
import type { Context } from '@hydraharness/cordis'
import type {
  ConnectionHandle, IApiClient, SettingsNamespaceView, SettingsPathOpView, SettingsTarget,
} from '@hydraharness/harness-api-remotes/client'
import {
  createSnapshotStore, type SettingsScope, type SettingsScopeSnapshot,
  type SettingsScopeSpec, type SnapshotStore,
} from '@hydraharness/harness-client-runtime/client'
// Type-only, and deliberately NOT `@hydraharness/harness-api-remotes/client`: this
// package is reachable from the Host build graph through its feature-package
// callers, and api-remotes' Client face imports a Host-tsdown-generated
// `/remote` artifact, which would deadlock the Host tsc phase. The gateway's
// Client half declares `ctx.remote` with no generated import, and the
// allowlist's `types` subpath is a pure-type source file, so the pair supplies
// `$on` and its key face without dragging a build artifact in. The runtime
// `remote` injection belongs to the providing plugin's apply, which registers
// the mirror's invalidation subscriptions.
import type {} from '@hydraharness/harness-api-remotes/client'
import type {} from '@hydraharness/harness-api-remotes/types'
// The forwarded event's own declaration: `$on`'s key face is
// `Extract<keyof Events, keyof Selection>`, so the allowlist alone resolves to
// never — the owning package's client-safe, type-only subpath supplies the
// cordis `Events` entry (and with it the branded `SettingsNamespace`).
import type {} from '@hydraharness/harness-settings/types'
import type { SettingsSchemaService } from './schema.ts'
import { SettingsDescribeMirror, type SettingsDescribeFace } from './settings-mirror.ts'

type SettingsFace = Pick<IApiClient, 'settings'>

/**
 * One namespace's derived view over the shared describe mirror, plus that
 * namespace's serialized Host writes. Writes carry the latest known namespace
 * revision, fold their answers back into the mirror, and teardown waits for
 * the operation already crossing the wire.
 */
export class SettingsScopeController<T> implements SettingsScope<T> {
  private readonly store: SnapshotStore<SettingsScopeSnapshot<T>>
  private tail: Promise<void> = Promise.resolve()
  private writeGeneration = 0
  private disposed = false
  private readonly unsubscribe: (() => void) | undefined
  /**
   * Revision answered by a superseded write still ahead of the mirror: the
   * mirror only folds the LATEST settlement in, so a queued successor takes
   * its fence from here first.
   */
  private pendingRevision: number | undefined

  /**
   * @param api - settings wire face (writes only; reads ride the mirror).
   * @param spec - namespace identity and optional narrowing decoder.
   * @param mirror - the shared describe mirror this scope derives from.
   * @param persistence - remote browsers remain process-local because settings RPCs are loopback-only.
   * @param schema - settings-owned schema operations.
   */
  constructor(
    private readonly api: SettingsFace,
    private readonly spec: SettingsScopeSpec<T>,
    private readonly mirror: SettingsDescribeMirror,
    private readonly persistence: 'host' | 'memory',
    private readonly schema: SettingsSchemaService,
  ) {
    this.store = createSnapshotStore<SettingsScopeSnapshot<T>>({
      status: persistence === 'host' ? 'loading' : 'unavailable',
      value: undefined,
      base: undefined,
      user: undefined,
      revision: undefined,
      writable: false,
      mode: persistence,
    })
    if (persistence === 'host') {
      this.unsubscribe = mirror.subscribe(() => { this.derive() })
      this.derive()
    }
  }

  /** @returns the current sync snapshot (stable reference until the next change). */
  getSnapshot(): SettingsScopeSnapshot<T> {
    return this.store.getSnapshot()
  }

  /**
   * Observe snapshot replacements.
   * @param listener - invoked after each snapshot change.
   * @returns the disposer removing this listener.
   */
  subscribe(listener: () => void): () => void {
    return this.store.subscribe(listener)
  }

  /**
   * Queue one field write; see {@link SettingsScope.set} for the ordering,
   * revision, and recovery contract.
   * @param field - scalar field inside the namespace section.
   * @param value - JSON-shaped value selected by the user.
   * @returns settlement after the write and any latest-write recovery read.
   */
  set(field: string, value: unknown): Promise<void> {
    return this.write({ op: 'set', path: [field], value })
  }

  /**
   * Queue one field clear; see {@link SettingsScope.unset} for the ordering,
   * revision, and recovery contract.
   * @param field - scalar field inside the namespace section.
   * @returns settlement after the clear and any latest-write recovery read.
   */
  unset(field: string): Promise<void> {
    return this.write({ op: 'unset', path: [field] })
  }

  private write(op: SettingsPathOpView): Promise<void> {
    const generation = ++this.writeGeneration
    return this.enqueue(async () => {
      const revision = this.pendingRevision ?? this.getSnapshot().revision
      let response: Awaited<ReturnType<SettingsFace['settings']['mutate']>>
      try {
        response = await this.api.settings.mutate({
          ...this.mirror.target,
          ns: this.spec.namespace,
          ops: [op],
          ...(revision === undefined ? {} : { expectedRevision: revision }),
        })
      } catch (_settingsWriteFailure) {
        await this.recover(generation)
        return
      }
      if (!response.result.ok) {
        await this.recover(generation)
        return
      }
      if (this.disposed) return
      if (generation === this.writeGeneration) {
        this.pendingRevision = undefined
        this.mirror.acceptView(response.result.value)
      } else {
        this.pendingRevision = response.result.value.revision
      }
    })
  }

  /** Reload Host state for the latest failed write; superseded failures leave recovery to it. */
  private async recover(generation: number): Promise<void> {
    if (this.disposed || generation !== this.writeGeneration) return
    this.pendingRevision = undefined
    await this.mirror.load()
  }

  /**
   * Stop queued operations, stop deriving, and wait for the current wire call
   * to settle.
   * @returns settlement after the controller reaches quiescence.
   */
  async dispose(): Promise<void> {
    this.disposed = true
    this.writeGeneration += 1
    this.unsubscribe?.()
    await this.tail
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    if (this.persistence === 'memory' || this.disposed) return Promise.resolve()
    const task = this.tail.then(async () => {
      if (this.disposed) return
      await operation()
    })
    // The returned task carries its own settlement to the caller; the queue
    // tail is kept fulfilled so one failed subscriber cannot strand later operations.
    this.tail = task.catch(() => {})
    return task
  }

  private derive(): void {
    if (this.disposed) return
    const mirrored = this.mirror.getSnapshot()
    if (mirrored.view === undefined) return
    const { writable } = mirrored.view
    const view = mirrored.view.namespaces.find(candidate => candidate.ns === this.spec.namespace)
    if (view === undefined) {
      this.store.update((draft) => {
        draft.status = 'unavailable'
        draft.writable = writable
      })
      return
    }
    const decoded = this.decode(view)
    this.store.update((draft) => {
      draft.revision = view.revision
      draft.base = view.base
      draft.user = view.user
      draft.writable = writable
      if (decoded === undefined) return
      draft.status = 'ready'
      draft.value = decoded
    })
  }

  private decode(view: SettingsNamespaceView): T | undefined {
    if (this.spec.decode !== undefined) return this.spec.decode(view.value)
    // Sections are plain objects by construction; schemastery alone would
    // resolve null or an array through object defaults instead of refusing.
    if (typeof view.value !== 'object' || view.value === null || Array.isArray(view.value)) return undefined
    let failure: string | undefined
    try {
      failure = this.schema.validate(this.schema.rehydrate(view.schema), view.value)
    } catch (_malformedSchemaEnvelope) {
      // A schema envelope this client cannot rehydrate vouches for no section;
      // the value is treated exactly like a schema-invalid one.
      return undefined
    }
    return failure === undefined ? view.value as T : undefined
  }
}

declare module '@hydraharness/cordis' {
  interface Context {
    settingsScope: SettingsScopeBinder
  }
}

/**
 * The settings domain's base service. Features that own a preference reach the
 * settings transport through this service rather than a shared function: the
 * client bundle purity gate forbids cross-plugin value imports and directs
 * cross-plugin collaboration through cordis services
 * (`packages/client/tsdown.client.ts`).
 */
export class SettingsScopeBinder extends Service {
  private readonly mirror: SettingsDescribeMirror
  private readonly schema: SettingsSchemaService
  private readonly mirrors = new Map<string, SettingsDescribeMirror>()
  private readonly selected: SnapshotStore<SettingsSelectionSnapshot> = createSnapshotStore({ target: {}, loading: false, error: null })
  private selectedMirror: SettingsDescribeMirror
  private readonly selectedView = createSnapshotStore(this.emptySnapshot())
  private stopSelectedMirror: () => void

  /**
   * @param ctx - the providing plugin's context.
   * @param config - the shared describe mirror every bound scope derives from,
   * plus the settings-owned schema operations.
   */
  constructor(ctx: Context, config: { mirror: SettingsDescribeMirror; schema: SettingsSchemaService }) {
    super(ctx, 'settingsScope')
    this.mirror = config.mirror
    this.schema = config.schema
    this.selectedMirror = this.mirror
    this.mirrors.set('', this.mirror)
    this.stopSelectedMirror = this.followSelectedMirror()
    ctx.effect(() => () => { this.stopSelectedMirror() }, 'ui-settings: selected document subscription')
  }

  /**
   * The shared mirror's read/fold face for cross-namespace surfaces (schema
   * introspection, the served-namespace directory). Per-namespace consumers
   * use {@link bind}; both derive from the same snapshot, so they can never
   * disagree about the document.
   * @param target - fixed document or the shell's current selection.
   * @returns the describe face over the shared mirror.
   */
  describe(target: SettingsTarget | 'selected' = {}): SettingsDescribeFace {
    if (target !== 'selected') return this.mirrorFor(target)
    const selectedTarget = () => this.selectedMirror.target
    return {
      get target() { return selectedTarget() },
      getSnapshot: () => this.selectedView.getSnapshot(),
      subscribe: listener => this.selectedView.subscribe(listener),
      ensure: () => this.selectedMirror.ensure(),
      acceptView: (view) => {
        this.mirrorFor(view.workspaceId === undefined ? {} : { workspaceId: view.workspaceId, layer: view.layer ?? 'local' }).acceptView(view)
      },
    }
  }

  /**
   * Observe the Settings selector's addressed document and trust state.
   * @returns the selection snapshot source.
   */
  selection(): SnapshotStore<SettingsSelectionSnapshot> { return this.selected }

  /**
   * Select a Settings document without changing Host-wide runtime configuration.
   * @param target - global document or a registered workspace and layer.
   * @returns after the scoped describe settles.
   */
  async selectTarget(target: SettingsTarget): Promise<void> {
    const normalized = target.workspaceId === undefined ? {} : { workspaceId: target.workspaceId, layer: target.layer ?? 'local' }
    const next = this.mirrorFor(normalized)
    if (next !== this.selectedMirror) {
      this.stopSelectedMirror()
      this.selectedMirror = next
      this.selected.set({ target: normalized, loading: true, error: null })
      this.stopSelectedMirror = this.followSelectedMirror()
    }
    await next.ensure()
  }

  /**
   * Persist explicit trust for the selected workspace on the Host.
   * @param trusted - allow project commands, or revoke their permission.
   * @returns after the Host acknowledges and the scoped view refreshes.
   */
  async setWorkspaceTrust(trusted: boolean): Promise<void> {
    const mirror = this.selectedMirror
    const { workspaceId } = mirror.target
    if (workspaceId === undefined) return
    const connection = this.ctx.get('connection') as ConnectionHandle
    this.selected.update((draft) => { draft.loading = true; draft.error = null })
    try {
      const response = await connection.api.settings.setWorkspaceTrust({ workspaceId, trusted })
      if (!response.result.ok) throw new Error(response.result.error.message)
      await mirror.load()
    } catch (error) {
      if (mirror === this.selectedMirror) this.selected.update((draft) => {
        draft.loading = false
        draft.error = error instanceof Error ? error.message : String(error)
      })
    }
  }

  /**
   * Refresh cached documents after a Host invalidation.
   * @param workspaceId - changed workspace, or omitted for the global document.
   */
  refresh(workspaceId?: SettingsTarget['workspaceId']): void {
    for (const mirror of this.mirrors.values()) {
      if (workspaceId === undefined || mirror.target.workspaceId === workspaceId) void mirror.load()
    }
  }

  private emptySnapshot(): ReturnType<SettingsDescribeMirror['getSnapshot']> {
    return { status: 'idle', view: undefined, error: null }
  }

  private mirrorFor(target: SettingsTarget): SettingsDescribeMirror {
    const key = target.workspaceId === undefined ? '' : `${target.workspaceId}:${target.layer ?? 'local'}`
    let mirror = this.mirrors.get(key)
    if (mirror === undefined) {
      const connection = this.ctx.get('connection') as ConnectionHandle
      mirror = new SettingsDescribeMirror(connection.api, connection.isLoopback ? 'host' : 'memory',
        target.workspaceId === undefined ? {} : { workspaceId: target.workspaceId, layer: target.layer ?? 'local' })
      this.mirrors.set(key, mirror)
    }
    return mirror
  }

  private followSelectedMirror(): () => void {
    const mirror = this.selectedMirror
    const update = (): void => {
      const snapshot = mirror.getSnapshot()
      this.selectedView.set(snapshot)
      this.selected.set({ target: mirror.target, loading: snapshot.status === 'idle' || snapshot.status === 'loading',
        error: snapshot.error, ...snapshot.view?.trusted === undefined ? {} : { trusted: snapshot.view.trusted } })
    }
    update()
    return mirror.subscribe(update)
  }

  /**
   * Bind one namespace scope on the CALLER's plugin lifecycle — the service
   * proxy binds `this.ctx` to the caller at call time, so the scope's disposer
   * belongs to the calling fiber. The scope derives from the shared mirror
   * (whose invalidation subscriptions live with the providing plugin), so
   * binding adds no wire read of its own and activation never blocks on the
   * settings transport.
   * @param spec - domain-owned namespace contract.
   * @param target - fixed document or the shell's current selection.
   * @returns the bound scope consumed by the domain's services and rows.
   */
  bind<T>(spec: SettingsScopeSpec<T>, target: SettingsTarget | 'selected' = {}): SettingsScope<T> {
    if (target === 'selected') return this.bindSelected(spec)
    const ctx = this.ctx
    const connection = ctx.get('connection') as ConnectionHandle
    const controller = new SettingsScopeController<T>(
      connection.api,
      spec,
      this.mirrorFor(target),
      connection.isLoopback ? 'host' : 'memory',
      this.schema,
    )
    ctx.effect(() => {
      void this.mirrorFor(target).ensure()
      return async () => {
        await controller.dispose()
      }
    }, `ui-settings: ${spec.namespace} settings scope`)
    return controller
  }

  private bindSelected<T>(spec: SettingsScopeSpec<T>): SettingsScope<T> {
    const ctx = this.ctx
    const controllers = new Map<SettingsDescribeMirror, SettingsScope<T>>()
    const current = (): SettingsScope<T> => {
      let scope = controllers.get(this.selectedMirror)
      if (scope === undefined) {
        scope = this.bind(spec, this.selectedMirror.target)
        controllers.set(this.selectedMirror, scope)
      }
      return scope
    }
    let scope = current()
    const store = createSnapshotStore(scope.getSnapshot())
    let stop = scope.subscribe(() => { store.set(scope.getSnapshot()) })
    const stopSelection = this.selected.subscribe(() => {
      const next = current()
      if (next === scope) return
      stop()
      scope = next
      store.set(scope.getSnapshot())
      stop = scope.subscribe(() => { store.set(scope.getSnapshot()) })
    })
    ctx.effect(() => () => { stop(); stopSelection() }, `ui-settings: selected ${spec.namespace} scope`)
    return { getSnapshot: () => store.getSnapshot(), subscribe: listener => store.subscribe(listener),
      set: (field, value) => current().set(field, value), unset: field => current().unset(field) }
  }
}

/** Viewing state of the Settings document selector. */
export interface SettingsSelectionSnapshot {
  /** Address of the current settings form. */
  target: SettingsTarget
  /** Workspace executable settings are applied only after explicit trust. */
  trusted?: boolean
  /** Whether a scoped read or trust write awaits acknowledgement. */
  loading: boolean
  /** Diagnostic from the latest scoped read or trust write. */
  error: string | null
}

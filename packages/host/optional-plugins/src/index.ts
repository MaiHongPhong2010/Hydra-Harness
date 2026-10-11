/** Global optional-plugin invocation gate; lifetime owners drain before removing contributions. */
import { Service, type Context } from '@hydraharness/cordis'
import z from '@hydraharness/schemastery'
import { settingsNamespace, type SettingsScope } from '@hydraharness/harness-settings'

declare module '@hydraharness/cordis' {
  interface Context { optionalPlugins: OptionalPluginPolicy }
}

/** Immediate disablement and leases for operations that may already be running. */
export class OptionalPluginPolicy extends Service {
  static inject = ['settings']
  private readonly settings: SettingsScope<{ enabled: boolean }>
  private active = 0
  private readonly waiters = new Set<() => void>()
  private readonly listeners = new Set<(enabled: boolean) => void>()

  /**
 * @param ctx - global settings and owning plugin lifetime.
 */
  constructor(ctx: Context) {
    super(ctx, 'optionalPlugins')
    this.settings = ctx.settings.register(settingsNamespace('optional-plugins'), z.object({ enabled: z.boolean().default(true) }))
    ctx.effect(() => this.settings.watch((value) => {
      if (value.enabled) this.releaseWaiters()
      for (const listener of this.listeners) listener(value.enabled)
    }), 'optional-plugins: accepted policy')
  }
  /** Committed policy, read synchronously before every invocation. */
  get enabled(): boolean { return this.settings.get().enabled }

  /** Rejects new optional work while disabled and tracks work already admitted.
 * @returns an idempotent completion lease; rejects a new operation immediately while disabled.
 */
  acquire(): () => void {
    if (!this.enabled) throw new Error('Optional plugins are disabled')
    this.active += 1
    let released = false
    return () => {
      if (released) return
      released = true
      this.active -= 1
      if (this.active === 0) this.releaseWaiters()
    }
  }
  /** Waits for owned work before a contribution can be removed.
 * @returns settlement when existing optional operations finish, or the user enables plugins again.
 */
  drain(): Promise<void> {
    if (this.active === 0 || this.enabled) return Promise.resolve()
    return new Promise((resolve) => { this.waiters.add(resolve) })
  }
  /** Observes accepted common-policy changes.
 * @param listener - callback after an accepted policy change.
 * @returns subscription disposer.
 */
  subscribe(listener: (enabled: boolean) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  private releaseWaiters(): void {
    for (const waiter of this.waiters) waiter()
    this.waiters.clear()
  }
}
export default OptionalPluginPolicy

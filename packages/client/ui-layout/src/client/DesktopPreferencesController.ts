/** Host preference acknowledgement and native application for one desktop renderer. */
import { createSnapshotStore, type SettingsScope } from '@hydraharness/harness-client-runtime/client'
import type { DesktopPreferences } from '../preferences.ts'
import type { NativePreferences, NativePreferencesApi, NativePreferencesSnapshot } from './desktop-preferences.ts'

const NATIVE_FIELDS = ['terminalShell', 'closeConfirmation', 'popoutHotkey', 'popoutStandalone'] as const

/** Applies accepted settings without replacing Host storage with renderer-local state. */
export class DesktopPreferencesController {
  /** Detected OS capabilities and failures applying accepted preferences. */
  readonly native = createSnapshotStore<NativePreferencesSnapshot>({})
  private last: Partial<NativePreferences> = {}
  private tail: Promise<void> = Promise.resolve()

  /**
 * @param scope - Host mirror.
 * @param api - trusted preload operations, absent on Web.
 */
  constructor(readonly scope: SettingsScope<DesktopPreferences>, private readonly api?: NativePreferencesApi) {}

  /** Watches accepted preferences and refreshes OS state when the window regains focus.
 * @returns disposer for accepted-value and OS-focus subscriptions.
 */
  start(): () => void {
    const adopt = () => {
      const value = this.scope.getSnapshot().value
      const api = this.api
      if (value === undefined || api === undefined) return
      this.tail = this.tail.then(async () => {
        for (const field of NATIVE_FIELDS) {
          if (value[field] === this.last[field]) continue
          try {
            const accepted = await api.configure({ [field]: value[field] })
            this.last = { ...this.last, [field]: accepted[field] }
          } catch (error: unknown) {
            this.native.set({ ...this.native.getSnapshot(), error: `${field}: ${error instanceof Error ? error.message : String(error)}` })
          }
        }
      })
    }
    const off = this.scope.subscribe(adopt)
    adopt()
    const refresh = () => { void this.refresh() }
    window.addEventListener('focus', refresh)
    refresh()
    return () => { off(); window.removeEventListener('focus', refresh) }
  }

  /** Refreshes detected shells, OS startup state, and notification availability.
 * @returns completion of the OS query.
 */
  async refresh(): Promise<void> {
    if (this.api === undefined) return
    try { this.native.set({ ...this.native.getSnapshot(), status: await this.api.status() }) }
    catch (error: unknown) {
      this.native.set({ ...this.native.getSnapshot(), error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** Persists a preference and restores the accepted Host value if the write fails.
 * @param field - owning setting.
 * @param value - selected value.
 * @returns Host acceptance and native application.
 */
  async save(field: keyof DesktopPreferences, value: string | boolean): Promise<void> {
    if (!this.scope.getSnapshot().writable) throw new Error('Settings are read only')
    await this.tail
    const previous = this.scope.getSnapshot().value?.[field]
    const nativeField = NATIVE_FIELDS.some(key => key === field)
    if (nativeField && this.api !== undefined) await this.api.configure({ [field]: value })
    try {
      await this.scope.set(field, value)
      if (this.scope.getSnapshot().value?.[field] !== value) throw new Error('Could not save this setting. Try again.')
    } catch (error: unknown) {
      if (nativeField && previous !== undefined) {
        try { await this.api?.configure({ [field]: this.scope.getSnapshot().value?.[field] ?? previous }) }
        catch (rollbackError: unknown) { throw new AggregateError([error, rollbackError], 'Could not save or restore the native preference. Check the active value before retrying.') }
      }
      throw error
    }
    this.native.set({ ...this.native.getSnapshot(), error: undefined })
  }

  /** Opens OS startup settings and refreshes their current state.
 * @returns navigation and refresh completion.
 */
  async openStartup(): Promise<void> {
    if (this.api === undefined) throw new Error('Startup settings are unavailable')
    await this.api.openStartup()
    await this.refresh()
  }
}

/** Connected-window delivery with native deduplication and browser permission handling. */
import { createSnapshotStore, type ISessions, type SettingsScope } from '@hydraharness/harness-client-runtime/client'
import type { NotificationId, NotificationRequest, NotificationSettings } from '@hydraharness/harness-notifications/types'
import type { NativePreferencesApi } from './desktop-preferences.ts'

/** Determines delivery from actual live events and the user's policy.
 * @param request - fresh Host fact.
 * @param policy - accepted user notification choices.
 * @param foreground - whether a connected Hydra window has focus.
 * @returns whether the notification should be delivered.
 */
export function shouldNotify(request: NotificationRequest, policy: NotificationSettings, foreground: boolean): boolean {
  return request.kind === 'question' ? policy.questions
    : policy.completion === 'always' || (policy.completion === 'background' && !foreground)
}

/** Desktop uses OS sound; browsers synthesize a short preview/delivery tone. */
export async function notificationTone(): Promise<void> {
  const audio = new AudioContext()
  try {
    await audio.resume()
    const tone = audio.createOscillator()
    const volume = audio.createGain()
    tone.frequency.value = 660
    volume.gain.setValueAtTime(0.12, audio.currentTime)
    volume.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.2)
    tone.connect(volume).connect(audio.destination)
    tone.start()
    tone.stop(audio.currentTime + 0.2)
    await new Promise<void>((resolve) => { tone.onended = () => { resolve() } })
  } finally { await audio.close() }
}

/** Notification execution belongs to the connected renderer or trusted native bridge. */
export class NotificationsController {
  /** Display permission and delivery failures, separate from the user's saved policy. */
  readonly permission = createSnapshotStore<{ status: string; error?: string | undefined }>({ status: 'unavailable' })
  private readonly delivered = new Set<NotificationId>()
  /**
 * @param scope - user policy.
 * @param sessions - click navigation.
 * @param api - optional Desktop provider.
 */
  constructor(readonly scope: SettingsScope<NotificationSettings>, private readonly sessions: ISessions,
    private readonly api?: NativePreferencesApi) { this.refreshPermission() }

  /** Read permission separately from the saved user choice. */
  refreshPermission(): void {
    this.permission.set({ status: this.api === undefined ? typeof Notification === 'undefined' ? 'unavailable' : Notification.permission : 'managed by operating system' })
  }
  /** Requests display permission after a user gesture or opens OS notification settings.
 * @returns the result of a user-triggered browser prompt or OS settings navigation.
 */
  async requestPermission(): Promise<void> {
    try {
      if (this.api !== undefined) await this.api.openNotificationSettings()
      else if (typeof Notification !== 'undefined') await Notification.requestPermission()
      else throw new Error('Notifications are unavailable in this browser')
      this.refreshPermission()
    } catch (error: unknown) {
      this.permission.set({ ...this.permission.getSnapshot(), error: error instanceof Error ? error.message : String(error) })
    }
  }
  /** Commits one notification policy field through the Host mirror.
 * @param field - policy field.
 * @param value - selected scalar.
 * @returns Host acceptance.
 */
  async save(field: keyof NotificationSettings, value: string | boolean): Promise<void> {
    if (!this.scope.getSnapshot().writable) throw new Error('Settings are read only')
    await this.scope.set(field, value)
    if (this.scope.getSnapshot().value?.[field] !== value) throw new Error('Could not save this setting. Try again.')
  }
  /** Plays the default sound after a user gesture.
 * @returns user-triggered sound preview; audio permission failures remain visible.
 */
  async preview(): Promise<void> {
    try { await notificationTone() }
    catch (error: unknown) {
      this.permission.set({ ...this.permission.getSnapshot(), error: error instanceof Error ? error.message : String(error) })
    }
  }
  /** Delivers each fresh fact once and navigates notification clicks to its chat.
 * @param request - fresh Host fact.
 * @returns delivery settlement; permission failures remain visible in Settings.
 */
  async deliver(request: NotificationRequest): Promise<void> {
    const policy = this.scope.getSnapshot().value
    if (policy === undefined || this.delivered.has(request.id)) return
    const foreground = document.visibilityState === 'visible' && document.hasFocus()
    if (!shouldNotify(request, policy, this.api === undefined ? foreground : false)) return
    this.delivered.add(request.id)
    try {
      if (this.api !== undefined) {
        const result = await this.api.notify({ id: request.id, sessionId: request.sessionId, title: request.title, body: request.body, silent: policy.sound === 'off', kind: request.kind, completionPolicy: policy.completion })
        if (!result.delivered && result.reason === 'Notifications are unavailable') throw new Error(result.reason)
      } else if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        const notice = new Notification(request.title, { body: request.body, tag: request.id, silent: true })
        notice.onclick = () => { window.focus(); this.sessions.open(request.sessionId); notice.close() }
        if (policy.sound === 'default') await notificationTone()
      } else this.refreshPermission()
    } catch (error: unknown) {
      this.permission.set({ ...this.permission.getSnapshot(), error: error instanceof Error ? error.message : String(error) })
    }
  }
}

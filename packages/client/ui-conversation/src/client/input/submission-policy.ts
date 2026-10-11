/**
 * Composer submission policy. It owns the live busy-Enter
 * preference and resolves keyboard gestures into queue/steer delivery modes;
 * Host and Agent keep the actual delivery-window authority.
 */
import {
  createSnapshotStore, type SettingsScope, type SnapshotStore,
} from '@hydraharness/harness-client-runtime/client'
import type {
  ComposerSubmitGesture, InputSubmitMode,
} from '../contract/composer-submission.ts'
import { DEFAULT_BUSY_ENTER_BEHAVIOR } from '../../submission-settings.ts'
import type { ConversationSettings } from '../../submission-settings.ts'

export { DEFAULT_BUSY_ENTER_BEHAVIOR } from '../../submission-settings.ts'

/**
 * Busy-Enter policy used by both the composer inject face and its Settings row.
 * Direct `steer` is intentionally best-effort: AgentLoop turns a closed-window
 * submission into the next waking Queue item.
 */
export class ComposerSubmissionPolicy {
  /** Accepted composition preferences. */
  readonly preferences: SnapshotStore<Required<ConversationSettings>> = createSnapshotStore({
    busyEnter: DEFAULT_BUSY_ENTER_BEHAVIOR, plainText: false, showContextUsage: true, sendShortcut: 'enter',
  })
  /** Whether the settings provider currently accepts writes. */
  readonly writable: SnapshotStore<boolean> = createSnapshotStore(false)
  private readonly host: SettingsScope<ConversationSettings> | undefined

  /**
   * @param host - durable preference scope owned by the providing plugin;
   * absent compositions stay process-local. The adoption subscription shares
   * the scope's plugin lifetime — a disposed scope never publishes again, so
   * the policy needs no release hook.
   */
  constructor(host?: SettingsScope<ConversationSettings>) {
    this.host = host
    if (host !== undefined) {
      host.subscribe(() => { this.adopt(host) })
      this.adopt(host)
    }
  }

  /**
   * Resolve one keyboard gesture without changing state.
   * @param running - whether the addressed agent currently reports busy.
   * @param gesture - plain Enter or the Cmd/Ctrl-accelerated chord.
   * @param steeringAvailable - whether this session transport supports steering.
   * @returns Queue outside steer-capable busy state; otherwise the preferred mode or its opposite.
   */
  resolve(
    running: boolean,
    gesture: ComposerSubmitGesture,
    steeringAvailable: boolean,
  ): InputSubmitMode {
    if (!running || !steeringAvailable) return 'queue'
    const preferred = this.preferences.getSnapshot().busyEnter
    const opposite = gesture === 'alternate'
      || (gesture === 'accelerated' && this.preferences.getSnapshot().sendShortcut === 'enter')
    return opposite ? (preferred === 'queue' ? 'steer' : 'queue') : preferred
  }

  /**
   * Save one preference and publish only the Host-acknowledged value.
   * @param field - conversation preference field.
   * @param value - schema-valid value selected by the user.
   * @returns settlement; rejects if the Host did not accept the selected value.
   */
  async save(field: keyof ConversationSettings, value: ConversationSettings[keyof ConversationSettings]): Promise<void> {
    if (this.host === undefined) throw new Error('Settings are unavailable')
    if (!this.host.getSnapshot().writable) throw new Error('Settings are read only')
    await this.host.set(field, value)
    if (this.host.getSnapshot().value?.[field] !== value) throw new Error('Could not save this setting. Try again.')
  }

  /**
   * Adopt the scope's accepted durable behavior without writing it back.
   * @param host - the constructor-narrowed scope driving this adoption.
   */
  private adopt(host: SettingsScope<ConversationSettings>): void {
    const snapshot = host.getSnapshot()
    this.writable.set(snapshot.writable)
    const section = snapshot.value
    if (section === undefined) return
    const resolved: Required<ConversationSettings> = {
      busyEnter: section.busyEnter,
      plainText: section.plainText ?? false,
      showContextUsage: section.showContextUsage ?? true,
      sendShortcut: section.sendShortcut ?? 'enter',
    }
    const held = this.preferences.getSnapshot()
    if (Object.keys(resolved).some(key => resolved[key as keyof typeof resolved] !== held[key as keyof typeof held])) {
      this.preferences.set(resolved)
    }
  }
}

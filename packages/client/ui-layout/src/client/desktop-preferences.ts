/** Desktop preference IPC and capability state. */
import type { DesktopPreferences } from '../preferences.ts'
import type { WorkspaceId, SessionId } from '@hydraharness/harness-client-runtime/client'

/** Preferences executed natively, with each field validated by the Electron owner. */
export type NativePreferences = Pick<DesktopPreferences, 'terminalShell' | 'closeConfirmation' | 'popoutHotkey' | 'popoutStandalone'>

/** Current OS capabilities; startup is read from the operating system. */
export interface NativePreferencesStatus {
  shells: { value: string; label: string }[]
  startup: { enabled: boolean; available: boolean }
  notifications: boolean
  preferences: NativePreferences
}

/** Allowlisted operations exposed only to trusted Hydra windows. */
export interface NativePreferencesApi {
  openNotificationSettings(): Promise<void>
  /** @returns current discovered shells, startup state and notification support. */
  status(): Promise<NativePreferencesStatus>
  /**
   * Apply a validated native preference; hotkey conflicts preserve the old registration.
   * @param value - changed native preference fields.
   * @returns native accepted values.
   */
  configure(value: Partial<NativePreferences>): Promise<NativePreferences>
  /** Open the operating system's startup-app settings. */
  openStartup(): Promise<void>
  /**
   * Publish the selected project for the global popout shortcut.
   * @param workspaceId - selected project, or no project.
   */
  setContext(workspaceId: WorkspaceId | undefined): void
  /**
   * Deliver once across all trusted windows, with a chat-specific click target.
   * @param value - bounded notification fields and deduplication identity.
   * @returns whether a new notification was submitted.
   */
  notify(value: { id: string; sessionId: SessionId; title: string; body: string; silent: boolean; kind: 'completion' | 'question'; completionPolicy: 'never' | 'background' | 'always' }): Promise<{ delivered: boolean; reason?: string }>
}

/** Native discovery and execution failures projected to settings rows. */
export interface NativePreferencesSnapshot {
  status?: NativePreferencesStatus
  error?: string | undefined
}

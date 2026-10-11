/** `settings.permission` namespace dictionaries (the Permission row's copy). */

/** English dictionary (the key-set source of truth). */
export const en = {
  saving: 'Saving…',
  reset: 'Reset to inherited permission',
  'title': 'Default permissions',
  'description': 'Save the default and apply it to open chats. Changes control the next action.',
  'full.title': 'Full access',
  'full.description': 'Allow file access and commands without approval in open and new chats.',
  'retry': 'Retry open chats',
  'loading': 'Loading',
  'unavailable': 'Unavailable',
  'preset.readOnly': 'Read only',
  'preset.workspaceWrite': 'Edit',
  'preset.fullAccess': 'Auto-Pilot',
  'confirm.title': 'Enable Auto-Pilot?',
  'confirm.description': 'Auto-Pilot allows file changes and external commands without approval in open and new chats. Only enable it when you trust these tasks.',
  'confirm.acknowledge': 'I understand the risks and want to continue',
  'confirm.cancel': 'Cancel',
  'confirm.enable': 'Enable Auto-Pilot',
} satisfies Record<string, string>

/** The settings.permission namespace key union. */
export type PermissionSettingsKey = keyof typeof en

/** English dictionary for the current-session popup gate (the key-set source of truth). */
export const accessEn = {
  'preset.readOnly': 'Read only',
  'preset.workspaceWrite': 'Edit',
  'preset.fullAccess': 'Auto-Pilot',
  'confirm.title': 'Enable Auto-Pilot?',
  'confirm.description': 'Auto-Pilot reduces confirmation steps and lets the agent perform more actions directly, including sensitive operations, file changes, or external commands. Only use it when you trust the current task.',
  'confirm.acknowledge': 'I understand the risks and want to continue',
  'confirm.cancel': 'Cancel',
  'confirm.enable': 'Enable Auto-Pilot',
} satisfies Record<string, string>

/** Current-session popup-gate key union. */
export type PermissionAccessKey = keyof typeof accessEn

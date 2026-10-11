/** Shell chrome and General-nav dictionaries; feature rows own their copy. */

/** English dictionary (the key-set source of truth). */
export const en = {
  'trigger': 'Settings',
  'title': 'Settings',
  'close': 'Close',
  'openDocument': 'Open configuration file',
  'openDocument.error': 'Could not open configuration file',
  'general.nav': 'General',
  'search': 'Search settings',
  'search.empty': 'No matching settings',
  'general.permissions': 'Permissions',
  'general.general': 'General',
  'general.composer': 'Composer',
  'general.popout': 'Popout Window',
  'general.notifications': 'Notifications',
  'general.toys': 'Toys',
  'trust.allow': 'Trust workspace',
  'trust.title': 'Trust this workspace?',
  'trust.description': 'MCP servers, hooks, and agent presets in this workspace can run commands on your computer. Trust only a workspace whose contents you recognize. This permission applies to future edits until you revoke it.',
  'trust.cancel': 'Cancel',
} satisfies Record<string, string>

/** The settings namespace key union. */
export type SettingsKey = keyof typeof en

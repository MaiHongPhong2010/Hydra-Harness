/** `settings.theme` namespace dictionaries (the Appearance row's copy). */

/** English dictionary (the key-set source of truth). */
export const en = {
  'appearance.title': 'Appearance',
  'appearance.light': 'Light',
  'appearance.dark': 'Dark',
  'appearance.system': 'System',
  'appearance.saving': 'Saving…',
  'appearance.applies': 'Applied immediately.',
} satisfies Record<string, string>

/** The settings.theme namespace key union. */
export type ThemeKey = keyof typeof en

/** `settings.locale` namespace dictionaries (the Language row's copy). */

/** English dictionary (the key-set source of truth). */
export const en = {
  'language.title': 'Language',
  'language.auto': 'Auto',
  'language.description': 'Choose the UI language, or follow the browser.',
  'language.saving': 'Saving…',
  'language.applies': 'Applied immediately.',
} satisfies Record<string, string>

/** The settings.locale namespace key union. */
export type SettingsLocaleKey = keyof typeof en

/** Host-acknowledged composer preference controls. */
import { PreferenceRow } from '@hydraharness/harness-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime, HostObservable } from '@hydraharness/harness-client-ui-slots'
import type { ConversationSettings } from '../../submission-settings.ts'
import type { ConversationKey } from '../locales.ts'

/** A row's registration-owned preference and mutation. */
export interface ComposerPreferenceRowInjected {
  field: keyof ConversationSettings
  title: ConversationKey
  description: ConversationKey
  save: (value: ConversationSettings[keyof ConversationSettings]) => Promise<void>
  hooks: {
    preferences: HostObservable<Required<ConversationSettings>>
    writable: HostObservable<boolean>
  }
}

type Props = PropsRuntime<'settings.general.composer.item'> & PropsLocale<'conversation'>
  & InjectFace<ComposerPreferenceRowInjected>

/**
 * Render one scalar preference with pending and failure feedback.
 * @param props - accepted settings and owning mutation.
 * @returns a preference row.
 */
export function ComposerPreferenceRow({ field, title, description, save, usePreferences, useWritable, t }: Props) {
  const value = usePreferences(settings => settings[field])
  const writable = useWritable(state => state)
  const options = field === 'sendShortcut'
    ? [{ value: 'enter', label: 'Enter' }, { value: 'mod-enter', label: 'Ctrl/Cmd+Enter' }]
    : field === 'busyEnter'
      ? [{ value: 'queue', label: t('settings.enter.queue') }, { value: 'steer', label: t('settings.enter.steer') }]
      : undefined
  return <PreferenceRow title={t(title)} description={t(description)} value={value} disabled={!writable}
    options={options} savingLabel={t('settings.saving')} appliesLabel={t('settings.applied')}
    onChange={next => save(next as ConversationSettings[keyof ConversationSettings])} />
}

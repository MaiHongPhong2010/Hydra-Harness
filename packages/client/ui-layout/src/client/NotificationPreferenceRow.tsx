/** Notification policy and separately displayed execution permission. */
import { Button, PreferenceRow } from '@hydraharness/harness-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@hydraharness/harness-client-ui-slots'
import type { SettingsScopeSnapshot } from '@hydraharness/harness-client-runtime/client'
import type { NotificationSettings } from '@hydraharness/harness-notifications/types'

/** Owning actions and accepted snapshots. */
export interface NotificationRowInjected {
  field: keyof NotificationSettings
  save: (value: string | boolean) => Promise<void>
  requestPermission: () => Promise<void>
  preview: () => Promise<void>
  hooks: {
    preferences: HostObservable<SettingsScopeSnapshot<NotificationSettings>>
    permission: HostObservable<{ status: string; error?: string | undefined }>
  }
}
type Props = PropsRuntime<'settings.general.notifications.item'> & PropsLocale<'settings.desktop'> & InjectFace<NotificationRowInjected>
/**
 * @param props - accepted policy and delivery capability.
 * @returns one scalar notification preference.
 */
export function NotificationPreferenceRow({ field, save, preview, requestPermission, usePreferences, usePermission, t }: Props) {
  const state = usePreferences(value => value)
  const permission = usePermission(value => value)
  const value = state.value?.[field]
  if (value === undefined) return null
  const options = field === 'completion' ? ['never', 'background', 'always'] : field === 'sound' ? ['default', 'off'] : undefined
  return <PreferenceRow title={t(`notification.${field}.title`)} description={t(`notification.${field}.description`)} value={value}
    disabled={!state.writable} options={options?.map(value => ({ value, label: t(`notification.${value}` as 'notification.never') }))}
    onChange={save} savingLabel={t('saving')} appliesLabel={t('applied')}>
    {field === 'permissionPrompts' && <div><div>{t('notification.permission')}: {permission.status}</div>
      {value === true && <Button size="sm" onClick={() => { void requestPermission() }}>{t('notification.grant')}</Button>}
      {permission.error !== undefined && <div role="alert">{permission.error}</div>}</div>}
    {field === 'sound' && <Button size="sm" disabled={value === 'off'} onClick={() => { void preview() }}>{t('notification.preview')}</Button>}
    {field === 'sound' && permission.error !== undefined && <div role="alert">{permission.error}</div>}
  </PreferenceRow>
}

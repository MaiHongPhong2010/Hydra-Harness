/** Empty-chat draft choices; clicking never submits a prompt. */
import { useEffect, useState } from 'react'
import { Button, PreferenceRow } from '@hydraharness/harness-client-ui-primitives'
import type { SettingsScopeSnapshot } from '@hydraharness/harness-client-runtime/client'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@hydraharness/harness-client-ui-slots'
import type {} from '@hydraharness/harness-client-ui-conversation/client'
import type { SuggestedPromptBatch } from '@hydraharness/harness-suggested-prompts/types'
import css from './Suggestions.module.css'

/** Feature-owned scalar preference. */
export interface SuggestedPreferenceInjected {
  save: (enabled: boolean) => Promise<void>
  hooks: { preferences: HostObservable<SettingsScopeSnapshot<{ enabled: boolean }>> }
}
/**
 * @param props - accepted setting and mutation.
 * @returns the suggested-prompts control.
 */
export function SuggestedPreferenceRow({ usePreferences, save, t }: PropsRuntime<'settings.general.general.item'> & PropsLocale<'suggestions'> & InjectFace<SuggestedPreferenceInjected>) {
  const state = usePreferences(value => value)
  if (state.value === undefined) return null
  return <PreferenceRow title={t('title')} description={t('description')} value={state.value.enabled} disabled={!state.writable}
    savingLabel={t('saving')} appliesLabel={t('applies')} onChange={value => save(value === true)} />
}

/** Generation remains behind the receiving chat's API. */
export interface SuggestionsInjected extends SuggestedPreferenceInjected { load: (refresh: boolean) => Promise<SuggestedPromptBatch> }
/**
 * @param props - empty-chat input actions and one bounded generation batch.
 * @returns draft choices and refresh/error feedback.
 */
export function Suggestions({ usePreferences, inputActions, load, t }: PropsRuntime<'conversation.hero.suggestions'> & PropsLocale<'suggestions'> & InjectFace<SuggestionsInjected>) {
  const enabled = usePreferences(value => value.value?.enabled === true)
  const [batch, setBatch] = useState<SuggestedPromptBatch>({ items: [] })
  const [busy, setBusy] = useState(false)
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    if (!enabled) return
    let mounted = true
    setBusy(true)
    void load(refresh > 0).then((value) => { if (mounted) setBatch(value) }, (error: unknown) => {
      if (mounted) setBatch({ items: [], error: error instanceof Error ? error.message : String(error) })
    }).finally(() => { if (mounted) setBusy(false) })
    return () => { mounted = false }
  }, [enabled, load, refresh])
  if (!enabled) return null
  return <div className={css.suggestions} aria-label={t('title')}>
    {batch.items.map(text => <Button key={text} variant="outline" disabled={busy} onClick={() => { inputActions.setDraft(text) }}>{text}</Button>)}
    <Button size="sm" disabled={busy} onClick={() => { setRefresh(value => value + 1) }}>{busy ? t('loading') : t('refresh')}</Button>
    {batch.error !== undefined && <div role="alert">{batch.error}</div>}
  </div>
}

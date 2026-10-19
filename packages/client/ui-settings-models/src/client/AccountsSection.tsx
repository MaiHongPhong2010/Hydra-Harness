/** Account inventory, provider-reported usage, and shortcuts to the shared model editor. */
import { useState } from 'react'
import type { ReactNode } from 'react'
import type { InjectFace, PropsRuntime } from '@hydraharness/harness-client-ui-slots'
import { Button } from '@hydraharness/harness-client-ui-primitives'
import { ProviderAccounts } from './ProviderAccounts.tsx'
import { providerAccountKey } from './store.ts'
import type { ProviderRow } from './store.ts'
import { providerCopy, type ModelsSectionInjected } from './ModelsSection.tsx'
import { ProviderEditor } from './ProviderEditor.tsx'
import styles from './ModelsSection.module.css'

/** Accounts uses the Models controller's directory and credential invalidations. */
export type AccountsSectionInjected = Pick<ModelsSectionInjected, 'controller' | 'api' | 'schema' | 't'> & {
  hooks: Pick<ModelsSectionInjected['hooks'], 'snapshot'>
}

/** Slot-owned navigation and framework-bound snapshot hook. */
export type AccountsSectionProps = Partial<InjectFace<AccountsSectionInjected> & PropsRuntime<'settings.section'>>

/**
 * Render account management and explicit, revision-checked model catalog editing.
 * @param props - shared controller, account and model editor dependencies, and section navigation.
 * @returns the Accounts page, or null before injection.
 */
export function AccountsSection(props: AccountsSectionProps): ReactNode {
  const { controller, useSnapshot, api, schema, t, openSection } = props
  if (controller === undefined || useSnapshot === undefined || api === undefined || schema === undefined || t === undefined) return null
  return <Loaded controller={controller} useSnapshot={useSnapshot} api={api} schema={schema} t={t}
    {...openSection === undefined ? {} : { openSection }} />
}

function Loaded({ controller, useSnapshot, api, schema, t, openSection }: InjectFace<AccountsSectionInjected>
  & Pick<AccountsSectionProps, 'openSection'>): ReactNode {
  const state = useSnapshot(snapshot => snapshot)
  const [selected, setSelected] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<ProviderRow>()
  const [saved, setSaved] = useState<string>()
  if (state.status === 'idle') void controller.load()
  const providers = new Map<string, string>()
  for (const row of state.rows) {
    const key = providerAccountKey(row.entry.settingsNs, row.entry.provider)
    if (key !== undefined) providers.set(key, key.endsWith('/antigravity') ? 'Google' : row.entry.displayName)
  }
  const active = selected !== undefined && providers.has(selected) ? selected : providers.keys().next().value
  const modelProviders = state.rows.filter(row => providerAccountKey(row.entry.settingsNs, row.entry.provider) === active)
  const namespace = editing === undefined ? undefined : state.namespaces.get(editing.entry.settingsNs)
  return <div className={styles['section']}>
    <h2 className={styles['title']}>{t('accountsTitle')}</h2>
    <p className={styles['intro']}>{t('accountsIntro')}</p>
    <Button variant="outline" onClick={() => { openSection?.('models') }}>{t('manageModels')}</Button>
    {state.status === 'error' ? <>
      <p className={styles['error']} role="alert">{`${t('loadFailed')}: ${state.error}`}</p>
      <Button variant="outline" onClick={() => { void controller.load() }}>{t('retry')}</Button>
    </> : active === undefined ? <p role="status">{t(state.status === 'ready' ? 'accountsUnavailable' : 'accountsLoading')}</p> : <>
      <label className={styles['field']}>
        <span className={styles['fieldLabel']}>{t('provider')}</span>
        <select data-hydra-control="field" className={styles['input']} value={active} aria-label={t('provider')}
          onChange={(event) => { setSelected(event.target.value); setEditing(undefined); setSaved(undefined) }}>
          {[...providers].map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select>
      </label>
      <div className={styles['modelCatalogActions']}>
        {modelProviders.map(row => <Button key={row.entry.provider} variant="outline"
          disabled={busy || editing !== undefined || !state.writable || row.accountCount === 0
            || row.entry.provider === 'cursor' || !state.namespaces.has(row.entry.settingsNs)}
          title={!state.writable ? t('readOnly') : row.entry.provider === 'cursor' ? t('accountTransportUnavailable')
            : row.accountCount === 0 ? t('accountMissing') : t('fetchModelsHint')}
          onClick={() => { setEditing(row); setSaved(undefined) }}>
          {modelProviders.length === 1 ? t('fetchAccountModels')
            : t('fetchAccountProviderModels').replace('{provider}', row.entry.displayName)}
        </Button>)}
      </div>
      {saved === undefined ? null : <p className={styles['savedNotice']} role="status">{saved}</p>}
      {editing === undefined || namespace === undefined ? null : <ProviderEditor key={editing.entry.provider}
        provider={editing.entry.provider} displayName={editing.entry.displayName} settingsPath={editing.entry.settingsPath}
        namespace={namespace} schema={schema} api={api} t={t} readOnly={!state.writable} fetchOnOpen
        onClose={(changed) => {
          setEditing(undefined)
          if (changed) {
            setSaved(providerCopy(t('savedProvider'), editing.entry))
            void controller.load()
          }
        }} />}
      {active.endsWith('/antigravity') ? <p className={styles['advancedHint']}>{t('googleAccountsHint')}</p> : null}
      <ProviderAccounts key={active} flowKey={active} api={api.authorization} t={t} disabled={false} onBusy={setBusy} />
    </>}
  </div>
}

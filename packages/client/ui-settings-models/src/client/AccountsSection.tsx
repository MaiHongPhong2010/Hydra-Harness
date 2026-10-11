/** Global account inventory and provider-reported usage, independent of model configuration. */
import { useState } from 'react'
import type { ReactNode } from 'react'
import type { InjectFace, PropsRuntime } from '@hydraharness/harness-client-ui-slots'
import { Button } from '@hydraharness/harness-client-ui-primitives'
import { ProviderAccounts } from './ProviderAccounts.tsx'
import { providerAccountKey } from './store.ts'
import type { ModelsSectionInjected } from './ModelsSection.tsx'
import styles from './ModelsSection.module.css'

/** Accounts uses the Models controller's directory and credential invalidations. */
export type AccountsSectionInjected = Pick<ModelsSectionInjected, 'controller' | 'api' | 't'> & {
  hooks: Pick<ModelsSectionInjected['hooks'], 'snapshot'>
}

/** Slot-owned navigation and framework-bound snapshot hook. */
export type AccountsSectionProps = Partial<InjectFace<AccountsSectionInjected> & PropsRuntime<'settings.section'>>

/**
 * Render accounts without writing provider profiles or model catalogs.
 * @param props - shared controller, authorization API, and section navigation.
 * @returns the Accounts page, or null before injection.
 */
export function AccountsSection(props: AccountsSectionProps): ReactNode {
  const { controller, useSnapshot, api, t, openSection } = props
  if (controller === undefined || useSnapshot === undefined || api === undefined || t === undefined) return null
  return <Loaded controller={controller} useSnapshot={useSnapshot} api={api} t={t}
    {...openSection === undefined ? {} : { openSection }} />
}

function Loaded({ controller, useSnapshot, api, t, openSection }: InjectFace<AccountsSectionInjected>
  & Pick<AccountsSectionProps, 'openSection'>): ReactNode {
  const state = useSnapshot(snapshot => snapshot)
  const [selected, setSelected] = useState<string>()
  const [, setBusy] = useState(false)
  if (state.status === 'idle') void controller.load()
  const providers = new Map<string, string>()
  for (const row of state.rows) {
    const key = providerAccountKey(row.entry.settingsNs, row.entry.provider)
    if (key !== undefined) providers.set(key, key.endsWith('/antigravity') ? 'Google' : row.entry.displayName)
  }
  const active = selected !== undefined && providers.has(selected) ? selected : providers.keys().next().value
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
          onChange={(event) => { setSelected(event.target.value) }}>
          {[...providers].map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select>
      </label>
      {active.endsWith('/antigravity') ? <p className={styles['advancedHint']}>{t('googleAccountsHint')}</p> : null}
      <ProviderAccounts key={active} flowKey={active} api={api.authorization} t={t} disabled={false} onBusy={setBusy} />
    </>}
  </div>
}

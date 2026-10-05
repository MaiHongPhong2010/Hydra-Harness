/** Account login and per-account sign-out through the Host authorization flows. */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type {
  AuthorizationAttemptView, AuthorizationEntryView, AuthorizationUsageView, IApiClient,
} from '@hydraharness/harness-api-remotes/client'
import { Button, Modal, Tooltip } from '@hydraharness/harness-client-ui-primitives'
import { messageOf } from './store.ts'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

type AuthorizationApi = IApiClient['authorization']

type UsageProvider = 'codex' | 'google' | 'other'

function usageProvider(flowKey: string): UsageProvider {
  if (flowKey.endsWith('/chatgpt')) return 'codex'
  if (flowKey.endsWith('/antigravity')) return 'google'
  return 'other'
}

function remainingPercent(usedPercent: number): number {
  return Math.round(Math.max(0, Math.min(100, 100 - usedPercent)))
}

function resetLabel(resetsAt: number | undefined, t: ProviderAccountsProps['t']): string | undefined {
  return resetsAt === undefined ? undefined
    : t('accountUsageResetAt').replace('{time}', new Date(resetsAt * 1000).toLocaleString())
}

function windowTitle(
  limit: AuthorizationUsageView['limits'][number], provider: UsageProvider,
  t: ProviderAccountsProps['t'],
): string {
  const window = limit.window?.toLocaleLowerCase().replace(/[ _-]+/gu, '')
  const duration = limit.windowMinutes === 300 || /^(?:5h|fivehours?)$/u.test(window ?? '')
    ? t('accountUsage5HourLimit')
    : limit.windowMinutes === 10_080 || /^(?:weekly|week|7d|sevendays?)$/u.test(window ?? '')
      ? t('accountUsageWeeklyLimit') : undefined
  if (duration === undefined) return limit.name
  const genericCodexName = /^(codex|5h|weekly)$/iu.test(limit.name)
  if (provider === 'codex') return genericCodexName ? duration : `${limit.name} · ${duration}`
  return limit.group !== undefined || genericCodexName ? duration : `${limit.name} · ${duration}`
}

function googleGroup(limit: AuthorizationUsageView['limits'][number], t: ProviderAccountsProps['t']): string {
  const value = `${limit.group ?? ''} ${limit.name}`.toLocaleLowerCase()
  if (value.includes('gemini')) return t('accountUsageGeminiModels')
  if (value.includes('claude') || value.includes('gpt')) return t('accountUsageClaudeGptModels')
  return t('accountUsageOtherModels')
}

function UsageLimit({
  limit, provider, t,
}: {
  limit: AuthorizationUsageView['limits'][number]
  provider: UsageProvider
  t: ProviderAccountsProps['t']
}): ReactNode {
  const remaining = remainingPercent(limit.usedPercent)
  const title = windowTitle(limit, provider, t)
  const reset = resetLabel(limit.resetsAt, t)
  const remainingAmount = limit.remainingAmount === undefined ? undefined
    : t('accountUsageRemainingAmount').replace('{amount}', limit.remainingAmount.toLocaleString())
  const value = limit.disabled === true ? t('accountUsageDisabled')
    : t('accountUsageRemaining').replace('{percent}', String(remaining))
  const label = title === t('accountUsage5HourLimit') ? t('accountUsage5HourShort')
    : title === t('accountUsageWeeklyLimit') ? t('accountUsageWeeklyShort') : title
  const details = [...new Set([limit.name, title, value, reset, remainingAmount, limit.description])]
    .filter(part => part !== undefined).join('\n')
  return (
    <Tooltip label={details} side="bottom" maxWidth={300}>
      <div className={`${styles['usageLimit']}${limit.disabled === true ? ` ${styles['usageLimitDisabled']}` : ''}`}
        tabIndex={0} role={limit.disabled === true ? 'group' : 'progressbar'} aria-label={title}
        aria-description={details} aria-valuetext={limit.disabled === true ? undefined : value}
        aria-valuemin={limit.disabled === true ? undefined : 0} aria-valuemax={limit.disabled === true ? undefined : 100}
        aria-valuenow={limit.disabled === true ? undefined : remaining}>
        <div className={styles['usageRing']}>
          <svg viewBox="0 0 48 48" aria-hidden="true">
            <circle className={styles['usageRingTrack']} cx="24" cy="24" r="21" />
            {limit.disabled === true ? null : <circle className={styles['usageRingFill']} cx="24" cy="24" r="21"
              pathLength="100" strokeDasharray={`${remaining} 100`} />}
          </svg>
          <strong>{limit.disabled === true ? '—' : value}</strong>
        </div>
        <span className={styles['usageLimitTitle']}>{limit.disabled === true ? value : label}</span>
      </div>
    </Tooltip>
  )
}

function UsageCredits({ value, t }: {
  value: AuthorizationUsageView['credits']
  t: ProviderAccountsProps['t']
}): ReactNode {
  if (value === undefined || value.length === 0) return null
  return (
    <section className={styles['usageCredits']} aria-label={t('accountUsageCreditsTitle')}>
      <h4>{t('accountUsageCreditsTitle')}</h4>
      {value.map((credit) => {
        const name = credit.creditType ?? credit.tier
        const amount = credit.creditAmount === undefined ? t('accountUsageUnavailable')
          : t('accountUsageCreditsAvailable').replace('{name}', name)
            .replace('{amount}', credit.creditAmount.toLocaleString())
        const minimum = credit.minimumCreditAmountForUsage === undefined ? undefined
          : t('accountUsageCreditsMinimum').replace('{amount}', credit.minimumCreditAmountForUsage.toLocaleString())
        return <Tooltip key={credit.tier} label={minimum ?? t('accountUsageCreditsTitle')} side="bottom">
          <div className={styles['usageCredit']} tabIndex={0} aria-description={minimum}>
            <span>{amount}</span>
          </div>
        </Tooltip>
      })}
    </section>
  )
}

function UsageReport({
  value, provider, t,
}: {
  value: AuthorizationUsageView
  provider: UsageProvider
  t: ProviderAccountsProps['t']
}): ReactNode {
  const groups = provider === 'google'
    ? [...new Map(value.limits.map(limit => [googleGroup(limit, t), [] as AuthorizationUsageView['limits']])).entries()]
      .map(([title]) => ({ title, limits: value.limits.filter(limit => googleGroup(limit, t) === title) }))
    : [{ title: t('accountUsageQuota'), limits: value.limits }]
  return (
    <div className={styles['usageReport']} aria-label={t('accountUsageTitle')}>
      {groups.map(group => (
        <section key={group.title} className={styles['usageGroup']} aria-label={group.title}>
          {provider === 'google' ? <h4>{group.title}</h4> : null}
          <div className={styles['usageLimits']}>
            {group.limits.map((limit, index) => <UsageLimit key={`${limit.name}-${limit.windowMinutes ?? 'model'}-${index}`}
              limit={limit} provider={provider} t={t} />)}
          </div>
        </section>
      ))}
      {value.limits.length === 0 ? <p className={styles['usageEmpty']}>{t('accountUsageNoLimits')}</p> : null}
      {provider === 'codex' ? <div className={styles['usageSummary']}>
        <span className={styles['usageBank']}>{value.bankedResetCount === undefined ? t('accountBankedResetsUnavailable')
          : t('accountBankedResets').replace('{count}', String(value.bankedResetCount))}</span>
      </div> : null}
      {provider === 'google' ? <UsageCredits value={value.credits} t={t} /> : null}
    </div>
  )
}

/** Props for the provider's independently persisted account pool. */
interface ProviderAccountsProps {
  /** Provider-owned authorization flow key. */
  flowKey: string
  /** Service-specific method when several services share one credential pool. */
  method?: string
  /** Add mode shows login controls; manage mode also lists accounts and usage. */
  mode?: 'add' | 'manage'
  /** Authorization wire methods; tokens never reach this component. */
  api: AuthorizationApi
  /** Section copy. */
  t: (key: keyof typeof en) => string
  /** Prevent account changes in a read-only editor. */
  disabled: boolean
  /** Disable the enclosing Apply action while a login is running. */
  onBusy: (busy: boolean) => void
}

/**
 * Render login controls and a searchable, paginated account inventory.
 * Multi-account pools fetch usage only for the expanded row; a sole account opens automatically.
 * Bulk removal requires confirmation and retains failed accounts for retry.
 * Closing the editor cancels the attempt it owns, including a late begin response.
 * @param props - flow identity, wire methods, and editor state.
 * @returns the account controls and status.
 */
export function ProviderAccounts({ flowKey, method, mode = 'manage', api, t, disabled, onBusy }: ProviderAccountsProps): ReactNode {
  const geminiWeb = flowKey === 'llm-account-auth/gemini-web'
  const desktop = (globalThis as typeof globalThis & {
    hydraDesktop?: {
      openExternal?: (url: string) => Promise<void>
    }
  }).hydraDesktop
  const [entry, setEntry] = useState<AuthorizationEntryView>()
  const [selectedMethod, setSelectedMethod] = useState<string>()
  const [attempt, setAttempt] = useState<AuthorizationAttemptView>()
  const [answer, setAnswer] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string>()
  const [copyStatus, setCopyStatus] = useState<'copied' | 'failed'>()
  const [usage, setUsage] = useState<Record<string, AuthorizationUsageView | undefined>>({})
  const [usageFailure, setUsageFailure] = useState<Record<string, boolean>>({})
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(0)
  const [expanded, setExpanded] = useState<string | null>()
  const [selected, setSelected] = useState<readonly string[]>([])
  const [removal, setRemoval] = useState<AuthorizationEntryView['accounts']>()
  const [removalProgress, setRemovalProgress] = useState(0)
  const usageId = useId()
  const pageSelection = useRef<HTMLInputElement>(null)
  const lifetime = useRef<object | undefined>(undefined)
  const activeAttempt = useRef<string | undefined>(undefined)
  const loginAccounts = useRef(new Set<string>())
  const usageSequence = useRef(new Map<string, number>())
  const usageControllers = useRef(new Map<string, AbortController>())
  const requestedUsage = useRef(new Set<string>())
  useEffect(() => { setAnswer('') }, [attempt?.prompt?.id])
  useEffect(() => { setCopyStatus(undefined) }, [attempt?.notice?.snippet])
  useEffect(() => {
    setEntry(undefined)
    setSelectedMethod(undefined)
    setAttempt(undefined)
    setQuery('')
    setPage(0)
    setExpanded(undefined)
    setSelected([])
    setRemoval(undefined)
    setUsage({})
    setUsageFailure({})
    requestedUsage.current.clear()
  }, [flowKey])

  useEffect(() => {
    const token = {}
    lifetime.current = token
    void api.list({}).then((response) => {
      if (lifetime.current !== token) return
      if (!response.result.ok) { setFailure(response.result.error.message); return }
      const next = response.result.value.entries.find(candidate => candidate.key === flowKey)
      setEntry(next)
      if (next === undefined) setFailure(t('accountsUnavailable'))
    }, (error: unknown) => {
      if (lifetime.current === token) setFailure(messageOf(error))
    })
    return () => {
      lifetime.current = undefined
      for (const controller of usageControllers.current.values()) controller.abort()
      usageControllers.current.clear()
      const attemptId = activeAttempt.current
      activeAttempt.current = undefined
      if (attemptId !== undefined) void api.cancel({ attemptId }).catch(() => undefined)
      onBusy(false)
    }
  }, [api, flowKey, onBusy, t])

  const nextUsageSequence = useCallback((accountId: string): number => {
    const sequence = (usageSequence.current.get(accountId) ?? 0) + 1
    usageSequence.current.set(accountId, sequence)
    return sequence
  }, [])

  const requestUsage = useCallback((accountId: string): void => {
    const token = lifetime.current
    /* v8 ignore if -- account effects and refresh buttons request usage only while mounted. */
    if (token === undefined) return
    const sequence = nextUsageSequence(accountId)
    usageControllers.current.get(accountId)?.abort()
    const controller = new AbortController()
    usageControllers.current.set(accountId, controller)
    requestedUsage.current.add(accountId)
    setUsage(current => ({ ...current, [accountId]: undefined }))
    setUsageFailure(current => ({ ...current, [accountId]: false }))
    void api.usage({ key: flowKey, accountId }, controller.signal).then((response) => {
      if (lifetime.current !== token || usageSequence.current.get(accountId) !== sequence) return
      const value = response.result
      if (!value.ok) throw new Error(value.error.message)
      if (value.value.usage === undefined) {
        setUsageFailure(current => ({ ...current, [accountId]: true }))
      } else {
        setUsage(current => ({ ...current, [accountId]: value.value.usage }))
      }
    }).catch(() => {
      if (lifetime.current === token && usageSequence.current.get(accountId) === sequence) {
        setUsageFailure(current => ({ ...current, [accountId]: true }))
      }
    }).finally(() => {
      if (usageControllers.current.get(accountId) === controller) usageControllers.current.delete(accountId)
    })
  }, [api, flowKey, nextUsageSequence])

  const running = attempt?.status === 'running'
  const visibleAccounts = mode === 'manage' && !running && entry?.key === flowKey ? entry.accounts : undefined
  const showSelection = (visibleAccounts?.length ?? 0) > 1 || selected.length > 0
  const search = query.trim().toLocaleLowerCase()
  const filtered = useMemo(() => (visibleAccounts ?? []).filter(account =>
    account.label.toLocaleLowerCase().includes(search) || account.id.toLocaleLowerCase().includes(search)), [visibleAccounts, search])
  const pageCount = Math.max(1, Math.ceil(filtered.length / 10))
  const currentPage = Math.min(page, pageCount - 1)
  const pageAccounts = filtered.slice(currentPage * 10, (currentPage + 1) * 10)
  const expandedId = expanded === undefined && visibleAccounts?.length === 1 ? visibleAccounts[0]?.id : expanded
  const visibleUsageId = pageAccounts.some(account => account.id === expandedId) ? expandedId : undefined
  const selectedOnPage = pageAccounts.filter(account => selected.includes(account.id)).length

  useEffect(() => {
    if (visibleUsageId === undefined || visibleUsageId === null) return
    if (!requestedUsage.current.has(visibleUsageId)) requestUsage(visibleUsageId)
    return () => {
      const controller = usageControllers.current.get(visibleUsageId)
      if (controller !== undefined) {
        controller.abort()
        usageControllers.current.delete(visibleUsageId)
        nextUsageSequence(visibleUsageId)
        requestedUsage.current.delete(visibleUsageId)
      }
    }
  }, [visibleUsageId, requestUsage, nextUsageSequence])

  useEffect(() => {
    if (pageSelection.current !== null) pageSelection.current.indeterminate = selectedOnPage > 0 && selectedOnPage < pageAccounts.length
  }, [selectedOnPage, pageAccounts.length])
  useEffect(() => {
    if (entry?.key === flowKey) setSelected(current => current.filter(id => entry.accounts.some(account => account.id === id)))
  }, [entry, flowKey])

  const attemptId = attempt?.status === 'running' ? attempt.id : undefined
  useEffect(() => {
    if (attemptId === undefined) return
    let stale = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async (): Promise<void> => {
      try {
        const response = await api.state({ attemptId })
        if (stale) return
        if (!response.result.ok) throw new Error(response.result.error.message)
        const next = response.result.value.attempt
        if (next.status === 'running') {
          setAttempt(next)
          timer = setTimeout(() => { void poll() }, 500)
          return
        }
        const listed = await api.list({})
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- cleanup can run while account listing awaits.
        if (stale) return
        if (!listed.result.ok) throw new Error(listed.result.error.message)
        const updated = listed.result.value.entries.find(candidate => candidate.key === flowKey)
        if (next.status === 'authorized') {
          requestedUsage.current.clear()
          setUsage({})
          setUsageFailure({})
          if (mode === 'manage') {
            const addedIndex = updated?.accounts.findIndex(account => !loginAccounts.current.has(account.id)) ?? -1
            const added = addedIndex < 0 ? undefined : updated?.accounts[addedIndex]
            if (added !== undefined) { setQuery(''); setPage(Math.floor(addedIndex / 10)); setExpanded(added.id) }
          }
        }
        setEntry(updated)
        activeAttempt.current = undefined
        onBusy(false)
        setAnswer('')
        setAttempt(next)
      } catch (error) {
        if (stale) return
        setFailure(messageOf(error))
        onBusy(false)
        void api.cancel({ attemptId }).catch(() => undefined)
        activeAttempt.current = undefined
        setAttempt(undefined)
      }
    }
    void poll()
    return () => { stale = true; clearTimeout(timer) }
  }, [api, attemptId, flowKey, mode, onBusy])

  const begin = async (): Promise<void> => {
    const token = lifetime.current
    loginAccounts.current = new Set(entry?.accounts.map(account => account.id))
    setBusy(true)
    setFailure(undefined)
    setAttempt(undefined)
    onBusy(true)
    try {
      const loginMethod = method ?? selectedMethod ?? (entry !== undefined && entry.methods.length > 1 ? entry.methods[0]?.id : undefined)
      const response = await api.begin({ key: flowKey, ...loginMethod === undefined ? {} : { method: loginMethod } })
      if (!response.result.ok) throw new Error(response.result.error.message)
      const attemptId = response.result.value.attemptId
      if (lifetime.current !== token) {
        void api.cancel({ attemptId }).catch(() => undefined)
        return
      }
      activeAttempt.current = attemptId
      setAttempt({ id: attemptId, status: 'running' })
    } catch (error) {
      if (lifetime.current !== token) return
      setFailure(messageOf(error))
      onBusy(false)
    } finally {
      if (lifetime.current === token) setBusy(false)
    }
  }

  const act = async (operation: () => Promise<unknown>): Promise<void> => {
    const token = lifetime.current
    setBusy(true)
    setFailure(undefined)
    try { await operation() } catch (error) {
      if (lifetime.current === token) setFailure(messageOf(error))
    } finally {
      if (lifetime.current === token) setBusy(false)
    }
  }

  const removeAccounts = async (accounts: AuthorizationEntryView['accounts']): Promise<void> => {
    const token = lifetime.current
    setBusy(true)
    onBusy(true)
    setFailure(undefined)
    setRemovalProgress(0)
    const removed = new Set<string>()
    const errors: string[] = []
    try {
      for (const account of accounts) {
        if (lifetime.current !== token) return
        try {
          const response = await api.logout({ key: flowKey, accountId: account.id })
          if (!response.result.ok) throw new Error(response.result.error.message)
          removed.add(account.id)
        } catch (error) { errors.push(`${account.label}: ${messageOf(error)}`) }
        if (lifetime.current !== token) return
        setRemovalProgress(removed.size + errors.length)
      }
      setEntry(current => current === undefined ? undefined
        : { ...current, accounts: current.accounts.filter(account => !removed.has(account.id)) })
      setSelected(current => current.filter(id => !removed.has(id)))
      const listed = await api.list({})
      if (lifetime.current !== token) return
      if (!listed.result.ok) throw new Error(listed.result.error.message)
      setEntry(listed.result.value.entries.find(candidate => candidate.key === flowKey))
      const [firstError] = errors
      if (firstError !== undefined) {
        setFailure(t('accountsRemoveFailed').replace('{count}', String(errors.length)).replace('{error}', firstError))
      }
    } catch (error) {
      if (lifetime.current === token) setFailure(messageOf(error))
    } finally {
      if (lifetime.current === token) { setRemoval(undefined); setBusy(false); onBusy(false) }
    }
  }

  const prompt = running ? attempt.prompt : undefined
  const notice = attempt?.notice
  const snippet = notice?.snippet
  const safeUrl = notice?.url !== undefined && /^https?:\/\//i.test(notice.url) ? notice.url : undefined
  const openExternal = desktop?.openExternal
  const unavailable = entry === undefined || entry.methods.length === 0
  const provider = usageProvider(flowKey)
  return (
    <div className={styles['field']}>
      {geminiWeb && mode === 'add' ? <p className={styles['advancedHint']}>{t('geminiWebHint')}</p> : null}
      {method === undefined && entry !== undefined && entry.methods.length > 1 ? <div className={styles['field']}>
        <label className={styles['fieldLabel']} htmlFor={`${usageId}-method`}>{t('accountSignInMethod')}</label>
        <select data-hydra-control="field" className={styles['input']} disabled={disabled || busy || running}
          id={`${usageId}-method`}
          value={selectedMethod ?? entry.methods[0]?.id}
          onChange={(event) => { setSelectedMethod(event.target.value); setFailure(undefined) }}>
          {entry.methods.map(choice => <option key={choice.id} value={choice.id}>{choice.label}</option>)}
        </select>
      </div> : null}
      <div className={styles['accountActions']}>
        <button type="button" className={styles[mode === 'manage' ? 'primaryButton' : 'secondaryButton']}
          disabled={disabled || busy || running || unavailable}
          onClick={() => { void begin() }}>{t(geminiWeb ? (entry?.accounts.length ? 'geminiWebReconnect' : 'geminiWebConnect') : 'accountAdd')}</button>
        {safeUrl === undefined ? null : <a className={styles['primaryButton']} href={safeUrl} target="_blank" rel="noopener noreferrer"
          onClick={openExternal === undefined ? undefined : (event) => {
            event.preventDefault()
            const token = lifetime.current
            setFailure(undefined)
            void openExternal(safeUrl).catch((error: unknown) => {
              if (lifetime.current === token) setFailure(messageOf(error))
            })
          }}>{t('accountOpenBrowser')}</a>}
        {running ? <button type="button" className={styles['secondaryButton']} disabled={busy}
          onClick={() => { void act(async () => {
            const response = await api.cancel({ attemptId: attempt.id })
            if (!response.result.ok) throw new Error(response.result.error.message)
          }) }}>{t('accountCancel')}</button> : null}
      </div>
      {mode === 'manage' && !running ? <>
        <div className={styles['accountToolbar']}>
          <span className={styles['fieldLabel']}>{t('accounts')}</span>
          {entry === undefined ? <span className={styles['usageStatus']}>{t(failure === undefined ? 'accountsLoading' : 'accountsUnavailable')}</span>
            : <span className={styles['usageStatus']}>{visibleAccounts?.length === 1 ? t('accountsCountOne')
              : t('accountsCount').replace('{count}', String(visibleAccounts?.length ?? 0))}</span>}
        </div>
        <p className={styles['advancedHint']}>{t(geminiWeb ? 'geminiWebHint' : 'accountsHint')}</p>
        {(visibleAccounts?.length ?? 0) > 1 || query.length > 0 ? <input data-hydra-control="field" type="search"
          className={styles['input']} aria-label={t('accountsSearch')} placeholder={t('accountsSearch')}
          value={query} disabled={busy} onChange={(event) => { setQuery(event.target.value); setPage(0) }} /> : null}
        {showSelection ? <div className={styles['accountToolbar']}>
          <label className={styles['accountSelect']}>
            <input ref={pageSelection} type="checkbox" disabled={disabled || busy || pageAccounts.length === 0}
              checked={pageAccounts.length > 0 && selectedOnPage === pageAccounts.length}
              onChange={(event) => {
                const ids = pageAccounts.map(account => account.id)
                const checked = event.target.checked
                setSelected(current => checked ? [...new Set([...current, ...ids])] : current.filter(id => !ids.includes(id)))
              }} />
            {t('accountsSelectPage')}
          </label>
          {selected.length === 0 ? null : <>
            <Button size="sm" variant="outline" className={styles['deleteConfirm']} disabled={disabled || busy}
              onClick={() => { setRemoval((visibleAccounts ?? []).filter(account => selected.includes(account.id))) }}>
              {t('accountsRemoveSelected').replace('{count}', String(selected.length))}
            </Button>
            <Button size="sm" disabled={busy} onClick={() => { setSelected([]) }}>{t('accountsClearSelection')}</Button>
          </>}
        </div> : null}
        <ul className={styles['accountList']} aria-label={t('accounts')}>
          {pageAccounts.map((account) => {
            const accountUsage = usage[account.id]
            const open = account.id === visibleUsageId
            return (
              <li key={account.id} className={styles['accountRow']}>
                <div className={styles['accountHeader']}>
                  {showSelection ? <input type="checkbox"
                    aria-label={t('accountSelectLabel').replace('{account}', account.label)} disabled={disabled || busy}
                    checked={selected.includes(account.id)} onChange={(event) => {
                      const checked = event.target.checked
                      setSelected(current => checked ? [...current, account.id] : current.filter(id => id !== account.id))
                    }} /> : null}
                  <div className={styles['accountIdentity']}>
                    <span>{account.label}</span>
                    {accountUsage?.planType === undefined ? null
                      : <span className={styles['accountPlan']}>{accountUsage.planType}</span>}
                  </div>
                  <div className={styles['accountControls']}>
                    <Button size="sm" variant="outline" disabled={busy} aria-expanded={open}
                      aria-controls={`${usageId}-${encodeURIComponent(account.id)}`}
                      aria-label={t(open ? 'accountHideUsage' : 'accountShowUsage').replace('{account}', account.label)}
                      title={t('accountUsageTitle')}
                      onClick={() => { setExpanded(open ? null : account.id) }}>{t('accountUsageButton')}</Button>
                    {open ? <Button size="sm" variant="outline" disabled={disabled || busy || running}
                      aria-label={t('accountUsageRefresh').replace('{account}', account.label)}
                      onClick={() => { requestUsage(account.id) }}>↻</Button> : null}
                    <Button size="sm" variant="outline" className={styles['deleteConfirm']} disabled={disabled || busy || running}
                      aria-label={t(geminiWeb ? 'geminiWebRemoveLabel' : 'accountSignOutLabel').replace('{account}', account.label)}
                      onClick={() => { void removeAccounts([account]) }}>
                      {t(geminiWeb ? 'geminiWebRemove' : 'accountSignOut')}
                    </Button>
                  </div>
                </div>
                <div hidden={!open} id={`${usageId}-${encodeURIComponent(account.id)}`}>
                  {!open ? null : accountUsage === undefined
                    ? <small className={styles['usageStatus']}>{usageFailure[account.id] ? t('accountUsageUnavailable') : t('accountUsageLoading')}</small>
                    : <UsageReport value={accountUsage} provider={provider} t={t} />}
                </div>
              </li>
            )
          })}
        </ul>
        {filtered.length === 0 && (visibleAccounts?.length ?? 0) > 0 ? <p className={styles['advancedHint']}>{t('accountsNoMatches')}</p> : null}
        {filtered.length > 0 ? <div className={styles['accountToolbar']}>
          <span className={styles['usageStatus']} aria-live="polite">{t('accountsRange')
            .replace('{start}', String(currentPage * 10 + 1)).replace('{end}', String(Math.min((currentPage + 1) * 10, filtered.length)))
            .replace('{count}', String(filtered.length))}</span>
          {pageCount === 1 ? null : <div className={styles['accountControls']}>
            <Button size="sm" variant="outline" disabled={currentPage === 0 || busy} aria-label={t('accountsPrevious')}
              onClick={() => { setPage(currentPage - 1) }}>{t('accountsPreviousButton')}</Button>
            <span className={styles['usageStatus']}>{currentPage + 1} / {pageCount}</span>
            <Button size="sm" variant="outline" disabled={currentPage === pageCount - 1 || busy} aria-label={t('accountsNext')}
              onClick={() => { setPage(currentPage + 1) }}>{t('accountsNextButton')}</Button>
          </div>}
        </div> : null}
        {entry?.accounts.length === 0 ? <p className={styles['advancedHint']}>{t('accountsEmpty')}</p> : null}
      </> : null}
      <div role="status" aria-live="polite">
        {notice === undefined ? null : <p className={styles['authInstructions']}>{notice.message}</p>}
        {notice?.code === undefined ? null : <p><code>{notice.code}</code></p>}
        {attempt?.status === 'authorized' ? <p>{t('accountAdded')}</p> : null}
        {attempt?.status === 'cancelled' ? <p>{t('accountCancelled')}</p> : null}
      </div>
      {snippet === undefined ? null : <div className={styles['authSnippet']}>
        <Button size="sm" variant="outline" onClick={() => {
          const token = lifetime.current
          void Promise.resolve().then(() => navigator.clipboard.writeText(snippet)).then(() => {
            if (lifetime.current === token) setCopyStatus('copied')
          }, () => {
            if (lifetime.current === token) setCopyStatus('failed')
          })
        }}>{t('accountCopyConsole')}</Button>
        {copyStatus === undefined ? null : <p role="status">{t(copyStatus === 'copied' ? 'accountConsoleCopied' : 'accountConsoleCopyFailed')}</p>}
        <details><summary>{t('accountShowConsole')}</summary><pre><code>{snippet}</code></pre></details>
      </div>}
      {prompt === undefined || attempt === undefined ? null : <form key={prompt.id} className={styles['field']} onSubmit={(event) => {
        event.preventDefault()
        void act(async () => {
          const response = await api.answer({ attemptId: attempt.id, promptId: prompt.id, value: answer })
          if (!response.result.ok) throw new Error(response.result.error.message)
          setAnswer('')
        })
      }}>
        <label className={styles['fieldLabel']} htmlFor={`auth-${prompt.id}`}>{prompt.message}</label>
        {prompt.kind === 'select'
          ? <select data-hydra-control="field" id={`auth-${prompt.id}`} className={styles['input']} value={answer} disabled={busy}
            onChange={(event) => { setAnswer(event.target.value) }}>
            <option value="">{t('accountChoose')}</option>
            {prompt.options?.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select>
          : <input data-hydra-control="field" id={`auth-${prompt.id}`} className={styles['input']} type={prompt.kind === 'secret' ? 'password' : 'text'}
            autoComplete="off" value={answer} placeholder={prompt.placeholder} disabled={busy}
            onChange={(event) => { setAnswer(event.target.value) }} />}
        <button type="submit" className={styles['secondaryButton']} disabled={busy || answer.trim().length === 0}>{t('accountContinue')}</button>
      </form>}
      {failure === undefined && attempt?.error === undefined ? null
        : <p className={styles['error']} role="alert">{failure ?? attempt?.error}</p>}
      <Modal open={removal !== undefined} title={t('accountsRemoveTitle').replace('{count}', String(removal?.length ?? 0))}
        closeLabel={t('close')} className={styles['deleteDialog'] as string}
        onClose={() => { if (!busy) setRemoval(undefined) }} description={t('accountsRemoveDescription')}
        footer={removal === undefined ? undefined : <>
          <Button variant="outline" disabled={busy} onClick={() => { setRemoval(undefined) }}>{t('cancel')}</Button>
          <Button variant="outline" className={styles['deleteConfirm']} disabled={busy}
            onClick={() => { void removeAccounts(removal) }}>{t('accountsRemoveConfirm')}</Button>
        </>}>
        <p>{t('accountsRemoveSelected').replace('{count}', String(removal?.length ?? 0))}</p>
        <ul className={styles['accountRemovalList']}>{removal?.map(account => <li key={account.id}>{account.label}</li>)}</ul>
        {busy ? <p role="status">{t('accountsRemoving').replace('{done}', String(removalProgress)).replace('{count}', String(removal?.length ?? 0))}</p> : null}
      </Modal>
    </div>
  )
}

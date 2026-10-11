/** Plugins settings section: localized tabs around feature-owned pages. */

import { useEffect, useId, useRef, useState } from 'react'
import type {
  HostObservable, InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime,
} from '@hydraharness/harness-client-ui-slots'
import { Input } from '@hydraharness/harness-client-ui-primitives'
import type { PluginsSettingsLocaleKey } from './locales.ts'
import type { SettingsSelectionSnapshot } from '@hydraharness/harness-client-ui-settings/client'
import css from './PluginsSettingsSection.module.css'

/** One tab projected from a `settings.plugins.tab` contribution. */
export interface PluginsSettingsTabEntry {
  id: string
  order: number
  label: string
}

/** Registration-side business face for the section. */
export interface PluginsSettingsSectionInjected {
  hooks: {
    /** Ordered, locale-aware projection of the Plugins tab ledger. */
    tabs: HostObservable<readonly PluginsSettingsTabEntry[]>
    selection: HostObservable<SettingsSelectionSnapshot>
  }
}

/** Props the renderer binds for the section. */
export type PluginsSettingsSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.plugins'>
  & PropsRenderSlots<'settings.plugins.tab'>
  & InjectFace<PluginsSettingsSectionInjected>

/** Render one Plugins page whose contents arrive from feature-owned tabs. */
export function PluginsSettingsSection({ t, renderSlot, useTabs, useSelection }: PluginsSettingsSectionProps) {
  const tabsId = useId()
  const searchId = useId()
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])
  const allRows = useTabs(value => value)
  const workspace = useSelection(value => value.target.workspaceId !== undefined)
  const rows = workspace ? allRows.filter(row => row.id === 'all' || row.id === 'mcp' || row.id === 'hooks') : allRows
  const [activeId, setActiveId] = useState<string>()
  const [query, setQuery] = useState('')
  const [visitedIds, setVisitedIds] = useState<ReadonlySet<string>>(() => new Set())
  const active = rows.find(row => row.id === activeId)?.id ?? rows[0]?.id

  // A tab mounts only when first selected, then stays mounted while hidden so
  // local drafts and disclosure state survive switching between views.
  useEffect(() => {
    if (active === undefined) return
    setVisitedIds((previous) => {
      if (previous.has(active)) return previous
      return new Set([...previous, active])
    })
  }, [active])

  return (
    <div className={css.section}>
      <h2 className={css.heading}>{t('title')}</h2>
      <p className={css.intro}>{t('intro')}</p>
      {rows.length === 0 ? <p className={css.empty}>{t('empty')}</p> : (
        <>
          <label className={css.search} htmlFor={searchId}>
            <span className={css.visuallyHidden}>{t('search')}</span>
            <Input
              id={searchId}
              type="search"
              value={query}
              placeholder={t('search')}
              onChange={(event) => { setQuery(event.currentTarget.value) }}
            />
          </label>
          <div className={css.tabs} role="tablist" aria-label={t('tabs')}>
            {rows.map((row, index) => {
              const selected = row.id === active
              return (
                <button
                  key={row.id}
                  ref={(element) => { tabRefs.current[index] = element }}
                  id={`${tabsId}-tab-${row.id}`}
                  type="button"
                  role="tab"
                  className={css.tab}
                  aria-selected={selected}
                  aria-controls={`${tabsId}-panel-${row.id}`}
                  data-active={selected ? 'true' : undefined}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => { setActiveId(row.id) }}
                  onKeyDown={(event) => {
                    let nextIndex: number
                    switch (event.key) {
                      case 'ArrowRight': nextIndex = (index + 1) % rows.length; break
                      case 'ArrowLeft': nextIndex = (index - 1 + rows.length) % rows.length; break
                      case 'Home': nextIndex = 0; break
                      case 'End': nextIndex = rows.length - 1; break
                      default: return
                    }
                    event.preventDefault()
                    const nextRow = rows[nextIndex] as PluginsSettingsTabEntry
                    const nextTab = tabRefs.current[nextIndex] as HTMLButtonElement
                    setActiveId(nextRow.id)
                    nextTab.focus()
                  }}
                >
                  {row.label}
                </button>
              )
            })}
          </div>
          {rows
            .filter(row => row.id === active || visitedIds.has(row.id))
            .map((row) => {
              const selected = row.id === active
              return (
                <div
                  key={row.id}
                  id={`${tabsId}-panel-${row.id}`}
                  className={css.panel}
                  role="tabpanel"
                  aria-labelledby={`${tabsId}-tab-${row.id}`}
                  hidden={!selected}
                >
                  {renderSlot('settings.plugins.tab', { query, active: selected }, { only: row.id })}
                </div>
              )
            })}
        </>
      )}
    </div>
  )
}

declare module '@hydraharness/harness-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Plugins section, configurable-tab, and card copy. */
    'settings.plugins': PluginsSettingsLocaleKey
  }
}

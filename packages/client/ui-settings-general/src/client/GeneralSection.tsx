/** General settings groups contain only feature-owned preference rows. */
import type { HostObservable, InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime } from '@hydraharness/harness-client-ui-slots'
import type { SettingsKey } from './locales.ts'
import css from './GeneralSection.module.css'

/** Ordered groups declared by the General section. */
export const GENERAL_GROUPS = [
  { slot: 'settings.general.permissions.item', title: 'general.permissions' },
  { slot: 'settings.general.general.item', title: 'general.general' },
  { slot: 'settings.general.composer.item', title: 'general.composer' },
  { slot: 'settings.general.popout.item', title: 'general.popout' },
  { slot: 'settings.general.notifications.item', title: 'general.notifications' },
  { slot: 'settings.general.toys.item', title: 'general.toys' },
] as const satisfies readonly { slot: string; title: SettingsKey }[]

/** One registered preference's localized search label. */
export interface GeneralItem {
  slot: typeof GENERAL_GROUPS[number]['slot']
  id: string
  label: string
  order: number
}

/** General's registry projection, shared with the navigation search. */
export interface GeneralSectionInjected {
  hooks: { generalItems: HostObservable<readonly GeneralItem[]> }
}

/** Full component props including localized headings and registry rows. */
export type GeneralSectionComponentProps = PropsRuntime<'settings.section'>
  & PropsRenderSlots<typeof GENERAL_GROUPS[number]['slot']>
  & PropsLocale<'settings'> & InjectFace<GeneralSectionInjected>

/**
 * Render groups with matching contributions; empty groups occupy no space.
 * @param props - feature registry and section search.
 * @returns the General settings column.
 */
export function GeneralSection({ renderSlot, useGeneralItems, query = '', t }: GeneralSectionComponentProps) {
  const items = useGeneralItems(value => value)
  const needle = query.trim().toLocaleLowerCase()
  const wholePage = needle === '' || t('general.nav').toLocaleLowerCase().includes(needle)
  return <div className={css.section}>
    <h1 className={css.title}>{t('general.nav')}</h1>
    {GENERAL_GROUPS.map((group) => {
      const wholeGroup = wholePage || t(group.title).toLocaleLowerCase().includes(needle)
      const rows = items.filter(item => item.slot === group.slot
        && (wholeGroup || item.label.toLocaleLowerCase().includes(needle)))
      if (rows.length === 0) return null
      return <section className={css.group} key={group.slot} aria-label={t(group.title)}>
        <h2 className={css.heading}>{t(group.title)}</h2>
        <div className={css.card}>{rows.map(row =>
          <div className={css.item} key={row.id}>{renderSlot(group.slot, {}, { only: row.id })}</div>)}</div>
      </section>
    })}
  </div>
}

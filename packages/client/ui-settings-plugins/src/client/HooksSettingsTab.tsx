/**
 * The Plugins section's Hooks tab: the user's own hook records first, then
 * every imported bundle's hook catalog contributed through
 * `settings.plugins.hooks.item`.
 *
 * The tab stacks the two catalogs rather than shipping two tabs, so one page
 * answers both hook questions: what the user wrote (editable records stored in
 * the settings document) and what a plugin shipped (read-only rows with their
 * trust action). Either half can be absent — an uncomposed registry renders no
 * user catalog, and a deployment with no imported bundles contributes no items
 * — so each renders only what it owns.
 */

import type { InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime } from '@hydraharness/harness-client-ui-slots'
import { HookRecordCatalog, type UserHookControls } from './HookRecordCatalog.tsx'
import css from './PluginsSettingsSection.module.css'

/** Injected face of the Hooks tab. */
export interface HooksSettingsFace {
  /** The user's own hook records; available only on a loopback connection. */
  userHooks?: UserHookControls
  /** Imported bundle catalogs belong to global settings. */
  workspace?: boolean
}

/** Props the renderer binds for the hooks tab. */
export type HooksSettingsTabProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'settings.plugins'>
  & PropsRenderSlots<'settings.plugins.hooks.item'>
  & InjectFace<HooksSettingsFace>

/**
 * Render the user's hook records above the imported bundles' catalogs, or say
 * the surface is local-only when no record controls exist.
 * @param props - the slot-assembled runtime, locale, injected controls, and
 * the child catalog dispatch.
 * @returns the stacked catalogs, or the unavailable notice.
 */
export function HooksSettingsTab({ active, userHooks, renderSlot, query, t, workspace }: HooksSettingsTabProps) {
  return (
    <>
      {userHooks === undefined
        ? <p className={css.empty}>{t('userHooksUnavailable')}</p>
        : <HookRecordCatalog active={active} controls={userHooks} query={query} t={t} />}
      {!workspace && renderSlot('settings.plugins.hooks.item', { query, active })}
    </>
  )
}

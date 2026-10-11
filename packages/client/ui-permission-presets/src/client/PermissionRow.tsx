/**
 * Global permission default and per-session results applying it to open chats.
 */

import { useEffect, useState } from 'react'
import type { SnapshotStore } from '@hydraharness/harness-client-runtime/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@hydraharness/harness-client-ui-slots'
import {
  IconChevronDownOutline14, Menu, RiskConfirmation,
  Button, Switch,
} from '@hydraharness/harness-client-ui-primitives'
import type { PermissionSettingsState } from './settings-store.ts'
import type { PermissionSettingsKey } from './locales.ts'
import { displayPermissionPreset, FULL_ACCESS_PRESET } from './presentation.ts'
import css from './PermissionRow.module.css'

/** Registration-side business face for the host-backed preference. */
export interface PermissionRowInjected {
  /** Full access shares the same preset as the default permission selector. */
  fullAccess?: boolean
  hooks: {
    /** Permission settings snapshot bound by the renderer as usePermission. */
    permission: SnapshotStore<PermissionSettingsState>
  }
  /** Load the descriptor when the row first renders. */
  load: () => Promise<void>
  /** Persist one advertised preset. */
  select: (preset: string) => Promise<void>
  /** Clear the addressed default override. */
  reset?: () => Promise<void>
}

/** Full component props. */
export type PermissionRowProps =
  PropsRuntime<'settings.general.permissions.item'>
  & PropsLocale<'settings.permission'>
  & InjectFace<PermissionRowInjected>

/**
 * Render the permission selector and shared full-access toggle.
 * @param props - composed slot props.
 * @returns the row, or null when the host does not expose permission settings.
 */
export function PermissionRow({ load, select, reset, usePermission, fullAccess = false, t }: PermissionRowProps) {
  const state = usePermission(snapshot => snapshot)
  const [open, setOpen] = useState(false)
  const [confirmingFullAccess, setConfirmingFullAccess] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false)
  const [confirmingReset, setConfirmingReset] = useState(false)

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (state.writable && state.status !== 'unavailable') return
    setOpen(false)
    setAcknowledged(false)
    setConfirmingFullAccess(false)
    setConfirmingReset(false)
  }, [state.status, state.writable])

  if (state.status === 'unavailable') return null
  const selected = state.options.find(option => option.id === state.currentValue)
  const busy = state.status === 'loading' || state.status === 'saving' || confirmingFullAccess
  const optionLabel = (option: PermissionSettingsState['options'][number]): string =>
    displayPermissionPreset(option.id, option.label, t)
  const label = selected !== undefined ? optionLabel(selected) : (busy ? t('loading') : t('unavailable'))
  const description: string = state.error ?? t('description')

  return (
    <>
      <div className={css.row}>
        <div className={css.rowText}>
          <div className={css.title}>{t(fullAccess ? 'full.title' : 'title')}</div>
          <div className={css.desc} role={state.error === null ? undefined : 'alert'}>{fullAccess && state.error === null ? t('full.description') : description}</div>
          {state.status === 'saving' && <div role="status">{t('saving')}</div>}
        </div>
        {fullAccess ? <Switch checked={state.currentValue === FULL_ACCESS_PRESET}
          aria-label={t('full.title')} disabled={busy || !state.writable}
          onClick={() => {
            if (state.currentValue === FULL_ACCESS_PRESET) { void select('workspace-write'); return }
            setAcknowledged(false)
            setConfirmingFullAccess(true)
          }} /> : <Menu
          open={open}
          onClose={() => { setOpen(false) }}
          items={state.options.map(option => ({ id: option.id, label: optionLabel(option) }))}
          selectedId={state.currentValue}
          onSelect={(id) => {
            setOpen(false)
            if (id === state.currentValue) return
            if (id === FULL_ACCESS_PRESET) {
              setAcknowledged(false)
              setConfirmingFullAccess(true)
              return
            }
            void select(id)
          }}
          align="end"
          portal
          anchor={(
            <button data-hydra-control="field"
              type="button"
              className={css.selector}
              aria-haspopup="menu"
              aria-expanded={open}
              disabled={busy || !state.writable || state.options.length === 0}
              onClick={() => { setOpen(value => !value) }}
            >
              {label}
              <IconChevronDownOutline14 className={css.chevron} />
            </button>
          )}
        />}
        {!fullAccess && state.failedSessions !== undefined && state.failedSessions.length > 0 && <>
          <ul>{state.failedSessions.map(failed => <li key={failed.sessionId}>{failed.sessionId}: {failed.error}</li>)}</ul>
          <Button variant="outline" size="sm" disabled={busy || !state.writable}
            onClick={() => { void select(state.currentValue) }}>{t('retry')}</Button>
        </>}
        {!fullAccess && reset !== undefined && <Button variant="outline" size="sm" disabled={busy || !state.writable || !state.overridden}
          onClick={() => {
            if (state.inheritedValue === FULL_ACCESS_PRESET && state.currentValue !== FULL_ACCESS_PRESET) {
              setConfirmingReset(true); setAcknowledged(false); setConfirmingFullAccess(true)
            } else void reset()
          }}>{t('reset')}</Button>}
      </div>
      <RiskConfirmation
        open={confirmingFullAccess}
        title={t('confirm.title')}
        description={t('confirm.description')}
        acknowledgeLabel={t('confirm.acknowledge')}
        cancelLabel={t('confirm.cancel')}
        confirmLabel={t('confirm.enable')}
        acknowledged={acknowledged}
        disabled={!state.writable || state.status === 'saving'}
        onAcknowledgedChange={setAcknowledged}
        onCancel={() => {
          setConfirmingReset(false)
          setAcknowledged(false)
          setConfirmingFullAccess(false)
        }}
        onConfirm={() => {
          setAcknowledged(false)
          setConfirmingFullAccess(false)
          if (confirmingReset) { setConfirmingReset(false); void reset?.() }
          else void select(FULL_ACCESS_PRESET)
        }}
      />
    </>
  )
}

declare module '@hydraharness/harness-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Permission row copy. */
    'settings.permission': PermissionSettingsKey
  }
}

/**
 * Settings shell root: the sidebar-foot trigger row plus the centered modal
 * panel (figma 501:29947, 1080x700) with the section nav rail. The shell is
 * a pure composition face — every piece of text (trigger label, panel title,
 * close label, sections) arrives from registrants through slots; accessible
 * names resolve to that content (trigger: its own text; dialog:
 * aria-labelledby the title node; close: visually-hidden slot text). Modal
 * open state and the active section id are component-local viewing state;
 * the onboarding coordinator mounts exactly one ordered registrant while the
 * sessions-derived empty-Hero fact is active. Visible dialog chrome belongs
 * to the step, so a mounted-but-deciding step paints nothing here.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  IconAgentPresetOutline16, IconArchiveOutline20, IconBrowserOutline16, IconCloseOutline16,
  IconCordisPluginOutline14, IconDataOutline16, IconPersonalizationOutline16, IconSettingsOutline16, Modal,
  Button, IconUserOutline16,
} from '@hydraharness/harness-client-ui-primitives'
import type { SettingsRootComponentProps, SettingsSectionRow } from './shell-contract.ts'
import css from './SettingsRoot.module.css'
import type { GeneralItem } from './GeneralSection.tsx'

/** Nav glyph by section id; unknown ids fall back to the settings gear. */
function navIcon(id: string) {
  if (id === 'models') return <IconDataOutline16 className={css.navIcon} size={16} />
  if (id === 'accounts') return <IconUserOutline16 className={css.navIcon} size={16} />
  if (id === 'browser') return <IconBrowserOutline16 className={css.navIcon} size={16} />
  if (id === 'usage') {
    return (
      <svg className={css.navIcon} width={16} height={16} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden>
        <path
          d="M14 7.14614C13.5 7.00383 12.6851 6.99859 12 7.00383C11.7709 7.00558 11.9094 6.9944 11.6 7.00383C10.7926 7.03273 10.0016 7.41781 10 8.50882C9.99825 9.67108 11 10.015 12 10.015C13 10.015 14 10.2803 14 11.5211C14 12.4536 13.1925 12.8621 12.1861 12.9974C11.3861 12.9974 11 13.0272 10 12.8838M12 13V14M12 6V7M21 17V17.8C21 18.9201 21 19.4802 20.782 19.908C20.5903 20.2843 20.2843 20.5903 19.908 20.782C19.4802 21 18.9201 21 17.8 21H6.2C5.0799 21 4.51984 21 4.09202 20.782C3.71569 20.5903 3.40973 20.2843 3.21799 19.908C3 19.4802 3 18.9201 3 17.8V17M19 10C19 13.866 15.866 17 12 17C8.13401 17 5 13.866 5 10C5 6.13401 8.13401 3 12 3C15.866 3 19 6.13401 19 10Z"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    )
  }
  if (id === 'agent-presets') return <IconAgentPresetOutline16 className={css.navIcon} size={16} />
  if (id === 'personalization') return <IconPersonalizationOutline16 className={css.navIcon} size={16} />
  if (id === 'plugins') return <IconCordisPluginOutline14 className={css.navIcon} size={16} />
  if (id === 'archived-sessions') return <IconArchiveOutline20 className={css.navIcon} size={16} />
  return <IconSettingsOutline16 className={css.navIcon} size={16} />
}

type PanelProps = {
  generalItems: readonly GeneralItem[]
  searchCopy: SettingsRootComponentProps['searchCopy']
  rows: readonly SettingsSectionRow[]
  renderSlot: SettingsRootComponentProps['renderSlot']
  activeId: string | undefined
  onSelect: (id: string) => void
  onClose: () => void
}

/**
 * Settings navigation and content inside the shared modal's focus and dismissal lifecycle.
 */
function SettingsPanel({ rows, generalItems, searchCopy, renderSlot, activeId, onSelect, onClose }: PanelProps) {
  const [query, setQuery] = useState('')
  const needle = query.trim().toLocaleLowerCase()
  const visibleRows = rows.filter(row => row.label.toLocaleLowerCase().includes(needle)
    || (row.id === 'general' && generalItems.some(item => item.label.toLocaleLowerCase().includes(needle))))
  // Entries can unmount underneath the requested id, so the render-time
  // projection falls back to the first row when the id is gone.
  const active = visibleRows.find(r => r.id === activeId)?.id ?? visibleRows[0]?.id
  const titleId = useId()
  const content = useRef<HTMLDivElement>(null)
  const focusHeading = useRef(false)
  const openSection = (id: string): void => {
    if (!rows.some(row => row.id === id)) return
    focusHeading.current = true
    setQuery('')
    onSelect(id)
  }
  useEffect(() => {
    if (!focusHeading.current) return
    focusHeading.current = false
    const heading = content.current?.querySelector<HTMLElement>('h1, h2, h3')
    if (heading === undefined || heading === null) return
    heading.tabIndex = -1
    heading.focus()
  })

  // Baseline focus management: entering the dialog lands on the close button.
  const closeButton = useRef<HTMLButtonElement | null>(null)
  useEffect(() => { closeButton.current?.focus() }, [])

  return (
    <Modal open onClose={onClose} title="" labelledBy={titleId} headless className={css.panel as string}>
      <nav className={css.nav}>
        <div className={css.navTitle} id={titleId}>{renderSlot('settings.header', {})}</div>
        <input data-hydra-control="field" type="search" aria-label={searchCopy.label}
          placeholder={searchCopy.label} value={query} onChange={(event) => { setQuery(event.target.value) }} />
        <div className={css.navList}>
          {visibleRows.map(row => (
            <button
              key={row.id}
              type="button"
              className={clsx(css.navCell, row.id === active && css.active)}
              aria-current={row.id === active ? 'true' : undefined}
              onClick={() => { onSelect(row.id) }}
            >
              {navIcon(row.id)}
              <span className={css.navLabel}>{row.label}</span>
            </button>
          ))}
        </div>
      </nav>
      <div className={css.content}>
        <div className={css.header}>
          <div className={css.actions}>{renderSlot('settings.action', {})}</div>
          <button ref={closeButton} type="button" className={css.close} onClick={onClose}>
            <IconCloseOutline16 size={14} />
            <span className={css.hiddenLabel}>{renderSlot('settings.close', {})}</span>
          </button>
        </div>
        <div className={css.options} ref={content}>
          {active !== undefined ? renderSlot('settings.section', { close: onClose, openSection, query }, { only: active })
            : <p role="status">{searchCopy.empty}</p>}
        </div>
      </div>
    </Modal>
  )
}

/**
 * Render the settings trigger and panel.
 * @param props - composed slot props (contract/slots.ts).
 * @returns the settings shell element tree.
 */
export function SettingsRoot(props: SettingsRootComponentProps) {
  const { wide, useSections, useGeneralItems, useOnboardingSteps, useSessions, renderSlot } = props
  const generalItems = useGeneralItems(value => value)
  const currentSession = useSessions(value => value.current)
  const workspaces = props.useWorkspaces(value => value.items)
  const workspace = workspaces.find(row => currentSession !== undefined && row.sessionIds.includes(currentSession))
  const prompted = useRef(new Set<string>())
  const [trustPrompt, setTrustPrompt] = useState<typeof workspace>()
  const [trustError, setTrustError] = useState<string>()
  const [trustSaving, setTrustSaving] = useState(false)
  const [open, setOpen] = useState(false)
  const [activeId, setActiveId] = useState<string | undefined>(undefined)
  const [completedOnboarding, setCompletedOnboarding] = useState<ReadonlySet<string>>(() => new Set())
  useEffect(() => {
    if (workspace === undefined || prompted.current.has(workspace.path)) return undefined
    let active = true
    void props.workspaceStatus(workspace.workspaceId).then((status) => {
      if (!active) return
      prompted.current.add(workspace.path)
      if (!status.trusted && !status.trustDecided && status.hasProjectConfig) setTrustPrompt(workspace)
    }, () => { /* A failed status read leaves project execution disabled on the Host. */ })
    return () => { active = false }
  }, [workspace, props.workspaceStatus])
  const answerTrust = (trusted: boolean): void => {
    if (trustPrompt === undefined || trustSaving) return
    setTrustSaving(true)
    setTrustError(undefined)
    void props.trustWorkspace(trustPrompt.workspaceId, trusted).then(() => { setTrustPrompt(undefined) },
      (error: unknown) => { setTrustError(error instanceof Error ? error.message : String(error)) })
      .finally(() => { setTrustSaving(false) })
  }
  const close = useCallback(() => {
    setOpen(false)
    setActiveId(undefined)
  }, [])
  const openSection = useCallback((id: string) => {
    setActiveId(id)
    setOpen(true)
  }, [])

  // The ledger tick keeps the nav rows fresh: registrants re-register with
  // freshly localized text on locale change, and the trigger/header/close
  // seats re-render through their own outlets' subscriptions.
  const rows = useSections(s => s)
  const onboardingSteps = useOnboardingSteps(s => s)
  const onboardingActive = useSessions(state =>
    state.phase === 'ready'
    && (state.current === undefined || state.byId[state.current]?.blank === true))
  const onboardingStep = onboardingActive
    ? onboardingSteps.find(step => !completedOnboarding.has(step.id))
    : undefined

  useEffect(() => {
    if (onboardingActive) return
    setCompletedOnboarding(new Set())
  }, [onboardingActive])

  const completeOnboardingStep = useCallback((id: string) => {
    setCompletedOnboarding((previous) => {
      if (previous.has(id)) return previous
      return new Set([...previous, id])
    })
  }, [])

  return (
    <>
      <button
        type="button"
        className={clsx(css.trigger, !wide && css.rail)}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => { setOpen(true) }}
      >
        {renderSlot('settings.trigger', { wide })}
      </button>
      {open && (
        <SettingsPanel
          generalItems={generalItems}
          searchCopy={props.searchCopy}
          rows={rows}
          renderSlot={renderSlot}
          activeId={activeId}
          onSelect={setActiveId}
          onClose={close}
        />
      )}
      {/* Dialog chrome and `#root` inert ownership live inside each step's
          visible branch. A step still deciding (private facts loading)
          renders null, so nothing paints or blocks while it decides. */}
      {onboardingStep !== undefined && renderSlot('settings.onboarding', {
        stepId: onboardingStep.id,
        complete: () => { completeOnboardingStep(onboardingStep.id) },
        openSection,
      }, { only: onboardingStep.id })}
      <Modal open={trustPrompt !== undefined} onClose={() => { answerTrust(false) }} title={props.trustCopy.title}
        description={props.trustCopy.description} footer={<>
          <Button variant="outline" disabled={trustSaving} onClick={() => { answerTrust(false) }}>{props.trustCopy.cancel}</Button>
          <Button disabled={trustSaving} onClick={() => { answerTrust(true) }}>{props.trustCopy.allow}</Button>
        </>}>
        <p>{trustPrompt?.path}</p>
        {trustError !== undefined && <p role="alert">{trustError}</p>}
      </Modal>
    </>
  )
}

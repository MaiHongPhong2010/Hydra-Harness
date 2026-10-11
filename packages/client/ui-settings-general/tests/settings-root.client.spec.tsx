// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useEffect, useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { bindSnapshotSelector } from '@hydraharness/harness-client-test-runtime'
import { createSnapshotStore } from '@hydraharness/harness-client-runtime/client'
import type { SettingsRootComponentProps } from '../src/client/shell-contract.ts'
import { SettingsRoot } from '../src/client/SettingsRoot.tsx'
import type { SettingsSectionOwnerProps } from '@hydraharness/harness-client-ui-settings/client'

afterEach(cleanup)

type Row = { id: string; order: number; label: string }
type Step = { id: string; order: number }

/** Slot-content stand-ins: the shell renders whatever the seats contribute. */
const SEAT_CONTENT: Record<string, string> = {
  'settings.trigger': 'Settings',
  'settings.header': 'Settings Title',
  'settings.action': 'Open configuration file',
  'settings.close': 'Close',
}

function mount({
  wide = true,
  onboardingActive = true,
  rows = [
    { id: 'general', order: 0, label: 'General' },
    { id: 'models', order: 10, label: 'Models' },
    { id: 'agent-presets', order: 20, label: 'Agent presets' },
  ],
  steps = [
    { id: 'welcome', order: -100 },
    { id: 'credential', order: 0 },
  ],
}: { wide?: boolean; onboardingActive?: boolean; rows?: Row[]; steps?: Step[] } = {}) {
  // Mutable row source standing in for the bound useSections hook; bump()
  // plays a ledger change through the same observable contract.
  let current = rows
  const listeners = new Set<() => void>()
  const renderSlot = vi.fn(
    ((key: string, _owner: unknown, opts?: { only?: string }) => {
      if (key === 'settings.section') return <div data-testid={`section-${opts?.only ?? 'all'}`} />
      return SEAT_CONTENT[key]
    }) as SettingsRootComponentProps['renderSlot'],
  )
  const useSessions = ((select: (state: unknown) => unknown) => select(onboardingActive
    ? { phase: 'ready', current: undefined, byId: {} }
    : {
      phase: 'ready',
      current: 'active-session',
      byId: { 'active-session': { blank: false } },
    })) as never
  const props: SettingsRootComponentProps = {
    searchCopy: { label: 'Search settings', empty: 'No matching settings' },
    useGeneralItems: select => select([{ slot: 'settings.general.composer.item', id: 'shortcut', order: 0, label: 'Composer Send shortcut' }]),
    useSessions,
    useWorkspaces: select => select({ items: [] } as never),
    workspaceStatus: vi.fn(),
    trustWorkspace: vi.fn(),
    trustCopy: { title: 'Trust workspace?', description: 'Project commands run on your computer.', allow: 'Trust', cancel: 'Cancel' },
    wide,
    useOnboardingSteps: select => select(steps),
    useSections: (select) => {
      const [, force] = useState(0)
      useEffect(() => {
        const listener = () => { force(n => n + 1) }
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      }, [])
      return select(current)
    },
    renderSlot,
  }
  const view = render(<SettingsRoot {...props} />)
  const bump = (next: Row[]) => {
    act(() => {
      current = next
      for (const fn of [...listeners]) fn()
    })
  }
  return { view, renderSlot, bump, listeners }
}

function openPanel() {
  fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
}

describe('SettingsRoot trigger', () => {
  it('renders the trigger seat content as the accessible name (no aria-label of its own)', () => {
    const { renderSlot } = mount()
    const trigger = screen.getByRole('button', { name: 'Settings' })
    expect(trigger.hasAttribute('aria-label')).toBe(false)
    expect(renderSlot).toHaveBeenCalledWith('settings.trigger', { wide: true })
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(trigger)
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Settings', expanded: true })).toBeTruthy()
  })

  it('hands the rail state to the trigger seat', () => {
    const { renderSlot } = mount({ wide: false })
    expect(renderSlot).toHaveBeenCalledWith('settings.trigger', { wide: false })
  })
})

describe('SettingsPanel chrome seats', () => {
  it('names the dialog via aria-labelledby pointing at the header seat node', () => {
    mount()
    openPanel()
    const dialog = screen.getByRole('dialog')
    const titleId = dialog.getAttribute('aria-labelledby')!
    expect(titleId).toBeTruthy()
    const title = document.getElementById(titleId)!
    expect(title.textContent).toBe('Settings Title')
    expect(screen.getByRole('dialog', { name: 'Settings Title' })).toBeTruthy()
  })

  it('names the close button through the visually-hidden close seat text', () => {
    mount()
    openPanel()
    const close = screen.getByRole('button', { name: 'Close' })
    expect(close.hasAttribute('aria-label')).toBe(false)
    expect(close.textContent).toContain('Close')
  })

  it('renders header actions before the shell-owned close control', () => {
    const { renderSlot } = mount()
    openPanel()
    expect(screen.getByText('Open configuration file')).toBeTruthy()
    expect(renderSlot).toHaveBeenCalledWith('settings.action', {})
  })
})

describe('SettingsPanel close paths', () => {
  it('closes via the header button', () => {
    mount()
    openPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('closes via a mask click', () => {
    mount()
    openPanel()
    const dialog = screen.getByRole('dialog')
    fireEvent.click(dialog.parentElement!.firstElementChild!)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('closes via document-level Escape and unhooks the listener with the panel', () => {
    mount()
    openPanel()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    // Ignored while closed (listener removed with the panel) and non-Escape
    // keys are ignored while open.
    fireEvent.keyDown(document, { key: 'Escape' })
    openPanel()
    fireEvent.keyDown(document, { key: 'Enter' })
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('lands focus on the close button when the dialog opens', () => {
    mount()
    openPanel()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }))
  })
})

describe('SettingsPanel navigation', () => {
  it('lets a section clear sidebar search, open another page, and focus its heading', () => {
    const { renderSlot } = mount({ rows: [
      { id: 'models', order: 10, label: 'Models' }, { id: 'accounts', order: 11, label: 'Accounts' },
    ] })
    renderSlot.mockImplementation(((key: string, owner: SettingsSectionOwnerProps, options?: { only?: string }) => {
      if (key !== 'settings.section') return SEAT_CONTENT[key]
      return <div><h2>{options?.only}</h2>
        <button onClick={() => { owner.openSection(options?.only === 'models' ? 'accounts' : 'models') }}>Manage</button></div>
    }) as SettingsRootComponentProps['renderSlot'])
    openPanel()
    const search = screen.getByRole('searchbox')
    fireEvent.change(search, { target: { value: 'Models' } })
    expect(screen.queryByRole('button', { name: 'Accounts' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Manage' }))
    expect(search).toHaveProperty('value', '')
    expect(screen.getByRole('button', { name: 'Accounts' }).getAttribute('aria-current')).toBe('true')
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'accounts' }))
    fireEvent.change(search, { target: { value: 'Accounts' } })
    fireEvent.click(screen.getByRole('button', { name: 'Manage' }))
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'models' }))
  })
  it('finds General by preference labels, other sections by name, and shows no-match feedback', () => {
    mount()
    openPanel()
    const search = screen.getByRole('searchbox', { name: 'Search settings' })
    fireEvent.change(search, { target: { value: 'shortcut' } })
    expect(screen.getByTestId('section-general')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Models' })).toBeNull()
    fireEvent.change(search, { target: { value: 'models' } })
    expect(screen.getByTestId('section-models')).toBeTruthy()
    fireEvent.change(search, { target: { value: 'missing feature' } })
    expect(screen.getByRole('status').textContent).toBe('No matching settings')
  })
  it('retains global settings navigation and drafts when the current workspace changes', async () => {
    const sessions = createSnapshotStore({ phase: 'ready', current: 'session-a', byId: {} })
    function DraftSection() {
      const [draft, setDraft] = useState('')
      return <input aria-label="Model draft" value={draft} onChange={(event) => { setDraft(event.currentTarget.value) }} />
    }
    const props: SettingsRootComponentProps = {
      searchCopy: { label: 'Search settings', empty: 'No matching settings' },
      useGeneralItems: select => select([]),
      wide: true,
      useSessions: bindSnapshotSelector(sessions) as never,
      useWorkspaces: select => select({ items: ['a', 'b'].map(id => ({
        workspaceId: `workspace-${id}`, path: `/workspace-${id}`, sessionIds: [`session-${id}`],
      })) } as never),
      workspaceStatus: vi.fn<SettingsRootComponentProps['workspaceStatus']>(async workspaceId => ({
        workspaceId, trusted: false, trustDecided: true, hasProjectConfig: true,
      })),
      trustWorkspace: vi.fn(),
      trustCopy: { title: 'Trust workspace?', description: 'Project commands run on your computer.', allow: 'Trust', cancel: 'Cancel' },
      useSections: select => select([{ id: 'models', order: 0, label: 'Models' }, { id: 'usage', order: 1, label: 'Usage' }]),
      useOnboardingSteps: select => select([]),
      renderSlot: key => key === 'settings.section' ? <DraftSection /> : SEAT_CONTENT[key],
    }
    render(<SettingsRoot {...props} />)
    openPanel()
    fireEvent.change(screen.getByLabelText('Model draft'), { target: { value: 'Global draft' } })
    await act(async () => { sessions.update((draft) => { draft.current = 'session-b' }) })
    expect(screen.getByLabelText('Model draft')).toHaveProperty('value', 'Global draft')
    expect(screen.getByRole('button', { name: 'Usage' })).toBeTruthy()
  })

  it('projects rows, marks the first active, and renders only that section', () => {
    mount()
    openPanel()
    expect(screen.getByRole('button', { name: 'General' }).getAttribute('aria-current')).toBe('true')
    expect(screen.getByRole('button', { name: 'Models' }).getAttribute('aria-current')).toBeNull()
    expect(screen.getByTestId('section-general')).toBeTruthy()
  })

  it('gives every section a nav glyph, distinct for the ids the shell knows', () => {
    mount({
      rows: [
        { id: 'general', order: 0, label: 'General' },
        { id: 'browser', order: 5, label: 'Browser' },
        { id: 'models', order: 10, label: 'Models' },
        { id: 'usage', order: 12, label: 'Usage' },
        { id: 'agent-presets', order: 20, label: 'Agent presets' },
        { id: 'plugins', order: 30, label: 'Plugins' },
        { id: 'personalization', order: 31, label: 'Personalization' },
        { id: 'archived-sessions', order: 32, label: 'Archived sessions' },
        { id: 'contributed', order: 40, label: 'Contributed' },
      ],
    })
    openPanel()
    // Glyphs carry no id of their own, so the drawn paths are what tells them apart.
    const glyphs = ['General', 'Browser', 'Models', 'Usage', 'Agent presets', 'Plugins', 'Personalization', 'Archived sessions', 'Contributed']
      .map(name => screen.getByRole('button', { name }).querySelector('svg')?.innerHTML)

    expect(glyphs.every(glyph => glyph !== undefined && glyph !== '')).toBe(true)
    expect(new Set(glyphs.slice(0, 8)).size).toBe(8)
    expect(glyphs[8]).toBe(glyphs[0])
  })

  it('switches the rendered section on nav click', () => {
    mount()
    openPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Models' }))
    expect(screen.getByRole('button', { name: 'Models' }).getAttribute('aria-current')).toBe('true')
    expect(screen.getByTestId('section-models')).toBeTruthy()
    expect(screen.queryByTestId('section-general')).toBeNull()
  })

  it('mounts onboarding steps in order and transfers ownership only on completion', () => {
    const { renderSlot } = mount()
    const first = renderSlot.mock.calls.find(call => call[0] === 'settings.onboarding')
    expect(first?.[1]).toMatchObject({ stepId: 'welcome' })
    expect(first?.[2]).toEqual({ only: 'welcome' })
    act(() => {
      (first?.[1] as { complete: () => void }).complete()
      ;(first?.[1] as { complete: () => void }).complete()
    })
    const onboardingCalls = renderSlot.mock.calls.filter(call => call[0] === 'settings.onboarding')
    const second = onboardingCalls.at(-1)
    expect(second?.[1]).toMatchObject({ stepId: 'credential' })
    expect(second?.[2]).toEqual({ only: 'credential' })

    act(() => {
      (second?.[1] as { openSection: (id: string) => void }).openSection('models')
    })
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByTestId('section-models')).toBeTruthy()

    cleanup()
    const inactive = mount({ onboardingActive: false }).renderSlot.mock.calls
      .filter(call => call[0] === 'settings.onboarding')
    expect(inactive).toHaveLength(0)
  })

  it('paints no takeover chrome of its own around the mounted step', () => {
    // The chrome (mask, opaque stage, #root inert) belongs to the step via
    // the step-owned dialog surface — a mounted-but-deciding step that
    // renders null must show and block nothing (the reload white-flash fix;
    // onboarding-surface.spec.tsx pins the primitive's half).
    const appRoot = document.createElement('div')
    appRoot.id = 'root'
    document.body.append(appRoot)
    const { view } = mount()
    expect(view.container.querySelector('[class*="onboarding"]')).toBeNull()
    expect(document.body.querySelector('[class*="onboarding"]')).toBeNull()
    expect(appRoot.inert).not.toBe(true)
    view.unmount()
    appRoot.remove()
  })

  it('falls back to the first row when the active entry unregisters', () => {
    const { bump } = mount()
    openPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Models' }))
    bump([{ id: 'general', order: 0, label: 'General' }])
    expect(screen.queryByRole('button', { name: 'Models' })).toBeNull()
    expect(screen.getByTestId('section-general')).toBeTruthy()
  })

  it('renders an empty content column when the ledger is empty', () => {
    const { renderSlot } = mount({ rows: [] })
    openPanel()
    expect(screen.getByRole('dialog')).toBeTruthy()
    const sectionCalls = renderSlot.mock.calls.filter(c => c[0] === 'settings.section')
    expect(sectionCalls).toHaveLength(0)
  })

  it('drops the ledger subscription on unmount', () => {
    const { view, listeners } = mount()
    expect(listeners.size).toBe(1)
    view.unmount()
    expect(listeners.size).toBe(0)
  })
})

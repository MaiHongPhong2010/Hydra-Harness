// @vitest-environment jsdom
/**
 * What the section and its cards show: the empty line when no plugin
 * contributed one, a card that renders nothing while its namespace is
 * unavailable, and the save footer that decides when staged edits are written.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@hydraharness/harness-client-test-runtime'
import { createSnapshotStore } from '@hydraharness/harness-client-runtime/client'
import type { SettingsSelectionSnapshot } from '@hydraharness/harness-client-ui-settings/client'
import { AgentLoopCard } from '../src/client/AgentLoopCard.tsx'
import type { AgentLoopCardProps } from '../src/client/AgentLoopCard.tsx'
import { BashCard } from '../src/client/BashCard.tsx'
import type { BashCardProps } from '../src/client/BashCard.tsx'
import { PageMemoryCard } from '../src/client/PageMemoryCard.tsx'
import type { PageMemoryCardProps } from '../src/client/PageMemoryCard.tsx'
import { ConfigurablePluginsTab } from '../src/client/ConfigurablePluginsTab.tsx'
import type { ConfigurablePluginsTabProps } from '../src/client/ConfigurablePluginsTab.tsx'
import { PluginsSettingsSection } from '../src/client/PluginsSettingsSection.tsx'
import type { PluginsSettingsSectionProps, PluginsSettingsTabEntry } from '../src/client/PluginsSettingsSection.tsx'
import type { AgentLoopCardState } from '../src/client/agent-loop-card-controller.ts'
import type { BashCardState } from '../src/client/bash-card-controller.ts'
import type { PageMemoryCardState } from '../src/client/page-memory-card-controller.ts'
import type { CardFieldState, CardShell } from '../src/client/card-form.ts'
import type { ConfigurablePluginsTabState } from '../src/client/tab-store.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t = (key: keyof typeof en) => en[key]

/** A settled form: nothing staged, everything served. */
const settled: CardShell = {
  available: true,
  writable: true,
  dirty: false,
  invalid: false,
  saving: false,
  failed: false,
}

/** One control's state, defaulting to an inherited value. */
function field(text: string, rest: Partial<CardFieldState> = {}): CardFieldState {
  return { text, overridden: false, invalid: false, ...rest }
}

function cardActions() {
  return { edit: vi.fn(), resetField: vi.fn(), save: vi.fn(), discard: vi.fn() }
}

function renderSection(rows: readonly PluginsSettingsTabEntry[]) {
  const selection = createSnapshotStore<SettingsSelectionSnapshot>({ target: {}, loading: false, error: null })
  const props = {
    t,
    useTabs: (selector: (value: readonly PluginsSettingsTabEntry[]) => unknown) => selector(rows),
    useSelection: bindSnapshotSelector(selection),
    renderSlot: (_name: string, _owner: unknown, options: { only?: string }) => (
      <span>{options.only}</span>
    ),
  } as unknown as PluginsSettingsSectionProps
  render(<PluginsSettingsSection {...props} />)
}

/**
 * Render the tab over the namespaces it was told to dispatch, with `cards`
 * standing in for the slot ledger: a key it names renders that text, and one
 * it does not renders nothing, exactly as an unclaimed key does.
 */
function renderConfigurable(namespaces: string[], cards: Record<string, string> = {}, loaded = true, query = '') {
  const store = createSnapshotStore<ConfigurablePluginsTabState>({ loaded, namespaces })
  const props = {
    t,
    query,
    useConfigurablePlugins: bindSnapshotSelector(store),
    renderSlot: (_name: string, _owner: object, opts?: { entryKey?: string }) => {
      const card = opts?.entryKey === undefined ? undefined : cards[opts.entryKey]
      return card === undefined ? null : (
        <div data-slot="settings.plugin.item">
          <div role="listitem">{card}</div>
        </div>
      )
    },
  } as unknown as ConfigurablePluginsTabProps
  render(<ConfigurablePluginsTab {...props} />)
}

function renderBash(state: Partial<BashCardState> = {}) {
  const store = createSnapshotStore<BashCardState>({
    ...settled,
    timeoutMs: field('60000'),
    maxOutputBytes: field('64000'),
    ...state,
  })
  const actions = cardActions()
  const props = { ...actions, t, useBashCard: bindSnapshotSelector(store) } as unknown as BashCardProps
  render(<BashCard {...props} />)
  return actions
}

function renderPageMemory(state: Partial<PageMemoryCardState> = {}) {
  const store = createSnapshotStore<PageMemoryCardState>({
    ...settled,
    role: field('operator'), locale: field('en-US'), storageDir: field(''),
    maxRecordBytes: field('32768'), maxWorkflows: field('12'), maxPages: field('500'),
    maxContextBytes: field('8192'), maxObservations: field('32'), maxHistory: field('256'),
    verificationTimeoutMs: field('5000'),
    ...state,
  })
  const actions = cardActions()
  const props = { ...actions, t, usePageMemoryCard: bindSnapshotSelector(store) } as unknown as PageMemoryCardProps
  render(<PageMemoryCard {...props} />)
  return actions
}

describe('PluginsSettingsSection', () => {
  it('says so when no plugin contributed a tab', () => {
    renderSection([])

    expect(screen.getByText(en.empty)).toBeTruthy()
    expect(screen.queryByRole('tab')).toBeNull()
  })

  it('defaults to the first ordered tab and mounts another only after selection', () => {
    renderSection([
      { id: 'configurable', order: 0, label: en.configurableTab },
      { id: 'all', order: 10, label: 'Plugin list' },
    ])

    const configurable = screen.getByRole('tab', { name: en.configurableTab })
    const all = screen.getByRole('tab', { name: 'Plugin list' })
    expect(configurable.getAttribute('aria-selected')).toBe('true')
    expect(screen.getByText('configurable')).toBeTruthy()
    expect(screen.queryByText('all')).toBeNull()

    fireEvent.click(all)
    expect(all.getAttribute('aria-selected')).toBe('true')
    expect(screen.getByText('all')).toBeTruthy()
    expect(screen.getByText('configurable').closest('[role="tabpanel"]')).toHaveProperty('hidden', true)

    fireEvent.click(configurable)
    expect(configurable.getAttribute('aria-selected')).toBe('true')
    expect(screen.getByText('all').closest('[role="tabpanel"]')).toHaveProperty('hidden', true)
  })

  it('leads with its own heading and intro', () => {
    renderSection([{ id: 'configurable', order: 0, label: en.configurableTab }])

    expect(screen.getByRole('heading', { name: en.title })).toBeTruthy()
    expect(screen.getByText(en.intro)).toBeTruthy()
  })

  it('passes its one shared search query to every rendered tab', () => {
    const rows: readonly PluginsSettingsTabEntry[] = [{ id: 'all', order: 10, label: 'Plugin list' }]
    const seen: string[] = []
    const selection = createSnapshotStore<SettingsSelectionSnapshot>({ target: {}, loading: false, error: null })
    const props = {
      t,
      useTabs: (selector: (value: readonly PluginsSettingsTabEntry[]) => unknown) => selector(rows),
      useSelection: bindSnapshotSelector(selection),
      renderSlot: (_name: string, owner: { query: string }, options: { only?: string }) => {
        seen.push(owner.query)
        return <span>{options.only}</span>
      },
    } as unknown as PluginsSettingsSectionProps
    render(<PluginsSettingsSection {...props} />)

    fireEvent.change(screen.getByRole('searchbox', { name: en.search }), { target: { value: 'toolkit' } })

    expect(seen.at(-1)).toBe('toolkit')
  })

  it('moves focus and selection with standard horizontal tab keys', () => {
    renderSection([
      { id: 'configurable', order: 0, label: en.configurableTab },
      { id: 'all', order: 10, label: 'Plugin list' },
      { id: 'diagnostics', order: 20, label: 'Diagnostics' },
    ])

    const configurable = screen.getByRole('tab', { name: en.configurableTab })
    const all = screen.getByRole('tab', { name: 'Plugin list' })
    const diagnostics = screen.getByRole('tab', { name: 'Diagnostics' })
    expect(configurable.getAttribute('tabindex')).toBe('0')
    expect(all.getAttribute('tabindex')).toBe('-1')

    configurable.focus()
    fireEvent.keyDown(configurable, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(all)
    expect(all.getAttribute('aria-selected')).toBe('true')

    fireEvent.keyDown(all, { key: 'End' })
    expect(document.activeElement).toBe(diagnostics)
    fireEvent.keyDown(diagnostics, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(configurable)
    fireEvent.keyDown(configurable, { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(diagnostics)
    fireEvent.keyDown(diagnostics, { key: 'Home' })
    expect(document.activeElement).toBe(configurable)

    fireEvent.keyDown(configurable, { key: 'Escape' })
    expect(document.activeElement).toBe(configurable)
    expect(configurable.getAttribute('aria-selected')).toBe('true')
  })
})

describe('ConfigurablePluginsTab', () => {
  it('says so when no plugin contributed a card', () => {
    renderConfigurable([], { bash: 'shell' })

    expect(screen.getByText(en.empty)).toBeTruthy()
    expect(screen.queryByText('shell')).toBeNull()
  })

  it('withholds the empty line until the Host has answered once', () => {
    // An unanswered read is not the statement that this deployment configures
    // no plugin; saying it anyway would flash a wrong answer on every open.
    renderConfigurable([], { bash: 'shell' }, false)

    expect(screen.queryByText(en.empty)).toBeNull()
  })

  it('dispatches one card per namespace, keyed by it', () => {
    renderConfigurable(['bash', 'agent-loop'], { bash: 'shell', 'agent-loop': 'loop' })

    expect(screen.getAllByRole('listitem').map(item => item.textContent)).toEqual(['shell', 'loop'])
    expect(screen.queryByText(en.empty)).toBeNull()
  })

  it('filters namespaces by the shared search and distinguishes no matches from no settings', () => {
    renderConfigurable(['bash', 'agent-loop'], { bash: 'shell', 'agent-loop': 'loop' }, true, 'loop')

    expect(screen.getByRole('listitem').textContent).toBe('loop')
    expect(screen.queryByText('shell')).toBeNull()

    cleanup()
    renderConfigurable(['bash'], { bash: 'shell' }, true, 'missing')
    expect(screen.getByText(en.emptySearch)).toBeTruthy()
    expect(screen.queryByText(en.empty)).toBeNull()
  })
})

describe('BashCard', () => {
  it('renders nothing while its namespace is unavailable', () => {
    const { container } = render(<div />)
    renderBash({ available: false })

    expect(container.textContent).toBe('')
    expect(screen.queryByText(en.bashTitle)).toBeNull()
  })

  it('shows the plugin and reveals its fields only once expanded', () => {
    renderBash()
    expect(screen.getByText(en.bashTitle)).toBeTruthy()
    expect(screen.queryByLabelText(en.bashTimeoutMs)).toBeNull()

    fireEvent.click(screen.getByText(en.bashTitle))

    expect(screen.getByLabelText(en.bashTimeoutMs)).toBeTruthy()
    expect(screen.getByLabelText(en.bashMaxOutputBytes)).toBeTruthy()
  })

  it('stages an edit instead of writing it', () => {
    const actions = renderBash()
    fireEvent.click(screen.getByText(en.bashTitle))

    fireEvent.change(screen.getByLabelText(en.bashTimeoutMs), { target: { value: '9000' } })

    expect(actions.edit).toHaveBeenCalledWith('timeoutMs', '9000')
    expect(actions.save).not.toHaveBeenCalled()
  })

  it('offers the reset for an overridden field only', () => {
    const actions = renderBash({ timeoutMs: field('9000', { overridden: true }) })
    fireEvent.click(screen.getByText(en.bashTitle))

    // One badge and one reset: the output cap is still inherited.
    expect(screen.getAllByText(en.overridden)).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: en.reset }))

    expect(actions.resetField).toHaveBeenCalledWith('timeoutMs')
  })

  it('addresses each of its two fields separately', () => {
    const actions = renderBash({ maxOutputBytes: field('64000', { overridden: true }) })
    fireEvent.click(screen.getByText(en.bashTitle))

    fireEvent.change(screen.getByLabelText(en.bashMaxOutputBytes), { target: { value: '1024' } })
    fireEvent.click(screen.getByRole('button', { name: en.reset }))

    expect(actions.edit).toHaveBeenCalledWith('maxOutputBytes', '1024')
    expect(actions.resetField).toHaveBeenCalledWith('maxOutputBytes')
  })

  it('keeps save and discard inert until something is staged', () => {
    renderBash()
    fireEvent.click(screen.getByText(en.bashTitle))

    expect(screen.getByRole('button', { name: en.save })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: en.discard })).toHaveProperty('disabled', true)
    expect(screen.queryByText(en.unsaved)).toBeNull()
  })

  it('writes the staged edits when saved, and drops them when discarded', () => {
    const actions = renderBash({ dirty: true, timeoutMs: field('9000', { overridden: true }) })
    fireEvent.click(screen.getByText(en.bashTitle))

    fireEvent.click(screen.getByRole('button', { name: en.save }))
    fireEvent.click(screen.getByRole('button', { name: en.discard }))

    expect(actions.save).toHaveBeenCalledOnce()
    expect(actions.discard).toHaveBeenCalledOnce()
  })

  it('marks a card holding unsaved edits, collapsed or not', () => {
    renderBash({ dirty: true })

    expect(screen.getByText(en.unsaved)).toBeTruthy()
  })

  it('blocks the save while a draft is invalid, and says why', () => {
    renderBash({ dirty: true, invalid: true, timeoutMs: field('soon', { invalid: true }) })
    fireEvent.click(screen.getByText(en.bashTitle))

    expect(screen.getByRole('button', { name: en.save })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: en.discard })).toHaveProperty('disabled', false)
    expect(screen.getByText(en.invalidNumber)).toBeTruthy()
  })

  it('reports a save in flight and refuses another', () => {
    renderBash({ dirty: true, saving: true })
    fireEvent.click(screen.getByText(en.bashTitle))

    expect(screen.getByRole('button', { name: en.saving })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: en.discard })).toHaveProperty('disabled', true)
  })

  it('reports a save the deployment did not accept', () => {
    renderBash({ dirty: true, failed: true })
    fireEvent.click(screen.getByText(en.bashTitle))

    expect(screen.getByText(en.saveFailed)).toBeTruthy()
  })

  it('says the document is read-only and disables its controls', () => {
    renderBash({ writable: false })
    fireEvent.click(screen.getByText(en.bashTitle))

    expect(screen.getByRole('status')).toHaveProperty('textContent', en.readOnly)
    expect(screen.getByLabelText(en.bashTimeoutMs)).toHaveProperty('disabled', true)
  })

  it('collapses again on a second click', () => {
    renderBash()
    fireEvent.click(screen.getByText(en.bashTitle))
    expect(screen.getByLabelText(en.bashTimeoutMs)).toBeTruthy()

    fireEvent.click(screen.getByText(en.bashTitle))

    expect(screen.queryByLabelText(en.bashTimeoutMs)).toBeNull()
  })
})

describe('PageMemoryCard', () => {
  it('shows the page-memory settings and stages edits', () => {
    const actions = renderPageMemory({ maxWorkflows: field('12', { overridden: true }) })
    expect(screen.getByText(en.pageMemoryTitle)).toBeTruthy()
    fireEvent.click(screen.getByText(en.pageMemoryTitle))
    expect(screen.getByLabelText(en.pageMemoryRole)).toBeTruthy()
    expect(screen.getByLabelText(en.pageMemoryMaxHistory)).toBeTruthy()
    fireEvent.change(screen.getByLabelText(en.pageMemoryMaxHistory), { target: { value: '64' } })
    expect(actions.edit).toHaveBeenCalledWith('maxHistory', '64')
    fireEvent.change(screen.getByLabelText(en.pageMemoryMaxWorkflows), { target: { value: '20' } })
    expect(actions.edit).toHaveBeenCalledWith('maxWorkflows', '20')
    fireEvent.click(screen.getByRole('button', { name: en.reset }))
    expect(actions.resetField).toHaveBeenCalledWith('maxWorkflows')
    expect(actions.save).not.toHaveBeenCalled()
  })
})

describe('AgentLoopCard', () => {
  it('stages and saves the only field it owns', () => {
    const store = createSnapshotStore<AgentLoopCardState>({
      ...settled,
      dirty: true,
      maxParallelToolCalls: field('10'),
    })
    const actions = cardActions()
    const props = {
      ...actions,
      t,
      useAgentLoopCard: bindSnapshotSelector(store),
    } as unknown as AgentLoopCardProps
    render(<AgentLoopCard {...props} />)

    fireEvent.click(screen.getByText(en.agentLoopTitle))
    fireEvent.change(screen.getByLabelText(en.agentLoopMaxParallel), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: en.save }))

    expect(actions.edit).toHaveBeenCalledWith('maxParallelToolCalls', '2')
    expect(actions.save).toHaveBeenCalledOnce()
  })

  it('stages a reset for the field it owns', () => {
    const store = createSnapshotStore<AgentLoopCardState>({
      ...settled,
      maxParallelToolCalls: field('2', { overridden: true }),
    })
    const actions = cardActions()
    const props = {
      ...actions,
      t,
      useAgentLoopCard: bindSnapshotSelector(store),
    } as unknown as AgentLoopCardProps
    render(<AgentLoopCard {...props} />)

    fireEvent.click(screen.getByText(en.agentLoopTitle))
    fireEvent.click(screen.getByRole('button', { name: en.reset }))

    expect(actions.resetField).toHaveBeenCalledWith('maxParallelToolCalls')
  })
})

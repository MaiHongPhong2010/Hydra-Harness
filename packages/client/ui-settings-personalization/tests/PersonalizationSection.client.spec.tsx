// @vitest-environment jsdom
/**
 * The Personalization section: custom instructions (editor, save gating,
 * conflict affordance), local-memory controls, and the personality selector.
 */

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@hydraharness/harness-client-test-runtime'
import { createSnapshotStore } from '@hydraharness/harness-client-runtime/client'
import type { SettingsScopeSnapshot } from '@hydraharness/harness-client-runtime/client'
import type { SettingsSelectionSnapshot } from '@hydraharness/harness-client-ui-settings/client'
import { PersonalizationSection } from '../src/client/PersonalizationSection.tsx'
import type { MemorySettings, PersonalityDraft, PersonalitySettings, PersonalizationSectionInjected, PersonalizationSectionProps } from '../src/client/PersonalizationSection.tsx'
import type { InstructionsState } from '../src/client/instructions-store.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const INSTRUCTIONS_READY: InstructionsState = {
  status: 'ready', draft: 'be nice', savedContent: 'be nice', revision: 'a'.repeat(64), error: null,
}

const PERSONALITY_READY: SettingsScopeSnapshot<PersonalitySettings> = {
  status: 'ready', value: { personality: 'pragmatic' }, base: undefined, user: undefined, revision: 0, writable: true, mode: 'host',
}

const MEMORY_READY: SettingsScopeSnapshot<MemorySettings> = {
  status: 'ready', value: { enabled: true, useMemories: true, generateMemories: true }, base: undefined, user: undefined, revision: 0, writable: true, mode: 'host',
}

function renderSection(
  instructions: Partial<InstructionsState> = {},
  personality: Partial<SettingsScopeSnapshot<PersonalitySettings>> = {},
  memory: Partial<SettingsScopeSnapshot<MemorySettings>> = {},
  expand = true,
  overrides: Partial<PersonalizationSectionInjected> = {},
) {
  const instructionsStore = createSnapshotStore<InstructionsState>({ ...INSTRUCTIONS_READY, ...instructions })
  const personalityStore = createSnapshotStore<SettingsScopeSnapshot<PersonalitySettings>>({ ...PERSONALITY_READY, ...personality })
  const memoryStore = createSnapshotStore<SettingsScopeSnapshot<MemorySettings>>({ ...MEMORY_READY, ...memory })
  const personalityDraft = createSnapshotStore<PersonalityDraft>({ value: undefined, saving: false, failed: false })
  const selection = createSnapshotStore<SettingsSelectionSnapshot>({ target: {}, loading: false, error: null })
  const actions = {
    load: vi.fn(() => Promise.resolve()),
    setDraft: vi.fn(),
    save: vi.fn(() => Promise.resolve()),
    reload: vi.fn(() => Promise.resolve()),
    setPersonality: vi.fn((value: PersonalitySettings['personality']) => { personalityDraft.update((draft) => { draft.value = value }) }),
    savePersonality: vi.fn(() => Promise.resolve()),
    loadMemories: vi.fn(() => Promise.resolve([])),
    removeMemory: vi.fn(() => Promise.resolve(true)),
    setMemory: vi.fn(() => Promise.resolve()),
    ...overrides,
  }
  const view = render(<PersonalizationSection {...({
    ...actions,
    close: () => {},
    useInstructions: bindSnapshotSelector(instructionsStore),
    useMemory: bindSnapshotSelector(memoryStore),
    usePersonality: bindSnapshotSelector(personalityStore),
    usePersonalityDraft: bindSnapshotSelector(personalityDraft),
    useSelection: bindSnapshotSelector(selection),
    t: (key: keyof typeof en) => en[key],
  } as unknown as PersonalizationSectionProps)} />)
  if (expand) fireEvent.click(screen.getByText('Custom instructions', { selector: 'summary' }))
  return { actions, instructionsStore, personalityStore, memoryStore, personalityDraft, view }
}

describe('PersonalizationSection', () => {
  it('deletes only memories confirmed removed and reports deletion errors', async () => {
    const removeMemory = vi.fn<PersonalizationSectionInjected['removeMemory']>()
      .mockResolvedValueOnce(false).mockRejectedValueOnce(new Error('locked')).mockRejectedValueOnce('offline').mockResolvedValueOnce(true)
    renderSection({}, {}, {}, true, {
      loadMemories: async () => [
        { id: 'a', text: 'First memory', createdAt: 1, updatedAt: 1 },
        { id: 'b', text: 'Second memory', createdAt: 1, updatedAt: 1 },
      ], removeMemory,
    })
    await screen.findByText('First memory')
    const remove = () => fireEvent.click(within(screen.getByText('First memory').closest('li')!).getByRole('button'))
    await act(async () => { remove() })
    expect(screen.getByText('First memory')).not.toBeNull()
    await act(async () => { remove() })
    expect(screen.getByRole('alert').textContent).toBe('locked')
    await act(async () => { remove() })
    expect(screen.getByRole('alert').textContent).toBe('offline')
    await act(async () => { remove() })
    expect(screen.queryByText('First memory')).toBeNull()
    expect(screen.getByText('Second memory')).not.toBeNull()
  })

  it.each([new Error('read failed'), 'read failed'])('shows memory-load failures: %s', async (error) => {
    renderSection({}, {}, {}, true, { loadMemories: async () => { throw error } })
    expect((await screen.findByRole('alert')).textContent).toBe('read failed')
  })

  it.each([false, true])('ignores a memory response after unmount (rejected: %s)', async (reject) => {
    const pending = Promise.withResolvers<Awaited<ReturnType<PersonalizationSectionInjected['loadMemories']>>>()
    const { view } = renderSection({}, {}, {}, true, { loadMemories: () => pending.promise })
    view.unmount()
    await act(async () => {
      if (reject) pending.reject(new Error('disconnected'))
      else pending.resolve([])
    })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows memory defaults while unavailable and tone save status', async () => {
    const { memoryStore, personalityDraft } = renderSection({}, { value: undefined }, { status: 'unavailable' })
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: 'Enable memories' }).disabled).toBe(true)
    await act(async () => { memoryStore.update((state) => { state.status = 'ready'; state.value = undefined }) })
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: 'Enable memories' }).checked).toBe(false)
    fireEvent.click(screen.getByText('Personality', { selector: 'summary' }))
    await act(async () => { personalityDraft.update((state) => { state.value = 'friendly'; state.saving = true; state.failed = true }) })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Saving…' }).disabled).toBe(true)
    expect(screen.getByRole('alert').textContent).toBe(en.saveFailed)
  })

  it('starts prompt editors collapsed and keeps typing separate from Save', () => {
    const { actions } = renderSection({}, {}, {}, false)
    expect(screen.getByText('Custom instructions', { selector: 'summary' }).closest('details')?.open).toBe(false)
    expect(screen.getByText('Personality', { selector: 'summary' }).closest('details')?.open).toBe(false)
    fireEvent.click(screen.getByText('Custom instructions', { selector: 'summary' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Custom instructions' }), { target: { value: 'draft' } })
    fireEvent.click(screen.getByText('Custom instructions', { selector: 'summary' }))
    expect(actions.setDraft).toHaveBeenCalledWith('draft')
    expect(actions.save).not.toHaveBeenCalled()
  })
  it('loads once on mount', () => {
    const { actions } = renderSection()
    expect(actions.load).toHaveBeenCalledTimes(1)
  })

  it('shows the loaded draft and disables Save until the draft changes', () => {
    renderSection()

    const textbox = screen.getByRole('textbox')
    expect(textbox instanceof HTMLTextAreaElement && textbox.value).toBe('be nice')
    const save = within(screen.getByText('Custom instructions', { selector: 'summary' }).closest('details')!).getByRole('button', { name: 'Save' })
    expect(save instanceof HTMLButtonElement && save.disabled).toBe(true)
  })

  it('enables Save once the draft diverges and calls save on click', () => {
    const { actions } = renderSection({ draft: 'be nicer' })

    const button = within(screen.getByText('Custom instructions', { selector: 'summary' }).closest('details')!).getByRole('button', { name: 'Save' })
    expect(button instanceof HTMLButtonElement && button.disabled).toBe(false)
    fireEvent.click(button)

    expect(actions.save).toHaveBeenCalledTimes(1)
  })

  it('routes typing to setDraft', () => {
    const { actions } = renderSection()

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'new text' } })

    expect(actions.setDraft).toHaveBeenCalledWith('new text')
  })

  it('shows a busy label and disables Save while saving', () => {
    renderSection({ status: 'saving', draft: 'be nicer' })

    const button = screen.getByRole('button', { name: 'Saving…' })
    expect(button instanceof HTMLButtonElement && button.disabled).toBe(true)
  })

  it('shows the conflict affordance and reloads on click, instead of a plain retry', () => {
    const { actions } = renderSection({ status: 'conflict', draft: 'my edit', error: 'stale' })

    expect(screen.getByRole('alert').textContent).toContain('These instructions changed elsewhere since you loaded them.')
    // Saving stays blocked until the user resolves the conflict.
    const save = within(screen.getByText('Custom instructions', { selector: 'summary' }).closest('details')!).getByRole('button', { name: 'Save' })
    expect(save instanceof HTMLButtonElement && save.disabled).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))

    expect(actions.reload).toHaveBeenCalledTimes(1)
  })

  it('shows a generic error message outside of a conflict', () => {
    renderSection({ status: 'error', error: 'socket closed' })

    expect(screen.getByRole('alert').textContent).toContain('socket closed')
  })

  it('shows local-memory controls and routes a global change', () => {
    const { actions } = renderSection()

    const enabled = screen.getByRole('checkbox', { name: 'Enable memories' }) as HTMLInputElement
    expect(enabled.checked).toBe(true)
    const checkboxes = screen.getAllByRole('checkbox')
    fireEvent.click(checkboxes[1]!)
    fireEvent.click(checkboxes[2]!)
    expect(actions.setMemory).toHaveBeenCalledWith('useMemories', false)
    expect(actions.setMemory).toHaveBeenCalledWith('generateMemories', false)
    fireEvent.click(enabled)
    expect(actions.setMemory).toHaveBeenCalledWith('enabled', false)
    expect(screen.getByText('No saved local memories.')).not.toBeNull()
  })

  it('shows the current personality and routes a change to setPersonality', () => {
    const { actions } = renderSection({}, { value: { personality: 'friendly' } }, {}, false)
    fireEvent.click(screen.getByText('Personality', { selector: 'summary' }))

    const select = screen.getByRole('combobox') as HTMLSelectElement
    expect(select.value).toBe('friendly')

    fireEvent.change(select, { target: { value: 'none' } })

    expect(actions.setPersonality).toHaveBeenCalledWith('none')
    expect(actions.savePersonality).not.toHaveBeenCalled()
    fireEvent.click(within(screen.getByText('Personality', { selector: 'summary' }).closest('details')!).getByRole('button', { name: 'Save' }))
    expect(actions.savePersonality).toHaveBeenCalledOnce()
  })

  it('disables the personality selector while unavailable or read-only', () => {
    renderSection({}, { status: 'unavailable', writable: false })
    fireEvent.click(screen.getByText('Personality', { selector: 'summary' }))

    const select = screen.getByRole('combobox')
    expect(select instanceof HTMLSelectElement && select.disabled).toBe(true)
  })
})

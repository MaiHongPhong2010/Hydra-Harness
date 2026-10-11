// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@hydraharness/harness-client-test-runtime'
import { createSnapshotStore } from '@hydraharness/harness-client-runtime/client'
import { ComposerPreferenceRow } from '../src/client/settings/ComposerPreferenceRow.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

it('keeps the accepted switch value while saving and exposes a failed save', async () => {
  const pending = Promise.withResolvers<undefined>()
  const save = vi.fn(() => pending.promise)
  render(<ComposerPreferenceRow field="plainText" title="settings.plain.title" description="settings.plain.description"
    useSessions={(() => {}) as never} useWorkspaces={(() => {}) as never} t={makeTranslate(en)} save={save}
    usePreferences={bindSnapshotSelector(createSnapshotStore({ busyEnter: 'queue' as const, plainText: false, showContextUsage: true, sendShortcut: 'enter' as const }))}
    useWritable={bindSnapshotSelector(createSnapshotStore(true))} />)
  const toggle = screen.getByRole('switch')
  fireEvent.click(toggle)
  expect(save).toHaveBeenCalledWith(true)
  expect(toggle.getAttribute('aria-checked')).toBe('false')
  expect(toggle).toHaveProperty('disabled', true)
  expect(screen.getByRole('status').textContent).toBe(en['settings.saving'])
  await act(async () => { pending.reject(new Error('Revision conflict')) })
  expect(screen.getByRole('alert').textContent).toBe('Revision conflict')
  expect(toggle).toHaveProperty('disabled', false)
})

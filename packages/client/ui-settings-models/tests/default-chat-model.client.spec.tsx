// @vitest-environment jsdom
/** Default choices preserve session-independent settings and retry stale revisions. */
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { DefaultChatModel } from '../src/client/DefaultChatModel.tsx'
import type { SettingsNamespaceView } from '@hydraharness/harness-api-remotes/client'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)
const ok = <T,>(value: T) => ({ result: { ok: true, value } })
const groups = [{ id: 'p', name: 'Provider', models: [
  { id: 'old', name: 'Old' },
  { id: 'new', name: 'New', endpoints: ['responses'], reasoning: { defaultEffort: 'low', efforts: [] } },
  { id: 'plain', name: 'Plain', endpoints: ['messages'] },
  { id: 'unnamed' },
  { id: 'empty-name', name: '' },
  { id: 'image', name: 'Image', endpoints: ['images/generations'] },
  { id: 'video', name: 'Video', endpoints: ['videos'] },
] }]
function owner() {
  const namespace = { ns: 'agent-default-model', value: { provider: 'p', model: 'old', reasoningEffort: 'high' },
    revision: 2, schema: {}, secrets: [], applies: 'live' } as SettingsNamespaceView
  return { namespace, groups: groups as never, readOnly: false, loading: false, t: (key: keyof typeof en) => en[key],
    api: { settings: { mutate: vi.fn(async () => ok(namespace)), describe: vi.fn() } } as never,
    onSaved: vi.fn(async () => {}) }
}
it('filters non-chat models and saves a complete selection only after acknowledgement', async () => {
  const props = owner()
  let finish!: (value: unknown) => void
  const mutate = vi.fn(() => new Promise((resolve) => { finish = resolve }))
  render(<DefaultChatModel {...props} api={{ settings: { mutate } } as never} />)
  expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual(['Old', 'New', 'Plain', 'unnamed', 'empty-name'])
  expect(screen.queryByRole('option', { name: 'Image' })).toBeNull()
  expect(screen.queryByRole('option', { name: 'Video' })).toBeNull()
  fireEvent.change(screen.getByRole('combobox', { name: en.defaultModel }), { target: { value: '["p","new"]' } })
  expect(screen.getByRole('status').textContent).toBe(en.saving)
  expect(props.onSaved).not.toHaveBeenCalled()
  expect(mutate).toHaveBeenCalledWith({ ns: 'agent-default-model', expectedRevision: 2, ops: [
    { op: 'set', path: ['provider'], value: 'p' }, { op: 'set', path: ['model'], value: 'new' },
    { op: 'set', path: ['reasoningEffort'], value: 'low' },
  ] })
  finish(ok({ ...props.namespace, revision: 3, value: { provider: 'p', model: 'new', reasoningEffort: 'low' } }))
  await waitFor(() => { expect(props.onSaved).toHaveBeenCalledOnce() })
  expect(screen.getByRole('status').textContent).toBe(en.defaultModelSaved)
})
it.each([['old', 'high'], ['plain', undefined]])('preserves compatible effort or clears it on %s', async (model, effort) => {
  const p = owner()
  const mutate = vi.fn(async () => ok(p.namespace))
  render(<DefaultChatModel {...p} api={{ settings: { mutate } } as never} />)
  fireEvent.change(screen.getByRole('combobox', { name: en.defaultModel }), { target: { value: JSON.stringify(['p', model]) } })
  await waitFor(() => { expect(p.onSaved).toHaveBeenCalled() })
  expect(mutate).toHaveBeenCalledWith({ ns: p.namespace.ns, expectedRevision: p.namespace.revision, ops: [
    { op: 'set', path: ['provider'], value: 'p' }, { op: 'set', path: ['model'], value: model },
    effort === undefined ? { op: 'unset', path: ['reasoningEffort'] } : { op: 'set', path: ['reasoningEffort'], value: effort },
  ] })
})
it('retains a failed selection and reloads a conflicting revision before retry', async () => {
  const p = owner()
  const latest = { ...p.namespace, revision: 9 }
  const mutate = vi.fn().mockResolvedValueOnce({ result: { ok: false, error: { code: 'settings-conflict', message: 'Revision conflict' } } })
    .mockResolvedValue(ok(latest))
  const describe = vi.fn(async () => ok({ namespaces: [latest] }))
  const view = render(<DefaultChatModel {...p} api={{ settings: { mutate, describe } } as never} />)
  fireEvent.change(screen.getByRole('combobox', { name: en.defaultModel }), { target: { value: '["p","plain"]' } })
  await waitFor(() => { expect(p.onSaved).toHaveBeenCalledWith(latest) })
  expect(screen.getByRole('alert').textContent).toBe('Revision conflict')
  expect(screen.getByRole<HTMLSelectElement>('combobox', { name: en.defaultModel }).value).toBe('["p","plain"]')
  view.rerender(<DefaultChatModel {...p} namespace={latest} api={{ settings: { mutate, describe } } as never} />)
  fireEvent.click(screen.getByRole('button', { name: en.retry }))
  await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(2) })
  expect(mutate).toHaveBeenNthCalledWith(2, { ns: p.namespace.ns, expectedRevision: 9, ops: [
    { op: 'set', path: ['provider'], value: 'p' }, { op: 'set', path: ['model'], value: 'plain' },
    { op: 'unset', path: ['reasoningEffort'] },
  ] })
})
it('keeps an unavailable saved selection visible and does not write on catalog changes', () => {
  const p = owner()
  const mutate = vi.fn()
  const view = render(<DefaultChatModel {...p} groups={[]} api={{ settings: { mutate } } as never} />)
  expect(screen.getByRole<HTMLSelectElement>('combobox', { name: en.defaultModel }).selectedOptions[0]?.textContent).toBe(`old — ${en.generationModelUnavailable}`)
  expect(mutate).not.toHaveBeenCalled()
  view.rerender(<DefaultChatModel {...p} readOnly loading />)
  expect(screen.getByRole<HTMLSelectElement>('combobox', { name: en.defaultModel }).disabled).toBe(true)
})
it('keeps a network failure for Retry or Discard', async () => {
  const p = owner()
  const mutate = vi.fn().mockRejectedValue(new Error('offline'))
  render(<DefaultChatModel {...p} api={{ settings: { mutate } } as never} />)
  fireEvent.change(screen.getByRole('combobox', { name: en.defaultModel }), { target: { value: '["p","plain"]' } })
  expect((await screen.findByRole('alert')).textContent).toBe('offline')
  fireEvent.click(screen.getByRole('button', { name: en.discard }))
  expect(screen.getByRole<HTMLSelectElement>('combobox', { name: en.defaultModel }).value).toBe('["p","old"]')
  expect(p.onSaved).not.toHaveBeenCalled()
})

it('offers selection when first-run composition has no selected model', () => {
  const p = owner()
  render(<DefaultChatModel {...p} namespace={{ ...p.namespace, value: { provider: '__unselected__', model: '__unselected__' } }} />)
  expect(screen.getByRole('option', { name: en.defaultModelUnselected })).toBeTruthy()
  expect(p.onSaved).not.toHaveBeenCalled()
})

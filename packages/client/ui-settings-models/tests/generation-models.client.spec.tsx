// @vitest-environment jsdom
/** Shared generation roles keep provider identity and save only acknowledged settings. */
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { RpcResponse, SettingsNamespaceView } from '@hydraharness/harness-api-remotes/client'
import { GenerationModels } from '../src/client/GenerationModels.tsx'
import { settingsSchema } from './settings-schema.client.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)
const ok = <T,>(value: T): RpcResponse<T> => ({ rpcId: 'generation-choice' as never, result: { ok: true, value } })
const groups = ['first', 'second'].map(id => ({ id, name: id, models: [
  { id: 'same-model', name: 'Shared name', endpoints: ['images/generations', 'videos'] },
  { id: 'image-only', name: 'Image', endpoints: ['images/generations'] },
  { id: 'video-only', name: 'Video', endpoints: ['videos'] },
  { id: 'text-model', name: 'Text', endpoints: ['chat/completions'] },
  { id: 'unknown', name: 'Unknown' },
] }))
function owner(value: unknown = {}) {
  return {
    catalogRevision: 'llm-pi-ai:7',
    namespace: { ns: 'llm-pi-ai', value, schema: {}, revision: 7, applies: 'live', secrets: [] } as SettingsNamespaceView,
    schema: settingsSchema, t: (key: keyof typeof en) => en[key], readOnly: false,
    api: { llm: { models: vi.fn(async () => ok({ groups, failures: [] })) }, settings: { mutate: vi.fn(async () => ok({})) } } as never,
    onSaved: vi.fn(async () => {}),
  }
}

it('filters each generation dropdown by endpoint classification and saves distinct providers', async () => {
  const props = owner()
  const mutate = vi.fn(async () => ok({}))
  const api = { llm: { models: async () => ok({ groups, failures: [] }) }, settings: { mutate } } as never
  const view = render(<GenerationModels {...props} api={api} />)
  await waitFor(() => { expect(screen.getByLabelText<HTMLSelectElement>(en.imageModel).disabled).toBe(false) })
  expect(view.container.querySelectorAll('select')).toHaveLength(2)
  for (const field of [en.imageModel, en.videoModel]) {
    expect([...screen.getByLabelText<HTMLSelectElement>(field).options].map(option => option.value))
      .toEqual(['', '["first","same-model"]', JSON.stringify(['first', field === en.imageModel ? 'image-only' : 'video-only']),
        '["second","same-model"]', JSON.stringify(['second', field === en.imageModel ? 'image-only' : 'video-only'])])
  }
  fireEvent.change(screen.getByLabelText(en.imageModel), { target: { value: '["second","same-model"]' } })
  fireEvent.change(screen.getByLabelText(en.videoModel), { target: { value: '["first","same-model"]' } })
  fireEvent.click(screen.getByRole('button', { name: en.apply }))
  await waitFor(() => { expect(props.onSaved).toHaveBeenCalledOnce() })
  expect(mutate).toHaveBeenCalledWith({ ns: 'llm-pi-ai', expectedRevision: 7, ops: [
    { op: 'set', path: ['imageModel'], value: { provider: 'second', model: 'same-model' } },
    { op: 'set', path: ['videoModel'], value: { provider: 'first', model: 'same-model' } },
  ] })
})

it('refreshes account catalogs without changing the preference revision or discarding pending choices', async () => {
  const props = owner()
  const models = vi.fn().mockResolvedValueOnce(ok({ groups, failures: [] }))
    .mockResolvedValueOnce(ok({ groups: [...groups, { id: 'chatgpt', name: 'ChatGPT', models: [{ id: 'gpt-image-2', name: 'Codex image', endpoints: ['images/generations'] }] }], failures: [] }))
  const api = { llm: { models }, settings: { mutate: vi.fn() } } as never
  const view = render(<GenerationModels {...props} api={api} catalogRevision="accounts:1" />)
  await waitFor(() => { expect(screen.getByLabelText<HTMLSelectElement>(en.imageModel).disabled).toBe(false) })
  fireEvent.change(screen.getByLabelText(en.imageModel), { target: { value: '["first","image-only"]' } })
  view.rerender(<GenerationModels {...props} api={api} catalogRevision="accounts:2" />)
  await waitFor(() => { expect(screen.getAllByRole('option', { name: 'ChatGPT / Codex image (gpt-image-2)' })).toHaveLength(1) })
  expect(models).toHaveBeenCalledTimes(2)
  expect(screen.getByLabelText<HTMLSelectElement>(en.imageModel).value).toBe('["first","image-only"]')
  expect(screen.getByRole('button', { name: en.discard })).toBeDefined()
})

it('retains failed choices for retry, supports Discard and clearing, and renders read-only values', async () => {
  const props = owner({ imageModel: { provider: 'second', model: 'same-model' } })
  const mutate = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(ok({}))
  const api = { llm: { models: async () => ok({ groups, failures: [] }) }, settings: { mutate } } as never
  const view = render(<GenerationModels {...props} api={api} />)
  await waitFor(() => { expect(screen.getByLabelText<HTMLSelectElement>(en.imageModel).disabled).toBe(false) })
  fireEvent.change(screen.getByLabelText(en.imageModel), { target: { value: '' } })
  fireEvent.click(screen.getByRole('button', { name: en.apply }))
  expect((await screen.findByRole('alert')).textContent).toBe('offline')
  expect(props.onSaved).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: en.discard }))
  expect(screen.getByLabelText<HTMLSelectElement>(en.imageModel).value).toBe('["second","same-model"]')
  fireEvent.change(screen.getByLabelText(en.imageModel), { target: { value: '' } })
  fireEvent.click(screen.getByRole('button', { name: en.apply }))
  await waitFor(() => { expect(props.onSaved).toHaveBeenCalledOnce() })
  expect(mutate).toHaveBeenNthCalledWith(2, { ns: 'llm-pi-ai', expectedRevision: 7,
    ops: [{ op: 'unset', path: ['imageModel'] }, { op: 'unset', path: ['videoModel'] }] })
  view.rerender(<GenerationModels {...props} api={api} readOnly />)
  expect(screen.getByLabelText<HTMLSelectElement>(en.imageModel).disabled).toBe(true)
})

it('shows partial catalog errors and keeps an unavailable selection explicit', async () => {
  const props = owner({ videoModel: { provider: 'missing', model: 'gone' } })
  render(<GenerationModels {...props} api={{ llm: { models: async () => ok({ groups, failures: [{ id: 'missing', name: 'Missing', message: 'Catalog offline' }] }) } } as never} />)
  expect((await screen.findByRole('alert')).textContent).toBe('Catalog offline')
  expect(screen.getByLabelText<HTMLSelectElement>(en.videoModel).selectedOptions[0]?.textContent).toBe(en.generationModelUnavailable)
})

it('keeps a reclassified saved model unavailable until cleared instead of silently selecting a replacement', async () => {
  const props = owner({ imageModel: { provider: 'first', model: 'text-model' } })
  const mutate = vi.fn(async () => ok({}))
  render(<GenerationModels {...props} api={{ llm: { models: async () => ok({ groups, failures: [] }) }, settings: { mutate } } as never} />)
  await waitFor(() => { expect(screen.getByLabelText<HTMLSelectElement>(en.imageModel).disabled).toBe(false) })
  const select = screen.getByLabelText<HTMLSelectElement>(en.imageModel)
  expect(select.selectedOptions[0]?.textContent).toBe(en.generationModelUnavailable)
  expect(mutate).not.toHaveBeenCalled()
  fireEvent.change(select, { target: { value: '' } })
  fireEvent.click(screen.getByRole('button', { name: en.apply }))
  await waitFor(() => { expect(props.onSaved).toHaveBeenCalledOnce() })
  expect(mutate).toHaveBeenCalledWith({ ns: 'llm-pi-ai', expectedRevision: 7,
    ops: [{ op: 'unset', path: ['imageModel'] }, { op: 'unset', path: ['videoModel'] }] })
})

it.each([null, 'invalid', { provider: 1, model: 'same-model' }, { provider: 'first', model: 1 }])('uses an unset generation selection for invalid durable values %j', async (imageModel) => {
  render(<GenerationModels {...owner({ imageModel })} />)
  await waitFor(() =>{  expect(screen.getByLabelText<HTMLSelectElement>(en.imageModel).disabled).toBe(false) })
  expect(screen.getByLabelText<HTMLSelectElement>(en.imageModel).value).toBe('')
})
it.each(['rejected', 'throw'])('retries a failed catalog request: %s', async (kind) => {
  const models = vi.fn()
  if (kind === 'throw') models.mockRejectedValueOnce('Catalog offline')
  else models.mockResolvedValueOnce({ result: { ok: false, error: { message: 'Catalog offline' } } })
  models.mockResolvedValue(ok({ groups: [{ id: 'id', name: 'Provider', models: [{ id: 'image', name: 'image', endpoints: ['images/generations'] }] }], failures: [] }))
  render(<GenerationModels {...owner()} api={{ llm: { models } } as never} />)
  expect((await screen.findByRole('alert')).textContent).toBe('Catalog offline')
  await waitFor(() =>{  expect(screen.getByRole<HTMLButtonElement>('button', { name: en.refreshModels }).disabled).toBe(false) })
  fireEvent.click(screen.getByRole('button', { name: en.refreshModels }))
  await screen.findByRole('option', { name: 'Provider / image' })
  expect(screen.queryByRole('alert')).toBeNull()
})
it('keeps a rejected settings write for correction and retry', async () => {
  const p = owner()
  render(<GenerationModels {...p} api={{ llm: { models: async () => ok({ groups, failures: [] }) }, settings: { mutate: async () => ({ result: { ok: false, error: { message: 'Revision conflict' } } }) } } as never} />)
  await waitFor(() =>{  expect(screen.getByLabelText<HTMLSelectElement>(en.imageModel).disabled).toBe(false) })
  fireEvent.change(screen.getByLabelText(en.imageModel), { target: { value: '["first","image-only"]' } })
  fireEvent.click(screen.getByRole('button', { name: en.apply }))
  expect((await screen.findByRole('alert')).textContent).toBe('Revision conflict')
  expect(p.onSaved).not.toHaveBeenCalled()
})
it.each([false, true])('ignores catalog completion after unmount: rejection %s', async (rejects) => {
  let finish!: (value: unknown) => void
  let reject!: (value: unknown) => void
  const pending = new Promise((yes, no) => { finish = yes; reject = no })
  const view = render(<GenerationModels {...owner()} api={{ llm: { models: async () => pending } } as never} />)
  view.unmount()
  if (rejects) reject('late')
  else finish(ok({ groups, failures: [] }))
  await pending.catch(() => undefined)
})

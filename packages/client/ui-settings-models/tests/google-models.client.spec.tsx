// @vitest-environment jsdom
/** Shared Google discovery keeps drafts, selection identities, and writes scoped to each service. */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import Schema from '@hydraharness/schemastery'
import type { DiscoveredModelView, IApiClient, RpcResponse } from '@hydraharness/harness-api-remotes/client'
import { ProviderEditor } from '../src/client/ProviderEditor.tsx'
import { en } from '../src/client/locales.ts'
import { settingsSchema } from './settings-schema.client.ts'

afterEach(cleanup)
const ok = <T,>(value: T): RpcResponse<T> => ({ rpcId: 'google-models-test' as never, result: { ok: true, value } })
const config = Schema.object({ providers: Schema.dict(Schema.object({
  endpoint: Schema.string(),
  models: Schema.array(Schema.object({ id: Schema.string(), name: Schema.string(), endpoints: Schema.array(Schema.string()) })),
})) })

function setup(provider = 'antigravity', discover?: (provider: string) => Promise<readonly DiscoveredModelView[]>, configured = true) {
  const discoverModels = vi.fn(async ({ provider }: { provider?: string }) => ok({ models: await (discover?.(provider!)
    ?? Promise.resolve([{ id: 'same-id', name: `${provider} model` }, { id: `${provider}-only` }])) }))
  const user = { providers: configured ? {
    antigravity: { endpoint: 'https://antigravity.example.test', models: [{ id: 'saved-ag', name: 'Saved AG' }] },
    'gemini-api': { endpoint: 'https://gemini.example.test', models: [{ id: 'saved-api', name: 'Saved API' }] },
  } : {} }
  const mutate = vi.fn(async (_request: Parameters<IApiClient['settings']['mutate']>[0]) => ok({ revision: 2, user }))
  const credentials = { describe: vi.fn(), set: vi.fn() }
  const onClose = vi.fn()
  const view = render(<ProviderEditor provider={provider} displayName="Google" settingsPath={['providers', provider]}
    namespace={{ ns: 'llm-account-auth', schema: config.toJSON(), revision: 1, applies: 'live', secrets: [],
      value: user, base: {}, user }} schema={settingsSchema} t={key => en[key]} readOnly={false} onClose={onClose}
    api={{ settings: { mutate }, credentials, llm: { discoverModels },
      authorization: { list: async () => ok({ entries: [] }), usage: async () => ok({}) } } as unknown as IApiClient} />)
  fireEvent.click(screen.getByText(en.customized))
  return { discoverModels, mutate, credentials, onClose, view }
}

it.each(['antigravity', 'gemini-api'])('fetches both backends from %s and applies equal ids to separate catalogs', async (provider) => {
  const { discoverModels, mutate, credentials, onClose } = setup(provider)
  expect(screen.getAllByRole('button', { name: en.fetchGoogleModels })).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: en.fetchGoogleModels }))
  const picker = await screen.findByRole('dialog', { name: en.fetchTitle })
  expect(discoverModels.mock.calls.map(([request]) => request.provider).sort()).toEqual(['antigravity', 'gemini-api'])
  const ag = within(picker).getByRole('rowgroup', { name: 'Antigravity' })
  const api = within(picker).getByRole('rowgroup', { name: 'Gemini API' })
  fireEvent.change(within(ag).getByLabelText('Model name same-id'), { target: { value: 'AG image' } })
  fireEvent.click(within(ag).getByRole('checkbox', { name: 'Image same-id' }))
  fireEvent.change(within(api).getByLabelText('Model name same-id'), { target: { value: 'API video' } })
  fireEvent.click(within(api).getByRole('checkbox', { name: 'Video same-id' }))
  fireEvent.click(within(api).getByRole('checkbox', { name: 'gemini-api-only' }))
  fireEvent.click(within(picker).getByRole('button', { name: en.fetchAdopt }))
  expect(mutate).not.toHaveBeenCalled()
  expect(screen.getByDisplayValue('AG image')).toBeDefined()
  expect(screen.getByDisplayValue('API video')).toBeDefined()
  expect(screen.queryByDisplayValue('gemini-api-only')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: en.apply }))
  await waitFor(() => { expect(onClose).toHaveBeenCalledWith(true) })
  const request = mutate.mock.calls[0]![0] as unknown as { expectedRevision: number; ops: { path: string[]; value?: unknown }[] }
  expect(request.expectedRevision).toBe(1)
  expect(request.ops).toHaveLength(2)
  expect(request.ops).toEqual(expect.arrayContaining([
    { op: 'set', path: ['providers', 'antigravity', 'models'], value: [
      { id: 'saved-ag', name: 'Saved AG' }, { id: 'same-id', name: 'AG image', endpoints: ['images/generations'] }, { id: 'antigravity-only' },
    ] },
    { op: 'set', path: ['providers', 'gemini-api', 'models'], value: [
      { id: 'saved-api', name: 'Saved API' }, { id: 'same-id', name: 'API video', endpoints: ['videos'] },
    ] },
  ]))
  expect(credentials.describe).not.toHaveBeenCalled()
  expect(credentials.set).not.toHaveBeenCalled()
})

it('retains successful results and identifies a failed backend inside the picker', async () => {
  const { mutate } = setup('antigravity', async (provider) => {
    if (provider === 'gemini-api') throw new Error('quota project missing')
    return [{ id: 'working-model' }]
  })
  fireEvent.click(screen.getByRole('button', { name: en.fetchGoogleModels }))
  const picker = await screen.findByRole('dialog', { name: en.fetchTitle })
  expect(within(picker).getByRole('alert').textContent).toBe('Gemini API: quota project missing')
  fireEvent.click(within(picker).getByRole('button', { name: en.fetchAdopt }))
  expect(screen.getByDisplayValue('working-model')).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: en.apply }))
  await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(1) })
  expect(mutate.mock.calls[0]![0]).toMatchObject({ ops: [{ path: ['providers', 'antigravity', 'models'] }] })
  expect(screen.getByDisplayValue('Saved API')).toBeDefined()
})

it('reports both failures and restores the Fetch button without creating a picker', async () => {
  setup('antigravity', async (provider) => { throw new Error(`${provider} unavailable`) })
  fireEvent.click(screen.getByRole('button', { name: en.fetchGoogleModels }))
  await screen.findByText('Antigravity: antigravity unavailable · Gemini API: gemini-api unavailable')
  expect(screen.queryByRole('dialog', { name: en.fetchTitle })).toBeNull()
  expect(screen.getByRole<HTMLButtonElement>('button', { name: en.fetchGoogleModels }).disabled).toBe(false)
})

it('cancels shared selection without changing either draft or writing settings', async () => {
  const { mutate } = setup()
  fireEvent.click(screen.getByRole('button', { name: en.fetchGoogleModels }))
  const picker = await screen.findByRole('dialog', { name: en.fetchTitle })
  fireEvent.click(within(picker).getByRole('button', { name: en.fetchDeselectAll }))
  expect(within(picker).getByRole<HTMLInputElement>('checkbox', { name: 'antigravity-only' }).checked).toBe(false)
  fireEvent.click(within(picker).getByRole('button', { name: en.fetchSelectAll }))
  fireEvent.click(within(picker).getByRole('button', { name: en.cancel }))
  expect(screen.queryByDisplayValue('same-id')).toBeNull()
  expect(mutate).not.toHaveBeenCalled()
})

it('gets all Google models into both drafts and allows resetting the related catalog', async () => {
  const { mutate } = setup()
  fireEvent.click(screen.getByRole('button', { name: en.getAllGoogleModels }))
  await waitFor(() => { expect(screen.getAllByDisplayValue('same-id')).toHaveLength(2) })
  const related = screen.getByRole('region', { name: 'Gemini API' })
  fireEvent.click(within(related).getByRole('button', { name: en.resetModels }))
  expect(within(related).queryByDisplayValue('saved-api')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: en.apply }))
  await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(1) })
  expect(mutate.mock.calls[0]![0].ops).toEqual(expect.arrayContaining([
    { op: 'unset', path: ['providers', 'gemini-api', 'models'] },
  ]))
})

it('blocks Apply for an invalid sibling row and retains both drafts when the Host refuses the write', async () => {
  const { mutate, onClose } = setup()
  const related = within(screen.getByRole('region', { name: 'Gemini API' }))
  fireEvent.change(related.getByLabelText('Model ID 1'), { target: { value: '' } })
  expect(screen.getByRole<HTMLButtonElement>('button', { name: en.apply }).disabled).toBe(true)
  fireEvent.change(related.getByLabelText('Model ID 1'), { target: { value: 'valid-api' } })
  mutate.mockResolvedValueOnce({ rpcId: 'google-test' as never, result: { ok: false, error: { code: 'settings-conflict', message: 'Conflict' } } } as never)
  fireEvent.click(screen.getByRole('button', { name: en.apply }))
  await screen.findByText(en.conflict)
  expect(screen.getByDisplayValue('valid-api')).toBeDefined()
  expect(screen.getByDisplayValue('saved-ag')).toBeDefined()
  expect(onClose).not.toHaveBeenCalled()
})

it('preserves tuned existing names when Get all adopts both catalogs', async () => {
  const { mutate } = setup('antigravity', async provider => [
    { id: provider === 'antigravity' ? 'saved-ag' : 'saved-api', name: 'Remote name' },
  ])
  fireEvent.click(screen.getByRole('button', { name: en.getAllGoogleModels }))
  await waitFor(() => { expect(screen.getByRole<HTMLButtonElement>('button', { name: en.getAllGoogleModels }).disabled).toBe(false) })
  expect(screen.getByDisplayValue('Saved AG')).toBeDefined()
  expect(screen.getByDisplayValue('Saved API')).toBeDefined()
  expect(screen.queryByDisplayValue('Remote name')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: en.apply }))
  await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(1) })
})

it.each(['antigravity', 'gemini-api'])('enables only the selected %s route when neither has a saved profile', async (provider) => {
  const { mutate, discoverModels } = setup(provider, undefined, false)
  expect(screen.queryByRole('region', { name: provider === 'antigravity' ? 'Gemini API' : 'Antigravity' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: en.fetchModels }))
  const picker = await screen.findByRole('dialog', { name: en.fetchTitle })
  expect(discoverModels.mock.calls.map(([request]) => request.provider)).toEqual([provider])
  fireEvent.click(within(picker).getByRole('button', { name: en.cancel }))
  fireEvent.click(screen.getByRole('button', { name: en.apply }))
  await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(1) })
  expect(mutate.mock.calls[0]![0].ops).toEqual([
    { op: 'set', path: ['providers', provider], value: {} },
  ])
})

it('keeps unsupported Cursor discovery disabled while exposing its saved model editor', async () => {
  const { discoverModels } = setup('cursor')
  expect(screen.getByRole<HTMLButtonElement>('button', { name: en.fetchModels }).disabled).toBe(true)
  expect(screen.getByRole<HTMLButtonElement>('button', { name: en.getAllModels }).disabled).toBe(true)
  expect(screen.getByText(en.accountTransportUnavailable)).toBeDefined()
  expect(discoverModels).not.toHaveBeenCalled()
})

it('saves the addressed Google catalog when its counterpart is unconfigured', async () => {
  const { mutate, onClose } = setup('antigravity', undefined, false)
  fireEvent.click(screen.getByRole('button', { name: en.fetchGoogleModels }))
  const picker = await screen.findByRole('dialog', { name: en.fetchTitle })
  fireEvent.click(within(picker).getByRole('button', { name: en.fetchAdopt }))
  fireEvent.click(screen.getByRole('button', { name: en.apply }))
  await waitFor(() =>{  expect(onClose).toHaveBeenCalledWith(true) })
  expect(mutate.mock.calls[0]![0].ops).toHaveLength(1)
  expect(mutate.mock.calls[0]![0].ops[0]?.path).toEqual(['providers', 'antigravity', 'models'])
})

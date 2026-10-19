// @vitest-environment jsdom
/** Account page navigation, shared Google login, and request ownership. */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import Schema from '@hydraharness/schemastery'
import { bindSnapshotSelector } from '@hydraharness/harness-client-test-runtime'
import { ModelsSettingsStore } from '../src/client/store.ts'
import { AccountsSection } from '../src/client/AccountsSection.tsx'
import { en } from '../src/client/locales.ts'
import { settingsSchema } from './settings-schema.client.ts'

afterEach(cleanup)
const ok = <T,>(value: T) => ({ result: { ok: true, value } })

function mount() {
  const authorization = {
    list: vi.fn(async () => ok({ entries: [
      { key: 'llm-account-auth/chatgpt', label: 'ChatGPT', methods: [{ id: 'oauth', label: 'Sign in' }],
        inFlight: false, accounts: [{ id: 'alice', label: 'Alice' }] },
      { key: 'llm-account-auth/antigravity', label: 'Google', methods: [
        { id: 'oauth', label: 'Antigravity' }, { id: 'gemini-api', label: 'Gemini API' },
      ], inFlight: false, accounts: [] },
    ] })),
    begin: vi.fn(async () => ok({ attemptId: 'pending-login' })),
    state: vi.fn(async () => ok({ attempt: { id: 'pending-login', status: 'running', notice: { message: 'Complete sign-in' } } })),
    cancel: vi.fn(async () => ok({})),
    usage: vi.fn(async () => ok({})),
    logout: vi.fn(async () => ok({})),
  }
  const api = { authorization, settings: { mutate: vi.fn(async () => ok({ revision: 2, user: {} })) },
    llm: { discoverModels: vi.fn(async () => ok({ models: [{ id: 'fetched-model', name: 'Fetched model' }] })) } }
  const controller = new ModelsSettingsStore(api as never, settingsSchema, {} as never)
  const config = Schema.object({ providers: Schema.dict(Schema.object({
    models: Schema.array(Schema.object({ id: Schema.string(), name: Schema.string() })),
  })) })
  controller.store.set({ ...controller.store.getSnapshot(), status: 'ready', writable: true,
    namespaces: new Map([['llm-account-auth', { ns: 'llm-account-auth', schema: config.toJSON(),
      revision: 1, applies: 'live', secrets: [], value: { providers: {} }, base: {}, user: {} }]]), rows: [
      ['chatgpt', 'ChatGPT'], ['antigravity', 'Antigravity'], ['gemini-api', 'Gemini API'], ['openai', 'OpenAI'],
    ].map(([provider, displayName]) => ({ entry: { provider: provider!, displayName: displayName!, active: false,
      settingsNs: provider === 'openai' ? 'llm-pi-ai' : 'llm-account-auth', settingsPath: ['providers', provider!] },
    configured: false, removable: false, apiKeyEnv: undefined, credential: undefined, fallbackCredentials: {}, accountCount: 1 })) })
  const openSection = vi.fn()
  const view = render(<AccountsSection controller={controller} api={api as never} schema={settingsSchema}
    useSnapshot={bindSnapshotSelector(controller.store)} t={key => en[key]} openSection={openSection} />)
  return { api, authorization, controller, openSection, view }
}

it('lists dormant providers, groups Google, and opens Models without configuring a provider', async () => {
  const { api, authorization, openSection } = mount()
  await screen.findByText('Alice')
  expect(screen.queryByLabelText(en.keyInput)).toBeNull()
  expect(screen.queryByRole('button', { name: en.apply })).toBeNull()
  expect(screen.queryByRole('button', { name: en.addModel })).toBeNull()
  const select = screen.getByLabelText<HTMLSelectElement>(en.provider)
  expect([...select.options].map(option => option.text)).toEqual(['ChatGPT', 'Google'])
  fireEvent.change(select, { target: { value: 'llm-account-auth/antigravity' } })
  await screen.findByText(en.accountsEmpty)
  expect(screen.queryByText('Alice')).toBeNull()
  fireEvent.change(screen.getByLabelText(en.accountSignInMethod), { target: { value: 'gemini-api' } })
  fireEvent.click(screen.getByRole('button', { name: en.accountAdd }))
  await waitFor(() => { expect(authorization.begin).toHaveBeenCalledWith({ key: 'llm-account-auth/antigravity', method: 'gemini-api' }) })
  fireEvent.click(screen.getByRole('button', { name: en.manageModels }))
  expect(openSection).toHaveBeenCalledWith('models')
  expect(api.settings.mutate).not.toHaveBeenCalled()
})

it('cancels the pending login when selecting another provider and aborts usage when leaving Accounts', async () => {
  const { authorization, view } = mount()
  await screen.findByText('Alice')
  let signal: AbortSignal | undefined
  authorization.usage.mockImplementation((async (_input: unknown, requestSignal: AbortSignal) => {
    signal = requestSignal
    return new Promise(() => {})
  }) as never)
  fireEvent.click(screen.getByRole('button', { name: 'Refresh usage for Alice' }))
  await waitFor(() => { expect(signal).toBeDefined() })
  fireEvent.click(screen.getByRole('button', { name: en.accountAdd }))
  await screen.findByText('Complete sign-in')
  fireEvent.change(screen.getByLabelText(en.provider), { target: { value: 'llm-account-auth/antigravity' } })
  expect(signal?.aborted).toBe(true)
  await waitFor(() => { expect(authorization.cancel).toHaveBeenCalledWith({ attemptId: 'pending-login' }) })
  view.unmount()
})

it('shows account-list errors without claiming the account inventory is empty', async () => {
  const { authorization, view, controller } = mount()
  await screen.findByText('Alice')
  authorization.list.mockRejectedValueOnce(new Error('Accounts connection failed'))
  fireEvent.change(screen.getByLabelText(en.provider), { target: { value: 'llm-account-auth/antigravity' } })
  await screen.findByText('Accounts connection failed')
  expect(screen.queryByText(en.accountsEmpty)).toBeNull()
  act(() => { controller.store.update((state) => { state.status = 'error'; state.error = 'Provider directory failed' }) })
  await screen.findByRole('alert')
  expect(screen.getByRole('button', { name: en.retry })).toBeTruthy()
  view.unmount()
  render(<AccountsSection />)
  expect(screen.queryByRole('heading')).toBeNull()
})

it('fetches once from Accounts and saves the selected catalog only after Apply', async () => {
  const { api, controller } = mount()
  const reload = vi.spyOn(controller, 'load').mockResolvedValue()
  await screen.findByText('Alice')
  fireEvent.click(screen.getByRole('button', { name: en.fetchAccountModels }))
  const picker = await screen.findByRole('dialog', { name: en.fetchTitle })
  expect(api.llm.discoverModels).toHaveBeenCalledExactlyOnceWith({ settingsNs: 'llm-account-auth', provider: 'chatgpt' })
  expect(api.settings.mutate).not.toHaveBeenCalled()
  fireEvent.click(within(picker).getByRole('button', { name: en.fetchAdopt }))
  expect(screen.getByDisplayValue('Fetched model')).toBeDefined()
  expect(api.settings.mutate).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: en.apply }))
  await screen.findByText('Saved ChatGPT (chatgpt).')
  expect(api.settings.mutate).toHaveBeenCalledWith({ ns: 'llm-account-auth', expectedRevision: 1,
    ops: [{ op: 'set', path: ['providers', 'chatgpt', 'models'], value: [{ id: 'fetched-model', name: 'Fetched model' }] }] })
  expect(reload).toHaveBeenCalledOnce()
  expect(screen.queryByRole('button', { name: en.apply })).toBeNull()
  expect(api.llm.discoverModels).toHaveBeenCalledTimes(1)
})

it('keeps failures retryable and discards a fetched catalog on Cancel', async () => {
  const { api } = mount()
  api.llm.discoverModels.mockRejectedValueOnce(new Error('Account endpoint unavailable'))
  fireEvent.click(screen.getByRole('button', { name: en.fetchAccountModels }))
  await screen.findByText('Account endpoint unavailable')
  fireEvent.click(screen.getByRole('button', { name: en.fetchModels }))
  const picker = await screen.findByRole('dialog', { name: en.fetchTitle })
  fireEvent.click(within(picker).getByRole('button', { name: en.fetchAdopt }))
  fireEvent.click(screen.getByRole('button', { name: en.cancel }))
  expect(api.settings.mutate).not.toHaveBeenCalled()
  expect(screen.queryByDisplayValue('fetched-model')).toBeNull()
  expect(screen.getByRole<HTMLButtonElement>('button', { name: en.fetchAccountModels }).disabled).toBe(false)
})

it('targets Gemini API from the shared Google pool and discards drafts when changing provider', async () => {
  const { api } = mount()
  fireEvent.change(screen.getByLabelText(en.provider), { target: { value: 'llm-account-auth/antigravity' } })
  fireEvent.click(screen.getByRole('button', { name: 'Fetch Gemini API models' }))
  await screen.findByRole('dialog', { name: en.fetchTitle })
  expect(api.llm.discoverModels).toHaveBeenCalledWith({ settingsNs: 'llm-account-auth', provider: 'gemini-api' })
  fireEvent.click(within(screen.getByRole('dialog', { name: en.fetchTitle })).getByRole('button', { name: en.cancel }))
  fireEvent.change(screen.getByLabelText(en.provider), { target: { value: 'llm-account-auth/chatgpt' } })
  expect(screen.queryByRole('button', { name: en.apply })).toBeNull()
  expect(api.settings.mutate).not.toHaveBeenCalled()
})

it('disables catalog changes for read-only settings or an empty account pool', () => {
  const { controller, api } = mount()
  act(() => { controller.store.update((state) => { state.writable = false }) })
  expect(screen.getByRole<HTMLButtonElement>('button', { name: en.fetchAccountModels }).disabled).toBe(true)
  act(() => { controller.store.update((state) => { state.writable = true; state.rows[0]!.accountCount = 0 }) })
  expect(screen.getByRole<HTMLButtonElement>('button', { name: en.fetchAccountModels }).disabled).toBe(true)
  expect(api.llm.discoverModels).not.toHaveBeenCalled()
})

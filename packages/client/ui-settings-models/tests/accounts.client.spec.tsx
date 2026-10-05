// @vitest-environment jsdom
/** Multiple account login, prompt privacy, and editor-owned cancellation. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { IApiClient, RpcResponse } from '@hydraharness/harness-api-remotes/client'
import Schema from '@hydraharness/schemastery'
import { ProviderAccounts } from '../src/client/ProviderAccounts.tsx'
import { ProviderEditor } from '../src/client/ProviderEditor.tsx'
import { providerAccountKey, providerUsable } from '../src/client/store.ts'
import { en } from '../src/client/locales.ts'
import { settingsSchema } from './settings-schema.client.ts'

afterEach(() => {
  cleanup()
  delete (globalThis as typeof globalThis & { hydraDesktop?: unknown }).hydraDesktop
  Reflect.deleteProperty(navigator, 'clipboard')
})

it('opens account sign-in through the Desktop system browser and retains masked authorization prompts', async () => {
  const openExternal = vi.fn(async () => undefined)
  Object.assign(globalThis, { hydraDesktop: { openExternal } })
  const api = {
    list: async () => ok({ entries: [{ key: 'llm-account-auth/chatgpt', label: 'ChatGPT',
      methods: [{ id: 'oauth', label: 'Sign in' }], inFlight: false, accounts: [] }] }),
    begin: vi.fn(async () => ok({ attemptId: 'chatgpt-desktop' })), answer: vi.fn(async () => ok({})),
    state: async () => ok({ attempt: { id: 'chatgpt-desktop', status: 'running',
      notice: { message: 'Complete sign-in in your browser.', url: 'https://auth.openai.com/authorize' },
      prompt: { id: 'session', kind: 'secret', message: 'Authorization code' } } }),
    cancel: vi.fn(async () => ok({})),
  }
  const view = render(<ProviderAccounts flowKey="llm-account-auth/chatgpt" api={api as never}
    t={t} disabled={false} onBusy={vi.fn()} mode="add" />)
  const add = screen.getByRole<HTMLButtonElement>('button', { name: en.accountAdd })
  await waitFor(() => { expect(add.disabled).toBe(false) })
  fireEvent.click(add)
  const open = await screen.findByRole('link', { name: en.accountOpenBrowser })
  const session = screen.getByLabelText<HTMLInputElement>('Authorization code')
  expect(session.type).toBe('password')
  expect(open.getAttribute('href')).toBe('https://auth.openai.com/authorize')
  expect(api.begin).toHaveBeenCalledWith({ key: 'llm-account-auth/chatgpt' })
  fireEvent.click(open)
  expect(openExternal).toHaveBeenCalledWith('https://auth.openai.com/authorize')
  expect(screen.getByRole<HTMLButtonElement>('button', { name: en.accountCancel }).disabled).toBe(false)
  expect(api.answer).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: en.accountCopyConsole })).toBeNull()
  view.unmount()
  expect(api.cancel).toHaveBeenCalledWith({ attemptId: 'chatgpt-desktop' })
})

it('copies an authorization snippet on request and retains manual copying when clipboard access fails', async () => {
  const api = {
    list: async () => ok({ entries: [{ key: 'example/import', label: 'Example',
      methods: [{ id: 'import', label: 'Import' }], inFlight: false, accounts: [] }] }),
    begin: async () => ok({ attemptId: 'snippet' }),
    state: async () => ok({ attempt: { id: 'snippet', status: 'running',
      notice: { message: 'Example instructions.', snippet: 'copy("fixture-code")' } } }),
    cancel: async () => ok({}),
  }
  render(<ProviderAccounts flowKey="example/import" api={api as never} t={t} disabled={false} onBusy={vi.fn()} mode="add" />)
  const add = screen.getByRole<HTMLButtonElement>('button', { name: en.accountAdd })
  await waitFor(() => { expect(add.disabled).toBe(false) })
  fireEvent.click(add)
  await screen.findByRole('button', { name: en.accountCopyConsole })
  const writeText = vi.fn(async () => {})
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  fireEvent.click(screen.getByRole('button', { name: en.accountCopyConsole }))
  await screen.findByText(en.accountConsoleCopied)
  expect(writeText).toHaveBeenCalledExactlyOnceWith('copy("fixture-code")')
  writeText.mockRejectedValueOnce(new Error('denied'))
  fireEvent.click(screen.getByRole('button', { name: en.accountCopyConsole }))
  await screen.findByText(en.accountConsoleCopyFailed)
})
const t = (key: keyof typeof en) => en[key]
const ok = <T,>(value: T): RpcResponse<T> => ({ rpcId: 'accounts-test' as never, result: { ok: true, value } })
const flowKey = 'llm-account-auth/chatgpt'

it.each(['add', 'manage'] as const)('offers managed Gemini Web Connect, Reconnect, and Remove in %s mode', async (mode) => {
  const key = 'llm-account-auth/gemini-web'
  let accounts: Array<{ id: string; label: string }> = []
  const api = {
    list: async () => ok({ entries: [{ key, label: 'Gemini Web', methods: [{ id: 'browser', label: 'Connect' }], inFlight: false, accounts }] }),
    begin: vi.fn(async () => { accounts = [{ id: 'one', label: 'fixture@example.test' }]; return ok({ attemptId: 'managed-web' }) }),
    state: async () => ok({ attempt: { id: 'managed-web', status: 'authorized' } }),
    cancel: async () => ok({}), logout: vi.fn(async () => { accounts = []; return ok({}) }), usage: async () => ok({}),
  }
  const view = render(<ProviderAccounts flowKey={key} api={api as never} t={t} disabled={false} onBusy={vi.fn()} mode={mode} />)
  const connect = await screen.findByRole<HTMLButtonElement>('button', { name: en.geminiWebConnect })
  await waitFor(() => { expect(connect.disabled).toBe(false) })
  expect(screen.getByText(en.geminiWebHint)).toBeTruthy()
  fireEvent.click(connect)
  await screen.findByRole('button', { name: en.geminiWebReconnect }, { timeout: 3000 })
  expect(api.begin).toHaveBeenCalledWith({ key })
  if (mode === 'manage') {
    fireEvent.click(screen.getByRole('button', { name: en.geminiWebRemoveLabel.replace('{account}', 'fixture@example.test') }))
    await waitFor(() => { expect(api.logout).toHaveBeenCalledWith({ key, accountId: 'one' }) })
  }
  view.unmount()
})

it.each(['first', 'second'])('starts the explicitly selected authorization %s method', async (choice) => {
  const key = 'example/import'
  const begin = vi.fn(async () => ok({ attemptId: 'gemini-choice' }))
  const api = { list: async () => ok({ entries: [{ key, label: 'Example import', methods: [
    { id: 'first', label: 'First' }, { id: 'second', label: 'Second' },
  ], inFlight: false, accounts: [] }] }), begin, state: async () => ok({ attempt: { id: 'gemini-choice', status: 'running' } }),
  cancel: async () => ok({}) }
  render(<ProviderAccounts flowKey={key} api={api as never} t={t} disabled={false} onBusy={vi.fn()} mode="add" />)
  const method = await screen.findByLabelText<HTMLSelectElement>(en.accountSignInMethod)
  expect(method.value).toBe('first')
  fireEvent.change(method, { target: { value: choice } })
  fireEvent.click(screen.getByRole('button', { name: en.accountAdd }))
  await waitFor(() => { expect(begin).toHaveBeenCalledWith({ key, method: choice }) })
})

it.each(['antigravity', 'gemini-api'])('starts the selected %s method on the shared Google pool', async (provider) => {
  const key = 'llm-account-auth/antigravity'
  const begin = vi.fn(async () => ok({ attemptId: 'google-login' }))
  const config = Schema.object({ providers: Schema.dict(Schema.object({ models: Schema.array(Schema.object({ id: Schema.string() })) })) })
  render(<ProviderEditor provider={provider} displayName="Google" settingsPath={['providers', provider]}
    namespace={{ ns: 'llm-account-auth', schema: config.toJSON(), revision: 1, applies: 'live', secrets: [],
      value: { providers: {} }, base: {}, user: {} }} schema={settingsSchema} t={t} readOnly={false} onClose={vi.fn()}
    api={{ authorization: { list: async () => ok({ entries: [{ key, label: 'Google', methods: [
      { id: 'oauth', label: 'Antigravity' }, { id: 'gemini-api', label: 'Gemini API' },
    ], inFlight: false, accounts: [] }] }), begin,
    state: async () => ok({ attempt: { id: 'google-login', status: 'authorized' } }),
    usage: async () => ok({}), cancel: async () => ok({}) } } as never} />)
  await screen.findByText(en.accountsEmpty)
  fireEvent.click(screen.getByRole('button', { name: en.accountAdd }))
  await screen.findByText(en.accountAdded)
  expect(begin).toHaveBeenCalledWith({ key, method: provider === 'gemini-api' ? 'gemini-api' : 'oauth' })
})

it('opens Antigravity OAuth through the Desktop system browser', async () => {
  const url = 'https://accounts.google.com/o/oauth2/v2/auth?state=fixture'
  const openExternal = vi.fn(async () => undefined)
  Object.assign(globalThis, { hydraDesktop: { openExternal } })
  const key = 'llm-account-auth/antigravity'
  const begin = vi.fn(async () => ok({ attemptId: 'antigravity-login' }))
  const api = {
    list: async () => ok({ entries: [{ key, label: 'Antigravity', methods: [
      { id: 'gemini-api', label: 'Gemini API' }, { id: 'oauth', label: 'Antigravity' },
    ], inFlight: false, accounts: [] }] }),
    begin,
    state: async () => ok({ attempt: { id: 'antigravity-login', status: 'running', notice: { message: 'Sign in with Google.', url } } }),
    cancel: vi.fn(async () => ok({})),
  }
  render(<ProviderAccounts flowKey={key} method="oauth" mode="add" api={api as never}
    t={t} disabled={false} onBusy={vi.fn()} />)
  const add = screen.getByRole<HTMLButtonElement>('button', { name: en.accountAdd })
  await waitFor(() => { expect(add.disabled).toBe(false) })
  fireEvent.click(add)
  const link = await screen.findByRole('link', { name: en.accountOpenBrowser })
  expect(link.getAttribute('href')).toBe(url)
  fireEvent.click(link)
  expect(begin).toHaveBeenCalledWith({ key, method: 'oauth' })
  expect(openExternal).toHaveBeenCalledWith(url)
})

it('keeps account inventory and quota in manage mode while add mode completes login', async () => {
  let accounts = [{ id: 'alice', label: 'alice@example.test' }]
  const api = {
    list: vi.fn(async () => ok({ entries: [{ key: flowKey, label: 'ChatGPT',
      methods: [{ id: 'oauth', label: 'Sign in' }], inFlight: false, accounts }] })),
    begin: vi.fn(async () => ok({ attemptId: 'login' })),
    state: vi.fn(async () => {
      accounts = [...accounts, { id: 'bob', label: 'bob@example.test' }]
      return ok({ attempt: { id: 'login', status: 'authorized' } })
    }),
    usage: vi.fn(async () => ok({})),
    cancel: vi.fn(async () => ok({})),
  }
  const onBusy = vi.fn()
  const view = render(<ProviderAccounts mode="add" flowKey={flowKey}
    api={api as unknown as IApiClient['authorization']} t={t} disabled={false} onBusy={onBusy} />)
  const add = screen.getByRole<HTMLButtonElement>('button', { name: en.accountAdd })
  await waitFor(() => { expect(add.disabled).toBe(false) })
  expect(screen.queryByRole('list', { name: en.accounts })).toBeNull()
  expect(screen.queryByText(en.accounts)).toBeNull()
  expect(screen.queryByText('alice@example.test')).toBeNull()
  expect(api.usage).not.toHaveBeenCalled()
  fireEvent.click(add)
  await screen.findByText(en.accountAdded)
  expect(screen.queryByText('alice@example.test')).toBeNull()
  expect(screen.queryByText('bob@example.test')).toBeNull()
  expect(api.usage).not.toHaveBeenCalled()
  expect(onBusy).toHaveBeenLastCalledWith(false)
  view.rerender(<ProviderAccounts flowKey={flowKey}
    api={api as unknown as IApiClient['authorization']} t={t} disabled={false} onBusy={onBusy} />)
  expect(await screen.findByText('alice@example.test')).toBeDefined()
  expect(await screen.findByText('bob@example.test')).toBeDefined()
  expect(api.usage).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Show usage for alice@example.test' }))
  await waitFor(() => { expect(api.usage).toHaveBeenCalledOnce() })
})

it('adds a second account and signs out only the selected account', async () => {
  let accounts = [{ id: 'alice', label: 'alice@example.test' }]
  let answered = false
  const api = {
    list: vi.fn(async () => ok({ entries: [{ key: flowKey, label: 'ChatGPT',
      methods: [{ id: 'oauth', label: 'Sign in' }], inFlight: false, accounts }] })),
    begin: vi.fn(async () => ok({ attemptId: 'login' })),
    state: vi.fn(async () => ok({ attempt: answered
      ? { id: 'login', status: 'authorized' }
      : { id: 'login', status: 'running', notice: { message: 'Continue in your browser', url: 'https://example.test/login' },
        prompt: { id: 'code', kind: 'secret', message: 'Authorization code' } } })),
    answer: vi.fn(async () => {
      accounts = [...accounts, { id: 'bob', label: 'bob@example.test' }]
      answered = true
      return ok({})
    }),
    cancel: vi.fn(async () => ok({})),
    logout: vi.fn(async ({ accountId }: { accountId: string }) => {
      accounts = accounts.filter(account => account.id !== accountId)
      return ok({})
    }),
    usage: vi.fn(async () => ok({})),
  }
  const onBusy = vi.fn()
  const openExternal = vi.fn(async () => undefined)
  Object.assign(globalThis, { hydraDesktop: { openExternal } })
  render(<ProviderAccounts flowKey={flowKey} api={api as unknown as IApiClient['authorization']}
    t={t} disabled={false} onBusy={onBusy} />)
  await screen.findByText('alice@example.test')
  fireEvent.click(screen.getByRole('button', { name: en.accountAdd }))
  const input = await screen.findByLabelText<HTMLInputElement>('Authorization code')
  expect(input.type).toBe('password')
  const link = screen.getByRole('link', { name: en.accountOpenBrowser })
  expect(link.getAttribute('rel')).toBe('noopener noreferrer')
  expect(link.parentElement).toBe(screen.getByRole('button', { name: en.accountAdd }).parentElement)
  fireEvent.click(link)
  expect(openExternal).toHaveBeenCalledWith('https://example.test/login')
  fireEvent.change(input, { target: { value: 'one-use-code' } })
  fireEvent.click(screen.getByRole('button', { name: en.accountContinue }))
  await screen.findByText(en.accountAdded, {}, { timeout: 2000 })
  expect(screen.getByText('alice@example.test')).toBeDefined()
  expect(screen.getByText('bob@example.test')).toBeDefined()
  expect(screen.queryByDisplayValue('one-use-code')).toBeNull()
  expect(api.answer).toHaveBeenCalledWith({ attemptId: 'login', promptId: 'code', value: 'one-use-code' })
  fireEvent.click(screen.getByRole('button', { name: 'Sign out alice@example.test' }))
  await waitFor(() => { expect(screen.queryByText('alice@example.test')).toBeNull() })
  expect(screen.getByText('bob@example.test')).toBeDefined()
  expect(api.logout).toHaveBeenCalledWith({ key: flowKey, accountId: 'alice' })
  expect(onBusy).toHaveBeenLastCalledWith(false)
  delete (globalThis as typeof globalThis & { hydraDesktop?: unknown }).hydraDesktop
})

it('cancels a login whose begin response arrives after the editor closes', async () => {
  let finishBegin!: (value: RpcResponse<{ attemptId: string }>) => void
  const api = {
    list: async () => ok({ entries: [{ key: flowKey, label: 'ChatGPT', methods: [{ id: 'oauth', label: 'Sign in' }],
      inFlight: false, accounts: [] }] }),
    begin: vi.fn(() => new Promise<RpcResponse<{ attemptId: string }>>((resolve) => { finishBegin = resolve })),
    cancel: vi.fn(async () => { throw new Error('connection closed') }),
    usage: vi.fn(async () => ok({})),
  }
  const view = render(<ProviderAccounts flowKey={flowKey} api={api as unknown as IApiClient['authorization']}
    t={t} disabled={false} onBusy={vi.fn()} />)
  await screen.findByText(en.accountsEmpty)
  fireEvent.click(screen.getByRole('button', { name: en.accountAdd }))
  view.unmount()
  finishBegin(ok({ attemptId: 'late' }))
  await waitFor(() => { expect(api.cancel).toHaveBeenCalledWith({ attemptId: 'late' }) })
})

it('shows provider-reported windows and banked resets per account', async () => {
  const usage = vi.fn(async () => ok({ usage: {
    planType: 'plus', limits: [
      { name: 'Codex', windowMinutes: 300, usedPercent: 25, resetsAt: 1_800_000_000 },
      { name: 'Codex', windowMinutes: 10_080, usedPercent: 50, resetsAt: 1_800_500_000 },
    ], bankedResetCount: 2, fetchedAt: 1_700_000_000,
  } }))
  const api = {
    list: async () => ok({ entries: [{ key: flowKey, label: 'ChatGPT', methods: [{ id: 'oauth', label: 'Sign in' }],
      inFlight: false, accounts: [{ id: 'alice', label: 'alice@example.test' }] }] }),
    usage,
  }
  render(<ProviderAccounts flowKey={flowKey} api={api as unknown as IApiClient['authorization']} t={t} disabled={false} onBusy={vi.fn()} />)
  const fiveHour = await screen.findByRole('progressbar', { name: '5 hour usage limit' })
  expect(fiveHour.getAttribute('aria-valuenow')).toBe('75')
  expect(fiveHour.getAttribute('aria-valuetext')).toBe('75% left')
  expect(fiveHour.getAttribute('aria-description')).toContain('Resets ')
  expect(screen.queryByText(/Resets /)).toBeNull()
  fireEvent.focus(fiveHour)
  expect(screen.getByRole('tooltip').textContent).toContain('Resets ')
  fireEvent.blur(fiveHour)
  expect(screen.getByText('75% left')).toBeDefined()
  expect(screen.getByText('5h')).toBeDefined()
  expect(screen.getByText('Weekly')).toBeDefined()
  expect(screen.getByText('50% left')).toBeDefined()
  expect(screen.getByText(/Banked resets: 2/)).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: en.accountUsageRefresh.replace('{account}', 'alice@example.test') }))
  await waitFor(() => { expect(usage).toHaveBeenCalledTimes(2) })
})

it('renders an unnamed plan, an unwindowed limit, and unavailable banked resets', async () => {
  const api = {
    list: async () => ok({ entries: [{ key: flowKey, label: 'ChatGPT', methods: [{ id: 'oauth', label: 'Sign in' }],
      inFlight: false, accounts: [{ id: 'alice', label: 'alice@example.test' }] }] }),
    usage: async () => ok({ usage: { limits: [{ name: 'Messages', usedPercent: 12.4 }, { name: 'Search', windowMinutes: 300, usedPercent: 5 }], fetchedAt: 1 } }),
  }
  render(<ProviderAccounts flowKey={flowKey} api={api as unknown as IApiClient['authorization']} t={t} disabled={false} onBusy={vi.fn()} />)
  await screen.findByText('Messages')
  expect(screen.getByText('Messages')).toBeTruthy()
  expect(screen.getByText('88% left')).toBeTruthy()
  expect(screen.getByText('Search · 5 hour usage limit')).toBeTruthy()
  expect(screen.getByText('95% left')).toBeTruthy()
  expect(screen.getByText(en.accountBankedResetsUnavailable)).toBeTruthy()
})

it('groups Google quota into compact meters with complete details on hover and focus', async () => {
  const googleKey = 'llm-account-auth/antigravity'
  const api = {
    list: async () => ok({ entries: [{ key: googleKey, label: 'Google Antigravity', methods: [{ id: 'oauth', label: 'Sign in' }],
      inFlight: false, accounts: [{ id: 'google', label: 'google@example.test' }] }] }),
    usage: async () => ok({ usage: { planType: 'Google AI Pro', limits: [
      { name: 'Gemini 3.1 Flash', group: 'Gemini models', window: 'weekly', windowMinutes: 10_080,
        usedPercent: 18, remainingAmount: 820, resetsAt: 1_800_000_000 },
      { name: 'Claude Opus', group: 'Claude and GPT models', window: '5 hours', windowMinutes: 300,
        usedPercent: 40, resetsAt: 1_800_000_000 },
      { name: 'Search', window: '5h', windowMinutes: 300, usedPercent: 20 },
      { name: 'Other model', usedPercent: 60 },
      { name: 'Disabled model', group: 'Other models', usedPercent: 0, disabled: true },
    ], credits: [
      { tier: 'g1', creditType: 'GOOGLE_ONE_AI', creditAmount: 1200, minimumCreditAmountForUsage: 100 },
      { tier: 'free', creditAmount: 4 },
      { tier: 'bonus' },
    ], fetchedAt: 1 } }),
  }
  render(<ProviderAccounts flowKey={googleKey} api={api as unknown as IApiClient['authorization']} t={t} disabled={false} onBusy={vi.fn()} />)
  expect(await screen.findByText(en.accountUsageGeminiModels)).toBeTruthy()
  expect(screen.getByText(en.accountUsageClaudeGptModels)).toBeTruthy()
  expect(screen.getByText(en.accountUsageOtherModels)).toBeTruthy()
  expect(screen.getByText('82% left')).toBeTruthy()
  expect(screen.getByText('60% left')).toBeTruthy()
  expect(screen.getByText('Search · 5 hour usage limit')).toBeTruthy()
  expect(screen.getByText('Weekly')).toBeTruthy()
  const weekly = screen.getByRole('progressbar', { name: 'Weekly usage limit' })
  expect(weekly.getAttribute('aria-description')).toContain('Gemini 3.1 Flash')
  expect(weekly.getAttribute('aria-description')).toContain('820 remaining')
  fireEvent.mouseEnter(weekly)
  expect(screen.getByRole('tooltip').textContent).toContain('820 remaining')
  fireEvent.mouseLeave(weekly)
  expect(screen.getByText('GOOGLE_ONE_AI: 1,200 credits')).toBeTruthy()
  expect(screen.getByText('free: 4 credits')).toBeTruthy()
  expect(screen.getByText(en.accountUsageUnavailable)).toBeTruthy()
  fireEvent.focus(screen.getByText('GOOGLE_ONE_AI: 1,200 credits').parentElement!)
  expect(screen.getByRole('tooltip').textContent).toBe('Credit use starts at 100')
  expect(screen.getByText('Disabled')).toBeTruthy()
  expect(screen.getAllByRole('progressbar')).toHaveLength(4)
  expect(screen.queryByText(/Banked resets/)).toBeNull()
})

it('renders an empty Google credits section without a placeholder', async () => {
  const googleKey = 'llm-account-auth/antigravity'
  const api = {
    list: async () => ok({ entries: [{ key: googleKey, label: 'Google Antigravity', methods: [{ id: 'oauth', label: 'Sign in' }],
      inFlight: false, accounts: [{ id: 'google', label: 'google@example.test' }] }] }),
    usage: async () => ok({ usage: { limits: [{ name: 'Gemini', usedPercent: 0 }], credits: [], fetchedAt: 1 } }),
  }
  render(<ProviderAccounts flowKey={googleKey} api={api as unknown as IApiClient['authorization']} t={t} disabled={false} onBusy={vi.fn()} />)
  await screen.findByText('Gemini')
  expect(screen.queryByRole('heading', { name: en.accountUsageCreditsTitle })).toBeNull()
})

it('keeps unknown providers on the generic usage presentation', async () => {
  const futureKey = 'llm-account-auth/future'
  const api = {
    list: async () => ok({ entries: [{ key: futureKey, label: 'Future', methods: [{ id: 'oauth', label: 'Sign in' }],
      inFlight: false, accounts: [{ id: 'future', label: 'future@example.test' }] }] }),
    usage: async () => ok({ usage: { planType: 'Future plan', limits: [{ name: 'Messages', usedPercent: 10 }], fetchedAt: 1 } }),
  }
  render(<ProviderAccounts flowKey={futureKey} api={api as unknown as IApiClient['authorization']} t={t} disabled={false} onBusy={vi.fn()} />)
  expect(await screen.findByText('Messages')).toBeTruthy()
  expect(screen.getByText('90% left')).toBeTruthy()
})

it('requires a connected account for an active account-backed provider', () => {
  expect(providerAccountKey('llm-account-auth', 'chatgpt')).toBe(flowKey)
  expect(providerAccountKey('llm-account-auth', 'antigravity')).toBe('llm-account-auth/antigravity')
  expect(providerAccountKey('llm-account-auth', 'gemini-api')).toBe('llm-account-auth/antigravity')
  expect(providerAccountKey('llm-pi-ai', 'openai')).toBeUndefined()
  const row = { entry: { active: true }, accountCount: 0 } as Parameters<typeof providerUsable>[0]
  expect(providerUsable(row)).toBe(false)
  expect(providerUsable({ ...row, accountCount: 2 })).toBe(true)
  expect(providerUsable({ ...row, entry: { ...row.entry, active: false }, accountCount: 2 })).toBe(false)
})

it.each(['chatgpt', 'future-provider'])('saves %s without requiring or storing an API key', async (provider) => {
  const config = Schema.object({ providers: Schema.dict(Schema.object({ models: Schema.array(Schema.object({ id: Schema.string() })) })) })
  const mutate = vi.fn(async () => ok({ revision: 2, user: { providers: { chatgpt: {} } } }))
  const set = vi.fn()
  const describe = vi.fn(async () => ok({ credentials: {} }))
  const onClose = vi.fn()
  render(<ProviderEditor provider={provider} displayName="ChatGPT" settingsPath={['providers', provider]}
    namespace={{ ns: 'llm-account-auth', schema: config.toJSON(), revision: 1, applies: 'live', secrets: [],
      value: { providers: {} }, base: {}, user: {} }} schema={settingsSchema} t={t} readOnly={false} onClose={onClose}
    api={{ settings: { mutate }, credentials: { describe, set },
      authorization: { list: async () => ok({ entries: [{ key: flowKey, label: 'ChatGPT', methods: [{ id: 'oauth', label: 'Sign in' }],
        inFlight: false, accounts: [] }] }), usage: async () => ok({}) } } as never} />)
  expect(screen.queryByLabelText(en.keyInput)).toBeNull()
  if (provider === 'chatgpt') {
    await screen.findByText(en.accountsEmpty)
    fireEvent.click(screen.getByText(en.customized))
    fireEvent.click(screen.getByRole('button', { name: en.addModel }))
    fireEvent.change(screen.getByLabelText(`${en.modelId} 1`), { target: { value: 'custom-model' } })
    expect(screen.getByDisplayValue('custom-model')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: en.resetModels }))
    expect(screen.queryByDisplayValue('custom-model')).toBeNull()
  } else expect(screen.getByRole<HTMLButtonElement>('button', { name: en.accountAdd }).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: en.apply }))
  await waitFor(() => { expect(onClose).toHaveBeenCalledWith(true) })
  expect(mutate).toHaveBeenCalledWith({ ns: 'llm-account-auth', expectedRevision: 1,
    ops: [{ op: 'set', path: ['providers', provider], value: {} }] })
  expect(set).not.toHaveBeenCalled()
  expect(describe).not.toHaveBeenCalled()
})

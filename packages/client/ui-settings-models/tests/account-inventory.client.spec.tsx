// @vitest-environment jsdom
/** Search, bounded quota requests, and acknowledged removal in large provider pools. */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { RpcResponse } from '@hydraharness/harness-api-remotes/client'
import { ProviderAccounts } from '../src/client/ProviderAccounts.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)
const t = (key: keyof typeof en) => en[key]
const key = 'llm-account-auth/chatgpt'
const ok = <T,>(value: T): RpcResponse<T> => ({ rpcId: 'inventory-test' as never, result: { ok: true, value } })

function mountPool(count = 100, disabled = false) {
  let accounts = Array.from({ length: count }, (_, index) => ({ id: `id-${index}`,
    label: `account-${String(index).padStart(3, '0')}@example.test` }))
  const failures = new Set<string>()
  const api = {
    list: vi.fn(async () => ok({ entries: [{ key, label: 'ChatGPT', methods: [{ id: 'oauth', label: 'Sign in' }], inFlight: false, accounts }] })),
    usage: vi.fn(async () => ok({ usage: { limits: [{ name: 'Codex', usedPercent: 25 }], fetchedAt: 1 } })),
    logout: vi.fn(async ({ accountId }: { accountId: string }) => {
      if (failures.has(accountId)) throw new Error('storage failed')
      accounts = accounts.filter(account => account.id !== accountId)
      return ok({})
    }),
  }
  const onBusy = vi.fn()
  const view = render(<ProviderAccounts flowKey={key} api={api as never} t={t} disabled={disabled} onBusy={onBusy} />)
  return { view, api, onBusy, failures, accounts: () => accounts }
}

it('searches all 100 accounts without loading quota and reuses the expanded account report', async () => {
  const { api } = mountPool()
  await screen.findByText('account-000@example.test')
  expect(within(screen.getByRole('list', { name: en.accounts })).getAllByRole('listitem')).toHaveLength(10)
  expect(api.usage).not.toHaveBeenCalled()
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'ACCOUNT-099' } })
  expect(screen.getByText('account-099@example.test')).toBeTruthy()
  expect(screen.queryByText('account-000@example.test')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Show usage for account-099@example.test' }))
  await screen.findByText('75% left')
  expect(api.usage.mock.calls).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: 'Hide usage for account-099@example.test' }))
  fireEvent.click(screen.getByRole('button', { name: 'Show usage for account-099@example.test' }))
  expect(api.usage.mock.calls).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: 'Refresh usage for account-099@example.test' }))
  await waitFor(() => { expect(api.usage.mock.calls).toHaveLength(2) })
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'id-77' } })
  expect(screen.getByText('account-077@example.test')).toBeTruthy()
  expect(api.usage.mock.calls).toHaveLength(2)
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'missing' } })
  expect(screen.getByText(en.accountsNoMatches)).toBeTruthy()
})

it('aborts quota work when changing page and ignores a late report', async () => {
  const { api } = mountPool(11)
  let finish!: (value: unknown) => void
  api.usage.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve as never }))
  await screen.findByText('account-000@example.test')
  fireEvent.click(screen.getByRole('button', { name: 'Show usage for account-000@example.test' }))
  await screen.findByText(en.accountUsageLoading)
  const signal = (api.usage.mock.calls as unknown as [unknown, AbortSignal][])[0]![1]
  fireEvent.click(screen.getByRole('button', { name: en.accountsNext }))
  expect(signal.aborted).toBe(true)
  finish(ok({ usage: { limits: [{ name: 'Stale usage', usedPercent: 2 }], fetchedAt: 1 } }))
  await screen.findByText('account-010@example.test')
  expect(screen.queryByText('Stale usage')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: en.accountsPrevious }))
  await screen.findByText('75% left')
  expect(api.usage.mock.calls).toHaveLength(2)
})

it('retains selections across pages and retries only failed account removals after confirmation', async () => {
  const { api, failures, accounts, onBusy } = mountPool(12)
  await screen.findByText('account-000@example.test')
  fireEvent.click(screen.getByRole('checkbox', { name: en.accountsSelectPage }))
  fireEvent.click(screen.getByRole('button', { name: en.accountsNext }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select account-010@example.test' }))
  const remove = screen.getByRole('button', { name: 'Remove selected (11)' })
  fireEvent.click(remove)
  const confirm = screen.getByRole('dialog', { name: 'Remove 11 accounts?' })
  expect(within(confirm).getAllByRole('listitem')).toHaveLength(11)
  fireEvent.click(within(confirm).getByRole('button', { name: en.cancel }))
  expect(api.logout).not.toHaveBeenCalled()
  failures.add('id-0')
  fireEvent.click(remove)
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: en.accountsRemoveConfirm }))
  await screen.findByRole('alert')
  expect(accounts()).toHaveLength(2)
  expect(api.logout).toHaveBeenCalledTimes(11)
  expect(onBusy).toHaveBeenLastCalledWith(false)
  expect(screen.getByText('1–2 of 2')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Remove selected (1)' })).toBeTruthy()
  expect(api.usage).not.toHaveBeenCalled()
  failures.clear()
  fireEvent.click(screen.getByRole('button', { name: 'Remove selected (1)' }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: en.accountsRemoveConfirm }))
  await waitFor(() => { expect(accounts()).toHaveLength(1) })
  expect(api.logout.mock.calls.at(-1)?.[0]).toEqual({ key, accountId: 'id-0' })
  expect(screen.queryByRole('button', { name: /^Remove selected/ })).toBeNull()
})

it('prevents mutations in read-only mode while allowing account search and quota inspection', async () => {
  const { api } = mountPool(100, true)
  await screen.findByText('account-000@example.test')
  expect(screen.getByRole<HTMLInputElement>('checkbox', { name: en.accountsSelectPage }).disabled).toBe(true)
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Sign out account-000@example.test' }).disabled).toBe(true)
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: '099' } })
  fireEvent.click(screen.getByRole('button', { name: 'Show usage for account-099@example.test' }))
  await screen.findByText('75% left')
  expect(api.logout).not.toHaveBeenCalled()
})

it('stops starting further removals when the editor closes during a pending acknowledgement', async () => {
  const { api, view } = mountPool(12)
  let finish!: () => void
  api.logout.mockImplementationOnce(() => new Promise((resolve) => { finish = () => { resolve(ok({})) } }))
  await screen.findByText('account-000@example.test')
  fireEvent.click(screen.getByRole('checkbox', { name: en.accountsSelectPage }))
  fireEvent.click(screen.getByRole('button', { name: 'Remove selected (10)' }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: en.accountsRemoveConfirm }))
  expect(screen.getByRole<HTMLButtonElement>('button', { name: en.cancel }).disabled).toBe(true)
  view.unmount()
  finish()
  await waitFor(() => { expect(api.logout).toHaveBeenCalledOnce() })
})

it('keeps acknowledged removals out of the list when reloading the inventory fails', async () => {
  const { api } = mountPool(12)
  await screen.findByText('account-000@example.test')
  api.list.mockRejectedValueOnce(new Error('listing disconnected'))
  fireEvent.click(screen.getByRole('button', { name: 'Sign out account-000@example.test' }))
  await screen.findByText('listing disconnected')
  expect(screen.queryByText('account-000@example.test')).toBeNull()
  expect(screen.getByText('11 accounts')).toBeTruthy()
  expect(screen.getByRole<HTMLButtonElement>('button', { name: en.accountAdd }).disabled).toBe(false)
})

it('clears search, selection, and cached quota when changing provider pools', async () => {
  const { view, api, onBusy } = mountPool(12)
  await screen.findByText('account-000@example.test')
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: '000' } })
  fireEvent.click(screen.getByRole('checkbox', { name: en.accountsSelectPage }))
  fireEvent.click(screen.getByRole('button', { name: 'Show usage for account-000@example.test' }))
  await screen.findByText('75% left')
  const nextKey = 'llm-account-auth/antigravity'
  api.list.mockResolvedValueOnce(ok({ entries: [{ key: nextKey, label: 'Google', methods: [{ id: 'oauth', label: 'Sign in' }],
    inFlight: false, accounts: [{ id: 'id-0', label: 'google@example.test' }] }] }))
  api.usage.mockResolvedValueOnce(ok({ usage: { limits: [{ name: 'Gemini', usedPercent: 10 }], fetchedAt: 2 } }))
  view.rerender(<ProviderAccounts flowKey={nextKey} api={api as never} t={t} disabled={false} onBusy={onBusy} />)
  await screen.findByText('90% left')
  expect(screen.queryByText('75% left')).toBeNull()
  expect(screen.queryByRole('searchbox')).toBeNull()
  expect(screen.queryByRole('button', { name: /^Remove selected/ })).toBeNull()
  expect(api.usage.mock.calls).toHaveLength(2)
})

it('reveals a newly connected account beyond the current page and fetches its current quota', async () => {
  const { api } = mountPool(12)
  const updated = [...Array.from({ length: 12 }, (_, index) => ({ id: `id-${index}`,
    label: `account-${String(index).padStart(3, '0')}@example.test` })), { id: 'new', label: 'new@example.test' }]
  Object.assign(api, {
    begin: vi.fn(async () => ok({ attemptId: 'new-login' })),
    state: vi.fn(async () => ok({ attempt: { id: 'new-login', status: 'authorized' } })),
    cancel: vi.fn(async () => ok({})),
  })
  await screen.findByText('account-000@example.test')
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: '000' } })
  api.list.mockResolvedValueOnce(ok({ entries: [{ key, label: 'ChatGPT', methods: [{ id: 'oauth', label: 'Sign in' }],
    inFlight: false, accounts: updated }] }))
  fireEvent.click(screen.getByRole('button', { name: en.accountAdd }))
  await screen.findByText('new@example.test')
  await screen.findByText('75% left')
  expect(screen.getByRole<HTMLInputElement>('searchbox').value).toBe('')
  expect(screen.getByText('11–13 of 13')).toBeTruthy()
  expect(api.usage.mock.calls).toHaveLength(1)
})

it('discards a sole account cached quota after reconnecting the same identity', async () => {
  const { api } = mountPool(1)
  Object.assign(api, {
    begin: vi.fn(async () => ok({ attemptId: 'reconnect' })),
    state: vi.fn(async () => ok({ attempt: { id: 'reconnect', status: 'authorized' } })),
    cancel: vi.fn(async () => ok({})),
  })
  await screen.findByText('75% left')
  api.usage.mockResolvedValueOnce(ok({ usage: { limits: [{ name: 'Codex', usedPercent: 1 }], fetchedAt: 2 } }))
  fireEvent.click(screen.getByRole('button', { name: en.accountAdd }))
  await screen.findByText('99% left')
  expect(screen.queryByText('75% left')).toBeNull()
  expect(api.usage.mock.calls).toHaveLength(2)
})

it('deselects page and individual accounts, clears selection, and dismisses removal', async () => {
  mountPool(2)
  await screen.findByText('account-000@example.test')
  const page = screen.getByRole('checkbox', { name: en.accountsSelectPage })
  fireEvent.click(page)
  fireEvent.click(page)
  expect(screen.queryByRole('button', { name: /^Remove selected/ })).toBeNull()
  const account = screen.getByRole('checkbox', { name: 'Select account-000@example.test' })
  fireEvent.click(account)
  fireEvent.click(account)
  expect(screen.queryByRole('button', { name: /^Remove selected/ })).toBeNull()
  fireEvent.click(account)
  fireEvent.click(screen.getByRole('button', { name: en.accountsClearSelection }))
  fireEvent.click(page)
  fireEvent.click(screen.getByRole('button', { name: 'Remove selected (2)' }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: en.close }))
  expect(screen.queryByRole('dialog')).toBeNull()
})

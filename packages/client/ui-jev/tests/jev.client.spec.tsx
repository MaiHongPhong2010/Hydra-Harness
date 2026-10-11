// @vitest-environment jsdom
/** Decision preference acknowledgements and isolated credential drafts. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { Context, FiberState } from '@hydraharness/cordis'
import { JevProviderOption } from '../src/client/JevProviderOption.tsx'
import { apply } from '../src/client/index.ts'
import * as Host from '../src/index.ts'
import { en } from '../../ui-settings-models/src/client/locales.ts'

afterEach(cleanup)
function owner() {
  const snapshot = { status: 'ready', error: null, view: { namespaces: [
    { ns: 'jev', value: { apiKeyEnv: 'CUSTOM_JEV_KEY', model: 'jev-test' }, revision: 1 },
    { ns: 'browser-decisions', value: { enabled: true }, revision: 7 },
  ] } }
  return { snapshot, props: { readOnly: false, credentials: {}, openSection: vi.fn(),
    useSessions: (() => { throw new Error('unused') }) as never,
    useWorkspaces: (() => { throw new Error('unused') }) as never,
    useSettings: (() => snapshot) as never, t: ((key: keyof typeof en) => en[key]) as never,
    saveKey: vi.fn(async () => true),
    saveEnabled: vi.fn(async (enabled: boolean) => { snapshot.view.namespaces[1]!.value.enabled = enabled }),
  } }
}
it('boots the Host entry without browser services', async () => {
  const ctx = new Context()
  try { const fiber = ctx.plugin(Host); await fiber.await(); expect(fiber.state).toBe(FiberState.ACTIVE) }
  finally { await ctx.fiber.dispose() }
})
it('saves Off separately from the unchanged credential and model', async () => {
  const p = owner()
  render(<JevProviderOption {...p.props} />)
  expect(screen.getByLabelText<HTMLSelectElement>(en.decisionModel).value).toBe('jev')
  expect(screen.queryByLabelText(en.keyInput)).toBeNull()
  fireEvent.change(screen.getByLabelText(en.decisionModel), { target: { value: 'off' } })
  await waitFor(() => { expect(screen.getByText(en.decisionSaved)).toBeTruthy() })
  expect(p.props.saveEnabled).toHaveBeenCalledWith(false, 7)
  expect(p.props.saveKey).not.toHaveBeenCalled()
  expect(screen.getByText('Model: jev-test')).toBeTruthy()
})
it('retains a failed preference for Retry and does not announce success before acknowledgement', async () => {
  const p = owner()
  p.props.saveEnabled.mockRejectedValueOnce(new Error('Revision conflict'))
  render(<JevProviderOption {...p.props} />)
  fireEvent.change(screen.getByLabelText(en.decisionModel), { target: { value: 'off' } })
  expect((await screen.findByRole('alert')).textContent).toBe('Revision conflict')
  expect(screen.queryByText(en.decisionSaved)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: en.retry }))
  await screen.findByText(en.decisionSaved)
  expect(p.props.saveEnabled).toHaveBeenCalledTimes(2)
})
it('uses the existing key reference, retains a rejected draft, and clears it after acknowledgement', async () => {
  const p = owner()
  p.props.saveKey.mockResolvedValueOnce(false)
  render(<JevProviderOption {...p.props} />)
  fireEvent.click(screen.getByRole('button', { name: en.configureDecision }))
  fireEvent.change(screen.getByLabelText(en.keyInput), { target: { value: 'fixture-secret' } })
  fireEvent.click(screen.getByRole('button', { name: en.apply }))
  expect((await screen.findByRole('alert')).textContent).toBe(en.decisionKeyError)
  expect(screen.getByLabelText<HTMLInputElement>(en.keyInput).value).toBe('fixture-secret')
  fireEvent.click(screen.getByRole('button', { name: en.apply }))
  await screen.findByText(en.decisionKeySaved)
  expect(p.props.saveKey).toHaveBeenCalledWith('CUSTOM_JEV_KEY', 'fixture-secret')
  fireEvent.click(screen.getByRole('button', { name: en.configureDecision }))
  expect(screen.getByLabelText<HTMLInputElement>(en.keyInput).value).toBe('')
  fireEvent.click(screen.getByRole('button', { name: en.cancel }))
  expect(screen.queryByLabelText(en.keyInput)).toBeNull()
})
it('validates keys and contains upstream errors without exposing key material', async () => {
  const p = owner()
  p.props.saveKey.mockRejectedValue(new Error('secret upstream body'))
  render(<JevProviderOption {...p.props} />)
  fireEvent.click(screen.getByRole('button', { name: en.configureDecision }))
  fireEvent.click(screen.getByRole('button', { name: en.apply }))
  expect((await screen.findByRole('alert')).textContent).toBe(en.decisionKeyRequired)
  fireEvent.change(screen.getByLabelText(en.keyInput), { target: { value: 'secret' } })
  fireEvent.click(screen.getByRole('button', { name: en.apply }))
  await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(en.decisionKeyError) })
})
it('shows unavailable settings and keeps read-only controls disabled', () => {
  const p = owner()
  const view = render(<JevProviderOption {...p.props} readOnly />)
  expect(screen.getByLabelText<HTMLSelectElement>(en.decisionModel).disabled).toBe(true)
  view.rerender(<JevProviderOption {...p.props} useSettings={(() => ({ status: 'error', error: 'offline' })) as never} />)
  expect(screen.getByText(en.decisionSettingsUnavailable)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: en.managePlugins }))
  expect(p.props.openSection).toHaveBeenCalledWith('plugins')
})
it('registers the decision slot and acknowledges settings through the shared mirror', async () => {
  const register = vi.fn()
  const inject = vi.fn((_: string, factory: () => unknown) => factory())
  const acceptView = vi.fn()
  const refresh = vi.fn()
  const set = vi.fn().mockResolvedValueOnce({ result: { ok: true } }).mockResolvedValueOnce({ result: { ok: false } })
  const view = { ns: 'browser-decisions', revision: 8, value: { enabled: false } }
  const mutate = vi.fn().mockResolvedValueOnce({ result: { ok: true, value: view } })
    .mockResolvedValueOnce({ result: { ok: false, error: { message: 'conflict' } } })
  apply({ get: () => ({ api: { credentials: { set }, settings: { mutate } } }),
    settingsScope: { describe: () => ({ acceptView }), refresh }, slots: { inject, register } } as never)
  expect(inject).toHaveBeenCalledWith('settings.models.decision', expect.any(Function))
  const spec = register.mock.calls[0]?.[0] as { inject: () => {
    saveKey: (ref: string, value: string) => Promise<boolean>
    saveEnabled: (value: boolean, revision: number) => Promise<void>
  } }
  await expect(spec.inject().saveKey('JEV_KEY', 'secret')).resolves.toBe(true)
  await expect(spec.inject().saveKey('JEV_KEY', 'secret')).resolves.toBe(false)
  await spec.inject().saveEnabled(false, 7)
  expect(mutate).toHaveBeenCalledWith({ ns: 'browser-decisions', expectedRevision: 7, ops: [{ op: 'set', path: ['enabled'], value: false }] })
  expect(acceptView).toHaveBeenCalledWith(view)
  await expect(spec.inject().saveEnabled(true, 7)).rejects.toThrow('conflict')
  expect(refresh).toHaveBeenCalledOnce()
})

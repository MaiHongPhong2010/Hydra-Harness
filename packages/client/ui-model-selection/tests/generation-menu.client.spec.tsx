// @vitest-environment jsdom
/** Generation menu failures, settings acknowledgments, and stale catalog lifetimes. */
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createSnapshotStore } from '@hydraharness/harness-client-runtime/client'
import type { SettingsMirrorSnapshot } from '@hydraharness/harness-client-ui-settings/client'
import type { SettingsNamespaceView } from '@hydraharness/harness-api-remotes/client'
import { GenerationMenu } from '../src/client/GenerationMenu.tsx'
import { en } from '../src/client/locales.ts'
import { en as common } from '@hydraharness/harness-client-locale/src/locales/en.ts'
const ok = (groups: unknown[] = [], failures: unknown[] = []) => ({ result: { ok: true, value: { groups, failures } } })
const groups = [{ id: 'one', name: 'One', models: [{ id: 'image', name: 'Image', endpoints: ['images/generations'] }, { id: 'unknown', name: 'Unknown' }, { id: 'video', name: 'Video', endpoints: ['videos'] }] }]
function props(value: unknown = {}, writable = true) {
  const namespace = { ns: 'llm-pi-ai', revision: 3, value, schema: {}, secrets: [], applies: 'live' } as SettingsNamespaceView
  const mirror = createSnapshotStore<SettingsMirrorSnapshot>({ status: 'ready', error: null, view: { writable, hasDocument: true, namespaces: [namespace] } })
  return { settings: { ...mirror, ensure: async () => {}, acceptView: vi.fn() },
    api: {
      llm: { models: vi.fn(async () => ok(groups)) },
      settings: { mutate: vi.fn(async () => ({ result: { ok: true, value: namespace } })) },
    } as never,
    pane: 'imageModel' as const, onPane: vi.fn(), onClose: vi.fn(), itemRef: () => null,
    t: (key: string, params?: Record<string, unknown>) => {
      const message = params?.message
      return ((en as Record<string, string>)[key] ?? (common as Record<string, string>)[key] ?? key)
        .replace('{message}', typeof message === 'string' ? message : '')
    },
  }
}
afterEach(cleanup)
it.each([null, 'invalid', { provider: 1, model: 'image' }, { provider: 'one', model: 1 }])('renders malformed saved selections as automatic: %j', async (imageModel) => {
  render(<GenerationMenu {...props({ imageModel })} />)
  expect((await screen.findByRole('menuitemradio', { name: 'Image' })).getAttribute('aria-checked')).toBe('false')
  expect(screen.getByRole('menuitemradio', { name: 'Automatic fallback' }).getAttribute('aria-checked')).toBe('true')
})
it('renders missing provider/model ids explicitly and navigates both generation roles', async () => {
  const p = props({ imageModel: { provider: 'one', model: 'gone' }, videoModel: { provider: 'missing', model: 'other' } })
  const view = render(<GenerationMenu {...p} pane="root" />)
  await waitFor(() =>{  expect(screen.getByRole('menuitem', { name: /Image model/ }).textContent).toContain('gone') })
  fireEvent.click(screen.getByRole('menuitem', { name: /Image model/ }))
  fireEvent.click(screen.getByRole('menuitem', { name: /Video model/ }))
  expect(p.onPane.mock.calls).toEqual([['imageModel'], ['videoModel']])
  view.rerender(<GenerationMenu {...p} />)
  expect((await screen.findByRole('menuitemradio', { name: /gone —/ })).hasAttribute('disabled')).toBe(true)
  view.rerender(<GenerationMenu {...props({ imageModel: { provider: 'one', model: 'image' } }, false)} />)
  expect((await screen.findByRole('menuitemradio', { name: 'Image' })).getAttribute('aria-checked')).toBe('true')
  expect(screen.getByRole('menuitemradio', { name: 'Image' }).hasAttribute('disabled')).toBe(true)
})
it.each([new Error('offline'), 'offline'])('shows catalog exceptions and retries: %j', async (error) => {
  const p = props()
  const models = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(ok(groups, [{ message: 'Partial catalog' }]))
  render(<GenerationMenu {...p} api={{ llm: { models }, settings: { mutate: vi.fn() } } as never} />)
  expect((await screen.findByRole('alert')).textContent).toContain('offline')
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await waitFor(() =>{  expect(screen.getByRole('alert').textContent).toContain('Partial catalog') })
})
it('shows a rejected catalog response', async () => {
  const p = props()
  render(<GenerationMenu {...p} api={{ llm: { models: async () => ({ result: { ok: false, error: { message: 'Catalog denied' } } }) } } as never} />)
  expect((await screen.findByRole('alert')).textContent).toContain('Catalog denied')
})
it.each([new Error('write offline'), 'write offline'])('keeps failed writes open and clears an acknowledged preference: %j', async (error) => {
  const p = props()
  const mutate = vi.fn().mockRejectedValueOnce(error).mockResolvedValue({ result: { ok: true, value: {} } })
  render(<GenerationMenu {...p} api={{ llm: { models: async () => ok(groups) }, settings: { mutate } } as never} />)
  fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Image' }))
  expect((await screen.findByRole('alert')).textContent).toContain('write offline')
  expect(p.onClose).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('menuitemradio', { name: 'Automatic fallback' }))
  await waitFor(() =>{  expect(p.onClose).toHaveBeenCalledOnce() })
  expect(mutate.mock.calls[1]![0]).toMatchObject({ ops: [{ op: 'unset', path: ['imageModel'] }] })
  expect(p.settings.acceptView).toHaveBeenCalledOnce()
})
it.each([false, true])('ignores catalog settlements after unmount: rejection %s', async (rejects) => {
  let resolve!: (value: unknown) => void
  let reject!: (error: unknown) => void
  const pending = new Promise((yes, no) => { resolve = yes; reject = no })
  const view = render(<GenerationMenu {...props()} api={{ llm: { models: async () => pending } } as never} />)
  view.unmount()
  if (rejects) reject(new Error('late'))
  else resolve(ok(groups))
  await pending.catch(() => undefined)
})
it('renders nothing until the settings namespace exists', () => {
  const p = props()
  p.settings.set({ status: 'loading', error: null, view: undefined })
  const view = render(<GenerationMenu {...p} />)
  expect(view.container.textContent).toBe('')
})

// @vitest-environment jsdom
import { Context } from '@hydraharness/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { bindSnapshotSelector } from '@hydraharness/harness-client-test-runtime'
import type { SettingsNamespaceView } from '@hydraharness/harness-api-remotes/client'
import { SettingsSchemaService } from '@hydraharness/harness-client-ui-settings/src/client/schema.ts'
import { SettingsDescribeMirror } from '@hydraharness/harness-client-ui-settings/src/client/settings-mirror.ts'
import { PermissionRow, type PermissionRowProps } from '../src/client/PermissionRow.tsx'
import { en } from '../src/client/locales.ts'
import { PermissionPresetSettingsController } from '../src/client/settings-store.ts'

const schema = new SettingsSchemaService(new Context())

/** Controller over a real mirror derived from the same fake wire. */
function derivedController(api: { settings: object }) {
  const wire = api as never
  return new PermissionPresetSettingsController(new SettingsDescribeMirror(wire), wire, schema)
}

afterEach(cleanup)

const SCHEMA = {
  uid: 5,
  refs: {
    1: { type: 'const', value: 'read-only' },
    2: { type: 'const', value: 'workspace-write' },
    3: { type: 'const', value: 'danger-full-access' },
    4: { type: 'union', list: [1, 2, 3] },
    5: { type: 'object', dict: { defaultPreset: 4 } },
  },
}

function view(defaultPreset: string, revision = 0): SettingsNamespaceView {
  return {
    ns: 'permission',
    schema: SCHEMA,
    value: { defaultPreset },
    base: { defaultPreset: 'read-only' },
    applies: 'live',
    secrets: [],
    revision,
  }
}

function ok<T>(value: T) {
  return { rpcId: 'test', result: { ok: true as const, value } }
}

const dictionary: Record<string, string> = en
const t: PermissionRowProps['t'] = key => dictionary[key] ?? key
const runtime = {
  useSessions: (() => { throw new Error('unused') }) as never,
  useWorkspaces: (() => { throw new Error('unused') }) as never,
}

function mount(controller: PermissionPresetSettingsController) {
  return render(
    <PermissionRow
      {...runtime}
      load={() => controller.load()}
      select={preset => controller.select(preset)}
      reset={() => controller.reset()}
      usePermission={bindSnapshotSelector(controller.store)}
      t={t}
    />,
  )
}

describe('PermissionRow', () => {
  it('requires acknowledgement when resetting an override would enable full access', async () => {
    const inherited = { ...view('read-only'), base: { defaultPreset: 'danger-full-access' }, user: { defaultPreset: 'read-only' } }
    const mutate = vi.fn(async (_request: unknown) => ok({ ...view('danger-full-access', 1), base: inherited.base }))
    const controller = derivedController({ settings: {
      describe: async () => ok({ writable: true, hasDocument: true, namespaces: [inherited] }), mutate,
    } })
    mount(controller)
    await screen.findByRole('button', { name: 'Read only' })
    fireEvent.click(screen.getByRole('button', { name: 'Reset to inherited permission' }))
    expect(mutate).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Enable Auto-Pilot' }))
    await waitFor(() => { expect(mutate).toHaveBeenCalledOnce() })
    expect(mutate.mock.calls[0]![0]).toMatchObject({ ops: [{ op: 'unset', path: ['defaultPreset'] }], applyPermissionToOpenSessions: true })
  })
  it('loads the descriptor, opens the menu, and selects a new default', async () => {
    const mutate = vi.fn(() => Promise.resolve(ok(view('workspace-write', 1))))
    const controller = derivedController({
      settings: {
        describe: () => Promise.resolve(ok({ writable: true, hasDocument: false, namespaces: [view('read-only')] })),
        mutate,
      },
    })
    mount(controller)
    const button = await screen.findByRole('button', { name: 'Read only' })
    expect(button.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(button)
    expect(button.getAttribute('aria-expanded')).toBe('true')
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => { expect(button.getAttribute('aria-expanded')).toBe('false') })
    fireEvent.click(button)
    fireEvent.click(button)
    expect(button.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(button)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Read only' }))
    expect(mutate).not.toHaveBeenCalled()
    fireEvent.click(button)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))
    await screen.findByRole('button', { name: 'Edit' })
    expect(mutate).toHaveBeenCalledOnce()
  })

  it('requires explicit acknowledgement before saving full access', async () => {
    const mutate = vi.fn(() => Promise.resolve(ok(view('danger-full-access', 1))))
    const controller = derivedController({
      settings: {
        describe: () => Promise.resolve(ok({ writable: true, hasDocument: false, namespaces: [view('read-only')] })),
        mutate,
      },
    })
    mount(controller)
    fireEvent.click(await screen.findByRole('button', { name: 'Read only' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Auto-Pilot' }))
    expect(mutate).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog', { name: 'Enable Auto-Pilot?' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Read only' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Auto-Pilot' }))
    const dialog = screen.getByRole('dialog', { name: 'Enable Auto-Pilot?' })
    const enable = screen.getByRole('button', { name: 'Enable Auto-Pilot' })
    expect((enable as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(enable)
    await waitFor(() => { expect(mutate).toHaveBeenCalledOnce() })
    expect(dialog.isConnected).toBe(false)
  })

  it('hides an unavailable namespace and disables a read-only provider', async () => {
    const absent = derivedController({
      settings: {
        describe: () => Promise.resolve(ok({ writable: true, hasDocument: false, namespaces: [] })),
        mutate: vi.fn(),
      },
    })
    const rendered = mount(absent)
    await waitFor(() => { expect(rendered.container.textContent).toBe('') })
    rendered.unmount()

    const readonly = derivedController({
      settings: {
        describe: () => Promise.resolve(ok({ writable: false, hasDocument: false, namespaces: [view('read-only')] })),
        mutate: vi.fn(),
      },
    })
    mount(readonly)
    expect((await screen.findByRole('button', { name: 'Read only' })).hasAttribute('disabled')).toBe(true)
  })

  it('shows loading and a contained write error', async () => {
    const describe = Promise.withResolvers<ReturnType<typeof ok<{
      writable: boolean
      namespaces: SettingsNamespaceView[]
    }>>>()
    const controller = derivedController({
      settings: {
        describe: () => describe.promise,
        mutate: () => Promise.resolve({
          rpcId: 'test',
          result: {
            ok: false as const,
            error: { code: 'settings-conflict', message: 'changed elsewhere', details: {} },
          },
        }),
      },
    })
    mount(controller)
    expect((await screen.findByRole('button', { name: 'Loading' })).hasAttribute('disabled')).toBe(true)
    describe.resolve(ok({ writable: true, hasDocument: false, namespaces: [view('read-only')] }))
    const button = await screen.findByRole('button', { name: 'Read only' })
    fireEvent.click(button)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))
    expect((await screen.findByRole('alert')).textContent).toBe('changed elsewhere')
  })
})

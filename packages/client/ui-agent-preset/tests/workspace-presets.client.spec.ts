/** Workspace preset defaults, staged picks, and late acknowledgements. */
import { expect, it, vi } from 'vitest'
import type { SettingsNamespaceView, SettingsTarget } from '@hydraharness/harness-api-remotes/client'
import { SettingsDescribeMirror } from '@hydraharness/harness-client-ui-settings/src/client/settings-mirror.ts'
import { AgentPresetSettingsController } from '../src/client/settings-store.ts'
import { AgentPresetSectionController } from '../src/client/section-store.ts'
import { AgentPresetSeatController } from '../src/client/seat-store.ts'

it('shows and writes the shared default when local sessions use another preset', async () => {
  const target: SettingsTarget = { workspaceId: 'a' as never, layer: 'shared' }
  let namespace: SettingsNamespaceView = { ...target, ns: 'agent-presets', schema: {}, value: { default: 'standard' },
    user: { default: 'standard' }, applies: 'live', secrets: [], revision: 1 }
  const list = vi.fn(async () => ({ rpcId: 'r', result: { ok: true, value: {
    presets: [{ id: 'standard', trust: 'system', isDefault: false }, { id: 'project', trust: 'user', isDefault: true }],
    authorable: true, hasDocument: false,
  } } }))
  const update = vi.fn(async (request: { patch: { default: string } }) => {
    namespace = { ...namespace, value: request.patch, user: request.patch, revision: 2 }
    return { rpcId: 'r', result: { ok: true, value: namespace } }
  })
  const api = { agentPresets: { list }, settings: { update,
    describe: async () => ({ rpcId: 'r', result: { ok: true, value: { ...target, writable: true, hasDocument: true, namespaces: [namespace] } } }) } } as never
  const mirror = new SettingsDescribeMirror(api, 'host', target)
  const row = new AgentPresetSettingsController(api, mirror)
  const section = new AgentPresetSectionController(api, undefined, target, mirror)
  await Promise.all([row.load(), section.load()])
  expect(row.store.getSnapshot().currentValue).toBe('standard')
  expect(section.store.getSnapshot().rows.find(preset => preset.isDefault)?.id).toBe('standard')
  await row.select('project')
  expect(update).toHaveBeenCalledWith({ ...target, ns: 'agent-presets', patch: { default: 'project' } })
  expect(row.store.getSnapshot().currentValue).toBe('project')
})

it('loads each workspace roster and retains a new stage while an earlier apply settles', async () => {
  let target: SettingsTarget = { workspaceId: 'a' as never, layer: 'local' }
  let session = { id: 'sa' as never, blank: true, agentPreset: 'default-a' }
  const pending = Promise.withResolvers<{ rpcId: string; result: { ok: true; value: { agentPreset: string } } }>()
  const list = vi.fn(async (request: SettingsTarget) => ({ rpcId: 'r', result: { ok: true, value: {
    presets: [{ id: `default-${request.workspaceId}`, trust: 'user', isDefault: true }],
  } } }))
  const applied = vi.fn()
  const seat = new AgentPresetSeatController({ agentPresets: { list, select: () => pending.promise } } as never,
    () => session, applied, () => target)
  await seat.load()
  const applying = seat.select('custom-a')
  target = { workspaceId: 'b' as never, layer: 'local' }
  session = { id: 'sb' as never, blank: true, agentPreset: 'default-b' }
  await seat.load()
  seat.stage('custom-b')
  pending.resolve({ rpcId: 'r', result: { ok: true, value: { agentPreset: 'custom-a' } } })
  await applying
  expect(list).toHaveBeenNthCalledWith(1, { workspaceId: 'a', layer: 'local' })
  expect(list).toHaveBeenNthCalledWith(2, { workspaceId: 'b', layer: 'local' })
  expect(seat.store.getSnapshot()).toMatchObject({ current: 'custom-b', busy: false })
  expect(applied).toHaveBeenCalledWith('sa', 'custom-a')
})

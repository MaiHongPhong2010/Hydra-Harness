/** Preset mutation refreshes that overlap an older directory read. */
import { expect, it, vi } from 'vitest'
import type { RpcResponse } from '@hydraharness/harness-api-remotes/client'
import { AgentPresetSectionController } from '../src/client/section-store.ts'
import { AgentPresetSettingsController, type RosterValue } from '../src/client/settings-store.ts'

const roster = (defaultId: string): RpcResponse<RosterValue> => ({
  rpcId: 'roster-race' as never,
  result: { ok: true, value: {
    presets: ['first', 'second'].map(id => ({ id, trust: 'system', isDefault: id === defaultId })),
    authorable: true, hasDocument: false,
  } },
})

it.each(['section', 'general'] as const)('refreshes %s after a mutation overlaps an older roster response', async (kind) => {
  const pending = Promise.withResolvers<ReturnType<typeof roster>>()
  const list = vi.fn().mockResolvedValueOnce(roster('first')).mockReturnValueOnce(pending.promise)
    .mockResolvedValue(roster('second'))
  const update = vi.fn().mockResolvedValue({ rpcId: 'write', result: { ok: true, value: {} } })
  const api = { agentPresets: { list }, settings: { update } } as never
  const mirror = { ensure: async () => {}, acceptView: () => {},
    getSnapshot: () => ({ view: { writable: true, namespaces: [] } }) } as never
  const controller = kind === 'section'
    ? new AgentPresetSectionController(api) : new AgentPresetSettingsController(api, mirror)
  await controller.load()
  const reading = controller.load()
  await vi.waitFor(() => { expect(list).toHaveBeenCalledTimes(2) })
  const saving = controller instanceof AgentPresetSectionController
    ? controller.makeDefault('second') : controller.select('second')
  const invalidation = controller.load()
  await vi.waitFor(() => { expect(update).toHaveBeenCalledTimes(1) })
  pending.resolve(roster('first'))
  await Promise.all([reading, saving, invalidation])
  const selected = controller instanceof AgentPresetSectionController
    ? controller.store.getSnapshot().rows.find(row => row.isDefault)?.id
    : controller.store.getSnapshot().currentValue
  expect(selected).toBe('second')
  expect(list).toHaveBeenCalledTimes(3)
})

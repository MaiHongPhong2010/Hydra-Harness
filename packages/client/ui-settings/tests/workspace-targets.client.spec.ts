/** Targeted settings reads and writes retain their addressed workspace. */
import { Context } from '@hydraharness/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { RpcResponse, SettingsNamespaceView, WorkspaceId } from '@hydraharness/harness-api-remotes/client'
import { SettingsScopeBinder } from '../src/client/settings-scope.ts'
import { SettingsDescribeMirror, type SettingsDescribeView, type SettingsTarget } from '../src/client/settings-mirror.ts'
import { SettingsSchemaService } from '../src/client/schema.ts'

const workspaceA = 'workspace-a' as WorkspaceId
const workspaceB = 'workspace-b' as WorkspaceId
const response = <T>(value: T): RpcResponse<T> => ({ rpcId: 'target-test' as never, result: { ok: true, value } })
const row = (target: SettingsTarget, value = target.workspaceId ?? 'global', revision = 0): SettingsNamespaceView => ({
  ...target, ns: 'agent-presets', schema: {}, value: { default: value }, applies: 'live', secrets: [], revision,
})

function bench() {
  const describeCall = vi.fn(async (target: SettingsTarget): Promise<RpcResponse<SettingsDescribeView>> => response({
    ...target, ...target.workspaceId === undefined ? {} : { trusted: false }, writable: true, hasDocument: true, namespaces: [row(target)],
  }))
  const mutate = vi.fn(async (request: SettingsTarget & { ops: { value?: unknown }[] }) =>
    response(row(request, String(request.ops[0]?.value), 1)))
  const trust = vi.fn(async (request: SettingsTarget & { trusted: boolean }) =>
    response({ ...request, hasProjectConfig: true, trustDecided: true }))
  const api = { settings: { describe: describeCall, mutate, setWorkspaceTrust: trust } }
  const ctx = new Context()
  ctx.provide('connection', { api, isLoopback: true } as never)
  const mirror = new SettingsDescribeMirror(api as never)
  const binder = new SettingsScopeBinder(ctx, { mirror, schema: new SettingsSchemaService(ctx) })
  return { binder, describeCall, mutate, trust }
}

describe('workspace settings targets', () => {
  it('keeps global consumers global while selected forms cache workspace layers independently', async () => {
    const { binder, describeCall } = bench()
    const spec = { namespace: 'agent-presets', decode: (value: unknown) => value as { default: string } }
    const global = binder.bind(spec)
    const selected = binder.bind(spec, 'selected')
    await binder.describe().ensure()
    await binder.selectTarget({ workspaceId: workspaceA })
    expect(selected.getSnapshot().value?.default).toBe(workspaceA)
    expect(global.getSnapshot().value?.default).toBe('global')
    await binder.selectTarget({ workspaceId: workspaceB, layer: 'shared' })
    expect(selected.getSnapshot().value?.default).toBe(workspaceB)
    await binder.selectTarget({ workspaceId: workspaceA })
    expect(describeCall).toHaveBeenCalledTimes(3)
    expect(binder.selection().getSnapshot().target).toEqual({ workspaceId: workspaceA, layer: 'local' })
  })

  it('settles a workspace write into its original mirror after another workspace is selected', async () => {
    const { binder, mutate } = bench()
    const selected = binder.bind({ namespace: 'agent-presets', decode: (value: unknown) => value as { default: string } }, 'selected')
    await binder.selectTarget({ workspaceId: workspaceA })
    const pending = Promise.withResolvers<RpcResponse<SettingsNamespaceView>>()
    mutate.mockReturnValueOnce(pending.promise)
    const writing = selected.set('default', 'preset-a')
    await vi.waitFor(() => { expect(mutate).toHaveBeenCalledOnce() })
    await binder.selectTarget({ workspaceId: workspaceB })
    await selected.set('default', 'preset-b')
    pending.resolve(response(row({ workspaceId: workspaceA, layer: 'local' }, 'preset-a', 1)))
    await writing
    expect(selected.getSnapshot().value?.default).toBe('preset-b')
    await binder.selectTarget({ workspaceId: workspaceA })
    expect(selected.getSnapshot().value?.default).toBe('preset-a')
    expect(mutate.mock.calls[0]?.[0]).toMatchObject({ workspaceId: workspaceA, layer: 'local', expectedRevision: 0 })
    expect(mutate.mock.calls[1]?.[0]).toMatchObject({ workspaceId: workspaceB, layer: 'local', expectedRevision: 0 })
  })

  it('reports an unknown workspace without displaying the global document', async () => {
    const { binder, describeCall } = bench()
    await binder.describe().ensure()
    describeCall.mockRejectedValueOnce(new Error('workspace not found'))
    await binder.selectTarget({ workspaceId: workspaceA })
    expect(binder.describe('selected').getSnapshot().view).toBeUndefined()
    expect(binder.selection().getSnapshot().error).toBe('workspace not found')
    expect(binder.selection().getSnapshot().target.workspaceId).toBe(workspaceA)
  })

  it('refreshes only the changed workspace and rejects a differently addressed write answer', async () => {
    const { binder, describeCall } = bench()
    await binder.selectTarget({ workspaceId: workspaceA })
    await binder.selectTarget({ workspaceId: workspaceB })
    const before = binder.describe('selected').getSnapshot()
    binder.describe({ workspaceId: workspaceB, layer: 'local' }).acceptView(row({ workspaceId: workspaceA, layer: 'local' }, 'wrong', 9))
    expect(binder.describe('selected').getSnapshot()).toBe(before)
    binder.refresh(workspaceA)
    await vi.waitFor(() => { expect(describeCall).toHaveBeenCalledTimes(3) })
    expect(describeCall.mock.calls.at(-1)?.[0].workspaceId).toBe(workspaceA)
  })

  it('shows trust-write failure while retaining the selected workspace', async () => {
    const { binder, trust } = bench()
    await binder.selectTarget({ workspaceId: workspaceA })
    trust.mockRejectedValueOnce(new Error('Host write failed'))
    await binder.setWorkspaceTrust(true)
    expect(trust).toHaveBeenCalledWith({ workspaceId: workspaceA, trusted: true })
    expect(binder.selection().getSnapshot()).toMatchObject({ target: { workspaceId: workspaceA }, loading: false, error: 'Host write failed' })
  })
})

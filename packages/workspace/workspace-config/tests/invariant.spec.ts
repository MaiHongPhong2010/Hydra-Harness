import { describe, expect, it } from 'vitest'
import { Context } from '@hydraharness/cordis'
import InvariantRegistry from '@hydraharness/harness-invariants'
import { WorkspaceId } from '@hydraharness/harness-workspace'
import * as WorkspaceConfigInvariant from '../src/invariant.ts'

describe('workspace trust invariant', () => {
  it('checks the Host decision and removes the listener with its companion', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    const decisions = new Map([[WorkspaceId('work'), true]])
    ctx.provide('workspaceConfig', { isTrusted: (id: WorkspaceId) => decisions.get(id) === true })
    const fiber = await ctx.plugin(WorkspaceConfigInvariant)
    try {
      expect(() => { ctx.emit('workspace-config/trust-updated', WorkspaceId('work'), true) }).not.toThrow()
      expect(() => { ctx.emit('workspace-config/trust-updated', WorkspaceId('work'), false) }).toThrow('Host-owned decision')
      decisions.set(WorkspaceId('work'), false)
      expect(() => { ctx.emit('workspace-config/trust-updated', WorkspaceId('work'), false) }).not.toThrow()
      await fiber.dispose()
      expect(() => { ctx.emit('workspace-config/trust-updated', WorkspaceId('work'), true) }).not.toThrow()
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

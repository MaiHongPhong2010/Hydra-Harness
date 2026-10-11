/** Package-owned runtime checks for workspace trust notifications. @module */

import type { Context } from '@hydraharness/cordis'
import type { InvariantInstaller } from '@hydraharness/harness-invariants'
import type {} from './index.ts'

/** Cordis companion plugin name. */
export const name = 'workspace-config-invariant'
/** Service required before reserving package ownership. */
export const inject = ['invariants']

const install: InvariantInstaller = Object.assign(
  (ctx: Context, fail: (message: string) => never) => {
    ctx.on('workspace-config/trust-updated', (workspaceId, trusted) => {
      if (ctx.workspaceConfig.isTrusted(workspaceId) !== trusted) {
        fail(`workspace '${workspaceId}' trust notification differs from its Host-owned decision`)
      }
    })
  },
  { inject: ['workspaceConfig'] },
)

/**
 * Register the relation between trust notifications and Host settings.
 * @param ctx - Context carrying the invariant service.
 * @returns disposer removing this package's invariant registration.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@hydraharness/harness-workspace-config', install))

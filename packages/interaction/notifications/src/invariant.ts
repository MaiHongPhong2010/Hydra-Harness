/** Package-owned invariant companion for `@hydraharness/harness-notifications`. */
/* jscpd:ignore-start */
import type { Context } from '@hydraharness/cordis'
import type { InvariantInstaller } from '@hydraharness/harness-invariants'

/** Cordis companion plugin name. */
export const name = 'notifications-invariant'
/** Service required before reserving package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this plugin registers settings while browser and OS providers own notification delivery; it owns
 * no mutable delivery projection.
 */
const install: InvariantInstaller = () => {}

/** Registers this package's invariant ownership.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns registration disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@hydraharness/harness-notifications', install))
/* jscpd:ignore-end */

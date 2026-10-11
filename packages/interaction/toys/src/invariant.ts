/** Package-owned invariant companion for `@hydraharness/harness-toys`. */
/* jscpd:ignore-start */
import type { Context } from '@hydraharness/cordis'
import type { InvariantInstaller } from '@hydraharness/harness-invariants'

/** Cordis companion plugin name. */
export const name = 'toys-invariant'
/** Service required before reserving package ownership. */
export const inject = ['invariants']

/** No runtime invariant: the command emits a transient presentation event and retains no durable effect state or mutable projection. */
const install: InvariantInstaller = () => {}

/** Registers this package's invariant ownership.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns registration disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@hydraharness/harness-toys', install))
/* jscpd:ignore-end */

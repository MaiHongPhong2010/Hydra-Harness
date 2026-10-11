/** Package-owned invariant companion for `@hydraharness/harness-optional-plugins`. */
/* jscpd:ignore-start */
import type { Context } from '@hydraharness/cordis'
import type { InvariantInstaller } from '@hydraharness/harness-invariants'

/** Cordis companion plugin name. */
export const name = 'optional-plugins-invariant'
/** Service required before reserving package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: admitted operations return private idempotent leases; consumers own their operation streams, so
 * the lease counter has no independent membership stream to compare.
 */
const install: InvariantInstaller = () => {}

/** Registers this package's invariant ownership.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns registration disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@hydraharness/harness-optional-plugins', install))
/* jscpd:ignore-end */

/** Package-owned invariant companion for `@hydraharness/harness-suggested-prompts`. */
/* jscpd:ignore-start */
import type { Context } from '@hydraharness/cordis'
import type { InvariantInstaller } from '@hydraharness/harness-invariants'

/** Cordis companion plugin name. */
export const name = 'suggested-prompts-invariant'
/** Service required before reserving package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: source readers and batch promises are private caches without an independent membership stream;
 * each batch logs its model inputs and results.
 */
const install: InvariantInstaller = () => {}

/** Registers this package's invariant ownership.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns registration disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@hydraharness/harness-suggested-prompts', install))
/* jscpd:ignore-end */

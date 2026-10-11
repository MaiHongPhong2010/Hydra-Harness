/** Package-owned invariant companion for `@hydraharness/harness-client-ui-suggested-prompts`. */
/* jscpd:ignore-start */
import type { Context } from '@hydraharness/cordis'
import type { InvariantInstaller } from '@hydraharness/harness-invariants'

/** Cordis companion plugin name. */
export const name = 'client-ui-suggested-prompts-invariant'
/** Service required before reserving package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the renderer displays Host-owned batches and fills drafts; it owns no Host projection or event
 * stream to reconcile.
 */
const install: InvariantInstaller = () => {}

/** Registers this package's invariant ownership.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns registration disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@hydraharness/harness-client-ui-suggested-prompts', install))
/* jscpd:ignore-end */

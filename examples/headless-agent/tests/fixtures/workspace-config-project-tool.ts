/** Project-preset contribution used by the real Loader snapshot. @module */

import type { Context } from '@hydraharness/cordis'
import { defineTool } from '@hydraharness/harness-tools'

/** Snapshot preset plugin identity. */
export const name = 'workspace-config-project-tool'
/** The preset contributes one scoped tool. */
export const inject = ['tools']

/**
 * Contribute a tool whose visibility identifies the trusted project preset.
 * @param ctx - the Loader-mounted preset context.
 */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'project_probe',
    description: 'Report the trusted project preset.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute() {
      return 'Project preset is active.'
    },
  }))
}

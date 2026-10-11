/** Explicit human-requested effects, gated by their own setting and optional-plugin policy. */
import type { Context } from '@hydraharness/cordis'
import type {} from '@hydraharness/harness-commands'
import type {} from '@hydraharness/harness-optional-plugins'
import { settingsNamespace } from '@hydraharness/harness-settings'
import z from '@hydraharness/schemastery'
import type { ConfettiId } from './types.ts'
export type * from './types.ts'

/** Deployment limits for a single transient effect. */
export interface Config {
  /** Number of visual particles. */
  particles?: number
  /** Effect lifetime in milliseconds. */
  durationMs?: number
}

/** Validated effect budgets. */
export const Config: z<Config> = z.object({
  particles: z.number().step(1).min(1).max(200).default(48),
  durationMs: z.number().step(1).min(100).max(10000).default(1800),
})

/** Registers the explicitly requested confetti command and its policy.
 * @param ctx - command and settings owners.
 * @param config - bounded animation limits.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const limits = Config(config) as Required<Config>
  ctx.inject(['settings', 'commands'], (cctx) => {
    const settings = cctx.settings.register(settingsNamespace('toys'), z.object({ confetti: z.boolean().default(false) }))
    cctx.commands.register({ name: 'confetti', description: 'Fire confetti when enabled in General Settings.', handler: async ({ agent, rawInput, commandId, signal }) => {
      signal.throwIfAborted()
      if (rawInput.trim() !== '') return { kind: 'error', text: '/confetti takes no arguments.' }
      if (!settings.get().confetti || cctx.get('optionalPlugins')?.enabled === false) return { kind: 'error', text: 'Enable Confetti cannon in General Settings first.' }
      await cctx.parallel('toys/confetti', { id: commandId as unknown as ConfettiId, sessionId: agent.id, ...limits })
      return { kind: 'success', text: 'Confetti fired.' }
    } })
  })
}

/** User policy for live notifications, delivered by connected Web or Desktop providers. */
import type { Context } from '@hydraharness/cordis'
import z from '@hydraharness/schemastery'
import { settingsNamespace } from '@hydraharness/harness-settings'
import type { NotificationSettings } from './types.ts'
export type { NotificationId, NotificationRequest, NotificationSettings } from './types.ts'

/** Registers global live-notification policy.
 * @param ctx - Host settings owner.
 */
export function apply(ctx: Context): void {
  ctx.inject(['settings'], (sctx) => {
    sctx.settings.register<NotificationSettings>(settingsNamespace('notifications'), z.object({
      completion: z.union(['never', 'background', 'always']).default('background'),
      permissionPrompts: z.boolean().default(true), questions: z.boolean().default(true),
      sound: z.union(['default', 'off']).default('default'),
    }))
  })
}

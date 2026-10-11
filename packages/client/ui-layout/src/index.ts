/** Host registration for layout-owned scalar preferences. */
import type { Context } from '@hydraharness/cordis'
import z from '@hydraharness/schemastery'
import { settingsNamespace } from '@hydraharness/harness-settings'
import { DESKTOP_PREFERENCES_NAMESPACE } from './preferences.ts'
import type { DesktopPreferences } from './preferences.ts'

/**
 * Register desktop chrome preferences; the browser feature owner applies their accepted values.
 * @param ctx - owning Host plugin context.
 */
export function apply(ctx: Context): void {
  ctx.inject(['settings'], (sctx) => {
    sctx.settings.register<DesktopPreferences>(settingsNamespace(DESKTOP_PREFERENCES_NAMESPACE), z.object({
      terminalShell: z.string().default(''),
      closeConfirmation: z.union(['never', 'shortcut', 'always']).default('never'),
      popoutHotkey: z.string().default(''),
      popoutStandalone: z.boolean().default(false),
      fileOpenDestination: z.union(['editor', 'terminal', 'system']).default('editor'),
      fullView: z.boolean().default(false),
      bottomPanelControl: z.boolean().default(true),
      terminalLocation: z.union(['bottom', 'right']).default('bottom'),
    }))
  })
}

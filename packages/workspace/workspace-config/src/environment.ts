/** Host-owned runtime context for one workspace. @module */

import type { Context } from '@hydraharness/cordis'
import type { ScopeKey } from '@hydraharness/harness-scope'
import type SettingsProvider from '@hydraharness/harness-settings'
import type AgentPresets from '@hydraharness/harness-agent-presets'

/** One canonical directory's standing runtime composition. */
export interface WorkspaceEnvironment {
  /** Canonical workspace directory; empty for the user-only environment. */
  readonly root: string
  /** Context resolving workspace settings and runtime services. */
  readonly ctx: Context
  /** Registration scope inherited by workspace preset generations. */
  readonly scopeKey: ScopeKey
  /** Effective composition, user, shared, and local settings provider. */
  readonly settings: SettingsProvider
  /** Workspace-scoped preset roster when presets are composed. */
  readonly presets: AgentPresets | undefined
  /** Host-owned permission to apply project settings and presets. */
  readonly trusted: boolean
}

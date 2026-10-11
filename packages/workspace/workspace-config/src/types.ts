/** Browser-safe workspace settings targets and notifications. @module */
import type { WorkspaceId } from '@hydraharness/harness-workspace/types'

/** Workspace document selected for a settings write. */
export type WorkspaceConfigLayer = 'shared' | 'local'

/** Optional settings target; omission selects the Host user document. */
export interface SettingsTarget {
  /** Registered workspace; omitted retains global settings. */
  workspaceId?: WorkspaceId
  /** Workspace document to edit; omitted selects the personal document. */
  layer?: WorkspaceConfigLayer
}

declare module '@hydraharness/cordis' {
  interface Events {
    /**
     * A workspace settings document or its inherited value changed.
     * @param workspaceId - Registered workspace owning the configuration.
     * @param layer - Shared or personal document affected by the update.
     * @mode emit
     */
    'workspace-config/updated'(workspaceId: WorkspaceId, layer: WorkspaceConfigLayer): void
    /**
     * The Host committed a workspace trust decision.
     * @param workspaceId - Registered workspace owning the canonical root.
     * @param trusted - Whether project execution is permitted.
     * @mode emit
     */
    'workspace-config/trust-updated'(workspaceId: WorkspaceId, trusted: boolean): void
  }
}

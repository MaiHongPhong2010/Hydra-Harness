/**
 * Settings shell contract — the types of the `sidebar.settings` occupant this
 * package renders. They live here rather than in ui-settings because they
 * reference the sidebar's own slot type: ui-settings is the settings domain's
 * base layer and must not depend on any `ui-*` presentation package, or the
 * reference graph closes a cycle through ui-sidebar → ui-layout → ui-theme.
 * The settings SLOT types (what registrants contribute) stay in ui-settings.
 */
import type { HostObservable, InjectFace, PropsRenderSlots, PropsRuntime } from '@hydraharness/harness-client-ui-slots'
// Type-only: pulls ui-sidebar's SlotMap merge (the 'sidebar.settings' entry)
// into every program that sees this contract.
import type {} from '@hydraharness/harness-client-ui-sidebar/client'
// Type-only: pulls the settings slot declarations the shell renders into.
import type {} from '@hydraharness/harness-client-ui-settings/client'
import type { WorkspaceId, WorkspaceSettingsStatus } from '@hydraharness/harness-api-remotes/client'
import type { GeneralItem } from './GeneralSection.tsx'

/** One nav row projected from a settings.section registration's options. */
export interface SettingsSectionRow {
  id: string
  order: number
  label: string
}

/** One ordered onboarding step projected from a slot registration. */
export interface SettingsOnboardingStep {
  id: string
  order: number
}

/**
 * Registrant-private injected share of the settings shell (assembled in
 * apply): the ledger's nav-row projection as a hooks-compartment source —
 * the shell reads no locale state and subscribes through the bound hook.
 */
export type SettingsRootInjected = {
  /** Localized navigation search and empty-state labels. */
  searchCopy: { label: string; empty: string }
  /** Read whether selected project commands await a trust decision. */
  workspaceStatus: (workspaceId: WorkspaceId) => Promise<WorkspaceSettingsStatus>
  /** Record explicit acceptance or refusal on the Host. */
  trustWorkspace: (workspaceId: WorkspaceId, trusted: boolean) => Promise<void>
  /** Localized trust dialog copy. */
  trustCopy: { title: string; description: string; allow: string; cancel: string }
  hooks: {
    /** General preference labels used by navigation search. */
    generalItems: HostObservable<readonly GeneralItem[]>
    /** settings.section ledger projected into ordered nav rows. */
    sections: HostObservable<readonly SettingsSectionRow[]>
    /** settings.onboarding ledger projected into coordinator order. */
    onboardingSteps: HostObservable<readonly SettingsOnboardingStep[]>
  }
}

/**
 * Full component props of the settings shell root: the sidebar owner share
 * (wide/rail state) plus the declared render shares and the injected face
 * (hooks compartment bound to useSections). No store is registered — modal
 * open state and active section id are component-local viewing state.
 */
export type SettingsRootComponentProps =
  PropsRuntime<'sidebar.settings'>
  & PropsRenderSlots<
    | 'settings.trigger'
    | 'settings.header'
    | 'settings.action'
    | 'settings.close'
    | 'settings.section'
    | 'settings.onboarding'
  >
  & InjectFace<SettingsRootInjected>

/**
 * Settings slot contract — the canonical home of every settings slot type,
 * owned by the settings domain base rather than by the shell that renders
 * them (ui-settings-general, which occupies `sidebar.settings`). The shell has
 * zero copy of its own: ALL text (trigger label, panel title, header actions,
 * close aria, section content) arrives from registrants. A feature owns its
 * own settings pages — adding a setting never means editing the shell; copy
 * that belongs to no single feature (chrome, the General section) is owned by
 * ui-settings-general too.
 */


declare module '@hydraharness/harness-client-ui-slots' {
  interface SlotMap {
    /**
     * The sidebar-foot trigger row content: icon + label, supplied as slot
     * content (the accessible name comes from the content — rail state
     * renders the label visually hidden). The shell renders the button
     * chrome and owns open state. Absent contribution degrades to an
     * icon-only button without an accessible name (broken-composition state;
     * the shipped composition always registers the seat).
     */
    'settings.trigger': { kind: 'single'; scope: 'root'; owner: SettingsTriggerOwnerProps }
    /**
     * The panel title text seat. Content renders inside the nav heading row;
     * the dialog's accessible name points at that node via aria-labelledby.
     * Absent contribution leaves the heading empty.
     */
    'settings.header': { kind: 'single'; scope: 'root'; owner: SettingsHeaderOwnerProps }
    /**
     * Optional actions rendered in the content-column header before Close.
     * Registrants own visibility, behavior, copy, and failure presentation;
     * the shell supplies only the ordered render site.
     */
    'settings.action': { kind: 'list'; scope: 'root'; owner: SettingsHeaderOwnerProps }
    /**
     * The close button's visually-hidden label text (the button itself —
     * icon, geometry, focus — is shell chrome). Absent contribution leaves
     * the button without an accessible name (broken-composition state).
     */
    'settings.close': { kind: 'single'; scope: 'root'; owner: SettingsHeaderOwnerProps }
    /**
     * One settings page per list entry. Registrant options carry the nav
     * identity: `id` (section key, drives `only` filtering), `order` (nav
     * position), `label` (registrant-localized display text — the registrant
     * re-registers with fresh text on locale change, so the shell never
     * subscribes locale state; the ledger bump doubles as the shell's
     * re-render trigger). Sections render inside the panel content column.
     * General declares six feature-row groups from this contract; the shell
     * owns navigation and search while each feature owns its value and write.
     */
    'settings.section': { kind: 'list'; scope: 'root'; owner: SettingsSectionOwnerProps }
    /**
     * Feature-owned rows inside the desktop Browser settings page. The page
     * only stacks contributions; each item owns its copy, state, and writes.
     * Declared at runtime only when the desktop browser is available.
     */
    'settings.browser.item': { kind: 'list'; scope: 'root'; owner: SettingsBrowserItemOwnerProps }
    /**
     * One page inside the Plugins settings section. The section owner renders
     * localized entry labels as tabs and mounts each contribution inside its
     * corresponding tab panel. Options: `id` (tab key), `order` (tab order),
     * and `label` (registrant-localized tab text). Declared at runtime by the
     * feature that owns the Plugins section; the type lives here so inventory
     * and configuration plugins collaborate without depending on one another.
     * The section also owns the one shared search box for the whole Plugins
     * surface (Plugins, Skills, Hooks, Marketplaces, MCP); each tab receives
     * its current text as `query` and filters its own rows against it.
     */
    'settings.plugins.tab': { kind: 'list'; scope: 'root'; owner: SettingsPluginsTabOwnerProps }
    /**
     * Feature-owned catalog sections inside the Plugins section's Hooks page.
     * The Hooks tab (ui-settings-plugins) stacks its own user-record catalog
     * and these contributions; each item owns its heading, rows, and writes.
     * Declared at runtime by that tab; the type lives here so the inventory
     * plugin contributes its imported-bundle hooks catalog without depending
     * on the tab owner (same rationale as `settings.plugins.tab`). Each item
     * receives the section's shared search text as `query` and filters its own
     * rows against it.
     */
    'settings.plugins.hooks.item': { kind: 'list'; scope: 'root'; owner: SettingsPluginsTabOwnerProps }
    /**
     * Root-scoped onboarding steps contributed by settings features. The
     * shell mounts one ordered step at a time; the active registrant either
     * completes itself or keeps ownership until the user completes its sole
     * path. Registrants own readiness, copy, dialog behavior, AND visible
     * chrome: a step wraps its visible content in its modal surface (including
     * `#root` inert ownership) and renders null while private facts are still
     * loading. The shell paints no chrome of its own, so a mounted-but-deciding
     * step shows and blocks nothing.
     */
    'settings.onboarding': { kind: 'list'; scope: 'root'; owner: SettingsOnboardingOwnerProps }
    /**
     * One preference row inside the General section — the additive seat for a
     * single setting that needs no page of its own (a whole page is
     * `settings.section`), contributed by the feature plugin that owns the
     * preference (locale → Language, ui-theme → Appearance, ui-conversation →
     * Composer Enter). Options: `id` (row key), `order` (row position). The
     * section column only stacks rows, so a row draws its own internals,
     * including its label: nothing projects a `label` here and the owner passes
     * no props at all — copy, current value, and the write path are all yours,
     * through your own inject face and `host.call`. Declared at runtime by
     * ui-settings-general's General entry; the type lives here with every other
     * settings slot type, because this package is the settings domain's base
     * layer and every registrant already depends on it for `ctx.settingsScope`.
     */
    'settings.general.permissions.item': { kind: 'list'; scope: 'root'; owner: SettingsGeneralItemOwnerProps }
    /** Application and environment preferences contributed by their feature owners. */
    'settings.general.general.item': { kind: 'list'; scope: 'root'; owner: SettingsGeneralItemOwnerProps }
    /** Message composition and submission preferences. */
    'settings.general.composer.item': { kind: 'list'; scope: 'root'; owner: SettingsGeneralItemOwnerProps }
    /** Desktop popout preferences. */
    'settings.general.popout.item': { kind: 'list'; scope: 'root'; owner: SettingsGeneralItemOwnerProps }
    /** Notification preferences. */
    'settings.general.notifications.item': { kind: 'list'; scope: 'root'; owner: SettingsGeneralItemOwnerProps }
    /** Optional visual effects. */
    'settings.general.toys.item': { kind: 'list'; scope: 'root'; owner: SettingsGeneralItemOwnerProps }
  }
}

/** Owner share of a Browser settings item (the page supplies nothing). */
export interface SettingsBrowserItemOwnerProps {
  /** Marker field: item owner props are intentionally empty. */
  children?: never
}

/** Owner share of a General preference row (the section supplies nothing). */
export interface SettingsGeneralItemOwnerProps {
  /** Marker field: item owner props are intentionally empty. */
  children?: never
}

/** Owner share of a Plugins tab: selection and the section's shared search box. */
export interface SettingsPluginsTabOwnerProps {
  /** Whether this tab is selected; retained tabs refresh Host lists when selected again. */
  active: boolean
  /** Current text of the section-level search box; empty string matches everything. */
  query: string
}

/** Owner share of the trigger content seat: the sidebar column state. */
export interface SettingsTriggerOwnerProps {
  /** Whether the sidebar renders wide content (false = 56px rail, icon only). */
  wide: boolean
}

/** Owner share of the header title seat (the shell supplies nothing). */
export interface SettingsHeaderOwnerProps {
  /** Marker field: header owner props are intentionally empty. */
  children?: never
}

/**
 * Owner share of a settings section entry. The shell owns modal visibility
 * and navigation; a section's data arrives through its own inject faces and
 * stores. Sections can close the panel or navigate to another registered page.
 */
export interface SettingsSectionOwnerProps {
  /** Settings navigation search; General filters its registered row labels. */
  query?: string
  /** Close the settings panel (the shell owns the open state). */
  close: () => void
  /** Open a registered section, clear navigation search, and focus its heading. */
  openSection: (id: string) => void
}

/** Owner share of the currently active settings-backed onboarding step. */
export interface SettingsOnboardingOwnerProps {
  /** Stable id of the step currently selected by the coordinator. */
  stepId: string
  /** Complete or skip this step and transfer ownership to the next entry. */
  complete: () => void
  /** Open the settings panel directly on one registered section. */
  openSection: (id: string) => void
}

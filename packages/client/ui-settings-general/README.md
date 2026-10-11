# @hydraharness/harness-client-ui-settings-general

Settings shell, ownerless copy, and durable product-onboarding namespace. It occupies `sidebar.settings` with the trigger chrome and modal settings panel, projects the `settings.section` ledger into the navigation and the `settings.onboarding` ledger into one mounted step at a time, and registers everything on the Settings pages that belongs to no single feature — the trigger/header/close chrome content, the local configuration-file action, the General section and its six General group slots, and the `settings` dictionaries. The slot types it renders into belong to ui-settings, the settings domain base; only the shell's own contract types live here, because they reference ui-sidebar's slot type and the base layer must depend on no `ui-*` package. Feature-owned rows (Permission, Language, Appearance), sections (Models), and conditional onboarding steps stay with their feature packages.

The shell ships no onboarding copy of its own — all text arrives from registrants. Nav labels may be locale-following thunks, so the nav projection resolves them through `resolveSlotLabel` and re-renders on the section ledger bump or the locale revision (an optional `ctx.get('locale')` read; no hard locale dependency). The onboarding ledger projects in ascending order and mounts exactly one step at a time. Visible steps own their dialog chrome and app-root `inert` lifecycle; a mounted step still resolving private facts renders null, so nothing paints or blocks while it decides. The active registrant receives its id, `complete()`, and an `openSection(id)` callback; completing or skipping transfers ownership to the next entry. Registrants own durable completion, capability readiness, copy, mutations, and their visible wrapper, so independently registered flows cannot stack and the shell does not become a second configuration fact source.

A loopback browser loads the provider's `hasDocument` capability through `settings.describe` and renders **Open configuration file** only when the Host confirms that a provider-owned local document can be prepared. The action sends the pathless, loopback-only `settings.openDocument` request; the Host resolves the provider path again, materializes an absent document, and hands it to a native text editor (`open -t` on macOS, bypassing a browser file association; the desktop file association on Linux and Windows; Windows association after `wslpath -w` translation on WSL). Open failures keep the action available and render a localized error. Reopening the dialog or reconnecting refreshes availability after a transient read failure or Host topology change. Remote browsers never register the action and never issue the privileged settings read.

The Host half registers `ui-onboarding` in the user-settings seam. Its composition base hides the shipped official DeepSeek row on a fresh Web installation; the Models page writes `false` when the user explicitly adds that provider and writes `true` when the user deletes it. The welcome step contributed by `ui-settings-models` reads and writes its `welcomeNoticeVersion` through the existing public settings boundary. The shell itself remains policy-free.

The Settings panel uses the shared [Modal](../ui-primitives/README.md#dialogs-and-menus) for keyboard focus and nested dismissal. It measures up to 1080 × 900 pixels, fits within a 24-pixel viewport margin, and keeps the same size across sections; longer content scrolls inside the panel. Closing a child dialog leaves Settings open; closing Settings restores focus to its trigger.

Settings edits the global user configuration and shows every registered section regardless of the active workspace. Project files in `.hydra/` supply automatic workspace overrides; the panel has no workspace or storage-layer selector. Selecting a workspace with executable configuration opens an explicit trust confirmation only when the Host has no saved decision. Trust and refusal remain saved on the Host.

General contributes Permissions, General, Composer, Popout Window, Notifications, and Toys list slots under settings.general.{group}.item. A localized contribution label makes each row searchable beside section names. Empty groups collapse; cards use a 680px content column and stack controls on narrow screens. The shell retains one global Settings surface and stores no feature values.

## Model Experience

None, as the plugin renders browser settings UI; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- The General section has no built-in rows; each row appears only when its owning feature plugin is mounted.

# Agent Note: User-owned MCP servers and hooks, persisted in settings

Status: implemented

## Problem

The report was that fresh installs did not auto-save to the config file (plugins/hooks/MCP/Marketplace). Investigation showed marketplace sources and plugin enablement do persist through `plugin-marketplaces` and `plugins.enabled`; the real gaps were upstream of that perception: the harness had **no surface at all** for the user's own MCP servers or hook declarations, and the marketplace add dialog coupled "save source" with "install a named plugin" so a failed import read as a lost source — the modal stayed open with a generic error and gave no hint the source had already been persisted.

## Decision

Two new Host registries mirror the settings-backed pattern used elsewhere, each exposing its records through `pluginInventory` Remotes so the browser can drive them:

**`@hydraharness/harness-mcp-registry`** stores MCP server records under `mcp-servers.servers` (name, transport `stdio`|`streamable-http`, command/args/cwd/env or url/headers, `toolCallTimeoutMs`, `enabled`). Env and header maps are `role('secret')` — they never ride a response; the view exposes only their names. On edit, an omitted map preserves the stored one and a supplied map (even `{}`) replaces it, so a redacted form can never wipe a credential the browser never saw. Reconciliation mounts each enabled record as an `mcp-client` fiber (`failOnStartupError` so failure is observable), tracks per-record status (`started`/`starting`/`failed`/`invalid`) with the failure detail, and emits `mcp-servers/reconciled`; redefinition remounts only records whose client config digest changed.

**`@hydraharness/harness-hooks-registry`** stores hook records under `hooks.records` (name, dialect `claude-code`|`codex`, either an absolute `configPath` or an inline JSON document capped at 256 KiB, plugin-root/project-dir substitution roots, `defaultTimeoutMs`, `enabled`). Definitions are parsed at define-time through the bridges' own parsers (new `./config` export on `hooks-claude-code`/`hooks-codex`) so a record is validated as mounted, not merely stored; inline documents are materialized to `$HYDRA_HOME/hooks/<name>.json` via `writeFileAtomic` on every mount and deleted on remove. Mounts are ordinary Cordis plugins (`hook-record:<name>`), re-reconciled by digest, and emit `hooks-registry/reconciled`.

Both registries serialize mutations through one enqueue chain, refuse unmountable hand-edited records into an `invalid` map rather than crashing startup, and ship `./invariant` companions registered via `ctx.invariants.register` that assert the mounted set follows the stored records. Adding a record saves it disabled, so nothing runs before the user reviews it; the switch is what mounts it. HTTP MCP writes reject username/password URL userinfo, generic settings descriptors treat the endpoint as a secret position, and the dedicated registry projection strips userinfo from legacy records, including malformed values. Definition requests require `mode: create | replace`: create rejects an existing name, and replace rejects a missing record. The check runs inside the mutation queue, before persistence or mounting, because an Add form may hold a stale list and must never replace an enabled command. Browser checks provide immediate duplicate-name feedback; Host checks also cover concurrent callers.

**Browser surface.** `ui-settings-plugins`' MCP tab gains the user's own server list above the imported-plugin list (add/edit/remove modal, transport-conditional fields, name pinned after save since it is also the tool prefix). Its **Hooks** tab is one page for both kinds of hook: the user's editable records first, then the imported bundles' read-only catalogs, which `ui-settings-plugin-inventory` contributes through the new `settings.plugins.hooks.item` child slot instead of the separate tab it used to own. Records are pasted JSON in the record's own dialect (an existing `hooks.json` works verbatim, `hooks` wrapper optional) or an absolute path. Both write only on loopback connections because they name Host paths and start Host processes.

**Marketplace modal split.** `ui-settings-plugin-inventory`'s add dialog now saves the source first, then optionally imports a named plugin. A blank name adds the source alone; a failed install leaves the source saved, reports the failure as an import-stage error beside the staged name (dialog stays open for a retry that re-runs **only** the import — never re-adding an already-saved source), and closing the dialog leaves the source in the Marketplace list.

## Alternatives considered

**A separate JSON file (e.g. `mcp.json`, `hooks.json`) in the Hydra home.** Rejected: settings.yaml is the one document the user already owns and hot-reloads, the settings seam gives revision fencing and secret redaction for free, and the FileSettingsProvider's comment-preserving leaf-diff writes mean hand-edits survive round-trips.

**Mounting user MCP servers through the imported-plugin runtime.** Rejected: a server record is not a plugin bundle — no manifest, no lifecycle beyond connect/disconnect — and forcing the shape would lose the per-record status reporting the tabs now show.

**One registry with a `kind` column.** Rejected: the two record shapes share almost nothing (transports vs. dialects, env redaction vs. definition parsing, tool lists vs. event coverage), and the shared invariant/mount bookkeeping is small enough that a union type would cost more than two parallel packages.

**A separate tab for the user's own hooks, beside the imported bundles' Hooks tab.** Shipped first, then rejected: two tabs both labelled about hooks made the user ask which one was which. The merged tab keeps the two halves as separate catalogs on one page, and the child slot (`settings.plugins.hooks.item`) is what lets the inventory package contribute its half without either package importing the other.

## Consequences

[Hook and MCP loading, ownership, and approval](../bug-fix/2026-09-06-hook-mcp-loading-and-ownership.md) requires Host-owned mounts, a nonempty runnable hook projection, and UTF-8 byte accounting for inline definitions.

[Workspace-local configuration](../architecture/2026-10-09-workspace-local-configuration.md) resolves these namespaces in separate workspace contexts. Their validation, redaction, and record identity remain unchanged; each workspace owns its mounts and can use the same server or hook name as another workspace. Project overrides require Host-recorded trust, while global user records remain usable without project trust.

A user's MCP servers and hooks now persist in `~/.hydra/settings.yaml` (`mcp-servers.servers`, `hooks.records`), survive restarts, and are hot-reloaded like any other settings namespace. Registry tests cover persistence, lifecycle, duplicate creates, and replacement after removal; browser tests cover record forms and duplicate-name rejection, alongside gateway forwarding tests in `plugin-inventory`. Keyless web snapshots exercise the composed Settings surface and persisted document. Known limitations, documented in the READMEs: renaming a record means adding under the new name and removing the old one (the name is identity, and for MCP also the tool prefix); an inline hook document is not read back for editing (the Host returns only what definitions cover, so editing starts from an empty field); and a composition without a registry answers its Remotes with a loud `unavailable` error rather than failing to mount.

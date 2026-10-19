# Agent Note: Fetch model catalogs from Accounts

Status: implemented

## Problem

Connected accounts appear in Accounts while catalog discovery is hidden inside Models provider editors. Fetching models requires leaving the account page, finding or adding its provider, and expanding the catalog.

## Decision

Accounts offers a Fetch models shortcut for the selected account pool. It opens the existing provider editor inline and starts discovery once. Antigravity and Gemini API retain separate buttons because they share credentials but address different catalogs. The editor preserves its shared Google discovery behavior when both routes are configured.

Fetch and Add selected change only the editor draft. Apply uses the existing revision-checked settings mutation and can enable a dormant provider; success appears after Host acknowledgement. Cancel or a provider switch discards the draft. Read-only settings, empty account pools, and unsupported transports disable the shortcut. Account login, removal, and quota operations retain their separate authorization ownership.

This partially supersedes the Accounts-only placement restriction in the [Accounts and Models ownership decision](../architecture/2026-10-11-accounts-models-settings-ownership.md). That decision remains active for credential ownership, deletion behavior, global defaults, and Settings navigation.

## Alternatives considered

**Navigate to Models.** Navigation still requires finding the provider and opening its catalog, leaving the requested shortcut incomplete.

**Write fetched catalogs immediately.** Discovery can replace edited metadata or enable an unwanted route. The existing draft and Apply flow keeps those changes explicit.

**Create another catalog editor.** Reusing ProviderEditor and ModelListEditor preserves validation, partial Google failures, selection identities, and revision conflicts without a second persistence implementation.

## Consequences

Accounts can open model editing without mixing account writes with catalog writes. Component tests cover discovery, explicit save, retry, Cancel, service selection, and unavailable actions. The assembled account browser scenario covers a dormant provider, Host persistence, unchanged credentials, reload, and narrow layouts. Fixture discovery does not establish live provider entitlement.

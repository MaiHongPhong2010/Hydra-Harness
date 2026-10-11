# Agent Note: Account inventory ownership and provider deletion in Models

Status: implemented

## Problem

The Add sign-in provider card duplicates the selected provider's account inventory and quota controls. Provider deletion needs to discard its open editor and remove saved credentials so later login obtains fresh account information without restoring a deleted account or model catalog.

## Decision

The [Accounts and Models ownership decision](../architecture/2026-10-11-accounts-models-settings-ownership.md) supersedes this note's account-control placement and Models deletion policy. The authorization service's whole-record reservation, idempotence, and storage-failure rules below still apply to explicit record removal.

The Add card contains login controls and provider settings. The provider's Edit card owns account listing, quota requests, per-account sign-out, and additional login controls. Configured providers remain selectable in Add so another account can be connected without duplicating their inventory.

Models Delete forgets the entire local credential record for every account-backed provider before unsetting its selected profile. It retains browser sign-ins and never calls the provider's logout or token-revocation endpoint. Opening Delete closes that provider's Edit card, discarding its draft and account view and canceling any login attempt that editor owns. A new login obtains fresh credentials; expanding an account in the next Edit requests its current quota report.

Antigravity and Gemini API use the [shared Google pool](../architecture/2026-10-03-shared-google-oauth-routes.md). Deleting either provider clears that pool and leaves its counterpart's catalog intact. The confirmation identifies this shared effect.

The authorization service reserves the record key during whole-record deletion, excluding login and account-specific removal until storage acknowledges it. Deleting an absent record is idempotent, and storage failure releases the reservation. Credential removal precedes settings removal so either failure leaves a provider row available for retry. Pi-ai's provider record is also removed, covering SDK-saved API keys and OAuth grants; primary and fallback API-key reference cleanup retains its existing ownership rules.

Settings and account storage remain independent under the [credential and authorization decision](../architecture/2026-08-13-credential-records-and-authorization-flows.md). The [native account pools note](../feature/2026-09-13-native-account-provider-pools.md) retains ownership of transport, rotation, cancellation, and opaque credential records; this note owns placement of account controls and disposal of the deleted provider's editor.

## Alternatives considered

- Keeping account inventory in both Add and Edit makes quota and sign-out controls appear in two provider contexts.
- Retaining a local credential record after Delete makes removed accounts reappear without a new login.
- Revoking the provider's browser session changes a separate login outside Hydra.
- Removing accounts one by one permits login between calls and can leave stale grant metadata.
- Keeping the open editor alive during Delete retains a draft and account view belonging to the removed configuration.
- Removing the other Google service's settings would discard a separate catalog without selecting that provider for deletion.

## Consequences

Delete removes the provider's saved accounts from `.credentials.yaml`; Sign out in Edit removes only the selected identity. The shared Google counterpart needs login again while retaining its settings. Keyless browser scenarios cover multiple-account removal, persisted record absence, retained unrelated credentials, reload, and fresh quota after login. These fixtures establish the settings and authorization workflow; live provider consent and native Electron interaction require separate verification.

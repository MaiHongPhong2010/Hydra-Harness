# Agent Note: Separate Accounts and Models settings ownership

Status: implemented

## Problem

Account inventory and quota share model editors, coupling immediate credential changes to Apply and making provider deletion discard reusable identities. Shared Google authorization amplifies that effect across two independently configured catalogs.

## Decision

The existing ui-settings-models plugin registers Accounts immediately after Models. Both sections use one global controller, directory, and credential invalidation path. Accounts mounts one authorization pool at a time; Antigravity and Gemini API share a Google entry while retaining their distinct login methods. No settings namespace, credential key, account id, Host API, or SDK wire format changes.

Accounts saves through authorization immediately and never writes provider profiles. Models owns catalogs, global chat/image/video defaults, API keys, and provider enablement. Its Default model selector and the composer share `agent-default-model` through the global settings mirror; the composer still owns a session-local choice. A Settings change applies to new Agents, preserving logged session choices. Revision-checked writes show success only after acknowledgement and keep failed drafts for retry. Decision contributions own their independent preferences and credentials through `settings.models.decision`, outside the LLM directory. Its Delete action removes only configuration and page-owned key references, keeping opaque account records and Google siblings. Account removal leaves catalogs intact. This supersedes the UI placement and Models deletion choice in the [account editor note](../bug-fix/2026-10-03-provider-account-editor-and-removal.md); that note retains the authorization service's whole-record reservation and storage-failure rationale. The [shared Google routes](2026-10-03-shared-google-oauth-routes.md) retain credential rotation and project semantics.

The settings.section owner supplies openSection: it clears navigation search, selects the destination, and focuses its heading. Manage models and Manage accounts navigate without creating or selecting a provider. Account view disposal cancels owned login and quota requests. Authorization failures stay distinguishable from empty inventory and leave model configuration usable.

## Alternatives considered

- A separate plugin or account configuration store duplicates directory joins and credential invalidation ownership.
- Enabling providers during login turns an account action into an unreviewed catalog/settings mutation.
- Deleting credentials with a model profile prevents accounts from being reused and affects the other Google route.
- Mounting every provider's account view issues unnecessary quota requests and leaves multiple login owners active.

## Consequences

Quota remains provider-reported and read-only, with no Hydra limits or new endpoints. Component tests cover section lifetimes, shared Google methods, navigation, cancellation, and deletion ownership. Assembled keyless Web scenarios exercise Host persistence, dormant-provider login, catalog editing, reload, bulk account removal, themes, narrow windows, and focus. Fixture sign-in and quota do not establish live provider entitlement or OAuth consent.

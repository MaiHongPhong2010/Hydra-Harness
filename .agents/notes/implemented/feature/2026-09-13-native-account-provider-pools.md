# Agent Note: Native account providers and per-request account rotation

Status: implemented

## Problem

ChatGPT and Google Antigravity account access needs an interactive login, durable refresh credentials, and independent account selection. A provider form containing only an API-key field cannot complete that workflow. A permanent proxy process also adds startup and lifecycle work to deployments that use API keys exclusively.

## Decision

The `llm-account-auth` plugin owns native subscription routes and their account pools; the [subscription transport decision](../architecture/2026-10-03-native-subscription-account-routes.md) owns supported protocols and the distinction between connected accounts and callable models. Its directory and settings declarations are available without starting a login or provider request. Provider code loads when an account operation needs it; token refresh happens during use. OAuth callback listeners exist only for their login attempt.

Each provider owns one credential record containing its account pool. The [credential and authorization decision](../architecture/2026-08-13-credential-records-and-authorization-flows.md) remains authoritative for record ownership and observed commits. An authorization flow contributes value-free account listing and account removal; the generic service and browser API never decode the provider's grant payload. Account ids are branded inside the Host and validated at wire and storage parsers.

The authorization service reserves a flow key for the full duration of account removal, so login and removal cannot overlap. A Host begin request keeps its carrier cancellation signal attached until the attempt id response is handed over; an earlier disconnect cancels the service attempt, while later cancellation uses the attempt API.

The [Accounts and Models ownership decision](../architecture/2026-10-11-accounts-models-settings-ownership.md) owns inventory placement and provider deletion. Adding an account preserves other accounts, and signing out removes only the selected identity. Provider configuration and account storage are separate writes: Apply enables the provider route. A route with no connected account does not satisfy onboarding readiness.

Requests rotate through the provider's accounts. A failed attempt can try the next account before any visible output is delivered. Cancellation ends the request instead of advancing to another account. Account selection does not add credentials or authorization answers to the session log or model messages.

Login checks cancellation inside the serialized credential modifier before admitting a grant. Cancellation cannot roll back an atomic write already admitted by the credential provider; the existing authorization service permits that write to finish.

## Alternatives considered

- A separate CLIProxyAPI process would reuse its protocol support but introduce another runtime, listener, and deployment lifecycle. The integrated providers keep authentication and requests within Hydra.
- A single credential per provider cannot retain multiple accounts or implement account rotation.
- Returning refresh tokens to the browser would let the UI manage accounts directly, but it would duplicate credential ownership and expose secrets across the Host API.

## Consequences

The account provider owns OAuth and model-protocol compatibility. Its package README documents provider-specific limits. API-key deployments incur only the dormant plugin declarations, without a proxy process, background refresh loop, or idle polling. The UI polls only while its login is running and cancels its attempt when its editor closes.

The earlier credential-record note is retained because its storage and authorization invariants still apply; this note adds the browser workflow and account selection rather than replacing those invariants. Real account consent and entitlement-dependent generation require separate live verification.

## Testing

Authorization service tests cover provider-owned account operations, store failures, missing flows, removal during login, and the removal reservation race. RPC tests cover value-free views, prompt validation, carrier cancellation before handoff, generic error redaction, and account-specific removal. UI tests cover a second account, removal without deleting its sibling, masked prompts, late login cancellation, and saving an account provider without an API key. The assembled browser scenario owns the user-visible transcript.

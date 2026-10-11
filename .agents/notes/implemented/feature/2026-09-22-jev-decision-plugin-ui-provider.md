# Agent Note: Jev decision capability and Models provider contribution

Status: implemented

## Problem

TypeSafe Jev answers unary choice, score, and yes/no questions. It does not implement Hydra's streaming `LlmAdapter`, so exposing it as a chat provider would make the model picker advertise a route that cannot produce conversation output. Browser decisions also need to remain advisory so an unavailable optional service cannot disable ordinary browser execution.

## Decision

`@hydraharness/harness-jev` provides `ctx.jev.systemOne()` as an optional Host capability. It calls Hydra's configured Jev `POST /api/v1/decisions` endpoint with a credential reference, `typesafe-ai/jev` default model, timeout, cancellation, response-envelope validation, and safe typed errors. Settings and credentials are optional: the plugin boots without either service, and a missing key fails only the decision request.

`@hydraharness/harness-browser-decisions` is a separately packaged optional consumer in the base bundle's `jev` plugin group. Its `browser_decide` tool asks Jev to choose from candidate labels and returns an unavailable result when Jev is absent or fails. It never navigates, clicks, creates selectors, changes permissions, or bypasses browser policy.

`@hydraharness/harness-client-ui-jev` registers `settings.models.decision`, below the Default, Image, and Video selectors. The contribution owns Off/Jev, its resolved model label, and a write-only credential editor. Models supplies read-only state, value-free credential descriptors, and section navigation. The shared settings mirror supplies Jev's namespace and the consumer's `browser-decisions.enabled` preference. Key writes use the existing Credentials API and clear a draft only after acknowledgement. Preference writes use revision-checked Settings mutations; Off retains the key and stops only new browser decision requests. The [consumer enablement note](2026-09-26-jev-bounded-consumer.md) owns group and in-flight behavior.

The decision contribution stays outside `ctx.llm`, `session.models`, and the conversation picker. Host Jev, the browser-decisions consumer, and the UI contribution share `pluginGroup: jev`. A disabled group displays Off with navigation to Plugins; changing a preference never enables a plugin group. Credential refresh and reload derive presence from Host descriptors rather than a browser-local saved flag.

The Jev provider, browser-decisions consumer, and Models contribution share one inventory group, so enabling that group mounts the bounded browser decision path after the normal core-plugin restart. Disabling the group removes its service, tool, and UI slot through normal Cordis disposal. Existing browser tools and model routes remain unchanged in the disabled and keyless states.

## Alternatives considered

**Register Jev as an `LlmAdapter`.** Rejected because Jev returns structured decisions rather than Hydra text/reasoning/tool-call streams.

**Embed browser behavior in the Jev provider.** Rejected because the provider is useful to other consumers and browser authority belongs to the existing browser executor and policy.

**Add a Jev-specific branch to `ModelsSection`.** Rejected because the typed decision slot lets optional providers own their preference and editor without coupling the page to their implementation.

**Add retries, a model catalog, or automatic browser invocation.** Deferred under YAGNI; callers can retry deliberately and the first consumer only needs one candidate-choice workflow.

## Consequences

Jev is available to future consumers through one small capability while the normal LLM route and replay contracts stay stable. The Models page owns layout, credential refresh, and contribution lifecycle, while Jev owns its decision preference and write-only editor. The decision tool can abstain, so missing optional infrastructure preserves the existing agent path. The provider's direct `fetch` keeps the dependency closure small, but the API response validator must track the TypeSafe wire fields used by consumers.

## Testing

The Host and consumer packages compile in the Host aggregate, and the UI contribution compiles in the Client aggregate. Focused component and store tests cover decision preferences, acknowledgement failures, and non-chat credential state. The assembled Web scenario saves a key through the real Host, verifies the preference after page reload, reopens the editor without exposing the key, and observes missing-key status after credential deletion. Provider and browser-consumer tests cover successful response projection and missing-service abstention; live provider calls remain opt-in.

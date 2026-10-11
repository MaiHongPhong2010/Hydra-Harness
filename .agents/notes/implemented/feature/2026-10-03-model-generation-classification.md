# Agent Note: Editable model generation classification

Status: implemented

## Problem

Provider catalogs mix conversation, image, and video models. Unknown aliases require a user correction, and showing every model in every generation selector makes those choices ambiguous.

## Decision

Fetch presents separate Image and Video checkbox columns, initialized from endpoint metadata. A model can carry either role or both. Neither means ordinary conversation use. Classification lives in the existing model `endpoints` field; clearing the final role writes `chat/completions` explicitly so family inference cannot restore it. Saved rows share adapter family inference through the pure LLM endpoint helper when metadata is absent; explicit metadata wins. The model's API protocol continues to own conversation transport. Every provider catalog exposes the same four columns and edits saved roles directly on each row, and Fetch adoption applies an explicitly changed role to an existing model while preserving its other metadata. Select all changes adoption only. Add selected changes the draft; Apply persists it.

Direct DeepSeek and Kiro propagate saved endpoints through their catalogs and reject generation-only conversation requests before I/O. Cursor exposes the editor while unsupported discovery remains disabled. Narrow catalogs move row actions below the inputs.

Settings and the composer filter image/video choices by the corresponding saved endpoint. Provider/model pairs preserve route identity. An existing choice that loses its generation role remains unavailable until explicitly cleared or replaced. This classification supersedes the unfiltered-selector part of the [generation endpoint decision](../architecture/2026-10-02-generative-model-endpoints-and-fallback.md); that note still owns discovery, transport, and rejection-only fallback.

Applying shared image/video preferences publishes the Host's acknowledged namespace to the shared settings mirror before refreshing the Models page. The composer therefore reflects accepted choices without waiting for a pushed invalidation. Failed writes retain the draft and the previous saved selection.

Applying an explicit pi-ai catalog clears shared generation choices referring to model IDs removed or renamed on that route. The catalog replacement and preference unsets share one revision-checked settings mutation, so validation never observes a dangling selection. Choices on other routes and IDs retained in the edited catalog survive. Cancel and rejected writes preserve stored preferences; a rejected edit remains available for retry.

Gemini discovery normalizes `predict` to image generation and `predictLongRunning` to video, and uses known image family metadata for shared `generateContent` methods. Provider method metadata is validated before applying family hints.

## Alternatives considered

**Infer roles solely from model names.** Rejected because aliases may have arbitrary names and explicit user corrections must survive reload.

**Introduce a second classification field.** Rejected because endpoint metadata already propagates through configuration and catalog queries. A parallel field would require precedence rules at every consumer.

**Accept missing pi-ai generation models or clear preferences in a separate write.** Rejected because malformed configuration must still fail at load, and separate writes can clear a valid preference even when the catalog edit is rejected.

## Consequences

Generation lists contain only models marked for their role. A classification describes intended use and does not grant provider access or add missing generation transport. Focused client tests cover both roles, ordinary overrides, existing metadata, and unavailable choices. Keyless assembled Web scenarios cover Fetch, persistence, filtered selectors, reload, both themes, and narrow layouts; live provider entitlement is separate evidence.

Focused deletion checks cover image/video selections, repeated IDs on another provider, renaming, retained IDs, and rejected writes. The assembled Web deletion scenario saves the edited catalog through the real Host and verifies the cleared video selection and retained image selection after reload.

A focused regression holds settings invalidations back and verifies that accepted image/video preferences reach the shared mirror and remain selected after the page refresh. The assembled discovery scenarios verify both selected composer rows before reload.

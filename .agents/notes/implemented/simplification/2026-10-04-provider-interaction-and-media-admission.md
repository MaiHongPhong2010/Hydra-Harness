# Agent Note: Shared authorization callbacks and generated image admission

Status: implemented

## Problem

Native account adapters and the pi-ai plugin translate the same authorization session callbacks. OpenAI and Google image tools also perform the same ordered attachment admission. Duplicated implementations can diverge in cancellation, prompt handling, filenames, or attachment policy.

## Decision

The pi-ai package exports `createPiAiAuthInteraction()` for both login owners. Callers explicitly choose text or secret manual-code prompts, preserving each owner's input visibility. Image tools share a package-internal admission helper that preserves provider order and derives filenames from the validated raster media type. Rendered controls and resolved provider profiles rely on values guaranteed by their owning construction; external responses and durable credentials retain validation.

## Alternatives considered

**Separate implementations.** Keeping duplicate callbacks and image admission repeats the same lifecycle and policy obligations across owners.

**One fixed manual-code prompt kind.** A fixed kind would change the input visibility of one login owner. The explicit argument preserves both behaviors.

## Consequences

Authorization callback changes have one implementation and exercise both prompt kinds. Both image tools continue publishing the same ordered durable references through attachment policy. Tests cover late asynchronous responses after editor closure and provider failures through real transport or SDK callbacks.

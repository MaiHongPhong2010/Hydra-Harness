# Agent Note: Jev bounded consumer enablement

Status: implemented

## Problem

The Jev capability could be enabled with its Models card while no model-facing consumer was mounted by the same toggle. A user had to discover and enable a second plugin before Jev could participate in a task.

## Decision

The base bundle assigns `@hydraharness/harness-browser-decisions` to the `jev` plugin group. Enabling Jev therefore mounts the provider, the Models contribution, and the `browser_decide` tool together after the normal restart. The tool asks Jev to choose among caller-supplied browser-action labels and returns advice only; the browser executor and permission policy remain authoritative.

The independently saved `browser-decisions.enabled` preference defaults to true for this mounted group. Off abstains before a new Jev call while allowing pending requests to complete. It preserves credentials and does not dispose the provider, tool, or UI; the Plugins group remains responsible for mounting and disposal. Its unavailable result is logged by the ordinary tool path, without adding a session event or wire API.

This is the first default consumer for the capability. The main conversation model decides when to call it through the ordinary tool schema, so JEV is used for bounded choices without adding a second request to every model step or changing the `ctx.llm` route.

## Alternatives considered

**Register Jev as a chat adapter.** Rejected because Jev returns structured decisions rather than Hydra conversation streams; the original capability decision is recorded in [the provider note](2026-09-22-jev-decision-plugin-ui-provider.md).

**Invoke Jev automatically on every model request.** Rejected because it adds latency and provider cost even when no discrete decision is needed, and it would require a new logged decision contract.

**Keep the consumer as a separate toggle.** Rejected because enabling the provider without a usable consumer leaves the feature dormant for ordinary Web users.

## Consequences

The Jev toggle now has one safe, visible use in browser-capable compositions. The consumer still abstains when credentials or the provider are unavailable, and all existing browser operations and conversation-model routes retain their prior authority.

## Testing

The assembled Web inventory test verifies that the Jev group includes the browser consumer and persists all three entries for restart. The assembled provider scenario boots the group with the consumer enabled and verifies the saved credential reaches the real `browser_decide` path through the Host.

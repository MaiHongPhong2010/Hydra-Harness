# Agent Note: Account sign-in usage reports

Status: implemented

## Problem

Account sign-in showed only provider-owned labels, so users could not tell which account had available five-hour or weekly capacity before choosing a model.

## Decision

The Host owns a value-free `authorization.usage` RPC. Each registered account flow may fetch a provider report while its credential remains inside the Host credential store. ChatGPT uses the official usage and reset-credit endpoints, preserving provider-reported five-hour, weekly, tier, reset, and banked-reset fields. Antigravity reads quota and tier fields from its Cloud Code Assist responses. The UI renders only fields returned by the provider and shows unavailable when a provider omits them.

## Alternatives considered

- Calculating limits from request history was rejected because local traffic does not represent provider-wide quotas or reset credits.
- Sending access tokens to the browser was rejected because Account sign-in credentials remain Host-owned.

## Consequences

Usage is an explicit per-account refresh, so a provider outage does not block account listing or sign-out. Provider response formats can change; malformed quota fields fail closed to an unavailable report rather than inventing a limit, while an unavailable optional banked-reset endpoint leaves the other usage fields intact.

The account view renders small circular meters beneath its expanded account, with the remaining percentage inside each ring and a short window label below it. Meters wrap within model-family groups. Reset times, full model names, descriptions, and remaining counts appear on hover or keyboard focus and remain available in the accessible description; credit thresholds use the same interaction. Disabled limits show a dash and Disabled instead of a percentage. Banked resets and credit balances occupy compact metadata rows. The [Accounts and Models ownership decision](../architecture/2026-10-11-accounts-models-settings-ownership.md) owns page placement and model navigation.

The [large-pool inventory](2026-10-03-scalable-provider-account-management.md) owns account search, pagination, and demand-based usage loading. Codex meters show provider-reported five-hour and weekly windows; Antigravity groups provider-reported quota-summary buckets by Gemini, Claude/GPT, and other model families. The browser does not manufacture shared windows, credit balances, or overage settings when Antigravity omits them. The assembled account browser replay checks compact report height, keyboard details, and overflow in light/dark themes at wide and narrow widths.

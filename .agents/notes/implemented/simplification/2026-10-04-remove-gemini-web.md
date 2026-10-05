# Agent Note: Remove Gemini web account integration

Status: implemented

## Problem

The consumer web route aims to use an existing Google AI plan for images and videos without API billing, Cloud project setup, or Python. Its browser-session integration requires cookie export and an unofficial protocol. Successful authentication and catalog discovery do not establish media delivery: one authorized live image request reaches generated-media download and receives HTTP 403. The user requests removal of the option.

## Decision

The cookie-import Gemini web integration has no registration, Console helper, worker, or SDK dependency. Its provider-local credentials and media selections are cleared from this user's Harness home without browser sign-out or substitution with a billed API. The separately authorized [managed HTTP provider](../feature/2026-10-05-managed-gemini-web-media.md) supersedes the absence of a consumer route while retaining the isolation and verification requirements below. Google in Account sign-in connects Antigravity directly, without a one-item service selector; saved Gemini API OAuth configurations retain separate editing and shared Google-pool behavior.

This note consolidates the Gemini subscription-media, TypeScript connection, and session-import decisions. Their original motivation remains valid, but reliable consumer-plan media delivery is unverified and does not justify retaining the requested integration.

Generic authorization notices retain bounded clipboard snippets independently of Gemini. The gateway exposes at most 8 KiB, replaces omitted snippets on subsequent notices, and excludes secret answers from public attempts and diagnostics. The UI renders snippet source literally, copies it only on a user gesture, and retains manual copying after clipboard denial. Ordinary provider links continue to use the system browser on Desktop. These reusable behaviors do not discover browser cookies.

## Alternatives considered

**Hide only the option.** Leaves a callable adapter, session credentials, and generation preferences for a route the user has removed. Complete removal avoids this split.

**Replace the session with API or CLI Google login.** API quota belongs to a Cloud project rather than the consumer plan; CLI login does not establish the consumer image/video workflow. Antigravity OAuth authenticates another service. AI Studio web would require a separately verified adapter rather than a URL substitution.

**Keep a cookie connector or Console helper.** Opening the default browser cannot transfer a session by itself. Page JavaScript cannot supply HttpOnly cookies. An explicit extension export avoids implicit browser-database access; a Console helper adds another paste without discovering those cookies. A direct connector adds installation, cookie permissions, a receiver, origin/token admission, and attempt-expiry requirements. None resolves media-download reliability.

## Consequences

Hydra gives up manual consumer Gemini session import. Reintroduction of media requires an explicit product decision and live authentication, catalog, image, video, and download evidence; the managed-provider decision owns that implementation. A maintained TypeScript dependency remains preferable when it supports bounded downloads and no generation retries. Session capture must discard unrelated cookies, validate before replacing a grant, keep account identity and same-session reconnection reliable, and preserve the prior grant on failed replacement. Remote Hosts need an explicit transfer interaction. Cancellation must join owned work before deleting media, and refreshed credentials must not overwrite newer login or removal.

A conversation selector is not a named video engine or entitlement claim. A streaming implementation must retain media for the selected reply across chunks without duplicating downloads; failures must identify their step without exposing cookie values or signed URLs. Uncertain generation failures must not resubmit prompts or fall back to paid API access. Keyless registration and assembled onboarding snapshots preserve the independent Google/API flows; managed-provider snapshots cover its separate account and media paths.

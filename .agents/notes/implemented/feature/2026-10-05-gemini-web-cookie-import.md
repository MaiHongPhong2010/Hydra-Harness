# Agent Note: Explicit Gemini Web cookie import

Status: implemented

## Problem

Google browser authentication can reject the managed login window. A user with an authenticated browser needs an explicit way to transfer that session while preserving the Host's credential ownership and HTTP verification. Page JavaScript cannot export HttpOnly cookies, and a copied Cookie header loses domain and expiry metadata.

## Decision

Gemini Web offers Import Cookies alongside managed-browser Connect through the existing authorization method and secret prompt. The Account sign-in form accepts a JSON file or masked paste, clears its answer after submission, and cancels its owned attempt on close. Files completing after prompt withdrawal or editor close cannot refill another attempt. The authorization answer's existing 64 KiB limit bounds accepted exports.

The Host accepts Google-only Chrome/Edge cookie arrays and Playwright storage-state cookies. Maintained Zod validation and tough-cookie preserve domain, path, HostOnly, Secure, HttpOnly, SameSite and expiry metadata. Cookie-Editor's [JSON formatter](https://github.com/Moustachauve/cookie-editor/blob/master/interface/lib/jsonFormat.js) writes unspecified SameSite as `null`; importing that value retains unspecified SameSite rather than granting SameSite=None. The import form offers a native disclosure with the active-tab export steps; the [user guide](../../../../docs/user/guide/providers.md#import-gemini-web-cookies) owns the complete procedure. Invalid JSON and metadata produce value-free errors. Partitioned cookies are rejected because the HTTP jar cannot preserve their partition identity; importing them as ordinary cookies would broaden their scope. A live Gemini session cookie and HTTP bootstrap are required before committing an account-matched, revision-checked grant. Failed import preserves the previous grant; cancelled or removed attempts cannot restore it. Import never opens a browser or generates media.

This decision partially supersedes the manual-transfer rejection in the [removal note](../simplification/2026-10-04-remove-gemini-web.md) and [managed-provider note](2026-10-05-managed-gemini-web-media.md). Both remain active for HTTP-only media verification, isolation, account ownership, and clipboard behavior. Browser database access, an export extension, Remote Host transfer and multi-account rotation remain outside this change.

## Alternatives considered

**Read personal browser databases or add an export extension.** Requires another permission and lifecycle owner. Explicit JSON transfer works with existing browser export tools and keeps authentication user-controlled.

**Accept a Cookie header or Console export.** Cannot preserve cookie scope and HttpOnly metadata. Complete exports are required, and importing a session does not establish media entitlement or remaining quota.

## Consequences

Users must supply a fresh complete Google export; Google can reject a transferred session. Ordinary browser Connect remains available. Fixture tests cover export validation, account replacement protection, cancellation and secret-free failures; the assembled Web snapshot exercises file import, malformed JSON and failed HTTP validation through the real authorization RPC. Live account compatibility remains a separate provider check.

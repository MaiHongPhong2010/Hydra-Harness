# Agent Note: Managed Gemini Web media over HTTP

Status: implemented

## Problem

Consumer Gemini media uses a browser session and undocumented RPCs. Authentication alone cannot establish image/video delivery, and retrying an uncertain submission can create duplicate work. The [cookie-import removal decision](../simplification/2026-10-04-remove-gemini-web.md) retains its rejection of manual cookie transfer and paid-route substitution; its absence of a consumer provider is superseded by this explicitly authorized implementation.

## Decision

The account-auth plugin owns a separate single-account `gemini-web` grant, managed Edge/Chrome profile, HTTP adapter, and private task records. A normal installed browser serves interactive authentication and closes before HTTP validation, generation, polling, or download. The credential store commits validated grants and serializes revision-checked cookie refresh. Remove and unload abort and join owned operations before profile cleanup. Windows Desktop and Web localhost share this Host implementation; Remote Hosts are outside its scope.

The aliases `gemini-web-image` and `gemini-web-video` declare media endpoints without claiming public API model identity or quota. Generation accepts text, Landscape/Portrait orientation, and up to five validated image references, submits once, and checkpoints conversation/reply ids before downloading. Retrieval remains tied to the stored reply and candidate. The `gemini_web_retrieve` tool reads persisted jobs without submitting prompts and publishes results through ordinary durable attachments. Errors preserve a local job id for recovery; cookies and signed media URLs stay outside transcript and diagnostics. Cancellation describes local work only.

Completed text replies without generated media are failed tasks, independent of response language; a pending video chip remains eligible for polling. The HTTP completion indicator separates refusals and requests for input from work still generating. Terminal failures retain their job id but do not suggest retrieval can produce missing media. The keyless Web reference-refusal scenario pins the failed card and its persistence after reload.

Image summaries record attachment ids and dimensions as model-visible tool text, so later turns can reference generated output without replaying its pixels. The video tool resolves references from the active conversation version and supports `latest` for durable results without an id summary. Provider upload identifiers and bytes remain request-local. Other adapters refuse references before HTTP instead of dropping them.

Live HTTP verification establishes text-prompt image and video delivery with the managed browser closed, fresh-client session reuse, and retrieval of accepted tasks without generation. Fixture verification separately covers framed replies, cookie scope, redirects, download completeness, credential races, and assembled media presentation. Live access remains account-dependent; bootstrap and Fetch do not prove remaining quota.

## Alternatives considered

**Use a billed Google API or browser download fallback.** Violates the requested consumer-session transport and conceals failure of the HTTP implementation.

**Use the existing Gemini Web SDK unchanged.** Its [generation retries and HTTP 206 download loop](https://github.com/Expert-Vision-Software/gemini-web-sdk) conflict with one submission and bounded recovery. The local adapter implements only observed bootstrap, submission, status, and original-image RPCs; maintained `tough-cookie`, Undici, and Playwright supply cookies, HTTP connections, and browser attachment.

**Import personal browser cookies or keep browser automation running.** Adds session-transfer permissions or an unnecessary runtime owner. A separate profile keeps authentication explicit, and HTTP-only media evidence remains independently testable.

## Consequences

Google can change the unofficial protocol or account controls without compatibility guarantees. Unverified Web parameters fail before submission; public API identifiers are not inferred from Web features. A lost response before provider ids arrive can leave an unrecoverable job, and Hydra cannot safely infer whether Google accepted it. No uncertain operation resubmits or switches providers. Private task records survive removal so reconnecting the same account can recover its accepted work; another account cannot retrieve it.

The earlier removal note remains active for its independent clipboard behavior, cookie-import rejection, account isolation, and reintroduction requirements. This partial supersession does not reverse those constraints.

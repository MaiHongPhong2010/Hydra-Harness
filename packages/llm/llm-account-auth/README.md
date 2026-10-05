# @hydraharness/harness-llm-account-auth

Native account authorization for ChatGPT, Google, Claude, xAI, Kimi Code, Cursor, and Kiro. Antigravity and saved Gemini API OAuth routes share one Google OAuth pool. Account sign-in remains separate from API-key routes.

| Route | Sign-in | Model transport |
| --- | --- | --- |
| `chatgpt` | ChatGPT browser OAuth | Native Codex Responses and images |
| `antigravity` | Shared Google OAuth | Cloud Code Assist text, tools, and images |
| `gemini-api` | Shared Google OAuth | Gemini Developer API catalog, text, tools, and Gemini images |
| `gemini-web` | Managed Edge/Chrome profile or cookies JSON | Consumer Gemini Web images and completed MP4 videos over HTTP |
| `claude` | Claude Pro/Max OAuth | Native Anthropic Messages |
| `xai-account` | SuperGrok or X subscription device login | Native xAI chat and image requests |
| `kimi` | Kimi Code device login | Native Kimi Coding Messages |
| `kiro` | AWS Builder ID device login | Native AWS text and tool event streams |
| `cursor` | Cursor browser PKCE login | Account management only; chat and discovery unavailable |

Account pools are resolved when an account operation needs them. Native conversation requests rotate accounts and retry a later account only before visible output. Cancellation stops the operation. Grants stay in the Host credential store; authorization surfaces receive account labels and transient login instructions only.

ChatGPT account profiles accept the pi-ai reasoning, cache, transport, timeout, and retry controls. Session-title calls force the provider's cheapest non-thinking mode where the route supports it. Antigravity uses the same stream-idle timeout setting and omits thinking for title calls; ordinary conversation reasoning remains configurable per request.

Codex Fetch reads the account's conversation catalog, then appends the adapter-supported `gpt-image-1.5` and `gpt-image-2` entries named **GPT Image 1.5** and **GPT Image 2**. These image ids are adapter metadata rather than server-listed account entitlements; Fetch sends no generation probe. Apply retains their `images/generations` metadata for the shared image selector and excludes them from chat selection. Image requests use the selected account's refreshed OAuth token and account id at `/backend-api/codex/images/generations`, preserving Images API controls and replies. The configured `endpoint` replaces `/backend-api` for discovery and images. Account rotation follows explicit HTTP 401/404/429; safety refusals, server errors, cancellation, and uncertain delivery stop. Codex video discovery and generation are unavailable.

Provider performance changes follow the [account request policy and verification requirements](../../../.agents/notes/implemented/feature/2026-09-16-account-model-performance.md), including effective setting propagation and the distinction between SDK tests and live latency evidence.

## Configuration and account setup

Open Settings → **Models** → **Account sign-in** → **Add sign-in provider**, select the provider, and choose **Add account**. Complete its browser or device-code instructions, then repeat for additional accounts. Account labels come from the returned identity, with a stable provider-account fallback when no identity is available.

Choose **Apply** after the accounts are saved. Callable routes enter the model selector, and **Customized settings** can fetch the signed-in account's catalog. Fetch follows Claude and Kiro pagination and preserves generation endpoint hints. xAI additionally reads its native image and video model resources, classifying returned ids by resource rather than name. Every account provider exposes editable Image/Video model roles. Cursor settings show the transport limitation and disable model discovery. Removing an account takes effect on the next request.

Claude, xAI, and Kimi reuse pi-ai's native login, refresh, and streaming implementations under independent Hydra route names. Kiro registers an AWS OIDC public client and retains its client id, secret, region, and refresh token in the Host; expired client registration requires signing in again. Its configurable `region`, `startURL`, and `issuerURL` support AWS regional and IAM Identity Center deployments. The optional `profileArn` must be provider-issued; Hydra never invents one. Native catalogs and streams use the configured `endpoint`, with HTTPS or loopback HTTP only. `loginTimeoutMs` bounds Cursor and Kiro login; `loginPollIntervalMs` controls Cursor polling while Kiro follows AWS's interval and slow-down responses.

Kiro serializes logged system text with the first user message, preserves tool schemas and results, and decodes CRC-validated AWS event frames through Smithy. It supports stream idle and request deadlines, text input, and model context capacity. Output caps, reasoning controls, cache settings, image input, and generation requests are refused. Saved endpoint metadata classifies selector choices; generation-only entries reject conversation before account or network I/O. Unknown metering events do not become guessed usage. Provider-reported account quota is currently available only for ChatGPT and Antigravity; other routes return unavailable.

Native OAuth stores credentials in the Host without a sidecar. Expired Antigravity access tokens refresh during model requests or discovery. Antigravity Fetch reads the available catalog independently of saved selections; conversation catalog queries retain those selections. The [Google editor](../../client/ui-settings-models/README.md) queries both OAuth routes while retaining separate model destinations.

Antigravity image generation uses the shared **Image model** selection and either default image tool. Gemini image families retain `images/generations` metadata through Fetch, saved model rows, and catalog queries; image input support alone does not imply image output. An alias can declare `endpoints: [images/generations]`. The adapter sends a native Cloud Code Assist `streamGenerateContent` request with `requestType: image_gen` and the selected account's project and token, bounds incoming SSE bytes with the tool's response limit, and combines response parts before image admission. It accepts one image request; explicit pixel sizes become equivalent aspect ratios, while OpenAI quality, background, and format controls have no native equivalent. A native-host HTTP 404 tries the next host; account HTTP 401/404/429 tries the next account. Cancellation, lost responses, safety refusals, and server failures stop without another generation. The tool validates the returned image bytes before publishing durable references.

The **Account sign-in** list can request provider-reported usage for each account. ChatGPT reports its five-hour and weekly windows plus any banked reset credits when the official usage endpoints return them; Antigravity first reads the Cloud Code Assist quota summary for grouped buckets, reset times, remaining counts, disabled states, and tier credit balances, then falls back to the model catalog when that summary is unavailable. Missing provider fields remain unavailable instead of being guessed, and credentials stay in the Host.

## Gemini Web

Gemini Web supports Windows Desktop and Web localhost on the same Host, one Google account, and one media operation at a time. Connect and Reconnect launch an installed Edge browser with a separate profile under `<Harness home>/gemini-web/profile`; `geminiWeb.browser: chrome` selects installed Chrome. The browser closes before HTTP session validation. Only a successful validation replaces the independent `llm-account-auth/gemini-web` credential grant. Failed reconnection retains the previous grant; cookie refresh cannot overwrite a newer login or restore a removed account. Remove aborts and joins owned work before clearing the grant and managed profile; it does not sign out a personal browser.

**Import Cookies** accepts a Google-only Chrome/Edge cookie JSON array or Playwright storage state containing `cookies`, up to 64 KiB. In Models → Account sign-in → Gemini Web, choose this sign-in method, start Import Cookies, select a JSON file or paste JSON into the masked field, then Continue. Each cookie needs `name`, `value`, `domain`, `path`, `secure` and `httpOnly`; exports retain `hostOnly`, `sameSite`, and `expirationDate` or `expires` when supplied. A usable `__Secure-1PSID` cookie is required. Partitioned cookies and non-Google domains are rejected. Import opens no browser and sends no generation request. HTTP bootstrap verifies the account before a revision-checked commit; invalid exports, expired sessions, account mismatch, cancellation and concurrent removal retain or leave removed the prior grant. Importing a different account requires Remove first. Cookies pass transiently through the authorization answer RPC and stay outside public attempts, diagnostics and session logs. The [import decision](../../../.agents/notes/implemented/feature/2026-10-05-gemini-web-cookie-import.md) owns these restrictions.

Fetch validates the saved session and lists the adapter aliases `gemini-web-image` and `gemini-web-video`. Their endpoint metadata enables the shared media selectors. These are Web routes, not public Gemini API model ids; listing them does not establish quota or account entitlement. Text prompts use Gemini Web defaults. Video accepts Landscape (`1280x720`) or Portrait (`720x1280`) orientation and up to five decoded PNG/JPEG/WebP/GIF references through domain-scoped HTTP uploads. Orientation does not request an exact resolution; duration uses the Web default. Reference byte and count limits follow attachment policy. Chat, video references, and unverified duration, quality, or background controls are refused. AI Studio and Remote Hosts are outside this provider's scope. The [configuration catalog](../../../docs/config-catalog.md#hydraharness-llm-account-auth) owns login/request deadlines and polling defaults.

Generation submits once. Bootstrap supplies the upload Push-ID; each reference uses one resumable start and one final upload to the observed Google upload host. Invalid upload URLs, byte limits, and upload errors stop before generation. A completed text reply without generated media ends with `NO_GENERATED_MEDIA` regardless of language; a pending video chip keeps polling. The observed English video quota refusal ends with `QUOTA_EXHAUSTED`. Both failures record `failed` and report that the task has no media to retrieve. HTTP parses framed replies, polls the saved conversation/reply, resolves original image links, and downloads bounded media with domain-scoped cookies. Complete HTTP 206 responses require a matching `Content-Range`; partial ranges fail without download loops. Cancellation stops local polling or download and does not claim to cancel Google's processing. A failure after checkpointing returns `jobId`; [`gemini_web_retrieve`](../../media/tool-media/README.md) reads that saved task after restart or Reconnect without sending another prompt. Private job records contain account hashes and task ids, excluding cookies and signed URLs. Uncertain delivery never switches to a billed API or browser download. The [decision record](../../../.agents/notes/implemented/feature/2026-10-05-managed-gemini-web-media.md) explains the HTTP-only requirement.

The [cookie-copy guide](../../../docs/user/guide/providers.md#import-gemini-web-cookies) describes exporting the active Gemini tab with Cookie-Editor and importing it into Hydra. An export's `sameSite: null` means unspecified, matching Cookie-Editor's JSON representation; it does not become SameSite=None.

The diagnostic `pnpm run gemini-web:probe login` uses a separate research profile and private files under `<Harness home>/research/gemini-web`; `bootstrap` checks that saved session, `generate image|video` submits one diagnostic task, and `retrieve image|video <jobId>` recovers it. Research grants do not configure a product account.

## Model Experience

### Provider request

#### What the model sees

The selected `model` receives the assembled system prompt, message history, tool schemas, and request controls. The account adapter adds no prompt prose; provider replay metadata is removed from every account-backed request so account rotation cannot reuse opaque state.

#### Token effect

Provider tokenization determines exact input and output usage. A failed account attempt is buffered until visible output begins, so discarded failures do not become model-visible history or token usage in the assembled response.

#### KV Cache effect

An unchanged assembled prefix can remain eligible for provider cache reuse. Rotating accounts or changing provider credentials may select a different provider cache, and account-specific replay metadata is therefore omitted from the next request.

### Provider response

#### What the model sees

Provider streams become Harness text, reasoning, tool-call, usage, and finish chunks. The adapter exposes only the first successful account attempt's visible output; an earlier failure with no visible output is discarded before failover.

#### Token effect

The provider's streamed usage is preserved when available. Response blocks enter later model context only after the session records the completed assistant message.

#### KV Cache effect

Recorded response content appends to the next request. Account-backed requests drop provider replay data so one account cannot reuse another account's opaque metadata, including when the next request happens to select the same account.

## Known Limitations and Deferred Work

Google OAuth opens the sign-in link before asking for service-specific information. The default `oauth` method connects Antigravity without asking for a Cloud project; Code Assist supplies its project during onboarding. The `gemini-api` method additionally asks for an API quota project and checks authenticated Gemini `models.list` before storing its grant. Both use the Antigravity PKCE flow with `cloud-platform` scope and the shared `llm-account-auth/antigravity` pool. They share removal, rotation, and serialized refresh; `projectId` identifies Code Assist and `quotaProjectId` supplies Gemini's `x-goog-user-project` header. API quota and billing belong to that Cloud project. Existing Antigravity grants require reconnecting with the `gemini-api` method before API requests can use them. Gemini conversation uses the official OpenAI-compatible endpoint with bearer OAuth, while Gemini image models use native `generateContent`. Imagen and Veo generation are unavailable through this API adapter.

- **Live provider compatibility depends on account entitlement** — focused fixtures establish wiring; real sign-in, quota, and entitled model access require separate live verification.
- **Cursor has no model transport** — its PKCE login and account storage are implemented; native Connect/protobuf chat and model discovery remain deferred.
- **Video is submission-only** — xAI requests can submit a generation job through the media seam; polling, downloading, and a video tool are separate consumers.
- **Refresh is request-scoped** — expired OAuth grants refresh during account operations.

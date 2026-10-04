# @hydraharness/harness-llm-pi-ai

Generic multi-provider adapter for the harness LLM seam backed by [`@earendil-works/pi-ai`](https://www.npmjs.com/package/@earendil-works/pi-ai). One plugin instance owns a dict of provider profiles keyed by route; every request selects a profile with `GenerateOptions.provider` and resolves `GenerateOptions.model` against that route's configured catalog. A route naming an installed pi-ai provider inherits its endpoint, wire protocol, and model catalog as defaults and overrides them field by field; a route pi-ai does not ship is declared outright, so an OpenAI-compatible gateway, a self-hosted server, or a provider newer than the installed catalog is configuration rather than a code change.

The package root exposes the Cordis plugin contract, `PiAiAdapter`, `supportedProtocols()`, and `resolveProfiles()` for native account composition. `createPiAiAuthInteraction()` translates an authorization session into pi-ai login callbacks; callers choose whether pasted manual codes use a text or secret prompt. Catalog materialization, provider construction, replay conversion, and stream conversion remain package-internal.

Profiles accept `apiKeyFallbackEnvs`, ordered credential references after `apiKeyEnv`. Keys stay in the credentials provider. Missing, malformed, rejected, or failed keys advance to the next choice; cancellation stops the sequence. With `llm-retry` mounted, conversation output streams normally and each failure retries through agent recovery. After the last key fails, ordinary retry policy applies to that key. Direct calls with multiple keys buffer each attempt to expose only one response; single-key calls keep streaming.

## Config

Configure credentials, the model catalog, and deployment-specific transport settings per provider, keyed by the provider route itself. Each profile may set a `retryPolicy`; omission uses normal mode with five retries. `apiKeyEnv` is a credential *reference* resolved per request, so no secret enters this file. Omitting both credential fields leaves the route unauthenticated, which for an installed catalog route means pi-ai's provider-native ambient discovery; a configured reference that resolves to nothing fails the request with `MISSING_CREDENTIAL` instead, because falling through would authenticate with whatever unrelated key the environment happens to hold. The ordered credentials serve every model on the route.

```yaml
- id: llm
  name: '@hydraharness/harness-llm-pi-ai'
  config:
    providers:
      # Catalog route: endpoint, protocol, and models all come from pi-ai.
      openai:
        apiKeyEnv: OPENAI_API_KEY
        baseURL: https://proxy.example.com:8443
        proxy: http://127.0.0.1:3128 # optional HTTP(S) forwarding proxy for this route only
        reasoning: high
        retryPolicy:
          mode: normal
          maxRetries: 3
          backoff:
            initialDelayMs: 500
            maxDelayMs: 10000
            jitterRatio: 0.1
      # Catalog route with its catalog narrowed to one model and that model's
      # capacity corrected; every unset field still comes from the catalog.
      anthropic:
        apiKeyEnv: ANTHROPIC_API_KEY
        streamIdleTimeoutMs: 300000
        models:
          - id: claude-sonnet-4-5
            contextWindow: 200000
      # Catalog route with one model reshaped in place; the rest of the
      # catalog keeps serving (a models list would replace it instead).
      deepseek:
        apiKeyEnv: DEEPSEEK_API_KEY
        modelOverrides:
          deepseek-v4-pro:
            reasoningEfforts:
              off:
              high: high
      # Hand-declared route: pi-ai ships nothing under this key, so the profile
      # supplies the whole provider.
      acme-gateway:
        displayName: Acme Gateway
        apiKeyEnv: ACME_GATEWAY_API_KEY
        api: openai-completions
        baseURL: https://gateway.acme.example/v1
        # Request shape for an endpoint whose URL pi-ai cannot recognize; it
        # would otherwise be addressed as though it were OpenAI itself.
        compat:
          thinkingFormat: deepseek
          supportsDeveloperRole: false
          maxTokensField: max_tokens
        models:
          - id: acme-large
            name: Acme Large
            contextWindow: 65536
            maxTokens: 4096
          - id: acme-think
            name: Acme Think
            contextWindow: 131072
            maxTokens: 16384
            # key = selectable level, value = its wire spelling; only off may
            # leave the value empty (supported, send nothing).
            reasoningEfforts:
              off:
              high: high
              max: ultra
      # Azure OpenAI deployments behind a gateway that authenticates with
      # `Authorization: Bearer` rather than Azure's own `api-key` header (set
      # AZURE_OPENAI_API_VERSION separately; it is process-wide, not per-route).
      # Model id = the gateway's deployment name, sent as both the URL segment
      # and the request body's `model` field.
      azure-gateway:
        displayName: Azure OpenAI gateway
        apiKeyEnv: AZURE_OPENAI_API_KEY
        api: azure-openai-completions
        baseURL: https://example.openai.azure.com/openai
        models:
          - id: gpt-5-2025-08-07
            name: GPT-5
            contextWindow: 400000
            maxTokens: 128000
          - id: gpt-5-mini-2025-08-07
            name: GPT-5 mini
            contextWindow: 400000
            maxTokens: 128000
      # A gateway path that already speaks plain OpenAI Chat Completions once
      # the deployment name is baked into baseURL, rather than into the URL at
      # request time: no api-version, so the unmodified `openai-completions`
      # protocol reaches it. One route per model, since baseURL is per-route.
      # The model id is this gateway's expected request-body `model` value,
      # which may differ from the URL's bare deployment segment (baked above).
      azure-gateway-gemini-2.5-flash:
        displayName: Gemini 2.5 Flash (Azure OpenAI gateway)
        apiKeyEnv: AZURE_OPENAI_API_KEY
        api: openai-completions
        baseURL: https://example.openai.azure.com/openai/deployments/gemini-2.5-flash
        models:
          - id: google/gemini-2.5-flash
            contextWindow: 1048576
            maxTokens: 65536
```

The dict shape makes duplicate routes unrepresentable, and the pre-release array shape (with per-profile `provider` fields) fails load with migration directions. `providers` may also be empty or omitted entirely: the adapter then mounts **dormant** — zero routes, no extra catalog entries — and registers routes the moment the `llm-pi-ai:` settings section supplies profiles, dropping them again when it empties. Dormant or not, the plugin declares every installed catalog provider in the configurable-provider directory (`ctx.llm.listConfigurableProviders()`, settings path `providers.<provider>`), joined with every route the current profiles declare, so configuration surfaces can offer the full catalog before any route exists and can still address a hand-declared one. Each entry carries `declared`: whether pi-ai ships nothing under that key. It follows the installed catalog, never the settings document, because narrowing a shipped provider's models stores a profile too and that route is still one pi-ai knows — only the adapter can tell the two apart, which is why the directory answers rather than leaving a surface to infer it. Which adapters exist is composition; which providers run can be entirely the user's settings document. Registration with `ctx.llm` is atomic: a collision with any provider route already owned by another adapter fails plugin loading without registering the remaining routes. Model ids are not lifecycle config; a model the route does not configure fails before any provider request with `LlmError('UNKNOWN_MODEL')`.

## Catalog resolution

Image generation uses the configured route's credentials, headers, and network proxy, including resolved OAuth authentication supplied by an account adapter. xAI image families use their JSON Images API with inline output; returned PNG, JPEG, or WebP bytes retain their actual MIME type for image admission. xAI video models submit JSON to `videos/generations`, translating seconds and size into duration and aspect ratio; explicit polling downloads the completed video without another submission. Native Gemini uses `generateContent`; Gemini image models behind OpenAI-compatible gateways use non-streaming Chat Completions with image/text modalities. An unknown proxy alias can declare both `images/generations` and `chat/completions` endpoints to select that transport. Explicit pixel sizes become equivalent aspect ratios for both Gemini paths. Other OpenAI-compatible image models use the Images API. Listing or selecting a model does not establish account entitlement or quota.

Model entries accept `endpoints`, relative API paths such as `chat/completions`, `responses`, `images/generations`, `images/edits`, or `videos`. Fetch preserves gateway `supported_endpoints`, `supported_endpoint_types`, or `endpoints` metadata and normalizes a leading `/v1/`. Without metadata, known OpenAI and Grok image, Sora and Grok video, embedding, audio, and moderation families receive dedicated endpoint hints; other ids remain unknown. Gemini discovery maps native prediction methods to image/video endpoints and uses known image-family hints for shared generateContent methods. Explicit endpoint configuration wins over family hints. Dedicated media entries on a provider mixing OpenAI conversation APIs receive the generation transport independently of its text models. Discovery makes only model-list GETs, never a billable generation probe; a listing or inferred endpoint does not establish account access.

Generation uses the saved route base URL, proxy, headers, and credential references independently of the conversation model. Top-level `imageModel` and `videoModel` fields store `{ provider, model }` choices shared by all adapters, read live through the LLM preference registration. A selected pi-ai model must exist in its route catalog and receives the generation endpoint even when listing metadata is absent; preferences for another adapter are resolved when generation runs. The Models page and composer menu edit these same fields. OpenAI-compatible images use JSON; compatible video submissions use multipart fields; native Veo uses JSON `predictLongRunning`. An explicit `pollIntervalMs` polls the accepted job and returns a completed video stream. Omission returns the accepted job reply. Native Gemini images use `models/{id}:generateContent`, `x-goog-api-key`, and image response modalities; one request supports one image, and the tool preserves the returned raster format. Keys are tried before changing models, only for missing credentials or HTTP 401/404/429. Accepted jobs and ambiguous failures are not resubmitted. Dedicated generation models are omitted from conversation pickers and refused before conversation I/O. The [media plugin](../../media/tool-media/README.md) bounds polling, download, and durable chat playback. Video status and download stay on the accepted route; credentials never accompany a download to a different origin. Signed downloads may redirect only to the provider delivery hosts.

A profile's `models` list *replaces* the route's installed catalog rather than extending it; omitting it (or leaving it empty) serves that catalog unchanged. Each entry defaults its unset fields from the installed model of the same `id`, so narrowing a catalog route to two models, correcting one capacity, or adding a model newer than the installed catalog are all one-line edits — but declaring any `models` list means every model the route should keep serving must appear in it, an entry of nothing but `id` being enough. The configurable entry fields are `id`, `name`, `endpoints`, `contextWindow`, `maxTokens`, `reasoningEfforts`, and `compat`. Pricing and input modalities have no harness consumer and ride the installed entry or are absent.

`modelOverrides` reshapes individual installed-catalog models without that cost: each key is a catalog model id, each value the same fields a `models` entry takes with the id living in the key, and the rest of the catalog keeps serving untouched — "correct one model, keep the other thirty-seven" as a three-line edit. An override becomes that catalog entry's configuration, so capacities, efforts, and compat resolve through the same path with the same diagnostics and the same request-default semantics as a `models` entry. Overrides are only meaningful on a catalog route serving its catalog: one set beside a `models` list (which already replaces the catalog), on a hand-declared route (whose models are fully spelled in `models`), or naming a model the catalog does not describe is refused rather than skipped, because a silently unchanged model is a typo someone would otherwise hunt for.

### Per-model reasoning efforts

`reasoningEfforts` declares a model's selectable thinking levels: each key is a level selectors offer, its value the spelling dispatch sends on the wire, so `high: high` passes the canonical name through while `max: ultra` renames it for a gateway with its own vocabulary. Keys come from pi-ai's level set (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`); a level not declared is not offered. Omitting the field keeps the installed catalog entry's capability (a hand-declared model has none and does not reason); `false` declares a non-reasoning model, which is how a profile strips reasoning from a catalog model its gateway cannot serve; an empty declaration is refused rather than guessing between those two meanings.

The declaration translates to pi-ai's `Model.reasoning` + `thinkingLevelMap` with every level decided explicitly — undeclared levels are pinned unsupported rather than left to pi-ai's own defaulting, which is asymmetric (an absent key means "supported" for the five base levels but "unsupported" for `xhigh`/`max`) and which a profile author should not need to know. `off` is the one three-state key: left out, selectors offer no Off and an explicit Off request is refused — a request naming no effort still goes out without the parameter, so what the provider then does is its own default; declared with no value (`off:`), Off is offered and selecting it sends nothing — for the `deepseek` dialect an explicit `thinking: {type: "disabled"}` — which also covers a request naming no effort at all; declared with a value (`off: none`), that value goes on the wire as the effort parameter. There is no spelling for restoring a catalog map key to "unset": the declaration is the whole offer, so restate the catalog levels you keep.

### Wire-compatibility switches

pi-ai shapes each request from the provider id and baseURL: which role carries the system prompt, which field caps output, how a thinking level travels. A private gateway's URL says nothing, and for an endpoint pi-ai does not recognize the detection answers as though it were OpenAI itself — a reasoning model's system prompt goes out as `developer`, the output cap as `max_completion_tokens`, the thinking level as a bare `reasoning_effort` — and most OpenAI-compatible gateways reject at least one of those. `compat` is therefore configurable on the route (its models' default) and per model (winning per field), resolving model → route → installed catalog entry → pi-ai's own detection; a route-level switch shadows the catalog entry's value for every model that reads it, and there is no spelling for handing a field back to the catalog short of restating its value.

Each switch belongs to the protocols whose pi-ai compat type declares it, and grouping follows the compat *type* rather than the protocol name: the three Responses protocols (`openai-responses`, `azure-openai-responses`, `openai-codex-responses`) share one compat type, so a switch settable on one is settable on all three. `supportsDeveloperRole` is settable on `openai-completions` and on those three; `thinkingFormat` only on `openai-completions`; `supportsTemperature` only on `anthropic-messages`; `supportsStrictMode` also reaches `bedrock-converse-stream`. A model-level switch its protocol does not take fails resolution naming what that protocol does offer; a route-level one lands on the models that read it and skips the rest, and is refused only when no model on the route could read it at all.

Three kinds of key are refused rather than dropped: one no protocol declares (a misspelling), one pi-ai's installed catalog owns for a named vendor (`openRouterRouting`, `zaiToolStream`, `deferredToolsMode`, `sessionAffinityFormat`, `supportsOpenAIGrammarTools`, `supportsToolSearch`, `supportsExplicitPromptCacheMode`, `supportsToolReferences`, `vercelGatewayRouting`, `sendSessionAffinityHeaders`) — a route needing a vendor's own switch is a catalog route that should be named as such — and one written with no value at all (`supportsDeveloperRole:`), which schemastery passes through as null and which would otherwise replace the installed catalog's value with nothing. The offered set is pinned to pi-ai's four compat types by drift gates, the protocols carrying them are derived from `Model.compat` itself, and each field's type is derived from upstream rather than restated, so an upgrade that adds a field, gives a further protocol a compat type, or widens a value union fails the build until someone classifies it.

A model neither the entry nor the installed catalog sizes takes the route's `defaultContextWindow` and `defaultMaxTokens` (both 131,072). These assumptions are configurable per route; deployments must choose capacities their gateway supports when exact metadata is unavailable. Without a configured model or request cap, OpenAI and Google APIs receive no output-cap field, leaving the provider's maximum in control. APIs requiring a cap retain pi-ai's model capacity and context fitting.

Request modalities resolve entry `input` → installed catalog entry → route `defaultInput` (default `[text]`), the same order and the same fallback role the capacities above use. So a catalog model keeps the modalities the catalog records for it, and a narrower route default never strips them; a gateway whose *undescribed* models all take images declares `[text, image]` once at the route instead of on every entry. An entry's empty list means the same as an absent one — it describes a model accepting nothing, so it states no answer and resolution continues past it, which is what keeps a catalog model's own modalities when a `models` entry names it without declaring any. The route's may not be empty, since nothing sits below it to answer instead.

`[text]` is the absence of a declaration rather than a guess at the endpoint, which is why the fallback here is conservative where the capacity fallbacks are merely plausible. Nothing interrogates a gateway for what it accepts, and the two wrong answers do not cost the same: the harness refuses an image before it is attached when a model's modalities omit one, so under-claiming costs a refusal naming the model, while over-claiming admits an image the provider then rejects mid-turn — after the message is durable, which leaves the session repeating a request that cannot succeed.

Resolution still fails loud, naming the offending route and model, when a route cannot be served at all: a route the catalog does not ship needs `api`, `baseURL`, and a non-empty `models` list of uniquely-identified models. That resolution runs inside the section schema, so an unserviceable profile is refused **where it is written** — `settings.mutate` answers `settings-rejected` naming the route and model — rather than being stored and then quietly disabling every route in the namespace. The settings seam keeps a namespace's last good value for an already-stored section that fails, so this cannot strand a deployment. `api` accepts the protocols in `supportedProtocols()` and is only needed when the catalog cannot supply one: a model absent from the catalog inherits the protocol its shipped siblings agree on, so adding a model to a single-protocol catalog route restates nothing.

`baseURL` sets the endpoint of every model on the route, so private gateway endpoints such as `https://gateway.example.com:8443` remain supported; a catalog route that omits it keeps each catalog model's own endpoint. Naming `api` on a catalog route repoints the whole route at that protocol, which is how a deployment moves a provider between, say, Responses and Chat Completions.

`proxy` identifies an optional `http:` or `https:` forwarding proxy. An absent or blank value connects directly to the endpoint. It applies to normal requests and endpoint interrogation for only that route, without changing the process environment or another route's traffic.

`supportedProtocols()` is deliberately narrower than pi-ai's full streaming API set: it holds only the protocols a profile can *completely* describe with a key, an endpoint, and headers. Bedrock signs with SigV4 over AWS credentials and a region, Vertex needs a project, a location, and application-default credentials, and Codex authenticates through OAuth — offering those would hand back a route that cannot authenticate. Catalog routes still reach them through their own provider; only an explicit override is refused.

`azure-openai-completions` is the one Azure-shaped exception: it reaches a locally patched pi-ai build (see `patches/@earendil-works__pi-ai@0.82.1.patch`) that sends `Authorization: Bearer` and a deployment-path endpoint instead of pi-ai's own `api-key`-header Azure Responses implementation. It still needs an api-version, which is process-wide rather than per-route: set the `AZURE_OPENAI_API_VERSION` environment variable to the value the gateway expects. A route naming this protocol sends each model's `id` as both the URL's deployment segment and the request body's `model` field, so the model id must equal the gateway's deployment name.

## Dynamic configuration (settings + credentials)

The adapter reads its profiles through a thunk **once per operation** instead of freezing them at construction. The plugin registers the `llm-pi-ai` namespace on the optional `ctx.settings` seam with this same `Config` schema and its `cordis.yml` entry as the composition `base`, and because `providers` is a dict, the base and the user's `llm-pi-ai:` settings section merge **per provider**: a user can add a route, override one field of a composition route, or change a route's endpoint or HTTP(S) proxy, all effective on the next request with no restart. Without a mounted settings service the entry config alone drives the adapter, unchanged.

Credentials resolve per stream call through `apiKeyEnv` and the optional `ctx.credentials` seam; without that seam, the adapter reads exactly the referenced environment variable. A profile naming no credential at all — and only that case — defers to pi-ai's ambient discovery. Every resolved key is trimmed and format-checked before use, so a value no HTTP header can carry is refused instead of surfacing as an opaque `fetch` `TypeError`; the refusal throws `LlmError('INVALID_CREDENTIAL')` naming the failing route and credential reference but never any part of the key. The route set and each route's captured retry policy are the registration-level facts: when either changes, the plugin replaces its registration atomically (same adapter instance, candidate set validated first), so a route another adapter already owns leaves the previous routes serving and reverting to a working configuration re-applies. Provider key order never counts as a change. A section this adapter could not serve is refused where it is written — the registered `validate` resolves the whole profile set, so `ctx.settings.mutate` rejects with the resolver's own error (the wire surface reports it as `settings-rejected`) and nothing is stored. A stored section that becomes unserviceable some other way — an external edit of `settings.yaml` — keeps the namespace's last good value at the settings seam and warns. The entry config itself still fails plugin load, and a route the llm registry refuses (one another adapter family already owns) is logged while the previously registered routes keep serving.

The adapter exposes each configured route's models through `ctx.llm.listModels(provider)`. This is provider-neutral selector metadata read from the same pi-ai `Models` collection the request path uses, so discovery does not create a second model registry. `ctx.llm.resolveModelInfo(provider, model)` performs that exact descriptor lookup once and returns its identity, context window, configured output cap, and selectable thinking levels, keeping authoritative metadata on the route-owning adapter rather than its consumers. A model's **configured** `maxTokens` becomes the seam's `defaultMaxTokens`, so a request that names no output cap carries the one the deployment chose; a value inherited from the installed catalog is the model's output *capability* and never becomes a request default on its own.

A model that carries reasoning metadata — from the installed catalog or from its entry's `reasoningEfforts` — exposes pi-ai's ordered `getSupportedThinkingLevels(model)` result without filtering or normalization, including `off` and the model-specific availability of `xhigh` or `max`. The Harness exposes each canonical pi-ai level as an opaque ID; provider/model wire spellings remain inside pi-ai's `thinkingLevelMap`.

A model **without** that metadata — a hand-declared one whose entry declares no `reasoningEfforts`, and a catalog model pi-ai marks as non-reasoning — exposes no `reasoning` at all. pi-ai reports such a model as supporting the single level `off`, but `off` is translated to *omitting* the reasoning option, which is byte-for-byte the request that naming no effort already produces: selecting it could not disable anything, so a provider whose own default is to think would keep thinking with `off` shown as selected. Reporting the capability as unavailable leaves a surface offering the provider's default and nothing that misrepresents it. The profile `reasoning` value, including `off`, is the deployment default when configured; omitting it preserves the provider default. Per-request `GenerateOptions.reasoningEffort` takes precedence, and a level absent from the exact model capability fails the REQUEST with `UNSUPPORTED_REASONING_EFFORT` before network I/O instead of being clamped. Describing a model never fails that way: the models under one provider disagree about which levels they accept, so `resolveModel` reports a profile level the exact model cannot take as no default at all rather than throwing. A throw there would take the whole provider out of every model catalog built over it — one mis-set profile field hiding even the models that do support the level — so a bad configuration surfaces where it is acted on, not where it is described. pi-ai's common stream options represent `off` by omitting `reasoning`.

Supported profile fields are `apiKeyEnv`, `apiKeyFallbackEnvs`, `displayName`, `api`, `baseURL`, `proxy`, `models`, `modelOverrides`, `compat`, `defaultContextWindow`, `defaultMaxTokens`, `defaultInput`, `headers`, `reasoning`, `thinkingBudgets`, `cacheRetention`, `transport`, `timeoutMs`, `websocketConnectTimeoutMs`, `streamIdleTimeoutMs`, `maxRequestImageBytes`, and `retryPolicy`. Each resolved profile retry policy is captured with that provider route; omission uses the shared bounded normal default of five retries. The stream-idle interval is a positive finite Node timer delay, defaults to five minutes, and covers only an outstanding provider read, not consumer think time. `maxRequestImageBytes` bounds one request's base64-encoded image payload (default 20MiB, a positive integer): every image in history is re-encoded into every request, so when the accumulated payload exceeds the bound, the oldest images are replaced by a fixed text placeholder until the request fits, keeping an image-heavy session serviceable instead of permanently rejected by a gateway request-size cap. The default leaves capacity for system prompts, history, tools, and JSON; deployments behind stricter gateways lower it per route. Harness app attribution wins a conflicting configured header name.

The adapter forces pi-ai's SDK `maxRetries` to zero so one `stream()` call makes one provider request. The removed profile fields `maxRetries` and `maxRetryDelayMs` fail load instead of silently multiplying or hiding the separately composed agent-level retry budget. Idle expiry aborts the SDK's stable request signal and surfaces `TIMEOUT`; an earlier caller abort remains `ABORTED`.

## Endpoint interrogation

The plugin offers `ctx.llm.registerModelDiscovery('llm-pi-ai', …)`, which answers "which models can this provider serve?" for a route a configuration surface is editing or drafting. It is deliberately *not* a catalog refresh: nothing is stored, and the reply is candidates the surface offers for adoption. `settings.yaml` remains the only thing that decides what a route serves.

Fetch always reads the live provider listing. An omitted endpoint or protocol inherits the saved profile, then the installed provider's transport defaults; the installed model list is never returned as a fetched result. An unreachable or unsupported listing reports its failure and leaves the current draft intact. A route the catalog does not describe must provide an endpoint.

A draft's typed credential wins over saved keys. Otherwise discovery resolves the route's ordered credential references, or its provider-native authentication when no reference is configured. Missing named credentials fail before network I/O. Probe keys are trimmed and format-checked; unusable header values report `INVALID_CREDENTIAL`.

Interrogation reads OpenAI-compatible `GET /models` listings with bearer auth and native Gemini listings with `x-goog-api-key`. Gemini follows every `nextPageToken` and retains all returned ids and supported methods. The default xAI endpoint also reads `image-generation-models` and `video-generation-models`, merging ids and assigning their resource's endpoint without guessing from names. A custom gateway uses its own `/models` listing. Azure requires distinct authentication and an API version; Codex uses OAuth. Other protocols answer `DISCOVERY_UNSUPPORTED` and retain hand-entry. The `baseURL` preserves deployment prefixes such as `https://gateway.example/openai/v1`, and the draft's optional `proxy` applies to listing requests.

Most listings disclose an id and nothing else; `context_window`/`context_length` and `max_output_tokens`/`max_tokens` are read when a gateway supplies them, entries without a usable id are skipped rather than failing the whole listing, and everything else the adopting surface still owes. The reply is read under a four-megabyte ceiling enforced on the bytes actually received — the endpoint is a URL the user typed, so a declared length is checked first but never trusted as the bound. An unreachable endpoint, a refused credential, a non-JSON body, and a body with no `data` array all fail with `DISCOVERY_FAILED` and a message naming the endpoint and, for a 401 or 403 alone, the credential. Cancellation during the body read surfaces as `ABORTED`, like a cancellation before the request went out.

## Provider/model routing and replay

Each resolution produces one **immutable** snapshot — the profiles plus a `createModels()` collection holding the `Provider` each route built — and every operation captures a whole snapshot before its first `await`. A configuration change builds a *new* collection rather than mutating the one in use: `Models.streamSimple()` resolves its provider lazily, when the stream is first consumed, which is after the credential await, so a mutated collection would let a request that started under one configuration finish under another or fail on a provider that no longer exists. This is what makes the seam's per-step call freeze (`llm.prepareCall()`) hold end to end — switching models mid-reply takes effect on the next step, never inside the one in flight. Requests reach their provider through `Models.streamSimple()`. A catalog route that keeps its catalog protocol **reuses** the installed provider with its model list replaced, because that provider owns API implementations this package cannot reconstruct — Bedrock loads its Smithy module through a separate entry point — so rebuilding it from parts would silently narrow which providers work. Every other route is built by `createProvider()` over the protocol table behind `supportedProtocols()`, whose entries are the same factories pi-ai's own provider factories use.

A route's `apiKeyEnv` key still resolves through the harness seam before the request reaches pi-ai and rides as the request's `apiKey` option, which pi-ai treats as the highest-priority auth override — the fail-loud reference semantics stay the harness's. Beneath that override the collection carries this plugin's credential store and ambient auth context: a stored sign-in (an OAuth grant, or a key typed into pi-ai's own login prompt) authenticates its route through them and refreshes itself under the store's cross-process lock. The store addresses records as `llm-pi-ai/<provider id>`, and a hand-declared route key outside that record grammar (uppercase, dots, underscores) reads as holding nothing stored rather than as an addressing error; such a route cannot be signed into — a record write for it refuses with `LlmError('UNSTORABLE_PROVIDER_ID')` — and authenticates through `apiKeyEnv` or ambient provider settings. A route naming no credential at all resolves as configured-but-keyless and leaves the requirement to the protocol, which is where it actually lives.

The selected model descriptor supplies the protocol implementation. This includes native API differences such as OpenAI models whose descriptor uses the Responses API rather than Chat Completions; the harness adapter does not hardcode endpoint selection by model name.

Successful assistant responses store a versioned, lossless-JSON replay state beside the provider and model that produced them, as a `ReplayEnvelope`: a response-level half (kind, version, API, route, response ids, native stop reason) plus one per-block entry per streamed block carrying that block's signatures. The per-block alignment is what `BlockAssembler` prunes when assembly drops a block (a `max-tokens` tool call), so the stored entries always describe the stored content — the retained blocks keep their signatures. At request time, `LlmRuntime` passes replay state only when the historical provider route and target provider route are currently owned by this same `PiAiAdapter` instance. The adapter validates the state and restores pi-ai response ids and provider signatures even when the target provider or model changes; pi-ai then decides which metadata its target API can reuse. History without replay state is translated as foreign provider-neutral content and never impersonates a native pi-ai response.

Durable content is the authoritative record; replay state only restores native fidelity. A stored state this build cannot use — another adapter's kind, another version (including the flat pre-envelope form older logs carry), malformed metadata, provider/model mismatches between the message and replay state, or content/block mismatches — degrades that one assistant message to the same foreign provider-neutral conversion instead of failing the request, and the plugin logs the `INVALID_REPLAY_STATE` diagnostic through its `onReplayDegrade` hook.

## Vocabulary differences

- pi-ai tool-call arguments are parsed objects; the harness stores raw JSON strings. The adapter parses input and re-stringifies output.
- pi-ai reports failures as in-stream error events; these map to `finish {kind:'error'|'aborted', failure}` chunks. Provider-specific error text distinguishes terminal `QUOTA` from transient `RATE_LIMIT`, while text and usage signals evaluated against the resolved model's context window normalize overflow to `CONTEXT_WINDOW_EXCEEDED`. A terminal `stop` whose message carries no content blocks maps to a `finish {kind:'error'}` with code `EMPTY_RESPONSE` (retried by default policy) instead of a successful empty message.
- pi-ai folds reasoning tokens into output usage; there is no separate reasoning count to map.
- pi-ai's `off` thinking level crosses the Harness capability seam unchanged and becomes an omitted pi-ai common `reasoning` option at dispatch.
- `GenerateOptions.stop` is rejected with `UNSUPPORTED_OPTION` because pi-ai's common streaming UI cannot guarantee it across providers.

## App attribution

Every request carries the shared attribution header from @hydraharness/harness-llm's `attributionHeaders()`, merged through pi-ai's `headers` stream option. Provider-specific app-attribution headers are not synthesized. See [@hydraharness/harness-llm § App attribution](../llm/README.md#app-attribution-attributionts).

## Dependency weight

pi-ai installs several provider SDKs and lazy-loads the one selected by the catalog model. The dependency weight is isolated to this opt-in adapter package.

## Model Experience

### Provider request through pi-ai

#### What the model sees

The selected catalog model receives `GenerateOptions.system`, history, tools, and sampling fields supported by pi-ai's common streaming API. This package adds no prompt prose, with one exception: when a request's accumulated base64 image payload exceeds the route's `maxRequestImageBytes`, each offloaded image (oldest first) is replaced by fixed text. The text tells the model to read the file again when a path is available or ask the user to attach the image again. Provider-native replay metadata is restored only when the adapter validates it for the historical content.

#### Token effect

Provider tokenization governs exact input. Conversion adds no model-visible text beyond the image-offload placeholder, which replaces the offloaded image's visual tokens with a short fixed sentence; replay metadata may let a native API reuse provider-side state.

#### KV Cache effect

Conversion preserves logical request order without adding text, while the selected provider's serialization and replay state determine reuse. Changing adapter instance, provider, model, or any upstream request token may prevent reuse from the first difference. Crossing the image bound rewrites an early message (the newly offloaded image becomes placeholder text), so reuse ends at that message until the offloaded prefix stabilizes.

### Provider response

#### What the model sees

pi-ai events become harness reasoning, text, tool-call, usage, and finish chunks. The adapter passes parsed tool arguments to the harness as raw JSON strings.

#### Token effect

Generated content affects later inputs only after the loop records it. pi-ai folds reasoning tokens into output usage when the provider does not report them separately.

#### KV Cache effect

Recorded response content appends to the next request and does not invalidate its earlier reusable prefix. Unrecorded transport metadata and usage accounting do not affect cache identity.

## Known Limitations and Deferred Work

- **`maxRequestImageBytes` counts base64 image payload only** — text, tools, and JSON structure ride outside the bound, so it must sit below the gateway's request-body cap with headroom. Offload is decided at request conversion as a pure function of history and configuration and is not recorded as a session event; per-route capability metadata (image count, per-image size, total request size) driving admission and assembly together is deferred design work.
- **A sign-in lives only in the process that started it** — an authorization attempt is not durable, so reloading the page mid-login abandons it and the human starts over. Signing out is `deleteRecord` on the stored record, which forgets it locally without telling the issuer.
- **Provider-native discovery answers through this plugin's ambient context** — a route naming no credential defers to the catalog provider's own resolution, which asks for environment values (`AZURE_OPENAI_API_KEY`, `AWS_PROFILE`, and each provider's own set) and for local credential files. Both questions are answered here: the credential seam is consulted before the process environment, and file existence is checked against the host process's filesystem with `~` expanded. What it cannot do is *read* a credential file's contents — a provider that parses `~/.aws/credentials` itself does so directly, outside the seam.
- **Settings can add or override routes, not remove composition routes** — the user layer merges over the composition `base`, so deleting a `cordis.yml`-provided provider is a composition change; `replace` on the namespace only resets the user layer.
- **The layered merge has no delete for dict keys** — the settings seam merges the composition `base` and the user layer per key, recursively, so a `reasoningEfforts` level, `modelOverrides` entry, or `compat` field the base declares cannot be removed by the user layer, only overridden — and for `reasoningEfforts` absence *is* the meaning ("not offered"), so a base-declared level stays offered. This only triggers when a `cordis.yml` entry config declares per-model reasoning fields for the same model the user layer edits; the supported posture is to leave those to the settings document (the shipped composition mounts the adapter dormant), and a `models` list is an array replacing wholesale, which is the in-band escape.
- **`headers` can carry a credential the redactor never sees** — the profile's `headers` dict is plain strings, so `Authorization` or `api-key` set there is returned verbatim by a redacted `describe()` and rendered by any configuration UI. Store credentials as `apiKeyEnv` references; making the dict write-only is deferred with the rest of the [wire-boundary work](../llm/README.md#known-limitations-and-deferred-work).
- **A route's catalog never refreshes itself** — the catalog is whatever `settings.yaml` says, so a model list is only as current as its last edit. Nothing here queries a provider for the models it serves; a route gains a model when someone writes one.
- **One wire protocol per route** — `api` applies to the whole route, so a mixed-protocol catalog route (an OpenAI-style catalog spanning Responses and Chat Completions) cannot host a model of the other protocol, and adding a model such a route does not describe requires naming `api` and moving every model onto it. Splitting the provider across two route keys is the workaround.
- **A modality declaration is not verified, and over-claiming outlives the turn** — nothing interrogates an endpoint for what it accepts, so a model declaring `image` its gateway does not serve is refused by the provider mid-turn rather than here. Prompt admission commits the user message durably before the request is built, so the rejected image stays in the session log: that model keeps re-sending it, and model selection refuses a switch to any text-only model. Recovery is another image-capable model, a fork before the image, or a new session; rolling an unconsumed image message back out of the log on a failed send is deferred.
- **An unauthenticated route depends on its protocol** — naming no credential resolves the route as configured-but-keyless, but pi-ai's OpenAI-compatible implementation still requires an API key or an `Authorization` header, so a keyless local server needs a placeholder credential referenced by `apiKeyEnv` or an `Authorization` entry in `headers`.
- **`GenerateOptions.stop` is unsupported** — pi-ai's common stream options cannot guarantee stop-sequence behavior across providers, so the adapter rejects the field.
- **In-history `system` messages use pi-ai's common context conversion** — provider-specific placement follows pi-ai rather than a harness-owned wire override.
- **Provider HTTP status is unavailable** — pi-ai error events do not expose a stable HTTP status across providers; failures expose only stable harness error codes.
- **Retry policy is provider-owned, not an SDK retry** — each provider profile may supply nested `retryPolicy`; omission resolves to normal mode with five retries, and the effective route policy is what `@hydraharness/harness-llm-retry` executes at the agent failed-step extension point. pi-ai SDK retries stay disabled so durable agent steps and `llm/retry` events own every visible attempt, and direct `ctx.llm.stream()` calls remain single-attempt.

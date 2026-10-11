# `@hydraharness/harness-jev`

Optional Host capability for the configured Jev `/api/v1/decisions` transport. It exposes `ctx.jev.systemOne()` for structured choices, scores, and yes/no answers without registering a chat model route.

Configure `apiKeyEnv`, `model`, `baseURL`, and `timeoutMs` in the `jev` entry. The key is resolved through `ctx.credentials` or the trusted launch environment on each request. Settings and credentials are optional, so a composition without Jev still boots; a missing key returns `JevError` with `MISSING_CREDENTIAL` when a caller asks for a decision.

The provider validates the response, honors cancellation and timeout, and normalizes authentication, rate-limit, transport, and invalid-response failures. It does not retry requests or log response bodies.

Enable the `jev` group in Plugins and save; the Web bundle enables the Host capability, its Models card, and the advisory `browser_decide` consumer together. The main model can call that tool when it needs a bounded choice, while browser execution and policy remain authoritative. All rows ship disabled. Without the UI, set `disabled: false` on the `jev`, `browser-decisions`, and (when present) `ui-jev` rows in a profile patch and supply the key through Credentials or `JEV_API_KEY`.

**Settings → Models → Decision model** owns the Off/Jev preference and **Configure Jev** key editor. The [browser consumer](../../browser/browser-decisions/README.md) owns preference enforcement; direct `ctx.jev.systemOne()` callers remain independent of that preference.

`JevSystemOneRequest` carries JSON `state`, named `questions`, and an optional Jev model override. Questions discriminate on `type`: `choice` maps labels to criteria, `score` supplies an ordered rubric of at least two entries, and `noul` optionally describes true/false outcomes. `JevRequestOptions` accepts `signal` and `timeoutMs`. The provider unwraps Jev's `{ code, message, data }` response and validates answers keyed by the requested question names; usage is preserved when the API supplies it. Unloading the plugin cancels and drains pending requests.

## Model Experience

### Independent decision request

#### What the model sees

Jev receives the caller's `state`, named `questions`, and resolved `model` through `POST /api/v1/decisions`. No chat adapter or tool is registered. Consumers own logging their model-visible inputs and results; the browser consumer uses ordinary tool-call and tool-result events.

#### Token effect

Each call sends an independent request with data-dependent input and output usage. Loading the provider adds no conversation tokens.

#### KV Cache effect

Jev requests do not alter the conversation prefix. Jev cache behavior is provider-owned; this package makes no reuse guarantee.

## Known Limitations and Deferred Work

- The default endpoint is `https://www.jevai.org/api/v1/decisions`. The [official TypeSafe API](https://docs.typesafe.ai/api) uses `https://api.typesafe.ai/v1/systemone`; verify model identifiers and response-envelope compatibility before changing the configured URL. The Decision preference keeps the configured endpoint and credential reference.
- The default model is `typesafe-ai/jev`; pin a supported Jev identifier in configuration when reproducible provider behavior matters.
- Automatic browser invocation, model discovery, and provider retries remain consumer-owned.

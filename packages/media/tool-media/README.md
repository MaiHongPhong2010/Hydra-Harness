# @hydraharness/harness-tool-media

Registers `image_generate`, `image_generate_google`, and `video_generate` under one Settings → Plugins entry. The shared switch enables or disposes all three tools together. Mounting the plugin makes no provider request and requires no credentials at startup.

## Configuration and admission

Select **Image model** and **Video model** in Settings → Models and configure each provider's credentials. Generation choices are independent of the conversation model. Saved models take priority over tool model hints. Optional provider restrictions refuse missing routes. Missing credentials or HTTP 401/404/429 permit another candidate; accepted requests, safety refusals, timeouts, cancellation, transport errors, and server failures stop fallback. See [generation routing](../../llm/llm/README.md).

The selected conversation model prepares the generation prompt in its normal tool-calling turn. The prompt descriptions direct it to use precise image or video terminology supported by the request and conversation while preserving intent, quoted text and language, counts, and constraints. Video wording must agree with requested duration and size. Requests to use an exact prompt or skip rewriting take priority. The tool sends the authored prompt unchanged to the media provider; no separate prompt-rewriting model request runs. The original user message and final tool-call prompt remain in history, and the media card exposes the final prompt for inspection and copying.

The plugin's configuration groups settings by tool. A profile patch replaces its complete configuration:

```yaml
- id: tool-media
  config:
    openai:
      model: gpt-image-1.5
      apiKeyEnv: OPENAI_API_KEY
    google:
      model: gemini-3.1-flash-image
      apiKeyEnv: GEMINI_API_KEY
    video:
      timeoutMs: 900000
      pollIntervalMs: 10000
      maxVideoBytes: 104857600
```

`openai` and `google` each accept `useProviderModels` (default `true`), optional `provider`, `model`, `baseURL`, `apiKeyEnv`, `timeoutMs` (180000), `maxResponseBytes` (33554432), `maxPromptChars` (32000), and `maxImages` (4). OpenAI also accepts `fallbackModels`. Standalone image routes use OpenAI's `https://api.openai.com/v1` or Gemini's `https://generativelanguage.googleapis.com/v1`; keys resolve once per call. HTTPS is required except for loopback test servers. The [generated configuration catalog](../../../docs/config-catalog.md#hydraharness-tool-media) owns all field defaults.

`image_generate` accepts prompt, count, size, quality, format, and background. It defaults to one PNG with automatic size, quality, and background. Transparent JPEG is refused before billing. `image_generate_google` accepts a prompt and bounds final output count instead of requesting an exact batch. Both accept completed inline images from OpenAI, Gemini, Antigravity, or compatible Chat Completions. Thought images, provider text, incomplete results, and remote-only URLs are excluded. Both tools admit images in provider order with names `generated-1.<extension>`, `generated-2.<extension>`, and so on. Attachment policy verifies the complete image batch before publishing references; its byte and dimension limits remain authoritative.

`video` accepts optional `provider` and `model`, plus `timeoutMs` (900000), `pollIntervalMs` (10000), `maxResponseBytes` (1048576 per job reply), `maxVideoBytes` (104857600), and `maxPromptChars` (32000). `video_generate` accepts prompt, optional seconds, and optional landscape or portrait size. The selected provider validates supported durations. It requires a saved video route; no standalone video provider is chosen implicitly.

The [provider adapter](../../llm/llm-pi-ai/README.md#catalog-resolution) submits native Veo, xAI, or compatible Videos API jobs, polls on the accepted route, and downloads the completed file. Polling keeps the original credentials and network proxy; delivery requests to another origin receive no route credentials. The tool streams MP4/WebM bytes into durable storage with a total byte limit and cancellation. A status failure or download failure never submits another job. OpenAI's public Videos API is [removed](https://developers.openai.com/api/docs/deprecations); compatible gateway support does not imply that public Sora is available.

## Durable presentation

Image results contain `{ model, images }` plus the exact provider when a saved route is used. Video results contain `{ provider, model, videos }`. Native model content carries a short acknowledgement; [`tool-images` and `tool-videos` metadata](../../../docs/subsystems/attachment.md#tool-presentation-images) carries stored references for gallery, playback, download, history reload, and ZIP export. Provider payloads and credentials stay out of the session log. All tools refuse nested Code Mode execution before billing because nested results do not persist this metadata.

## Model Experience

### Tool schema

#### What the model sees

The three [generation schemas](../../../docs/tool-catalog.md#hydraharness-tool-media) while the plugin is enabled.

#### Token effect

Fixed schema cost on requests that expose these tools, including prompt-refinement instructions; refinement uses the selected conversation model's ordinary turn.

#### KV Cache effect

Prefix-stable while configuration and visibility are unchanged.

### Tool result

#### What the model sees

Images return `Generated <count> image(s) with <provider> (<model>).` Videos return `Generated video with <provider> (<model>).` Failures return tool error text; media bytes and presentation metadata stay outside model history.

#### Token effect

The prompt remains in tool-call history; the result adds an acknowledgement or error without base64 or image-input tokens.

#### KV Cache effect

Append-only tool history retains the earlier reusable prefix.

## Known Limitations and Deferred Work

- Generation uses Native tool mode. Editing, reference media, streaming previews, and resumed video polling after process restart are not exposed.
- Provider entitlement and billing require separate verification. Admission, download, storage failure, or cancellation can occur after billing; cancellation does not guarantee cancellation of the provider job.
- Video files are stored verbatim using the provider's MP4/WebM content type; the tool does not decode or transcode them.
- Large images may exceed attachment policy after generation. Configure attachment limits or request JPEG/WebP explicitly.
- Provider-specific account adapters must support video completion before their selected models can generate playable output.
- Stored immutable media remains until reference-aware retention exists.

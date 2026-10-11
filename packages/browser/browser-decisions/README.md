# `@hydraharness/harness-browser-decisions`

Optional model-facing `browser_decide` tool over `ctx.jev`. The base bundle places it in the `jev` plugin group, so enabling Jev exposes one bounded consumer with the provider and Models card. It receives observed browser text, a question, and at least two candidate labels, then returns Jev's selected label and confidence. When Jev is disabled, unconfigured, cancelled, or unavailable, the tool returns `available: false` so the agent can continue with its existing browser tools.

The global `browser-decisions` settings namespace owns `enabled`, a boolean defaulting to `true` for an enabled Jev plugin group. **Settings → Models → Decision model → Off** blocks new calls before contacting Jev and returns `Decision model is Off.` Pending requests keep their original cancellation signal and may finish. Switching back to Jev affects the next call; it does not mount a disabled plugin or change the Jev credential, endpoint, or model.

The tool is advisory. It never navigates, clicks, fills, executes JavaScript or CDP commands, changes permissions, or bypasses the browser executor and policy.

## Model Experience

### Tool schema

#### What the model sees

The generated [`browser_decide` schema](../../../docs/tool-catalog.md#hydraharness-browser-decisions) accepts observed state, a question, and distinct candidate labels. The tool remains callable without Jev and returns an unavailable result in that case.

#### Token effect

One fixed tool definition is included wherever the plugin is mounted and visible.

#### KV Cache effect

The definition is stable across provider availability changes. Mounting or disposing the consumer changes the tool prefix.

### Decision result

#### What the model sees

`Jev chose <label> (<confidence>% confidence).` or `Jev decision unavailable: <reason>` appears in the logged tool result. Only a supplied candidate with finite confidence between zero and one is accepted. The result authorizes no browser operation.

#### Token effect

Each call appends a short result; the observed state and candidates are retained in the tool call. The separate Jev request has its own token usage.

#### KV Cache effect

Results append after the existing conversation prefix. Jev's independent request does not replace earlier conversation tokens.

## Known Limitations and Deferred Work

- The initial consumer supports candidate choices only; score and yes/no consumers can use `ctx.jev` directly.
- Confidence thresholds and retries remain caller policy.

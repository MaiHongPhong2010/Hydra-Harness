# `@hydraharness/harness-client-ui-jev`

Optional browser contribution to **Settings → Models → Decision model**, below Default, Image, and Video. Enable the Jev group in Plugins and save to mount the Host provider, browser decision consumer, and this contribution. Its **Off / Jev** dropdown saves `browser-decisions.enabled` globally through the existing Settings API. Off prevents new `browser_decide` requests; pending requests finish, and credentials, model, and endpoint are retained. The existing enabled group defaults to Jev. Selecting a decision preference never enables a plugin group.

The contribution registers and disposes `settings.models.decision`. Owner props carry read-only state, value-free credential descriptors, and `openSection(id)` navigation. The shared settings mirror supplies the Host's resolved Jev model and credential reference. **Configure Jev** opens a blank, write-only key field; Apply uses the existing Credentials API and clears the draft only after acknowledgement. Failures retain the draft for retry, and closing the editor clears it. Credential updates refresh the status without exposing a secret. Jev is absent from API keys → Add provider, the Host LLM directory, and the conversation picker.

## Model Experience

### Provider configuration

#### What the model sees

The UI registers no model-facing text. It configures the independent `ctx.jev` capability; the separately packaged browser-decisions consumer is enabled with the same `jev` group.

#### Token effect

Zero; opening the editor and saving a credential make no model request.

#### KV Cache effect

The conversation prefix and model route are unchanged by credential edits.

## Known Limitations and Deferred Work

- The card exposes the resolved model label; endpoint and model editing remain Host configuration concerns.
- No network request runs when the card opens.

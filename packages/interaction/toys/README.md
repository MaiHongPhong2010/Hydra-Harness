# Toys

`/confetti` emits one live effect when `toys.confetti` is enabled. It takes no arguments, adds no model input, and never fires during transcript replay. Optional-plugin disablement blocks the command's effect. Connected renderers honor reduced motion and clear the effect after its configured lifetime.

The plugin config sets `particles` (1–200, default 48) and `durationMs` (100–10000, default 1800). The user preference defaults to Off.

## Model Experience

None, as the explicit human command emits a transient visual effect without model input.

#### KV Cache effect

None; confetti adds no model context.

## Known Limitations and Deferred Work

- The effect is live-only and requires a connected renderer with reduced motion disabled.

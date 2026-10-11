# Suggested prompt UI

The General preference enables the Host-owned suggested-prompts feature. Empty chats show a cached bounded batch and Refresh. Clicking a choice replaces the input draft without sending it; errors leave the composer available. Generation limits, permissions and token use belong to `@hydraharness/harness-suggested-prompts`.
## Model Experience

None, as the renderer displays Host-owned suggestions and fills the draft without sending it.

#### KV Cache effect

None; the renderer assembles no model request.

## Known Limitations and Deferred Work

- Suggestions require readable project data or a permitted MCP resource source and an available selected model.

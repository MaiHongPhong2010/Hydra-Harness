# Suggested prompts

Optional empty-chat suggestions read bounded project files and resource sources registered by connected MCP providers. Sources retain their owning scope; project reads reject paths outside the canonical workspace root. Enabling the feature can send this context to the selected model and consume tokens. Clicking a suggestion fills the draft only.

The `suggested-prompts.enabled` setting defaults to false. `maxInputBytes`, `maxSuggestions`, `maxTokens`, `timeoutMs` and `projectFiles` configure each batch. A chat receives one cached batch until Refresh; generation uses the agent's maintenance lifetime and failures return a readable error. Auxiliary request input and accepted results are logged separately from conversation messages.

## Model Experience

### Empty-chat batch

#### What the model sees

A separate request asks for a bounded JSON array of short project prompts, followed by permitted project and MCP source text explicitly treated as untrusted data. Both the assembled request and accepted result are recorded in the session log.

#### Token effect

Each new or refreshed batch consumes input tokens for at most `maxInputBytes` source bytes and at most `maxTokens` output tokens. Cached reads consume no additional model tokens.

#### KV Cache effect

This auxiliary request does not modify the conversation prefix. A refresh may use changed source data and receives no conversation-cache guarantee.

## Known Limitations and Deferred Work

- Suggestions require an idle empty chat, a selected model, and permitted readable sources. Unreadable data and generation failures leave the composer usable. Sources may be sent to the selected provider when this feature is enabled.

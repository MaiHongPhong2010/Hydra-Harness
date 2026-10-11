# @hydraharness/harness-client-ui-settings-personalization

Settings → Personalization section (nav order `1`): System prompts groups custom instructions and personality into separate native disclosure panels, collapsed on section entry. Each editor stages changes until its Save button is pressed. Registers `settings.section` (`id: 'personalization'`) using [`ui-settings`](../ui-settings/README.md)'s existing slot, `ctx.settingsScope`, and locale contracts.

- **Custom instructions** load and save through the personalization RPC pair (`settings.readInstructions`/`writeInstructions`, [`@hydraharness/harness-host-apiproxy`](../../host/apiproxy/README.md)), which stores the document at `$HYDRA_HOME/AGENTS.md`. The editor's `expectedRevision` fences writes against the document's SHA-256 content hash; a stale write surfaces as a distinct `conflict` status with a reload affordance, never a silent overwrite.
- **Memory** manages saved local memories and global memory defaults through the Host's memory RPCs and settings namespace.
- **Personality** stages a tone selection, then writes the `personalization` settings namespace through `ctx.settingsScope.bind()` on Save. A rejected write retains the selection with a retry message. Saved tone preferences apply to new chats; existing chats keep their logged personality.

Section entry refreshes a clean instructions editor. Unsaved edits, conflicts, and pending saves survive section switches while the panels return to their collapsed state. Only an explicit instructions reload discards that draft. Successful saves retain edits entered after submission. Collapsing either panel never writes its draft; an unsaved indicator remains visible in its summary.

Saved custom instructions enter chat requests through the [agent-instructions loader](../../context/agent-instructions/README.md#state-and-refresh), including subsequent requests of an existing chat. They are logged user-role guidance and do not replace the agent's system prompt or override system, developer, or direct user instructions.

Personalization edits the global user instructions and preferences. Workspace instructions in `.hydra/AGENTS.md` and `.hydra/AGENTS.local.md` apply automatically to chats in that workspace; selecting a workspace does not change the Settings editor.

## Model Experience

Indirectly, through the custom-instructions document and personality value this section edits — `@hydraharness/harness-agent-instructions` and `@hydraharness/harness-personalization` own their model-visible rendering.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **No live multi-tab invalidation for custom instructions** — unlike a namespace-registered settings section, a write here does not ride the forwarded `settings/document-updated` event. A second open tab discovers a concurrent edit only on its next save attempt (`instructions-conflict`) or a manual reload of the section.
- **No client-side size or format validation** — the editor accepts any text; the 65,536-byte UTF-8 cap and content-hash revisioning are enforced entirely Host-side. An oversized draft is rejected only on save.
- **One global custom-instructions document** — named prompt libraries and editing deployment-owned system sections are outside this editor.

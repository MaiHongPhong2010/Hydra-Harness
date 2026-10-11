# Agent Note: Workspace-local configuration and execution trust

Status: implemented

## Problem

A Host can serve several project directories at once. User-wide settings cannot express a project's permission default, presets, MCP servers, and hooks without changing other open workspaces. Repository instructions and skills also need the selected workspace root when a session starts in a nested directory. Loading executable project configuration without a Host-owned decision lets a repository launch commands merely by being opened.

## Decision

[@hydraharness/harness-workspace-config](../../../../packages/workspace/workspace-config/README.md) owns one standing environment per canonical root. Workspace registration prepares missing `.hydra/settings.yaml`, `settings.local.yaml`, `AGENTS.md`, and `.gitignore` before publishing the record. Existing bytes are retained; symbolic links, nonregular targets, and writes outside the root reject. Preparation is idempotent, so a later attempt can complete missing files after a partial failure. Removing a registration retains the directory, conversations, and running environment.

The shared and personal documents reuse [settings-file](../../../../packages/settings/settings-file/README.md), including its cross-process exclusion, atomic writes, comment preservation, watchers, and schema validation. [Settings inheritance](../../../../docs/subsystems/settings.md#inherited-providers) mirrors only `permission`, `agent-presets`, `mcp-servers`, and `hooks`. Resolution is defaults, composition, user, shared, personal. Maps merge by field and arrays replace wholesale; removing an override restores the lower value. Model defaults, credentials, provider accounts, and remaining namespaces stay global; project documents and writes reject these namespaces.

The Settings panel edits global user configuration independently of the active workspace. Project overrides are resolved from `.hydra/` files when a consumer addresses that workspace; the UI exposes no global/shared/personal selector. This separates the file receiving an edit from the effective configuration of a running chat, following [Codex configuration layering](https://learn.chatgpt.com/docs/config-file/config-basic) and its [user-config write operations](https://learn.chatgpt.com/docs/app-server). Settings drafts and navigation remain stable when the current workspace changes.

Each environment owns settings, MCP and hook registries, and a preset roster. Registration views follow `agent → preset generation → workspace → global`; switching the selected workspace never rewrites Host-wide settings. MCP names are unique within their owning scope, so two workspaces can use the same name. Hook temporary documents remain under a Host-owned path keyed by canonical root. Project presets precede the deployment's roots, and project clones go into `.hydra/agent-presets`. The [standing-mount decision](2026-08-08-per-preset-standing-mounts.md) still owns generation retention: later sessions read an edited composition, while joined sessions keep their generation.

Preset deletion cannot edit a lower settings layer on behalf of a personal operation. A workspace preset selected by an inherited default is retained until that lower layer selects another preset; refusal happens before deleting files. A personal-only default can be cleared to restore the lower selection after deletion.

Trust is saved in the Host's `workspace-config.trustedRoots` section, keyed by canonical root. Shared and personal overrides are suppressed until trusted, while instructions, skills, and inherited user MCP and hook definitions remain available. Trust applies to subsequent edits until revoked; a project file cannot grant it. Revocation suppresses project layers and removes executable project contributions. This decision requires no content digest acknowledgement on every edit.

The base bundle supplies workspace configuration and the preset roster to Web and headless profiles. Entry points resolve the directory's nearest registered ancestor and compose the agent in that environment before publication. Subagents inherit their parent's scope, including the enclosing workspace scope when no preset roster is composed. Model, permission, and preset facts already recorded by sessions remain the authority on resume and fork. Settings APIs accept a workspace id and shared/personal layer, reject unknown ids, and keep an omitted target global; browser requests cannot supply arbitrary settings paths.

`.hydra/AGENTS.md` and `AGENTS.local.md` are additive root scopes after ordinary root instructions and before descendant instructions. Their content follows [workspace instruction persistence and budgeting](../feature/2026-06-24-workspace-context.md). Skill lookup uses the selected root. These files are data for the model, so execution trust does not block their reading.

## Alternatives considered

**Continue using one global settings document for every workspace.** This cannot express two simultaneous projects with different defaults or same-named MCP servers without coupling their sessions. Global settings remain the inherited user layer instead.

**Switch the Host's settings and registries when selecting a workspace.** Selection is a client action while other sessions can continue running. Replacing shared services would change those sessions and their tool sets, so the environment owns separate service realms and registration scopes.

**Share MCP processes across workspace environments.** This could reduce process count but adds ownership and teardown coordination between independently editable configurations. Each environment keeps its own connections; process sharing is deferred until its cost warrants that coordination.

## Verification

The [keyless Loader snapshot](../../../../examples/headless-agent/tests/workspace-config.snapshot.ts) drives real agents from a registered root's nested directory. It compares model instructions and hook context with durable messages, loads a project skill through the real tool, and compares request tool availability with `llm/call-start`. Its trust, personal-reset, and revocation states cover the global model through every trust state, personal and shared hook resolution, and project preset and MCP visibility. Dynamic packages defined, run, and inspected through the real Cordis tools cannot grant trust through `workspaceConfig` or the global trust settings namespace; their failed Host state and model-visible errors leave trust unchanged.

The [API recovery tests](../../../../packages/host/apiproxy/tests/api-proxy-workspace-resume.spec.ts) use the real Loader and JSONL persistence to reconstruct a retired idle chat once across concurrent requests, preserve recorded selections and its log prefix, and mount changed project tools. Active turns and running descendants, including a continuable activation, prevent reconstruction until idle.

The [Web Settings scenario](../../../../apps/web/tests/workspace-settings.e2e.ts) snapshots global navigation after workspace selection, checks global model and instruction writes, and loads project permission overrides through the real file watcher. Its two workspaces pin isolation, fallback after override removal, and trust revocation. The desktop workspace-settings smoke saves global instructions and verifies that each workspace instruction file remains unchanged.

## Consequences

Project configuration can travel with the repository while personal overrides stay ignored by its `.gitignore`. The [user-settings seam](2026-07-28-user-settings-seam.md), [user-owned MCP and hook records](../feature/2026-09-04-user-owned-mcp-servers-and-hooks.md), and workspace instruction decisions remain active for their independent validation, redaction, and model-input rules; this note adds workspace ownership and execution trust.

Environments and superseded preset generations consume resources until their owning Host or roster unloads, except generations explicitly removed by trust revocation. Re-trusting permits fresh project generations; it does not restore a revoked generation. The [Host API](../../../../packages/host/apiproxy/README.md) reconstructs an API-owned idle persisted Web/Desktop chat under a fresh generation of its recorded preset, preserving history and selections. Busy chats must become idle first; chats without durable logs need a new chat, and externally owned Agents require a fresh composition. Multiple active workspaces can therefore create multiple MCP processes. Trust-once accepts later project edits under the same canonical root; users must revoke trust when that assumption changes. Instruction and skill content remains untrusted model input even when execution trust is withheld.

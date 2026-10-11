# Workspace configuration

`ctx.workspaceConfig` prepares `.hydra/` in each workspace and owns a standing runtime for every canonical root. Session logs, model and provider settings, credentials, and trust decisions stay on the Host.

## Files and trust

Initialization creates missing `settings.yaml`, `settings.local.yaml`, `AGENTS.md`, and `.gitignore` without replacing existing bytes. The ignore file excludes `settings.local.yaml` and `AGENTS.local.md`. Existing links and nonregular entries in these slots reject initialization before workspace registration. An optional `AGENTS.local.md` must also be a confined regular file.

Workspace settings inherit schema/composition defaults, then Host user settings, shared settings, and personal settings. Maps merge by field; lists replace. Reset removes an override and reveals the lower layer. Workspace documents accept only `permission`, `agent-presets`, `mcp-servers`, and `hooks`. File watchers, atomic persistence, locks, validation, and secret redaction belong to [settings-file](../../settings/settings-file/README.md).

The Host settings namespace `workspace-config` stores `trustedRoots` by canonical path. Until trusted, project settings and `.hydra/agent-presets` do not execute; inherited Host MCP servers and hooks remain available. Instructions and skills are independently available. Revocation stops project preset generations and reconciles MCP/hooks to inherited settings before resolving. Retained agents from an unloaded project generation cannot enter another step or execute a tool, including after trust is accepted again. A saved denial remains a decision, so selecting the same root does not repeat its trust prompt.

After trust is restored, the [Host API](../../host/apiproxy/README.md) rebuilds an idle persisted Web/Desktop chat from its flushed log under a fresh generation, preserving history and recorded model, permission, and preset selection. Running work must become idle and queued input must be cleared before recovery; a chat without a durable log needs a new chat. Other lifecycle owners must compose a fresh Agent.

## Runtime and settings targets

`environment(cwd)` uses the nearest registered canonical ancestor, falling back to the existing cwd directory. Every environment isolates settings, MCP records, hook records, and the preset roster. Preset generations inherit the workspace registration scope. Same-name MCP servers in different environments are independent. Inline hook documents live under the Host home's `workspace-runtime/<root hash>/hooks`, outside the repository.

Workspace MCP processes and hook commands use the owning root as their working directory. Relative MCP working directories and file hook documents resolve from that root.

When the deployment supplies no preset roster, a trusted workspace can supply its own roster by setting `agent-presets.default` explicitly and creating that preset under `.hydra/agent-presets`. An untrusted workspace exposes no project-only roster. No default preset id is inferred.

`environmentFor(workspaceId)` and `settingsFor(workspaceId, layer)` accept only registered identities; unknown ids reject. `shared` selects the team document; `local`, the default, selects the personal document. `userEnvironment()` serves consumers without a directory. Deleting a workspace registration retains its files and standing session environment until Host teardown.

`Config.hydraHome` selects Host runtime storage. Optional `watch` and `debounceMs` apply to workspace settings providers; omitted values use that provider's defaults. Trust changes and document updates carry the owning workspace identity so clients can invalidate the correct settings cache.

## Model Experience

### Scoped runtime configuration

#### What the model sees

This plugin writes no model context or session events. Existing consumers log instructions, selected models/presets, and the tool schemas in `llm/call-start` using each session's workspace environment. A revoked project preset cannot continue its model step.

#### Token effect

No direct tokens; enabled instructions, skills, tools, and preset plugins determine the resulting request size.

#### KV Cache effect

Workspace-specific tool and prompt contributions affect request prefixes through their owning consumers. Existing sessions retain their preset generation when files change; revocation removes project execution permission immediately.

## Known Limitations and Deferred Work

- Each active workspace runs its own inherited MCP and hook composition. Server process sharing across workspace scopes requires separate lifecycle and isolation work.
- An existing `.gitignore` retains its contents. Repositories that already own this file must include the personal settings and instructions exclusions themselves.

# Use the Web UI

Start the Web UI through the [root README](../../../README.md#run); the command prints its URL. This guide begins after that server is running. The `hydra` process uses its invoking directory as the default filesystem location, but a fresh Web UI has no selected workspace until you add one.

## Configure a model

Open **Settings → Models**, enter a [DeepSeek API key](https://platform.deepseek.com/), and save it. The model route becomes usable immediately without restarting the server.

The [model configuration guide](./providers.md) covers other providers and custom OpenAI-compatible endpoints.

## Choose a workspace

Click **Choose workspace**, add the project directory where you started `hydra`, and select it. The session composer remains unavailable until a workspace is selected.

### Configure this workspace

Hydra creates a `.hydra/` directory in each added workspace. Existing files are preserved; an older workspace receives missing files when selected or used for a session. Removing a workspace from the sidebar keeps this directory and its conversations.

| Path below `.hydra/` | Purpose |
|---|---|
| `settings.yaml` | Shared project settings, suitable for version control |
| `settings.local.yaml` | Personal overrides for this workspace |
| `AGENTS.md` | Project instructions appended after the root instructions |
| `AGENTS.local.md` | Optional personal instructions appended after project instructions |
| `skills/<name>/SKILL.md` | Project skills available to agents in this workspace |
| `agent-presets/<id>/` | Project agent presets, using Hydra's preset format |
| `.gitignore` | Excludes `settings.local.yaml` and `AGENTS.local.md` |

**Settings** edits your global configuration. For project-specific values, edit `.hydra/settings.yaml` or `.hydra/settings.local.yaml` in that workspace. These files override existing global values or add values used only by that workspace. Removing a project value restores its inherited value. Project settings support the permission default, agent presets and plugin enablement, MCP servers, and hooks. Model defaults, provider configuration, sign-in, and API keys stay global.

Values resolve in this order: schema defaults, deployment configuration, global user settings, shared project settings, personal workspace settings. Objects merge by field; a list replaces the inherited list in full. Two open workspaces keep separate settings and processes, including servers or presets with the same name.

Trust a workspace before enabling its settings and agent presets. The Host saves that decision for the canonical project directory; a repository file cannot grant trust. Instructions and skills are readable before trust, and global user MCP servers and hooks remain available. Trust covers later edits until the Host decision is revoked. Use **Open configuration file** to edit `workspace-config.trustedRoots` in the global file; setting the canonical directory to `false` revokes trust. Revoking trust stops project MCP servers and hooks and prevents project presets from starting.

After trusting again, reopen or continue an idle saved chat in Web or Desktop. Hydra rebuilds its project preset generation while preserving its history, model, permission, and preset selection. Wait for running work, including subagents, to finish and clear queued input before reopening. A chat with no saved log needs a new chat.

Instruction changes follow the existing workspace instruction refresh rules. New sessions use the latest preset files, while a running session retains its preset generation. CLI and SDK sessions use their working directory or the nearest registered workspace root; subagents inherit their parent's workspace.

## Run a task

Start a session and send:

> Summarize this repository and identify its main packages.

The agent can read and edit workspace files, run commands, delegate work, and maintain a plan. The Web UI asks before operations that require approval under the active permission policy.

## Continue

- [Use the desktop app](./desktop.md)
- [Reuse page workflows](./page-memory.md)
- [Configure models](./providers.md)
- [Use the Python SDK](./python-sdk.md)
- [Use other CLI modes](../../../apps/cli/README.md)
- [Develop a plugin](../develop/basic/index.md)

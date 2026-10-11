# `@hydraharness/harness-base`

The [media generation plugin](../../media/tool-media/README.md) mounts by default with one live Settings switch for image and video tools. Configure a generation model and its credentials before requesting media; mounting the plugin makes no provider request.

The shared hydra core as a profile bundle: [`cordis.patch.yml`](cordis.patch.yml) inserts every base plugin row — model adapters, the shared [`agent-default-model`](../../core/agent-default-model/README.md) selection, tools, persistence, policy, settings/credentials, telemetry, the [`imported OpenAI/Codex plugin runtime`](../../host/plugin-runtime/README.md), and the core spawn/fork subagent providers — over the empty profile root, as the first layer of every profile's `hydra.profile.bundles` list. The optional Codex and Claude Code providers stay outside this package and its production dependency closure; a Profile installs either [product provider Bundle](../../subagent/README.md) only when needed. The default `@hydraharness/harness` production closure therefore includes neither product provider, the Claude Agent SDK, nor the Codex wrapper and platform payloads. Later bundle layers (e.g. [`@hydraharness/harness-web-app`](../web-app/README.md)) and the user's profile `cordis.patch.yml` override these rows by id; a patch replaces a row's whole `config`, so mode-specific values live in mode bundles, not here. The package has no runtime API; the profile composer resolves the patch through the `hydra.bundle.patch` manifest field, never through code.

The patch gates both shell stacks by platform on its own rows: `bash-sandbox`/`tool-bash` carry `disabled: !!js process.platform === 'win32'` (bash has no Windows runner), and their twins `pwsh-sandbox`/`tool-pwsh` mount on win32 only with the inverted expression — one shared patch file, exactly one shell stack per host. The permission surface stays exactly as on POSIX: `sandbox`/`sandbox-policy` enforce the file-effect policy through the Windows ACL restricted-token runner (the win32 chain of `@hydraharness/harness-sandbox-local` → `@hydraharness/harness-sandbox-windows-acl`), the permission switcher and the approval service run unchanged, and `fs-sandbox` keeps fencing `ctx.fs` writes — mounting `@hydraharness/harness-fs-local` alongside it would double-register `ctx.fs` and fail the load. A Windows host that prefers the unconfined local pwsh executor or full access overrides these rows through its profile or home `cordis.patch.yml` (the bash-restore recipe must be complete: disable `pwsh-sandbox`/`tool-pwsh` AND re-enable `bash-sandbox`/`tool-bash` — both executor families register the same `bash` service, so an incomplete recipe fails loud at load). POSIX hosts see the pwsh rows disabled.

The row set and its rationale are documented inline in the patch file; the [generated composition graph](../../../apps/cli/composition.md) renders it.

The base bundle mounts DeepSeek, Serper, and Other search providers with [explicit Settings selection](../../web/web/README.md#product-search-settings) and public HTTP fetch. Standard and Code presets expose fetch; private origins require an explicit operator grant in the [HTTP provider](../../web/web-fetch-http/README.md). The optional [research policy](../../guard/research-policy/README.md) can impose deployment limits when configured explicitly.

The base also mounts the LSP capability; its stdio provider defaults to disabled unless `HYDRA_LSP_COMMAND` is set. The provider checks executable availability on query, so a saved enablement override or a command unavailable on another machine cannot prevent Desktop or Web startup. Install a compatible server on that host and set `HYDRA_LSP_COMMAND` to its command or absolute path; queries against a missing server return `LSP_UNAVAILABLE`. See [stdio configuration](../../lsp/lsp-stdio/README.md#configuration).

The base mounts [`workspace-config`](../../workspace/workspace-config/README.md), which prepares `.hydra/` at the selected workspace and owns its settings, MCP, hooks, trust, and preset context. Project execution is enabled by a Host-owned trust decision; provider credentials and sessions remain in the harness home.

## Model Experience

Indirectly, through the inserted rows: this bundle selects the shipped persona-less prompt base, tool set, and DeepSeek adapter that mode bundles specialize, and contributes no model-visible text of its own.

#### KV Cache effect

None directly; each inserted row's package owns its effect.

## Known Limitations and Deferred Work

- **A patch replaces whole row configs** — profile overrides must restate every field a row keeps; there is no deep-merge layer.
- **The Windows temp grant is a private per-session subdirectory** — `workspace-write` confines writes to the workspace plus the session's own temp subdirectory (`<temp>\hydra-<hash>`, TMP/TEMP rewritten for confined children); `read-only` grants nothing. See `@hydraharness/harness-sandbox-windows-acl`.

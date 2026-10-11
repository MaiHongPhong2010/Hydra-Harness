# @hydraharness/harness-host-plugin-inventory

`PluginInventoryGateway` projects the current Cordis Loader tree, persistent module enablement, imported OpenAI/Codex bundle lifecycle, OpenAI/Codex marketplace sources, and the user's own MCP server and hook records through `pluginInventory` Remotes. It publishes `list`, `setEnabled`, `listMarketplaces`, `addMarketplace`, `setMarketplaceEnabled`, `removeMarketplace`, `listImportedPlugins`, `importPlugin`, `infoPlugin`, `enablePlugin`, `disablePlugin`, `setPluginMcpServerEnabled`, `trustPlugin`, `untrustPlugin`, `removePlugin`, `listMcpServers`, `defineMcpServer`, `setMcpServerEnabled`, `removeMcpServer`, `listHookRecords`, `defineHookRecord`, `setHookRecordEnabled`, and `removeHookRecord`.

Loader inventory reads `ctx.loader.entries()` directly, skips structural group rows and configured Host placeholders for agent-preset entries, and projects one logical module with its configured entry id, module name, effective enablement, toggle eligibility, and root Fiber phase. When `agentPresets` is present, it also projects each preset leaf with an `agent-preset:<preset>:<row>` id. Ordinary Host rows change live and persist in `plugins.enabled`; rows declaring `pluginType: core` persist their desired state in `hydra.profile.pluginEnablement`, remain live until restart, and return `restartRequired`. Omitted `pluginType` or `pluginType: normal` permits live changes. The static declaration is beside `id` and `name`, outside `config`; invalid values and the `plugin_type` spelling are rejected. Preset rows persist in `agent-presets.pluginEnablement` and affect only sessions created after the change.

`list` and `setEnabled` accept an optional workspace settings target. A workspace list contains only its preset leaves; workspace writes reject Host rows and persist the selected preset override in `agent-presets.pluginEnablement`. Each leaf's `presetId` and `presetRowId` identify the nested override that a settings reset removes. Initial enablement is tracked separately per workspace and layer.

Entries declaring the same non-empty `pluginGroup` share one control; `relatedModules` lists its other modules. A group inherits core treatment from any core member. Only profile-owned members are persisted; dynamically owned entries remain controlled by their owner. Live groups roll back their Loader state if application or persistence fails. The shipped Settings UI, storage stack, and directory-picker pair each form one group. Independently configured agent-preset instances retain separate switches. `initialEnabled` and `changedSinceStart` compare saved state with Host startup, including mixed initial states within a group.

Each entry also carries `description` from its package manifest and `application` from `hydra.plugin.application`; Loader or preset entry metadata can override either value for a composition-specific description. The gateway reads these fields without importing plugin code so Settings can explain a plugin in its details dialog.

## OpenAI/Codex marketplace sources

`plugin-marketplaces.sources` stores a normalized source, optional Git ref, repository-relative sparse paths, and an `enabled` slot flag (default `true`). Sources are GitHub shorthand, HTTPS/SSH Git URLs, or existing local folders. A source must contain `.agents/plugins/marketplace.json`, `.agents/plugins/api_marketplace.json`, or root `marketplace.json` with a `plugins` array. Top-level marketplace metadata and per-entry metadata such as `category` and `policy` are accepted during validation; this Host inventory does not apply catalog installation or authentication policy. Catalog order is retained by the runtime selector. The catalog is validation-only here; `importPlugin` selects and stages a bundle through `@hydraharness/harness-plugin-runtime`, which validates the bundle manifest and controls its lifecycle.

Git reads use a temporary shallow clone, enable sparse checkout only when paths are supplied, always retain the catalog path, reject unsafe transports and credential-like environment variables, apply a 30-second command timeout, and remove the checkout after parsing. Local catalog files and Git output are capped at 1 MiB. At most 20 sources and 500 catalog entries are accepted.

`setMarketplaceEnabled` persists the slot's `enabled` flag and cascades to every imported plugin whose recorded source marketplace matches this source, calling the same `enable`/`disable` lifecycle as `enablePlugin`/`disablePlugin`. `removeMarketplace` cascades a full `removePlugin` (uninstall, including writable data) to those same plugins before deleting the source record. Both cascades are a no-op when the imported-plugin runtime is not part of the composition.

## The user's own MCP servers and hooks

The `listMcpServers`/`defineMcpServer`/`setMcpServerEnabled`/`removeMcpServer` and `listHookRecords`/`defineHookRecord`/`setHookRecordEnabled`/`removeHookRecord` Remotes forward to `@hydraharness/harness-mcp-registry` and `@hydraharness/harness-hooks-registry`, which own the stored records (`mcp-servers.servers` and `hooks.records`), their validation, and their mounts. This gateway adds only the Remote surface: a composition without either registry answers its calls with `MCP server registry is unavailable` or `hook record registry is unavailable` rather than failing to mount.

These calls accept an optional `workspaceId` and `layer` (`shared` or `local`, default `local`) to select workspace records through [`workspace-config`](../../workspace/workspace-config/README.md). Lists and mutation results project the selected file's desired records with runtime status and echo the selected target; mutations persist in that file. Untrusted records remain editable without being mounted. Omitting both target fields retains global behavior; a layer without a workspace ID rejects. Remove calls accept the original record-name string or `{ name, workspaceId, layer }`. Unknown workspace IDs reject before reading or changing records.

## Model Experience

None, as this Host projection registers no prompt, tool, message, or provider request.

#### KV Cache effect

None; this package never assembles model input.

## Known Limitations and Deferred Work

- **No marketplace-entry projection** — the gateway validates sources but does not expose catalog metadata; import with a selected plugin name is owned by the imported-plugin runtime.
- **No marketplace sync or policy engine** — adding a source validates its current document only. There is no daily/explicit sync, per-entry policy application, update report, or version picker. Reimporting an installed source uses the imported-plugin runtime's existing versioned install path only when explicitly requested.

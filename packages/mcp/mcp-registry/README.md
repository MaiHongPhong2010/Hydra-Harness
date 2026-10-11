# @hydraharness/harness-mcp-registry

`McpServerRegistry` (`ctx.mcpServers`) owns the declared server records in its settings provider's `mcp-servers` namespace. User and workspace providers choose the persistence file; changes from a configuration surface or a hand-edited document reconcile without a restart. Each enabled record mounts an `@hydraharness/harness-mcp-client` fiber whose `serverName` is the record name, making its tools `mcp__<name>__<tool>`.

## Service API

`list()` projects every stored record with its live status and currently registered tool names. `define(request)` stores one complete definition and converges the mounted set: `mode: 'create'` requires an unused name, and `mode: 'replace'` requires an existing record. These conditions are checked inside the serialized mutation chain, so concurrent creates cannot overwrite one another and an edit cannot recreate a removed record. `setEnabled({ name, enabled })` changes only the desired state. `remove(name)` deletes the record and unmounts it. Every mutation and every reconciliation runs on one serialized chain, so a write never observes a half-applied mount.

On replacement, omitted `enabled` and `toolCallTimeoutMs` retain their stored values. Omitted `env`, `headers`, and `url` also retain stored values because those secret positions never reach a redacted descriptor. An editor leaves an unchanged projected URL omitted to retain stored query credentials; an explicit URL edit replaces it. Other omitted optional fields clear the stored values.

`define`, `setEnabled`, and `remove` accept an optional `SettingsProvider` selecting a write layer. They derive records and revisions from that layer's base and stored override, including overrides currently suppressed by trust; a shared write never copies local secrets or definitions. Their result remains the effective runtime projection. `list(settings)` projects a selected layer's desired records, reporting live status/tools only when the running definition matches; `list()` reads effective records. `settle()` awaits queued reconciliation after a settings-layer or trust change.

## Stored records

Registry writes carry the revision read before constructing the next server list. A concurrent settings change rejects the write with `SettingsConflictError` and refreshes the stored projection; retry against that projection. This prevents stale lists from restoring deleted servers or discarding another writer's changes.

`mcp-servers.servers` is an ordered list of at most 50 records. A record carries `name`, `transport` (`stdio` or `streamable-http`), both transports' fields, `toolCallTimeoutMs`, and `enabled` (default `false`, so a new record is inert until switched on). A stdio record requires `command` and may carry `args`, `env`, and `cwd`; a `streamable-http` record requires an absolute HTTP/HTTPS `url` and may carry `headers`. `name` must match `[A-Za-z0-9_-]{1,32}` and be unique across records — a section declaring one name twice is refused at the write, because which server served a tool would otherwise depend on mount order.

A stored record this registry cannot mount is reported with status `invalid` and the refusal reason instead of failing the process: a hand-edited document must not prevent every other server from starting. A record whose connection fails reports `failed` with the transport's summary; `mcp-client` keeps its own reconnect policy running underneath. HTTP URLs reject username/password userinfo on writes, and the URL is a secret position in generic settings descriptors because legacy endpoints or query strings may contain credentials; the dedicated registry view strips userinfo, query, and fragment.

`mcp-servers/reconciled` is emitted after each reconciliation settles, carrying the projection. The package invariant checks the registry's one contract on that event: an accepted enabled record is live and a disabled one is not.

Server mounts, settings writes, and tool snapshots use the registry's owning context and registration scope, including calls through an API context. Independent workspace registries may use the same server name. Mounts survive disposal of the API caller; disabling or removing a record, or unloading its registry, disposes only its connection and tools.

Registry `Config.cwd` is an optional absolute workspace directory. Omitted or relative record working directories resolve from it; with no owning cwd, records retain the MCP client's process-directory behavior. Relative command arguments therefore address the selected workspace without changing the Host cwd.

## Model Experience

Indirectly, through `@hydraharness/harness-mcp-client`, which registers each mounted server's tools on `ctx.tools` under `mcp__<name>__<tool>`. This package decides which servers are mounted; it assembles no model input of its own.

#### KV Cache effect

Independent of this package's own operations, and consequential through them: mounting or unmounting a record changes the tool catalog of subsequent requests, which replaces the tool-definition prefix and invalidates reuse for sessions built before the change. Records are stable between edits, so an unchanged document leaves the prefix alone.

## Known Limitations and Deferred Work

- **No OAuth or bearer-token acquisition** — a remote record authenticates only through the static `headers` it stores, so a server requiring an interactive authorization flow cannot be declared here.
- **No per-record tool approval** — `defaultToolsApprovalMode` and per-tool overrides exist for imported plugin bundles (`@hydraharness/harness-plugin-runtime`) but not for these records; a mounted server's tools follow the process-wide approval policy.

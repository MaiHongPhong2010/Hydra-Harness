# @hydraharness/harness-hooks-registry

`HookRecordRegistry` (`ctx.hookRecords`) owns the declared hook records in its settings provider's `hooks` namespace. User and workspace providers choose the persistence file; changes from a configuration surface or a hand-edited document reconcile without a restart. Each enabled record mounts its dialect's bridge — `@hydraharness/harness-hooks-claude-code` or `@hydraharness/harness-hooks-codex` — which owns payloads, matchers, and extension-point mapping.

## Service API

`list()` projects every stored record with its live status, the events its definitions cover, and how many command hooks they declare. `define(request)` stores one complete definition and converges the mounted set: `mode: 'create'` requires an unused name, and `mode: 'replace'` requires an existing record. These conditions are checked inside the serialized mutation chain, so concurrent creates cannot overwrite one another and an edit cannot recreate a removed record. `setEnabled({ name, enabled })` changes only the desired state. `remove(name)` deletes the record, unmounts it, and deletes any document this registry materialized for it. Every mutation and every reconciliation runs on one serialized chain.

On replacement, omitted `enabled` and `defaultTimeoutMs` retain their stored values. Other omitted optional fields clear the stored values; callers must supply the complete document source, since inline definitions are not returned by `list()`.

`define`, `setEnabled`, and `remove` accept an optional `SettingsProvider` selecting a write layer. They derive records and revisions from that layer's base and stored override, including overrides suppressed by trust; shared writes preserve shared definitions without copying local overrides. Their result remains the effective runtime projection. Removing a shared record retains its materialized document while a local record still runs. `list(settings)` projects desired records, reporting live state only when the running definition matches; `list()` reads effective records. `settle()` awaits queued reconciliation after a settings-layer or trust change.

## Stored records

Registry writes carry the revision read before constructing the next record list. A concurrent settings change rejects the write with `SettingsConflictError` and refreshes the stored projection; retry against that projection. This prevents stale lists from restoring deleted records or discarding another writer's changes.

`hooks.records` is an ordered list of at most 50 records. A record carries `name` (`[A-Za-z0-9_-]{1,64}`, unique across records), `dialect` (`claude-code` or `codex`), exactly one document source, `defaultTimeoutMs`, and `enabled` (default `false`, so a new record is inert until switched on). `claude-code` records may also carry `pluginRoot` and `projectDir`, which the bridge substitutes into command strings.

The document source is either `configPath` — an absolute path, or a path relative to registry `Config.cwd` when supplied — or `config`, inline definitions as a bare event map or a `{ hooks: … }` wrapper. Inline definitions are capped at 256 KiB and materialized to `<hydraHome>/hooks/<name>.json` on every mount, because both bridges read one file path at load; editing the inline section is enough to change what runs.

`define` parses the definitions with the record's own dialect parser before it persists, so a stored record can never be silently inert. At mount time the same parse decides the record's projection: a record whose document is missing, is not valid JSON, or declares nothing its dialect can run is reported with status `invalid` and the reason instead of failing the process — a hand-edited document must not stop every other record from mounting.

`hooks-registry/reconciled` is emitted after each reconciliation settles, carrying the projection. The package invariant checks the registry's one contract on that event: an accepted enabled record is live and a disabled one is not.

Mounts and settings writes use the registry's owning context and registration scope, including calls through an API context. Hooks receive descendant agents' events, including subagent lifecycle events; sibling workspace hooks remain separate. Mounts survive disposal of the API caller. Each workspace registry requires a separate Host-private `hydraHome` for its materialized documents. Definition validation requires at least one supported synchronous command hook, and the inline-document limit measures UTF-8 bytes.

Registry `Config.cwd` is an optional absolute workspace directory. Relative file and substitution paths resolve from it, and the bridge runs commands there. Without it, file paths must be absolute and commands use the agent's session cwd. Unmounting aborts and drains every active hook before reconciliation settles, including blocking prompt/tool hooks; materialized inline files remain under the Host-private home.

## Model Experience

Indirectly, through the bridge a record mounts. `@hydraharness/harness-hooks-claude-code` and `@hydraharness/harness-hooks-codex` own everything a hook injects into a request — `SessionStart` and `UserPromptSubmit` context, `PostToolUse` feedback, `Stop` continuation messages — and this package decides only which of their configurations are live. It assembles no model input of its own.

#### KV Cache effect

Independent of this package's own operations, and consequential through them: mounting a record makes its hooks able to inject context into later requests, which the bridges document. Mounting or unmounting between requests does not itself rewrite an existing prefix; a hook that injects a message appends to the conversation like any other message.

## Known Limitations and Deferred Work

- **One document per bridge mount** — file records are read when the bridge mounts; editing an external hook document requires redefining or toggling the record to reload it.
- **No dialect conversion** — a record is mounted by the dialect it declares; the registry never translates a Claude Code document into Codex spelling or the reverse, and each dialect silently drops events the other supports.

# Workspaces

A workspace is the persistent record of a directory the user works in: a stable id over a canonical path, a display title, and the ordered account of sessions that belong to it. [@hydraharness/harness-workspace](../../packages/workspace/workspace) owns `ctx.workspaceRegistry`, an optional host-side capability that contributes no model tools, prompt text, or session events. It stores its records through the [storage domain form](storage.md) and validates session membership against [`SessionHeader.cwd`](persistence.md#sessionheader--metadata-beside-the-log), so `storageDomain` and `sessionPersistence` are mandatory startup dependencies: an unavailable persistence peer leaves the plugin pending rather than being mistaken for an empty history. Design record: [domain KV storage Agent Note](../../.agents/notes/proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.md); bootstrap and GUI ordering: [Workspace UI product-flow Agent Note](../../.agents/notes/implemented/feature/2026-07-25-workspace-ui-product-flow.md).

Source: [`packages/workspace/workspace/src/types.ts`](../../packages/workspace/workspace/src/types.ts)

## Identity

```ts type-equiv
/**
 * Identifies one workspace record. A generated uuid, never the path: path
 * normalization rewrites paths, and a reference anchor must stay stable.
 */
type WorkspaceId = Branded<'WorkspaceId'>
```

`WorkspaceId` is a [branded id](core.md#branded-ids). Path identity is separate: `realpathNormalize` (`fs.realpath`; trailing slashes, `..`, and symlinks resolved) is the one uniqueness canon — workspace paths are stored canonicalized, uniqueness is string equality of canonical paths (a symlink to an owned directory collides), and attach-time session cwd checks go through the same canon.

## The workspace entity

Consumers see only the `Workspace` interface; the implementation stays package-private.

```ts type-equiv
/**
 * One workspace: a stable id over an existing directory, a display title, and
 * an ordered candidate account of sessions. Membership requires both an id in
 * that account and a session header whose canonical cwd equals the workspace
 * path. Consumers only see this interface; the implementation stays private.
 */
interface Workspace {
  /** A task owns a real directory but is displayed outside project groups; omitted means project. */
  readonly kind?: 'project' | 'task' | undefined
  /** Stable record id (generated uuid). */
  readonly id: WorkspaceId

  /**
   * Canonical directory path: the `fs.realpath` of the path given at create
   * time (trailing slashes, `..`, and symlinks all resolved). Never rewritten
   * afterwards, even when the directory disappears (see {@link status}).
   */
  readonly path: string

  /** Display title. Defaults to `basename(path)` at create; duplicates are allowed. */
  readonly title: string

  /** ISO-8601 creation instant, stamped at create and never rewritten. */
  readonly createdAt: string

  /** ISO-8601 instant of the last durable mutation (create counts as one). */
  readonly updatedAt: string

  /**
   * Header-validated sessions in manually owned order: a new session is
   * prepended at attach, explicit reordering goes through
   * `insertSessionBefore`, and activity never reorders. The durable candidate
   * account is filtered synchronously: missing headers, invalid cwd values,
   * and canonical cwd mismatches are never returned. A subsequent workspace
   * mutation prunes those filtered candidates durably.
   */
  readonly sessionIds: readonly SessionId[]

  /**
   * Replace the display title durably.
   * @param title - New title; any string, duplicates across workspaces allowed.
   * @returns resolution after durability.
   */
  setTitle(title: string): Promise<void>

  /**
   * Prepend a session to this workspace's candidate account. An already
   * accounted id resolves without writing, aside from the durable
   * filtered-candidate prune every accepted mutation performs. A new id's
   * live or persisted
   * header cwd must resolve to an existing directory equal to {@link path};
   * unknown ids, missing or invalid cwd values, and mismatches reject without
   * writing.
   * @param sessionId - The session to record.
   * @returns resolution after durability.
   */
  attachSession(sessionId: SessionId): Promise<void>

  /**
   * Move an accounted session within the manual order, DOM-insertBefore-like:
   * with an anchor the session lands before it, without one it appends to the
   * end. Only the moved id changes position. A session or anchor absent from
   * the account rejects without writing; a move to the current position
   * resolves without writing, aside from the durable filtered-candidate
   * prune every accepted mutation performs; decided on the domain write
   * chain.
   * @param sessionId - The accounted session to move.
   * @param beforeSessionId - Accounted anchor to insert before; omitted appends.
   * @returns resolution after durability.
   */
  insertSessionBefore(sessionId: SessionId, beforeSessionId?: SessionId): Promise<void>

  /**
   * Remove a session from this workspace's account. Idempotent: an id not on
   * the account resolves without writing, aside from the durable
   * filtered-candidate prune every accepted mutation performs; decided on
   * the domain write chain like attach. Never touches the session's own stored log.
   * @param sessionId - The session to remove.
   * @returns resolution after durability.
   */
  detachSession(sessionId: SessionId): Promise<void>

  /**
   * Live directory check, uncached: whether {@link path} currently exists and
   * is a directory. A missing directory never mutates the record — the
   * directory may only be temporarily moved.
   * @returns `'ok'` when the directory exists, `'missing-dir'` otherwise.
   */
  status(): Promise<'ok' | 'missing-dir'>
}
```

Ownership truth is the record's ordered `sessionIds`, never derived from session cwd — but membership requires both: an id on the account and a header whose canonical cwd equals the workspace path, so one session structurally belongs to at most one workspace. Failed writes reject (`insertSessionBefore` account errors as `WorkspaceMoveInvalidError`, storage failures as plain errors); every accepted mutation stamps `updatedAt` and durably prunes candidates that no longer pass the membership check.

## The registry: `ctx.workspaceRegistry`

`WorkspaceRegistry` ([signatures](#ctxworkspaceregistry--workspaceregistry)) owns registration and resolution. `create(path, title?)` canonicalizes the path, rejects a nonexistent path (the original `ENOENT`) or a non-directory, returns the existing entity unchanged when the canonical path is already owned, and otherwise creates a record with `title ?? basename(path)` prepended to the durable registry order — a new record cannot duplicate an existing display title (`WorkspaceNameConflictError`). `get(id)` and the ordered `list()` are synchronous cache reads; `resolveByPath(path)` applies the same realpath canon without creating. `delete(id)` removes only the registration, order entry, and session account — the directory, user files, live sessions, and persisted logs are never touched, so those sessions become Ungrouped ([decision](../../.agents/notes/implemented/feature/2026-07-27-workspace-registration-deletion.md)); unknown ids return `false`. Create and delete persist a pending-mutation marker before their two writes (record + order) can diverge; startup resolves exactly the marked mutation — by deleting the marked table row, which completes an interrupted delete and rolls back an interrupted create (the registration is re-creatable, so rollback is the safe direction) — and an unmarked order/table mismatch fails loud as corruption.

Sessions get their cwd at create time from whoever creates them, not from this registry — the API gateway resolves a new session's cwd from the chosen workspace's `path` (falling back to an explicit or default cwd), creates the session so the cwd lands in its immutable [`SessionHeader`](persistence.md#sessionheader--metadata-beside-the-log), then calls `attachSession`, which re-validates that stored header cwd against the workspace path. On the first successful start, the registry bootstraps history from persisted headers alone (`id`, `cwd`, `createdAt` — never event bodies), grouping sessions with a valid canonical cwd into per-directory workspaces, newest first; the initialized marker is written last so an interrupted bootstrap resumes safely. The bootstrap is one-time: cwd-less legacy sessions stay Ungrouped, and sessions created afterwards join a workspace only through `attachSession`.

## Consumers

[@hydraharness/harness-host-apiproxy](../../packages/host/apiproxy) serves workspace CRUD to GUI clients and performs the create-session-then-attach flow above. [@hydraharness/harness-workspace-config](../../packages/workspace/workspace-config) prepares files before registration and resolves the nearest registered ancestor for session configuration. [@hydraharness/harness-agent-instructions](../../packages/context/agent-instructions) and [@hydraharness/harness-skill-filesystem](../../packages/skill/skill-filesystem) use that resolved root when workspace configuration is composed; they retain their directory discovery behavior without it.

## Workspace configuration

`ctx.workspaceConfig` owns one standing runtime per canonical root and a user-only runtime for sessions without a directory. Each workspace has shared and personal [settings providers](settings.md), scoped MCP and hook registries, and a preset roster. The scope parent order is agent, preset generation, workspace, global; deleting a workspace registration does not dispose its running sessions or files. See the [workspace configuration decision](../../.agents/notes/implemented/architecture/2026-10-09-workspace-local-configuration.md).

Only `permission`, `agent-presets`, `mcp-servers`, and `hooks` participate in project settings. Their resolution adds shared and personal overrides after the global resolved value. Model settings, credentials, provider accounts, and other namespaces remain global. The Host's `workspace-config.trustedRoots` setting enables project layers and preset roots; an untrusted project's raw sections remain editable while effective reads inherit global settings. Revocation disposes project preset generations; re-trusting permits fresh generations for new agents without restoring stopped generations. Instructions and skills do not require execution trust.

```ts type-equiv
/** Workspace document selected for a settings write. */
type WorkspaceConfigLayer = 'shared' | 'local'
```

```ts type-equiv
/** Optional settings target; omission selects the Host user document. */
interface SettingsTarget {
  /** Registered workspace; omitted retains global settings. */
  workspaceId?: WorkspaceId
  /** Workspace document to edit; omitted selects the personal document. */
  layer?: WorkspaceConfigLayer
}
```

```ts type-equiv
/** One canonical directory's standing runtime composition. */
interface WorkspaceEnvironment {
  /** Canonical workspace directory; empty for the user-only environment. */
  readonly root: string
  /** Context resolving workspace settings and runtime services. */
  readonly ctx: Context
  /** Registration scope inherited by workspace preset generations. */
  readonly scopeKey: ScopeKey
  /** Effective composition, user, shared, and local settings provider. */
  readonly settings: SettingsProvider
  /** Workspace-scoped preset roster when presets are composed. */
  readonly presets: AgentPresets | undefined
  /** Host-owned permission to apply project settings and presets. */
  readonly trusted: boolean
}
```

Settings and registry API calls carry `SettingsTarget` rather than a browser-supplied path. Missing targets address global settings; unknown workspace ids reject. `workspace-config/updated` carries the affected workspace and document layer, and `workspace-config/trust-updated` carries its trust decision so clients can refresh only the relevant configuration.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxdirectorypicker--directorypicker-abstract-seam"></a>

### `ctx.directoryPicker` — `DirectoryPicker` (abstract seam)

Abstract directory-picking service. Subclass, implement `capability()`, and load the subclass as a plugin — it registers as `ctx.directoryPicker` (one implementation per context; loading a second throws, cordis' standard duplicate-service behavior). The capability object must be stable for the service lifetime: consumers may capture it across calls.

```ts cordis-catalog
/**
 * The backend's interaction capability.
 * @returns the discriminated capability consumers switch on.
 */
abstract capability(): DirectoryPickerCapability
```

Source: [`packages/host/directory-picker/src/index.ts`](../../packages/host/directory-picker/src/index.ts)

<a id="ctxworkspaceconfig--workspaceconfigservice"></a>

### `ctx.workspaceConfig` — `WorkspaceConfigService`

Workspace-local settings and runtime services retained until the Host unloads.

```ts cordis-catalog
/**
 * Initialize a canonical workspace directory without overwriting existing files.
 * @param cwd - Existing directory to prepare as a workspace root.
 * @returns the canonical directory after every required file exists.
 */
async initialize(cwd: string): Promise<string>

/**
 * Resolve the nearest registered canonical ancestor, otherwise the cwd itself.
 * @param cwd - Existing session or workspace directory.
 * @returns the canonical workspace root.
 */
async resolveRoot(cwd: string): Promise<string>

/**
 * Resolve or construct the directory's isolated settings and runtime composition.
 * A failed construction is removed so corrected files can be retried.
 * @param cwd - Existing workspace or session directory.
 * @returns the standing environment for its canonical workspace root.
 */
async environment(cwd: string): Promise<WorkspaceEnvironment>

/**
 * Read an already prepared environment without filesystem work.
 * @param cwd - Previously resolved directory spelling or canonical descendant.
 * @returns its cached environment, or undefined before preparation.
 */
currentEnvironment(cwd: string): WorkspaceEnvironment | undefined

/**
 * Read the user-only runtime environment for consumers without a directory.
 * @returns the initialized user environment.
 */
userEnvironment(): WorkspaceEnvironment

/**
 * Resolve an exact registered workspace without accepting browser-supplied paths.
 * @param workspaceId - Existing workspace registration.
 * @returns its isolated environment.
 * @throws If the workspace identity is not registered or its directory cannot be initialized.
 */
async environmentFor(workspaceId: WorkspaceId): Promise<WorkspaceEnvironment>

/**
 * Select a registered workspace's editable settings document.
 * @param workspaceId - Existing workspace registration.
 * @param layer - Shared or personal document; omitted selects personal settings.
 * @returns the provider retaining that document's raw overrides.
 * @throws If the workspace identity is not registered or its directory cannot be initialized.
 */
async settingsFor(workspaceId: WorkspaceId, layer: WorkspaceConfigLayer = 'local'): Promise<SettingsProvider>

/**
 * Read a Host-owned trust decision without loading project code.
 * @param workspaceId - Existing workspace registration.
 * @returns whether its canonical root is trusted.
 * @throws If the workspace identity is not registered.
 */
isTrusted(workspaceId: WorkspaceId): boolean

/**
 * Distinguish an unanswered trust prompt from an explicit denial or revocation.
 * @param workspaceId - Existing workspace registration.
 * @returns whether the Host stores a decision for its canonical root.
 * @throws If the workspace identity is not registered.
 */
hasTrustDecision(workspaceId: WorkspaceId): boolean

/**
 * Commit trust on the Host and converge the workspace runtime before returning.
 * @param workspaceId - Existing workspace registration.
 * @param trusted - Apply project settings and presets until explicitly revoked.
 * @returns completion after the Host decision persists and runtime reconciliation settles.
 * @throws If the workspace is unknown, persistence fails, or its runtime cannot reconcile.
 */
async setTrusted(workspaceId: WorkspaceId, trusted: boolean): Promise<void>

/**
 * Detect project overrides or preset compositions that require a trust decision.
 * @param workspaceId - Existing workspace registration.
 * @returns whether shared/personal settings or a preset composition is present.
 * @throws If the workspace is unknown or a configuration path cannot be read.
 */
async hasProjectConfig(workspaceId: WorkspaceId): Promise<boolean>
```

Types: [SettingsProvider](settings.md)

Source: [`packages/workspace/workspace-config/src/index.ts`](../../packages/workspace/workspace-config/src/index.ts)

<a id="ctxworkspaceregistry--workspaceregistry"></a>

### `ctx.workspaceRegistry` — `WorkspaceRegistry`

Durable workspace registry. Startup waits for `sessionPersistence`, builds one canonical-cwd header index, and completes the one-time history bootstrap before the service becomes active. The persistence dependency is mandatory so an unavailable peer can never be mistaken for an empty history and commit the initialized marker.

```ts cordis-catalog
/**
 * Create a distinct validated directory for a chat outside projects; later root changes affect only new tasks.
 * @returns the task workspace, retained for Files and Terminal ownership.
 */
async createTask(): Promise<Workspace>

/**
 * Create or reuse a workspace for an existing directory. The path is
 * canonicalized through `fs.realpath`; a nonexistent path rejects with the
 * original error and a non-directory rejects. Repeated calls for the same
 * canonical path return the existing entity without changing its title.
 * A newly created workspace is prepended to the durable registry order.
 * Different canonical paths may share a display title.
 * Workspace preparation listeners run before registration writes, including
 * when the canonical path already has a record; a rejected listener aborts creation.
 * @param path - Existing directory to own, in any path spelling.
 * @param title - Display title used only when a new record is created.
 * @returns the existing or newly durable workspace.
 */
async create(path: string, title?: string): Promise<Workspace>

/**
 * Look up a workspace by id.
 * @param id - Workspace id.
 * @returns the workspace, or `undefined` when unknown.
 */
get(id: WorkspaceId): Workspace | undefined

/**
 * Synchronous workspace projection in durable registry order. Every
 * entity's `sessionIds` getter is already filtered by the startup/live
 * canonical-cwd header index; this method performs no persistence reads.
 * @returns a fresh ordered array of workspace entities.
 */
list(): Workspace[]

/**
 * Delete one workspace registration while retaining its directory and every
 * session log. The durable order is updated before the table deletion; a
 * failed table write restores the prior order and keeps the entity
 * published. Unknown ids are an idempotent no-op for domain callers.
 * @param id - Workspace registration to remove.
 * @returns `true` when a record was deleted, `false` when it was unknown.
 */
delete(id: WorkspaceId): Promise<boolean>

/**
 * Move one workspace within the durable display order, DOM-insertBefore-like.
 * With an anchor it lands before that workspace; without one it appends.
 * @param id - Workspace to move.
 * @param beforeId - Workspace anchor; omitted appends.
 * @returns the complete committed workspace order.
 */
insertBefore(id: WorkspaceId, beforeId?: WorkspaceId): Promise<readonly WorkspaceId[]>

/**
 * Archive one session durably. The session must exist (live or in session
 * persistence); its workspace accounting — or lack of one — is irrelevant.
 * An already archived id resolves without writing.
 * @param sessionId - The session to archive.
 * @returns resolution after durability.
 */
archiveSession(sessionId: SessionId): Promise<void>

/**
 * Restore one session from the registry-global archive set. The session's
 * workspace accounting is retained while archived, so removing the id from
 * the set restores it to its previous workspace and position.
 * An id that is not archived resolves without writing.
 * @param sessionId - The session to restore.
 * @returns resolution after durability.
 */
unarchiveSession(sessionId: SessionId): Promise<void>

/**
 * Remove a deleted session from every Workspace and the archive set.
 * @param sessionId - permanently deleted session identity.
 */
removeSession(sessionId: SessionId): Promise<void>

/**
 * Resolve by canonical directory path without creating or mutating a
 * workspace. A missing path rejects during `realpath`; an existing unowned
 * directory returns `undefined`.
 * @param path - Existing directory path in any spelling.
 * @returns the workspace owning the canonical path, when one exists.
 */
async resolveByPath(path: string): Promise<Workspace | undefined>
```

Types: [SessionId](core.md)

Source: [`packages/workspace/workspace/src/index.ts`](../../packages/workspace/workspace/src/index.ts)

<a id="workspace-events"></a>

### `workspace/*` events

<a id="workspacepre-create--parallel"></a>

#### `workspace/pre-create` — parallel

Prepare workspace-owned resources before creating or reusing a registration. A rejected listener prevents durable registration and entity publication.

```ts cordis-catalog
/**
 * Prepare workspace-owned resources before creating or reusing a registration.
 * A rejected listener prevents durable registration and entity publication.
 * @param path - Canonical existing workspace directory.
 * @mode parallel
 */
'workspace/pre-create'(path: string): Promise<void>
```

Source: [`packages/workspace/workspace/src/types.ts`](../../packages/workspace/workspace/src/types.ts)

<a id="workspace-config-events"></a>

### `workspace-config/*` events

<a id="workspace-configtrust-updated--emit"></a>

#### `workspace-config/trust-updated` — emit

The Host committed a workspace trust decision.

```ts cordis-catalog
/**
 * The Host committed a workspace trust decision.
 * @param workspaceId - Registered workspace owning the canonical root.
 * @param trusted - Whether project execution is permitted.
 * @mode emit
 */
'workspace-config/trust-updated'(workspaceId: WorkspaceId, trusted: boolean): void
```

Source: [`packages/workspace/workspace-config/src/types.ts`](../../packages/workspace/workspace-config/src/types.ts)

<a id="workspace-configupdated--emit"></a>

#### `workspace-config/updated` — emit

A workspace settings document or its inherited value changed.

```ts cordis-catalog
/**
 * A workspace settings document or its inherited value changed.
 * @param workspaceId - Registered workspace owning the configuration.
 * @param layer - Shared or personal document affected by the update.
 * @mode emit
 */
'workspace-config/updated'(workspaceId: WorkspaceId, layer: WorkspaceConfigLayer): void
```

Source: [`packages/workspace/workspace-config/src/types.ts`](../../packages/workspace/workspace-config/src/types.ts)
<!-- END GENERATED cordis-surface -->

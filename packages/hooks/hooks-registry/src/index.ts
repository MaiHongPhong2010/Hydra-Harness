/**
 * User-declared hook records: one settings-backed registry that mounts every
 * enabled record on its dialect's bridge (`@hydraharness/harness-hooks-claude-code` or
 * `@hydraharness/harness-hooks-codex`) and unmounts it when the record is disabled,
 * redefined, or removed. The stored document (`hooks.records` in the harness
 * settings file) is the only source of truth, so a hook added from a
 * configuration surface survives a restart and one added by hand-editing that
 * document mounts without one.
 *
 * A record either points at an existing hook document (`configPath`) or carries
 * its definitions inline. Inline definitions are materialized under the harness
 * home, because both bridges read one file path at load.
 * @module @hydraharness/harness-hooks-registry
 */

import type {} from '@hydraharness/harness-optional-plugins'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { Service, type Context, type Fiber } from '@hydraharness/cordis'
import z from '@hydraharness/schemastery'
import { writeFileAtomic } from '@hydraharness/harness-atomic-write'
import { resolveHydraHome } from '@hydraharness/harness-home-paths'
import { settingsNamespace, type SettingsProvider, type SettingsScope } from '@hydraharness/harness-settings'
import {
  apply as applyClaudeCodeHooks, inject as claudeCodeInject,
} from '@hydraharness/harness-hooks-claude-code'
import { apply as applyCodexHooks, inject as codexInject } from '@hydraharness/harness-hooks-codex'
import { parseClaudeCodeConfig } from '@hydraharness/harness-hooks-claude-code/config'
import { parseCodexConfig } from '@hydraharness/harness-hooks-codex/config'
import type {
  HookDialect, HookRecordDefinitionRequest, HookRecordEnablementRequest, HookRecordSnapshot,
  HookRecordStatus, HookRecordView, HookSourceKind,
} from './types.ts'
import type { JsonValue } from '@hydraharness/harness-session/types'

export type * from './types.ts'

declare module '@hydraharness/cordis' {
  interface Context {
    /** User-declared hook records and their live bridge mounts. */
    hookRecords: HookRecordRegistry
  }
}

/** Settings namespace holding every user-declared hook record. */
export const HOOKS_SETTINGS_NAMESPACE = settingsNamespace('hooks')

/** Accepted record name. */
const RECORD_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u
const MAX_RECORDS = 50
const MAX_INLINE_BYTES = 256 * 1024
const DEFAULT_HOOK_TIMEOUT_MS = 600_000

/** Registry configuration. */
export interface Config {
  /** Override the resolved harness home that holds materialized inline documents. */
  hydraHome?: string
  /** Absolute workspace directory for relative document paths and hook commands. */
  cwd?: string
}

/** One stored record, as the settings document holds it. */
interface StoredRecord {
  name: string
  dialect: HookDialect
  configPath: string
  config: Record<string, JsonValue>
  pluginRoot: string
  projectDir: string
  defaultTimeoutMs: number
  enabled: boolean
}

/** The namespace section: an ordered record list. */
interface HooksSettings {
  records: StoredRecord[]
}

const StoredRecordSchema: z<StoredRecord> = z.object({
  name: z.string().required(),
  dialect: z.union([z.const('claude-code'), z.const('codex')]).default('claude-code'),
  configPath: z.string().default(''),
  // Inline definitions stay opaque to the schema: each dialect owns its own
  // document grammar, and both parsers already refuse what they cannot run.
  config: z.dict(z.any()).default({}),
  pluginRoot: z.string().default(''),
  projectDir: z.string().default(''),
  defaultTimeoutMs: z.number().step(1).min(1).default(DEFAULT_HOOK_TIMEOUT_MS),
  enabled: z.boolean().default(false),
})

const HooksSettingsSchema: z<HooksSettings> = z.object({
  records: z.array(StoredRecordSchema).max(MAX_RECORDS).default([]),
})

/** Which document source a stored record declares. */
function sourceKind(record: StoredRecord): HookSourceKind {
  return record.configPath === '' ? 'inline' : 'file'
}

/**
 * Reject a definition this registry could not mount. Every check answers a
 * constraint the schema cannot express: the name grammar, that exactly one
 * document source is declared, that a path is absolute, and that inline
 * definitions stay inside the document budget.
 * @param record - one stored record to judge.
 * @param label - operation name used in the diagnostic.
 */
function assertMountable(record: StoredRecord, label: string, cwd?: string): void {
  if (!RECORD_NAME_PATTERN.test(record.name)) {
    throw new Error(`${label}: record name must match ${String(RECORD_NAME_PATTERN)}`)
  }
  const inline = Object.keys(record.config).length > 0
  if (record.configPath === '' && !inline) {
    throw new Error(`${label}: record ${record.name} needs either a configPath or inline hook definitions`)
  }
  if (record.configPath !== '' && inline) {
    throw new Error(`${label}: record ${record.name} declares both a configPath and inline hook definitions`)
  }
  if (record.configPath !== '' && !isAbsolute(record.configPath) && cwd === undefined) {
    throw new Error(`${label}: record ${record.name} configPath must be absolute`)
  }
  if (inline && Buffer.byteLength(JSON.stringify(record.config), 'utf8') > MAX_INLINE_BYTES) {
    throw new Error(`${label}: record ${record.name} inline hooks exceed ${String(MAX_INLINE_BYTES)} bytes`)
  }
  if (record.dialect === 'codex' && (record.pluginRoot !== '' || record.projectDir !== '')) {
    throw new Error(`${label}: record ${record.name} substitution roots apply to claude-code records only`)
  }
}

/** Reject a stored section whose records collide, so no mount silently wins. */
function assertUniqueNames(settings: HooksSettings): void {
  const seen = new Set<string>()
  for (const record of settings.records) {
    if (seen.has(record.name)) {
      throw new Error(`hookRecords: record name ${JSON.stringify(record.name)} is declared more than once`)
    }
    seen.add(record.name)
  }
}

/**
 * Parse one document with its dialect's parser, so what the registry reports is
 * exactly what the bridge will run.
 * @param dialect - the record's config dialect.
 * @param raw - parsed JSON document.
 * @returns the event names covered and the total command-hook count.
 */
function summarize(dialect: HookDialect, raw: unknown): { events: string[]; hookCount: number } {
  const parsed = dialect === 'claude-code' ? parseClaudeCodeConfig(raw) : parseCodexConfig(raw)
  const events = Object.keys(parsed.config).sort()
  let hookCount = 0
  for (const groups of Object.values(parsed.config)) {
    for (const group of groups) hookCount += group.hooks.length
  }
  if (hookCount === 0) throw new Error(`hookRecords: ${dialect} document contains no supported synchronous command hooks`)
  return { events, hookCount }
}

/**
 * Fold one write request onto the record it replaces. Every field is restated
 * by the caller: unlike a credential, nothing here is withheld from a read, so
 * an omission is a deliberate clear.
 * @param request - complete definition supplied by the caller.
 * @param previous - the record being replaced, when one exists.
 * @returns the next stored record.
 */
function foldDefinition(
  request: HookRecordDefinitionRequest,
  previous: StoredRecord | undefined,
): StoredRecord {
  return {
    name: request.name.trim(),
    dialect: request.dialect,
    configPath: (request.configPath ?? '').trim(),
    config: { ...request.config },
    pluginRoot: (request.pluginRoot ?? '').trim(),
    projectDir: (request.projectDir ?? '').trim(),
    defaultTimeoutMs: request.defaultTimeoutMs ?? previous?.defaultTimeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS,
    enabled: request.enabled ?? previous?.enabled ?? false,
  }
}

/** Services required by the registry; the bridges themselves need `shell`. */
export const inject = ['settings', 'shell']

/** One live bridge mount, the definition it was started from, and what it runs. */
interface LiveMount {
  readonly fiber: Fiber
  readonly digest: string
  readonly events: readonly string[]
  readonly hookCount: number
  status: 'started' | 'failed'
  detail?: string
}

/**
 * Settings-backed hook records with their live bridge mounts. Reconciliation is
 * idempotent and runs on one serialized chain, so a document commit from any
 * source — this service's own write, another process, or a hand edit —
 * converges the mounted set on the stored one.
 * Mutations reject with `SettingsConflictError` if another writer changes the
 * stored section after the read; retry uses the refreshed projection.
 */
export class HookRecordRegistry extends Service {
  static inject = inject
  /** Bridge mounts belong to this Host service, not to a traced API caller. */
  private readonly owner: Context
  static Config: z<Config> = z.object({
    hydraHome: z.string(),
    cwd: z.string(),
  })

  private readonly settings: SettingsScope<HooksSettings>
  private readonly live = new Map<string, LiveMount>()
  /** Stored records this registry refuses to mount, with the refusal reason. */
  private readonly invalid = new Map<string, string>()
  /** Directory holding the documents materialized from inline definitions. */
  private readonly inlineRoot: string
  private readonly cwd: string | undefined
  private tail: Promise<unknown> = Promise.resolve()
  private stopped = false

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'hookRecords')
    if (config.cwd !== undefined && !isAbsolute(config.cwd)) throw new Error('hookRecords: cwd must be absolute')
    this.owner = ctx
    this.cwd = config.cwd
    this.inlineRoot = join(resolveHydraHome(config.hydraHome), 'hooks')
    this.settings = ctx.settings.register(HOOKS_SETTINGS_NAMESPACE, HooksSettingsSchema, {
      // Refuse a colliding section where it is written: two records claiming
      // one name would make which definitions run depend on mount order.
      validate: assertUniqueNames,
    })
  }

  protected async [Service.init](): Promise<void> {
    this.ctx.inject(['optionalPlugins'], (pctx) => {
      pctx.effect(() => pctx.optionalPlugins.subscribe((enabled) => {
        void this.enqueue(async () => {
          if (!enabled) await pctx.optionalPlugins.drain()
          if (pctx.optionalPlugins.enabled === enabled) await this.reconcile()
        }).catch((error: unknown) => { this.ctx.logger.error(error) })
      }), 'hooks-registry: optional policy')
    })
    this.ctx.effect(() => () => this.shutdown(), 'hookRecords.dispose')
    this.ctx.effect(
      () => this.settings.watch(() => this.enqueue(() => this.reconcile())),
      'hookRecords.settingsWatch',
    )
    await this.enqueue(() => this.reconcile())
  }

  /**
   * Project every stored record with its live state.
   * @param settings - optional layer whose desired records to project.
   * @returns the current record projection, in stored order.
   */
  list(settings?: SettingsProvider): HookRecordSnapshot {
    const records = settings === undefined ? this.settings.get().records : this.writeSource(settings).records
    return { records: records.map(record => this.view(record)) }
  }

  /**
   * Reconcile the current effective settings after a layer or trust change.
   * @returns completion after earlier queued work and the current mounts settle.
   */
  settle(): Promise<void> {
    return this.enqueue(() => this.reconcile())
  }

  /**
   * Create or replace one complete definition as requested, then
   * converge the mounted set. A definition this registry could not mount is
   * refused before anything persists.
   * @param request - complete record definition.
   * @param settings - selected write layer; omitted uses this registry's provider.
   * @returns the refreshed projection.
   * @throws If create names an existing record or replace names a missing record.
   */
  define(request: HookRecordDefinitionRequest, settings: SettingsProvider = this.owner.settings): Promise<HookRecordSnapshot> {
    return this.enqueue(async () => {
      const { revision, records } = this.writeSource(settings)
      const index = records.findIndex(candidate => candidate.name === request.name.trim())
      if (request.mode === 'create' && index !== -1) throw new Error(`hookRecords.define: record ${request.name} already exists`)
      if (request.mode === 'replace' && index === -1) throw new Error(`hookRecords.define: record ${request.name} is not configured`)
      const record = foldDefinition(request, index === -1 ? undefined : records[index])
      assertMountable(record, 'hookRecords.define', this.cwd)
      // The dialect parser is the authority on whether these definitions run;
      // refusing here means a stored record can never be silently inert.
      summarize(record.dialect, await this.readDefinitions(record))
      const next = index === -1
        ? [...records, record]
        : records.map((candidate, position) => position === index ? record : candidate)
      if (next.length > MAX_RECORDS) throw new Error(`hookRecords.define: at most ${String(MAX_RECORDS)} records are supported`)
      await settings.update(HOOKS_SETTINGS_NAMESPACE, { records: next }, revision)
      await this.reconcile()
      return this.list()
    })
  }

  /**
   * Change one stored record's desired state.
   * @param request - target record and desired state.
   * @param settings - selected write layer; omitted uses this registry's provider.
   * @returns the refreshed projection.
   */
  setEnabled(request: HookRecordEnablementRequest, settings: SettingsProvider = this.owner.settings): Promise<HookRecordSnapshot> {
    return this.enqueue(async () => {
      const { revision, records } = this.writeSource(settings)
      const index = records.findIndex(candidate => candidate.name === request.name)
      if (index === -1) throw new Error(`hookRecords.setEnabled: record ${request.name} is not configured`)
      const next = records.map((candidate, position) => position === index
        ? { ...candidate, enabled: request.enabled }
        : candidate)
      await settings.update(HOOKS_SETTINGS_NAMESPACE, { records: next }, revision)
      await this.reconcile()
      return this.list()
    })
  }

  /**
   * Remove one stored record, unmount it, and delete any document this registry
   * materialized for it.
   * @param name - stored record name.
   * @param settings - selected write layer; omitted uses this registry's provider.
   * @returns the refreshed projection.
   */
  remove(name: string, settings: SettingsProvider = this.owner.settings): Promise<HookRecordSnapshot> {
    return this.enqueue(async () => {
      const { revision, records } = this.writeSource(settings)
      if (!records.some(candidate => candidate.name === name)) {
        throw new Error(`hookRecords.remove: record ${name} is not configured`)
      }
      await settings.replace(HOOKS_SETTINGS_NAMESPACE, { records: records.filter(candidate => candidate.name !== name) }, revision)
      await this.reconcile()
      if (!this.settings.get().records.some(record => record.name === name)) {
        await rm(this.inlinePath(name), { force: true })
      }
      return this.list()
    })
  }

  /** Read the selected layer's desired records, including overrides suppressed by trust. */
  private writeSource(settings: SettingsProvider): HooksSettings & { revision: number } {
    const descriptor = settings.describe().find(section => section.ns === HOOKS_SETTINGS_NAMESPACE)
    if (descriptor === undefined) throw new Error('hookRecords: selected settings provider has no hooks namespace')
    return {
      ...HooksSettingsSchema({
        records: (descriptor.user as Partial<HooksSettings> | undefined)?.records
          ?? (descriptor.base as Partial<HooksSettings> | undefined)?.records ?? [],
      }),
      revision: descriptor.revision,
    }
  }

  /* jscpd:ignore-start -- hook and MCP registries intentionally share serialized reconciliation. */
  /** Serialize every mutation and reconciliation on one chain. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(task, task)
    this.tail = run.then(() => undefined, () => undefined)
    return run
  }

  /**
   * Converge the mounted set on the stored one: unmount every record that is
   * gone, disabled, or redefined, then mount every enabled record that is not
   * already live from the same definition. A record whose document is missing,
   * unparseable, or refused by its dialect is recorded as `invalid` with the
   * diagnostic and does not stop the others.
   */
  private async reconcile(): Promise<void> {
    if (this.stopped) return
    const records = new Map(this.settings.get().records.map(record => [record.name, record]))
    this.invalid.clear()
    for (const [name, mount] of [...this.live]) {
      const record = records.get(name)
      if (this.ctx.get('optionalPlugins')?.enabled !== false && record?.enabled === true && recordDigest(record) === mount.digest) continue
      this.live.delete(name)
      await disposeQuietly(mount.fiber)
    }
    for (const record of records.values()) {
      if (this.ctx.get('optionalPlugins')?.enabled === false || !record.enabled || this.live.has(record.name)) continue
      await this.mount(record)
    }
    // The projection is published only after every mount settled, so an
    // observer cannot read a record whose bridge is still loading.
    this.ctx.emit('hooks-registry/reconciled', this.list())
  }
  /* jscpd:ignore-end */

  /**
   * Materialize the record's document when it is inline, then start its
   * dialect's bridge. A refusal is stored as `invalid` rather than thrown: a
   * hand-edited document must not stop every other record from mounting.
   */
  private async mount(record: StoredRecord): Promise<void> {
    let configPath: string
    let summary: { events: string[]; hookCount: number }
    try {
      assertMountable(record, 'hookRecords', this.cwd)
      configPath = await this.materialize(record)
      summary = summarize(record.dialect, await this.readDefinitions(record))
    } catch (error) {
      /* v8 ignore next -- validation, JSON parsing, and local filesystem operations throw Error instances. */
      this.invalid.set(record.name, error instanceof Error ? error.message : String(error))
      return
    }
    const fiber = record.dialect === 'claude-code'
      ? this.owner.plugin({
        name: `hook-record:${record.name}`,
        inject: claudeCodeInject,
        apply: applyClaudeCodeHooks,
      }, {
        configPath,
        defaultTimeoutMs: record.defaultTimeoutMs,
        ...this.cwd === undefined ? {} : { cwd: this.cwd },
        ...record.pluginRoot === '' ? {} : { pluginRoot: this.documentPath(record.pluginRoot) },
        ...record.projectDir === '' ? {} : { projectDir: this.documentPath(record.projectDir) },
      })
      : this.owner.plugin({
        name: `hook-record:${record.name}`,
        inject: codexInject,
        apply: applyCodexHooks,
      }, {
        configPath,
        defaultTimeoutMs: record.defaultTimeoutMs,
        ...this.cwd === undefined ? {} : { cwd: this.cwd },
      })
    const mount: LiveMount = {
      fiber,
      digest: recordDigest(record),
      events: summary.events,
      hookCount: summary.hookCount,
      status: 'started',
    }
    this.live.set(record.name, mount)
    try {
      await fiber
    } catch (error) {
      mount.status = 'failed'
      /* v8 ignore next -- Cordis normalizes plugin failures to Error before fiber.await rejects. */
      mount.detail = error instanceof Error ? error.message : String(error)
    }
  }

  /**
   * Resolve the document path the bridge reads: a `file` record's own path, or
   * the harness-home document this registry writes from inline definitions.
   * Materialization is idempotent and re-runs per mount, so an edited inline
   * section always reaches the bridge.
   */
  private async materialize(record: StoredRecord): Promise<string> {
    if (sourceKind(record) === 'file') return this.documentPath(record.configPath)
    const path = this.inlinePath(record.name)
    await mkdir(this.inlineRoot, { recursive: true, mode: 0o700 })
    await writeFileAtomic(path, `${JSON.stringify(record.config, undefined, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
    return path
  }

  /** Read one record's raw definitions, from its file or its inline section. */
  private async readDefinitions(record: StoredRecord): Promise<unknown> {
    if (sourceKind(record) === 'inline') return record.config
    let text: string
    try {
      text = await readFile(this.documentPath(record.configPath), 'utf8')
    } catch (cause) {
      throw new Error(`hookRecords: record ${record.name} cannot read ${record.configPath}`, { cause })
    }
    try {
      return JSON.parse(text) as unknown
    } catch (cause) {
      throw new Error(`hookRecords: record ${record.name} document is not valid JSON`, { cause })
    }
  }

  /** Path of the document this registry materializes for one inline record. */
  private inlinePath(name: string): string {
    return join(this.inlineRoot, `${name}.json`)
  }

  /** Resolve a read-only document or substitution path inside the owning cwd. */
  private documentPath(path: string): string {
    return this.cwd === undefined ? path : resolve(this.cwd, path)
  }

  /** Project one stored record with its live state. */
  private view(record: StoredRecord): HookRecordView {
    const candidate = this.live.get(record.name)
    const digest = recordDigest(record)
    const mount = candidate?.digest === digest ? candidate : undefined
    const effective = this.settings.get().records.find(hook => hook.name === record.name)
    const invalid = effective !== undefined && recordDigest(effective) === digest ? this.invalid.get(record.name) : undefined
    const status: HookRecordStatus = invalid !== undefined
      ? 'invalid'
      : !record.enabled ? 'stopped' : mount?.status ?? 'stopped'
    const detail = invalid ?? mount?.detail
    return {
      name: record.name,
      dialect: record.dialect,
      source: sourceKind(record),
      enabled: record.enabled,
      status,
      ...detail === undefined || status === 'stopped' ? {} : { detail },
      ...sourceKind(record) === 'file' ? { configPath: record.configPath } : {},
      events: mount?.events ?? [],
      hookCount: mount?.hookCount ?? 0,
      ...record.pluginRoot === '' ? {} : { pluginRoot: record.pluginRoot },
      ...record.projectDir === '' ? {} : { projectDir: record.projectDir },
    }
  }

  /* jscpd:ignore-start -- hook and MCP shutdowns intentionally share teardown semantics. */
  /** Refuse new work, then unmount every live record. */
  private async shutdown(): Promise<void> {
    this.stopped = true
    /* v8 ignore next -- enqueue stores a fulfilled tail after either task outcome. */
    await this.tail.catch(() => undefined)
    this.invalid.clear()
    for (const [name, mount] of [...this.live]) {
      this.live.delete(name)
      await disposeQuietly(mount.fiber)
    }
  }
  /* jscpd:ignore-end */
}

/**
 * Digest of everything a mount is started from, so reconciliation can tell a
 * redefined record from an untouched one without restarting a live bridge on
 * every unrelated document commit. The desired state is excluded: enablement is
 * handled by mount and unmount, not by a restart.
 */
function recordDigest(record: StoredRecord): string {
  const { enabled: _desired, ...definition } = record
  return JSON.stringify(definition)
}

/**
 * Unmount one bridge and swallow its teardown failure. The record it served is
 * already out of the live map, so a disposal error cannot restore it, and
 * letting it escape would strand every later record in the same reconcile.
 * @param fiber - the mount to tear down.
 */
async function disposeQuietly(fiber: Fiber): Promise<void> {
  try {
    await fiber.dispose()
  } catch (_hookMountTeardownFailure) {
    // The fiber is inactive either way; nothing here can act on the failure.
  }
}

export default HookRecordRegistry

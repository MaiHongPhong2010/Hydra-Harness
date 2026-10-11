/**
 * User-declared MCP servers: one settings-backed registry that mounts every
 * enabled record as an `@hydraharness/harness-mcp-client` fiber and unmounts it when the
 * record is disabled, redefined, or removed. The stored document
 * (`mcp-servers.servers` in the harness settings file) is the only source of
 * truth, so a server added from a configuration surface survives a restart and
 * a server added by hand-editing the document mounts without one.
 * @module @hydraharness/harness-mcp-registry
 */

import type {} from '@hydraharness/harness-optional-plugins'
import { isAbsolute, resolve } from 'node:path'
import { Service, type Context, type Fiber } from '@hydraharness/cordis'
import z from '@hydraharness/schemastery'
import { settingsNamespace, type SettingsProvider, type SettingsScope } from '@hydraharness/harness-settings'
import { scopeOf } from '@hydraharness/harness-scope'
import {
  apply as applyMcpClient, inject as mcpClientInject, type Config as McpClientConfig,
} from '@hydraharness/harness-mcp-client'
// Side-effect type import: declaration-merges `ctx.tools` onto Context.
import type {} from '@hydraharness/harness-tools'
import type {
  McpServerDefinitionRequest, McpServerEnablementRequest, McpServerSnapshot,
  McpServerStatus, McpServerTransport, McpServerView,
} from './types.ts'

export type * from './types.ts'

declare module '@hydraharness/cordis' {
  interface Context {
    /** User-declared MCP server records and their live mounts. */
    mcpServers: McpServerRegistry
  }
}

/** Settings namespace holding every user-declared MCP server record. */
export const MCP_SERVERS_SETTINGS_NAMESPACE = settingsNamespace('mcp-servers')

/** Accepted record name, kept inside the MCP tool-name budget. */
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/u
const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60_000
const MAX_SERVERS = 50
const MAX_ARGS = 64
const MAX_VALUE_LENGTH = 4_096

/** Remove URL credentials, query and fragment before projecting an endpoint. */
function redactUrlUserinfo(value: string): string {
  // Strip a leading userinfo segment before parsing. URL accepts values such as
  // `user:password@host` as a custom-scheme URL, so parsing first would echo it.
  const withoutUserinfo = value.replace(/^((?:[a-z][a-z\d+.-]*:)?\/\/)?[^/?#@]*@/iu, '$1')
  try {
    const parsed = new URL(withoutUserinfo)
    parsed.username = ''
    parsed.password = ''
    parsed.search = ''
    parsed.hash = ''
    return parsed.toString()
  } catch {
    // Malformed endpoints can still contain credential query/fragment values.
    return withoutUserinfo.replace(/[?#][\s\S]*$/u, '')
  }
}

/** Owning directory used by workspace server processes. */
export interface Config {
  /** Absolute directory for omitted or relative record working directories. */
  cwd?: string
}

/** One stored record, as the settings document holds it. */
interface StoredServer {
  name: string
  transport: McpServerTransport
  command: string
  args: string[]
  env: Record<string, string>
  cwd: string
  url: string
  headers: Record<string, string>
  toolCallTimeoutMs: number
  enabled: boolean
}

/** The namespace section: an ordered record list. */
interface McpServersSettings {
  servers: StoredServer[]
}

const StoredServerSchema: z<StoredServer> = z.object({
  name: z.string().required(),
  transport: z.union([z.const('stdio'), z.const('streamable-http')]).default('stdio'),
  command: z.string().default(''),
  args: z.array(z.string()).max(MAX_ARGS).default([]),
  // Child-environment and header values are credential-shaped by nature, so
  // the whole map is a secret position: it never rides a redacted descriptor,
  // and the registry's own writes preserve what the document already holds.
  env: z.dict(z.string()).role('secret').default({}),
  cwd: z.string().default(''),
  // An endpoint may carry credentials in legacy userinfo or a query string;
  // keep the whole URL out of generic settings descriptors, while the registry
  // projection still exposes a credential-free endpoint to its dedicated UI.
  url: z.string().role('secret').default(''),
  headers: z.dict(z.string()).role('secret').default({}),
  toolCallTimeoutMs: z.number().step(1).min(1).default(DEFAULT_TOOL_CALL_TIMEOUT_MS),
  enabled: z.boolean().default(false),
})

const McpServersSettingsSchema: z<McpServersSettings> = z.object({
  servers: z.array(StoredServerSchema).max(MAX_SERVERS).default([]),
})

/**
 * Reject a definition this registry could not mount. Every check answers a
 * constraint the schema cannot express — which fields one transport requires,
 * and that a name is unique across records.
 * @param record - one stored record to judge.
 * @param label - operation name used in the diagnostic.
 */
function assertMountable(record: StoredServer, label: string): void {
  if (!SERVER_NAME_PATTERN.test(record.name)) {
    throw new Error(`${label}: server name must match ${String(SERVER_NAME_PATTERN)}`)
  }
  if (record.transport === 'stdio') {
    if (record.command.trim() === '') throw new Error(`${label}: stdio server ${record.name} requires a command`)
    if (record.url !== '') throw new Error(`${label}: stdio server ${record.name} cannot carry a url`)
  } else {
    if (record.url.trim() === '') throw new Error(`${label}: streamable-http server ${record.name} requires a url`)
    if (record.command !== '') throw new Error(`${label}: streamable-http server ${record.name} cannot carry a command`)
    let parsed: URL
    try {
      parsed = new URL(record.url)
    } catch (cause) {
      throw new Error(`${label}: server ${record.name} url is not absolute`, { cause })
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`${label}: server ${record.name} url must use HTTP or HTTPS`)
    }
    if (parsed.username !== '' || parsed.password !== '') {
      throw new Error(`${label}: server ${record.name} url must not include username or password`)
    }
  }
  for (const [field, entries] of [['env', record.env], ['headers', record.headers]] as const) {
    for (const [key, value] of Object.entries(entries)) {
      if (key.trim() === '' || value.length > MAX_VALUE_LENGTH) {
        throw new Error(`${label}: server ${record.name} ${field} entries need a name and a value under ${String(MAX_VALUE_LENGTH)} characters`)
      }
    }
  }
}

/** Reject a stored section whose records collide, so no mount silently wins. */
function assertUniqueNames(settings: McpServersSettings): void {
  const seen = new Set<string>()
  for (const record of settings.servers) {
    if (seen.has(record.name)) {
      throw new Error(`mcpServers: server name ${JSON.stringify(record.name)} is declared more than once`)
    }
    seen.add(record.name)
  }
}

/** Translate one stored record into the mcp-client plugin config it mounts as. */
function clientConfig(record: StoredServer, cwd?: string): McpClientConfig {
  const shared = {
    serverName: record.name,
    toolCallTimeoutMs: record.toolCallTimeoutMs,
    // The registry reports a record's startup outcome, so it must observe one:
    // this makes a failed first connection reject the mount instead of
    // disappearing into a background retry the settings page cannot see.
    // Reconnection still covers drops after a successful start.
    failOnStartupError: true,
  }
  if (record.transport === 'stdio') {
    return {
      ...shared,
      transport: 'stdio',
      command: record.command,
      args: [...record.args],
      env: { ...record.env },
      cwd: cwd === undefined ? record.cwd : resolve(cwd, record.cwd),
    }
  }
  return {
    ...shared,
    transport: 'streamable-http',
    url: record.url,
    headers: { ...record.headers },
  }
}

/**
 * Fold a write request onto its previous record, preserving omitted secret
 * fields (`env`, `headers`, `url`) that a configuration surface never receives.
 * @param request - complete definition supplied by the caller.
 * @param previous - the record being replaced, when one exists.
 * @returns the next stored record.
 */
function foldDefinition(
  request: McpServerDefinitionRequest,
  previous: StoredServer | undefined,
): StoredServer {
  const transport = request.transport
  return {
    name: request.name.trim(),
    transport,
    command: transport === 'stdio' ? (request.command ?? '').trim() : '',
    args: transport === 'stdio' ? [...request.args ?? []] : [],
    env: request.env === undefined ? { ...previous?.env } : { ...request.env },
    cwd: transport === 'stdio' ? (request.cwd ?? '').trim() : '',
    url: transport === 'streamable-http' ? (request.url ?? previous?.url ?? '').trim() : '',
    headers: request.headers === undefined ? { ...previous?.headers } : { ...request.headers },
    toolCallTimeoutMs: request.toolCallTimeoutMs ?? previous?.toolCallTimeoutMs ?? DEFAULT_TOOL_CALL_TIMEOUT_MS,
    enabled: request.enabled ?? previous?.enabled ?? false,
  }
}

/**
 * Digest of everything a mount is started from, so reconciliation can tell a
 * redefined record from an untouched one without restarting a live server on
 * every unrelated document commit.
 */
function mountDigest(record: StoredServer, cwd?: string): string {
  return JSON.stringify(clientConfig(record, cwd))
}

/** Services required by the registry. */
export const inject = ['settings', 'tools']

/** One live `mcp-client` mount and the definition it was started from. */
interface LiveMount {
  readonly fiber: Fiber
  readonly digest: string
  status: 'starting' | 'started' | 'failed'
  detail?: string
}

/**
 * Settings-backed MCP server records with their live `mcp-client` mounts.
 * Reconciliation is idempotent and runs on one serialized chain, so a document
 * commit from any source — this service's own write, another process, or a
 * hand edit — converges the mounted set on the stored one.
 * Mutations reject with `SettingsConflictError` if another writer changes the
 * stored section after the read; retry uses the refreshed projection.
 */
export class McpServerRegistry extends Service {
  static inject = inject
  static Config: z<Config> = z.object({ cwd: z.string() })
  /** Server mounts belong to this Host service, not to a traced API caller. */
  private readonly owner: Context
  private readonly tools: Context['tools']
  private readonly cwd: string | undefined

  private readonly settings: SettingsScope<McpServersSettings>
  private readonly live = new Map<string, LiveMount>()
  /** Stored records this registry refuses to mount, with the refusal reason. */
  private readonly invalid = new Map<string, string>()
  private tail: Promise<unknown> = Promise.resolve()
  private stopped = false

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'mcpServers')
    if (config.cwd !== undefined && !isAbsolute(config.cwd)) throw new Error('mcpServers: cwd must be absolute')
    this.owner = ctx
    this.cwd = config.cwd
    this.tools = ctx.tools
    this.settings = ctx.settings.register(MCP_SERVERS_SETTINGS_NAMESPACE, McpServersSettingsSchema, {
      // Refuse a colliding section where it is written: two records claiming
      // one name would make which server serves a tool depend on mount order.
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
      }), 'mcp-registry: optional policy')
    })
    this.ctx.effect(() => () => this.shutdown(), 'mcpServers.dispose')
    this.ctx.effect(
      () => this.settings.watch(() => this.enqueue(() => this.reconcile())),
      'mcpServers.settingsWatch',
    )
    await this.enqueue(() => this.reconcile())
  }

  /**
   * Project every stored record with its live state.
   * @param settings - optional layer whose desired records to project.
   * @returns the current record projection, in stored order.
   */
  list(settings?: SettingsProvider): McpServerSnapshot {
    const servers = settings === undefined ? this.settings.get().servers : this.writeSource(settings).servers
    return { servers: servers.map(record => this.view(record)) }
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
   * @param request - complete server definition.
   * @param settings - selected write layer; omitted uses this registry's provider.
   * @returns the refreshed projection.
   * @throws If create names an existing record or replace names a missing record.
   */
  define(request: McpServerDefinitionRequest, settings: SettingsProvider = this.owner.settings): Promise<McpServerSnapshot> {
    return this.enqueue(async () => {
      const { revision, servers } = this.writeSource(settings)
      const index = servers.findIndex(candidate => candidate.name === request.name.trim())
      if (request.mode === 'create' && index !== -1) throw new Error(`mcpServers.define: server ${request.name} already exists`)
      if (request.mode === 'replace' && index === -1) throw new Error(`mcpServers.define: server ${request.name} is not configured`)
      const record = foldDefinition(request, index === -1 ? undefined : servers[index])
      assertMountable(record, 'mcpServers.define')
      const next = index === -1 ? [...servers, record] : servers.map((candidate, position) => position === index ? record : candidate)
      if (next.length > MAX_SERVERS) throw new Error(`mcpServers.define: at most ${String(MAX_SERVERS)} servers are supported`)
      await settings.update(MCP_SERVERS_SETTINGS_NAMESPACE, { servers: next }, revision)
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
  setEnabled(request: McpServerEnablementRequest, settings: SettingsProvider = this.owner.settings): Promise<McpServerSnapshot> {
    return this.enqueue(async () => {
      const { revision, servers } = this.writeSource(settings)
      const index = servers.findIndex(candidate => candidate.name === request.name)
      if (index === -1) throw new Error(`mcpServers.setEnabled: server ${request.name} is not configured`)
      const next = servers.map((candidate, position) => position === index
        ? { ...candidate, enabled: request.enabled }
        : candidate)
      await settings.update(MCP_SERVERS_SETTINGS_NAMESPACE, { servers: next }, revision)
      await this.reconcile()
      return this.list()
    })
  }

  /**
   * Remove one stored record and unmount it.
   * @param name - stored record name.
   * @param settings - selected write layer; omitted uses this registry's provider.
   * @returns the refreshed projection.
   */
  remove(name: string, settings: SettingsProvider = this.owner.settings): Promise<McpServerSnapshot> {
    return this.enqueue(async () => {
      const { revision, servers } = this.writeSource(settings)
      if (!servers.some(candidate => candidate.name === name)) {
        throw new Error(`mcpServers.remove: server ${name} is not configured`)
      }
      await settings.replace(MCP_SERVERS_SETTINGS_NAMESPACE,
        { servers: servers.filter(candidate => candidate.name !== name) }, revision)
      await this.reconcile()
      return this.list()
    })
  }

  /** Read the selected layer's desired records, including overrides suppressed by trust. */
  private writeSource(settings: SettingsProvider): McpServersSettings & { revision: number } {
    const descriptor = settings.describe().find(section => section.ns === MCP_SERVERS_SETTINGS_NAMESPACE)
    if (descriptor === undefined) throw new Error('mcpServers: selected settings provider has no mcp-servers namespace')
    return {
      ...McpServersSettingsSchema({
        servers: (descriptor.user as Partial<McpServersSettings> | undefined)?.servers
          ?? (descriptor.base as Partial<McpServersSettings> | undefined)?.servers ?? [],
      }),
      revision: descriptor.revision,
    }
  }

  /** Serialize every mutation and reconciliation on one chain. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(task, task)
    this.tail = run.then(() => undefined, () => undefined)
    return run
  }

  /**
   * Converge the mounted set on the stored one: unmount every record that is
   * gone, disabled, or redefined, then mount every enabled record that is not
   * already live from the same definition. Mounts run concurrently and are
   * awaited, so the projection this publishes reports each record's settled
   * startup outcome rather than a pending one. A record this registry cannot
   * mount is recorded as `invalid` with its diagnostic and does not stop the
   * others.
   */
  private async reconcile(): Promise<void> {
    if (this.stopped) return
    const records = new Map(this.settings.get().servers.map(record => [record.name, record]))
    this.invalid.clear()
    for (const [name, mount] of [...this.live]) {
      const record = records.get(name)
      if (this.ctx.get('optionalPlugins')?.enabled !== false && record?.enabled === true && mountDigest(record, this.cwd) === mount.digest) continue
      this.live.delete(name)
      await disposeQuietly(mount.fiber)
    }
    const pending: Promise<void>[] = []
    for (const record of records.values()) {
      if (this.ctx.get('optionalPlugins')?.enabled === false || !record.enabled || this.live.has(record.name)) continue
      try {
        assertMountable(record, 'mcpServers')
      } catch (error) {
        // A hand-edited document must not take the process down; the record's
        // own status is where its owner learns the definition was refused.
        /* v8 ignore next -- assertMountable only throws Error instances. */
        this.invalid.set(record.name, error instanceof Error ? error.message : String(error))
        continue
      }
      pending.push(this.mount(record))
    }
    await Promise.all(pending)
    // The projection is published only after every mount settled, so an
    // observer cannot read a record whose connection is still opening as one
    // that failed to start.
    this.ctx.emit('mcp-servers/reconciled', this.list())
  }

  /**
   * Start one record's `mcp-client` fiber and record its startup outcome. A
   * failed mount stays in the live map so reconciliation does not retry it on
   * every unrelated document change; toggling the record or redefining it is
   * the explicit retry.
   */
  private async mount(record: StoredServer): Promise<void> {
    const digest = mountDigest(record, this.cwd)
    const fiber = this.owner.plugin({
      name: `mcp-server:${record.name}`,
      inject: mcpClientInject,
      apply: applyMcpClient,
    }, clientConfig(record, this.cwd))
    const mount: LiveMount = { fiber, digest, status: 'starting' }
    this.live.set(record.name, mount)
    try {
      await fiber
      mount.status = 'started'
    } catch (error) {
      mount.status = 'failed'
      /* v8 ignore next -- Cordis normalizes plugin failures to Error before fiber.await rejects. */
      mount.detail = error instanceof Error ? error.message : String(error)
    }
  }

  /** Project one stored record with its live state and registered tool names. */
  private view(record: StoredServer): McpServerView {
    const candidate = record.enabled ? this.live.get(record.name) : undefined
    const digest = mountDigest(record, this.cwd)
    const mount = candidate?.digest === digest ? candidate : undefined
    const effective = this.settings.get().servers.find(server => server.name === record.name)
    const invalid = record.enabled && effective !== undefined && mountDigest(effective, this.cwd) === digest
      ? this.invalid.get(record.name) : undefined
    const status: McpServerStatus = invalid !== undefined
      ? 'invalid'
      : !record.enabled ? 'stopped' : mount?.status ?? 'stopped'
    const rawDetail = invalid ?? mount?.detail
    const detail = record.url === '' ? rawDetail : rawDetail?.replaceAll(record.url, redactUrlUserinfo(record.url))
    const prefix = `mcp__${record.name}__`
    return {
      name: record.name,
      transport: record.transport,
      enabled: record.enabled,
      status,
      ...detail === undefined || status === 'stopped' ? {} : { detail },
      ...record.transport === 'stdio' ? { command: record.command, args: [...record.args] } : {},
      ...record.transport === 'stdio' && record.cwd !== '' ? { cwd: record.cwd } : {},
      ...record.transport === 'streamable-http' ? { url: redactUrlUserinfo(record.url) } : {},
      envNames: Object.keys(record.env).sort(),
      headerNames: Object.keys(record.headers).sort(),
      toolCallTimeoutMs: record.toolCallTimeoutMs,
      tools: mount?.status === 'started'
        ? this.tools.schemas(scopeOf(this.owner)).map(tool => tool.name).filter(name => name.startsWith(prefix)).sort() : [],
    }
  }

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
}

/**
 * Unmount one fiber and swallow its teardown failure. The record it served is
 * already out of the live map, so a disposal error cannot restore it, and
 * letting it escape would strand every later record in the same reconcile.
 * @param fiber - the mount to tear down.
 */
async function disposeQuietly(fiber: Fiber): Promise<void> {
  try {
    await fiber.dispose()
  } catch (_mcpMountTeardownFailure) {
    // The fiber is inactive either way; nothing here can act on the failure.
  }
}

export default McpServerRegistry

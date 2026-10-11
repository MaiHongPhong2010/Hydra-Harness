/** Runtime plugin inventory plus shared user-setting enablement controls. */

import { execFile } from 'node:child_process'
import type {} from '@hydraharness/harness-optional-plugins'
import { lstat, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Service, type Context, type FiberState } from '@hydraharness/cordis'
import type { Entry } from '@hydraharness/cordis-plugin-loader'
import type { Include } from '@hydraharness/cordis-plugin-include'
import { profilePluginEnablement, readProfileManifest, resolveProfileDir } from '@hydraharness/harness-app-boot'
import { withFileLock, writeFileAtomic } from '@hydraharness/harness-atomic-write'
import { settingsNamespace, type SettingsProvider, type SettingsScope } from '@hydraharness/harness-settings'
import type {} from '@hydraharness/harness-workspace-config'
import type { SettingsTarget } from '@hydraharness/harness-workspace-config/types'
import { TypertRemoteService, Remote } from '@hydraharness/harness-typert-protocol'
import type {
  ImportedPluginEntry, ImportedPluginRuntime, ImportedPluginSnapshot, PluginImportSource,
} from '@hydraharness/harness-plugin-runtime'
import type {
  HookRecordDefinitionRequest, HookRecordEnablementRequest, HookRecordRegistry, HookRecordSnapshot,
} from '@hydraharness/harness-hooks-registry'
import type {
  McpServerDefinitionRequest, McpServerEnablementRequest, McpServerRegistry, McpServerSnapshot,
} from '@hydraharness/harness-mcp-registry'
import z from '@hydraharness/schemastery'
import { z as zod } from 'zod'
import type {
  AddPluginMarketplaceRequest,
  ImportedPluginMcpServerEnablementRequest,
  ImportedPluginMcpToolApprovalRequest,
  PluginEnablementRequest,
  PluginEnablementResult,
  PluginEntryId,
  PluginFiberPhase,
  PluginInventoryEntry,
  PluginInventorySnapshot,
  PluginMarketplaceSnapshot,
  PluginMarketplaceView,
  SetPluginMarketplaceEnablementRequest,
} from './types.ts'

export type * from './types.ts'

declare module '@hydraharness/cordis-plugin-loader' {
  interface EntryOptions {
    /** Optional composition-specific summary, overriding the package description. */
    description?: string
    /** Optional composition-specific usage guidance, overriding package metadata. */
    application?: string
    /** Core plugins change only on restart; omitted means normal. */
    pluginType?: 'core' | 'normal'
    /** Required functionality and dependencies remain mounted when optional plugins are suspended. */
    pluginRequired?: boolean
    /** Entries that implement one feature and share one Settings switch. */
    pluginGroup?: string
  }
}

/** Brand an existing Loader-tree entry id at the owning boundary. */
function pluginEntryId(value: string): PluginEntryId {
  return value as PluginEntryId
}

/** Runtime mirror: FiberState is a cross-package const enum. */
const FIBER_STATE = {
  PENDING: 0 as FiberState.PENDING,
  LOADING: 1 as FiberState.LOADING,
  ACTIVE: 2 as FiberState.ACTIVE,
  FAILED: 3 as FiberState.FAILED,
  DISPOSED: 4 as FiberState.DISPOSED,
  UNLOADING: 5 as FiberState.UNLOADING,
} as const

/** Complete public projection of Cordis Fiber states. */
const FIBER_PHASE = {
  [FIBER_STATE.PENDING]: 'pending',
  [FIBER_STATE.LOADING]: 'loading',
  [FIBER_STATE.ACTIVE]: 'active',
  [FIBER_STATE.FAILED]: 'failed',
  [FIBER_STATE.DISPOSED]: null,
  [FIBER_STATE.UNLOADING]: 'unloading',
} as const satisfies Record<FiberState, PluginFiberPhase>

const PLUGIN_SETTINGS_NAMESPACE = settingsNamespace('plugins')
const MARKETPLACE_SETTINGS_NAMESPACE = settingsNamespace('plugin-marketplaces')
const HMR_MODULE = '@hydraharness/cordis-plugin-hmr'
const AGENT_PRESET_ENTRY_PREFIX = 'agent-preset:'
const MAX_MARKETPLACE_BYTES = 1024 * 1024
const MARKETPLACE_GIT_TIMEOUT_MS = 30_000
const MAX_MARKETPLACE_SPARSE_PATHS = 20
const MAX_MARKETPLACE_SPARSE_PATH_LENGTH = 512
const GITHUB_SHORTHAND_PATTERN = /^([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)$/u
const MarketplaceDocumentSchema = zod.object({
  plugins: zod.array(zod.record(zod.string(), zod.unknown())).max(500),
}).loose()

const PluginMetadataSchema = zod.object({
  description: zod.string().trim().min(1).optional(),
  application: zod.string().trim().min(1).optional(),
})

const PluginPackageSchema = zod.object({
  description: PluginMetadataSchema.shape.description,
  hydra: zod.object({
    plugin: zod.object({ application: zod.string().trim().min(1).optional() }).optional(),
  }).optional(),
})

/** Read presentation metadata without importing or activating the plugin. */
async function pluginMetadata(moduleName: string, baseUrl: string | undefined, options: unknown = {}): Promise<Pick<PluginInventoryEntry, 'description' | 'application'>> {
  const overrides = PluginMetadataSchema.parse(options)
  const metadata = {
    ...overrides.description === undefined ? {} : { description: overrides.description },
    ...overrides.application === undefined ? {} : { application: overrides.application },
  }
  if (baseUrl === undefined || moduleName.startsWith('.') || moduleName.startsWith('/')
    || moduleName.includes(':') || moduleName.includes('\\')) return metadata
  const packageName = moduleName.split('/').slice(0, moduleName.startsWith('@') ? 2 : 1).join('/')
  let path: string
  try {
    path = createRequire(baseUrl).resolve(`${packageName}/package.json`)
  } catch (error) {
    // Disabled packages may be absent; third-party packages may hide their manifest.
    if (error instanceof Error && 'code' in error
      && (error.code === 'MODULE_NOT_FOUND' || error.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED')) return metadata
    throw error
  }
  const result = PluginPackageSchema.safeParse(JSON.parse(await readFile(path, 'utf8')) as unknown)
  if (!result.success) throw new Error(`pluginInventory: invalid plugin metadata in ${path}`, { cause: result.error })
  const { description, hydra } = result.data
  return {
    ...description === undefined ? {} : { description },
    ...hydra?.plugin?.application === undefined ? {} : { application: hydra.plugin.application },
    ...metadata,
  }
}

type MarketplaceDocument = zod.infer<typeof MarketplaceDocumentSchema>

interface PluginSettings {
  enabled: Record<string, boolean>
}

const PluginSettingsSchema: z<PluginSettings> = z.object({
  enabled: z.dict(z.boolean()).default({}),
})

interface MarketplaceSource {
  source: string
  gitRef: string
  sparsePaths: string[]
  enabled: boolean
}

interface MarketplaceSettings {
  sources: MarketplaceSource[]
}

const MarketplaceSourceSchema: z<MarketplaceSource> = z.object({
  source: z.string(),
  gitRef: z.string().default(''),
  sparsePaths: z.array(z.string()).max(MAX_MARKETPLACE_SPARSE_PATHS).default([]),
  enabled: z.boolean().default(true),
})

const MarketplaceSettingsSchema: z<MarketplaceSettings> = z.object({
  sources: z.array(MarketplaceSourceSchema).max(20).default([]),
})

interface LoadedMarketplace {
  source: MarketplaceSource
  document: MarketplaceDocument
}

interface NormalizedMarketplaceSource extends MarketplaceSource {
  kind: 'git' | 'local'
}

function missingPath(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
}

function normalizeGitRef(value: string | undefined): string | undefined {
  const gitRef = value?.trim()
  if (gitRef === undefined || gitRef === '') return undefined
  if (gitRef.length > 255
    || gitRef.startsWith('-')
    || /[\u0000-\u0020\u007F]/u.test(gitRef)) {
    throw new Error('pluginInventory: Git ref is invalid')
  }
  return gitRef
}

function normalizeSparsePaths(values: readonly string[] | undefined): string[] {
  if ((values?.length ?? 0) > MAX_MARKETPLACE_SPARSE_PATHS) {
    throw new Error(`pluginInventory: at most ${String(MAX_MARKETPLACE_SPARSE_PATHS)} sparse paths are allowed`)
  }
  const paths = (values ?? []).map((value) => {
    const path = value.trim().replaceAll('\\', '/').replace(/\/+$/u, '')
    if (path.length > MAX_MARKETPLACE_SPARSE_PATH_LENGTH) {
      throw new Error(`pluginInventory: sparse paths may contain at most ${String(MAX_MARKETPLACE_SPARSE_PATH_LENGTH)} characters`)
    }
    const segments = path.split('/')
    if (path === ''
      || path.startsWith('/')
      || path.startsWith('-')
      || /^[A-Za-z]:\//u.test(path)
      || segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
      throw new Error(`pluginInventory: sparse path ${JSON.stringify(value)} must be repository-relative`)
    }
    return path
  })
  return [...new Set(paths)].sort()
}

function normalizeGitSource(source: string): string {
  const shorthand = GITHUB_SHORTHAND_PATTERN.exec(source)
  if (shorthand !== null) {
    /* v8 ignore next -- A successful shorthand match contains both required captures. */
    const owner = shorthand[1] ?? ''
    /* v8 ignore next -- A successful shorthand match contains both required captures. */
    const repository = (shorthand[2] ?? '').replace(/\.git$/u, '')
    return `https://github.com/${owner}/${repository}.git`
  }
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[A-Za-z0-9._~/-]+$/u.test(source)) return source
  let url: URL
  try {
    url = new URL(source)
  } catch (cause) {
    throw new Error('pluginInventory: source must be a GitHub repo, Git URL, or existing local folder', { cause })
  }
  if (url.protocol !== 'https:' && url.protocol !== 'ssh:') {
    throw new Error('pluginInventory: remote marketplace source must use HTTPS or SSH')
  }
  if (url.password !== '' || url.hash !== '' || url.search !== ''
    || (url.protocol === 'https:' && url.username !== '')) {
    throw new Error('pluginInventory: marketplace source cannot contain credentials, a query, or a fragment')
  }
  return url.href
}

async function normalizeMarketplaceSource(
  request: AddPluginMarketplaceRequest | MarketplaceSource,
): Promise<NormalizedMarketplaceSource> {
  const source = request.source.trim()
  if (source === '' || source.length > 2048 || /[\u0000-\u001F\u007F]/u.test(source)) {
    throw new Error('pluginInventory: marketplace source is invalid')
  }
  const gitRef = normalizeGitRef(request.gitRef)
  const sparsePaths = normalizeSparsePaths(request.sparsePaths)
  const localPath = resolve(source)
  try {
    if (!GITHUB_SHORTHAND_PATTERN.test(source) && (await stat(localPath)).isDirectory()) {
      if (gitRef !== undefined || sparsePaths.length > 0) {
        throw new Error('pluginInventory: Git ref and sparse paths require a Git source')
      }
      return { kind: 'local', source: await realpath(localPath), gitRef: '', sparsePaths: [], enabled: true }
    }
  } catch (error) {
    if (!missingPath(error)) throw error
  }
  return {
    kind: 'git',
    source: normalizeGitSource(source),
    gitRef: gitRef ?? '',
    sparsePaths,
    enabled: true,
  }
}

function marketplaceGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (!/(?:KEY|SECRET|TOKEN|PASSWORD)/iu.test(name)) env[name] = value
  }
  env.GCM_INTERACTIVE = 'Never'
  env.GIT_TERMINAL_PROMPT = '0'
  return env
}

function runGit(cwd: string, args: readonly string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    execFile('git', [
      '-c', 'protocol.ext.allow=never',
      '-c', 'protocol.file.allow=never',
      ...args,
    ], {
      cwd,
      encoding: 'utf8',
      env: marketplaceGitEnv(),
      maxBuffer: MAX_MARKETPLACE_BYTES,
      timeout: MARKETPLACE_GIT_TIMEOUT_MS,
      windowsHide: true,
    }, (error, _stdout, stderr) => {
      if (error === null) {
        resolvePromise()
        return
      }
      const detail = stderr.trim().split(/\r?\n/u)[0]
      reject(new Error(
        `pluginInventory: failed to load Git marketplace${detail === undefined || detail === '' ? '' : `: ${detail}`}`,
        { cause: error },
      ))
    })
  })
}

async function readMarketplaceDocument(root: string): Promise<MarketplaceDocument> {
  for (const relativePath of ['.agents/plugins/marketplace.json', '.agents/plugins/api_marketplace.json', 'marketplace.json']) {
    const filename = join(root, relativePath)
    try {
      const metadata = await lstat(filename)
      if (!metadata.isFile()) continue
      if (metadata.size > MAX_MARKETPLACE_BYTES) {
        throw new Error(`pluginInventory: marketplace exceeds ${String(MAX_MARKETPLACE_BYTES)} bytes`)
      }
      const body = await readFile(filename)
      if (body.byteLength > MAX_MARKETPLACE_BYTES) {
        throw new Error(`pluginInventory: marketplace exceeds ${String(MAX_MARKETPLACE_BYTES)} bytes`)
      }
      return MarketplaceDocumentSchema.parse(JSON.parse(body.toString('utf8')) as unknown)
    } catch (error) {
      if (missingPath(error)) continue
      throw error
    }
  }
  throw new Error('pluginInventory: OpenAI/Codex marketplace.json is missing')
}

/** Load and validate one marketplace root without retaining an executable checkout. */
async function loadMarketplace(request: AddPluginMarketplaceRequest | MarketplaceSource): Promise<LoadedMarketplace> {
  const normalized = await normalizeMarketplaceSource(request)
  const { kind, ...source } = normalized
  if (kind === 'local') {
    return { source, document: await readMarketplaceDocument(source.source) }
  }

  // Temporary shallow clones avoid cache invalidation; add snapshots if list latency becomes material.
  const tempRoot = await mkdtemp(join(tmpdir(), 'hydra-marketplace-'))
  const checkout = join(tempRoot, 'repository')
  try {
    if (source.gitRef !== '') {
      try {
        await runGit(tempRoot, ['check-ref-format', '--allow-onelevel', source.gitRef])
      } catch (cause) {
        throw new Error('pluginInventory: Git ref is invalid', { cause })
      }
    }
    const cloneArgs = ['clone', '--depth', '1', '--filter=blob:none']
    if (source.sparsePaths.length > 0) cloneArgs.push('--sparse')
    if (source.gitRef !== '') cloneArgs.push('--no-checkout')
    cloneArgs.push('--', source.source, checkout)
    await runGit(tempRoot, cloneArgs)
    if (source.gitRef !== '') {
      await runGit(tempRoot, ['-C', checkout, 'fetch', '--depth', '1', 'origin', source.gitRef])
    }
    if (source.sparsePaths.length > 0) {
      await runGit(tempRoot, [
        '-C', checkout, 'sparse-checkout', 'set', '--cone', '--sparse-index', '--',
        '.agents/plugins', ...source.sparsePaths,
      ])
    }
    if (source.gitRef !== '') {
      await runGit(tempRoot, ['-C', checkout, 'checkout', '--detach', 'FETCH_HEAD'])
    }
    return { source, document: await readMarketplaceDocument(checkout) }
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
}

/** Inventory exclusions for entries owned by another composition plane. */
export interface Config {
  /** Entry ids owned by another composition plane and omitted from this inventory. */
  compositionEntryIds?: string[]
}

interface EntryState {
  entry: Entry
  disabled: boolean | null | undefined
  config: unknown
}

/** Optional preset service shape; inventory must also run without a roster. */
interface AgentPresetPluginControls {
  listPluginEntries(settings?: SettingsProvider): Promise<readonly {
    entryId: string
    presetId: string
    rowId?: string
    moduleName: string
    enabled: boolean
    description?: string
    application?: string
  }[]>
  setPluginEnabled(entryId: string, enabled: boolean, settings?: SettingsProvider): Promise<void>
}

/** Remote-only service exposing the Loader's current non-group entry state. */
export class PluginInventoryGateway extends TypertRemoteService {
  static inject = ['loader', 'settings']
  static Config: z<Config> = z.object({
    compositionEntryIds: z.array(z.string()).default([]),
  })

  private readonly compositionEntryIds: ReadonlySet<string>
  private readonly settings: SettingsScope<PluginSettings>
  private readonly marketplaceSettings: SettingsScope<MarketplaceSettings>
  private readonly defaultEnabled = new Map<string, boolean>()
  private readonly initialEnabled = new Map<string, boolean>()
  private readonly originalConfigs = new Map<string, unknown>()
  private readonly suspended = new Map<Entry, boolean>()
  private readonly required = new Set<string>()
  private readonly appliedSettings = new Set<string>()
  private restartEnablement: Record<string, boolean> = {}
  private mutationTail: Promise<unknown> = Promise.resolve()

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'pluginInventory')
    this.compositionEntryIds = new Set(config.compositionEntryIds)
    this.settings = ctx.settings.register(PLUGIN_SETTINGS_NAMESPACE, PluginSettingsSchema)
    this.marketplaceSettings = ctx.settings.register(MARKETPLACE_SETTINGS_NAMESPACE, MarketplaceSettingsSchema)
    ctx.inject(['optionalPlugins'], (pctx) => {
      pctx.effect(() => pctx.optionalPlugins.subscribe((enabled) => {
        void this.enqueue(() => this.applyOptionalGate(enabled)).catch((error: unknown) => { this.ctx.logger.error(error) })
      }), 'pluginInventory: optional policy')
      void this.enqueue(() => this.applyOptionalGate(pctx.optionalPlugins.enabled))
        .catch((error: unknown) => { this.ctx.logger.error(error) })
    })
    ctx.on('loader/config-update', () => {
      const policy = ctx.get('optionalPlugins')
      if (policy !== undefined) void this.enqueue(() => this.applyOptionalGate(policy.enabled))
        .catch((error: unknown) => { ctx.logger.error(error) })
    })
  }

  protected async [Service.init](): Promise<void> {
    const rootInclude = this.rootInclude()
    if (rootInclude === undefined) return
    const representatives = this.representatives(rootInclude)
    for (const entry of representatives.values()) {
      this.defaultEnabled.set(entry.options.name, !entry.disabled && !this.isHmrWatchOnly(entry))
      this.originalConfigs.set(entry.options.name, structuredClone(entry.options.config))
    }
    if ([...representatives.values()].some(entry => this.isRestartOnly(entry))) {
      this.restartEnablement = profilePluginEnablement(
        readProfileManifest('pluginInventory', this.profileDir()),
      )
    }
    await this.applySettings(this.settings.get().enabled)
    for (const entry of representatives.values()) this.initialEnabled.set(entry.id, this.enabled(entry))
    this.ctx.effect(
      () => this.settings.watch(next => this.enqueue(() => this.applySettings(next.enabled))),
      'pluginInventory.settingsWatch',
    )
  }

  /** Protect required modules and their declared dependency closure before suspending root-owned features. */
  private async applyOptionalGate(enabled: boolean): Promise<void> {
    const policy = this.ctx.get('optionalPlugins')
    if (policy === undefined) return
    if (!enabled) await policy.drain()
    if (policy.enabled !== enabled) return
    const entries = [...this.representatives(this.rootInclude()).values()]
    const byModule = new Map(entries.map(entry => [entry.options.name, entry]))
    const pending = entries.filter(entry => entry.options.pluginRequired === true).map(entry => entry.options.name)
    this.required.clear()
    for (const name of pending) {
      if (this.required.has(name)) continue
      this.required.add(name)
      const entry = byModule.get(name)
      const baseUrl = entry?.parent.tree.ctx.baseUrl
      if (baseUrl === undefined || !name.startsWith('@')) continue
      const packageName = name.split('/').slice(0, 2).join('/')
      const manifest = createRequire(baseUrl).resolve(`${packageName}/package.json`)
      const metadata = zod.object({ dependencies: zod.record(zod.string(), zod.string()).optional(), peerDependencies: zod.record(zod.string(), zod.string()).optional(), hydra: zod.object({ bundle: zod.unknown().optional() }).optional() }).parse(JSON.parse(await readFile(manifest, 'utf8')) as unknown)
      // Bundle manifests list optional composition rows; required runtime rows carry their own flags.
      if (metadata.hydra?.bundle !== undefined) continue
      for (const dependency of Object.keys({ ...metadata.dependencies, ...metadata.peerDependencies })) {
        for (const candidate of entries) if (candidate.options.name === dependency || candidate.options.name.startsWith(`${dependency}/`)) pending.push(candidate.options.name)
      }
    }
    for (const entry of entries) {
      if (entry.subtree !== undefined || entry.subgroup !== undefined || this.required.has(entry.options.name)) continue
      const previous = this.suspended.get(entry)
      if (!enabled) {
        if (!this.suspended.has(entry)) this.suspended.set(entry, !entry.disabled)
        await entry.update({ disabled: true })
      } else if (previous !== undefined) {
        const nextEnabled = this.isRestartOnly(entry) ? previous
          : this.settings.get().enabled[entry.options.name] ?? this.defaultEnabled.get(entry.options.name) ?? previous
        this.suspended.delete(entry)
        await entry.update({ disabled: !nextEnabled })
      }
    }
  }

  private rootInclude(): Include | undefined {
    return Object.values(this.ctx.loader.store)
      .map(entry => entry.subtree)
      .find((tree): tree is Include => tree !== undefined
        && 'filename' in tree
        && typeof tree.filename === 'string')
  }

  /** Project persisted OpenAI/Codex marketplace sources without exposing their entries here. */
  private async marketplaceSnapshot(): Promise<PluginMarketplaceSnapshot> {
    const sources = this.marketplaceSettings.get().sources
    if (sources.length === 0) return { marketplaces: [] }
    const marketplaces: PluginMarketplaceView[] = []
    for (const source of sources) {
      const sourceView = {
        source: source.source,
        ...(source.gitRef === '' ? {} : { gitRef: source.gitRef }),
        sparsePaths: source.sparsePaths,
        enabled: source.enabled,
      }
      try {
        await loadMarketplace(source)
        marketplaces.push({ status: 'ready', ...sourceView })
      } catch {
        marketplaces.push({ status: 'unavailable', ...sourceView })
      }
    }
    return { marketplaces }
  }

  private moduleEntries(moduleName: string): Entry[] {
    const entries: Entry[] = []
    for (const entry of this.ctx.loader.entries()) {
      if (!entry.options.group
        && !this.compositionEntryIds.has(entry.options.id)
        && entry.options.name === moduleName) entries.push(entry)
    }
    return entries
  }

  /** One logical row per module, preferring the profile-owned entry. */
  private representatives(rootInclude: Include | undefined): Map<string, Entry> {
    const entries = new Map<string, Entry>()
    for (const entry of this.ctx.loader.entries()) {
      if (entry.options.group || this.compositionEntryIds.has(entry.options.id)) continue
      this.isRestartOnly(entry)
      if (entry.options.pluginRequired !== undefined && typeof entry.options.pluginRequired !== 'boolean') throw new Error(`pluginInventory: ${entry.id}.pluginRequired must be boolean`)
      const group: unknown = entry.options.pluginGroup
      if (group !== undefined && (typeof group !== 'string' || group.trim() === '')) {
        throw new Error(`pluginInventory: ${entry.id}.pluginGroup must be a non-empty string`)
      }
      if ('plugin_type' in entry.options) throw new Error(`pluginInventory: ${entry.id}.plugin_type: use pluginType`)
      const current = entries.get(entry.options.name)
      if (current === undefined
        || (entry.parent.tree === rootInclude && current.parent.tree !== rootInclude)
        || (this.isRestartOnly(entry) && !this.isRestartOnly(current))) {
        entries.set(entry.options.name, entry)
      }
    }
    return entries
  }

  /** Whether changing this root entry must wait for the next profile boot. */
  private isRestartOnly(entry: Entry): boolean {
    const value: unknown = entry.options.pluginType
    if (value !== undefined && value !== 'core' && value !== 'normal') {
      throw new Error(`pluginInventory: ${entry.id}.pluginType must be core or normal`)
    }
    return value === 'core' || (entry.options.pluginGroup !== undefined
      && [...this.ctx.loader.entries()].some(candidate => candidate.options.pluginGroup === entry.options.pluginGroup
        && candidate.options.pluginType === 'core'))
  }

  private isToggleable(entry: Entry, rootInclude = this.rootInclude()): boolean {
    return rootInclude !== undefined
      && entry.parent.tree === rootInclude
      && entry.options.pluginRequired !== true && !this.required.has(entry.options.name)
  }

  private enabled(entry: Entry): boolean {
    if (this.isRestartOnly(entry) || !this.isToggleable(entry)) return this.suspended.get(entry) ?? !entry.disabled
    return this.settings.get().enabled[entry.options.name]
      ?? this.defaultEnabled.get(entry.options.name)
      ?? !entry.disabled
  }

  /** Desired state used by the switch; restart-only entries retain the live Loader state until reboot. */
  private desiredEnabled(entry: Entry): boolean {
    return this.isRestartOnly(entry)
      ? this.restartEnablement[entry.options.id] ?? !entry.disabled
      : this.enabled(entry)
  }

  /** Whether the currently loaded entry still differs from its persisted desired state. */
  private restartRequired(entry: Entry): boolean {
    const pending = this.restartEnablement[entry.options.id]
    return this.isRestartOnly(entry) && pending !== undefined && pending !== !entry.disabled
  }

  /** Resolve the active root Include to the profile directory the launcher owns. */
  private profileDir(): string {
    const filename = this.rootInclude()?.filename
    /* v8 ignore next -- Restart updates only follow a synchronous rootInclude-backed toggleability check. */
    if (typeof filename !== 'string') throw new Error('pluginInventory: active profile root is unavailable')
    /* v8 ignore next -- The root Include stores filename as the filesystem path returned by fileURLToPath. */
    const path = filename.startsWith('file:') ? fileURLToPath(filename) : filename
    const actual = resolve(dirname(path))
    const expected = resolve(resolveProfileDir(basename(actual)))
    if (actual !== expected) {
      throw new Error(`pluginInventory: active root ${path} is not a managed hydra profile`)
    }
    return expected
  }

  /** Persist one restart-only root switch without changing the live Loader tree. */
  private async setRestartEnabled(entries: readonly Entry[], enabled: boolean): Promise<void> {
    const profileDir = this.profileDir()
    const manifestPath = join(profileDir, 'package.json')
    await withFileLock(manifestPath, async () => {
      // Re-read while holding the cross-process lock so a concurrent profile
      // edit cannot be replaced by a stale manifest snapshot.
      const manifest = readProfileManifest('pluginInventory', profileDir)
      const pluginEnablement = {
        ...profilePluginEnablement(manifest),
        ...Object.fromEntries(entries.map(entry => [entry.options.id, enabled])),
      }
      const next = {
        ...manifest,
        hydra: {
          ...manifest.hydra,
          profile: {
            ...manifest.hydra?.profile,
            pluginEnablement,
          },
        },
      }
      await writeFileAtomic(manifestPath, `${JSON.stringify(next, undefined, 2)}\n`, { mode: 0o600 })
      this.restartEnablement = pluginEnablement
    })
  }

  private isHmrWatchOnly(entry: Entry): boolean {
    const config = entry.options.config as { root?: unknown } | undefined
    return entry.options.name === HMR_MODULE && Array.isArray(config?.root) && config.root.length === 0
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.mutationTail.then(task, task)
    this.mutationTail = run.then(() => undefined, () => undefined)
    return run
  }

  private async restore(states: readonly EntryState[]): Promise<void> {
    for (const state of states.toReversed()) {
      await state.entry.update({
        disabled: state.disabled ?? null,
        config: state.config ?? null,
      })
    }
  }

  /** Keep one configured instance active; HMR's disabled state remains watch-only. */
  private async updateModule(entry: Entry, enabled: boolean): Promise<EntryState[]> {
    const candidates = this.moduleEntries(entry.options.name)
    const states = candidates.map(candidate => ({
      entry: candidate,
      disabled: candidate.options.disabled,
      config: candidate.options.config as unknown,
    }))
    try {
      for (const candidate of candidates) {
        if (candidate !== entry && !candidate.disabled) await candidate.update({ disabled: true })
      }
      if (entry.options.name === HMR_MODULE) {
        const original = this.originalConfigs.get(entry.options.name)
        const config = { ...(original as Record<string, unknown> | undefined) }
        if (enabled) delete config.root
        else config.root = []
        await entry.update({ disabled: null, config })
      } else {
        await entry.update({ disabled: enabled ? null : true })
      }
      return states
    } catch (error) {
      try {
        await this.restore(states)
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], `pluginInventory: failed to update and roll back ${entry.options.name}`)
      }
      throw error
    }
  }

  private async applySettings(enabled: Readonly<Record<string, boolean>>): Promise<void> {
    const rootInclude = this.rootInclude()
    const representatives = this.representatives(rootInclude)
    const modules = new Set([...this.appliedSettings, ...Object.keys(enabled)])
    this.appliedSettings.clear()
    for (const moduleName of Object.keys(enabled)) this.appliedSettings.add(moduleName)
    const failures: unknown[] = []
    for (const moduleName of modules) {
      const entry = representatives.get(moduleName)
      if (entry === undefined) continue
      if (!this.isToggleable(entry, rootInclude) || this.isRestartOnly(entry)) continue
      const desired = enabled[moduleName]
        ?? this.defaultEnabled.get(moduleName)
        ?? !entry.disabled
      try {
        await this.updateModule(entry, this.ctx.get('optionalPlugins')?.enabled === false && !this.required.has(moduleName) ? false : desired)
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'pluginInventory: failed to apply plugin settings')
  }

  /**
   * Read the Loader and optional preset roster directly on every call. Cordis's
   * internal plugin/status events already maintain Entry.fiber and Fiber state,
   * so a second Host cache would only add another lifecycle truth to synchronize.
   * @returns Current Host entries followed by preset-owned leaf entries.
   */

  private async hostEntries(): Promise<PluginInventoryEntry[]> {
    const rootInclude = this.rootInclude()
    return Promise.all(this.inventoryGroups(rootInclude).map(async (group) => {
      const entry = group[0] as Entry
      const members = group.filter(candidate => this.isToggleable(candidate, rootInclude))
      const controlled = members.length > 0 ? members : group
      const initialStates = controlled.map(candidate => this.initialEnabled.get(candidate.id) ?? this.enabled(candidate))
      const desiredStates = controlled.map(candidate => this.desiredEnabled(candidate))
      const enabled = controlled.every(candidate => this.enabled(candidate))
      const restartRequired = controlled.some(candidate => this.restartRequired(candidate))
      const pendingEnabled = restartRequired ? controlled.every(candidate => this.desiredEnabled(candidate)) : undefined
      const active = enabled
        ? this.moduleEntries(entry.options.name).find(candidate => !candidate.disabled && candidate.fiber !== undefined)
        : undefined
      const fiber = active?.fiber
      return {
        entryId: pluginEntryId(entry.id),
        moduleName: entry.options.name,
        ...await pluginMetadata(entry.options.name, entry.parent.tree.ctx.baseUrl, entry.options),
        pluginType: group.some(candidate => this.isRestartOnly(candidate)) ? 'core' : 'normal',
        ...entry.options.pluginRequired === true || this.required.has(entry.options.name) ? { required: true } : {},
        initialEnabled: initialStates.every(Boolean) ? true : initialStates.some(Boolean) ? null : false,
        changedSinceStart: controlled.some((candidate, index) => this.desiredEnabled(candidate) !== initialStates[index]),
        ...(desiredStates.some(Boolean) && !desiredStates.every(Boolean) ? { mixedEnabled: true } : {}),
        ...(group.length > 1 ? { relatedModules: group.slice(1).map(candidate => candidate.options.name) } : {}),
        enabled,
        ...pendingEnabled === undefined ? {} : { pendingEnabled },
        restartRequired,
        toggleable: this.isToggleable(entry, rootInclude),
        fiberPhase: fiber === undefined ? null : FIBER_PHASE[fiber.state],
      }
    }))
  }

  private async presetEntries(
    presets: AgentPresetPluginControls | undefined, settings?: SettingsProvider, target: SettingsTarget = {},
  ): Promise<PluginInventoryEntry[]> {
    if (presets === undefined) return []
    const entries = settings === undefined ? await presets.listPluginEntries() : await presets.listPluginEntries(settings)
    return Promise.all(entries.map(async entry => ({
      entryId: pluginEntryId(entry.entryId),
      moduleName: entry.moduleName,
      ...await pluginMetadata(entry.moduleName, this.ctx.baseUrl, entry),
      enabled: entry.enabled,
      presetId: entry.presetId,
      ...entry.rowId === undefined ? {} : { presetRowId: entry.rowId },
      newSessionsOnly: true,
      initialEnabled: this.initialEnabled.get(this.initialKey(entry.entryId, target)) ?? entry.enabled,
      restartRequired: false,
      toggleable: true,
      fiberPhase: null,
    })))
  }

  /**
   * List Host entries and preset leaves, or only the selected workspace's preset leaves.
   * @param request - Workspace and editable settings layer; omission selects global inventory.
   * @returns the current inventory projection.
   */
  @Remote('list')
  async list(request?: SettingsTarget): Promise<PluginInventorySnapshot> {
    const target = request ?? {}
    this.assertTarget(target)
    const workspace = target.workspaceId === undefined ? undefined : await this.workspaceTarget(target.workspaceId, target.layer)
    const selected = workspace?.target ?? {}
    const entries = workspace === undefined
      ? [...await this.hostEntries(), ...await this.presetEntries(this.agentPresets())]
      : await this.presetEntries(workspace.presets, workspace.settings, selected)
    for (const entry of entries) {
      const key = this.initialKey(entry.entryId, selected)
      if (!this.initialEnabled.has(key)) this.initialEnabled.set(key, entry.enabled)
    }
    return { entries, ...selected }
  }

  /** Keep initial preset states separate for global and workspace settings files. */
  private initialKey(entryId: string, target: SettingsTarget): string {
    return target.workspaceId === undefined ? entryId : `${target.workspaceId}:${target.layer ?? 'local'}:${entryId}`
  }

  /** Group only explicitly related entries, preferring a persistently editable owner. */
  private inventoryGroups(rootInclude: Include | undefined): Entry[][] {
    const groups = new Map<string, Entry[]>()
    for (const entry of this.representatives(rootInclude).values()) {
      const key = entry.options.pluginGroup === undefined ? `module:${entry.options.name}`
        : `group:${entry.options.pluginGroup}:${entry.options.pluginRequired === true || this.required.has(entry.options.name) ? 'required' : 'optional'}`
      const group = groups.get(key) ?? []
      if (this.isToggleable(entry, rootInclude) && group[0] !== undefined && !this.isToggleable(group[0], rootInclude)) group.unshift(entry)
      else group.push(entry)
      groups.set(key, group)
    }
    return [...groups.values()]
  }

  /**
   * Persist a restart-only root state without live unload, or apply one normal
   * module-wide live state and persist it in the shared settings document.
   * @param request - Target entry, desired enablement, and optional workspace settings file.
   * @returns The fresh snapshot and whether this mutation needs a restart.
   */
  @Remote('setEnabled')
  setEnabled(request: PluginEnablementRequest): Promise<PluginEnablementResult> {
    this.assertTarget(request)
    return this.enqueue(async () => {
      const workspace = request.workspaceId === undefined ? undefined : await this.workspaceTarget(request.workspaceId, request.layer)
      if (workspace !== undefined && !request.entryId.startsWith(AGENT_PRESET_ENTRY_PREFIX)) {
        throw new Error('pluginInventory: workspace settings can change only agent preset entries')
      }
      if (request.entryId.startsWith(AGENT_PRESET_ENTRY_PREFIX)) {
        const presets = workspace === undefined ? this.agentPresets() : workspace.presets
        if (presets === undefined) {
          throw new Error('pluginInventory: agent preset controls are unavailable')
        }
        const entries = workspace === undefined ? await presets.listPluginEntries() : await presets.listPluginEntries(workspace.settings)
        const entry = entries
          .find(candidate => candidate.entryId === request.entryId)
        if (entry === undefined) {
          throw new Error(`pluginInventory: preset entry ${request.entryId} cannot be toggled in-app`)
        }
        const key = this.initialKey(entry.entryId, workspace?.target ?? {})
        if (!this.initialEnabled.has(key)) this.initialEnabled.set(key, entry.enabled)
        if (entry.enabled !== request.enabled) {
          if (workspace === undefined) await presets.setPluginEnabled(entry.entryId, request.enabled)
          else await presets.setPluginEnabled(entry.entryId, request.enabled, workspace.settings)
        }
        return { snapshot: await this.list(workspace?.target), restartRequired: false }
      }
      const resolved = this.ctx.loader.resolve(request.entryId)
      const rootInclude = this.rootInclude()
      const group = this.inventoryGroups(rootInclude)
        .find(candidates => candidates.some(candidate => candidate.options.name === resolved.options.name)) ?? []
      const entry = group[0]
      if (entry === undefined || !this.isToggleable(entry, rootInclude)) {
        throw new Error(`pluginInventory: entry ${request.entryId} cannot be toggled in-app`)
      }
      const members = group.filter(candidate => this.isToggleable(candidate, rootInclude))
      if (members.every(candidate => request.enabled === this.desiredEnabled(candidate))) {
        return { snapshot: await this.list(), restartRequired: members.some(candidate => this.restartRequired(candidate)) }
      }

      if (group.some(candidate => this.isRestartOnly(candidate))) {
        await this.setRestartEnabled(members, request.enabled)
        return { snapshot: await this.list(), restartRequired: members.some(candidate => this.restartRequired(candidate)) }
      }

      const states: EntryState[] = []
      try {
        for (const member of members) states.push(...await this.updateModule(member, request.enabled))
        await this.settings.update({ enabled: Object.fromEntries(members.map(member => [member.options.name, request.enabled])) })
      } catch (error) {
        try {
          await this.restore(states)
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], `pluginInventory: failed to persist and roll back ${request.entryId}`)
        }
        throw error
      }
      return { snapshot: await this.list(), restartRequired: false }
    })
  }

  /**
   * Project every persisted OpenAI/Codex marketplace source.
   * @returns OpenAI/Codex marketplace sources in persisted order.
   */
  @Remote('listMarketplaces')
  listMarketplaces(): Promise<PluginMarketplaceSnapshot> {
    return this.marketplaceSnapshot()
  }

  /**
   * Persist one validated OpenAI/Codex marketplace source, replacing any source of the same location.
   * @param request - marketplace location with its optional Git ref and sparse paths.
   * @returns The refreshed OpenAI/Codex marketplace source list.
   */
  @Remote('addMarketplace')
  addMarketplace(request: AddPluginMarketplaceRequest): Promise<PluginMarketplaceSnapshot> {
    return this.enqueue(async () => {
      const loaded = await loadMarketplace(request)
      const sources = this.marketplaceSettings.get().sources
      const existing = sources.findIndex(source => source.source === loaded.source.source)
      const entry = { ...loaded.source, enabled: sources[existing]?.enabled ?? true }
      const next = existing === -1
        ? [...sources, entry]
        : sources.map((source, index) => index === existing ? entry : source)
      await this.marketplaceSettings.update({ sources: next })
      return this.marketplaceSnapshot()
    })
  }

  /**
   * Enable or disable one marketplace slot, cascading to its imported plugins.
   * @param request - marketplace source and its desired enablement.
   * @returns The refreshed OpenAI/Codex marketplace source list.
   */
  @Remote('setMarketplaceEnabled')
  setMarketplaceEnabled(request: SetPluginMarketplaceEnablementRequest): Promise<PluginMarketplaceSnapshot> {
    return this.enqueue(async () => {
      const sources = this.marketplaceSettings.get().sources
      const index = sources.findIndex(candidate => candidate.source === request.source)
      if (index === -1) throw new Error(`pluginInventory: marketplace ${request.source} is not configured`)
      const next = sources.map((candidate, position) => position === index
        ? { ...candidate, enabled: request.enabled }
        : candidate)
      await this.marketplaceSettings.update({ sources: next })
      await this.cascadeMarketplacePlugins(
        request.source,
        (runtime, identity) => request.enabled ? runtime.enable(identity) : runtime.disable(identity),
      )
      return this.marketplaceSnapshot()
    })
  }

  /**
   * Remove one persisted OpenAI/Codex marketplace source and uninstall its imported plugins.
   * @param source - the persisted marketplace location to delete.
   * @returns The refreshed OpenAI/Codex marketplace source list.
   */
  @Remote('removeMarketplace')
  removeMarketplace(source: string): Promise<PluginMarketplaceSnapshot> {
    return this.enqueue(async () => {
      if (!this.marketplaceSettings.get().sources.some(candidate => candidate.source === source)) {
        throw new Error(`pluginInventory: marketplace ${source} is not configured`)
      }
      await this.cascadeMarketplacePlugins(source, (runtime, identity) => runtime.remove(identity))
      const next = this.marketplaceSettings.get().sources.filter(candidate => candidate.source !== source)
      await this.marketplaceSettings.update({ sources: next })
      return await this.marketplaceSnapshot()
    })
  }

  /**
   * Apply one lifecycle action to every plugin imported from this marketplace root.
   * A no-op when the imported-plugin runtime is not part of this composition.
   */
  private async cascadeMarketplacePlugins(
    marketplace: string,
    action: (runtime: ImportedPluginRuntime, identity: string) => Promise<ImportedPluginSnapshot>,
  ): Promise<void> {
    const runtime = this.ctx.get('importedPlugins')
    if (runtime === undefined) return
    const plugins = (await runtime.list()).plugins.filter(plugin => plugin.source.marketplace === marketplace)
    const failures: unknown[] = []
    for (const plugin of plugins) {
      try {
        await action(runtime, plugin.identity)
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) {
      throw new AggregateError(failures, `pluginInventory: failed to update plugins for marketplace ${marketplace}`)
    }
  }

  /**
   * List source-qualified imported OpenAI/Codex plugin bundles.
   * @returns Current imported-plugin projection.
   */
  @Remote('listImportedPlugins')
  listImportedPlugins(): Promise<ImportedPluginSnapshot> {
    return this.importedPlugins().list()
  }

  /**
   * Stage a direct local/Git source or marketplace bundle through the shared runtime.
   * @param source - Plugin source to import.
   * @returns Current imported-plugin projection.
   */
  @Remote('importPlugin')
  importPlugin(source: PluginImportSource): Promise<ImportedPluginSnapshot> {
    return this.importedPlugins().import(source)
  }

  /**
   * Read one imported bundle by source-qualified identity or an unambiguous name.
   * @param identityOrName - Source-qualified identity or unambiguous plugin name.
   * @returns Current plugin projection.
   */
  @Remote('infoPlugin')
  infoPlugin(identityOrName: string): Promise<ImportedPluginEntry> {
    return this.importedPlugins().info(identityOrName)
  }

  /**
   * Enable and load one imported bundle without changing native Hydra package state.
   * @param identityOrName - Source-qualified identity or unambiguous plugin name.
   * @returns Current imported-plugin projection.
   */
  @Remote('enablePlugin')
  enablePlugin(identityOrName: string): Promise<ImportedPluginSnapshot> {
    return this.importedPlugins().enable(identityOrName)
  }

  /**
   * Disable and deterministically unload one imported bundle.
   * @param identityOrName - Source-qualified identity or unambiguous plugin name.
   * @returns Current imported-plugin projection.
   */
  @Remote('disablePlugin')
  disablePlugin(identityOrName: string): Promise<ImportedPluginSnapshot> {
    return this.importedPlugins().disable(identityOrName)
  }

  /**
   * Change one imported plugin MCP server without changing hook trust.
   * @param request - plugin identity, server name, and desired enablement.
   * @returns Current imported-plugin projection.
   */
  @Remote('setPluginMcpServerEnabled')
  setPluginMcpServerEnabled(
    request: ImportedPluginMcpServerEnablementRequest,
  ): Promise<ImportedPluginSnapshot> {
    return this.importedPlugins().setMcpServerEnabled(request.identity, request.server, request.enabled)
  }

  /**
   * Set one imported MCP tool's approval mode without changing server enablement.
   * @param request - Plugin identity, server, tool, and approval mode.
   * @returns Current imported-plugin projection.
   */
  @Remote('setPluginMcpToolApproval')
  setPluginMcpToolApproval(
    request: ImportedPluginMcpToolApprovalRequest,
  ): Promise<ImportedPluginSnapshot> {
    return this.importedPlugins().setMcpToolApproval(request.identity, request.server, request.tool, request.approval)
  }

  /**
   * Trust only the current hook definitions; MCP/tool approval remains independent.
   * @param identityOrName - Source-qualified identity or unambiguous plugin name.
   * @returns Current imported-plugin projection.
   */
  @Remote('trustPlugin')
  trustPlugin(identityOrName: string): Promise<ImportedPluginSnapshot> {
    return this.importedPlugins().trustHooks(identityOrName)
  }

  /**
   * Revoke hook trust without disabling other plugin components.
   * @param identityOrName - Source-qualified identity or unambiguous plugin name.
   * @returns Current imported-plugin projection.
   */
  @Remote('untrustPlugin')
  untrustPlugin(identityOrName: string): Promise<ImportedPluginSnapshot> {
    return this.importedPlugins().untrustHooks(identityOrName)
  }

  /**
   * Remove one imported bundle and its writable plugin data.
   * @param identityOrName - Source-qualified identity or unambiguous plugin name.
   * @returns Current imported-plugin projection.
   */
  @Remote('removePlugin')
  removePlugin(identityOrName: string): Promise<ImportedPluginSnapshot> {
    return this.importedPlugins().remove(identityOrName)
  }

  /**
   * List the user's own MCP server records with their live state.
   * @param request - Workspace to inspect; omission selects the user's global records.
   * @returns Selected settings records with runtime status and the workspace target.
   */
  @Remote('listMcpServers')
  listMcpServers(request?: SettingsTarget): Promise<McpServerSnapshot & SettingsTarget> {
    const target = request ?? {}
    this.assertTarget(target)
    if (target.workspaceId !== undefined) {
      return this.workspaceTarget(target.workspaceId, target.layer)
        .then(({ ctx, settings, target: selected }) => ({ ...this.mcpServers(ctx).list(settings), ...selected }))
    }
    return Promise.resolve(this.mcpServers().list())
  }

  /**
   * Store one complete MCP server definition and converge its mount.
   * @param request - Complete server definition and optional workspace file to edit.
   * @returns Refreshed MCP record projection.
   */
  @Remote('defineMcpServer')
  defineMcpServer(request: McpServerDefinitionRequest & SettingsTarget): Promise<McpServerSnapshot & SettingsTarget> {
    this.assertTarget(request)
    if (request.workspaceId !== undefined) {
      return this.workspaceTarget(request.workspaceId, request.layer).then(async ({ ctx, settings, target }) => {
        const registry = this.mcpServers(ctx)
        await registry.define(request, settings)
        return { ...registry.list(settings), ...target }
      })
    }
    return this.mcpServers().define(request)
  }

  /**
   * Change one MCP record's desired state without touching its definition.
   * @param request - Target record, desired state, and optional workspace file to edit.
   * @returns Refreshed MCP record projection.
   */
  @Remote('setMcpServerEnabled')
  setMcpServerEnabled(request: McpServerEnablementRequest & SettingsTarget): Promise<McpServerSnapshot & SettingsTarget> {
    this.assertTarget(request)
    if (request.workspaceId !== undefined) {
      return this.workspaceTarget(request.workspaceId, request.layer).then(async ({ ctx, settings, target }) => {
        const registry = this.mcpServers(ctx)
        await registry.setEnabled(request, settings)
        return { ...registry.list(settings), ...target }
      })
    }
    return this.mcpServers().setEnabled(request)
  }

  /**
   * Remove one MCP record and unmount its server.
   * @param request - Stored record name and optional workspace file to edit; a string selects global records.
   * @returns Refreshed MCP record projection.
   */
  @Remote('removeMcpServer')
  removeMcpServer(request: string | ({ name: string } & SettingsTarget)): Promise<McpServerSnapshot & SettingsTarget> {
    if (typeof request !== 'string') this.assertTarget(request)
    if (typeof request !== 'string' && request.workspaceId !== undefined) {
      return this.workspaceTarget(request.workspaceId, request.layer).then(async ({ ctx, settings, target }) => {
        const registry = this.mcpServers(ctx)
        await registry.remove(request.name, settings)
        return { ...registry.list(settings), ...target }
      })
    }
    return this.mcpServers().remove(typeof request === 'string' ? request : request.name)
  }

  /**
   * List the user's own hook records with their live state.
   * @param request - Workspace to inspect; omission selects the user's global records.
   * @returns Selected settings records with runtime status and the workspace target.
   */
  @Remote('listHookRecords')
  listHookRecords(request?: SettingsTarget): Promise<HookRecordSnapshot & SettingsTarget> {
    const target = request ?? {}
    this.assertTarget(target)
    if (target.workspaceId !== undefined) {
      return this.workspaceTarget(target.workspaceId, target.layer)
        .then(({ ctx, settings, target: selected }) => ({ ...this.hookRecords(ctx).list(settings), ...selected }))
    }
    return Promise.resolve(this.hookRecords().list())
  }

  /**
   * Store one complete hook record definition and converge its bridge mount.
   * @param request - Complete record definition and optional workspace file to edit.
   * @returns Refreshed hook record projection.
   */
  @Remote('defineHookRecord')
  defineHookRecord(request: HookRecordDefinitionRequest & SettingsTarget): Promise<HookRecordSnapshot & SettingsTarget> {
    this.assertTarget(request)
    if (request.workspaceId !== undefined) {
      return this.workspaceTarget(request.workspaceId, request.layer).then(async ({ ctx, settings, target }) => {
        const registry = this.hookRecords(ctx)
        await registry.define(request, settings)
        return { ...registry.list(settings), ...target }
      })
    }
    return this.hookRecords().define(request)
  }

  /**
   * Change one hook record's desired state without touching its definition.
   * @param request - Target record, desired state, and optional workspace file to edit.
   * @returns Refreshed hook record projection.
   */
  @Remote('setHookRecordEnabled')
  setHookRecordEnabled(request: HookRecordEnablementRequest & SettingsTarget): Promise<HookRecordSnapshot & SettingsTarget> {
    this.assertTarget(request)
    if (request.workspaceId !== undefined) {
      return this.workspaceTarget(request.workspaceId, request.layer).then(async ({ ctx, settings, target }) => {
        const registry = this.hookRecords(ctx)
        await registry.setEnabled(request, settings)
        return { ...registry.list(settings), ...target }
      })
    }
    return this.hookRecords().setEnabled(request)
  }

  /**
   * Remove one hook record and unmount its bridge.
   * @param request - Stored record name and optional workspace file to edit; a string selects global records.
   * @returns Refreshed hook record projection.
   */
  @Remote('removeHookRecord')
  removeHookRecord(request: string | ({ name: string } & SettingsTarget)): Promise<HookRecordSnapshot & SettingsTarget> {
    if (typeof request !== 'string') this.assertTarget(request)
    if (typeof request !== 'string' && request.workspaceId !== undefined) {
      return this.workspaceTarget(request.workspaceId, request.layer).then(async ({ ctx, settings, target }) => {
        const registry = this.hookRecords(ctx)
        await registry.remove(request.name, settings)
        return { ...registry.list(settings), ...target }
      })
    }
    return this.hookRecords().remove(typeof request === 'string' ? request : request.name)
  }

  /** Reject a workspace file selector that cannot identify a workspace. */
  private assertTarget(target: SettingsTarget): void {
    if (target.workspaceId === undefined && target.layer !== undefined) {
      throw new Error('pluginInventory: layer requires workspaceId')
    }
  }

  /** Resolve one workspace's runtime services and selected editable settings file. */
  private async workspaceTarget(
    workspaceId: NonNullable<SettingsTarget['workspaceId']>, layer: SettingsTarget['layer'] = 'local',
  ): Promise<{ ctx: Context; presets: AgentPresetPluginControls | undefined; settings: SettingsProvider; target: SettingsTarget }> {
    const service = this.ctx.get('workspaceConfig')
    if (service === undefined) throw new Error('pluginInventory: workspace configuration is unavailable')
    const environment = await service.environmentFor(workspaceId)
    const settings = await service.settingsFor(workspaceId, layer)
    return { ctx: environment.ctx, presets: environment.presets, settings, target: { workspaceId, layer } }
  }

  private importedPlugins(): ImportedPluginRuntime {
    const runtime = this.ctx.get('importedPlugins')
    if (runtime === undefined) throw new Error('pluginInventory: imported plugin runtime is unavailable')
    return runtime
  }

  /** The MCP record registry is optional in compositions without user MCP servers. */
  private mcpServers(ctx = this.ctx): McpServerRegistry {
    const registry = ctx.get('mcpServers')
    if (registry === undefined) throw new Error('pluginInventory: MCP server registry is unavailable')
    return registry
  }

  /** The hook record registry is optional in compositions without user hooks. */
  private hookRecords(ctx = this.ctx): HookRecordRegistry {
    const registry = ctx.get('hookRecords')
    if (registry === undefined) throw new Error('pluginInventory: hook record registry is unavailable')
    return registry
  }

  /** Agent-preset ownership is optional in headless and non-roster compositions. */
  private agentPresets(): AgentPresetPluginControls | undefined {
    return this.ctx.get('agentPresets')
  }
}

export default PluginInventoryGateway

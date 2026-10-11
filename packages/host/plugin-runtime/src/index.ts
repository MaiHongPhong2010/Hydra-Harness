/** Shared, immutable runtime for imported OpenAI/Codex and Claude plugin bundles. */

import { execFile } from 'node:child_process'
import type {} from '@hydraharness/harness-optional-plugins'
import { createHash, randomUUID } from 'node:crypto'
import {
  copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { Service, type Context, type Fiber } from '@hydraharness/cordis'
import { withFileLock, writeFileAtomic } from '@hydraharness/harness-atomic-write'
import type {} from '@hydraharness/harness-commands'
import type { CommandResult } from '@hydraharness/harness-commands'
import { resolveHydraHome } from '@hydraharness/harness-home-paths'
import { apply as applyCodexHooks, inject as codexHooksInject } from '@hydraharness/harness-hooks-codex'
import { parseCodexConfig } from '@hydraharness/harness-hooks-codex/config'
import { createUserMessage } from '@hydraharness/harness-llm'
import { apply as applyMcpClient, inject as mcpClientInject, publicToolName, type Config as McpClientConfig } from '@hydraharness/harness-mcp-client'
import {
  BUNDLED_SKILL_RANK,
  parseSkillDocument,
  type SkillDocument,
  type SkillCandidate, type SkillDefinition, type SkillLookupOptions, type SkillProvider,
} from '@hydraharness/harness-skill'
import type { PreToolDecision, ToolExecution } from '@hydraharness/harness-tools'
import { parse as parseToml } from 'smol-toml'
import { parse as parseYaml } from 'yaml'
import type {
  HookTrustState, ImportedMcpServerSnapshot, ImportedPluginAgentMetadata, ImportedPluginEntry, ImportedPluginIdentity,
  ImportedPluginSnapshot, ImportedPluginSource, ImportPluginRequest, PluginImportSource, PluginManifest,
} from './types.ts'

export type * from './types.ts'

declare module '@hydraharness/cordis' {
  interface Context {
    importedPlugins: ImportedPluginRuntime
  }
}

/** Services required by the imported-plugin runtime. */
export const inject = ['skills', 'commands', 'tools']

/** Runtime configuration for the imported-plugin service. */
export interface Config {
  /** Override the resolved Hydra home directory. */
  hydraHome?: string
}

const REGISTRY_VERSION = 1
const MAX_PACKAGE_BYTES = 64 * 1024 * 1024
const MAX_FILE_BYTES = 8 * 1024 * 1024
const MAX_FILES = 4_000
const MAX_MANIFEST_BYTES = 256 * 1024
const MAX_MARKETPLACE_BYTES = 1024 * 1024
const GIT_TIMEOUT_MS = 30_000
const PLUGIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u
const COMMAND_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
// oxlint-disable-next-line @stylistic/max-len
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u
const GITHUB_SHORTHAND = /^([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)$/u
const SCP_GIT_SOURCE = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[A-Za-z0-9._~/-]+$/u
const AGENT_PLUGIN_SCHEMA_URI = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json'
const AGENT_PLUGIN_SCHEMA_PREFIX = 'https://agent-plugins.org/schemas/'
const PLUGIN_COMMAND_HINT = '[list|import <folder-or-git-source>|install <plugin[@marketplace]|folder-or-git-source>|marketplace add <folder-or-git-source>|marketplace list|marketplace remove <source>|info <name>|enable <name>|disable <name>|trust <name>|untrust <name>|remove <name>]'

/** Optional Host inventory used by `/plugin marketplace` without a package dependency. */
interface MarketplaceInventory {
  addMarketplace(request: { source: string }): Promise<MarketplaceList>
  listMarketplaces(): Promise<MarketplaceList>
  removeMarketplace(source: string): Promise<MarketplaceList>
}

interface MarketplaceList {
  readonly marketplaces: readonly {
    readonly source: string
    readonly status?: string
    readonly enabled?: boolean
  }[]
}

interface HookDefinition {
  readonly label: string
  readonly raw: Record<string, unknown>
}

interface McpDefinition {
  readonly name: string
  readonly config: McpClientConfig
}

interface LoadedPlugin {
  readonly root: string
  readonly manifest: PluginManifest
  readonly skills: readonly LoadedSkill[]
  readonly commands: readonly LoadedCommand[]
  readonly mcp: readonly McpDefinition[]
  readonly hooks: readonly HookDefinition[]
  readonly hookDigest?: string
  readonly apps?: Readonly<Record<string, unknown>>
  readonly agentMetadata?: ImportedPluginAgentMetadata
}

interface LoadedSkill {
  readonly rawName: string
  readonly description: string
  readonly whenToUse?: string
  readonly invocation: SkillDocument['invocation']
  readonly path: string
  readonly directory: string
  readonly agentMetadata?: ImportedPluginAgentMetadata
  readonly openAiModelInvocable: boolean
}

interface LoadedCommand {
  readonly name: string
  readonly description: string
  readonly prompt: string
  readonly inputHint?: string
}

interface StoredMcpState {
  enabled: boolean
  defaultToolsApprovalMode: 'ask' | 'allow' | 'deny'
  toolApproval: Record<string, 'ask' | 'allow' | 'deny'>
}

interface StoredPlugin {
  name: string
  source: ImportedPluginSource
  activeVersion: string
  versions: Record<string, { installedAt: string }>
  enabled: boolean
  hookTrustDigest?: string
  mcp: Record<string, StoredMcpState>
}

interface StoredRegistry {
  version: number
  plugins: Record<string, StoredPlugin>
}

interface SourceMaterial {
  readonly root: string
  readonly source: ImportedPluginSource
  readonly dispose: () => Promise<void>
}

interface MarketplaceGitPlugin {
  readonly source: string
  readonly path?: string
  readonly ref?: string
  readonly selector: string
}

interface RuntimeComponent {
  skillDispose?: () => void
  commandDisposes: (() => void)[]
  hookFiber?: Fiber
  mcpFibers: Map<string, Fiber>
}

type ManifestFormat = 'legacy' | 'portable' | 'claude'
type ManifestLocation = { readonly path: string; readonly format: ManifestFormat }

/** Plugin root resolver and manifest parser. It never executes plugin files. */
export class PluginManifestLoader {
  /**
   * Validate and discover one bundle without executing it.
   * @param root - Candidate plugin-root directory.
   * @param identity - Source-qualified identity used to namespace MCP servers.
   * @returns Parsed manifest and discovered component definitions.
   */

  async load(root: string, identity = 'plugin'): Promise<LoadedPlugin> {
    const checkedRoot = await validateBundleTree(root)
    const manifestLocation = await pluginManifestPath(checkedRoot)
    const manifest = parseManifest(
      await readBoundedJson(manifestLocation.path, MAX_MANIFEST_BYTES, 'plugin manifest'),
      manifestLocation.format,
    )
    if (manifest.format === 'claude') await rejectUnsupportedClaudeComponents(checkedRoot)
    const agentMetadata = await discoverOpenAiMetadata(checkedRoot)
    const skills = await discoverSkills(checkedRoot, manifest, agentMetadata)
    const commands = await discoverCommands(checkedRoot)
    const mcp = await discoverMcp(checkedRoot, manifest, identity)
    const hooks = await discoverHooks(checkedRoot, manifest)
    const apps = await discoverApps(checkedRoot, manifest)
    return {
      root: checkedRoot,
      manifest,
      skills,
      commands,
      mcp,
      hooks,
      ...hooks.length === 0 ? {} : { hookDigest: digest(hooks.map(hook => hook.raw)) },
      ...apps === undefined ? {} : { apps },
      ...agentMetadata === undefined ? {} : { agentMetadata },
    }
  }
}

/** Durable registry and immutable bundle store beneath one Hydra home directory. */
export class PluginStore {
  /** Immutable versioned plugin-bundle root. */
  readonly cacheRoot: string
  /** Persistent writable plugin-data root. */
  readonly dataRoot: string
  /** Durable source-qualified plugin registry path. */
  readonly registryPath: string
  private readonly manifests = new PluginManifestLoader()

  constructor(readonly home = resolveHydraHome()) {
    this.cacheRoot = join(home, 'plugins', 'cache')
    this.dataRoot = join(home, 'plugins', 'data')
    this.registryPath = join(home, 'plugins', 'registry.json')
  }

  /**
   * List every stored entry by source-qualified identity.
   * @returns Every stored entry by source-qualified identity.
   */
  async list(): Promise<ReadonlyMap<string, StoredPlugin>> {
    return new Map(Object.entries((await this.readRegistry()).plugins))
  }

  /**
   * Read one stored plugin entry.
   * @param identity - Source-qualified plugin identity.
   * @returns Stored entry, or undefined when absent.
   */
  async get(identity: string): Promise<StoredPlugin | undefined> {
    return (await this.readRegistry()).plugins[identity]
  }

  /**
   * Validate, stage, and activate one imported source.
   * @param source - Local, Git, or marketplace source.
   * @returns Source-qualified identity of the activated plugin.
   */
  async install(source: PluginImportSource): Promise<string> {
    const material = await materializeSource(source)
    try {
      const preliminary = await this.manifests.load(material.root)
      const identity = pluginIdentity(preliminary.manifest.name, material.source.sourceId)
      // The source is treated as untrusted twice: once before copying and again
      // after staging, so a local source cannot race a checked installation.
      await this.ensureRegistryDirectory()
      return await withFileLock(this.registryPath, async () => {
        const stageParent = join(this.cacheRoot, material.source.sourceId, preliminary.manifest.name)
        const stage = join(stageParent, `.staging-${randomUUID()}`)
        const target = join(stageParent, preliminary.manifest.version)
        try {
          await copyTree(material.root, stage)
          const staged = await this.manifests.load(stage, identity)
          if (staged.manifest.name !== preliminary.manifest.name || staged.manifest.version !== preliminary.manifest.version) {
            throw new Error('plugin runtime: plugin manifest changed while staging')
          }
          const registry = await this.readRegistry()
          const duplicate = Object.entries(registry.plugins)
            .find(([candidateIdentity, candidate]) => candidateIdentity !== identity && candidate.name === staged.manifest.name)
          if (duplicate !== undefined) {
            throw new Error(`plugin runtime: ${staged.manifest.name} is already installed from another source as ${duplicate[0]}; remove it before importing this source`)
          }
          await mkdir(stageParent, { recursive: true, mode: 0o700 })
          if (!await exists(target)) await rename(stage, target)
          const previous = registry.plugins[identity]
          registry.plugins[identity] = {
            name: staged.manifest.name,
            source: material.source,
            activeVersion: staged.manifest.version,
            versions: {
              ...previous?.versions,
              [staged.manifest.version]: { installedAt: new Date().toISOString() },
            },
            enabled: previous?.enabled ?? false,
            ...previous?.hookTrustDigest === undefined ? {} : { hookTrustDigest: previous.hookTrustDigest },
            mcp: initializeMcpState(staged.mcp, previous?.mcp),
          }
          await this.writeRegistry(registry)
          await mkdir(join(this.dataRoot, material.source.sourceId, staged.manifest.name), {
            recursive: true, mode: 0o700,
          })
          return identity
        } finally {
          await rm(stage, { recursive: true, force: true })
        }
      }, { waitMs: GIT_TIMEOUT_MS })
    } finally {
      await material.dispose()
    }
  }

  /**
   * Mutate one durable entry while holding the registry lock.
   * @param identity - Source-qualified plugin identity.
   * @param mutation - In-place mutation applied before atomic persistence.
   * @returns After the registry is persisted.
   */
  async update(identity: string, mutation: (entry: StoredPlugin) => void): Promise<void> {
    await this.ensureRegistryDirectory()
    await withFileLock(this.registryPath, async () => {
      const registry = await this.readRegistry()
      const entry = registry.plugins[identity]
      if (entry === undefined) throw new Error(`plugin runtime: imported plugin ${identity} is not installed`)
      mutation(entry)
      await this.writeRegistry(registry)
    })
  }

  /**
   * Remove one registry entry and its owned bundle and data directories.
   * @param identity - Source-qualified plugin identity.
   * @returns Removed entry, or undefined when absent.
   */
  async remove(identity: string): Promise<StoredPlugin | undefined> {
    await this.ensureRegistryDirectory()
    return await withFileLock(this.registryPath, async () => {
      const registry = await this.readRegistry()
      const entry = registry.plugins[identity]
      if (entry === undefined) return undefined
      const { [identity]: _removed, ...remainingPlugins } = registry.plugins
      registry.plugins = remainingPlugins
      await this.writeRegistry(registry)
      const cache = join(this.cacheRoot, entry.source.sourceId, entry.name)
      const data = join(this.dataRoot, entry.source.sourceId, entry.name)
      assertStoreDescendant(this.cacheRoot, cache)
      assertStoreDescendant(this.dataRoot, data)
      await rm(cache, { recursive: true, force: true })
      await rm(data, { recursive: true, force: true })
      return entry
    })
  }

  /**
   * Resolve the active immutable bundle path.
   * @param entry - Stored plugin entry.
   * @returns Active version directory.
   */
  bundlePath(entry: StoredPlugin): string {
    return join(this.cacheRoot, entry.source.sourceId, entry.name, entry.activeVersion)
  }

  /**
   * Resolve the persistent writable data path.
   * @param entry - Stored plugin entry.
   * @returns Plugin data directory.
   */
  dataPath(entry: StoredPlugin): string {
    return join(this.dataRoot, entry.source.sourceId, entry.name)
  }

  /**
   * Load one active stored bundle.
   * @param entry - Stored plugin entry.
   * @param identity - Source-qualified plugin identity.
   * @returns Parsed active bundle.
   */
  async load(entry: StoredPlugin, identity: string): Promise<LoadedPlugin> {
    return await this.manifests.load(this.bundlePath(entry), identity)
  }

  private async readRegistry(): Promise<StoredRegistry> {
    try {
      const raw = JSON.parse(await readFile(this.registryPath, 'utf8')) as unknown
      if (!isRecord(raw) || raw.version !== REGISTRY_VERSION || !isRecord(raw.plugins)) {
        throw new Error('plugin runtime: registry has an unsupported format')
      }
      return raw as unknown as StoredRegistry
    } catch (error) {
      if (isMissing(error)) return { version: REGISTRY_VERSION, plugins: {} }
      throw error
    }
  }

  private async writeRegistry(registry: StoredRegistry): Promise<void> {
    await writeFileAtomic(this.registryPath, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
  }

  private async ensureRegistryDirectory(): Promise<void> {
    await mkdir(dirname(this.registryPath), { recursive: true, mode: 0o700 })
  }
}

/** Lightweight views over the durable records; the runtime owns live components. */
export class PluginRegistry {
  constructor(private readonly store: PluginStore) {}

  /**
   * List every stored entry by source-qualified identity.
   * @returns Every stored entry by source-qualified identity.
   */
  list(): Promise<ReadonlyMap<string, StoredPlugin>> { return this.store.list() }
  /**
   * Read one stored plugin entry.
   * @param identity - Source-qualified plugin identity.
   * @returns Stored entry, or undefined when absent.
   */
  get(identity: string): Promise<StoredPlugin | undefined> { return this.store.get(identity) }
}

/** Explicit names for the runtime's independent trust and component registries. */
export class PluginTrustStore {
  constructor(private readonly store: PluginStore) {}
  /**
   * Record trust for one exact hook definition digest.
   * @param identity - Source-qualified plugin identity.
   * @param definitionDigest - Current canonical hook-definition digest.
   * @returns After trust persistence completes.
   */
  async trust(identity: string, definitionDigest: string): Promise<void> {
    await this.store.update(identity, (entry) => { entry.hookTrustDigest = definitionDigest })
  }
  /**
   * Remove recorded hook trust.
   * @param identity - Source-qualified plugin identity.
   * @returns After trust removal persists.
   */
  async untrust(identity: string): Promise<void> {
    await this.store.update(identity, (entry) => { delete entry.hookTrustDigest })
  }
}

/** Public lifecycle facade over the shared imported-plugin runtime. */
export class PluginLifecycleManager {
  constructor(private readonly runtime: ImportedPluginRuntime) {}
  /**
   * Enable and load one plugin.
   * @param identity - Source-qualified plugin identity.
   * @returns Refreshed installed-plugin projection.
   */
  enable(identity: string): Promise<ImportedPluginSnapshot> { return this.runtime.enable(identity) }
  /**
   * Disable and unload one plugin.
   * @param identity - Source-qualified plugin identity.
   * @returns Refreshed installed-plugin projection.
   */
  disable(identity: string): Promise<ImportedPluginSnapshot> { return this.runtime.disable(identity) }
  /**
   * Unload one plugin's live components.
   * @param identity - Source-qualified plugin identity.
   * @returns After owned components quiesce.
   */
  unload(identity: string): Promise<void> { return this.runtime.unload(identity) }
}

/** Shared `@hydraharness/harness-base` service for every imported bundle, not a Web-only facility. */
export class ImportedPluginRuntime extends Service {
  static inject = inject
  /** Component effects belong to the Host service, independent of a method caller's context. */
  private readonly owner: Context
  private readonly store: PluginStore
  /** Read-only facade over durable imported-plugin records. */
  readonly registry: PluginRegistry
  /** Hook-definition trust record manager. */
  readonly trust: PluginTrustStore
  /** Enablement and teardown facade. */
  readonly lifecycle: PluginLifecycleManager
  private readonly live = new Map<string, RuntimeComponent>()
  private readonly initialEnabled = new Map<string, boolean>()
  private readonly startup = new Map<string, Map<string, ImportedMcpServerSnapshot['startupState']>>()
  private mutationTail: Promise<unknown> = Promise.resolve()

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'importedPlugins')
    this.owner = ctx
    this.store = new PluginStore(resolveHydraHome(config.hydraHome))
    this.registry = new PluginRegistry(this.store)
    this.trust = new PluginTrustStore(this.store)
    this.lifecycle = new PluginLifecycleManager(this)
  }

  protected async [Service.init](): Promise<void> {
    this.ctx.inject(['optionalPlugins'], (pctx) => {
      pctx.effect(() => pctx.optionalPlugins.subscribe((enabled) => {
        void this.enqueue(async () => {
          if (!enabled) await pctx.optionalPlugins.drain()
          if (pctx.optionalPlugins.enabled !== enabled) return
          if (!enabled) for (const identity of [...this.live.keys()]) await this.unload(identity)
          else for (const [identity, entry] of await this.store.list()) if (entry.enabled) await this.load(identity, entry)
        }).catch((error: unknown) => { this.ctx.logger.error(error) })
      }), 'plugin-runtime: optional policy')
    })
    this.ctx.effect(() => () => this.dispose(), 'plugin-runtime.dispose')
    this.ctx.on('tools/pre-execute', (exec, next): Promise<PreToolDecision> => this.approveMcpTool(exec, next))
    this.ctx.commands.register({
      name: 'plugin',
      description: 'Manage imported OpenAI/Codex-compatible plugin bundles',
      input: { hint: PLUGIN_COMMAND_HINT },
      handler: async ({ rawInput }) => this.command(rawInput),
    })
    const entries = await this.store.list()
    for (const [identity, entry] of entries) {
      this.initialEnabled.set(identity, entry.enabled)
      if (entry.enabled) await this.load(identity, entry)
    }
  }

  /**
   * Return every imported plugin's current source-qualified runtime view.
   * @returns Current installed-plugin projection.
   */
  async list(): Promise<ImportedPluginSnapshot> {
    const entries = await this.store.list()
    return { plugins: await Promise.all([...entries].sort(([left], [right]) => left.localeCompare(right))
      .map(async ([identity, entry]) => await this.view(identity, entry))) }
  }

  /**
   * Return one installed plugin view.
   * @param identityOrName - Source-qualified identity or an unambiguous plugin name.
   * @returns Current installed-plugin projection.
   */
  async info(identityOrName: string): Promise<ImportedPluginEntry> {
    const [identity, entry] = await this.resolve(identityOrName)
    return await this.view(identity, entry)
  }

  /**
   * Stage one local, Git, or marketplace source.
   * @param source - Source to import.
   * @returns Refreshed installed-plugin projection.
   */
  import(source: PluginImportSource): Promise<ImportedPluginSnapshot> {
    return this.enqueue(async () => {
      const identity = await this.store.install(source)
      const entry = await this.require(identity)
      if (entry.enabled) await this.reload(identity, entry)
      return await this.list()
    })
  }

  /**
   * Enable and load one plugin.
   * @param identityOrName - Plugin identity or unambiguous name.
   * @returns Refreshed installed-plugin projection.
   */
  enable(identityOrName: string): Promise<ImportedPluginSnapshot> {
    return this.enqueue(async () => {
      const [identity] = await this.resolve(identityOrName)
      await this.store.update(identity, (entry) => { entry.enabled = true })
      await this.load(identity, await this.require(identity))
      return await this.list()
    })
  }

  /**
   * Disable and unload one plugin.
   * @param identityOrName - Plugin identity or unambiguous name.
   * @returns Refreshed installed-plugin projection.
   */
  disable(identityOrName: string): Promise<ImportedPluginSnapshot> {
    return this.enqueue(async () => {
      const [identity] = await this.resolve(identityOrName)
      await this.unload(identity)
      await this.store.update(identity, (entry) => { entry.enabled = false })
      return await this.list()
    })
  }

  /**
   * Trust one plugin's current hook definition.
   * @param identityOrName - Plugin identity or unambiguous name.
   * @returns Refreshed installed-plugin projection.
   */
  trustHooks(identityOrName: string): Promise<ImportedPluginSnapshot> {
    return this.enqueue(async () => {
      const [identity, entry] = await this.resolve(identityOrName)
      const loaded = await this.store.load(entry, identity)
      if (loaded.hookDigest === undefined) throw new Error(`plugin runtime: ${identity} has no hooks to trust`)
      await this.trust.trust(identity, loaded.hookDigest)
      if (entry.enabled) await this.reload(identity, await this.require(identity))
      return await this.list()
    })
  }

  /**
   * Revoke one plugin's hook trust.
   * @param identityOrName - Plugin identity or unambiguous name.
   * @returns Refreshed installed-plugin projection.
   */
  untrustHooks(identityOrName: string): Promise<ImportedPluginSnapshot> {
    return this.enqueue(async () => {
      const [identity, entry] = await this.resolve(identityOrName)
      await this.trust.untrust(identity)
      if (entry.enabled) await this.reload(identity, await this.require(identity))
      return await this.list()
    })
  }

  /**
   * Unload and remove one plugin with its owned store paths.
   * @param identityOrName - Plugin identity or unambiguous name.
   * @returns Refreshed installed-plugin projection.
   */
  remove(identityOrName: string): Promise<ImportedPluginSnapshot> {
    return this.enqueue(async () => {
      const [identity] = await this.resolve(identityOrName)
      await this.unload(identity)
      await this.store.remove(identity)
      return await this.list()
    })
  }

  /**
   * Set one plugin MCP server's lifecycle state.
   * @param identityOrName - Owning plugin identity or unambiguous name.
   * @param server - Manifest MCP server name.
   * @param enabled - Desired server state.
   * @returns Refreshed installed-plugin projection.
   */
  /* jscpd:ignore-start -- MCP lifecycle setters intentionally share queue and reload handling. */
  async setMcpServerEnabled(identityOrName: string, server: string, enabled: boolean): Promise<ImportedPluginSnapshot> {
    return this.enqueue(async () => {
      const [identity] = await this.resolve(identityOrName)
      await this.store.update(identity, (entry) => {
        const state = entry.mcp[server]
        if (!Object.hasOwn(entry.mcp, server) || state === undefined) throw new Error(`plugin runtime: MCP server ${server} is not declared`)
        state.enabled = enabled
        entry.mcp[server] = state
      })
      const entry = await this.require(identity)
      if (entry.enabled) await this.reload(identity, entry)
      return await this.list()
    })
  }

  /**
   * Set one MCP tool's approval mode.
   * @param identityOrName - Owning plugin identity or unambiguous name.
   * @param server - Manifest MCP server name.
   * @param tool - Raw MCP tool name or host-qualified public tool name.
   * @param approval - Independent per-tool approval mode.
   * @returns Refreshed installed-plugin projection.
   */
  async setMcpToolApproval(
    identityOrName: string,
    server: string,
    tool: string,
    approval: 'ask' | 'allow' | 'deny',
  ): Promise<ImportedPluginSnapshot> {
    return this.enqueue(async () => {
      const [identity] = await this.resolve(identityOrName)
      await this.store.update(identity, (entry) => {
        const state = entry.mcp[server]
        if (!Object.hasOwn(entry.mcp, server) || state === undefined) throw new Error(`plugin runtime: MCP server ${server} is not declared`)
        state.toolApproval[tool] = approval
        entry.mcp[server] = state
      })
      return await this.list()
    })
  }
  /* jscpd:ignore-end */

  /**
   * Unload every live component owned by one plugin.
   * @param identity - Installed plugin identity.
   * @returns After skills, hooks, and MCP fibers quiesce.
   */
  async unload(identity: string): Promise<void> {
    const component = this.live.get(identity)
    if (component === undefined) return
    this.live.delete(identity)
    component.skillDispose?.()
    for (const dispose of [...component.commandDisposes].reverse()) dispose()
    const fibers = [...component.mcpFibers.values(), component.hookFiber].filter((fiber): fiber is Fiber => fiber !== undefined)
    for (const fiber of fibers) void fiber.dispose()
    await Promise.all(fibers.map(async (fiber) => {
      await fiber.await().catch(() => {})
    }))
    this.startup.delete(identity)
  }

  private async load(identity: string, entry: StoredPlugin): Promise<void> {
    if (this.ctx.get('optionalPlugins')?.enabled === false) return
    if (this.live.has(identity)) return
    const loaded = await this.store.load(entry, identity)
    const component: RuntimeComponent = { commandDisposes: [], mcpFibers: new Map() }
    this.live.set(identity, component)
    try {
      const skillDispose = this.registerSkills(identity, loaded.skills)
      if (skillDispose !== undefined) component.skillDispose = skillDispose
      this.registerCommands(identity, loaded.commands, component.commandDisposes)
      await this.startMcp(identity, entry, loaded, component)
      if (loaded.hookDigest !== undefined && entry.hookTrustDigest === loaded.hookDigest) {
        component.hookFiber = await this.startHooks(identity, entry, loaded)
      }
    } catch (error) {
      await this.unload(identity)
      throw error
    }
  }

  private async reload(identity: string, entry: StoredPlugin): Promise<void> {
    await this.unload(identity)
    await this.load(identity, entry)
  }

  private registerSkills(identity: string, skills: readonly LoadedSkill[]): (() => void) | undefined {
    if (skills.length === 0) return undefined
    return this.owner.skills.registerProvider((): SkillProvider => ({
      name: `codex-plugin:${identity}`,
      list: (_options: SkillLookupOptions): Promise<SkillCandidate[]> => {
        return Promise.resolve(skills.map(skill => ({
          name: qualifiedSkillName(identity, skill.rawName),
          aliases: [skill.rawName],
          description: skill.description,
          ...skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse },
          invocation: skill.invocation,
          source: `codex-plugin:${identity}`,
          provider: `codex-plugin:${identity}`,
          rank: BUNDLED_SKILL_RANK,
          locator: skill,
          path: skill.path,
          resourceBase: { kind: 'directory', path: skill.directory },
          metadata: { pluginIdentity: identity, skillName: skill.rawName },
        })))
      },
      get: async (candidate: SkillCandidate): Promise<SkillDefinition | undefined> => {
        const skill = candidate.locator as LoadedSkill
        const parsed = parseSkillDocument(await readBoundedText(skill.path, MAX_FILE_BYTES, 'skill file'))
        if (parsed.name !== skill.rawName) return undefined
        return {
          name: candidate.name,
          description: parsed.description,
          ...parsed.whenToUse === undefined ? {} : { whenToUse: parsed.whenToUse },
          invocation: {
            ...parsed.invocation,
            modelInvocable: parsed.invocation.modelInvocable && skill.openAiModelInvocable,
          },
          source: `codex-plugin:${identity}`,
          provider: `codex-plugin:${identity}`,
          resourceBase: { kind: 'directory', path: skill.directory },
          path: skill.path,
          metadata: { pluginIdentity: identity, skillName: skill.rawName },
          content: parsed.content,
        }
      },
    }))
  }

  private registerCommands(identity: string, commands: readonly LoadedCommand[], disposes: (() => void)[]): void {
    for (const command of commands) {
      try {
        disposes.push(this.owner.commands.register({
          name: command.name,
          description: command.description,
          input: { hint: command.inputHint ?? '[arguments]' },
          handler: ({ agent, rawInput }) => {
            agent.followup(createUserMessage({
              content: [{ type: 'text', text: renderCommandPrompt(command.prompt, rawInput) }],
              source: { kind: 'plugin', plugin: `codex-plugin:${identity}` },
            }))
            return { kind: 'success' }
          },
        }))
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes('is already registered')) throw error
        this.ctx.logger.warn(`plugin runtime: command "/${command.name}" from ${identity} ignored because a command with that name is already registered`)
      }
    }
  }

  private async startMcp(
    identity: string,
    entry: StoredPlugin,
    loaded: LoadedPlugin,
    component: RuntimeComponent,
  ): Promise<void> {
    const states = new Map<string, ImportedMcpServerSnapshot['startupState']>()
    this.startup.set(identity, states)
    const pending: Promise<void>[] = []
    for (const server of loaded.mcp) {
      // Imported MCP servers are opt-in: enabling the bundle must not start a
      // local command or remote connection before the user reviews it.
      if (entry.mcp[server.name]?.enabled !== true) continue
      states.set(server.name, 'starting')
      const fiber = this.owner.plugin({
        name: `imported-mcp:${identity}:${server.name}`,
        inject: mcpClientInject,
        apply: applyMcpClient,
      }, server.config)
      component.mcpFibers.set(server.name, fiber)
      pending.push(Promise.resolve(fiber).then(
        () => { states.set(server.name, 'started') },
        async () => {
          states.set(server.name, 'failed')
          component.mcpFibers.delete(server.name)
          try {
            await fiber.dispose()
          } catch {
            // The failed fiber is already inactive; no further cleanup is possible here.
          }
        },
      ))
    }
    await Promise.all(pending)
  }

  private async startHooks(identity: string, entry: StoredPlugin, loaded: LoadedPlugin): Promise<Fiber> {
    const configPath = join(this.store.dataPath(entry), `hooks-${loaded.hookDigest}.json`)
    const hookConfig = mergeHookDefinitions(loaded.hooks)
    // Windows profiles use PowerShell; expand known plugin variables without embedding path bytes as shell code.
    const text = JSON.stringify(hookConfig, (key, value: unknown) => key === 'command' && typeof value === 'string' && process.platform === 'win32'
      ? value.replaceAll(/\$\{((?:CLAUDE_)?PLUGIN_(?:ROOT|DATA))\}/gu, '${env:$1}') : value)
    await writeFileAtomic(configPath, `${text}\n`, { mode: 0o600, dirMode: 0o700 })
    return this.owner.plugin({
      name: `imported-hooks:${identity}`,
      inject: codexHooksInject,
      apply: applyCodexHooks,
    }, {
      configPath,
      env: {
        PLUGIN_ROOT: loaded.root,
        PLUGIN_DATA: this.store.dataPath(entry),
        CLAUDE_PLUGIN_ROOT: loaded.root,
        CLAUDE_PLUGIN_DATA: this.store.dataPath(entry),
      },
    })
  }

  private async view(identity: string, entry: StoredPlugin): Promise<ImportedPluginEntry> {
    const loaded = await this.store.load(entry, identity)
    const hookTrustState: HookTrustState = loaded.hookDigest === undefined
      ? 'not-applicable'
      : loaded.hookDigest === entry.hookTrustDigest ? 'trusted' : 'pending'
    const started = this.startup.get(identity)
    return {
      identity: identity as ImportedPluginIdentity,
      name: entry.name,
      ...loaded.manifest.description === undefined ? {} : { description: loaded.manifest.description },
      ...loaded.manifest.application === undefined ? {} : { application: loaded.manifest.application },
      version: entry.activeVersion,
      source: entry.source,
      pluginRoot: loaded.root,
      dataPath: this.store.dataPath(entry),
      enabled: entry.enabled,
      initialEnabled: this.initialEnabled.get(identity) ?? false,
      lifecycle: this.live.has(identity) ? 'loaded' : entry.enabled ? 'enabled' : 'disabled',
      hookTrustState,
      ...loaded.hookDigest === undefined ? {} : { hookDefinitionDigest: loaded.hookDigest },
      skills: loaded.skills.map(skill => skill.rawName),
      mcpServers: loaded.mcp.map(server => ({
        name: server.name,
        enabled: entry.mcp[server.name]?.enabled === true,
        startupState: started?.get(server.name) ?? 'not-started',
        authenticationState: server.config.transport === 'stdio' ? 'not-applicable' : 'unknown',
        defaultToolsApprovalMode: entry.mcp[server.name]?.defaultToolsApprovalMode ?? 'ask',
        toolApproval: entry.mcp[server.name]?.toolApproval ?? {},
        tools: this.ctx.tools.schemas().map(tool => tool.name)
          .filter(name => name.startsWith(`mcp__${mcpServerName(identity, server.name)}__`)).sort(),
      })),
      hooks: loaded.hooks.map(hook => hook.label),
      ...loaded.agentMetadata === undefined ? {} : { agentMetadata: loaded.agentMetadata },
      ...loaded.apps === undefined ? {} : { appMappings: Object.keys(loaded.apps).sort() },
      installationStatus: 'installed',
    }
  }

  private async resolve(identityOrName: string): Promise<[string, StoredPlugin]> {
    const value = identityOrName.trim()
    const entries = await this.store.list()
    const exact = entries.get(value)
    if (exact !== undefined) return [value, exact]
    const matches = [...entries].filter(([, entry]) => entry.name === value)
    if (matches.length === 1) return matches[0] as [string, StoredPlugin]
    if (matches.length > 1) throw new Error(`plugin runtime: ${value} exists in multiple sources; use <name>@<source-id>`)
    throw new Error(`plugin runtime: imported plugin ${value} is not installed`)
  }

  private async require(identity: string): Promise<StoredPlugin> {
    const entry = await this.store.get(identity)
    if (entry === undefined) throw new Error(`plugin runtime: imported plugin ${identity} is not installed`)
    return entry
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.mutationTail.then(task)
    this.mutationTail = run.then(() => undefined, () => undefined)
    return run
  }

  private async approveMcpTool(exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision> {
    if (!exec.name.startsWith('mcp__')) return await next()
    for (const [identity, component] of this.live) {
      const matching = [...component.mcpFibers.keys()]
        .find(name => exec.name.startsWith(`mcp__${mcpServerName(identity, name)}__`))
      if (matching === undefined) continue
      const entry = await this.require(identity)
      const state = entry.mcp[matching]
      const override = Object.entries(state?.toolApproval ?? {})
        .find(([raw]) => raw === exec.name || publicToolName(mcpServerName(identity, matching), raw) === exec.name)
      const toolName = override?.[0] ?? exec.name
      const approval = override?.[1] ?? state?.defaultToolsApprovalMode ?? 'ask'
      if (approval === 'allow') return await next()
      if (approval === 'deny') return { kind: 'deny', reason: `MCP tool ${toolName} is disabled by its plugin policy` }
      return { kind: 'ask', reason: `MCP tool ${toolName} requires approval` }
    }
    return await next()
  }

  private marketplaceInventory(): MarketplaceInventory | undefined {
    // Cross-plugin lookup: the inventory service lives in another composition
    // plane, so the Context merge cannot type it here.
    const inventory: unknown = this.ctx.get('pluginInventory')
    return inventory === undefined || inventory === null ? undefined : inventory as MarketplaceInventory
  }

  private requireMarketplaceInventory(): MarketplaceInventory {
    const inventory = this.marketplaceInventory()
    if (inventory === undefined) throw new Error('plugin runtime: plugin inventory is unavailable')
    return inventory
  }

  private async resolveMarketplace(name: string): Promise<string> {
    const trimmed = name.trim()
    if (isExplicitSource(trimmed)) return trimmed
    const inventory = this.marketplaceInventory()
    if (inventory === undefined) throw new Error(`plugin runtime: unknown marketplace ${trimmed}`)
    const { marketplaces } = await inventory.listMarketplaces()
    const key = marketplaceRepoKey(trimmed)
    const matches = marketplaces.filter(entry => entry.source === trimmed || marketplaceRepoKey(entry.source) === key)
    if (matches.length === 1) {
      /* v8 ignore next -- filter produced exactly one marketplace with a required source. */
      return matches[0]?.source ?? trimmed
    }
    if (matches.length > 1) throw new Error(`plugin runtime: marketplace ${trimmed} matches multiple sources`)
    throw new Error(`plugin runtime: unknown marketplace ${trimmed}`)
  }

  private async marketplaceCommand(input: string): Promise<CommandResult> {
    const [verb, ...rest] = input.split(/\s+/u).filter(part => part !== '')
    const argument = rest.join(' ')
    switch (verb) {
      case 'add': {
        if (argument === '') return usage()
        const inventory = this.marketplaceInventory()
        if (inventory === undefined) {
          await this.import(argument)
          return { kind: 'success', text: 'Plugin imported. It is disabled until explicitly enabled.' }
        }
        await inventory.addMarketplace({ source: argument })
        return { kind: 'success', text: 'Marketplace added. Install a plugin with /plugin install <name>@<marketplace>.' }
      }
      case 'list': {
        const { marketplaces } = await this.requireMarketplaceInventory().listMarketplaces()
        return {
          kind: 'success',
          text: marketplaces.length === 0
            ? 'No plugin marketplaces.'
            : marketplaces.map(entry => `${entry.source} ${entry.status ?? 'ready'}${entry.enabled === false ? ' disabled' : ''}`).join('\n'),
        }
      }
      case 'remove': {
        if (argument === '') return usage()
        await this.requireMarketplaceInventory().removeMarketplace(await this.resolveMarketplace(argument))
        return { kind: 'success', text: 'Marketplace removed.' }
      }
      default:
        return usage()
    }
  }

  private async installCommand(argument: string): Promise<CommandResult> {
    if (argument === '') return usage()
    const qualified = /^([A-Za-z0-9][A-Za-z0-9._-]{0,99})@(.+)$/u.exec(argument)
    let request: PluginImportSource
    if (isExplicitSource(argument)) {
      request = argument
    } else if (qualified !== null) {
      /* v8 ignore next -- both regex capture groups require at least one character. */
      const marketplace = qualified[2] ?? ''
      /* v8 ignore next -- both regex capture groups require at least one character. */
      const plugin = qualified[1] ?? ''
      request = { source: await this.resolveMarketplace(marketplace), plugin }
    } else {
      const entries = [...await this.store.list()].filter(([, entry]) => entry.name === argument)
      if (entries.length === 1) {
        /* v8 ignore next -- the filtered map contains exactly one entry tuple. */
        const [entryId] = entries[0] ?? []
        /* v8 ignore if -- every map entry tuple starts with its string key. */
        if (entryId === undefined) throw new Error(`plugin runtime: imported plugin ${argument} is not installed`)
        await this.enable(entryId)
        return { kind: 'success', text: `Plugin ${argument} enabled.` }
      }
      const inventory = this.marketplaceInventory()
      const marketplaces = inventory === undefined ? [] : (await inventory.listMarketplaces()).marketplaces
      if (marketplaces.length !== 1) throw new Error(`plugin runtime: imported plugin ${argument} is not installed`)
      const marketplace = marketplaces[0]
      /* v8 ignore if -- the preceding length check requires exactly one marketplace. */
      if (marketplace === undefined) throw new Error(`plugin runtime: imported plugin ${argument} is not installed`)
      request = { source: marketplace.source, plugin: argument }
    }
    const snapshot = await this.import(request)
    const name = snapshot.plugins[0]?.name
    if (name === undefined) throw new Error('plugin runtime: import produced no plugin')
    await this.enable(name)
    return { kind: 'success', text: `Plugin ${name} enabled.` }
  }

  private async command(rawInput: string): Promise<CommandResult> {
    const input = rawInput.trim()
    if (input === '' || input === 'list') {
      const plugins = (await this.list()).plugins
      return { kind: 'success', text: plugins.length === 0 ? 'No imported plugins.' : plugins
        .map(plugin => `${plugin.identity} ${plugin.version} ${plugin.enabled ? 'enabled' : 'disabled'}${plugin.hookTrustState === 'pending' ? ' (hook review pending)' : ''}`)
        .join('\n') }
    }
    const [verb] = input.split(/\s+/u)
    /* v8 ignore next -- splitting a non-empty input always yields a first word. */
    const argument = input.slice(verb?.length ?? 0).trim()
    try {
      switch (verb) {
        case 'import':
          if (argument === '') return usage()
          await this.import(argument)
          return { kind: 'success', text: 'Plugin imported. It is disabled until explicitly enabled.' }
        case 'install':
          return await this.installCommand(argument)
        case 'marketplace':
          return await this.marketplaceCommand(argument)
        case 'info': return argument === '' ? usage() : { kind: 'success', text: renderInfo(await this.info(argument)) }
        case 'enable': if (argument === '') return usage(); await this.enable(argument); return { kind: 'success', text: 'Plugin enabled.' }
        case 'disable': if (argument === '') return usage(); await this.disable(argument); return { kind: 'success', text: 'Plugin disabled and unloaded.' }
        case 'trust': if (argument === '') return usage(); await this.trustHooks(argument); return { kind: 'success', text: 'Current hook definitions trusted; no MCP/tool approval changed.' }
        case 'untrust': if (argument === '') return usage(); await this.untrustHooks(argument); return { kind: 'success', text: 'Hook trust removed.' }
        case 'remove': if (argument === '') return usage(); await this.remove(argument); return { kind: 'success', text: 'Plugin removed.' }
        default: return usage()
      }
    } catch (error) {
      return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
    }
  }

  private async dispose(): Promise<void> {
    for (const identity of [...this.live.keys()]) await this.unload(identity)
  }
}

export const name = 'plugin-runtime'
export default ImportedPluginRuntime

function usage(): CommandResult {
  return { kind: 'error', text: `Usage: /plugin ${PLUGIN_COMMAND_HINT}` }
}

function isExplicitSource(value: string): boolean {
  if (GITHUB_SHORTHAND.test(value) || SCP_GIT_SOURCE.test(value)) return true
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(value) || isAbsolute(value)) return true
  return !value.includes('@') && (value.includes('/') || value.includes('\\'))
}

function marketplaceRepoKey(source: string): string {
  const withoutGit = source.replace(/\.git$/iu, '')
  const parts = withoutGit.split(/[/\\:]/u).filter(part => part.length > 0)
  const last = parts.at(-1)
  /* v8 ignore next -- persisted marketplace sources always retain a host or path segment */
  return (last ?? source).toLowerCase()
}

function renderInfo(plugin: ImportedPluginEntry): string {
  return [
    `${plugin.identity} ${plugin.version}`,
    `source: ${plugin.source.source}`,
    `enabled: ${String(plugin.enabled)}; hooks: ${plugin.hookTrustState}`,
    `skills: ${plugin.skills.join(', ') || 'none'}`,
    `MCP: ${plugin.mcpServers.map(server => `${server.name}=${server.enabled ? server.startupState : 'disabled'}`).join(', ') || 'none'}`,
  ].join('\n')
}

function pluginIdentity(name: string, sourceId: string): string { return `${name}@${sourceId}` }

function digest(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex')
}

function sourceId(value: unknown): string { return digest(value).slice(0, 16) }

function qualifiedSkillName(identity: string, name: string): string {
  return `plugin-${digest(identity).slice(0, 12)}-${name}`.replace(/[^a-z0-9-]/giu, '-').toLowerCase()
}

function renderCommandPrompt(prompt: string, rawInput: string): string {
  const argumentsText = rawInput.trim()
  const positional = argumentsText === '' ? [] : argumentsText.split(/\s+/u)
  return prompt
    .replaceAll('{{args}}', argumentsText)
    .replaceAll('$ARGUMENTS', argumentsText)
    .replaceAll(/\$(\d+)\b/gu, (_match, index: string) => positional[Number(index) - 1] ?? '')
}

function mcpServerName(identity: string, name: string): string {
  return `p${digest(identity).slice(0, 10)}-${digest(name).slice(0, 10)}`
}

async function materializeSource(input: PluginImportSource): Promise<SourceMaterial> {
  const request: ImportPluginRequest = typeof input === 'string' ? { source: input } : input
  const source = request.source.trim()
  if (source === '' || source.length > 2_048 || /[\u0000-\u001F\u007F]/u.test(source)) {
    throw new Error('plugin runtime: plugin source is invalid')
  }
  const local = resolve(source)
  try {
    if ((await stat(local)).isDirectory()) {
      const base = await realpath(local)
      const marketplacePlugin = await marketplaceGitPlugin(base, request)
      if (marketplacePlugin !== undefined) {
        return await materializeMarketplaceGitPlugin('marketplace-local', base, undefined, marketplacePlugin)
      }
      const selected = await selectPluginRoot(base, request)
      const marketplace = !await isDirectPluginRoot(base, request)
      const descriptor: ImportedPluginSource = {
        kind: marketplace ? 'marketplace-local' : 'local',
        source: base,
        sourceId: sourceId({ kind: marketplace ? 'marketplace-local' : 'local', source: base, path: request.path, plugin: request.plugin }),
        ...request.path === undefined ? {} : { path: request.path },
        ...marketplace ? { marketplace: base } : {},
      }
      return { root: selected, source: descriptor, dispose: async () => {} }
    }
  } catch (error) {
    if (!isMissing(error)) throw error
  }
  const remote = normalizeGitSource(source)
  const temp = await mkdirTemp('hydra-imported-plugin-')
  const checkout = join(temp, 'repository')
  try {
    await runGit(temp, ['clone', '--depth', '1', '--filter=blob:none', '--', remote, checkout], request.ref)
    const marketplacePlugin = await marketplaceGitPlugin(checkout, request)
    if (marketplacePlugin !== undefined) {
      const nested = await materializeMarketplaceGitPlugin('marketplace-git', remote, request.ref, marketplacePlugin)
      return {
        ...nested,
        dispose: async () => {
          await nested.dispose()
          await rm(temp, { recursive: true, force: true })
        },
      }
    }
    const selected = await selectPluginRoot(checkout, request)
    const marketplace = !await isDirectPluginRoot(checkout, request)
    const descriptor: ImportedPluginSource = {
      kind: marketplace ? 'marketplace-git' : 'git',
      source: remote,
      sourceId: sourceId({ kind: marketplace ? 'marketplace-git' : 'git', source: remote, ref: request.ref, path: request.path, plugin: request.plugin }),
      ...request.ref === undefined ? {} : { ref: request.ref },
      ...request.path === undefined ? {} : { path: request.path },
      ...marketplace ? { marketplace: remote } : {},
    }
    return { root: selected, source: descriptor, dispose: async () => { await rm(temp, { recursive: true, force: true }) } }
  } catch (error) {
    await rm(temp, { recursive: true, force: true })
    throw error
  }
}

async function mkdirTemp(prefix: string): Promise<string> {
  const { mkdtemp } = await import('node:fs/promises')
  return await mkdtemp(join(tmpdir(), prefix))
}

function normalizeGitSource(source: string): string {
  const shorthand = GITHUB_SHORTHAND.exec(source)
  if (shorthand !== null) {
    /* v8 ignore next -- GITHUB_SHORTHAND requires a non-empty repository capture. */
    return `https://github.com/${shorthand[1]}/${(shorthand[2] ?? '').replace(/\.git$/u, '')}.git`
  }
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[A-Za-z0-9._~/-]+$/u.test(source)) return source
  let parsed: URL
  try { parsed = new URL(source) } catch { throw new Error('plugin runtime: source must be an existing folder, GitHub shorthand, or HTTPS/SSH Git URL') }
  if ((parsed.protocol !== 'https:' && parsed.protocol !== 'ssh:') || parsed.username !== '' || parsed.password !== '' || parsed.search !== '' || parsed.hash !== '') {
    throw new Error('plugin runtime: remote source must be credential-free HTTPS or SSH Git URL')
  }
  return parsed.href
}

function runGit(cwd: string, args: string[], ref: string | undefined): Promise<void> {
  if (ref !== undefined && (ref.length === 0 || ref.length > 255 || ref.startsWith('-') || /[\u0000-\u0020\u007F]/u.test(ref))) {
    return Promise.reject(new Error('plugin runtime: Git ref is invalid'))
  }
  const cloneArgs = ref === undefined ? args : [...args.slice(0, -3), '--branch', ref, ...args.slice(-3)]
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) if (!/(?:KEY|SECRET|TOKEN|PASSWORD)/iu.test(key)) env[key] = value
  env.GCM_INTERACTIVE = 'Never'
  env.GIT_TERMINAL_PROMPT = '0'
  return new Promise((resolvePromise, reject) => {
    execFile('git', ['-c', 'protocol.ext.allow=never', '-c', 'protocol.file.allow=never', ...cloneArgs], {
      cwd, env, timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_MARKETPLACE_BYTES, windowsHide: true,
    }, (error) => {
      if (error === null) {
        resolvePromise()
      } else {
        reject(new Error('plugin runtime: Git import failed', { cause: error }))
      }
    })
  })
}

async function selectPluginRoot(root: string, request: ImportPluginRequest): Promise<string> {
  const candidate = request.path === undefined ? root : await existingInside(root, request.path, 'plugin path')
  const direct = await hasPluginManifest(candidate)
  if (direct) return candidate
  const selected = await selectMarketplacePlugin(candidate, request.plugin)
  const location = marketplaceLocalPluginPath(selected)
  if (location === undefined) throw new Error('plugin runtime: marketplace plugin requires a relative path or source')
  const pluginRoot = await existingInside(candidate, location, 'marketplace plugin path')
  if (!await hasPluginManifest(pluginRoot)) throw new Error('plugin runtime: marketplace entry is not a Codex plugin root')
  return pluginRoot
}

async function materializeMarketplaceGitPlugin(
  kind: ImportedPluginSource['kind'],
  marketplace: string,
  marketplaceRef: string | undefined,
  plugin: MarketplaceGitPlugin,
): Promise<SourceMaterial> {
  const nested = await materializeSource({
    source: plugin.source,
    ...plugin.path === undefined ? {} : { path: plugin.path },
    ...plugin.ref === undefined ? {} : { ref: plugin.ref },
  })
  return {
    root: nested.root,
    source: {
      kind,
      source: marketplace,
      sourceId: sourceId({
        kind, marketplace, marketplaceRef, plugin: plugin.selector, source: plugin.source, path: plugin.path, ref: plugin.ref,
      }),
      ...plugin.ref === undefined ? {} : { ref: plugin.ref },
      ...plugin.path === undefined ? {} : { path: plugin.path },
      marketplace,
    },
    dispose: nested.dispose,
  }
}

async function marketplaceGitPlugin(root: string, request: ImportPluginRequest): Promise<MarketplaceGitPlugin | undefined> {
  const candidate = request.path === undefined ? root : await existingInside(root, request.path, 'plugin path')
  const direct = await hasPluginManifest(candidate)
  if (direct) return undefined
  const marketplacePath = await optionalMarketplaceManifestPath(candidate)
  if (marketplacePath === undefined) return undefined
  const selected = await selectMarketplacePlugin(candidate, request.plugin, marketplacePath)
  const source = isRecord(selected.source) ? selected.source : undefined
  if (source === undefined || source.source === 'local') return undefined
  const remote = typeof source.url === 'string' ? source.url : typeof source.source === 'string' && source.source !== 'git-subdir'
    ? source.source : undefined
  if (remote === undefined) throw new Error('plugin runtime: marketplace Git plugin requires source.url')
  const path = typeof source.path === 'string' ? source.path : undefined
  const ref = typeof source.ref === 'string' ? source.ref : typeof source.sha === 'string' ? source.sha : undefined
  return {
    source: remote,
    ...path === undefined ? {} : { path },
    ...ref === undefined ? {} : { ref },
    selector: typeof selected.id === 'string' ? selected.id : string(selected.name),
  }
}

async function selectMarketplacePlugin(root: string, plugin: string | undefined, knownPath?: string): Promise<Record<string, unknown>> {
  const marketplace = await readBoundedJson(
    knownPath ?? await marketplaceManifestPath(root),
    MAX_MARKETPLACE_BYTES,
    'marketplace manifest',
  )
  if (!isRecord(marketplace) || !Array.isArray(marketplace.plugins)) throw new Error('plugin runtime: marketplace.json requires a plugins array')
  const plugins = marketplace.plugins.filter(isRecord)
  const selected = plugin === undefined
    ? plugins.length === 1 ? plugins[0] : undefined
    : plugins.find(entry => entry.name === plugin || entry.id === plugin)
  if (selected === undefined) throw new Error('plugin runtime: select a marketplace plugin by name')
  return selected
}

function marketplaceLocalPluginPath(selected: Record<string, unknown>): string | undefined {
  const source = isRecord(selected.source) ? selected.source : undefined
  return typeof selected.path === 'string' ? selected.path
    : typeof selected.source === 'string' ? selected.source
      : typeof selected.directory === 'string' ? selected.directory
        : source?.source === 'local' && typeof source.path === 'string' ? source.path : undefined
}

async function marketplaceManifestPath(root: string): Promise<string> {
  const path = await optionalMarketplaceManifestPath(root)
  if (path !== undefined) return path
  throw new Error('plugin runtime: marketplace.json is missing')
}

async function optionalMarketplaceManifestPath(root: string): Promise<string | undefined> {
  for (const path of ['.agents/plugins/marketplace.json', '.agents/plugins/api_marketplace.json', 'marketplace.json']) {
    if (await exists(join(root, path))) return await existingInside(root, path, 'marketplace manifest')
  }
}

async function isDirectPluginRoot(root: string, request: ImportPluginRequest): Promise<boolean> {
  const candidate = request.path === undefined ? root : resolveInside(root, request.path, 'plugin path')
  return await hasPluginManifest(candidate)
}

async function hasPluginManifest(root: string): Promise<boolean> {
  return await findManifestLocation(root) !== undefined
}

async function pluginManifestPath(root: string): Promise<ManifestLocation> {
  const location = await findManifestLocation(root)
  if (location !== undefined) return location
  throw new Error('plugin runtime: plugin manifest is missing (expected .codex-plugin/plugin.json, .claude-plugin/plugin.json, or plugin.json)')
}

async function findManifestLocation(root: string): Promise<ManifestLocation | undefined> {
  const portablePath = join(root, 'plugin.json')
  if (await exists(portablePath)) {
    const info = await lstat(portablePath)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('plugin runtime: root plugin.json must be a regular file')
    let raw: unknown
    try {
      raw = JSON.parse(await readBoundedText(portablePath, MAX_MANIFEST_BYTES, 'plugin manifest')) as unknown
    } catch (error) {
      if (!await exists(join(root, '.codex-plugin', 'plugin.json'))) throw error
      raw = undefined
    }
    const schema = isRecord(raw) && typeof raw.$schema === 'string' ? raw.$schema : undefined
    if (schema === AGENT_PLUGIN_SCHEMA_URI) {
      return { path: await existingInside(root, 'plugin.json', 'plugin manifest'), format: 'portable' }
    }
    if (schema?.startsWith(AGENT_PLUGIN_SCHEMA_PREFIX)) {
      throw new Error(`plugin runtime: unsupported Agent Plugins schema ${JSON.stringify(schema)}`)
    }
  }
  const legacyPath = join(root, '.codex-plugin', 'plugin.json')
  if (await exists(legacyPath)) {
    return { path: await existingInside(root, '.codex-plugin/plugin.json', 'plugin manifest'), format: 'legacy' }
  }
  const claudePath = join(root, '.claude-plugin', 'plugin.json')
  if (await exists(claudePath)) {
    return { path: await existingInside(root, '.claude-plugin/plugin.json', 'plugin manifest'), format: 'claude' }
  }
  if (await exists(join(root, '.claude-plugin'))) {
    throw new Error('plugin runtime: Claude plugin manifest is missing (expected .claude-plugin/plugin.json)')
  }
  return undefined
}

function parseManifest(raw: unknown, format: ManifestFormat): PluginManifest {
  if (format === 'portable') return parsePortableManifest(raw)
  if (format === 'claude') return parseClaudeManifest(raw)
  if (!isRecord(raw) || !PLUGIN_NAME.test(string(raw.name)) || !VERSION.test(string(raw.version))) {
    throw new Error('plugin runtime: plugin manifest requires a valid name and semantic version')
  }
  /* jscpd:ignore-start -- portable and legacy manifests share metadata validation. */
  for (const key of ['description', 'application', 'homepage', 'repository', 'license'] as const) {
    if (raw[key] !== undefined && typeof raw[key] !== 'string') throw new Error(`plugin runtime: manifest ${key} must be a string`)
  }
  if (raw.keywords !== undefined && (!Array.isArray(raw.keywords) || raw.keywords.some(value => typeof value !== 'string'))) {
    throw new Error('plugin runtime: manifest keywords must be a string array')
  }
  if (raw.author !== undefined && typeof raw.author !== 'string' && !isRecord(raw.author)) {
    throw new Error('plugin runtime: manifest author must be a string or object')
  }
  /* jscpd:ignore-end */
  if (raw.interface !== undefined && !isRecord(raw.interface)) throw new Error('plugin runtime: manifest interface must be an object')
  validateManifestPaths(raw)
  return { ...raw as unknown as PluginManifest, format: 'legacy' }
}

function parseClaudeManifest(raw: unknown): PluginManifest {
  if (!isRecord(raw)) throw new Error('plugin runtime: Claude plugin manifest must be an object')
  const name = string(raw.name).trim()
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(name)) {
    throw new Error(`plugin runtime: invalid Claude plugin name ${JSON.stringify(name)}`)
  }
  const version = raw.version === undefined ? 'unknown' : string(raw.version).trim()
  if (!isSafeVersionDirectory(version)) {
    throw new Error('plugin runtime: Claude plugin version is not a safe directory name')
  }
  for (const key of ['displayName', 'description', 'application', 'homepage', 'repository', 'license'] as const) {
    if (raw[key] !== undefined && typeof raw[key] !== 'string') throw new Error(`plugin runtime: Claude plugin manifest ${key} must be a string`)
  }
  if (raw.keywords !== undefined && (!Array.isArray(raw.keywords) || raw.keywords.some(value => typeof value !== 'string'))) {
    throw new Error('plugin runtime: Claude plugin manifest keywords must be a string array')
  }
  if (raw.author !== undefined && !isRecord(raw.author)) {
    throw new Error('plugin runtime: Claude plugin manifest author must be an object')
  }
  for (const key of ['commands', 'agents', 'lspServers', 'monitors', 'outputStyles', 'themes', 'settings', 'dependencies', 'bin', 'apps', 'interface']) {
    if (raw[key] !== undefined) throw new Error(`plugin runtime: Claude plugin field ${key} is unsupported`)
  }
  validateManifestPaths(raw)
  const components: {
    skills?: NonNullable<PluginManifest['skills']>
    mcpServers?: NonNullable<PluginManifest['mcpServers']>
    hooks?: NonNullable<PluginManifest['hooks']>
  } = {}
  if (raw.skills !== undefined) components.skills = raw.skills as NonNullable<PluginManifest['skills']>
  if (raw.mcpServers !== undefined) components.mcpServers = raw.mcpServers as NonNullable<PluginManifest['mcpServers']>
  if (raw.hooks !== undefined) components.hooks = raw.hooks as NonNullable<PluginManifest['hooks']>
  return {
    format: 'claude', name, version,
    ...typeof raw.description === 'string' ? { description: raw.description } : {},
    ...typeof raw.application === 'string' ? { application: raw.application } : {},
    ...isRecord(raw.author) ? { author: raw.author } : {},
    ...typeof raw.homepage === 'string' ? { homepage: raw.homepage } : {},
    ...typeof raw.repository === 'string' ? { repository: raw.repository } : {},
    ...typeof raw.license === 'string' ? { license: raw.license } : {},
    ...Array.isArray(raw.keywords) ? { keywords: raw.keywords as readonly string[] } : {},
    ...components,
  }
}

function parsePortableManifest(raw: unknown): PluginManifest {
  if (!isRecord(raw) || typeof raw.$schema !== 'string' || raw.$schema !== AGENT_PLUGIN_SCHEMA_URI) {
    throw new Error(`plugin runtime: root plugin.json requires Agent Plugins schema ${AGENT_PLUGIN_SCHEMA_URI}`)
  }
  const name = string(raw.name).trim()
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(name) || name.includes('..') || name.includes('--')) {
    throw new Error(`plugin runtime: invalid Agent Plugins name ${JSON.stringify(name)}`)
  }
  const version = raw.version === undefined ? '1.0.0' : string(raw.version).trim()
  if (!isSafeVersionDirectory(version)) {
    throw new Error('plugin runtime: portable plugin version is not a safe directory name')
  }
  for (const key of ['description', 'application', 'homepage', 'repository', 'license'] as const) {
    if (raw[key] !== undefined && typeof raw[key] !== 'string') throw new Error(`plugin runtime: manifest ${key} must be a string`)
  }
  if (raw.keywords !== undefined && (!Array.isArray(raw.keywords) || raw.keywords.some(value => typeof value !== 'string'))) {
    throw new Error('plugin runtime: manifest keywords must be a string array')
  }
  if (raw.author !== undefined && typeof raw.author !== 'string' && !isRecord(raw.author)) {
    throw new Error('plugin runtime: manifest author must be a string or object')
  }
  const extension = isRecord(raw.extensions) && isRecord(raw.extensions['com.openai'])
    ? raw.extensions['com.openai'] : undefined
  const presentation = extension?.interface ?? raw.interface
  if (presentation !== undefined && !isRecord(presentation)) throw new Error('plugin runtime: manifest interface must be an object')
  // Agent Plugins keeps skills and MCP at the portable manifest root. Codex
  // extensions add host-specific apps, hooks, and interface metadata.
  const component = (key: 'apps' | 'hooks'): unknown => extension?.[key] ?? raw[key]
  const optional: {
    description?: string
    application?: string
    author?: PluginManifest['author']
    homepage?: string
    repository?: string
    license?: string
    keywords?: readonly string[]
  } = {}
  if (typeof raw.description === 'string') optional.description = raw.description
  if (typeof raw.application === 'string') optional.application = raw.application
  if (typeof raw.author === 'string' || isRecord(raw.author)) optional.author = raw.author
  if (typeof raw.homepage === 'string') optional.homepage = raw.homepage
  if (typeof raw.repository === 'string') optional.repository = raw.repository
  if (typeof raw.license === 'string') optional.license = raw.license
  if (Array.isArray(raw.keywords)) optional.keywords = raw.keywords as readonly string[]
  const skills = raw.skills === undefined ? './skills' : raw.skills as Exclude<PluginManifest['skills'], undefined>
  const mcpServers = raw.mcpServers === undefined ? './mcp.json' : raw.mcpServers as Exclude<PluginManifest['mcpServers'], undefined>
  const manifest: PluginManifest = {
    format: 'portable', name, version, ...optional,
    skills, mcpServers,
    ...component('apps') === undefined ? {} : { apps: component('apps') as PluginManifest['apps'] },
    ...component('hooks') === undefined ? {} : { hooks: component('hooks') as PluginManifest['hooks'] },
    ...isRecord(presentation) ? { interface: presentation } : {},
  } as unknown as PluginManifest
  validateManifestPaths(manifest as unknown as Record<string, unknown>)
  return manifest
}

function isSafeVersionDirectory(version: string): boolean {
  return /^[a-z0-9][a-z0-9._+-]*$/iu.test(version)
    && !version.endsWith('.')
    && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(version)
}

function validateManifestPaths(manifest: Record<string, unknown>): void {
  for (const key of ['skills', 'mcpServers', 'apps', 'hooks']) {
    const value = manifest[key]
    if (typeof value === 'string') assertRelativePluginPath(value, `manifest ${key}`)
    if (Array.isArray(value)) for (const item of value) if (typeof item === 'string') assertRelativePluginPath(item, `manifest ${key}`)
  }
  const ui = isRecord(manifest.interface) ? manifest.interface : undefined
  if (ui === undefined) return
  for (const key of ['composerIcon', 'logo'] as const) {
    if (typeof ui[key] === 'string') assertRelativePluginPath(ui[key], `manifest interface.${key}`)
  }
  if (ui.screenshots !== undefined) {
    for (const path of stringArray(ui.screenshots, 'manifest interface.screenshots')) assertRelativePluginPath(path, 'manifest interface.screenshots')
  }
}

async function rejectUnsupportedClaudeComponents(root: string): Promise<void> {
  for (const path of ['agents', 'output-styles', 'themes', 'monitors', 'bin', '.lsp.json', 'settings.json']) {
    if (await exists(join(root, path))) throw new Error(`plugin runtime: Claude plugin component ${path} is unsupported`)
  }
}

/** Read the optional OpenAI presentation/policy document beside a plugin or skill. */
async function discoverOpenAiMetadata(root: string): Promise<ImportedPluginAgentMetadata | undefined> {
  const relativePath = 'agents/openai.yaml'
  const path = join(root, relativePath)
  if (!await exists(path)) return undefined
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`plugin runtime: ${relativePath} must be a regular file`)
  let parsed: unknown
  try {
    parsed = parseYaml(await readBoundedText(path, MAX_MANIFEST_BYTES, relativePath))
  } catch (error) {
    throw new Error(`plugin runtime: ${relativePath} is invalid YAML`, { cause: error })
  }
  if (!isRecord(parsed)) throw new Error(`plugin runtime: ${relativePath} must contain a YAML object`)
  const presentation = parsed.interface
  if (presentation !== undefined && !isRecord(presentation)) {
    throw new Error(`plugin runtime: ${relativePath} interface must be an object`)
  }
  const policy = parsed.policy
  if (policy !== undefined && !isRecord(policy)) {
    throw new Error(`plugin runtime: ${relativePath} policy must be an object`)
  }
  const values: Record<string, unknown> = {}
  for (const [source, target] of [
    ['display_name', 'displayName'],
    ['short_description', 'shortDescription'],
    ['icon_small', 'iconSmall'],
    ['icon_large', 'iconLarge'],
    ['brand_color', 'brandColor'],
    ['default_prompt', 'defaultPrompt'],
  ] as const) {
    const value = presentation?.[source]
    if (value === undefined) continue
    if (typeof value !== 'string' || value.trim() === '') throw new Error(`plugin runtime: ${relativePath} interface.${source} must be a non-empty string`)
    if (source === 'icon_small' || source === 'icon_large') assertRelativePluginPath(value, `${relativePath} interface.${source}`)
    values[target] = value
  }
  const allowImplicitInvocation = policy?.allow_implicit_invocation
  if (allowImplicitInvocation !== undefined) {
    if (typeof allowImplicitInvocation !== 'boolean') throw new Error(`plugin runtime: ${relativePath} policy.allow_implicit_invocation must be a boolean`)
    values.allowImplicitInvocation = allowImplicitInvocation
  }
  if (parsed.dependencies !== undefined && !isRecord(parsed.dependencies)) {
    throw new Error(`plugin runtime: ${relativePath} dependencies must be an object`)
  }
  return Object.keys(values).length === 0 ? undefined : values
}

async function discoverSkills(
  root: string,
  manifest: PluginManifest,
  pluginAgentMetadata?: ImportedPluginAgentMetadata,
): Promise<LoadedSkill[]> {
  const paths = stringPaths(manifest.skills)
  if (paths.length === 0) {
    if (await exists(join(root, 'skills'))) paths.push('skills')
    else if (manifest.format === 'claude' && await exists(join(root, 'SKILL.md'))) paths.push('SKILL.md')
  }
  const skills: LoadedSkill[] = []
  for (const path of paths) {
    if (manifest.format === 'portable' && path === './skills' && !await exists(join(root, path))) continue
    const location = await existingInside(root, path, 'skill path')
    const info = await lstat(location)
    const files = info.isDirectory()
      ? (await readdir(location, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => join(location, entry.name, 'SKILL.md'))
      : [location]
    for (const file of files) {
      if (basename(file) !== 'SKILL.md' || !await exists(file)) continue
      const resolved = await existingInside(root, relative(root, file), 'skill file')
      const parsed = parseSkillDocument(await readBoundedText(resolved, MAX_FILE_BYTES, 'skill file'))
      const agentMetadata = await discoverOpenAiMetadata(dirname(resolved))
      const openAiModelInvocable = pluginAgentMetadata?.allowImplicitInvocation !== false
        && agentMetadata?.allowImplicitInvocation !== false
      skills.push({
        rawName: parsed.name,
        description: parsed.description,
        invocation: {
          ...parsed.invocation,
          modelInvocable: parsed.invocation.modelInvocable && openAiModelInvocable,
        },
        ...parsed.whenToUse === undefined ? {} : { whenToUse: parsed.whenToUse },
        path: resolved, directory: dirname(resolved),
        ...agentMetadata === undefined ? {} : { agentMetadata },
        openAiModelInvocable,
      })
    }
  }
  return skills.sort((left, right) => left.rawName.localeCompare(right.rawName))
}

async function discoverCommands(root: string): Promise<LoadedCommand[]> {
  const directory = join(root, 'commands')
  if (!await exists(directory)) return []
  const info = await lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('plugin runtime: commands must be a real directory')
  const commands: LoadedCommand[] = []
  const entries = (await readdir(directory, { withFileTypes: true }))
    .filter(entry => entry.isFile() && (extname(entry.name) === '.toml' || extname(entry.name) === '.md'))
    .sort((left, right) => left.name.localeCompare(right.name))
  const tomlNames = new Set(entries.filter(entry => extname(entry.name) === '.toml')
    .map(entry => entry.name.slice(0, -'.toml'.length)))
  for (const entry of entries) {
    const extension = extname(entry.name)
    const name = entry.name.slice(0, -extension.length)
    if (extension === '.md' && tomlNames.has(name)) continue
    if (!COMMAND_NAME.test(name)) throw new Error(`plugin runtime: command filename "${entry.name}" must use lower kebab-case`)
    const path = await existingInside(root, join('commands', entry.name), 'command')
    if (extension === '.md') {
      commands.push(parseMarkdownCommand(name, await readBoundedText(path, MAX_FILE_BYTES, 'command'), entry.name))
      continue
    }
    let definition: unknown
    try {
      definition = parseToml(await readBoundedText(path, MAX_FILE_BYTES, 'command'))
    } catch (error) {
      throw new Error(`plugin runtime: command "${entry.name}" is invalid TOML`, { cause: error })
    }
    if (!isRecord(definition) || typeof definition.description !== 'string' || definition.description.trim() === ''
      || typeof definition.prompt !== 'string' || definition.prompt.trim() === '') {
      throw new Error(`plugin runtime: command "${entry.name}" requires non-empty string description and prompt`)
    }
    commands.push({ name, description: definition.description, prompt: definition.prompt })
  }
  return commands.sort((left, right) => left.name.localeCompare(right.name))
}

/** Parse one Codex/Claude-style Markdown command without executing metadata. */
function parseMarkdownCommand(name: string, raw: string, filename: string): LoadedCommand {
  const match = /^---\r?\n([\s\S]*?\r?\n)---(?:\r?\n|$)/u.exec(raw)
  let metadata: Record<string, unknown> = {}
  let prompt = raw
  if (match !== null) {
    try {
      /* v8 ignore next -- the frontmatter regex always captures its YAML body. */
      const parsed: unknown = parseYaml(match[1] ?? '')
      if (!isRecord(parsed)) throw new Error('frontmatter must be a YAML object')
      metadata = parsed
    } catch (error) {
      throw new Error(`plugin runtime: command "${filename}" has invalid YAML frontmatter`, { cause: error })
    }
    prompt = raw.slice(match[0].length)
  }
  prompt = prompt.trim()
  if (prompt === '') throw new Error(`plugin runtime: command "${filename}" requires a non-empty Markdown body`)
  const description = metadata.description === undefined
    ? firstMarkdownLine(prompt)
    : typeof metadata.description === 'string' ? metadata.description.trim() : ''
  if (description === '') throw new Error(`plugin runtime: command "${filename}" requires a non-empty string description`)
  const hint = metadata['argument-hint']
  if (hint !== undefined && (typeof hint !== 'string' || hint.trim() === '')) {
    throw new Error(`plugin runtime: command "${filename}" argument-hint must be a non-empty string`)
  }
  return {
    name,
    description,
    prompt,
    ...typeof hint === 'string' ? { inputHint: hint.trim() } : {},
  }
}

function firstMarkdownLine(prompt: string): string {
  /* v8 ignore next -- split always returns at least one line. */
  const line = prompt.split(/\r?\n/u)[0] ?? ''
  return line.replace(/^#{1,6}\s+/u, '').trim()
}

async function discoverMcp(root: string, manifest: PluginManifest, identity: string): Promise<McpDefinition[]> {
  const documents: unknown[] = []
  const sources = stringPaths(manifest.mcpServers)
  if (manifest.mcpServers === undefined && await exists(join(root, '.mcp.json'))) sources.push('.mcp.json')
  for (const path of sources) {
    if (manifest.format === 'portable' && path === './mcp.json' && !await exists(join(root, path))) continue
    documents.push(await readBoundedJson(await existingInside(root, path, 'MCP configuration'), MAX_MANIFEST_BYTES, 'MCP configuration'))
  }
  if (isRecord(manifest.mcpServers)) documents.push(manifest.mcpServers)
  const result: McpDefinition[] = []
  for (const document of documents) {
    const map = normalizeMcpMap(document)
    for (const [name, definition] of Object.entries(map)) {
      if (!isRecord(definition)) throw new Error(`plugin runtime: MCP server ${name} must be an object`)
      result.push({ name, config: normalizeMcpConfig(root, identity, name, definition) })
    }
  }
  const seen = new Set<string>()
  for (const server of result) {
    if (seen.has(server.name)) throw new Error(`plugin runtime: duplicate MCP server ${server.name}`)
    seen.add(server.name)
  }
  return result
}

function normalizeMcpMap(raw: unknown): Record<string, unknown> {
  if (!isRecord(raw)) throw new Error('plugin runtime: MCP configuration must be an object')
  if (isRecord(raw.mcp_servers)) return raw.mcp_servers
  if (isRecord(raw.mcpServers)) return raw.mcpServers
  return raw
}

function normalizeMcpConfig(root: string, identity: string, name: string, raw: Record<string, unknown>): McpClientConfig {
  const serverName = mcpServerName(identity, name)
  const type = raw.type === undefined ? undefined : string(raw.type).trim().toLowerCase()
  if (raw.type !== undefined && type !== 'stdio' && type !== 'http' && type !== 'streamable_http' && type !== 'streamable-http') {
    throw new Error(`plugin runtime: MCP server ${name} has unsupported transport type`)
  }
  const isHttp = type === 'http' || type === 'streamable_http' || type === 'streamable-http' || (type === undefined && typeof raw.url === 'string')
  if (isHttp) {
    if (typeof raw.url !== 'string' || raw.url.trim() === '') throw new Error(`plugin runtime: MCP server ${name} requires url for HTTP transport`)
    if (raw.oauth !== undefined || raw.oauth_resource !== undefined) {
      throw new Error(`plugin runtime: MCP server ${name} OAuth metadata is not supported by the local MCP client`)
    }
    const bearerTokenEnvVar = raw.bearer_token_env_var === undefined ? undefined : environmentVariableName(raw.bearer_token_env_var, `MCP ${name}.bearer_token_env_var`)
    return {
      transport: 'streamable-http', serverName, url: raw.url,
      headers: stringRecord(raw.headers ?? raw.http_headers, `MCP ${name}.headers`),
      ...bearerTokenEnvVar === undefined ? {} : { bearerTokenEnvVar },
      toolCallTimeoutMs: 60_000, failOnStartupError: true,
    }
  }
  if (typeof raw.command !== 'string' || raw.command.trim() === '') throw new Error(`plugin runtime: MCP server ${name} requires command or url`)
  if (raw.bearer_token_env_var !== undefined || raw.oauth !== undefined || raw.oauth_resource !== undefined) {
    throw new Error(`plugin runtime: MCP server ${name} authentication metadata requires HTTP transport`)
  }
  const cwd = raw.cwd === undefined ? root : resolveInside(root, string(raw.cwd), `MCP ${name}.cwd`)
  return {
    transport: 'stdio', serverName, command: raw.command,
    args: raw.args === undefined ? [] : stringArray(raw.args, `MCP ${name}.args`),
    env: stringRecord(raw.env, `MCP ${name}.env`), cwd, toolCallTimeoutMs: 60_000, failOnStartupError: true,
  }
}

async function discoverHooks(root: string, manifest: PluginManifest): Promise<HookDefinition[]> {
  const hooks: HookDefinition[] = []
  if (manifest.hooks === undefined) {
    for (const entry of ['hooks/hooks.json', 'hooks.json']) {
      if (!await exists(join(root, entry))) continue
      hooks.push({ label: entry, raw: record(await readBoundedJson(await existingInside(root, entry, 'hooks configuration'), MAX_MANIFEST_BYTES, 'hooks configuration'), 'hooks configuration') })
    }
  }
  const value = manifest.hooks
  const entries = Array.isArray(value) ? value : value === undefined ? [] : [value]
  for (const [index, entry] of entries.entries()) {
    if (typeof entry === 'string') {
      const path = await existingInside(root, entry, 'hooks configuration')
      hooks.push({ label: entry, raw: record(await readBoundedJson(path, MAX_MANIFEST_BYTES, 'hooks configuration'), 'hooks configuration') })
    } else if (isRecord(entry)) {
      hooks.push({ label: `manifest hooks ${String(index + 1)}`, raw: entry })
    } else {
      throw new Error('plugin runtime: manifest hooks must be paths or objects')
    }
  }
  for (const hook of hooks) {
    const parsed = parseCodexConfig(hook.raw)
    if (Object.keys(parsed.config).length === 0) {
      throw new Error(`plugin runtime: ${hook.label} contains no supported synchronous command hooks`)
    }
  }
  return hooks
}

async function discoverApps(root: string, manifest: PluginManifest): Promise<Readonly<Record<string, unknown>> | undefined> {
  const mappings: Record<string, unknown> = {}
  if (await exists(join(root, '.app.json'))) {
    Object.assign(mappings, record(await readBoundedJson(await existingInside(root, '.app.json', '.app.json'), MAX_MANIFEST_BYTES, '.app.json'), '.app.json'))
  }
  if (typeof manifest.apps === 'string' || Array.isArray(manifest.apps)) {
    for (const path of stringPaths(manifest.apps)) {
      Object.assign(mappings, record(await readBoundedJson(await existingInside(root, path, 'app mapping'), MAX_MANIFEST_BYTES, 'app mapping'), 'app mapping'))
    }
  } else if (isRecord(manifest.apps)) {
    Object.assign(mappings, manifest.apps)
  }
  return Object.keys(mappings).length === 0 ? undefined : mappings
}

function mergeHookDefinitions(definitions: readonly HookDefinition[]): Record<string, unknown> {
  const hooks: Record<string, unknown[]> = {}
  for (const definition of definitions) {
    const source = isRecord(definition.raw.hooks) ? definition.raw.hooks : definition.raw
    for (const [event, groups] of Object.entries(source)) {
      if (!Array.isArray(groups)) continue
      // Array.isArray narrows the entry value to any[]; re-root it in unknown
      // before spreading so the stored hook group keeps a checked type.
      hooks[event] = [...hooks[event] ?? [], ...(groups as unknown[])]
    }
  }
  return { hooks }
}

function initializeMcpState(
  definitions: readonly McpDefinition[], old: Record<string, StoredMcpState> | undefined,
): Record<string, StoredMcpState> {
  return Object.fromEntries(definitions.map(({ name }) => [name, old?.[name] ?? {
    // New MCP components require an explicit user enablement decision.
    enabled: false, defaultToolsApprovalMode: 'ask', toolApproval: {},
  }]))
}

async function validateBundleTree(root: string): Promise<string> {
  const metadata = await lstat(root)
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('plugin runtime: plugin root must be a real directory')
  const canonical = await realpath(root)
  let total = 0
  let count = 0
  const walk = async (directory: string): Promise<void> => {
    const actual = await realpath(directory)
    if (!isInside(canonical, actual)) throw new Error('plugin runtime: symbolic link or junction escapes plugin root')
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      const info = await lstat(path)
      if (info.isSymbolicLink()) throw new Error(`plugin runtime: symbolic links are not allowed (${path})`)
      count += 1
      if (count > MAX_FILES) throw new Error(`plugin runtime: plugin contains more than ${String(MAX_FILES)} files`)
      if (info.isDirectory()) await walk(path)
      else if (info.isFile()) {
        if (info.size > MAX_FILE_BYTES) throw new Error(`plugin runtime: file exceeds ${String(MAX_FILE_BYTES)} bytes`)
        total += info.size
        if (total > MAX_PACKAGE_BYTES) throw new Error(`plugin runtime: package exceeds ${String(MAX_PACKAGE_BYTES)} bytes`)
      } else throw new Error(`plugin runtime: unsupported filesystem entry (${path})`)
    }
  }
  await walk(canonical)
  return canonical
}

async function copyTree(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true, mode: 0o700 })
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name)
    const to = join(destination, entry.name)
    const info = await lstat(from)
    if (info.isSymbolicLink()) throw new Error('plugin runtime: symbolic links are not allowed')
    if (info.isDirectory()) await copyTree(from, to)
    else if (info.isFile()) await copyFile(from, to)
    else throw new Error('plugin runtime: unsupported filesystem entry')
  }
}

function assertRelativePluginPath(path: string, label: string): void {
  if (path.length === 0 || path.includes('\0') || isAbsolute(path) || /^[A-Za-z]:/u.test(path) || /^\\\\/u.test(path) || path.startsWith('/') || path.startsWith('\\')) {
    throw new Error(`plugin runtime: ${label} must be relative to the plugin root`)
  }
  const normalized = path.replaceAll('\\', '/').replace(/\/+$/u, '')
  const segments = normalized.split('/')
  if (segments.some(segment => segment === '..' || segment === '')) throw new Error(`plugin runtime: ${label} cannot traverse outside the plugin root`)
}

function resolveInside(root: string, path: string, label: string): string {
  assertRelativePluginPath(path, label)
  return resolve(root, path)
}

async function existingInside(root: string, path: string, label: string): Promise<string> {
  const candidate = resolveInside(root, path, label)
  const info = await lstat(candidate)
  if (info.isSymbolicLink()) throw new Error(`plugin runtime: ${label} must not be a symbolic link`)
  const actual = await realpath(candidate)
  if (!isInside(await realpath(root), actual)) throw new Error(`plugin runtime: ${label} escapes plugin root`)
  return actual
}

function assertStoreDescendant(root: string, path: string): void {
  if (!isInside(resolve(root), resolve(path))) throw new Error('plugin runtime: refusing to remove outside the plugin store')
}

function isInside(root: string, path: string): boolean {
  const child = relative(resolve(root), resolve(path))
  return child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child))
}

async function readBoundedJson(path: string, limit: number, label: string): Promise<unknown> {
  return JSON.parse(await readBoundedText(path, limit, label)) as unknown
}

async function readBoundedText(path: string, limit: number, label: string): Promise<string> {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size > limit) throw new Error(`plugin runtime: ${label} is invalid or too large`)
  const text = await readFile(path, 'utf8')
  if (Buffer.byteLength(text) > limit) throw new Error(`plugin runtime: ${label} is too large`)
  return text
}

function string(value: unknown): string { return typeof value === 'string' ? value : '' }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`plugin runtime: ${label} must be an object`)
  return value
}
function stringArray(value: unknown, label: string): string[] {
  // Validate against unknown[] first: Array.isArray on unknown yields any[],
  // whose spread/index would leak any into the returned strings.
  const items: unknown[] = Array.isArray(value) ? value : []
  if (!Array.isArray(value) || items.some(item => typeof item !== 'string')) throw new Error(`plugin runtime: ${label} must be a string array`)
  return items.filter((item): item is string => typeof item === 'string')
}
function stringRecord(value: unknown, label: string): Record<string, string> {
  if (value === undefined) return {}
  if (!isRecord(value) || Object.values(value).some(item => typeof item !== 'string')) throw new Error(`plugin runtime: ${label} must be a string map`)
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, item as string]))
}
function environmentVariableName(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || /[=\u0000-\u001F\u007F]/u.test(value)) throw new Error(`plugin runtime: ${label} must be a valid environment variable name`)
  return value
}
function stringPaths(value: unknown): string[] {
  if (value === undefined || isRecord(value)) return []
  const paths = typeof value === 'string' ? [value] : stringArray(value, 'manifest paths')
  for (const path of paths) assertRelativePluginPath(path, 'manifest path')
  return paths
}
function isMissing(error: unknown): boolean { return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT' || (error as NodeJS.ErrnoException | undefined)?.code === 'ENOTDIR' }
async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  // JSON.stringify returns undefined for functions/symbols at runtime even
  // though its type says string; fall back to null like JSON does.
  /* oxlint-disable-next-line typescript/no-unnecessary-condition -- load-bearing: stringify returns undefined for function/symbol leaves */
  return JSON.stringify(value) ?? 'null'
}

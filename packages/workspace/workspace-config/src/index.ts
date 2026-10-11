/** Workspace-local configuration, Host trust, and standing runtime ownership. @module */

import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import { readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Context, Service } from '@hydraharness/cordis'
import z from '@hydraharness/schemastery'
import { createScope, scopeChainOf, scopeOf, type Scope } from '@hydraharness/harness-scope'
import { settingsNamespace, type SettingsProvider, type SettingsScope } from '@hydraharness/harness-settings'
import FileSettingsProvider from '@hydraharness/harness-settings-file'
import AgentPresets, { AgentPresetSettingsSchema, COMPOSITION_FILE, type AgentPresetSettings } from '@hydraharness/harness-agent-presets'
import McpServerRegistry from '@hydraharness/harness-mcp-registry'
import HookRecordRegistry from '@hydraharness/harness-hooks-registry'
import { resolveHydraHome } from '@hydraharness/harness-home-paths'
import { realpathNormalize, type Workspace, type WorkspaceId } from '@hydraharness/harness-workspace'
import type {} from '@hydraharness/harness-tools'
import type {} from '@hydraharness/harness-shell'
import type {} from '@hydraharness/harness-system-prompt'
import type { Agent } from '@hydraharness/harness-agent'
import { initializeFiles, withinRoot } from './files.ts'
import type { WorkspaceConfigLayer } from './types.ts'
import type { WorkspaceEnvironment } from './environment.ts'

/** Parameters for workspace document watching and Host-owned hook storage. */
export interface Config {
  /** Harness home holding workspace hook documents and user configuration. */
  hydraHome?: string
  /** Watch shared and personal documents; defaults to the file provider's behavior. */
  watch?: boolean
  /** Workspace file watcher settle window; defaults to the file provider's value. */
  debounceMs?: number
}

interface TrustSettings {
  trustedRoots: Record<string, boolean>
}

interface EnvironmentState {
  readonly environment: WorkspaceEnvironment
  readonly scope: Scope
  readonly shared: SettingsProvider
  readonly local: SettingsProvider
  presets: AgentPresets | undefined
  readonly projectOnlyPresets: boolean
  runtimeReady: boolean
  trusted: boolean
  transition: Promise<void>
}

const WORKSPACE_NAMESPACES = [
  'permission', 'agent-presets', 'mcp-servers', 'hooks',
].map(settingsNamespace)

/** Host-only namespace carrying canonical root trust decisions. */
export const WORKSPACE_TRUST_SETTINGS_NAMESPACE = settingsNamespace('workspace-config')

const TrustSettingsSchema: z<TrustSettings> = z.object({
  trustedRoots: z.dict(z.boolean()).default({}),
})

declare module '@hydraharness/cordis' {
  interface Context {
    workspaceConfig: WorkspaceConfigService
  }
}

export type { SettingsTarget, WorkspaceConfigLayer } from './types.ts'
export type { WorkspaceEnvironment } from './environment.ts'

/** Workspace-local settings and runtime services retained until the Host unloads. */
export class WorkspaceConfigService extends Service {
  static inject = ['settings', 'tools', 'shell', 'systemPrompt']
  static Config: z<Config> = z.object({
    hydraHome: z.string(),
    watch: z.boolean(),
    debounceMs: z.number().min(0),
  })

  private readonly owner: Context
  private readonly userSettings: SettingsProvider
  private readonly trust: SettingsScope<TrustSettings>
  private readonly environments = new Map<string, Promise<EnvironmentState>>()
  private readonly readyEnvironments = new Map<string, EnvironmentState>()
  private readonly aliases = new Map<string, string>()
  private user: WorkspaceEnvironment | undefined
  private closed = false

  constructor(ctx: Context, private readonly config: Config = {}) {
    super(ctx, 'workspaceConfig')
    this.owner = ctx
    this.userSettings = ctx.settings
    this.trust = this.userSettings.register(WORKSPACE_TRUST_SETTINGS_NAMESPACE, TrustSettingsSchema)
    ctx.on('workspace/pre-create', async (path) => { await this.initialize(path) })
    ctx.tools.guard(execution => this.revokedReason(execution.agent))
    ctx.on('agent/pre-step', async ({ agent }, next) =>
      this.revokedReason(agent) === undefined ? await next() : { kind: 'reject' })
  }

  protected async [Service.init](): Promise<void> {
    this.owner.effect(() => async () => {
      this.closed = true
      await Promise.allSettled([...this.environments.values()])
      await Promise.all([...this.readyEnvironments.values()].map(state => state.scope.dispose()))
      this.environments.clear()
      this.readyEnvironments.clear()
      this.aliases.clear()
    }, 'workspaceConfig.environments')

    const scopeKey = {}
    const user = createScope(this.owner, scopeKey)
    await user.ctx.plugin(McpServerRegistry)
    await user.ctx.plugin(HookRecordRegistry, {
      ...this.config.hydraHome === undefined ? {} : { hydraHome: this.config.hydraHome },
    })
    const owner = this.owner
    this.user = {
      root: '', ctx: user.ctx, scopeKey, settings: this.userSettings, trusted: true,
      get presets() { return owner.get('agentPresets') },
    }
    this.trust.watch(async (next, previous) => {
      const changed = [...this.readyEnvironments].filter(([root]) =>
        next.trustedRoots[root] !== previous.trustedRoots[root])
      // Suppress every revoked root before any asynchronous process teardown.
      for (const [root, state] of changed) {
        if (next.trustedRoots[root] !== true) this.disableProjectSettings(state)
      }
      for (const [root, state] of changed) {
        await this.applyTrust(state, next.trustedRoots[root] === true)
        this.notifyTrust(root, next.trustedRoots[root] === true)
      }
    })
  }

  /**
   * Initialize a canonical workspace directory without overwriting existing files.
   * @param cwd - Existing directory to prepare as a workspace root.
   * @returns the canonical directory after every required file exists.
   */
  async initialize(cwd: string): Promise<string> {
    if (this.closed) throw new Error('workspace-config: Host is shutting down')
    const root = await realpathNormalize(cwd)
    if (!(await stat(root)).isDirectory()) throw new Error(`workspace-config: ${root} is not a directory`)
    await initializeFiles(root)
    return root
  }

  /**
   * Resolve the nearest registered canonical ancestor, otherwise the cwd itself.
   * @param cwd - Existing session or workspace directory.
   * @returns the canonical workspace root.
   */
  async resolveRoot(cwd: string): Promise<string> {
    const canonical = await realpathNormalize(cwd)
    const registry = this.owner.get('workspaceRegistry')
    const roots = registry?.list().map(workspace => workspace.path) ?? []
    return roots.filter(root => withinRoot(root, canonical)).sort((left, right) => right.length - left.length)[0] ?? canonical
  }

  /**
   * Resolve or construct the directory's isolated settings and runtime composition.
   * A failed construction is removed so corrected files can be retried.
   * @param cwd - Existing workspace or session directory.
   * @returns the standing environment for its canonical workspace root.
   */
  async environment(cwd: string): Promise<WorkspaceEnvironment> {
    if (this.closed) throw new Error('workspace-config: Host is shutting down')
    const root = await this.resolveRoot(cwd)
    this.aliases.set(resolve(cwd), root)
    this.aliases.set(await realpathNormalize(cwd), root)
    let pending = this.environments.get(root)
    if (pending === undefined) {
      pending = this.createEnvironment(root)
      this.environments.set(root, pending)
      void pending.catch(() => { if (this.environments.get(root) === pending) this.environments.delete(root) })
    }
    const state = await pending
    await this.applyTrust(state, this.trust.get().trustedRoots[root] === true)
    await this.enqueueTransition(state, () => this.ensurePresets(state))
    return state.environment
  }

  /**
   * Read an already prepared environment without filesystem work.
   * @param cwd - Previously resolved directory spelling or canonical descendant.
   * @returns its cached environment, or undefined before preparation.
   */
  currentEnvironment(cwd: string): WorkspaceEnvironment | undefined {
    const path = resolve(cwd)
    const root = this.aliases.get(path)
    if (root !== undefined) {
      const state = this.readyEnvironments.get(root)
      return state?.runtimeReady === true ? state.environment : undefined
    }
    return [...this.readyEnvironments.entries()]
      .filter(([candidate, state]) => state.runtimeReady && withinRoot(candidate, path))
      .sort(([left], [right]) => right.length - left.length)[0]?.[1].environment
  }

  /**
   * Read the user-only runtime environment for consumers without a directory.
   * @returns the initialized user environment.
   */
  userEnvironment(): WorkspaceEnvironment {
    if (this.user === undefined) throw new Error('workspace-config: user environment is not ready')
    return this.user
  }

  /**
   * Resolve an exact registered workspace without accepting browser-supplied paths.
   * @param workspaceId - Existing workspace registration.
   * @returns its isolated environment.
   * @throws If the workspace identity is not registered or its directory cannot be initialized.
   */
  async environmentFor(workspaceId: WorkspaceId): Promise<WorkspaceEnvironment> {
    return await this.environment(this.workspace(workspaceId).path)
  }

  /**
   * Select a registered workspace's editable settings document.
   * @param workspaceId - Existing workspace registration.
   * @param layer - Shared or personal document; omitted selects personal settings.
   * @returns the provider retaining that document's raw overrides.
   * @throws If the workspace identity is not registered or its directory cannot be initialized.
   */
  async settingsFor(workspaceId: WorkspaceId, layer: WorkspaceConfigLayer = 'local'): Promise<SettingsProvider> {
    const environment = await this.environmentFor(workspaceId)
    const state = this.requireState(environment)
    return layer === 'shared' ? state.shared : state.local
  }

  /**
   * Read a Host-owned trust decision without loading project code.
   * @param workspaceId - Existing workspace registration.
   * @returns whether its canonical root is trusted.
   * @throws If the workspace identity is not registered.
   */
  isTrusted(workspaceId: WorkspaceId): boolean {
    return this.trust.get().trustedRoots[this.workspace(workspaceId).path] === true
  }

  /**
   * Distinguish an unanswered trust prompt from an explicit denial or revocation.
   * @param workspaceId - Existing workspace registration.
   * @returns whether the Host stores a decision for its canonical root.
   * @throws If the workspace identity is not registered.
   */
  hasTrustDecision(workspaceId: WorkspaceId): boolean {
    return Object.hasOwn(this.trust.get().trustedRoots, this.workspace(workspaceId).path)
  }

  /**
   * Commit trust on the Host and converge the workspace runtime before returning.
   * @param workspaceId - Existing workspace registration.
   * @param trusted - Apply project settings and presets until explicitly revoked.
   * @returns completion after the Host decision persists and runtime reconciliation settles.
   * @throws If the workspace is unknown, persistence fails, or its runtime cannot reconcile.
   */
  async setTrusted(workspaceId: WorkspaceId, trusted: boolean): Promise<void> {
    const root = this.workspace(workspaceId).path
    await this.trust.update({ trustedRoots: { [root]: trusted } })
    if (trusted) {
      await this.environment(root)
    } else {
      const state = this.readyEnvironments.get(root)
      if (state !== undefined) await this.applyTrust(state, false)
    }
    this.notifyTrust(root, this.trust.get().trustedRoots[root] === true)
  }

  /**
   * Detect project overrides or preset compositions that require a trust decision.
   * @param workspaceId - Existing workspace registration.
   * @returns whether shared/personal settings or a preset composition is present.
   * @throws If the workspace is unknown or a configuration path cannot be read.
   */
  async hasProjectConfig(workspaceId: WorkspaceId): Promise<boolean> {
    const environment = await this.environmentFor(workspaceId)
    const state = this.requireState(environment)
    if ([state.shared, state.local].some(settings => settings.describe().some(descriptor =>
      typeof descriptor.user === 'object' && descriptor.user !== null && Object.keys(descriptor.user).length > 0))) return true
    const directory = join(environment.root, '.hydra', 'agent-presets')
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      try {
        if ((await stat(join(directory, entry.name, COMPOSITION_FILE))).isFile()) return true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    return false
  }

  private workspace(id: WorkspaceId): Workspace {
    const workspace = this.owner.get('workspaceRegistry')?.get(id)
    if (workspace === undefined) throw new Error(`workspace-config: unknown workspace '${id}'`)
    return workspace
  }

  private requireState(environment: WorkspaceEnvironment): EnvironmentState {
    const state = this.readyEnvironments.get(environment.root)
    assert(state?.environment === environment, `workspace-config: environment ${environment.root} is no longer active`)
    return state
  }

  private async createEnvironment(root: string): Promise<EnvironmentState> {
    await this.initialize(root)
    const scopeKey = {}
    const scope = createScope(this.owner, scopeKey)
    const runtime = scope.ctx.isolate('settings').isolate('mcpServers').isolate('hookRecords').isolate('agentPresets')
    const sharedContext = runtime.isolate('settings')
    try {
      await sharedContext.plugin(FileSettingsProvider, {
        path: join(root, '.hydra', 'settings.yaml'),
        ...this.config.watch === undefined ? {} : { watch: this.config.watch },
        ...this.config.debounceMs === undefined ? {} : { debounceMs: this.config.debounceMs },
        allowedNamespaces: WORKSPACE_NAMESPACES, layerEnabled: false, confinedRoot: root,
      })
      const shared = sharedContext.get('settings')
      assert(shared !== undefined, 'workspace-config: shared settings provider did not become available')
      shared.inherit(this.userSettings, WORKSPACE_NAMESPACES)
      const projectOnlyPresets = this.owner.get('agentPresets') === undefined
      if (projectOnlyPresets && shared.get(settingsNamespace('agent-presets')) === undefined) {
        shared.register(settingsNamespace('agent-presets'), AgentPresetSettingsSchema)
      }
      await runtime.plugin(FileSettingsProvider, {
        path: join(root, '.hydra', 'settings.local.yaml'),
        ...this.config.watch === undefined ? {} : { watch: this.config.watch },
        ...this.config.debounceMs === undefined ? {} : { debounceMs: this.config.debounceMs },
        allowedNamespaces: WORKSPACE_NAMESPACES, layerEnabled: false, confinedRoot: root,
      })
      const local = runtime.get('settings')
      assert(local !== undefined, 'workspace-config: personal settings provider did not become available')
      local.inherit(shared, WORKSPACE_NAMESPACES)
      const state: EnvironmentState = {
        scope, shared, local, presets: undefined, projectOnlyPresets, runtimeReady: false,
        trusted: false, transition: Promise.resolve(),
        environment: {
          root, ctx: runtime, scopeKey, settings: local,
          get presets() { return state.projectOnlyPresets && !state.trusted ? undefined : state.presets },
          get trusted() { return state.trusted },
        },
      }
      this.readyEnvironments.set(root, state)
      await runtime.plugin(McpServerRegistry, { cwd: root })
      const rootHash = createHash('sha256').update(root).digest('hex')
      await runtime.plugin(HookRecordRegistry, {
        hydraHome: join(resolveHydraHome(this.config.hydraHome), 'workspace-runtime', rootHash),
        cwd: root,
      })
      shared.observe(() => { this.notify(root, 'shared'); this.notify(root, 'local') })
      local.observe(() => { this.notify(root, 'local') })
      state.runtimeReady = true
      await this.applyTrust(state, this.trust.get().trustedRoots[root] === true)
      return state
    } catch (error) {
      if (this.readyEnvironments.get(root)?.scope === scope) this.readyEnvironments.delete(root)
      await scope.dispose()
      throw error
    }
  }

  private async ensurePresets(state: EnvironmentState): Promise<void> {
    if (state.presets !== undefined) return
    const global = this.owner.get('agentPresets')
    const configured = state.local.get(settingsNamespace('agent-presets')) as AgentPresetSettings | undefined
    const defaultId = global?.config.default ?? (state.trusted ? configured?.default : undefined)
    if (defaultId === undefined) return
    await state.environment.ctx.plugin(AgentPresets, {
      default: defaultId,
      workspaceRoot: state.environment.root,
      roots: [
        ...state.trusted ? [{ path: join(state.environment.root, '.hydra', 'agent-presets'), trust: 'user' as const }] : [],
        ...global?.roots ?? [],
      ],
      includeUserRoot: false,
    })
    state.presets = state.environment.ctx.get('agentPresets')
  }

  private applyTrust(state: EnvironmentState, trusted: boolean): Promise<void> {
    if (!trusted) this.disableProjectSettings(state)
    return this.enqueueTransition(state, async () => {
      if (!state.runtimeReady) return
      const current = this.trust.get().trustedRoots[state.environment.root] === true
      state.trusted = current
      state.shared.setLayerEnabled(current)
      state.local.setLayerEnabled(current)
      await this.ensurePresets(state)
      await state.presets?.setProjectRoot(join(state.environment.root, '.hydra', 'agent-presets'), state.trusted)
      const mcp = state.environment.ctx.get('mcpServers')
      const hooks = state.environment.ctx.get('hookRecords')
      assert(mcp !== undefined && hooks !== undefined, 'workspace-config: workspace runtime is no longer active')
      await mcp.settle()
      await hooks.settle()
    })
  }

  private disableProjectSettings(state: EnvironmentState): void {
    state.trusted = false
    state.shared.setLayerEnabled(false)
    state.local.setLayerEnabled(false)
  }

  private enqueueTransition(state: EnvironmentState, operation: () => Promise<void>): Promise<void> {
    const next = state.transition.then(operation)
    state.transition = next.then(() => undefined, () => undefined)
    return next
  }

  private revokedReason(agent: Agent | undefined): string | undefined {
    if (agent === undefined) return undefined
    const chain = scopeChainOf(scopeOf(agent.ctx))
    for (const [root, state] of this.readyEnvironments) {
      if (!chain.includes(state.environment.scopeKey)) continue
      const projectRoot = join(root, '.hydra', 'agent-presets')
      if (state.presets?.isRetiredProjectContext(agent.ctx, projectRoot) === true) {
        return 'Workspace trust was revoked and this preset generation was unloaded. Start a new chat or restart Hydra to load its project preset again.'
      }
      if (this.trust.get().trustedRoots[root] !== true && state.presets?.isProjectContext(agent.ctx, projectRoot) === true) {
        return 'Workspace trust was revoked. Trust this workspace before continuing its project preset.'
      }
    }
    return undefined
  }

  private notify(root: string, layer: WorkspaceConfigLayer): void {
    if (this.closed) return
    const workspace = this.owner.get('workspaceRegistry')?.list().find(record => record.path === root)
    if (workspace !== undefined) this.owner.emit('workspace-config/updated', workspace.id, layer)
  }

  private notifyTrust(root: string, trusted: boolean): void {
    if (this.closed) return
    // A later Host commit can supersede an earlier asynchronous reconciliation.
    if ((this.trust.get().trustedRoots[root] === true) !== trusted) return
    const workspace = this.owner.get('workspaceRegistry')?.list().find(record => record.path === root)
    if (workspace !== undefined) this.owner.emit('workspace-config/trust-updated', workspace.id, trusted)
  }
}

export default WorkspaceConfigService

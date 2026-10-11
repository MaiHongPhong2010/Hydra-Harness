/**
 * Agent presets: each session composes its model-facing plugin set from one
 * preset `cordis.yml`, mounted ONCE per preset under a standing scope and
 * joined by every agent that names it.
 *
 * The standing mount is what makes a preset one composition rather than one
 * per session: its plugin instances, tool registrations, prompt sections, and
 * projection units exist exactly once, keyed per session inside the plugins
 * themselves (they predate presets and were written for a shared world). An
 * agent joins by having its scope key parented to the mount's
 * ({@link bindScopeParent}), which makes the mount's registrations visible to
 * that agent's views and the mount's listeners receive that agent's events —
 * and a host reader with no agent at all (a cold transcript read) resolves
 * the same standing registrations by preset id.
 *
 * This package owns the preset vocabulary, filesystem discovery, and the
 * guarded standing mount. It does not decide when an agent is created — the
 * agent factory's `setup(agentCtx)` hook is the one supported call site,
 * because only there is the join installed while the agent is still
 * unpublished, so a rejected composition rolls the whole creation back.
 * @module @hydraharness/harness-agent-presets
 */

import { stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { Context, Service } from '@hydraharness/cordis'
import { entryListSchema, type PatchOptions } from '@hydraharness/cordis-plugin-include'
import type { EntryOptions } from '@hydraharness/cordis-plugin-loader'
import z from '@hydraharness/schemastery'
import { bindScopeParent, createScope, scopeChainOf, scopeOf, type Scope, type ScopeKey, type ScopeParentBinding } from '@hydraharness/harness-scope'
import { load } from 'js-yaml'
// Type-only: resolves the `agent/created` lifecycle event this service watches.
import type {} from '@hydraharness/harness-agent'
import { settingsNamespace, type SettingsProvider, type SettingsScope, type default as SettingsService } from '@hydraharness/harness-settings'
import { expandHomePath, hydraHomePath } from '@hydraharness/harness-home-paths'
import { discoverPresets, USER_PRESET_DIR } from './discovery.ts'
import { authoringDirectory, copyComposition, deleteComposition, readComposition } from './authoring.ts'
import { mountPreset, serviceForAgent, standingMountFor } from './mount.ts'
import { PresetExistsError, PresetNotWritableError } from './authoring.ts'
import { PresetMountError, UnknownPresetError, type AgentPreset, type Config, type PresetRoot } from './preset.ts'
import type {} from './types.ts'

/** Settings namespace carrying the user's chosen default preset. */
export const SETTINGS_NAMESPACE = 'agent-presets'

/** The user-writable slice of this plugin's config. */
export interface AgentPresetSettings {
  /** Preset mounted when a session names none. */
  default?: string
  /** Per-preset leaf states applied when a new standing composition mounts. */
  pluginEnablement: Record<string, Record<string, boolean>>
}

/** Runtime schema for the user-writable slice. */
export const AgentPresetSettingsSchema: z<AgentPresetSettings> = z.object({
  default: z.string(),
  pluginEnablement: z.dict(z.dict(z.boolean()).default({})).default({}),
})

/** One persistently switchable leaf in an agent-preset composition. */
export interface AgentPresetPluginEntry {
  /** Stable id qualified by its preset, so identical leaf ids never collide. */
  readonly entryId: string
  /** Preset whose next standing composition will receive this state. */
  readonly presetId: string
  /** Raw composition-row id targeted by the Include patch. */
  readonly rowId: string
  /** Exact module specifier declared by the composition row. */
  readonly moduleName: string
  /** Desired state inherited by the next session on this preset. */
  readonly enabled: boolean
}

const PRESET_PLUGIN_ENTRY_PREFIX = 'agent-preset:'
const selectedNotifications = new WeakMap<Context, WeakSet<object>>()

function presetPluginEntryId(presetId: string, rowId: string): string {
  return `${PRESET_PLUGIN_ENTRY_PREFIX}${presetId}:${rowId}`
}

function collectPresetPluginEntries(
  rows: readonly EntryOptions[],
  presetId: string,
  enablement: Readonly<Record<string, boolean>>,
  entries: AgentPresetPluginEntry[],
): void {
  for (const row of rows) {
    if (row.group === true && Array.isArray(row.config)) {
      collectPresetPluginEntries(row.config, presetId, enablement, entries)
      continue
    }
    if (typeof row.id !== 'string') continue
    entries.push({
      entryId: presetPluginEntryId(presetId, row.id),
      presetId,
      rowId: row.id,
      moduleName: row.name,
      enabled: enablement[row.id] ?? (row.disabled !== true),
    })
  }
}

function changedPresetEnablementIds(
  next: Readonly<Record<string, Record<string, boolean>>>,
  previous: Readonly<Record<string, Record<string, boolean>>>,
): string[] {
  const changed: string[] = []
  for (const presetId of new Set([...Object.keys(next), ...Object.keys(previous)])) {
    const current = next[presetId] ?? {}
    const prior = previous[presetId] ?? {}
    const ids = new Set([...Object.keys(current), ...Object.keys(prior)])
    if ([...ids].some(id => current[id] !== prior[id])) changed.push(presetId)
  }
  return changed
}

export { COMPOSITION_FILE, discoverPresets, scanRoot } from './discovery.ts'
export {
  METADATA_FILE, readPresetMetadata, renderPresetMetadata, type PresetMetadata,
} from './metadata.ts'
export {
  inactiveRows, leakedServices, livePresetMounts, mountPreset, serviceForAgent, standingMountFor,
  type JoinedPresetMount, type PresetMount,
} from './mount.ts'
export {
  authoringDirectory, copyComposition, deleteComposition, InvalidPresetIdError, PresetExistsError,
  PresetNotWritableError, readComposition, writableRoot,
} from './authoring.ts'
export { resolveSessionPreset, type PresetBearingSession } from './session.ts'
export { PresetMountError, UnknownPresetError } from './preset.ts'
export type { AgentPreset, Config, PresetRoot, PresetTrust } from './preset.ts'

declare module '@hydraharness/cordis' {
  interface Context {
    agentPresets: AgentPresets
  }
}

/**
 * Registry over the deployment's agent presets.
 *
 * Discovery is unmemoized: `list()` and `resolve()` re-read the roots on every
 * call so a preset authored while the process runs is visible immediately,
 * and a preset deleted underneath a picker disappears from the next read.
 */
export class AgentPresets extends Service {
  static inject = ['loader']

  /** Runtime schema for the preset roster. */
  static Config = z.object({
    default: z.string().required(),
    roots: z.array(z.object({
      path: z.string().required(),
      trust: z.union(['system', 'user'] as const).default('user'),
    })).default([]),
    includeUserRoot: z.boolean().default(true),
    workspaceRoot: z.string(),
  }) as z<Config>

  /**
   * The roots discovery and authoring actually scan: every configured root in
   * order, then the harness-home user root unless `includeUserRoot` is false.
   *
   * Workspace trust may prepend or remove its project root. Appending the
   * harness-home root keeps the configured precedence and authoring root.
   */
  private resolvedRoots: readonly PresetRoot[]
  private readonly workspaceRoot: string | undefined

  /**
   * The user layer over `config.default`, present only while a settings
   * provider is composed. Held rather than snapshotted so a hot-reloaded
   * document takes effect without a restart.
   */
  private settings: SettingsScope<AgentPresetSettings> | undefined

  /**
   * The settings service behind {@link settings}, held for the one write this
   * service makes: clearing a user default it has just deleted.
   */
  private settingsService: SettingsService | undefined

  /**
   * The service's own untraced context. Methods invoked through the traceable
   * proxy see `this.ctx` rebound to the CALLER's context, which carries a
   * shadow; a subtree minted from it resolves every service through that
   * shadow's fiber instead of each entry's own inject store, so preset rows
   * would fail on the very services they declare. Standing mounts must hang
   * off the untraced original (the `jobs-local` selfCtx precedent).
   */
  private readonly selfCtx: Context

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'agentPresets')
    this.selfCtx = ctx
    this.workspaceRoot = config.workspaceRoot === undefined ? undefined : resolve(expandHomePath(config.workspaceRoot))
    this.resolvedRoots = config.includeUserRoot
      ? [...config.roots, { path: hydraHomePath(USER_PRESET_DIR), trust: 'user' }]
      : [...config.roots]
    // Deliberately not `installSettingsSection`: that helper exists to re-judge
    // what a consumer DERIVED from the source — memoized resolutions,
    // registration-level facts — across attach, detach, and change. Nothing
    // here is derived. `defaultId` reads through on every call, so both of its
    // hooks would be no-ops and the source thunk would restate this field.
    ctx.inject(['settings'], (settingsCtx) => {
      const settings = settingsCtx.settings.register(
        settingsNamespace(SETTINGS_NAMESPACE),
        AgentPresetSettingsSchema,
        { base: { default: config.default } },
      )
      this.settings = settings
      this.settingsService = settingsCtx.settings
      settingsCtx.effect(() => {
        const stop = settings.watch((next, previous) => {
          for (const presetId of changedPresetEnablementIds(next.pluginEnablement, previous.pluginEnablement)) {
            this.standing.delete(presetId)
          }
        })
        return () => {
          stop()
          /* v8 ignore else -- Cordis disposes this settings injection before replacing it. */
          if (this.settings === settings) this.settings = undefined
          this.settingsService = undefined
        }
      }, 'agentPresets.settings()')
    })

    // Advisory, not fatal: a synchronous `agent/created` listener that throws
    // VETOES publication, and this service must not, because composing an agent
    // outside the roster is legal — `recompose` binds exactly such a bare agent
    // below, and the ACP, SDK-server, and headless entry points all create one.
    // The invariant companion is the check that fails loud, at assembly. Why an
    // unjoined agent matters at all has one home: the [Agent
    // Note](../../../../.agents/notes/implemented/architecture/2026-08-10-host-plane-ownership-after-presets.md).
    //
    // Known false positive: a session created bare and bound later by
    // `recompose` is warned about once, before its first bind. No shipped flow
    // does that today — the Web surface mounts in `setup` and children join
    // through `composeFrom` before publication.
    ctx.on('agent/created', ({ agent }) => {
      if (this.resolvedRoots.length === 0) return
      if (this.composedPreset(agent.ctx) !== undefined) return
      ctx.logger.warn(
        `agent "${agent.id}" was published without joining an agent preset; `
        + 'its tools, prompt sections, and skill registry view resolve against the empty global layer '
        + '(join through AgentPresets.mount() or composeFrom() in the agent factory setup)',
      )
    })

    // The durable record is the commit point. Its public notification carries
    // only the stable identity needed by clients, never the live Session.
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'agent-preset/selected') return
      let notified = selectedNotifications.get(ctx.root)
      if (notified === undefined) selectedNotifications.set(ctx.root, notified = new WeakSet())
      if (notified.has(event)) return
      notified.add(event)
      ctx.emit('agent-preset/selected', session.id, event.data.agentPreset)
    })
  }

  /**
   * The preset id mounted when a caller names none.
   *
   * Read per call rather than cached: the settings document is hot-reloaded, so
   * changing the default takes effect on the next session created and leaves
   * every running session on the preset it was composed from.
   */
  get defaultId(): string {
    return this.settings?.get().default ?? this.config.default
  }

  /**
   * Every preset the configured roots currently supply.
   * @returns the presets, first-root-wins per id.
   */
  async list(): Promise<AgentPreset[]> {
    return await discoverPresets(this.resolvedRoots)
  }

  /**
   * Resolve one preset by id.
   *
   * A broken preset resolves — deleting one, reading one, and reporting one
   * all need the row — and the mounting paths refuse it AFTER resolution
   * through {@link resolveMountable}.
   * @param id - the preset id, or `undefined` for {@link defaultId}.
   * @returns the resolved preset.
   * @throws when no configured root supplies that id.
   */
  async resolve(id?: string): Promise<AgentPreset> {
    const wanted = id ?? this.defaultId
    const presets = await this.list()
    const found = presets.find(preset => preset.id === wanted)
    if (found === undefined) {
      throw new UnknownPresetError(wanted, presets.map(preset => preset.id))
    }
    return found
  }

  /**
   * Resolve one preset that is about to compose an agent, refusing a broken
   * one with its discovery-reported reason. Failing here rather than inside
   * the loader keeps the answer the same for every unloadable shape — ghost
   * directory, unparsable YAML, rowless list — and spends no mount attempt
   * on a composition discovery already read as unusable.
   * @param id - the preset id, or `undefined` for {@link defaultId}.
   * @returns the resolved, mountable preset.
   * @throws when the preset is unknown or discovery reports it broken.
   */
  private async resolveMountable(id?: string): Promise<AgentPreset> {
    const preset = await this.resolve(id)
    if (preset.broken !== undefined) {
      throw new PresetMountError(preset.id, preset.broken)
    }
    return preset
  }

  /**
   * Standing mounts by preset id, single-flight so two agents racing the
   * first use of one preset share one composition. A settled failure is
   * removed so a later session retries a preset whose file has been fixed; a
   * settled success serves until the composition FILE visibly changes — each
   * generation records its file stamp, and a stale stamp starts the next
   * generation for sessions created afterwards. Sessions already joined keep
   * the generation they run on; a superseded one is never disposed while the
   * process lives (reclaimed only by whole-tree teardown), so editing files
   * is bounded by how often compositions change, not by session count.
   */
  private readonly standing = new Map<string, Promise<StandingMount>>()
  /** Every generation remains owned until its originating root is revoked or the roster unloads. */
  private readonly generations = new Map<ScopeKey, { preset: AgentPreset; scope: Scope }>()
  /** Origin survives revocation while an agent still retains its generation key. */
  private readonly generationOrigins = new WeakMap<ScopeKey, string>()

  /**
   * Parent bindings of the agents this roster composed, keyed by the agent's
   * scope key. The binding is @hydraharness/harness-scope's only re-link capability; holding it
   * here makes this service the sole authority that can move an agent between
   * standing compositions. WeakMap: entries die with their agents.
   */
  private readonly bindings = new WeakMap<ScopeKey, ScopeParentBinding>()

  /**
   * Compose one agent from a preset: ensure the preset's standing mount, then
   * parent the agent's scope key to it so the mount's registrations and
   * listeners cover this agent.
   *
   * Call from the agent factory's `setup(agentCtx)`; a rejection there rolls
   * the agent creation back, so a broken preset never yields a half-composed
   * session.
   * @param agentCtx - the agent's scope context.
   * @param id - the preset id, or `undefined` for {@link defaultId}.
   * @returns the preset that was composed, for the caller to record.
   * @throws when the preset is unknown or its composition is unusable.
   */
  async mount(agentCtx: Context, id?: string): Promise<AgentPreset> {
    const agentKey = scopeOf(agentCtx)
    if (agentKey === undefined) {
      throw new Error('agent-presets: refusing to compose an unscoped context; the scope key is what joins an agent to its preset')
    }
    const preset = await this.resolveMountable(id)
    const standing = await this.ensureStanding(preset)
    // The one bind of this agent's ancestry. The binding is the only re-link
    // authority, held privately so nothing outside this roster can move a
    // composed agent to another preset; a later recompose layer re-links
    // through it under the caller-owned blank-session contract.
    this.bindings.set(agentKey, bindScopeParent(agentKey, standing.key))
    return preset
  }

  /**
   * Join one agent to the SAME standing composition another already runs on.
   *
   * This is how a child agent inherits its parent's capabilities. It is a bind,
   * not a mount: the parent's generation is already composed, so the child gets
   * that exact instance — the same plugin objects, the same tool registrations,
   * the same prompt sections. Re-resolving the parent's preset by id instead
   * would re-read the roster, and a composition file edited since the parent
   * started would hand the child a DIFFERENT generation than the one its
   * parent's history was produced under (and a preset deleted since would fail
   * the child outright while its parent keeps running).
   *
   * Synchronous, and with no composition failure mode of its own — it reads no
   * roster, mounts nothing, and touches no file — which is what lets a child
   * creation window use it: the two in-process subagent drivers compose their
   * children inside a synchronous `setup`. It still rejects a caller error, as
   * the `@throws` below record.
   *
   * A parent that joined no preset — a rosterless deployment — yields no join
   * and no error: there, the model-facing rows sit in the host composition and
   * the child already sees them through the global layer.
   * @param agentCtx - the joining agent's scope context.
   * @param parentCtx - the scope context of the agent whose composition to join.
   * @returns the preset id joined, or undefined when the parent joined none.
   * @throws when `agentCtx` carries no scope, or has already joined a preset.
   */
  composeFrom(agentCtx: Context, parentCtx: Context): string | undefined {
    const agentKey = scopeOf(agentCtx)
    if (agentKey === undefined) {
      throw new Error('agent-presets: refusing to compose an unscoped context; the scope key is what joins an agent to its preset')
    }
    const standing = standingMountFor(parentCtx)
    if (standing === undefined) return undefined
    this.bindings.set(agentKey, bindScopeParent(agentKey, standing.key))
    return standing.presetId
  }

  /**
   * The preset one live agent runs on.
   *
   * Read from the live scope chain rather than from the session, so it answers
   * for an agent whose session has not recorded a preset yet — a child agent
   * whose durable header is being built from its parent's composition.
   * @param agentCtx - the agent's scope context.
   * @returns the preset id, or undefined when the agent joined none.
   */
  composedPreset(agentCtx: Context): string | undefined {
    return standingMountFor(agentCtx)?.presetId
  }

  /**
   * The roots this roster scans, which is not `config.roots`: it is every
   * configured root in order, then the harness-home user root unless
   * `includeUserRoot` is false. Read this — not the config field — to answer
   * whether a roster is composed at all, so one derivation decides it.
   */
  get roots(): readonly PresetRoot[] {
    return this.resolvedRoots
  }

  /**
   * Enable or revoke one workspace project root. Revocation disposes its
   * generations, including pending mounts; generations from other roots remain live.
   * @param path - project directory containing preset subdirectories.
   * @param enabled - whether the project root may supply compositions.
   * @returns completion after revoked project generations have stopped.
   */
  async setProjectRoot(path: string, enabled: boolean): Promise<void> {
    const projectPath = resolve(expandHomePath(path))
    const currentIndex = this.resolvedRoots.findIndex(root => resolve(expandHomePath(root.path)) === projectPath)
    if ((enabled && currentIndex === 0) || (!enabled && currentIndex === -1)) return
    const remaining = this.resolvedRoots.filter(root => resolve(expandHomePath(root.path)) !== projectPath)
    this.resolvedRoots = enabled ? [{ path: projectPath, trust: 'user' }, ...remaining] : remaining
    for (const [key, generation] of [...this.generations]) {
      if (dirname(dirname(generation.preset.path)) !== projectPath) continue
      this.standing.delete(generation.preset.id)
      if (enabled) continue
      this.generations.delete(key)
      await generation.scope.dispose()
    }
    if (!enabled) return
    // A project preset may shadow a generation supplied by another root.
    for (const preset of await discoverPresets([{ path: projectPath, trust: 'user' }])) {
      this.standing.delete(preset.id)
    }
  }

  /**
   * Whether an agent joined a generation supplied below a project directory,
   * including a generation disposed after trust was revoked.
   * @param agentCtx - the agent's registration context.
   * @param root - project directory whose preset origins to recognize.
   * @returns whether the joined generation originates inside that directory.
   */
  isProjectContext(agentCtx: Context, root: string): boolean {
    return this.projectGenerations(agentCtx, root).length > 0
  }

  /**
   * Whether an agent retains a project generation stopped by trust revocation.
   * Re-trusting a workspace permits fresh generations, without restoring stopped ones.
   * @param agentCtx - the agent's registration context.
   * @param root - project directory whose stopped generations to recognize.
   * @returns whether continuing this agent requires a fresh composition.
   */
  isRetiredProjectContext(agentCtx: Context, root: string): boolean {
    return this.projectGenerations(agentCtx, root).some(key => !this.generations.has(key))
  }

  private projectGenerations(agentCtx: Context, root: string): ScopeKey[] {
    const projectRoot = resolve(expandHomePath(root))
    return scopeChainOf(scopeOf(agentCtx)).filter((key) => {
      const origin = this.generationOrigins.get(key)
      if (origin === undefined) return false
      const location = relative(projectRoot, origin)
      return !isAbsolute(location) && location !== '..' && !location.startsWith(`..${sep}`)
    })
  }

  /** Whether this deployment has a root locally authored presets go to. */
  get authorable(): boolean {
    return this.workspaceRoot !== undefined || this.resolvedRoots.some(root => root.trust === 'user')
  }

  private get authoringRoots(): readonly PresetRoot[] {
    return this.workspaceRoot === undefined
      ? this.resolvedRoots
      : [{ path: join(this.workspaceRoot, '.hydra', 'agent-presets'), trust: 'user' }]
  }

  /**
   * Resolve a locally writable preset directory for an editor.
   * @param id - the preset to edit.
   * @returns its directory after checking authoring ownership and canonical containment.
   * @throws when the preset is inherited, read-only, or escapes through a link.
   */
  async authoringDirectory(id: string): Promise<string> {
    return authoringDirectory(this.authoringRoots, await this.resolve(id), this.workspaceRoot)
  }

  /**
   * Read one preset's composition text.
   * @param id - the preset id.
   * @returns the composition exactly as stored.
   * @throws when no configured root supplies that id.
   */
  async read(id: string): Promise<string> {
    return await readComposition(await this.resolve(id))
  }

  /**
   * List the explicit leaf rows every preset can switch for future sessions.
   * @param settings - optional selected layer whose desired enablement to read.
   * @returns every leaf with its persisted desired state.
   */
  async listPluginEntries(settings?: SettingsProvider): Promise<AgentPresetPluginEntry[]> {
    const entries: AgentPresetPluginEntry[] = []
    const enablement = settings === undefined ? this.settings?.get().pluginEnablement ?? {}
      : this.pluginEnablementSource(settings).enablement
    for (const preset of await this.list()) {
      if (preset.broken !== undefined) continue
      try {
        const rows = load(await readComposition(preset), { schema: entryListSchema })
        if (!Array.isArray(rows)) continue
        collectPresetPluginEntries(rows, preset.id, enablement[preset.id] ?? {}, entries)
      } catch {
        // Discovery reports a concurrently broken composition on its next scan.
      }
    }
    return entries
  }

  /**
   * Persist one preset leaf state and let only later sessions mount a new generation.
   * @param entryId - preset-qualified leaf entry id.
   * @param enabled - desired state for later sessions.
   * @param settings - selected write layer; omitted uses this roster's provider.
   */
  async setPluginEnabled(entryId: string, enabled: boolean, settings?: SettingsProvider): Promise<void> {
    const entry = (await this.listPluginEntries(settings)).find(candidate => candidate.entryId === entryId)
    if (entry === undefined) throw new Error(`agent-presets: plugin entry ${entryId} was not found`)
    if (entry.enabled === enabled) return
    const source = settings ?? this.selfCtx.get('settings')
    if (source === undefined) throw new Error('agent-presets: plugin settings are unavailable')
    const { revision } = this.pluginEnablementSource(source)
    await source.update(settingsNamespace(SETTINGS_NAMESPACE),
      { pluginEnablement: { [entry.presetId]: { [entry.rowId]: enabled } } }, revision)
    // Existing sessions retain their joined standing mount. A later mount gets
    // fresh Include patches from the committed settings value.
    this.standing.delete(entry.presetId)
  }

  private pluginEnablementSource(settings: SettingsProvider): {
    enablement: Record<string, Record<string, boolean>>
    revision: number
  } {
    const descriptor = settings.describe().find(section => section.ns === SETTINGS_NAMESPACE)
    if (descriptor === undefined) throw new Error('agent-presets: plugin settings are unavailable')
    const inherited = (descriptor.base as Partial<AgentPresetSettings>).pluginEnablement ?? {}
    const user = (descriptor.user as Partial<AgentPresetSettings> | undefined)?.pluginEnablement ?? {}
    const enablement = Object.fromEntries([...new Set([...Object.keys(inherited), ...Object.keys(user)])]
      .map(presetId => [presetId, { ...inherited[presetId], ...user[presetId] }]))
    return { enablement, revision: descriptor.revision }
  }

  /**
   * Create a locally authored preset by copying an existing one whole.
   *
   * Copy is the only authoring write. Composition text never crosses this
   * seam: the source is named by id and its directory is copied as it stands,
   * so the copy is exactly as loadable as its source and authoring grants no
   * capability the roster did not already carry. The copy is NOT mounted to
   * validate — a source that mounts today yields a copy that mounts today.
   * @param from - the preset the copy starts from; shipped presets are the
   * primary source, so any trust is accepted.
   * @param id - the new preset's id, which becomes its directory name.
   * @param name - display name for the copy; absent falls back to the id.
   * @throws when the source is unknown, the id is unusable or already taken,
   * or the deployment configures no writable root.
   */
  async copy(from: string, id: string, name?: string): Promise<void> {
    const source = await this.resolve(from)
    // The roster check refuses ids any root supplies — shipped ones included,
    // since a user directory named like a shipped preset is shadowed by it.
    // The disk check inside copyComposition only sees the writable root.
    if ((await this.list()).some(preset => preset.id === id)) {
      throw new PresetExistsError(id)
    }
    await copyComposition(this.authoringRoots, source, id, name, this.workspaceRoot)
    // A settled mount under this id can only be stale (its preset was deleted
    // from disk outside `remove`); the new preset must not inherit it. Every
    // session already joined keeps the generation it runs on regardless.
    this.standing.delete(id)
  }

  /**
   * Delete a locally authored preset.
   * @param id - the preset id.
   * @throws when the preset is unknown, ships with the deployment, or remains
   * a workspace's inherited default.
   */
  async remove(id: string): Promise<void> {
    const preset = await this.resolve(id)
    const inherited = this.settingsService?.describe()
      .find(descriptor => descriptor.ns === SETTINGS_NAMESPACE)?.base as AgentPresetSettings | undefined
    if (this.workspaceRoot !== undefined && preset.trust === 'user' && inherited?.default === id) {
      throw new PresetNotWritableError(id,
        'it is an inherited default; select another default in the lower settings layer before removing it')
    }
    await deleteComposition(this.authoringRoots, preset, this.workspaceRoot)
    // Existing sessions retain their joined generation.
    this.standing.delete(id)
    if (this.settings?.get().default !== id) return
    await this.settingsService?.mutate(
      settingsNamespace(SETTINGS_NAMESPACE),
      [{ op: 'unset', path: ['default'] }],
    )
  }

  /**
   * One agent's instance of a service its preset mounted.
   *
   * A preset publishes services behind `isolate` realms, which are invisible
   * outside the group that declares them — including to the host. This is how a
   * caller holding the agent reads one anyway: a request that is ABOUT a
   * session but arrives from outside it, which is every browser RPC.
   *
   * Read addressing only. A host row that `inject`s a service cannot use this,
   * because injection resolves before any session exists and has no agent to
   * key by; such a service belongs on the host plane instead.
   * @param agent - the agent whose composition to look inside.
   * @param name - the service name as the preset's rows resolve it.
   * @returns the agent's instance, or undefined when its preset mounts none.
   */
  serviceFor<K extends string & keyof Context>(agent: { ctx: Context }, name: K): Context[K] | undefined {
    return serviceForAgent(this.ctx, agent, name)
  }

  /**
   * Re-link one agent to a different preset's standing composition.
   *
   * Only valid while the agent has produced nothing: swapping tools mid
   * conversation would leave logged tool calls the new composition cannot
   * make. The CALLER owns that check — this method does not read session
   * history.
   *
   * The swap is a parent re-link, not an unmount: standing mounts are shared
   * and permanent, so the old composition stays for its other agents and the
   * new one is ensured BEFORE the link moves. An unknown or unusable preset
   * therefore throws with the agent exactly as it was — there is no torn-down
   * state to restore. The re-link runs through the binding this roster kept
   * from the agent's mount — @hydraharness/harness-scope's only re-link authority. An agent
   * that never composed one has nothing to re-link: the switch is then the
   * agent's first bind, exactly a mount.
   * @param agentCtx - the agent's scope context.
   * @param id - the preset to compose the agent from instead.
   * @returns the preset now installed.
   * @throws when the preset is unknown or its composition is unusable.
   */
  async recompose(agentCtx: Context, id: string): Promise<AgentPreset> {
    const agentKey = scopeOf(agentCtx)
    if (agentKey === undefined) {
      throw new Error('agent-presets: refusing to recompose an unscoped context')
    }
    const preset = await this.resolveMountable(id)
    const standing = await this.ensureStanding(preset)
    const binding = this.bindings.get(agentKey)
    if (binding === undefined) {
      this.bindings.set(agentKey, bindScopeParent(agentKey, standing.key))
    } else {
      binding.rebind(standing.key)
    }
    return preset
  }

  /**
   * The standing scope key of one preset, for a host reader with no agent.
   *
   * A cold transcript read resolves tool presenters against the composition
   * the session recorded, and the standing mount makes that possible without
   * resuming anything: ensuring the mount composes plugins but starts no
   * agent, no session, and no turn.
   * @param id - the preset id, or `undefined` for {@link defaultId}.
   * @returns the standing scope key readers pass as a registry view scope.
   * @throws when the preset is unknown or its composition is unusable.
   */
  async standingKeyFor(id?: string): Promise<ScopeKey> {
    const preset = await this.resolveMountable(id)
    return (await this.ensureStanding(preset)).key
  }

  /** Resolve (or create, single-flight) the standing mount of one preset. */
  private async ensureStanding(preset: AgentPreset): Promise<StandingMount> {
    const origin = dirname(dirname(preset.path))
    if (!this.resolvedRoots.some(root => resolve(expandHomePath(root.path)) === origin)) {
      throw new PresetMountError(preset.id, 'the preset root is no longer enabled')
    }
    const pending = this.standing.get(preset.id)
    if (pending !== undefined) {
      const mounted = await pending
      // Files are the only composition editor (authoring is copy/delete), so
      // the stamp is what notices an edit: a changed file starts the next
      // generation here, for this and later sessions. An unreadable stamp
      // serves the current generation — a mount must survive its file
      // disappearing, and failing the session over a stat would not.
      const current = await compositionStamp(preset.path)
      if (current === undefined || sameStamp(mounted.stamp, current)) return mounted
      // TODO: reclaim the superseded generation once the last agent joined to
      // it is gone. The subtree is not inert — `@hydraharness/harness-skill-filesystem` watches its
      // roots — and the settings-page authoring flow turns "a composition
      // changed" into a per-save event. This needs a joined-agent count on
      // StandingMount, incremented in `mount`/`composeFrom`/`recompose` and
      // decremented when the agent's scope key dies.
      // Guarded delete: a caller that raced this one may have already started
      // the next generation, and dropping THAT pointer would fork a third.
      if (this.standing.get(preset.id) === pending) this.standing.delete(preset.id)
      return this.ensureStanding(preset)
    }
    const created = (async (): Promise<StandingMount> => {
      const key: ScopeKey = { agentPreset: preset.id }
      const parent = scopeOf(this.selfCtx)
      const scope = createScope(this.selfCtx, key, parent === undefined ? undefined : { parent })
      this.generations.set(key, { preset, scope })
      this.generationOrigins.set(key, preset.path)
      try {
        // Stamped before the file is read: an edit racing the mount makes the
        // stamp stale rather than silently current, so the next session
        // refreshes instead of trusting a composition older than its stamp.
        const stamp = await compositionStamp(preset.path)
        if (stamp === undefined) {
          throw new PresetMountError(preset.id, `composition file is unreadable: ${preset.path}`)
        }
        await mountPreset(scope.ctx, preset, this.enablementPatches(preset.id))
        return { key, scope, stamp }
      } catch (error) {
        this.generations.delete(key)
        this.standing.delete(preset.id)
        await scope.dispose()
        throw error
      }
    })()
    this.standing.set(preset.id, created)
    return created
  }

  /** Include patches that override only persisted leaf states for one preset. */
  private enablementPatches(presetId: string): PatchOptions[] {
    return Object.entries(this.settings?.get().pluginEnablement[presetId] ?? {})
      .map(([id, enabled]) => ({ id, disabled: !enabled }))
  }
}

/** The composition file identity one standing generation was mounted from. */
interface CompositionStamp {
  /** Modification time in milliseconds, as `stat` reports it. */
  readonly mtimeMs: number
  /** File size in bytes, the tiebreak for edits within one mtime tick. */
  readonly size: number
}

/** Read one composition file's stamp, or undefined when it cannot be statted. */
async function compositionStamp(path: string): Promise<CompositionStamp | undefined> {
  try {
    const { mtimeMs, size } = await stat(path)
    return { mtimeMs, size }
  } catch {
    // Deleted, replaced by an unreadable entry, or otherwise unstattable all
    // mean the same to the caller: the file offers no identity to compare.
    return undefined
  }
}

/** Whether two stamps name the same file state. */
function sameStamp(a: CompositionStamp, b: CompositionStamp): boolean {
  return a.mtimeMs === b.mtimeMs && a.size === b.size
}

/** One preset's standing composition. */
interface StandingMount {
  /** Scope key agents are parented to; also the mount's registration scope. */
  readonly key: ScopeKey
  /** Disposal boundary; held for whole-tree teardown, never per-session. */
  readonly scope: Scope
  /** Stamp of the composition file this generation was mounted from. */
  readonly stamp: CompositionStamp
}

export default AgentPresets

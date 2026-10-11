/**
 * Agent-preset default-settings controller.
 *
 * The roster supplies available presets; the addressed settings view supplies
 * the selected layer's default and inheritance. Writes target the namespace's
 * `default` field, which the Host resolves at session creation.
 */

import type { IApiClient, SettingsNamespaceView } from '@hydraharness/harness-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@hydraharness/harness-client-runtime/client'
import type { SettingsDescribeFace, SettingsTarget } from '@hydraharness/harness-client-ui-settings/client'

/** The agent-preset settings namespace on the host wire. */
export const AGENT_PRESET_SETTINGS_NS = 'agent-presets'

/**
 * Human text for a rejected wire call. A transport failure rejects with an
 * Error; a host or a runtime can reject with anything, and the surface still
 * has to say something.
 * @param error - the rejection value.
 * @returns the message to show.
 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Persist one preset as the default for sessions created later.
 *
 * The default is a settings field rather than a preset property, so both the
 * General row and the management section write it here — one home for which
 * namespace and field the host resolves at session creation.
 * @param api - the settings wire face.
 * @param id - the preset to make default.
 * @param target - global or workspace document receiving the override.
 * @param accept - folds the addressed Host acknowledgement into its settings mirror.
 * @returns the failure message, or undefined once the write landed.
 */
export async function writeDefaultPreset(
  api: Pick<IApiClient, 'settings'>,
  id: string,
  target: SettingsTarget = {},
  accept?: (view: SettingsNamespaceView) => void,
): Promise<string | undefined> {
  let response
  try {
    response = await api.settings.update({ ...target, ns: AGENT_PRESET_SETTINGS_NS, patch: { default: id } })
  } catch (error) {
    // The transport rejected rather than answering; the caller must be able to
    // say so instead of the row silently snapping back.
    return messageOf(error)
  }
  if (!response.result.ok) return response.result.error.message
  accept?.(response.result.value)
  return undefined
}

/** One selectable preset. */
export interface AgentPresetOption {
  /** Preset id, written to Settings and the label's fallback. */
  id: string
  /** Whether the preset ships with the deployment or was authored locally. */
  trust: 'system' | 'user'
  /** Display name the preset published, absent when it published none. */
  name?: string
  /** One sentence on what the preset is for. */
  description?: string
}

/** One roster entry exactly as the host reports it. */
export interface RosterPreset {
  /** Preset id and directory name. */
  id: string
  /** Whether the preset ships with the deployment or was authored locally. */
  trust: 'system' | 'user'
  /** Whether a session that names no preset gets this one. */
  isDefault: boolean
  /** Display name the preset published, absent when it published none. */
  name?: string
  /** One sentence on what the preset is for. */
  description?: string
  /** Why the preset cannot compose a session, absent when it can. */
  broken?: string
}

/** The roster the host answered with. */
export interface RosterValue {
  /** Every preset the deployment composes, in the order the host lists them. */
  presets: readonly RosterPreset[]
  /** Whether this browser may author presets at all. */
  authorable: boolean
  /** Whether the host can open a preset directory on a native desktop. */
  hasDocument: boolean
}

/** The roster, or the message to show in its place. */
export type RosterRead = { ok: true; value: RosterValue } | { ok: false; error: string }

/**
 * Read the roster, folding both refusal shapes into one message.
 *
 * The wire refuses in two ways — the transport rejects, or it answers an
 * `ok: false` envelope — and every surface treats them identically. Folding
 * them here keeps each store's `load` about what it does with a roster rather
 * than about how the call can fail.
 * @param api - the agent-preset wire face.
 * @param target - workspace whose effective roster is requested.
 * @returns the roster, or the message to show in its place.
 */
export async function readRoster(api: Pick<IApiClient, 'agentPresets'>, target: SettingsTarget = {}): Promise<RosterRead> {
  try {
    const response = await api.agentPresets.list(target)
    return response.result.ok
      ? { ok: true, value: response.result.value }
      : { ok: false, error: response.result.error.message }
  } catch (error) {
    return { ok: false, error: messageOf(error) }
  }
}

/**
 * Serialize roster refreshes, coalescing invalidations during a read into a
 * rerun before publishing. Callers settle after the latest requested refresh.
 * @param api - the agent-preset wire face.
 * @param store - the surface's own snapshot store.
 * @param accept - publish a successful roster into the surface's snapshot.
 * @param target - workspace whose effective roster is requested.
 * @returns the refresh callback owned by this controller.
 */
export function createRosterLoader<S extends { status: string; error: string | null }>(
  api: Pick<IApiClient, 'agentPresets'>,
  store: SnapshotStore<S>,
  accept: (roster: RosterValue) => void | Promise<void>,
  target: SettingsTarget = {},
): () => Promise<void> {
  let inFlight: Promise<void> | undefined
  let rerun = false
  const needsRerun = (): boolean => rerun
  return () => {
    if (inFlight !== undefined) {
      rerun = true
      return inFlight
    }
    inFlight = Promise.resolve().then(async () => {
      try {
        do {
          store.set({ ...store.getSnapshot(), status: 'loading', error: null })
          rerun = false
          const roster = await readRoster(api, target)
          if (needsRerun()) continue
          if (roster.ok) await accept(roster.value)
          else store.set({ ...store.getSnapshot(), status: 'error', error: roster.error })
        } while (needsRerun())
      } finally {
        inFlight = undefined
      }
    })
    return inFlight
  }
}

/**
 * The roster entries as the pickers render them: healthy presets only.
 *
 * The chip and the row exist to choose the NEXT session's composition, and a
 * broken preset cannot compose one — offering it would defer the discovery
 * of that fact to a failed session start. The management section renders the
 * full roster (broken rows included) from its own store instead.
 *
 * The chip, the row, and the management section all show the same facts, and
 * `exactOptionalPropertyTypes` makes "absent" and "present as undefined"
 * different shapes — so the spread dance belongs in one place rather than
 * once per store.
 * @param presets - the roster the host answered with.
 * @returns one option per selectable preset, in roster order.
 */
export function presetOptions(
  presets: readonly { id: string; trust: 'system' | 'user'; name?: string; description?: string; broken?: string }[],
): AgentPresetOption[] {
  return presets.filter(preset => preset.broken === undefined).map(preset => ({
    id: preset.id,
    trust: preset.trust,
    ...preset.name === undefined ? {} : { name: preset.name },
    ...preset.description === undefined ? {} : { description: preset.description },
  }))
}

/** Agent-preset settings-row snapshot. */
export interface AgentPresetSettingsState {
  status: 'idle' | 'loading' | 'ready' | 'saving' | 'unavailable' | 'error'
  error: string | null
  /**
   * Whether this browser may persist the choice at all. `settings.describe` is
   * loopback-only and reports a read-only provider as `writable: false`; the
   * row then shows the current default and disables the control rather than
   * offering a write the gateway will refuse.
   */
  writable: boolean
  currentValue: string
  /** Whether the addressed document overrides the inherited preset. */
  overridden?: boolean
  options: readonly AgentPresetOption[]
}

const INITIAL: AgentPresetSettingsState = {
  status: 'idle',
  error: null,
  // Assumed until `load()` asks; a row that has not read yet renders nothing
  // interactive anyway (status 'idle').
  writable: true,
  currentValue: '',
  options: [],
}

/** Reads the roster and persists the chosen default. */
export class AgentPresetSettingsController {
  /** Row snapshot the renderer subscribes to. */
  readonly store: SnapshotStore<AgentPresetSettingsState> = createSnapshotStore(INITIAL)
  private readonly refresh: () => Promise<void>

  /**
   * @param api - the agent-preset and settings wire faces (roster and default write).
   * @param describeFace - the shared mirror's describe face (writability source).
   */
  constructor(
    private readonly api: IApiClient,
    private readonly describeFace: SettingsDescribeFace,
  ) {
    this.refresh = createRosterLoader(api, this.store, roster => this.acceptRoster(roster), describeFace.target)
  }

  private set(patch: Partial<AgentPresetSettingsState>): void {
    this.store.set({ ...this.store.getSnapshot(), ...patch })
  }

  /**
   * Load the roster. An empty roster means the deployment composes no
   * presets, which is a valid deployment rather than a failure — the row
   * reports `unavailable` and renders nothing.
   * @returns once the snapshot reflects the host.
   */
  load(): Promise<void> {
    return this.refresh()
  }

  private async acceptRoster(roster: RosterValue): Promise<void> {
    const { presets } = roster
    const [first] = presets
    if (first === undefined) {
      this.set({ status: 'unavailable', options: [], currentValue: '' })
      return
    }
    // The roster says what may be chosen; the shared mirror says whether this
    // browser may write the choice down. A non-loopback browser's mirror never
    // answers, so the row stays read-only rather than offering a control
    // whose write the Host would refuse.
    await this.describeFace.ensure()
    const settings = this.describeFace.getSnapshot().view?.namespaces.find(view => view.ns === AGENT_PRESET_SETTINGS_NS)
    this.set({
      status: 'ready',
      error: null,
      writable: this.describeFace.getSnapshot().view?.writable ?? false,
      options: presetOptions(presets),
      // A roster can mark nothing default: settings can name a preset that
      // was since deleted, and the picker still has to show something.
      currentValue: (settings?.value as { default?: string } | undefined)?.default
        ?? presets.find(preset => preset.isDefault)?.id ?? first.id,
      overridden: Object.prototype.hasOwnProperty.call(settings?.user ?? {}, 'default'),
    })
  }

  /**
   * Persist one preset as the default for sessions created later. Running
   * sessions keep the composition they were created with, so this never
   * disturbs work in progress.
   * @param id - the preset to make default.
   * @returns once the write settled and the roster was re-read.
   */
  async select(id: string): Promise<void> {
    const before = this.store.getSnapshot()
    if (before.status === 'saving' || id === before.currentValue) return
    this.set({ status: 'saving', error: null, currentValue: id })
    const failure = await writeDefaultPreset(this.api, id, this.describeFace.target, (view) => { this.describeFace.acceptView(view) })
    if (failure !== undefined) {
      this.set({ status: 'ready', currentValue: before.currentValue, error: failure })
      return
    }
    // The roster may change when the default enables a different composition.
    await this.load()
  }

  /**
   * Clear the addressed preset override and inherit the previous layer.
   * @returns after the Host acknowledges and the roster refreshes.
   */
  async reset(): Promise<void> {
    const view = this.describeFace.getSnapshot().view?.namespaces.find(entry => entry.ns === AGENT_PRESET_SETTINGS_NS)
    if (view === undefined || !this.store.getSnapshot().writable) return
    this.set({ status: 'saving', error: null })
    try {
      const response = await this.api.settings.mutate({ ...this.describeFace.target, ns: AGENT_PRESET_SETTINGS_NS,
        expectedRevision: view.revision, ops: [{ op: 'unset', path: ['default'] }] })
      if (!response.result.ok) throw new Error(response.result.error.message)
      this.describeFace.acceptView(response.result.value)
      await this.load()
    } catch (error) { this.set({ status: 'ready', error: messageOf(error) }) }
  }
}

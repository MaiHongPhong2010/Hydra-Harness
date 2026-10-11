/**
 * Agent-preset surface plugin, browser half — four surfaces over one roster:
 * a General-settings row for the default preset, a chip on the new-session
 * screen for the session about to start, a read-only label in the session
 * header, and a settings section that manages the roster (copy, delete,
 * default, and the way into a preset's own files).
 *
 * A running session keeps the composition it began with (the host refuses to
 * adopt an existing session under a different preset). That is what splits
 * the choice from the display: the General row and the hero chip are both
 * before-the-fact, while the header only reports what a session already runs.
 */

import type { ConnectionHandle, SessionId } from '@hydraharness/harness-api-remotes/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@hydraharness/harness-client-locale/client'
// Type-only: pulls the ctx.remote merge and the forwarded-event key face
// (the settings invalidation rides the allowlist) into this program.
import type {} from '@hydraharness/harness-api-remotes/client'
// Type-only: pulls the settings shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@hydraharness/harness-client-ui-settings/client'
import type { ClientContext } from '@hydraharness/harness-client-runtime/client'
import { createSnapshotStore } from '@hydraharness/harness-client-runtime/client'
import { AgentPresetLabel } from './AgentPresetLabel.tsx'
import type { AgentPresetLabelInjected } from './AgentPresetLabel.tsx'
import { AgentPresetRow } from './AgentPresetRow.tsx'
import type { AgentPresetRowInjected } from './AgentPresetRow.tsx'
import { AgentPresetSeat } from './AgentPresetSeat.tsx'
import type { AgentPresetSeatInjected } from './AgentPresetSeat.tsx'
import { AgentPresetSection } from './AgentPresetSection.tsx'
import type { AgentPresetSectionInjected } from './AgentPresetSection.tsx'
import { AgentPresetSeatController } from './seat-store.ts'
import type { SeatSessionSummary } from './seat-store.ts'
import { AgentPresetSectionController } from './section-store.ts'
import { en } from './locales.ts'
import { AGENT_PRESET_SETTINGS_NS, AgentPresetSettingsController } from './settings-store.ts'

export type { AgentPresetLabelInjected, AgentPresetLabelProps } from './AgentPresetLabel.tsx'
export type { AgentPresetRowInjected, AgentPresetRowProps } from './AgentPresetRow.tsx'
export type { AgentPresetSeatInjected, AgentPresetSeatProps } from './AgentPresetSeat.tsx'
export type { AgentPresetSectionInjected, AgentPresetSectionProps } from './AgentPresetSection.tsx'
export type { AgentPresetSeatState, SeatSessionSummary } from './seat-store.ts'
export {
  draftBlocker, type AgentPresetSectionState, type CopyDraft, type PresetRow, type PresetView,
} from './section-store.ts'
export type { AgentPresetOption, AgentPresetSettingsState } from './settings-store.ts'
export { AGENT_PRESET_SETTINGS_NS, writeDefaultPreset } from './settings-store.ts'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'connection', 'remote', 'settingsScope']

/**
 * Mount the General-settings row.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const { api } = ctx.get('connection') as ConnectionHandle
  const controller = new AgentPresetSettingsController(api, ctx.settingsScope.describe())
  // One roster, four surfaces. The chip is registered in a later scope, so it
  // subscribes here rather than being reached from this one.
  const rosterReaders = new Set<() => void>()
  const rosterChanged = () => {
    void controller.load()
    for (const read of rosterReaders) read()
  }
  const selection = ctx.settingsScope.selection()
  const groups = new Map<string, { row: AgentPresetSettingsController; section: AgentPresetSectionController }>()
  const addressed = () => {
    const { target } = selection.getSnapshot()
    const key = `${target.workspaceId ?? 'global'}:${target.layer ?? ''}`
    let group = groups.get(key)
    if (group === undefined) {
      group = { row: target.workspaceId === undefined
        ? controller : new AgentPresetSettingsController(api, ctx.settingsScope.describe(target)),
      section: new AgentPresetSectionController(api, rosterChanged, target, ctx.settingsScope.describe(target)) }
      groups.set(key, group)
    }
    return group
  }
  let group = addressed()
  let section = group.section
  const rowView = createSnapshotStore(group.row.store.getSnapshot())
  const sectionView = createSnapshotStore(section.store.getSnapshot())
  const follow = () => {
    const row = group.row
    const activeSection = section
    rowView.set(row.store.getSnapshot())
    sectionView.set(activeSection.store.getSnapshot())
    const disposers = [row.store.subscribe(() => { rowView.set(row.store.getSnapshot()) }),
      activeSection.store.subscribe(() => { sectionView.set(activeSection.store.getSnapshot()) })]
    return () => { for (const dispose of disposers) dispose() }
  }
  let stopGroup = follow()
  ctx.effect(() => {
    const stopSelection = selection.subscribe(() => {
      const next = addressed()
      if (next === group) return
      stopGroup()
      group = next
      section = next.section
      stopGroup = follow()
    })
    return () => { stopGroup(); stopSelection() }
  }, 'ui-agent-preset: addressed settings forms')

  ctx.effect(() => ctx.locale.register('settings.agentPreset', { en }), 'ui-agent-preset: settings row dictionaries')

  const injected = (): AgentPresetRowInjected => ({
    hooks: { agentPreset: rowView },
    load: () => group.row.load(),
    select: (id: string) => group.row.select(id),
    reset: () => group.row.reset(),
  })

  ctx.effect(() => {
    // The roster is a live directory and the default is a settings field, so
    // both an external settings edit and a reconnect can move this row.
    const refresh = (): void => {
      void controller.load()
      if (group.row !== controller) void group.row.load()
      // The section reads the same roster and marks the same default, so a
      // change made from either surface converges both.
      if (section.store.getSnapshot().status !== 'idle') void section.load()
    }
    const disposers = [
      ctx.remote.$on('settings/document-updated', (ns) => {
        if (ns !== AGENT_PRESET_SETTINGS_NS) return
        refresh()
      }),
      ctx.on('connection/reset', () => { refresh() }),
    ]
    return () => { for (const dispose of disposers) dispose() }
  }, 'ui-agent-preset: settings refresh')

  // The settings section's conversational authoring entry: stage the
  // self-referential preset and land a new session on it. Bound inside the
  // conversation scope below (the seat and the session flow live there) and
  // unbound with it, so the section's face reads the current binding per
  // render and simply hides the button while no flow exists.
  let creatorDraft: (() => void) | undefined

  // The new-session chip and the header label: one controller, because the
  // staged choice belongs to the flow rather than to any one session.
  ctx.inject(['slots', 'conversation', 'sessions', 'workspaces'], (scope: ClientContext) => {
    const api = (scope.get('connection') as ConnectionHandle).api
    const workspaceTarget = (sessionId?: SessionId) => {
      const state = scope.workspaces.list.getSnapshot()
      const workspaceId = state.items.find(row => sessionId !== undefined && row.sessionIds.includes(sessionId))?.workspaceId
        ?? (sessionId === undefined ? state.recentWorkspaceId : undefined)
      return workspaceId === undefined ? {} : { workspaceId, layer: 'local' as const }
    }
    const currentWorkspaceTarget = () => {
      const sessionId = scope.sessions.list.getSnapshot().current
      const target = workspaceTarget(sessionId)
      return target.workspaceId === undefined ? workspaceTarget() : target
    }
    const seat = new AgentPresetSeatController(api, (): SeatSessionSummary | undefined => {
      const state = scope.sessions.list.getSnapshot()
      const summary = state.current === undefined ? undefined : state.byId[state.current]
      return summary === undefined
        ? undefined
        : {
          id: summary.id,
          blank: summary.blank,
          ...summary.agentPreset === undefined ? {} : { agentPreset: summary.agentPreset },
        }
    }, (sessionId, agentPreset) => {
      scope.sessions.noteAgentPreset(sessionId as never, agentPreset)
    }, currentWorkspaceTarget)

    const seatInjected = (): AgentPresetSeatInjected => ({
      hooks: { agentPresetSeat: seat.store },
      load: () => seat.load(),
      select: (id: string) => seat.select(id),
      introduced: () => { seat.introduced() },
    })

    const labels = new Map<string, AgentPresetSettingsController>()
    const labelInjected = (sessionId: SessionId): AgentPresetLabelInjected => {
      const target = workspaceTarget(sessionId)
      const key = target.workspaceId ?? 'global'
      let roster = labels.get(key)
      if (roster === undefined) {
        roster = target.workspaceId === undefined ? controller : new AgentPresetSettingsController(api, ctx.settingsScope.describe(target))
        labels.set(key, roster)
      }
      return { hooks: { agentPresets: roster.store }, load: () => roster.load() }
    }

    scope.effect(() => {
      // Connecting a workspace either creates a blank session or reuses one,
      // and either way the chip's pick predates it — so the stage is applied
      // when the session arrives, not when it was made.
      let activeWorkspace = currentWorkspaceTarget().workspaceId
      const followWorkspace = (): void => {
        const workspaceId = currentWorkspaceTarget().workspaceId
        if (workspaceId !== activeWorkspace) { activeWorkspace = workspaceId; void seat.load() }
        void seat.apply()
      }
      const stop = scope.sessions.list.subscribe(followWorkspace)
      const stopWorkspace = scope.workspaces.list.subscribe(followWorkspace)
      // The chip opens on the deployment default, so a default changed from
      // the settings surface moves it too — otherwise the screen that starts
      // the next session keeps offering the previous default until a reload,
      // which is exactly the session the setting claims to govern. A staged
      // pick survives: `load()` prefers it over the refreshed fallback.
      const settingsMoved = scope.remote.$on('settings/document-updated', (ns) => {
        if (ns !== AGENT_PRESET_SETTINGS_NS) return
        void seat.load()
      })
      const workspaceSettingsMoved = scope.remote.$on('workspace-config/updated', (workspaceId) => {
        if (workspaceId === currentWorkspaceTarget().workspaceId) void seat.load()
        const roster = labels.get(workspaceId)
        if (roster !== undefined) void roster.load()
      })
      const workspaceTrustMoved = scope.remote.$on('workspace-config/trust-updated', (workspaceId) => {
        if (workspaceId === currentWorkspaceTarget().workspaceId) void seat.load()
        const roster = labels.get(workspaceId)
        if (roster !== undefined) void roster.load()
      })
      // Every tab folds the committed preset into the shared session row; the
      // initiating tab may already have applied the RPC echo, which is idempotent.
      const presetSelected = scope.remote.$on('agent-preset/selected', (sessionId, agentPreset) => {
        scope.sessions.noteAgentPreset(sessionId, agentPreset)
      })
      // Authoring writes a FILE, not a setting, so nothing on the wire
      // announces it — without this the screen that starts the next session
      // keeps offering the roster as it stood when the chip first loaded, and
      // a preset authored to be used is missing from the one place it is used.
      const readRoster = (): void => { void seat.load() }
      rosterReaders.add(readRoster)
      // Stage WITHOUT applying — the still-current running session would
      // refuse the swap and drop the stage — then start the session it lands
      // on: the chip's list-change applier composes the blank session the
      // workspace connect produces or reuses.
      creatorDraft = () => {
        // The introduce cue makes the chip announce the pick the user never
        // made on this screen — the stage happened back in settings.
        seat.stage('cordis', true)
        scope.workspaces.startSession()
      }
      const chip = scope.slots.register({
        name: 'conversation.hero.agentPreset',
        locale: 'settings.agentPreset',
        inject: seatInjected,
      }, AgentPresetSeat)
      const label = scope.slots.register({
        name: 'conversation.session.header.actions',
        id: 'agent-preset',
        // Static session context occupies the header's leading negative-order band.
        order: -10,
        locale: 'settings.agentPreset',
        inject: labelInjected,
      }, AgentPresetLabel)
      return () => {
        stop()
        stopWorkspace()
        settingsMoved()
        workspaceSettingsMoved()
        workspaceTrustMoved()
        presetSelected()
        rosterReaders.delete(readRoster)
        creatorDraft = undefined
        chip()
        label()
      }
    }, 'ui-agent-preset: new-session chip and header label')
  })

  const sectionInjected = (): AgentPresetSectionInjected => ({
    hooks: { agentPresetSection: sectionView },
    load: () => section.load(),
    view: (id: string) => section.view(id),
    closeView: () => { section.closeView() },
    beginCopy: (from: string) => { section.beginCopy(from) },
    cancelCopy: () => { section.cancelCopy() },
    setCopyId: (id: string) => { section.setCopyId(id) },
    setCopyName: (name: string) => { section.setCopyName(name) },
    confirmCopy: () => section.confirmCopy(),
    openLocation: (id: string) => section.openLocation(id),
    ...creatorDraft === undefined ? {} : { startCreatorDraft: creatorDraft },
    confirmDelete: (id: string | null) => { section.confirmDelete(id) },
    remove: () => section.remove(),
    makeDefault: (id: string) => section.makeDefault(id),
  })

  ctx.slots.inject('settings.general.general.item', () => ctx.slots.register({
    name: 'settings.general.general.item',
    id: 'agent-preset',
    label: () => ctx.locale.bind('settings.agentPreset')('title'),
    order: -25,
    locale: 'settings.agentPreset',
    inject: injected,
  }, AgentPresetRow))
  // Ordered after Models: choosing a model is routine, and composing an
  // agent is the deployment-shaping act behind it.
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'agent-presets',
    order: 20,
    label: () => ctx.locale.bind('settings.agentPreset')('nav'),
    locale: 'settings.agentPreset',
    inject: sectionInjected,
  }, AgentPresetSection))
}

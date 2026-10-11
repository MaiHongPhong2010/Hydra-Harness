/**
 * Permission preset plugin, browser half — a popupSelect DECORATION hung on
 * the host `/permission` command: one flat list of presets, current value
 * marked active, a pick executes the switch. The decoration owns only the
 * bare invocation; the host command keeps its catalog row, the argued path
 * (`/permission <preset>` still switches directly), and the lifecycle
 * logging. Options and the active mark read the session's `permissions`
 * projection (the same host-computed select the composer chip renders); a
 * pick submits the `/permission <preset>` command line, so both surfaces
 * write through one path and the pushed projection frame is the one
 * confirmation. The Auto-Pilot row carries the same explicit risk gate as
 * the composer chip; the shared popup shell owns the modal mechanics.
 * The General-settings row separately writes the default preset for fresh
 * sessions and eligible confirmed blank reuse through the host Settings API.
 */
import type { ConnectionHandle } from '@hydraharness/harness-api-remotes/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@hydraharness/harness-client-locale/client'
// Type-only: the settings slot types (this package registers a General row).
import type {} from '@hydraharness/harness-client-ui-settings/client'
// Type-only: pulls the ctx.remote merge and the forwarded-event key face
// (the settings invalidation rides the allowlist) into this program.
import type {} from '@hydraharness/harness-api-remotes/client'
import type { ClientContext, SessionFace } from '@hydraharness/harness-client-runtime/client'
import { createSnapshotStore } from '@hydraharness/harness-client-runtime/client'
import type { CommandUiContract, SelectOption } from '@hydraharness/harness-client-ui-commands/client'
import type { ClientSessionContext } from '@hydraharness/harness-client-ui-input-trigger/client'
import type { PermissionSelect } from '@hydraharness/harness-permission-presets/client'
import { PermissionRow } from './PermissionRow.tsx'
import type { PermissionRowInjected } from './PermissionRow.tsx'
import {
  accessEn, en,
} from './locales.ts'
import {
  displayPermissionPreset, FULL_ACCESS_PRESET,
} from './presentation.ts'
import { PermissionPresetSettingsController } from './settings-store.ts'

export type { PermissionRowInjected, PermissionRowProps } from './PermissionRow.tsx'
export type {
  PermissionDefaultOption, PermissionSettingsState,
} from './settings-store.ts'

/** Required services (cordis fiber inject). */
export const inject = ['commandUi', 'sessions', 'slots', 'locale', 'connection', 'remote', 'settingsScope', 'settingsSchema']

const ACCESS_NS = 'permission.access'

/** Read one session's current permissions projection value (undefined = capability absent). */
function selectOf(session: SessionFace | undefined): PermissionSelect | undefined {
  return session?.projections.faceOf('permissions').getSnapshot() as PermissionSelect | undefined
}

/** Flatten the projection select into popup rows; `custom` is display state, never a target. */
function optionsOf(value: PermissionSelect, t: (key: string) => string): SelectOption[] {
  return value.options
    .filter(option => option.value !== 'custom')
    .map(option => ({
      id: option.value,
      label: displayPermissionPreset(option.value, option.name, t),
      ...(option.description !== undefined ? { detail: option.description } : {}),
      ...(option.value === value.currentValue ? { active: true } : {}),
      ...(option.value === FULL_ACCESS_PRESET
        ? {
          confirmation: {
            title: t('confirm.title'),
            description: t('confirm.description'),
            acknowledgeLabel: t('confirm.acknowledge'),
            cancelLabel: t('confirm.cancel'),
            confirmLabel: t('confirm.enable'),
          },
        }
        : {}),
    }))
}

/**
 * Client plugin body: register the /permission popup picker over the
 * permissions projection.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const command = ctx.get('commandUi') as CommandUiContract
  const sessions = ctx.sessions
  // This optional bundle and ui-conversation can load independently, so each
  // owns the same safety copy under its own locale namespace.
  /* jscpd:ignore-start */
  ctx.effect(() => ctx.locale.register(ACCESS_NS, 'en', {
    'preset.readOnly': accessEn['preset.readOnly'],
    'preset.workspaceWrite': accessEn['preset.workspaceWrite'],
    'preset.fullAccess': accessEn['preset.fullAccess'],
    'confirm.title': accessEn['confirm.title'],
    'confirm.description': accessEn['confirm.description'],
    'confirm.acknowledge': accessEn['confirm.acknowledge'],
    'confirm.cancel': accessEn['confirm.cancel'],
    'confirm.enable': accessEn['confirm.enable'],
  }), 'ui-permission: Auto-Pilot confirmation dictionary')
  /* jscpd:ignore-end */
  const t = ctx.locale.bind(ACCESS_NS)
  const sessionFor = (session: ClientSessionContext): SessionFace | undefined =>
    sessions.binding(session.sessionId)?.session

  ctx.effect(() => ctx.locale.register('settings.permission', { en }), 'ui-permission: settings row dictionaries')

  const connection = ctx.get('connection') as ConnectionHandle
  // The row follows the shared describe mirror, whose owning plugin already
  // refreshes it on document commits and reconnects.
  const selection = ctx.settingsScope.selection()
  const controllers = new Map<string, PermissionPresetSettingsController>()
  const addressed = () => {
    const { target } = selection.getSnapshot()
    const key = `${target.workspaceId ?? 'global'}:${target.layer ?? ''}`
    let controller = controllers.get(key)
    if (controller === undefined) {
      controller = new PermissionPresetSettingsController(ctx.settingsScope.describe(target), connection.api, ctx.settingsSchema)
      controllers.set(key, controller)
    }
    return controller
  }
  let controller = addressed()
  const permission = createSnapshotStore(controller.store.getSnapshot())
  let stop = controller.store.subscribe(() => { permission.set(controller.store.getSnapshot()) })
  ctx.effect(() => {
    const stopSelection = selection.subscribe(() => {
      const next = addressed()
      if (next === controller) return
      stop()
      controller = next
      permission.set(controller.store.getSnapshot())
      stop = controller.store.subscribe(() => { permission.set(controller.store.getSnapshot()) })
    })
    return () => { stop(); stopSelection(); for (const item of controllers.values()) item.dispose() }
  }, 'ui-permission: addressed settings forms')
  const load = (): Promise<void> => controller.load()
  const select = (preset: string): Promise<void> => controller.select(preset)
  const injected = (): PermissionRowInjected => ({
    hooks: { permission },
    load,
    select,
    reset: () => controller.reset(),
  })

  ctx.effect(() => () => { controller.dispose() }, 'ui-permission: settings row directory')

  ctx.slots.inject('settings.general.permissions.item', () => ctx.slots.register({
    name: 'settings.general.permissions.item',
    id: 'permission',
    label: () => ctx.locale.bind('settings.permission')('title'),
    order: -20,
    locale: 'settings.permission',
    inject: injected,
  }, PermissionRow))

  ctx.slots.inject('settings.general.permissions.item', () => ctx.slots.register({
    name: 'settings.general.permissions.item', id: 'full-access', order: -19,
    label: () => ctx.locale.bind('settings.permission')('full.title'),
    locale: 'settings.permission', inject: () => ({ ...injected(), fullAccess: true }),
  }, PermissionRow))

  ctx.effect(() => command.decorate({
    name: 'permission',
    // The picker exists exactly while the projection does: a permission-less
    // host serves no key and the bare invocation falls through to the host
    // command (which is absent too — the line simply misses).
    available: session => selectOf(sessionFor(session)) !== undefined,
    ui: {
      kind: 'popupSelect',
      options: (session) => {
        const value = selectOf(sessionFor(session))
        if (value === undefined) throw new Error('permission presets are not available on this host')
        return Promise.resolve(optionsOf(value, t))
      },
      onSelect: async (option, session) => {
        const live = sessionFor(session)
        if (live === undefined) throw new Error('this session is not materialized yet')
        const result = await live.command(`/permission ${option.id}`)
        if (!result.ok) throw new Error(`permission switch failed: ${result.error.code}: ${result.error.message}`)
        if (!result.value.matched) throw new Error('the host offers no /permission command')
      },
    },
  }), 'ui-permission: /permission decoration')
}

/**
 * Layout plugin, browser half: one register() call contributes AppFrame into
 * the runtime's built-in 'root' slot and, in the same breath, declares the
 * five child slots (declaration = exclusive render authority), seats the
 * layout store (panel geometry), and wires the panel-action service face.
 * ctx.layout is the cross-plugin panel-action contract; navigation state lives
 * with the runtime sessions service. A second effect seats the theme
 * presenter, which projects ctx.theme snapshots onto document.body. The same
 * desktop feature owner contributes Browser settings when its preload exists.
 */
import type { ClientContext } from '@hydraharness/harness-client-runtime/client'
import type {} from '@hydraharness/harness-client-ui-theme/client'
import type {} from '@hydraharness/harness-client-ui-settings/client'
import type {} from '@hydraharness/harness-client-locale/client'
import type { PanelActions } from './service.ts'
import { AppFrame } from './AppFrame.tsx'
import { BrowserSection, BROWSER_SETTINGS_NAMESPACE } from './BrowserSection.tsx'
import type { BrowserSectionInjected, BrowserSettings } from './BrowserSection.tsx'
import { en as browserEn } from './browser-locales.ts'
import type { BrowserKey } from './browser-locales.ts'
import type { DesktopBrowserApi } from './DesktopBrowserPanel.tsx'
import { createLayoutStore } from './stores.ts'
import { LayoutController } from './service.ts'
import { ThemePresenter } from './theme-presenter.ts'
import { DESKTOP_PREFERENCES_NAMESPACE, type DesktopPreferences } from '../preferences.ts'
import { DesktopPreferencesController } from './DesktopPreferencesController.ts'
import { DesktopPreferenceRow, type DesktopPreferenceRowInjected } from './DesktopPreferenceRow.tsx'
import { HistoryPreferenceRow } from './HistoryPreferenceRow.tsx'
import { en as desktopEn, type DesktopSettingsKey } from './desktop-locales.ts'
import type { NativePreferencesApi } from './desktop-preferences.ts'
import type {} from '@hydraharness/harness-api-remotes/client'
import type { NotificationSettings } from '@hydraharness/harness-notifications/types'
import { NotificationsController } from './NotificationsController.ts'
import { NotificationPreferenceRow, type NotificationRowInjected } from './NotificationPreferenceRow.tsx'
import { EnvironmentPreferenceRow, type EnvironmentApi } from './EnvironmentPreferenceRow.tsx'
import { createSnapshotStore } from '@hydraharness/harness-client-runtime/client'
import type { ConfettiRequest } from '@hydraharness/harness-toys/types'
import { ConfettiOverlay } from './ConfettiOverlay.tsx'
import { ToysPreferenceRow } from './ToysPreferenceRow.tsx'
import { LicensesRow } from './LicensesRow.tsx'

type BrowserManagementApi = DesktopBrowserApi & Required<Pick<
  DesktopBrowserApi,
  'configure' | 'clearData' | 'history' | 'removeHistory' | 'downloads'
  | 'removeDownload' | 'sites' | 'setSite' | 'removeSite'
>>

type AutofillManagementApi = DesktopBrowserApi & Required<Pick<
  DesktopBrowserApi,
  'autofillStatus' | 'autofillListLogins' | 'autofillSaveLogin' | 'autofillRemoveLogin'
  | 'autofillListContacts' | 'autofillGetContact' | 'autofillSaveContact' | 'autofillRemoveContact'
>>

function hasBrowserManagement(browser: DesktopBrowserApi | undefined): browser is BrowserManagementApi {
  return browser !== undefined
    && typeof browser.configure === 'function'
    && typeof browser.clearData === 'function'
    && typeof browser.history === 'function'
    && typeof browser.removeHistory === 'function'
    && typeof browser.downloads === 'function'
    && typeof browser.removeDownload === 'function'
    && typeof browser.sites === 'function'
    && typeof browser.setSite === 'function'
    && typeof browser.removeSite === 'function'
}

function hasAutofillManagement(browser: DesktopBrowserApi): browser is AutofillManagementApi {
  return typeof browser.autofillStatus === 'function'
    && typeof browser.autofillListLogins === 'function'
    && typeof browser.autofillSaveLogin === 'function'
    && typeof browser.autofillRemoveLogin === 'function'
    && typeof browser.autofillListContacts === 'function'
    && typeof browser.autofillGetContact === 'function'
    && typeof browser.autofillSaveContact === 'function'
    && typeof browser.autofillRemoveContact === 'function'
}

// Contract exports only (export-convergence rule: cross-package consumers
// keep a symbol exported; test-only/package-internal symbols live off /src).
// ILayout: the ctx.layout face consumers and test fakes type against.
// OwnerShare contracts below are the render-side halves registrants compose
// against; the frame components and the store factory are package-internal.
export { LayoutController } from './service.ts'
export type { ILayout } from './service.ts'

declare module '@hydraharness/cordis' {
  interface Context {
    /** The outward face only; the concrete service stays inside this plugin. */
    layout: import('./service.ts').ILayout
  }
}

declare module '@hydraharness/harness-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Desktop Browser settings copy. */
    'settings.browser': BrowserKey
    /** General preferences owned by layout and local history. */
    'settings.desktop': DesktopSettingsKey
  }

  interface SlotMap {
    // The 'root' entry itself is the runtime's built-in slot (declared
    // there); these five are the frame's children, declared by the same
    // register() call that contributes AppFrame. Session owners never pass
    // sessionId: the framework injects it as a standard prop.
    /**
     * The whole left column. OCCUPIED by ui-sidebar's SidebarRoot, which
     * declares the workspace and settings seats inside it — registering here
     * replaces the navigation column outright rather than adding to it, and
     * the seats it declares disappear with it. To add something to the
     * sidebar, register into one of those inner seats instead.
     *
     * The occupant receives the frame's live column state (collapsed, width)
     * and is expected to render the compact control rail while collapsed.
     */
    'sidebar': { kind: 'single'; scope: 'root'; owner: SidebarOwnerProps }
    /**
     * The whole center column, across both the no-session hero and a live
     * conversation. OCCUPIED by ui-conversation's ConversationRoot, which
     * declares the session body, composer, and input seats inside it —
     * registering here replaces the entire conversation surface (and removes
     * every seat it declares) rather than adding to it.
     *
     * Current-session-optional: the occupant owns both states without
     * changing its React identity, so it keeps its own state across a session
     * switch. It receives no owner props; session facts arrive through the
     * framework hooks of the `session-maybe` scope.
     */
    'conversation': { kind: 'single'; scope: 'session-maybe'; owner: ConvOwnerProps }
    /**
     * The right details column, shown when the layout opens it. OCCUPIED by
     * ui-conversation's DetailsPanel, which declares the tool-details seat
     * inside it — registering here replaces the column and takes that seat
     * with it. Absent an occupant the column renders nothing.
     *
     * No owner props: the framework injects the session id and hooks for the
     * `session` scope, and `ctx.layout` owns whether the column is open.
     */
    'details': { kind: 'single'; scope: 'session'; owner: DetailsOwnerProps }
    /**
     * The desktop right panel's Review tab body. That panel mounts the seat
     * only while a Review tab is open, and the browser-only frame never
     * mounts the panel at all, so an unrendered seat is the ordinary state;
     * absent an occupant the tab body renders nothing.
     *
     * No owner props: the framework injects the session id and hooks for the
     * `session` scope, which follow the application's current session rather
     * than a side-chat session opened in a neighbouring tab.
     */
    'review': { kind: 'single'; scope: 'session' }
    /**
     * Frame-wide floating layer, above every column and outside their scroll
     * containers. Deliberately generic and unowned by any feature: a badge, a
     * toast stack or a status pill all belong here, and entries order among
     * themselves. The layer itself is click-through — entries opt back into
     * pointer events — so an occupant never blocks the app underneath.
     *
     * This is the additive seat for a frame-wide surface of your own: a fresh
     * `id` is added beside the shipped entries instead of replacing them.
     */
    'shell.overlay': { kind: 'list'; scope: 'root' }
  }
}

// OwnerShare contracts — the render-side share the slot owner supplies at
// renderSlot. Registrants IMPORT these and compose their full component props
// through the four-share intersection (PropsRuntime & PropsRenderSlots &
// PropsStore & I). Conversation business state and actions arrive through
// framework-standard hooks and each registrant's inject face, not owner props.

/** Sidebar owner share: live column state from the frame's concession solve. */
export interface SidebarOwnerProps {
  /** True when the sidebar is closed (the column renders the compact control rail). */
  collapsed: boolean
  /** Rendered column width in px (SIDEBAR_COLLAPSED when collapsed). */
  width: number
}

/** Conversation owner share: secondary occurrences suppress global navigation chrome. */
export interface ConvOwnerProps {
  secondary?: boolean | undefined
}

/** Details owner share: empty — sessionId arrives as a framework-standard prop. */
export interface DetailsOwnerProps {}

/** Required services (cordis fiber inject — the loader passes all module exports as an object plugin). */
export const inject = ['slots', 'theme', 'sessions', 'workspaces', 'locale', 'settingsScope']

/**
 * Client plugin body: provide ctx.layout, then one register() call — AppFrame
 * into 'root' with the five child-slot declarations, the layout store seat,
 * and the inject hook that hands the store's bound actions to the service.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const desktop = globalThis as typeof globalThis & {
    hydraDesktop?: { browser?: DesktopBrowserApi; preferences?: NativePreferencesApi; environment?: EnvironmentApi }
  }
  const desktopScope = ctx.settingsScope.bind<DesktopPreferences>({ namespace: DESKTOP_PREFERENCES_NAMESPACE })
  const preferences = new DesktopPreferencesController(desktopScope, desktop.hydraDesktop?.preferences)
  ctx.effect(() => preferences.start(), 'ui-layout: native preferences')
  ctx.effect(() => ctx.locale.register('settings.desktop', { en: desktopEn }), 'ui-layout: General preferences copy')
  const dt = ctx.locale.bind('settings.desktop')
  const toys = ctx.settingsScope.bind<{ confetti: boolean }>({ namespace: 'toys' })
  const effect = createSnapshotStore<ConfettiRequest | undefined>(undefined)
  let effectTimer: ReturnType<typeof setTimeout> | undefined
  ctx.effect(() => () => { clearTimeout(effectTimer) }, 'ui-layout: transient effect lifetime')
  ctx.inject(['remote'], (rctx) => {
    rctx.effect(() => rctx.remote.$on('toys/confetti', (request) => {
      if (request.sessionId !== ctx.sessions.list.getSnapshot().current || toys.getSnapshot().value?.confetti !== true
        || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
      clearTimeout(effectTimer)
      effect.set(request)
      effectTimer = setTimeout(() => { effect.set(undefined) }, request.durationMs)
    }), 'ui-layout: live requested effects')
  })
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'confetti', inject: () => ({ hooks: { effect } }) }, ConfettiOverlay))
  ctx.slots.inject('settings.general.toys.item', () => ctx.slots.register({
    name: 'settings.general.toys.item', id: 'confetti', label: () => dt('toys.title'), locale: 'settings.desktop',
    inject: () => ({ hooks: { toys }, save: async (enabled: boolean) => {
      if (!toys.getSnapshot().writable) throw new Error('Settings are read only')
      await toys.set('confetti', enabled)
      if (toys.getSnapshot().value?.confetti !== enabled) throw new Error('Could not save confetti setting')
    } }),
  }, ToysPreferenceRow))
  ctx.slots.inject('settings.general.general.item', () => ctx.slots.register({
    name: 'settings.general.general.item', id: 'licenses', order: 85, label: () => dt('licenses.title'), locale: 'settings.desktop',
  }, LicensesRow))
  const environment = desktop.hydraDesktop?.environment
  if (environment !== undefined) ctx.slots.inject('settings.general.general.item', () => ctx.slots.register({
    name: 'settings.general.general.item', id: 'environment', order: 21, label: () => dt('environment.title'), locale: 'settings.desktop',
    inject: () => ({ api: environment }),
  }, EnvironmentPreferenceRow))
  const notificationScope = ctx.settingsScope.bind<NotificationSettings>({ namespace: 'notifications' })
  const notifications = new NotificationsController(notificationScope, ctx.sessions, desktop.hydraDesktop?.preferences)
  ctx.inject(['remote'], (nctx) => {
    nctx.effect(() => nctx.remote.$on('notifications/requested', (request) => { void notifications.deliver(request) }), 'ui-layout: live notifications')
  })
  ctx.effect(() => {
    const refresh = () => { notifications.refreshPermission() }
    window.addEventListener('focus', refresh)
    return () => { window.removeEventListener('focus', refresh) }
  }, 'ui-layout: notification permission status')
  if (desktop.hydraDesktop?.preferences !== undefined || typeof Notification !== 'undefined') {
    const fields: readonly (keyof NotificationSettings)[] = ['completion', 'permissionPrompts', 'questions', 'sound']
    fields.forEach((field, order) => ctx.slots.inject('settings.general.notifications.item', () => ctx.slots.register({
      name: 'settings.general.notifications.item', id: field, order, label: () => dt(`notification.${field}.title`), locale: 'settings.desktop',
      inject: (): NotificationRowInjected => ({ field, save: value => notifications.save(field, value),
        requestPermission: () => notifications.requestPermission(),
        preview: () => notifications.preview(), hooks: { preferences: notificationScope, permission: notifications.permission } }),
    }, NotificationPreferenceRow)))
  }
  if (desktop.hydraDesktop?.preferences !== undefined) {
    const rows: readonly Omit<DesktopPreferenceRowInjected, 'hooks' | 'save' | 'openStartup'>[] = [
      { field: 'fileOpenDestination', title: 'destination.title', description: 'destination.description', applies: 'applied', choices: [
        { value: 'editor', label: 'destination.editor' }, { value: 'terminal', label: 'destination.terminal' }, { value: 'system', label: 'destination.system' },
      ] },
      { field: 'terminalShell', title: 'shell.title', description: 'shell.description', applies: 'shell.applies' },
      { field: 'closeConfirmation', title: 'close.title', description: 'close.description', applies: 'applied', choices: [
        { value: 'never', label: 'close.never' }, { value: 'shortcut', label: 'close.shortcut' }, { value: 'always', label: 'close.always' },
      ] },
      { field: 'fullView', title: 'full.title', description: 'full.description', applies: 'full.applies' },
      { field: 'startup', title: 'startup.title', description: 'startup.description', applies: 'applied' },
      { field: 'bottomPanelControl', title: 'bottom.title', description: 'bottom.description', applies: 'applied' },
      { field: 'terminalLocation', title: 'location.title', description: 'location.description', applies: 'shell.applies', choices: [
        { value: 'bottom', label: 'location.bottom' }, { value: 'right', label: 'location.right' },
      ] },
      { field: 'popoutHotkey', title: 'hotkey.title', description: 'hotkey.description', applies: 'applied' },
      { field: 'popoutStandalone', title: 'standalone.title', description: 'standalone.description', applies: 'applied' },
    ]
    rows.forEach((row, order) => {
      const slot = row.field.startsWith('popout') ? 'settings.general.popout.item' : 'settings.general.general.item'
      ctx.slots.inject(slot, () => ctx.slots.register({
        name: slot, id: row.field, order: order + 20, label: () => dt(row.title), locale: 'settings.desktop',
        inject: (): DesktopPreferenceRowInjected => ({ ...row, save: (value: string | boolean) => {
          if (row.field === 'startup') throw new Error('Startup settings are managed by the OS')
          return preferences.save(row.field, value)
        }, openStartup: () => preferences.openStartup(), hooks: { preferences: desktopScope, native: preferences.native } }),
      }, DesktopPreferenceRow))
    })
  }
  const history = ctx.settingsScope.bind<{ compression: 'none' | 'zstd' }>({ namespace: 'session-history' })
  ctx.slots.inject('settings.general.general.item', () => ctx.slots.register({
    name: 'settings.general.general.item', id: 'compression', order: 50, label: () => dt('history.title'), locale: 'settings.desktop',
    inject: () => ({ save: async (enabled: boolean) => {
      const value = enabled ? 'zstd' : 'none'
      if (!history.getSnapshot().writable) throw new Error('Settings are read only')
      await history.set('compression', value)
      if (history.getSnapshot().value?.compression !== value) throw new Error('Could not save this setting. Try again.')
    }, hooks: { history } }),
  }, HistoryPreferenceRow))
  const browser = desktop.hydraDesktop?.browser
  if (hasBrowserManagement(browser)) {
    const autofill = hasAutofillManagement(browser) ? browser : undefined
    const openUrl = browser.openUrl === undefined ? undefined : async (url: string) => {
      await browser.openUrl?.(url)
    }
    const autofillUnavailable = () => Promise.reject(new Error('secure autofill storage is unavailable'))
    ctx.effect(
      () => ctx.locale.register('settings.browser', { en: browserEn }),
      'ui-layout: Browser settings dictionaries',
    )
    const t = ctx.locale.bind('settings.browser')
    const scope = ctx.settingsScope.bind<BrowserSettings>({ namespace: BROWSER_SETTINGS_NAMESPACE })
    const openDownload = browser.openDownload === undefined
      ? undefined
      : (id: string) => browser.openDownload?.(id) ?? Promise.resolve()
    const injected = (): BrowserSectionInjected => ({
      setSetting: (key, value) => scope.set(key, value),
      configureNative: settings => browser.configure(settings),
      pickDownloadDirectory: () => ctx.workspaces.pickDirectory(),
      clearData: scope => browser.clearData(scope),
      ...(openUrl === undefined ? {} : { openUrl: (url: string) => openUrl(url) }),
      history: () => browser.history(),
      removeHistory: id => browser.removeHistory(id),
      downloads: () => browser.downloads(),
      removeDownload: id => browser.removeDownload(id),
      ...(openDownload === undefined ? {} : { openDownload: (id: string) => openDownload(id) }),
      sites: () => browser.sites(),
      setSite: site => browser.setSite(site),
      removeSite: origin => browser.removeSite(origin),
      autofillStatus: () => autofill?.autofillStatus() ?? Promise.resolve({ available: false }),
      logins: () => autofill?.autofillListLogins() ?? autofillUnavailable(),
      saveLogin: login => autofill?.autofillSaveLogin(login) ?? autofillUnavailable(),
      removeLogin: id => autofill?.autofillRemoveLogin(id) ?? autofillUnavailable(),
      contacts: () => autofill?.autofillListContacts() ?? autofillUnavailable(),
      getContact: id => autofill?.autofillGetContact(id) ?? autofillUnavailable(),
      saveContact: contact => autofill?.autofillSaveContact(contact) ?? autofillUnavailable(),
      removeContact: id => autofill?.autofillRemoveContact(id) ?? autofillUnavailable(),
      hooks: { snapshot: scope },
    })
    ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section',
      id: 'browser',
      order: 5,
      label: () => t('browser.nav'),
      locale: 'settings.browser',
      inject: injected,
      children: { 'settings.browser.item': { kind: 'list', scope: 'root' } },
    }, BrowserSection))
  }

  const layout = new LayoutController()
  ctx.effect(() => {
    const disposeService = ctx.reflect.provide('layout', layout)
    const disposeRegistration = ctx.slots.register({
      name: 'root',
      children: {
        'sidebar': { kind: 'single', scope: 'root' },
        'conversation': { kind: 'single', scope: 'session-maybe' },
        'details': { kind: 'single', scope: 'session' },
        'review': { kind: 'single', scope: 'session' },
        'shell.overlay': { kind: 'list', scope: 'root' },
      },
      // Exclusive store: the factory itself — the framework instantiates per
      // entry and delivers useStore/actions to AppFrame as standard props.
      store: createLayoutStore,
      // The hook's only side effect connects the root store to ctx.layout;
      // conversation business actions belong to their registrants.
      inject: (actions: PanelActions) => {
        layout.attachPanels(actions)
        return {
          hooks: { desktopPreferences: desktopScope },
          startSession: () => { ctx.workspaces.startSession() },
          openFolder: async () => {
            const path = await ctx.workspaces.pickDirectory()
            if (path === null) return
            const workspace = await ctx.workspaces.create({ path })
            ctx.workspaces.startSession(workspace.workspaceId)
          },
          createSideSession: async () => {
            const sessions = ctx.sessions.list.getSnapshot()
            const workspaces = ctx.workspaces.list.getSnapshot()
            const current = sessions.current === undefined ? undefined : sessions.byId[sessions.current]
            const currentWorkspace = current === undefined
              ? undefined
              : workspaces.items.find(item => item.kind !== 'task' && item.sessionIds.includes(current.id))
            if (currentWorkspace !== undefined) {
              return await ctx.sessions.create({ workspaceId: currentWorkspace.workspaceId })
            }
            if (current !== undefined) return await ctx.sessions.create({ projectless: true })
            const recent = workspaces.items.find(item => item.kind !== 'task' && item.workspaceId === workspaces.recentWorkspaceId)
            if (recent !== undefined) return await ctx.sessions.create({ workspaceId: recent.workspaceId })
            return await ctx.sessions.create({ projectless: true })
          },
        }
      },
    }, AppFrame)
    return () => {
      disposeRegistration()
      // provide()'s disposer settles asynchronously; teardown is synchronous fire-and-forget.
      void disposeService()
    }
  }, 'ui-layout: service + root registration')

  // Theme presentation: pure DOM writes from resolved snapshots — initial
  // state through the getter once, then event-driven only; no React path.
  ctx.effect(() => {
    const presenter = new ThemePresenter()
    presenter.apply(ctx.theme.getTheme())
    const off = ctx.on('theme/change', (snapshot) => { presenter.apply(snapshot) })
    return () => {
      off()
      presenter.dispose()
    }
  }, 'ui-layout: theme presenter')
}

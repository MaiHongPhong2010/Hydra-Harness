/** Desktop tab host for workspace tools and per-workspace bottom terminals. */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import type { SessionId, WorkspaceId } from '@hydraharness/harness-client-runtime/client'
import {
  IconApiOutline14,
  IconChecklistOutline14,
  IconCloseOutline16,
  IconFolderOpenOutline16,
  IconGlobeOutline14,
  IconNewChatOutline16,
} from '@hydraharness/harness-client-ui-primitives'
import { DesktopFilesPanel, type DesktopFilesApi } from './DesktopFilesPanel.tsx'
import { DesktopTerminalPanel } from './DesktopTerminalPanel.tsx'
import css from './DesktopBrowserPanel.module.css'

interface DesktopBrowserBounds {
  x: number
  y: number
  width: number
  height: number
  visible: boolean
  /** False once the panel holds no Browser tab, so the controller re-reveals it for the next agent action. */
  present: boolean
}

/** User policy applied by the native browser controller. */
export type BrowserPolicy = 'allow' | 'ask' | 'block'

/** Portion of the in-app browser data that Settings can clear. */
export type BrowserClearDataScope = 'all' | 'history' | 'site-data' | 'cache' | 'downloads'

/** Where a user-opened URL leaves the desktop application. */
export type BrowserDestination = 'hydra' | 'system'

/** Whether a browser annotation carries a bounded element screenshot. */
export type BrowserAnnotationScreenshots = 'include' | 'ask' | 'never'

/** Settings the desktop controller can enforce without the Host action gate. */
export interface BrowserNativeSettings {
  webDestination: BrowserDestination
  localDestination: BrowserDestination
  annotationScreenshots: BrowserAnnotationScreenshots
  downloadDirectory: string
  askWhereToSave: boolean
  navigationPolicy: BrowserPolicy
  downloadPolicy: BrowserPolicy
  uploadPolicy: BrowserPolicy
  fullCdpAccess: boolean
}

/** Effective native capabilities returned after Browser settings are applied. */
export interface BrowserNativeCapabilities {
  fullCdpAccessAllowed: boolean
}

/** One navigation record returned by the desktop browser. */
export interface BrowserHistoryEntry {
  id: string
  url: string
  title: string
  visitedAt: string
}

/** One download record returned by the desktop browser. */
export interface BrowserDownloadEntry {
  id: string
  url: string
  filename: string
  path: string
  state: string
  startedAt: string
  endedAt?: string | undefined
}

/** One browser-owned permission override, keyed by its canonical origin. */
export interface BrowserSitePermission {
  origin: string
  access: 'allow' | 'block'
  media: 'allow' | 'block'
}

/** Whether encrypted desktop autofill storage is usable. */
export interface BrowserAutofillStatus {
  available: boolean
  reason?: string | undefined
}

/** Password-free metadata shown by the login manager. */
export interface BrowserLoginMetadata {
  id: string
  origin: string
  username: string
  createdAt: string
  updatedAt: string
}

/** Login mutation accepted by the encrypted vault. */
export interface BrowserLoginInput {
  id?: string | undefined
  origin: string
  username: string
  /** Required for new records; omitted on edit to preserve the current secret. */
  password?: string | undefined
}

/** Exact contact field allowlist accepted by the encrypted vault. */
export interface BrowserContactFields {
  name?: string | undefined
  givenName?: string | undefined
  additionalName?: string | undefined
  familyName?: string | undefined
  organization?: string | undefined
  email?: string | undefined
  tel?: string | undefined
  addressLine1?: string | undefined
  addressLine2?: string | undefined
  city?: string | undefined
  region?: string | undefined
  postalCode?: string | undefined
  countryCode?: string | undefined
}

/** Metadata returned when contacts are listed. */
export interface BrowserContactMetadata {
  id: string
  label: string
  createdAt: string
  updatedAt: string
}

/** One contact returned only to the built-in management UI. */
export interface BrowserContact extends BrowserContactMetadata {
  fields: BrowserContactFields
}

/** Contact mutation accepted by the encrypted vault. */
export interface BrowserContactInput {
  id?: string | undefined
  label: string
  fields: BrowserContactFields
}

/** Resolved app colors used by the native browser chrome. */
export interface DesktopBrowserTheme {
  colorScheme: 'light' | 'dark'
  colors: {
    shell: string
    tabstrip: string
    surface: string
    text: string
    muted: string
    hover: string
    border: string
    accent: string
    accentText: string
    omnibox: string
    status: string
  }
}

export interface DesktopBrowserApi {
  setBounds(bounds: DesktopBrowserBounds): void
  emitAnnotation?(annotation: unknown): void
  onAnnotation?(listener: (annotation: unknown) => void): () => void
  /**
   * Apply the renderer's resolved palette to native browser chrome.
   * @param theme - Resolved app colors, or null to restore the OS palette.
   */
  setTheme?(theme: DesktopBrowserTheme | null): void
  /** Optional only so layout-only tests and an older preload can expose bounds without claiming management support. */
  configure?(settings: BrowserNativeSettings): Promise<BrowserNativeCapabilities>
  /** Show the native risk confirmation required before enabling Full CDP. */
  confirmFullCdpAccess?(): Promise<boolean>
  clearData?(scope: BrowserClearDataScope): Promise<void>
  openUrl?(url: string): Promise<void>
  history?(): Promise<BrowserHistoryEntry[]>
  removeHistory?(id: string): Promise<void>
  downloads?(): Promise<BrowserDownloadEntry[]>
  removeDownload?(id: string): Promise<void>
  openDownload?(id: string): Promise<void>
  sites?(): Promise<BrowserSitePermission[]>
  setSite?(site: BrowserSitePermission): Promise<void>
  removeSite?(origin: string): Promise<void>
  autofillStatus?(): Promise<BrowserAutofillStatus>
  autofillListLogins?(): Promise<BrowserLoginMetadata[]>
  autofillSaveLogin?(login: BrowserLoginInput): Promise<BrowserLoginMetadata>
  autofillRemoveLogin?(id: string): Promise<boolean>
  autofillListContacts?(): Promise<BrowserContactMetadata[]>
  autofillGetContact?(id: string): Promise<BrowserContact | null>
  autofillSaveContact?(contact: BrowserContactInput): Promise<BrowserContactMetadata>
  autofillRemoveContact?(id: string): Promise<boolean>
}

export type DesktopTerminalEvent =
  | { type: 'data'; data: string }
  | { type: 'exit'; code: number | null }

/** Terminal placement and creation ordinal, validated by the native IPC handlers. */
export type DesktopTerminalId =
  | 'bottom'
  | 'right'
  | `${'bottom' | 'right' | 'term'}-${number}`
  | `${'bottom' | 'right' | 'term'}-${number}-${number}`
  | `bottom-${number}-${number}-${number}`

export interface DesktopTerminalApi {
  /**
   * Start in the registered workspace root, or reattach to the same workspace's live PTY.
   * @param terminalId - Independent terminal instance.
   * @param size - Initial or updated character dimensions.
   * @param workspaceId - Owning workspace; omitted for a workspace-free terminal in the desktop launch directory.
   * @returns Running state; rejects an unavailable workspace or a different owner for a live terminal.
   */
  start(terminalId: DesktopTerminalId, size: { cols: number; rows: number }, workspaceId?: WorkspaceId,
    cwd?: string): Promise<{ running: boolean }>
  /**
   * Stop the terminal and wait for its process to exit.
   * @param terminalId - Independent terminal instance.
   * @returns Resolves for an exited or absent terminal; rejects when termination fails.
   */
  stop(terminalId: DesktopTerminalId): Promise<void>
  write(terminalId: DesktopTerminalId, data: string): void
  resize(terminalId: DesktopTerminalId, size: { cols: number; rows: number }): void
  list?(): Promise<Array<{ id: DesktopTerminalId; pid?: number; shell: string }>>
  onEvent(terminalId: DesktopTerminalId, listener: (event: DesktopTerminalEvent) => void): () => void
}

export type DesktopPanelShortcut = RightPanelKind

export interface DesktopPanelApi {
  open?(kind: DesktopPanelShortcut): Promise<void>
  onShortcut(listener: (shortcut: DesktopPanelShortcut) => void): () => void
  /** The native browser closed itself, as when the user closes its last tab. */
  onClose(listener: (kind: DesktopPanelShortcut) => void): () => void
}

export interface DesktopChromeApi {
  dispatch(action: 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'delete' | 'select-all' | 'zoom-in' | 'zoom-out' | 'reset-zoom' | 'toggle-fullscreen' | 'close' | 'quit'): Promise<void>
  setTheme?(theme: { color: string; symbolColor: string } | null): void
}

declare global {
  interface Window {
    hydraDesktop?: {
      browser: DesktopBrowserApi
      terminal?: DesktopTerminalApi
      files?: DesktopFilesApi
      panels?: DesktopPanelApi
      chrome?: DesktopChromeApi
      preferences?: import('./desktop-preferences.ts').NativePreferencesApi
    }
  }
}

type RightPanelKind = 'files' | 'side-chat' | 'browser' | 'terminal' | 'review'

type RightPanelTab = {
  id: string
  label: string
} & ({
  kind: 'terminal'
  number: number
  terminalId: DesktopTerminalId
  workspaceId: WorkspaceId | undefined
  cwd?: string | undefined
} | {
  kind: Exclude<RightPanelKind, 'terminal'>
  sessionId?: SessionId | undefined
})

const INITIAL_TAB: RightPanelTab = { id: 'browser', kind: 'browser', label: 'Browser' }

const PANEL_OPTIONS = [
  { kind: 'files', label: 'Files', icon: <IconFolderOpenOutline16 size={16} />, description: 'Browse and edit workspace files.', shortcut: 'Control+P', shortcutLabel: 'Ctrl+P' },
  { kind: 'side-chat', label: 'Side chat', icon: <IconNewChatOutline16 size={16} />, description: 'Start a separate conversation.', shortcut: 'Control+Alt+S', shortcutLabel: 'Ctrl+Alt+S' },
  { kind: 'browser', label: 'Browser', icon: <IconGlobeOutline14 size={16} />, description: 'Browse alongside your agent.', shortcut: 'Control+Shift+B', shortcutLabel: 'Ctrl+Shift+B' },
  { kind: 'terminal', label: 'Terminal', icon: <IconApiOutline14 size={16} />, description: 'Run commands in a terminal.', shortcut: 'Control+Backquote', shortcutLabel: 'Ctrl+`' },
  { kind: 'review', label: 'Review', icon: <IconChecklistOutline14 size={16} />, description: 'Inspect and undo agent file changes.' },
] as const

/** Every panel kind, always visible: opening one is a single click. */
function PanelOptions(props: {
  activeKind?: RightPanelKind | undefined
  creating: boolean
  cards?: boolean
  terminalOnly?: boolean
  onSelect: (kind: RightPanelKind) => void
}) {
  return (
    <div className={props.cards ? css.optionCards : css.options} role="group" aria-label="Open panel">
      {PANEL_OPTIONS.filter(option => !props.terminalOnly || option.kind === 'terminal').map(option => (
        <button
          key={option.kind}
          type="button"
          className={css.option}
          aria-label={option.label}
          aria-keyshortcuts={'shortcut' in option ? option.shortcut : undefined}
          aria-pressed={option.kind === 'side-chat' || props.cards ? undefined : props.activeKind === option.kind}
          aria-busy={option.kind === 'side-chat' && props.creating ? true : undefined}
          data-active={props.activeKind === option.kind || undefined}
          title={'shortcutLabel' in option ? `${option.label} (${option.shortcutLabel})` : option.label}
          disabled={option.kind === 'side-chat' && props.creating}
          onClick={() => { props.onSelect(option.kind) }}
        >
          <span aria-hidden="true" className={css.optionIcon}>{option.icon}</span>
          <span className={css.optionText}>{option.label}</span>
          {props.cards && <span className={css.optionDescription}>{option.description}</span>}
          {props.cards && 'shortcutLabel' in option && <kbd>{option.shortcutLabel}</kbd>}
        </button>
      ))}
    </div>
  )
}

function IconButton(props: {
  label: string
  active: boolean
  children: ReactNode
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className={css.iconButton}
      aria-label={props.label}
      aria-pressed={props.active}
      title={props.label}
      data-active={props.active || undefined}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  )
}

function PanelIcon({ panel }: { panel: 'expanded' | 'bottom' | 'right' }) {
  if (panel === 'expanded') {
    return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 6V3h3M10 3h3v3M13 10v3h-3M6 13H3v-3" /></svg>
  }
  if (panel === 'bottom') {
    return <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="3" width="11" height="10" rx="1.5" /><path d="M3 9.5h10" /></svg>
  }
  return <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="3" width="11" height="10" rx="1.5" /><path d="M9 3v10" /></svg>
}

/** Always-visible desktop layout controls; right panel and bottom Terminal stay independent. */
export function DesktopPanelControls(props: {
  browserOpen: boolean
  terminalOpen: boolean
  browserExpanded: boolean
  bottomControl?: boolean
  onToggleBrowser: () => void
  onToggleTerminal: () => void
  onToggleExpanded: () => void
}) {
  return (
    <div className={css.panelControls} aria-label="Desktop panels">
      <IconButton label="Expand right panel" active={props.browserExpanded} onClick={props.onToggleExpanded}>
        <PanelIcon panel="expanded" />
      </IconButton>
      {props.bottomControl !== false && <IconButton label="Toggle bottom terminal" active={props.terminalOpen} onClick={props.onToggleTerminal}>
        <PanelIcon panel="bottom" />
      </IconButton>}
      <IconButton label="Toggle right panel" active={props.browserOpen} onClick={props.onToggleBrowser}>
        <PanelIcon panel="right" />
      </IconButton>
    </div>
  )
}

/** Shared tab lifecycle for right workspace tools and bottom terminal groups. */
export function DesktopBrowserPanel(props: {
  open: boolean
  workspaceId?: WorkspaceId | undefined
  sessionTitle?: string | undefined
  onOpen: () => void
  fullView?: boolean | undefined
  mainSessionId?: SessionId | undefined
  renderMainChat?: (() => ReactNode) | undefined
  terminalLocation?: 'bottom' | 'right' | undefined
  onBottomTerminal?: ((cwd?: string) => void) | undefined
  terminalRequest?: { sequence: number; cwd?: string | undefined } | undefined
  fileDestination?: 'editor' | 'terminal' | 'system' | undefined
} & ({
  /** Stable bottom workspace ordinal; each terminal tab has its own ordinal within it. */
  terminalGroup: number
} | {
  terminalGroup?: undefined
  createSideSession: () => Promise<SessionId>
  renderSideChat: (sessionId: SessionId) => ReactNode
  renderReview: () => ReactNode
})) {
  const { onOpen, terminalGroup } = props
  const createSideSession = terminalGroup === undefined ? props.createSideSession : undefined
  const api = terminalGroup === undefined ? window.hydraDesktop?.browser : undefined
  const panelKey = terminalGroup === undefined ? 'right' : `bottom-${terminalGroup}`
  const panelRef = useRef<HTMLElement | null>(null)
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const sideChatNumber = useRef(0)
  const terminalNumber = useRef(terminalGroup === undefined ? 1 : 2)
  const [{ tabs, activeId }, setPanel] = useState<{ tabs: RightPanelTab[]; activeId: string }>(() => {
    const first: RightPanelTab = terminalGroup === undefined ? INITIAL_TAB : {
      id: 'terminal', kind: 'terminal', label: 'Terminal', number: 1,
      terminalId: `bottom-${terminalGroup}-1`, workspaceId: props.workspaceId, cwd: props.terminalRequest?.cwd,
    }
    return { tabs: [first], activeId: first.id }
  })
  const [creating, setCreating] = useState(false)
  const [closingTerminals, setClosingTerminals] = useState<ReadonlySet<DesktopTerminalId>>(new Set())
  const terminalClosePending = useRef(new Set<DesktopTerminalId>())
  const [panelError, setPanelError] = useState<string>()
  const [filesFocus, setFilesFocus] = useState(0)
  const [filesDirty, setFilesDirty] = useState(false)
  const [filesSaving, setFilesSaving] = useState(false)
  const [filesWorkspaceId, setFilesWorkspaceId] = useState(props.workspaceId)
  const activeTab = tabs.find(tab => tab.id === activeId)
  const selectionRevision = useRef(0)
  const creatingRef = useRef(false)
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([])
  const focusTabAfterClose = useRef(false)
  const browserPresent = tabs.some(tab => tab.kind === 'browser')

  const selectTab = useCallback((id: string) => {
    selectionRevision.current += 1
    setPanel(current => ({ ...current, activeId: id }))
    setPanelError(undefined)
  }, [])

  useEffect(() => {
    if (filesWorkspaceId === props.workspaceId || filesSaving) return
    if (filesDirty && !window.confirm('Discard unsaved file changes and switch Workspace?')) return
    setFilesWorkspaceId(props.workspaceId)
  }, [filesDirty, filesSaving, filesWorkspaceId, props.workspaceId])

  const selectPanel = useCallback((kind: RightPanelKind, cwd?: string) => {
    if (kind === 'terminal' && terminalGroup === undefined && props.terminalLocation === 'bottom' && props.onBottomTerminal !== undefined) {
      props.onBottomTerminal(cwd)
      return
    }
    if (kind === 'side-chat' && creatingRef.current) return
    onOpen()
    setPanelError(undefined)
    const revision = ++selectionRevision.current
    if (kind === 'files') setFilesFocus(current => current + 1)
    if (kind === 'side-chat') {
      if (createSideSession === undefined) return
      creatingRef.current = true
      setCreating(true)
      void createSideSession().then((sessionId) => {
        sideChatNumber.current += 1
        const number = sideChatNumber.current
        const tab: RightPanelTab = {
          id: `side-chat:${sessionId}`,
          kind,
          label: number === 1 ? 'Side chat' : `Side chat ${number}`,
          sessionId,
        }
        const selectCreated = selectionRevision.current === revision
        setPanel(current => ({
          tabs: [...current.tabs, tab],
          activeId: selectCreated ? tab.id : current.activeId,
        }))
      }).catch((reason: unknown) => {
        setPanelError(String(reason))
      }).finally(() => {
        creatingRef.current = false
        setCreating(false)
      })
      return
    }
    if (kind === 'terminal') {
      const ordinal = terminalNumber.current++
      setPanel((current) => {
        const usedNumbers = new Set(current.tabs.flatMap(tab => tab.kind === 'terminal' ? [tab.number] : []))
        let number = 1
        while (usedNumbers.has(number)) number += 1
        const tab: RightPanelTab = {
          id: ordinal === 1 ? 'terminal' : `terminal:${ordinal}`,
          kind,
          number,
          label: number === 1 ? 'Terminal' : `Terminal ${number}`,
          terminalId: terminalGroup === undefined
            ? ordinal === 1 ? 'right' : `right-${ordinal}`
            : `bottom-${terminalGroup}-${ordinal}`,
          workspaceId: props.workspaceId,
          cwd,
        }
        return { tabs: [...current.tabs, tab], activeId: tab.id }
      })
      return
    }
    setPanel(current => ({
      tabs: current.tabs.some(tab => tab.kind === kind) ? current.tabs
        : [...current.tabs, { id: kind, kind, label: kind.charAt(0).toUpperCase() + kind.slice(1) }],
      activeId: kind,
    }))
  }, [createSideSession, onOpen, props.workspaceId, terminalGroup, props.terminalLocation, props.onBottomTerminal])
  const terminalRequest = useRef(props.terminalRequest?.sequence)
  useEffect(() => {
    const request = props.terminalRequest
    if (request === undefined || request.sequence === terminalRequest.current || terminalGroup === undefined) return
    terminalRequest.current = request.sequence
    selectPanel('terminal', request.cwd)
  }, [props.terminalRequest, selectPanel, terminalGroup])

  useEffect(() => {
    const sessionId = props.mainSessionId
    if (sessionId === undefined || terminalGroup !== undefined) return
    const id = `chat:${sessionId}`
    setPanel(current => ({ tabs: current.tabs.some(tab => tab.id === id) ? current.tabs.map(tab => tab.id === id ? { ...tab, label: props.sessionTitle ?? 'Chat' } : tab)
      : [...current.tabs, { id, kind: 'side-chat', sessionId, label: props.sessionTitle ?? 'Chat' }],
    activeId: current.tabs.some(tab => tab.id === id) ? current.activeId : id }))
  }, [props.mainSessionId, props.sessionTitle, terminalGroup])

  useEffect(() => terminalGroup === undefined ? window.hydraDesktop?.panels?.onShortcut((shortcut) => {
    if (shortcut === 'terminal' && props.terminalLocation === 'bottom' && props.onBottomTerminal !== undefined) props.onBottomTerminal()
    else selectPanel(shortcut)
  }) : undefined, [selectPanel, terminalGroup, props.terminalLocation, props.onBottomTerminal])

  // Closing the active tab unmounts the control holding focus; the tab that
  // takes over receives it instead of the document body.
  useEffect(() => {
    if (!focusTabAfterClose.current) return
    focusTabAfterClose.current = false
    const index = tabs.findIndex(tab => tab.id === activeId)
    const target = tabRefs.current[index] ?? panelRef.current?.querySelector<HTMLButtonElement>('[aria-label="Open panel"] button')
    target?.focus()
  }, [activeId, tabs])

  const removeTab = (id: string) => {
    selectionRevision.current += 1
    const focused = document.activeElement
    focusTabAfterClose.current = focused !== null && panelRef.current?.contains(focused) === true
      && (focused.closest('[data-panel-tab]')?.getAttribute('data-panel-tab') === id
        || focused.closest('[role="tabpanel"]')?.id === `hydra-${panelKey}-panel-surface-${id}`)
    setPanel((current) => {
      const index = current.tabs.findIndex(tab => tab.id === id)
      if (index === -1) return current
      const remaining = current.tabs.filter(tab => tab.id !== id)
      return {
        tabs: remaining,
        activeId: current.activeId === id ? remaining[Math.min(index, remaining.length - 1)]?.id ?? '' : current.activeId,
      }
    })
  }

  const closeTab = async (id: string) => {
    if (id === `chat:${props.mainSessionId ?? ''}`) return
    if (id === 'files' && filesSaving) return
    if (id === 'files' && filesDirty && !window.confirm('Discard unsaved file changes?')) return
    const closingTab = tabs.find(tab => tab.id === id)
    if (closingTab === undefined) return
    if (closingTab.kind === 'terminal' && window.hydraDesktop?.terminal !== undefined) {
      const terminalId = closingTab.terminalId
      if (terminalClosePending.current.has(terminalId)) return
      terminalClosePending.current.add(terminalId)
      setClosingTerminals(new Set(terminalClosePending.current))
      try {
        await window.hydraDesktop.terminal.stop(terminalId)
      } catch (reason: unknown) {
        setPanelError(`Could not close ${closingTab.label}: ${String(reason)}`)
        return
      } finally {
        terminalClosePending.current.delete(terminalId)
        setClosingTerminals(new Set(terminalClosePending.current))
      }
    }
    removeTab(id)
  }

  // The native browser closes its own panel when the user closes its last tab.
  const closePanel = useRef(closeTab)
  useEffect(() => { closePanel.current = closeTab })
  useEffect(() => terminalGroup === undefined ? window.hydraDesktop?.panels?.onClose((kind) => {
    if (kind === 'browser') void closePanel.current('browser')
  }) : undefined, [terminalGroup])

  // Roving tabindex: the selected tab is the strip's one tab stop, and the
  // arrow keys move both the selection and focus (wraparound, Home/End jump).
  const moveTab = (event: ReactKeyboardEvent, index: number) => {
    const last = tabs.length - 1
    let next: number
    switch (event.key) {
      case 'Delete':
        event.preventDefault()
        void closeTab((tabs[index] as RightPanelTab).id)
        return
      case 'ArrowRight': next = index === last ? 0 : index + 1; break
      case 'ArrowLeft': next = index === 0 ? last : index - 1; break
      case 'Home': next = 0; break
      case 'End': next = last; break
      default: return
    }
    event.preventDefault()
    const tab = tabs[next] as RightPanelTab
    selectTab(tab.id)
    const target = tabRefs.current[next] as HTMLButtonElement | null
    target?.focus()
  }

  useEffect(() => {
    if (!props.open) return
    const tab = tabRefs.current[tabs.findIndex(item => item.id === activeId)]
    if (typeof tab?.scrollIntoView === 'function') tab.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeId, tabs, props.open])

  useLayoutEffect(() => {
    if (api === undefined) return
    const viewport = viewportRef.current
    if (viewport === null || !props.open || activeTab?.kind !== 'browser') {
      api.setBounds({ x: 0, y: 0, width: 0, height: 0, visible: false, present: browserPresent })
      return
    }
    let frame: number | undefined
    let coveredByModal = document.querySelector('[role="dialog"][aria-modal="true"]') !== null
    const report = () => {
      frame = undefined
      const rect = viewport.getBoundingClientRect()
      api.setBounds({
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.max(0, Math.round(rect.width)),
        height: Math.max(0, Math.round(rect.height)),
        visible: props.open && !coveredByModal && rect.width > 0 && rect.height > 0,
        present: browserPresent,
      })
    }
    const schedule = () => { frame ??= requestAnimationFrame(report) }
    const observer = new ResizeObserver(schedule)
    const modalObserver = new MutationObserver(() => {
      const next = document.querySelector('[role="dialog"][aria-modal="true"]') !== null
      if (next === coveredByModal) return
      coveredByModal = next
      report()
    })
    observer.observe(viewport)
    modalObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ['aria-modal', 'role'],
      childList: true,
      subtree: true,
    })
    const visualViewport = window.visualViewport
    window.addEventListener('resize', schedule)
    visualViewport?.addEventListener('resize', schedule)
    visualViewport?.addEventListener('scroll', schedule)
    schedule()
    return () => {
      observer.disconnect()
      modalObserver.disconnect()
      window.removeEventListener('resize', schedule)
      visualViewport?.removeEventListener('resize', schedule)
      visualViewport?.removeEventListener('scroll', schedule)
      if (frame !== undefined) cancelAnimationFrame(frame)
      api.setBounds({ x: 0, y: 0, width: 0, height: 0, visible: false, present: browserPresent })
    }
  }, [activeTab?.kind, api, browserPresent, props.open])

  return (
    <section
      ref={panelRef}
      className={css.panel}
      aria-label={terminalGroup === undefined ? 'Right panel' : 'Terminal'}
      data-desktop-panel={terminalGroup === undefined ? 'browser' : 'terminal'}
      hidden={!props.open}
    >
      <header className={css.header}>
        {terminalGroup === undefined && <div className={css.optionHeader}>
          {tabs.length > 0
            ? <PanelOptions activeKind={activeTab?.kind} creating={creating} onSelect={selectPanel} />
            : <span className={css.optionLabel}>Side panel</span>}
        </div>}
        {tabs.length > 0 && <div className={css.tabs} role="tablist" aria-label={terminalGroup === undefined ? 'Right panel tabs' : 'Bottom terminal tabs'}>
          {tabs.map((tab, index) => (
            <div className={css.tab} data-panel-tab={tab.id} data-active={tab.id === activeId || undefined} key={tab.id}>
              <button
                ref={(element) => { tabRefs.current[index] = element }}
                id={`hydra-${panelKey}-panel-tab-${tab.id}`}
                type="button"
                className={css.tabSelect}
                role="tab"
                aria-selected={tab.id === activeId}
                aria-description={tab.kind === 'files' && filesDirty ? 'Unsaved changes' : undefined}
                aria-controls={`hydra-${panelKey}-panel-surface-${tab.id}`}
                tabIndex={tab.id === activeId ? 0 : -1}
                title={tab.label}
                onClick={() => { selectTab(tab.id) }}
                onKeyDown={(event) => { moveTab(event, index) }}
              >
                {tab.kind === 'files' && <IconFolderOpenOutline16 size={13} />}
                {tab.kind === 'side-chat' && <IconNewChatOutline16 size={13} />}
                {tab.kind === 'browser' && <IconGlobeOutline14 size={13} />}
                {tab.kind === 'terminal' && <IconApiOutline14 size={13} />}
                {tab.kind === 'review' && <IconChecklistOutline14 size={13} />}
                <span>{tab.label}</span>
                {tab.kind === 'files' && filesDirty && <span className={css.dirtyMark} aria-hidden="true">●</span>}
              </button>
              <button
                type="button"
                className={css.tabClose}
                aria-label={`Close ${tab.label}`}
                title={`Close ${tab.label} (Delete)`}
                disabled={tab.id === `chat:${props.mainSessionId ?? ''}` || (tab.kind === 'files' && filesSaving) || (tab.kind === 'terminal' && closingTerminals.has(tab.terminalId))}
                onClick={() => { void closeTab(tab.id) }}
              >
                <IconCloseOutline16 size={12} />
              </button>
            </div>
          ))}
        </div>}
        {creating && <div className={css.panelStatus} role="status">Creating side chat…</div>}
        {panelError !== undefined && <div className={css.panelError}>
          <span role="alert">{panelError}</span>
          <button type="button" className={css.tabClose} aria-label="Dismiss panel error" onClick={() => { setPanelError(undefined) }}><IconCloseOutline16 size={14} /></button>
        </div>}
      </header>
      <div className={css.panelBody}>
        {tabs.map(tab => (
          <div
            className={css.surface}
            id={`hydra-${panelKey}-panel-surface-${tab.id}`}
            role="tabpanel"
            aria-labelledby={`hydra-${panelKey}-panel-tab-${tab.id}`}
            hidden={tab.id !== activeId}
            data-panel-kind={tab.kind}
            key={tab.id}
          >
            {tab.kind === 'browser' && <div ref={viewportRef} className={css.viewport} aria-label="Browser page" />}
            {tab.kind === 'files' && (
              <DesktopFilesPanel
                key={filesWorkspaceId ?? 'no-workspace'}
                workspaceId={filesWorkspaceId}
                active={props.open && tab.id === activeId}
                focusSearch={filesFocus}
                onDirtyChange={setFilesDirty}
                onSavingChange={setFilesSaving}
                destination={props.fileDestination}
                onOpenTerminal={(cwd) => { selectPanel('terminal', cwd) }}
              />
            )}
            {tab.kind === 'side-chat' && tab.sessionId !== undefined && props.terminalGroup === undefined && (
              <div className={css.sideChat}>{tab.sessionId === props.mainSessionId && props.renderMainChat !== undefined
                ? props.renderMainChat() : props.renderSideChat(tab.sessionId)}</div>
            )}
            {tab.kind === 'terminal' && <DesktopTerminalPanel
              open={props.open && tab.id === activeId && !closingTerminals.has(tab.terminalId)}
              terminalId={tab.terminalId}
              workspaceId={tab.workspaceId}
              cwd={tab.cwd}
              terminalLabel={tab.label.replace('Terminal', terminalGroup === undefined ? 'Right terminal' : 'Bottom terminal')}
              sessionTitle={props.sessionTitle}
              onNewTerminal={() => { selectPanel('terminal') }}
              onEmpty={() => { removeTab(tab.id) }}
              embedded
            />}
            {tab.kind === 'review' && props.terminalGroup === undefined && props.renderReview()}
          </div>
        ))}
        {tabs.length === 0 && (
          <div className={css.emptyPanel}>
            <strong>Choose a panel</strong>
            <span>No panel is open.</span>
            <PanelOptions
              cards terminalOnly={terminalGroup !== undefined}
              activeKind={activeTab?.kind} creating={creating} onSelect={selectPanel}
            />
          </div>
        )}
      </div>
    </section>
  )
}

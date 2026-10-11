/** Desktop-only interactive terminal backed by the Electron preload bridge. */
import { useCallback, useEffect, useRef, useState } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import type { WorkspaceId } from '@hydraharness/harness-client-runtime/client'
import {
  IconChevronDownOutline14,
  IconChevronRightOutline14,
  IconPlusOutline16,
  IconTrashOutline16,
} from '@hydraharness/harness-client-ui-primitives'
import type { DesktopTerminalId } from './DesktopBrowserPanel.tsx'
import './xterm.css'
import css from './DesktopTerminalPanel.module.css'

function terminalTheme(element: HTMLElement) {
  const style = getComputedStyle(element)
  return {
    background: style.getPropertyValue('--dsw-alias-bg-base').trim(),
    foreground: style.getPropertyValue('--dsw-alias-label-primary').trim(),
    cursor: style.getPropertyValue('--dsw-alias-state-business-primary').trim(),
    selectionBackground: style.getPropertyValue('--dsw-alias-interactive-bg-active').trim(),
  }
}

function terminalSize(terminal: Terminal) {
  return { cols: Math.max(2, terminal.cols), rows: Math.max(1, terminal.rows) }
}

function defaultShellName() {
  if (typeof navigator !== 'undefined' && /Win/i.test(navigator.userAgent || navigator.platform)) {
    return 'powershell.exe'
  }
  return 'bash'
}

function IconTerminalPrompt({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="11" rx="2" stroke="currentColor" strokeWidth="1.2" />
      <path d="M4.5 6L7 8L4.5 10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8.5 10.5H11.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

function IconSplitTerminal({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <rect x="2" y="2.5" width="5.5" height="11" rx="1" stroke="currentColor" strokeWidth="1.2" />
      <rect x="8.5" y="2.5" width="5.5" height="11" rx="1" stroke="currentColor" strokeWidth="1.2" />
      <path d="M12.5 10.5V13.5M11 12H14" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

function IconSidebarToggle({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <rect x="2" y="2.5" width="12" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
      <path d="M10.5 2.5V13.5" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  )
}

export type TerminalStatus = 'starting' | 'running' | 'exited' | 'error'

interface PaneStatus {
  status: TerminalStatus
  exitCode: number | null
  error?: string | undefined
}

interface QuoteSelectionData {
  paneId: DesktopTerminalId
  text: string
  x: number
  y: number
}

interface TerminalPaneItem {
  id: DesktopTerminalId
  name: string
}

/** Individual split terminal pane running an independent xterm instance. */
function SingleTerminalPane({
  id,
  workspaceId,
  cwd,
  open,
  name,
  active,
  onFocus,
  onStatusChange,
  onQuoteSelection,
  onTriggerQuote,
  restartCount,
}: {
  id: DesktopTerminalId
  workspaceId: WorkspaceId | undefined
  cwd?: string | undefined
  open: boolean
  name: string
  active: boolean
  onFocus: () => void
  onStatusChange: (id: DesktopTerminalId, status: PaneStatus) => void
  onQuoteSelection: (data: QuoteSelectionData | null) => void
  onTriggerQuote: (text: string, name: string) => void
  restartCount: number
}) {
  const api = window.hydraDesktop?.terminal
  const hostRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const mountedRef = useRef(true)
  const openRef = useRef(open)
  const activeRef = useRef(active)
  const startAttemptRef = useRef(0)
  const startingRef = useRef(false)
  openRef.current = open
  activeRef.current = active

  const start = useCallback(() => {
    const terminal = terminalRef.current
    const fit = fitRef.current
    if (api === undefined || terminal === null || fit === null || startingRef.current) return
    startingRef.current = true
    const attempt = ++startAttemptRef.current
    onStatusChange(id, { status: 'starting', exitCode: null })
    fit.fit()
    void api.start(id, terminalSize(terminal), workspaceId, cwd).then((state) => {
      if (!mountedRef.current || startAttemptRef.current !== attempt) return
      startingRef.current = false
      onStatusChange(id, { status: state.running ? 'running' : 'exited', exitCode: null })
      if (state.running && openRef.current && activeRef.current) terminal.focus()
    }).catch((error: unknown) => {
      if (!mountedRef.current || startAttemptRef.current !== attempt) return
      startingRef.current = false
      const message = `Terminal failed to start: ${String(error)}`
      onStatusChange(id, { status: 'error', exitCode: null, error: message })
      terminal.writeln(`\r\n${message}`)
    })
  }, [api, id, onStatusChange, workspaceId, cwd])

  useEffect(() => {
    if (active && openRef.current) {
      terminalRef.current?.focus()
    }
  }, [active])

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  useEffect(() => {
    const host = hostRef.current
    if (api === undefined || host === null) return
    const terminal = new Terminal({
      convertEol: false,
      cursorBlink: true,
      fontFamily: 'Cascadia Mono, SFMono-Regular, Consolas, Liberation Mono, monospace',
      fontSize: 12,
      screenReaderMode: true,
      scrollback: 5_000,
      theme: terminalTheme(host),
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(host)
    terminalRef.current = terminal
    fitRef.current = fit

    const themeObserver = new MutationObserver(() => {
      terminal.options.theme = terminalTheme(host)
    })
    themeObserver.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme', 'style'] })

    const data = terminal.onData((value) => { api.write(id, value) })
    const unsubscribe = api.onEvent(id, (event) => {
      if (!mountedRef.current || terminalRef.current !== terminal) return
      if (event.type === 'data') terminal.write(event.data)
      else {
        startAttemptRef.current += 1
        startingRef.current = false
        onStatusChange(id, { status: 'exited', exitCode: event.code })
      }
    })

    const checkSelection = () => {
      const selection = terminal.getSelection()
      if (!selection || !selection.trim()) {
        onQuoteSelection(null)
        return
      }
      const domSelection = window.getSelection()
      let x = 0
      let y = 0
      if (domSelection && domSelection.rangeCount > 0 && !domSelection.isCollapsed) {
        const range = domSelection.getRangeAt(0)
        const rect = range.getBoundingClientRect()
        const hostRect = host.getBoundingClientRect()
        if (rect.width > 0 && rect.height > 0) {
          x = Math.max(20, rect.left - hostRect.left + rect.width / 2)
          y = Math.max(10, rect.top - hostRect.top)
        }
      }
      if (x === 0 && y === 0) {
        const hostRect = host.getBoundingClientRect()
        x = hostRect.width / 2
        y = 30
      }
      onQuoteSelection({ paneId: id, text: selection, x, y })
    }

    const selectionDisposable = terminal.onSelectionChange(checkSelection)
    host.addEventListener('mouseup', checkSelection)

    terminal.attachCustomKeyEventHandler((e) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'l') {
        const selection = terminal.getSelection()
        if (selection && selection.trim()) {
          e.preventDefault()
          onTriggerQuote(selection, name)
          onQuoteSelection(null)
          return false
        }
      }
      return true
    })

    const observer = new ResizeObserver(() => {
      if (host.hidden || host.clientWidth === 0 || host.clientHeight === 0) return
      fit.fit()
      api.resize(id, terminalSize(terminal))
    })
    observer.observe(host)

    return () => {
      startAttemptRef.current += 1
      startingRef.current = false
      observer.disconnect()
      themeObserver.disconnect()
      selectionDisposable.dispose()
      host.removeEventListener('mouseup', checkSelection)
      unsubscribe()
      data.dispose()
      terminal.dispose()
      terminalRef.current = null
      fitRef.current = null
    }
  }, [api, id, name, onQuoteSelection, onStatusChange, onTriggerQuote])

  useEffect(() => {
    if (!open || api === undefined) return
    const frame = requestAnimationFrame(start)
    return () => { cancelAnimationFrame(frame) }
  }, [api, open, restartCount, start])

  return (
    <div
      ref={hostRef}
      className={css.terminal}
      aria-label="Terminal output"
      onClick={onFocus}
    />
  )
}

/** Interactive multi-pane terminal with text quote to chat and process management sidebar. */
export function DesktopTerminalPanel({
  open,
  terminalId = 'bottom',
  workspaceId,
  cwd,
  terminalLabel,
  sessionTitle,
  embedded = false,
  onQuote,
  onNewTerminal,
  onEmpty,
}: {
  open: boolean
  terminalId?: DesktopTerminalId
  workspaceId?: WorkspaceId | undefined
  cwd?: string | undefined
  terminalLabel?: string | undefined
  sessionTitle?: string | undefined
  embedded?: boolean
  onQuote?: (text: string) => void
  onNewTerminal: () => void
  /** Remove the tab after its last pane stops successfully. */
  onEmpty: () => void
}) {
  const isRight = !terminalId.startsWith('bottom')
  const api = window.hydraDesktop?.terminal
  const defaultShell = defaultShellName()

  const [panes, setPanes] = useState<TerminalPaneItem[]>([
    { id: terminalId, name: defaultShell },
  ])
  const [activePaneId, setActivePaneId] = useState<DesktopTerminalId>(terminalId)
  const [paneStatuses, setPaneStatuses] = useState<Record<string, PaneStatus>>({
    [terminalId]: { status: 'exited', exitCode: null },
  })
  const [restartCounts, setRestartCounts] = useState<Record<string, number>>({})
  const [showSidebar, setShowSidebar] = useState(true)
  const [conversationsExpanded, setConversationsExpanded] = useState(true)
  const [quotePopover, setQuotePopover] = useState<QuoteSelectionData | null>(null)
  const [stoppingPane, setStoppingPane] = useState<DesktopTerminalId>()
  const stopping = stoppingPane !== undefined
  const [stopError, setStopError] = useState<string>()

  const splitCounterRef = useRef(1)
  const panesRef = useRef(panes)
  panesRef.current = panes

  useEffect(() => {
    return () => {
      for (const pane of panesRef.current) {
        if (pane.id !== terminalId) {
          void api?.stop(pane.id)
        }
      }
    }
  }, [api, terminalId])

  const activeStatus = paneStatuses[activePaneId]?.status ?? 'exited'
  const activeExitCode = paneStatuses[activePaneId]?.exitCode ?? null
  const activeError = paneStatuses[activePaneId]?.error
  const running = activeStatus === 'running'

  const handleStatusChange = useCallback((id: DesktopTerminalId, status: PaneStatus) => {
    setPaneStatuses(prev => ({ ...prev, [id]: status }))
  }, [])

  const handleRestart = (id: DesktopTerminalId) => {
    setRestartCounts(prev => ({ ...prev, [id]: (prev[id] ?? 0) + 1 }))
  }

  const handleSplit = (sourceId: DesktopTerminalId) => {
    const nextIndex = ++splitCounterRef.current
    const base = terminalId === 'right' || terminalId === 'bottom' ? `${terminalId}-1` : terminalId
    const newId = `${base}-${nextIndex}` as DesktopTerminalId
    const newPane: TerminalPaneItem = { id: newId, name: defaultShell }
    setPanes(prev => [...prev, newPane])
    setActivePaneId(newId)
    void sourceId
  }

  const handleKill = async (id: DesktopTerminalId) => {
    if (api === undefined || stopping) return
    setStoppingPane(id)
    setStopError(undefined)
    try {
      await api.stop(id)
    } catch (reason: unknown) {
      setStopError(`Could not close terminal: ${String(reason)}`)
      return
    } finally {
      setStoppingPane(undefined)
    }
    const remaining = panesRef.current.filter(pane => pane.id !== id)
    panesRef.current = remaining
    setPanes(remaining)
    const nextPane = remaining[0]
    if (nextPane === undefined) onEmpty()
    else setActivePaneId(current => current === id ? nextPane.id : current)
  }

  const handleTriggerQuote = useCallback((text: string, processName: string) => {
    const annotation = {
      kind: 'browser-element',
      url: `terminal://${processName}`,
      title: `Terminal (${processName})`,
      preview: text,
    }
    const browserApi = window.hydraDesktop?.browser
    if (browserApi?.emitAnnotation) {
      browserApi.emitAnnotation(annotation)
    }
    window.dispatchEvent(new CustomEvent('hydra-desktop:browser-annotation', { detail: annotation }))
    onQuote?.(text)
    try { void navigator.clipboard.writeText(text) } catch {}
  }, [onQuote])

  const handleQuoteClick = () => {
    if (quotePopover) {
      const activePane = panes.find(p => p.id === quotePopover.paneId) ?? panes[0]
      handleTriggerQuote(quotePopover.text, activePane?.name ?? defaultShell)
      setQuotePopover(null)
    }
  }

  // Keyboard shortcut Ctrl+L when text is selected anywhere in terminal
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'l') {
        if (quotePopover && quotePopover.text) {
          e.preventDefault()
          handleQuoteClick()
        }
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => { window.removeEventListener('keydown', onKeyDown, true) }
  })

  const resolvedSessionTitle = sessionTitle || 'Sửa Lỗi Kỹ Thuật'

  return (
    <section
      className={css.panel}
      aria-label={terminalLabel ?? (isRight ? 'Right terminal' : 'Terminal')}
      data-desktop-panel={isRight ? 'right-terminal' : 'terminal'}
      data-embedded={embedded || undefined}
      aria-busy={activeStatus === 'starting' || undefined}
      hidden={!open}
    >
      <header className={css.header}>
        <div className={css.headerLeft}>
          <span className={css.title}>Terminals</span>
          <div className={css.projectDropdown}>
            <button
              type="button"
              className={css.projectButton}
              aria-label="Project profile"
            >
              <span>Project</span>
              <IconChevronDownOutline14 size={10} />
            </button>
          </div>
        </div>

        <div className={css.headerCenter}>
          <span className={css.status} data-running={running || undefined}>
            {api === undefined
              ? 'Unavailable'
              : activeStatus === 'starting'
                ? 'Starting…'
                : activeStatus === 'error'
                  ? 'Failed'
                  : running
                    ? 'Running'
                    : activeExitCode === null ? 'Exited' : `Exited (${activeExitCode})`}
          </span>
          {api !== undefined && !running && (
            <button
              type="button"
              className={css.restart}
              disabled={activeStatus === 'starting' || stopping}
              onClick={() => { handleRestart(activePaneId) }}
            >
              {activeStatus === 'starting' ? 'Starting…' : 'Restart'}
            </button>
          )}
        </div>

        <div className={css.headerRight}>
          <button
            type="button"
            className={css.headerIconButton}
            title="New Terminal"
            aria-label="New Terminal"
            onClick={onNewTerminal}
          >
            <IconPlusOutline16 size={14} />
          </button>
          <button
            type="button"
            className={css.headerIconButton}
            data-active={showSidebar || undefined}
            title="Toggle Sidebar"
            aria-label="Toggle Sidebar"
            onClick={() => { setShowSidebar(prev => !prev) }}
          >
            <IconSidebarToggle size={14} />
          </button>
        </div>
      </header>

      <div className={css.mainArea}>
        <div className={css.terminalPanes}>
          {panes.map(pane => (
            <div
              key={pane.id}
              className={css.splitPane}
              data-active={pane.id === activePaneId || undefined}
            >
              <SingleTerminalPane
                id={pane.id}
                workspaceId={workspaceId}
                cwd={cwd}
                open={open && stoppingPane !== pane.id}
                name={pane.name}
                active={pane.id === activePaneId}
                onFocus={() => { setActivePaneId(pane.id) }}
                onStatusChange={handleStatusChange}
                onQuoteSelection={setQuotePopover}
                onTriggerQuote={handleTriggerQuote}
                restartCount={restartCounts[pane.id] ?? 0}
              />
              {quotePopover && quotePopover.paneId === pane.id && (
                <div
                  className={css.quotePopover}
                  style={{ left: quotePopover.x, top: quotePopover.y }}
                >
                  <button
                    type="button"
                    className={css.quotePill}
                    title="Quote into chat session (Ctrl+L)"
                    aria-label="Quote Ctrl+L"
                    onClick={handleQuoteClick}
                  >
                    Quote <kbd className={css.quoteShortcut}>Ctrl+L</kbd>
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>

        {showSidebar && (
          <aside className={css.sidebar} aria-label="Terminal processes">
            <div
              className={css.sidebarHeader}
              role="button"
              tabIndex={0}
              onClick={() => { setConversationsExpanded(prev => !prev) }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') setConversationsExpanded(prev => !prev)
              }}
            >
              <span className={css.chevron}>
                {conversationsExpanded
                  ? <IconChevronDownOutline14 size={12} />
                  : <IconChevronRightOutline14 size={12} />}
              </span>
              <span className={css.conversationsTitle}>Conversations</span>
            </div>
            {conversationsExpanded && (
              <div className={css.conversationGroup}>
                <div className={css.sessionName} title={resolvedSessionTitle}>
                  {resolvedSessionTitle}
                </div>
                <div className={css.processList} role="list">
                  {panes.map((pane) => {
                    const isActive = pane.id === activePaneId
                    return (
                      <div
                        key={pane.id}
                        className={css.processItem}
                        data-active={isActive || undefined}
                        role="listitem"
                        tabIndex={0}
                        onClick={() => { setActivePaneId(pane.id) }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') setActivePaneId(pane.id)
                        }}
                      >
                        <span className={css.processIcon} aria-hidden="true">
                          <IconTerminalPrompt size={14} />
                        </span>
                        <span className={css.processName} title={pane.name}>
                          {pane.name}
                        </span>
                        <div className={css.processActions}>
                          <button
                            type="button"
                            className={css.actionButton}
                            title="Split Terminal"
                            aria-label="Split Terminal"
                            disabled={stopping}
                            onClick={(e) => {
                              e.stopPropagation()
                              handleSplit(pane.id)
                            }}
                          >
                            <IconSplitTerminal size={14} />
                          </button>
                          <button
                            type="button"
                            className={css.actionButton}
                            title={`Kill ${pane.name}`}
                            aria-label={`Kill ${pane.name}`}
                            disabled={api === undefined || stopping}
                            onClick={(e) => {
                              e.stopPropagation()
                              void handleKill(pane.id)
                            }}
                          >
                            <IconTrashOutline16 size={13} />
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </aside>
        )}
      </div>

      {api === undefined && (
        <div className={css.message} role="status">Desktop terminal is unavailable.</div>
      )}
      {activeError !== undefined && (
        <div className={css.message} role="alert">{activeError}</div>
      )}
      {stopError !== undefined && (
        <div className={css.message} role="alert">{stopError}</div>
      )}
    </section>
  )
}

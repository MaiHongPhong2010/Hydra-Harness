// @vitest-environment jsdom
/**
 * AppFrame interaction spec under the four-share props form: real layout
 * store instance (createLayoutStore().create() — the test-sanctioned engine
 * path), a recording renderSlot stub, and a render-prop SessionProvider stub
 * (the real one is framework-wired to the renderer host; its own behavior is
 * ui-renderer's spec territory). Drag sequences (pointer capture + rAF flush),
 * concession response to viewport change, and details staying mounted at
 * zero width are the preserved behavior assertions. jsdom has no layout
 * engine, so the frame width comes from a mocked getBoundingClientRect and
 * resizes are driven through the ResizeObserver stub.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { AppFrame } from '@hydraharness/harness-client-ui-layout/src/client/AppFrame.tsx'
import type { AppFrameProps } from '@hydraharness/harness-client-ui-layout/src/client/AppFrame.tsx'
import { SIDEBAR_COLLAPSED } from '@hydraharness/harness-client-ui-layout/src/client/columns.ts'
import { createLayoutStore } from '@hydraharness/harness-client-ui-layout/src/client/stores.ts'
import type {
  SessionId, SessionListState, WorkspaceId, WorkspaceListState,
} from '@hydraharness/harness-client-runtime/client'

vi.mock('@xterm/xterm', () => ({ Terminal: vi.fn(function () { return {
  cols: 80, rows: 24, options: {},
  loadAddon() {}, open() {}, write() {}, writeln() {}, focus() {}, dispose() {},
  onData: () => ({ dispose() {} }), onSelectionChange: () => ({ dispose() {} }),
  getSelection: () => '', attachCustomKeyEventHandler() {},
} }) }))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: vi.fn(function () { return { fit() {} } }) }))

// Session selection controls for the SessionProvider and useSessions stubs.
const selectedSession = { current: 's-test' as SessionId | undefined }
const selectedSessionBlank = { current: false }
const baselinesReady = { current: true }
const providedSessions: SessionId[] = []

// Render-prop contract stub fed through the standard seat prop (the renderer
// injects the real one in production): session mode runs children(id), empty
// mode runs the empty branch — the frame must work against exactly this
// shape. Typed as the seat's own component type so the branded sessionId
// parameter stays contract-checked.
const SessionProviderStub: AppFrameProps['SessionProvider'] = ({ children, empty, sessionId }) => {
  const resolved = sessionId ?? selectedSession.current
  if (resolved === undefined) return <>{empty?.() ?? null}</>
  providedSessions.push(resolved)
  return <>{children(resolved)}</>
}


/** Observer stub: captures the callback so tests can fire resizes manually. */
let fireResize: (() => void) | null = null
class ResizeObserverStub {
  #cb: ResizeObserverCallback
  constructor(cb: ResizeObserverCallback) { this.#cb = cb }
  observe(): void { fireResize = () => { this.#cb([], this) } }
  unobserve(): void {}
  disconnect(): void { fireResize = null }
}

let frameWidth = 1920

/** Test-local selector hook over a framework-neutral store instance. */
function hookOf<T>(inst: { subscribe: (fn: () => void) => () => void; getSnapshot: () => T }) {
  return function useSelector<S>(sel: (s: T) => S): S { return sel(useSyncExternalStore(inst.subscribe, inst.getSnapshot)) }
}

function mountFrame(workspaceOverrides: Partial<WorkspaceListState> = {}, preferenceOverrides: { terminalLocation?: 'bottom' | 'right'; fullView?: boolean; bottomPanelControl?: boolean } = {}) {
  window.innerWidth = frameWidth // first-render viewport source before the observer fires
  const instance = createLayoutStore().create()
  const createSideSession = vi.fn(async () => 's-side' as SessionId)
  const slotCalls: { key: string; props: unknown }[] = []
  const renderSlot = ((key: string, owner: object) => {
    slotCalls.push({ key, props: owner })
    if (key === 'sidebar') return <div data-testid="sidebar-content" />
    if (key === 'conversation') return <div data-testid="center-content" />
    if (key === 'details') return <div data-testid="details-content" />
    if (key === 'review') return <div data-testid="review-content" />
    if (key === 'conversation.empty') return <div data-testid="empty-content" />
    return <div data-testid="other-content" />
  }) as AppFrameProps['renderSlot']
  const useSessions = ((sel: (s: SessionListState) => unknown) => {
    const current = selectedSession.current
    const sessionState = {
      ids: current === undefined ? [] : [current],
      byId: current === undefined
        ? {}
        : { [current]: { id: current, displayTitle: 'Test', running: false, blank: selectedSessionBlank.current, updatedAt: 1 } },
      current,
      phase: 'ready',
    } as SessionListState
    return sel(sessionState)
  }) as never
  const workspaceState: WorkspaceListState = {
    items: [], archivedSessionIds: [], state: 'idle', phase: 'ready', error: null,
    baselinesReady: baselinesReady.current, recentWorkspaceId: undefined,
    ...workspaceOverrides,
  }
  const element = () => (
    <AppFrame
      useStore={hookOf(instance)}
      actions={instance.actions}
      renderSlot={renderSlot}
      useSessions={useSessions}
      useDesktopPreferences={((sel: (s: object) => unknown) => sel({ value: { bottomPanelControl: true, terminalLocation: 'bottom', fullView: false, ...preferenceOverrides } })) as never}
      useWorkspaces={((sel: (s: WorkspaceListState) => unknown) => sel(workspaceState)) as never}
      SessionProvider={SessionProviderStub}
      createSideSession={createSideSession}
    />
  )
  const utils = render(element())
  const frame = utils.container.firstElementChild as HTMLElement
  return { instance, frame, slotCalls, createSideSession, rerenderFrame: () => { utils.rerender(element()) }, ...utils }
}

function tracks(frame: HTMLElement): number[] {
  const m = /^(\d+)px minmax\(0, 1fr\) (\d+)px$/.exec(frame.style.gridTemplateColumns)
  if (m === null) throw new Error(`unexpected template: ${frame.style.gridTemplateColumns}`)
  return [Number(m[1]), Number(m[2])]
}

function drag(handle: Element, fromX: number, toX: number): void {
  const down = new PointerEvent('pointerdown', { pointerId: 1, clientX: fromX, bubbles: true })
  const move = new PointerEvent('pointermove', { pointerId: 1, clientX: toX, bubbles: true })
  const up = new PointerEvent('pointerup', { pointerId: 1, clientX: toX, bubbles: true })
  act(() => { handle.dispatchEvent(down) })
  act(() => { handle.dispatchEvent(move); vi.advanceTimersByTime(20) })
  act(() => { handle.dispatchEvent(up) })
}

function dragY(handle: Element, fromY: number, toY: number): void {
  const down = new PointerEvent('pointerdown', { pointerId: 1, clientY: fromY, bubbles: true })
  const move = new PointerEvent('pointermove', { pointerId: 1, clientY: toY, bubbles: true })
  const up = new PointerEvent('pointerup', { pointerId: 1, clientY: toY, bubbles: true })
  act(() => { handle.dispatchEvent(down) })
  act(() => { handle.dispatchEvent(move); vi.advanceTimersByTime(20) })
  act(() => { handle.dispatchEvent(up) })
}

beforeEach(() => {
  localStorage.clear()
  frameWidth = 1920
  window.innerHeight = 1080
  selectedSession.current = 's-test' as SessionId
  selectedSessionBlank.current = false
  baselinesReady.current = true
  providedSessions.length = 0
  vi.useFakeTimers()
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => { cb(0) }, 16) as unknown as number)
  vi.stubGlobal('cancelAnimationFrame', (h: number) => { clearTimeout(h) })
  window.innerWidth = frameWidth
  Element.prototype.getBoundingClientRect = function () {
    return { width: frameWidth, height: 1080, top: 0, left: 0, right: frameWidth, bottom: 1080, x: 0, y: 0, toJSON: () => ({}) }
  }
  // jsdom lacks pointer capture: emulate per-element so hasPointerCapture gates pass.
  const captured = new WeakSet<Element>()
  Element.prototype.setPointerCapture = function () { captured.add(this) }
  Element.prototype.releasePointerCapture = function () { captured.delete(this) }
  Element.prototype.hasPointerCapture = function () { return captured.has(this) }
})

afterEach(() => {
  cleanup()
  delete window.hydraDesktop
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('AppFrame', () => {
  it('adds bottom terminal tabs with the plus button and splits only with Split Terminal', async () => {
    const start = vi.fn(async () => ({ running: true }))
    const stop = vi.fn(async () => {})
    window.hydraDesktop = {
      browser: { setBounds: vi.fn() },
      terminal: { start, stop, write: vi.fn(), resize: vi.fn(), onEvent: () => () => {} },
    }
    const view = mountFrame()
    fireEvent.click(view.getByRole('button', { name: 'Toggle bottom terminal' }))
    await act(async () => { await vi.advanceTimersByTimeAsync(20) })
    fireEvent.click(view.getByRole('button', { name: 'New Terminal' }))
    await act(async () => { await vi.advanceTimersByTimeAsync(20) })
    const tabs = within(view.getByRole('tablist', { name: 'Bottom terminal tabs' }))
    expect(tabs.getAllByRole('tab').map(tab => tab.textContent)).toEqual(['Terminal', 'Terminal 2'])
    expect(tabs.getByRole('tab', { name: 'Terminal 2' }).getAttribute('aria-selected')).toBe('true')
    expect(view.getAllByRole('button', { name: 'Split Terminal' })).toHaveLength(1)
    expect(start).toHaveBeenLastCalledWith('bottom-1-2', { cols: 80, rows: 24 }, undefined, undefined)
    fireEvent.click(view.getByRole('button', { name: 'Split Terminal' }))
    await act(async () => { await vi.advanceTimersByTimeAsync(20) })
    expect(start).toHaveBeenLastCalledWith('bottom-1-2-2', { cols: 80, rows: 24 }, undefined, undefined)
    expect(view.getAllByRole('button', { name: 'Split Terminal' })).toHaveLength(2)
    fireEvent.click(tabs.getByRole('tab', { name: 'Terminal' }))
    await act(async () => { await vi.advanceTimersByTimeAsync(20) })
    expect(view.getAllByRole('button', { name: 'Split Terminal' })).toHaveLength(1)
    fireEvent.click(tabs.getByRole('tab', { name: 'Terminal 2' }))
    await act(async () => { await vi.advanceTimersByTimeAsync(20) })
    expect(view.getAllByRole('button', { name: 'Split Terminal' })).toHaveLength(2)
    fireEvent.click(tabs.getByRole('button', { name: 'Close Terminal 2' }))
    await act(async () => { await vi.advanceTimersByTimeAsync(20) })
    expect(stop).toHaveBeenCalledWith('bottom-1-2')
    expect(stop).toHaveBeenCalledWith('bottom-1-2-2')
    expect(stop).not.toHaveBeenCalledWith('bottom-1-1')
    expect(tabs.getAllByRole('tab')).toHaveLength(1)
  })

  it('preserves separate bottom terminals while switching among workspace sessions', async () => {
    const start = vi.fn(async () => ({ running: true }))
    const stop = vi.fn(async () => {})
    window.hydraDesktop = {
      browser: { setBounds: vi.fn() },
      terminal: { start, stop, write: vi.fn(), resize: vi.fn(), onEvent: () => () => {} },
    }
    const items = ['a', 'b', 'c'].map(name => ({
      workspaceId: `workspace-${name}` as WorkspaceId, path: `/workspaces/${name}`, title: name,
      sessionIds: [`session-${name}` as SessionId], createdAt: '', updatedAt: '',
    }))
    selectedSession.current = 'session-a' as SessionId
    const view = mountFrame({ items, recentWorkspaceId: items[2]!.workspaceId })
    fireEvent.click(view.getByRole('button', { name: 'Toggle bottom terminal' }))
    await act(async () => { await vi.advanceTimersByTimeAsync(20) })
    expect(start).toHaveBeenLastCalledWith('bottom-1-1', { cols: 80, rows: 24 }, 'workspace-a', undefined)
    fireEvent.click(view.getByRole('button', { name: 'Split Terminal' }))
    await act(async () => { await vi.advanceTimersByTimeAsync(20) })
    expect(start).toHaveBeenLastCalledWith('bottom-1-1-2', { cols: 80, rows: 24 }, 'workspace-a', undefined)
    for (const [name, id] of [['b', 'bottom-2-1'], ['c', 'bottom-3-1'], ['a', 'bottom-1-1-2']]) {
      selectedSession.current = `session-${name}` as SessionId
      view.rerenderFrame()
      await act(async () => { await vi.advanceTimersByTimeAsync(20) })
      expect(start).toHaveBeenLastCalledWith(id, { cols: 80, rows: 24 }, `workspace-${name}`, undefined)
      expect(view.getAllByRole('region', { name: 'Terminal' })).toHaveLength(1)
    }
    expect(view.getAllByRole('button', { name: 'Split Terminal' })).toHaveLength(2)
    expect(stop).not.toHaveBeenCalled()
  })

  it('opens Ctrl+P Files against the current registered workspace', async () => {
    const workspaceId = 'workspace-test' as WorkspaceId
    const rootPath = 'C:\\workspace'
    let shortcut: ((value: 'files' | 'side-chat' | 'browser' | 'terminal' | 'review') => void) | undefined
    const files = {
      root: vi.fn(async () => rootPath),
      list: vi.fn(async () => []),
      search: vi.fn(async () => []),
      read: vi.fn(async (path: string) => ({ path, content: '', version: 'v1' })),
      create: vi.fn(),
      save: vi.fn(),
      format: vi.fn(),
    }
    window.hydraDesktop = {
      browser: { setBounds: vi.fn() },
      files,
      panels: {
        onShortcut: (listener) => {
          shortcut = listener
          return () => { shortcut = undefined }
        },
        onClose: () => () => {},
      },
    }
    const view = mountFrame({
      items: [{
        workspaceId,
        path: rootPath,
        title: 'Workspace',
        sessionIds: ['s-test' as SessionId],
        createdAt: '2026-08-28T00:00:00.000Z',
        updatedAt: '2026-08-28T00:00:00.000Z',
      }],
      recentWorkspaceId: workspaceId,
    })

    await act(async () => { shortcut?.('files'); await Promise.resolve() })

    expect(view.getByRole('tab', { name: 'Files' }).getAttribute('aria-selected')).toBe('true')
    expect(files.root).toHaveBeenCalledWith(workspaceId)
  })

  it('renders the Review seat from the right panel against the current session', () => {
    window.hydraDesktop = { browser: { setBounds: vi.fn() } }
    const view = mountFrame()
    expect(view.queryByTestId('review-content')).toBeNull()
    fireEvent.click(view.getByLabelText('Toggle right panel'))
    fireEvent.click(view.getByRole('button', { name: 'Review' }))
    expect(view.getByRole('tab', { name: 'Review' }).getAttribute('aria-selected')).toBe('true')
    expect(view.getByTestId('review-content')).toBeTruthy()
    expect(view.slotCalls.find(call => call.key === 'review')!.props).toEqual({})
  })

  it('starts with the right panel closed, then keeps its tabs and Terminals independent', async () => {
    frameWidth = 1400
    window.innerHeight = 900
    let shortcut: ((value: 'files' | 'side-chat' | 'browser' | 'terminal' | 'review') => void) | undefined
    window.hydraDesktop = {
      browser: { setBounds: vi.fn() },
      panels: {
        onShortcut: (listener) => {
          shortcut = listener
          return () => { shortcut = undefined }
        },
        onClose: () => () => {},
      },
    }
    const view = mountFrame({}, { terminalLocation: 'right' })
    const shell = view.container.firstElementChild as HTMLElement
    expect(shell.hasAttribute('data-browser-open')).toBe(false)
    expect(shell.hasAttribute('data-terminal-open')).toBe(false)
    expect(view.getByLabelText('Right panel').hasAttribute('hidden')).toBe(true)
    expect(view.getByLabelText('Toggle right panel').getAttribute('aria-pressed')).toBe('false')

    act(() => { shortcut?.('browser') })
    expect(shell.hasAttribute('data-browser-open')).toBe(true)
    expect(view.getByLabelText('Right panel').hasAttribute('hidden')).toBe(false)
    expect(view.getByRole('tab', { name: 'Browser' }).getAttribute('aria-selected')).toBe('true')

    fireEvent.click(view.getByLabelText('Toggle bottom terminal'))
    expect(shell.hasAttribute('data-browser-open')).toBe(true)
    expect(shell.hasAttribute('data-terminal-open')).toBe(true)
    expect(view.getByLabelText('Terminal', { selector: 'section' }).hasAttribute('hidden')).toBe(false)

    act(() => { shortcut?.('terminal') })
    expect(within(view.getByRole('tablist', { name: 'Right panel tabs' })).getByRole('tab', { name: 'Terminal' }).getAttribute('aria-selected')).toBe('true')
    expect(within(view.getByRole('tablist', { name: 'Bottom terminal tabs' })).getAllByRole('tab')).toHaveLength(1)
    expect(view.getByLabelText('Right terminal').hasAttribute('hidden')).toBe(false)
    expect(view.getByLabelText('Terminal', { selector: 'section' }).hasAttribute('hidden')).toBe(false)

    const browserHandle = view.getByRole('separator', { name: 'Resize right panel' })
    const terminalHandle = view.getByRole('separator', { name: 'Resize Terminal panel' })
    drag(browserHandle, 800, 0)
    dragY(terminalHandle, 600, 0)
    expect(browserHandle.getAttribute('aria-valuenow')).toBe('1388')
    expect(terminalHandle.getAttribute('aria-valuenow')).toBe('450')
    drag(browserHandle, 0, 1000)
    dragY(terminalHandle, 0, 500)
    expect(browserHandle.getAttribute('aria-valuenow')).toBe('388')
    expect(terminalHandle.getAttribute('aria-valuenow')).toBe('240')
    fireEvent.keyDown(browserHandle, { key: 'ArrowLeft' })
    fireEvent.keyDown(terminalHandle, { key: 'ArrowUp', shiftKey: true })
    expect(browserHandle.getAttribute('aria-valuenow')).toBe('396')
    expect(terminalHandle.getAttribute('aria-valuenow')).toBe('272')

    fireEvent.click(view.getByRole('button', { name: 'Side chat' }))
    await vi.advanceTimersByTimeAsync(0)
    expect(view.createSideSession).toHaveBeenCalledOnce()
    expect(providedSessions).toContain('s-side')
    expect(view.getByRole('tab', { name: 'Side chat' }).getAttribute('aria-selected')).toBe('true')
    expect(view.slotCalls.some(call => call.key === 'conversation' && JSON.stringify(call.props) === '{"secondary":true}')).toBe(true)
    fireEvent.click(within(view.getByRole('tablist', { name: 'Right panel tabs' })).getByRole('tab', { name: 'Terminal' }))

    const toggleRight = view.getByLabelText('Toggle right panel')
    fireEvent.click(toggleRight)
    expect(view.getByLabelText('Right panel').hasAttribute('hidden')).toBe(true)
    expect(view.getByLabelText('Terminal', { selector: 'section' }).hasAttribute('hidden')).toBe(false)
    fireEvent.click(toggleRight)
    expect(view.getByLabelText('Right terminal').hasAttribute('hidden')).toBe(false)

    fireEvent.click(view.getByLabelText('Expand right panel'))
    expect(shell.hasAttribute('data-browser-expanded')).toBe(true)
    expect(view.getByLabelText('Toggle bottom terminal').getAttribute('aria-pressed')).toBe('true')
    expect(view.getByLabelText('Terminal', { selector: 'section' }).hasAttribute('hidden')).toBe(true)
    expect(view.getByLabelText('Right terminal').hasAttribute('hidden')).toBe(false)
    fireEvent.click(view.getByLabelText('Expand right panel'))
    expect(shell.hasAttribute('data-browser-expanded')).toBe(false)
    expect(view.getByLabelText('Terminal', { selector: 'section' }).hasAttribute('hidden')).toBe(false)
    expect(view.getByRole('separator', { name: 'Resize right panel' }).getAttribute('aria-valuenow')).toBe('396')
    expect(view.getByRole('separator', { name: 'Resize Terminal panel' }).getAttribute('aria-valuenow')).toBe('272')
  })

  it('recomputes desktop panel limits from the whole app viewport', () => {
    frameWidth = 1500
    window.innerHeight = 1000
    window.hydraDesktop = { browser: { setBounds: vi.fn() } }
    const view = mountFrame()
    fireEvent.click(view.getByLabelText('Toggle right panel'))
    const browserHandle = view.getByRole('separator', { name: 'Resize right panel' })
    fireEvent.click(view.getByLabelText('Toggle bottom terminal'))
    const terminalHandle = view.getByRole('separator', { name: 'Resize Terminal panel' })

    expect(browserHandle.getAttribute('aria-valuemax')).toBe('1500')
    expect(terminalHandle.getAttribute('aria-valuemax')).toBe('500')
    drag(browserHandle, 1000, 0)
    dragY(terminalHandle, 700, 0)
    expect(browserHandle.getAttribute('aria-valuenow')).toBe('1500')
    expect(terminalHandle.getAttribute('aria-valuenow')).toBe('500')

    act(() => {
      window.innerWidth = 1000
      window.innerHeight = 700
      window.dispatchEvent(new Event('resize'))
    })
    expect(browserHandle.getAttribute('aria-valuemax')).toBe('1000')
    expect(terminalHandle.getAttribute('aria-valuemax')).toBe('350')
    expect(browserHandle.getAttribute('aria-valuenow')).toBe('1000')
    expect(terminalHandle.getAttribute('aria-valuenow')).toBe('350')

    // The temporary viewport clamp must not overwrite the dimensions the user
    // chose before the window was narrowed.
    act(() => {
      window.innerWidth = 1500
      window.innerHeight = 1000
      window.dispatchEvent(new Event('resize'))
    })
    expect(browserHandle.getAttribute('aria-valuenow')).toBe('1500')
    expect(terminalHandle.getAttribute('aria-valuenow')).toBe('500')
  })

  it('steps the sidebar and details widths from the keyboard', () => {
    const view = mountFrame()
    act(() => { view.instance.actions.openDetails() })
    const sidebar = view.getByRole('separator', { name: 'Resize sidebar' })
    const details = view.getByRole('separator', { name: 'Resize details panel' })
    expect(sidebar.getAttribute('aria-orientation')).toBe('vertical')
    expect(sidebar.getAttribute('aria-valuemin')).toBe('160')
    expect(sidebar.getAttribute('aria-valuemax')).toBe('1920')
    expect(tracks(view.frame)).toEqual([280, 360])
    // ArrowRight grows the sidebar; ArrowLeft grows details, whose drag delta is inverted.
    fireEvent.keyDown(sidebar, { key: 'ArrowRight' })
    fireEvent.keyDown(details, { key: 'ArrowLeft' })
    expect(tracks(view.frame)).toEqual([288, 368])
    expect(sidebar.getAttribute('aria-valuenow')).toBe('288')
    expect(details.getAttribute('aria-valuenow')).toBe('368')
    // Shift steps by 32; no ceiling or floor kicks in yet, so it's exact arithmetic.
    fireEvent.keyDown(sidebar, { key: 'ArrowLeft', shiftKey: true })
    fireEvent.keyDown(details, { key: 'ArrowRight', shiftKey: true })
    expect(tracks(view.frame)).toEqual([256, 336])
    // The cross-axis arrow is not a resize for a vertical separator.
    fireEvent.keyDown(sidebar, { key: 'ArrowUp' })
    expect(tracks(view.frame)).toEqual([256, 336])
  })

  it('renders three tracks from store state', () => {
    const { frame } = mountFrame()
    expect(tracks(frame)).toEqual([280, 0])
  })

  it('renders the session pair with empty owner shares (sessionId is framework-standard)', () => {
    const { slotCalls, getByTestId } = mountFrame()
    expect(getByTestId('center-content')).toBeTruthy()
    expect(getByTestId('details-content')).toBeTruthy()
    const keys = slotCalls.map(c => c.key)
    expect(keys).toContain('conversation')
    expect(keys).toContain('details')
    expect(keys).not.toContain('conversation.empty')
    expect(slotCalls.find(c => c.key === 'conversation')!.props).toEqual({})
    expect(slotCalls.find(c => c.key === 'details')!.props).toEqual({})
  })

  it('keeps the conversation slot mounted while no session is current', () => {
    // No current session: the session-maybe conversation shell owns the New
    // Session view itself — the center column renders it unconditionally.
    selectedSession.current = undefined
    const { slotCalls, getByTestId } = mountFrame()
    expect(getByTestId('center-content')).toBeTruthy()
    expect(slotCalls.map(c => c.key)).toContain('conversation')
  })

  it('renders both column occupants before baselines settle (no loading gate)', () => {
    // No loading gate: a bare loading status reads worse than the shell's own
    // pending rendering — both occupants mount from first paint.
    baselinesReady.current = false
    const { slotCalls } = mountFrame()
    expect(slotCalls.map(c => c.key)).toContain('conversation')
    expect(slotCalls.map(c => c.key)).toContain('details')
  })

  it('ignores unselected states and closes only when the Session id changes', () => {
    const { frame, instance, rerenderFrame } = mountFrame()
    expect(tracks(frame)).toEqual([280, 0])

    act(() => { instance.actions.openDetails() })
    expect(tracks(frame)).toEqual([280, 360])

    selectedSession.current = 's-next' as SessionId
    act(() => { rerenderFrame() })
    expect(tracks(frame)).toEqual([280, 0])

    act(() => { instance.actions.openDetails() })
    selectedSession.current = 's-blank' as SessionId
    selectedSessionBlank.current = true
    act(() => { rerenderFrame() })
    expect(tracks(frame)).toEqual([280, 0])
    expect(instance.getSnapshot().details).toBe(360)

    selectedSession.current = 's-next' as SessionId
    selectedSessionBlank.current = false
    act(() => { rerenderFrame() })
    expect(tracks(frame)).toEqual([280, 360])

    selectedSession.current = undefined
    act(() => { rerenderFrame() })
    expect(tracks(frame)).toEqual([280, 0])
    selectedSession.current = 's-test' as SessionId
    act(() => { rerenderFrame() })
    expect(tracks(frame)).toEqual([280, 0])
  })

  it('keeps details closed when the first Session materializes', () => {
    selectedSession.current = undefined
    const { frame, instance, rerenderFrame } = mountFrame()
    expect(tracks(frame)).toEqual([280, 0])
    expect(instance.getSnapshot().details).toBe(0)

    selectedSession.current = 's-first' as SessionId
    act(() => { rerenderFrame() })
    expect(tracks(frame)).toEqual([280, 0])
  })

  it('sidebar slot receives live concession output as owner props', () => {
    const { slotCalls } = mountFrame()
    expect(slotCalls.find(c => c.key === 'sidebar')!.props).toEqual({ collapsed: false, width: 280 })
  })

  it('sidebar drag widens through rAF-batched pointer moves', () => {
    const { frame } = mountFrame()
    const handles = frame.querySelectorAll('[class*="handle"]')
    drag(handles[0]!, 280, 350)
    expect(tracks(frame)[0]).toBe(350)
  })

  it('details drag widens leftward (negative dx grows the panel)', () => {
    const { frame, instance } = mountFrame()
    act(() => { instance.actions.openDetails() })
    const handles = frame.querySelectorAll('[class*="handle"]')
    drag(handles[1]!, 1560, 1500)
    expect(tracks(frame)[1]).toBe(420)
  })

  it('drag base is the rendered (viewport-clamped) width, not the preference', () => {
    frameWidth = 1100 // above the auto-collapse breakpoint; sidebar 800 leaves only 300 for details
    const { frame, instance } = mountFrame()
    act(() => {
      instance.actions.setSidebar(800)
      instance.actions.openDetails()
    })
    expect(tracks(frame)).toEqual([800, 300])
    const handles = frame.querySelectorAll('[class*="handle"]')
    drag(handles[1]!, 920, 930) // shrink by 10 from the rendered width
    expect(instance.getSnapshot().details).toBe(290)
  })

  it('details column stays mounted at zero width', () => {
    const { frame, getByTestId } = mountFrame()
    expect(tracks(frame)).toEqual([280, 0])
    expect(getByTestId('details-content')).toBeTruthy()
    expect(frame.hasAttribute('data-details-collapsed')).toBe(true)
  })

  it('closed sidebar keeps its compact rail with mounted slot content and collapsed owner props', () => {
    const { frame, instance, slotCalls, getByTestId } = mountFrame()
    act(() => { instance.actions.toggleSidebar() })
    expect(tracks(frame)).toEqual([SIDEBAR_COLLAPSED, 0])
    expect(getByTestId('sidebar-content')).toBeTruthy()
    expect(frame.hasAttribute('data-sidebar-collapsed')).toBe(true)
    const lastSidebarCall = slotCalls.filter(c => c.key === 'sidebar').at(-1)!
    expect(lastSidebarCall.props).toEqual({ collapsed: true, width: SIDEBAR_COLLAPSED })
  })

  it('viewport shrink re-solves the details column via ResizeObserver; sidebar holds', () => {
    const { frame, instance } = mountFrame()
    act(() => {
      instance.actions.setSidebar(800)
      instance.actions.openDetails()
    })
    frameWidth = 1100 // above the auto-collapse breakpoint; sidebar 800 leaves only 300 for details
    act(() => { fireResize?.(); vi.advanceTimersByTime(20) })
    expect(tracks(frame)).toEqual([800, 300])
    frameWidth = 1920
    act(() => { fireResize?.(); vi.advanceTimersByTime(20) })
    expect(tracks(frame)).toEqual([800, 360])
  })

  it('drag handles disappear for collapsed columns', () => {
    const { frame, instance } = mountFrame()
    expect(frame.querySelectorAll('[class*="handle"]')).toHaveLength(1)
    act(() => { instance.actions.openDetails() })
    expect(frame.querySelectorAll('[class*="handle"]')).toHaveLength(2)
    act(() => { instance.actions.closeDetails() })
    expect(frame.querySelectorAll('[class*="handle"]')).toHaveLength(1)
    act(() => { instance.actions.toggleSidebar() })
    expect(frame.querySelectorAll('[class*="handle"]')).toHaveLength(0)
  })
})

describe('AppFrame — narrow-viewport auto-collapse', () => {
  it('mounts collapsed below the breakpoint with no sidebar handle', () => {
    frameWidth = 980
    const { frame, slotCalls } = mountFrame()
    expect(tracks(frame)).toEqual([SIDEBAR_COLLAPSED, 0])
    expect(frame.hasAttribute('data-sidebar-collapsed')).toBe(true)
    expect(slotCalls.filter(c => c.key === 'sidebar').at(-1)!.props).toEqual({ collapsed: true, width: SIDEBAR_COLLAPSED })
    expect(frame.querySelectorAll('[class*="handle"]')).toHaveLength(0)
  })

  it('narrow toggle re-expands over the squeezed center and back', () => {
    frameWidth = 980
    const { frame, instance } = mountFrame()
    act(() => { instance.actions.toggleSidebar() })
    expect(tracks(frame)).toEqual([280, 0])
    expect(frame.hasAttribute('data-sidebar-collapsed')).toBe(false)
    expect(frame.querySelectorAll('[class*="handle"]')).toHaveLength(1)
    act(() => { instance.actions.toggleSidebar() })
    expect(tracks(frame)).toEqual([SIDEBAR_COLLAPSED, 0])
  })

  it('a wide-closed preference re-expands at the contract default while narrow', () => {
    frameWidth = 1920
    const { frame, instance } = mountFrame()
    act(() => { instance.actions.toggleSidebar() }) // close while wide: preference 0
    frameWidth = 980
    act(() => { fireResize?.(); vi.advanceTimersByTime(20) })
    act(() => { instance.actions.toggleSidebar() })
    expect(tracks(frame)).toEqual([280, 0])
    expect(instance.getSnapshot().sidebar).toBe(0) // preference untouched
  })

  it('shrinking across the breakpoint auto-collapses; re-widening restores the drag width', () => {
    const { frame, instance } = mountFrame()
    act(() => { instance.actions.setSidebar(400) })
    frameWidth = 980
    act(() => { fireResize?.(); vi.advanceTimersByTime(20) })
    expect(tracks(frame)).toEqual([SIDEBAR_COLLAPSED, 0])
    frameWidth = 1920
    act(() => { fireResize?.(); vi.advanceTimersByTime(20) })
    expect(tracks(frame)).toEqual([400, 0])
  })
})

describe('AppFrame — guard branches', () => {
  it('pointer moves without capture are ignored (no width write)', () => {
    const { frame, instance } = mountFrame()
    const handle = frame.querySelectorAll('[class*="handle"]')[0]!
    const before = instance.getSnapshot().sidebar
    // Move + up without a preceding pointerdown: hasPointerCapture is false.
    act(() => {
      handle.dispatchEvent(new PointerEvent('pointermove', { pointerId: 9, clientX: 500, bubbles: true }))
      vi.advanceTimersByTime(20)
      handle.dispatchEvent(new PointerEvent('pointerup', { pointerId: 9, clientX: 500, bubbles: true }))
    })
    expect(instance.getSnapshot().sidebar).toBe(before)
  })

  it('two moves inside one frame coalesce through the pending rAF', () => {
    const { frame, instance } = mountFrame()
    const handle = frame.querySelectorAll('[class*="handle"]')[0]!
    act(() => { handle.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, clientX: 280, bubbles: true })) })
    act(() => {
      // Two moves before the frame flushes: the second must ride the pending
      // rAF (frame.current ??= guard), and the flush sees the latest x.
      handle.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 320, bubbles: true }))
      handle.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 340, bubbles: true }))
      vi.advanceTimersByTime(20)
    })
    act(() => { handle.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, clientX: 340, bubbles: true })) })
    expect(instance.getSnapshot().sidebar).toBe(340)
  })

  it('pointerup with a pending rAF cancels it and commits the final position', () => {
    const { frame, instance } = mountFrame()
    const handle = frame.querySelectorAll('[class*="handle"]')[0]!
    act(() => { handle.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, clientX: 280, bubbles: true })) })
    act(() => {
      handle.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 360, bubbles: true }))
      // No timer advance: the rAF is still pending when pointerup arrives.
      handle.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, clientX: 360, bubbles: true }))
    })
    expect(instance.getSnapshot().sidebar).toBe(360)
  })

  it('zero-width resize reports are ignored (display:none window)', () => {
    const { frame } = mountFrame()
    frameWidth = 0
    act(() => { fireResize?.(); vi.advanceTimersByTime(20) })
    // Track template still reflects the last non-zero viewport.
    expect(tracks(frame)).toEqual([280, 0])
  })
})

describe('AppFrame — unmount with an in-flight resize frame', () => {
  it('cancels the pending rAF on unmount (no post-unmount setState)', () => {
    const { unmount } = mountFrame()
    frameWidth = 800
    act(() => { fireResize?.() }) // rAF scheduled, NOT flushed
    unmount()
    // Flushing after unmount must be a no-op (the frame was cancelled).
    expect(() => { vi.advanceTimersByTime(20) }).not.toThrow()
  })

  it('double resize inside one frame rides the pending rAF (??= guard)', () => {
    const { frame, instance } = mountFrame()
    act(() => { instance.actions.openDetails() })
    frameWidth = 1250
    act(() => { fireResize?.(); fireResize?.(); vi.advanceTimersByTime(20) })
    expect(tracks(frame)).toEqual([280, 360])
  })
})

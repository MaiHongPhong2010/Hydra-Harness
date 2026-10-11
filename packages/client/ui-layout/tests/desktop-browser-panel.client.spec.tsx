// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import type { SessionId, WorkspaceId } from '@hydraharness/harness-client-runtime/client'
import {
  DesktopBrowserPanel,
  DesktopPanelControls,
} from '@hydraharness/harness-client-ui-layout/src/client/DesktopBrowserPanel.tsx'
import type {
  DesktopBrowserApi, DesktopPanelShortcut, DesktopTerminalApi, DesktopTerminalId,
} from '@hydraharness/harness-client-ui-layout/src/client/DesktopBrowserPanel.tsx'
import { DesktopFilesPanel } from '@hydraharness/harness-client-ui-layout/src/client/DesktopFilesPanel.tsx'

vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn(function MockTerminal() { return {
    cols: 80,
    rows: 24,
    loadAddon: vi.fn(),
    open: vi.fn(),
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    onResize: vi.fn(() => ({ dispose: vi.fn() })),
    onSelectionChange: vi.fn(() => ({ dispose: vi.fn() })),
    getSelection: vi.fn(() => ''),
    attachCustomKeyEventHandler: vi.fn(),
    write: vi.fn(),
    writeln: vi.fn(),
    focus: vi.fn(),
    dispose: vi.fn(),
  } }),
}))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: vi.fn(function MockFitAddon() { return { fit: vi.fn() } }) }))

function PanelHarness(props: {
  open?: boolean | undefined
  workspaceId?: WorkspaceId | undefined
  createSideSession: () => Promise<SessionId>
  renderSideChat: (sessionId: SessionId) => ReactNode
  onOpen?: (() => void) | undefined
}) {
  return (
    <DesktopBrowserPanel
      open={props.open ?? true}
      workspaceId={props.workspaceId}
      createSideSession={props.createSideSession}
      renderSideChat={props.renderSideChat}
      renderReview={() => <div data-testid="review-slot" />}
      onOpen={props.onOpen ?? (() => {})}
    />
  )
}

function stubPanelObservers(): void {
  vi.stubGlobal('ResizeObserver', class {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(): void { this.callback([], this as unknown as ResizeObserver) }
    disconnect(): void {}
  })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    window.setTimeout(() => { callback(0) }, 0))
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { window.clearTimeout(id) })
}

function stubVisualViewport(): EventTarget {
  const visualViewport = new EventTarget()
  vi.stubGlobal('visualViewport', visualViewport)
  return visualViewport
}

afterEach(() => {
  cleanup()
  delete window.hydraDesktop
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('DesktopBrowserPanel', () => {
  it('closes bottom tabs with the trash button and reuses the smallest free label with a fresh PTY id', async () => {
    stubPanelObservers()
    const start = vi.fn<DesktopTerminalApi['start']>(async () => ({ running: true }))
    const stop = vi.fn(async () => {})
    window.hydraDesktop = {
      browser: { setBounds: vi.fn() },
      terminal: { start, stop, write: vi.fn(), resize: vi.fn(), onEvent: () => () => {} },
    }
    const view = render(<DesktopBrowserPanel open terminalGroup={1} onOpen={() => {}} />)
    await waitFor(() => { expect(start).toHaveBeenCalledWith('bottom-1-1', expect.any(Object), undefined, undefined) })
    fireEvent.click(view.getByRole('button', { name: 'New Terminal' }))
    fireEvent.click(view.getByRole('button', { name: 'New Terminal' }))
    expect(view.getByRole('tab', { name: 'Terminal 3' })).toBeTruthy()

    fireEvent.click(view.getByRole('button', { name: 'Close Terminal 2' }))
    await waitFor(() => { expect(view.queryByRole('tab', { name: 'Terminal 2' })).toBeNull() })
    fireEvent.click(view.getByRole('button', { name: 'New Terminal' }))
    await waitFor(() => { expect(start).toHaveBeenCalledWith('bottom-1-4', expect.any(Object), undefined, undefined) })
    expect(view.getByRole('tab', { name: 'Terminal 2' }).getAttribute('aria-selected')).toBe('true')
    expect(view.getByRole('tab', { name: 'Terminal 3' })).toBeTruthy()

    fireEvent.click(view.getByRole('button', { name: /Kill/ }))
    await waitFor(() => { expect(view.queryByRole('tab', { name: 'Terminal 2' })).toBeNull() })
    expect(stop).toHaveBeenCalledWith('bottom-1-4')
    expect(stop).not.toHaveBeenCalledWith('bottom-1-1')
    fireEvent.click(view.getByRole('button', { name: 'Close Terminal 3' }))
    await waitFor(() => { expect(view.queryByRole('tab', { name: 'Terminal 3' })).toBeNull() })
    fireEvent.click(view.getByRole('button', { name: 'Split Terminal' }))
    await waitFor(() => { expect(start).toHaveBeenCalledWith('bottom-1-1-2', expect.any(Object), undefined, undefined) })
    fireEvent.click(view.getAllByRole('button', { name: /Kill/ })[0]!)
    await waitFor(() => { expect(view.getAllByRole('button', { name: /Kill/ })).toHaveLength(1) })
    expect(view.getByRole('tab', { name: 'Terminal' })).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: /Kill/ }))
    await waitFor(() => { expect(view.queryByRole('tab')).toBeNull() })
    expect(stop).toHaveBeenCalledWith('bottom-1-1')
    expect(stop).toHaveBeenCalledWith('bottom-1-1-2')

    fireEvent.click(view.getByRole('button', { name: 'Terminal' }))
    await waitFor(() => { expect(start).toHaveBeenCalledWith('bottom-1-5', expect.any(Object), undefined, undefined) })
    expect(view.getByRole('tab', { name: 'Terminal' })).toBeTruthy()
    expect(view.queryByRole('tab', { name: 'Terminal 5' })).toBeNull()
  })

  it('starts each terminal in its creation workspace, including splits after switching workspaces', async () => {
    stubPanelObservers()
    const start = vi.fn<DesktopTerminalApi['start']>(async () => ({ running: true }))
    window.hydraDesktop = {
      browser: { setBounds: vi.fn() },
      terminal: { start, stop: vi.fn(async () => {}), write: vi.fn(), resize: vi.fn(), onEvent: () => () => {} },
    }
    const createSideSession = async () => 'side' as SessionId
    const renderSideChat = () => null
    const panel = (workspaceId: string) => (
      <PanelHarness workspaceId={workspaceId as WorkspaceId} createSideSession={createSideSession} renderSideChat={renderSideChat} />
    )
    const view = render(panel('workspace-a'))
    fireEvent.click(view.getByRole('button', { name: 'Terminal' }))
    await waitFor(() => { expect(start).toHaveBeenCalledWith('right', { cols: 80, rows: 24 }, 'workspace-a', undefined) })
    view.rerender(panel('workspace-b'))
    fireEvent.click(view.getByRole('button', { name: 'Terminal' }))
    await waitFor(() => { expect(start).toHaveBeenCalledWith('right-2', { cols: 80, rows: 24 }, 'workspace-b', undefined) })
    view.rerender(panel('workspace-c'))
    fireEvent.click(view.getByRole('button', { name: 'Terminal' }))
    await waitFor(() => { expect(start).toHaveBeenCalledWith('right-3', { cols: 80, rows: 24 }, 'workspace-c', undefined) })
    fireEvent.click(view.getByRole('tab', { name: 'Terminal' }))
    fireEvent.click(view.getByRole('button', { name: 'Split Terminal' }))
    await waitFor(() => { expect(start).toHaveBeenCalledWith('right-1-2', { cols: 80, rows: 24 }, 'workspace-a', undefined) })
    expect(start.mock.calls.filter(call => call[0] === 'right').every(call => call[2] === 'workspace-a')).toBe(true)
  })

  it('hides native bounds for overlays and non-Browser tabs, then restores them', async () => {
    const setBounds = vi.fn()
    const api: DesktopBrowserApi = { setBounds }
    window.hydraDesktop = { browser: api }
    stubPanelObservers()
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 700, y: 72, left: 700, top: 72, right: 1200, bottom: 800,
      width: 500, height: 728, toJSON: () => ({}),
    })

    const createSideSession = vi.fn(async () => 'side-1' as SessionId)
    const renderSideChat = (sessionId: SessionId) => <div>{String(sessionId)}</div>
    const view = render(
      <PanelHarness createSideSession={createSideSession} renderSideChat={renderSideChat} />,
    )
    const visibleBounds = { x: 700, y: 72, width: 500, height: 728, visible: true, present: true }
    const hiddenBounds = { x: 0, y: 0, width: 0, height: 0, visible: false, present: true }

    await waitFor(() => { expect(setBounds).toHaveBeenLastCalledWith(visibleBounds) })

    const modal = document.createElement('div')
    modal.setAttribute('role', 'dialog')
    modal.setAttribute('aria-modal', 'true')
    document.body.append(modal)
    await waitFor(() => {
      expect(setBounds).toHaveBeenLastCalledWith({ ...visibleBounds, visible: false })
    })
    modal.remove()
    await waitFor(() => { expect(setBounds).toHaveBeenLastCalledWith(visibleBounds) })

    fireEvent.click(view.getByRole('button', { name: 'Files' }))
    await waitFor(() => { expect(setBounds).toHaveBeenLastCalledWith(hiddenBounds) })

    fireEvent.click(view.getByRole('tab', { name: 'Browser' }))
    await waitFor(() => { expect(setBounds).toHaveBeenLastCalledWith(visibleBounds) })

    // Closing the Browser tab tells the controller the panel no longer hosts one.
    fireEvent.click(view.getByRole('button', { name: 'Close Browser' }))
    const absentBounds = { ...hiddenBounds, present: false }
    await waitFor(() => { expect(setBounds).toHaveBeenLastCalledWith(absentBounds) })

    view.rerender(
      <PanelHarness open={false} createSideSession={createSideSession} renderSideChat={renderSideChat} />,
    )
    await waitFor(() => { expect(setBounds).toHaveBeenLastCalledWith(absentBounds) })
  })

  it('re-measures native bounds when the visual viewport changes', async () => {
    const setBounds = vi.fn()
    window.hydraDesktop = { browser: { setBounds } }
    stubPanelObservers()
    const visualViewport = stubVisualViewport()
    let width = 500
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(() => ({
      x: 700, y: 72, left: 700, top: 72, right: 700 + width, bottom: 800,
      width, height: 728, toJSON: () => ({}),
    }))

    render(<PanelHarness createSideSession={async () => 'side-1' as SessionId} renderSideChat={() => null} />)
    await waitFor(() => { expect(setBounds).toHaveBeenLastCalledWith({
      x: 700, y: 72, width: 500, height: 728, visible: true, present: true,
    }) })

    width = 640
    act(() => { visualViewport.dispatchEvent(new Event('resize')) })
    await waitFor(() => { expect(setBounds).toHaveBeenLastCalledWith({
      x: 700, y: 72, width: 640, height: 728, visible: true, present: true,
    }) })
  })

  it('opens Review from the panel options once and reopens the same tab after closing', () => {
    window.hydraDesktop = { browser: { setBounds: vi.fn() } }
    stubPanelObservers()
    const createSideSession = vi.fn(async () => 'side' as SessionId)
    const view = render(
      <PanelHarness createSideSession={createSideSession} renderSideChat={() => null} />,
    )
    expect(view.queryByTestId('review-slot')).toBeNull()
    const chooseReview = () => { fireEvent.click(view.getByRole('button', { name: 'Review' })) }
    chooseReview()
    expect(view.getByRole('tab', { name: 'Review' }).getAttribute('aria-selected')).toBe('true')
    expect(view.getByTestId('review-slot')).toBeTruthy()
    chooseReview()
    expect(view.getAllByRole('tab', { name: 'Review' })).toHaveLength(1)
    fireEvent.click(view.getByRole('button', { name: 'Close Review' }))
    expect(view.queryByRole('tab', { name: 'Review' })).toBeNull()
    expect(view.getByRole('tab', { name: 'Browser' }).getAttribute('aria-selected')).toBe('true')
  })

  it('opens Files, multiple Side chat sessions, Browser, and a right Terminal as tabs', async () => {
    const workspaceId = 'workspace-1' as WorkspaceId
    const rootPath = 'C:\\workspace'
    const sourcePath = `${rootPath}\\src`
    let finishRoot!: (value: string) => void
    const files = {
      root: vi.fn((_workspaceId?: string) => new Promise<string>((resolve) => { finishRoot = resolve })),
      list: vi.fn(async (path?: string) => path === sourcePath
        ? [{ name: 'index.ts', path: `${sourcePath}\\index.ts`, directory: false }]
        : [
          { name: 'src', path: sourcePath, directory: true },
          { name: 'README.md', path: `${rootPath}\\README.md`, directory: false },
          { name: 'other.ts', path: `${rootPath}\\other.ts`, directory: false },
        ]),
      search: vi.fn(async () => [
        { name: 'src/index.ts', path: `${sourcePath}\\index.ts`, directory: false },
      ]),
      read: vi.fn(async (path: string) => ({ path, content: 'fixture', version: 'v1' })),
      create: vi.fn(),
      save: vi.fn(),
      format: vi.fn(),
    }
    window.hydraDesktop = { browser: { setBounds: vi.fn() }, files }
    stubPanelObservers()
    const sessionIds = ['side-1', 'side-2'] as SessionId[]
    let nextSession = 0
    const createSideSession = vi.fn(async () => sessionIds[nextSession++]!)
    const renderSideChat = (sessionId: SessionId) => <div>{`Chat ${String(sessionId)}`}</div>
    const onOpen = vi.fn()
    const view = render(
      <PanelHarness
        workspaceId={workspaceId}
        createSideSession={createSideSession}
        renderSideChat={renderSideChat}
        onOpen={onOpen}
      />,
    )
    const choose = (name: 'Files' | 'Side chat' | 'Terminal') => {
      fireEvent.click(view.getByRole('button', { name }))
    }

    expect(view.getByRole('tab', { name: 'Browser' }).getAttribute('aria-selected')).toBe('true')
    choose('Files')
    expect(view.getByRole('tab', { name: 'Files' }).getAttribute('aria-selected')).toBe('true')
    await waitFor(() => { expect(files.root).toHaveBeenCalledWith(workspaceId) })
    await act(async () => { finishRoot(rootPath); await Promise.resolve() })
    const tree = await view.findByRole('tree', { name: 'Workspace files' })
    expect(files.list).toHaveBeenCalledWith(rootPath, workspaceId)
    const filter = view.getByRole('searchbox', { name: 'Filter workspace files' })
    expect(document.activeElement).toBe(filter)
    fireEvent.click(within(tree).getByRole('button', { name: 'README.md' }))
    await waitFor(() => { expect(files.read).toHaveBeenCalledWith(`${rootPath}\\README.md`, workspaceId) })
    expect(view.getByRole('region', { name: 'File editor' }).textContent).toContain('README.md')
    expect((view.getByRole('textbox', { name: 'Editor for README.md' }) as HTMLTextAreaElement).value).toBe('fixture')
    fireEvent.click(within(tree).getByRole('button', { name: 'src' }))
    await waitFor(() => { expect(files.list).toHaveBeenCalledWith(sourcePath, workspaceId) })
    expect(within(tree).getByRole('button', { name: 'index.ts' })).toBeTruthy()
    fireEvent.change(filter, { target: { value: 'index' } })
    await waitFor(() => { expect(files.search).toHaveBeenCalledWith('index', workspaceId) })
    expect(within(tree).getByRole('button', { name: 'src/index.ts' })).toBeTruthy()

    let finishOther!: (value: { path: string; content: string; version: string }) => void
    let finishIndex!: (value: { path: string; content: string; version: string }) => void
    files.read
      .mockImplementationOnce(() => new Promise((resolve) => { finishIndex = resolve }))
      .mockImplementationOnce(() => new Promise((resolve) => { finishOther = resolve }))
    fireEvent.change(filter, { target: { value: '' } })
    fireEvent.click(within(tree).getByRole('button', { name: 'index.ts' }))
    fireEvent.click(within(tree).getByRole('button', { name: 'other.ts' }))
    await waitFor(() => { expect(files.read).toHaveBeenCalledTimes(3) })
    await act(async () => {
      finishOther({ path: `${rootPath}\\other.ts`, content: 'newer', version: 'v3' })
      await Promise.resolve()
      finishIndex({ path: `${sourcePath}\\index.ts`, content: 'older', version: 'v2' })
    })
    expect((view.getByRole('textbox', { name: 'Editor for other.ts' }) as HTMLTextAreaElement).value).toBe('newer')

    let finishOldList!: (value: Array<{ name: string; path: string; directory: boolean }>) => void
    let finishNewList!: (value: Array<{ name: string; path: string; directory: boolean }>) => void
    files.list
      .mockImplementationOnce(() => new Promise((resolve) => { finishOldList = resolve }))
      .mockImplementationOnce(() => new Promise((resolve) => { finishNewList = resolve }))
    fireEvent.click(view.getByRole('button', { name: 'Refresh files' }))
    fireEvent.click(view.getByRole('button', { name: 'Refresh files' }))
    await act(async () => {
      finishNewList([{ name: 'fresh.ts', path: `${rootPath}\\fresh.ts`, directory: false }])
      await Promise.resolve()
      finishOldList([{ name: 'stale.ts', path: `${rootPath}\\stale.ts`, directory: false }])
    })
    expect(within(tree).getByRole('button', { name: 'fresh.ts' })).toBeTruthy()
    expect(within(tree).queryByRole('button', { name: 'stale.ts' })).toBeNull()

    choose('Side chat')
    await waitFor(() => { expect(view.getByRole('tab', { name: 'Side chat' })).toBeTruthy() })
    choose('Side chat')
    await waitFor(() => { expect(view.getByRole('tab', { name: 'Side chat 2' })).toBeTruthy() })

    choose('Terminal')
    choose('Terminal')
    expect(view.getAllByRole('tab').map(tab => tab.textContent)).toEqual([
      'Browser', 'Files', 'Side chat', 'Side chat 2', 'Terminal', 'Terminal 2',
    ])
    expect(view.getByLabelText('Right terminal').getAttribute('data-desktop-panel')).toBe('right-terminal')
    expect(view.getByLabelText('Right terminal 2').getAttribute('data-desktop-panel')).toBe('right-terminal')
    expect(view.getByText('Chat side-1')).toBeTruthy()
    expect(view.getByText('Chat side-2')).toBeTruthy()
    expect(createSideSession).toHaveBeenCalledTimes(2)
    expect(onOpen).toHaveBeenCalledTimes(5)

    fireEvent.click(view.getByRole('tab', { name: 'Files' }))
    const editor = view.getByRole('textbox', { name: 'Editor for other.ts' })
    fireEvent.change(editor, { target: { value: 'dirty' } })
    await view.findByLabelText('Unsaved changes')
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    fireEvent.click(view.getByRole('button', { name: 'Close Files' }))
    expect(view.getByRole('tab', { name: 'Files' })).toBeTruthy()
    expect(confirm).toHaveBeenCalledWith('Discard unsaved file changes?')
    confirm.mockReturnValue(true)
    fireEvent.click(view.getByRole('button', { name: 'Close Files' }))
    expect(view.queryByRole('tab', { name: 'Files' })).toBeNull()
  })

  it('creates independent right Terminal tabs and stops only the closed PTY', async () => {
    const start = vi.fn(async () => ({ running: true }))
    const stop = vi.fn(async () => {})
    const terminal: DesktopTerminalApi = { start, stop, write: vi.fn(), resize: vi.fn(), onEvent: vi.fn(() => () => {}) }
    window.hydraDesktop = { browser: { setBounds: vi.fn() }, terminal }
    stubPanelObservers()
    const view = render(<PanelHarness createSideSession={async () => 'side' as SessionId} renderSideChat={() => null} />)

    fireEvent.click(view.getByRole('button', { name: 'Terminal' }))
    await waitFor(() => { expect(start).toHaveBeenCalledWith('right', expect.anything(), undefined, undefined) })
    fireEvent.click(view.getByRole('button', { name: 'Terminal' }))
    await waitFor(() => { expect(start).toHaveBeenCalledWith('right-2', expect.anything(), undefined, undefined) })
    expect(view.getByRole('tab', { name: 'Terminal 2' })).toBeTruthy()
    expect(view.getByLabelText('Right terminal 2')).toBeTruthy()

    fireEvent.click(view.getByRole('button', { name: 'Close Terminal 2' }))
    await waitFor(() => { expect(stop).toHaveBeenCalledWith('right-2') })
    expect(view.getByRole('tab', { name: 'Terminal' })).toBeTruthy()
    expect(stop).not.toHaveBeenCalledWith('right')
  })

  it('closes each Terminal independently while a new Terminal is opened', async () => {
    const firstStop = Promise.withResolvers<undefined>()
    const secondStop = Promise.withResolvers<undefined>()
    const stop = vi.fn((id: DesktopTerminalId) => id === 'right' ? firstStop.promise : secondStop.promise)
    const start = vi.fn(async () => ({ running: true }))
    const terminal: DesktopTerminalApi = {
      start,
      stop,
      write: vi.fn(), resize: vi.fn(), onEvent: () => () => {},
    }
    window.hydraDesktop = { browser: { setBounds: vi.fn() }, terminal }
    stubPanelObservers()
    const view = render(<PanelHarness createSideSession={async () => 'side' as SessionId} renderSideChat={() => null} />)
    const create = () => { fireEvent.click(view.getByRole('button', { name: 'Terminal' })) }
    create()
    create()
    fireEvent.click(view.getByRole('button', { name: 'Close Terminal' }))
    fireEvent.click(view.getByRole('button', { name: 'Close Terminal 2' }))
    expect(stop).toHaveBeenCalledTimes(2)
    expect(stop).toHaveBeenCalledWith('right')
    expect(stop).toHaveBeenCalledWith('right-2')
    create()
    await waitFor(() => { expect(start).toHaveBeenCalledWith('right-3', expect.anything(), undefined, undefined) })
    expect(view.getByRole('region', { name: 'Right terminal 3' })).toBeTruthy()
    await act(async () => { firstStop.resolve(undefined); secondStop.reject(new Error('busy')) })
    expect(view.queryByRole('tab', { name: 'Terminal' })).toBeNull()
    expect(view.getByRole('tab', { name: 'Terminal 2' })).toBeTruthy()
    expect(view.getByRole('tab', { name: 'Terminal 3' }).getAttribute('aria-selected')).toBe('true')
    expect(view.getByRole('alert').textContent).toContain('Could not close Terminal 2')
  })

  it('keeps the selected panel when a pending Side chat finishes', async () => {
    let finishCreate!: (sessionId: SessionId) => void
    const createSideSession = vi.fn(() => new Promise<SessionId>((resolve) => { finishCreate = resolve }))
    window.hydraDesktop = { browser: { setBounds: vi.fn() } }
    stubPanelObservers()
    const view = render(
      <PanelHarness createSideSession={createSideSession} renderSideChat={() => null} />,
    )

    fireEvent.click(view.getByRole('button', { name: 'Side chat' }))
    fireEvent.click(view.getByRole('button', { name: 'Review' }))
    expect(view.getByRole('tab', { name: 'Review' }).getAttribute('aria-selected')).toBe('true')

    await act(async () => { finishCreate('side' as SessionId); await Promise.resolve() })
    expect(view.getByRole('tab', { name: 'Review' }).getAttribute('aria-selected')).toBe('true')
    expect(view.getByRole('tab', { name: 'Side chat' }).getAttribute('aria-selected')).toBe('false')
  })

  it('creates entries, formats drafts, saves by version, and keeps stale drafts', async () => {
    const workspaceId = 'workspace-edit' as WorkspaceId
    const rootPath = 'C:\\workspace'
    const configPath = `${rootPath}\\config.json`
    const entries = [
      { name: 'config.json', path: configPath, directory: false },
      { name: 'README.md', path: `${rootPath}\\README.md`, directory: false },
    ]
    const files = {
      root: vi.fn(async () => rootPath),
      list: vi.fn(async () => [...entries]),
      search: vi.fn(async () => []),
      read: vi.fn(async (path: string) => path === configPath
        ? { path, content: '{"value":1}', version: 'v-json' }
        : { path, content: '', version: 'v-new' }),
      create: vi.fn(async (parent: string, name: string, kind: 'file' | 'directory') => {
        const entry = { name, path: `${parent}\\${name}`, directory: kind === 'directory' }
        entries.push(entry)
        return entry
      }),
      save: vi.fn(async (path: string) => ({ path, version: 'v-saved' })),
      format: vi.fn(async () => '{\n  "value": 2\n}\n'),
    }
    window.hydraDesktop = { browser: { setBounds: vi.fn() }, files }
    const view = render(
      <DesktopFilesPanel workspaceId={workspaceId} active focusSearch={1} />,
    )
    const tree = await view.findByRole('tree', { name: 'Workspace files' })
    expect(view.container.querySelector('[data-file-icon="data"]')).toBeTruthy()
    expect(view.container.querySelector('[data-file-icon="text"]')).toBeTruthy()

    fireEvent.click(view.getByRole('button', { name: 'New file' }))
    const newFile = view.getByRole('textbox', { name: 'New file name' })
    fireEvent.change(newFile, { target: { value: 'new.ts' } })
    fireEvent.submit(newFile.closest('form')!)
    await waitFor(() => {
      expect(files.create).toHaveBeenCalledWith(rootPath, 'new.ts', 'file', workspaceId)
    })
    expect(await within(tree).findByRole('button', { name: 'new.ts' })).toBeTruthy()

    fireEvent.click(view.getByRole('button', { name: 'New folder' }))
    const newFolder = view.getByRole('textbox', { name: 'New folder name' })
    fireEvent.change(newFolder, { target: { value: 'src' } })
    fireEvent.submit(newFolder.closest('form')!)
    await waitFor(() => {
      expect(files.create).toHaveBeenCalledWith(rootPath, 'src', 'directory', workspaceId)
    })

    fireEvent.click(within(tree).getByRole('button', { name: 'config.json' }))
    const editor = await view.findByRole('textbox', { name: 'Editor for config.json' }) as HTMLTextAreaElement
    const editorRegion = view.getByRole('region', { name: 'File editor' })
    const highlightedJson = () => editorRegion.querySelector<HTMLElement>('[data-editor-highlight="json"] pre.shiki')
    await waitFor(() => { expect(highlightedJson()).not.toBeNull() })
    expect(within(editorRegion).getAllByRole('textbox')).toEqual([editor])
    expect(highlightedJson()!.closest('[data-editor-highlight]')?.hasAttribute('inert')).toBe(true)
    const tokenColors = new Set([...highlightedJson()!.querySelectorAll<HTMLElement>('span[style]')]
      .map(token => token.style.color).filter(color => color.startsWith('var(--shiki-')))
    expect(tokenColors.size).toBeGreaterThan(1)
    fireEvent.change(editor, { target: { value: '{"value":2}' } })
    expect(view.getByLabelText('Unsaved changes')).toBeTruthy()
    await waitFor(() => {
      expect(highlightedJson()?.textContent?.replace(/\u200b$/u, '')).toBe(editor.value)
    })
    fireEvent.click(view.getByRole('button', { name: 'Format' }))
    await waitFor(() => { expect(files.format).toHaveBeenCalledWith(configPath, '{"value":2}', workspaceId) })
    expect(editor.value).toBe('{\n  "value": 2\n}\n')
    await waitFor(() => {
      expect(highlightedJson()?.textContent?.replace(/\u200b$/u, '')).toBe(editor.value)
    })

    fireEvent.keyDown(window, { key: 's', ctrlKey: true })
    await waitFor(() => {
      expect(files.save).toHaveBeenCalledWith(configPath, '{\n  "value": 2\n}\n', 'v-json', workspaceId)
    })
    expect(view.queryByLabelText('Unsaved changes')).toBeNull()

    fireEvent.change(editor, { target: { value: '{"value":3}' } })
    files.save.mockRejectedValueOnce(new Error('file changed since it was opened'))
    fireEvent.keyDown(window, { key: 's', ctrlKey: true })
    expect((await view.findByRole('alert')).textContent).toContain('file changed since it was opened')
    expect(editor.value).toBe('{"value":3}')
    expect(view.getByLabelText('Unsaved changes')).toBeTruthy()

    fireEvent.change(editor, { target: { value: 'x'.repeat(50_001) } })
    await waitFor(() => {
      expect(editorRegion.querySelector('[data-editor-highlight="plain"] > pre')?.textContent).toBe(editor.value)
    })
  })

  it('keeps edits made while file reads and creates are pending', async () => {
    const workspaceId = 'workspace-races' as WorkspaceId
    const rootPath = 'C:\\workspace'
    const firstPath = `${rootPath}\\first.txt`
    const secondPath = `${rootPath}\\second.txt`
    const entries = [
      { name: 'first.txt', path: firstPath, directory: false },
      { name: 'second.txt', path: secondPath, directory: false },
    ]
    let finishRead!: (value: { path: string; content: string; version: string }) => void
    let finishCreate!: (value: { name: string; path: string; directory: boolean }) => void
    const files = {
      root: vi.fn(async () => rootPath),
      list: vi.fn(async () => [...entries]),
      search: vi.fn(async () => []),
      read: vi.fn(async (path: string) => ({ path, content: 'first', version: 'v1' })),
      create: vi.fn(() => new Promise<{ name: string; path: string; directory: boolean }>((resolve) => {
        finishCreate = resolve
      })),
      save: vi.fn(),
      format: vi.fn(),
    }
    window.hydraDesktop = { browser: { setBounds: vi.fn() }, files }
    const view = render(<DesktopFilesPanel workspaceId={workspaceId} active focusSearch={1} />)
    const tree = await view.findByRole('tree', { name: 'Workspace files' })
    fireEvent.click(within(tree).getByRole('button', { name: 'first.txt' }))
    const editor = await view.findByRole('textbox', { name: 'Editor for first.txt' }) as HTMLTextAreaElement

    files.read.mockImplementationOnce(() => new Promise((resolve) => { finishRead = resolve }))
    fireEvent.click(within(tree).getByRole('button', { name: 'second.txt' }))
    fireEvent.change(editor, { target: { value: 'draft while opening' } })
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    await act(async () => {
      finishRead({ path: secondPath, content: 'second', version: 'v2' })
      await Promise.resolve()
    })
    expect(confirm).toHaveBeenCalledWith('Discard unsaved changes and open another file?')
    expect(editor.value).toBe('draft while opening')

    fireEvent.change(editor, { target: { value: 'first' } })
    fireEvent.click(view.getByRole('button', { name: 'New file' }))
    const input = view.getByRole('textbox', { name: 'New file name' })
    fireEvent.change(input, { target: { value: 'created.txt' } })
    fireEvent.submit(input.closest('form')!)
    await waitFor(() => { expect(files.create).toHaveBeenCalledOnce() })
    fireEvent.change(editor, { target: { value: 'draft while creating' } })
    const created = { name: 'created.txt', path: `${rootPath}\\created.txt`, directory: false }
    entries.push(created)
    await act(async () => { finishCreate(created); await Promise.resolve() })
    await within(tree).findByRole('button', { name: 'created.txt' })
    expect((await view.findByRole('textbox', { name: 'Editor for first.txt' }) as HTMLTextAreaElement).value)
      .toBe('draft while creating')
    expect(files.read).toHaveBeenCalledTimes(2)

    fireEvent.change(editor, { target: { value: 'first' } })
    fireEvent.click(view.getByRole('button', { name: 'New file' }))
    const secondInput = view.getByRole('textbox', { name: 'New file name' })
    fireEvent.change(secondInput, { target: { value: 'created-later.txt' } })
    fireEvent.submit(secondInput.closest('form')!)
    await waitFor(() => { expect(files.create).toHaveBeenCalledTimes(2) })
    files.read.mockImplementationOnce(() => new Promise((resolve) => { finishRead = resolve }))
    fireEvent.click(within(tree).getByRole('button', { name: 'second.txt' }))
    const createdLater = { name: 'created-later.txt', path: `${rootPath}\\created-later.txt`, directory: false }
    entries.push(createdLater)
    await act(async () => { finishCreate(createdLater); await Promise.resolve() })
    await within(tree).findByRole('button', { name: 'created-later.txt' })
    expect(files.read).toHaveBeenCalledTimes(3)
    await act(async () => { finishRead({ path: secondPath, content: 'second', version: 'v2' }); await Promise.resolve() })
    expect(await view.findByRole('textbox', { name: 'Editor for second.txt' })).toBeTruthy()
  })

  it('keeps a dirty Workspace mounted until its pending save finishes', async () => {
    const firstWorkspace = 'workspace-first' as WorkspaceId
    const secondWorkspace = 'workspace-second' as WorkspaceId
    const firstRoot = 'C:\\first'
    const secondRoot = 'C:\\second'
    let finishSave!: (value: { path: string; version: string }) => void
    const files = {
      root: vi.fn(async (workspaceId: string) => workspaceId === firstWorkspace ? firstRoot : secondRoot),
      list: vi.fn(async (path: string) => [
        { name: 'file.txt', path: `${path}\\file.txt`, directory: false },
        { name: 'other.txt', path: `${path}\\other.txt`, directory: false },
      ]),
      search: vi.fn(async () => []),
      read: vi.fn(async (path: string) => ({ path, content: 'saved', version: 'v1' })),
      create: vi.fn(),
      save: vi.fn(() => new Promise<{ path: string; version: string }>((resolve) => { finishSave = resolve })),
      format: vi.fn(),
    }
    window.hydraDesktop = { browser: { setBounds: vi.fn() }, files }
    stubPanelObservers()
    const createSideSession = vi.fn(async () => 'side' as SessionId)
    const renderSideChat = () => null
    const view = render(
      <PanelHarness workspaceId={firstWorkspace} createSideSession={createSideSession} renderSideChat={renderSideChat} />,
    )
    fireEvent.click(view.getByRole('button', { name: 'Files' }))
    const tree = await view.findByRole('tree', { name: 'Workspace files' })
    fireEvent.click(within(tree).getByRole('button', { name: 'file.txt' }))
    const editor = await view.findByRole('textbox', { name: 'Editor for file.txt' }) as HTMLTextAreaElement
    let finishPendingRead!: (value: { path: string; content: string; version: string }) => void
    files.read.mockImplementationOnce(() => new Promise((resolve) => { finishPendingRead = resolve }))
    fireEvent.click(within(tree).getByRole('button', { name: 'other.txt' }))
    fireEvent.change(editor, { target: { value: 'draft' } })
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)

    view.rerender(
      <PanelHarness workspaceId={secondWorkspace} createSideSession={createSideSession} renderSideChat={renderSideChat} />,
    )
    await waitFor(() => {
      expect(confirm).toHaveBeenCalledWith('Discard unsaved file changes and switch Workspace?')
    })
    expect(files.root).not.toHaveBeenCalledWith(secondWorkspace)
    expect(editor.value).toBe('draft')

    fireEvent.keyDown(window, { key: 's', ctrlKey: true })
    await waitFor(() => { expect(files.save).toHaveBeenCalledOnce() })
    expect((view.getByRole('button', { name: 'Close Files' }) as HTMLButtonElement).disabled).toBe(true)
    confirm.mockReturnValue(true)
    await act(async () => {
      finishPendingRead({ path: `${firstRoot}\\other.txt`, content: 'other', version: 'other' })
      await Promise.resolve()
    })
    expect(editor.value).toBe('draft')
    confirm.mockReturnValue(false)
    await act(async () => { finishSave({ path: `${firstRoot}\\file.txt`, version: 'v2' }); await Promise.resolve() })
    await waitFor(() => { expect(files.root).toHaveBeenCalledWith(secondWorkspace) })

    const secondTree = await view.findByRole('tree', { name: 'Workspace files' })
    fireEvent.click(within(secondTree).getByRole('button', { name: 'file.txt' }))
    const secondEditor = await view.findByRole('textbox', { name: 'Editor for file.txt' })
    let finishOldRead!: (value: { path: string; content: string; version: string }) => void
    files.read.mockImplementationOnce(() => new Promise((resolve) => { finishOldRead = resolve }))
    fireEvent.click(within(secondTree).getByRole('button', { name: 'other.txt' }))
    fireEvent.change(secondEditor, { target: { value: 'discard this draft' } })
    confirm.mockReturnValue(true)
    view.rerender(
      <PanelHarness workspaceId={firstWorkspace} createSideSession={createSideSession} renderSideChat={renderSideChat} />,
    )
    await waitFor(() => { expect(files.root).toHaveBeenCalledTimes(3) })
    const finalTree = await view.findByRole('tree', { name: 'Workspace files' })
    fireEvent.click(within(finalTree).getByRole('button', { name: 'file.txt' }))
    const finalEditor = await view.findByRole('textbox', { name: 'Editor for file.txt' })
    fireEvent.change(finalEditor, { target: { value: 'new Workspace draft' } })
    await act(async () => {
      finishOldRead({ path: `${secondRoot}\\other.txt`, content: 'old response', version: 'old' })
      await Promise.resolve()
    })
    confirm.mockClear()
    confirm.mockReturnValue(false)
    fireEvent.click(view.getByRole('button', { name: 'Close Files' }))
    expect(confirm).toHaveBeenCalledWith('Discard unsaved file changes?')
    expect(view.getByRole('tab', { name: 'Files' })).toBeTruthy()
  })

  it('moves the tab selection and focus by keyboard and names each surface from its tab', () => {
    window.hydraDesktop = { browser: { setBounds: vi.fn() } }
    stubPanelObservers()
    const view = render(
      <PanelHarness createSideSession={async () => 'side' as SessionId} renderSideChat={() => null} />,
    )
    const choose = (name: string) => { fireEvent.click(view.getByRole('button', { name })) }
    choose('Review')
    choose('Terminal')
    const strip = view.getAllByRole('tab')
    expect(strip.map(tab => tab.textContent)).toEqual(['Browser', 'Review', 'Terminal'])
    // The strip is one tab stop: only the selected tab is focusable.
    expect(strip.map(tab => tab.getAttribute('tabindex'))).toEqual(['-1', '-1', '0'])
    const tab = (name: string) => view.getByRole('tab', { name })
    const terminal = tab('Terminal')
    const surface = document.getElementById(terminal.getAttribute('aria-controls')!)
    expect(surface?.getAttribute('role')).toBe('tabpanel')
    expect(surface?.getAttribute('aria-labelledby')).toBe(terminal.id)
    // Arrows wrap both ways and move focus with the selection; Home/End jump.
    fireEvent.keyDown(terminal, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(tab('Browser'))
    expect(tab('Browser').getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(tab('Browser'), { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(tab('Terminal'))
    fireEvent.keyDown(tab('Terminal'), { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(tab('Review'))
    fireEvent.keyDown(tab('Review'), { key: 'ArrowRight' })
    expect(document.activeElement).toBe(tab('Terminal'))
    fireEvent.keyDown(tab('Terminal'), { key: 'Home' })
    expect(document.activeElement).toBe(tab('Browser'))
    fireEvent.keyDown(tab('Browser'), { key: 'End' })
    expect(document.activeElement).toBe(tab('Terminal'))
    fireEvent.keyDown(tab('Terminal'), { key: 'PageDown' })
    expect(document.activeElement).toBe(tab('Terminal'))
  })

  it('closes the Browser tab when the native browser closes itself', () => {
    let closePanel: ((kind: DesktopPanelShortcut) => void) | undefined
    window.hydraDesktop = {
      browser: { setBounds: vi.fn() },
      panels: {
        onShortcut: () => () => {},
        onClose: (listener) => {
          closePanel = listener
          return () => {}
        },
      },
    }
    stubPanelObservers()
    const view = render(
      <PanelHarness createSideSession={async () => 'side' as SessionId} renderSideChat={() => null} />,
    )
    fireEvent.click(view.getByRole('button', { name: 'Review' }))
    expect(view.getByRole('tab', { name: 'Browser' }).getAttribute('aria-selected')).toBe('false')
    // The user closed the last controlled tab, so the browser hands its panel back.
    act(() => { closePanel?.('browser') })
    expect(view.queryByRole('tab', { name: 'Browser' })).toBeNull()
    expect(view.getByRole('tab', { name: 'Review' }).getAttribute('aria-selected')).toBe('true')
    // A second close is inert instead of closing whatever took over.
    act(() => { closePanel?.('browser') })
    expect(view.queryAllByRole('tab')).toHaveLength(1)
  })

  it('reopens Browser from a shortcut after its native tab was closed', () => {
    let sendShortcut: ((kind: DesktopPanelShortcut) => void) | undefined
    window.hydraDesktop = {
      browser: { setBounds: vi.fn() },
      panels: {
        onShortcut: (listener) => {
          sendShortcut = listener
          return () => {}
        },
        onClose: (_listener) => {
          return () => {}
        },
      },
    }
    stubPanelObservers()
    const view = render(
      <PanelHarness createSideSession={async () => 'side' as SessionId} renderSideChat={() => null} />,
    )
    fireEvent.click(view.getByRole('button', { name: 'Close Browser' }))
    expect(view.queryByRole('tab', { name: 'Browser' })).toBeNull()

    act(() => { sendShortcut?.('browser') })
    expect(view.getByRole('tab', { name: 'Browser' }).getAttribute('aria-selected')).toBe('true')
  })

  it('stops the right Terminal once and hands focus to the tab that takes over', async () => {
    window.hydraDesktop = { browser: { setBounds: vi.fn() } }
    stubPanelObservers()
    const view = render(
      <PanelHarness createSideSession={async () => 'side' as SessionId} renderSideChat={() => null} />,
    )
    fireEvent.click(view.getByRole('button', { name: 'Terminal' }))
    // The Terminal bridge arrives after mount, so the surface stays inert while
    // the tab exists and the close path still reads the bridge at click time.
    const stop = vi.fn(async () => {})
    window.hydraDesktop.terminal = {
      stop,
      start: vi.fn(async () => ({ running: true })),
      resize: vi.fn(),
      write: vi.fn(),
      onEvent: () => () => {},
    }
    const close = view.getByRole('button', { name: 'Close Terminal' })
    close.focus()
    fireEvent.click(close)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(stop).toHaveBeenCalledWith('right')
    await waitFor(() => { expect(view.queryByRole('tab', { name: 'Terminal' })).toBeNull() })
    expect(document.activeElement).toBe(view.getByRole('tab', { name: 'Browser' }))
  })

  it('keeps the selection when a background tab closes and empties the panel with the last one', () => {
    window.hydraDesktop = { browser: { setBounds: vi.fn() } }
    stubPanelObservers()
    const view = render(
      <PanelHarness createSideSession={async () => 'side' as SessionId} renderSideChat={() => null} />,
    )
    fireEvent.click(view.getByRole('button', { name: 'Review' }))
    fireEvent.click(view.getByRole('button', { name: 'Close Browser' }))
    expect(view.queryByRole('tab', { name: 'Browser' })).toBeNull()
    expect(view.getByRole('tab', { name: 'Review' }).getAttribute('aria-selected')).toBe('true')
    fireEvent.click(view.getByRole('button', { name: 'Close Review' }))
    expect(view.queryAllByRole('tab')).toHaveLength(0)
    expect(view.getByText('No panel is open.')).toBeTruthy()
  })

  it('uses the current labels and pressed state for independent desktop controls', () => {
    const onToggleBrowser = vi.fn()
    const onToggleTerminal = vi.fn()
    const onToggleExpanded = vi.fn()
    const view = render(
      <DesktopPanelControls
        browserOpen
        terminalOpen
        browserExpanded={false}
        onToggleBrowser={onToggleBrowser}
        onToggleTerminal={onToggleTerminal}
        onToggleExpanded={onToggleExpanded}
      />,
    )
    expect(view.getByLabelText('Toggle right panel').getAttribute('aria-pressed')).toBe('true')
    expect(view.getByLabelText('Toggle bottom terminal').getAttribute('aria-pressed')).toBe('true')
    expect(view.getByLabelText('Expand right panel').getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(view.getByLabelText('Toggle right panel'))
    fireEvent.click(view.getByLabelText('Toggle bottom terminal'))
    fireEvent.click(view.getByLabelText('Expand right panel'))
    expect(onToggleBrowser).toHaveBeenCalledOnce()
    expect(onToggleTerminal).toHaveBeenCalledOnce()
    expect(onToggleExpanded).toHaveBeenCalledOnce()
  })

  it('keeps a later panel selection when Side chat finishes, even after returning to the original tab', async () => {
    window.hydraDesktop = { browser: { setBounds: vi.fn() } }
    stubPanelObservers()
    let finish!: (id: SessionId) => void
    const view = render(
      <PanelHarness createSideSession={() => new Promise((resolve) => { finish = resolve })} renderSideChat={() => null} />,
    )
    fireEvent.click(view.getByRole('button', { name: 'Side chat' }))
    expect(view.getByRole('status').textContent).toBe('Creating side chat…')
    fireEvent.click(view.getByRole('button', { name: 'Review' }))
    fireEvent.click(view.getByRole('tab', { name: 'Browser' }))
    await act(async () => { finish('side-late' as SessionId) })
    expect(view.getByRole('tab', { name: 'Browser' }).getAttribute('aria-selected')).toBe('true')
    expect(view.getByRole('tab', { name: 'Side chat' }).getAttribute('aria-selected')).toBe('false')
    expect(view.queryByRole('status')).toBeNull()
  })

  it('closes tabs with Delete and returns keyboard focus to the empty panel choices', () => {
    window.hydraDesktop = { browser: { setBounds: vi.fn() } }
    stubPanelObservers()
    const view = render(<PanelHarness createSideSession={async () => 'side' as SessionId} renderSideChat={() => null} />)
    const browser = view.getByRole('tab', { name: 'Browser' })
    browser.focus()
    fireEvent.keyDown(browser, { key: 'Delete' })
    expect(view.queryAllByRole('tab')).toHaveLength(0)
    expect(document.activeElement).toBe(view.getByRole('button', { name: 'Files' }))
    expect(view.getByText('Browse and edit workspace files.')).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: 'Browser' }))
    expect(view.getByRole('tab', { name: 'Browser' }).getAttribute('aria-selected')).toBe('true')
  })

  it('retains Terminal when stopping fails and preserves tabs opened while stopping', async () => {
    let rejectStop!: (reason: Error) => void
    const stop = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectStop = reject }))
    const terminal: DesktopTerminalApi = {
      stop,
      start: vi.fn(async () => ({ running: true })),
      resize: vi.fn(),
      write: vi.fn(),
      onEvent: () => () => {},
    }
    window.hydraDesktop = { browser: { setBounds: vi.fn() }, terminal }
    stubPanelObservers()
    const view = render(<PanelHarness createSideSession={async () => 'side' as SessionId} renderSideChat={() => null} />)
    fireEvent.click(view.getByRole('button', { name: 'Terminal' }))
    const close = view.getByRole('button', { name: 'Close Terminal' }) as HTMLButtonElement
    fireEvent.click(close)
    expect(close.disabled).toBe(true)
    fireEvent.click(view.getByRole('button', { name: 'Review' }))
    await act(async () => { rejectStop(new Error('stop unavailable')) })
    expect(view.getByRole('alert').textContent).toContain('Could not close Terminal')
    expect(view.getByRole('tab', { name: 'Terminal' })).toBeTruthy()
    expect(view.getByRole('tab', { name: 'Review' }).getAttribute('aria-selected')).toBe('true')
    fireEvent.click(view.getByRole('button', { name: 'Dismiss panel error' }))
    expect(view.queryByRole('alert')).toBeNull()
    let finishStop!: () => void
    stop.mockImplementationOnce(() => new Promise((resolve) => { finishStop = resolve }))
    fireEvent.click(close)
    fireEvent.click(view.getByRole('button', { name: 'Side chat' }))
    await view.findByRole('tab', { name: 'Side chat' })
    await act(async () => { finishStop() })
    expect(view.queryByRole('tab', { name: 'Terminal' })).toBeNull()
    expect(view.getByRole('tab', { name: 'Side chat' }).getAttribute('aria-selected')).toBe('true')
  })

  it('opens a new terminal tab when clicking New Terminal inside the terminal panel', async () => {
    const terminal: DesktopTerminalApi = {
      start: vi.fn(async () => ({ running: true })),
      stop: vi.fn(async () => {}),
      resize: vi.fn(),
      write: vi.fn(),
      onEvent: () => () => {},
    }
    window.hydraDesktop = { browser: { setBounds: vi.fn() }, terminal }
    stubPanelObservers()
    const view = render(<PanelHarness createSideSession={async () => 'side' as SessionId} renderSideChat={() => null} />)
    fireEvent.click(view.getByRole('button', { name: 'Terminal' }))
    expect(view.getByRole('tab', { name: 'Terminal' }).getAttribute('aria-selected')).toBe('true')

    const newTerminalBtn = view.getByRole('button', { name: 'New Terminal' })
    fireEvent.click(newTerminalBtn)

    expect(view.getByRole('tab', { name: 'Terminal 2' }).getAttribute('aria-selected')).toBe('true')
    expect(view.getAllByRole('tab').map(tab => tab.textContent)).toEqual([
      'Browser', 'Terminal', 'Terminal 2',
    ])
  })
})

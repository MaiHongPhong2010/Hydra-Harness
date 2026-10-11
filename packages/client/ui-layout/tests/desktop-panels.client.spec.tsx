// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { DesktopFilesPanel } from '@hydraharness/harness-client-ui-layout/src/client/DesktopFilesPanel.tsx'
import { DesktopTerminalPanel } from '@hydraharness/harness-client-ui-layout/src/client/DesktopTerminalPanel.tsx'

interface MockTerminalInstance {
  options: { theme?: Record<string, string> }
  cols: number
  rows: number
  disposed: boolean
  selection: string
  setSelection(text: string): void
  keyHandler?: (e: KeyboardEvent) => boolean
}

const terminalInstances = vi.hoisted(() => [] as MockTerminalInstance[])

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options: { theme?: Record<string, string> }
    cols = 80
    rows = 24
    disposed = false
    selection = ''
    selectionListeners: Array<() => void> = []
    keyHandler?: (e: KeyboardEvent) => boolean
    constructor(options: { theme?: Record<string, string> }) {
      this.options = options
      terminalInstances.push(this)
    }
    loadAddon(): void {}
    open(): void {}
    onData(): { dispose(): void } { return { dispose() {} } }
    write(): void {}
    writeln(): void {}
    focus(): void {}
    getSelection(): string { return this.selection }
    setSelection(text: string): void {
      this.selection = text
      for (const listener of this.selectionListeners) listener()
    }
    onSelectionChange(fn: () => void): { dispose(): void } {
      this.selectionListeners.push(fn)
      return { dispose: () => { this.selectionListeners = this.selectionListeners.filter(l => l !== fn) } }
    }
    attachCustomKeyEventHandler(handler: (e: KeyboardEvent) => boolean): void {
      this.keyHandler = handler
    }
    dispose(): void { this.disposed = true }
  },
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit(): void {}
  },
}))

function stubObservers(): void {
  vi.stubGlobal('ResizeObserver', class {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(): void { this.callback([], this as unknown as ResizeObserver) }
    disconnect(): void {}
  })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0)
    return 1
  })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
}

afterEach(() => {
  cleanup()
  terminalInstances.length = 0
  document.body.removeAttribute('data-ds-dark-theme')
  document.body.style.removeProperty('--dsw-alias-bg-base')
  document.body.style.removeProperty('--dsw-alias-label-primary')
  delete window.hydraDesktop
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('DesktopTerminalPanel', () => {
  it('serializes starts and keeps restart available after an exit', async () => {
    stubObservers()
    let finishStart!: (state: { running: boolean }) => void
    let onEvent!: (event: { type: 'data'; data: string } | { type: 'exit'; code: number | null }) => void
    const api = {
      start: vi.fn(() => new Promise<{ running: boolean }>((resolve) => { finishStart = resolve })),
      stop: vi.fn(async () => {}),
      write: vi.fn(),
      resize: vi.fn(),
      onEvent: vi.fn((_id: 'bottom' | 'right', listener: typeof onEvent) => {
        onEvent = listener
        return () => {}
      }),
    }
    window.hydraDesktop = { browser: { setBounds: vi.fn() }, terminal: api }

    const view = render(<DesktopTerminalPanel onEmpty={() => {}} onNewTerminal={() => {}} open terminalId="right" embedded />)
    await waitFor(() => { expect(api.start).toHaveBeenCalledOnce() })
    expect(view.getAllByText('Starting…')).toHaveLength(2)
    expect((view.getByRole('button', { name: 'Starting…' }) as HTMLButtonElement).disabled).toBe(true)

    await act(async () => { finishStart({ running: true }); await Promise.resolve() })
    expect(view.getByText('Running')).toBeTruthy()
    act(() => { onEvent({ type: 'exit', code: 7 }) })
    expect(view.getByText('Exited (7)')).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: 'Restart' }))
    await waitFor(() => { expect(api.start).toHaveBeenCalledTimes(2) })
  })

  it('updates xterm colors when the document theme changes and disconnects on cleanup', async () => {
    stubObservers()
    const api = {
      start: vi.fn(async () => ({ running: true })),
      stop: vi.fn(async () => {}),
      write: vi.fn(),
      resize: vi.fn(),
      onEvent: vi.fn(() => () => {}),
    }
    window.hydraDesktop = { browser: { setBounds: vi.fn() }, terminal: api }
    document.body.style.setProperty('--dsw-alias-bg-base', '#ffffff')
    document.body.style.setProperty('--dsw-alias-label-primary', '#111111')
    const view = render(
      <>
        <DesktopTerminalPanel onEmpty={() => {}} onNewTerminal={() => {}} open terminalId="bottom" />
        <DesktopTerminalPanel onEmpty={() => {}} onNewTerminal={() => {}} open terminalId="right" embedded />
      </>,
    )
    await waitFor(() => { expect(api.start).toHaveBeenCalledTimes(2) })
    expect(terminalInstances).toHaveLength(2)
    expect(terminalInstances.map(instance => instance.options.theme?.background)).toEqual(['#ffffff', '#ffffff'])
    await act(async () => {
      document.body.style.setProperty('--dsw-alias-bg-base', '#151517')
      document.body.style.setProperty('--dsw-alias-label-primary', '#f4f4f5')
      document.body.setAttribute('data-ds-dark-theme', '')
      await Promise.resolve()
    })
    expect(terminalInstances.map(instance => instance.options.theme?.background)).toEqual(['#151517', '#151517'])
    expect(terminalInstances.map(instance => instance.options.theme?.foreground)).toEqual(['#f4f4f5', '#f4f4f5'])
    expect(terminalInstances).toHaveLength(2)
    expect(terminalInstances.every(instance => !instance.disposed)).toBe(true)
    expect(api.start).toHaveBeenCalledTimes(2)
    expect(api.stop).not.toHaveBeenCalled()
    view.unmount()
    const themesAfterUnmount = terminalInstances.map(instance => instance.options.theme)
    document.body.style.setProperty('--dsw-alias-bg-base', '#ffffff')
    await Promise.resolve()
    terminalInstances.forEach((instance, index) => {
      expect(instance.options.theme).toBe(themesAfterUnmount[index])
    })
  })

  it('renders header toolbar with Terminals title, Project dropdown, and sidebar toggle', async () => {
    stubObservers()
    const api = {
      start: vi.fn(async () => ({ running: true })),
      stop: vi.fn(async () => {}),
      write: vi.fn(),
      resize: vi.fn(),
      onEvent: vi.fn(() => () => {}),
    }
    window.hydraDesktop = { browser: { setBounds: vi.fn() }, terminal: api }

    const view = render(<DesktopTerminalPanel onEmpty={() => {}} onNewTerminal={() => {}} open terminalId="bottom" sessionTitle="Sửa Lỗi Kỹ Thuật" />)
    await waitFor(() => { expect(api.start).toHaveBeenCalledOnce() })

    // Header controls
    expect(view.getByText('Terminals')).toBeTruthy()
    expect(view.getByRole('button', { name: 'Project profile' })).toBeTruthy()
    expect(view.getByRole('button', { name: 'New Terminal' })).toBeTruthy()
    const toggleBtn = view.getByRole('button', { name: 'Toggle Sidebar' })
    expect(toggleBtn).toBeTruthy()

    // Sidebar initially open
    expect(view.getByRole('complementary', { name: 'Terminal processes' })).toBeTruthy()
    expect(view.getByText('Conversations')).toBeTruthy()
    expect(view.getByText('Sửa Lỗi Kỹ Thuật')).toBeTruthy()

    // Toggle sidebar to hide
    fireEvent.click(toggleBtn)
    expect(view.queryByRole('complementary', { name: 'Terminal processes' })).toBeNull()

    // Toggle sidebar to show again
    fireEvent.click(toggleBtn)
    expect(view.getByRole('complementary', { name: 'Terminal processes' })).toBeTruthy()
  })

  it('calls onNewTerminal when New Terminal button is clicked with callback', async () => {
    stubObservers()
    const api = {
      start: vi.fn(async () => ({ running: true })),
      stop: vi.fn(async () => {}),
      write: vi.fn(),
      resize: vi.fn(),
      onEvent: vi.fn(() => () => {}),
    }
    window.hydraDesktop = { browser: { setBounds: vi.fn() }, terminal: api }
    const onNewTerminal = vi.fn()

    const view = render(
      <DesktopTerminalPanel
        open
        terminalId="right"
        sessionTitle="Sửa Lỗi Kỹ Thuật"
        onEmpty={() => {}} onNewTerminal={onNewTerminal}
      />,
    )
    await waitFor(() => { expect(api.start).toHaveBeenCalledOnce() })

    const newTerminalBtn = view.getByRole('button', { name: 'New Terminal' })
    fireEvent.click(newTerminalBtn)
    expect(onNewTerminal).toHaveBeenCalledOnce()
  })

  it('supports splitting and killing terminal panes', async () => {
    stubObservers()
    const api = {
      start: vi.fn(async () => ({ running: true })),
      stop: vi.fn(async () => {}),
      write: vi.fn(),
      resize: vi.fn(),
      onEvent: vi.fn(() => () => {}),
    }
    window.hydraDesktop = { browser: { setBounds: vi.fn() }, terminal: api }

    const view = render(<DesktopTerminalPanel onEmpty={() => {}} onNewTerminal={() => {}} open terminalId="bottom" sessionTitle="Sửa Lỗi Kỹ Thuật" />)
    await waitFor(() => { expect(api.start).toHaveBeenCalledTimes(1) })

    // Initial pane in sidebar
    const initialSplitBtn = view.getByRole('button', { name: 'Split Terminal' })
    expect(initialSplitBtn).toBeTruthy()

    // Click split terminal
    fireEvent.click(initialSplitBtn)
    await waitFor(() => { expect(api.start).toHaveBeenCalledTimes(2) })

    // Two panes now exist in the list
    const splitBtns = view.getAllByRole('button', { name: 'Split Terminal' })
    expect(splitBtns).toHaveLength(2)

    // Kill the second pane
    const killBtns = view.getAllByRole('button', { name: /Kill/ })
    expect(killBtns).toHaveLength(2)
    fireEvent.click(killBtns[1]!)

    expect(api.stop).toHaveBeenCalledWith('bottom-1-2')
    // After kill, only 1 pane remains
    await waitFor(() => { expect(view.getAllByRole('button', { name: 'Split Terminal' })).toHaveLength(1) })
    expect(api.start).toHaveBeenCalledTimes(2)
  })

  it('keeps the last pane until stopping succeeds and allows retry after failure', async () => {
    stubObservers()
    const pending = Promise.withResolvers<undefined>()
    const stop = vi.fn(() => pending.promise)
    const onEmpty = vi.fn()
    window.hydraDesktop = {
      browser: { setBounds: vi.fn() },
      terminal: {
        start: vi.fn(async () => ({ running: true })), stop,
        write: vi.fn(), resize: vi.fn(), onEvent: vi.fn(() => () => {}),
      },
    }
    const view = render(<DesktopTerminalPanel open onNewTerminal={() => {}} onEmpty={onEmpty} />)
    await waitFor(() => { expect(view.getByText('Running')).toBeTruthy() })
    fireEvent.click(view.getByRole('button', { name: /Kill/ }))
    expect((view.getByRole('button', { name: /Kill/ }) as HTMLButtonElement).disabled).toBe(true)
    expect(view.queryByText('Exited (0)')).toBeNull()
    expect(onEmpty).not.toHaveBeenCalled()
    await act(async () => { pending.reject(new Error('stop failed')) })
    expect(view.getByRole('alert').textContent).toContain('stop failed')
    expect(view.getByRole('button', { name: /Kill/ })).toBeTruthy()
    expect(onEmpty).not.toHaveBeenCalled()

    stop.mockResolvedValueOnce(undefined)
    fireEvent.click(view.getByRole('button', { name: /Kill/ }))
    await waitFor(() => { expect(onEmpty).toHaveBeenCalledOnce() })
    expect(view.queryByRole('button', { name: /Kill/ })).toBeNull()
    expect(view.queryByRole('alert')).toBeNull()
  })

  it('supports splitting in embedded tab terminal with monotonic sub-pane IDs and unmount cleanup', async () => {
    stubObservers()
    const api = {
      start: vi.fn(async () => ({ running: true })),
      stop: vi.fn(async () => {}),
      write: vi.fn(),
      resize: vi.fn(),
      onEvent: vi.fn(() => () => {}),
    }
    window.hydraDesktop = { browser: { setBounds: vi.fn() }, terminal: api }

    const view = render(<DesktopTerminalPanel onEmpty={() => {}} onNewTerminal={() => {}} open terminalId="right-4" embedded />)
    await waitFor(() => { expect(api.start).toHaveBeenCalledWith('right-4', expect.any(Object), undefined, undefined) })

    const splitBtn = view.getByRole('button', { name: 'Split Terminal' })
    fireEvent.click(splitBtn)
    await waitFor(() => { expect(api.start).toHaveBeenCalledWith('right-4-2', expect.any(Object), undefined, undefined) })

    const splitBtns = view.getAllByRole('button', { name: 'Split Terminal' })
    fireEvent.click(splitBtns[0]!)
    await waitFor(() => { expect(api.start).toHaveBeenCalledWith('right-4-3', expect.any(Object), undefined, undefined) })

    // Kill the second pane (right-4-2)
    const killBtns = view.getAllByRole('button', { name: /Kill/ })
    expect(killBtns).toHaveLength(3)
    fireEvent.click(killBtns[1]!)
    expect(api.stop).toHaveBeenCalledWith('right-4-2')
    await waitFor(() => { expect(view.getAllByRole('button', { name: /Kill/ })).toHaveLength(2) })

    // Split again should generate next monotonic ID right-4-4 without colliding with right-4-3
    const remainingSplitBtns = view.getAllByRole('button', { name: 'Split Terminal' })
    fireEvent.click(remainingSplitBtns[0]!)
    await waitFor(() => { expect(api.start).toHaveBeenCalledWith('right-4-4', expect.any(Object), undefined, undefined) })

    // Unmounting cleans up all open split panes
    view.unmount()
    expect(api.stop).toHaveBeenCalledWith('right-4-3')
    expect(api.stop).toHaveBeenCalledWith('right-4-4')
  })

  it('generates right-1-2 for split right terminal without colliding with tab 2', async () => {
    stubObservers()
    const api = {
      start: vi.fn(async () => ({ running: true })),
      stop: vi.fn(async () => {}),
      write: vi.fn(),
      resize: vi.fn(),
      onEvent: vi.fn(() => () => {}),
    }
    window.hydraDesktop = { browser: { setBounds: vi.fn() }, terminal: api }

    const view = render(<DesktopTerminalPanel onEmpty={() => {}} onNewTerminal={() => {}} open terminalId="right" embedded />)
    await waitFor(() => { expect(api.start).toHaveBeenCalledWith('right', expect.any(Object), undefined, undefined) })

    const splitBtn = view.getByRole('button', { name: 'Split Terminal' })
    fireEvent.click(splitBtn)
    await waitFor(() => { expect(api.start).toHaveBeenCalledWith('right-1-2', expect.any(Object), undefined, undefined) })
  })

  it('supports quoting selected terminal text into chat session', async () => {
    stubObservers()
    const onQuote = vi.fn()
    const emitAnnotation = vi.fn()
    const api = {
      start: vi.fn(async () => ({ running: true })),
      stop: vi.fn(async () => {}),
      write: vi.fn(),
      resize: vi.fn(),
      onEvent: vi.fn(() => () => {}),
    }
    window.hydraDesktop = {
      browser: { setBounds: vi.fn(), emitAnnotation },
      terminal: api,
    }

    const view = render(
      <DesktopTerminalPanel
        open
        terminalId="bottom"
        onEmpty={() => {}} onNewTerminal={() => {}}
        sessionTitle="Sửa Lỗi Kỹ Thuật"
        onQuote={onQuote}
      />,
    )
    await waitFor(() => { expect(api.start).toHaveBeenCalledOnce() })

    // Simulate selection in xterm
    const terminal = terminalInstances.at(-1)
    expect(terminal).toBeDefined()
    act(() => {
      terminal?.setSelection('echo "Hello Hydra"')
    })

    // Quote Ctrl+L pill should appear
    await waitFor(() => {
      expect(view.getByRole('button', { name: 'Quote Ctrl+L' })).toBeTruthy()
    })

    // Click the Quote pill button
    fireEvent.click(view.getByRole('button', { name: 'Quote Ctrl+L' }))

    // Expect quote callback and emitAnnotation to be called
    expect(onQuote).toHaveBeenCalledWith('echo "Hello Hydra"')
    expect(emitAnnotation).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'browser-element',
      preview: 'echo "Hello Hydra"',
    }))

    // Popover should be dismissed
    expect(view.queryByRole('button', { name: 'Quote Ctrl+L' })).toBeNull()
  })
})

describe('DesktopFilesPanel', () => {
  it('does not display an old workspace while the new root is loading', async () => {
    const roots = new Map<string, (path: string) => void>()
    const files = {
      root: vi.fn((workspaceId: string) => new Promise<string>((resolve) => { roots.set(workspaceId, resolve) })),
      list: vi.fn(async (path: string) => [{ name: 'file.txt', path: `${path}\\file.txt`, directory: false }]),
      search: vi.fn(async () => []),
      read: vi.fn(async (path: string) => ({ path, content: '', version: 'v1' })),
      create: vi.fn(),
      save: vi.fn(),
      format: vi.fn(),
    }
    window.hydraDesktop = { browser: { setBounds: vi.fn() }, files }
    const first = 'workspace-first'
    const second = 'workspace-second'
    const view = render(<DesktopFilesPanel workspaceId={first} active focusSearch={1} />)
    await waitFor(() => { expect(files.root).toHaveBeenCalledWith(first) })
    view.rerender(<DesktopFilesPanel workspaceId={second} active focusSearch={1} />)
    await waitFor(() => { expect(files.root).toHaveBeenCalledWith(second) })
    await act(async () => { roots.get(first)?.('C:\\first'); await Promise.resolve() })
    expect(view.queryByRole('tree', { name: 'Workspace files' })).toBeNull()
    await act(async () => { roots.get(second)?.('C:\\second'); await Promise.resolve() })
    expect(await view.findByRole('tree', { name: 'Workspace files' })).toBeTruthy()
    expect(within(view.getByRole('tree', { name: 'Workspace files' })).getByRole('button', { name: 'file.txt' })).toBeTruthy()
  })

  it('prevents duplicate create requests from rapid submits', async () => {
    const rootPath = 'C:\\workspace'
    let finishCreate!: (entry: { name: string; path: string; directory: boolean }) => void
    const files = {
      root: vi.fn(async () => rootPath),
      list: vi.fn(async () => []),
      search: vi.fn(async () => []),
      read: vi.fn(async (path: string) => ({ path, content: '', version: 'v1' })),
      create: vi.fn(() => new Promise<{ name: string; path: string; directory: boolean }>((resolve) => { finishCreate = resolve })),
      save: vi.fn(),
      format: vi.fn(),
    }
    window.hydraDesktop = { browser: { setBounds: vi.fn() }, files }
    const view = render(<DesktopFilesPanel workspaceId="workspace" active focusSearch={1} />)
    await view.findByRole('tree', { name: 'Workspace files' })
    fireEvent.click(view.getByRole('button', { name: 'New file' }))
    const input = view.getByRole('textbox', { name: 'New file name' })
    fireEvent.change(input, { target: { value: 'new.ts' } })
    const form = input.closest('form')!
    fireEvent.submit(form)
    fireEvent.submit(form)
    expect(files.create).toHaveBeenCalledOnce()
    await act(async () => {
      finishCreate({ name: 'new.ts', path: `${rootPath}\\new.ts`, directory: false })
      await Promise.resolve()
    })
  })

  it('shows a create error when the desktop request is rejected', async () => {
    const rootPath = 'C:\\workspace'
    const files = {
      root: vi.fn(async () => rootPath),
      list: vi.fn(async () => []),
      search: vi.fn(async () => []),
      read: vi.fn(async (path: string) => ({ path, content: '', version: 'v1' })),
      create: vi.fn(async () => { throw new Error('create failed') }),
      save: vi.fn(),
      format: vi.fn(),
    }
    window.hydraDesktop = { browser: { setBounds: vi.fn() }, files }
    const view = render(<DesktopFilesPanel workspaceId="workspace" active focusSearch={1} />)
    await view.findByRole('tree', { name: 'Workspace files' })
    fireEvent.click(view.getByRole('button', { name: 'New file' }))
    const input = view.getByRole('textbox', { name: 'New file name' })
    fireEvent.change(input, { target: { value: 'failed.ts' } })
    fireEvent.submit(input.closest('form')!)
    expect((await view.findByRole('alert')).textContent).toContain('create failed')
  })

  it('ignores an older directory request after a newer refresh starts', async () => {
    const rootPath = 'C:\\workspace'
    const listRequests: Array<{ resolve: (entries: Array<{ name: string; path: string; directory: boolean }>) => void }> = []
    const files = {
      root: vi.fn(async () => rootPath),
      list: vi.fn(() => new Promise<Array<{ name: string; path: string; directory: boolean }>>((resolve) => {
        listRequests.push({ resolve })
      })),
      search: vi.fn(async () => []),
      read: vi.fn(async (path: string) => ({ path, content: '', version: 'v1' })),
      create: vi.fn(),
      save: vi.fn(),
      format: vi.fn(),
    }
    window.hydraDesktop = { browser: { setBounds: vi.fn() }, files }
    const view = render(<DesktopFilesPanel workspaceId="workspace" active focusSearch={1} />)
    await waitFor(() => { expect(files.list).toHaveBeenCalledOnce() })
    await act(async () => {
      listRequests[0]?.resolve([{ name: 'initial.txt', path: `${rootPath}\\initial.txt`, directory: false }])
      await Promise.resolve()
    })
    expect(view.getByRole('button', { name: 'initial.txt' })).toBeTruthy()

    fireEvent.click(view.getByRole('button', { name: 'Refresh files' }))
    fireEvent.click(view.getByRole('button', { name: 'Refresh files' }))
    expect(files.list).toHaveBeenCalledTimes(3)
    await act(async () => {
      listRequests[2]?.resolve([{ name: 'newest.txt', path: `${rootPath}\\newest.txt`, directory: false }])
      await Promise.resolve()
    })
    fireEvent.click(view.getByRole('button', { name: 'Refresh files' }))
    expect(files.list).toHaveBeenCalledTimes(4)
    await act(async () => {
      listRequests[1]?.resolve([{ name: 'old.txt', path: `${rootPath}\\old.txt`, directory: false }])
      await Promise.resolve()
    })
    expect(view.getByRole('button', { name: 'newest.txt' })).toBeTruthy()
    expect(view.queryByRole('button', { name: 'old.txt' })).toBeNull()

    await act(async () => {
      listRequests[3]?.resolve([{ name: 'current.txt', path: `${rootPath}\\current.txt`, directory: false }])
      await Promise.resolve()
    })
    expect(view.getByRole('button', { name: 'current.txt' })).toBeTruthy()
    expect(view.queryByRole('button', { name: 'newest.txt' })).toBeNull()
  })

  it('keeps workspace entries predictable with folders first and natural name order', async () => {
    const rootPath = 'C:\\workspace'
    const files = {
      root: vi.fn(async () => rootPath),
      list: vi.fn(async () => [
        { name: 'file10.ts', path: `${rootPath}\\file10.ts`, directory: false },
        { name: 'zeta', path: `${rootPath}\\zeta`, directory: true },
        { name: 'file2.ts', path: `${rootPath}\\file2.ts`, directory: false },
        { name: 'Alpha', path: `${rootPath}\\Alpha`, directory: true },
      ]),
      search: vi.fn(async () => []),
      read: vi.fn(async (path: string) => ({ path, content: '', version: 'v1' })),
      create: vi.fn(),
      save: vi.fn(),
      format: vi.fn(),
    }
    window.hydraDesktop = { browser: { setBounds: vi.fn() }, files }
    const view = render(<DesktopFilesPanel workspaceId="workspace" active focusSearch={1} />)
    await view.findByRole('tree', { name: 'Workspace files' })

    const items = within(view.getByRole('tree')).getAllByRole('treeitem')
    expect(items.map(item => item.textContent?.trim())).toEqual(['Alpha', 'zeta', 'file2.ts', 'file10.ts'])
  })

  it('moves a file when dropped onto a folder', async () => {
    const rootPath = 'C:\\workspace'
    const folderPath = `${rootPath}\\src`
    const moveFn = vi.fn(async (path: string) => ({
      oldPath: path,
      path: `${folderPath}\\file.ts`,
      name: 'file.ts',
      directory: false,
    }))
    const files = {
      root: vi.fn(async () => rootPath),
      list: vi.fn(async () => [
        { name: 'file.ts', path: `${rootPath}\\file.ts`, directory: false },
        { name: 'src', path: folderPath, directory: true },
      ]),
      search: vi.fn(async () => []),
      read: vi.fn(async (path: string) => ({ path, content: '', version: 'v1' })),
      create: vi.fn(),
      move: moveFn,
      save: vi.fn(),
      format: vi.fn(),
    }
    window.hydraDesktop = { browser: { setBounds: vi.fn() }, files }
    const view = render(<DesktopFilesPanel workspaceId="workspace" active focusSearch={1} />)
    const tree = await view.findByRole('tree', { name: 'Workspace files' })
    const file = within(tree).getByRole('button', { name: 'file.ts' })
    const folder = within(tree).getByRole('button', { name: 'src' })
    const dataTransfer = { effectAllowed: '', dropEffect: '', setData: vi.fn(), getData: vi.fn(() => `${rootPath}\\file.ts`) }
    fireEvent.dragStart(file, { dataTransfer })
    fireEvent.dragOver(folder, { dataTransfer })
    fireEvent.drop(folder, { dataTransfer })
    await waitFor(() => {
      expect(moveFn).toHaveBeenCalledWith(`${rootPath}\\file.ts`, folderPath, 'workspace')
    })
  })

  it('supports multi-document tabs, switching tabs, and closing tabs', async () => {
    const rootPath = 'C:\\workspace'
    const files = {
      root: vi.fn(async () => rootPath),
      list: vi.fn(async () => [
        { name: 'a.ts', path: `${rootPath}\\a.ts`, directory: false },
        { name: 'b.ts', path: `${rootPath}\\b.ts`, directory: false },
      ]),
      search: vi.fn(async () => []),
      read: vi.fn(async (path: string) => ({ path, content: `content of ${path}`, version: 'v1' })),
      create: vi.fn(),
      save: vi.fn(),
      format: vi.fn(),
    }
    window.hydraDesktop = { browser: { setBounds: vi.fn() }, files }
    const view = render(<DesktopFilesPanel workspaceId="workspace" active focusSearch={1} />)
    await view.findByRole('tree', { name: 'Workspace files' })

    // Open first file
    fireEvent.click(view.getByRole('button', { name: 'a.ts' }))
    await view.findByRole('textbox', { name: 'Editor for a.ts' })
    expect(view.getByRole('tab', { name: /a\.ts/ })).toBeTruthy()

    // Open second file
    fireEvent.click(view.getByRole('button', { name: 'b.ts' }))
    await view.findByRole('textbox', { name: 'Editor for b.ts' })
    expect(view.getByRole('tab', { name: /a\.ts/ })).toBeTruthy()
    expect(view.getByRole('tab', { name: /b\.ts/ })).toBeTruthy()

    // Switch back to first file tab
    fireEvent.click(view.getByRole('tab', { name: /a\.ts/ }))
    expect(await view.findByRole('textbox', { name: 'Editor for a.ts' })).toBeTruthy()

    // Close tab
    fireEvent.click(view.getByRole('button', { name: 'Close a.ts' }))
    expect(view.queryByRole('tab', { name: /a\.ts/ })).toBeNull()
    expect(view.getByRole('tab', { name: /b\.ts/ })).toBeTruthy()
  })

  it('supports context menu actions: rename and delete files', async () => {
    const rootPath = 'C:\\workspace'
    const renameFn = vi.fn(async (_path: string, newName: string) => ({
      oldPath: `${rootPath}\\old.ts`,
      path: `${rootPath}\\${newName}`,
      name: newName,
      directory: false,
    }))
    const deleteFn = vi.fn(async (path: string) => ({ path }))
    const files = {
      root: vi.fn(async () => rootPath),
      list: vi.fn(async () => [{ name: 'old.ts', path: `${rootPath}\\old.ts`, directory: false }]),
      search: vi.fn(async () => []),
      read: vi.fn(async (path: string) => ({ path, content: 'code', version: 'v1' })),
      create: vi.fn(),
      rename: renameFn,
      delete: deleteFn,
      save: vi.fn(),
      format: vi.fn(),
    }
    window.hydraDesktop = { browser: { setBounds: vi.fn() }, files }
    const view = render(<DesktopFilesPanel workspaceId="workspace" active focusSearch={1} />)
    await view.findByRole('tree', { name: 'Workspace files' })

    const fileButton = view.getByRole('button', { name: 'old.ts' })
    // Right click to open context menu
    fireEvent.contextMenu(fileButton)
    expect(view.getByRole('menu', { name: 'File options' })).toBeTruthy()

    // Click Rename
    fireEvent.click(view.getByRole('menuitem', { name: 'Rename' }))
    const renameInput = view.getByRole('textbox', { name: 'Rename old.ts' })
    fireEvent.change(renameInput, { target: { value: 'renamed.ts' } })
    fireEvent.click(view.getByRole('button', { name: 'Confirm rename' }))
    await waitFor(() => {
      expect(renameFn).toHaveBeenCalledWith(`${rootPath}\\old.ts`, 'renamed.ts', 'workspace')
    })

    // Delete with confirmation
    const updatedButton = await view.findByRole('button', { name: 'old.ts' })
    fireEvent.contextMenu(updatedButton)
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    fireEvent.click(view.getByRole('menuitem', { name: 'Delete' }))
    await waitFor(() => {
      expect(deleteFn).toHaveBeenCalledWith(`${rootPath}\\old.ts`, 'workspace')
    })
    confirmSpy.mockRestore()
  })

  it('renders line numbers gutter and supports discard of unsaved changes', async () => {
    const rootPath = 'C:\\workspace'
    const files = {
      root: vi.fn(async () => rootPath),
      list: vi.fn(async () => [{ name: 'file.ts', path: `${rootPath}\\file.ts`, directory: false }]),
      search: vi.fn(async () => []),
      read: vi.fn(async (path: string) => ({ path, content: 'line 1\nline 2\nline 3', version: 'v1' })),
      create: vi.fn(),
      save: vi.fn(),
      format: vi.fn(),
    }
    window.hydraDesktop = { browser: { setBounds: vi.fn() }, files }
    const view = render(<DesktopFilesPanel workspaceId="workspace" active focusSearch={1} />)
    await view.findByRole('tree', { name: 'Workspace files' })
    fireEvent.click(view.getByRole('button', { name: 'file.ts' }))

    const editor = await view.findByRole('textbox', { name: 'Editor for file.ts' }) as HTMLTextAreaElement
    expect(editor.value).toBe('line 1\nline 2\nline 3')
    expect(view.getByText('3 lines')).toBeTruthy()

    // Edit content to be 4 lines
    fireEvent.change(editor, { target: { value: 'line 1\nline 2\nline 3\nline 4' } })
    expect(view.getByText('4 lines')).toBeTruthy()
    expect(view.getByRole('button', { name: 'Discard' })).toBeTruthy()

    // Discard changes
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    fireEvent.click(view.getByRole('button', { name: 'Discard' }))
    expect(editor.value).toBe('line 1\nline 2\nline 3')
    expect(view.getByText('3 lines')).toBeTruthy()
    confirmSpy.mockRestore()
  })

  it('supports Open Editors section with Save All and Close All', async () => {
    const rootPath = 'C:\\workspace'
    const saveFn = vi.fn(async (path: string, _content: string, version: string) => ({
      path,
      version: `${version}-saved`,
    }))
    const files = {
      root: vi.fn(async () => rootPath),
      list: vi.fn(async () => [
        { name: 'first.ts', path: `${rootPath}\\first.ts`, directory: false },
        { name: 'second.ts', path: `${rootPath}\\second.ts`, directory: false },
      ]),
      search: vi.fn(async () => []),
      read: vi.fn(async (path: string) => ({ path, content: `original ${path}`, version: 'v1' })),
      create: vi.fn(),
      save: saveFn,
      format: vi.fn(),
    }
    window.hydraDesktop = { browser: { setBounds: vi.fn() }, files }
    const view = render(<DesktopFilesPanel workspaceId="workspace" active focusSearch={1} />)
    await view.findByRole('tree', { name: 'Workspace files' })

    // Open both files
    fireEvent.click(view.getByRole('button', { name: 'first.ts' }))
    await view.findByRole('textbox', { name: 'Editor for first.ts' })
    fireEvent.click(view.getByRole('button', { name: 'second.ts' }))
    await view.findByRole('textbox', { name: 'Editor for second.ts' })

    // Open editors list contains both
    const openEditors = view.getByRole('list', { name: 'Open editors' })
    expect(openEditors).toBeTruthy()
    expect(view.getByText('OPEN EDITORS')).toBeTruthy()

    // Edit second file
    const editor = view.getByRole('textbox', { name: 'Editor for second.ts' })
    fireEvent.change(editor, { target: { value: 'modified second' } })

    // Save all files
    const saveAllBtn = view.getByRole('button', { name: 'Save all files' })
    expect(saveAllBtn.hasAttribute('disabled')).toBe(false)
    fireEvent.click(saveAllBtn)
    await waitFor(() => {
      expect(saveFn).toHaveBeenCalledWith(`${rootPath}\\second.ts`, 'modified second', 'v1', 'workspace')
    })

    // Close all files
    fireEvent.click(view.getByRole('button', { name: 'Close all files' }))
    expect(view.queryByRole('list', { name: 'Open editors' })).toBeNull()
    expect(view.getByText('Select a text file from the workspace tree.')).toBeTruthy()
  })

  it('renders outline symbols and navigates line on symbol click', async () => {
    const rootPath = 'C:\\workspace'
    const codeContent = [
      'export interface UserConfig {',
      '  name: string',
      '}',
      '',
      'export class UserService {',
      '  getUser() {}',
      '}',
      '',
      'export function main() {',
      '  return 42',
      '}',
    ].join('\n')

    const files = {
      root: vi.fn(async () => rootPath),
      list: vi.fn(async () => [{ name: 'app.ts', path: `${rootPath}\\app.ts`, directory: false }]),
      search: vi.fn(async () => []),
      read: vi.fn(async (path: string) => ({ path, content: codeContent, version: 'v1' })),
      create: vi.fn(),
      save: vi.fn(),
      format: vi.fn(),
    }
    window.hydraDesktop = { browser: { setBounds: vi.fn() }, files }
    const view = render(<DesktopFilesPanel workspaceId="workspace" active focusSearch={1} />)
    await view.findByRole('tree', { name: 'Workspace files' })

    fireEvent.click(view.getByRole('button', { name: 'app.ts' }))
    await view.findByRole('textbox', { name: 'Editor for app.ts' })

    // Outline should show symbols
    const outline = view.getByRole('list', { name: 'Code outline' })
    expect(outline).toBeTruthy()
    expect(within(outline).getByText('UserConfig')).toBeTruthy()
    expect(within(outline).getByText('UserService')).toBeTruthy()
    expect(within(outline).getByText('main')).toBeTruthy()

    // Breadcrumbs should render
    const breadcrumbs = view.getByRole('navigation', { name: 'Breadcrumbs' })
    expect(breadcrumbs).toBeTruthy()
    expect(within(breadcrumbs).getByText('app.ts')).toBeTruthy()

    // Clicking a symbol jumps to line
    fireEvent.click(within(outline).getByText('UserService'))
    expect(view.getByText('Ln 5, Col 1')).toBeTruthy()
    const userServiceItem = within(outline).getByText('UserService').closest('[role="listitem"]')
    expect(userServiceItem?.getAttribute('data-selected')).toBe('true')
    const activeLineNumber = view.container.querySelector('[data-line="5"]')
    expect(activeLineNumber?.getAttribute('data-active')).toBe('true')
    expect(activeLineNumber?.getAttribute('data-flash')).toBe('true')
  })

  it('supports Word Wrap toggle and Go to Line shortcut', async () => {
    const rootPath = 'C:\\workspace'
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n')
    const files = {
      root: vi.fn(async () => rootPath),
      list: vi.fn(async () => [{ name: 'script.ts', path: `${rootPath}\\script.ts`, directory: false }]),
      search: vi.fn(async () => []),
      read: vi.fn(async (path: string) => ({ path, content: lines, version: 'v1' })),
      create: vi.fn(),
      save: vi.fn(),
      format: vi.fn(),
    }
    window.hydraDesktop = { browser: { setBounds: vi.fn() }, files }
    const view = render(<DesktopFilesPanel workspaceId="workspace" active focusSearch={1} />)
    await view.findByRole('tree', { name: 'Workspace files' })

    fireEvent.click(view.getByRole('button', { name: 'script.ts' }))
    const editor = await view.findByRole('textbox', { name: 'Editor for script.ts' })

    // Toggle Word Wrap via button
    const wrapBtn = view.getByRole('button', { name: 'Wrap: Off' })
    fireEvent.click(wrapBtn)
    expect(view.getByRole('button', { name: 'Wrap: On' })).toBeTruthy()
    expect(editor.getAttribute('wrap')).toBe('soft')

    // Toggle Word Wrap via Alt+Z
    fireEvent.keyDown(window, { key: 'z', altKey: true })
    expect(view.getByRole('button', { name: 'Wrap: Off' })).toBeTruthy()
    expect(editor.getAttribute('wrap')).toBe('off')

    // Go to Line via Ctrl+G
    fireEvent.keyDown(window, { key: 'g', ctrlKey: true })
    const gotoDialog = view.getByRole('dialog', { name: 'Go to line' })
    expect(gotoDialog).toBeTruthy()
    const gotoInput = view.getByPlaceholderText('1-20')
    fireEvent.change(gotoInput, { target: { value: '15' } })
    fireEvent.keyDown(gotoInput, { key: 'Enter' })

    // Line 15 active
    expect(view.getByText('Ln 15, Col 1')).toBeTruthy()
  })

  it('supports resizing explorer sidebar via splitter drag', async () => {
    const rootPath = 'C:\\workspace'
    const files = {
      root: vi.fn(async () => rootPath),
      list: vi.fn(async () => [{ name: 'file.ts', path: `${rootPath}\\file.ts`, directory: false }]),
      search: vi.fn(async () => []),
      read: vi.fn(async (path: string) => ({ path, content: 'test', version: 'v1' })),
      create: vi.fn(),
      save: vi.fn(),
      format: vi.fn(),
    }
    window.hydraDesktop = { browser: { setBounds: vi.fn() }, files }
    const view = render(<DesktopFilesPanel workspaceId="workspace" active focusSearch={1} />)
    await view.findByRole('tree', { name: 'Workspace files' })

    const splitter = view.getByRole('separator', { name: 'Resize file explorer' })
    expect(splitter).toBeTruthy()

    // Mouse drag on splitter
    fireEvent.mouseDown(splitter, { clientX: 240 })
    fireEvent.mouseMove(window, { clientX: 300 })
    fireEvent.mouseUp(window)

    // TreePane width updated
    const treePane = view.getByRole('complementary')
    expect(treePane.style.width).toBe('300px')
  })

  it('supports Find in File (Ctrl+F) with next/previous matches and match case', async () => {
    const rootPath = 'C:\\workspace'
    const code = 'const hello = "world"\nconsole.log(hello)\nreturn hello'
    const files = {
      root: vi.fn(async () => rootPath),
      list: vi.fn(async () => [{ name: 'file.ts', path: `${rootPath}\\file.ts`, directory: false }]),
      search: vi.fn(async () => []),
      read: vi.fn(async (path: string) => ({ path, content: code, version: 'v1' })),
      create: vi.fn(),
      save: vi.fn(),
      format: vi.fn(),
    }
    window.hydraDesktop = { browser: { setBounds: vi.fn() }, files }
    const view = render(<DesktopFilesPanel workspaceId="workspace" active focusSearch={1} />)
    await view.findByRole('tree', { name: 'Workspace files' })
    fireEvent.click(view.getByRole('button', { name: 'file.ts' }))
    await view.findByRole('textbox', { name: 'Editor for file.ts' })

    // Open Find via Ctrl+F
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
    const findWidget = view.getByRole('search', { name: 'Find in file' })
    expect(findWidget).toBeTruthy()

    // Type search query
    const findInput = view.getByRole('searchbox', { name: 'Find query' })
    fireEvent.change(findInput, { target: { value: 'hello' } })
    expect(view.getByText('1 of 3')).toBeTruthy()

    // Next match
    fireEvent.click(view.getByRole('button', { name: 'Next match' }))
    expect(view.getByText('2 of 3')).toBeTruthy()

    // Previous match
    fireEvent.click(view.getByRole('button', { name: 'Previous match' }))
    expect(view.getByText('1 of 3')).toBeTruthy()

    // Toggle Match Case
    fireEvent.click(view.getByRole('button', { name: 'Match case' }))
    fireEvent.change(findInput, { target: { value: 'HELLO' } })
    expect(view.getByText('No results')).toBeTruthy()

    // Close find via Escape
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(view.queryByRole('search', { name: 'Find in file' })).toBeNull()
  })

  it('supports collapsing all folders in explorer', async () => {
    const rootPath = 'C:\\workspace'
    const files = {
      root: vi.fn(async () => rootPath),
      list: vi.fn(async (path: string) => {
        if (path === rootPath) {
          return [{ name: 'sub', path: `${rootPath}\\sub`, directory: true }]
        }
        return [{ name: 'inner.ts', path: `${rootPath}\\sub\\inner.ts`, directory: false }]
      }),
      search: vi.fn(async () => []),
      read: vi.fn(async (path: string) => ({ path, content: 'code', version: 'v1' })),
      create: vi.fn(),
      save: vi.fn(),
      format: vi.fn(),
    }
    window.hydraDesktop = { browser: { setBounds: vi.fn() }, files }
    const view = render(<DesktopFilesPanel workspaceId="workspace" active focusSearch={1} />)
    await view.findByRole('tree', { name: 'Workspace files' })

    // Expand subfolder
    fireEvent.click(view.getByRole('button', { name: 'sub' }))
    expect(await view.findByRole('button', { name: 'inner.ts' })).toBeTruthy()

    // Click collapse all folders
    fireEvent.click(view.getByRole('button', { name: 'Collapse all folders' }))
    expect(view.queryByRole('button', { name: 'inner.ts' })).toBeNull()
  })
})

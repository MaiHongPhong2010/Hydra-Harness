// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { bindSnapshotSelector } from '@hydraharness/harness-client-test-runtime'
import type {
  SessionId, SessionListState, SessionSummary, WorkspaceId, WorkspaceListState, WorkspaceView,
} from '@hydraharness/harness-client-runtime/client'
import { makeTranslate } from '@hydraharness/harness-client-test-runtime'
import { en as commonEn } from '@hydraharness/harness-client-locale/src/locales/en.ts'
import type { WorkspaceBrowserProps } from '../src/client/contract/slots.ts'
import { createWorkspaceViewStore, FLAT_SESSION_ORDER_KEY } from '../src/client/stores.ts'
import { UNGROUPED_KEY } from '../src/client/tree.ts'
import { WorkspaceBrowser } from '../src/client/WorkspaceBrowser.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)
beforeEach(() => { localStorage.clear(); createWorkspaceViewStore().create().actions.setOrderBy('manual') })

// The seat's key domain is workspace ∪ common; the stub mirrors the real
// lookup chain (namespace, then common vocabulary, then the key).
const t: WorkspaceBrowserProps['t'] = makeTranslate(en, commonEn)

const sid = (id: string) => id as SessionId
const wid = (id: string) => id as WorkspaceId
const summary = (id: string, updatedAt: number, overrides: Partial<SessionSummary> = {}): SessionSummary => ({
  id: sid(id), displayTitle: id, running: false, blank: false, updatedAt, ...overrides,
})
const sessionState = (items: readonly SessionSummary[], overrides: Partial<SessionListState> = {}): SessionListState => ({
  ids: items.map(item => item.id),
  byId: Object.fromEntries(items.map(item => [item.id, item])),
  current: undefined,
  phase: 'ready',
  subagentsByParent: {}, jobsBySession: {},
  currentAddress: undefined,
  ...overrides,
})
const workspace = (id: string, sessionIds: string[], title = id): WorkspaceView => ({
  workspaceId: wid(id), path: `/projects/${id}`, title,
  sessionIds: sessionIds.map(sid), createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
})
const workspaceState = (items: readonly WorkspaceView[], archivedSessionIds: readonly SessionId[] = []): WorkspaceListState => ({
  items, archivedSessionIds, state: 'idle', phase: 'ready', error: null, baselinesReady: true,
  recentWorkspaceId: items[0]?.workspaceId,
})
function hook<T>(snapshot: T) {
  return function select<S>(selector: (state: T) => S): S { return selector(snapshot) }
}

/** jsdom lacks DragEvent — the fireEvent fallback drops clientY, so pin it on the built event. */
function fireDrag(row: HTMLElement, kind: 'dragOver' | 'drop', clientY: number): void {
  const event = kind === 'dragOver' ? createEvent.dragOver(row) : createEvent.drop(row)
  Object.defineProperty(event, 'clientY', { value: clientY })
  Object.defineProperty(event, 'dataTransfer', { value: { effectAllowed: '', dropEffect: '' } })
  fireEvent(row, event)
}

function dragData(): Pick<DataTransfer, 'effectAllowed' | 'dropEffect' | 'setData'> {
  return { effectAllowed: 'uninitialized', dropEffect: 'none', setData: vi.fn() }
}

function mount(overrides: Partial<WorkspaceBrowserProps> = {}) {
  const store = createWorkspaceViewStore().create()
  const props: WorkspaceBrowserProps = {
    wide: true,
    expandSidebar: vi.fn(),
    useSessions: hook(sessionState([])),
    useWorkspaces: hook(workspaceState([])),
    useStore: bindSnapshotSelector(store),
    actions: store.actions,
    startSession: vi.fn(),
    open: vi.fn(),
    searchSessions: vi.fn(async () => ({ items: [], hasMore: false })),
    searchResultLimit: 20,
    renameSession: vi.fn(async () => {}),
    forkSession: vi.fn(),
    sessionMarkdown: vi.fn(async () => '# Session'),
    renameWorkspace: vi.fn(async () => {}),
    deleteWorkspace: vi.fn(async () => {}),
    deleteSession: vi.fn(async () => {}),
    archiveSession: vi.fn(async () => {}),
    insertWorkspaceBefore: vi.fn(async () => {}),
    insertSessionBefore: vi.fn(async () => {}),
    createWorkspace: vi.fn(async () => workspace('created', [])),
    useDirectoryFlow: bindSnapshotSelector({ getSnapshot: () => true, subscribe: () => () => {} }),
    useHostDescription: selector => selector(undefined),
    renderSlot: ((_name: string, owner: { open: boolean }) => (owner.open ? <div data-testid="directory-flow" /> : null)) as never,
    t,
    ...overrides,
  }
  const view = render(<WorkspaceBrowser {...props} />)
  return { view, props, store }
}

/** Re-render with (possibly) changed props — WorkspaceBrowser has no side channel. */
function rerender(b: ReturnType<typeof mount>, overrides: Partial<WorkspaceBrowserProps>) {
  Object.assign(b.props, overrides)
  b.view.rerender(<WorkspaceBrowser {...b.props} />)
}

describe('WorkspaceBrowser', () => {
  it('keeps standalone chats navigable in Ungrouped', () => {
    const task = { ...workspace('task', ['task-chat']), kind: 'task' as const }
    const b = mount({
      useSessions: hook(sessionState([summary('task-chat', 1, { cwd: task.path })])),
      useWorkspaces: hook(workspaceState([task])),
    })
    expect(screen.queryByText('task', { exact: true })).toBeNull()
    fireEvent.click(screen.getByText('Ungrouped'))
    const row = screen.getByRole('treeitem', { name: /task-chat/u })
    fireEvent.click(row)
    expect(b.props.open).toHaveBeenCalledWith(sid('task-chat'))
  })

  it('opens a context menu without selecting the row and persists pin/unread actions', () => {
    const b = mount({ useSessions: hook(sessionState([summary('session', 1)])) })
    fireEvent.click(screen.getByText('Ungrouped'))
    const row = screen.getByRole('treeitem', { name: /session/ })
    fireEvent.contextMenu(row, { clientX: 120, clientY: 180 })
    expect(b.props.open).not.toHaveBeenCalled()
    expect(screen.getByRole('menuitem', { name: 'Share' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('menuitem', { name: 'Share' }).textContent).toContain('Coming soon')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Pin' }))
    expect(screen.getByRole('group', { name: 'Pinned' })).toBeTruthy()
    expect(screen.getAllByRole('button', { name: 'Session actions for session' })).toHaveLength(1)
    const pinned = screen.getByRole('treeitem', { name: /session/ })
    fireEvent.contextMenu(pinned)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Mark as unread' }))
    expect(screen.getByLabelText('Unread')).toBeTruthy()
    expect(createWorkspaceViewStore().create().getSnapshot().pinnedSessionIds).toEqual(['session'])
    fireEvent.click(screen.getByRole('treeitem', { name: /session/ }))
    expect(screen.queryByLabelText('Unread')).toBeNull()
    expect(b.props.open).toHaveBeenCalledWith(sid('session'))
  })

  it('creates a section and changes display project while keeping the working directory', () => {
    const b = mount({ useSessions: hook(sessionState([summary('session', 1, { cwd: '/original' })])),
      useWorkspaces: hook(workspaceState([workspace('target', [])])) })
    fireEvent.click(screen.getByText('Ungrouped'))
    fireEvent.contextMenu(screen.getByRole('treeitem', { name: /session/ }))
    fireEvent.mouseEnter(screen.getByRole('menuitem', { name: 'Project' }).parentElement as HTMLElement)
    fireEvent.click(screen.getByRole('menuitem', { name: 'target' }))
    expect(b.store.getSnapshot().projectBySession).toEqual({ session: 'target' })
    expect(b.props.insertSessionBefore).not.toHaveBeenCalled()
    fireEvent.contextMenu(screen.getByRole('treeitem', { name: /session/ }))
    fireEvent.mouseEnter(screen.getByRole('menuitem', { name: 'Section' }).parentElement as HTMLElement)
    fireEvent.click(screen.getByRole('menuitem', { name: 'New section…' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Section name' }), { target: { value: 'Review' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect(screen.getByRole('group', { name: 'Review' })).toBeTruthy()
    expect(screen.getAllByRole('button', { name: 'Session actions for session' })).toHaveLength(1)
  })

  it('workspace hover card shows a POSIX home descendant as ~', () => {
    vi.useFakeTimers()
    try {
      mount({
        useWorkspaces: hook(workspaceState([{
          ...workspace('project', []),
          path: '/home/u/Documents/project',
          title: 'Project',
        }])),
        useHostDescription: selector => selector({
          version: '0', cwd: '/tmp', attachedSessions: 0, home: '/home/u', canOpenPath: false,
        }),
      })
      fireEvent.pointerEnter(screen.getByRole('treeitem').parentElement as HTMLElement)
      act(() => { vi.advanceTimersByTime(500) })
      expect(screen.getByText('~/Documents/project')).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('prunes deleted Workspace view state only after the Workspace baseline is ready', async () => {
    const pending = {
      ...workspaceState([]),
      phase: 'pending' as const,
      state: 'loading' as const,
      baselinesReady: false,
    }
    const b = mount({ useWorkspaces: hook(pending) })
    act(() => {
      b.store.actions.setGroupExpanded('deleted', true)
      b.store.actions.syncSessionOrderAccount('deleted', ['session'], { session: 1 })
    })
    expect(b.store.getSnapshot().groupExpansion).toEqual({ deleted: true })

    rerender(b, { useWorkspaces: hook(workspaceState([])) })
    await waitFor(() => {
      expect(b.store.getSnapshot().groupExpansion).toEqual({})
      expect(b.store.getSnapshot().sessionOrderByAccount).toEqual({ [UNGROUPED_KEY]: [] })
      expect(b.store.getSnapshot().sessionUpdatedAtByAccount).toEqual({ [UNGROUPED_KEY]: {} })
    })
  })

  it('renders the grouped tree by default and switches to the flat list via Group by', () => {
    const sessions = sessionState([summary('alpha-s', 2), summary('beta-s', 1)])
    const b = mount({
      useSessions: hook(sessions),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['alpha-s']), workspace('beta', ['beta-s'])])),
    })
    expect(screen.getByText('Workspaces')).toBeTruthy()
    expect(screen.getByText('alpha')).toBeTruthy()
    // Sessions hidden while their group is folded.
    expect(screen.queryByText('alpha-s')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'View options' }))
    expect(screen.getByText('Group by')).toBeTruthy() // the menu heading label
    expect(screen.getByRole('separator')).toBeTruthy()
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual([
      'WorkSpace', 'In one list', 'Manual', 'Last updated',
    ])
    expect(screen.getByRole('menuitem', { name: 'WorkSpace' }).querySelector('svg')).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Manual' }).querySelector('svg')).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitem', { name: 'In one list' }))
    // Store-driven flip: title changes, rows flatten newest-first, headers gone.
    expect(b.store.getSnapshot().groupBy).toBe('flat')
    expect(screen.getByText('Sessions')).toBeTruthy()
    expect(screen.queryByText('alpha')).toBeNull()
    expect(screen.getByText('alpha-s')).toBeTruthy()
    expect(screen.getByText('beta-s')).toBeTruthy()

    // Back to workspace grouping through the same menu.
    fireEvent.click(screen.getByRole('button', { name: 'View options' }))
    expect(screen.getByRole('menuitem', { name: 'Manual' }).hasAttribute('disabled')).toBe(false)
    fireEvent.click(screen.getByRole('menuitem', { name: 'WorkSpace' }))
    expect(b.store.getSnapshot().groupBy).toBe('workspace')
    expect(screen.getByText('Workspaces')).toBeTruthy()

    // Escape closes the menu without picking.
    fireEvent.click(screen.getByRole('button', { name: 'View options' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(b.store.getSnapshot().groupBy).toBe('workspace')
  })

  it('persists flat-list drag order locally and applies Last updated within that account', async () => {
    const insertSessionBefore = vi.fn(async () => {})
    const sessions = sessionState([summary('one', 3), summary('two', 2), summary('three', 1)])
    const workspaces = workspaceState([
      workspace('alpha', ['one']),
      workspace('beta', ['two']),
    ])
    const b = mount({
      useSessions: hook(sessions),
      useWorkspaces: hook(workspaces),
      insertSessionBefore,
    })
    fireEvent.click(screen.getByRole('button', { name: 'View options' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'In one list' }))
    await waitFor(() => {
      expect(b.store.getSnapshot().sessionOrderByAccount[FLAT_SESSION_ORDER_KEY])
        .toEqual(['one', 'two', 'three'])
    })

    const one = screen.getByText('one').closest('[role="treeitem"]') as HTMLElement
    const three = screen.getByText('three').closest('[role="treeitem"]') as HTMLElement
    three.getBoundingClientRect = () => ({
      top: 150, bottom: 184, left: 0, right: 200, width: 200, height: 34,
      x: 0, y: 150, toJSON: () => ({}),
    })
    fireEvent.dragStart(one, { dataTransfer: dragData() })
    fireDrag(three, 'drop', 180)
    expect(b.store.getSnapshot().sessionOrderByAccount[FLAT_SESSION_ORDER_KEY])
      .toEqual(['two', 'three', 'one'])
    expect(insertSessionBefore).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'View options' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Last updated' }))
    await waitFor(() => {
      expect(b.store.getSnapshot().sessionOrderByAccount[FLAT_SESSION_ORDER_KEY])
        .toEqual(['one', 'two', 'three'])
    })

    fireEvent.click(screen.getByRole('button', { name: 'View options' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Manual' }))
    fireEvent.dragStart(one, { dataTransfer: dragData() })
    fireDrag(three, 'drop', 180)
    b.view.unmount()

    const restored = mount({ useSessions: hook(sessions), useWorkspaces: hook(workspaces) })
    expect(restored.store.getSnapshot().groupBy).toBe('flat')
    expect(restored.store.getSnapshot().orderBy).toBe('manual')
    expect(screen.getAllByRole('treeitem').map(row => row.textContent)).toEqual([
      expect.stringContaining('two'),
      expect.stringContaining('three'),
      expect.stringContaining('one'),
    ])
  })

  it('expands a group on click and opens a session row', () => {
    const open = vi.fn()
    mount({
      useSessions: hook(sessionState([summary('alpha-s', 1)])),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['alpha-s'])])),
      open,
    })
    fireEvent.click(screen.getByText('alpha'))
    fireEvent.click(screen.getByText('alpha-s'))
    expect(open).toHaveBeenCalledWith(sid('alpha-s'))
    // Collapse hides the row again.
    fireEvent.click(screen.getByText('alpha'))
    expect(screen.queryByText('alpha-s')).toBeNull()
  })

  it('shows five sessions by default and clears transient show-all when the Workspace collapses', () => {
    const items = Array.from({ length: 7 }, (_, index) => summary(`session-${index + 1}`, 7 - index))
    const b = mount({
      useSessions: hook(sessionState(items)),
      useWorkspaces: hook(workspaceState([workspace('alpha', items.map(item => item.id))])),
    })
    fireEvent.click(screen.getByText('alpha'))
    for (const item of items.slice(0, 5)) expect(screen.getByText(item.displayTitle)).toBeTruthy()
    expect(screen.queryByText('session-6')).toBeNull()
    expect(screen.queryByText('session-7')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Show 2 more sessions' }))
    expect(screen.getByText('session-6')).toBeTruthy()
    expect(screen.getByText('session-7')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Show less' })).toBeTruthy()

    fireEvent.click(screen.getByText('alpha'))
    expect(b.store.getSnapshot().groupExpansion).toEqual({ alpha: false })
    fireEvent.click(screen.getByText('alpha'))
    expect(b.store.getSnapshot().groupExpansion).toEqual({ alpha: true })
    expect(screen.queryByText('session-6')).toBeNull()
    expect(screen.getByRole('button', { name: 'Show 2 more sessions' })).toBeTruthy()
  })

  it('shares one editable order across modes and promotes only while Last updated is active', async () => {
    const initial = sessionState([summary('one', 3), summary('two', 2)])
    const b = mount({
      useSessions: hook(initial),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['two', 'one'])])),
    })
    fireEvent.click(screen.getByText('alpha'))
    fireEvent.click(screen.getByRole('button', { name: 'View options' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Last updated' }))
    await waitFor(() => {
      const rows = screen.getAllByRole('treeitem').slice(1)
      expect(rows[0]?.textContent).toContain('one')
      expect(rows[1]?.textContent).toContain('two')
    })

    const [one, two] = screen.getAllByRole('treeitem').slice(1) as [HTMLElement, HTMLElement]
    two.getBoundingClientRect = () => ({
      top: 150, bottom: 184, left: 0, right: 200, width: 200, height: 34, x: 0, y: 150, toJSON: () => ({}),
    })
    fireEvent.dragStart(one, { dataTransfer: dragData() })
    fireDrag(two, 'drop', 180)
    expect(b.store.getSnapshot().sessionOrderByAccount.alpha).toEqual(['two', 'one'])

    fireEvent.click(screen.getByRole('button', { name: 'View options' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Manual' }))
    expect(screen.getAllByRole('treeitem').slice(1)[0]?.textContent).toContain('two')

    // User activity updates the timestamp baseline in Manual mode without
    // changing the shared visual order.
    const updated = sessionState([summary('one', 4), summary('two', 2)])
    rerender(b, { useSessions: hook(updated) })
    await waitFor(() => {
      expect(b.store.getSnapshot().sessionUpdatedAtByAccount.alpha).toEqual({ one: 4, two: 2 })
    })
    expect(b.store.getSnapshot().sessionOrderByAccount.alpha).toEqual(['two', 'one'])
    expect(screen.getAllByRole('treeitem').slice(1)[0]?.textContent).toContain('two')

    // Entering Last updated performs one complete recency sort.
    fireEvent.click(screen.getByRole('button', { name: 'View options' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Last updated' }))
    await waitFor(() => {
      expect(b.store.getSnapshot().sessionOrderByAccount.alpha).toEqual(['one', 'two'])
      expect(screen.getAllByRole('treeitem').slice(1)[0]?.textContent).toContain('one')
    })

    // A later user activity timestamp promotes that Session once while the
    // mode remains active.
    const promoted = sessionState([summary('one', 4), summary('two', 5)])
    rerender(b, { useSessions: hook(promoted) })
    await waitFor(() => {
      expect(b.store.getSnapshot().sessionOrderByAccount.alpha).toEqual(['two', 'one'])
      expect(screen.getAllByRole('treeitem').slice(1)[0]?.textContent).toContain('two')
    })

    b.view.unmount()
    const restored = mount({
      useSessions: hook(promoted),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['two', 'one'])])),
    })
    expect(restored.store.getSnapshot().sessionOrderByAccount.alpha).toEqual(['two', 'one'])
    expect(screen.getAllByRole('treeitem').slice(1)[0]?.textContent).toContain('two')
  })

  it('archives a session from the row menu and hides archived rows in both modes', async () => {
    const archiveSession = vi.fn(async () => {})
    const b = mount({
      useSessions: hook(sessionState([summary('kept-s', 2), summary('gone-s', 1)])),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['kept-s', 'gone-s'])])),
      archiveSession,
    })
    fireEvent.click(screen.getByText('alpha'))
    fireEvent.click(screen.getByRole('button', { name: 'Session actions for gone-s' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Archive session' }))
    expect(archiveSession).toHaveBeenCalledWith(sid('gone-s'))

    // The archive-set echo hides the row in grouped and flat modes.
    rerender(b, { useWorkspaces: hook(workspaceState([workspace('alpha', ['kept-s', 'gone-s'])], [sid('gone-s')])) })
    expect(screen.queryByText('gone-s')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'View options' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'In one list' }))
    expect(screen.getByText('kept-s')).toBeTruthy()
    expect(screen.queryByText('gone-s')).toBeNull()
  })

  it('logs and keeps the tree when the archive call rejects', async () => {
    const rejection = new Error('archive exploded')
    const archiveSession = vi.fn(async () => { throw rejection })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      mount({
        useSessions: hook(sessionState([summary('alpha-s', 1)])),
        useWorkspaces: hook(workspaceState([workspace('alpha', ['alpha-s'])])),
        archiveSession,
      })
      fireEvent.click(screen.getByText('alpha'))
      fireEvent.click(screen.getByRole('button', { name: 'Session actions for alpha-s' }))
      fireEvent.click(screen.getByRole('menuitem', { name: 'Archive session' }))
      await Promise.resolve()
      await Promise.resolve()
      expect(warn).toHaveBeenCalledWith('session archive rejected:', rejection)
      expect(screen.getByText('alpha-s')).toBeTruthy()
    } finally {
      warn.mockRestore()
    }
  })

  it('renders a fork child as a top-level row without a session twist', () => {
    const parent = summary('parent-s', 2)
    const child = { ...summary('child-s', 1), parentId: parent.id }
    mount({
      useSessions: hook(sessionState([parent, child])),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['parent-s', 'child-s'])])),
    })
    fireEvent.click(screen.getByText('alpha'))
    expect(screen.getByText('child-s')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Show \d+ more sessions|Show less/ })).toBeNull()
    expect(screen.getByText('child-s').closest('[role="treeitem"]')?.getAttribute('draggable')).toBe('true')
  })

  it('expands the target group before starting a session from its ＋', () => {
    const startSession = vi.fn()
    const b = mount({
      useSessions: hook(sessionState([summary('alpha-s', 1)])),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['alpha-s'])])),
      startSession,
    })
    startSession.mockImplementation(() => {
      expect(b.store.getSnapshot().groupExpansion).toEqual({ alpha: true })
    })
    expect(screen.queryByText('alpha-s')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'New session in alpha' }))
    expect(b.store.getSnapshot().groupExpansion).toEqual({ alpha: true })
    expect(screen.getByText('alpha-s')).toBeTruthy()
    expect(startSession).toHaveBeenCalledWith(wid('alpha'))
  })

  it('auto-expands Ungrouped, offers orphan-chat deletion, and keeps its ＋ inert', async () => {
    const startSession = vi.fn()
    const deleteSession = vi.fn(async () => {})
    mount({
      useSessions: hook(sessionState([summary('loose', 1)], { current: sid('loose') })),
      useWorkspaces: hook(workspaceState([workspace('alpha', [])])),
      startSession,
      deleteSession,
    })
    // The loose session's group is UNGROUPED_KEY: expanded by the effect.
    expect(screen.getByText('loose')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Ungrouped actions' }))
    expect(screen.queryByRole('menuitem', { name: 'Rename' })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete orphan chats' }))
    expect(screen.getByRole('dialog', { name: 'Delete session' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Delete session' }))
    await waitFor(() => { expect(deleteSession).toHaveBeenCalledWith(sid('loose')) })
    fireEvent.click(screen.getByRole('button', { name: 'New session in Ungrouped' }))
    expect(startSession).not.toHaveBeenCalled()
  })

  it('deletes every eligible orphan even when the Ungrouped bucket shows only five rows', async () => {
    const orphanIds = ['orphan-1', 'orphan-2', 'orphan-3', 'orphan-4', 'orphan-5', 'orphan-6']
    const currentBlank = summary('current-blank', 100, { blank: true })
    const staleBlank = summary('stale-blank', 99, { blank: true })
    const owned = summary('owned', 98)
    const archived = summary('archived', 97)
    const subagent = summary('child', 96, { origin: 'subagent', parentId: sid('orphan-1') })
    const sessions = [
      ...orphanIds.map((id, index) => summary(id, 90 - index)),
      currentBlank, staleBlank, owned, archived, subagent,
    ]
    const deleteSession = vi.fn<(id: SessionId) => Promise<void>>(async () => {})
    mount({
      useSessions: hook(sessionState(sessions, { current: currentBlank.id })),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['owned'])], [archived.id])),
      deleteSession,
    })

    // The group is open because it contains the current blank row, but its
    // overflow stays collapsed; the hidden sixth orphan must still be a target.
    expect(screen.getByRole('button', { name: 'Show 2 more sessions' })).toBeTruthy()
    expect(screen.getByText('orphan-1')).toBeTruthy()
    expect(screen.queryByText('orphan-6')).toBeNull()
    expect(screen.queryByText('owned')).toBeNull()
    expect(screen.queryByText('archived')).toBeNull()
    expect(screen.queryByText('child')).toBeNull()
    expect(screen.getByText('New Session')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Ungrouped actions' }))
    expect(screen.queryByRole('menuitem', { name: 'Rename' })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete orphan chats' }))
    const dialog = screen.getByRole('dialog', { name: 'Delete selected sessions (6)' })
    expect(dialog.querySelectorAll('li')).toHaveLength(orphanIds.length)
    expect(dialog.textContent).not.toContain('current-blank')
    expect(dialog.textContent).not.toContain('stale-blank')
    expect(dialog.textContent).not.toContain('owned')
    expect(dialog.textContent).not.toContain('archived')
    expect(dialog.textContent).not.toContain('child')

    fireEvent.click(screen.getByRole('button', { name: 'Delete selected sessions (6)' }))
    await waitFor(() => { expect(deleteSession).toHaveBeenCalledTimes(orphanIds.length) })
    expect(deleteSession.mock.calls.map(([id]) => id)).toEqual([
      sid('orphan-1'), sid('orphan-2'), sid('orphan-3'), sid('orphan-4'), sid('orphan-5'), sid('orphan-6'),
    ])
  })

  it('keeps partial orphan deletion retryable and lets Cancel close the existing dialog', async () => {
    const first = summary('first', 2)
    const second = summary('second', 1)
    const deleteSession = vi.fn<(id: SessionId) => Promise<void>>()
      .mockRejectedValueOnce(new Error('storage unavailable'))
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
    mount({
      useSessions: hook(sessionState([first, second], { current: first.id })),
      useWorkspaces: hook(workspaceState([])),
      deleteSession,
    })

    fireEvent.click(screen.getByRole('button', { name: 'Ungrouped actions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete orphan chats' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete selected sessions (2)' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('first: storage unavailable') })
    expect(screen.getByRole('dialog', { name: 'Delete selected sessions (1)' })).toBeTruthy()
    expect(deleteSession).toHaveBeenCalledTimes(2)

    // Retry only the failed target; success closes the dialog.
    fireEvent.click(screen.getByRole('button', { name: 'Delete selected sessions (1)' }))
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    expect(deleteSession).toHaveBeenCalledTimes(3)
    expect(deleteSession.mock.calls[2]?.[0]).toBe(sid('first'))

    // A fresh gesture can be cancelled without dispatching another deletion.
    fireEvent.click(screen.getByRole('button', { name: 'Ungrouped actions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete orphan chats' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(deleteSession).toHaveBeenCalledTimes(3)
  })

  it('disables orphan deletion when Ungrouped contains only the current blank row', () => {
    const deleteSession = vi.fn<(id: SessionId) => Promise<void>>(async () => {})
    mount({
      useSessions: hook(sessionState([summary('blank', 1, { blank: true })], { current: sid('blank') })),
      useWorkspaces: hook(workspaceState([])),
      deleteSession,
    })
    fireEvent.click(screen.getByRole('button', { name: 'Ungrouped actions' }))
    const item = screen.getByRole('menuitem', { name: 'Delete orphan chats' }) as HTMLButtonElement
    expect(item.disabled).toBe(true)
    fireEvent.click(item)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(deleteSession).not.toHaveBeenCalled()
  })

  it.each([
    ['session list', { useSessions: hook(sessionState([summary('loose', 1)], { current: sid('loose'), phase: 'pending' as const })) }],
    ['Workspace', { useWorkspaces: hook({ ...workspaceState([]), phase: 'pending' as const, state: 'loading' as const, baselinesReady: false }) }],
  ] as const)('disables orphan deletion while the %s baseline is pending', (_label, overrides) => {
    mount({
      useSessions: hook(sessionState([summary('loose', 1)], { current: sid('loose') })),
      useWorkspaces: hook(workspaceState([])),
      ...overrides,
    })
    fireEvent.click(screen.getByRole('button', { name: 'Ungrouped actions' }))
    const item = screen.getByRole('menuitem', { name: 'Delete orphan chats' }) as HTMLButtonElement
    expect(item.disabled).toBe(true)
  })

  it('keeps an already-expanded group when the selection moves within it', () => {
    const first = sessionState([summary('a', 2), summary('b', 1)], { current: sid('a') })
    const b = mount({
      useSessions: hook(first),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['a', 'b'])])),
    })
    expect(screen.getByText('a')).toBeTruthy()
    // Selection hop inside the same group: the effect re-runs and leaves the
    // expansion list unchanged (no duplicate key, group still open).
    rerender(b, { useSessions: hook({ ...first, current: sid('b') }) })
    expect(screen.getByText('b')).toBeTruthy()
    fireEvent.click(screen.getByText('alpha'))
    expect(screen.queryByText('b')).toBeNull()
  })

  it('shows only the current blank session as the localized New Session, excluded from search', () => {
    const currentBlank = summary('alpha-blank', 9, { blank: true })
    const staleBlank = summary('beta-blank', 8, { blank: true })
    const sessions = sessionState(
      [currentBlank, staleBlank],
      { current: currentBlank.id },
    )
    const b = mount({
      useSessions: hook(sessions),
      useWorkspaces: hook(workspaceState([
        workspace('alpha', ['alpha-blank']), workspace('beta', ['beta-blank']),
      ])),
    })
    expect(screen.getByText('New Session')).toBeTruthy()
    expect(screen.queryByText('alpha-blank')).toBeNull()
    expect(screen.queryByText('beta-blank')).toBeNull()

    rerender(b, { useSessions: hook({ ...sessions, current: staleBlank.id }) })
    expect(screen.getAllByText('New Session')).toHaveLength(1)
    b.store.actions.setGroupBy('flat')
    rerender(b, {})
    expect(screen.getAllByText('New Session')).toHaveLength(1)
    // Search excludes blank rows entirely — neither the canonical stored
    // title nor the localized display label participates in matching.
    fireEvent.change(screen.getByPlaceholderText('Search sessions...'), { target: { value: 'new session' } })
    expect(screen.queryByText('New Session')).toBeNull()
    fireEvent.change(screen.getByPlaceholderText('Search sessions...'), { target: { value: 'New Session' } })
    expect(screen.queryByText('New Session')).toBeNull()
  })

  it('promotes the blank selected by New Session in its grouped and flat orders', async () => {
    const items = [
      summary('old', 100),
      summary('blank', 150, { blank: true }),
      summary('mid', 200),
    ]
    const startSession = vi.fn()
    const b = mount({
      useSessions: hook(sessionState(items)),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['old', 'blank', 'mid'])])),
      startSession,
    })
    await waitFor(() => {
      expect(b.store.getSnapshot().sessionOrderByAccount.alpha).toEqual(['old', 'blank', 'mid'])
    })
    startSession.mockImplementation(() => {
      rerender(b, { useSessions: hook(sessionState(items, { current: sid('blank') })) })
    })
    fireEvent.click(screen.getByRole('button', { name: 'New session in alpha' }))
    expect(startSession).toHaveBeenCalledWith(wid('alpha'))
    await waitFor(() => {
      expect(b.store.getSnapshot().sessionOrderByAccount.alpha).toEqual(['blank', 'old', 'mid'])
      expect(b.store.getSnapshot().sessionOrderByAccount[FLAT_SESSION_ORDER_KEY]).toEqual(['blank'])
    })
    b.store.actions.setGroupBy('flat')
    await waitFor(() => {
      expect(b.store.getSnapshot().sessionOrderByAccount[FLAT_SESSION_ORDER_KEY]).toEqual(['blank', 'mid', 'old'])
    })
  })

  it('does not repeat blank promotion after a manual drag or the first prompt', async () => {
    const insertSessionBefore = vi.fn(async () => {})
    const b = mount({
      useSessions: hook(sessionState([
        summary('old', 100),
        summary('blank', 150, { blank: true }),
        summary('mid', 200),
      ], { current: sid('blank') })),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['old', 'blank', 'mid'])])),
      insertSessionBefore,
    })
    await waitFor(() => {
      expect(b.store.getSnapshot().sessionOrderByAccount.alpha).toEqual(['blank', 'old', 'mid'])
    })
    const blank = screen.getByText('New Session').closest('[role="treeitem"]') as HTMLElement
    const mid = screen.getByText('mid').closest('[role="treeitem"]') as HTMLElement
    mid.getBoundingClientRect = () => ({
      top: 150, bottom: 184, left: 0, right: 200, width: 200, height: 34, x: 0, y: 150, toJSON: () => ({}),
    })
    fireEvent.dragStart(blank, { dataTransfer: dragData() })
    fireDrag(mid, 'drop', 180)
    expect(b.store.getSnapshot().sessionOrderByAccount.alpha).toEqual(['old', 'mid', 'blank'])
    expect(insertSessionBefore).toHaveBeenCalledWith(wid('alpha'), sid('blank'), undefined)

    rerender(b, {
      useSessions: hook(sessionState([
        summary('old', 100),
        summary('blank', 150),
        summary('mid', 200),
      ], { current: sid('blank') })),
    })
    await waitFor(() => {
      expect(b.store.getSnapshot().sessionOrderByAccount.alpha).toEqual(['old', 'mid', 'blank'])
    })
  })

  it('shows local metadata matches immediately, then clears back to the grouped tree', async () => {
    vi.useFakeTimers()
    try {
      const sessions = sessionState([
        summary('needle-row', 2, { displayTitle: 'Needle row' }),
        summary('other-row', 1, { displayTitle: 'Other row' }),
      ])
      mount({
        useSessions: hook(sessions),
        useWorkspaces: hook(workspaceState([workspace('alpha', ['needle-row', 'other-row'])])),
      })
      fireEvent.click(screen.getByRole('button', { name: 'Search sessions' }))
      const input = screen.getByPlaceholderText<HTMLInputElement>('Search sessions...')
      fireEvent.change(input, { target: { value: 'needle' } })
      const resultTree = screen.getByRole('tree', { name: 'Search results' })
      expect(screen.getByText('Needle row')).toBeTruthy()
      expect(screen.queryByText('Other row')).toBeNull()
      const status = screen.getByRole('status')
      expect(status.textContent).toBe('Searching session history…')
      expect(resultTree.contains(status)).toBe(false)

      fireEvent.change(input, { target: { value: 'zzz' } })
      await act(async () => { await vi.advanceTimersByTimeAsync(250) })
      expect(screen.getByText('No matching sessions')).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: 'Clear search' }))
      expect(input.value).toBe('')
      expect(screen.getByRole('tree', { name: 'Sessions' })).toBeTruthy()
      // Clicking the field row focuses the input (wide mode).
      fireEvent.click(input.parentElement as HTMLElement)
      expect(document.activeElement).toBe(input)
    } finally {
      vi.useRealTimers()
    }
  })

  it('collapses an empty search on outside click but keeps a non-empty query expanded', () => {
    mount()
    const search = screen.getByRole('button', { name: 'Search sessions' })
    fireEvent.click(search)
    expect(search.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(document.body)
    expect(search.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(search)
    const input = screen.getByPlaceholderText<HTMLInputElement>('Search sessions...')
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.click(document.body)
    expect(search.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(search)
    fireEvent.change(input, { target: { value: 'kept' } })
    fireEvent.click(document.body)
    expect(search.getAttribute('aria-expanded')).toBe('true')
    expect(input.value).toBe('kept')
  })

  it('adds Host content hits with context, shows the result bound, and opens without clearing the query', async () => {
    vi.useFakeTimers()
    try {
      const open = vi.fn()
      const searchSessions = vi.fn(async () => ({
        items: [{ sessionId: sid('body-hit'), snippet: '…the waterfall token appears here…' }],
        hasMore: true,
      }))
      mount({
        useSessions: hook(sessionState([
          summary('body-hit', 1, { displayTitle: 'Research notes' }),
        ])),
        useWorkspaces: hook(workspaceState([
          workspace('research', ['body-hit'], 'Research Workspace'),
        ])),
        open,
        searchSessions,
      })
      const input = screen.getByPlaceholderText<HTMLInputElement>('Search sessions...')
      fireEvent.change(input, { target: { value: 'waterfall token' } })
      expect(screen.getByText('Searching session history…')).toBeTruthy()
      expect(screen.queryByText('Research notes')).toBeNull()

      await act(async () => { await vi.advanceTimersByTimeAsync(250) })

      expect(searchSessions).toHaveBeenCalledWith('waterfall token', expect.any(AbortSignal))
      expect(screen.getByText('Research notes')).toBeTruthy()
      expect(screen.getByText('Research Workspace')).toBeTruthy()
      expect(screen.getByText('…the waterfall token appears here…')).toBeTruthy()
      expect(screen.getByText('Showing the first 20 results. Narrow your search.')).toBeTruthy()
      fireEvent.click(screen.getByRole('treeitem'))
      expect(open).toHaveBeenCalledWith(sid('body-hit'))
      expect(input.value).toBe('waterfall token')
    } finally {
      vi.useRealTimers()
    }
  })

  it('bounds programmatic search input to a schema-valid request without splitting an astral character', async () => {
    vi.useFakeTimers()
    try {
      const searchSessions = vi.fn(async () => ({ items: [], hasMore: false }))
      mount({ searchSessions })
      const input = screen.getByPlaceholderText<HTMLInputElement>('Search sessions...')
      expect(input.maxLength).toBe(500)
      fireEvent.change(input, { target: { value: 'y'.repeat(501) } })
      expect(input.value).toBe('y'.repeat(500))
      const expected = `prefix${'x'.repeat(493)}`
      fireEvent.change(input, {
        target: { value: `prefix\0${'x'.repeat(493)}😀tail` },
      })

      expect(input.value).toBe(expected)
      expect(input.value.length).toBe(499)
      expect(input.value).not.toContain('\0')
      await act(async () => { await vi.advanceTimersByTimeAsync(250) })
      expect(searchSessions).toHaveBeenCalledOnce()
      expect(searchSessions).toHaveBeenCalledWith(expected, expect.any(AbortSignal))
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps local matches and shows a lightweight warning when Host search fails', async () => {
    vi.useFakeTimers()
    try {
      const searchSessions = vi.fn(async () => { throw new Error('index unavailable') })
      mount({
        useSessions: hook(sessionState([
          summary('local-hit', 1, { displayTitle: 'Needle title' }),
        ])),
        useWorkspaces: hook(workspaceState([workspace('alpha', ['local-hit'])])),
        searchSessions,
      })
      fireEvent.change(screen.getByPlaceholderText('Search sessions...'), {
        target: { value: 'needle' },
      })
      expect(screen.getByText('Needle title')).toBeTruthy()
      await act(async () => { await vi.advanceTimersByTimeAsync(250) })
      expect(screen.getByText('Needle title')).toBeTruthy()
      expect(screen.getByText('Content search is temporarily unavailable. Showing name matches.')).toBeTruthy()
      expect(screen.queryByText('No matching sessions')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('aborts a superseded request and ignores its stale result', async () => {
    vi.useFakeTimers()
    try {
      let resolveFirst!: (value: {
        items: { sessionId: SessionId; snippet: string }[]
        hasMore: boolean
      }) => void
      const first = new Promise<{
        items: { sessionId: SessionId; snippet: string }[]
        hasMore: boolean
      }>((resolve) => { resolveFirst = resolve })
      const searchSessions = vi.fn((query: string, _signal: AbortSignal) => query === 'first'
        ? first
        : Promise.resolve({
          items: [{ sessionId: sid('second-hit'), snippet: 'second excerpt' }],
          hasMore: false,
        }))
      mount({
        useSessions: hook(sessionState([
          summary('first-hit', 2, { displayTitle: 'Old result' }),
          summary('second-hit', 1, { displayTitle: 'Fresh result' }),
        ])),
        searchSessions,
      })
      const input = screen.getByPlaceholderText('Search sessions...')
      fireEvent.change(input, { target: { value: 'first' } })
      await act(async () => { await vi.advanceTimersByTimeAsync(250) })
      const firstSignal = searchSessions.mock.calls[0]?.[1] as AbortSignal
      expect(firstSignal.aborted).toBe(false)

      fireEvent.change(input, { target: { value: 'second' } })
      expect(firstSignal.aborted).toBe(true)
      await act(async () => { await vi.advanceTimersByTimeAsync(250) })
      expect(screen.getByText('Fresh result')).toBeTruthy()

      await act(async () => {
        resolveFirst({
          items: [{ sessionId: sid('first-hit'), snippet: 'stale excerpt' }],
          hasMore: false,
        })
        await Promise.resolve()
      })
      expect(screen.queryByText('Old result')).toBeNull()
      expect(screen.getByText('Fresh result')).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores a rejected request after it has been superseded', async () => {
    vi.useFakeTimers()
    try {
      let rejectFirst!: (reason: Error) => void
      const first = new Promise<never>((_resolve, reject) => { rejectFirst = reject })
      const searchSessions = vi.fn((query: string) => query === 'first'
        ? first
        : Promise.resolve({ items: [], hasMore: false }))
      mount({ searchSessions })
      const input = screen.getByPlaceholderText('Search sessions...')
      fireEvent.change(input, { target: { value: 'first' } })
      await act(async () => { await vi.advanceTimersByTimeAsync(250) })

      fireEvent.change(input, { target: { value: 'second' } })
      await act(async () => {
        rejectFirst(new Error('stale failure'))
        await Promise.resolve()
      })
      expect(screen.queryByText('Content search is temporarily unavailable. Showing name matches.')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows the no-sessions empty state in both modes and resolves an empty search', async () => {
    vi.useFakeTimers()
    try {
      const b = mount()
      expect(screen.getByText('No sessions yet')).toBeTruthy()
      b.store.actions.setGroupBy('flat')
      rerender(b, {})
      expect(screen.getByText('No sessions yet')).toBeTruthy()
      fireEvent.change(screen.getByPlaceholderText('Search sessions...'), { target: { value: 'x' } })
      expect(screen.getByText('Searching session history…')).toBeTruthy()
      await act(async () => { await vi.advanceTimersByTimeAsync(250) })
      expect(screen.getByText('No matching sessions')).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('rail state renders icon controls that request expansion', () => {
    vi.useFakeTimers()
    try {
      const expandSidebar = vi.fn()
      const b = mount({ wide: false, expandSidebar })
      // No wide chrome in rail state.
      expect(screen.queryByText('Workspaces')).toBeNull()
      expect(screen.queryByPlaceholderText('Search sessions...')).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'Search sessions' }))
      expect(expandSidebar).toHaveBeenCalledTimes(1)
      // The wide flip mounts the input and focuses it after the slide.
      rerender(b, { wide: true })
      const input = screen.getByPlaceholderText('Search sessions...')
      act(() => { vi.advanceTimersByTime(300) })
      expect(document.activeElement).toBe(input)
      // Wide search button is decorative (tabIndex -1, no expand call).
      fireEvent.click(screen.getByRole('button', { name: 'Search sessions' }))
      expect(expandSidebar).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the rail-opened search expanded when the initiating click reaches document', () => {
    vi.useFakeTimers()
    try {
      const b = mount({ wide: false })
      fireEvent.click(screen.getByRole('button', { name: 'Search sessions' }))
      rerender(b, { wide: true })
      // In the browser the rail click keeps bubbling to document after the
      // wide flip mounted the outside-click listener, with the unmounted rail
      // button as its target — outside searchRoot. It must not dismiss the
      // search it just opened.
      fireEvent.click(document.body)
      expect(screen.getByRole('button', { name: 'Search sessions' }).getAttribute('aria-expanded')).toBe('true')
      act(() => { vi.advanceTimersByTime(300) })
      expect(document.activeElement).toBe(screen.getByPlaceholderText('Search sessions...'))
      // The gesture has settled: outside clicks dismiss the search again.
      fireEvent.click(document.body)
      expect(screen.getByRole('button', { name: 'Search sessions' }).getAttribute('aria-expanded')).toBe('false')
    } finally {
      vi.useRealTimers()
    }
  })

  it('rail add-workspace raises the directory flow in place, with no menu and no expansion', () => {
    const expandSidebar = vi.fn()
    mount({ wide: false, expandSidebar, useWorkspaces: hook(workspaceState([workspace('alpha', [])])) })
    fireEvent.click(screen.getByRole('button', { name: 'Add workspace' }))
    expect(expandSidebar).not.toHaveBeenCalled()
    // Adding is the header's only action, so the gesture IS that action: no
    // one-row popover, and existing workspaces stay in the tree below.
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.queryByRole('menuitem', { name: 'alpha' })).toBeNull()
    expect(screen.getByTestId('directory-flow')).toBeTruthy()
  })

  it('hides the add button when no directory-flow occupant is composed', () => {
    mount({
      useWorkspaces: hook(workspaceState([workspace('alpha', [])])),
      useDirectoryFlow: bindSnapshotSelector({ getSnapshot: () => false, subscribe: () => () => {} }),
    })
    // Nothing to add with, so the header offers no dead button.
    expect(screen.queryByRole('button', { name: 'Add workspace' })).toBeNull()
    expect(screen.getByText('alpha')).toBeTruthy()
  })

  it('uses the full expanded Workspace section when resolving a Workspace drop half', () => {
    const insertWorkspaceBefore = vi.fn(async () => {})
    const sessions = sessionState(Array.from({ length: 5 }, (_, index) => summary(`beta-${index}`, index)))
    mount({
      useSessions: hook(sessions),
      useWorkspaces: hook(workspaceState([
        workspace('alpha', []),
        workspace('beta', sessions.ids),
        workspace('tail', []),
      ])),
      insertWorkspaceBefore,
    })
    fireEvent.click(screen.getByText('beta'))
    const source = screen.getByText('tail').closest('[role="treeitem"]') as HTMLElement
    let targetSection = screen.getByText('beta').closest('[role="treeitem"]')?.parentElement as HTMLElement
    while (targetSection.parentElement?.getAttribute('role') !== 'tree') {
      targetSection = targetSection.parentElement as HTMLElement
    }
    targetSection.getBoundingClientRect = () => ({
      top: 100, bottom: 300, left: 0, right: 200, width: 200, height: 200, x: 0, y: 100, toJSON: () => ({}),
    })
    fireEvent.dragStart(source, { dataTransfer: dragData() })
    // y=190 is below the header row but still in the top half of the whole
    // expanded section, so the target is before beta rather than after it.
    fireDrag(targetSection, 'drop', 190)
    expect(insertWorkspaceBefore).toHaveBeenCalledWith(wid('tail'), wid('beta'))
  })

  it('draws the first Workspace insertion boundary on the scroll container', () => {
    mount({
      useWorkspaces: hook(workspaceState([
        workspace('alpha', []),
        workspace('beta', []),
      ])),
    })
    const source = screen.getByText('beta').closest('[role="treeitem"]') as HTMLElement
    let firstSection = screen.getByText('alpha').closest('[role="treeitem"]')?.parentElement as HTMLElement
    while (firstSection.parentElement?.getAttribute('role') !== 'tree') {
      firstSection = firstSection.parentElement as HTMLElement
    }
    firstSection.getBoundingClientRect = () => ({
      top: 100, bottom: 134, left: 0, right: 200, width: 200, height: 34, x: 0, y: 100, toJSON: () => ({}),
    })
    fireEvent.dragStart(source, { dataTransfer: dragData() })
    fireDrag(firstSection, 'dragOver', 105)
    expect(firstSection.parentElement?.className).toContain('listTopDropActive')
    const marker = firstSection.parentElement?.previousElementSibling
    expect(marker?.className).toContain('listTopDropIndicator')
  })

  it('accepts a document-level drop and commits the last Workspace marker on drag end', () => {
    const insertWorkspaceBefore = vi.fn(async () => {})
    mount({
      useWorkspaces: hook(workspaceState([
        workspace('alpha', []),
        workspace('beta', []),
        workspace('tail', []),
      ])),
      insertWorkspaceBefore,
    })
    const source = screen.getByText('tail').closest('[role="treeitem"]') as HTMLElement
    let target = screen.getByText('beta').closest('[role="treeitem"]')?.parentElement as HTMLElement
    while (target.parentElement?.getAttribute('role') !== 'tree') {
      target = target.parentElement as HTMLElement
    }
    target.getBoundingClientRect = () => ({
      top: 100, bottom: 134, left: 0, right: 200, width: 200, height: 34, x: 0, y: 100, toJSON: () => ({}),
    })
    fireEvent.dragStart(source, { dataTransfer: dragData() })
    fireDrag(target, 'dragOver', 105)
    const outsideDrop = createEvent.drop(document.body)
    Object.defineProperty(outsideDrop, 'dataTransfer', { value: dragData() })
    fireEvent(document.body, outsideDrop)
    expect(outsideDrop.defaultPrevented).toBe(true)
    fireEvent.dragEnd(source)
    expect(insertWorkspaceBefore).toHaveBeenCalledWith(wid('tail'), wid('beta'))
  })

  it('drag reorder reports the anchor to insertSessionBefore and skips no-op drops', () => {
    const insertSessionBefore = vi.fn(async () => {})
    const sessions = sessionState([summary('one', 3), summary('two', 2), summary('three', 1)])
    mount({
      useSessions: hook(sessions),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['one', 'two', 'three'])])),
      insertSessionBefore,
    })
    fireEvent.click(screen.getByText('alpha'))
    const rows = screen.getAllByRole('treeitem').slice(1) // drop the group header
    const [one, , three] = rows as [HTMLElement, HTMLElement, HTMLElement]
    three.getBoundingClientRect = () => ({
      top: 200, bottom: 234, left: 0, right: 200, width: 200, height: 34, x: 0, y: 200, toJSON: () => ({}),
    })
    const dataTransfer = dragData()
    fireEvent.dragStart(one, { dataTransfer })
    // Drop on the top half of "three": insert one before three.
    fireDrag(three, 'dragOver', 205)
    fireDrag(three, 'drop', 205)
    expect(insertSessionBefore).toHaveBeenCalledWith(wid('alpha'), sid('one'), sid('three'))

    // Dropping right back onto its own position is a no-op — top half
    // (anchor = itself) and bottom half (anchor = the next root) alike.
    fireEvent.dragStart(one, { dataTransfer })
    one.getBoundingClientRect = () => ({
      top: 100, bottom: 134, left: 0, right: 200, width: 200, height: 34, x: 0, y: 100, toJSON: () => ({}),
    })
    fireDrag(one, 'dragOver', 105)
    fireDrag(one, 'drop', 105)
    expect(insertSessionBefore).toHaveBeenCalledTimes(1)
    fireEvent.dragStart(one, { dataTransfer })
    fireDrag(one, 'drop', 130)
    expect(insertSessionBefore).toHaveBeenCalledTimes(1)
  })

  it('persists Ungrouped drag order in both modes without writing a Host Workspace account', async () => {
    const insertSessionBefore = vi.fn(async () => {})
    const sessions = sessionState([summary('one', 3), summary('two', 2), summary('three', 1)])
    const b = mount({
      useSessions: hook(sessions),
      useWorkspaces: hook(workspaceState([])),
      insertSessionBefore,
    })
    fireEvent.click(screen.getByText('Ungrouped'))

    const dragAfter = (sourceTitle: string, targetTitle: string): void => {
      const source = screen.getByText(sourceTitle).closest('[role="treeitem"]') as HTMLElement
      const target = screen.getByText(targetTitle).closest('[role="treeitem"]') as HTMLElement
      target.getBoundingClientRect = () => ({
        top: 150, bottom: 184, left: 0, right: 200, width: 200, height: 34, x: 0, y: 150, toJSON: () => ({}),
      })
      fireEvent.dragStart(source, { dataTransfer: dragData() })
      fireDrag(target, 'drop', 180)
    }

    dragAfter('one', 'three')
    expect(b.store.getSnapshot().sessionOrderByAccount[UNGROUPED_KEY]).toEqual(['two', 'three', 'one'])
    dragAfter('two', 'one')
    expect(b.store.getSnapshot().sessionOrderByAccount[UNGROUPED_KEY]).toEqual(['three', 'one', 'two'])
    expect(insertSessionBefore).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'View options' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Last updated' }))
    await waitFor(() => {
      expect(b.store.getSnapshot().sessionOrderByAccount[UNGROUPED_KEY]).toEqual(['one', 'two', 'three'])
    })
    dragAfter('one', 'three')
    expect(b.store.getSnapshot().sessionOrderByAccount[UNGROUPED_KEY]).toEqual(['two', 'three', 'one'])
    expect(insertSessionBefore).not.toHaveBeenCalled()

    b.view.unmount()
    const restored = mount({
      useSessions: hook(sessions),
      useWorkspaces: hook(workspaceState([])),
      insertSessionBefore,
    })
    expect(restored.store.getSnapshot().sessionOrderByAccount[UNGROUPED_KEY]).toEqual(['two', 'three', 'one'])
    expect(screen.getAllByRole('treeitem').slice(1).map(row => row.textContent)).toEqual([
      expect.stringContaining('two'),
      expect.stringContaining('three'),
      expect.stringContaining('one'),
    ])
  })

  it('still sends the reorder when the dragged row left the group mid-drag', () => {
    const insertSessionBefore = vi.fn(async () => {})
    const sessions = sessionState([summary('one', 2), summary('two', 1)])
    const b = mount({
      useSessions: hook(sessions),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['one', 'two'])])),
      insertSessionBefore,
    })
    fireEvent.click(screen.getByText('alpha'))
    const one = screen.getByText('one').closest('[role="treeitem"]') as HTMLElement
    fireEvent.dragStart(one, { dataTransfer: dragData() })
    // The host dropped "one" from the workspace account while the drag is in
    // flight: the source index is gone but the drop still resolves its anchor.
    rerender(b, { useWorkspaces: hook(workspaceState([workspace('alpha', ['two'])])) })
    const two = screen.getByText('two').closest('[role="treeitem"]') as HTMLElement
    two.getBoundingClientRect = () => ({
      top: 150, bottom: 184, left: 0, right: 200, width: 200, height: 34, x: 0, y: 150, toJSON: () => ({}),
    })
    fireDrag(two, 'drop', 155)
    expect(insertSessionBefore).toHaveBeenCalledWith(wid('alpha'), sid('one'), sid('two'))
  })

  it('drag end without a drop clears markers; bottom-half drop appends past the last row', () => {
    const insertSessionBefore = vi.fn(async () => {})
    const sessions = sessionState([summary('one', 2), summary('two', 1)])
    mount({
      useSessions: hook(sessions),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['one', 'two'])])),
      insertSessionBefore,
    })
    fireEvent.click(screen.getByText('alpha'))
    const [one, two] = screen.getAllByRole('treeitem').slice(1) as [HTMLElement, HTMLElement]
    two.getBoundingClientRect = () => ({
      top: 150, bottom: 184, left: 0, right: 200, width: 200, height: 34, x: 0, y: 150, toJSON: () => ({}),
    })
    const dataTransfer = dragData()
    fireEvent.dragStart(one, { dataTransfer })
    fireEvent.dragEnd(one)
    // The drag ended: rows no longer accept drops.
    fireDrag(two, 'drop', 180)
    expect(insertSessionBefore).not.toHaveBeenCalled()

    // Bottom half of the last row: append (anchor omitted).
    fireEvent.dragStart(one, { dataTransfer })
    fireDrag(two, 'dragOver', 180)
    fireDrag(two, 'drop', 180)
    expect(insertSessionBefore).toHaveBeenCalledWith(wid('alpha'), sid('one'), undefined)
  })

  it('accepts a document-level drop and commits the last Session marker on drag end', () => {
    const insertSessionBefore = vi.fn(async () => {})
    mount({
      useSessions: hook(sessionState([summary('one', 2), summary('two', 1)])),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['one', 'two'])])),
      insertSessionBefore,
    })
    fireEvent.click(screen.getByText('alpha'))
    const [one, two] = screen.getAllByRole('treeitem').slice(1) as [HTMLElement, HTMLElement]
    two.getBoundingClientRect = () => ({
      top: 150, bottom: 184, left: 0, right: 200, width: 200, height: 34, x: 0, y: 150, toJSON: () => ({}),
    })
    fireEvent.dragStart(one, { dataTransfer: dragData() })
    fireDrag(two, 'dragOver', 180)
    const outsideDrop = createEvent.drop(document.body)
    Object.defineProperty(outsideDrop, 'dataTransfer', { value: dragData() })
    fireEvent(document.body, outsideDrop)
    expect(outsideDrop.defaultPrevented).toBe(true)
    fireEvent.dragEnd(one)
    expect(insertSessionBefore).toHaveBeenCalledWith(wid('alpha'), sid('one'), undefined)
  })

  it('logs and keeps the order when the reorder call rejects', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const insertSessionBefore = vi.fn(async () => { throw new Error('stale anchor') })
      const sessions = sessionState([summary('one', 2), summary('two', 1)])
      mount({
        useSessions: hook(sessions),
        useWorkspaces: hook(workspaceState([workspace('alpha', ['one', 'two'])])),
        insertSessionBefore,
      })
      fireEvent.click(screen.getByText('alpha'))
      const [one, two] = screen.getAllByRole('treeitem').slice(1) as [HTMLElement, HTMLElement]
      two.getBoundingClientRect = () => ({
        top: 150, bottom: 184, left: 0, right: 200, width: 200, height: 34, x: 0, y: 150, toJSON: () => ({}),
      })
      const dataTransfer = dragData()
      fireEvent.dragStart(one, { dataTransfer })
      fireDrag(two, 'drop', 180)
      await waitFor(() => { expect(warn).toHaveBeenCalledWith('session reorder rejected:', expect.any(Error)) })
    } finally {
      warn.mockRestore()
    }
  })

  it('renames a workspace through the row menu dialog', async () => {
    let resolveRename!: () => void
    const renameWorkspace = vi.fn(() => new Promise<void>((resolve) => { resolveRename = resolve }))
    mount({
      useWorkspaces: hook(workspaceState([workspace('alpha', [], 'Alpha'), workspace('beta', [], 'Beta')])),
      renameWorkspace,
    })
    fireEvent.click(screen.getByRole('button', { name: 'Workspace actions for Alpha' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
    const input = screen.getByLabelText<HTMLInputElement>('Workspace name')
    expect(input.value).toBe('Alpha')
    // Unchanged and blank names stay blocked.
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Rename' }).disabled).toBe(true)
    fireEvent.change(input, { target: { value: '   ' } })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Rename' }).disabled).toBe(true)
    // A duplicate of another workspace's title shows the inline conflict.
    fireEvent.change(input, { target: { value: ' Beta ' } })
    expect(screen.getByRole('alert').textContent).toBe('A workspace named “Beta” already exists.')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Rename' }).disabled).toBe(true)
    fireEvent.change(input, { target: { value: 'Gamma' } })
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    expect(renameWorkspace).toHaveBeenCalledWith(wid('alpha'), 'Gamma')
    // While renaming: input disabled, close blocked, Enter ignored.
    expect(input.disabled).toBe(true)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.getByRole('dialog')).toBeTruthy()
    await act(async () => { resolveRename() })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('rename via Enter, failure surfaces the error, Cancel closes', async () => {
    const renameWorkspace = vi.fn(async () => { throw new Error('rename conflict') })
    mount({
      useWorkspaces: hook(workspaceState([workspace('alpha', [], 'Alpha')])),
      renameWorkspace,
    })
    fireEvent.click(screen.getByRole('button', { name: 'Workspace actions for Alpha' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
    const input = screen.getByLabelText<HTMLInputElement>('Workspace name')
    // Enter with a blocked draft (unchanged) does nothing.
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(renameWorkspace).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: 'Renamed' } })
    fireEvent.keyDown(input, { key: 'a' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(renameWorkspace).toHaveBeenCalledWith(wid('alpha'), 'Renamed')
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('rename conflict') })
    // The dialog stays for retry; typing clears the error; Cancel closes.
    fireEvent.change(input, { target: { value: 'Renamed2' } })
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('reports non-Error rename failures as text', async () => {
    const renameWorkspace = vi.fn(async () => { throw 'denied' })
    mount({
      useWorkspaces: hook(workspaceState([workspace('alpha', [], 'Alpha')])),
      renameWorkspace,
    })
    fireEvent.click(screen.getByRole('button', { name: 'Workspace actions for Alpha' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
    fireEvent.change(screen.getByLabelText('Workspace name'), { target: { value: 'Other' } })
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('denied') })
  })

  it('confirms Workspace deletion, explains retention, and blocks duplicate submission', async () => {
    let resolveDelete!: () => void
    const deleteWorkspace = vi.fn(() => new Promise<void>((resolve) => { resolveDelete = resolve }))
    const browser = mount({
      useWorkspaces: hook(workspaceState([workspace('alpha', ['session'], 'Alpha')])),
      deleteWorkspace,
    })
    fireEvent.click(screen.getByRole('button', { name: 'Workspace actions for Alpha' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete workspace' }))
    const dialog = screen.getByRole('dialog', { name: 'Delete workspace' })
    expect(dialog.textContent).toContain('This removes “Alpha” from the workspace list')
    expect(dialog.textContent).toContain('The folder and session logs will be kept')
    expect(dialog.textContent).toContain('Its sessions will appear under Ungrouped')

    const confirm = screen.getByRole<HTMLButtonElement>('button', { name: 'Delete workspace' })
    fireEvent.click(confirm)
    fireEvent.click(confirm)
    expect(deleteWorkspace).toHaveBeenCalledOnce()
    expect(deleteWorkspace).toHaveBeenCalledWith(wid('alpha'))
    expect(confirm.disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Cancel' }).disabled).toBe(true)
    expect(screen.getByRole('status').textContent).toBe('Deleting workspace…')
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.getByRole('dialog', { name: 'Delete workspace' })).toBeTruthy()
    await act(async () => { resolveDelete() })
    // RPC success alone does not close: the component waits until its
    // useWorkspaces projection has committed the removal, preventing a stale
    // Workspace frame from leaking into the next gesture.
    expect(screen.getByRole('dialog', { name: 'Delete workspace' })).toBeTruthy()
    rerender(browser, { useWorkspaces: hook(workspaceState([])) })
    expect(screen.queryByRole('dialog', { name: 'Delete workspace' })).toBeNull()
  })

  it('keeps the delete dialog open on failure and allows retry or cancellation', async () => {
    const deleteWorkspace = vi.fn()
      .mockRejectedValueOnce(new Error('storage unavailable'))
      .mockRejectedValueOnce('denied')
    mount({
      useWorkspaces: hook(workspaceState([workspace('alpha', [], 'Alpha')])),
      deleteWorkspace,
    })
    fireEvent.click(screen.getByRole('button', { name: 'Workspace actions for Alpha' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete workspace' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete workspace' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('storage unavailable') })
    expect(screen.getByRole('dialog', { name: 'Delete workspace' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Delete workspace' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('denied') })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog', { name: 'Delete workspace' })).toBeNull()
  })

  it('Cancel, Escape, and Close dismiss deletion without calling the action', () => {
    const deleteWorkspace = vi.fn(async () => {})
    mount({
      useWorkspaces: hook(workspaceState([workspace('alpha', [], 'Alpha')])),
      deleteWorkspace,
    })
    const open = () => {
      fireEvent.click(screen.getByRole('button', { name: 'Workspace actions for Alpha' }))
      fireEvent.click(screen.getByRole('menuitem', { name: 'Delete workspace' }))
    }
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    open()
    fireEvent.keyDown(document, { key: 'Escape' })
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(deleteWorkspace).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog', { name: 'Delete workspace' })).toBeNull()
  })

  it('search hides drag affordances (rows are not draggable during search)', () => {
    const sessions = sessionState([summary('needle-a', 2, { displayTitle: 'Needle A' })])
    mount({
      useSessions: hook(sessions),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['needle-a'])])),
    })
    fireEvent.change(screen.getByPlaceholderText('Search sessions...'), { target: { value: 'needle' } })
    const row = screen.getByText('Needle A').closest('[role="treeitem"]') as HTMLElement
    expect(row.hasAttribute('draggable')).toBe(false)
  })
})

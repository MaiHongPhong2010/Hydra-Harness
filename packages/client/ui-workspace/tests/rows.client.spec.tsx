// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import type { SessionId, WorkspaceId } from '@hydraharness/harness-client-runtime/client'
import { makeTranslate } from '@hydraharness/harness-client-test-runtime'
import { en as commonEn } from '@hydraharness/harness-client-locale/src/locales/en.ts'
import type { RowDragProps } from '../src/client/rows/Rows.tsx'
import { ProjectRowItem, SearchResultItem, SessionNodeItem } from '../src/client/rows/Rows.tsx'
import type { GroupNode, SearchResultNode, SessionNode } from '../src/client/tree.ts'
import { en } from '../src/client/locales.ts'

let selectMenu: ((id: string) => void) | undefined
vi.mock('@hydraharness/harness-client-ui-primitives', async (importOriginal) => {
  const primitives = await importOriginal<typeof import('@hydraharness/harness-client-ui-primitives')>()
  const RealMenu = primitives.Menu
  return {
    ...primitives,
    Menu: (props: ComponentProps<typeof RealMenu>) => {
      selectMenu = props.onSelect
      return <RealMenu {...props} />
    },
  }
})

afterEach(cleanup)

// Standard locale seat stub mirroring the real ns → common → key chain (en default).
const t = makeTranslate(en, commonEn) as never

const sid = (id: string) => id as SessionId
const wid = (id: string) => id as WorkspaceId

/** Half detection reads the row rect; jsdom rects are all-zero by default. */
function stubRect(row: HTMLElement): void {
  row.getBoundingClientRect = () => ({
    top: 100, bottom: 134, left: 0, right: 200, width: 200, height: 34,
    x: 0, y: 100, toJSON: () => ({}),
  })
}

function dragProps(overrides: Partial<RowDragProps> = {}): RowDragProps {
  return {
    start: vi.fn(), active: false, marker: null,
    hover: vi.fn(), drop: vi.fn(), end: vi.fn(),
    ...overrides,
  }
}

/** Install the async browser clipboard and restore its prior host shape. */
function installClipboard(writeText: (text: string) => Promise<void>): () => void {
  const prior = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  })
  return () => {
    if (prior === undefined) Reflect.deleteProperty(navigator, 'clipboard')
    else Object.defineProperty(navigator, 'clipboard', prior)
  }
}

const dataTransfer = { effectAllowed: '', dropEffect: '', setData: vi.fn() }

/** jsdom lacks DragEvent — the fireEvent fallback drops clientY, so pin it on the built event. */
function fireDrag(row: HTMLElement, kind: 'dragOver' | 'drop', clientY: number): void {
  const event = kind === 'dragOver' ? createEvent.dragOver(row) : createEvent.drop(row)
  Object.defineProperty(event, 'clientY', { value: clientY })
  Object.defineProperty(event, 'dataTransfer', { value: { ...dataTransfer } })
  fireEvent(row, event)
}

describe('workspace browser rows', () => {
  it('omits only an empty leading status slot in the hierarchy-free flat list', () => {
    const idle: SessionNode = {
      id: sid('flat'), title: 'Flat Session', blank: false, running: false,
      runningSubagentCount: 0, completed: false, updatedAt: 0,
    }
    const view = render(<SessionNodeItem onDelete={vi.fn()} node={idle} currentId={undefined} now={0} onOpen={vi.fn()}
      onRename={vi.fn()} onFork={vi.fn()} onArchive={vi.fn()} flat t={t} />)
    const title = screen.getByText('Flat Session')
    expect(title.previousElementSibling).toBeNull()

    view.rerender(<SessionNodeItem onDelete={vi.fn()} node={{ ...idle, running: true }} currentId={undefined} now={0}
      onOpen={vi.fn()} onRename={vi.fn()} onFork={vi.fn()} onArchive={vi.fn()} flat t={t} />)
    expect(screen.getByText('Flat Session').previousElementSibling?.querySelector('[data-state="ongoing"]')).toBeTruthy()
  })

  it('renders a selected content-search row and opens only its session', () => {
    const onOpen = vi.fn()
    const result: SearchResultNode = {
      id: sid('result'),
      title: 'Result title',
      workspace: 'Workspace context',
      running: true,
      runningSubagentCount: 0,
      completed: false,
      snippet: 'matching message excerpt',
    }
    render(<SearchResultItem result={result} currentId={result.id} onOpen={onOpen} t={t} />)
    const row = screen.getByRole('treeitem')
    expect(row.getAttribute('aria-selected')).toBe('true')
    expect(screen.getByText('Workspace context')).toBeTruthy()
    expect(screen.getByText('matching message excerpt')).toBeTruthy()
    expect(row.querySelector('[data-state="ongoing"]')).toBeTruthy()
    expect(screen.getByText('Running')).toBeTruthy()
    expect(row.hasAttribute('draggable')).toBe(false)
    fireEvent.click(row)
    expect(onOpen).toHaveBeenCalledWith(result.id)
  })

  it.each([
    ['approval', 'Waiting for approval'],
    ['plan-review', 'Plan awaiting review'],
    ['question', 'Waiting for answer'],
  ] as const)('shows %s ahead of running in search results', (pendingInteraction, label) => {
    const result: SearchResultNode = {
      id: sid(pendingInteraction), title: 'Needs input', workspace: 'Project',
      pendingInteraction, running: true, runningSubagentCount: 0, completed: false,
    }
    render(<SearchResultItem result={result} currentId={undefined} onOpen={vi.fn()} t={t} />)
    const row = screen.getByRole('treeitem')
    expect(row.querySelector('[data-state="warning"]')).toBeTruthy()
    expect(row.querySelector('[data-state="ongoing"]')).toBeNull()
    expect(screen.getByText(label)).toBeTruthy()
  })

  it('renders an active Workspace and keeps its create action separate from toggling', () => {
    const onToggle = vi.fn()
    const onCreate = vi.fn()
    const group: GroupNode = {
      key: 'project', workspaceId: wid('project'), cwd: '/projects/project', createdAt: 0, label: 'Project',
      sessionCount: 1, expanded: true, containsCurrent: true, sessions: [],
    }
    render(<ProjectRowItem group={group} onToggle={onToggle} onCreate={onCreate} t={t} />)

    expect(screen.getByRole('treeitem').getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'New session in Project' }))
    expect(onCreate).toHaveBeenCalledOnce()
    expect(onToggle).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('Project'))
    expect(onToggle).toHaveBeenCalledOnce()
  })

  it('renders and opens a selected running Session row', () => {
    const node: SessionNode = {
      id: sid('session'), title: 'Session', blank: false, running: true,
      runningSubagentCount: 0, completed: false, updatedAt: 0,
    }
    const onOpen = vi.fn()
    render(
      <SessionNodeItem onDelete={vi.fn()} node={node} currentId={node.id} now={0} onOpen={onOpen}
        onRename={vi.fn()} onFork={vi.fn()} onArchive={vi.fn()} t={t} />,
    )

    const row = screen.getByRole('treeitem')
    expect(row.getAttribute('aria-selected')).toBe('true')
    expect(row.hasAttribute('aria-expanded')).toBe(false)
    expect(screen.queryByRole('button', { name: /Show \d+ more sessions|Show less/ })).toBeNull()
    fireEvent.click(row)
    expect(onOpen).toHaveBeenCalledWith(node.id)
  })

  it('shows the green done dot only on a finished, unviewed session (live activity wins the slot)', () => {
    const renderRow = (over: Partial<SessionNode>) => render(
      <SessionNodeItem onDelete={vi.fn()}
        node={{
          id: sid('s1'), title: 'One', blank: false, running: false,
          runningSubagentCount: 0, completed: false, updatedAt: 0, ...over,
        }}
        currentId={undefined} now={0} onOpen={vi.fn()}
        onRename={vi.fn()} onFork={vi.fn()} onArchive={vi.fn()} t={t}
      />,
    )
    const stateDot = (view: ReturnType<typeof renderRow>) =>
      view.container.querySelector('[data-state]')
    // No completion reminder, not running: no state dot at all.
    const plain = renderRow({})
    expect(stateDot(plain)).toBeNull()
    plain.unmount()
    // Completed while unviewed: the green done dot.
    const done = renderRow({ completed: true })
    expect(done.container.querySelector('[data-state="done"]')).not.toBeNull()
    done.unmount()
    // Running wins the slot: the animated ongoing dot, no done dot.
    const running = renderRow({ completed: true, running: true })
    expect(running.container.querySelector('[data-state="ongoing"]')).not.toBeNull()
    expect(running.container.querySelector('[data-state="done"]')).toBeNull()
    running.unmount()
    // Descendant activity also wins until the last running descendant stops.
    const delegated = renderRow({ completed: true, runningSubagentCount: 1 })
    expect(delegated.container.querySelector('[data-state="ongoing"]')).not.toBeNull()
    expect(delegated.container.querySelector('[data-state="done"]')).toBeNull()
  })

  it('shows descendant activity without describing an idle parent as running', () => {
    vi.useFakeTimers()
    try {
      const node: SessionNode = {
        id: sid('owner'), title: 'Delegating', blank: false, running: false,
        runningSubagentCount: 2, completed: false, updatedAt: 0,
      }
      render(<SessionNodeItem onDelete={vi.fn()} node={node} currentId={undefined} now={0} onOpen={vi.fn()}
        onRename={vi.fn()} onFork={vi.fn()} onArchive={vi.fn()} t={t} />)
      const row = screen.getByRole('treeitem')
      expect(row.querySelector('[data-state="ongoing"]')).not.toBeNull()
      expect(screen.getByText('2 subagents running')).toBeTruthy()
      expect(screen.queryByText('Running')).toBeNull()

      fireEvent.pointerEnter(row.parentElement as HTMLElement)
      act(() => { vi.advanceTimersByTime(500) })
      expect(screen.getAllByText('2 subagents running')).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps descendant activity secondary while the parent is running', () => {
    vi.useFakeTimers()
    try {
      const node: SessionNode = {
        id: sid('owner'), title: 'Delegating', blank: false, running: true,
        runningSubagentCount: 1, completed: false, updatedAt: 0,
      }
      render(<SessionNodeItem onDelete={vi.fn()} node={node} currentId={undefined} now={0} onOpen={vi.fn()}
        onRename={vi.fn()} onFork={vi.fn()} onArchive={vi.fn()} t={t} />)
      const row = screen.getByRole('treeitem')
      expect(row.querySelectorAll('[data-state="ongoing"]')).toHaveLength(1)
      expect(screen.getByText('Running')).toBeTruthy()
      expect(screen.getByText('1 subagent running')).toBeTruthy()

      fireEvent.pointerEnter(row.parentElement as HTMLElement)
      act(() => { vi.advanceTimersByTime(500) })
      expect(screen.getAllByText('Running')).toHaveLength(2)
      expect(screen.getAllByText('1 subagent running')).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps child activity as a secondary status while user attention is primary', () => {
    const node: SessionNode = {
      id: sid('owner'), title: 'Needs input', blank: false, pendingInteraction: 'question',
      running: false, runningSubagentCount: 1, completed: false, updatedAt: 0,
    }
    render(<SessionNodeItem onDelete={vi.fn()} node={node} currentId={undefined} now={0} onOpen={vi.fn()}
      onRename={vi.fn()} onFork={vi.fn()} onArchive={vi.fn()} t={t} />)
    const row = screen.getByRole('treeitem')
    expect(row.querySelector('[data-state="warning"]')).not.toBeNull()
    expect(row.querySelector('[data-state="ongoing"]')).toBeNull()
    expect(screen.getByText('Waiting for answer')).toBeTruthy()
    expect(screen.getByText('1 subagent running')).toBeTruthy()
  })

  it('shows the green done dot on a finished search result row', () => {
    render(<SearchResultItem
      result={{
        id: sid('result'), title: 'Done', workspace: 'Workspace', running: false,
        runningSubagentCount: 0, completed: true,
      }}
      currentId={undefined} onOpen={vi.fn()} t={t}
    />)
    expect(screen.getByRole('treeitem').querySelector('[data-state="done"]')).not.toBeNull()
  })

  it('workspace row menu opens on the ellipsis, renames, and shows the danger delete row', () => {
    const onRename = vi.fn()
    const onDelete = vi.fn()
    const onToggle = vi.fn()
    const group: GroupNode = {
      key: 'project', workspaceId: wid('project'), cwd: '/projects/project', createdAt: 0, label: 'Project',
      sessionCount: 0, expanded: false, containsCurrent: false, sessions: [],
    }
    render(<ProjectRowItem
      group={group} onToggle={onToggle} onCreate={vi.fn()}
      actions={{ rename: onRename, delete: onDelete }} t={t}
    />)
    fireEvent.click(screen.getByRole('button', { name: 'Workspace actions for Project' }))
    // Opening the menu neither toggles the group nor renames yet.
    expect(onToggle).not.toHaveBeenCalled()
    expect(screen.getByRole('menuitem', { name: 'Delete workspace' }).className).toMatch(/danger/)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
    expect(onRename).toHaveBeenCalledOnce()
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Workspace actions for Project' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete workspace' }))
    expect(screen.queryByRole('menu')).toBeNull()
    expect(onRename).toHaveBeenCalledOnce()
    expect(onDelete).toHaveBeenCalledOnce()
    // Escape closes without selecting (Menu onClose path).
    fireEvent.click(screen.getByRole('button', { name: 'Workspace actions for Project' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('starts and ends workspace row dragging with the workspace key', () => {
    const start = vi.fn()
    const end = vi.fn()
    const group: GroupNode = {
      key: 'project', workspaceId: wid('project'), cwd: '/projects/project', createdAt: 0, label: 'Project',
      sessionCount: 0, expanded: false, containsCurrent: false, sessions: [],
    }
    render(<ProjectRowItem
      group={group} onToggle={vi.fn()} onCreate={vi.fn()} drag={{ start, end }} t={t}
    />)
    const dataTransfer = { effectAllowed: '', setData: vi.fn() }
    const row = screen.getByRole('treeitem')
    fireEvent.dragStart(row, { dataTransfer })
    expect(dataTransfer.effectAllowed).toBe('move')
    expect(dataTransfer.setData).toHaveBeenCalledWith('text/plain', 'project')
    expect(start).toHaveBeenCalledOnce()
    fireEvent.dragEnd(row)
    expect(end).toHaveBeenCalledOnce()
  })

  it('workspace hover card shows its details and copies the full directory path', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn(async () => {})
    const restoreClipboard = installClipboard(writeText)
    try {
      const group: GroupNode = {
        key: 'project', workspaceId: wid('project'), cwd: '/projects/project', createdAt: 0, label: 'Project',
        sessionCount: 0, expanded: false, containsCurrent: false, sessions: [],
      }
      render(<ProjectRowItem group={group} onToggle={vi.fn()} onCreate={vi.fn()} t={t} />)
      fireEvent.pointerEnter(screen.getByRole('treeitem').parentElement as HTMLElement)
      act(() => { vi.advanceTimersByTime(500) })
      // Card body: full title + cwd + absolute creation time.
      expect(screen.getAllByText('Project')).toHaveLength(2)
      expect(screen.getByText('/projects/project')).toBeTruthy()
      expect(screen.getByText(/^Created \d+-\d+-\d+ /)).toBeTruthy()
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy: /projects/project' })) })
      expect(writeText).toHaveBeenCalledWith('/projects/project')
      expect(screen.getByRole('status').textContent).toBe('Copied')
    } finally {
      restoreClipboard()
      vi.useRealTimers()
    }
  })

  it('workspace hover card shows a POSIX home descendant as ~ and still copies the full path', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn(async () => {})
    const restoreClipboard = installClipboard(writeText)
    try {
      const group: GroupNode = {
        key: 'project', workspaceId: wid('project'), cwd: '/home/u/Documents/project', createdAt: 0, label: 'Project',
        sessionCount: 0, expanded: false, containsCurrent: false, sessions: [],
      }
      render(<ProjectRowItem group={group} home="/home/u" onToggle={vi.fn()} onCreate={vi.fn()} t={t} />)
      fireEvent.pointerEnter(screen.getByRole('treeitem').parentElement as HTMLElement)
      act(() => { vi.advanceTimersByTime(500) })
      expect(screen.getByText('~/Documents/project')).toBeTruthy()
      expect(screen.queryByText('/home/u/Documents/project')).toBeNull()
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy: /home/u/Documents/project' })) })
      expect(writeText).toHaveBeenCalledWith('/home/u/Documents/project')
    } finally {
      restoreClipboard()
      vi.useRealTimers()
    }
  })

  it('workspace hover card without a directory omits the path and copy action', async () => {
    vi.useFakeTimers()
    try {
      const group: GroupNode = {
        key: 'project', workspaceId: wid('project'), cwd: undefined, createdAt: 0, label: 'Project',
        sessionCount: 0, expanded: false, containsCurrent: false, sessions: [],
      }
      render(<ProjectRowItem group={group} home="/home/u" onToggle={vi.fn()} onCreate={vi.fn()} t={t} />)
      fireEvent.pointerEnter(screen.getByRole('treeitem').parentElement as HTMLElement)
      act(() => { vi.advanceTimersByTime(500) })
      expect(screen.getAllByText('Project')).toHaveLength(2)
      expect(screen.getByText(/^Created \d+-\d+-\d+ /)).toBeTruthy()
      expect(screen.queryByRole('button', { name: /^Copy:/ })).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('workspace hover card leaves a Windows path verbatim', async () => {
    vi.useFakeTimers()
    try {
      const group: GroupNode = {
        key: 'project', workspaceId: wid('project'), cwd: 'C:\\Users\\u\\project', createdAt: 0, label: 'Project',
        sessionCount: 0, expanded: false, containsCurrent: false, sessions: [],
      }
      render(<ProjectRowItem group={group} home="C:\\Users\\u" onToggle={vi.fn()} onCreate={vi.fn()} t={t} />)
      fireEvent.pointerEnter(screen.getByRole('treeitem').parentElement as HTMLElement)
      act(() => { vi.advanceTimersByTime(500) })
      expect(screen.getByText('C:\\Users\\u\\project')).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('ungrouped bucket exposes only the orphan-chat delete action', () => {
    const onDeleteUngrouped = vi.fn()
    const group: GroupNode = {
      key: '', workspaceId: undefined, cwd: undefined, createdAt: undefined, label: 'Ungrouped',
      sessionCount: 0, expanded: false, containsCurrent: false, sessions: [],
    }
    render(<ProjectRowItem
      group={group} onToggle={vi.fn()} onCreate={vi.fn()}
      onDeleteUngrouped={onDeleteUngrouped} t={t}
    />)
    fireEvent.click(screen.getByRole('button', { name: 'Ungrouped actions' }))
    expect(screen.queryByRole('menuitem', { name: 'Rename' })).toBeNull()
    expect(screen.getByRole('menuitem', { name: 'Delete orphan chats' }).className).toMatch(/danger/)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete orphan chats' }))
    expect(onDeleteUngrouped).toHaveBeenCalledOnce()
  })

  it('keeps the Ungrouped delete action disabled when no deletable chat exists', () => {
    const onDeleteUngrouped = vi.fn()
    const onToggle = vi.fn()
    const group: GroupNode = {
      key: '', workspaceId: undefined, cwd: undefined, createdAt: undefined, label: 'Ungrouped',
      sessionCount: 1, expanded: true, containsCurrent: true, sessions: [],
    }
    render(<ProjectRowItem
      group={group} onToggle={onToggle} onCreate={vi.fn()}
      onDeleteUngrouped={onDeleteUngrouped} ungroupedDeleteDisabled t={t}
    />)
    const row = screen.getByRole('treeitem')
    fireEvent.keyDown(screen.getByText('Ungrouped'), { key: 'Enter' })
    fireEvent.keyDown(row, { key: 'Escape' })
    expect(onToggle).not.toHaveBeenCalled()
    fireEvent.keyDown(row, { key: 'Enter' })
    expect(onToggle).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'Ungrouped actions' }))
    const item = screen.getByRole('menuitem', { name: 'Delete orphan chats' }) as HTMLButtonElement
    expect(item.disabled).toBe(true)
    fireEvent.click(item)
    expect(onDeleteUngrouped).not.toHaveBeenCalled()
  })

  it('guards disabled deletion and ignores selections outside the current workspace menu', () => {
    const onDeleteUngrouped = vi.fn()
    const onRename = vi.fn()
    const onDelete = vi.fn()
    const ungrouped: GroupNode = {
      key: '', workspaceId: undefined, cwd: undefined, createdAt: undefined, label: 'Ungrouped',
      sessionCount: 0, expanded: false, containsCurrent: false, sessions: [],
    }
    const { rerender } = render(<ProjectRowItem
      group={ungrouped} onToggle={vi.fn()} onCreate={vi.fn()}
      onDeleteUngrouped={onDeleteUngrouped} ungroupedDeleteDisabled t={t}
    />)
    act(() => { selectMenu!('delete-ungrouped') })
    expect(onDeleteUngrouped).not.toHaveBeenCalled()
    act(() => { selectMenu!('rename') })
    expect(onRename).not.toHaveBeenCalled()

    rerender(<ProjectRowItem group={{ ...ungrouped, workspaceId: wid('project'), key: 'project', label: 'Project' }}
      onToggle={vi.fn()} onCreate={vi.fn()} actions={{ rename: onRename, delete: onDelete }} t={t} />)
    act(() => { selectMenu!('delete-ungrouped') })
    act(() => { selectMenu!('archive') })
    expect(onRename).not.toHaveBeenCalled()
    expect(onDelete).not.toHaveBeenCalled()
  })

  it('blank New Session rows carry no menu, no time label, and no hover-card time', () => {
    vi.useFakeTimers()
    try {
      const node: SessionNode = {
        id: sid('s-blank'), title: 'ignored', blank: true, running: false,
        runningSubagentCount: 0, completed: false, updatedAt: 0,
      }
      render(<SessionNodeItem onDelete={vi.fn()} node={node} currentId={node.id} now={0} onOpen={vi.fn()}
        onRename={vi.fn()} onFork={vi.fn()} onArchive={vi.fn()} t={t} />)
      // The placeholder has no content yet: no row verbs, no "now" stamp.
      expect(screen.queryByRole('button', { name: /Session actions for/ })).toBeNull()
      expect(screen.queryByText('now')).toBeNull()
      // The hover card keeps title + status but drops the timestamp line.
      const wrapper = screen.getByRole('treeitem').parentElement as HTMLElement
      fireEvent.pointerEnter(wrapper)
      act(() => { vi.advanceTimersByTime(500) })
      expect(screen.getAllByText('New Session').length).toBeGreaterThanOrEqual(2)
      expect(screen.getByText('Idle')).toBeTruthy()
      expect(screen.queryByText('now')).toBeNull()
      expect(screen.getByText('Idle').closest('[role="button"]')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('session row menu dispatches rename, fork, archive, and delete without opening the session', () => {
    const onOpen = vi.fn()
    const onRename = vi.fn()
    const onFork = vi.fn()
    const onArchive = vi.fn()
    const onDelete = vi.fn()
    const node: SessionNode = {
      id: sid('s1'), title: 'One', blank: false, running: false,
      runningSubagentCount: 0, completed: false, updatedAt: 0,
    }
    render(<SessionNodeItem onDelete={onDelete} node={node} currentId={undefined} now={0} onOpen={onOpen}
      onRename={onRename} onFork={onFork} onArchive={onArchive} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: 'Session actions for One' }))
    expect(onOpen).not.toHaveBeenCalled()
    // Archive is not destructive (log and accounting slot remain): no danger styling.
    expect(screen.getByRole('menuitem', { name: 'Archive session' }).className).not.toMatch(/danger/)
    // Rename dispatches with the current display title (dialog prefill).
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
    expect(screen.queryByRole('menu')).toBeNull()
    expect(onRename).toHaveBeenCalledWith(node.id, 'One')
    expect(onOpen).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Session actions for One' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Fork session' }))
    expect(onFork).toHaveBeenCalledWith(node.id)
    // Archive dispatches without opening the session.
    fireEvent.click(screen.getByRole('button', { name: 'Session actions for One' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Archive session' }))
    expect(onArchive).toHaveBeenCalledWith(node.id)
    fireEvent.click(screen.getByRole('button', { name: 'Session actions for One' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete session' }))
    expect(onDelete).toHaveBeenCalledWith(node.id, 'One')
    expect(onRename).toHaveBeenCalledOnce()
    expect(onOpen).not.toHaveBeenCalled()
    // Escape closes without selecting (Menu onClose path).
    fireEvent.click(screen.getByRole('button', { name: 'Session actions for One' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
  })


  it('shows the hover card after the dwell and suppresses it while the row menu is open', () => {
    vi.useFakeTimers()
    try {
      const node: SessionNode = {
        id: sid('s1'), title: 'Hovered', blank: false, running: true,
        runningSubagentCount: 0, completed: false, updatedAt: 0,
      }
      render(<SessionNodeItem onDelete={vi.fn()} node={node} currentId={undefined} now={60_000} onOpen={vi.fn()}
        onRename={vi.fn()} onFork={vi.fn()} onArchive={vi.fn()} t={t} />)
      const wrapper = screen.getByRole('treeitem').parentElement as HTMLElement
      fireEvent.pointerEnter(wrapper)
      act(() => { vi.advanceTimersByTime(500) })
      // Card body: full title + relative time + running status.
      expect(screen.getAllByText('Hovered')).toHaveLength(2)
      expect(screen.getByText('1min ago')).toBeTruthy()
      expect(screen.getAllByText('Running')).toHaveLength(2)
      fireEvent.pointerLeave(wrapper)
      // Menu open (disabled=true) suppresses the card for the same hover.
      fireEvent.click(screen.getByRole('button', { name: 'Session actions for Hovered' }))
      fireEvent.pointerEnter(wrapper)
      act(() => { vi.advanceTimersByTime(1000) })
      expect(screen.queryByText('1min ago')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([
    ['approval', 'Waiting for approval'],
    ['plan-review', 'Plan awaiting review'],
    ['question', 'Waiting for answer'],
  ] as const)('shows %s as warning ahead of the running state', (pendingInteraction, label) => {
    vi.useFakeTimers()
    try {
      const node: SessionNode = {
        id: sid(pendingInteraction), title: 'Needs input', blank: false,
        pendingInteraction, running: true, runningSubagentCount: 0, completed: false, updatedAt: 0,
      }
      const view = render(<SessionNodeItem onDelete={vi.fn()} node={node} currentId={undefined} now={0} onOpen={vi.fn()}
        onRename={vi.fn()} onFork={vi.fn()} onArchive={vi.fn()} t={t} />)
      const row = screen.getByRole('treeitem')
      expect(row.querySelector('[data-state="warning"]')).toBeTruthy()
      expect(row.querySelector('[data-state="ongoing"]')).toBeNull()
      expect(screen.getByText(label)).toBeTruthy()

      view.rerender(<SessionNodeItem onDelete={vi.fn()} node={{ ...node, running: false }} currentId={undefined} now={0}
        onOpen={vi.fn()} onRename={vi.fn()} onFork={vi.fn()} onArchive={vi.fn()} t={t} />)
      expect(screen.getByRole('treeitem').querySelector('[data-state="warning"]')).toBeTruthy()

      fireEvent.pointerEnter(screen.getByRole('treeitem').parentElement as HTMLElement)
      act(() => { vi.advanceTimersByTime(500) })
      expect(screen.getAllByText(label)).toHaveLength(2)
      expect(document.querySelectorAll('[data-state="warning"]')).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('idle hover card shows the Idle status line', () => {
    vi.useFakeTimers()
    try {
      const node: SessionNode = {
        id: sid('s1'), title: 'Quiet', blank: false, running: false,
        runningSubagentCount: 0, completed: false, updatedAt: 0,
      }
      render(<SessionNodeItem onDelete={vi.fn()} node={node} currentId={undefined} now={0} onOpen={vi.fn()}
        onRename={vi.fn()} onFork={vi.fn()} onArchive={vi.fn()} t={t} />)
      fireEvent.pointerEnter(screen.getByRole('treeitem').parentElement as HTMLElement)
      act(() => { vi.advanceTimersByTime(500) })
      expect(screen.getByText('Idle')).toBeTruthy()
      expect(screen.getAllByText('now')).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('completed hover card shows the Completed status line', () => {
    vi.useFakeTimers()
    try {
      const node: SessionNode = {
        id: sid('s1'), title: 'Done', blank: false, running: false,
        runningSubagentCount: 0, completed: true, updatedAt: 0,
      }
      render(<SessionNodeItem onDelete={vi.fn()} node={node} currentId={undefined} now={0} onOpen={vi.fn()}
        onRename={vi.fn()} onFork={vi.fn()} onArchive={vi.fn()} t={t} />)
      fireEvent.pointerEnter(screen.getByRole('treeitem').parentElement as HTMLElement)
      act(() => { vi.advanceTimersByTime(500) })
      // Row's visually-hidden reminder label plus the hover card's status line.
      expect(screen.getAllByText('Completed')).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('draggable row wires start/end and gates hover/drop on an active same-group drag', () => {
    const node: SessionNode = {
      id: sid('s1'), title: 'Drag me', blank: false, running: false,
      runningSubagentCount: 0, completed: false, updatedAt: 0,
    }
    const inactive = dragProps()
    const { rerender } = render(
      <SessionNodeItem onDelete={vi.fn()} node={node} currentId={undefined} now={0} onOpen={vi.fn()}
        onRename={vi.fn()} onFork={vi.fn()} onArchive={vi.fn()} drag={inactive} t={t} />,
    )
    const row = screen.getByRole('treeitem')
    stubRect(row)
    expect(row.getAttribute('draggable')).toBe('true')
    fireEvent.dragStart(row, { dataTransfer })
    expect(inactive.start).toHaveBeenCalledOnce()
    // Inactive drag: hover and drop are rejected.
    fireEvent.dragOver(row, { dataTransfer })
    fireEvent.drop(row, { dataTransfer })
    expect(inactive.hover).not.toHaveBeenCalled()
    expect(inactive.drop).not.toHaveBeenCalled()
    fireEvent.dragEnd(row)
    expect(inactive.end).toHaveBeenCalledOnce()

    const active = dragProps({ active: true, marker: 'before' })
    rerender(
      <SessionNodeItem onDelete={vi.fn()} node={node} currentId={undefined} now={0} onOpen={vi.fn()}
        onRename={vi.fn()} onFork={vi.fn()} onArchive={vi.fn()} drag={active} t={t} />,
    )
    stubRect(screen.getByRole('treeitem'))
    // Top half hovers/drops 'before'; bottom half 'after' (row mid = 117).
    fireDrag(screen.getByRole('treeitem'), 'dragOver', 105)
    expect(active.hover).toHaveBeenCalledWith('before')
    fireDrag(screen.getByRole('treeitem'), 'dragOver', 130)
    expect(active.hover).toHaveBeenCalledWith('after')
    fireDrag(screen.getByRole('treeitem'), 'drop', 130)
    expect(active.drop).toHaveBeenCalledWith('after')

    const after = dragProps({ active: true, marker: 'after' })
    rerender(
      <SessionNodeItem onDelete={vi.fn()} node={node} currentId={undefined} now={0} onOpen={vi.fn()}
        onRename={vi.fn()} onFork={vi.fn()} onArchive={vi.fn()} drag={after} t={t} />,
    )
    expect(screen.getByRole('treeitem').className).toMatch(/dropAfter/)
  })
})

it('dispatches all extended session actions through the same context-menu handler', () => {
  const management = { pinned: false, unread: false, cwd: '/project', projectId: 'project', sectionId: 'section', projects: [{ workspaceId: 'project', title: 'Project' }], sections: [{ id: 'section', title: 'Section' }],
    onPin: vi.fn(), onUnread: vi.fn(), onWindow: vi.fn(), onNewSection: vi.fn(), onProject: vi.fn(), onSection: vi.fn(), onCopy: vi.fn() }
  const node: SessionNode = { id: sid('actions'), title: 'Actions', blank: false, running: false, runningSubagentCount: 0, completed: false, updatedAt: 0 }
  const p = { node, currentId: undefined, now: 0, onOpen: vi.fn(), onRename: vi.fn(), onFork: vi.fn(),
    onArchive: vi.fn(), onDelete: vi.fn(), management, t }
  const view = render(<SessionNodeItem {...p} />)
  const row = screen.getByRole('treeitem')
  const actions = ['pin','unread','window','section:new','project:project','project:none','section:section','section:none',
    'copy:link','copy:markdown','copy:directory','unknown']
  for (const id of actions) {
    fireEvent.contextMenu(row, { clientX: 10, clientY: 20 })
    act(() =>{  selectMenu!(id) })
  }
  expect(management.onProject.mock.calls).toEqual([['project'], [null]])
  expect(management.onSection.mock.calls).toEqual([['section'], [null]])
  expect(management.onCopy.mock.calls).toEqual([['link'], ['markdown'], ['directory']])
  expect(management.onWindow).toHaveBeenCalledOnce()
  fireEvent.keyDown(row, { key: 'Enter' })
  fireEvent.keyDown(row, { key: ' ' })
  expect(p.onOpen).toHaveBeenCalledTimes(2)
  fireEvent.keyDown(row.querySelector('button')!, { key: 'Enter' })
  expect(p.onOpen).toHaveBeenCalledTimes(2)
  for (const event of [{ key: 'ContextMenu' }, { key: 'F10', shiftKey: true }]) {
    fireEvent.keyDown(row, event)
    expect(screen.getByRole('menu')).toBeTruthy()
    act(() =>{  selectMenu!('unknown') })
  }
  for (const key of ['r', 'p', 'l', 'x']) fireEvent.keyDown(row, { key, altKey: true, ctrlKey: true })
  for (const key of ['u', 'c', 'a', 'x']) fireEvent.keyDown(row, { key, shiftKey: true, ctrlKey: true })
  fireEvent.keyDown(row, { key: 'x', ctrlKey: true })
  fireEvent.keyDown(row, { key: 'x', altKey: true, ctrlKey: true, shiftKey: true })
  expect(p.onRename).toHaveBeenCalledOnce()
  expect(p.onArchive).toHaveBeenCalledOnce()
  expect(management.onPin).toHaveBeenCalledTimes(2)
  view.rerender(<SessionNodeItem {...p} management={{ ...management, cwd: undefined }} />)
  fireEvent.keyDown(row, { key: 'c', shiftKey: true, ctrlKey: true })
  expect(management.onCopy).toHaveBeenCalledTimes(5)
  view.rerender(<SessionNodeItem {...p} management={undefined} />)
  fireEvent.keyDown(row, { key: 'p', altKey: true, ctrlKey: true })
  fireEvent.contextMenu(row)
  act(() =>{  selectMenu!('unknown') })
  view.rerender(<SessionNodeItem {...p} node={{ ...node, blank: true }} />)
  fireEvent.contextMenu(row)
  fireEvent.keyDown(row, { key: 'ContextMenu' })
  expect(screen.queryByRole('menu')).toBeNull()
})

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { DesktopFilesPanel, type DesktopFileEntry, type DesktopFilesApi } from '../src/client/DesktopFilesPanel.tsx'

const root = 'C:\\workspace'
const source = `${root}\\src`
const destination = `${root}\\lib`
const file = `${source}\\a.ts`

function filesFixture() {
  const entries = new Map<string, DesktopFileEntry[]>([
    [root, [{ name: 'src', path: source, directory: true }, { name: 'lib', path: destination, directory: true }]],
    [source, [{ name: 'a.ts', path: file, directory: false }]],
    [destination, []],
  ])
  const files = {
    root: vi.fn(async () => root),
    list: vi.fn(async (path: string) => entries.get(path) ?? []),
    search: vi.fn(async () => []),
    read: vi.fn(async (path: string) => ({ path, content: 'original', version: 'v1' })),
    create: vi.fn(async (parent: string, name: string, kind: 'file' | 'directory') => ({ path: `${parent}\\${name}`, name, directory: kind === 'directory' })),
    rename: vi.fn<NonNullable<DesktopFilesApi['rename']>>(async (path, name) => ({
      oldPath: path, path: `${root}\\${name}`, name, directory: true,
    })),
    move: vi.fn(async (path: string, parent: string) => ({ oldPath: path, path: `${parent}\\src`, name: 'src', directory: true })),
    delete: vi.fn(async (path: string) => ({ path })),
    save: vi.fn(async (path: string, _content: string, version: string) => ({ path, version: `${version}-saved` })),
    format: vi.fn(async (_path: string, content: string) => content),
  }
  window.hydraDesktop = { browser: { setBounds: vi.fn() }, files }
  return { files, entries }
}

afterEach(() => {
  cleanup()
  delete window.hydraDesktop
  vi.restoreAllMocks()
})

describe('Files operations', () => {
  it('creates in the context-menu folder even when another directory is selected', async () => {
    const { files } = filesFixture()
    const view = render(<DesktopFilesPanel workspaceId="workspace" active focusSearch={1} />)
    fireEvent.contextMenu(await view.findByRole('button', { name: 'src' }))
    fireEvent.click(view.getByRole('menuitem', { name: 'New File' }))
    fireEvent.change(view.getByRole('textbox', { name: 'New file name' }), { target: { value: 'new.ts' } })
    fireEvent.click(view.getByRole('button', { name: 'Create file' }))
    await waitFor(() => { expect(files.create).toHaveBeenCalledWith(source, 'new.ts', 'file', 'workspace') })
  })

  it.each(['rename', 'move'] as const)('%s keeps the descendant editor and expanded tree at the new path', async (operation) => {
    const { files, entries } = filesFixture()
    const view = render(<DesktopFilesPanel workspaceId="workspace" active focusSearch={1} />)
    const folder = await view.findByRole('button', { name: 'src' })
    fireEvent.click(folder)
    fireEvent.click(await view.findByRole('button', { name: 'a.ts' }))
    const editor = await view.findByRole('textbox', { name: 'Editor for a.ts' })
    fireEvent.change(editor, { target: { value: 'draft' } })
    const nextFolder = operation === 'rename' ? `${root}\\renamed` : `${destination}\\src`
    entries.set(nextFolder, [{ name: 'a.ts', path: `${nextFolder}\\a.ts`, directory: false }])
    entries.set(root, operation === 'rename'
      ? [{ name: 'renamed', path: nextFolder, directory: true }]
      : [{ name: 'lib', path: destination, directory: true }])
    entries.set(destination, [{ name: 'src', path: nextFolder, directory: true }])
    if (operation === 'rename') {
      fireEvent.contextMenu(folder)
      fireEvent.click(view.getByRole('menuitem', { name: 'Rename' }))
      fireEvent.change(view.getByRole('textbox', { name: 'Rename src' }), { target: { value: 'renamed' } })
      fireEvent.click(view.getByRole('button', { name: 'Confirm rename' }))
    } else {
      const dataTransfer = { effectAllowed: '', dropEffect: '', setData: vi.fn(), getData: vi.fn(() => source) }
      fireEvent.dragStart(folder, { dataTransfer })
      fireEvent.drop(view.getByRole('button', { name: 'lib' }), { dataTransfer })
    }
    await waitFor(() => { expect(view.getByRole('tab', { name: /a\.ts/u }).getAttribute('title')).toBe(`${nextFolder}\\a.ts`) })
    expect((view.getByRole('textbox', { name: 'Editor for a.ts' }) as HTMLTextAreaElement).value).toBe('draft')
    await waitFor(() => { expect(view.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(false) })
    fireEvent.click(view.getByRole('button', { name: 'Save' }))
    await waitFor(() => { expect(files.save).toHaveBeenCalledWith(`${nextFolder}\\a.ts`, 'draft', 'v1', 'workspace') })
    if (operation === 'move') fireEvent.click(view.getByRole('button', { name: 'lib' }))
    expect(await within(view.getByRole('tree', { name: 'Workspace files' })).findByRole('button', { name: 'a.ts' })).toBeTruthy()
  })

  it('keeps successful Save All acknowledgements when a later file fails', async () => {
    const { files, entries } = filesFixture()
    const second = `${root}\\b.ts`
    entries.set(root, [{ name: 'a.ts', path: file, directory: false }, { name: 'b.ts', path: second, directory: false }])
    files.save.mockResolvedValueOnce({ path: file, version: 'v2' }).mockRejectedValueOnce(new Error('disk full'))
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const onDirtyChange = vi.fn()
    const view = render(<DesktopFilesPanel workspaceId="workspace" active focusSearch={1} onDirtyChange={onDirtyChange} />)
    for (const name of ['a.ts', 'b.ts']) {
      fireEvent.click(await view.findByRole('button', { name }))
      fireEvent.change(await view.findByRole('textbox', { name: `Editor for ${name}` }), { target: { value: `draft ${name}` } })
    }
    fireEvent.click(view.getByRole('button', { name: 'Save all files' }))
    expect((await view.findByRole('alert')).textContent).toContain('disk full')
    expect(within(view.getByRole('tab', { name: /a\.ts/u })).queryByTitle('Unsaved changes')).toBeNull()
    expect(within(view.getByRole('tab', { name: /b\.ts/u })).queryByTitle('Unsaved changes')).toBeTruthy()
    expect(onDirtyChange).toHaveBeenLastCalledWith(true)
    fireEvent.click(view.getByRole('button', { name: 'Save all files' }))
    await waitFor(() => { expect(files.save).toHaveBeenCalledTimes(3) })
    expect(files.save.mock.calls[2]?.[0]).toBe(second)
  })

  it.each(['v1', 'externally-changed'])('renaming a file advances only its matching disk version (%s)', async (before) => {
    const { files, entries } = filesFixture()
    entries.set(root, [{ name: 'a.ts', path: file, directory: false }])
    const nextPath = `${root}\\renamed.ts`
    files.rename.mockResolvedValue({ oldPath: file, path: nextPath, name: 'renamed.ts', version: { before, after: 'v2' } })
    const view = render(<DesktopFilesPanel workspaceId="workspace" active focusSearch={1} />)
    const row = await view.findByRole('button', { name: 'a.ts' })
    fireEvent.click(row)
    fireEvent.change(await view.findByRole('textbox', { name: 'Editor for a.ts' }), { target: { value: 'draft' } })
    fireEvent.contextMenu(row)
    fireEvent.click(view.getByRole('menuitem', { name: 'Rename' }))
    fireEvent.change(view.getByRole('textbox', { name: 'Rename a.ts' }), { target: { value: 'renamed.ts' } })
    fireEvent.click(view.getByRole('button', { name: 'Confirm rename' }))
    await view.findByRole('textbox', { name: 'Editor for renamed.ts' })
    await waitFor(() => { expect(view.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(false) })
    fireEvent.click(view.getByRole('button', { name: 'Save' }))
    await waitFor(() => { expect(files.save).toHaveBeenCalledWith(nextPath, 'draft', before === 'v1' ? 'v2' : 'v1', 'workspace') })
  })

  it('preserves newer typing while Save All is pending', async () => {
    const { files, entries } = filesFixture()
    entries.set(root, [{ name: 'a.ts', path: file, directory: false }])
    const pending: Array<(result: { path: string; version: string }) => void> = []
    files.save.mockImplementation(() => new Promise((resolve) => { pending.push(resolve) }))
    const view = render(<DesktopFilesPanel workspaceId="workspace" active focusSearch={1} />)
    fireEvent.click(await view.findByRole('button', { name: 'a.ts' }))
    const editor = await view.findByRole('textbox', { name: 'Editor for a.ts' })
    fireEvent.change(editor, { target: { value: 'submitted' } })
    fireEvent.click(view.getByRole('button', { name: 'Save all files' }))
    fireEvent.change(editor, { target: { value: 'newer draft' } })
    await act(async () => { pending[0]?.({ path: file, version: 'v2' }) })
    expect((view.getByRole('textbox', { name: 'Editor for a.ts' }) as HTMLTextAreaElement).value).toBe('newer draft')
    expect(view.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(false)
  })

  it.each(['Save', 'Save all files'])('%s updates the saved document after switching tabs', async (button) => {
    const { files, entries } = filesFixture()
    const second = `${root}\\b.ts`
    entries.set(root, [{ name: 'a.ts', path: file, directory: false }, { name: 'b.ts', path: second, directory: false }])
    const pending: Array<(result: { path: string; version: string }) => void> = []
    files.save.mockImplementation(() => new Promise((resolve) => { pending.push(resolve) }))
    const view = render(<DesktopFilesPanel workspaceId="workspace" active focusSearch={1} />)
    for (const name of ['a.ts', 'b.ts']) {
      fireEvent.click(await view.findByRole('button', { name }))
      await view.findByRole('textbox', { name: `Editor for ${name}` })
    }
    fireEvent.click(view.getByRole('tab', { name: /a\.ts/u }))
    fireEvent.change(view.getByRole('textbox', { name: 'Editor for a.ts' }), { target: { value: 'submitted' } })
    fireEvent.click(view.getByRole('button', { name: button }))
    fireEvent.click(view.getByRole('tab', { name: /b\.ts/u }))
    await act(async () => { pending[0]?.({ path: file, version: 'v2' }) })
    expect((view.getByRole('textbox', { name: 'Editor for b.ts' }) as HTMLTextAreaElement).value).toBe('original')
    expect(within(view.getByRole('tab', { name: /a\.ts/u })).queryByTitle('Unsaved changes')).toBeNull()
  })

  it('does not reopen a tab closed during Save All', async () => {
    const { files, entries } = filesFixture()
    entries.set(root, [{ name: 'a.ts', path: file, directory: false }])
    const pending: Array<(result: { path: string; version: string }) => void> = []
    files.save.mockImplementation(() => new Promise((resolve) => { pending.push(resolve) }))
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const view = render(<DesktopFilesPanel workspaceId="workspace" active focusSearch={1} />)
    fireEvent.click(await view.findByRole('button', { name: 'a.ts' }))
    fireEvent.change(await view.findByRole('textbox', { name: 'Editor for a.ts' }), { target: { value: 'submitted' } })
    fireEvent.click(view.getByRole('button', { name: 'Save all files' }))
    fireEvent.click(view.getByRole('button', { name: 'Close a.ts' }))
    await act(async () => { pending[0]?.({ path: file, version: 'v2' }) })
    expect(view.queryByRole('tab', { name: /a\.ts/u })).toBeNull()
  })

  it.each(['rename', 'move', 'delete'] as const)('ignores %s failures from a previous workspace', async (operation) => {
    const { files, entries } = filesFixture()
    entries.set(root, [{ name: 'src', path: source, directory: true }, { name: 'lib', path: destination, directory: true }])
    const pending: Array<() => void> = []
    files[operation].mockImplementation(() => new Promise<never>((_resolve, reject) => {
      pending.push(() => { reject(new Error('previous workspace failure')) })
    }))
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const view = render(<DesktopFilesPanel workspaceId="first" active focusSearch={1} />)
    const folder = await view.findByRole('button', { name: 'src' })
    if (operation === 'move') {
      const dataTransfer = { effectAllowed: '', dropEffect: '', setData: vi.fn(), getData: vi.fn(() => source) }
      fireEvent.dragStart(folder, { dataTransfer })
      fireEvent.drop(view.getByRole('button', { name: 'lib' }), { dataTransfer })
    } else {
      fireEvent.contextMenu(folder)
      fireEvent.click(view.getByRole('menuitem', { name: operation === 'rename' ? 'Rename' : 'Delete' }))
      if (operation === 'rename') {
        fireEvent.change(view.getByRole('textbox', { name: 'Rename src' }), { target: { value: 'lib' } })
        fireEvent.click(view.getByRole('button', { name: 'Confirm rename' }))
      }
    }
    await waitFor(() => { expect(pending.length).toBe(1) })
    view.rerender(<DesktopFilesPanel workspaceId="second" active focusSearch={1} />)
    await view.findByRole('button', { name: 'src' })
    files.list.mockClear()
    await act(async () => { pending[0]?.() })
    expect(files.list).not.toHaveBeenCalled()
    expect(view.queryByRole('alert')).toBeNull()
  })
})

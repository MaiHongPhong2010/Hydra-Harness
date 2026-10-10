import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  CodeBlock,
  IconBrowseOutline16,
  IconCheckOutline14,
  IconChevronDownOutline14,
  IconChevronRightOutline14,
  IconChevronUpOutline14,
  IconCloseOutline16,
  IconCodeOutline16,
  IconCopyOutline16,
  IconDataOutline16,
  IconEditOutline16,
  IconFolderClose16,
  IconFolderOpen16,
  IconPlusOutline16,
  IconProjectAddOutline16,
  IconRefreshOutline14,
  IconSearchOutline16,
  IconTrashOutline16,
} from '@hydraharness/harness-client-ui-primitives'
import css from './DesktopFilesPanel.module.css'

export interface DesktopFileEntry {
  name: string
  path: string
  directory: boolean
}

export interface DesktopFilesApi {
  root(workspaceId: string): Promise<string>
  list(path: string, workspaceId: string): Promise<DesktopFileEntry[]>
  search(query: string, workspaceId: string): Promise<DesktopFileEntry[]>
  read(path: string, workspaceId: string): Promise<{ path: string; content: string; version: string }>
  create(
    parentPath: string,
    name: string,
    kind: 'file' | 'directory',
    workspaceId: string,
  ): Promise<DesktopFileEntry>
  rename?(
    path: string,
    newName: string,
    workspaceId: string,
  ): Promise<{ oldPath: string; path: string; name: string; directory?: boolean; version?: { before: string; after: string } }>
  move?(
    path: string,
    destinationDirectory: string,
    workspaceId: string,
  ): Promise<{ oldPath: string; path: string; name: string; directory?: boolean; version?: { before: string; after: string } }>
  delete?(path: string, workspaceId: string): Promise<{ path: string }>
  reveal?(path: string, workspaceId: string): Promise<boolean>
  save(
    path: string,
    content: string,
    expectedVersion: string,
    workspaceId: string,
  ): Promise<{ path: string; version: string }>
  format(path: string, content: string, workspaceId: string): Promise<string>
}

interface EditorDocument {
  path: string
  savedContent: string
  draft: string
  version: string
}

interface CreateDraft {
  parent: string
  kind: 'file' | 'directory'
}

interface DiffLine {
  type: 'add' | 'del' | 'context'
  oldNo?: number
  newNo?: number
  text: string
}

type FileIconKind = 'code' | 'data' | 'web' | 'text'

const HIGHLIGHT_MAX_CHARS = 50_000
const EDITOR_LANGUAGE_ALIASES = new Map([
  ['mts', 'ts'], ['cts', 'ts'], ['mjs', 'js'], ['cjs', 'js'],
  ['h', 'c'], ['cc', 'cpp'], ['hpp', 'cpp'], ['cxx', 'cpp'],
  ['kt', 'kotlin'], ['markdown', 'md'], ['htm', 'html'],
])

function fileName(path: string): string {
  return path.replace(/[/\\]+$/u, '').split(/[/\\]/u).pop() ?? path
}

function editorLanguage(path: string): string | undefined {
  const name = fileName(path)
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return undefined
  const extension = name.slice(dot + 1).toLowerCase()
  return EDITOR_LANGUAGE_ALIASES.get(extension) ?? extension
}

function relativePath(root: string, path: string): string {
  return path.slice(root.replace(/[/\\]+$/u, '').length).replace(/^[/\\]+/u, '') || fileName(root)
}

function parentDirectory(root: string, path: string): string {
  const boundary = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  const parent = boundary < 0 ? root : path.slice(0, boundary)
  return parent.length < root.replace(/[/\\]+$/u, '').length ? root : parent
}

function samePath(left: string, right: string): boolean {
  return left.replaceAll('\\', '/').toLocaleLowerCase() === right.replaceAll('\\', '/').toLocaleLowerCase()
}

function pathContains(parent: string, candidate: string): boolean {
  const normalizedParent = parent.replaceAll('\\', '/').replace(/\/+$/u, '').toLocaleLowerCase()
  const normalizedCandidate = candidate.replaceAll('\\', '/').toLocaleLowerCase()
  return normalizedCandidate.startsWith(`${normalizedParent}/`)
}

function fileIconKind(path: string): FileIconKind {
  const extension = fileName(path).split('.').pop()?.toLocaleLowerCase()
  if (extension !== undefined && ['json', 'jsonc', 'yaml', 'yml', 'toml', 'xml', 'csv'].includes(extension)) return 'data'
  if (extension !== undefined && ['html', 'htm', 'css', 'scss', 'less', 'vue', 'svelte'].includes(extension)) return 'web'
  if (extension !== undefined && ['md', 'mdx', 'txt', 'rst'].includes(extension)) return 'text'
  return 'code'
}

const FILE_ENTRY_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

function sortFileEntries(entries: DesktopFileEntry[]): DesktopFileEntry[] {
  return [...entries].sort((left, right) => {
    if (left.directory !== right.directory) return left.directory ? -1 : 1
    return FILE_ENTRY_COLLATOR.compare(left.name, right.name)
  })
}

function documentIsDirty(document: EditorDocument | undefined): boolean {
  return document !== undefined && document.draft !== document.savedContent
}

function lineEndingOf(content: string): 'CRLF' | 'LF' {
  let crlf = 0
  let lf = 0
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] !== '\n') continue
    if (content[index - 1] === '\r') crlf += 1
    else lf += 1
  }
  return crlf > lf ? 'CRLF' : 'LF'
}

function computeLineDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.split('\n')
  const newLines = newText.split('\n')
  const result: DiffLine[] = []
  let oldIdx = 0
  let newIdx = 0
  while (oldIdx < oldLines.length || newIdx < newLines.length) {
    if (oldIdx < oldLines.length && newIdx < newLines.length && oldLines[oldIdx] === newLines[newIdx]) {
      result.push({ type: 'context', oldNo: oldIdx + 1, newNo: newIdx + 1, text: oldLines[oldIdx] ?? '' })
      oldIdx += 1
      newIdx += 1
    } else {
      const foundInNew = oldIdx < oldLines.length ? newLines.indexOf(oldLines[oldIdx] ?? '', newIdx) : -1
      const foundInOld = newIdx < newLines.length ? oldLines.indexOf(newLines[newIdx] ?? '', oldIdx) : -1
      if (
        oldIdx < oldLines.length
        && (newIdx >= newLines.length || foundInNew === -1 || (foundInOld !== -1 && foundInOld < foundInNew))
      ) {
        result.push({ type: 'del', oldNo: oldIdx + 1, text: oldLines[oldIdx] ?? '' })
        oldIdx += 1
      } else if (newIdx < newLines.length) {
        result.push({ type: 'add', newNo: newIdx + 1, text: newLines[newIdx] ?? '' })
        newIdx += 1
      }
    }
  }
  return result
}

interface CodeSymbol {
  kind: 'function' | 'class' | 'interface' | 'type' | 'heading'
  name: string
  line: number
}

function extractSymbols(code: string, language?: string): CodeSymbol[] {
  const symbols: CodeSymbol[] = []
  const lines = code.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const lineText = lines[i] ?? ''
    const trimmed = lineText.trim()
    const lineNo = i + 1
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
      continue
    }

    if (language === 'md' || language === 'markdown') {
      const headingMatch = /^(#{1,6})\s+(.+)$/u.exec(trimmed)
      if (headingMatch) {
        symbols.push({ kind: 'heading', name: headingMatch[2] ?? '', line: lineNo })
      }
      continue
    }

    if (language === 'py' || language === 'python') {
      const pyFunc = /^def\s+([a-zA-Z0-9_]+)\s*\(/u.exec(trimmed)
      if (pyFunc) {
        symbols.push({ kind: 'function', name: pyFunc[1] ?? '', line: lineNo })
        continue
      }
      const pyClass = /^class\s+([a-zA-Z0-9_]+)\s*[:\(]/u.exec(trimmed)
      if (pyClass) {
        symbols.push({ kind: 'class', name: pyClass[1] ?? '', line: lineNo })
        continue
      }
    }

    const funcMatch = /(?:export\s+)?(?:async\s+)?function\s*\*?\s*([a-zA-Z0-9_$]+)\s*\(/u.exec(trimmed)
    if (funcMatch) {
      symbols.push({ kind: 'function', name: funcMatch[1] ?? '', line: lineNo })
      continue
    }

    const arrowMatch = /(?:export\s+)?(?:const|let|var)\s+([a-zA-Z0-9_$]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[a-zA-Z0-9_$]+)\s*=>/u.exec(
      trimmed,
    )
    if (arrowMatch) {
      symbols.push({ kind: 'function', name: arrowMatch[1] ?? '', line: lineNo })
      continue
    }

    const classMatch = /(?:export\s+)?(?:abstract\s+)?class\s+([a-zA-Z0-9_$]+)/u.exec(trimmed)
    if (classMatch) {
      symbols.push({ kind: 'class', name: classMatch[1] ?? '', line: lineNo })
      continue
    }

    const ifaceMatch = /(?:export\s+)?interface\s+([a-zA-Z0-9_$]+)/u.exec(trimmed)
    if (ifaceMatch) {
      symbols.push({ kind: 'interface', name: ifaceMatch[1] ?? '', line: lineNo })
      continue
    }

    const typeMatch = /(?:export\s+)?type\s+([a-zA-Z0-9_$]+)\s*=/u.exec(trimmed)
    if (typeMatch) {
      symbols.push({ kind: 'type', name: typeMatch[1] ?? '', line: lineNo })
      continue
    }
  }
  return symbols
}

function FileIcon({ path }: { path: string }) {
  const kind = fileIconKind(path)
  const ext = fileName(path).split('.').pop()?.toLowerCase() ?? ''
  return (
    <span className={css.fileIcon} data-file-icon={kind} data-ext={ext} aria-hidden="true">
      {kind === 'data' && <IconDataOutline16 size={14} />}
      {kind === 'web' && <IconBrowseOutline16 size={14} />}
      {kind === 'text' && <IconEditOutline16 size={14} />}
      {kind === 'code' && <IconCodeOutline16 size={14} />}
    </span>
  )
}

function WordWrapIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M2.5 4h11M2.5 8h7a2.5 2.5 0 0 1 0 5H7m0 0l2-2M7 13l2 2M2.5 12h2"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function GoToLineIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M2.5 4.5h6M2.5 8h4M2.5 11.5h6M11 6.5l2.5 2.5L11 11.5M13.5 9H8.5"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** Workspace Explorer and guarded multi-document code editor backed by the desktop bridge. */
export function DesktopFilesPanel(props: {
  workspaceId?: string | undefined
  active: boolean
  focusSearch: number
  onDirtyChange?: ((dirty: boolean) => void) | undefined
  onSavingChange?: ((saving: boolean) => void) | undefined
}) {
  const api = window.hydraDesktop?.files
  const { workspaceId } = props
  const searchRef = useRef<HTMLInputElement | null>(null)
  const createRef = useRef<HTMLInputElement | null>(null)
  const listRequests = useRef(new Map<string, number>())
  const listRequestSequence = useRef(0)
  const listGeneration = useRef(0)
  const readRequest = useRef(0)
  const handledFocusSearch = useRef(-1)
  const savingRef = useRef(false)
  const formattingRef = useRef(false)
  const creatingRef = useRef(false)
  const mutatingRef = useRef(false)
  const mountedRef = useRef(true)
  const rootWorkspaceRef = useRef<string>()
  const documentRef = useRef<EditorDocument>()
  const openDocumentsRef = useRef<EditorDocument[]>([])
  const activePathRef = useRef<string>()

  const [rootPath, setRootPath] = useState<string>()
  const [children, setChildren] = useState<Record<string, DesktopFileEntry[]>>({})
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [selectedDirectory, setSelectedDirectory] = useState<string>()
  const [openDocuments, setOpenDocuments] = useState<EditorDocument[]>([])
  const [activePath, setActivePath] = useState<string>()
  const [document, setDocument] = useState<EditorDocument>()
  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState<DesktopFileEntry[]>([])
  const [createDraft, setCreateDraft] = useState<CreateDraft>()
  const [createName, setCreateName] = useState('')
  const editorTextareaRef = useRef<HTMLTextAreaElement | null>(null)
  const codeScrollRef = useRef<HTMLDivElement | null>(null)
  const flashTimeoutRef = useRef<number | undefined>(undefined)
  const [flashLine, setFlashLine] = useState<number>()
  const [activeOutlineLine, setActiveOutlineLine] = useState<number>()
  const isDraggingRef = useRef(false)
  const startXRef = useRef(0)
  const startWidthRef = useRef(240)

  const [sidebarWidth, setSidebarWidth] = useState(240)
  const [isDragging, setIsDragging] = useState(false)
  const [openEditorsCollapsed, setOpenEditorsCollapsed] = useState(false)
  const [workspaceTreeCollapsed, setWorkspaceTreeCollapsed] = useState(false)
  const [outlineCollapsed, setOutlineCollapsed] = useState(false)
  const [wordWrap, setWordWrap] = useState(false)
  const [showGotoLine, setShowGotoLine] = useState(false)
  const [gotoLineValue, setGotoLineValue] = useState('')
  const [selectedChars, setSelectedChars] = useState(0)
  const findInputRef = useRef<HTMLInputElement | null>(null)
  const [showFind, setShowFind] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [findMatchCase, setFindMatchCase] = useState(false)
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0)

  const [renamingPath, setRenamingPath] = useState<string>()
  const [renameName, setRenameName] = useState('')
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; entry: DesktopFileEntry }>()
  const [showDiff, setShowDiff] = useState(false)
  const [cursorPos, setCursorPos] = useState({ line: 1, col: 1 })
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(false)
  const [reading, setReading] = useState(false)
  const [rootLoading, setRootLoading] = useState(false)
  const [searching, setSearching] = useState(false)
  const [creating, setCreating] = useState(false)
  const [saving, setSaving] = useState(false)
  const [formatting, setFormatting] = useState(false)
  const [mutating, setMutating] = useState(false)
  const [draggedPath, setDraggedPath] = useState<string>()
  const [dropTargetPath, setDropTargetPath] = useState<string>()

  const deferredDraft = useDeferredValue(document?.draft)
  const dirty = documentIsDirty(document)

  const publishDocuments = useCallback((nextList: EditorDocument[]) => {
    openDocumentsRef.current = nextList
    setOpenDocuments(nextList)
    const nextActiveDoc = nextList.find(d => d.path === activePathRef.current)
    documentRef.current = nextActiveDoc
    setDocument(nextActiveDoc)
    props.onDirtyChange?.(nextList.some(d => documentIsDirty(d)))
  }, [props.onDirtyChange])

  const updateDocument = useCallback((update: (current: EditorDocument | undefined) => EditorDocument | undefined) => {
    if (!mountedRef.current) return
    const currentActive = openDocumentsRef.current.find(d => d.path === activePathRef.current)
    const next = update(currentActive)
    let nextList: EditorDocument[]
    if (next === undefined) {
      nextList = openDocumentsRef.current.filter(d => d.path !== activePathRef.current)
      const newActive = nextList[nextList.length - 1]?.path
      activePathRef.current = newActive
      setActivePath(newActive)
    } else {
      const idx = openDocumentsRef.current.findIndex(d => d.path === next.path)
      if (idx >= 0) {
        nextList = [...openDocumentsRef.current]
        nextList[idx] = next
      } else {
        nextList = [...openDocumentsRef.current, next]
      }
      activePathRef.current = next.path
      setActivePath(next.path)
    }
    publishDocuments(nextList)
  }, [publishDocuments])

  const remapEntryPaths = (oldPath: string, newPath: string, version?: { before: string; after: string }) => {
    const remap = (path: string) => samePath(path, oldPath) || pathContains(oldPath, path)
      ? `${newPath}${path.slice(oldPath.length)}` : path
    if (activePathRef.current !== undefined) {
      activePathRef.current = remap(activePathRef.current)
      setActivePath(activePathRef.current)
    }
    publishDocuments(openDocumentsRef.current.map(d => ({
      ...d, path: remap(d.path),
      version: samePath(d.path, oldPath) && version !== undefined && d.version === version.before ? version.after : d.version,
    })))
    setChildren(current => Object.fromEntries(Object.entries(current).map(([path, entries]) => [
      remap(path), entries.map(entry => ({ ...entry, path: remap(entry.path), name: fileName(remap(entry.path)) })),
    ])))
    setExpanded(current => new Set([...current].map(remap)))
    setSelectedDirectory(current => current === undefined ? current : remap(current))
    setCreateDraft(current => current === undefined ? current : { ...current, parent: remap(current.parent) })
    setQuery('')
  }

  const loadDirectory = useCallback(async (path: string) => {
    if (api === undefined || rootPath === undefined || workspaceId === undefined
      || rootWorkspaceRef.current !== workspaceId || !mountedRef.current) return
    const generation = listGeneration.current
    const request = ++listRequestSequence.current
    listRequests.current.set(path, request)
    setLoading(true)
    setError(undefined)
    try {
      const entries = await api.list(path, workspaceId)
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- refs can change while the desktop request is pending.
      if (mountedRef.current && listGeneration.current === generation && listRequests.current.get(path) === request) {
        setChildren(current => ({ ...current, [path]: entries }))
      }
    } catch (reason) {
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- refs can change while the desktop request is pending.
      if (mountedRef.current && listGeneration.current === generation && listRequests.current.get(path) === request) {
        setError(String(reason))
      }
    } finally {
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- refs can change while the desktop request is pending.
      if (mountedRef.current && listGeneration.current === generation && listRequests.current.get(path) === request) {
        listRequests.current.delete(path)
        setLoading(listRequests.current.size > 0)
      }
    }
  }, [api, rootPath, workspaceId])

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  useEffect(() => {
    if (contextMenu === undefined) return
    const handleDismiss = () => { setContextMenu(undefined) }
    window.addEventListener('click', handleDismiss)
    window.addEventListener('contextmenu', handleDismiss)
    return () => {
      window.removeEventListener('click', handleDismiss)
      window.removeEventListener('contextmenu', handleDismiss)
    }
  }, [contextMenu])

  useEffect(() => {
    rootWorkspaceRef.current = undefined
    listGeneration.current += 1
    listRequests.current.clear()
    readRequest.current += 1
    setRootPath(undefined)
    setLoading(false)
    setReading(false)
    setRootLoading(false)
    if (api === undefined || workspaceId === undefined) return
    let current = true
    setRootLoading(true)
    void api.root(workspaceId).then(
      (path) => {
        if (!current || !mountedRef.current) return
        rootWorkspaceRef.current = workspaceId
        setRootPath(path)
      },
      (reason: unknown) => { if (current && mountedRef.current) setError(String(reason)) },
    ).finally(() => { if (current && mountedRef.current) setRootLoading(false) })
    return () => { current = false }
  }, [api, workspaceId])

  useEffect(() => {
    if (!props.active || rootPath === undefined || handledFocusSearch.current === props.focusSearch) return
    handledFocusSearch.current = props.focusSearch
    searchRef.current?.focus()
  }, [props.active, props.focusSearch, rootPath])

  useEffect(() => { createRef.current?.focus() }, [createDraft])

  useEffect(() => () => { props.onDirtyChange?.(false) }, [props.onDirtyChange])
  useEffect(() => () => { props.onSavingChange?.(false) }, [props.onSavingChange])
  useEffect(() => () => {
    if (flashTimeoutRef.current !== undefined) {
      window.clearTimeout(flashTimeoutRef.current)
    }
  }, [])

  useEffect(() => {
    setChildren({})
    openDocumentsRef.current = []
    setOpenDocuments([])
    activePathRef.current = undefined
    setActivePath(undefined)
    documentRef.current = undefined
    setDocument(undefined)
    setCreateDraft(undefined)
    setCreateName('')
    setRenamingPath(undefined)
    setContextMenu(undefined)
    setShowDiff(false)
    setError(undefined)
    setActiveOutlineLine(undefined)
    setFlashLine(undefined)
    if (rootPath === undefined || rootWorkspaceRef.current !== workspaceId) {
      setExpanded(new Set())
      setSelectedDirectory(undefined)
      return
    }
    setExpanded(new Set([rootPath]))
    setSelectedDirectory(rootPath)
    void loadDirectory(rootPath)
  }, [loadDirectory, rootPath, workspaceId])

  useEffect(() => {
    const value = query.trim()
    if (api === undefined || rootPath === undefined || workspaceId === undefined || value === '') {
      setMatches([])
      setSearching(false)
      return
    }
    let current = true
    setMatches([])
    setSearching(true)
    const timer = window.setTimeout(() => {
      void api.search(value, workspaceId).then(
        (entries) => { if (current) setMatches(entries) },
        (reason: unknown) => { if (current) { setMatches([]); setError(String(reason)) } },
      ).finally(() => { if (current) setSearching(false) })
    }, 150)
    return () => { current = false; window.clearTimeout(timer) }
  }, [api, query, rootPath, workspaceId])

  const toggleDirectory = (path: string) => {
    const opening = !expanded.has(path)
    setSelectedDirectory(path)
    setExpanded((current) => {
      const next = new Set(current)
      if (opening) next.add(path)
      else next.delete(path)
      return next
    })
    if (opening && children[path] === undefined) void loadDirectory(path)
  }

  const openFile = useCallback(async (path: string) => {
    if (api === undefined || rootPath === undefined || workspaceId === undefined
      || savingRef.current || mutatingRef.current || !mountedRef.current) return
    const previous = documentRef.current
    if (previous?.path === path) return
    if (documentIsDirty(previous) && !window.confirm('Discard unsaved changes and open another file?')) return
    const existing = openDocumentsRef.current.find(d => d.path === path)
    if (existing !== undefined) {
      activePathRef.current = path
      setActivePath(path)
      documentRef.current = existing
      setDocument(existing)
      setShowDiff(false)
      setSelectedDirectory(parentDirectory(rootPath, path))
      return
    }
    const request = ++readRequest.current
    setReading(true)
    setError(undefined)
    try {
      const next = await api.read(path, workspaceId)
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- refs can change while the desktop request is pending.
      if (mountedRef.current && readRequest.current === request) {
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- saving can start while the desktop request is pending.
        if (savingRef.current) return
        const latest = documentRef.current
        if (latest !== previous && documentIsDirty(latest)
          && !window.confirm('Discard unsaved changes and open another file?')) return
        const newDoc: EditorDocument = { path: next.path, savedContent: next.content, draft: next.content, version: next.version }
        const nextList = [...openDocumentsRef.current, newDoc]
        openDocumentsRef.current = nextList
        setOpenDocuments(nextList)
        activePathRef.current = next.path
        setActivePath(next.path)
        documentRef.current = newDoc
        setDocument(newDoc)
        setShowDiff(false)
        setSelectedDirectory(parentDirectory(rootPath, next.path))
      }
    } catch (reason) {
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- refs can change while the desktop request is pending.
      if (mountedRef.current && readRequest.current === request) setError(String(reason))
    } finally {
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- refs can change while the desktop request is pending.
      if (mountedRef.current && readRequest.current === request) setReading(false)
    }
  }, [api, rootPath, workspaceId])

  const closeTab = useCallback((path: string, force = false) => {
    const target = openDocumentsRef.current.find(d => d.path === path)
    if (target === undefined) return
    if (!force && documentIsDirty(target) && !window.confirm(`Discard unsaved changes in "${fileName(path)}"?`)) {
      return
    }
    const nextList = openDocumentsRef.current.filter(d => d.path !== path)
    openDocumentsRef.current = nextList
    setOpenDocuments(nextList)
    if (activePathRef.current === path) {
      const nextActive = nextList[nextList.length - 1]?.path
      activePathRef.current = nextActive
      setActivePath(nextActive)
      const nextDoc = nextList.find(d => d.path === nextActive)
      documentRef.current = nextDoc
      setDocument(nextDoc)
      setShowDiff(false)
    }
    props.onDirtyChange?.(nextList.some(d => documentIsDirty(d)))
  }, [props.onDirtyChange])

  const discardChanges = useCallback(() => {
    if (document === undefined || !dirty) return
    if (!window.confirm(`Discard unsaved changes in "${fileName(document.path)}"?`)) return
    updateDocument(current => current === undefined ? current : { ...current, draft: current.savedContent })
    setShowDiff(false)
  }, [dirty, document, updateDocument])

  const startCreate = (kind: CreateDraft['kind'], parent = selectedDirectory ?? rootPath) => {
    if (parent === undefined || creatingRef.current || mutatingRef.current) return
    setQuery('')
    setError(undefined)
    setCreateName('')
    setCreateDraft({ parent, kind })
  }

  const submitCreate = async () => {
    if (api === undefined || createDraft === undefined || workspaceId === undefined || createName.trim() === ''
      || creatingRef.current || mutatingRef.current) return
    const draft = createDraft
    const name = createName.trim()
    const generation = listGeneration.current
    const documentAtSubmit = documentRef.current
    const readRequestAtSubmit = readRequest.current
    creatingRef.current = true
    setCreating(true)
    setError(undefined)
    try {
      const entry = await api.create(draft.parent, name, draft.kind, workspaceId)
      if (!mountedRef.current || listGeneration.current !== generation) return
      setExpanded(current => new Set(current).add(draft.parent))
      await loadDirectory(draft.parent)
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- unmount can occur while the directory refresh is pending.
      if (!mountedRef.current || listGeneration.current !== generation) return
      setCreateDraft(undefined)
      setCreateName('')
      if (entry.directory) setSelectedDirectory(entry.path)
      else if (readRequest.current === readRequestAtSubmit
        && documentRef.current === documentAtSubmit && !documentIsDirty(documentRef.current)) {
        await openFile(entry.path)
      }
    } catch (reason) {
      if (mountedRef.current && listGeneration.current === generation) setError(String(reason))
    } finally {
      creatingRef.current = false
      if (mountedRef.current) setCreating(false)
    }
  }

  const startRename = (entry: DesktopFileEntry) => {
    if (mutatingRef.current || savingRef.current || formattingRef.current || creatingRef.current) return
    setContextMenu(undefined)
    setRenamingPath(entry.path)
    setRenameName(entry.name)
  }

  const submitRename = async (entry: DesktopFileEntry) => {
    if (mutatingRef.current || savingRef.current || formattingRef.current || creatingRef.current) return
    if (api?.rename === undefined || workspaceId === undefined || rootPath === undefined
      || renameName.trim() === '' || renameName.trim() === entry.name) {
      setRenamingPath(undefined)
      return
    }
    const newName = renameName.trim()
    const generation = listGeneration.current
    mutatingRef.current = true
    setMutating(true)
    setError(undefined)
    readRequest.current += 1
    setReading(false)
    try {
      const result = await api.rename(entry.path, newName, workspaceId)
      if (!mountedRef.current || listGeneration.current !== generation) return
      remapEntryPaths(entry.path, result.path, result.version)
      const parent = parentDirectory(rootPath, entry.path)
      await loadDirectory(parent)
    } catch (reason) {
      if (mountedRef.current && listGeneration.current === generation) setError(String(reason))
    } finally {
      mutatingRef.current = false
      if (mountedRef.current) {
        setMutating(false)
        if (listGeneration.current === generation) setRenamingPath(undefined)
      }
    }
  }

  const handleMove = async (sourcePath: string, destinationPath: string) => {
    setDropTargetPath(undefined)
    setDraggedPath(undefined)
    if (api?.move === undefined || workspaceId === undefined || rootPath === undefined
      || mutatingRef.current || savingRef.current || formattingRef.current || creatingRef.current
      || samePath(parentDirectory(rootPath, sourcePath), destinationPath)
      || samePath(sourcePath, destinationPath) || pathContains(sourcePath, destinationPath)) return
    const generation = listGeneration.current
    mutatingRef.current = true
    setMutating(true)
    setError(undefined)
    readRequest.current += 1
    setReading(false)
    try {
      const result = await api.move(sourcePath, destinationPath, workspaceId)
      if (!mountedRef.current || listGeneration.current !== generation) return
      remapEntryPaths(sourcePath, result.path, result.version)
      await Promise.all([
        loadDirectory(parentDirectory(rootPath, sourcePath)),
        loadDirectory(destinationPath),
      ])
    } catch (reason) {
      if (mountedRef.current && listGeneration.current === generation) setError(String(reason))
    } finally {
      mutatingRef.current = false
      if (mountedRef.current) setMutating(false)
    }
  }

  const handleDelete = async (entry: DesktopFileEntry) => {
    setContextMenu(undefined)
    if (api?.delete === undefined || workspaceId === undefined || rootPath === undefined
      || mutatingRef.current || savingRef.current || formattingRef.current || creatingRef.current) return
    if (!window.confirm(`Are you sure you want to delete "${entry.name}"?`)) return
    const generation = listGeneration.current
    mutatingRef.current = true
    setMutating(true)
    setError(undefined)
    readRequest.current += 1
    setReading(false)
    try {
      await api.delete(entry.path, workspaceId)
      if (!mountedRef.current || listGeneration.current !== generation) return
      if (entry.directory) {
        const inside = openDocumentsRef.current.filter(d => d.path.startsWith(`${entry.path}/`) || d.path.startsWith(`${entry.path}\\`))
        for (const d of inside) {
          closeTab(d.path, true)
        }
      } else {
        closeTab(entry.path, true)
      }
      const parent = parentDirectory(rootPath, entry.path)
      setSelectedDirectory(current => current !== undefined && (samePath(current, entry.path) || pathContains(entry.path, current))
        ? parent : current)
      setExpanded(current => new Set([...current].filter(path => !samePath(path, entry.path) && !pathContains(entry.path, path))))
      setChildren(current => Object.fromEntries(Object.entries(current)
        .filter(([path]) => !samePath(path, entry.path) && !pathContains(entry.path, path))))
      setQuery('')
      await loadDirectory(parent)
    } catch (reason) {
      if (mountedRef.current && listGeneration.current === generation) setError(String(reason))
    } finally {
      mutatingRef.current = false
      if (mountedRef.current) setMutating(false)
    }
  }

  const handleReveal = async (path: string) => {
    setContextMenu(undefined)
    if (api?.reveal === undefined || workspaceId === undefined) return
    try {
      await api.reveal(path, workspaceId)
    } catch (reason) {
      setError(String(reason))
    }
  }

  const handleCopyPath = async (path: string, isRelative = false) => {
    setContextMenu(undefined)
    if (rootPath === undefined) return
    const text = isRelative ? relativePath(rootPath, path) : path
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      // Clipboard permission or unsupported in headless environment
    }
  }

  const copyDraftContent = async () => {
    if (document === undefined) return
    try {
      await navigator.clipboard.writeText(document.draft)
    } catch {
      // Clipboard permission or unsupported in headless environment
    }
  }

  const updateCursorAndSelection = (target: HTMLTextAreaElement) => {
    const text = target.value.slice(0, target.selectionStart)
    const lines = text.split('\n')
    const lastLine = lines[lines.length - 1]
    setCursorPos({ line: lines.length, col: (lastLine ? lastLine.length : 0) + 1 })
    const selLength = Math.abs(target.selectionEnd - target.selectionStart)
    setSelectedChars(selLength)
    setActiveOutlineLine(undefined)
  }

  const handleSplitterMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    isDraggingRef.current = true
    setIsDragging(true)
    startXRef.current = e.clientX
    startWidthRef.current = sidebarWidth

    const onMouseMove = (moveEvent: MouseEvent) => {
      if (!isDraggingRef.current) return
      const delta = moveEvent.clientX - startXRef.current
      const nextWidth = Math.max(160, Math.min(480, startWidthRef.current + delta))
      setSidebarWidth(nextWidth)
    }

    const onMouseUp = () => {
      isDraggingRef.current = false
      setIsDragging(false)
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }, [sidebarWidth])

  const jumpToLine = useCallback((targetLine: number) => {
    if (document === undefined || editorTextareaRef.current === null) return
    const lines = document.draft.split('\n')
    const clampedLine = Math.max(1, Math.min(lines.length, targetLine))
    let charOffset = 0
    for (let i = 0; i < clampedLine - 1; i += 1) {
      charOffset += (lines[i]?.length ?? 0) + 1
    }
    const endOfLineOffset = charOffset + (lines[clampedLine - 1]?.length ?? 0)
    editorTextareaRef.current.focus()
    editorTextareaRef.current.setSelectionRange(charOffset, endOfLineOffset)
    setCursorPos({ line: clampedLine, col: 1 })
    setActiveOutlineLine(clampedLine)

    setFlashLine(clampedLine)
    if (flashTimeoutRef.current !== undefined) {
      window.clearTimeout(flashTimeoutRef.current)
    }
    flashTimeoutRef.current = window.setTimeout(() => {
      setFlashLine(undefined)
    }, 1800)

    if (codeScrollRef.current !== null) {
      const lineEl = codeScrollRef.current.querySelector<HTMLElement>(`[data-line="${clampedLine}"]`)
      const viewportHeight = codeScrollRef.current.clientHeight || 400
      const lineTop = lineEl ? lineEl.offsetTop : (12 + (clampedLine - 1) * 18.6)
      const scrollTarget = Math.max(0, lineTop - Math.floor(viewportHeight / 3))
      if (typeof codeScrollRef.current.scrollTo === 'function') {
        codeScrollRef.current.scrollTo({ top: scrollTarget, behavior: 'smooth' })
      } else {
        codeScrollRef.current.scrollTop = scrollTarget
      }
    }
  }, [document])

  const closeAllTabs = useCallback(() => {
    const dirtyDocs = openDocumentsRef.current.filter(d => documentIsDirty(d))
    if (dirtyDocs.length > 0 && !window.confirm(`Discard unsaved changes in ${dirtyDocs.length} file(s)?`)) {
      return
    }
    openDocumentsRef.current = []
    setOpenDocuments([])
    activePathRef.current = undefined
    setActivePath(undefined)
    documentRef.current = undefined
    setDocument(undefined)
    setShowDiff(false)
    props.onDirtyChange?.(false)
  }, [props.onDirtyChange])

  const saveAllFiles = useCallback(async () => {
    if (api === undefined || workspaceId === undefined || savingRef.current || formattingRef.current || mutatingRef.current) return
    const dirtyDocs = openDocumentsRef.current.filter(d => documentIsDirty(d))
    if (dirtyDocs.length === 0) return
    const generation = listGeneration.current
    savingRef.current = true
    setSaving(true)
    props.onSavingChange?.(true)
    setError(undefined)
    try {
      for (const doc of dirtyDocs) {
        if (!mountedRef.current || listGeneration.current !== generation) return
        if (!openDocumentsRef.current.some(current => current.path === doc.path)) continue
        const saved = await api.save(doc.path, doc.draft, doc.version, workspaceId)
        // Acknowledgements update disk state without replacing newer drafts or reopening closed tabs.
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- unmount can occur while the save is pending.
        if (!mountedRef.current || listGeneration.current !== generation) return
        publishDocuments(openDocumentsRef.current.map(current => current.path === doc.path
          ? { ...current, savedContent: doc.draft, version: saved.version } : current))
      }
    } catch (reason) {
      if (mountedRef.current && listGeneration.current === generation) setError(String(reason))
    } finally {
      savingRef.current = false
      if (mountedRef.current) {
        setSaving(false)
        props.onSavingChange?.(false)
      }
    }
  }, [api, publishDocuments, props.onSavingChange, workspaceId])

  const saveFile = useCallback(async () => {
    if (api === undefined || document === undefined || workspaceId === undefined || !dirty
      || savingRef.current || formattingRef.current || mutatingRef.current) return
    const snapshot = document
    const generation = listGeneration.current
    savingRef.current = true
    setSaving(true)
    props.onSavingChange?.(true)
    setError(undefined)
    try {
      const saved = await api.save(snapshot.path, snapshot.draft, snapshot.version, workspaceId)
      if (!mountedRef.current || listGeneration.current !== generation) return
      publishDocuments(openDocumentsRef.current.map(current => current.path === snapshot.path
        ? { ...current, savedContent: snapshot.draft, version: saved.version } : current))
    } catch (reason) {
      if (mountedRef.current && listGeneration.current === generation) setError(String(reason))
    } finally {
      savingRef.current = false
      if (mountedRef.current) {
        setSaving(false)
        props.onSavingChange?.(false)
      }
    }
  }, [api, dirty, document, props.onSavingChange, publishDocuments, workspaceId])

  const formatFile = useCallback(async () => {
    if (api === undefined || document === undefined || workspaceId === undefined
      || formattingRef.current || savingRef.current || mutatingRef.current) return
    const snapshot = document
    formattingRef.current = true
    setFormatting(true)
    setError(undefined)
    try {
      const formatted = await api.format(snapshot.path, snapshot.draft, workspaceId)
      updateDocument(current => current?.path === snapshot.path && current.draft === snapshot.draft
        ? { ...current, draft: formatted }
        : current)
    } catch (reason) {
      if (mountedRef.current && documentRef.current?.path === snapshot.path
        && documentRef.current.draft === snapshot.draft) setError(String(reason))
    } finally {
      formattingRef.current = false
      if (mountedRef.current) setFormatting(false)
    }
  }, [api, document, updateDocument, workspaceId])

  const findMatches = useMemo(() => {
    if (!findQuery || document === undefined) return []
    const draft = document.draft
    const matches: Array<{ start: number; end: number; line: number }> = []
    const queryToSearch = findMatchCase ? findQuery : findQuery.toLowerCase()
    const textToSearch = findMatchCase ? draft : draft.toLowerCase()
    let pos = 0
    while (pos < textToSearch.length) {
      const idx = textToSearch.indexOf(queryToSearch, pos)
      if (idx === -1) break
      const line = draft.slice(0, idx).split('\n').length
      matches.push({ start: idx, end: idx + queryToSearch.length, line })
      pos = idx + Math.max(1, queryToSearch.length)
    }
    return matches
  }, [document, findMatchCase, findQuery])

  const goToMatch = useCallback((index: number) => {
    if (findMatches.length === 0 || editorTextareaRef.current === null || document === undefined) return
    const normalizedIndex = (index + findMatches.length) % findMatches.length
    setCurrentMatchIndex(normalizedIndex)
    const match = findMatches[normalizedIndex]
    if (match) {
      /* jscpd:ignore-start -- line navigation uses the same scroll calculation for two editor views. */
      editorTextareaRef.current.focus()
      editorTextareaRef.current.setSelectionRange(match.start, match.end)
      const lastNl = document.draft.lastIndexOf('\n', match.start - 1)
      const col = lastNl === -1 ? match.start + 1 : match.start - lastNl
      setCursorPos({ line: match.line, col })
      if (codeScrollRef.current !== null) {
        const lineEl = codeScrollRef.current.querySelector<HTMLElement>(`[data-line="${match.line}"]`)
        const viewportHeight = codeScrollRef.current.clientHeight || 400
        const lineTop = lineEl ? lineEl.offsetTop : (12 + (match.line - 1) * 18.6)
        const scrollTarget = Math.max(0, lineTop - Math.floor(viewportHeight / 3))
        if (typeof codeScrollRef.current.scrollTo === 'function') {
          codeScrollRef.current.scrollTo({ top: scrollTarget, behavior: 'smooth' })
        } else {
          codeScrollRef.current.scrollTop = scrollTarget
        }
      }
    }
    /* jscpd:ignore-end */
  }, [document, findMatches])

  const findNext = useCallback(() => {
    goToMatch(currentMatchIndex + 1)
  }, [currentMatchIndex, goToMatch])

  const findPrev = useCallback(() => {
    goToMatch(currentMatchIndex - 1)
  }, [currentMatchIndex, goToMatch])

  useEffect(() => {
    if (showFind) {
      findInputRef.current?.focus()
      findInputRef.current?.select()
    }
  }, [showFind])

  useEffect(() => {
    if (!props.active) return
    const onKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLocaleLowerCase()
      if ((event.ctrlKey || event.metaKey) && !event.altKey && key === 's') {
        event.preventDefault()
        void saveFile()
      } else if (event.shiftKey && event.altKey && key === 'f') {
        event.preventDefault()
        void formatFile()
      } else if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && key === 'f') {
        event.preventDefault()
        setShowFind(true)
      } else if (event.altKey && !event.ctrlKey && !event.metaKey && key === 'z') {
        event.preventDefault()
        setWordWrap(w => !w)
      } else if ((event.ctrlKey || event.metaKey) && !event.altKey && key === 'g') {
        event.preventDefault()
        setShowGotoLine(true)
      } else if (event.key === 'Escape') {
        if (showFind) {
          setShowFind(false)
          editorTextareaRef.current?.focus()
          return
        }
        setContextMenu(undefined)
        setRenamingPath(undefined)
        setShowGotoLine(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown) }
  }, [formatFile, props.active, saveFile, showFind])

  const language = document === undefined ? undefined : editorLanguage(document.path)
  const outlineSymbols = useMemo(() => {
    return document === undefined ? [] : extractSymbols(document.draft, language)
  }, [document, language])

  const activeSymbolLine = useMemo(() => {
    if (outlineSymbols.length === 0) return undefined
    if (activeOutlineLine !== undefined) return activeOutlineLine
    let closestLine: number | undefined
    for (const sym of outlineSymbols) {
      if (sym.line <= cursorPos.line) {
        if (closestLine === undefined || sym.line > closestLine) {
          closestLine = sym.line
        }
      }
    }
    return closestLine
  }, [activeOutlineLine, cursorPos.line, outlineSymbols])

  const renderDirectory = (path: string, depth: number): ReactNode => {
    const entries = children[path]
    if (entries === undefined) return null
    return sortFileEntries(entries).map((entry) => {
      const open = entry.directory && expanded.has(entry.path)
      const isRenaming = renamingPath === entry.path
      return (
        <div key={entry.path} role="treeitem" aria-expanded={entry.directory ? open : undefined}>
          {isRenaming ? (
            <form
              className={css.renameRow}
              style={{ paddingLeft: 8 + depth * 14 }}
              onSubmit={(e) => {
                e.preventDefault()
                void submitRename(entry)
              }}
            >
              {entry.directory ? <IconFolderClose16 size={15} /> : <FileIcon path={entry.path} />}
              <input data-hydra-control="compact"
                autoFocus
                className={css.renameInput}
                aria-label={`Rename ${entry.name}`}
                disabled={mutating}
                value={renameName}
                onChange={(e) => { setRenameName(e.currentTarget.value) }}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setRenamingPath(undefined)
                }}
              />
              <button type="submit" aria-label="Confirm rename" className={css.renameBtn} disabled={mutating}>
                <IconCheckOutline14 />
              </button>
              <button
                type="button"
                aria-label="Cancel rename"
                disabled={mutating}
                className={css.renameBtn}
                onClick={() => { setRenamingPath(undefined) }}
              >
                <IconCloseOutline16 size={13} />
              </button>
            </form>
          ) : (
            <button
              type="button"
              className={css.row}
              draggable={!mutating && !saving && !formatting && !creating}
              data-drop-target={dropTargetPath === entry.path ? 'true' : undefined}
              style={{ paddingLeft: 8 + depth * 14 }}
              data-selected={entry.directory
                ? selectedDirectory === entry.path
                : document?.path === entry.path || undefined}
              onClick={() => {
                if (entry.directory) toggleDirectory(entry.path)
                else void openFile(entry.path)
              }}
              onContextMenu={(e) => {
                e.preventDefault()
                e.stopPropagation()
                setContextMenu({ x: e.clientX, y: e.clientY, entry })
              }}
              onDragStart={(event) => {
                if (mutating || saving || formatting || creating) return
                setDraggedPath(entry.path)
                event.dataTransfer.effectAllowed = 'move'
                event.dataTransfer.setData('text/plain', entry.path)
              }}
              onDragEnd={() => { setDraggedPath(undefined); setDropTargetPath(undefined) }}
              onDragOver={(event) => {
                if (!entry.directory || draggedPath === undefined || samePath(draggedPath, entry.path)
                  || pathContains(draggedPath, entry.path) || mutating) return
                event.preventDefault()
                event.dataTransfer.dropEffect = 'move'
                setDropTargetPath(entry.path)
              }}
              onDragLeave={() => { if (dropTargetPath === entry.path) setDropTargetPath(undefined) }}
              onDrop={(event) => {
                event.preventDefault()
                const sourcePath = draggedPath ?? event.dataTransfer.getData('text/plain')
                if (sourcePath !== '') void handleMove(sourcePath, entry.path)
                else setDropTargetPath(undefined)
              }}
            >
              {entry.directory
                ? <IconChevronRightOutline14 className={css.chevron} size={12} />
                : <span className={css.chevron} />}
              {entry.directory
                ? open ? <IconFolderOpen16 size={15} /> : <IconFolderClose16 size={15} />
                : <FileIcon path={entry.path} />}
              <span className={css.name}>{entry.name}</span>
            </button>
          )}
          {open && renderDirectory(entry.path, depth + 1)}
        </div>
      )
    })
  }

  if (rootPath === undefined) {
    return (
      <div className={css.empty} role={error === undefined ? 'status' : 'alert'}>
        {error ?? (workspaceId === undefined
          ? 'Open a workspace to browse its files.'
          : rootLoading ? 'Loading workspace files…' : 'Workspace files are unavailable.')}
      </div>
    )
  }

  const status = saving
    ? 'Saving…'
    : formatting
      ? 'Formatting…'
      : mutating
        ? 'Updating files…'
        : creating
          ? 'Creating…'
          : searching
            ? 'Searching…'
            : loading || reading
              ? 'Loading…'
              : undefined
  const highlightedDraft = document !== undefined && deferredDraft === document.draft
    && document.draft.length <= HIGHLIGHT_MAX_CHARS
    ? deferredDraft
    : undefined
  const lineCount = document ? document.draft.split('\n').length : 1

  return (
    <div className={css.surface} style={{ gridTemplateColumns: `${sidebarWidth}px 4px minmax(0, 1fr)` }} data-files-root={rootPath}>
      <aside className={css.treePane} style={{ width: sidebarWidth }}>
        {/* OPEN EDITORS Section */}
        <div className={css.section}>
          <div
            className={css.sectionHeader}
            role="button"
            tabIndex={0}
            onClick={() => { setOpenEditorsCollapsed(c => !c) }}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setOpenEditorsCollapsed(c => !c) }}
          >
            <span className={`${css.sectionChevron} ${!openEditorsCollapsed ? css.sectionChevronOpen : ''}`}>
              <IconChevronRightOutline14 size={12} />
            </span>
            <span className={css.sectionTitle}>OPEN EDITORS</span>
            {openDocuments.length > 0 && (
              <span className={css.sectionBadge}>{openDocuments.length}</span>
            )}
            <div className={css.sectionActions} onClick={(e) => { e.stopPropagation() }}>
              <button
                type="button"
                className={css.sectionActionBtn}
                title="Save all files"
                aria-label="Save all files"
                disabled={saving || formatting || mutating || !openDocuments.some(d => documentIsDirty(d))}
                onClick={() => { void saveAllFiles() }}
              >
                <IconCheckOutline14 size={12} />
              </button>
              <button
                type="button"
                className={css.sectionActionBtn}
                title="Close all files"
                aria-label="Close all files"
                disabled={openDocuments.length === 0}
                onClick={closeAllTabs}
              >
                <IconCloseOutline16 size={12} />
              </button>
            </div>
          </div>
          {!openEditorsCollapsed && openDocuments.length > 0 && (
            <div className={css.openEditorsList} role="list" aria-label="Open editors">
              {openDocuments.map((doc) => {
                const isActive = doc.path === activePath
                const isDocDirty = documentIsDirty(doc)
                const name = fileName(doc.path)
                const rel = relativePath(rootPath, doc.path)
                const lastSlash = Math.max(rel.lastIndexOf('/'), rel.lastIndexOf('\\'))
                const dirPath = lastSlash > 0 ? rel.slice(0, lastSlash) : ''
                return (
                  <div
                    key={doc.path}
                    className={`${css.openEditorItem} ${isActive ? css.openEditorActive : ''}`}
                    role="listitem"
                    title={doc.path}
                    onClick={() => {
                      activePathRef.current = doc.path
                      setActivePath(doc.path)
                      documentRef.current = doc
                      setDocument(doc)
                      setShowDiff(false)
                    }}
                  >
                    <FileIcon path={doc.path} />
                    <span className={css.openEditorName}>{name}</span>
                    {dirPath !== '' && <span className={css.openEditorPath}>{dirPath}</span>}
                    {isDocDirty && <span className={css.tabDirty} aria-hidden="true" title="Unsaved changes">●</span>}
                    <button
                      type="button"
                      className={css.openEditorClose}
                      aria-label={`Close editor ${name}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        closeTab(doc.path)
                      }}
                    >
                      <IconCloseOutline16 size={12} />
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* WORKSPACE FILES Section */}
        <div className={css.section} style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <div
            className={css.sectionHeader}
            role="button"
            tabIndex={0}
            onClick={() => { setWorkspaceTreeCollapsed(c => !c) }}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setWorkspaceTreeCollapsed(c => !c) }}
          >
            <span className={`${css.sectionChevron} ${!workspaceTreeCollapsed ? css.sectionChevronOpen : ''}`}>
              <IconChevronRightOutline14 size={12} />
            </span>
            <span className={css.sectionTitle} title={rootPath}>{fileName(rootPath).toUpperCase()}</span>
            <div className={css.sectionActions} onClick={(e) => { e.stopPropagation() }}>
              <button
                type="button"
                className={css.sectionActionBtn}
                aria-label="New file"
                title="New file"
                disabled={creating || mutating}
                onClick={() => { startCreate('file') }}
              >
                <IconPlusOutline16 size={12} />
              </button>
              <button
                type="button"
                className={css.sectionActionBtn}
                aria-label="New folder"
                title="New folder"
                disabled={creating || mutating}
                onClick={() => { startCreate('directory') }}
              >
                <IconProjectAddOutline16 size={12} />
              </button>
              <button
                type="button"
                className={css.sectionActionBtn}
                aria-label="Collapse all folders"
                title="Collapse all folders"
                onClick={() => { setExpanded(new Set()) }}
              >
                <IconFolderClose16 size={12} />
              </button>
              <button
                type="button"
                className={css.sectionActionBtn}
                aria-label="Refresh files"
                title="Refresh files"
                disabled={creating || mutating}
                onClick={() => { void loadDirectory(rootPath) }}
              >
                <IconRefreshOutline14 size={12} />
              </button>
            </div>
          </div>
          {!workspaceTreeCollapsed && (
            <>
              <div className={css.filter}>
                <input data-hydra-control="compact"
                  ref={searchRef}
                  type="search"
                  aria-label="Filter workspace files"
                  placeholder="Filter files…"
                  value={query}
                  onChange={(event) => { setQuery(event.currentTarget.value); setError(undefined) }}
                />
              </div>
              <div
                className={css.tree}
                role="tree"
                aria-label="Workspace files"
                aria-busy={loading || searching || creating || mutating || undefined}
                data-drop-target={dropTargetPath === rootPath ? 'true' : undefined}
                onDragOver={(event) => {
                  if (event.target !== event.currentTarget || draggedPath === undefined || mutating) return
                  event.preventDefault()
                  event.dataTransfer.dropEffect = 'move'
                  setDropTargetPath(rootPath)
                }}
                onDragLeave={(event) => {
                  if (event.target === event.currentTarget) setDropTargetPath(undefined)
                }}
                onDrop={(event) => {
                  if (event.target !== event.currentTarget) return
                  event.preventDefault()
                  const sourcePath = draggedPath ?? event.dataTransfer.getData('text/plain')
                  if (sourcePath !== '') void handleMove(sourcePath, rootPath)
                  else setDropTargetPath(undefined)
                }}
              >
                {createDraft !== undefined && (
                  <form
                    className={css.createRow}
                    title={`Create in ${relativePath(rootPath, createDraft.parent)}`}
                    onSubmit={(event) => { event.preventDefault(); void submitCreate() }}
                  >
                    {createDraft.kind === 'directory' ? <IconFolderClose16 size={15} /> : <FileIcon path={createName} />}
                    <input data-hydra-control="compact"
                      ref={createRef}
                      aria-label={createDraft.kind === 'directory' ? 'New folder name' : 'New file name'}
                      value={createName}
                      disabled={creating}
                      onChange={(event) => { setCreateName(event.currentTarget.value) }}
                      onKeyDown={(event) => {
                        if (event.key !== 'Escape') return
                        setCreateDraft(undefined)
                        setCreateName('')
                      }}
                    />
                    <button type="submit" aria-label={`Create ${createDraft.kind}`} disabled={creating || createName.trim() === ''}>
                      <IconCheckOutline14 />
                    </button>
                    <button
                      type="button"
                      aria-label={`Cancel new ${createDraft.kind}`}
                      disabled={creating}
                      onClick={() => { setCreateDraft(undefined); setCreateName('') }}
                    >
                      <IconCloseOutline16 size={13} />
                    </button>
                  </form>
                )}
                {query.trim() === ''
                  ? renderDirectory(rootPath, 0)
                  : matches.map(entry => (
                    <div key={entry.path} role="treeitem">
                      <button
                        type="button"
                        className={css.row}
                        data-selected={document?.path === entry.path || undefined}
                        title={entry.name}
                        onClick={() => { void openFile(entry.path) }}
                        onContextMenu={(e) => {
                          e.preventDefault()
                          e.stopPropagation()
                          setContextMenu({ x: e.clientX, y: e.clientY, entry })
                        }}
                      >
                        <span className={css.chevron} />
                        <FileIcon path={entry.path} />
                        <span className={css.name}>{entry.name}</span>
                      </button>
                    </div>
                  ))}
                {query.trim() !== '' && !searching && matches.length === 0 && (
                  <div className={css.noResults}>No files found.</div>
                )}
              </div>
            </>
          )}
        </div>

        {/* OUTLINE Section */}
        <div className={css.section}>
          <div
            className={css.sectionHeader}
            role="button"
            tabIndex={0}
            onClick={() => { setOutlineCollapsed(c => !c) }}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setOutlineCollapsed(c => !c) }}
          >
            <span className={`${css.sectionChevron} ${!outlineCollapsed ? css.sectionChevronOpen : ''}`}>
              <IconChevronRightOutline14 size={12} />
            </span>
            <span className={css.sectionTitle}>OUTLINE</span>
            {outlineSymbols.length > 0 && (
              <span className={css.sectionBadge}>{outlineSymbols.length}</span>
            )}
          </div>
          {!outlineCollapsed && (
            <div className={css.outlineList} role="list" aria-label="Code outline">
              {outlineSymbols.length === 0 ? (
                <div className={css.outlineEmpty}>No symbols found in file.</div>
              ) : (
                outlineSymbols.map((sym, idx) => {
                  const isSelected = activeSymbolLine === sym.line
                  return (
                    <div
                      key={`${sym.name}-${sym.line}-${idx}`}
                      className={css.outlineItem}
                      role="listitem"
                      data-selected={isSelected ? 'true' : undefined}
                      aria-selected={isSelected}
                      tabIndex={0}
                      onClick={() => {
                        setActiveOutlineLine(sym.line)
                        jumpToLine(sym.line)
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          setActiveOutlineLine(sym.line)
                          jumpToLine(sym.line)
                        }
                      }}
                    >
                      <span className={css.symbolBadge} data-kind={sym.kind}>
                        {sym.kind === 'function' ? 'ƒ' : sym.kind === 'class' ? 'C' : sym.kind === 'interface' ? 'I' : sym.kind === 'type' ? 'T' : '#'}
                      </span>
                      <span className={css.symbolName}>{sym.name}</span>
                      <span className={css.symbolLine}>:{sym.line}</span>
                    </div>
                  )
                })
              )}
            </div>
          )}
        </div>
      </aside>

      {/* Resizable Splitter */}
      <div
        className={`${css.splitter} ${isDragging ? css.splitterActive : ''}`}
        onMouseDown={handleSplitterMouseDown}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize file explorer"
      />

      <section className={css.editor} aria-label="File editor">
        {openDocuments.length > 0 && (
          <div className={css.tabBar}>
            <div className={css.tabList} role="tablist" aria-label="Open files">
              {openDocuments.map((doc) => {
                const isTabActive = doc.path === activePath
                const isTabDirty = documentIsDirty(doc)
                return (
                  /* jscpd:ignore-start -- list and tab rows intentionally share activation behavior. */
                  <div
                    key={doc.path}
                    className={`${css.tab} ${isTabActive ? css.tabActive : ''}`}
                    role="tab"
                    aria-selected={isTabActive}
                    title={doc.path}
                    onClick={() => {
                      activePathRef.current = doc.path
                      setActivePath(doc.path)
                      documentRef.current = doc
                      setDocument(doc)
                      setShowDiff(false)
                    }}
                  >
                    <FileIcon path={doc.path} />
                    <span className={css.tabName}>{fileName(doc.path)}</span>
                    {isTabDirty && <span className={css.tabDirty} aria-hidden="true" title="Unsaved changes">●</span>}
                    <button
                      type="button"
                      className={css.tabClose}
                      aria-label={`Close ${fileName(doc.path)}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        closeTab(doc.path)
                      }}
                    >
                      <IconCloseOutline16 size={12} />
                    </button>
                  </div>
                  /* jscpd:ignore-end */
                )
              })}
            </div>

            {document !== undefined && (
              <div className={css.editorActions}>
                <button
                  type="button"
                  className={`${css.editorActionBtn} ${wordWrap ? css.editorActionBtnActive : ''}`}
                  aria-label={wordWrap ? 'Wrap: On' : 'Wrap: Off'}
                  aria-keyshortcuts="Alt+Z"
                  title={wordWrap ? 'Disable Word Wrap (Alt+Z)' : 'Enable Word Wrap (Alt+Z)'}
                  onClick={() => { setWordWrap(w => !w) }}
                >
                  <WordWrapIcon size={14} />
                </button>
                <button
                  type="button"
                  className={css.editorActionBtn}
                  aria-label=":Line"
                  aria-keyshortcuts="Control+G"
                  title="Go to line (Ctrl+G)"
                  onClick={() => { setShowGotoLine(true) }}
                >
                  <GoToLineIcon size={14} />
                </button>
                <button
                  type="button"
                  className={`${css.editorActionBtn} ${showFind ? css.editorActionBtnActive : ''}`}
                  aria-label="Find"
                  aria-keyshortcuts="Control+F"
                  title={showFind ? 'Close Find (Ctrl+F)' : 'Find in file (Ctrl+F)'}
                  onClick={() => { setShowFind(s => !s) }}
                >
                  <IconSearchOutline16 size={13} />
                </button>
                {dirty && (
                  <>
                    <button
                      type="button"
                      className={`${css.editorActionBtn} ${showDiff ? css.editorActionBtnActive : ''}`}
                      aria-label={showDiff ? 'Editor' : 'Diff'}
                      disabled={saving || formatting}
                      title="Toggle diff with disk"
                      onClick={() => { setShowDiff(s => !s) }}
                    >
                      <span className={css.btnTextBadge}>{showDiff ? 'Code' : 'Diff'}</span>
                    </button>
                    <button
                      type="button"
                      className={css.editorActionBtn}
                      aria-label="Discard"
                      disabled={saving || formatting}
                      title="Discard unsaved changes"
                      onClick={discardChanges}
                    >
                      <span className={css.btnTextBadge}>Discard</span>
                    </button>
                  </>
                )}
                <button
                  type="button"
                  className={css.editorActionBtn}
                  aria-label="Copy file content"
                  title="Copy file content"
                  onClick={() => { void copyDraftContent() }}
                >
                  <IconCopyOutline16 size={13} />
                </button>
                <button
                  type="button"
                  className={css.editorActionBtn}
                  aria-label="Format"
                  aria-keyshortcuts="Shift+Alt+F"
                  disabled={formatting || saving || mutating}
                  title="Format document (Shift+Alt+F)"
                  onMouseDown={(event) => { event.preventDefault() }}
                  onClick={() => { void formatFile() }}
                >
                  <IconCodeOutline16 size={13} />
                </button>
                <button
                  type="button"
                  className={`${css.editorActionBtn} ${dirty ? css.editorActionBtnDirty : ''}`}
                  aria-label="Save"
                  aria-keyshortcuts="Control+S"
                  disabled={!dirty || saving || formatting || mutating}
                  title="Save (Ctrl+S)"
                  onMouseDown={(event) => { event.preventDefault() }}
                  onClick={() => { void saveFile() }}
                >
                  <IconCheckOutline14 size={13} />
                </button>
              </div>
            )}
          </div>
        )}

        {document !== undefined && (
          <nav className={css.breadcrumbs} aria-label="Breadcrumbs">
            <div className={css.breadcrumbsPath}>
              {relativePath(rootPath, document.path).split(/[/\\]/u).map((segment, idx, arr) => {
                const isLast = idx === arr.length - 1
                return (
                  <span key={idx} className={css.breadcrumbSegment}>
                    {idx > 0 && (
                      <span className={css.breadcrumbChevron} aria-hidden="true">
                        <IconChevronRightOutline14 size={10} />
                      </span>
                    )}
                    <span className={`${css.breadcrumbItem} ${isLast ? css.breadcrumbActive : ''}`}>
                      {isLast && <FileIcon path={document.path} />}
                      {segment}
                    </span>
                  </span>
                )
              })}
            </div>
            {dirty && <span className={css.dirty} aria-label="Unsaved changes">●</span>}
          </nav>
        )}

        {showGotoLine && (
          <div className={css.gotoLineDialog} role="dialog" aria-label="Go to line">
            <span className={css.gotoLineLabel}>Go to line:</span>
            <input data-hydra-control="compact"
              autoFocus
              type="number"
              min={1}
              max={lineCount}
              className={css.gotoLineInput}
              placeholder={`1-${lineCount}`}
              value={gotoLineValue}
              onChange={(e) => { setGotoLineValue(e.currentTarget.value) }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  const num = Number.parseInt(gotoLineValue, 10)
                  if (!Number.isNaN(num)) {
                    jumpToLine(num)
                    setShowGotoLine(false)
                    setGotoLineValue('')
                  }
                } else if (e.key === 'Escape') {
                  setShowGotoLine(false)
                  setGotoLineValue('')
                }
              }}
            />
            <button
              type="button"
              className={css.gotoLineBtn}
              onClick={() => {
                const num = Number.parseInt(gotoLineValue, 10)
                if (!Number.isNaN(num)) {
                  jumpToLine(num)
                  setShowGotoLine(false)
                  setGotoLineValue('')
                }
              }}
            >
              Go
            </button>
            <button
              type="button"
              className={css.gotoLineBtn}
              onClick={() => {
                setShowGotoLine(false)
                setGotoLineValue('')
              }}
            >
              ✕
            </button>
          </div>
        )}

        {showFind && document !== undefined && (
          <div className={css.findWidget} role="search" aria-label="Find in file">
            <input data-hydra-control="compact"
              ref={findInputRef}
              type="search"
              className={css.findInput}
              aria-label="Find query"
              placeholder="Find..."
              value={findQuery}
              onChange={(e) => { setFindQuery(e.currentTarget.value) }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  if (e.shiftKey) findPrev()
                  else findNext()
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  setShowFind(false)
                  editorTextareaRef.current?.focus()
                }
              }}
            />
            <span className={css.findMatchesCount}>
              {findQuery === ''
                ? ''
                : findMatches.length === 0
                  ? 'No results'
                  : `${currentMatchIndex + 1} of ${findMatches.length}`}
            </span>
            <button
              type="button"
              className={css.findBtn}
              aria-label="Previous match"
              title="Previous match (Shift+Enter)"
              disabled={findMatches.length === 0}
              onClick={findPrev}
            >
              <IconChevronUpOutline14 size={13} />
            </button>
            <button
              type="button"
              className={css.findBtn}
              aria-label="Next match"
              title="Next match (Enter)"
              disabled={findMatches.length === 0}
              onClick={findNext}
            >
              <IconChevronDownOutline14 size={13} />
            </button>
            <button
              type="button"
              className={`${css.findBtn} ${findMatchCase ? css.findBtnActive : ''}`}
              aria-label="Match case"
              title="Match case"
              onClick={() => { setFindMatchCase(c => !c) }}
            >
              Aa
            </button>
            <button
              type="button"
              className={css.findBtn}
              aria-label="Close find"
              title="Close find"
              onClick={() => {
                setShowFind(false)
                editorTextareaRef.current?.focus()
              }}
            >
              <IconCloseOutline16 size={12} />
            </button>
          </div>
        )}

        {document === undefined ? (
          <div className={css.empty}>Select a text file from the workspace tree.</div>
        ) : showDiff && dirty ? (
          <div className={css.diffScroll} role="region" aria-label="Diff with disk">
            {computeLineDiff(document.savedContent, document.draft).map((line, idx) => (
              <div
                key={idx}
                className={`${css.diffLine} ${line.type === 'add' ? css.diffLineAdd : line.type === 'del' ? css.diffLineDel : css.diffLineContext}`}
              >
                <span className={css.diffGutter} aria-hidden="true">
                  {line.type === 'del' ? line.oldNo : line.type === 'add' ? line.newNo : `${line.oldNo ?? ''}`}
                </span>
                <span className={css.diffText}>
                  {line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '} {line.text}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div ref={codeScrollRef} className={css.codeScroll}>
            <div className={css.codeCanvas} data-wrap={wordWrap ? 'true' : undefined}>
              <div className={css.lineGutter} aria-hidden="true">
                {Array.from({ length: lineCount }, (_, i) => (
                  <div
                    key={i + 1}
                    className={css.lineNumber}
                    data-line={i + 1}
                    data-active={cursorPos.line === i + 1 ? 'true' : undefined}
                    data-flash={flashLine === i + 1 ? 'true' : undefined}
                  >
                    {i + 1}
                  </div>
                ))}
              </div>
              <div className={css.codeArea}>
                {flashLine !== undefined && (
                  <div
                    className={css.lineFlashHighlight}
                    style={{
                      top: 12 + (flashLine - 1) * 18.6,
                      height: 18.6,
                    }}
                    aria-hidden="true"
                  />
                )}
                <div
                  ref={node => node?.setAttribute('inert', '')}
                  className={css.codeSyntax}
                  data-editor-highlight={highlightedDraft === undefined ? 'plain' : language ?? 'plain'}
                  aria-hidden="true"
                >
                  {highlightedDraft === undefined
                    ? (
                      <pre className={css.codePlain} data-wrap={wordWrap ? 'true' : undefined}>
                        {document.draft}{document.draft.endsWith('\n') && '\u200b'}
                      </pre>
                    )
                    : (
                      <CodeBlock
                        code={`${highlightedDraft}${highlightedDraft.endsWith('\n') ? '\u200b' : ''}`}
                        lang={language}
                        className={css.codeHighlight}
                        data-wrap={wordWrap ? 'true' : undefined}
                      />
                    )}
                </div>
                <textarea data-hydra-control="editor"
                  ref={editorTextareaRef}
                  className={css.code}
                  aria-label={`Editor for ${fileName(document.path)}`}
                  data-dirty={dirty || undefined}
                  data-wrap={wordWrap ? 'true' : undefined}
                  spellCheck={false}
                  wrap={wordWrap ? 'soft' : 'off'}
                  value={document.draft}
                  onChange={(event) => {
                    const draft = event.currentTarget.value
                    updateDocument(current => current === undefined ? current : { ...current, draft })
                    updateCursorAndSelection(event.currentTarget)
                  }}
                  onSelect={(event) => { updateCursorAndSelection(event.currentTarget) }}
                  onKeyUp={(event) => { updateCursorAndSelection(event.currentTarget) }}
                  onClick={(event) => { updateCursorAndSelection(event.currentTarget) }}
                />
              </div>
            </div>
          </div>
        )}
        {document !== undefined && (
          <footer className={css.statusBar}>
            <div className={css.statusLeft}>
              <span className={css.statusItem}>
                Ln {cursorPos.line}, Col {cursorPos.col}
                {selectedChars > 0 && ` (${selectedChars} selected)`}
              </span>
              <span className={css.statusDivider}>|</span>
              <span className={css.statusItem}>{lineCount} lines</span>
              <span className={css.statusDivider}>|</span>
              <span className={css.statusItem}>Spaces: 2</span>
            </div>
            <div className={css.statusRight}>
              <span className={css.statusItem}>UTF-8</span>
              <span className={css.statusDivider}>|</span>
              <span className={css.statusItem}>{lineEndingOf(document.draft)}</span>
              <span className={css.statusDivider}>|</span>
              <span className={css.statusPill}>{(language ?? 'plain').toUpperCase()}</span>
            </div>
          </footer>
        )}
        {(status !== undefined || error !== undefined) && (
          <div className={css.messages}>
            {status !== undefined && <span className={css.status} role="status" aria-live="polite">{status}</span>}
            {error !== undefined && <div className={css.error} role="alert">{error}</div>}
          </div>
        )}
      </section>

      {contextMenu !== undefined && (
        <div
          className={css.contextMenu}
          style={{ left: Math.min(contextMenu.x, window.innerWidth - 180), top: Math.min(contextMenu.y, window.innerHeight - 200) }}
          role="menu"
          aria-label="File options"
        >
          {contextMenu.entry.directory && (
            <>
              <button
                type="button"
                className={css.contextMenuItem}
                role="menuitem"
                onClick={() => {
                  setContextMenu(undefined)
                  setSelectedDirectory(contextMenu.entry.path)
                  startCreate('file', contextMenu.entry.path)
                }}
              >
                <IconPlusOutline16 size={13} />
                New File
              </button>
              <button
                type="button"
                className={css.contextMenuItem}
                role="menuitem"
                onClick={() => {
                  setContextMenu(undefined)
                  setSelectedDirectory(contextMenu.entry.path)
                  startCreate('directory', contextMenu.entry.path)
                }}
              >
                <IconProjectAddOutline16 size={13} />
                New Folder
              </button>
              <div className={css.contextMenuSeparator} />
            </>
          )}
          <button
            type="button"
            className={css.contextMenuItem}
            role="menuitem"
            disabled={api?.rename === undefined || mutating || saving || formatting || creating}
            onClick={() => { startRename(contextMenu.entry) }}
          >
            <IconEditOutline16 size={13} />
            Rename
          </button>
          <button
            type="button"
            className={css.contextMenuItem}
            role="menuitem"
            disabled={api?.delete === undefined || mutating || saving || formatting || creating}
            onClick={() => { void handleDelete(contextMenu.entry) }}
          >
            <IconTrashOutline16 size={13} />
            Delete
          </button>
          <div className={css.contextMenuSeparator} />
          <button
            type="button"
            className={css.contextMenuItem}
            role="menuitem"
            onClick={() => { void handleCopyPath(contextMenu.entry.path) }}
          >
            <IconCopyOutline16 size={13} />
            Copy Path
          </button>
          <button
            type="button"
            className={css.contextMenuItem}
            role="menuitem"
            onClick={() => { void handleCopyPath(contextMenu.entry.path, true) }}
          >
            <IconCopyOutline16 size={13} />
            Copy Relative Path
          </button>
          {api?.reveal !== undefined && (
            <button
              type="button"
              className={css.contextMenuItem}
              role="menuitem"
              onClick={() => { void handleReveal(contextMenu.entry.path) }}
            >
              <IconBrowseOutline16 size={13} />
              Reveal in Explorer
            </button>
          )}
        </div>
      )}
    </div>
  )
}

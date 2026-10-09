'use strict'

const { once } = require('node:events')
const { spawn } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const { existsSync } = require('node:fs')
const { glob, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { basename, dirname, isAbsolute, join, relative, resolve, sep } = require('node:path')
const { createInterface } = require('node:readline')
const { setTimeout: delay } = require('node:timers/promises')
const { stripVTControlCharacters } = require('node:util')
const { app, BrowserWindow, dialog, ipcMain, nativeImage, nativeTheme, shell, utilityProcess } = require('electron')
const nodePty = require('node-pty')

const CLI_ENTRY = process.env.HYDRA_DESKTOP_CLI_ENTRY || join(require.resolve('@hydraharness/harness/package.json'), '..', 'lib', 'bin.js')
const BROWSER_ENTRY = join(require.resolve('@hydraharness/harness-browser-electron/package.json'), '..', 'electron-app', 'main.cjs')
const DESKTOP_ICON = join(__dirname, 'assets', process.platform === 'win32' ? 'hydra.ico' : 'hydra.png')
const SMOKE_ZOOM = process.argv.includes('--smoke-zoom')
const SMOKE = process.argv.includes('--smoke') || SMOKE_ZOOM
const HOST_READY_TIMEOUT_MS = 90_000
const HOST_REQUEST_TIMEOUT_MS = 15_000
const HOST_SHUTDOWN_TIMEOUT_MS = 7_000
const MAX_EDITABLE_FILE_BYTES = 1_000_000
const HOST_URL = /^hydra web: (http:\/\/127\.0\.0\.1:\d+)$/u
const CHROME_EXECUTE_ACTIONS = new Set([
  'undo', 'redo', 'cut', 'copy', 'paste', 'delete', 'selectAll',
  'zoomIn', 'zoomOut', 'resetZoom', 'fullscreen', 'close', 'quit',
])
const CHROME_DISPATCH_ACTIONS = new Set([
  'new-chat', 'open-folder', 'settings', 'sidebar', 'bottom-panel', 'terminal', 'browser',
  'back', 'forward', 'shortcuts',
])
const TITLEBAR_OVERLAY_SUPPORTED = process.platform === 'win32' || process.platform === 'linux'
const TITLEBAR_HEIGHT = 36
const TITLEBAR_OVERLAY_TRANSPARENT = 'rgba(0,0,0,0)'

app.setName('Hydra harness')
app.setPath('userData', join(process.env.HYDRA_HOME || join(app.getPath('home'), '.hydra'), 'desktop-electron'))

let mainWindow
let host
let hostBaseUrl
let smokeWorkspace
let browser
let browserConnection
let browserBounds = { x: 0, y: 0, width: 0, height: 0, visible: false, present: true }
const terminals = new Map()
const terminalTails = new Map()
const fileSaveTails = new Map()

function panelShortcut(input) {
  if (input.type !== 'keyDown' || !input.control || input.meta) return undefined
  if (input.shift) return !input.alt && input.key.toLowerCase() === 'b' ? 'browser' : undefined
  if (input.alt) return input.key.toLowerCase() === 's' ? 'side-chat' : undefined
  if (input.key.toLowerCase() === 'p') return 'files'
  if (input.key.toLowerCase() === 't') return 'browser'
  if (input.key === '`' || input.code === 'Backquote') return 'terminal'
  return undefined
}

function zoomShortcut(input) {
  if (input.type !== 'keyDown' || !input.control || input.alt || input.meta) return undefined
  if (input.key === '+' || input.key === '=') return 1
  if (!input.shift && input.key === '-') return -1
  if (!input.shift && input.key === '0') return 0
  return undefined
}

/** Applies one zoom step; zero restores the application's actual size. */
function applyZoom(contents, step) {
  contents.setZoomLevel(step === 0 ? 0 : contents.getZoomLevel() + step)
}

app.on('web-contents-created', (_event, contents) => {
  contents.on('before-input-event', (event, input) => {
    if (mainWindow === undefined || mainWindow.isDestroyed() || contents !== mainWindow.webContents) return
    const zoom = zoomShortcut(input)
    if (zoom !== undefined) {
      event.preventDefault()
      applyZoom(contents, zoom)
      return
    }
    const shortcut = panelShortcut(input)
    if (shortcut === undefined) return
    event.preventDefault()
    mainWindow.webContents.send('hydra-desktop:panel-shortcut', shortcut)
  })
})
let shuttingDown
let hostExited = false
let hostExitCode

function postBrowser(connectionId, type, payload = {}) {
  if (host === undefined || hostExited) return
  host.postMessage({ type, connectionId, ...payload })
}

function parseBrowserLine(line) {
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}

async function handleBrowserMessage(message) {
  if (typeof message !== 'object' || message === null || !('type' in message)) return
  if (message.type === 'hydra-browser-connect') {
    if (typeof message.connectionId !== 'string') return
    const previous = browserConnection
    browserConnection = message.connectionId
    await browser.cancelRequests()
    if (previous !== undefined && previous !== message.connectionId) postBrowser(previous, 'hydra-browser-close')
    if (browserConnection !== message.connectionId) return
    const settings = typeof message.settings === 'object' && message.settings !== null ? message.settings : {}
    try {
      await browser.command('configure_browser', settings)
    } catch (error) {
      postBrowser(message.connectionId, 'hydra-browser-error', { error: String(error) })
      postBrowser(message.connectionId, 'hydra-browser-close')
      browserConnection = undefined
      return
    }
    const homeUrl = typeof message.settings === 'object' && message.settings !== null
      && 'homeUrl' in message.settings && typeof message.settings.homeUrl === 'string'
      ? message.settings.homeUrl
      : undefined
    if (homeUrl !== undefined) {
      try { await browser.command('navigate', { url: homeUrl }) } catch {}
    }
    postBrowser(message.connectionId, 'hydra-browser-line', { line: JSON.stringify({ event: 'ready' }) })
    return
  }
  if (message.type === 'hydra-browser-disconnect') {
    if (message.connectionId === browserConnection) {
      browserConnection = undefined
      await browser.cancelRequests()
    }
    return
  }
  if (message.type !== 'hydra-browser-line' || message.connectionId !== browserConnection || typeof message.line !== 'string') return
  const request = parseBrowserLine(message.line)
  if (request === undefined) return
  const reply = await browser.request(request)
  if (reply !== undefined) {
    postBrowser(message.connectionId, 'hydra-browser-line', { line: JSON.stringify(reply) })
  }
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    show: false,
    autoHideMenuBar: true,
    ...(TITLEBAR_OVERLAY_SUPPORTED ? {
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: TITLEBAR_OVERLAY_TRANSPARENT, symbolColor: '#c7ccd4', height: TITLEBAR_HEIGHT },
    } : {}),
    backgroundColor: '#111315',
    title: 'Hydra harness',
    icon: DESKTOP_ICON,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    void routeAppUrl(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    const current = window.webContents.getURL()
    if (current === '' || current === 'about:blank') return
    try {
      if (new URL(current).origin === new URL(url).origin) return
    } catch {}
    event.preventDefault()
    void routeAppUrl(url)
  })
  window.on('page-title-updated', event => { event.preventDefault() })
  return window
}

async function routeAppUrl(url) {
  if (shuttingDown !== undefined || browser === undefined) return
  try {
    await browser.command('route_user_url', { url })
  } catch (error) {
    process.stderr.write(`desktop: URL routing failed: ${String(error)}\n`)
  }
}

function installBrowserController(window) {
  const registered = Promise.withResolvers()
  globalThis.__HYDRA_BROWSER_EMBED__ = {
    window,
    config: {
      persistSessionCookies: true,
      readinessTimeoutMs: 45_000,
      experimentalScriptExecution: true,
    },
    send(message) {
      if (browserConnection !== undefined) {
        postBrowser(browserConnection, 'hydra-browser-line', { line: JSON.stringify(message) })
      } else if (message.event === 'browser:permission') {
        void browser.request({ method: 'browser_permission_response', args: { id: message.id } })
      }
    },
    onState(state) {
      void state
    },
    onAnnotation(annotation) {
      if (!window.isDestroyed()) window.webContents.send('hydra-desktop:browser-annotation', annotation)
    },
    openBrowser() {
      if (!window.isDestroyed()) window.webContents.send('hydra-desktop:panel-shortcut', 'browser')
    },
    closeBrowser() {
      if (!window.isDestroyed()) window.webContents.send('hydra-desktop:panel-close', 'browser')
    },
    register(controller) { registered.resolve(controller) },
  }
  require(BROWSER_ENTRY)
  return registered.promise
}

function startHost() {
  if (!existsSync(CLI_ENTRY)) {
    throw new Error('Desktop Host is not built. Run `pnpm run build` first.')
  }
  const hostEnv = { ...process.env, HYDRA_DESKTOP_BROWSER_BRIDGE: 'parent-port' }
  delete hostEnv.ELECTRON_RUN_AS_NODE
  const child = utilityProcess.fork(CLI_ENTRY, [
    'web', '--no-open', '--host', '127.0.0.1', '--port', '0',
  ], {
    cwd: process.cwd(),
    env: hostEnv,
    // Electron's Node ABI cannot use the system-Node native helper that exposes
    // the Loader internals. The built-in flag gives profile-relative plugin
    // resolution the same hook without loading that addon.
    execArgv: ['--expose-internals'],
    serviceName: 'Hydra harness Host',
    stdio: 'pipe',
  })
  host = child
  child.on('message', message => { void handleBrowserMessage(message) })
  child.on('exit', (code) => {
    hostExited = true
    hostExitCode = code
  })
  child.stderr?.on('data', chunk => { process.stderr.write(chunk) })

  const ready = Promise.withResolvers()
  const lines = createInterface({ input: child.stdout })
  lines.on('line', line => {
    process.stdout.write(`${line}\n`)
    const match = HOST_URL.exec(line.trim())
    if (match?.[1] !== undefined) ready.resolve(match[1])
  })
  child.once('exit', (code) => {
    ready.reject(new Error(`Hydra harness Host exited before readiness (code ${String(code)})`))
  })
  const timeout = setTimeout(() => {
    ready.reject(new Error(`Hydra harness Host did not become ready within ${HOST_READY_TIMEOUT_MS}ms`))
  }, HOST_READY_TIMEOUT_MS)
  return ready.promise.finally(() => { clearTimeout(timeout) })
}

function validSender(event) {
  return mainWindow !== undefined && event.sender === mainWindow.webContents
}

function overlayColor(value) {
  if (typeof value !== 'string' || value.length > 128) return undefined
  if (/^#[\da-f]{3,8}$/iu.test(value) || /^rgba?\([^\r\n()]+\)$/u.test(value)) return value
  return undefined
}

function terminalSize(value) {
  if (typeof value !== 'object' || value === null) return undefined
  const cols = Number(value.cols)
  const rows = Number(value.rows)
  if (!Number.isInteger(cols) || cols < 2 || cols > 500) return undefined
  if (!Number.isInteger(rows) || rows < 1 || rows > 200) return undefined
  return { cols, rows }
}

function sendTerminalEvent(terminalId, value) {
  if (mainWindow === undefined || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('hydra-desktop:terminal-event', { terminalId, event: value })
}

function terminalId(value) {
  if (value === 'bottom' || value === 'right') return value
  if (typeof value !== 'string') return undefined
  const match = /^(?:right|bottom|term)(?:-[1-9]\d{0,15})+$/.exec(value)
  if (match === null) return undefined
  const parts = value.split('-').slice(1)
  return parts.every(part => Number.isSafeInteger(Number(part))) ? value : undefined
}

/** Serialize each PTY's start and stop so closing during startup cannot orphan its process. */
async function queueTerminal(id, operation) {
  const previous = terminalTails.get(id) ?? Promise.resolve()
  const current = previous.catch(() => {}).then(operation)
  terminalTails.set(id, current)
  try {
    return await current
  } finally {
    if (terminalTails.get(id) === current) terminalTails.delete(id)
  }
}

function releaseTerminal(id, instance) {
  const record = terminals.get(id)
  if (record?.instance !== instance) return
  terminals.delete(id)
  for (const subscription of record.subscriptions) subscription.dispose()
}

async function startTerminal(id, size, workspaceId) {
  const current = terminals.get(id)
  if (current !== undefined) {
    if (current.workspaceId !== workspaceId) throw new Error('terminal belongs to another workspace')
    try { current.instance.resize(size.cols, size.rows) } catch {}
    return { running: true }
  }
  const cwd = workspaceId === undefined ? process.cwd() : await registeredWorkspaceRoot(workspaceId)
  const { scrubbedParentEnv } = await import('@hydraharness/harness-subprocess')
  const env = scrubbedParentEnv()
  let shell = env.SHELL ?? '/bin/sh'
  let shellName = shell.split('/').pop() || 'sh'
  if (process.platform === 'win32') {
    const pwsh7 = join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe')
    if (existsSync(pwsh7)) {
      shell = pwsh7
      shellName = 'pwsh.exe'
    } else {
      shell = 'powershell.exe'
      shellName = 'powershell.exe'
    }
  }
  const args = process.platform === 'win32' ? ['-NoLogo', '-NoProfile', '-NoExit'] : ['-i']
  const instance = nodePty.spawn(shell, args, {
    name: 'xterm-256color',
    cols: size.cols,
    rows: size.rows,
    cwd,
    env,
  })
  const record = { instance, subscriptions: [], output: '', shellName, workspaceId }
  terminals.set(id, record)
  const data = instance.onData((value) => {
    record.output = (record.output + value).slice(-200_000)
    sendTerminalEvent(id, { type: 'data', data: value })
  })
  const exited = instance.onExit(({ exitCode }) => {
    releaseTerminal(id, instance)
    sendTerminalEvent(id, { type: 'exit', code: exitCode })
  })
  record.subscriptions = [data, exited]
  return { running: true }
}

async function stopTerminal(id) {
  const record = terminals.get(id)
  if (record === undefined) return
  const { instance } = record
  const exited = Promise.withResolvers()
  const wait = instance.onExit(() => { exited.resolve() })
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const killer = spawn('taskkill.exe', ['/pid', String(instance.pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true,
      })
      killer.once('error', resolve)
      killer.once('exit', resolve)
    })
  } else {
    try { instance.kill() } catch {}
  }
  try {
    await Promise.race([exited.promise, delay(2_000)])
    if (terminals.get(id)?.instance === instance) {
      instance.kill()
      await Promise.race([exited.promise, delay(2_000)])
      if (terminals.get(id)?.instance === instance) throw new Error(`Terminal ${id} did not exit`)
    }
  } finally {
    wait.dispose()
  }
}

async function hostRequest(method, payload = {}) {
  if (hostBaseUrl === undefined) throw new Error('Host is unavailable')
  const rpcId = randomUUID()
  const response = await fetch(new URL(`/api/${method}`, hostBaseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
    signal: AbortSignal.timeout(HOST_REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`${method} failed: HTTP ${response.status}`)
  const message = await response.json()
  const result = message?.result
  if (message?.rpcId !== rpcId || typeof result?.ok !== 'boolean') {
    throw new Error(`${method} returned an invalid response`)
  }
  if (!result.ok) throw new Error(`${method} failed: ${result.error?.message ?? 'unknown error'}`)
  return result.value
}

async function registeredWorkspaceRoot(workspaceId) {
  if (typeof workspaceId !== 'string' || workspaceId === '') throw new Error('workspace is unavailable')
  const value = await hostRequest('workspace.list')
  if (!Array.isArray(value?.items)) throw new Error('workspace.list returned an invalid response')
  const workspace = value.items.find(item => item?.workspaceId === workspaceId)
  if (typeof workspace?.path !== 'string') throw new Error('workspace is not registered')
  const root = await realpath(workspace.path)
  if (!(await stat(root)).isDirectory()) throw new Error('workspace path is invalid')
  return root
}

async function confinedPath(root, target = root) {
  if (typeof root !== 'string' || !isAbsolute(root)
    || typeof target !== 'string' || !isAbsolute(target)) {
    throw new Error('workspace path is invalid')
  }
  const base = await realpath(root)
  if (!(await stat(base)).isDirectory()) throw new Error('workspace path is invalid')
  const candidate = await realpath(target)
  const inside = relative(base, candidate)
  if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new Error('path is outside the workspace')
  }
  return candidate
}

async function listFiles(root, target = root) {
  const path = await confinedPath(root, target)
  const entries = await readdir(path, { withFileTypes: true })
  return entries
    .filter(entry => !entry.isSymbolicLink())
    .map(entry => ({ name: entry.name, path: join(path, entry.name), directory: entry.isDirectory() }))
    .sort((left, right) => Number(right.directory) - Number(left.directory) || left.name.localeCompare(right.name))
}

async function searchFiles(root, query) {
  if (typeof query !== 'string' || query.length > 256) throw new Error('file search is invalid')
  const needle = query.trim().toLocaleLowerCase().replaceAll('\\', '/')
  if (needle === '') return []
  const base = await confinedPath(root)
  const matches = []
  // Substring search stops at 200 hits; add an index only if large workspaces need ranked results.
  for await (const entry of glob('**/*', {
    cwd: base,
    exclude: entry => entry.isSymbolicLink() || entry.name === '.git' || entry.name === 'node_modules',
    withFileTypes: true,
  })) {
    if (!entry.isFile()) continue
    const candidate = join(entry.parentPath, entry.name)
    const name = relative(base, candidate).split(sep).join('/')
    if (!name.toLocaleLowerCase().includes(needle)) continue
    let path
    try { path = await confinedPath(base, candidate) } catch { continue }
    matches.push({ name, path, directory: false })
    if (matches.length === 200) break
  }
  return matches.sort((left, right) => left.name.localeCompare(right.name))
}

function fileVersion(metadata) {
  return `${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeNs}:${metadata.ctimeNs}`
}

function normalizeNewlines(content) {
  return content.replaceAll('\r\n', '\n').replaceAll('\r', '\n')
}

function lineEndingOf(content) {
  let crlf = 0
  let lf = 0
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] !== '\n') continue
    if (content[index - 1] === '\r') crlf += 1
    else lf += 1
  }
  return crlf > lf ? 'CRLF' : 'LF'
}

async function readWorkspaceText(root, target) {
  const path = await confinedPath(root, target)
  const handle = await open(path, 'r')
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile()) throw new Error('path is not a file')
    if (before.size > BigInt(MAX_EDITABLE_FILE_BYTES)) throw new Error('file is larger than 1 MB')
    const capacity = Math.max(1, Number(before.size) + 1)
    const buffer = Buffer.allocUnsafe(capacity)
    let length = 0
    while (length < capacity) {
      const chunk = await handle.read(buffer, length, capacity - length, null)
      if (chunk.bytesRead === 0) break
      length += chunk.bytesRead
    }
    const after = await handle.stat({ bigint: true })
    if (fileVersion(before) !== fileVersion(after)) throw new Error('file changed while it was being read')
    if (length > MAX_EDITABLE_FILE_BYTES) throw new Error('file is larger than 1 MB')
    const bytes = buffer.subarray(0, length)
    if (bytes.includes(0)) throw new Error('binary files are not editable')
    const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bom ? bytes.subarray(3) : bytes)
    return {
      path,
      content: normalizeNewlines(decoded),
      version: fileVersion(after),
      mode: Number(after.mode & 0o777n),
      lineEnding: lineEndingOf(decoded),
      bom,
    }
  } finally {
    await handle.close()
  }
}

async function readWorkspaceFile(root, target) {
  const { path, content, version } = await readWorkspaceText(root, target)
  return { path, content, version }
}

function validateEntryName(name) {
  if (typeof name !== 'string' || name === '' || name !== name.trim()
    || name === '.' || name === '..' || /[\\/:*?"<>|\0]/u.test(name)) {
    throw new Error('file name is invalid')
  }
}

async function createWorkspaceEntry(root, parentTarget, name, kind) {
  validateEntryName(name)
  if (kind !== 'file' && kind !== 'directory') throw new Error('file kind is invalid')
  const parent = await confinedPath(root, parentTarget)
  if (!(await stat(parent)).isDirectory()) throw new Error('parent path is not a directory')
  const target = join(parent, name)
  if (kind === 'directory') {
    await mkdir(target)
  } else {
    const handle = await open(target, 'wx')
    await handle.close()
  }
  const path = await confinedPath(root, target)
  return { name, path, directory: kind === 'directory' }
}

async function renameWorkspaceEntry(root, target, newName) {
  validateEntryName(newName)
  const currentPath = await confinedPath(root, target)
  const rootCanonical = await realpath(root)
  if (currentPath === rootCanonical) throw new Error('cannot rename workspace root')
  const parent = dirname(currentPath)
  const destination = join(parent, newName)
  const targetStat = await stat(currentPath)
  if (existsSync(destination)) throw new Error('a file or folder with this name already exists')
  await rename(currentPath, destination)
  const newConfined = await confinedPath(root, destination)
  return { oldPath: currentPath, path: newConfined, name: newName, directory: targetStat.isDirectory() }
}

async function moveWorkspaceEntry(root, target, destinationTarget) {
  const currentPath = await confinedPath(root, target)
  const destinationDirectory = await confinedPath(root, destinationTarget)
  const rootCanonical = await realpath(root)
  if (currentPath === rootCanonical) throw new Error('cannot move workspace root')
  if (!(await stat(destinationDirectory)).isDirectory()) throw new Error('destination path is not a directory')
  const targetStat = await stat(currentPath)
  if (targetStat.isDirectory() && (destinationDirectory === currentPath
    || destinationDirectory.startsWith(`${currentPath}${sep}`))) {
    throw new Error('cannot move a folder into itself')
  }
  const destination = join(destinationDirectory, basename(currentPath))
  if (existsSync(destination)) throw new Error('a file or folder with this name already exists')
  await rename(currentPath, destination)
  const newConfined = await confinedPath(root, destination)
  return { oldPath: currentPath, path: newConfined, name: basename(newConfined), directory: targetStat.isDirectory() }
}

async function deleteWorkspaceEntry(root, target) {
  const currentPath = await confinedPath(root, target)
  const rootCanonical = await realpath(root)
  if (currentPath === rootCanonical) throw new Error('cannot delete workspace root')
  await rm(currentPath, { recursive: true, force: true })
  return { path: currentPath }
}

async function revealWorkspaceEntry(root, target) {
  const currentPath = await confinedPath(root, target)
  shell.showItemInFolder(currentPath)
  return true
}

async function serializeFileSave(path, operation) {
  const previous = fileSaveTails.get(path) ?? Promise.resolve()
  const current = previous.catch(() => {}).then(operation)
  fileSaveTails.set(path, current)
  try {
    return await current
  } finally {
    if (fileSaveTails.get(path) === current) fileSaveTails.delete(path)
  }
}

async function saveWorkspaceFile(root, target, content, expectedVersion) {
  if (typeof content !== 'string' || content.includes('\0')
    || Buffer.byteLength(content, 'utf8') > MAX_EDITABLE_FILE_BYTES
    || typeof expectedVersion !== 'string' || expectedVersion === '' || expectedVersion.length > 256) {
    throw new Error('file save is invalid')
  }
  const path = await confinedPath(root, target)
  return await serializeFileSave(path, async () => {
    const current = await readWorkspaceText(root, path)
    if (current.version !== expectedVersion) throw new Error('file changed since it was opened')
    const normalized = normalizeNewlines(content)
    const body = current.lineEnding === 'CRLF' ? normalized.replaceAll('\n', '\r\n') : normalized
    const output = current.bom ? `\ufeff${body}` : body
    if (Buffer.byteLength(output, 'utf8') > MAX_EDITABLE_FILE_BYTES) throw new Error('file is larger than 1 MB')
    const { writeFileAtomic } = await import('@hydraharness/harness-atomic-write')
    const publicationPath = await confinedPath(root, current.path)
    await writeFileAtomic(publicationPath, output, { mode: current.mode })
    const saved = await readWorkspaceText(root, publicationPath)
    if (saved.content !== normalized) throw new Error('file changed immediately after it was saved')
    return { path: saved.path, version: saved.version }
  })
}

async function formatWorkspaceFile(root, target, content) {
  if (typeof content !== 'string' || content.includes('\0')
    || Buffer.byteLength(content, 'utf8') > MAX_EDITABLE_FILE_BYTES) {
    throw new Error('file format is invalid')
  }
  const { path } = await readWorkspaceText(root, target)
  const { format } = await import('prettier')
  const formatted = normalizeNewlines(await format(content, { filepath: path }))
  if (formatted.includes('\0') || Buffer.byteLength(formatted, 'utf8') > MAX_EDITABLE_FILE_BYTES) {
    throw new Error('formatted file is larger than 1 MB')
  }
  return formatted
}

function installRendererIpc() {
  ipcMain.handle('hydra-desktop:open-external', async (event, value) => {
    if (shuttingDown !== undefined || !validSender(event)) throw new Error('desktop is unavailable')
    if (typeof value?.url !== 'string' || value.url.length > 2_048) throw new Error('external URL is invalid')
    let url
    try { url = new URL(value.url) } catch { throw new Error('external URL is invalid') }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('external URL is invalid')
    url.username = ''
    url.password = ''
    await shell.openExternal(url.href)
  })

  ipcMain.handle('hydra-desktop:open-session-window', async (event, value) => {
    if (shuttingDown !== undefined || !validSender(event) || typeof value?.sessionId !== 'string'
      || value.sessionId.length === 0 || value.sessionId.length > 256 || value.sessionId.includes('\0')) {
      throw new Error('invalid session window request')
    }
    const url = new URL(hostBaseUrl)
    url.searchParams.set('session', value.sessionId)
    const child = new BrowserWindow({
      width: 1200, height: 800, minWidth: 800, minHeight: 600,
      show: !SMOKE,
      title: 'Hydra harness', icon: DESKTOP_ICON,
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
    })
    child.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    child.webContents.on('will-navigate', (navigation, target) => {
      if (new URL(target).origin !== url.origin) navigation.preventDefault()
    })
    try { await child.loadURL(url.href) } catch (error) { child.destroy(); throw error }
  })
  ipcMain.handle('hydra-desktop:chrome-action', async (event, value) => {
    if (shuttingDown !== undefined || !validSender(event)) throw new Error('desktop is unavailable')
    if (typeof value !== 'string') throw new Error('desktop action is invalid')
    const nativeAction = {
      undo: 'undo',
      redo: 'redo',
      cut: 'cut',
      copy: 'copy',
      paste: 'paste',
      delete: 'delete',
      'select-all': 'selectAll',
      'zoom-in': 'zoomIn',
      'zoom-out': 'zoomOut',
      'reset-zoom': 'resetZoom',
      'toggle-fullscreen': 'fullscreen',
      close: 'close',
      quit: 'quit',
    }[value]
    if (nativeAction !== undefined && CHROME_EXECUTE_ACTIONS.has(nativeAction)) {
      if (nativeAction === 'undo' || nativeAction === 'redo' || nativeAction === 'cut' || nativeAction === 'copy'
        || nativeAction === 'paste' || nativeAction === 'delete' || nativeAction === 'selectAll') {
        mainWindow.webContents[nativeAction]()
      }
      else if (nativeAction === 'zoomIn') applyZoom(mainWindow.webContents, 1)
      else if (nativeAction === 'zoomOut') applyZoom(mainWindow.webContents, -1)
      else if (nativeAction === 'resetZoom') applyZoom(mainWindow.webContents, 0)
      else if (nativeAction === 'fullscreen') mainWindow.setFullScreen(!mainWindow.isFullScreen())
      else if (nativeAction === 'close') mainWindow.close()
      else if (nativeAction === 'quit') app.quit()
      return
    }
    const dispatchAction = {
      'new-chat': 'new-chat',
      'open-folder': 'open-folder',
      settings: 'settings',
      'toggle-sidebar': 'sidebar',
      'toggle-bottom-panel': 'bottom-panel',
      'open-terminal': 'terminal',
      'open-browser': 'browser',
      back: 'back',
      forward: 'forward',
      'keyboard-shortcuts': 'shortcuts',
    }[value]
    if (dispatchAction !== undefined && CHROME_DISPATCH_ACTIONS.has(dispatchAction)) {
      mainWindow.webContents.send('hydra-desktop:chrome-dispatch', dispatchAction)
      return
    }
    throw new Error('desktop action is unavailable')
  })
  ipcMain.on('hydra-desktop:chrome-theme', (event, value) => {
    if (shuttingDown !== undefined || !validSender(event) || !TITLEBAR_OVERLAY_SUPPORTED) return
    if (value === null) {
      mainWindow.setTitleBarOverlay({ color: TITLEBAR_OVERLAY_TRANSPARENT, symbolColor: '#c7ccd4', height: TITLEBAR_HEIGHT })
      return
    }
    if (typeof value !== 'object' || value === null) return
    const color = overlayColor(value.color)
    const symbolColor = overlayColor(value.symbolColor)
    if (color === undefined || symbolColor === undefined) return
    mainWindow.setTitleBarOverlay({ color, symbolColor, height: TITLEBAR_HEIGHT })
  })
  const browserOperation = async (event, method, args = {}) => {
    if (shuttingDown !== undefined || !validSender(event)) throw new Error('browser management is unavailable')
    return await browser.command(method, args)
  }
  ipcMain.on('hydra-desktop:browser-bounds', (event, value) => {
    if (shuttingDown !== undefined || !validSender(event) || typeof value !== 'object' || value === null) return
    const [windowWidth, windowHeight] = mainWindow.getContentSize()
    const zoom = mainWindow.webContents.getZoomFactor()
    const dip = input => Math.round((Number(input) || 0) * zoom)
    const x = Math.min(windowWidth, Math.max(0, dip(value.x)))
    const y = Math.min(windowHeight, Math.max(0, dip(value.y)))
    browserBounds = {
      x,
      y,
      width: Math.min(windowWidth - x, Math.max(0, dip(value.width))),
      height: Math.min(windowHeight - y, Math.max(0, dip(value.height))),
      visible: value.visible === true,
      present: value.present !== false,
    }
    browser.setBounds(browserBounds)
  })
  ipcMain.handle('hydra-desktop:browser-configure', (event, value) =>
    browserOperation(event, 'configure_browser', value))
  ipcMain.on('hydra-desktop:browser-theme', (event, value) => {
    if (shuttingDown !== undefined || !validSender(event)) return
    try { browser.setTheme(value) } catch (error) {
      process.stderr.write(`desktop: Browser theme rejected: ${String(error)}\n`)
    }
  })
  ipcMain.handle('hydra-desktop:browser-confirm-full-cdp', async (event) => {
    if (shuttingDown !== undefined || !validSender(event)) return false
    const choice = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: 'Enable full CDP access?',
      message: 'Full Chrome DevTools Protocol access has elevated risk.',
      detail: 'It can inspect and control sensitive browser internals. Every CDP command will still require separate approval.',
      buttons: ['Enable', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    })
    return choice.response === 0
  })
  ipcMain.handle('hydra-desktop:browser-clear-data', (event, value) =>
    browserOperation(event, 'clear_browser_data', value))
  ipcMain.handle('hydra-desktop:browser-open-url', (event, value) =>
    browserOperation(event, 'route_user_url', value))
  ipcMain.handle('hydra-desktop:browser-history', event =>
    browserOperation(event, 'browser_history'))
  ipcMain.handle('hydra-desktop:browser-remove-history', (event, value) =>
    browserOperation(event, 'remove_browser_history', value))
  ipcMain.handle('hydra-desktop:browser-downloads', event =>
    browserOperation(event, 'browser_downloads'))
  ipcMain.handle('hydra-desktop:browser-remove-download', (event, value) =>
    browserOperation(event, 'remove_browser_download', value))
  ipcMain.handle('hydra-desktop:browser-open-download', (event, value) =>
    browserOperation(event, 'open_browser_download', value))
  ipcMain.handle('hydra-desktop:browser-sites', event =>
    browserOperation(event, 'browser_sites'))
  ipcMain.handle('hydra-desktop:browser-set-site', (event, value) =>
    browserOperation(event, 'set_browser_site', value))
  ipcMain.handle('hydra-desktop:browser-remove-site', (event, value) =>
    browserOperation(event, 'remove_browser_site', value))
  ipcMain.handle('hydra-desktop:browser-autofill-status', event =>
    browserOperation(event, 'autofill_status'))
  ipcMain.handle('hydra-desktop:browser-autofill-list-logins', event =>
    browserOperation(event, 'autofill_list_logins'))
  ipcMain.handle('hydra-desktop:browser-autofill-save-login', (event, value) =>
    browserOperation(event, 'autofill_save_login', value))
  ipcMain.handle('hydra-desktop:browser-autofill-remove-login', (event, value) =>
    browserOperation(event, 'autofill_remove_login', value))
  ipcMain.handle('hydra-desktop:browser-autofill-list-contacts', event =>
    browserOperation(event, 'autofill_list_contacts'))
  ipcMain.handle('hydra-desktop:browser-autofill-get-contact', (event, value) =>
    browserOperation(event, 'autofill_get_contact', value))
  ipcMain.handle('hydra-desktop:browser-autofill-save-contact', (event, value) =>
    browserOperation(event, 'autofill_save_contact', value))
  ipcMain.handle('hydra-desktop:browser-autofill-remove-contact', (event, value) =>
    browserOperation(event, 'autofill_remove_contact', value))
  ipcMain.handle('hydra-desktop:terminal-start', async (event, value) => {
    if (shuttingDown !== undefined || !validSender(event)) throw new Error('terminal is unavailable')
    const id = terminalId(value?.terminalId)
    const size = terminalSize(value?.size)
    if (id === undefined || size === undefined) throw new Error('terminal request is invalid')
    return await queueTerminal(id, () => startTerminal(id, size, value?.workspaceId))
  })
  ipcMain.handle('hydra-desktop:terminal-stop', async (event, value) => {
    if (shuttingDown !== undefined || !validSender(event)) throw new Error('terminal is unavailable')
    const id = terminalId(value?.terminalId)
    if (id === undefined) throw new Error('terminal request is invalid')
    await queueTerminal(id, () => stopTerminal(id))
  })
  ipcMain.on('hydra-desktop:terminal-write', (event, value) => {
    const id = terminalId(value?.terminalId)
    if (shuttingDown !== undefined || !validSender(event) || id === undefined
      || typeof value?.data !== 'string' || value.data.length > 65_536) return
    try { terminals.get(id)?.instance.write(value.data) } catch {}
  })
  ipcMain.on('hydra-desktop:terminal-resize', (event, value) => {
    if (shuttingDown !== undefined || !validSender(event)) return
    const id = terminalId(value?.terminalId)
    const size = terminalSize(value?.size)
    if (id === undefined || size === undefined) return
    try { terminals.get(id)?.instance.resize(size.cols, size.rows) } catch {}
  })
  ipcMain.handle('hydra-desktop:terminal-list', (event) => {
    if (shuttingDown !== undefined || !validSender(event)) return []
    const list = []
    for (const [id, record] of terminals) {
      list.push({
        id,
        pid: record.instance.pid,
        shell: record.shellName || (process.platform === 'win32' ? 'powershell.exe' : 'bash'),
      })
    }
    return list
  })
  ipcMain.on('hydra-desktop:emit-annotation', (event, annotation) => {
    if (shuttingDown !== undefined || !validSender(event)) return
    if (mainWindow !== undefined && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('hydra-desktop:browser-annotation', annotation)
    }
  })
  ipcMain.handle('hydra-desktop:files-root', async (event, value) => {
    if (shuttingDown !== undefined || !validSender(event)) throw new Error('files are unavailable')
    return await registeredWorkspaceRoot(value?.workspaceId)
  })
  ipcMain.handle('hydra-desktop:files-list', async (event, value) => {
    if (shuttingDown !== undefined || !validSender(event)) throw new Error('files are unavailable')
    return await listFiles(await registeredWorkspaceRoot(value?.workspaceId), value?.path)
  })
  ipcMain.handle('hydra-desktop:files-search', async (event, value) => {
    if (shuttingDown !== undefined || !validSender(event)) throw new Error('files are unavailable')
    return await searchFiles(await registeredWorkspaceRoot(value?.workspaceId), value?.query)
  })
  ipcMain.handle('hydra-desktop:files-read', async (event, value) => {
    if (shuttingDown !== undefined || !validSender(event)) throw new Error('files are unavailable')
    return await readWorkspaceFile(await registeredWorkspaceRoot(value?.workspaceId), value?.path)
  })
  ipcMain.handle('hydra-desktop:files-create', async (event, value) => {
    if (shuttingDown !== undefined || !validSender(event)) throw new Error('files are unavailable')
    return await createWorkspaceEntry(
      await registeredWorkspaceRoot(value?.workspaceId),
      value?.parentPath,
      value?.name,
      value?.kind,
    )
  })
  ipcMain.handle('hydra-desktop:files-rename', async (event, value) => {
    if (shuttingDown !== undefined || !validSender(event)) throw new Error('files are unavailable')
    return await renameWorkspaceEntry(
      await registeredWorkspaceRoot(value?.workspaceId),
      value?.path,
      value?.newName,
    )
  })
  ipcMain.handle('hydra-desktop:files-move', async (event, value) => {
    if (shuttingDown !== undefined || !validSender(event)) throw new Error('files are unavailable')
    return await moveWorkspaceEntry(
      await registeredWorkspaceRoot(value?.workspaceId),
      value?.path,
      value?.destinationDirectory,
    )
  })
  ipcMain.handle('hydra-desktop:files-delete', async (event, value) => {
    if (shuttingDown !== undefined || !validSender(event)) throw new Error('files are unavailable')
    return await deleteWorkspaceEntry(
      await registeredWorkspaceRoot(value?.workspaceId),
      value?.path,
    )
  })
  ipcMain.handle('hydra-desktop:files-reveal', async (event, value) => {
    if (shuttingDown !== undefined || !validSender(event)) throw new Error('files are unavailable')
    return await revealWorkspaceEntry(
      await registeredWorkspaceRoot(value?.workspaceId),
      value?.path,
    )
  })
  ipcMain.handle('hydra-desktop:files-save', async (event, value) => {
    if (shuttingDown !== undefined || !validSender(event)) throw new Error('files are unavailable')
    return await saveWorkspaceFile(
      await registeredWorkspaceRoot(value?.workspaceId),
      value?.path,
      value?.content,
      value?.expectedVersion,
    )
  })
  ipcMain.handle('hydra-desktop:files-format', async (event, value) => {
    if (shuttingDown !== undefined || !validSender(event)) throw new Error('files are unavailable')
    return await formatWorkspaceFile(
      await registeredWorkspaceRoot(value?.workspaceId),
      value?.path,
      value?.content,
    )
  })
}

function assertNativeViews(panel) {
  const visible = mainWindow.contentView.children
    .filter(view => view.getVisible())
    .map(view => view.getBounds())
    .sort((left, right) => left.y - right.y)
  const [chrome, page] = visible
  const valid = visible.length === 2
    && chrome.x === panel.x && chrome.y === panel.y && chrome.width === panel.width
    && page.x === panel.x && page.y === chrome.y + chrome.height && page.width === panel.width
    && page.y + page.height === panel.y + panel.height
  if (!valid) {
    throw new Error(`native browser views do not fill the panel: ${JSON.stringify({ panel, visible })}`)
  }
}

async function waitForBounds(label, predicate) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (browserBounds.visible && browserBounds.width > 100 && browserBounds.height > 100 && predicate(browserBounds)) {
      return { ...browserBounds }
    }
    await delay(100)
  }
  throw new Error(`${label} browser view has unusable bounds: ${JSON.stringify(browserBounds)}`)
}

async function waitForHiddenBrowser(label) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const visibleViews = mainWindow.contentView.children.filter(view => view.getVisible())
    if (!browserBounds.visible && visibleViews.length === 0) return
    await delay(100)
  }
  throw new Error(`${label} did not hide native browser views: ${JSON.stringify(browserBounds)}`)
}

async function selectControl(label, scope) {
  const clicked = await mainWindow.webContents.executeJavaScript(`(() => {
    const parent = ${scope === undefined ? 'document' : `document.querySelector(${JSON.stringify(scope)})`}
    const button = parent?.querySelector('[aria-label=${JSON.stringify(label)}]')
    if (!(button instanceof HTMLButtonElement)) return false
    button.click()
    return true
  })()`)
  if (!clicked) throw new Error(`desktop panel control is missing: ${label}`)
}

async function waitForTerminal(id, label, predicate) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const terminal = terminals.get(id)
    if (terminal !== undefined && predicate(terminal)) return
    await delay(100)
  }
  throw new Error(`${label} terminal check failed`)
}

async function waitForRenderer(label, expression) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (await mainWindow.webContents.executeJavaScript(`(async () => Boolean(await (${expression})))()`)) return
    await delay(100)
  }
  throw new Error(`${label} renderer check failed`)
}

async function prepareSmokeWorkspace() {
  const root = await mkdtemp(join(tmpdir(), 'hydra-desktop-smoke-'))
  smokeWorkspace = { root }
  const outside = await mkdtemp(join(tmpdir(), 'hydra-desktop-smoke-outside-'))
  smokeWorkspace = { root, outside }
  await writeFile(join(root, 'package.json'), '{"name":"hydra-desktop-smoke"}\n')
  await writeFile(join(root, 'bom-crlf.txt'), '\ufeffone\r\ntwo\r\n')
  await writeFile(join(outside, 'outside-only.txt'), 'must not be searchable\n')
  await symlink(outside, join(root, 'linked-outside'), process.platform === 'win32' ? 'junction' : 'dir')
  const terminalWorkspaces = []
  smokeWorkspace.terminalWorkspaces = terminalWorkspaces
  for (const name of ['workspace B', 'workspace C']) {
    const path = join(root, name)
    await mkdir(path)
    const created = await hostRequest('workspace.create', { path })
    if (typeof created?.workspace?.workspaceId !== 'string') throw new Error('terminal smoke workspace is unavailable')
    terminalWorkspaces.push({ workspaceId: created.workspace.workspaceId, path: await realpath(path) })
  }
  const value = await hostRequest('workspace.create', { path: root })
  const workspaceId = value?.workspace?.workspaceId
  if (typeof workspaceId !== 'string') throw new Error('desktop smoke Workspace is unavailable')
  if (value?.created !== true) throw new Error('desktop smoke Workspace already exists')
  smokeWorkspace = { root: await realpath(root), outside: await realpath(outside), workspaceId, terminalWorkspaces }
}

async function cleanupSmokeWorkspace() {
  const workspace = smokeWorkspace
  smokeWorkspace = undefined
  if (workspace === undefined) return
  let cleanupError
  for (const workspaceId of [workspace.workspaceId, ...(workspace.terminalWorkspaces ?? []).map(item => item.workspaceId)]) {
    if (workspaceId === undefined) continue
    try { await hostRequest('workspace.delete', { workspaceId }) } catch (error) { cleanupError = error }
  }
  for (const directory of [workspace.root, workspace.outside]) {
    if (directory === undefined) continue
    const parent = resolve(tmpdir())
    const target = resolve(directory)
    const inside = relative(parent, target)
    if (inside.includes(sep) || !inside.startsWith('hydra-desktop-smoke-')) {
      throw new Error(`refusing to remove unexpected smoke path: ${target}`)
    }
    await rm(target, { recursive: true, force: true })
  }
  if (cleanupError !== undefined) throw cleanupError
}

async function smokeZoomShortcuts() {
  const contents = mainWindow.webContents
  contents.setZoomLevel(0)
  const actual = []
  for (const [shortcut, keyCode, modifiers] of [
    ['Ctrl+=', '=', ['control']],
    ['Ctrl+-', '-', ['control']],
    ['Ctrl+Shift+=', '=', ['control', 'shift']],
    ['Ctrl+0', '0', ['control']],
    ['Ctrl+-', '-', ['control']],
    ['Ctrl+0', '0', ['control']],
    ['Ctrl+Alt+=', '=', ['control', 'alt']],
    ['Ctrl+Shift+-', '-', ['control', 'shift']],
  ]) {
    contents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    contents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
    await delay(100)
    actual.push(`${shortcut}: ${Math.round(contents.getZoomFactor() * 100)}%`)
  }
  await selectControl('Toggle right panel')
  await waitForRenderer('Review option', 'document.querySelector(\'[aria-label="Open panel"] [aria-label="Review"]\')')
  await selectControl('Review', '[aria-label="Open panel"]')
  for (const [width, height] of [[1000, 700], [1366, 768], [1440, 900], [1920, 1080]]) {
    mainWindow.setSize(width, height)
    for (const zoom of [0.67, 0.8, 1, 1.25, 1.5, 2]) {
      contents.setZoomFactor(zoom)
      for (const expanded of [false, true]) {
        if (expanded) await selectControl('Expand right panel')
        await waitForRenderer(`titlebar layout at ${width}x${height}, zoom ${zoom}, expanded ${expanded}`, `(() => {
          const bar = document.querySelector('[data-desktop-titlebar]')
          const panel = document.querySelector('[aria-label="Right panel"]')
          const review = panel?.querySelector('[aria-label="Open panel"] [aria-label="Review"]')
          if (!bar || !panel || !review || panel.hidden) return false
          const bounds = bar.getBoundingClientRect()
          const native = navigator.windowControlsOverlay?.getTitlebarAreaRect()
          const left = native?.width > 0 ? native.left : 0
          const right = native?.width > 0 ? native.right : bounds.right
          const bottom = native?.width > 0 ? native.bottom : 0
          if (bounds.bottom + 0.5 < bottom) return false
          const buttons = [...bar.querySelectorAll('button')]
          if (!buttons.every(button => {
            const rect = button.getBoundingClientRect()
            return rect.left >= left && rect.right <= right
              && rect.top >= bounds.top && rect.bottom <= bounds.bottom
          })) return false
          const option = review.getBoundingClientRect()
          const pane = panel.getBoundingClientRect()
          return option.width >= 24 && option.top >= bounds.bottom
            && option.left >= pane.left && option.right <= pane.right
        })()`)
        if (expanded) await selectControl('Expand right panel')
      }
    }
  }
  contents.setZoomLevel(0)
  actual.push('Titlebar and Review: 4 window sizes, 6 zoom levels, normal and expanded panels')
  const transcript = `${actual.join('\n')}\n`
  const expected = await readFile(join(__dirname, 'tests', 'snapshots', 'zoom-shortcuts.expected.md'), 'utf8')
  if (transcript !== expected.replaceAll('\r\n', '\n')) {
    throw new Error(`desktop zoom shortcuts differ from the snapshot:\n${transcript}`)
  }
}

async function smoke() {
  if (nativeImage.createFromPath(DESKTOP_ICON).isEmpty()) throw new Error('desktop Hydra icon is unavailable')
  if (typeof smokeWorkspace?.workspaceId !== 'string') throw new Error('desktop smoke Workspace is unavailable')
  const panelStartsClosed = await mainWindow.webContents.executeJavaScript(`(() => {
    const panel = document.querySelector('[aria-label="Right panel"]')
    return panel instanceof HTMLElement && panel.hidden
  })()`)
  if (!panelStartsClosed) throw new Error('desktop browser panel opens by default')
  const titleBarReady = await mainWindow.webContents.executeJavaScript(`(() => {
    const bar = document.querySelector('[data-desktop-titlebar]')
    return bar instanceof HTMLElement
      && bar.querySelector('[aria-label="Back"]') instanceof HTMLButtonElement
      && bar.querySelector('[aria-label="Forward"]') instanceof HTMLButtonElement
      && [...bar.querySelectorAll('button[aria-haspopup="menu"]')].map(button => button.textContent).join('|') === 'File|Edit|View|Help'
  })()`)
  if (!titleBarReady) throw new Error('desktop title bar controls are unavailable')
  if (mainWindow.getTitle() !== 'Hydra harness') throw new Error(`unexpected desktop title: ${mainWindow.getTitle()}`)
  const externalUrls = []
  const openExternal = shell.openExternal
  shell.openExternal = async url => { externalUrls.push(url) }
  try {
    await mainWindow.webContents.executeJavaScript('window.hydraDesktop.openExternal("https://gemini.google.com/app")')
    if (externalUrls.length !== 1 || externalUrls[0] !== 'https://gemini.google.com/app') {
      throw new Error('Desktop Gemini sign-in did not delegate to the system browser')
    }
    const invalidExternal = await mainWindow.webContents.executeJavaScript(`window.hydraDesktop.openExternal('file:///private')
      .then(() => false, error => error.message.includes('external URL is invalid'))`)
    if (!invalidExternal || externalUrls.length !== 1) throw new Error('Desktop external browser accepted an unsupported URL')
  } finally { shell.openExternal = openExternal }
  const windowSession = await hostRequest('session.create', { workspaceId: smokeWorkspace.workspaceId })
  await mainWindow.webContents.executeJavaScript(`window.hydraDesktop.openSessionWindow(${JSON.stringify(windowSession.sessionId)})`)
  const sessionWindow = BrowserWindow.getAllWindows().find(window => window !== mainWindow)
  if (sessionWindow === undefined) throw new Error('session window did not open')
  const sessionWindowReady = await sessionWindow.webContents.executeJavaScript(`typeof window.hydraDesktop === 'undefined'
    && new URL(location.href).searchParams.get('session') === ${JSON.stringify(windowSession.sessionId)}`)
  if (!sessionWindowReady) throw new Error('session window URL or native isolation is invalid')
  sessionWindow.destroy()
  await hostRequest('session.delete', { sessionId: windowSession.sessionId })
  if (panelShortcut({ type: 'keyDown', control: true, alt: false, meta: false, shift: false, key: 'p' }) !== 'files'
    || panelShortcut({ type: 'keyUp', control: true, alt: false, meta: false, shift: false, key: 'p' }) !== undefined
    || panelShortcut({ type: 'keyDown', control: true, alt: true, meta: false, shift: false, key: 's' }) !== 'side-chat'
    || panelShortcut({ type: 'keyDown', control: true, alt: false, meta: false, shift: true, key: 'b' }) !== 'browser'
    || panelShortcut({ type: 'keyDown', control: true, alt: false, meta: false, shift: false, key: 't' }) !== 'browser'
    || panelShortcut({ type: 'keyDown', control: true, alt: false, meta: false, shift: false, key: '`' }) !== 'terminal') {
    throw new Error('desktop panel shortcut mapping is invalid')
  }
  await selectControl('Toggle right panel')
  const onboardingDeadline = Date.now() + 15_000
  while (!browserBounds.visible && Date.now() < onboardingDeadline) {
    await mainWindow.webContents.executeJavaScript(`(() => {
      const dialog = document.querySelector('[role="dialog"][aria-modal="true"]')
      if (!dialog) return
      const title = dialog.getAttribute('aria-label') ?? document.getElementById(dialog.getAttribute('aria-labelledby'))?.textContent
      const label = title === 'Internal Testing Notice' ? 'Continue' : title === 'Settings' ? 'Close' : undefined
      if (label) [...dialog.querySelectorAll('button')].find(button => button.textContent.trim() === label)?.click()
    })()`)
    await delay(100)
  }
  const right = await waitForBounds('right', bounds => bounds.x > 0 && bounds.width < mainWindow.getContentBounds().width)
  assertNativeViews(right)
  const panelOptions = await mainWindow.webContents.executeJavaScript(`(() =>
    [...document.querySelectorAll('[aria-label="Open panel"] > button')].map(button => ({
      label: button.getAttribute('aria-label'),
      shortcut: button.getAttribute('aria-keyshortcuts'),
    }))
  )()`)
  if (JSON.stringify(panelOptions) !== JSON.stringify([
    { label: 'Files', shortcut: 'Control+P' },
    { label: 'Side chat', shortcut: 'Control+Alt+S' },
    { label: 'Browser', shortcut: 'Control+Shift+B' },
    { label: 'Terminal', shortcut: 'Control+Backquote' },
    { label: 'Review', shortcut: null },
  ])) throw new Error(`panel options contract is invalid: ${JSON.stringify(panelOptions)}`)
  mainWindow.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'P', modifiers: ['control'] })
  mainWindow.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'P', modifiers: ['control'] })
  await waitForHiddenBrowser('Files panel')
  await waitForRenderer('workspace Files panel', `document.querySelector('[data-panel-kind="files"]:not([hidden]) [aria-label="Workspace files"] [role="treeitem"]')`)
  await waitForRenderer('workspace Files filter focus', `document.activeElement?.getAttribute('aria-label') === 'Filter workspace files'`)
  const files = await mainWindow.webContents.executeJavaScript(`(async () => {
    const workspaceId = ${JSON.stringify(smokeWorkspace.workspaceId)}
    const api = window.hydraDesktop?.files
    if (api === undefined) return undefined
    const rejected = promise => promise.then(() => false, () => true)
    const root = document.querySelector('[data-panel-kind="files"]:not([hidden]) [data-files-root]')?.getAttribute('data-files-root')
    const results = await api.search('package.json', workspaceId)
    const match = results?.find(entry => entry.name === 'package.json')
    const preview = match === undefined ? undefined : await api?.read(match.path, workspaceId)
    const linked = await api.search('outside-only', workspaceId)
    const unscopedRejected = await rejected(api.root())
    const escaped = await api.read(${JSON.stringify(resolve(smokeWorkspace.root, '..'))}, workspaceId)
      .then(() => false, error => String(error).includes('outside the workspace'))
    const directory = await api.create(root, 'src', 'directory', workspaceId)
    const created = await api.create(directory.path, 'sample.json', 'file', workspaceId)
    const opened = await api.read(created.path, workspaceId)
    const formatted = await api.format(created.path, '{"b":2,"a":1}', workspaceId)
    await api.save(created.path, formatted, opened.version, workspaceId)
    const formattedRead = await api.read(created.path, workspaceId)
    const duplicateRejected = await rejected(api.create(directory.path, 'sample.json', 'file', workspaceId))
    const invalidNameRejected = await rejected(api.create(root, '../escaped.txt', 'file', workspaceId))
    const outsideParentRejected = await rejected(api.create(
      ${JSON.stringify(smokeWorkspace.outside)}, 'escaped.txt', 'file', workspaceId,
    ))
    const symlinkParentRejected = await rejected(api.create(
      ${JSON.stringify(join(smokeWorkspace.root, 'linked-outside'))}, 'escaped.txt', 'file', workspaceId,
    ))
    const races = await Promise.allSettled([
      api.save(created.path, 'first\\n', formattedRead.version, workspaceId),
      api.save(created.path, 'second\\n', formattedRead.version, workspaceId),
    ])
    const afterRace = await api.read(created.path, workspaceId)
    const staleRejected = await rejected(api.save(created.path, 'stale\\n', formattedRead.version, workspaceId))
    const nulRejected = await rejected(api.save(created.path, 'bad\\0content', afterRace.version, workspaceId))
    const oversizedRejected = await rejected(api.save(created.path, 'é'.repeat(500_001), afterRace.version, workspaceId))
    const afterFailure = await api.read(created.path, workspaceId)
    const bomPath = ${JSON.stringify(join(smokeWorkspace.root, 'bom-crlf.txt'))}
    const bom = await api.read(bomPath, workspaceId)
    await api.save(bomPath, bom.content + 'three\\n', bom.version, workspaceId)
    return {
      root,
      preview: preview?.content,
      previewVersion: preview?.version,
      linked: linked.length,
      unscopedRejected,
      escaped,
      created: created.path,
      formatted: formattedRead.content,
      duplicateRejected,
      invalidNameRejected,
      outsideParentRejected,
      symlinkParentRejected,
      raceWinners: races.filter(result => result.status === 'fulfilled').length,
      raceContent: afterRace.content,
      staleRejected,
      nulRejected,
      oversizedRejected,
      afterFailure: afterFailure.content,
    }
  })()`)
  if (files?.root !== smokeWorkspace.root
    || !String(files?.preview).includes('hydra-desktop-smoke')
    || typeof files?.previewVersion !== 'string'
    || files?.linked !== 0
    || files?.unscopedRejected !== true
    || files?.escaped !== true
    || files?.created !== join(smokeWorkspace.root, 'src', 'sample.json')
    || !String(files?.formatted).includes('"b": 2')
    || files?.duplicateRejected !== true
    || files?.invalidNameRejected !== true
    || files?.outsideParentRejected !== true
    || files?.symlinkParentRejected !== true
    || files?.raceWinners !== 1
    || !['first\n', 'second\n'].includes(files?.raceContent)
    || files?.staleRejected !== true
    || files?.nulRejected !== true
    || files?.oversizedRejected !== true
    || files?.afterFailure !== files?.raceContent) {
    throw new Error(`desktop Files Workspace contract is invalid: ${JSON.stringify(files)}`)
  }
  const bomCrlf = await readFile(join(smokeWorkspace.root, 'bom-crlf.txt'))
  if (!bomCrlf.equals(Buffer.from('\ufeffone\r\ntwo\r\nthree\r\n'))) {
    throw new Error(`desktop Files changed BOM or CRLF bytes: ${JSON.stringify([...bomCrlf])}`)
  }
  await selectControl('Terminal')
  await waitForHiddenBrowser('right Terminal')
  await waitForRenderer('right Terminal panel', `document.querySelector('[aria-label="Right terminal"]:not([hidden])')`)
  await waitForTerminal('right', 'right startup', () => true)
  await selectControl('Toggle bottom terminal')
  const terminalsVisible = await mainWindow.webContents.executeJavaScript(`(() => {
    const bottom = document.querySelector('section[aria-label="Terminal"]')
    const right = document.querySelector('[aria-label="Right terminal"]')
    return bottom instanceof HTMLElement && !bottom.hidden && right instanceof HTMLElement && !right.hidden
  })()`)
  if (!terminalsVisible) throw new Error('right and bottom Terminal panels did not open together')
  await waitForTerminal('bottom-1-1', 'bottom startup', () => true)
  const workspaceTranscript = []
  const assertTerminalCwd = async (id, expected) => {
    const command = process.platform === 'win32'
      ? "Write-Output ('HYDRA_CWD:' + (Get-Location).Path)\r"
      : "printf 'HYDRA_CWD:%s\\n' \"$PWD\"\r"
    await mainWindow.webContents.executeJavaScript(`window.hydraDesktop.terminal.write(${JSON.stringify(id)}, ${JSON.stringify(command)})`)
    await waitForTerminal(id, 'workspace cwd', terminal => terminal.output.includes(`HYDRA_CWD:${expected}`))
    const output = stripVTControlCharacters(terminals.get(id).output)
    const cwd = [...output.matchAll(/HYDRA_CWD:([^\r\n]+)/g)].at(-1)?.[1]
    if (cwd !== expected) throw new Error(`unexpected terminal cwd: ${JSON.stringify(cwd)}`)
    workspaceTranscript.push({ terminal: id, cwd: relative(smokeWorkspace.root, cwd).split(sep).join('/') || '.' })
  }
  await assertTerminalCwd('right', smokeWorkspace.root)
  await assertTerminalCwd('bottom-1-1', smokeWorkspace.root)
  const marker = `HYDRA_TERMINAL_SMOKE_${Date.now()}`
  const rightMarker = `${marker}_RIGHT`
  const bottomMarker = `${marker}_BOTTOM`
  // Shell history predictions must not contain the complete output marker.
  const markerCommand = value => process.platform === 'win32'
    ? `Write-Output ('HYDRA_' + '${value.slice(6)}')\r`
    : `printf 'HYDRA_%s\\n' '${value.slice(6)}'\r`
  await mainWindow.webContents.executeJavaScript(`(() => {
    window.hydraDesktop?.terminal?.write('right', ${JSON.stringify(markerCommand(rightMarker))})
    window.hydraDesktop?.terminal?.write('bottom-1-1', ${JSON.stringify(markerCommand(bottomMarker))})
  })()`)
  await waitForTerminal('right', 'right command output', terminal => terminal.output.includes(rightMarker))
  await waitForTerminal('bottom-1-1', 'bottom command output', terminal => terminal.output.includes(bottomMarker))
  if (terminals.get('right').output.includes(bottomMarker) || terminals.get('bottom-1-1').output.includes(rightMarker)) {
    throw new Error('right and bottom Terminal output crossed PTY boundaries')
  }
  const firstTerminal = terminals.get('right').instance
  await selectControl('Terminal')
  await waitForRenderer('second Terminal tab', `document.querySelector('[aria-label="Right terminal 2"]:not([hidden])')`)
  await waitForTerminal('right-2', 'second right startup', () => true)
  await assertTerminalCwd('right-2', smokeWorkspace.root)
  const secondMarker = `${marker}_SECOND`
  await mainWindow.webContents.executeJavaScript(`window.hydraDesktop.terminal.write('right-2', ${JSON.stringify(markerCommand(secondMarker))})`)
  await waitForTerminal('right-2', 'second right output', terminal => terminal.output.includes(secondMarker))
  if (terminals.get('right').instance !== firstTerminal || terminals.get('right').output.includes(secondMarker)
    || terminals.get('right-2').output.includes(rightMarker) || terminals.get('bottom-1-1').output.includes(secondMarker)) {
    throw new Error(`Terminal tabs did not preserve independent PTYs: ${JSON.stringify({
      firstPreserved: terminals.get('right')?.instance === firstTerminal,
      firstHasSecond: terminals.get('right')?.output.includes(secondMarker),
      secondHasFirst: terminals.get('right-2')?.output.includes(rightMarker),
      bottomHasSecond: terminals.get('bottom-1-1')?.output.includes(secondMarker),
    })}`)
  }
  if (process.platform === 'win32') {
    await mainWindow.webContents.executeJavaScript(`window.hydraDesktop.terminal.write('right-2', "Write-Output ('HYDRA_' + 'POWERSHELL:' + $PSVersionTable.PSVersion.Major)\\r")`)
    await waitForTerminal('right-2', 'PowerShell version', terminal => /HYDRA_POWERSHELL:\d+/.test(terminal.output))
  }
  await selectControl('Close Terminal 2')
  await waitForRenderer('second Terminal closed', `!document.querySelector('[aria-label="Close Terminal 2"]')`)
  if (terminals.has('right-2') || terminals.get('right')?.instance !== firstTerminal || !terminals.has('bottom-1-1')) {
    throw new Error('closing the second Terminal affected another PTY')
  }
  const bottomPanel = 'section[aria-label="Terminal"]'
  const firstBottom = terminals.get('bottom-1-1').instance
  await selectControl('New Terminal', bottomPanel)
  await waitForTerminal('bottom-1-2', 'second bottom tab startup', () => true)
  await assertTerminalCwd('bottom-1-2', smokeWorkspace.root)
  await waitForRenderer('bottom plus creates a tab without a split', `(() => {
    const panel = document.querySelector(${JSON.stringify(bottomPanel)})
    return panel.querySelectorAll('[role="tab"]').length === 2
      && panel.querySelectorAll('[role="tabpanel"]:not([hidden]) [aria-label="Terminal output"]').length === 1
  })()`)
  await selectControl('Split Terminal', `${bottomPanel} [role="tabpanel"]:not([hidden])`)
  await waitForTerminal('bottom-1-2-2', 'bottom split startup', () => true)
  await assertTerminalCwd('bottom-1-2-2', smokeWorkspace.root)
  const bottomTabs = await mainWindow.webContents.executeJavaScript(`(() => {
    const tabs = [...document.querySelectorAll(${JSON.stringify(`${bottomPanel} [role="tab"]`)})]
    return tabs.map(tab => ({ label: tab.textContent.trim(), selected: tab.getAttribute('aria-selected') === 'true' }))
  })()`)
  if (JSON.stringify(bottomTabs) !== JSON.stringify([{ label: 'Terminal', selected: false }, { label: 'Terminal 2', selected: true }])) {
    throw new Error(`bottom terminal tabs are invalid: ${JSON.stringify(bottomTabs)}`)
  }
  await selectControl('Close Terminal 2', bottomPanel)
  await waitForRenderer('bottom tab processes stopped', `window.hydraDesktop.terminal.list().then(items =>
    !items.some(item => item.id === 'bottom-1-2' || item.id === 'bottom-1-2-2'))`)
  if (terminals.get('bottom-1-1')?.instance !== firstBottom || terminals.get('right')?.instance !== firstTerminal) {
    throw new Error('closing the bottom tab affected another terminal')
  }
  await selectControl('New Terminal', bottomPanel)
  await waitForTerminal('bottom-1-3', 'replacement bottom tab startup', () => true)
  await waitForRenderer('bottom tab reuses number 2', `document.querySelector(${JSON.stringify(bottomPanel)})
    .querySelector('[role="tab"][aria-selected="true"]')?.textContent.trim() === 'Terminal 2'`)
  workspaceTranscript.push({ terminal: 'bottom-1-3', label: 'Terminal 2' })
  await mainWindow.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(bottomPanel)})
    .querySelector('[role="tabpanel"]:not([hidden]) button[aria-label^="Kill "]').click()`)
  await waitForRenderer('trash closes the terminal tab and process', `!document.querySelector(${JSON.stringify(bottomPanel)})
    .querySelector('[aria-label="Close Terminal 2"]') && window.hydraDesktop.terminal.list().then(items =>
      !items.some(item => item.id === 'bottom-1-3'))`)
  if (terminals.get('bottom-1-1')?.instance !== firstBottom || terminals.get('right')?.instance !== firstTerminal) {
    throw new Error('trash affected another terminal')
  }
  workspaceTranscript.push({ action: 'trash-close', tabs: await mainWindow.webContents.executeJavaScript(`
    [...document.querySelectorAll(${JSON.stringify(`${bottomPanel} [role="tab"]`)})].map(tab => tab.textContent.trim())`) })
  const rejectedTerminalId = await mainWindow.webContents.executeJavaScript(`window.hydraDesktop.terminal.start('right-0', { cols: 80, rows: 24 }).then(() => false, () => true)`)
  if (!rejectedTerminalId) throw new Error('invalid Terminal id was accepted')
  const rejectedSplitTerminalId = await mainWindow.webContents.executeJavaScript(`window.hydraDesktop.terminal.start('right-4-0', { cols: 80, rows: 24 }).then(() => false, () => true)`)
  if (!rejectedSplitTerminalId) throw new Error('invalid split Terminal id right-4-0 was accepted')
  const splitTerminalAccepted = await mainWindow.webContents.executeJavaScript(`(async () => {
    const res = await window.hydraDesktop.terminal.start('right-4-2', { cols: 80, rows: 24 }, ${JSON.stringify(smokeWorkspace.workspaceId)})
    return res.running
  })()`)
  if (!splitTerminalAccepted) throw new Error('split terminal id right-4-2 was not accepted')
  await assertTerminalCwd('right-4-2', smokeWorkspace.root)
  await mainWindow.webContents.executeJavaScript("window.hydraDesktop.terminal.stop('right-4-2')")
  const workspaceRejections = await mainWindow.webContents.executeJavaScript(`(async () => {
    const api = window.hydraDesktop.terminal
    const rejected = promise => promise.then(() => false, () => true)
    return await Promise.all([
      rejected(api.start('right-9001', { cols: 80, rows: 24 }, 'missing-workspace')),
      rejected(api.start('right', { cols: 80, rows: 24 }, ${JSON.stringify(smokeWorkspace.terminalWorkspaces[0].workspaceId)})),
    ])
  })()`)
  if (!workspaceRejections.every(Boolean) || terminals.has('right-9001')) throw new Error('invalid terminal workspace was accepted')
  for (const workspace of smokeWorkspace.terminalWorkspaces) {
    await mainWindow.webContents.executeJavaScript(`window.hydraDesktop.terminal.start('right-9001', { cols: 80, rows: 24 }, ${JSON.stringify(workspace.workspaceId)})`)
    await assertTerminalCwd('right-9001', workspace.path)
    await mainWindow.webContents.executeJavaScript("window.hydraDesktop.terminal.stop('right-9001')")
  }
  const workspaceGolden = join(__dirname, 'tests', 'snapshots', 'terminal-workspaces.expected.json')
  const transcript = `${JSON.stringify(workspaceTranscript, null, 2)}\n`
  if (process.env.HYDRA_SNAPSHOT === 'refresh') {
    await mkdir(dirname(workspaceGolden), { recursive: true })
    await writeFile(workspaceGolden, transcript)
  } else if (await readFile(workspaceGolden, 'utf8') !== transcript) {
    throw new Error(`terminal workspace snapshot mismatch:\n${transcript}`)
  }
  await mainWindow.webContents.executeJavaScript(`(async () => {
    const api = window.hydraDesktop.terminal
    await Promise.all([
      api.start('right-9000', { cols: 80, rows: 24 }),
      api.start('right-9000', { cols: 80, rows: 24 }),
      api.stop('right-9000'),
    ])
  })()`)
  if (terminals.has('right-9000')) throw new Error('closing during Terminal startup left a PTY alive')
  const panels = await mainWindow.webContents.executeJavaScript(`(() => {
    const right = document.querySelector('[aria-label="Right panel"]')?.getBoundingClientRect()
    const bottom = document.querySelector('section[aria-label="Terminal"]')?.getBoundingClientRect()
    return right && bottom ? {
      right: { left: right.left, top: right.top, bottom: right.bottom },
      bottom: { left: bottom.left, top: bottom.top, right: bottom.right },
    } : undefined
  })()`)
  if (panels === undefined || panels.bottom.top <= panels.right.top || panels.bottom.right > panels.right.left + 1) {
    throw new Error(`right and bottom panels overlap: ${JSON.stringify(panels)}`)
  }
  mainWindow.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'T', modifiers: ['control'] })
  mainWindow.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'T', modifiers: ['control'] })
  const simultaneous = await waitForBounds('right with bottom Terminal', bounds => bounds.x > 0 && bounds.width < mainWindow.getContentBounds().width)
  assertNativeViews(simultaneous)
  await mainWindow.webContents.executeJavaScript(`(() => {
    const dialog = document.createElement('div')
    dialog.id = 'desktop-smoke-modal'
    dialog.setAttribute('role', 'dialog')
    dialog.setAttribute('aria-modal', 'true')
    document.body.append(dialog)
  })()`)
  await waitForHiddenBrowser('renderer modal')
  await mainWindow.webContents.executeJavaScript("document.querySelector('#desktop-smoke-modal')?.remove()")
  assertNativeViews(await waitForBounds('right after modal', bounds => bounds.x > 0 && bounds.width < mainWindow.getContentBounds().width))
  await selectControl('Expand right panel')
  const expanded = await waitForBounds(
    'expanded',
    bounds => bounds.width > simultaneous.width,
  )
  assertNativeViews(expanded)
  await selectControl('Expand right panel')
  const restored = await waitForBounds('restored right', bounds => bounds.width < expanded.width)
  assertNativeViews(restored)
  const terminalRestored = await mainWindow.webContents.executeJavaScript(`(() => {
    const panel = document.querySelector('section[aria-label="Terminal"]')
    const button = document.querySelector('[aria-label="Toggle bottom terminal"]')
    return panel instanceof HTMLElement && !panel.hidden && button?.getAttribute('aria-pressed') === 'true'
  })()`)
  if (!terminalRestored) throw new Error('Terminal did not restore after Browser expand')
  await selectControl('Toggle right panel')
  await waitForHiddenBrowser('right panel close')
  mainWindow.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'T', modifiers: ['control'] })
  mainWindow.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'T', modifiers: ['control'] })
  assertNativeViews(await waitForBounds('right panel reopen', bounds => bounds.width < expanded.width))
  if (BrowserWindow.getAllWindows().length !== 1) {
    throw new Error(`desktop opened ${BrowserWindow.getAllWindows().length} BrowserWindows instead of one`)
  }
  const beforeClose = browser.getState()
  if (beforeClose?.tabs.length !== 1 || beforeClose.activeTabId !== beforeClose.tabs[0]?.id) {
    throw new Error(`desktop browser tab state is invalid: ${JSON.stringify(beforeClose)}`)
  }
  const nativeChrome = mainWindow.contentView.children.find(view => view.webContents.getURL().endsWith('/chrome.html'))
  nativeChrome.webContents.focus()
  nativeChrome.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'T', modifiers: ['control'] })
  nativeChrome.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'T', modifiers: ['control'] })
  const newTabDeadline = Date.now() + 5_000
  while (browser.getState().tabs.length !== 2 && Date.now() < newTabDeadline) await delay(50)
  if (browser.getState().tabs.length !== 2 || !browserBounds.visible) throw new Error('native Ctrl+T toggled a desktop panel instead of opening a browser tab')
  await browser.command('close_tab', { tabId: browser.getState().activeTabId })
  assertNativeViews(await waitForBounds('native tab shortcut', bounds => bounds.width < expanded.width))
  const themeSettings = (await hostRequest('settings.describe')).namespaces.find(item => item.ns === 'ui-theme')
  let themeRevision = themeSettings.revision
  const systemTheme = nativeTheme.themeSource
  let previousPanelColor
  try {
    for (const colorScheme of ['dark', 'light']) {
      nativeTheme.themeSource = colorScheme === 'dark' ? 'light' : 'dark'
      const updated = await hostRequest('settings.mutate', {
        ns: 'ui-theme', expectedRevision: themeRevision,
        ops: [{ op: 'set', path: ['preference'], value: colorScheme }],
      })
      themeRevision = updated.revision
      await waitForRenderer('app theme', `document.documentElement.style.colorScheme === ${JSON.stringify(colorScheme)} && document.body.hasAttribute('data-ds-dark-theme') === ${JSON.stringify(colorScheme === 'dark')}`)
      const deadline = Date.now() + 15_000
      let matched = false
      while (Date.now() < deadline) {
        const panelColor = await mainWindow.webContents.executeJavaScript(`getComputedStyle(document.querySelector('[data-desktop-panel="browser"] header')).backgroundColor`)
        const colors = await nativeChrome.webContents.executeJavaScript(`({
          scheme: document.documentElement.style.colorScheme,
          shell: getComputedStyle(document.body).backgroundColor,
          tabs: getComputedStyle(document.querySelector('.tabs')).backgroundColor,
        })`)
        if (colors.scheme === colorScheme && colors.shell === panelColor && colors.tabs === panelColor
          && (previousPanelColor === undefined || panelColor !== previousPanelColor)) {
          matched = true
          previousPanelColor = panelColor
          break
        }
        await delay(50)
      }
      if (!matched) throw new Error(`Browser chrome does not match the ${colorScheme} app theme`)
      await waitForRenderer('terminal theme', `(() => {
        const viewports = [...document.querySelectorAll('[data-desktop-panel] .xterm-viewport')]
        return viewports.length === 2 && viewports.every(viewport =>
          getComputedStyle(viewport).backgroundColor === getComputedStyle(viewport.closest('[data-desktop-panel]')).backgroundColor)
      })()`)
      const artifacts = join(__dirname, '..', '..', '.artifacts')
      await mkdir(artifacts, { recursive: true })
      await writeFile(join(artifacts, `browser-theme-${colorScheme}.png`), (await mainWindow.capturePage()).toPNG())
    }
  } finally {
    nativeTheme.themeSource = systemTheme
    await hostRequest('settings.mutate', {
      ns: 'ui-theme', expectedRevision: themeRevision,
      ops: [themeSettings.user?.preference === undefined
        ? { op: 'unset', path: ['preference'] }
        : { op: 'set', path: ['preference'], value: themeSettings.user.preference }],
    })
  }
  await nativeChrome.webContents.executeJavaScript("document.querySelector('.tab-close').click()")
  await waitForRenderer('Browser panel dismissed after last tab', `!document.querySelector('[role="tab"][aria-controls="hydra-right-panel-surface-browser"]')`)
  await waitForHiddenBrowser('last browser tab closed')
  const afterClose = browser.getState()
  if (BrowserWindow.getAllWindows().length !== 1 || afterClose?.tabs.length !== 0) {
    throw new Error(`last-tab close did not leave the desktop with an empty browser: ${JSON.stringify(afterClose)}`)
  }
  const reopened = await browser.command('get_browser_state')
  if (reopened.tabs.length !== 1 || reopened.url !== 'about:blank') {
    throw new Error(`agent could not reopen the browser: ${JSON.stringify(reopened)}`)
  }
  assertNativeViews(await waitForBounds('agent reopens browser', bounds => bounds.width < expanded.width))
  await selectControl('Close Browser')
  await waitForHiddenBrowser('Browser panel tab closed')
  await browser.command('get_browser_state')
  assertNativeViews(await waitForBounds('agent restores Browser panel tab', bounds => bounds.width < expanded.width))
  process.stdout.write(`${JSON.stringify({
    event: 'desktop-smoke',
    ok: true,
    windows: 1,
    files: { root: files.root, shortcut: 'Ctrl+P', search: true, preview: true, confined: true },
    terminal: { rightMarker, bottomMarker, secondMarker, bottomTabs, workspaceCwd: true, simultaneous: true, isolated: true, appTheme: true, multipleTabs: true, powershell: process.platform === 'win32' },
    browser: { lastTabClosesPanel: true, agentReopens: true, appTheme: true },
    bounds: { right, simultaneous, expanded, restored },
  })}\n`)
}

async function shutdown() {
  if (shuttingDown !== undefined) return await shuttingDown
  shuttingDown = (async () => {
    const terminalIds = new Set([...terminals.keys(), ...terminalTails.keys()])
    try { await Promise.all([...terminalIds].map(id => queueTerminal(id, () => stopTerminal(id)))) } catch (error) { process.stderr.write(`${String(error)}\n`) }
    try { await browser?.dispose() } catch (error) { process.stderr.write(`${String(error)}\n`) }
    try { await cleanupSmokeWorkspace() } catch (error) {
      process.stderr.write(`desktop: smoke Workspace cleanup failed: ${String(error)}\n`)
      if (SMOKE) process.exitCode = 1
    }
    if (host !== undefined && !hostExited) {
      const exited = once(host, 'exit')
      host.postMessage({ type: 'shutdown' })
      const stopped = await Promise.race([exited.then(() => true), delay(HOST_SHUTDOWN_TIMEOUT_MS).then(() => false)])
      if (!stopped) host.kill()
      if (SMOKE && (!stopped || hostExitCode !== 0)) {
        process.stderr.write(`desktop: Host shutdown was not clean (code ${String(hostExitCode)})\n`)
        process.exitCode = 1
      }
    }
    mainWindow?.destroy()
    app.exit(process.exitCode ?? 0)
  })()
  return await shuttingDown
}

app.whenReady().then(async () => {
  try {
    mainWindow = createWindow()
    browser = await installBrowserController(mainWindow)
    installRendererIpc()
    hostBaseUrl = await startHost()
    if (SMOKE) await prepareSmokeWorkspace()
    await mainWindow.loadURL(hostBaseUrl)
    if (!SMOKE) mainWindow.show()
    mainWindow.on('close', event => {
      if (shuttingDown === undefined) {
        event.preventDefault()
        void shutdown()
      }
    })
    if (SMOKE) {
      if (SMOKE_ZOOM) {
        await smokeZoomShortcuts()
        process.stdout.write(`${JSON.stringify({ event: 'desktop-zoom-smoke', ok: true })}\n`)
      } else {
        await smoke()
      }
      await shutdown()
    }
  } catch (error) {
    process.stderr.write(`desktop: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exitCode = 1
    await shutdown()
  }
})

app.on('window-all-closed', () => { if (shuttingDown === undefined) void shutdown() })

// Electron main process for the harness's embedded browser. Spawned by
// `@hydraharness/harness-browser-electron`; it owns one window holding controlled tab views
// and speaks NDJSON over stdio.
//
// Protocol, one JSON object per line:
//   in   {"id":1,"method":"navigate","args":{"url":"https://…"}}
//   out  {"id":1,"ok":true,"result":{…}}  |  {"id":1,"ok":false,"error":"…"}
//
// stdout IS the channel. Nothing here may `console.log`; every diagnostic goes
// to stderr, which the parent surfaces as launch-failure detail.
'use strict'

const { once } = require('node:events')
const { randomUUID } = require('node:crypto')
const { createReadStream, existsSync } = require('node:fs')
const { readFile, rename, writeFile } = require('node:fs/promises')
const { createInterface } = require('node:readline')
const { basename, isAbsolute, join } = require('node:path')
const { setTimeout: delay } = require('node:timers/promises')

const { app, BrowserWindow, Menu, WebContentsView, clipboard, dialog, ipcMain, nativeImage, nativeTheme, safeStorage, session, shell } = require('electron')
const { connectPlaywrightPage } = require('./playwright.cjs')

const { createAutofillVault } = require('./autofill-vault.cjs')

/**
 * The desktop shell may host this controller in-process. Standalone launches
 * keep the original argv/stdout protocol used by BrowserSessionService.
 */
const embedded = globalThis.__HYDRA_BROWSER_EMBED__
/** Config from the parent, or defaults when run by hand for a smoke test. */
const config = embedded?.config ?? JSON.parse(process.argv[2] ?? '{}')
const CHROME_HEIGHT = 96
const CHROME_THEME_COLOR_FIELDS = Object.freeze([
  'shell', 'tabstrip', 'surface', 'text', 'muted', 'hover', 'border',
  'accent', 'accentText', 'omnibox', 'status',
])
const READINESS_TIMEOUT_MS = config.readinessTimeoutMs ?? 45_000
const READINESS_POLL_MS = 250
const READINESS_SETTLE_MS = 500

/** Optional profile-owned home page; config validation happens in the parent. */
const HOME_URL = typeof config.homeUrl === 'string' && config.homeUrl.length > 0 ? config.homeUrl : undefined
const PERSIST_SESSION_COOKIES = config.persistSessionCookies === true
const SESSION_COOKIE_TTL_SECONDS = 30 * 24 * 60 * 60
const PROFILE_STORE_FILE = 'browser-management.json'
const AUTOFILL_STORE_FILE = 'browser-autofill.json'
const AUTOFILL_UNAVAILABLE_REASON = 'Secure autofill storage is unavailable on this device.'
const MAX_HISTORY_ENTRIES = 1_000
const MAX_DOWNLOAD_ENTRIES = 500
const MAX_SITE_ENTRIES = 500
const DECISIONS = new Set(['allow', 'ask', 'block'])
const DESTINATIONS = new Set(['hydra', 'system'])
const ANNOTATION_SCREENSHOTS = new Set(['include', 'ask', 'never'])
const CLEAR_DATA_SCOPES = new Set(['all', 'history', 'site-data', 'cache', 'downloads'])
const SITE_DATA_TYPES = ['cookies', 'backgroundFetch', 'fileSystems', 'indexedDB', 'localStorage', 'serviceWorkers', 'webSQL']
const MAX_HISTORY_SEARCH_RESULTS = 20
const MAX_SCREENSHOT_BYTES = 3_500_000
const MAX_SCREENSHOT_EDGE = 2_000
const MAX_CDP_PARAMS_BYTES = 64 * 1_024
const MAX_CDP_RESULT_BYTES = 1_024 * 1_024
const MAX_CDP_EVENT_RESULTS = 100
const MAX_CDP_EVENT_ENTRIES = 1_000
const MAX_CDP_EVENT_BYTES = 64 * 1_024
const MAX_CDP_EVENT_RING_BYTES = 4 * 1_024 * 1_024
const MAX_IFRAME_ANNOTATE_DEPTH = 8
const CDP_METHOD = /^[A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*$/u
const CROSS_TARGET_CDP_DOMAINS = new Set(['Browser', 'SystemInfo', 'Target', 'Tethering'])

/** Preferences enforced by the Electron owner, updated through validated commands. */
const nativeSettings = {
  webDestination: DESTINATIONS.has(config.webDestination) ? config.webDestination : 'hydra',
  localDestination: DESTINATIONS.has(config.localDestination) ? config.localDestination : 'hydra',
  annotationScreenshots: ANNOTATION_SCREENSHOTS.has(config.annotationScreenshots)
    ? config.annotationScreenshots : 'include',
  downloadDirectory: typeof config.downloadDirectory === 'string' ? config.downloadDirectory : '',
  askWhereToSave: config.askWhereToSave === true,
  navigationPolicy: DECISIONS.has(config.navigationPolicy)
    ? config.navigationPolicy
    : embedded === undefined ? 'allow' : 'ask',
  downloadPolicy: DECISIONS.has(config.downloadPolicy)
    ? config.downloadPolicy
    : embedded === undefined ? 'allow' : 'ask',
  fullCdpAccessAllowed: config.fullCdpAccessAllowed !== false,
  fullCdpAccess: config.fullCdpAccess === true,
}

/** App-owned browsing records; Chromium exposes neither durable history manager. */
let profileStore = { history: [], downloads: [], sites: {}, bookmarks: [] }
let profileStorePath
let profileStoreWrite = Promise.resolve()
const reservedDownloadPaths = new Set()

/** Pending native cookie-store writes, flushed before a harness-owned exit. */
const sessionCookieWrites = new Set()
/** Controlled pages share one Chromium session, isolated from the app renderer. */
let browserSession
/** Main-process-only encrypted credentials and contact information. */
let autofillVault
let autofillUnavailableReason = AUTOFILL_UNAVAILABLE_REASON

const log = (...parts) => console.error('[hydra-browser]', ...parts)

function boundedString(value, max) {
  return typeof value === 'string' && value.length <= max ? value : undefined
}

/** Canonical exact HTTP(S) origin used by navigation and permission policy. */
function canonicalOrigin(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : undefined
  } catch {
    return undefined
  }
}

/** Match the preload's privacy-preserving annotation page address. */
function annotationPageUrl(value) {
  const url = routedHttpUrl(value)
  if (url === undefined) return undefined
  url.search = ''
  url.hash = ''
  return url.href
}

/** Return whether the active tab can produce a page annotation. */
function annotationEnabledFor(tab) {
  if (typeof embedded?.onAnnotation !== 'function') return false
  const contents = tab?.view.webContents
  return contents !== undefined && !contents.isDestroyed()
    && annotationPageUrl(contents.getURL()) !== undefined
}

function validDecision(value) {
  return DECISIONS.has(value) ? value : undefined
}

function validDestination(value) {
  return DESTINATIONS.has(value) ? value : undefined
}

function validAnnotationScreenshots(value) {
  return ANNOTATION_SCREENSHOTS.has(value) ? value : undefined
}

function clearDataScope(value) {
  if (value !== undefined && (typeof value !== 'object' || value === null || Array.isArray(value))) {
    throw new Error('clear data scope must be an object')
  }
  const scope = value?.scope ?? 'all'
  if (!CLEAR_DATA_SCOPES.has(scope)) {
    throw new Error('clear data scope must be all, history, site-data, cache, or downloads')
  }
  return scope
}

function historyEntry(value) {
  if (typeof value !== 'object' || value === null) return undefined
  const id = boundedString(value.id, 100)
  const url = boundedString(value.url, 2_048)
  const title = boundedString(value.title, 512)
  const visitedAt = boundedString(value.visitedAt, 64)
  if (!id || !url || title === undefined || !visitedAt || canonicalOrigin(url) === undefined) return undefined
  return { id, url, title, visitedAt }
}

function downloadEntry(value) {
  if (typeof value !== 'object' || value === null) return undefined
  const id = boundedString(value.id, 100)
  const url = boundedString(value.url, 2_048)
  const filename = boundedString(value.filename, 512)
  const path = boundedString(value.path, 32_768)
  const state = ['progressing', 'completed', 'cancelled', 'interrupted'].includes(value.state)
    ? value.state : undefined
  const startedAt = boundedString(value.startedAt, 64)
  const endedAt = value.endedAt === undefined ? undefined : boundedString(value.endedAt, 64)
  if (!id || !url || !filename || path === undefined || !state || !startedAt) return undefined
  return { id, url, filename, path, state, startedAt, ...(endedAt === undefined ? {} : { endedAt }) }
}

function siteEntry(origin, value) {
  const normalized = canonicalOrigin(origin)
  if (normalized !== origin || typeof value !== 'object' || value === null) return undefined
  const access = validDecision(value.access)
  const media = validDecision(value.media)
  if (access !== 'allow' && access !== 'block') return undefined
  if (media !== 'allow' && media !== 'block') return undefined
  return { origin, access, media }
}

function bookmarkEntry(value) {
  if (typeof value !== 'object' || value === null) return undefined
  const id = boundedString(value.id, 100)
  const url = boundedString(value.url, 2_048)
  const title = boundedString(value.title, 512)
  const favicon = typeof value.favicon === 'string' ? value.favicon.slice(0, 10_000) : ''
  const createdAt = boundedString(value.createdAt, 64)
  if (!id || !url || title === undefined || !createdAt) return undefined
  return { id, url, title, favicon, createdAt }
}

/** Parse only the bounded app-owned records from a durable profile file. */
function profileStoreOf(value) {
  if (typeof value !== 'object' || value === null) return { history: [], downloads: [], sites: {}, bookmarks: [] }
  const history = Array.isArray(value.history)
    ? value.history.slice(0, MAX_HISTORY_ENTRIES).flatMap(entry => historyEntry(entry) ?? [])
    : []
  const downloads = Array.isArray(value.downloads)
    ? value.downloads.slice(0, MAX_DOWNLOAD_ENTRIES).flatMap(entry => downloadEntry(entry) ?? [])
    : []
  const sites = {}
  if (typeof value.sites === 'object' && value.sites !== null) {
    for (const [origin, candidate] of Object.entries(value.sites).slice(0, MAX_SITE_ENTRIES)) {
      const entry = siteEntry(origin, candidate)
      if (entry !== undefined) sites[origin] = { access: entry.access, media: entry.media }
    }
  }
  const bookmarks = Array.isArray(value.bookmarks)
    ? value.bookmarks.slice(0, 500).flatMap(entry => bookmarkEntry(entry) ?? [])
    : []
  return { history, downloads, sites, bookmarks }
}

function listBookmarks() {
  return profileStore.bookmarks.map(b => ({ ...b }))
}

async function addBookmark({ url, title, favicon }) {
  if (!url || typeof url !== 'string') return
  const id = randomUUID()
  const existing = profileStore.bookmarks.find(b => b.url === url)
  if (existing) {
    if (title) existing.title = title
    if (favicon) existing.favicon = favicon
  } else {
    profileStore.bookmarks.push({
      id,
      url,
      title: title || url,
      favicon: favicon || '',
      createdAt: new Date().toISOString(),
    })
  }
  await persistProfileStore()
  updateChrome()
}

async function removeBookmark(urlOrId) {
  profileStore.bookmarks = profileStore.bookmarks.filter(b => b.id !== urlOrId && b.url !== urlOrId)
  await persistProfileStore()
  updateChrome()
}

function isBookmarked(url) {
  return profileStore.bookmarks.some(b => b.url === url)
}

async function loadProfileStore() {
  profileStorePath = join(app.getPath('userData'), PROFILE_STORE_FILE)
  try {
    profileStore = profileStoreOf(JSON.parse(await readFile(profileStorePath, 'utf8')))
  } catch (error) {
    if (error?.code !== 'ENOENT') log('profile management store ignored:', error)
  }
}

/** Open and validate the encrypted vault without making browser startup depend on it. */
async function initializeAutofillVault() {
  try {
    const candidate = createAutofillVault({
      filename: join(app.getPath('userData'), AUTOFILL_STORE_FILE),
      safeStorage,
    })
    await Promise.all([candidate.listLogins(), candidate.listContacts()])
    autofillVault = candidate
    autofillUnavailableReason = undefined
  } catch {
    autofillVault = undefined
    autofillUnavailableReason = AUTOFILL_UNAVAILABLE_REASON
    log('secure autofill is unavailable')
  }
}

function autofillStatus() {
  return autofillVault === undefined
    ? { available: false, reason: autofillUnavailableReason ?? AUTOFILL_UNAVAILABLE_REASON }
    : { available: true }
}

async function useAutofillVault(operation) {
  const vault = autofillVault
  if (vault === undefined) throw new Error(autofillUnavailableReason ?? AUTOFILL_UNAVAILABLE_REASON)
  try {
    return await operation(vault)
  } catch (error) {
    if (error?.code === 'AUTOFILL_VAULT_UNAVAILABLE') {
      autofillVault = undefined
      autofillUnavailableReason = AUTOFILL_UNAVAILABLE_REASON
    }
    throw error
  }
}

function persistProfileStore() {
  const snapshot = JSON.stringify({ version: 1, ...profileStore })
  profileStoreWrite = profileStoreWrite.catch(() => undefined).then(async () => {
    const temporary = `${profileStorePath}.tmp`
    await writeFile(temporary, snapshot, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, profileStorePath)
  })
  void profileStoreWrite.catch(error => log('profile management store write failed:', error))
  return profileStoreWrite
}

function configureBrowserSettings(value) {
  if (typeof value !== 'object' || value === null) throw new Error('Browser settings are invalid')
  const directory = value.downloadDirectory
  if (typeof directory !== 'string' || (directory !== '' && !isAbsolute(directory))) {
    throw new Error('download directory must be empty or absolute')
  }
  const navigationPolicy = validDecision(value.navigationPolicy)
  const downloadPolicy = validDecision(value.downloadPolicy)
  if (navigationPolicy === undefined || downloadPolicy === undefined || typeof value.askWhereToSave !== 'boolean') {
    throw new Error('Browser permission settings are invalid')
  }
  nativeSettings.downloadDirectory = directory
  nativeSettings.askWhereToSave = value.askWhereToSave
  nativeSettings.navigationPolicy = navigationPolicy
  nativeSettings.downloadPolicy = downloadPolicy
  if (value.webDestination !== undefined) {
    const destination = validDestination(value.webDestination)
    if (destination === undefined) throw new Error('web destination must be hydra or system')
    nativeSettings.webDestination = destination
  }
  if (value.localDestination !== undefined) {
    const destination = validDestination(value.localDestination)
    if (destination === undefined) throw new Error('local destination must be hydra or system')
    nativeSettings.localDestination = destination
  }
  if (value.annotationScreenshots !== undefined) {
    const screenshots = validAnnotationScreenshots(value.annotationScreenshots)
    if (screenshots === undefined) throw new Error('annotation screenshot policy is invalid')
    nativeSettings.annotationScreenshots = screenshots
  }
  if (value.fullCdpAccessAllowed !== undefined) {
    if (typeof value.fullCdpAccessAllowed !== 'boolean') throw new Error('full CDP organization policy is invalid')
    nativeSettings.fullCdpAccessAllowed &&= value.fullCdpAccessAllowed
  }
  if (value.fullCdpAccess !== undefined) {
    if (typeof value.fullCdpAccess !== 'boolean') throw new Error('full CDP setting is invalid')
    nativeSettings.fullCdpAccess = value.fullCdpAccess
  }
  if (!nativeSettings.fullCdpAccessAllowed || !nativeSettings.fullCdpAccess) {
    for (const tab of tabs.values()) detachTabDebugger(tab, true)
  }
  if (browserSession !== undefined) browserSession.setDownloadPath(directory || app.getPath('downloads'))
  return { fullCdpAccessAllowed: nativeSettings.fullCdpAccessAllowed }
}

function recordHistory(contents) {
  let url
  try {
    const parsed = new URL(contents.getURL())
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return
    parsed.username = ''
    parsed.password = ''
    url = parsed.href
  } catch {
    return
  }
  const now = new Date().toISOString()
  const current = profileStore.history[0]
  const entry = { id: current?.url === url ? current.id : randomUUID(), url, title: contents.getTitle() || url, visitedAt: now }
  if (current?.url === url) profileStore.history[0] = entry
  else profileStore.history.unshift(entry)
  profileStore.history.length = Math.min(profileStore.history.length, MAX_HISTORY_ENTRIES)
  persistProfileStore()
}

function searchHistory(value) {
  const query = typeof value?.query === 'string' ? boundedString(value.query.trim(), 256) : undefined
  const limit = value?.limit
  if (!query) throw new Error('history query must contain 1 to 256 characters')
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_HISTORY_SEARCH_RESULTS) {
    throw new Error(`history search limit must be from 1 to ${MAX_HISTORY_SEARCH_RESULTS}`)
  }
  const needle = query.toLocaleLowerCase()
  return profileStore.history
    .filter(entry => `${entry.title}\n${entry.url}`.toLocaleLowerCase().includes(needle))
    .slice(0, limit)
    .map(({ url, title, visitedAt }) => ({ url, title, visitedAt }))
}

function listSites() {
  return Object.entries(profileStore.sites)
    .map(([origin, value]) => ({ origin, access: value.access, media: value.media }))
    .sort((left, right) => left.origin.localeCompare(right.origin))
}

async function setSite(value) {
  const origin = canonicalOrigin(value?.origin)
  if (origin === undefined) throw new Error('site must be an absolute HTTP(S) URL')
  const access = validDecision(value.access)
  const media = validDecision(value.media)
  if (access !== 'allow' && access !== 'block') throw new Error('site access must be allow or block')
  if (media !== 'allow' && media !== 'block') throw new Error('site media must be allow or block')
  if (!Object.hasOwn(profileStore.sites, origin) && Object.keys(profileStore.sites).length >= MAX_SITE_ENTRIES) {
    throw new Error(`site override limit of ${MAX_SITE_ENTRIES} reached`)
  }
  const previous = profileStore.sites[origin]
  profileStore.sites[origin] = { access, media }
  const persisted = persistProfileStore()
  if (media === 'block' && previous?.media !== 'block') await revokeMediaForOrigin(origin)
  await persisted
}

function removeSite(value) {
  const origin = canonicalOrigin(value?.origin)
  if (origin === undefined) throw new Error('site must be an absolute HTTP(S) URL')
  delete profileStore.sites[origin]
  persistProfileStore()
}

function uniqueDownloadPath(directory, filename) {
  const parsed = basename(filename)
  const dot = parsed.lastIndexOf('.')
  const stem = dot > 0 ? parsed.slice(0, dot) : parsed
  const extension = dot > 0 ? parsed.slice(dot) : ''
  let candidate = join(directory, parsed)
  for (let suffix = 1; existsSync(candidate) || reservedDownloadPaths.has(candidate); suffix += 1) {
    candidate = join(directory, `${stem} (${suffix})${extension}`)
  }
  return candidate
}

function updateDownload(id, patch) {
  const index = profileStore.downloads.findIndex(entry => entry.id === id)
  if (index === -1) return
  profileStore.downloads[index] = { ...profileStore.downloads[index], ...patch }
  persistProfileStore()
}

/** Latest denied download per document, retained until navigation or another download. */
const downloadDenials = new WeakMap()

/** Enforce download policy before data reaches disk and retain a bounded ledger. */
function beginDownload(event, item, contents) {
  const id = randomUUID()
  const directory = nativeSettings.downloadDirectory || app.getPath('downloads')
  const filename = basename(item.getFilename())
  if (contents !== undefined) downloadDenials.delete(contents)
  const deny = reason => {
    if (contents !== undefined) downloadDenials.set(contents, `BROWSER_POLICY_DENIED: Download ${JSON.stringify(filename)} ${reason}.`)
  }
  const proposedPath = uniqueDownloadPath(directory, filename)
  reservedDownloadPaths.add(proposedPath)
  const entry = {
    id,
    url: item.getURL(),
    filename,
    path: nativeSettings.askWhereToSave ? '' : proposedPath,
    state: 'progressing',
    startedAt: new Date().toISOString(),
  }
  profileStore.downloads.unshift(entry)
  profileStore.downloads.length = Math.min(profileStore.downloads.length, MAX_DOWNLOAD_ENTRIES)

  log(`browser permission: action=download capability=downloads decision=${nativeSettings.downloadPolicy} source=general`)
  if (nativeSettings.downloadPolicy === 'block') {
    deny('was blocked by Browser permissions')
    reservedDownloadPaths.delete(proposedPath)
    event.preventDefault()
    updateDownload(id, { state: 'cancelled', endedAt: new Date().toISOString() })
    return
  }

  const requiresApproval = nativeSettings.downloadPolicy === 'ask'
  if (requiresApproval) item.pause()
  let finished = false
  if (nativeSettings.askWhereToSave) item.setSaveDialogOptions({ defaultPath: proposedPath })
  else item.setSavePath(proposedPath)
  persistProfileStore()
  item.on('updated', () => {
    updateDownload(id, { state: item.getState(), path: item.getSavePath() || entry.path })
  })
  item.once('done', (_event, state) => {
    finished = true
    reservedDownloadPaths.delete(proposedPath)
    updateDownload(id, { state, path: item.getSavePath() || entry.path, endedAt: new Date().toISOString() })
  })
  if (requiresApproval) {
    const origin = canonicalOrigin(item.getURL()) ?? canonicalOrigin(contents?.getURL())
    const permission = contents === undefined || origin === undefined
      ? Promise.resolve(false)
      : requestPermission(contents, 'download', origin, filename)
    void permission.then(allowed => {
      if (finished) return
      if (allowed && nativeSettings.downloadPolicy !== 'block') item.resume()
      else { deny('was not approved'); item.cancel() }
    }, () => { if (!finished) { deny('was not approved'); item.cancel() } })
  }
}

const send = (message) => {
  if (embedded !== undefined) embedded.send(message)
  else process.stdout.write(`${JSON.stringify(message)}\n`)
}

/** Keep an SSO session cookie in Chromium's encrypted on-disk store. */
function persistSessionCookie(cookie) {
  if (!PERSIST_SESSION_COOKIES || cookie.expirationDate !== undefined) return
  const host = cookie.domain.replace(/^\./, '')
  const task = browserSession.cookies.set({
    url: `${cookie.secure ? 'https' : 'http'}://${host}${cookie.path || '/'}`,
    name: cookie.name,
    value: cookie.value,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite,
    ...cookie.hostOnly ? {} : { domain: cookie.domain },
    expirationDate: Math.floor(Date.now() / 1_000) + SESSION_COOKIE_TTL_SECONDS,
  }).then(() => browserSession.cookies.flushStore()).catch(error => {
    log('session-cookie persistence failed:', error)
  })
  sessionCookieWrites.add(task)
  void task.finally(() => sessionCookieWrites.delete(task))
}

async function flushSessionCookies() {
  if (!PERSIST_SESSION_COOKIES) return
  await Promise.all([...sessionCookieWrites])
  await browserSession.cookies.flushStore()
}

/** In-flight `page-control` requests, keyed by the id the preload echoes back. */
const pendingPageCalls = new Map()
let nextPageCallId = 1
const nativeMouseTabs = new Set()

/** In-flight PageAgent model requests awaiting the owning Hydra agent. */
const pendingPageAgentLlmCalls = new Map()
let nextPageAgentLlmCallId = 1

/** @typedef {{ id: number, view: import('electron').WebContentsView, contents: import('electron').WebContents, favicon?: string, cdp: { owned: boolean, persistent: boolean, nextSequence: number, events: Array<object>, bytes: number } }} Tab */

/** @type {Map<number, Tab>} */
const tabs = new Map()
let nextTabId = 1
/** @type {Tab | undefined} */
let activeTab
/** @type {import('electron').BrowserWindow} */
let window
/** @type {import('electron').WebContentsView | undefined} */
let chrome
/** Last renderer-owned rectangle for an in-process controlled browser. */
let embeddedBounds = { x: 0, y: 0, width: 0, height: 0, visible: false }
/** Last browser chrome state, also returned to a newly mounted desktop panel. */
let chromeState
/** Embedded desktop override; standalone chrome follows Electron's OS scheme. */
let chromeThemeOverride
/** Status line shown in native chrome while the agent drives the page. */
let chromeActivity = ''
let activeBrowserCalls = 0

/** The gradient follows browser commands; the preload retains the virtual cursor while idle. */
function updateBrowserActivity() {
  for (const tab of tabs.values()) {
    if (!tab.contents.isDestroyed()) tab.contents.send('browser:activity', activeBrowserCalls > 0)
  }
}
/** Whether an agent browser action has already revealed the desktop panel. */
let agentBrowserRevealed = false
/** Toolbar picker whose completion owns the pressed-state reset. */
let toolbarAnnotation
let windowClosing = false
/** @type {(() => Tab) | undefined} */
let createTab
/** @type {((tab: Tab) => void) | undefined} */
let selectTab
/** @type {((tab: Tab) => void) | undefined} */
let closeTab

function isControlledContents(contents) {
  return Array.from(tabs.values()).some(tab => tab.view.webContents === contents)
}

/** Share the owned debugger between accessibility, native input, and diagnostics. */
function ensureTabDebugger(tab, persistent) {
  const devtools = tab.view.webContents.debugger
  if (tab.cdp.owned && devtools.isAttached()) {
    tab.cdp.persistent ||= persistent
    return false
  }
  tab.cdp.owned = false
  tab.cdp.persistent = false
  if (devtools.isAttached()) throw new Error('the controlled tab debugger is already in use')
  devtools.attach('1.3')
  tab.cdp.owned = true
  tab.cdp.persistent = persistent
  return true
}

/** Connect once to the tab's existing Electron debugger through native Playwright. */
async function ensureNativePage(tab) {
  if (tab.playwrightPage !== undefined) return tab.playwrightPage
  if (!tab.cdp.owned || !tab.view.webContents.debugger.isAttached()) ensureTabDebugger(tab, true)
  tab.playwrightPage = await connectPlaywrightPage(tab.contents, READINESS_TIMEOUT_MS)
  // Hydra's dialog tool owns the response; Playwright must not auto-dismiss it.
  tab.playwrightPage.on('dialog', () => {})
  return tab.playwrightPage
}

/** Parse model-supplied patterns once; stateful matching flags are unsupported. */
function browserRegex(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('regex must be a non-empty string')
  const literal = /^\/(.*)\/([imsu]*)$/su.exec(value)
  return literal ? new RegExp(literal[1], literal[2]) : new RegExp(value)
}

function nativeLocator(page, args) {
  if (args.target !== undefined) {
    if (typeof args.target !== 'string' || !args.target.trim()) throw new Error('target must be an observed ref or unique CSS selector')
    const target = args.target.trim()
    if (/^(f\d+)?e\d+$/u.test(target)) return page.locator(`aria-ref=${target}`)
    // "iframeSelector >> innerSelector" descends into an <iframe> (repeat to
    // nest further); each segment but the last selects one frame via
    // Playwright's own frameLocator, unaffected by the top document's origin.
    const segments = target.split(/\s*>>\s*/u)
    let scope = page
    for (const segment of segments.slice(0, -1)) scope = scope.frameLocator(`css=${segment}`)
    return scope.locator(`css=${segments.at(-1)}`)
  }
  if (args.index !== undefined) {
    if (!Number.isSafeInteger(args.index) || args.index < 0) throw new Error('index must be a non-negative integer')
    return page.locator(`[data-hydra-a11y-ref="e${args.index}"]`)
  }
  const name = typeof args.name === 'string' ? args.name.trim() : ''
  if (!name) throw new Error('provide an index or a non-empty name')
  const escapedId = [...name].map(character => `\\${character.codePointAt(0).toString(16)} `).join('')
  return page.getByLabel(name, { exact: true })
    .or(page.getByRole('button', { name, exact: true }))
    .or(page.getByRole('link', { name, exact: true }))
    .or(page.getByPlaceholder(name, { exact: true }))
    .or(page.locator(`[id="${escapedId}"]`))
}

/**
 * Animate the existing mask to the locator Playwright will act on. Cosmetic
 * only: the isolated PageController world it redispatches into cannot follow
 * an element across a frame boundary (a cross-origin iframe's document is
 * unreachable from the top frame's page-JS by construction), so a resolution
 * failure here must never block the real native action that follows.
 */
async function moveNativePointer(tab, args, mode = 'default', click = false) {
  try {
    await withNativeRef(tab, args, resolved => pageControl(tab, 'prepare_pointer', { ...resolved, mode, click }))
  } catch {}
}

/** Resolve Playwright refs in their owning world before calling the isolated preload. */
async function withNativeRef(tab, args, action) {
  if (args.target === undefined || !/^(f\d+)?e\d+$/u.test(args.target)) return action(args)
  const page = await ensureNativePage(tab)
  const element = await nativeLocator(page, args).elementHandle()
  if (!element) throw new Error('Accessibility ref is unavailable; find it again.')
  const attribute = `data-hydra-target-${randomUUID()}`
  try {
    await element.evaluate((node, attribute) => node.setAttribute(attribute, ''), attribute)
    return await action({ ...args, target: `[${attribute}]` })
  } finally {
    try {
      await element.evaluate((node, attribute) => node.removeAttribute(attribute), attribute)
    } catch {
      // Navigation or tab teardown can destroy the element's execution context.
    }
    await element.dispose()
  }
}

/** Diagnostic retention is bounded independently of the smaller model output budget. */
function boundedDiagnostic(text) {
  return text.length <= MAX_CDP_EVENT_BYTES ? text : `${text.slice(0, MAX_CDP_EVENT_BYTES)}\n(Output truncated at the diagnostic retention limit.)`
}

const IFRAME_LINE = /^(\s*)- iframe\b.*\[ref=((?:f\d+)?e\d+)\](:)?\s*$/u

/**
 * Label every "- iframe [ref=...]" boundary with the origin its `src`
 * attribute names, so several same-shaped embeds from different platforms
 * (a payment widget, a video embed, a consent frame) stay distinguishable.
 * Reads the DOM attribute directly rather than the resolved Frame's own
 * `url()`, which lags for a target Hydra's CDP bridge has not fully attached
 * to. Also splices a frame's own snapshot in when Playwright's own composed
 * text left the boundary childless, a defensive fallback in case its
 * recursive composition does not cover a given case.
 */
async function annotateIframes(page, lines, options, depthSoFar = 0) {
  const out = []
  for (const line of lines) {
    const match = IFRAME_LINE.exec(line)
    if (!match) { out.push(line); continue }
    const [, indent, ref, hasChildren] = match
    const bare = line.replace(/:\s*$/u, '')
    const element = await nativeLocator(page, { target: ref }).elementHandle().catch(() => undefined)
    const src = await element?.evaluate(node => node.getAttribute('src')).catch(() => undefined)
    const origin = typeof src === 'string' ? httpOrigin(src) : undefined
    const labeled = origin === undefined ? bare : `${bare} (${origin})`
    const atDepthLimit = depthSoFar >= (options.depth ?? MAX_IFRAME_ANNOTATE_DEPTH)
    const frame = hasChildren || atDepthLimit || element === undefined ? undefined : await element.contentFrame().catch(() => undefined)
    await element?.dispose()
    if (hasChildren || !frame) {
      out.push(hasChildren ? `${labeled}:` : labeled)
      continue
    }
    const child = await frame.locator('body,frameset').ariaSnapshot({ mode: 'ai', depth: options.depth, boxes: options.boxes }).catch(() => '')
    if (!child.trim()) { out.push(labeled); continue }
    out.push(`${labeled}:`)
    const nested = await annotateIframes(page, child.split('\n'), options, depthSoFar + 1)
    out.push(...nested.map(childLine => `${indent}  ${childLine}`))
  }
  return out
}

/** Preserve Hydra's password redaction in upstream distilled snapshots, including file output. */
async function distilledSnapshot(page, options = {}) {
  const source = options.target === undefined ? page : nativeLocator(page, { target: options.target })
  const snapshot = await source.ariaSnapshot({ mode: 'ai', depth: options.depth, boxes: options.boxes })
  const lines = await annotateIframes(page, snapshot.split('\n'), options)
  for (let index = 0; index < lines.length; index++) {
    // Playwright keys have an optional JSON-quoted name, state brackets, and optional YAML quoting.
    const key = /^(\s*- '?[\w-]+(?: "(?:[^"\\]|\\.)*")?(?: \[[^\]]+\])*'?):.+$/u.exec(lines[index])
    if (!key) continue
    const refs = [...key[1].matchAll(/\[ref=((?:f\d+)?e\d+)\]/gu)]
    const ref = refs.at(-1)?.[1]
    if (ref && await nativeLocator(page, { target: ref }).evaluate(node => node.tagName === 'INPUT' && node.type === 'password')) {
      lines[index] = `${key[1]}: "[redacted]"`
    }
  }
  return lines.join('\n')
}

async function nativePageAction(tab, method, args, signal) {
  if (!['click_element', 'hover_element', 'drag_element', 'input_text', 'select_option', 'fill_fields', 'find_element', 'select_text'].includes(method)) return undefined
  // Playwright needs animation frames even when Windows occludes a focused tab.
  const throttled = tab.contents.getBackgroundThrottling()
  tab.contents.setBackgroundThrottling(false)
  let page
  let disconnect
  const cancel = () => {
    if (tab.playwrightPage === page) tab.playwrightPage = undefined
    // Disconnect this tab's transport: pending locators stop, while its document stays open.
    disconnect = page.context().browser().close({ reason: 'browser action cancelled' })
  }
  try {
    signal?.throwIfAborted()
    if (method === 'select_text') return await withNativeRef(tab, args, resolved => pageControl(tab, method, resolved))
    page = await ensureNativePage(tab)
    signal?.throwIfAborted()
    signal?.addEventListener('abort', cancel, { once: true })
    if (method === 'find_element') {
      const text = args.text ?? args.query
      if ((text === undefined) === (args.regex === undefined)) throw new Error('provide exactly one of text or regex')
      if (text !== undefined && (typeof text !== 'string' || !text.trim())) throw new Error('text must be non-empty')
      const pattern = args.regex === undefined ? undefined : browserRegex(args.regex)
      const snapshot = await distilledSnapshot(page)
      const lines = snapshot.split('\n')
      const matches = lines.flatMap((line, index) => (pattern ? pattern.test(line) : line.toLowerCase().includes(text.toLowerCase())) ? [index] : [])
      const selected = new Set()
      for (const index of matches) {
        selected.add(index)
        const indent = lines[index].search(/\S/u)
        // The matched node's own subtree, so a matched container shows what it holds.
        for (let i = index + 1; i < lines.length; i++) {
          const childIndent = lines[i].search(/\S/u)
          if (childIndent >= 0 && childIndent <= indent) break
          selected.add(i)
        }
        // Only the nearest enclosing iframe, so a match inside an embed still
        // names its platform without the full ancestor breadcrumb.
        let ancestorIndent = indent
        for (let i = index - 1; i >= 0 && ancestorIndent > 0; i--) {
          const parentIndent = lines[i].search(/\S/u)
          if (parentIndent >= 0 && parentIndent < ancestorIndent) {
            ancestorIndent = parentIndent
            if (/^\s*- iframe\b/u.test(lines[i])) { selected.add(i); break }
          }
        }
      }
      const snippets = [...selected].sort((a, b) => a - b).map(i => lines[i]).join('\n')
      return { success: matches.length > 0, message: matches.length === 0 ? 'No matching accessibility nodes.' : boundedDiagnostic(`Found ${matches.length} matching nodes:\n${snippets}`) }
    }
    if (method === 'fill_fields') {
      if (!Array.isArray(args.fields) || args.fields.length === 0) throw new Error('fields must be a non-empty array')
      for (const field of args.fields) {
        signal?.throwIfAborted()
        const locator = nativeLocator(page, field)
        const kind = await locator.evaluate(element => element.tagName === 'SELECT' ? 'select' : element.getAttribute('type'))
        await moveNativePointer(tab, field, ['select', 'checkbox', 'radio'].includes(kind) ? 'default' : 'ibeam')
        signal?.throwIfAborted()
        if (kind === 'checkbox' || kind === 'radio') {
          if (!['true', 'false'].includes(field.text)) return { success: false, message: 'Checkbox and radio values must be true or false.' }
          if (kind === 'radio' && field.text === 'false') return { success: false, message: 'Select another radio option to clear this one.' }
          await locator.setChecked(field.text === 'true')
        } else if (kind === 'select') {
          await locator.selectOption({ label: field.text })
        } else {
          await locator.fill(field.text)
        }
      }
      return { success: true, message: `Filled ${args.fields.length} browser field${args.fields.length === 1 ? '' : 's'}.` }
    }
    const locator = nativeLocator(page, method === 'drag_element' ? { index: args.startIndex } : args)
    await moveNativePointer(tab, method === 'drag_element' ? { index: args.startIndex } : args, method === 'input_text' ? 'ibeam' : 'default', method === 'click_element')
    signal?.throwIfAborted()
    switch (method) {
      case 'click_element': await locator.click(); return { success: true, message: 'Clicked browser control.' }
      case 'hover_element': await locator.hover(); return { success: true, message: 'Hovered browser control.' }
      case 'drag_element': {
        const source = nativeLocator(page, { index: args.startIndex })
        const target = nativeLocator(page, { index: args.endIndex })
        await source.dragTo(target)
        await moveNativePointer(tab, { index: args.endIndex })
        return { success: true, message: 'Dragged browser control.' }
      }
      case 'input_text': await locator.fill(args.text); return { success: true, message: 'Filled browser control.' }
      case 'select_option': {
        await locator.selectOption({ label: args.text })
        return { success: true, message: 'Selected browser option.' }
      }
      default: return undefined
    }
  } finally {
    signal?.removeEventListener('abort', cancel)
    await disconnect
    if (!tab.contents.isDestroyed()) tab.contents.setBackgroundThrottling(throttled)
  }
}

/** Release only a debugger attachment owned by this controller. */
function detachTabDebugger(tab, clear) {
  tab.playwrightPage = undefined
  nativeMouseTabs.delete(tab)
  const contents = tab.contents
  const owned = tab.cdp.owned
  tab.cdp.owned = false
  tab.cdp.persistent = false
  tab.cdp.raw = false
  if (clear) {
    tab.cdp.events = []
    tab.cdp.bytes = 0
  }
  if (!owned || contents.isDestroyed()) return
  const devtools = contents.debugger
  if (!devtools.isAttached()) return
  try {
    devtools.detach()
  } catch {}
}

/** Retain a bounded, tab-local event stream without cross-target domains. */
function recordCdpEvent(tab, method, params) {
  if (!tab.cdp.owned || !tab.cdp.persistent || typeof method !== 'string' || !CDP_METHOD.test(method)
    || CROSS_TARGET_CDP_DOMAINS.has(method.slice(0, method.indexOf('.')))
    || typeof params !== 'object' || params === null || Array.isArray(params)) return
  const sequence = tab.cdp.nextSequence++
  const event = { sequence, method, params, receivedAt: new Date().toISOString() }
  let bytes
  try {
    bytes = Buffer.byteLength(JSON.stringify(event), 'utf8')
  } catch {
    return
  }
  if (bytes > MAX_CDP_EVENT_BYTES) return
  tab.cdp.events.push({ ...event, bytes })
  tab.cdp.bytes += bytes
  while (tab.cdp.events.length > MAX_CDP_EVENT_ENTRIES || tab.cdp.bytes > MAX_CDP_EVENT_RING_BYTES) {
    tab.cdp.bytes -= tab.cdp.events.shift().bytes
  }
}

function reloadFrame(frame) {
  return new Promise((resolve) => {
    const ready = () => { resolve() }
    frame.once('dom-ready', ready)
    if (frame.reload()) return
    frame.removeListener('dom-ready', ready)
    resolve()
  })
}

/** Destroy documents holding media tracks before a new block is acknowledged. */
async function revokeMediaForOrigin(origin) {
  await Promise.all(Array.from(tabs.values(), async (tab) => {
    const contents = tab.view.webContents
    if (contents.isDestroyed()) return
    await Promise.all(contents.mainFrame.framesInSubtree.map(async (frame) => {
      if (frame.detached || frame.origin !== origin) return
      await reloadFrame(frame)
    }))
  }))
}

function siteNavigationBlocked(targetUrl) {
  const origin = canonicalOrigin(targetUrl)
  return origin !== undefined && profileStore.sites[origin]?.access === 'block'
}

/** Decide one cross-origin navigation at the Electron boundary. */
const approvedNavigations = new WeakMap()

function navigationPolicy(contents, targetUrl) {
  if (targetUrl === 'about:blank') return true
  const origin = canonicalOrigin(targetUrl)
  if (origin === undefined) return false
  const approval = approvedNavigations.get(contents)
  if (approval?.user === true) return true
  if (nativeSettings.navigationPolicy === 'block') return false
  const existing = profileStore.sites[origin]
  if (siteNavigationBlocked(targetUrl)) return false
  if (approval?.url === new URL(targetUrl).href) return true
  if (canonicalOrigin(contents.getURL()) === origin) return true
  const policy = existing?.access ?? nativeSettings.navigationPolicy
  if (policy === 'allow') return true
  if (policy === 'block' || window === undefined || windowClosing) return false
  return undefined
}

/** User browsing lasts until the next agent command; Host approval covers only its exact URL. */
async function loadAllowedUrl(contents, targetUrl, navigationApproved = false, signal) {
  signal?.throwIfAborted()
  let approval = navigationApproved === 'user'
    ? { user: true }
    : navigationApproved === true ? { url: new URL(targetUrl).href } : undefined
  if (approval === undefined) approvedNavigations.delete(contents)
  else approvedNavigations.set(contents, approval)
  try {
    const allowed = navigationPolicy(contents, targetUrl)
    if (allowed === false || (allowed === undefined && !await requestPermission(contents, 'navigation', canonicalOrigin(targetUrl)))) {
      throw new Error(`navigation to ${targetUrl} was blocked by Browser settings`)
    }
    if (allowed === undefined) {
      approval = { url: new URL(targetUrl).href }
      approvedNavigations.set(contents, approval)
    }
    signal?.throwIfAborted()
    let settled = false
    let timer
    const ready = new Promise((resolve, reject) => {
      const finish = error => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        contents.removeListener('dom-ready', onReady)
        contents.removeListener('did-fail-load', onFailed)
        contents.removeListener('did-fail-provisional-load', onFailed)
        contents.removeListener('destroyed', onDestroyed)
        contents.removeListener('render-process-gone', onDestroyed)
        signal?.removeEventListener('abort', onAborted)
        if (error === undefined) resolve()
        else reject(error)
      }
      const onReady = () => finish()
      const onFailed = (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (isMainFrame) finish(new Error(`navigation could not load ${validatedURL}: ${errorDescription} (${errorCode})`))
      }
      const onDestroyed = () => finish(new Error('browser tab closed during navigation'))
      const onAborted = () => { contents.stop(); finish(signal.reason) }
      timer = setTimeout(() => finish(new Error(`navigation to ${targetUrl} did not become ready within ${READINESS_TIMEOUT_MS}ms`)), READINESS_TIMEOUT_MS)
      contents.once('dom-ready', onReady)
      contents.on('did-fail-load', onFailed)
      contents.on('did-fail-provisional-load', onFailed)
      contents.once('destroyed', onDestroyed)
      contents.once('render-process-gone', onDestroyed)
      signal?.addEventListener('abort', onAborted, { once: true })
    })
    await Promise.race([contents.loadURL(targetUrl), ready])
  } finally {
    if (approval?.user !== true && approvedNavigations.get(contents) === approval) approvedNavigations.delete(contents)
  }
}

function mediaPermissionAllowed(contents, origin) {
  if (!isControlledContents(contents)) return false
  const normalized = canonicalOrigin(origin)
  if (normalized === undefined) return false
  const existing = profileStore.sites[normalized]
  if (existing?.media === 'allow') return true
  if (existing?.media === 'block' || window === undefined || windowClosing) return false
  return undefined
}

const pendingPermissions = new Map()
let nextPermissionId = 0

/** Pending decisions belong to the initiating document and never survive its replacement. */
function cancelPermissions(contents) {
  for (const [id, pending] of pendingPermissions) {
    if (contents !== undefined && pending.contents !== contents) continue
    pendingPermissions.delete(id)
    pending.resolve(undefined)
    send({ event: 'browser:permission-cancelled', id })
  }
}

async function requestPermission(contents, kind, origin, filename) {
  if (windowClosing || contents.isDestroyed() || !isControlledContents(contents) || typeof origin !== 'string') return false
  const sourceUrl = contents.getURL()
  const id = ++nextPermissionId
  const choice = await new Promise(resolve => {
    pendingPermissions.set(id, { contents, resolve })
    send({ event: 'browser:permission', id, request: { kind, origin, ...(filename === undefined ? {} : { filename }) } })
  })
  if (windowClosing || contents.isDestroyed() || contents.getURL() !== sourceUrl) return false
  if (kind === 'download') return choice === 'once' && nativeSettings.downloadPolicy !== 'block'
  const field = kind === 'navigation' ? 'access' : kind === 'media' ? 'media' : undefined
  const existing = profileStore.sites[origin]
  if (field !== undefined && existing?.[field] === 'block') return false
  if (kind === 'navigation' && navigationPolicy(contents, origin) === false) return false
  if (kind === 'media' && (choice === 'always' || choice === 'block')) {
    profileStore.sites[origin] = { access: 'block', media: 'block', ...existing, [field]: choice === 'always' ? 'allow' : 'block' }
    await persistProfileStore()
  }
  return choice === 'once' || choice === 'always'
}

function historyDestination(contents, offset) {
  const history = contents.navigationHistory
  return history.getEntryAtIndex(history.getActiveIndex() + offset)?.url
}

// navigate() resolves on dom-ready (see loadAllowedUrl) so Playwright can attach
// before the page finishes loading; that means a did-finish-load for it can still
// be queued when a later back()/forward() starts listening for its own. Waiting
// for a bare 'did-finish-load' can then resolve on that leftover event while the
// view is still on the old URL. Loop until the event we catch actually landed on
// the page we asked for.
async function waitForFinishedLoad(contents, targetUrl, signal) {
  for (;;) {
    await once(contents, 'did-finish-load', { signal })
    if (contents.getURL() === targetUrl) return
  }
}

function moveInHistory(contents, offset) {
  const targetUrl = historyDestination(contents, offset)
  if (targetUrl === undefined) return false
  approvedNavigations.set(contents, { user: true })
  contents.navigationHistory.goToIndex(contents.navigationHistory.getActiveIndex() + offset)
  return true
}

function reloadAllowed(contents, ignoreCache = false, userInput = true) {
  if (userInput) approvedNavigations.set(contents, { user: true })
  if (ignoreCache) contents.reloadIgnoringCache()
  else contents.reload()
  return true
}

/** Resolve an omnibox entry as an address when possible, otherwise a search. */
function resolveOmnibox(value) {
  try {
    const url = new URL(value)
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.href
  } catch {}
  if (/^(?:localhost|[^\s/.]+(?:\.[^\s/.]+)+)(?::\d+)?(?:[/?#].*)?$/u.test(value)) return `https://${value}`
  return `https://www.google.com/search?q=${encodeURIComponent(value)}`
}

/** Validate a user-opened app link and remove URL credentials before routing it. */
function routedHttpUrl(value) {
  if (typeof value !== 'string' || value.length > 2_048) return undefined
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    url.username = ''
    url.password = ''
    return url
  } catch {
    return undefined
  }
}

function isLoopbackUrl(url) {
  const host = url.hostname.toLowerCase()
  if (host === 'localhost' || host === '::1' || host === '[::1]') return true
  const octets = host.split('.')
  return octets.length === 4 && octets[0] === '127'
    && octets.every(octet => /^\d{1,3}$/u.test(octet) && Number(octet) <= 255)
}

/** Route a URL opened by the trusted desktop renderer, never a controlled page. */
async function routeUserUrl(value) {
  const url = routedHttpUrl(value)
  if (url === undefined) throw new Error('desktop Browser routing accepts only absolute HTTP(S) URLs')
  const destination = isLoopbackUrl(url) ? nativeSettings.localDestination : nativeSettings.webDestination
  if (destination === 'system') {
    await shell.openExternal(url.href)
    return { success: true, destination, url: url.href }
  }
  if (!createTab || !selectTab) throw new Error('tab controls are unavailable')
  const opened = createTab()
  selectTab(opened)
  try {
    await loadAllowedUrl(opened.view.webContents, url.href, 'user')
  } catch (error) {
    if (tabs.size > 1 && closeTab) closeTab(opened)
    throw error
  }
  embedded?.openBrowser?.()
  return { success: true, destination, url: opened.view.webContents.getURL() }
}

function isProfileManagement(method) {
  return method === 'configure_browser'
    || method === 'clear_browser_data'
    || method.startsWith('autofill_')
    || method === 'browser_history'
    || method === 'search_browser_history'
    || method === 'remove_browser_history'
    || method === 'browser_downloads'
    || method === 'remove_browser_download'
    || method === 'open_browser_download'
    || method === 'browser_sites'
    || method === 'set_browser_site'
    || method === 'remove_browser_site'
    || method === 'route_user_url'
    || method === 'get_page_identity'
    || method === 'page_agent_llm_response'
}

function agentChromeActivity(method, args) {
  switch (method) {
    case 'click_element':
      return typeof args.index === 'number' ? `Hydra: Click [${args.index}]` : `Hydra: Click ${args.name ?? 'element'}`
    case 'input_text':
      return typeof args.index === 'number' ? `Hydra: Type into [${args.index}]` : `Hydra: Type into ${args.name ?? 'field'}`
    case 'select_option':
      return typeof args.index === 'number' ? `Hydra: Select in [${args.index}]` : `Hydra: Select ${args.name ?? 'option'}`
    case 'fill_fields':
      return 'Hydra: Fill form'
    case 'find_element':
      return `Hydra: Find ${args.query ?? 'control'}`
    case 'navigate':
      return 'Hydra: Navigate'
    case 'back':
      return 'Hydra: Back'
    case 'forward':
      return 'Hydra: Forward'
    case 'scroll':
    case 'scroll_horizontally':
      return 'Hydra: Scroll'
    case 'press':
      return `Hydra: Press ${args.key}`
    case 'wait':
      return 'Hydra: Wait'
    case 'open_new_tab':
      return 'Hydra: Open tab'
    case 'switch_to_tab':
      return 'Hydra: Switch tab'
    case 'close_tab':
      return 'Hydra: Close tab'
    case 'upload_file':
      return typeof args.index === 'number' ? `Hydra: Upload through [${args.index}]` : 'Hydra: Upload file'
    case 'page_agent_run':
      return 'Hydra: PageAgent'
    case 'page_agent_stop':
      return 'Hydra: Stop PageAgent'
    default:
      return `Hydra: ${method}`
  }
}

/** Reopen a controlled tab after the user closed the last one. */
function ensureTab() {
  if (tabs.size > 0) return activeTab
  if (!createTab || !selectTab) return undefined
  selectTab(createTab())
  return activeTab
}

function noteAgentBrowser(method, args) {
  if (isProfileManagement(method)) return
  if (!agentBrowserRevealed) {
    agentBrowserRevealed = true
    embedded?.openBrowser?.()
  }
  if (
    method === 'get_browser_state'
    || method === 'get_upload_target'
    || method === 'get_cdp_target'
    || method === 'browser_screenshot'
    || method === 'cdp_command'
    || method === 'cdp_read_events'
  ) {
    return
  }
  chromeActivity = agentChromeActivity(method, args)
  updateChrome()
}

/**
 * Validate the renderer-owned native chrome palette before it crosses into CSS.
 * @param {unknown} value - `{ colorScheme, colors }` or null to follow the OS.
 * @returns {{ colorScheme: 'light'|'dark', colors: Record<string, string> } | null}
 */
function validateChromeTheme(value) {
  if (value === null) return null
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('browser theme must be an object or null')
  }
  const source = /** @type {Record<string, unknown>} */ (value)
  if (Object.keys(source).length !== 2 || !('colorScheme' in source) || !('colors' in source)) {
    throw new Error('browser theme must contain only colorScheme and colors')
  }
  if (source.colorScheme !== 'light' && source.colorScheme !== 'dark') {
    throw new Error('browser theme colorScheme must be light or dark')
  }
  if (typeof source.colors !== 'object' || source.colors === null || Array.isArray(source.colors)) {
    throw new Error('browser theme colors must be an object')
  }
  const colors = /** @type {Record<string, unknown>} */ (source.colors)
  if (Object.keys(colors).length !== CHROME_THEME_COLOR_FIELDS.length
    || CHROME_THEME_COLOR_FIELDS.some(field => !Object.hasOwn(colors, field))) {
    throw new Error('browser theme colors contain an unsupported field')
  }
  const validated = {}
  for (const field of CHROME_THEME_COLOR_FIELDS) {
    const color = colors[field]
    if (typeof color !== 'string' || color.length === 0 || color.length > 256) {
      throw new Error(`browser theme color ${field} must be a non-empty string of 256 characters or fewer`)
    }
    validated[field] = color
  }
  return { colorScheme: source.colorScheme, colors: validated }
}

/** Persist and publish the embedded chrome palette. */
function setChromeTheme(value) {
  chromeThemeOverride = validateChromeTheme(value)
  updateChrome()
}

/** Keep the native browser chrome in sync with every tab and the selected page. */
function updateChrome() {
  if (windowClosing) return
  // No selected tab is a real state: the user closed the last one.
  const contents = activeTab?.view.webContents
  if (activeTab !== undefined && (contents === undefined || contents.isDestroyed())) return
  const url = contents?.getURL() ?? ''
  const bookmarks = listBookmarks()
  chromeState = {
    tabs: Array.from(tabs.values(), tab => ({
      id: tab.id,
      title: tab.view.webContents.getTitle() || 'New Tab',
      favicon: tab.favicon ?? '',
      isAudible: tab.view.webContents.isCurrentlyAudible(),
      isMuted: tab.view.webContents.isAudioMuted(),
      isLoading: tab.view.webContents.isLoading(),
    })),
    activeTabId: activeTab?.id ?? 0,
    url,
    canGoBack: contents?.navigationHistory.canGoBack() ?? false,
    canGoForward: contents?.navigationHistory.canGoForward() ?? false,
    history: profileStore.history.slice(0, MAX_HISTORY_SEARCH_RESULTS)
      .map(({ title, url: entryUrl }) => ({ title, url: entryUrl })),
    bookmarks,
    isBookmarked: isBookmarked(url),
    zoomPercent: Math.round((contents?.getZoomFactor() ?? 1) * 100),
    annotationEnabled: annotationEnabledFor(activeTab),
    loading: contents?.isLoading() ?? false,
    secure: url.startsWith('https:'),
    theme: chromeThemeOverride?.colorScheme ?? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light'),
    themeColors: chromeThemeOverride?.colors ?? null,
    activity: chromeActivity,
  }
  if (embedded !== undefined) embedded.onState(chromeState)
  if (chrome !== undefined && !chrome.webContents.isDestroyed()) {
    chrome.webContents.send('browser-chrome:update', chromeState)
  }
}

/**
 * Fail every in-flight page call for one tab. That tab's preload can no longer
 * settle them, while calls in other tabs remain valid.
 * @param {Tab} tab - tab whose calls must reject.
 * @param {string} reason - what happened, surfaced to the caller.
 */
function abortPageCalls(tab, reason) {
  for (const [id, pending] of pendingPageCalls) {
    if (pending.tab !== tab) continue
    pending.reject(new Error(reason))
    pendingPageCalls.delete(id)
  }
}

/** Reject model requests whose isolated-world document no longer exists. */
function abortPageAgentLlmCalls(tab, reason) {
  for (const [id, pending] of pendingPageAgentLlmCalls) {
    if (pending.tab !== tab) continue
    pending.reject(new Error(reason))
    pendingPageAgentLlmCalls.delete(id)
  }
}

/** Ask the owning Hydra process to run one PageAgent model step. */
function pageAgentLlm(tab, request) {
  return new Promise((resolve, reject) => {
    const id = nextPageAgentLlmCallId++
    pendingPageAgentLlmCalls.set(id, { resolve, reject, tab })
    send({ event: 'page-agent:llm', id, tabId: tab.id, request })
  })
}

/**
 * Forward one action to the preload after committing a new tab's blank document.
 * @param {Tab} tab - tab whose preload owns the request.
 * @param {string} action - action name the preload's dispatch understands.
 * @param {Record<string, unknown>} args - JSON-safe action arguments.
 * @returns {Promise<unknown>} the preload's JSON-safe result.
 */
async function pageControl(tab, action, args) {
  const contents = tab.view.webContents
  // A fresh WebContentsView has no preload listener until its first document loads.
  if (contents.getURL() === '' && !contents.isLoading()) {
    await contents.loadURL('about:blank')
  }
  if (!tab.preloadReady || contents.isLoadingMainFrame()) {
    await new Promise((resolve, reject) => {
      let settled = false
      const finish = error => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        contents.removeListener('dom-ready', ready)
        contents.removeListener('did-stop-loading', stopped)
        contents.removeListener('did-fail-load', failed)
        contents.removeListener('destroyed', destroyed)
        contents.removeListener('render-process-gone', destroyed)
        if (error === undefined) resolve()
        else reject(error)
      }
      const ready = () => finish()
      const stopped = () => { if (tab.preloadReady) finish() }
      const destroyed = () => finish(new Error('page preload became unavailable before it was ready'))
      const failed = (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (isMainFrame) finish(new Error(`page preload could not load ${validatedURL}: ${errorDescription} (${errorCode})`))
      }
      const timer = setTimeout(() => finish(new Error('page preload did not become ready before navigation timed out')), READINESS_TIMEOUT_MS)
      contents.once('dom-ready', ready)
      contents.once('did-stop-loading', stopped)
      contents.on('did-fail-load', failed)
      contents.once('destroyed', destroyed)
      contents.once('render-process-gone', destroyed)
    })
  }
  return await new Promise((resolve, reject) => {
    const id = nextPageCallId++
    const timer = setTimeout(() => {
      pendingPageCalls.delete(id)
      reject(new Error(`page preload did not answer ${action} within ${READINESS_TIMEOUT_MS}ms`))
    }, READINESS_TIMEOUT_MS)
    const pending = {
      tab,
      resolve(value) { clearTimeout(timer); resolve(value) },
      reject(error) { clearTimeout(timer); reject(error) },
    }
    pendingPageCalls.set(id, pending)
    try {
      contents.send('page-control', { id, action, args })
    } catch (error) {
      pendingPageCalls.delete(id)
      pending.reject(error)
    }
  })
}

/** Cancel a manual picker without exposing the private preload channel. */
function cancelAnnotation(tab) {
  if (!tab.contents.isDestroyed()) tab.contents.send('page-annotation:cancel')
}

/** Validate and bound page-owned annotation data before it reaches the app renderer. */
function annotationOf(value) {
  if (typeof value !== 'object' || value === null
    || (value.kind !== 'browser-element' && value.kind !== 'browser-region')
    || typeof value.url !== 'string' || typeof value.title !== 'string' || typeof value.preview !== 'string') return undefined
  if (value.url.length > 2_048 || annotationPageUrl(value.url) !== value.url
    || value.title.length > 160 || value.preview.length > 1_024) return undefined
  if (value.index !== undefined && (!Number.isInteger(value.index) || value.index < 0)) return undefined
  let rect
  if (value.rect !== undefined) {
    if (typeof value.rect !== 'object' || value.rect === null) return undefined
    const { x, y, width, height } = value.rect
    if (![x, y, width, height].every(Number.isSafeInteger)
      || x < 0 || y < 0 || width < 1 || height < 1 || width > 10_000 || height > 10_000) return undefined
    rect = { x, y, width, height }
  }
  if (value.kind === 'browser-region' && (value.index !== undefined || rect === undefined)) return undefined
  return {
    kind: value.kind,
    url: value.url,
    title: value.title,
    preview: value.preview,
    ...(value.index === undefined ? {} : { index: value.index }),
    ...(rect === undefined ? {} : { rect }),
  }
}

/**
 * Copy pixels from the renderer when the OS compositor has no display surface.
 * @param {Electron.WebContents} contents
 * @param {{ x: number, y: number, width: number, height: number } | undefined} rect
 * @returns {Promise<Electron.NativeImage | undefined>}
 */
async function captureViaCdp(contents, rect, captureBeyondViewport = false, scale = undefined) {
  const debug = contents.debugger
  const attached = debug.isAttached()
  try {
    if (!attached) debug.attach('1.3')
    const params = { format: 'png', fromSurface: captureBeyondViewport, captureBeyondViewport }
    if (rect !== undefined) {
      params.clip = {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        scale: scale ?? 1,
      }
    }
    if (rect === undefined && scale !== undefined) params.captureBeyondViewport = true
    const result = await debug.sendCommand('Page.captureScreenshot', params)
    if (typeof result?.data !== 'string' || result.data.length === 0) return undefined
    const image = nativeImage.createFromBuffer(Buffer.from(result.data, 'base64'))
    return image.isEmpty() ? undefined : image
  } catch {
    // Renderer screenshot is a fallback when the OS compositor has no surface.
    return undefined
  } finally {
    if (!attached && debug.isAttached()) {
      try {
        debug.detach()
      } catch {
        // The tab closed before the fallback debugger could detach.
      }
    }
  }
}

/** Capture one viewport/region as a bounded PNG; callers decide whether refusal is fatal. */
async function pageContentRect(contents) {
  const debug = contents.debugger
  const attached = debug.isAttached()
  try {
    if (!attached) debug.attach('1.3')
    const metrics = await debug.sendCommand('Page.getLayoutMetrics')
    const size = metrics?.cssContentSize ?? metrics?.contentSize
    if (!size || !Number.isFinite(size.width) || !Number.isFinite(size.height)
      || size.width < 1 || size.height < 1 || size.width > 100_000 || size.height > 100_000) {
      throw new Error('page content bounds are unavailable or too large')
    }
    return { x: 0, y: 0, width: Math.ceil(size.width), height: Math.ceil(size.height) }
  } finally {
    if (!attached && debug.isAttached()) {
      try { debug.detach() } catch {}
    }
  }
}

async function boundedPng(contents, rect, fullPage = false) {
  if (fullPage) {
    const fullRect = rect ?? await pageContentRect(contents)
    const scale = Math.min(1, MAX_SCREENSHOT_EDGE / Math.max(fullRect.width, fullRect.height))
    let image = await captureViaCdp(contents, fullRect, true, scale)
    if (image === undefined || image.isEmpty()) return undefined
    let size = image.getSize()
    if (Math.max(size.width, size.height) > MAX_SCREENSHOT_EDGE) {
      const resizeScale = MAX_SCREENSHOT_EDGE / Math.max(size.width, size.height)
      image = image.resize({ width: Math.max(1, Math.round(size.width * resizeScale)), height: Math.max(1, Math.round(size.height * resizeScale)) })
      size = image.getSize()
    }
    const png = image.toPNG()
    if (png.length > MAX_SCREENSHOT_BYTES) return undefined
    return { data: png.toString('base64'), bytes: png.length, width: size.width, height: size.height }
  }
  const capture = stayHidden => (rect === undefined
    ? contents.capturePage({ stayHidden })
    : contents.capturePage(rect, { stayHidden }))
  let image
  try {
    image = await capture(false)
  } catch {
    // Hidden WebContentsView has no compositor surface until a shown capture.
  }
  if (image === undefined || image.isEmpty()) {
    try {
      image = await capture(true)
    } catch {
      // stayHidden copy can miss the same absent surface; retry from the renderer.
    }
  }
  if (image === undefined || image.isEmpty()) {
    image = await captureViaCdp(contents, rect)
  }
  if (image === undefined || image.isEmpty()) return undefined
  let size = image.getSize()
  if (Math.max(size.width, size.height) > MAX_SCREENSHOT_EDGE) {
    const scale = MAX_SCREENSHOT_EDGE / Math.max(size.width, size.height)
    image = image.resize({
      width: Math.max(1, Math.round(size.width * scale)),
      height: Math.max(1, Math.round(size.height * scale)),
    })
    size = image.getSize()
  }
  const png = image.toPNG()
  if (png.length > MAX_SCREENSHOT_BYTES) return undefined
  return { data: png.toString('base64'), bytes: png.length, width: size.width, height: size.height }
}

async function annotationScreenshot(contents, rect) {
  if (rect === undefined) return undefined
  const screenshot = await boundedPng(contents, rect)
  return screenshot === undefined ? undefined : { mediaType: 'image/png', data: screenshot.data }
}

/** Insert one selected element or region into the desktop's main composer. */
async function publishAnnotation(tab, action, args) {
  try {
    const selected = annotationOf(await pageControl(tab, action, args))
    if (selected === undefined || activeTab !== tab) return
    const contents = tab.view.webContents
    const expectedOrigin = canonicalOrigin(selected.url)
    if (contents.isDestroyed() || annotationPageUrl(contents.getURL()) !== selected.url) return
    let includeScreenshot = nativeSettings.annotationScreenshots === 'include'
    if (nativeSettings.annotationScreenshots === 'ask' && window !== undefined && !windowClosing) {
      const target = selected.kind === 'browser-region' ? 'page region' : 'page element'
      includeScreenshot = dialog.showMessageBoxSync(window, {
        type: 'question',
        title: 'Include annotation screenshot?',
        message: `Attach a screenshot of the selected ${target}?`,
        detail: `Page: ${expectedOrigin}`,
        buttons: ['Include screenshot', 'Text only'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      }) === 0
    }
    let screenshot
    if (includeScreenshot) {
      try {
        screenshot = await annotationScreenshot(contents, selected.rect)
      } catch (error) {
        log('annotation screenshot failed:', error)
      }
    }
    if (activeTab !== tab || contents.isDestroyed() || annotationPageUrl(contents.getURL()) !== selected.url) return
    embedded?.onAnnotation?.({ ...selected, ...(screenshot === undefined ? {} : { screenshot }) })
  } catch (error) {
    if (!isNavigationInterruption(error)) log('annotation failed:', error)
  }
}

function stillOnOrigin(tab, origin) {
  const contents = tab.view.webContents
  return activeTab === tab && tabs.has(tab.id) && !contents.isDestroyed() && httpOrigin(contents.getURL()) === origin
}

function autofillMenuLabel(value, fallback) {
  if (typeof value !== 'string') return fallback
  return value.replace(/\s+/gu, ' ').trim().slice(0, 160) || fallback
}

async function fillSavedLogin(tab, origin, id, point) {
  if (!stillOnOrigin(tab, origin)) return
  try {
    const login = await useAutofillVault(vault => vault.resolveLogin(id))
    if (login === undefined || login.origin !== origin || !stillOnOrigin(tab, origin)) return
    await pageControl(tab, 'autofill_login', {
      expectedOrigin: origin,
      username: login.username,
      password: login.password,
      ...point,
    })
  } catch (error) {
    if (!isNavigationInterruption(error)) log('saved login could not be filled')
  }
}

async function fillSavedContact(tab, origin, id, point) {
  if (!stillOnOrigin(tab, origin) || window === undefined || windowClosing) return
  const confirmed = dialog.showMessageBoxSync(window, {
    type: 'question',
    title: 'Fill contact information?',
    message: `Fill saved contact information on ${origin}?`,
    detail: 'Only fields with standard autocomplete labels will be filled.',
    buttons: ['Fill contact', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  }) === 0
  if (!confirmed || !stillOnOrigin(tab, origin)) return
  try {
    const contact = await useAutofillVault(vault => vault.resolveContact(id))
    if (contact === undefined || !stillOnOrigin(tab, origin)) return
    await pageControl(tab, 'autofill_contact', {
      expectedOrigin: origin,
      fields: contact.fields,
      ...point,
    })
  } catch (error) {
    if (!isNavigationInterruption(error)) log('saved contact could not be filled')
  }
}

/** Native page menu matching the desktop browser controls. */
async function openPageMenu(tab, params) {
  if (activeTab !== tab || windowClosing) return
  const contents = tab.view.webContents
  const origin = httpOrigin(contents.getURL())
  const point = Number.isFinite(params.x) && Number.isFinite(params.y) ? { x: params.x, y: params.y } : {}
  let logins = []
  let contacts = []
  if (origin !== undefined && autofillVault !== undefined) {
    try {
      [logins, contacts] = await Promise.all([
        useAutofillVault(vault => vault.listLogins()),
        useAutofillVault(vault => vault.listContacts()),
      ])
    } catch {
      logins = []
      contacts = []
    }
  }
  if (activeTab !== tab || contents.isDestroyed()
    || (origin !== undefined && httpOrigin(contents.getURL()) !== origin)) return

  const matchingLogins = logins.filter(login => login.origin === origin)
  const unavailableLabel = autofillVault === undefined ? 'Secure autofill storage unavailable' : undefined
  const history = contents.navigationHistory
  const annotationEnabled = annotationEnabledFor(tab)

  const template = []

  // Link context
  if (params.linkURL) {
    template.push(
      {
        label: 'Open link in new tab',
        click: () => {
          const opened = createTab?.()
          if (opened && selectTab) {
            selectTab(opened)
            void loadAllowedUrl(opened.view.webContents, params.linkURL, 'user')
          }
        },
      },
      {
        label: 'Copy link address',
        click: () => { clipboard.writeText(params.linkURL) },
      },
      { type: 'separator' },
    )
  }

  // Media/Image context
  if (params.mediaType === 'image' && params.srcURL) {
    template.push(
      {
        label: 'Open image in new tab',
        click: () => {
          const opened = createTab?.()
          if (opened && selectTab) {
            selectTab(opened)
            void loadAllowedUrl(opened.view.webContents, params.srcURL, 'user')
          }
        },
      },
      {
        label: 'Save image as...',
        click: () => { contents.downloadURL(params.srcURL) },
      },
      {
        label: 'Copy image address',
        click: () => { clipboard.writeText(params.srcURL) },
      },
      { type: 'separator' },
    )
  }

  // Text selection context
  if (params.selectionText) {
    const trimmed = params.selectionText.trim()
    template.push(
      { label: 'Copy', role: 'copy' },
      {
        label: `Search Google for "${trimmed.length > 25 ? `${trimmed.slice(0, 25)}…` : trimmed}"`,
        click: () => {
          const opened = createTab?.()
          if (opened && selectTab) {
            selectTab(opened)
            void loadAllowedUrl(opened.view.webContents, `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`, 'user')
          }
        },
      },
      { type: 'separator' },
    )
  }

  // Autofill
  if (origin !== undefined) {
    template.push(
      {
        label: 'Autofill login',
        enabled: origin !== undefined,
        submenu: matchingLogins.length > 0
          ? matchingLogins.map(login => ({
              label: autofillMenuLabel(login.username, 'Saved login'),
              click: () => { void fillSavedLogin(tab, origin, login.id, point) },
            }))
          : [{ label: unavailableLabel ?? 'No saved login for this site', enabled: false }],
      },
      {
        label: 'Autofill contact',
        enabled: origin !== undefined,
        submenu: contacts.length > 0
          ? contacts.map(contact => ({
              label: autofillMenuLabel(contact.label, 'Saved contact'),
              click: () => { void fillSavedContact(tab, origin, contact.id, point) },
            }))
          : [{ label: unavailableLabel ?? 'No saved contacts', enabled: false }],
      },
      { type: 'separator' },
    )
  }

  // Annotations
  if (annotationEnabled) {
    template.push(
      {
        label: 'Quick annotate',
        enabled: annotationEnabled,
        click: () => { void publishAnnotation(tab, 'annotate_element_at', { x: params.x, y: params.y }) },
      },
      {
        label: 'Annotate',
        enabled: annotationEnabled,
        click: () => { void publishAnnotation(tab, 'annotate_element', {}) },
      },
      { type: 'separator' },
    )
  }

  // Navigation & Page Tools
  template.push(
    { label: 'Back', enabled: history.canGoBack(), click: () => { moveInHistory(contents, -1) } },
    { label: 'Forward', enabled: history.canGoForward(), click: () => { moveInHistory(contents, 1) } },
    { label: 'Reload', click: () => { reloadAllowed(contents) } },
    { type: 'separator' },
    {
      label: 'View page source',
      click: () => {
        const opened = createTab?.()
        if (opened && selectTab) {
          selectTab(opened)
          void loadAllowedUrl(opened.view.webContents, `view-source:${contents.getURL()}`)
        }
      },
    },
    {
      label: 'Print...',
      click: () => { contents.print() },
    },
    { type: 'separator' },
    {
      label: 'Inspect',
      click: () => {
        contents.openDevTools({ mode: 'detach' })
        contents.inspectElement(params.x, params.y)
      },
    },
  )

  Menu.buildFromTemplate(template).popup({ window })
}

/** Context menu for browser tabs. */
function openTabMenu(tabId) {
  const tab = tabs.get(tabId)
  if (!tab || windowClosing) return
  const orderedTabs = Array.from(tabs.values())
  const index = orderedTabs.indexOf(tab)

  Menu.buildFromTemplate([
    {
      label: 'New tab',
      accelerator: 'CmdOrCtrl+T',
      click: () => { if (createTab && selectTab) selectTab(createTab()) },
    },
    {
      label: 'Reload tab',
      accelerator: 'CmdOrCtrl+R',
      click: () => { reloadAllowed(tab.view.webContents) },
    },
    {
      label: 'Duplicate tab',
      click: () => {
        if (createTab && selectTab) {
          const dup = createTab()
          selectTab(dup)
          void loadAllowedUrl(dup.view.webContents, tab.view.webContents.getURL(), 'user')
        }
      },
    },
    {
      label: tab.view.webContents.isAudioMuted() ? 'Unmute tab' : 'Mute tab',
      click: () => {
        tab.view.webContents.setAudioMuted(!tab.view.webContents.isAudioMuted())
        updateChrome()
      },
    },
    { type: 'separator' },
    {
      label: 'Close tab',
      accelerator: 'CmdOrCtrl+W',
      click: () => { closeTab?.(tab) },
    },
    {
      label: 'Close other tabs',
      enabled: tabs.size > 1,
      click: () => {
        for (const other of orderedTabs) {
          if (other !== tab) closeTab?.(other)
        }
      },
    },
    {
      label: 'Close tabs to the right',
      enabled: index < orderedTabs.length - 1,
      click: () => {
        for (let i = index + 1; i < orderedTabs.length; i++) {
          closeTab?.(orderedTabs[i])
        }
      },
    },
  ]).popup({ window })
}

/** Chrome menu (three dots ⋮). */
function openChromeMenu() {
  if (windowClosing) return
  const contents = activeTab?.view.webContents

  Menu.buildFromTemplate([
    {
      label: 'New tab',
      accelerator: 'CmdOrCtrl+T',
      click: () => { if (createTab && selectTab) selectTab(createTab()) },
    },
    { type: 'separator' },
    {
      label: 'Bookmarks',
      submenu: [
        {
          label: 'Bookmark this tab...',
          accelerator: 'CmdOrCtrl+D',
          enabled: activeTab !== undefined,
          click: () => {
            if (activeTab) {
              const url = activeTab.view.webContents.getURL()
              if (!isBookmarked(url)) {
                void addBookmark({ url, title: activeTab.view.webContents.getTitle(), favicon: activeTab.favicon })
              }
            }
          },
        },
        ...(profileStore.bookmarks.length > 0 ? [
          { type: 'separator' },
          ...profileStore.bookmarks.slice(0, 15).map(bm => ({
            label: bm.title || bm.url,
            click: () => {
              if (activeTab) void loadAllowedUrl(activeTab.view.webContents, bm.url, 'user')
            },
          })),
        ] : []),
      ],
    },
    {
      label: 'History',
      accelerator: 'CmdOrCtrl+H',
      submenu: [
        {
          label: 'Clear browsing data...',
          click: () => {
            void handle('clear_browser_data', { scope: 'all' })
          },
        },
        ...(profileStore.history.length > 0 ? [
          { type: 'separator' },
          ...profileStore.history.slice(0, 15).map(h => ({
            label: h.title || h.url,
            click: () => {
              if (activeTab) void loadAllowedUrl(activeTab.view.webContents, h.url, 'user')
            },
          })),
        ] : []),
      ],
    },
    {
      label: 'Downloads',
      accelerator: 'CmdOrCtrl+J',
      submenu: profileStore.downloads.length > 0
        ? profileStore.downloads.slice(0, 10).map(d => ({
            label: `${d.filename} (${d.state})`,
            click: () => { if (d.path) void shell.showItemInFolder(d.path) },
          }))
        : [{ label: 'No recent downloads', enabled: false }],
    },
    { type: 'separator' },
    {
      label: 'Zoom',
      submenu: [
        {
          label: 'Zoom In (+)',
          accelerator: 'CmdOrCtrl+Plus',
          click: () => {
            if (contents) {
              contents.setZoomFactor(Math.min(3, contents.getZoomFactor() + 0.1))
              updateChrome()
            }
          },
        },
        {
          label: 'Zoom Out (-)',
          accelerator: 'CmdOrCtrl+-',
          click: () => {
            if (contents) {
              contents.setZoomFactor(Math.max(0.3, contents.getZoomFactor() - 0.1))
              updateChrome()
            }
          },
        },
        {
          label: 'Reset Zoom (100%)',
          accelerator: 'CmdOrCtrl+0',
          click: () => {
            if (contents) {
              contents.setZoomFactor(1)
              updateChrome()
            }
          },
        },
      ],
    },
    {
      label: 'Find in page...',
      accelerator: 'CmdOrCtrl+F',
      click: () => { chrome?.webContents.send('browser-chrome:show-find') },
    },
    {
      label: 'Print...',
      accelerator: 'CmdOrCtrl+P',
      enabled: activeTab !== undefined,
      click: () => { contents?.print() },
    },
    { type: 'separator' },
    {
      label: 'Developer tools',
      accelerator: 'F12',
      click: () => {
        if (contents) {
          if (contents.isDevToolsOpened()) contents.closeDevTools()
          else contents.openDevTools({ mode: 'detach' })
        }
      },
    },
    {
      label: 'View source',
      enabled: activeTab !== undefined,
      click: () => {
        if (contents) {
          const opened = createTab?.()
          if (opened && selectTab) {
            selectTab(opened)
            void loadAllowedUrl(opened.view.webContents, `view-source:${contents.getURL()}`)
          }
        }
      },
    },
  ]).popup({ window })
}

/** Standard keyboard shortcuts across browser views. */
function handleKeyboardShortcuts(event, input, tab) {
  if (input.type !== 'keyDown') return
  const isCtrlOrCmd = process.platform === 'darwin' ? input.meta : input.control

  if (input.key === 'F12') {
    event.preventDefault()
    const target = tab?.view.webContents ?? activeTab?.view.webContents
    if (target) {
      if (target.isDevToolsOpened()) target.closeDevTools()
      else target.openDevTools({ mode: 'detach' })
    }
    return
  }

  if (input.key === 'F5') {
    event.preventDefault()
    const target = tab?.view.webContents ?? activeTab?.view.webContents
    if (target) {
      reloadAllowed(target, input.shift, activeBrowserCalls === 0)
    }
    return
  }

  if (!isCtrlOrCmd) return

  const key = input.key.toLowerCase()
  if (key === 't' && !input.shift && !input.alt) {
    event.preventDefault()
    if (createTab && selectTab) selectTab(createTab())
  } else if (key === 'w' && !input.shift && !input.alt) {
    event.preventDefault()
    if (tab && closeTab) closeTab(tab)
    else if (activeTab && closeTab) closeTab(activeTab)
  } else if (key === 'r' && !input.shift && !input.alt) {
    event.preventDefault()
    const target = tab?.view.webContents ?? activeTab?.view.webContents
    if (target) reloadAllowed(target, false, activeBrowserCalls === 0)
  } else if (key === 'r' && input.shift && !input.alt) {
    event.preventDefault()
    const target = tab?.view.webContents ?? activeTab?.view.webContents
    if (target) reloadAllowed(target, true, activeBrowserCalls === 0)
  } else if (key === 'f' && !input.shift && !input.alt) {
    event.preventDefault()
    chrome?.webContents.send('browser-chrome:show-find')
  } else if (key === 'l' && !input.shift && !input.alt) {
    event.preventDefault()
    chrome?.webContents.send('browser-chrome:focus-omnibox')
  } else if (key === 'd' && !input.shift && !input.alt) {
    event.preventDefault()
    const target = tab ?? activeTab
    if (target) {
      const url = target.view.webContents.getURL()
      if (isBookmarked(url)) void removeBookmark(url)
      else void addBookmark({ url, title: target.view.webContents.getTitle(), favicon: target.favicon })
    }
  } else if (key === 'i' && input.shift && !input.alt) {
    event.preventDefault()
    const target = tab?.view.webContents ?? activeTab?.view.webContents
    if (target) {
      if (target.isDevToolsOpened()) target.closeDevTools()
      else target.openDevTools({ mode: 'detach' })
    }
  } else if ((input.key === '=' || input.key === '+') && !input.alt) {
    event.preventDefault()
    const target = tab?.view.webContents ?? activeTab?.view.webContents
    if (target) {
      target.setZoomFactor(Math.min(3, target.getZoomFactor() + 0.1))
      updateChrome()
    }
  } else if (input.key === '-' && !input.alt) {
    event.preventDefault()
    const target = tab?.view.webContents ?? activeTab?.view.webContents
    if (target) {
      target.setZoomFactor(Math.max(0.3, target.getZoomFactor() - 0.1))
      updateChrome()
    }
  } else if (input.key === '0' && !input.alt) {
    event.preventDefault()
    const target = tab?.view.webContents ?? activeTab?.view.webContents
    if (target) {
      target.setZoomFactor(1)
      updateChrome()
    }
  } else if (input.key === 'Tab') {
    event.preventDefault()
    const tabList = Array.from(tabs.values())
    const current = tab ?? activeTab
    const idx = current ? tabList.indexOf(current) : -1
    if (idx !== -1 && tabList.length > 1) {
      const nextIdx = input.shift ? (idx - 1 + tabList.length) % tabList.length : (idx + 1) % tabList.length
      selectTab?.(tabList[nextIdx])
    }
  } else if (input.key >= '1' && input.key <= '9') {
    const num = Number(input.key)
    const tabList = Array.from(tabs.values())
    if (num <= tabList.length) {
      event.preventDefault()
      selectTab?.(tabList[num - 1])
    }
  }
}

/** Whether a page-control request was invalidated by a document/tab transition. */
function isNavigationInterruption(error) {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('page navigated away')
}

/** Whether PageController ran while Chromium had replaced the document body. */
function isTransientPageStateError(error) {
  const message = error instanceof Error ? error.message : String(error)
  return /^Cannot read properties of null \(reading '(?:scrollWidth|scrollHeight)'\)$/.test(message)
}

/** Current tab inventory, shared by structured output and the prompt header. */
function tabStates() {
  return Array.from(tabs.values(), tab => {
    const contents = tab.view.webContents
    return {
      id: tab.id,
      url: contents.getURL() || 'about:blank',
      title: contents.getTitle() || 'New Tab',
      status: contents.isLoadingMainFrame() ? 'loading' : 'complete',
      active: activeTab === tab,
    }
  })
}

/** Add browser-window evidence that PageController cannot observe by itself. */
function completeState(tab, state, settled, captured = true) {
  const inventory = tabStates()
  if (settled && captured) tab.settledState = state
  return {
    ...state,
    ...(downloadDenials.has(tab.view.webContents)
      ? { footer: `${state.footer}\n${downloadDenials.get(tab.view.webContents)}` } : {}),
    tabs: inventory,
    tabId: tab.id,
    activeTabId: activeTab?.id ?? tab.id,
    settled,
    capturedAt: new Date().toISOString(),
  }
}

/** A non-blank PageController observation, or the intentionally blank new tab. */
function isUsableState(state) {
  if (state.url === 'about:blank') return true
  return state.content.trim().length > 0 && state.content.trim() !== '<EMPTY>'
}

/**
 * Read one document, optionally following selected-tab changes and SPA/SSO
 * transitions until Chromium is idle and PageController exposes usable content.
 */
async function readBrowserState(tab, waitForReady, followActive, signal) {
  if (tab.dialog) {
    return completeState(tab, {
      ...(tab.lastState ?? { url: tab.contents.getURL(), title: tab.contents.getTitle(), header: '', content: '' }),
      footer: `Open ${tab.dialog.type} dialog: ${tab.dialog.message}. Use browser_handle_dialog to continue.`,
    }, false)
  }
  const deadline = Date.now() + READINESS_TIMEOUT_MS
  const observationId = randomUUID()
  let candidateSince
  let candidateSignature
  let lastState
  let lastTab = tab
  let lastError

  while (true) {
    signal?.throwIfAborted()
    const current = followActive ? activeTab ?? lastTab : lastTab
    if (current.view.webContents.isDestroyed()) throw new Error(`controlled tab [${current.id}] is unavailable`)
    lastTab = current
    try {
      const state = await pageControl(current, 'get_browser_state', {
        observationId,
        quietMs: Math.min(READINESS_POLL_MS, READINESS_TIMEOUT_MS),
        timeoutMs: Math.min(READINESS_SETTLE_MS, READINESS_TIMEOUT_MS),
      })
      signal?.throwIfAborted()
      current.lastState = state
      if (followActive && activeTab !== undefined && activeTab !== current) {
        candidateSince = undefined
        candidateSignature = undefined
        continue
      }
      lastState = state
      lastError = undefined
      const loading = current.view.webContents.isLoadingMainFrame()
      if (!waitForReady) return completeState(current, state, !loading && isUsableState(state))

      if (!loading && isUsableState(state)) {
        if (current.settledState?.url === state.url
          && current.settledState.title === state.title
          && current.settledState.content === state.content) {
          return completeState(current, state, true)
        }
        const signature = JSON.stringify([state.url, state.title, state.content])
        if (candidateSignature !== signature) {
          candidateSignature = signature
          candidateSince = Date.now()
        }
        if (Date.now() - candidateSince >= READINESS_SETTLE_MS) {
          return completeState(current, state, true)
        }
      } else {
        candidateSince = undefined
        candidateSignature = undefined
      }
    } catch (error) {
      if (!isNavigationInterruption(error) && !isTransientPageStateError(error)) throw error
      lastError = error
      candidateSince = undefined
      candidateSignature = undefined
    }

    if (Date.now() >= deadline) {
      if (lastState !== undefined) return completeState(lastTab, lastState, false)
      throw lastError ?? new Error('page readiness timed out before a document could be observed')
    }
    await delay(Math.min(READINESS_POLL_MS, Math.max(1, deadline - Date.now())), undefined, { signal })
  }
}

ipcMain.on('page-control:result', (event, reply) => {
  const settle = pendingPageCalls.get(reply.id)
  // A reply for an id we already abandoned (navigation, timeout) is expected.
  if (!settle || event.sender !== settle.tab.view.webContents) return
  pendingPageCalls.delete(reply.id)
  if (reply.ok) settle.resolve(reply.result)
  else settle.reject(new Error(reply.error))
})

/** The isolated PageAgent runtime may only reach the host through this bridge. */
ipcMain.handle('page-agent:llm', async (event, request) => {
  const tab = Array.from(tabs.values()).find(candidate => candidate.view.webContents === event.sender)
  if (!tab) throw new Error('PageAgent request did not originate from a controlled tab')
  return await pageAgentLlm(tab, request)
})

/** Serialize Chromium's accessibility tree, joined to the preload's action refs. */
async function readAccessibilitySnapshot(tab) {
  const devtools = tab.view.webContents.debugger
  const attached = ensureTabDebugger(tab, false)
  try {
    const document = await devtools.sendCommand('DOM.getDocument', { depth: -1, pierce: true })
    const refs = new Map()
    const visit = node => {
      const attrs = new Map()
      for (let i = 0; i < (node.attributes?.length ?? 0); i += 2) attrs.set(node.attributes[i], node.attributes[i + 1])
      const ref = attrs.get('data-hydra-a11y-ref')
      if (/^e\d+$/u.test(ref ?? '')) refs.set(node.backendNodeId, { index: Number(ref.slice(1)), attrs })
      for (const child of [...node.children ?? [], ...node.shadowRoots ?? []]) visit(child)
      if (node.contentDocument) visit(node.contentDocument)
    }
    visit(document.root)
    const { nodes } = await devtools.sendCommand('Accessibility.getFullAXTree')
    const escaped = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
    const lines = []
    const emitted = new Set()
    for (const node of nodes) {
      if (node.ignored) continue
      const matched = refs.get(node.backendDOMNodeId)
      const role = String(node.role?.value ?? 'generic').toLowerCase()
      const name = String(node.name?.value ?? '')
      if (matched === undefined) {
        if (role === 'statictext' && name.trim()) lines.push(escaped(name))
        continue
      }
      const { index, attrs } = matched
      if (emitted.has(index)) continue
      emitted.add(index)
      const properties = []
      for (const property of node.properties ?? []) {
        if (['checked', 'expanded', 'disabled', 'selected', 'pressed', 'level', 'required', 'readonly', 'invalid'].includes(property.name)) {
          properties.push(`${property.name}="${escaped(property.value?.value)}"`)
        }
      }
      if (attrs.has('id')) properties.push(`id=${escaped(attrs.get('id'))}`)
      if (attrs.get('type') === 'file') properties.push('type=file')
      if (attrs.has('href')) properties.push(`href="${escaped(attrs.get('href'))}"`)
      const value = attrs.get('type') === 'password' ? '[redacted]' : node.value?.value
      if (value !== undefined && value !== '') properties.push(`value=${escaped(value)}`)
      const suffix = properties.length ? ` ${properties.join(' ')}` : ''
      lines.push(`[${index}]<${role}${suffix}>${escaped(name)}</${role}>`)
    }
    // Hidden chooser inputs are absent from AX but remain an explicit upload target.
    for (const { index, attrs } of refs.values()) {
      if (emitted.has(index) || attrs.get('type') !== 'file' || attrs.has('disabled')) continue
      const metadata = ['type=file']
      for (const name of ['id', 'name']) {
        if (attrs.has(name)) metadata.push(`${name}=${escaped(attrs.get(name))}`)
      }
      lines.push(`[${index}]<button ${metadata.join(' ')}>${escaped(attrs.get('aria-label') ?? 'Choose file')}</button>`)
    }
    return lines.join('\n')
  } finally {
    if (attached && !tab.cdp.persistent) detachTabDebugger(tab, false)
  }
}

ipcMain.handle('browser:accessibility-snapshot', async event => {
  const tab = Array.from(tabs.values()).find(candidate => candidate.view.webContents === event.sender)
  if (!tab) throw new Error('accessibility request did not originate from a controlled tab')
  return await readAccessibilitySnapshot(tab)
})

/** Forward agent mouse actions through Chromium's native input path. */
ipcMain.handle('browser:native-mouse', async (event, input) => {
  const tab = Array.from(tabs.values()).find(candidate => candidate.view.webContents === event.sender)
  if (!tab) throw new Error('native mouse input did not originate from a controlled tab')
  if (typeof input !== 'object' || input === null
    || !['mouseMove', 'mouseDown', 'mouseUp'].includes(input.type)
    || !Number.isFinite(input.x) || !Number.isFinite(input.y)) {
    throw new Error('invalid native mouse input')
  }
  const nativeAvailable = config.show !== false && window?.isVisible() === true && window.isFocused() === true
  let attached = nativeMouseTabs.has(tab)
  if (!attached) {
    attached = ensureTabDebugger(tab, false)
    if (attached) nativeMouseTabs.add(tab)
  }
  try {
    let dialogOpened
    const opened = new Promise(resolve => {
      dialogOpened = (_event, method) => { if (method === 'Page.javascriptDialogOpening') resolve() }
      tab.contents.debugger.on('message', dialogOpened)
    })
    try {
      await Promise.race([opened, tab.contents.debugger.sendCommand('Input.dispatchMouseEvent', {
        type: { mouseMove: 'mouseMoved', mouseDown: 'mousePressed', mouseUp: 'mouseReleased' }[input.type],
        x: input.x,
        y: input.y,
        ...(input.type === 'mouseMove'
          ? { button: input.dragging === true ? 'left' : 'none', buttons: input.dragging === true ? 1 : 0 }
          : { button: 'left', buttons: input.type === 'mouseDown' ? 1 : 0, clickCount: 1 }),
      })])
    } finally {
      tab.contents.debugger.removeListener('message', dialogOpened)
    }
  } finally {
    if ((input.type === 'mouseUp' || !nativeAvailable) && attached) {
      nativeMouseTabs.delete(tab)
      if (!tab.cdp.persistent) detachTabDebugger(tab, true)
    }
  }
  return nativeAvailable
})

/** The current HTTP(S) origin, or undefined for a non-web document. */
function httpOrigin(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : undefined
  } catch {
    return undefined
  }
}

const FILE_INPUT_MARK = 'data-hydra-host-file-input'

/** Whether a CDP node description is an HTML file input. */
function isFileInputNode(node) {
  if (node?.nodeName !== 'INPUT') return false
  const attributes = new Map()
  for (let index = 0; index < (node.attributes?.length ?? 0); index += 2) {
    attributes.set(node.attributes[index], node.attributes[index + 1])
  }
  return attributes.get('type')?.toLowerCase() === 'file'
}

/** Select one host-validated file through an indexed HTML file input. */
async function uploadFile(tab, args) {
  const contents = tab.view.webContents
  const expectedOrigin = canonicalOrigin(args.expectedOrigin)
  if (args.tabId !== tab.id || expectedOrigin === undefined || expectedOrigin !== args.expectedOrigin) {
    return { success: false, message: '❌ File upload requires a Host-bound tab and HTTP(S) origin.' }
  }
  const origin = httpOrigin(contents.getURL())
  if (origin !== expectedOrigin) {
    return { success: false, message: '❌ File upload target changed before approval could be applied.' }
  }
  const devtools = contents.debugger
  let attached = false
  let markToken

  try {
    attached = ensureTabDebugger(tab, false)
    const marked = await pageControl(tab, 'mark_file_input', { index: args.index })
    if (typeof marked?.token !== 'string' || !/^[0-9a-f-]{36}$/iu.test(marked.token)) {
      throw new Error('the indexed element is not an HTML file input')
    }
    markToken = marked.token
    const document = await devtools.sendCommand('DOM.getDocument', { depth: 0 })
    const located = await devtools.sendCommand('DOM.querySelector', {
      nodeId: document.root.nodeId,
      selector: `input[${FILE_INPUT_MARK}="${marked.token}"]`,
    })
    if (!Number.isInteger(located?.nodeId) || located.nodeId === 0) {
      throw new Error('the indexed element is not an HTML file input')
    }
    const hit = await devtools.sendCommand('DOM.describeNode', { nodeId: located.nodeId })
    if (!isFileInputNode(hit?.node)) throw new Error('the indexed element is not an HTML file input')
    if (!tabs.has(tab.id) || contents.isDestroyed() || httpOrigin(contents.getURL()) !== expectedOrigin) {
      throw new Error('the target page origin changed before the file could be selected')
    }
    await devtools.sendCommand('DOM.setFileInputFiles', {
      files: [args.filePath],
      nodeId: located.nodeId,
    })
    return {
      success: true,
      message: `✅ Selected ${basename(args.filePath)} through element [${args.index}] on ${origin}.`,
    }
  } catch (error) {
    return {
      success: false,
      message: `❌ Failed to upload file through element [${args.index}]: ${error instanceof Error ? error.message : String(error)}`,
    }
  } finally {
    if (markToken !== undefined) {
      await pageControl(tab, 'unmark_file_input', { token: markToken }).catch(() => {
        // The document may already have navigated away from the marked input.
      })
    }
    if (attached && !tab.cdp.persistent) detachTabDebugger(tab, true)
  }
}

function validatedCdpCommand(args) {
  if (typeof args.method !== 'string' || args.method.length > 128 || !CDP_METHOD.test(args.method)) {
    throw new Error('CDP method must use Domain.command syntax')
  }
  const domain = args.method.slice(0, args.method.indexOf('.'))
  if (CROSS_TARGET_CDP_DOMAINS.has(domain)) {
    throw new Error(`CDP domain ${domain} is unavailable outside the controlled tab`)
  }
  if (typeof args.params !== 'object' || args.params === null || Array.isArray(args.params)) {
    throw new Error('CDP params must be a JSON object')
  }
  const encoded = JSON.stringify(args.params)
  if (Buffer.byteLength(encoded, 'utf8') > MAX_CDP_PARAMS_BYTES) {
    throw new Error(`CDP params exceed ${MAX_CDP_PARAMS_BYTES} bytes`)
  }
  return { method: args.method, params: args.params }
}

/** Send one host-approved CDP command without allowing a target breakout. */
async function sendCdpCommand(tab, args) {
  if (!nativeSettings.fullCdpAccessAllowed || !nativeSettings.fullCdpAccess) {
    throw new Error('full browser CDP access is disabled')
  }
  const command = validatedCdpCommand(args)
  const contents = tab.view.webContents
  const expectedOrigin = canonicalOrigin(args.expectedOrigin)
  if (args.tabId !== tab.id || expectedOrigin === undefined || expectedOrigin !== args.expectedOrigin) {
    throw new Error('CDP command requires a Host-bound tab and HTTP(S) origin')
  }
  if (httpOrigin(contents.getURL()) !== expectedOrigin) {
    throw new Error('CDP target changed before approval could be applied')
  }
  const devtools = contents.debugger
  ensureTabDebugger(tab, true)
  tab.cdp.raw = true
  if (!nativeSettings.fullCdpAccessAllowed || !nativeSettings.fullCdpAccess
    || !tabs.has(tab.id) || contents.isDestroyed() || httpOrigin(contents.getURL()) !== expectedOrigin) {
    throw new Error('CDP target changed before the command could run')
  }
  const result = await devtools.sendCommand(command.method, command.params)
  if (typeof result !== 'object' || result === null || Array.isArray(result)) {
    throw new Error('CDP returned a non-object result')
  }
  const encoded = JSON.stringify(result)
  if (Buffer.byteLength(encoded, 'utf8') > MAX_CDP_RESULT_BYTES) {
    throw new Error(`CDP result exceeds ${MAX_CDP_RESULT_BYTES} bytes`)
  }
  return result
}

/** Read one bounded page from the retained event stream of an approved tab. */
function readCdpEvents(tab, args) {
  if (!nativeSettings.fullCdpAccessAllowed || !nativeSettings.fullCdpAccess) {
    throw new Error('full browser CDP access is disabled')
  }
  const afterSequence = args.afterSequence ?? 0
  const limit = args.limit ?? MAX_CDP_EVENT_RESULTS
  if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
    throw new Error('CDP event cursor must be a non-negative integer')
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CDP_EVENT_RESULTS) {
    throw new Error(`CDP event limit must be from 1 to ${MAX_CDP_EVENT_RESULTS}`)
  }
  if (args.method !== undefined && (typeof args.method !== 'string'
    || args.method.length > 128 || !CDP_METHOD.test(args.method))) {
    throw new Error('CDP event method filter must use Domain.event syntax')
  }
  const contents = tab.view.webContents
  const expectedOrigin = canonicalOrigin(args.expectedOrigin)
  if (args.tabId !== tab.id || expectedOrigin === undefined || expectedOrigin !== args.expectedOrigin) {
    throw new Error('CDP event read requires a Host-bound tab and HTTP(S) origin')
  }
  if (httpOrigin(contents.getURL()) !== expectedOrigin) {
    throw new Error('CDP target changed before approval could be applied')
  }
  ensureTabDebugger(tab, true)
  if (!nativeSettings.fullCdpAccessAllowed || !nativeSettings.fullCdpAccess
    || !tabs.has(tab.id) || contents.isDestroyed() || httpOrigin(contents.getURL()) !== expectedOrigin) {
    throw new Error('CDP target changed before events could be read')
  }

  const events = []
  let nextSequence = afterSequence
  let scannedAll = true
  for (const retained of tab.cdp.events) {
    if (retained.sequence <= afterSequence) continue
    if (args.method !== undefined && retained.method !== args.method) {
      nextSequence = retained.sequence
      continue
    }
    const event = {
      sequence: retained.sequence,
      method: retained.method,
      params: retained.params,
      receivedAt: retained.receivedAt,
    }
    const page = { events: [...events, event], nextSequence: retained.sequence }
    if (Buffer.byteLength(JSON.stringify(page), 'utf8') > MAX_CDP_RESULT_BYTES) {
      scannedAll = false
      break
    }
    events.push(event)
    nextSequence = retained.sequence
    if (events.length === limit) {
      scannedAll = false
      break
    }
  }
  if (scannedAll) nextSequence = Math.max(nextSequence, tab.cdp.nextSequence - 1)
  return { events, nextSequence }
}

/**
 * Run one protocol method. Navigation is the main process's own business;
 * everything else is a DOM action and belongs to the preload. Every method
 * answers in PageController's own `{success, message}` shape so the harness
 * never has to tell the two halves apart.
 * @param {string} method - protocol method name.
 * @param {Record<string, any>} args - JSON-safe method arguments.
 * @returns {Promise<unknown>} the JSON-safe result.
 */
async function handle(method, args, signal) {
  signal?.throwIfAborted()
  if (isProfileManagement(method)) return await handleCommand(method, args, signal)
  const target = args?.tabId === undefined ? activeTab : tabs.get(args.tabId)
  if (target && !['get_browser_state', 'find_element', 'console_messages', 'network_requests', 'network_request'].includes(method)) {
    target.settledState = undefined
  }
  if (target && approvedNavigations.get(target.contents)?.user === true) approvedNavigations.delete(target.contents)
  const stopNavigation = () => target?.contents.stop()
  if (['back', 'forward', 'reload'].includes(method)) signal?.addEventListener('abort', stopNavigation, { once: true })
  activeBrowserCalls += 1
  updateBrowserActivity()
  try {
    return await handleCommand(method, args, signal)
  } finally {
    signal?.removeEventListener('abort', stopNavigation)
    activeBrowserCalls -= 1
    updateBrowserActivity()
  }
}

async function handleCommand(method, args, signal) {
  noteAgentBrowser(method, args ?? {})
  if (method === 'autofill_login' || method === 'autofill_contact') {
    throw new Error(`unknown browser method: ${method}`)
  }
  if (method === 'autofill_status') return autofillStatus()
  if (method === 'autofill_list_logins') {
    return await useAutofillVault(vault => vault.listLogins())
  }
  if (method === 'autofill_save_login') {
    return await useAutofillVault(vault => vault.saveLogin(args))
  }
  if (method === 'autofill_remove_login') {
    return await useAutofillVault(vault => vault.removeLogin(args.id))
  }
  if (method === 'autofill_list_contacts') {
    return await useAutofillVault(vault => vault.listContacts())
  }
  if (method === 'autofill_get_contact') {
    return await useAutofillVault(async vault => await vault.resolveContact(args.id) ?? null)
  }
  if (method === 'autofill_save_contact') {
    return await useAutofillVault(vault => vault.saveContact(args))
  }
  if (method === 'autofill_remove_contact') {
    return await useAutofillVault(vault => vault.removeContact(args.id))
  }
  if (method === 'configure_browser') {
    return { success: true, ...configureBrowserSettings(args) }
  }
  if (method === 'clear_browser_data') {
    const scope = clearDataScope(args)
    if (scope === 'all') for (const tab of tabs.values()) detachTabDebugger(tab, true)
    if (scope === 'all' || scope === 'site-data') await Promise.all([...sessionCookieWrites])
    await profileStoreWrite
    if (scope === 'all') await browserSession.clearData()
    else if (scope === 'site-data') await browserSession.clearData({ dataTypes: SITE_DATA_TYPES })
    else if (scope === 'cache') await browserSession.clearData({ dataTypes: ['cache'] })
    else if (scope === 'downloads') await browserSession.clearData({ dataTypes: ['downloads'] })
    if (scope === 'all' || scope === 'history') {
      for (const tab of tabs.values()) tab.view.webContents.navigationHistory.clear()
      profileStore.history = []
    }
    if (scope === 'all' || scope === 'downloads') profileStore.downloads = []
    if (scope === 'all' || scope === 'history' || scope === 'downloads') await persistProfileStore()
    return { success: true, scope }
  }
  if (method === 'browser_history') return profileStore.history.map(entry => ({ ...entry }))
  if (method === 'search_browser_history') return searchHistory(args)
  if (method === 'remove_browser_history') {
    if (typeof args.id !== 'string') throw new Error('history id must be a string')
    profileStore.history = profileStore.history.filter(entry => entry.id !== args.id)
    await persistProfileStore()
    return { success: true }
  }
  if (method === 'browser_downloads') return profileStore.downloads.map(entry => ({ ...entry }))
  if (method === 'remove_browser_download') {
    if (typeof args.id !== 'string') throw new Error('download id must be a string')
    profileStore.downloads = profileStore.downloads.filter(entry => entry.id !== args.id)
    await persistProfileStore()
    return { success: true }
  }
  if (method === 'open_browser_download') {
    if (typeof args.id !== 'string') throw new Error('download id must be a string')
    const entry = profileStore.downloads.find(item => item.id === args.id)
    if (!entry || typeof entry.path !== 'string' || entry.path.length === 0) throw new Error('download file is unavailable')
    const error = await shell.openPath(entry.path)
    if (error) throw new Error(error)
    return { success: true }
  }
  if (method === 'browser_sites') return listSites()
  if (method === 'set_browser_site') {
    await setSite(args)
    return { success: true }
  }
  if (method === 'remove_browser_site') {
    removeSite(args)
    await profileStoreWrite
    return { success: true }
  }
  if (method === 'route_user_url') return await routeUserUrl(args.url)
  if (method === 'get_page_identity') {
    if (args.tabId !== undefined && (!Number.isSafeInteger(args.tabId) || args.tabId < 1)) {
      throw new Error('tabId must be a positive integer')
    }
    const tab = args.tabId === undefined ? activeTab : tabs.get(args.tabId)
    if (!tab || tab.view.webContents.isDestroyed()) {
      throw new Error(args.tabId === undefined ? 'active tab is unavailable' : `controlled tab [${args.tabId}] is unavailable`)
    }
    const contents = tab.view.webContents
    return {
      url: contents.getURL() || 'about:blank',
      title: contents.getTitle() || 'New Tab',
      tabId: tab.id,
      activeTabId: activeTab?.id ?? tab.id,
      settled: !contents.isLoadingMainFrame(),
    }
  }
  if (method === 'open_new_tab') {
    if (args.url !== undefined && activeTab !== undefined && navigationPolicy(activeTab.view.webContents, args.url) === false) {
      throw new Error(`navigation to ${args.url} was blocked by Browser settings`)
    }
    const opened = createTab?.()
    if (!opened || !selectTab) throw new Error('tab controls are unavailable')
    selectTab(opened)
    if (args.url !== undefined) {
      try { await loadAllowedUrl(opened.view.webContents, args.url, args.navigationApproved === true, signal) }
      catch (error) {
        closeTab(opened)
        throw error
      }
    }
    return { success: true, message: `Opened tab [${opened.id}]${args.url === undefined ? '' : ` at ${opened.view.webContents.getURL()}`}.` }
  }
  if (method === 'switch_to_tab') {
    const target = tabs.get(args.tabId)
    if (!target || !selectTab) return { success: false, message: `No controlled tab has id [${args.tabId}].` }
    selectTab(target)
    return { success: true, message: `Switched to tab [${target.id}].` }
  }
  if (method === 'close_tab') {
    const target = tabs.get(args.tabId)
    if (!target || !closeTab) return { success: false, message: `No controlled tab has id [${args.tabId}].` }
    if (tabs.size === 1) return { success: false, message: 'The last controlled tab cannot be closed by the agent.' }
    closeTab(target)
    return { success: true, message: `Closed tab [${args.tabId}].` }
  }

  let tab
  if (args.tabId === undefined) {
    // The user may have closed the last controlled tab; a page action reopens one.
    tab = ensureTab()
  } else {
    if (!Number.isSafeInteger(args.tabId) || args.tabId < 1) throw new Error('tabId must be a positive integer')
    tab = tabs.get(args.tabId)
  }
  if (!tab || tab.view.webContents.isDestroyed()) {
    throw new Error(args.tabId === undefined ? 'active tab is unavailable' : `controlled tab [${args.tabId}] is unavailable`)
  }
  const contents = tab.view.webContents
  const capturePageEvents = !['get_cdp_target', 'cdp_command', 'cdp_read_events'].includes(method)
  if (capturePageEvents && !contents.getURL()) await contents.loadURL('about:blank')
  if (capturePageEvents && ensureTabDebugger(tab, true)) {
    await contents.debugger.sendCommand('Page.enable')
    await contents.debugger.sendCommand('Runtime.enable')
    await contents.debugger.sendCommand('Network.enable', { maxTotalBufferSize: MAX_CDP_EVENT_RING_BYTES, maxResourceBufferSize: MAX_CDP_EVENT_BYTES })
  }
  let onNativeDialog
  const nativeDialog = new Promise(resolve => {
    onNativeDialog = (_event, eventMethod) => {
      if (eventMethod === 'Page.javascriptDialogOpening') resolve({ success: true, message: 'Browser dialog opened.' })
    }
    contents.debugger.on('message', onNativeDialog)
  })
  let nativeResult
  try {
    nativeResult = await Promise.race([nativePageAction(tab, method, args, signal), nativeDialog])
  } catch (error) {
    if (error.name !== 'TimeoutError') throw error
    nativeResult = { success: false, message: error.message }
  } finally {
    contents.debugger.removeListener('message', onNativeDialog)
  }
  if (nativeResult !== undefined) return nativeResult
  signal?.throwIfAborted()
  switch (method) {
    case 'click_at': {
      if (![args.x, args.y].every(Number.isFinite) || args.x < 0 || args.y < 0
        || !['left', 'middle', 'right'].includes(args.button ?? 'left')
        || !Number.isSafeInteger(args.clickCount ?? 1) || (args.clickCount ?? 1) < 1 || (args.clickCount ?? 1) > 3) {
        throw new Error('click coordinates or button are invalid')
      }
      const button = args.button ?? 'left'
      const clickCount = args.clickCount ?? 1
      await contents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: args.x, y: args.y, button: 'none', buttons: 0 })
      await contents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: args.x, y: args.y, button, buttons: 1, clickCount })
      await contents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: args.x, y: args.y, button, buttons: 0, clickCount })
      return { success: true, message: `Clicked browser viewport at (${args.x}, ${args.y}).` }
    }

    case 'resize':
      if (![args.width, args.height].every(size => Number.isSafeInteger(size) && size >= 1 && size <= 8192)) throw new Error('viewport dimensions must be integers from 1 to 8192')
      await contents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width: args.width, height: args.height, deviceScaleFactor: 1, mobile: false })
      return { success: true, message: `Resized viewport to ${args.width} × ${args.height}.` }

    case 'drop': {
      if (!Array.isArray(args.filePaths) || args.filePaths.some(path => typeof path !== 'string')
        || typeof args.data !== 'object' || args.data === null || Array.isArray(args.data)
        || Object.entries(args.data).some(([mimeType, data]) => !mimeType.includes('/') || typeof data !== 'string')
        || Buffer.byteLength(JSON.stringify(args.data)) > MAX_CDP_PARAMS_BYTES) throw new Error('invalid drop files or MIME data')
      const expectedOrigin = canonicalOrigin(args.expectedOrigin)
      const allowed = () => args.filePaths.length === 0 || (args.tabId === tab.id && expectedOrigin !== undefined && httpOrigin(contents.getURL()) === expectedOrigin)
      if (!allowed()) throw new Error('file drop requires a Host-bound tab and HTTP(S) origin')
      const point = await pageControl(tab, 'prepare_pointer', { index: args.index })
      if (point.success === false) return point
      if (!allowed()) throw new Error('file drop target changed before the files could be transferred')
      const data = { items: Object.entries(args.data).map(([mimeType, data]) => ({ mimeType, data })), files: args.filePaths, dragOperationsMask: 1 }
      for (const type of ['dragEnter', 'dragOver', 'drop']) {
        if (!allowed()) throw new Error('file drop target changed during the gesture')
        await contents.debugger.sendCommand('Input.dispatchDragEvent', { type, x: point.x, y: point.y, data })
      }
      return { success: true, message: 'Dropped files or data onto browser control.' }
    }

    case 'handle_dialog':
      if (typeof args.accept !== 'boolean' || (args.promptText !== undefined && typeof args.promptText !== 'string')) throw new Error('invalid dialog response')
      if (!tab.dialog) return { success: false, message: 'No dialog visible.' }
      await contents.debugger.sendCommand('Page.handleJavaScriptDialog', { accept: args.accept, ...args.promptText === undefined ? {} : { promptText: args.promptText } })
      tab.dialog = undefined
      return { success: true, message: args.accept ? 'Accepted browser dialog.' : 'Dismissed browser dialog.' }

    case 'console_messages': {
      const levels = { error: 0, assert: 0, warning: 1, warn: 1, info: 2, log: 2, debug: 3 }
      if (!['error', 'warning', 'info', 'debug'].includes(args.level)) throw new Error('invalid console level')
      const messages = tab.cdp.events.filter(event => event.method === 'Runtime.consoleAPICalled' && (levels[event.params.type] ?? 2) <= levels[args.level])
        .map(event => `[${event.params.type}] ${(event.params.args ?? []).map(arg => String(arg.value ?? arg.description ?? arg.type)).join(' ')}`)
      return { success: true, message: boundedDiagnostic(messages.join('\n')) || 'No retained console messages.' }
    }

    case 'network_requests': {
      const filter = args.filter === undefined ? undefined : browserRegex(args.filter)
      const lines = tab.cdp.events.filter(event => event.method === 'Network.requestWillBeSent').flatMap(event => {
        if (filter && !filter.test(event.params.request.url)) return []
        const response = tab.cdp.events.find(candidate => candidate.method === 'Network.responseReceived' && candidate.params.requestId === event.params.requestId)?.params.response
        if (!args.includeStatic && !['Fetch', 'XHR', 'Document'].includes(event.params.type) && response?.status < 400) return []
        return `[${event.sequence}] ${event.params.request.method} ${event.params.request.url} ${response?.status ?? 'pending'}`
      })
      return { success: true, message: boundedDiagnostic(lines.join('\n')) || 'No retained network requests.' }
    }

    case 'network_request': {
      const request = tab.cdp.events.find(event => event.sequence === args.index && event.method === 'Network.requestWillBeSent')?.params
      if (!request) return { success: false, message: 'Request is unavailable or expired. Read browser_network_requests for current indexes.' }
      const response = tab.cdp.events.find(event => event.method === 'Network.responseReceived' && event.params.requestId === request.requestId)?.params.response
      let data
      switch (args.part) {
        case 'request-headers': data = request.request.headers; break
        case 'response-headers': data = response?.headers ?? {}; break
        case 'request-body': data = request.request.postData ?? (await contents.debugger.sendCommand('Network.getRequestPostData', { requestId: request.requestId })).postData; break
        case 'response-body': data = await contents.debugger.sendCommand('Network.getResponseBody', { requestId: request.requestId }); break
        case undefined: data = { request: request.request, response }; break
        default: throw new Error('invalid network request part')
      }
      return { success: true, message: boundedDiagnostic(JSON.stringify(data)) }
    }
    case 'get_upload_target': {
      const origin = httpOrigin(contents.getURL())
      if (origin === undefined) throw new Error('file upload requires a currently observed HTTP(S) page')
      return { origin, tabId: tab.id }
    }

    case 'get_cdp_target': {
      const origin = httpOrigin(contents.getURL())
      if (origin === undefined) throw new Error('CDP requires a currently observed HTTP(S) page')
      return { origin, tabId: tab.id }
    }

    case 'get_browser_state': {
      if (args.metadataOnly !== undefined && typeof args.metadataOnly !== 'boolean') throw new Error('metadataOnly must be a boolean')
      if (args.metadataOnly === true) {
        return completeState(tab, {
          url: contents.getURL(), title: contents.getTitle(), header: '', content: '',
          footer: tab.dialog ? `Open ${tab.dialog.type} dialog: ${tab.dialog.message}. Use browser_handle_dialog to continue.` : '',
        }, !contents.isLoadingMainFrame() && !tab.dialog, false)
      }
      const state = await readBrowserState(tab, args.waitForReady === true, args.tabId === undefined, signal)
      if (args.snapshot === undefined) return state
      const options = args.snapshot
      if (options.depth !== undefined && (!Number.isSafeInteger(options.depth) || options.depth < 0)) throw new Error('snapshot depth must be a non-negative integer')
      if (options.boxes !== undefined && typeof options.boxes !== 'boolean') throw new Error('snapshot boxes must be boolean')
      const page = await ensureNativePage(tabs.get(state.tabId))
      return { ...state, content: await distilledSnapshot(page, options) }
    }

    case 'browser_screenshot': {
      if (Object.hasOwn(args, 'tabId')) throw new Error('browser_screenshot does not accept tabId')
      if (args.fullPage !== undefined && typeof args.fullPage !== 'boolean') throw new Error('fullPage must be a boolean')
      const clip = args.clip
      if (clip !== undefined && (args.fullPage === true || typeof clip !== 'object' || clip === null || Array.isArray(clip)
        || !['x', 'y', 'width', 'height'].every(key => Number.isSafeInteger(clip[key]))
        || clip.x < 0 || clip.y < 0 || clip.width < 1 || clip.height < 1 || clip.width > 10_000 || clip.height > 10_000)) {
        throw new Error('clip must be a non-negative integer rectangle up to 10000 pixels')
      }
      const url = contents.getURL()
      if (httpOrigin(url) === undefined) {
        throw new Error('browser screenshot requires the selected tab to show an HTTP(S) page')
      }
      const screenshot = await boundedPng(contents, clip, args.fullPage === true)
      if (screenshot === undefined) {
        throw new Error(`browser screenshot is empty or exceeds the ${MAX_SCREENSHOT_BYTES}-byte PNG limit`)
      }
      if (activeTab !== tab || contents.isDestroyed() || contents.getURL() !== url) {
        throw new Error('selected browser tab changed while its screenshot was captured')
      }
      return {
        mediaType: 'image/png',
        ...screenshot,
        tabId: tab.id,
        mode: args.fullPage === true ? 'full-page' : clip === undefined ? 'viewport' : 'clip',
        ...clip === undefined ? {} : { clip },
        url,
        title: contents.getTitle(),
        capturedAt: new Date().toISOString(),
      }
    }

    case 'navigate':
      // Resolves on dom-ready (see loadAllowedUrl), not did-finish-load: a caller
      // that awaits this can already attach Playwright/CDP to the page it asked
      // for before every subresource has finished loading.
      await loadAllowedUrl(contents, args.url, args.navigationApproved === true, signal)
      return { success: true, message: `Navigated to ${contents.getURL()}` }

    case 'back': {
      const history = contents.navigationHistory
      if (history.canGoBack()) {
        const targetUrl = historyDestination(contents, -1)
        if (targetUrl === undefined || siteNavigationBlocked(targetUrl)) {
          throw new Error(`navigation to ${targetUrl ?? 'the earlier page'} was blocked by Browser settings`)
        }
        const loaded = waitForFinishedLoad(contents, targetUrl, signal)
        history.goToIndex(history.getActiveIndex() - 1)
        await loaded
      } else {
        const moved = await pageControl(tab, 'history_go', { delta: -1 })
        if (moved?.success !== true) {
          return { success: false, message: moved?.message ?? 'No earlier page in this view.' }
        }
      }
      return { success: true, message: `Went back to ${contents.getURL()}` }
    }

    case 'forward': {
      const history = contents.navigationHistory
      if (history.canGoForward()) {
        const targetUrl = historyDestination(contents, 1)
        if (targetUrl === undefined || siteNavigationBlocked(targetUrl)) {
          throw new Error(`navigation to ${targetUrl ?? 'the later page'} was blocked by Browser settings`)
        }
        const loaded = waitForFinishedLoad(contents, targetUrl, signal)
        history.goToIndex(history.getActiveIndex() + 1)
        await loaded
      } else {
        const moved = await pageControl(tab, 'history_go', { delta: 1 })
        if (moved?.success !== true) {
          return { success: false, message: moved?.message ?? 'No later page in this view.' }
        }
      }
      return { success: true, message: `Went forward to ${contents.getURL()}` }
    }

    case 'reload': {
      if (siteNavigationBlocked(contents.getURL())) {
        throw new Error(`navigation to ${contents.getURL()} was blocked by Browser settings`)
      }
      const loaded = once(contents, 'did-finish-load', { signal })
      contents.reload()
      await loaded
      return { success: true, message: `Reloaded ${contents.getURL()}` }
    }

    case 'press': {
      if (typeof args.key !== 'string' || !args.key.trim()) throw new Error('key must be non-empty')
      const parts = args.key === '+' ? ['+'] : args.key.split('+')
      const keyCode = parts.pop()
      const modifierNames = { Control: 'control', Ctrl: 'control', Alt: 'alt', Shift: 'shift', Meta: 'meta', ControlOrMeta: process.platform === 'darwin' ? 'meta' : 'control' }
      if (!keyCode || parts.some(part => !Object.hasOwn(modifierNames, part))) throw new Error('invalid keyboard chord')
      const modifiers = parts.map(part => modifierNames[part])
      if (!contents.isFocused()) contents.focus()
      for (const type of modifiers.length === 0 ? ['keyDown', 'char', 'keyUp'] : ['keyDown', 'keyUp']) {
        contents.sendInputEvent({ type, keyCode, modifiers })
      }
      return { success: true, message: `Pressed ${args.key}` }
    }

    case 'wait': {
      if (!Number.isFinite(args.seconds) || args.seconds < 1 || args.seconds > 10) {
        throw new Error('wait seconds must be between 1 and 10')
      }
      const lastUpdate = await pageControl(tab, 'get_last_update_time', {})
      const remaining = Math.max(0, args.seconds * 1_000 - (Date.now() - lastUpdate))
      await delay(remaining, undefined, { signal })
      return { success: true, message: `Waited up to ${args.seconds} second${args.seconds === 1 ? '' : 's'} for the page.` }
    }

    case 'wait_for': {
      if (!Number.isFinite(args.seconds) || args.seconds <= 0 || args.seconds > 10) throw new Error('wait time must be greater than zero and at most 10 seconds')
      for (const value of [args.text, args.textGone]) {
        if (value !== undefined && (typeof value !== 'string' || value.length === 0)) throw new Error('wait text must be non-empty')
      }
      const deadline = Date.now() + args.seconds * 1000
      if (args.text === undefined && args.textGone === undefined) {
        await delay(args.seconds * 1000, undefined, { signal })
        return { success: true, message: `Waited ${args.seconds} seconds.` }
      }
      do {
        const state = await readBrowserState(tab, false, false, signal)
        if ((args.text === undefined || state.content.includes(args.text)) && (args.textGone === undefined || !state.content.includes(args.textGone))) {
          return { success: true, message: 'The requested text condition is met.' }
        }
        await delay(Math.min(READINESS_POLL_MS, Math.max(0, deadline - Date.now())), undefined, { signal })
      } while (Date.now() < deadline)
      return { success: false, message: 'Timed out waiting for the requested text condition.' }
    }

    case 'execute_javascript':
      if (config.experimentalScriptExecution !== true) {
        throw new Error('experimental browser JavaScript is disabled by the host')
      }
      return await pageControl(tab, method, args)

    case 'execute_javascript_page': {
      if (config.experimentalScriptExecution !== true) throw new Error('experimental browser JavaScript is disabled by the host')
      if (typeof args.script !== 'string' || args.script.trim().length === 0) throw new Error('script must be a non-empty string')
      const value = await contents.executeJavaScript(`(async () => { ${args.script}\n })()`, true)
      let result
      try { result = value === undefined ? 'undefined' : JSON.stringify(value) } catch { result = String(value) }
      return { success: true, message: boundedDiagnostic(result ?? 'undefined') }
    }

    case 'upload_file':
      return await uploadFile(tab, args)

    case 'cdp_command':
      return await sendCdpCommand(tab, args)

    case 'cdp_read_events':
      return readCdpEvents(tab, args)

    default:
      try {
        return await pageControl(tab, method, args)
      } catch (error) {
        if (isNavigationInterruption(error)
          && ['click_element', 'input_text', 'select_option', 'fill_fields'].includes(method)) {
          return { success: true, message: `The ${method} action started a page navigation.` }
        }
        throw error
      }
  }
}

if (config.userDataDir && embedded === undefined) app.setPath('userData', config.userDataDir)

app.whenReady().then(async () => {
  browserSession = embedded === undefined
    ? session.defaultSession
    : session.fromPartition('persist:hydra-controlled-browser')
  await Promise.all([loadProfileStore(), initializeAutofillVault()])
  nativeTheme.on('updated', updateChrome)
  configureBrowserSettings(nativeSettings)
  // Holding Chromium's request callback preserves POST bodies and redirects while chat answers.
  browserSession.webRequest.onBeforeRequest((details, callback) => {
    const contents = [...tabs.values()].find(tab => tab.contents.id === details.webContentsId)?.contents
    if (details.resourceType !== 'mainFrame' || contents === undefined) { callback({}); return }
    const allowed = navigationPolicy(contents, details.url)
    if (allowed !== undefined) { callback({ cancel: !allowed }); return }
    void requestPermission(contents, 'navigation', canonicalOrigin(details.url))
      .then(approved => { callback({ cancel: !approved }) }, () => { callback({ cancel: true }) })
  })
  browserSession.on('will-download', beginDownload)
  browserSession.setPermissionCheckHandler((contents, permission, requestingOrigin) => {
    if (contents === null) return false
    if (permission === 'media') return mediaPermissionAllowed(contents, requestingOrigin) === true
    return permission === 'geolocation' || permission === 'notifications'
  })
  browserSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    const origin = details.requestingUrl ?? contents.getURL()
    if (!['media', 'geolocation', 'notifications'].includes(permission)) { callback(false); return }
    const allowed = permission === 'media' ? mediaPermissionAllowed(contents, origin) : undefined
    if (allowed !== undefined) { callback(allowed); return }
    void requestPermission(contents, permission, canonicalOrigin(origin)).then(callback, () => { callback(false) })
  })
  browserSession.setDevicePermissionHandler(() => false)
  browserSession.setDisplayMediaRequestHandler((_request, callback) => { callback({}) })
  if (PERSIST_SESSION_COOKIES) {
    browserSession.cookies.on('changed', (_event, cookie, _cause, removed) => {
      if (!removed) persistSessionCookie(cookie)
    })
  }
  window = embedded?.window ?? new BrowserWindow({
    width: config.width ?? 1280,
    height: config.height ?? 900,
    show: config.show ?? true,
    title: 'Hydra harness — controlled browser',
    icon: join(__dirname, 'hydra.png'),
  })
  if (embedded === undefined) window.once('close', () => {
    windowClosing = true
    for (const tab of tabs.values()) detachTabDebugger(tab, true)
  })

  chrome = new WebContentsView({
    webPreferences: {
      preload: join(__dirname, 'chrome-preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })
  window.contentView.addChildView(chrome)
  chrome.webContents.on('before-input-event', (event, input) => {
    handleKeyboardShortcuts(event, input, activeTab)
  })

  const fit = () => {
    const [windowWidth, windowHeight] = window.getContentSize()
    const panel = embedded === undefined
      ? { x: 0, y: 0, width: windowWidth, height: windowHeight, visible: true }
      : embeddedBounds
    const chromeHeight = Math.min(CHROME_HEIGHT, panel.height)
    chrome.setBounds({ x: panel.x, y: panel.y, width: panel.width, height: chromeHeight })
    chrome.setVisible(panel.visible && panel.width > 0 && chromeHeight > 0 && tabs.size > 0)
    for (const tab of tabs.values()) {
      tab.view.setBounds({
        x: panel.x,
        y: panel.y + chromeHeight,
        width: panel.width,
        height: Math.max(0, panel.height - chromeHeight),
      })
      tab.view.setVisible(panel.visible && activeTab === tab && panel.width > 0 && panel.height > chromeHeight)
    }
  }

  /** @returns {Tab} a hidden tab sharing the browser profile with every other tab. */
  createTab = function createControlledTab() {
    const view = new WebContentsView({
      webPreferences: {
        preload: join(__dirname, 'preload.cjs'),
        session: browserSession,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        // Hidden browser tabs still need timers and animation frames for SPA
        // hydration and the simulated cursor to make progress in headless mode.
        backgroundThrottling: false,
      },
    })
    const tab = {
      id: nextTabId++,
      cdp: { owned: false, persistent: false, nextSequence: 1, events: [], bytes: 0 },
      preloadReady: false,
      view,
      contents: view.webContents,
      favicon: '',
    }
    tabs.set(tab.id, tab)
    window.contentView.addChildView(tab.view)
    tab.view.setVisible(false)

    const { contents } = tab
    contents.debugger.on('message', (_event, method, params) => {
      recordCdpEvent(tab, method, params)
      if (method === 'Page.javascriptDialogOpening') tab.dialog = params
      if (method === 'Page.javascriptDialogClosed') tab.dialog = undefined
    })
    contents.debugger.on('detach', () => {
      tab.playwrightPage = undefined
      tab.cdp.owned = false
      tab.cdp.persistent = false
      tab.cdp.events = []
      tab.cdp.bytes = 0
    })
    contents.on('context-menu', (event, params) => {
      event.preventDefault()
      void openPageMenu(tab, params).catch(() => { log('page context menu could not be opened') })
    })
    contents.setWindowOpenHandler(({ url }) => {
      if (navigationPolicy(contents, url) === false) return { action: 'deny' }
      const userNavigation = approvedNavigations.get(contents)?.user === true
      const opened = createTab?.()
      if (!opened || !selectTab) return { action: 'deny' }
      selectTab(opened)
      void loadAllowedUrl(opened.view.webContents, url, userNavigation ? 'user' : false).catch(error => {
        if (!windowClosing && tabs.has(opened.id)) closeTab(opened)
        log('new-tab navigation failed:', error)
      })
      return { action: 'deny' }
    })
    const enforceNavigation = (event, url) => {
      if (navigationPolicy(contents, url) === false) event.preventDefault()
    }
    contents.on('will-navigate', enforceNavigation)
    contents.on('will-redirect', enforceNavigation)
    // Both ends of a document's life invalidate only the preload holding that
    // tab's indices; a background tab cannot cancel an active tab's action.
    contents.on('did-start-navigation', event => {
      if (!event.isMainFrame || event.isSameDocument) return
      tab.settledState = undefined
      downloadDenials.delete(contents)
      cancelPermissions(contents)
      if (tab.cdp.raw) detachTabDebugger(tab, true)
      tab.cdp.events = []
      tab.cdp.bytes = 0
      tab.lastState = undefined
      tab.dialog = undefined
      cancelAnnotation(tab)
      abortPageCalls(tab, 'page navigated away before the action completed')
      abortPageAgentLlmCalls(tab, 'page navigated away before PageAgent received a model response')
    })
    // A blocked request or download keeps the current document and its preload.
    contents.on('did-frame-navigate', (_event, _url, _code, _status, isMainFrame) => {
      if (isMainFrame) tab.preloadReady = false
    })
    contents.on('render-process-gone', (_event, details) => {
      tab.preloadReady = false
      cancelPermissions(contents)
      detachTabDebugger(tab, true)
      abortPageCalls(tab, `renderer gone: ${details.reason}`)
      abortPageAgentLlmCalls(tab, `renderer gone: ${details.reason}`)
    })
    contents.on('destroyed', () => {
      cancelPermissions(contents)
      closeTab(tab)
    })
    contents.on('dom-ready', () => {
      tab.preloadReady = true
      contents.send('browser:activity', activeBrowserCalls > 0)
    })
    contents.on('did-finish-load', () => { recordHistory(contents) })
    contents.on('did-navigate-in-page', () => { recordHistory(contents) })
    contents.on('page-favicon-updated', (_event, favicons) => {
      tab.favicon = typeof favicons?.[0] === 'string' ? favicons[0] : ''
      updateChrome()
    })
    contents.on('media-started-playing', updateChrome)
    contents.on('media-paused', updateChrome)
    contents.on('found-in-page', (_event, result) => {
      if (chrome !== undefined && !chrome.webContents.isDestroyed()) {
        chrome.webContents.send('browser-chrome:found-in-page', result)
      }
    })
    contents.on('before-mouse-event', (_event, input) => {
      if (input.type === 'mouseDown' && activeBrowserCalls === 0) approvedNavigations.set(contents, { user: true })
    })
    contents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && activeBrowserCalls === 0) approvedNavigations.set(contents, { user: true })
      handleKeyboardShortcuts(event, input, tab)
    })
    for (const event of [
      'did-finish-load', 'did-navigate', 'did-navigate-in-page', 'page-title-updated',
      'did-start-loading', 'did-stop-loading',
    ]) {
      contents.on(event, updateChrome)
    }
    return tab
  }

  /** Show a tab and make it the default target for actions without `tabId`. */
  selectTab = function selectControlledTab(tab) {
    if (windowClosing || !tabs.has(tab.id) || activeTab === tab || tab.view.webContents.isDestroyed()) return
    if (activeTab) {
      cancelAnnotation(activeTab)
      activeTab.view.setVisible(false)
    }
    activeTab = tab
    tab.view.setVisible(true)
    fit()
    tab.view.webContents.focus()
    updateChrome()
  }

  /** Close a tab; the last one closes the window, or the desktop's Browser panel. */
  closeTab = function closeControlledTab(tab) {
    if (windowClosing || !tabs.has(tab.id)) return
    if (tabs.size === 1 && embedded === undefined) {
      window.close()
      return
    }

    const orderedTabs = Array.from(tabs.values())
    const index = orderedTabs.indexOf(tab)
    const replacement = orderedTabs[index + 1] ?? orderedTabs[index - 1]
    const wasActive = activeTab === tab
    cancelAnnotation(tab)
    detachTabDebugger(tab, true)
    abortPageCalls(tab, 'tab closed before the action completed')
    abortPageAgentLlmCalls(tab, 'tab closed before PageAgent received a model response')
    tabs.delete(tab.id)
    tab.view.setVisible(false)
    window.contentView.removeChildView(tab.view)
    if (wasActive) activeTab = undefined
    if (!tab.contents.isDestroyed()) tab.contents.close()
    if (wasActive && replacement !== undefined) selectTab(replacement)
    else if (tabs.size === 0) {
      agentBrowserRevealed = false
      updateChrome()
      fit()
      embedded?.closeBrowser?.()
    } else {
      updateChrome()
    }
  }

  const initialTab = createTab()
  selectTab(initialTab)
  if (chrome !== undefined) void chrome.webContents.loadFile(join(__dirname, 'chrome.html'))
  fit()
  window.on('resize', fit)
  chrome?.webContents.once('did-finish-load', updateChrome)

  if (chrome !== undefined) {
    ipcMain.on('browser-chrome:navigate', (event, value) => {
      if (event.sender !== chrome.webContents) return
      if (typeof value !== 'string' || !value.trim()) return
      const tab = activeTab
      if (!tab) return
      void loadAllowedUrl(tab.view.webContents, resolveOmnibox(value.trim()), 'user')
        .catch(error => log('omnibox navigation failed:', error))
    })
    ipcMain.on('browser-chrome:back', event => {
      if (event.sender !== chrome.webContents || !activeTab) return
      moveInHistory(activeTab.view.webContents, -1)
    })
    ipcMain.on('browser-chrome:forward', event => {
      if (event.sender !== chrome.webContents || !activeTab) return
      moveInHistory(activeTab.view.webContents, 1)
    })
    ipcMain.on('browser-chrome:reload', event => {
      if (event.sender !== chrome.webContents || !activeTab) return
      reloadAllowed(activeTab.view.webContents)
    })
    ipcMain.on('browser-chrome:annotate', event => {
      if (event.sender !== chrome.webContents) return
      if (!activeTab || typeof embedded?.onAnnotation !== 'function') {
        chrome.webContents.send('browser-chrome:annotation-ended')
        return
      }
      if (toolbarAnnotation !== undefined) return
      const pending = { tab: activeTab }
      toolbarAnnotation = pending
      void publishAnnotation(pending.tab, 'annotate_element', {}).finally(() => {
        if (toolbarAnnotation !== pending) return
        toolbarAnnotation = undefined
        if (!chrome.webContents.isDestroyed()) chrome.webContents.send('browser-chrome:annotation-ended')
      })
    })
    ipcMain.on('browser-chrome:cancel-annotation', event => {
      if (event.sender === chrome.webContents && toolbarAnnotation !== undefined) {
        cancelAnnotation(toolbarAnnotation.tab)
      }
    })
    ipcMain.on('browser-chrome:new-tab', event => {
      if (event.sender === chrome.webContents) selectTab(createTab())
    })
    ipcMain.on('browser-chrome:select-tab', (event, id) => {
      if (event.sender !== chrome.webContents || !Number.isInteger(id)) return
      const tab = tabs.get(id)
      if (tab) selectTab(tab)
    })
    ipcMain.on('browser-chrome:close-tab', (event, id) => {
      if (event.sender !== chrome.webContents || !Number.isInteger(id)) return
      const tab = tabs.get(id)
      if (tab) closeTab(tab)
    })
    ipcMain.on('browser-chrome:stop', event => {
      if (event.sender !== chrome.webContents || !activeTab) return
      activeTab.view.webContents.stop()
    })
    ipcMain.on('browser-chrome:hard-reload', event => {
      if (event.sender !== chrome.webContents || !activeTab) return
      reloadAllowed(activeTab.view.webContents, true)
    })
    ipcMain.on('browser-chrome:home', event => {
      if (event.sender !== chrome.webContents || !activeTab) return
      const homeUrl = HOME_URL ?? 'https://www.google.com'
      void loadAllowedUrl(activeTab.view.webContents, homeUrl, 'user')
    })
    ipcMain.on('browser-chrome:toggle-mute', (event, id) => {
      if (event.sender !== chrome.webContents) return
      const tab = (Number.isInteger(id) ? tabs.get(id) : undefined) ?? activeTab
      if (tab) {
        tab.view.webContents.setAudioMuted(!tab.view.webContents.isAudioMuted())
        updateChrome()
      }
    })
    ipcMain.on('browser-chrome:toggle-bookmark', event => {
      if (event.sender !== chrome.webContents || !activeTab) return
      const url = activeTab.view.webContents.getURL()
      if (!url) return
      if (isBookmarked(url)) {
        void removeBookmark(url)
      } else {
        void addBookmark({ url, title: activeTab.view.webContents.getTitle(), favicon: activeTab.favicon })
      }
    })
    ipcMain.on('browser-chrome:remove-bookmark', (event, id) => {
      if (event.sender !== chrome.webContents || typeof id !== 'string') return
      void removeBookmark(id)
    })
    ipcMain.on('browser-chrome:zoom', (event, action) => {
      if (event.sender !== chrome.webContents || !activeTab) return
      const contents = activeTab.view.webContents
      if (action === 'in') contents.setZoomFactor(Math.min(3, contents.getZoomFactor() + 0.1))
      else if (action === 'out') contents.setZoomFactor(Math.max(0.3, contents.getZoomFactor() - 0.1))
      else contents.setZoomFactor(1)
      updateChrome()
    })
    ipcMain.on('browser-chrome:find-in-page', (event, text, forward) => {
      if (event.sender !== chrome.webContents || !activeTab || typeof text !== 'string') return
      activeTab.view.webContents.findInPage(text, { forward: forward !== false, findNext: true })
    })
    ipcMain.on('browser-chrome:stop-find', event => {
      if (event.sender !== chrome.webContents || !activeTab) return
      activeTab.view.webContents.stopFindInPage('clearSelection')
    })
    ipcMain.on('browser-chrome:tab-context-menu', (event, id) => {
      if (event.sender !== chrome.webContents || !Number.isInteger(id)) return
      openTabMenu(id)
    })
    ipcMain.on('browser-chrome:open-menu', event => {
      if (event.sender !== chrome.webContents) return
      openChromeMenu()
    })
  }

  /** Run one NDJSON request from either stdio or the desktop utility bridge. */
  const requests = new Map()
  const protocolRequest = async request => {
    const { id, method, args } = request
    if (method === 'cancel_browser_call') {
      if (!Number.isSafeInteger(args?.id)) return { id, ok: false, error: 'cancelled browser request id must be an integer' }
      requests.get(args.id)?.controller.abort(new Error('browser action cancelled'))
      cancelPermissions()
      return undefined
    }
    if (method === 'cancel_browser_permissions') {
      cancelPermissions()
      return undefined
    }
    if (method === 'browser_permission_response') {
      const pending = pendingPermissions.get(args?.id)
      if (pending === undefined) return undefined
      pendingPermissions.delete(args.id)
      pending.resolve(['once', 'always', 'block'].includes(args.choice) ? args.choice : undefined)
      return undefined
    }
    if (method === 'page_agent_llm_response') {
      const pending = pendingPageAgentLlmCalls.get(args?.callId)
      if (pending === undefined) return undefined
      pendingPageAgentLlmCalls.delete(args.callId)
      if (args.ok === true) pending.resolve(args.result)
      else pending.reject(new Error(args.error ?? 'Hydra could not complete the PageAgent model request'))
      return undefined
    }
    const controller = new AbortController()
    const operation = (async () => {
      try {
        const result = await handle(method, args ?? {}, controller.signal)
        controller.signal.throwIfAborted()
        return { id, ok: true, result }
      } catch (error) {
        return { id, ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    })()
    requests.set(id, { controller, operation })
    try {
      return await operation
    } finally {
      requests.delete(id)
    }
  }

  if (embedded !== undefined) {
    embedded.register({
      async command(method, args = {}) { return await handle(method, args) },
      getState() { return chromeState },
      async request(request) { return await protocolRequest(request) },
      cancelPermissions() { cancelPermissions() },
      async cancelRequests() {
        const pending = [...requests.values()]
        for (const { controller } of pending) controller.abort(new Error('browser owner disconnected'))
        cancelPermissions()
        await Promise.all(pending.map(({ operation }) => operation))
      },
      setTheme(value) { setChromeTheme(value) },
      setWindow(next) {
        if (windowClosing || next === window) return
        window.removeListener('resize', fit)
        window.contentView.removeChildView(chrome)
        for (const tab of tabs.values()) window.contentView.removeChildView(tab.view)
        window = next
        window.contentView.addChildView(chrome)
        for (const tab of tabs.values()) window.contentView.addChildView(tab.view)
        window.on('resize', fit)
        fit()
      },
      setBounds(bounds) {
        if (windowClosing) return
        embeddedBounds = bounds
        // `present: false` means the renderer no longer hosts a Browser panel, so
        // the next agent action has to reveal one again.
        if (bounds.present === false) agentBrowserRevealed = false
        else if (bounds.visible && tabs.size === 0) ensureTab()
        fit()
      },
      async dispose() {
        windowClosing = true
        cancelPermissions()
        window.removeListener('resize', fit)
        for (const tab of tabs.values()) {
          detachTabDebugger(tab, true)
          abortPageCalls(tab, 'desktop browser closed before the action completed')
          abortPageAgentLlmCalls(tab, 'desktop browser closed before PageAgent received a model response')
          tab.view.setVisible(false)
          window.contentView.removeChildView(tab.view)
          if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close()
        }
        tabs.clear()
        activeTab = undefined
        chrome.setVisible(false)
        window.contentView.removeChildView(chrome)
        if (!chrome.webContents.isDestroyed()) chrome.webContents.close()
        await flushSessionCookies()
        await profileStoreWrite
      },
    })
  } else {
    // Not `process.stdin`: in Electron's main process on Windows that is a stub
    // Readable that never emits, while reading fd 0 directly works everywhere.
    const input = createInterface({ input: createReadStream(null, { fd: 0, autoClose: false }) })
    input.on('line', line => {
      if (!line.trim()) return
      let request
      try {
        request = JSON.parse(line)
      } catch {
        // Nothing to reply to without an id, and throwing here would take the
        // process down over one bad line.
        log('unparseable request', JSON.stringify(line))
        return
      }
      void protocolRequest(request).then(reply => { if (reply !== undefined) send(reply) })
    })
    // The parent closing the pipe is the shutdown signal, so a killed harness
    // never leaves a window behind.
    input.on('close', () => {
      void Promise.all([flushSessionCookies(), profileStoreWrite])
        .catch(error => log('profile flush failed:', error)).finally(() => app.quit())
    })
  }
  // Permission replies must be readable while a configured home awaits its chat decision.
  if (HOME_URL !== undefined) {
    try {
      await loadAllowedUrl(initialTab.view.webContents, HOME_URL)
    } catch (error) {
      log('home navigation failed:', error)
    }
  }
  if (embedded === undefined) send({ event: 'ready' })
})

// Closing the window by hand is a shutdown too: the parent sees the child exit
// and knows to spawn a fresh one next time.
if (embedded === undefined) app.on('window-all-closed', () => app.quit())

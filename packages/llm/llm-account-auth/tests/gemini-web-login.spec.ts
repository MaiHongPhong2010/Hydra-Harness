/** Managed-browser ownership, authenticated capture, and cancellation without personal-profile access. */
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:net'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { loginGeminiWeb } from '../src/gemini-web-login.ts'

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), connect: vi.fn(), kill: vi.fn(), server: vi.fn<() => Server | undefined>() }))
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), spawn: mocks.spawn, execFile: mocks.kill }))
vi.mock('node:net', async (original) => {
  const actual = await original<typeof import('node:net')>()
  return { ...actual, createServer: () => mocks.server() ?? actual.createServer() }
})
vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>(), access: vi.fn(async () => {}) }))
vi.mock('playwright-core', () => ({ chromium: { connectOverCDP: mocks.connect } }))
let root: string
let platform: PropertyDescriptor
beforeEach(async () => {
  platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: 'win32' })
  root = await mkdtemp(join(tmpdir(), 'gemini-browser-')); vi.resetAllMocks()
})
afterEach(async () => { Object.defineProperty(process, 'platform', platform); vi.useRealTimers(); await rm(root, { recursive: true, force: true }) })

function browserFixture(cookies: () => Promise<unknown[]>, html = '{"oPEP7c":"fixture@example.test"}') {
  const child = Object.assign(new EventEmitter(), { pid: 1234, exitCode: null as number | null })
  const close = vi.fn(async () => { child.exitCode = 0; child.emit('exit', 0, null) })
  const context = { cookies, pages: () => [{ url: () => 'https://gemini.google.com/app',
    waitForLoadState: async () => {}, content: async () => html }] }
  const browser = { contexts: () => [context], isConnected: () => true,
    newBrowserCDPSession: async () => ({ send: close }), close: vi.fn(async () => {}) }
  mocks.spawn.mockReturnValue(child); mocks.connect.mockResolvedValue(browser)
  return { child, browser, close }
}

it('captures scoped cookies and closes the owned normal browser before returning', async () => {
  const cookie = { name: '__Secure-1PSID', value: 'private-fixture', domain: '.google.com', path: '/', secure: true, httpOnly: true, expires: -1 }
  const h = browserFixture(async () => [cookie, { ...cookie, domain: '.example.test' }])
  const notify = vi.fn()
  const jar = await loginGeminiWeb(root, 'msedge', AbortSignal.timeout(10_000), notify)
  expect(await jar.getCookieString('https://gemini.google.com')).toBe('__Secure-1PSID=private-fixture')
  expect(await jar.getCookieString('https://example.test')).toBe('')
  expect(h.close).toHaveBeenCalledOnce(); expect(h.child.exitCode).toBe(0)
  const args = mocks.spawn.mock.calls[0]![1] as string[]
  expect(args).toContain(`--user-data-dir=${join(root, 'profile')}`)
  expect(args.join(' ')).not.toMatch(/automation|disable.*security|password|private-fixture/)
  expect(notify.mock.calls.flat().join(' ')).not.toContain('private-fixture')
})

it('does not treat stale cookies on an unauthenticated app page as completed sign-in', async () => {
  const h = browserFixture(async () => [{ name: '__Secure-1PSID' }], '{"oPEP7c":""}')
  await expect(loginGeminiWeb(root, 'chrome', AbortSignal.timeout(20), vi.fn())).rejects.toBeDefined()
  expect(h.close).toHaveBeenCalledOnce(); expect(h.child.exitCode).toBe(0)
})

it('joins browser exit when cancellation interrupts cookie capture', async () => {
  const controller = new AbortController()
  const h = browserFixture(async () => { controller.abort(); return [] })
  await expect(loginGeminiWeb(root, 'msedge', controller.signal, vi.fn())).rejects.toBeDefined()
  expect(h.child.exitCode).toBe(0)
})

it('reports a busy profile or early browser exit without committing a session', async () => {
  const child = Object.assign(new EventEmitter(), { pid: 1234, exitCode: 0 })
  mocks.spawn.mockImplementation(() => { queueMicrotask(() => child.emit('exit', 0, null)); return child })
  await expect(loginGeminiWeb(root, 'msedge', AbortSignal.timeout(10_000), vi.fn())).rejects.toMatchObject({ code: 'PROFILE_BUSY_OR_BROWSER_EXITED' })
  expect(mocks.connect).not.toHaveBeenCalled()
})

it('retries CDP attachment while the normal browser finishes starting', async () => {
  const h = browserFixture(async () => [{ name: '__Secure-1PSID', value: 'fixture', domain: '.google.com', path: '/', secure: true, httpOnly: true, expires: -1 }])
  mocks.connect.mockRejectedValueOnce(new Error('Browser starting')).mockResolvedValue(h.browser)
  await loginGeminiWeb(root, 'msedge', AbortSignal.timeout(5000), vi.fn())
  expect(mocks.connect).toHaveBeenCalledTimes(2)
  expect(h.child.exitCode).toBe(0)
})

it('refuses unsupported hosts and an already cancelled login before launching', async () => {
  Object.defineProperty(process, 'platform', { value: 'linux' })
  await expect(loginGeminiWeb(root, 'msedge', new AbortController().signal, vi.fn())).rejects.toMatchObject({ code: 'WINDOWS_REQUIRED' })
  const signal = AbortSignal.abort()
  await expect(loginGeminiWeb(root, 'chrome', signal, vi.fn())).rejects.toMatchObject({ name: 'AbortError' })
  expect(mocks.spawn).not.toHaveBeenCalled()
})

it.each([null, 'path', new Error('Socket close failed')])('refuses invalid port reservations %#', async (address) => {
  const server = Object.assign(new EventEmitter(), { listen: () => { queueMicrotask(() => server.emit('listening')); return server },
    address: () => address, close: (callback: (error?: Error) => void) =>{  callback(address instanceof Error ? address : undefined) } })
  mocks.server.mockReturnValue(server as unknown as Server)
  await expect(loginGeminiWeb(root, 'msedge', new AbortController().signal, vi.fn())).rejects.toBeDefined()
  expect(mocks.spawn).not.toHaveBeenCalled()
})

it('reports a failed native spawn without trying to capture cookies', async () => {
  const child = Object.assign(new EventEmitter(), { pid: undefined, exitCode: null })
  mocks.spawn.mockImplementation(() => { queueMicrotask(() => child.emit('error', new Error('Spawn failed'))); return child })
  mocks.connect.mockRejectedValue(new Error('No CDP server'))
  await expect(loginGeminiWeb(root, 'msedge', AbortSignal.timeout(1000), vi.fn())).rejects.toMatchObject({ code: 'PROFILE_BUSY_OR_BROWSER_EXITED' })
})

it('refuses a browser without its owned context and contains CDP close errors', async () => {
  const h = browserFixture(async () => [])
  h.browser.contexts = () => []
  h.browser.newBrowserCDPSession = async () => { h.child.exitCode = 0; h.child.emit('exit', 0, null); throw new Error('Disconnected') }
  h.browser.close.mockRejectedValue(new Error('Already closed'))
  await expect(loginGeminiWeb(root, 'chrome', AbortSignal.timeout(1000), vi.fn())).rejects.toMatchObject({ code: 'NO_BROWSER_CONTEXT' })
})

it('waits for an authenticated page and exports host-only cookie attributes', async () => {
  const expired = Date.now() / 1000 + 60
  const cookies = [{ name: '__Secure-1PSID', value: 'fixture', domain: 'gemini.google.com', path: '/app', secure: true, httpOnly: false, expires: expired },
    { name: 'hostonly', value: 'fixture', domain: 'gemini.google.com', path: '/app', secure: false, httpOnly: false, expires: -1 }]
  const h = browserFixture(async () => cookies)
  const page = h.browser.contexts()[0]!.pages()[0]!
  let navigation = 0
  h.browser.contexts()[0]!.pages = () => [{ ...page, url: () => 'https://accounts.google.com/signin' },
    { ...page, waitForLoadState: async () => { if (navigation++ === 0) throw new Error('Loading') } }]
  const jar = await loginGeminiWeb(root, 'chrome', AbortSignal.timeout(5000), vi.fn())
  expect(await jar.getCookieString('https://gemini.google.com/app')).toBe('__Secure-1PSID=fixture; hostonly=fixture')
  expect(await jar.getCookieString('https://other.google.com/app')).toBe('')
})

it('contains cookie-capture exceptions and force-closes a nonresponsive owned process', async () => {
  vi.useFakeTimers()
  const h = browserFixture(async () => { throw new Error('Private CDP cookie failure') })
  h.close.mockRejectedValue(new Error('Disconnected'))
  mocks.kill.mockImplementation((_exe, _args, _options, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    h.child.exitCode = 0; h.child.emit('exit', 0, null); callback(null, '', '')
  })
  const operation = loginGeminiWeb(root, 'msedge', new AbortController().signal, vi.fn())
  const rejected = expect(operation).rejects.toMatchObject({ code: 'BROWSER_FAILED' })
  await vi.waitFor(() => { expect(h.close).toHaveBeenCalled() })
  await vi.advanceTimersByTimeAsync(3100); await rejected
  expect(mocks.kill).toHaveBeenCalledWith('taskkill', ['/PID', '1234', '/T', '/F'], expect.objectContaining({ windowsHide: true }), expect.any(Function))
})

/**
 * One Electron child process and the NDJSON conversation with it. Knows
 * nothing about agents; the service owns who may talk to which child.
 * @module @hydraharness/harness-browser-electron/child
 */

import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { createInterface } from 'node:readline'
import { PassThrough, Writable } from 'node:stream'
import type { Readable } from 'node:stream'
import { randomUUID } from 'node:crypto'
import { desktopPort } from '@hydraharness/harness-native-command/desktop-bridge'
import { fileURLToPath } from 'node:url'
import { BrowserError } from './types.ts'

/** Electron entry this package ships; sibling of `lib/` in a published install. */
const MAIN_ENTRY = fileURLToPath(new URL('../electron-app/main.cjs', import.meta.url))

/** Trailing child stderr retained to explain a launch failure. */
const STDERR_KEEP = 4_000

/** Grace between closing the child's stdin and killing it. */
const SHUTDOWN_GRACE_MS = 5_000

/** The part of `ChildProcess` this module uses; tests supply a stand-in. */
export interface BrowserChildProcess {
  readonly stdin: Writable
  readonly stdout: Readable
  readonly stderr: Readable
  once(event: 'exit' | 'error', listener: (payload?: unknown) => void): unknown
  kill(): unknown
}

/** A live embedded browser. */
export interface BrowserChild {
  /**
   * Send one request and await its reply.
   * @param method - protocol method the Electron main process understands.
   * @param args - JSON-safe arguments.
   * @param signal - cancels the native request and its permission questions; rejection waits for the child to finish it.
   * @returns the JSON-safe result.
   */
  call(method: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>
  /** Ask the child to exit, killing it if it will not. */
  close(): Promise<void>
  /** Settles when the child ends, however it ends. Never rejects. */
  readonly closed: Promise<void>
}

/** One OpenAI-shaped PageAgent request emitted by one controlled tab. */
export interface PageAgentLlmRequest {
  readonly tabId: number
  readonly request: unknown
}

/** Everything one child needs to start. */
export interface LaunchOptions {
  /** Cancel startup, including a pending home-page permission question. */
  readonly signal?: AbortSignal | undefined
  /** Chromium profile directory; a persistent one keeps SSO across sessions. */
  readonly userDataDir: string
  /** Optional HTTP(S) page loaded before the child reports itself ready. */
  readonly homeUrl?: string | undefined
  /** Keep session cookies in Chromium's encrypted persistent cookie store. */
  readonly persistSessionCookies?: boolean | undefined
  readonly width: number
  readonly height: number
  /** Headed by default, so the user watches what the agent does. */
  readonly show: boolean
  readonly startupTimeoutMs: number
  readonly actionTimeoutMs: number
  /** Bounded wait for a loaded document to expose usable SPA content. */
  readonly readinessTimeoutMs: number
  /** Whether experimental isolated-world JavaScript is allowed by the host. */
  readonly experimentalScriptExecution: boolean
  /** Organization ceiling for the elevated-risk full CDP setting. */
  readonly fullCdpAccessAllowed?: boolean | undefined
  /** User opt-in for full CDP access. */
  readonly fullCdpAccess?: boolean | undefined
  /** Destination for user-opened public HTTP(S) URLs. */
  readonly webDestination?: 'hydra' | 'system' | undefined
  /** Destination for user-opened loopback HTTP(S) URLs. */
  readonly localDestination?: 'hydra' | 'system' | undefined
  /** Screenshot behavior for browser annotations. */
  readonly annotationScreenshots?: 'include' | 'ask' | 'never' | undefined
  /** Directory used for downloads; an empty value keeps Electron's default. */
  readonly downloadDirectory?: string | undefined
  /** Whether Chromium asks for a path for every download. */
  readonly askWhereToSave?: boolean | undefined
  /** Default decision before navigating to a website without an override. */
  readonly navigationPolicy?: 'allow' | 'ask' | 'block' | undefined
  /** Default decision before a website download starts. */
  readonly downloadPolicy?: 'allow' | 'ask' | 'block' | undefined
  /** Explicit Electron binary; omitted resolves the `electron` package. */
  readonly electronPath?: string | undefined
  /** Test seam standing in for the real Electron spawn. */
  readonly spawnChild?: ((command: string, args: string[]) => BrowserChildProcess) | undefined
  /** Route PageAgent's private model request to the owning Hydra agent. */
  readonly onPageAgentLlm?: ((request: PageAgentLlmRequest) => Promise<unknown>) | undefined
  /** Ask in the owning chat; cancellation or an unavailable answerer denies access. */
  readonly onPermission?: ((request: { kind: 'navigation' | 'media' | 'geolocation' | 'notifications' | 'download'; origin: string; filename?: string }, signal: AbortSignal) => Promise<'once' | 'always' | 'block' | undefined>) | undefined
}

interface Reply {
  id?: number
  event?: string
  ok?: boolean
  result?: unknown
  error?: string
  tabId?: number
  request?: unknown
}

interface PendingCall {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
  resume(): void
}

interface DesktopParentPort {
  postMessage(message: unknown): void
  on(event: 'message', listener: (event: unknown) => void): void
  off(event: 'message', listener: (event: unknown) => void): void
}

/** Electron utility-process port, present only in the desktop Host child. */
function desktopParentPort(): DesktopParentPort | undefined {
  return desktopPort()
}

/** Adapt Electron utility messages to the established NDJSON child contract. */
function connectDesktopBrowser(port: DesktopParentPort, settings: Record<string, unknown>): BrowserChildProcess {
  const connectionId = randomUUID()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const events = new EventEmitter()
  let input = ''
  let closed = false

  const finish = (): void => {
    if (closed) return
    closed = true
    port.off('message', onMessage)
    stdout.end()
    stderr.end()
    events.emit('exit')
  }
  const onMessage = (event: unknown): void => {
    const message = typeof event === 'object' && event !== null && 'data' in event ? event.data : event
    if (typeof message !== 'object' || message === null || !('connectionId' in message) || message.connectionId !== connectionId) return
    if ('type' in message && message.type === 'hydra-browser-line' && 'line' in message && typeof message.line === 'string') {
      stdout.write(`${message.line}\n`)
    } else if ('type' in message && message.type === 'hydra-browser-error' && 'error' in message && typeof message.error === 'string') {
      stderr.write(message.error)
    } else if ('type' in message && message.type === 'hydra-browser-close') {
      finish()
    }
  }
  port.on('message', onMessage)

  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      input += String(chunk)
      const lines = input.split(/\r?\n/u)
      /* v8 ignore next -- String.split always returns at least one element. */
      input = lines.pop() ?? ''
      for (const line of lines) {
        /* v8 ignore next -- This private stream receives one nonempty JSON object per write. */
        if (line !== '') port.postMessage({ type: 'hydra-browser-line', connectionId, line })
      }
      callback()
    },
    final(callback) {
      port.postMessage({ type: 'hydra-browser-disconnect', connectionId })
      finish()
      callback()
    },
  })

  port.postMessage({ type: 'hydra-browser-connect', connectionId, settings })
  return {
    stdin,
    stdout,
    stderr,
    once(event, listener) {
      events.once(event, listener)
      return events
    },
    kill() {
      port.postMessage({ type: 'hydra-browser-disconnect', connectionId })
      finish()
    },
  }
}

/**
 * Locate the Electron binary the `electron` package downloaded.
 * @param load - module resolver; the parameter exists so the miss can be tested.
 * @returns absolute path to the executable.
 */
export function resolveElectronPath(load: NodeJS.Require = createRequire(import.meta.url)): string {
  try {
    return load('electron') as string
  } catch (cause) {
    throw new BrowserError(
      'the embedded browser needs the optional `electron` dependency, which is not installed',
      'BROWSER_UNAVAILABLE',
      { cause },
    )
  }
}

/**
 * Start one Electron child and wait until it reports itself ready.
 * @param options - profile, window, deadlines, and lifecycle callback.
 * @returns the live child, once it can accept requests.
 */
export async function launchBrowser(options: LaunchOptions): Promise<BrowserChild> {
  options.signal?.throwIfAborted()
  const settings = {
    userDataDir: options.userDataDir,
    ...options.homeUrl === undefined ? {} : { homeUrl: options.homeUrl },
    ...options.persistSessionCookies === true ? { persistSessionCookies: true } : {},
    width: options.width,
    height: options.height,
    show: options.show,
    readinessTimeoutMs: options.readinessTimeoutMs,
    experimentalScriptExecution: options.experimentalScriptExecution,
    ...options.fullCdpAccessAllowed === undefined ? {} : { fullCdpAccessAllowed: options.fullCdpAccessAllowed },
    ...options.fullCdpAccess === undefined ? {} : { fullCdpAccess: options.fullCdpAccess },
    ...options.webDestination === undefined ? {} : { webDestination: options.webDestination },
    ...options.localDestination === undefined ? {} : { localDestination: options.localDestination },
    ...options.annotationScreenshots === undefined ? {} : { annotationScreenshots: options.annotationScreenshots },
    ...options.downloadDirectory === undefined ? {} : { downloadDirectory: options.downloadDirectory },
    ...options.askWhereToSave === undefined ? {} : { askWhereToSave: options.askWhereToSave },
    ...options.navigationPolicy === undefined ? {} : { navigationPolicy: options.navigationPolicy },
    ...options.downloadPolicy === undefined ? {} : { downloadPolicy: options.downloadPolicy },
  }
  const bridgeMode = process.env.HYDRA_DESKTOP_BROWSER_BRIDGE
  const bridge = bridgeMode === 'parent-port' || bridgeMode === 'stdio' ? desktopParentPort() : undefined
  if ((bridgeMode === 'parent-port' || bridgeMode === 'stdio') && bridge === undefined) {
    throw new BrowserError('the desktop browser bridge is unavailable', 'BROWSER_LAUNCH_FAILED')
  }
  const child = bridge === undefined
    ? (options.spawnChild ?? spawn)(options.electronPath ?? resolveElectronPath(), [MAIN_ENTRY, JSON.stringify(settings)])
    : connectDesktopBrowser(bridge, settings)

  const pending = new Map<number, PendingCall>()
  const permissions = new Map<number, AbortController>()
  const ready = Promise.withResolvers<void>()
  const exited = Promise.withResolvers<void>()
  let nextId = 0
  let started = false
  let closing = false
  let ended: BrowserError | undefined
  let stderr = ''

  const end = (error: BrowserError): void => {
    if (ended !== undefined) return
    ended = error
    for (const controller of permissions.values()) controller.abort()
    permissions.clear()
    for (const call of pending.values()) {
      clearTimeout(call.timer)
      call.reject(error)
    }
    pending.clear()
    // A no-op once startup succeeded, which is the only way `call` is reachable.
    ready.reject(error)
    exited.resolve()
  }

  child.stderr.on('data', (chunk: unknown) => {
    stderr = (stderr + String(chunk)).slice(-STDERR_KEEP)
  })

  createInterface({ input: child.stdout }).on('line', (line: string) => {
    let reply: Reply
    try {
      reply = JSON.parse(line) as Reply
    } catch {
      // Electron writes its own noise to stdout before the app starts.
      return
    }
    if (reply.event === 'ready') {
      started = true
      ready.resolve()
      return
    }
    if (reply.event === 'browser:permission-cancelled') {
      if (reply.id !== undefined) permissions.get(reply.id)?.abort()
      return
    }
    if (reply.event === 'browser:permission') {
      const id = reply.id
      const onPermission = options.onPermission
      const request = reply.request as { kind?: unknown; origin?: unknown; filename?: unknown } | undefined
      const requestKind = request?.kind
      const respond = (choice?: string): void => {
        if (ended === undefined && !closing) child.stdin.write(`${JSON.stringify({ method: 'browser_permission_response', args: { id, choice } })}\n`)
      }
      if (typeof id !== 'number' || !Number.isSafeInteger(id) || permissions.has(id)
        || !['navigation', 'media', 'geolocation', 'notifications', 'download'].includes(requestKind as string) || typeof request?.origin !== 'string'
        || (request.filename !== undefined && (typeof request.filename !== 'string' || request.filename.length > 512))
        || !URL.canParse(request.origin) || !['http:', 'https:'].includes(new URL(request.origin).protocol)
        || new URL(request.origin).origin !== request.origin || onPermission === undefined) {
        respond()
        return
      }
      const controller = new AbortController()
      permissions.set(id, controller)
      clearTimeout(startup)
      for (const call of pending.values()) clearTimeout(call.timer)
      const cancelled = new Promise<undefined>((resolve) => {
        controller.signal.addEventListener('abort', () => { resolve(undefined) }, { once: true })
      })
      const kind = requestKind as 'navigation' | 'media' | 'geolocation' | 'notifications' | 'download'
      const origin = request.origin
      const filename = request.filename
      void Promise.race([cancelled, Promise.resolve().then(() => onPermission({ kind, origin,
        ...filename === undefined ? {} : { filename },
      }, controller.signal))])
        .then((choice) => { respond(controller.signal.aborted ? undefined : choice) }, () => { respond() })
        .finally(() => {
          permissions.delete(id)
          if (permissions.size === 0) {
            for (const call of pending.values()) call.resume()
            if (!started && ended === undefined && !closing) startup = setTimeout(startupExpired, options.startupTimeoutMs)
          }
        })
      return
    }
    if (reply.event === 'page-agent:llm') {
      const callId = reply.id
      const tabId = reply.tabId
      const respond = (args: Record<string, unknown>): void => {
        if (ended === undefined) child.stdin.write(`${JSON.stringify({ method: 'page_agent_llm_response', args })}\n`)
      }
      if (!Number.isSafeInteger(callId) || typeof tabId !== 'number' || !Number.isSafeInteger(tabId) || options.onPageAgentLlm === undefined) {
        respond({ callId, ok: false, error: 'PageAgent model bridge is unavailable' })
        return
      }
      void options.onPageAgentLlm({ tabId, request: reply.request }).then(
        (result) => { respond({ callId, ok: true, result }) },
        (error: unknown) => { respond({ callId, ok: false, error: error instanceof Error ? error.message : String(error) }) },
      )
      return
    }
    // -1 is never a live id, so an id-less line misses like any other stray
    // reply: one for a call that already timed out has nowhere to go either.
    const id = reply.id ?? -1
    const call = pending.get(id)
    if (call === undefined) return
    pending.delete(id)
    clearTimeout(call.timer)
    if (reply.ok === true) call.resolve(reply.result)
    else call.reject(new Error(reply.error ?? 'the embedded browser reported an unknown failure'))
  })

  child.once('exit', () => {
    end(started
      ? new BrowserError('the embedded browser exited', 'BROWSER_GONE')
      : new BrowserError(`the embedded browser exited before it was ready\n${stderr}`, 'BROWSER_LAUNCH_FAILED'))
  })
  child.once('error', (payload?: unknown) => {
    end(new BrowserError(`the embedded browser could not be started: ${String(payload)}`, 'BROWSER_LAUNCH_FAILED'))
  })

  const startupExpired = (): void => {
    child.kill()
    end(new BrowserError(
      `the embedded browser did not start within ${options.startupTimeoutMs}ms\n${stderr}`,
      'BROWSER_LAUNCH_FAILED',
    ))
  }
  let startup = setTimeout(startupExpired, options.startupTimeoutMs)
  const close = async (): Promise<void> => {
    closing = true
    for (const controller of permissions.values()) controller.abort()
    child.stdin.end()
    const forced = setTimeout(() => child.kill(), SHUTDOWN_GRACE_MS)
    forced.unref()
    try {
      await exited.promise
    } finally {
      clearTimeout(forced)
    }
  }
  const cancelStartup = (): void => {
    for (const controller of permissions.values()) controller.abort()
    ready.reject(options.signal?.reason)
  }
  options.signal?.addEventListener('abort', cancelStartup, { once: true })
  if (options.signal?.aborted) cancelStartup()
  try {
    await ready.promise
  } catch (error) {
    await close()
    throw error
  } finally {
    clearTimeout(startup)
    options.signal?.removeEventListener('abort', cancelStartup)
  }

  return {
    closed: exited.promise,

    call: (method, args, signal) => new Promise<unknown>((resolve, reject) => {
      signal?.throwIfAborted()
      if (ended !== undefined) {
        reject(ended)
        return
      }
      const id = ++nextId
      let cancellation: Error | undefined
      const expire = (): void => {
        if (cancellation !== undefined) { void close(); return }
        cancellation = new BrowserError(
          `the embedded browser did not answer ${method} within ${options.actionTimeoutMs}ms`,
          'BROWSER_TIMEOUT',
        )
        child.stdin.write(`${JSON.stringify({ method: 'cancel_browser_call', args: { id } })}\n`)
        // An unresponsive child must stop before another request can use its page.
        call.timer = setTimeout(() => { void close() }, SHUTDOWN_GRACE_MS)
        call.timer.unref()
      }
      const timer = setTimeout(expire, options.actionTimeoutMs)
      timer.unref()
      const cancel = (): void => {
        if (cancellation !== undefined) return
        cancellation = signal?.reason instanceof Error ? signal.reason : new Error('browser action cancelled')
        clearTimeout(call.timer)
        for (const controller of permissions.values()) controller.abort()
        /* v8 ignore next -- end rejects pending calls and removes their abort listeners synchronously. */
        if (ended === undefined) child.stdin.write(`${JSON.stringify({ method: 'cancel_browser_call', args: { id } })}\n`)
        call.resume()
      }
      const cleanup = (): void => { signal?.removeEventListener('abort', cancel) }
      const call: PendingCall = {
        resolve(value) { cleanup(); if (cancellation !== undefined) reject(cancellation); else resolve(value) },
        reject(error) { cleanup(); reject(cancellation ?? error) },
        timer, resume() {
          call.timer = setTimeout(expire, options.actionTimeoutMs)
          call.timer.unref()
        },
      }
      signal?.addEventListener('abort', cancel, { once: true })
      if (permissions.size > 0) clearTimeout(timer)
      pending.set(id, call)
      child.stdin.write(`${JSON.stringify({ id, method, args })}\n`)
    }),

    close,
  }
}

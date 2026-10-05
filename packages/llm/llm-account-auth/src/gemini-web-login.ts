/** User-operated login in an installed browser with a separate Host profile. */
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { once } from 'node:events'
import { mkdir, access } from 'node:fs/promises'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { CookieJar } from 'tough-cookie'
import type { Browser } from 'playwright-core'
import { GeminiWebError } from './gemini-web-http.ts'

/** Capture cookies only from an owned profile, closing the browser before returning.
 * @param root - Provider directory inside the Harness home.
 * @param channel - Installed Microsoft Edge or Chrome.
 * @param signal - Login cancellation, including the provider deadline.
 * @param notify - Non-secret progress callback.
 * @returns Domain-scoped cookies; the caller must validate HTTP before storing them.
 */
export async function loginGeminiWeb(root: string, channel: 'msedge' | 'chrome', signal: AbortSignal,
  notify: (message: string) => void): Promise<CookieJar> {
  signal.throwIfAborted()
  if (process.platform !== 'win32') throw new GeminiWebError('login', 'WINDOWS_REQUIRED')
  const executable = channel === 'msedge'
    ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
    : 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  await access(executable)
  await mkdir(root, { recursive: true, mode: 0o700 })
  const reservation = createServer()
  reservation.listen(0, '127.0.0.1')
  await once(reservation, 'listening')
  const address = reservation.address()
  await new Promise<void>((resolve, reject) => reservation.close((error) => { if (error) reject(error); else resolve() }))
  if (address === null || typeof address === 'string') throw new GeminiWebError('login', 'INVALID_LOOPBACK_PORT')
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL/i.test(key)))
  signal.throwIfAborted()
  const child = spawn(executable, [`--user-data-dir=${join(root, 'profile')}`,
    `--remote-debugging-port=${address.port}`, '--remote-debugging-address=127.0.0.1',
    '--no-first-run', '--no-default-browser-check', 'https://gemini.google.com/app'], { env, stdio: 'ignore' })
  const state = { spawnFailed: false }
  const exited = once(child, 'exit').then(() => {}, () => { state.spawnFailed = true })
  let browser: Browser | undefined
  try {
    const { chromium } = await import('playwright-core')
    while (browser === undefined) {
      signal.throwIfAborted()
      if (state.spawnFailed || child.exitCode !== null) throw new GeminiWebError('login', 'PROFILE_BUSY_OR_BROWSER_EXITED')
      try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${address.port}`, { timeout: 1000 }) }
      catch { await delay(250, undefined, { signal }) }
    }
    const context = browser.contexts()[0]
    if (context === undefined) throw new GeminiWebError('login', 'NO_BROWSER_CONTEXT')
    notify('Sign in to Gemini in the separate Hydra browser. The browser closes before HTTP validation.')
    while (true) {
      signal.throwIfAborted()
      const cookies = await context.cookies()
      let authenticated = false
      for (const page of context.pages()) {
        if (!page.url().startsWith('https://gemini.google.com/app')) continue
        try { await page.waitForLoadState('domcontentloaded', { timeout: 1000 }) }
        catch { continue /* An unfinished authentication navigation is checked again. */ }
        const html = await page.content()
        authenticated = html.length <= 16 * 1024 * 1024 && /"oPEP7c"\s*:\s*"[^\s"@]+@[^\s"@]+\.[^\s"]+"/.test(html)
        if (authenticated) break
      }
      if (cookies.some(cookie => cookie.name === '__Secure-1PSID')
        && authenticated) {
        const jar = new CookieJar()
        for (const cookie of cookies) {
          if (!/(?:^|\.)google\.com$/.test(cookie.domain)) continue
          const fields = [`${cookie.name}=${cookie.value}`, `Path=${cookie.path}`]
          if (cookie.domain.startsWith('.')) fields.push(`Domain=${cookie.domain}`)
          if (cookie.secure) fields.push('Secure')
          if (cookie.httpOnly) fields.push('HttpOnly')
          if (cookie.expires > 0) fields.push(`Expires=${new Date(cookie.expires * 1000).toUTCString()}`)
          await jar.setCookie(fields.join('; '), `https://${cookie.domain.replace(/^\./, '')}${cookie.path}`)
        }
        return jar
      }
      await delay(1000, undefined, { signal })
    }
  } catch (error) {
    if (error instanceof GeminiWebError || signal.aborted) throw error
    throw new GeminiWebError('login', 'BROWSER_FAILED')
  } finally {
    try {
      if (browser?.isConnected()) {
        const control = await browser.newBrowserCDPSession()
        const closing = control.send('Browser.close')
        void closing.catch(() => { /* Normal browser exit can disconnect this RPC. */ })
        await Promise.race([closing, delay(3000)])
      }
    } catch { /* Browser.close can disconnect before its response arrives. */ }
    if (child.exitCode === null) {
      const closed = await Promise.race([exited.then(() => true), delay(3000).then(() => false)])
      if (!closed && child.pid !== undefined) await promisify(execFile)('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, env })
    }
    await exited
    try { await browser?.close() } catch { /* The owned process has already exited. */ }
  }
}

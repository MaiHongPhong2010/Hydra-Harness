/** Owned-process Desktop transport for utility-process and WSL Hosts. */
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'

/** The framing version checked before the Desktop launcher accepts a Linux artifact. */
export const DESKTOP_BRIDGE_VERSION = 1
/** Reserved prefix distinguishes bridge frames from ordinary Host diagnostics. */
export const DESKTOP_BRIDGE_PREFIX = 'HYDRA_DESKTOP_BRIDGE:'

/** Transport owned by the launched Host process, never a renderer socket. */
export interface DesktopPort {
  /**
 * @param message - bounded bridge fact or request.
 */
  postMessage(message: unknown): void
  /**
 * @param event - incoming process messages.
 * @param listener - frame consumer.
 */
  on(event: 'message', listener: (event: unknown) => void): void
  /**
 * @param event - incoming process messages.
 * @param listener - installed consumer.
 */
  off(event: 'message', listener: (event: unknown) => void): void
}
let stdio: DesktopPort | undefined

/** Returns the authenticated transport owned by the launched Desktop parent process.
 * @returns the parent-owned transport; stdio requires an authenticated Desktop launch.
 */
export function desktopPort(): DesktopPort | undefined {
  const utility = (process as NodeJS.Process & { parentPort?: DesktopPort }).parentPort
  if (utility !== undefined) return utility
  if (process.env.HYDRA_DESKTOP_BROWSER_BRIDGE !== 'stdio') return undefined
  if (stdio !== undefined) return stdio
  const token = process.env.HYDRA_DESKTOP_BRIDGE_TOKEN
  if (token === undefined || !/^[a-f0-9]{64}$/u.test(token)) throw new Error('The Desktop bridge launch token is invalid')
  const bus = new EventEmitter()
  const lines = createInterface({ input: process.stdin })
  lines.on('line', (line) => {
    if (Buffer.byteLength(line) > 8 * 1024 * 1024) return
    let frame: unknown
    try { frame = JSON.parse(line) as unknown }
    catch { return /* Non-JSON stdin cannot authenticate as a Desktop frame. */ }
    if (typeof frame !== 'object' || frame === null || !('token' in frame) || frame.token !== token || !('message' in frame)) return
    bus.emit('message', frame.message)
  })
  stdio = { postMessage: (message) => { process.stdout.write(`${DESKTOP_BRIDGE_PREFIX}${JSON.stringify({ token, message })}\n`) },
    on: (event, listener) => { bus.on(event, listener) }, off: (event, listener) => { bus.off(event, listener) } }
  return stdio
}

/** Executes an allowlisted native operation through the owned parent transport.
 * @param operation - allowlisted OS action.
 * @param path - Host-validated filesystem target.
 * @param signal - caller lifetime.
 * @returns Desktop response.
 */
export function desktopNativeRequest(operation: 'pick-directory' | 'open-path' | 'open-text', path: string | undefined, signal: AbortSignal): Promise<unknown> {
  const port = desktopPort()
  if (port === undefined) return Promise.reject(new Error('The Desktop native bridge is unavailable'))
  signal.throwIfAborted()
  const requestId = randomUUID()
  return new Promise((resolve, reject) => {
    const clear = (): void => { port.off('message', receive); signal.removeEventListener('abort', abort) }
    const abort = (): void => {
      clear()
      port.postMessage({ type: 'hydra-native-cancel', requestId })
      reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)))
    }
    const receive = (event: unknown): void => {
      const frame = typeof event === 'object' && event !== null && 'data' in event ? event.data : event
      if (typeof frame !== 'object' || frame === null || !('type' in frame) || frame.type !== 'hydra-native-result' || !('requestId' in frame) || frame.requestId !== requestId) return
      clear()
      if ('error' in frame && typeof frame.error === 'string') reject(new Error(frame.error))
      else resolve('value' in frame ? frame.value : undefined)
    }
    port.on('message', receive)
    signal.addEventListener('abort', abort, { once: true })
    port.postMessage({ type: 'hydra-native-request', requestId, operation, ...path === undefined ? {} : { path } })
  })
}

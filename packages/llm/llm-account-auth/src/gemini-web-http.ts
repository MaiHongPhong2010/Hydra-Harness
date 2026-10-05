/** Bounded Gemini Web HTTP media transport using observed, unofficial RPCs. */
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { CookieJar } from 'tough-cookie'
import { Agent } from 'undici'
import { attributionHeaders } from '@hydraharness/harness-llm'
import type { Branded } from '@hydraharness/harness-brand'
import type { ImageMediaType } from '@hydraharness/harness-attachment'

const ORIGIN = 'https://gemini.google.com'
const GENERATE = `${ORIGIN}/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate`
const BATCH = `${ORIGIN}/_/BardChatUi/data/batchexecute`
const UPLOAD = 'https://push.clients6.google.com/upload/'

/** Verified image bytes retained only for one video request. */
export interface GeminiWebInputImage {
  data: Uint8Array
  mimeType: ImageMediaType
}

/** Controlled diagnostics never contain provider bodies, URLs, or cookie values. */
export class GeminiWebError extends Error {
  constructor(readonly stage: string, readonly code: string, readonly status?: number) {
    super(`Gemini ${stage}: ${code}${status === undefined ? '' : ` (HTTP ${status})`}`)
  }
}

/** Minimum task identifiers persisted separately from cookies and signed media URLs. */
export interface GeminiWebJob {
  id: Branded<'GeminiWebJobId'>
  kind: 'image' | 'video'
  cid: Branded<'GeminiWebConversationId'>
  rid: Branded<'GeminiWebReplyId'>
  rcid: Branded<'GeminiWebCandidateId'>
}

/** Initialize a validated local job with empty provider identifiers.
 * @param id - UUID already validated at the caller's JSON or allocation boundary.
 * @param kind - Requested media family.
 * @returns A task whose provider identifiers are populated by HTTP checkpoints.
 */
export function geminiWebJob(id: string, kind: GeminiWebJob['kind']): GeminiWebJob {
  return { id: id as GeminiWebJob['id'], kind, cid: '' as GeminiWebJob['cid'], rid: '' as GeminiWebJob['rid'], rcid: '' as GeminiWebJob['rcid'] }
}

/** Selected generated media, retained only for the current operation. */
export interface GeminiWebMedia {
  url: string
  imageId?: string
}

function at(value: unknown, path: readonly (number | string)[]): unknown {
  let current = value
  for (const key of path) {
    if (typeof key === 'number') {
      if (!Array.isArray(current)) return undefined
      current = current[key] as unknown
    } else {
      if (current === null || typeof current !== 'object' || Array.isArray(current)) return undefined
      current = (current as Record<string, unknown>)[key]
    }
  }
  return current
}

function list(value: unknown): unknown[] { return Array.isArray(value) ? value : [] }
function text(value: unknown): string { return typeof value === 'string' ? value : '' }

function json(value: string, stage: string): unknown {
  try { return JSON.parse(value) as unknown }
  catch { throw new GeminiWebError(stage, 'INVALID_JSON') }
}

/** Decode anti-XSSI frames whose lengths count UTF-16 units, including the leading newline. */
export class GeminiWebFrames {
  private buffer = ''
  private prefix = false

  /** Decode complete frames, retaining a split frame for the next call.
   * @param chunk - TextDecoder output, never independently decoded UTF-8 chunks.
   * @returns All complete wire records in order.
   */
  feed(chunk: string): unknown[] {
    this.buffer += chunk
    if (!this.prefix) {
      if (this.buffer.length < 4) return []
      if (!this.buffer.startsWith(")]}'")) throw new GeminiWebError('response', 'MISSING_XSSI_PREFIX')
      this.buffer = this.buffer.slice(4)
      this.prefix = true
    }
    const records: unknown[] = []
    while (true) {
      this.buffer = this.buffer.trimStart()
      if (this.buffer.length === 0) break
      const marker = /^(\d+)\n/.exec(this.buffer)
      if (marker === null) {
        if (!/^\d+$/.test(this.buffer)) throw new GeminiWebError('response', 'INVALID_FRAME_LENGTH')
        break
      }
      const digits = marker[0].slice(0, -1)
      const length = Number(digits)
      if (!Number.isSafeInteger(length) || length < 1 || length > 16 * 1024 * 1024) {
        throw new GeminiWebError('response', 'INVALID_FRAME_LENGTH')
      }
      const start = digits.length
      if (this.buffer.length < start + length) break
      const record = json(this.buffer.slice(start, start + length), 'response')
      records.push(...list(record))
      this.buffer = this.buffer.slice(start + length)
    }
    return records
  }

  /** Reject an incomplete prefix or frame after EOF. */
  finish(): void {
    if (!this.prefix || this.buffer.trim().length > 0) throw new GeminiWebError('response', 'TRUNCATED_FRAME')
  }
}

/** Extract only bootstrap request fields; the HTML is not retained.
 * @param html - Authenticated Gemini application HTML.
 * @returns Current CSRF token, web build, and session id.
 */
export function geminiWebBootstrap(html: string): Record<'SNlM0e' | 'cfb2h' | 'FdrFJe', string> {
  const field = (key: string): string => {
    const captured = new RegExp(`"${key}"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*")`).exec(html)?.[1]
    if (captured === undefined) throw new GeminiWebError('bootstrap', 'RECONNECT_REQUIRED')
    const value = json(captured, 'bootstrap')
    if (typeof value !== 'string' || value === '') throw new GeminiWebError('bootstrap', 'INVALID_METADATA')
    return value
  }
  return { SNlM0e: field('SNlM0e'), cfb2h: field('cfb2h'), FdrFJe: field('FdrFJe') }
}

/** Extract generated media from a selected candidate; search images and thumbnails are excluded.
 * A completed text reply without media raises NO_GENERATED_MEDIA, except while a video chip remains pending.
 * The observed English video quota refusal raises QUOTA_EXHAUSTED.
 * @param candidate - Candidate selected by the stored reply id.
 * @param kind - Requested generated media family.
 * @returns Original-download metadata, or undefined while the reply or video is pending.
 */
export function geminiWebCandidate(candidate: unknown, kind: GeminiWebJob['kind']): GeminiWebMedia | undefined {
  if (kind === 'image') {
    const images = [...list(at(candidate, [12, 7, 0])), ...list(at(candidate, [12, 0, '8', 0]))]
    for (const image of images) {
      const url = text(at(image, [0, 3, 3]))
      const imageId = text(at(image, [1, 0]))
      if (url && imageId) return { url, imageId }
    }
  } else {
    for (const video of list(at(candidate, [12, 0, '60', 0, 0, 0]))) {
      const url = text(at(video, [7, 1]))
      if (url) return { url }
    }
    const omniVideo = text(at(candidate, [12, 86, 1, 1, 7, 1]))
    if (omniVideo) return { url: omniVideo }
    if (text(at(candidate, [1, 0])).includes('I can create more videos as soon as your limit resets.')) {
      throw new GeminiWebError('video', 'QUOTA_EXHAUSTED')
    }
  }
  const pendingVideo = kind === 'video' && text(at(candidate, [12, 0, '65', 1])) !== ''
  if (at(candidate, [8, 0]) === 2 && text(at(candidate, [1, 0])).trim() && !pendingVideo) {
    throw new GeminiWebError(kind, 'NO_GENERATED_MEDIA')
  }
  return undefined
}

/** Admit only HTTPS media hosts observed in the Gemini browser flow.
 * @param value - Provider-returned asset or redirect URL.
 * @returns The admitted URL.
 */
export function geminiWebMediaUrl(value: string): URL {
  let url: URL
  try { url = new URL(value) } catch { throw new GeminiWebError('download', 'INVALID_MEDIA_URL') }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash
    || !(url.hostname === 'contribution.usercontent.google.com' || url.hostname === 'lh3.google.com'
      || url.hostname === 'work.fife.usercontent.google.com'
      || /^lh\d+\.googleusercontent\.com$/.test(url.hostname))) {
    const host = /^(?:[a-z0-9-]+\.)*(?:google\.com|googleusercontent\.com)$/.test(url.hostname) ? url.hostname : 'external'
    throw new GeminiWebError('download', `UNSUPPORTED_MEDIA_HOST:${host}`)
  }
  return url
}

async function readBytes(response: Response, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
  if (response.body === null) throw new GeminiWebError('response', 'EMPTY_BODY')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      signal.throwIfAborted()
      const result = await reader.read()
      if (result.done) break
      size += result.value.byteLength
      if (size > maxBytes) throw new GeminiWebError('response', 'BYTE_LIMIT')
      chunks.push(result.value)
    }
  } finally { try { await reader.cancel() } finally { reader.releaseLock() } }
  return Buffer.concat(chunks, size)
}

/** One HTTP-only client; generation is sent once and retrieval never submits a prompt. */
export class GeminiWebHttp {
  private metadata: ReturnType<typeof geminiWebBootstrap> | undefined
  private pushId: unknown
  private requestId = 10000
  private readonly dispatcher = new Agent({ maxHeaderSize: 64 * 1024 })

  constructor(private readonly jar: CookieJar, private readonly signal: AbortSignal,
    private readonly fetcher: typeof fetch = fetch) {}

  private async request(url: string, init: RequestInit = {}): Promise<Response> {
    this.signal.throwIfAborted()
    const headers = new Headers({ ...attributionHeaders(), ...Object.fromEntries(new Headers(init.headers)) })
    const cookie = await this.jar.getCookieString(url)
    if (cookie) headers.set('cookie', cookie)
    let response: Response
    try { response = await this.fetcher(url, { ...init, signal: this.signal, redirect: 'manual', headers,
      ...{ dispatcher: this.dispatcher },
    }) }
    catch (error) {
      this.signal.throwIfAborted()
      const cause = error instanceof Error ? error.cause : undefined
      const code = cause !== null && typeof cause === 'object' && 'code' in cause ? cause.code : undefined
      throw new GeminiWebError('http', ['HPE_HEADER_OVERFLOW', 'UND_ERR_HEADERS_OVERFLOW', 'UND_ERR_CONNECT_TIMEOUT',
        'UND_ERR_SOCKET', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN']
        .includes(typeof code === 'string' ? code : '') ? String(code) : 'TRANSPORT_ERROR')
    }
    try {
      for (const value of response.headers.getSetCookie()) await this.jar.setCookie(value, url)
    } catch {
      await response.body?.cancel()
      throw new GeminiWebError('session', 'INVALID_SET_COOKIE')
    }
    return response
  }

  /** Release owned HTTP connections after every response body has been consumed or cancelled. */
  async close(): Promise<void> { await this.dispatcher.close() }

  /** Validate the stored session without a generation request.
   * @returns HTTP-verified Google account label, kept out of model transcripts.
   */
  async bootstrap(): Promise<{ email: string }> {
    const response = await this.request(`${ORIGIN}/app`, { headers: { accept: 'text/html' } })
    if (response.status !== 200) {
      await response.body?.cancel()
      throw new GeminiWebError('bootstrap', 'RECONNECT_REQUIRED', response.status)
    }
    const html = new TextDecoder('utf-8', { fatal: true })
      .decode(await readBytes(response, 16 * 1024 * 1024, this.signal))
    this.metadata = geminiWebBootstrap(html)
    const push = /"qKIAYe"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(html)?.[1]
    this.pushId = push === undefined ? undefined : json(push, 'bootstrap')
    const email = /"oPEP7c"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(html)?.[1]
    const value = email === undefined ? undefined : json(email, 'bootstrap')
    if (typeof value !== 'string' || value.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      throw new GeminiWebError('bootstrap', 'RECONNECT_REQUIRED')
    }
    return { email: value }
  }

  private params(): { query: URLSearchParams; token: string } {
    const metadata = this.metadata
    if (metadata === undefined) throw new GeminiWebError('session', 'BOOTSTRAP_REQUIRED')
    this.requestId += 100000
    return { query: new URLSearchParams({ hl: 'en', rt: 'c', _reqid: String(this.requestId),
      bl: metadata.cfb2h, 'f.sid': metadata.FdrFJe }), token: metadata.SNlM0e }
  }

  private async frames(response: Response, receive: (frame: unknown) => Promise<void>): Promise<void> {
    if (response.body === null) throw new GeminiWebError('response', 'EMPTY_BODY')
    const reader = response.body.getReader()
    const decoder = new TextDecoder('utf-8', { fatal: true })
    const parser = new GeminiWebFrames()
    let bytes = 0
    try {
      while (true) {
        this.signal.throwIfAborted()
        const result = await reader.read()
        if (result.done) break
        bytes += result.value.byteLength
        if (bytes > 16 * 1024 * 1024) throw new GeminiWebError('response', 'BYTE_LIMIT')
        for (const frame of parser.feed(decoder.decode(result.value, { stream: true }))) await receive(frame)
      }
      decoder.decode()
      parser.finish()
    } finally { try { await reader.cancel() } finally { reader.releaseLock() } }
  }

  private async post(url: string, payload: unknown, receive: (frame: unknown) => Promise<void>,
    extra?: Record<string, string>): Promise<void> {
    const { query, token } = this.params()
    for (const [key, value] of Object.entries(extra ?? {})) query.set(key, value)
    const response = await this.request(`${url}?${query}`, { method: 'POST', headers: {
      'content-type': 'application/x-www-form-urlencoded;charset=UTF-8', origin: ORIGIN, referer: `${ORIGIN}/`, 'x-same-domain': '1',
    }, body: new URLSearchParams({ at: token, 'f.req': JSON.stringify(payload) }) })
    if (response.status !== 200) {
      await response.body?.cancel()
      throw new GeminiWebError('rpc', [401, 403].includes(response.status) ? 'RECONNECT_REQUIRED' : 'HTTP_ERROR', response.status)
    }
    await this.frames(response, receive)
  }

  private async batch(rpc: string, payload: unknown): Promise<unknown[]> {
    const results: unknown[] = []
    await this.post(BATCH, [[[rpc, JSON.stringify(payload), null, 'generic']]], (frame) => {
      if (at(frame, [0]) !== 'wrb.fr' || at(frame, [1]) !== rpc) return Promise.resolve()
      const value = at(frame, [2])
      if (typeof value !== 'string') throw new GeminiWebError('rpc', 'MISSING_RPC_RESULT')
      results.push(json(value, 'rpc'))
      return Promise.resolve()
    }, { rpcids: rpc, 'source-path': '/app' })
    return results
  }

  private async upload(image: GeminiWebInputImage, index: number): Promise<unknown[]> {
    if (typeof this.pushId !== 'string' || !/^feeds\/[a-zA-Z0-9_-]{1,256}$/.test(this.pushId)) {
      throw new GeminiWebError('upload', 'MISSING_PUSH_ID')
    }
    const name = `reference-${index + 1}.${image.mimeType.slice(6).replace('jpeg', 'jpg')}`
    const headers = { origin: ORIGIN, referer: `${ORIGIN}/`, 'x-tenant-id': 'bard-storage',
      'content-type': 'application/x-www-form-urlencoded;charset=UTF-8', 'push-id': this.pushId }
    const started = await this.request(UPLOAD, { method: 'POST', headers: { ...headers,
      'x-goog-upload-command': 'start', 'x-goog-upload-protocol': 'resumable',
      'x-goog-upload-header-content-length': String(image.data.byteLength),
    }, body: `File name: ${name}` })
    const location = started.headers.get('x-goog-upload-url')
    await started.body?.cancel()
    if (started.status !== 200) throw new GeminiWebError('upload', 'HTTP_ERROR', started.status)
    let url: URL
    try { url = new URL(location ?? '') } catch { throw new GeminiWebError('upload', 'INVALID_UPLOAD_URL') }
    if (url.origin !== new URL(UPLOAD).origin || url.pathname !== '/upload/' || url.username || url.password || url.hash) {
      throw new GeminiWebError('upload', 'INVALID_UPLOAD_URL')
    }
    const completed = await this.request(url.href, { method: 'POST', headers: { ...headers,
      'x-goog-upload-command': 'upload, finalize', 'x-goog-upload-offset': '0',
    }, body: Buffer.from(image.data) })
    if (completed.status !== 200) {
      await completed.body?.cancel()
      throw new GeminiWebError('upload', 'HTTP_ERROR', completed.status)
    }
    const path = new TextDecoder('utf-8', { fatal: true }).decode(await readBytes(completed, 4096, this.signal)).trim()
    if (!/^\/contrib_service\/[a-zA-Z0-9_./-]+$/.test(path)) throw new GeminiWebError('upload', 'INVALID_FILE_REFERENCE')
    return [[path, 1, null, image.mimeType, randomUUID()], name]
  }

  /** Submit exactly once and persist task identifiers as each complete frame arrives.
   * @param job - Newly allocated local job with empty provider ids.
   * @param prompt - Final text prompt.
   * @param save - Durable checkpoint callback, excluding media URLs.
   * @param input - Verified reference images and selected video orientation.
   * @returns Generated media metadata, or undefined when status retrieval is required.
   */
  async generate(job: GeminiWebJob, prompt: string, save: () => Promise<void>,
    input: { images?: readonly GeminiWebInputImage[]; size?: '1280x720' | '720x1280' } = {},
  ): Promise<GeminiWebMedia | undefined> {
    if (!prompt.trim() || prompt.length > 32000 || job.cid || job.rid || job.rcid) {
      throw new GeminiWebError('submit', 'INVALID_NEW_JOB')
    }
    if (this.metadata === undefined) await this.bootstrap()
    const body: unknown[] = new Array(81).fill(null)
    body[0] = [prompt, 0, null, null, null, null, 0]
    if (input.images !== undefined) {
      const uploaded: unknown[] = []
      for (const [index, image] of input.images.entries()) uploaded.push(await this.upload(image, index))
      body[0] = [prompt, 0, null, uploaded, null, null, 0, null, null,
        [null, null, null, null, null, null, [[null, null, null, 2]]]]
      body[30] = [4, 16]
    }
    body[1] = ['en']
    body[2] = ['', '', '', null, null, null, null, null, null, '']
    body[6] = [1]; body[7] = 1; body[10] = 1; body[11] = 0
    body[17] = [[0]]; body[18] = 0; body[27] = 1; body[30] ??= [4]; body[41] = [1]
    body[49] = job.kind === 'image' ? 14 : 11
    body[53] = 0
    if (job.kind === 'video') body[55] = [[input.size === '720x1280' ? 17 : 16]]
    body[59] = randomUUID().toUpperCase(); body[61] = []; body[68] = 1; body[80] = 1
    let media: GeminiWebMedia | undefined
    await this.post(GENERATE, [null, JSON.stringify(body)], async (frame) => {
      const errorCode = at(frame, [5, 2, 0, 1, 0])
      if (typeof errorCode === 'number') throw new GeminiWebError('submit', 'PROVIDER_REJECTED')
      if (at(frame, [0]) !== 'wrb.fr') return
      const payload = at(frame, [2])
      if (typeof payload !== 'string') return
      const result = json(payload, 'response')
      const cid = text(at(result, [1, 0]))
      const rid = text(at(result, [1, 1]))
      if ((cid && job.cid && cid !== job.cid) || (rid && job.rid && rid !== job.rid)) return
      if (cid) job.cid ||= cid as GeminiWebJob['cid']
      if (rid) job.rid ||= rid as GeminiWebJob['rid']
      for (const candidate of list(at(result, [4]))) {
        const rcid = text(at(candidate, [0]))
        if (!rcid) continue
        job.rcid ||= rcid as GeminiWebJob['rcid']
        if (rcid !== job.rcid) continue
        media = geminiWebCandidate(candidate, job.kind) ?? media
      }
      await save()
    })
    if (!job.cid || !job.rid) throw new GeminiWebError('submit', 'NO_RECOVERABLE_JOB')
    return media
  }

  /** Poll only the stored conversation and reply.
   * @param job - Accepted task identifiers.
   * @param intervalMs - Delay between read-only status requests.
   * @param save - Persist a candidate id first supplied by polling.
   * @returns Generated media from the selected reply.
   */
  async retrieve(job: GeminiWebJob, intervalMs = 10000, save: () => Promise<void> = async () => {}): Promise<GeminiWebMedia> {
    if (!job.cid || !job.rid) throw new GeminiWebError('retrieve', 'NO_RECOVERABLE_JOB')
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) throw new GeminiWebError('retrieve', 'INVALID_POLL_INTERVAL')
    if (this.metadata === undefined) await this.bootstrap()
    while (true) {
      const results = await this.batch('hNvQHb', [job.cid, 5, null, 1, [1], [4], null, 1])
      for (const result of results) {
        for (const turn of list(at(result, [0]))) {
          if (text(at(turn, [0, 1])) !== job.rid) continue
          for (const candidate of list(at(turn, [3, 0]))) {
            const rcid = text(at(candidate, [0]))
            if (!rcid) continue
            if (!job.rcid) {
              job.rcid = rcid as GeminiWebJob['rcid']
              await save()
            }
            if (rcid !== job.rcid) continue
            const media = geminiWebCandidate(candidate, job.kind)
            if (media !== undefined) return media
          }
        }
      }
      await delay(intervalMs, undefined, { signal: this.signal })
    }
  }

  /** Resolve the original image URL through the web download RPC, without thumbnail fallback.
   * @param job - Accepted image task.
   * @param media - Selected generated image metadata.
   * @returns Original image URL kept only in memory.
   */
  async originalImage(job: GeminiWebJob, media: GeminiWebMedia): Promise<string> {
    if (job.kind !== 'image' || !media.imageId) throw new GeminiWebError('image-link', 'MISSING_IMAGE_ID')
    const results = await this.batch('c8o8Fe', [
      [[null, null, null, [null, null, null, null, null, '']], [media.imageId, 0], null, [19, ''], null, null, null, null, null, ''],
      [job.rid, job.rcid, job.cid, null, ''], 1, 0, 1,
    ])
    const url = text(at(results[0], [0]))
    if (!url) throw new GeminiWebError('image-link', 'NO_ORIGINAL_URL')
    return geminiWebMediaUrl(url).href
  }

  /** Download a complete generated asset, following admitted redirects with domain-scoped cookies.
   * @param value - Original asset URL.
   * @param kind - Required generated media family.
   * @returns Bounded bytes and verified MIME; no URL is included in the result.
   */
  async download(value: string, kind: GeminiWebJob['kind']): Promise<{ data: Uint8Array; mime: string }> {
    let url = geminiWebMediaUrl(value)
    for (let redirects = 0; redirects <= 5; redirects++) {
      const response = await this.request(url.href, { headers: { origin: ORIGIN, referer: `${ORIGIN}/` } })
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location')
        await response.body?.cancel()
        if (!location) throw new GeminiWebError('download', 'MISSING_REDIRECT')
        url = geminiWebMediaUrl(new URL(location, url).href)
        continue
      }
      if (response.status !== 200 && response.status !== 206) {
        await response.body?.cancel()
        throw new GeminiWebError('download', 'HTTP_ERROR', response.status)
      }
      const mime = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? ''
      if (!(kind === 'video' ? mime === 'video/mp4' : ['image/png', 'image/jpeg', 'image/webp'].includes(mime))) {
        await response.body?.cancel()
        throw new GeminiWebError('download', 'INVALID_MEDIA_TYPE')
      }
      const max = kind === 'video' ? 100 * 1024 * 1024 : 32 * 1024 * 1024
      let total: number | undefined
      if (response.status === 206) {
        const range = /^bytes 0-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') ?? '')
        total = range === null ? undefined : Number(range[2])
        if (range === null || total === undefined || !Number.isSafeInteger(total) || Number(range[1]) + 1 !== total || total > max) {
          await response.body?.cancel()
          throw new GeminiWebError('download', 'INCOMPLETE_RANGE', 206)
        }
      }
      const data = await readBytes(response, max, this.signal)
      const contentLength = response.headers.get('content-length')
      if (!data.length || (total !== undefined && total !== data.length)
        || (contentLength !== null && Number(contentLength) !== data.length)) {
        throw new GeminiWebError('download', 'INCOMPLETE_BODY')
      }
      const buffer = Buffer.from(data)
      const valid = mime === 'video/mp4' ? buffer.subarray(4, 8).toString('ascii') === 'ftyp'
        : mime === 'image/png' ? buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          : mime === 'image/jpeg' ? buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255
            : buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP'
      if (!valid) throw new GeminiWebError('download', 'INVALID_MEDIA_SIGNATURE')
      return { data, mime }
    }
    throw new GeminiWebError('download', 'REDIRECT_LIMIT')
  }
}

/** Single-account Gemini Web media transport with version-checked Host grants and durable jobs. */
import type { Context } from '@hydraharness/cordis'
import { randomUUID, createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, rename, unlink, lstat, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import z from '@hydraharness/schemastery'
import { CookieJar } from 'tough-cookie'
import { resolveHydraHome } from '@hydraharness/harness-home-paths'
import { credentialKey, type CredentialRecord } from '@hydraharness/harness-credentials'
import { authorizationAccountId, type AuthorizationSession } from '@hydraharness/harness-authorization'
import { LlmAdapter, LlmError, type GenerateOptions, type LlmDiscoveredModel, type LlmModelInfo,
  type MediaGenerationOptions, type StreamChunk, type AdapterRegistrationHandle } from '@hydraharness/harness-llm'
import { GeminiWebHttp, GeminiWebError, geminiWebJob, type GeminiWebJob } from './gemini-web-http.ts'
import { loginGeminiWeb } from './gemini-web-login.ts'
import type { AccountModelProfile } from './config.ts'
import type { GeminiWebInputImage } from './gemini-web-http.ts'

/** Deployment settings for the managed browser and bounded HTTP operations. */
export interface GeminiWebConfig {
  /** Installed browser used only for authentication. */
  browser?: 'msedge' | 'chrome'
  /** Harness home override; omitted uses the common Host resolver. */
  hydraHome?: string
  /** Maximum interactive sign-in duration. */
  loginTimeoutMs?: number
  /** Maximum HTTP generation or retrieval duration. */
  requestTimeoutMs?: number
  /** Delay between saved-task status reads. */
  pollIntervalMs?: number
}

/** Loader defaults for Gemini Web operations. */
export const GeminiWebConfig: z<GeminiWebConfig> = z.object({
  browser: z.union(['msedge', 'chrome']).default('msedge'), hydraHome: z.string(),
  loginTimeoutMs: z.number().step(1).min(1).max(2_147_483_647).default(900_000),
  requestTimeoutMs: z.number().step(1).min(1).max(2_147_483_647).default(900_000),
  pollIntervalMs: z.number().step(1).min(1).max(2_147_483_647).default(10_000),
})

const KEY = credentialKey('llm-account-auth', 'gemini-web')
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/
const CATALOG = [
  { id: 'gemini-web-image', name: 'Gemini Web Image', endpoints: ['images/generations'] },
  { id: 'gemini-web-video', name: 'Gemini Web Video', endpoints: ['videos'] },
] satisfies LlmDiscoveredModel[]

interface Grant {
  version: 1
  revision: string
  accountId: string
  label: string
  jar: unknown
}
interface Job extends GeminiWebJob {
  version: 1
  accountId: string
  status: 'submitting' | 'accepted' | 'downloaded' | 'uncertain' | 'failed'
}
interface Operation { controller: AbortController; done: Promise<unknown> }

function grant(record: CredentialRecord | undefined): Grant | undefined {
  if (record === undefined) return undefined
  const value = record.kind === 'grant' ? record.payload : undefined
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new LlmError('Gemini Web session is invalid. Reconnect the account.', 'RECONNECT_REQUIRED')
  const row = value as Record<string, unknown>
  if (row.version !== 1 || typeof row.revision !== 'string' || !UUID.test(row.revision)
    || typeof row.accountId !== 'string' || !/^[a-f0-9]{64}$/.test(row.accountId)
    || typeof row.label !== 'string' || row.label.length < 1 || row.label.length > 320
    || row.jar === null || typeof row.jar !== 'object' || Array.isArray(row.jar)
    || JSON.stringify(row.jar).length > 2 * 1024 * 1024) throw new LlmError('Gemini Web session is invalid. Reconnect the account.', 'RECONNECT_REQUIRED')
  return row as unknown as Grant
}

async function privateJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 })
  try { await rename(temporary, path) }
  catch (error) {
    try { await unlink(temporary) } catch { /* Preserve the atomic write failure when temporary cleanup also fails. */ }
    throw error
  }
}

/** Gemini media adapter; generation and retrieval share attachment-compatible replies. */
export class GeminiWebAdapter extends LlmAdapter {
  private registration: AdapterRegistrationHandle | undefined
  private catalog: readonly (LlmDiscoveredModel & { name: string })[] = CATALOG
  private readonly operations = new Set<Operation>()
  private mediaBusy = false
  private loginBusy = false
  private closed = false
  private removing = false

  constructor(private readonly ctx: Context, private readonly config: () => GeminiWebConfig | undefined) { super() }

  /** Update the callable route after a settings commit.
   * @param enabled - Whether the user has applied this provider profile.
   * @param models - Applied replacement aliases and their display names.
   */
  configure(enabled: boolean, models?: readonly AccountModelProfile[]): void {
    this.catalog = models?.length ? models.map(model => ({ id: model.id,
      name: model.name ?? (model.id === 'gemini-web-image' ? 'Gemini Web Image' : 'Gemini Web Video'),
      endpoints: [model.id === 'gemini-web-image' ? 'images/generations' : 'videos'],
    })) : CATALOG
    if (this.registration !== undefined) this.registration.replace(enabled ? ['gemini-web'] : [])
    else if (enabled) this.registration = this.ctx.llm.registerAdapter(['gemini-web'], this)
  }

  private spec() {
    const raw = this.config() ?? {}
    return { root: join(resolveHydraHome(raw.hydraHome), 'gemini-web'), browser: raw.browser ?? 'msedge',
      loginTimeoutMs: raw.loginTimeoutMs ?? 900_000, requestTimeoutMs: raw.requestTimeoutMs ?? 900_000,
      pollIntervalMs: raw.pollIntervalMs ?? 10_000 }
  }

  private store() {
    const store = this.ctx.get('credentials')
    if (store === undefined) throw new LlmError('Gemini Web requires the Host credential store.', 'RECONNECT_REQUIRED')
    return store
  }

  private run<T>(signal: AbortSignal | undefined, timeoutMs: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.closed || this.removing) return Promise.reject(new LlmError('Gemini Web is stopping.', 'ABORTED'))
    const controller = new AbortController()
    const bounded = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs), ...signal === undefined ? [] : [signal]])
    const operation: Operation = { controller, done: Promise.resolve() }
    const done = Promise.resolve().then(() => work(bounded)).finally(() => this.operations.delete(operation))
    operation.done = done
    this.operations.add(operation)
    return done
  }

  private async stop(): Promise<void> {
    for (const operation of this.operations) operation.controller.abort()
    await Promise.allSettled([...this.operations].map(operation => operation.done))
  }

  /** Abort and join owned HTTP or browser work before plugin disposal. */
  async dispose(): Promise<void> { this.closed = true; await this.stop() }

  /** Register the independent web grant flow when authorization services are available. */
  registerAuthorization(): void {
    this.ctx.inject(['authorization', 'credentials'], (authorized) => {
      authorized.authorization.registerFlow({ key: KEY, label: 'Gemini Web',
        methods: [{ id: 'browser', label: 'Connect Gemini Web' }],
        accounts: {
          list: async () => {
            const current = grant(await this.store().readRecord(KEY))
            return current === undefined ? [] : [{ id: authorizationAccountId(current.accountId), label: current.label }]
          },
          remove: async (id) => {
            this.removing = true
            try {
              await this.stop()
              const saved = grant(await this.store().readRecord(KEY))
              if (saved?.accountId !== id) throw new LlmError('Gemini Web account was replaced.', 'ACCOUNT_NOT_FOUND')
              await this.store().deleteRecord(KEY)
              const root = resolve(this.spec().root)
              const profile = resolve(root, 'profile')
              let stat
              try { stat = await lstat(root) }
              catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
              if (stat?.isSymbolicLink()) throw new LlmError('Gemini Web profile root must not be a link.', 'INVALID_PROFILE')
              if (stat !== undefined) {
                const profileStat = await lstat(profile).catch((error: unknown) => {
                  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
                  return undefined
                })
                if (profileStat?.isSymbolicLink()) await unlink(profile)
                else if (profileStat !== undefined) await rm(profile, { recursive: true })
              }
            } finally { this.removing = false }
          },
        },
        run: session => this.connect(session),
      })
    })
  }

  private async connect(session: AuthorizationSession): Promise<void> {
    if (this.loginBusy) throw new LlmError('Gemini Web sign-in is already open.', 'PROVIDER_BUSY')
    this.loginBusy = true
    const spec = this.spec()
    try { await this.run(session.signal, spec.loginTimeoutMs, async (signal) => {
      const before = grant(await this.store().readRecord(KEY))
      const jar = await loginGeminiWeb(spec.root, spec.browser, signal, (message) =>{  session.notify({ message }) })
      const client = new GeminiWebHttp(jar, signal)
      let identity: { email: string }
      try { identity = await client.bootstrap() } finally { await client.close() }
      const accountId = createHash('sha256').update(identity.email.toLowerCase()).digest('hex')
      if (before !== undefined && accountId !== before.accountId) throw new LlmError('Reconnect using the same Gemini account. Remove it before connecting another account.', 'ACCOUNT_MISMATCH')
      const next: Grant = { version: 1, revision: randomUUID(), accountId, label: identity.email, jar: await jar.serialize() }
      await this.store().modifyRecord(KEY, (current) => {
        signal.throwIfAborted()
        if (grant(current)?.revision !== before?.revision) throw new LlmError('Gemini Web account changed during sign-in. Connect again.', 'ACCOUNT_CHANGED')
        return Promise.resolve({ kind: 'grant' as const, payload: next })
      })
    }) } finally { this.loginBusy = false }
  }

  override providerInfo(provider: string) { return { id: provider, name: 'Gemini Web' } }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(this.catalog.map(row => ({ ...row, provider, inputModalities: ['text'] })))
  }

  /** Validate the web session before listing the two verified media routes; no generation probe.
   * @param signal - Discovery cancellation.
   * @returns Adapter aliases, without API model ids or quota claims.
   */
  async discover(signal?: AbortSignal): Promise<LlmDiscoveredModel[]> {
    return this.run(signal, this.spec().requestTimeoutMs, async (bounded) => {
      await this.http(bounded, () => Promise.resolve())
      return structuredClone(CATALOG)
    })
  }

  override async *stream(_options: GenerateOptions): AsyncGenerator<StreamChunk> {
    await Promise.reject(new LlmError('Gemini Web supports image and video tools only.', 'UNSUPPORTED_GENERATION'))
  }

  private async http<T>(signal: AbortSignal, work: (client: GeminiWebHttp, saved: Grant) => Promise<T>): Promise<T> {
    const saved = grant(await this.store().readRecord(KEY))
    if (saved === undefined) throw new LlmError('Connect Gemini Web in Account sign-in.', 'RECONNECT_REQUIRED')
    let jar: CookieJar
    try { jar = await CookieJar.deserialize(saved.jar as Parameters<typeof CookieJar.deserialize>[0]) }
    catch { throw new LlmError('Gemini Web session is invalid. Reconnect the account.', 'RECONNECT_REQUIRED') }
    const client = new GeminiWebHttp(jar, signal)
    try {
      const identity = await client.bootstrap()
      if (createHash('sha256').update(identity.email.toLowerCase()).digest('hex') !== saved.accountId) {
        throw new LlmError('Reconnect Gemini Web using the saved account.', 'RECONNECT_REQUIRED')
      }
      return await work(client, saved)
    }
    finally {
      await client.close()
      const updated = await jar.serialize()
      await this.store().modifyRecord(KEY, (current) => {
        const latest = grant(current)
        return Promise.resolve(latest?.revision === saved.revision ? { kind: 'grant' as const, payload: { ...latest, jar: updated } } : current)
      })
    }
  }

  override async requestGeneration(options: MediaGenerationOptions & { provider: string; model: string }): Promise<Response> {
    const spec = this.spec()
    const kind = options.endpoint === 'videos' ? 'video' : 'image'
    if (options.provider !== 'gemini-web' || options.model !== `gemini-web-${kind}`) throw new LlmError('Select the matching Gemini Web media alias.', 'INVALID_GENERATION')
    const body = options.body
    const retrieve = body['jobId'] !== undefined
    const permitted = retrieve ? ['jobId'] : kind === 'image' ? ['model', 'prompt', 'n', 'output_format', 'size', 'quality', 'background']
      : ['prompt', 'size', 'referenceImages']
    if (Object.keys(body).some(key => !permitted.includes(key)) || (!retrieve &&
      (typeof body['prompt'] !== 'string' || !body['prompt'].trim() || body['prompt'].length > 32000
        || (body['n'] !== undefined && body['n'] !== 1) || (body['output_format'] !== undefined && body['output_format'] !== 'png')))) {
      throw new LlmError('Gemini Web accepts a text prompt and verified media settings. Omit seconds; video duration uses the provider default.', 'INVALID_GENERATION')
    }
    if (!retrieve && kind === 'image' && ['size', 'quality', 'background'].some(key => body[key] !== undefined && body[key] !== 'auto')) {
      throw new LlmError('Gemini Web supports default image settings only.', 'INVALID_GENERATION')
    }
    if (!retrieve && kind === 'video' && body['size'] !== undefined && body['size'] !== '1280x720' && body['size'] !== '720x1280') {
      throw new LlmError('Gemini Web video supports landscape or portrait orientation.', 'INVALID_GENERATION')
    }
    let images: GeminiWebInputImage[] | undefined
    if (body['referenceImages'] !== undefined) {
      const values = body['referenceImages']
      if (!Array.isArray(values) || values.length === 0 || values.length > 5) throw new LlmError('Supply one to five reference images.', 'INVALID_GENERATION')
      images = []
      for (const value of values as unknown[]) {
        if (value === null || typeof value !== 'object' || !('data' in value) || !(value.data instanceof Uint8Array)
          || !('mimeType' in value) || typeof value.mimeType !== 'string' || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(value.mimeType)) {
          throw new LlmError('Invalid reference image bytes or media type.', 'INVALID_GENERATION')
        }
        images.push(value as GeminiWebInputImage)
      }
    }
    const id = retrieve ? body['jobId'] : randomUUID()
    if (typeof id !== 'string' || !UUID.test(id)) throw new LlmError('Invalid Gemini Web job id.', 'INVALID_GENERATION')
    if (this.mediaBusy) throw new LlmError('Gemini Web is already processing a media task.', 'PROVIDER_BUSY')
    this.mediaBusy = true
    const checkpoint = { recorded: false }
    try {
      return await this.run(options.signal, spec.requestTimeoutMs, async (signal) => {
        if (images !== undefined) {
          const attachments = this.ctx.get('attachments')
          if (attachments === undefined) throw new LlmError('Reference images require the attachment store.', 'INVALID_GENERATION')
          const limits = attachments.imageLimits
          if (images.length > limits.maxImagesPerMessage) throw new LlmError('Reference images exceed the attachment count limit.', 'INVALID_GENERATION')
          if (images.reduce((bytes, image) => bytes + image.data.byteLength, 0) > limits.maxMessageImageBytes) {
            throw new LlmError('Reference images exceed the attachment byte limit.', 'INVALID_GENERATION')
          }
          for (const image of images) {
            signal.throwIfAborted()
            await attachments.validateImage({ data: image.data, mediaType: image.mimeType })
          }
        }
        signal.throwIfAborted()
        return this.http(signal, async (client, saved) => {
          const root = join(spec.root, 'jobs')
          await mkdir(root, { recursive: true, mode: 0o700 })
          const path = join(root, `${id}.json`)
          let job: Job
          if (retrieve) {
            let value: unknown
            try { const raw = await readFile(path, 'utf8'); if (Buffer.byteLength(raw) > 4096) throw new Error('Oversized job'); value = JSON.parse(raw) as unknown }
            catch { throw new LlmError(`Gemini Web job ${id} is unavailable.`, 'JOB_NOT_FOUND') }
            if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new LlmError('Invalid stored Gemini Web job.', 'INVALID_JOB')
            const row = value as Record<string, unknown>
            if (row.version !== 1 || row.id !== id || row.kind !== kind || row.accountId !== saved.accountId
              || !['submitting', 'accepted', 'downloaded', 'uncertain', 'failed'].includes(String(row.status))
              || !['cid', 'rid', 'rcid'].every(key => typeof row[key] === 'string' && (row[key]).length <= 256)) throw new LlmError('Gemini Web job does not belong to this account or media kind.', 'INVALID_JOB')
            job = row as unknown as Job
          } else job = { ...geminiWebJob(id, kind), version: 1, accountId: saved.accountId, status: 'submitting' }
          const save = () => privateJson(path, job)
          await save()
          checkpoint.recorded = true
          try {
            if (!retrieve) await client.generate(job, body['prompt'] as string, save, {
              ...images === undefined ? {} : { images },
              ...body['size'] === undefined ? {} : { size: body['size'] as '1280x720' | '720x1280' },
            })
            job.status = 'accepted'; await save()
            const selected = await client.retrieve(job, options.pollIntervalMs ?? spec.pollIntervalMs, save)
            const url = kind === 'image' ? await client.originalImage(job, selected) : selected.url
            const asset = await client.download(url, kind)
            signal.throwIfAborted()
            job.status = 'downloaded'; await save()
            if (kind === 'video') return new Response(Buffer.from(asset.data), { headers: { 'content-type': asset.mime, 'x-hydra-job-id': id } })
            const result = JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ inlineData: {
              mimeType: asset.mime, data: Buffer.from(asset.data).toString('base64'),
            } }] } }] })
            if (Buffer.byteLength(result) > options.maxResponseBytes) throw new GeminiWebError('response', 'BYTE_LIMIT')
            return new Response(result, { headers: { 'content-type': 'application/json', 'x-hydra-job-id': id } })
          } catch (error) {
            const terminal = error instanceof GeminiWebError && ['NO_GENERATED_MEDIA', 'QUOTA_EXHAUSTED'].includes(error.code)
            job.status = terminal ? 'failed' : 'uncertain'
            try { await save() } catch { /* Storage failure must preserve the original job diagnostic. */ }
            if (terminal) {
              const reason = error.code === 'QUOTA_EXHAUSTED' ? `Gemini declined the ${kind} request because its quota is exhausted.`
                : `Gemini finished the reply without generating ${kind === 'video' ? 'a video' : 'an image'}.`
              throw new LlmError(`${reason} jobId=${id}. This task has no ${kind} to retrieve; do not retry generation automatically.`, 'GEMINI_WEB_JOB_FAILED')
            }
            const reason = error instanceof GeminiWebError ? error.message : signal.aborted ? 'Local polling or download stopped.' : 'Media operation failed.'
            throw new LlmError(`${reason} jobId=${id}. Use gemini_web_retrieve with this jobId; do not send the prompt again. Reconnect if the session expired.`,
              error instanceof GeminiWebError && error.code === 'RECONNECT_REQUIRED' ? 'RECONNECT_REQUIRED' : 'GEMINI_WEB_JOB_FAILED')
          }
        })
      })
    } catch (error) {
      if (!checkpoint.recorded || (error instanceof LlmError && error.message.includes(`jobId=${id}`))) throw error
      throw new LlmError(`Gemini Web operation stopped. jobId=${id}. Use gemini_web_retrieve; do not send the prompt again. Reconnect if the session expired.`, 'GEMINI_WEB_JOB_FAILED')
    } finally { this.mediaBusy = false }
  }
}

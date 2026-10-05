/** Web-grant isolation, recovery without resubmission, and credential/lifecycle races. */
import { mkdtemp, rm, mkdir, readFile, writeFile, symlink, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@hydraharness/cordis'
import Llm from '@hydraharness/harness-llm'
import Authorization from '@hydraharness/harness-authorization'
import { credentialKey } from '@hydraharness/harness-credentials'
import { CookieJar } from 'tough-cookie'
import { MemoryCredentials } from '../../../credentials/authorization/tests/memory.ts'
import * as AccountAuth from '../src/index.ts'
import { GeminiWebAdapter } from '../src/gemini-web.ts'

const login = vi.hoisted(() => vi.fn())
const fileFaults = vi.hoisted(() => ({ rename: vi.fn(), unlink: vi.fn(), lstat: vi.fn() }))
vi.mock('../src/gemini-web-login.ts', () => ({ loginGeminiWeb: login }))
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => { fileFaults.rename(...args); await actual.rename(...args) },
    unlink: async (...args: Parameters<typeof actual.unlink>) => { fileFaults.unlink(...args); await actual.unlink(...args) },
    lstat: async (...args: Parameters<typeof actual.lstat>) => { fileFaults.lstat(...args); return actual.lstat(...args) },
  }
})
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const fault of Object.values(fileFaults)) fault.mockReset()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})
const KEY = credentialKey('llm-account-auth', 'gemini-web')
const id = '00000000-0000-4000-8000-000000000001'
const accountId = createHash('sha256').update('fixture@example.test').digest('hex')
const html = '{"SNlM0e":"fixture","cfb2h":"build","FdrFJe":"session","oPEP7c":"fixture@example.test"}'
const frames = (value: unknown) => { const text = JSON.stringify(value); return `)]}'\n${text.length + 1}\n${text}\n` }
const video = Buffer.concat([Buffer.from([0, 0, 0, 16]), Buffer.from('ftypisom'), Buffer.from([0, 0, 0, 0])])

async function fixture(requestTimeoutMs = 900_000) {
  const home = await mkdtemp(join(tmpdir(), 'gemini-web-'))
  cleanups.push(() => rm(home, { recursive: true, force: true }))
  const ctx = new Context(); cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(Llm); await ctx.plugin(MemoryCredentials); await ctx.plugin(Authorization)
  const flows = vi.spyOn(ctx.authorization, 'registerFlow')
  const registrations = vi.spyOn(ctx.llm, 'registerAdapter')
  await ctx.plugin(AccountAuth, { geminiWeb: { hydraHome: home, pollIntervalMs: 1, requestTimeoutMs }, providers: { 'gemini-web': {} } })
  const adapter = registrations.mock.calls.find(([routes]) => routes.includes('gemini-web'))![1] as GeminiWebAdapter
  const jar = new CookieJar()
  await jar.setCookie('__Secure-1PSID=fixture; Secure; Domain=.google.com; Path=/', 'https://gemini.google.com')
  await ctx.credentials.modifyRecord(KEY, async () => ({ kind: 'grant', payload: { version: 1, revision: id, accountId,
    label: 'fixture@example.test', jar: await jar.serialize() } }))
  login.mockResolvedValue(jar)
  return { ctx, home, adapter, jar, flow: flows.mock.calls.find(([row]) => row.key === KEY)![0] }
}

function videoReply(): Response {
  const candidate: unknown[] = new Array(13).fill(null); candidate[0] = 'rc_fixture'
  const item: unknown[] = new Array(8).fill(null); item[7] = [null, 'https://contribution.usercontent.google.com/video']
  candidate[12] = [{ '60': [[[[item]]]] }]
  return new Response(frames([['wrb.fr', 'hNvQHb', JSON.stringify([[[[null, 'r_fixture'], null, null, [[candidate]]]]])]]))
}

it.each(['submit', 'retrieve', 'quota', 'image'] as const)('records a terminal %s refusal with its job id and releases the media slot', async (stage) => {
  const h = await fixture(); const jobs = join(h.home, 'gemini-web', 'jobs')
  await mkdir(jobs, { recursive: true })
  await writeFile(join(jobs, `${id}.json`), JSON.stringify({ version: 1, id, accountId, kind: 'video', cid: 'c_fixture', rid: 'r_fixture', rcid: 'rc_fixture', status: 'failed' }))
  const candidate: unknown[] = new Array(13).fill(null); candidate[0] = 'rc_fixture'; candidate[8] = [2]
  candidate[1] = [stage === 'quota' ? 'I can create more videos as soon as your limit resets.' : 'Tôi không thể hỗ trợ bạn việc đó.']
  let submissions = 0; let polls = 0
  const submit = stage === 'submit' || stage === 'image'
  const kind = stage === 'image' ? 'image' : 'video'
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.pathname === '/app') return new Response(html)
    if (url.pathname.includes('StreamGenerate')) {
      submissions++
      return new Response(frames([['wrb.fr', null, JSON.stringify([null, ['c_fixture', 'r_fixture'], null, null, [candidate]])]]))
    }
    polls++
    return new Response(frames([['wrb.fr', 'hNvQHb', JSON.stringify([[[[null, 'r_fixture'], null, null, [[candidate]]]]])]]))
  }))
  const request = () => h.adapter.requestGeneration({ provider: 'gemini-web', model: `gemini-web-${kind}`, endpoint: kind === 'image' ? 'images/generations' : 'videos',
    body: submit ? { prompt: 'Animate' } : { jobId: id }, signal: new AbortController().signal, maxResponseBytes: 1024 })
  for (let attempt = 0; attempt < 2; attempt++) {
    await expect(request()).rejects.toThrow(stage === 'quota' ? 'quota is exhausted' : `finished the reply without generating ${kind === 'image' ? 'an image' : 'a video'}`)
  }
  expect(submissions).toBe(submit ? 2 : 0)
  expect(polls).toBe(submit ? 0 : 2)
  const { readdir } = await import('node:fs/promises')
  for (const name of await readdir(jobs)) expect(JSON.parse(await readFile(join(jobs, name), 'utf8'))).toMatchObject({ status: 'failed' })
})

it('validates reference policy and forwards verified bytes and portrait orientation', async () => {
  const h = await fixture()
  const validateImage = vi.fn(async () => {})
  const limits = { maxImagesPerMessage: 5, maxMessageImageBytes: 10 }
  h.ctx.provide('attachments', { imageLimits: limits, validateImage } as never)
  const calls: string[] = []
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input)); calls.push(url.pathname)
    if (url.pathname === '/app') return new Response(html.slice(0, -1) + ',"qKIAYe":"feeds/fixture"}')
    if (url.hostname === 'push.clients6.google.com') return new Headers(init?.headers).get('x-goog-upload-command') === 'start'
      ? new Response(null, { headers: { 'x-goog-upload-url': 'https://push.clients6.google.com/upload/?upload_id=fixture' } })
      : new Response('/contrib_service/ttl_1d/fixture')
    if (url.pathname.includes('StreamGenerate')) {
      const outer = JSON.parse(new URLSearchParams(init?.body as URLSearchParams).get('f.req')!) as [unknown, string]
      const payload = JSON.parse(outer[1]) as unknown[]; expect(payload[55]).toEqual([[17]])
      return new Response(frames([['wrb.fr', null, JSON.stringify([null, ['c_fixture', 'r_fixture'], null, null, []])]]))
    }
    if (url.pathname.includes('batchexecute')) return videoReply()
    return new Response(video, { headers: { 'content-type': 'video/mp4' } })
  })
  vi.stubGlobal('fetch', fetcher)
  const input = { data: new Uint8Array([1]), mimeType: 'image/png' }
  const request = (body: Record<string, unknown>) => h.adapter.requestGeneration({ provider: 'gemini-web', model: 'gemini-web-video',
    endpoint: 'videos', body, signal: new AbortController().signal, maxResponseBytes: 1024 })
  const response = await request({ prompt: 'Animate', size: '720x1280', referenceImages: [input] })
  expect(await response.arrayBuffer()).toEqual(video.buffer.slice(video.byteOffset, video.byteOffset + video.byteLength))
  expect(validateImage).toHaveBeenCalledWith({ data: input.data, mediaType: 'image/png' })
  expect(calls.filter(path => path.includes('StreamGenerate'))).toHaveLength(1)
  const count = calls.length
  for (const referenceImages of [null, {}, [], new Array(6).fill(input), [null], [1], [{}], [{ data: 'x' }],
    [{ data: input.data }], [{ data: input.data, mimeType: 3 }], [{ data: input.data, mimeType: 'text/plain' }]]) {
    await expect(request({ prompt: 'Animate', referenceImages })).rejects.toMatchObject({ code: 'INVALID_GENERATION' })
  }
  await expect(request({ prompt: 'Animate', size: 'square' })).rejects.toMatchObject({ code: 'INVALID_GENERATION' })
  limits.maxImagesPerMessage = 1
  await expect(request({ prompt: 'Animate', referenceImages: [input, input] })).rejects.toThrow('count limit')
  limits.maxMessageImageBytes = 0
  await expect(request({ prompt: 'Animate', referenceImages: [input] })).rejects.toThrow('byte limit')
  expect(calls).toHaveLength(count)
})

it('requires attachment validation for reference requests before HTTP', async () => {
  const h = await fixture(); const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
  await expect(h.adapter.requestGeneration({ provider: 'gemini-web', model: 'gemini-web-video', endpoint: 'videos',
    body: { prompt: 'Animate', referenceImages: [{ data: new Uint8Array([1]), mimeType: 'image/png' }] },
    signal: new AbortController().signal, maxResponseBytes: 1024 })).rejects.toThrow('attachment store')
  expect(fetcher).not.toHaveBeenCalled()
})

it('Remove aborts and joins reference validation before any upload or generation', async () => {
  const h = await fixture()
  let release!: () => void; let started!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const ready = new Promise<void>((resolve) => { started = resolve })
  h.ctx.provide('attachments', { imageLimits: { maxImagesPerMessage: 5, maxMessageImageBytes: 10 },
    validateImage: async () => { started(); await gate },
  } as never)
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
  const request = h.adapter.requestGeneration({ provider: 'gemini-web', model: 'gemini-web-video', endpoint: 'videos',
    body: { prompt: 'Animate', referenceImages: [{ data: new Uint8Array([1]), mimeType: 'image/png' }] },
    signal: new AbortController().signal, maxResponseBytes: 1024 })
  const rejected = expect(request).rejects.toBeDefined()
  await ready
  let removed = false
  const remove = h.ctx.authorization.removeAccount(KEY, accountId as never).then(() => { removed = true })
  await Promise.resolve(); expect(removed).toBe(false)
  release(); await remove; await rejected
  expect(fetcher).not.toHaveBeenCalled()
  expect(await h.ctx.credentials.readRecord(KEY)).toBeUndefined()
})

it('lists isolated accounts and aliases, refusing API model ids and unsupported controls before HTTP', async () => {
  const h = await fixture(); const fetcher = vi.fn(async () => new Response(html)); vi.stubGlobal('fetch', fetcher)
  expect(await h.ctx.authorization.listAccounts(KEY)).toEqual([{ id: accountId, label: 'fixture@example.test' }])
  expect(await h.ctx.authorization.listAccounts(credentialKey('llm-account-auth', 'antigravity'))).toEqual([])
  expect((await h.adapter.discover()).map(row => row.id)).toEqual(['gemini-web-image', 'gemini-web-video'])
  expect(fetcher).toHaveBeenCalledOnce()
  for (const [model, body] of [['gemini-3.1-flash-image', { prompt: 'Boat' }], ['gemini-web-image', { prompt: 'Boat', n: 2 }],
    ['gemini-web-image', { prompt: 'Boat', size: '1024x1024' }], ['gemini-web-video', { prompt: 'Boat', seconds: 10 }]] as const) {
    await expect(h.adapter.requestGeneration({ provider: 'gemini-web', model, endpoint: model.includes('video') ? 'videos' : 'images/generations',
      body, signal: new AbortController().signal, maxResponseBytes: 1024 })).rejects.toMatchObject({ code: 'INVALID_GENERATION' })
  }
  expect(fetcher).toHaveBeenCalledOnce()
  h.adapter.configure(true, [{ id: 'gemini-web-image', name: 'My images' }])
  expect(await h.adapter.listModels('gemini-web')).toEqual([{ id: 'gemini-web-image', name: 'My images',
    provider: 'gemini-web', endpoints: ['images/generations'], inputModalities: ['text'] }])
})

it('retrieves persisted reply ids after Host restart without a generation request', async () => {
  const h = await fixture(); const jobs = join(h.home, 'gemini-web', 'jobs'); await mkdir(jobs, { recursive: true })
  await writeFile(join(jobs, `${id}.json`), JSON.stringify({ version: 1, id, accountId, kind: 'video', cid: 'c_fixture', rid: 'r_fixture', rcid: '', status: 'accepted' }))
  const paths: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input)); paths.push(url.pathname)
    if (url.pathname === '/app') return new Response(html)
    if (url.pathname.includes('batchexecute')) return videoReply()
    if (url.pathname === '/video') return new Response(video, { headers: { 'content-type': 'video/mp4' } })
    throw new Error('No generation request is allowed')
  }))
  const restarted = new GeminiWebAdapter(h.ctx, () => ({ hydraHome: h.home, pollIntervalMs: 1 }))
  const response = await restarted.requestGeneration({ provider: 'gemini-web', model: 'gemini-web-video', endpoint: 'videos',
    body: { jobId: id }, signal: new AbortController().signal, maxResponseBytes: 1024 })
  expect(Buffer.from(await response.arrayBuffer())).toEqual(video)
  expect(paths).toHaveLength(3)
  expect(JSON.parse(await readFile(join(jobs, `${id}.json`), 'utf8'))).toMatchObject({ rcid: 'rc_fixture', status: 'downloaded' })
  await restarted.dispose()
})

it('preserves the prior grant when HTTP validation after reconnect fails', async () => {
  const h = await fixture(); const before = await h.ctx.credentials.readRecord(KEY)
  vi.stubGlobal('fetch', vi.fn(async () => new Response('Sign in', { status: 403 })))
  const flow = h.ctx.authorization.list().find(row => row.key === KEY)!
  expect(flow.label).toBe('Gemini Web')
  await expect(h.ctx.authorization.begin({ key: KEY, interaction: { notify: vi.fn(), prompt: vi.fn() } })).rejects.toMatchObject({ code: 'RECONNECT_REQUIRED' })
  expect(await h.ctx.credentials.readRecord(KEY)).toEqual(before)
})

it('does not overwrite a newer reconnect grant while an old HTTP operation finishes', async () => {
  const h = await fixture(); let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let started!: () => void; const ready = new Promise<void>((resolve) => { started = resolve })
  vi.stubGlobal('fetch', vi.fn(async () => { started(); await gate; return new Response(html, { headers: { 'set-cookie': 'old=refresh; Secure; Path=/' } }) }))
  const discovery = h.adapter.discover(); await ready
  const next = { version: 1, revision: '00000000-0000-4000-8000-000000000002', accountId, label: 'fixture@example.test', jar: await h.jar.serialize() }
  await h.ctx.credentials.modifyRecord(KEY, async () => ({ kind: 'grant', payload: next }))
  release(); await discovery
  expect(await h.ctx.credentials.readRecord(KEY)).toEqual({ kind: 'grant', payload: next })
})

it('Remove aborts and joins HTTP work before deleting the grant and managed profile', async () => {
  const h = await fixture(); const profile = join(h.home, 'gemini-web', 'profile'); await mkdir(profile, { recursive: true })
  await writeFile(join(profile, 'owned'), 'fixture')
  let started!: () => void; const ready = new Promise<void>((resolve) => { started = resolve })
  vi.stubGlobal('fetch', vi.fn((_input: unknown, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    started(); init.signal!.addEventListener('abort', () => { reject(new Error('Cancelled HTTP operation')) }, { once: true })
  })))
  const discovery = h.adapter.discover(); const failed = expect(discovery).rejects.toBeDefined(); await ready
  await h.ctx.authorization.removeAccount(KEY, accountId as never)
  await failed
  expect(await h.ctx.credentials.readRecord(KEY)).toBeUndefined()
  await expect(readFile(join(profile, 'owned'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it.each(['poll', 'download', 'timeout', 'unload'] as const)('keeps one accepted task recoverable when local work stops at %s', async (stage) => {
  const h = await fixture(stage === 'timeout' ? 1000 : 900_000)
  const controller = new AbortController(); let submissions = 0
  const polling = Promise.withResolvers<undefined>()
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.pathname === '/app') return new Response(html)
    if (url.pathname.includes('StreamGenerate')) {
      submissions++
      return new Response(frames([['wrb.fr', null, JSON.stringify([null, ['c_fixture', 'r_fixture'], null, null, []])]]))
    }
    if (url.pathname.includes('batchexecute') && stage === 'download') return videoReply()
    if (stage === 'timeout' || stage === 'unload') {
      const signal = init?.signal
      if (signal === undefined || signal === null) throw new Error('Polling requires cancellation')
      polling.resolve(undefined)
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => { reject(new Error('Cancelled polling')) }, { once: true })
      })
    }
    controller.abort(); controller.signal.throwIfAborted()
    throw new Error('Unreachable cancelled transport')
  }))
  const failed = h.adapter.requestGeneration({ provider: 'gemini-web', model: 'gemini-web-video', endpoint: 'videos',
    body: { prompt: 'A boat' }, signal: controller.signal, maxResponseBytes: 1024 })
  const rejected = expect(failed).rejects.toHaveProperty('code', 'GEMINI_WEB_JOB_FAILED')
  if (stage === 'unload') { await polling.promise; await h.adapter.dispose() }
  await rejected
  await expect(failed).rejects.toThrow('jobId=')
  expect(submissions).toBe(1)
  const { readdir } = await import('node:fs/promises')
  const jobs = join(h.home, 'gemini-web', 'jobs'); const files = await readdir(jobs)
  expect(files).toHaveLength(1)
  expect(JSON.parse(await readFile(join(jobs, files[0]!), 'utf8'))).toMatchObject({ cid: 'c_fixture', rid: 'r_fixture', status: 'uncertain' })
})

it('does not accept a stored grant belonging to another HTTP account', async () => {
  const h = await fixture(); const fetcher = vi.fn(async () => new Response(html.replace('fixture@example.test', 'other@example.test')))
  vi.stubGlobal('fetch', fetcher)
  await expect(h.adapter.discover()).rejects.toMatchObject({ code: 'RECONNECT_REQUIRED' })
  expect(fetcher).toHaveBeenCalledOnce()
})

const generation = (body: Record<string, unknown>, kind: 'image' | 'video' = 'video') => ({
  provider: 'gemini-web', model: `gemini-web-${kind}`, endpoint: kind === 'image' ? 'images/generations' as const : 'videos' as const,
  body, signal: new AbortController().signal, maxResponseBytes: 1024,
})

it('refuses unsupported routes, chat, missing grants, and work after disposal', async () => {
  const h = await fixture()
  expect(h.adapter.providerInfo('gemini-web')).toEqual({ id: 'gemini-web', name: 'Gemini Web' })
  await expect(h.adapter.stream({} as never).next()).rejects.toMatchObject({ code: 'UNSUPPORTED_GENERATION' })
  h.adapter.configure(false); h.adapter.configure(true, [{ id: 'gemini-web-video' }, { id: 'gemini-web-image' }])
  expect((await h.adapter.listModels('gemini-web')).map(row => row.name)).toEqual(['Gemini Web Video', 'Gemini Web Image'])
  for (const body of [{ prompt: 1 }, { prompt: '' }, { prompt: 'x'.repeat(32001) }, { prompt: 'boat', output_format: 'webp' },
    { prompt: 'boat', quality: 'high' }, { jobId: 1 }, { jobId: 'bad' }, { jobId: id, prompt: 'duplicate' }]) {
    await expect(h.adapter.requestGeneration(generation(body, 'image'))).rejects.toMatchObject({ code: 'INVALID_GENERATION' })
  }
  await expect(h.adapter.requestGeneration({ ...generation({ prompt: 'boat' }), provider: 'bad' })).rejects.toMatchObject({ code: 'INVALID_GENERATION' })
  await expect(h.flow.accounts!.remove('other' as never)).rejects.toMatchObject({ code: 'ACCOUNT_NOT_FOUND' })
  await h.ctx.credentials.deleteRecord(KEY)
  expect(await h.ctx.authorization.listAccounts(KEY)).toEqual([])
  await expect(h.adapter.discover()).rejects.toMatchObject({ code: 'RECONNECT_REQUIRED' })
  await expect(h.ctx.authorization.removeAccount(KEY, 'other' as never)).rejects.toMatchObject({ code: 'ACCOUNT_NOT_FOUND' })
  await h.adapter.dispose()
  await expect(h.adapter.discover()).rejects.toMatchObject({ code: 'ABORTED' })
  const standalone = new GeminiWebAdapter(new Context(), () => undefined)
  await expect(standalone.discover()).rejects.toMatchObject({ code: 'RECONNECT_REQUIRED' })
  await standalone.dispose()
})

it.each([
  null, [], 'invalid', { version: 1 },
  { revision: 'invalid' }, { accountId: 'invalid' }, { label: '' }, { label: 'x'.repeat(321) },
  { jar: null }, { jar: [] }, { jar: { private: 'x'.repeat(2 * 1024 * 1024) } }, { jar: { cookies: [null] } },
])('rejects invalid durable grants before issuing HTTP %#', async (replacement) => {
  const h = await fixture(); const original = await h.ctx.credentials.readRecord(KEY)
  const payload = replacement !== null && typeof replacement === 'object' && !Array.isArray(replacement)
    ? { ...(original as { payload: Record<string, unknown> }).payload, ...replacement } : replacement
  await h.ctx.credentials.modifyRecord(KEY, async () => ({ kind: 'grant', payload }))
  await expect(h.adapter.discover()).rejects.toMatchObject({ code: 'RECONNECT_REQUIRED' })
})

it('rejects a non-grant credential record', async () => {
  const h = await fixture(); await h.ctx.credentials.modifyRecord(KEY, async () => ({ kind: 'api-key', key: 'fixture' }))
  await expect(h.adapter.discover()).rejects.toMatchObject({ code: 'RECONNECT_REQUIRED' })
})

it('commits a verified Connect grant and refuses simultaneous login or a different account', async () => {
  const h = await fixture(); await h.ctx.credentials.deleteRecord(KEY)
  const ready = Promise.withResolvers<undefined>(); const complete = Promise.withResolvers<CookieJar>()
  login.mockImplementationOnce(async (_root, _browser, _signal, notify: (message: string) => void) => {
    notify('Sign in'); ready.resolve(undefined); return complete.promise
  })
  vi.stubGlobal('fetch', vi.fn(async () => new Response(html)))
  const notify = vi.fn(); const request = { key: KEY, interaction: { notify, prompt: vi.fn() } }
  const connecting = h.ctx.authorization.begin(request); await ready.promise
  await expect(h.flow.run({ signal: new AbortController().signal } as never)).rejects.toMatchObject({ code: 'PROVIDER_BUSY' })
  complete.resolve(h.jar); await connecting
  expect(notify).toHaveBeenCalled()
  expect((await h.ctx.credentials.readRecord(KEY) as { payload: unknown }).payload).toMatchObject({ version: 1, accountId })
  vi.stubGlobal('fetch', vi.fn(async () => new Response(html.replace('fixture@example.test', 'different@example.test'))))
  await expect(h.ctx.authorization.begin(request)).rejects.toMatchObject({ code: 'ACCOUNT_MISMATCH' })
})

it('rejects Connect when its saved grant changes before committing', async () => {
  const h = await fixture(); const before = await h.ctx.credentials.readRecord(KEY)
  vi.stubGlobal('fetch', vi.fn(async () => {
    await h.ctx.credentials.modifyRecord(KEY, async () => ({ kind: 'grant', payload: { ...(before as { payload: object }).payload, revision: '00000000-0000-4000-8000-000000000002' } }))
    return new Response(html)
  }))
  await expect(h.ctx.authorization.begin({ key: KEY, interaction: { notify: vi.fn(), prompt: vi.fn() } })).rejects.toMatchObject({ code: 'ACCOUNT_CHANGED' })
})

it('does not restore a removed grant when its HTTP refresh completes', async () => {
  const h = await fixture(); const entered = Promise.withResolvers<undefined>(); const released = Promise.withResolvers<undefined>()
  vi.stubGlobal('fetch', vi.fn(async () => { entered.resolve(undefined); await released.promise; return new Response(html) }))
  const discovery = h.adapter.discover(); await entered.promise; await h.ctx.credentials.deleteRecord(KEY); released.resolve(undefined)
  await discovery; expect(await h.ctx.credentials.readRecord(KEY)).toBeUndefined()
})

it.each(['missing', 'bad-json', 'oversized', 'null', 'array', 'wrong-version', 'wrong-id', 'wrong-kind', 'wrong-owner', 'wrong-status', 'missing-ids', 'long-ids'])('refuses invalid saved jobs: %s', async (fault) => {
  const h = await fixture(); vi.stubGlobal('fetch', vi.fn(async () => new Response(html)))
  const root = join(h.home, 'gemini-web', 'jobs'); await mkdir(root, { recursive: true })
  const row: Record<string, unknown> = { version: 1, id, accountId, kind: 'video', cid: 'c_fixture', rid: 'r_fixture', rcid: '', status: 'accepted' }
  if (fault === 'wrong-version') row.version = 2
  if (fault === 'wrong-id') row.id = 'other'
  if (fault === 'wrong-kind') row.kind = 'image'
  if (fault === 'wrong-owner') row.accountId = 'other'
  if (fault === 'wrong-status') row.status = 'other'
  if (fault === 'missing-ids') delete row.cid
  if (fault === 'long-ids') row.rid = 'x'.repeat(257)
  if (fault !== 'missing') await writeFile(join(root, `${id}.json`), fault === 'bad-json' ? 'invalid' : fault === 'oversized' ? 'x'.repeat(4097)
    : JSON.stringify(fault === 'null' ? null : fault === 'array' ? [] : row))
  await expect(h.adapter.requestGeneration(generation({ jobId: id }))).rejects.toMatchObject({ code: ['missing', 'bad-json', 'oversized'].includes(fault) ? 'JOB_NOT_FOUND' : 'INVALID_JOB' })
})

function imageReply(): Response {
  const candidate: unknown[] = new Array(13).fill(null); candidate[0] = 'rc_fixture'
  candidate[12] = new Array(8).fill(null); (candidate[12] as unknown[])[7] = [[[[null, null, null, [null, null, null, 'https://lh3.google.com/image']], ['image_fixture']]]]
  return new Response(frames([['wrb.fr', 'hNvQHb', JSON.stringify([[[[null, 'r_fixture'], null, null, [[candidate]]]]])]]))
}

it.each([1024, 1])('generates an image once and bounds the final native JSON at %i bytes', async (limit) => {
  const h = await fixture(); let submissions = 0
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.pathname === '/app') return new Response(html)
    if (url.pathname.includes('StreamGenerate')) { submissions++; return new Response(frames([['wrb.fr', null, JSON.stringify([null, ['c_fixture', 'r_fixture'], null, null, []])]])) }
    if (url.searchParams.get('rpcids') === 'hNvQHb') return imageReply()
    if (url.searchParams.get('rpcids') === 'c8o8Fe') return new Response(frames([['wrb.fr', 'c8o8Fe', JSON.stringify(['https://lh3.google.com/image'])]]))
    return new Response(Buffer.from('89504e470d0a1a0a', 'hex'), { headers: { 'content-type': 'image/png' } })
  }))
  const operation = h.adapter.requestGeneration({ ...generation({ prompt: 'boat', n: 1, output_format: 'png', size: 'auto', quality: 'auto', background: 'auto' }, 'image'), maxResponseBytes: limit, pollIntervalMs: 1 })
  if (limit === 1) await expect(operation).rejects.toThrow('BYTE_LIMIT')
  else expect(await (await operation).json()).toMatchObject({ candidates: [{ finishReason: 'STOP' }] })
  expect(submissions).toBe(1)
})

it.each(['rpc-expired', 'checkpoint', 'checkpoint-unlink', 'refresh'])('keeps the job id after %s fails', async (failure) => {
  const h = await fixture(); let accepted = false
  const modify = h.ctx.credentials.modifyRecord.bind(h.ctx.credentials)
  if (failure.startsWith('checkpoint')) fileFaults.rename.mockImplementation(() => { if (accepted) throw new Error('Disk full') })
  if (failure === 'checkpoint-unlink') fileFaults.unlink.mockImplementation(() => { throw new Error('Cannot unlink') })
  if (failure === 'refresh') vi.spyOn(h.ctx.credentials, 'modifyRecord').mockImplementation(async (...args) => { if (accepted) throw new Error('Credential disk full'); return modify(...args) })
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.pathname === '/app') return new Response(html)
    if (url.pathname.includes('StreamGenerate')) { accepted = true; return new Response(frames([['wrb.fr', null, JSON.stringify([null, ['c_fixture', 'r_fixture'], null, null, []])]])) }
    return failure === 'rpc-expired' ? new Response(null, { status: 403 }) : videoReply()
  }))
  await expect(h.adapter.requestGeneration(generation({ prompt: 'Boat' }))).rejects.toThrow('jobId=')
})

it('serializes media operations while allowing a read-only session check', async () => {
  const h = await fixture(); const entered = Promise.withResolvers<undefined>(); const released = Promise.withResolvers<undefined>()
  vi.stubGlobal('fetch', vi.fn(async () => { entered.resolve(undefined); await released.promise; return new Response(html) }))
  const pending = h.adapter.requestGeneration(generation({ jobId: id })); const failed = expect(pending).rejects.toMatchObject({ code: 'JOB_NOT_FOUND' })
  await entered.promise; await expect(h.adapter.requestGeneration(generation({ prompt: 'Boat' }))).rejects.toMatchObject({ code: 'PROVIDER_BUSY' })
  released.resolve(undefined); await failed
})

it('cleans only a profile junction and preserves the external target', async () => {
  const h = await fixture(); const root = join(h.home, 'gemini-web'); const target = join(h.home, 'external')
  await mkdir(root); await mkdir(target); await writeFile(join(target, 'keep'), 'owned outside profile')
  await symlink(target, join(root, 'profile'), process.platform === 'win32' ? 'junction' : 'dir')
  await h.ctx.authorization.removeAccount(KEY, accountId as never)
  expect(await readFile(join(target, 'keep'), 'utf8')).toBe('owned outside profile')
})

it('refuses a linked provider root and tolerates absent owned directories', async () => {
  const h = await fixture(); const root = join(h.home, 'gemini-web'); const target = join(h.home, 'external')
  await mkdir(target); await symlink(target, root, process.platform === 'win32' ? 'junction' : 'dir')
  await expect(h.ctx.authorization.removeAccount(KEY, accountId as never)).rejects.toMatchObject({ code: 'INVALID_PROFILE' })
  await unlink(root)
  const record = { kind: 'grant' as const,
    payload: { version: 1, revision: id, accountId, label: 'fixture@example.test', jar: await h.jar.serialize() } }
  await h.ctx.credentials.modifyRecord(KEY, async () => record); await h.ctx.authorization.removeAccount(KEY, accountId as never)
  await mkdir(root)
  await h.ctx.credentials.modifyRecord(KEY, async () => record)
  await h.ctx.authorization.removeAccount(KEY, accountId as never)
})

it.each(['root', 'profile'])('surfaces %s inspection failures after joining owned work', async (part) => {
  const h = await fixture(); await mkdir(join(h.home, 'gemini-web'))
  fileFaults.lstat.mockImplementation((path: string) => {
    if (path.endsWith(part === 'root' ? 'gemini-web' : 'profile')) throw Object.assign(new Error('Permission denied'), { code: 'EACCES' })
  })
  await expect(h.ctx.authorization.removeAccount(KEY, accountId as never)).rejects.toMatchObject({ code: 'EACCES' })
})

it('rejects a cookie jar that cannot be deserialized', async () => {
  const h = await fixture(); const record = await h.ctx.credentials.readRecord(KEY)
  await h.ctx.credentials.modifyRecord(KEY, async () => ({ kind: 'grant', payload: { ...(record as { payload: object }).payload, jar: { storeType: 'UnsupportedStore', cookies: 'invalid' } } }))
  await expect(h.adapter.discover()).rejects.toMatchObject({ code: 'RECONNECT_REQUIRED' })
})

it('uses default provider settings and the public discovery registration', async () => {
  const ctx = new Context(); cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(Llm); await ctx.plugin(Authorization); await ctx.plugin(MemoryCredentials)
  const registrations = vi.spyOn(ctx.llm, 'registerAdapter')
  await ctx.plugin(AccountAuth, { providers: { 'gemini-web': {} } })
  const adapter = registrations.mock.calls.find(([routes]) => routes.includes('gemini-web'))![1] as GeminiWebAdapter
  await expect(adapter.discover()).rejects.toMatchObject({ code: 'RECONNECT_REQUIRED' })
  await expect(ctx.llm.discoverModels('llm-account-auth', { provider: 'gemini-web' })).rejects.toMatchObject({ code: 'RECONNECT_REQUIRED' })
})

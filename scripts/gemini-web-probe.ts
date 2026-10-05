/** Consumer Gemini HTTP feasibility probe; not registered as a production provider. */
import { mkdir, readFile, rename, writeFile, open, unlink } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID, createHash } from 'node:crypto'
import { resolveHydraHome } from '../packages/util/home-paths/src/index.ts'
import { CookieJar } from 'tough-cookie'
import { loginGeminiWeb } from '../packages/llm/llm-account-auth/src/gemini-web-login.ts'
import { GeminiWebHttp, GeminiWebError, geminiWebJob } from './gemini-web-http.ts'
import type { GeminiWebJob } from './gemini-web-http.ts'

const root = join(resolveHydraHome(), 'research', 'gemini-web')
const origin = 'https://gemini.google.com'
const grantPath = join(root, 'session.json')
let stage = 'input'

async function writePrivate(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' })
  try { await rename(temporary, path) }
  catch (error) {
    try { await unlink(temporary) } catch { /* Preserve the write error when temporary cleanup also fails. */ }
    throw error
  }
}

async function login(signal: AbortSignal): Promise<void> {
  const channel = process.argv[3] ?? 'msedge'
  if (channel !== 'msedge' && channel !== 'chrome') throw new GeminiWebError('login', 'INVALID_BROWSER')
  stage = 'login'
  const jar = await loginGeminiWeb(root, channel, signal, (message) =>{  console.log(message) })
  stage = 'http-bootstrap'
  const client = new GeminiWebHttp(jar, signal)
  try { await client.bootstrap() } finally { await client.close() }
  await writePrivate(grantPath, await jar.serialize())
  console.log('HTTP_BOOTSTRAP_OK: Browser closed; session stored outside the checkout.')
}

async function main(): Promise<void> {
  const signal = AbortSignal.timeout(15 * 60 * 1000)
  const command = process.argv[2]
  if (command === 'login') { await login(signal); return }
  if (command === 'bootstrap') {
    const jar = await loadJar()
    const client = new GeminiWebHttp(jar, signal)
    try { await client.bootstrap() } finally { await client.close() }
    await writePrivate(grantPath, await jar.serialize())
    console.log('HTTP_BOOTSTRAP_OK: Existing session works in a new HTTP client.')
    return
  }
  if (command === 'generate' || command === 'retrieve') {
    const jar = await loadJar()
    const client = new GeminiWebHttp(jar, signal)
    const owner = createHash('sha256').update((await jar.getCookies(origin))
      .find(cookie => cookie.key === '__Secure-1PSID')?.value ?? '').digest('hex')
    const kind = process.argv[3]
    if (kind !== 'image' && kind !== 'video') throw new GeminiWebError('input', 'INVALID_MEDIA_KIND')
    const jobId = command === 'generate' ? randomUUID() : process.argv[4] ?? ''
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(jobId)) throw new GeminiWebError('input', 'INVALID_JOB_ID')
    const jobPath = join(root, `${jobId}.json`)
    let job: GeminiWebJob & { owner: string }
    if (command === 'generate') job = { ...geminiWebJob(jobId, kind), owner }
    else {
      const value: unknown = JSON.parse(await readFile(jobPath, 'utf8'))
      if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new GeminiWebError('retrieve', 'INVALID_JOB')
      const record = value as Record<string, unknown>
      if (record.owner !== owner || record.kind !== kind || record.id !== jobId
        || !['cid', 'rid', 'rcid'].every(key => typeof record[key] === 'string')) {
        throw new GeminiWebError('retrieve', 'JOB_SESSION_MISMATCH')
      }
      job = record as unknown as typeof job
    }
    const save = () => writePrivate(jobPath, job)
    await save()
    console.log(`JOB ${jobId} ${kind}; submission is never retried.`)
    try {
      const prompt = process.argv[4] ?? (kind === 'image'
        ? 'Generate an image of a small red paper boat on a pale blue background, no text.'
        : 'Generate a short landscape video of a red paper boat drifting slowly on calm blue water, no text.')
      const media = command === 'generate' ? await client.generate(job, prompt, save) : undefined
      const selected = media ?? await client.retrieve(job, 10000, save)
      const url = kind === 'image' ? await client.originalImage(job, selected) : selected.url
      const { data, mime } = await client.download(url, kind)
      const extension = mime === 'image/jpeg' ? 'jpg' : mime.slice(mime.indexOf('/') + 1)
      const path = join(root, `${jobId}.${extension}`)
      let handle
      try { handle = await open(path, 'wx', 0o600) }
      catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error
        if (!Buffer.from(data).equals(await readFile(path))) throw new GeminiWebError('storage', 'EXISTING_MEDIA_MISMATCH')
      }
      if (handle !== undefined) {
        try { await handle.writeFile(data) } finally { await handle.close() }
      }
      console.log(`HTTP_MEDIA_OK ${kind}: ${data.byteLength} bytes, ${mime}; ${path}`)
    } finally {
      await client.close()
      await writePrivate(grantPath, await jar.serialize())
    }
    return
  }
  console.log('Usage: node --import tsx/esm scripts/gemini-web-probe.ts login [msedge|chrome] | bootstrap | generate image|video [prompt] | retrieve image|video <jobId>')
  throw new GeminiWebError('input', 'INVALID_COMMAND')
}

async function loadJar(): Promise<CookieJar> {
  const source = await readFile(grantPath, 'utf8')
  if (Buffer.byteLength(source) > 256 * 1024) throw new GeminiWebError('session', 'INVALID_STORED_SESSION')
  return CookieJar.deserialize(JSON.parse(source) as Parameters<typeof CookieJar.deserialize>[0])
}

async function run(): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 })
  const lockPath = join(root, 'probe.lock')
  let lock
  try { lock = await open(lockPath, 'wx', 0o600) }
  catch { throw new GeminiWebError('lifecycle', 'PROBE_BUSY') }
  try {
    await lock.writeFile(String(process.pid))
    await main()
  } finally {
    await lock.close()
    await unlink(lockPath)
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void run().catch((error: unknown) => {
    // Provider response bodies, tokens, signed URLs, and browser errors can contain secrets.
    console.error(error instanceof GeminiWebError ? error.message : `GEMINI_WEB_PROBE_FAILED at ${stage}: No raw provider or browser error is printed.`)
    process.exitCode = 1
  })
}

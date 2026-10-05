/** Opt-in live Gemini media in the shipped Electron shell and its own Host process. */
import { mkdir, mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { spawn, execFile } from 'node:child_process'
import { once } from 'node:events'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium, type Browser, type Page } from 'playwright'
import WebSocket, { WebSocketServer } from 'ws'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { probeFreePort, REPO_ROOT, saveFailureShot } from './support.ts'
import { onTestFailed } from 'vitest'

const profileHome = process.env.HYDRA_GEMINI_WEB_DESKTOP_LIVE_HOME
const fixtures = join(REPO_ROOT, 'apps/web/tests/snapshots/gemini-web')
const savedJobs = { image: process.env.HYDRA_GEMINI_WEB_DESKTOP_IMAGE_JOB, video: process.env.HYDRA_GEMINI_WEB_DESKTOP_VIDEO_JOB }

// Hidden Desktop chrome views suspend their renderers. Attach only the visible Host page.
async function rendererBridge(endpoint: string, targetId: string) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(server, 'listening')
  const address = server.address()
  if (typeof address === 'string' || address === null) throw new Error('No renderer bridge port')
  server.on('connection', (client) => {
    const upstream = new WebSocket(endpoint)
    const ready = once(upstream, 'open')
    upstream.on('message', (data: Buffer) => { if (client.readyState === WebSocket.OPEN) client.send(data.toString()) })
    client.on('message', (data: Buffer) => {
      const row = JSON.parse(data.toString()) as { method?: string; params?: unknown; sessionId?: string }
      if (row.method === 'Target.setAutoAttach' && row.sessionId === undefined) {
        row.method = 'Target.autoAttachRelated'; row.params = { targetId, waitForDebuggerOnStart: false }
      }
      void ready.then(() => { upstream.send(JSON.stringify(row)) }).catch(() => { client.close() })
    })
    client.on('close', () => { upstream.close() }); client.on('error', () => { upstream.close() })
    upstream.on('close', () => { client.close() }); upstream.on('error', () => { client.close() })
  })
  return { endpoint: `ws://127.0.0.1:${address.port}`, close: async () => {
    for (const client of server.clients) client.terminate()
    await new Promise<void>((resolve, reject) =>{  server.close((error) => { if (error) reject(error); else resolve() }) })
  } }
}

async function replay(kind: 'image' | 'video', jobId?: string): Promise<string> {
  const content = await readFile(join(fixtures, `${kind}.jsonl`), 'utf8')
  const lines = content.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
  const sessionId = randomUUID()
  for (const row of lines) {
    if (row.type === 'session') row.id = sessionId
    if (row.type === 'user/message' && jobId !== undefined) {
      (row.data as { content: unknown[] }).content = [{ type: 'text', text: `Retrieve Gemini Web ${kind} job ${jobId}.` }]
    }
    if (row.type !== 'assistant/chunk' || jobId === undefined) continue
    const chunk = (row.data as { chunk: Record<string, unknown> }).chunk
    if (chunk.type === 'tool-call-delta') { chunk.name = 'gemini_web_retrieve'; chunk.argumentsDelta = JSON.stringify({ jobId, kind }) }
    const block = chunk.block as Record<string, unknown> | undefined
    if (block?.type === 'tool-call') { block.name = 'gemini_web_retrieve'; block.arguments = JSON.stringify({ jobId, kind }) }
  }
  return lines.map(line => JSON.stringify(line)).join('\n') + '\n'
}

describe.skipIf(profileHome === undefined)('live Gemini Web shipped Desktop', () => {
  let home: string; let workspace: string; let replayPath: string; let videoReplayPath: string
  let app: { close(): Promise<void> }; let page: Page
  let before: Set<string>
  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'hydra-gemini-desktop-'))
    workspace = join(home, 'workspace'); await mkdir(workspace)
    replayPath = join(home, 'replay.jsonl')
    videoReplayPath = join(home, 'video-replay.jsonl')
    await writeFile(replayPath, await replay('image', savedJobs.image))
    await writeFile(videoReplayPath, await replay('video', savedJobs.video))
    const patch = [
      { id: 'llm-deepseek', disabled: true }, { id: 'session-title-llm', disabled: true },
      { id: 'agent-instructions', disabled: true },
      { id: 'agent-default-model', config: { provider: 'fixture-media', model: 'fixture-media' } },
      { id: 'llm-pi-ai', config: { providers: { 'fixture-media': { api: 'openai-completions', baseURL: 'http://127.0.0.1:1',
        apiKeyEnv: 'HYDRA_DESKTOP_TEST_KEY', models: [{ id: 'fixture-media', contextWindow: 128000 }] } },
      imageModel: { provider: 'gemini-web', model: 'gemini-web-image' }, videoModel: { provider: 'gemini-web', model: 'gemini-web-video' } } },
      { id: 'llm-account-auth', config: { geminiWeb: { hydraHome: profileHome }, providers: { 'gemini-web': { models: [
        { id: 'gemini-web-image', endpoints: ['images/generations'] }, { id: 'gemini-web-video', endpoints: ['videos'] },
      ] } } } },
      { insert: [{ id: 'live-media-replay', name: pathToFileURL(join(REPO_ROOT, 'packages/test-support/llm-replay/lib/index.js')).href,
        config: { file: replayPath, childFiles: [videoReplayPath] } }] },
    ]
    await writeFile(join(home, 'cordis.patch.yml'), JSON.stringify(patch, null, 2))
    before = new Set(await readdir(join(profileHome!, 'gemini-web/jobs')))
  }, 120_000)
  async function launch(): Promise<void> {
    const executable = createRequire(join(REPO_ROOT, 'apps/desktop/package.json'))('electron') as string
    const env = { ...process.env, HYDRA_HOME: home, HYDRA_TELEMETRY_DISABLED: '1', HYDRA_DESKTOP_TEST_KEY: 'fixture-only', LANG: 'en_US.UTF-8' }
    Reflect.deleteProperty(env, 'ELECTRON_RUN_AS_NODE')
    const port = await probeFreePort()
    const child = spawn(executable, [join(REPO_ROOT, 'apps/desktop'), '--lang=en-US',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
      `--remote-debugging-port=${port}`, `--hydra-gemini-live-test=${home}`], { cwd: workspace, env, stdio: 'pipe', windowsHide: true })
    const exited = once(child, 'exit').then(() => {})
    void exited.catch(() => {})
    const resources: { connection?: Browser; bridge?: Awaited<ReturnType<typeof rendererBridge>> } = {}
    app = { async close() {
      if (child.exitCode === null) {
        try { await page?.evaluate(() => (globalThis as typeof globalThis & {
          hydraDesktop: { chrome: { dispatch(action: string): Promise<void> } }
        }).hydraDesktop.chrome.dispatch('close')) } catch { /* Native close can destroy the renderer before acknowledging. */ }
        const stopped = await Promise.race([exited.then(() => true), delay(7000).then(() => false)])
        if (!stopped && child.pid !== undefined) await promisify(execFile)('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
      }
      await exited
      try { await resources.connection?.close() } catch { /* The owned Electron process has exited. */ }
      await resources.bridge?.close()
    } }
    child.stdout.resume(); child.stderr.resume()
    let targetId = ''
    await expect.poll(async () => {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as Array<{ id: string; url: string }>
      targetId = targets.find(row => /^http:\/\/127\.0\.0\.1:\d+\//.test(row.url))?.id ?? ''
      return targetId !== ''
    }, { timeout: 60_000 }).toBe(true)
    const metadata = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json() as { webSocketDebuggerUrl: string }
    resources.bridge = await rendererBridge(metadata.webSocketDebuggerUrl, targetId)
    const connection = await chromium.connectOverCDP(resources.bridge.endpoint, { timeout: 30_000, noDefaults: true })
    resources.connection = connection
    const isHost = (candidate: Page) => /^http:\/\/127\.0\.0\.1:\d+\//.test(candidate.url())
    await expect.poll(() => connection.contexts()[0]!.pages().some(isHost), { timeout: 60_000 }).toBe(true)
    page = connection.contexts()[0]!.pages().find(isHost)!
    page.setDefaultTimeout(60_000)
    await page.waitForSelector('[class*="frame"]')
    const notice = page.getByRole('heading', { name: 'Internal Testing Notice', exact: true })
    await Promise.race([notice.waitFor(), page.getByRole('button', { name: 'Settings', exact: true }).waitFor()])
    if (await notice.isVisible()) await page.getByRole('button', { name: 'Continue', exact: true }).click()
    console.info('Desktop renderer ready')
  }
  afterAll(async () => {
    try { await app?.close() } finally {
      if (home !== undefined && relative(tmpdir(), home).startsWith('hydra-gemini-desktop-')) await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 })
    }
  })
  async function media(kind: 'image' | 'video', prompt: string): Promise<void> {
    const input = page.locator('textarea').first(); await input.fill(prompt); await input.press('Enter')
    const card = page.locator(`[data-media-generation="${kind}"]`).last()
    await card.waitFor({ timeout: 60_000 })
    const asset = card.locator(kind === 'image' ? 'img' : 'video')
    await Promise.race([asset.waitFor({ timeout: 900_000 }), card.getByRole('alert').waitFor({ timeout: 900_000 }).then(async () => {
      throw new Error(await card.getByRole('alert').innerText())
    })])
    await page.getByText('The media is displayed in chat.', { exact: true }).last().waitFor()
    if (kind === 'video') await asset.evaluate(async (element) => {
      const video = element as HTMLVideoElement; await video.play(); video.pause()
      if (video.videoWidth <= video.videoHeight) throw new Error('Expected Landscape video')
    })
    else expect(await asset.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
    await mkdir(join(REPO_ROOT, '.artifacts/gemini-web-live'), { recursive: true })
    await page.screenshot({ path: join(REPO_ROOT, '.artifacts/gemini-web-live', `desktop-${kind}.png`) })
    await page.reload(); await asset.waitFor()
  }
  async function newSession(): Promise<void> {
    await page.getByText('New Session', { exact: true }).click()
    await page.locator('[data-media-generation]').last().waitFor({ state: 'detached' })
  }
  it('connects, generates image/video, restarts the Host, and retrieves both saved tasks', async () => {
    onTestFailed(() => saveFailureShot(page, 'gemini-web-desktop-failure'))
    await launch()
    const method = 'workspace.create'
    const created = await page.request.post(new URL(`/api/${method}`, page.url()).href, {
      data: { type: 'client-request', rpcId: randomUUID(), method, payload: { path: workspace } },
    })
    expect(created.ok()).toBe(true)
    expect((await created.json() as { result: { ok: boolean } }).result.ok).toBe(true)
    await page.reload()
    await page.getByRole('textbox', { name: 'Choose workspace' }).waitFor({ state: 'detached' })
    console.info('Connecting Gemini Web account')
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Settings' })
    await dialog.getByRole('button', { name: 'Models', exact: true }).click()
    await dialog.getByRole('button', { name: 'Edit Gemini Web (gemini-web)', exact: true }).click()
    await dialog.getByRole('button', { name: 'Connect', exact: true }).click()
    await dialog.getByText('Account connected. Apply to save provider settings.', { exact: true }).waitFor({ timeout: 900_000 })
    const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-Command',
      '(Get-CimInstance Win32_Process -Filter "Name=\'msedge.exe\'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:HYDRA_GEMINI_PROFILE_VALUE) } | Measure-Object).Count',
    ], { env: { ...process.env, HYDRA_GEMINI_PROFILE_VALUE: join(profileHome!, 'gemini-web', 'profile') }, windowsHide: true })
    expect(stdout.trim()).toBe('0')
    await dialog.getByRole('button', { name: 'Apply', exact: true }).click()
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    console.info('Managed sign-in finished; generating media over HTTP')
    await media('image', 'Generate an image of a red paper boat on calm blue water.')
    await newSession()
    await media('video', 'Generate a landscape video of a red paper boat on calm blue water.')
    const jobs = []
    for (const file of await readdir(join(profileHome!, 'gemini-web/jobs'))) {
      if (before.has(file) && !Object.values(savedJobs).some(id => file === `${id}.json`)) continue
      const row = JSON.parse(await readFile(join(profileHome!, 'gemini-web/jobs', file), 'utf8')) as { id: string; kind: 'image' | 'video'; status: string }
      expect(row.status).toBe('downloaded'); jobs.push(row)
    }
    expect(jobs).toHaveLength(2)
    await app.close()
    const image = jobs.find(job => job.kind === 'image')!; const video = jobs.find(job => job.kind === 'video')!
    await writeFile(replayPath, await replay('image', image.id))
    await writeFile(videoReplayPath, await replay('video', video.id))
    await launch()
    await newSession()
    await media('image', `Retrieve Gemini Web image job ${image.id}.`)
    await newSession()
    await media('video', `Retrieve Gemini Web video job ${video.id}.`)
    expect((await readdir(join(profileHome!, 'gemini-web/jobs'))).filter(file => !before.has(file)))
      .toHaveLength(2 - Object.values(savedJobs).filter(id => id !== undefined).length)
  }, 1_800_000)
})

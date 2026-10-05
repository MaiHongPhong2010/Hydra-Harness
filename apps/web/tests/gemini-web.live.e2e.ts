/** Opt-in live Gemini Web delivery through the shipped UI and native account flow. */
import { readFile, mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chromium, type Browser, type Page } from 'playwright'
import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { CallId } from '@hydraharness/harness-llm'
import { toolImageReferences, toolVideoReferences } from '@hydraharness/harness-attachment'
import { GeminiWebAdapter } from '../../../packages/llm/llm-account-auth/src/gemini-web.ts'
import { launchWebScaffold, fixtureUserPrompts, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, connectFreshWorkspace, REPO_ROOT } from './support.ts'

const home = process.env.HYDRA_GEMINI_WEB_LIVE_HOME
describe.skipIf(home === undefined).each(['image', 'video'] as const)('live Gemini Web %s', (kind) => {
  let scaffold: WebScaffold; let browser: Browser; let page: Page
  let fixture = join(REPO_ROOT, 'apps/web/tests/snapshots/gemini-web', `${kind}.jsonl`)
  let fixtureRoot: string | undefined
  beforeAll(async () => {
    const jobId = kind === 'image' ? process.env.HYDRA_GEMINI_WEB_LIVE_IMAGE_JOB : process.env.HYDRA_GEMINI_WEB_LIVE_VIDEO_JOB
    if (jobId !== undefined) {
      if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(jobId)) throw new Error('Invalid live recovery job id')
      const rows = (await readFile(fixture, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
      for (const row of rows) {
        if (row.type === 'user/message') (row.data as { content: unknown[] }).content = [{ type: 'text', text: `Retrieve Gemini Web ${kind} job ${jobId}.` }]
        if (row.type !== 'assistant/chunk') continue
        const chunk = (row.data as { chunk: Record<string, unknown> }).chunk
        if (chunk.type === 'tool-call-delta') { chunk.name = 'gemini_web_retrieve'; chunk.argumentsDelta = JSON.stringify({ jobId, kind }) }
        const block = chunk.block as Record<string, unknown> | undefined
        if (block?.type === 'tool-call') { block.name = 'gemini_web_retrieve'; block.arguments = JSON.stringify({ jobId, kind }) }
      }
      fixtureRoot = await mkdtemp(join(tmpdir(), 'gemini-live-recovery-'))
      fixture = join(fixtureRoot, 'session.jsonl'); await writeFile(fixture, rows.map(row => JSON.stringify(row)).join('\n') + '\n')
    }
    scaffold = await launchWebScaffold({ replayFixture: fixture, extraPatches: [
      { id: 'llm-account-auth', config: { providers: { 'gemini-web': {} }, geminiWeb: { hydraHome: home } } },
    ] })
    browser = await chromium.launch(); page = await newEnglishPage(browser)
    page.setDefaultTimeout(60_000)
    await page.goto(scaffold.baseUrl); await page.waitForSelector('[class*="frame"]')
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)
  afterAll(async () => { try { await browser?.close() } finally {
    try { await scaffold?.close() } finally { if (fixtureRoot !== undefined) await rm(fixtureRoot, { recursive: true, force: true }) }
  } })
  it('closes the managed browser, delivers media, reloads, and recovers without another prompt', async () => {
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Settings' })
    await dialog.getByRole('button', { name: 'Models', exact: true }).click()
    await dialog.getByRole('button', { name: 'Edit Gemini Web (gemini-web)', exact: true }).click()
    await dialog.getByRole('button', { name: 'Connect', exact: true }).click()
    await dialog.getByText('Account connected. Apply to save provider settings.', { exact: true }).waitFor({ timeout: 900_000 })
    const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-Command',
      '(Get-CimInstance Win32_Process -Filter "Name=\'msedge.exe\'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:HYDRA_GEMINI_PROFILE_VALUE) } | Measure-Object).Count',
    ], { env: { ...process.env, HYDRA_GEMINI_PROFILE_VALUE: join(home!, 'gemini-web', 'profile') }, windowsHide: true })
    expect(stdout.trim()).toBe('0')
    await dialog.getByText('Customized settings', { exact: true }).click()
    await dialog.getByRole('button', { name: 'Get all', exact: true }).click()
    await expect.poll(() => dialog.getByRole('textbox', { name: 'Model ID 1', exact: true }).inputValue()).toBe('gemini-web-image')
    await dialog.getByRole('button', { name: 'Apply', exact: true }).click()
    await dialog.getByLabel(kind === 'image' ? 'Image model' : 'Video model', { exact: true })
      .selectOption(JSON.stringify(['gemini-web', `gemini-web-${kind}`]))
    await dialog.getByRole('region', { name: 'Image and video generation' }).getByRole('button', { name: 'Apply', exact: true }).click()
    await dialog.getByRole('button', { name: 'Apply', exact: true }).waitFor({ state: 'detached' })
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    const settled = scaffold.whenTurnSettled(900_000)
    const input = page.locator('textarea').first()
    await input.fill(fixtureUserPrompts(await readFile(fixture, 'utf8'))[0]!); await input.press('Enter')
    const session = scaffold.ctx.sessions.get(await settled)!
    const result = session.events.find(event => event.type === 'tool/result')!
    if (result.data.error !== undefined) throw new Error(JSON.stringify(result.data.message.content))
    expect(result.data.error).toBeUndefined()
    const refs = kind === 'image' ? toolImageReferences(result.data.meta) : toolVideoReferences(result.data.meta)
    expect(refs).toHaveLength(1); expect(refs[0]!.bytes).toBeGreaterThan(1000)
    const meta = result.data.meta as Record<string, unknown>
    expect(meta.jobId).toMatch(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/)
    const card = `[data-media-generation="${kind}"]`
    await page.locator(`${card} ${kind === 'image' ? 'img' : 'video'}`).waitFor()
    if (kind === 'video') await page.locator(`${card} video`).evaluate(async (element) => {
      const video = element as HTMLVideoElement; await video.play(); video.pause()
      if (video.videoWidth <= video.videoHeight) throw new Error('Expected Landscape video')
    })
    await mkdir(join(REPO_ROOT, '.artifacts/gemini-web-live'), { recursive: true })
    await page.screenshot({ path: join(REPO_ROOT, '.artifacts/gemini-web-live', `${kind}.png`) })
    await page.reload(); await page.locator(`${card} ${kind === 'image' ? 'img' : 'video'}`).waitFor()
    const restarted = new GeminiWebAdapter(scaffold.ctx, () => ({ hydraHome: home! }))
    try {
      const reply = await restarted.requestGeneration({ provider: 'gemini-web', model: `gemini-web-${kind}`,
        endpoint: kind === 'image' ? 'images/generations' : 'videos', body: { jobId: meta.jobId }, maxResponseBytes: 32 * 1024 * 1024,
        signal: AbortSignal.timeout(900_000) })
      expect((await reply.arrayBuffer()).byteLength).toBeGreaterThan(1000)
    } finally { await restarted.dispose() }
    const retrieved = await scaffold.ctx.tools.execute({ name: 'gemini_web_retrieve', callId: CallId('live-retrieve'),
      arguments: { jobId: meta.jobId, kind }, signal: AbortSignal.timeout(900_000) })
    expect(retrieved.isError).toBe(false)
    expect(kind === 'image' ? toolImageReferences(retrieved.meta) : toolVideoReferences(retrieved.meta)).toHaveLength(1)
  }, 900_000)
})

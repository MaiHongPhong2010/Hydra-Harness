/** Shipped account/media composition with secret-free Gemini HTTP fixtures and browser snapshots. */
import { readFile, mkdir, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { chromium, type Browser, type Page } from 'playwright'
import { CookieJar } from 'tough-cookie'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { credentialKey } from '@hydraharness/harness-credentials'
import { toolImageReferences, toolVideoReferences } from '@hydraharness/harness-attachment'
import { unzipSync } from 'fflate'
import { captureStableAria, compareOrRefreshGolden, fixtureUserPrompts, launchWebScaffold, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, REPO_ROOT } from './support.ts'

const DIR = fileURLToPath(new URL('./snapshots/gemini-web/', import.meta.url))
const JOB_ID = '00000000-0000-4000-8000-000000000001'
const accountId = createHash('sha256').update('fixture@example.test').digest('hex')
const frame = (rows: unknown) => { const value = JSON.stringify(rows); return `)]}'\n${value.length + 1}\n${value}\n` }
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')

describe.each(['image', 'video', 'retrieve', 'error', 'reference', 'refusal'] as const)('Gemini Web assembled %s', (scenario) => {
  let scaffold: WebScaffold; let browser: Browser; let page: Page
  let bytes: Buffer; let root: string; let home: string; let jar: CookieJar
  let denyBootstrap = false
  const calls: string[] = []
  const kind = scenario === 'image' ? 'image' : 'video'
  const references = scenario === 'reference' || scenario === 'refusal'
  const failure = scenario === 'error' || scenario === 'refusal'
  let replyKind = kind
  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'hydra-gemini-web-'))
    bytes = await readFile(join(DIR, 'fixture.mp4'))
    const originalFetch = globalThis.fetch
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (!['gemini.google.com', 'lh3.google.com', 'contribution.usercontent.google.com', 'push.clients6.google.com'].includes(url.hostname)) return originalFetch(input, init)
      calls.push(url.pathname.includes('StreamGenerate') ? 'submit' : url.searchParams.get('rpcids') ?? url.pathname)
      if (url.pathname === '/app') return denyBootstrap ? new Response('Sign in', { status: 403 })
        : new Response('{"SNlM0e":"fixture","cfb2h":"fixture-build","FdrFJe":"fixture-session","oPEP7c":"fixture@example.test","qKIAYe":"feeds/fixture"}')
      if (url.hostname === 'push.clients6.google.com') {
        if (new Headers(init?.headers).get('x-goog-upload-command') === 'start') return new Response(null, {
          headers: { 'x-goog-upload-url': 'https://push.clients6.google.com/upload/?upload_id=fixture' },
        })
        expect(Buffer.from(init?.body as Uint8Array)).toEqual(image)
        return new Response('/contrib_service/ttl_1d/fixture')
      }
      if (url.pathname.includes('StreamGenerate')) {
        const outer = JSON.parse(new URLSearchParams(init?.body as URLSearchParams).get('f.req')!) as [unknown, string]
        const body = JSON.parse(outer[1]) as unknown[]; replyKind = body[49] === 14 ? 'image' : 'video'
        if (references && replyKind === 'video') {
          expect(body[55]).toEqual([[17]])
          expect((body[0] as unknown[])[3]).toEqual([[['/contrib_service/ttl_1d/fixture', 1, null, 'image/png', expect.any(String)], 'reference-1.png']])
        }
      }
      const candidate: unknown[] = new Array(13).fill(null); candidate[0] = 'rc_fixture'
      if (replyKind === 'image') candidate[12] = [null, null, null, null, null, null, null, [[[
        [null, null, null, [null, null, null, 'https://lh3.google.com/image']], ['fixture-image'],
      ]]]]
      else if (scenario === 'refusal') {
        candidate[1] = ['Tôi không thể hỗ trợ bạn việc đó, vì tôi chỉ là một mô hình ngôn ngữ và không có khả năng hiểu và phản hồi.']
        candidate[8] = [2]; candidate[12] = [null, null, null, null, null, null, null, []]
      } else {
        const video: unknown[] = new Array(8).fill(null); video[7] = [null, 'https://contribution.usercontent.google.com/video']
        const media: unknown[] = new Array(87).fill(null)
        media[86] = [null, [null, [null, null, null, null, null, null, null, video[7]]]]
        candidate[12] = media
      }
      if (url.pathname.includes('StreamGenerate')) {
        const result: unknown[] = new Array(5).fill(null); result[1] = ['c_fixture', 'r_fixture']; result[4] = replyKind === 'image' ? [candidate] : []
        return new Response(frame([['wrb.fr', null, JSON.stringify(result)]]))
      }
      if (url.searchParams.get('rpcids') === 'hNvQHb') return new Response(frame([['wrb.fr', 'hNvQHb', JSON.stringify([
        [[[null, 'r_fixture'], null, null, [[candidate]]]],
      ])]]))
      if (url.searchParams.get('rpcids') === 'c8o8Fe') return new Response(frame([['wrb.fr', 'c8o8Fe', '["https://lh3.google.com/image"]']]))
      if (url.pathname === '/image') return new Response(image, { headers: { 'content-type': 'image/png' } })
      if (url.pathname === '/video') return new Response(scenario === 'error' ? null : new Uint8Array(bytes), {
        status: scenario === 'error' ? 403 : 200, headers: { 'content-type': 'video/mp4' },
      })
      throw new Error('Unexpected fixture RPC')
    })
    scaffold = await launchWebScaffold({ replayFixture: join(DIR, `${scenario}.jsonl`), extraPatches: [
      { id: 'llm-account-auth', config: { providers: { 'gemini-web': {} }, geminiWeb: { hydraHome: home, pollIntervalMs: 1 } } },
      { id: 'tool-media', config: { video: { pollIntervalMs: 1 } } },
    ] })
    root = join(home, 'gemini-web', 'jobs'); await mkdir(root, { recursive: true })
    jar = new CookieJar(); await jar.setCookie('__Secure-1PSID=fixture; Secure; Domain=.google.com; Path=/', 'https://gemini.google.com')
    if (scenario !== 'image') await scaffold.ctx.credentials.modifyRecord(credentialKey('llm-account-auth', 'gemini-web'), async () => ({ kind: 'grant', payload: {
      version: 1, revision: JOB_ID, accountId, label: 'fixture@example.test', jar: await jar.serialize(),
    } }))
    if (scenario === 'retrieve') await writeFile(join(root, `${JOB_ID}.json`), JSON.stringify({
      version: 1, id: JOB_ID, kind, accountId, cid: 'c_fixture', rid: 'r_fixture', rcid: 'rc_fixture', status: 'accepted',
    }))
    browser = await chromium.launch(); page = await newEnglishPage(browser)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' }); await page.waitForSelector('[class*="frame"]')
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    try { await scaffold?.close() } finally {
      vi.unstubAllGlobals(); if (home !== undefined) await rm(home, { recursive: true, force: true })
    }
  })

  it('selects media, displays durable attachments or a recoverable job error, and survives reload/export', async () => {
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Settings' })
    await dialog.getByRole('button', { name: 'Models', exact: true }).click()
    await dialog.getByRole('button', { name: 'Edit Gemini Web (gemini-web)', exact: true }).click()
    const docs = dialog.getByRole('link', { name: 'Read the full cookie-copy guide', exact: true })
    expect(await docs.getAttribute('href')).toBe('https://maihongphong1902.github.io/Hydra-Harness/guide/providers#import-gemini-web-cookies')
    if (scenario === 'image') {
      await dialog.getByRole('button', { name: 'Connect', exact: true }).waitFor()
      await expect.poll(() => dialog.getByRole('button', { name: 'Connect', exact: true }).isEnabled()).toBe(true)
      await dialog.getByText('No accounts connected.', { exact: true }).waitFor()
      await compareOrRefreshGolden(join(DIR, 'onboarding.expected.md'),
        await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd), webSnapshotMode())
      await dialog.getByRole('combobox', { name: 'Sign-in method' }).selectOption('cookies')
      await dialog.getByRole('button', { name: 'Import Cookies', exact: true }).click()
      const secret = dialog.getByLabel('Gemini cookies JSON', { exact: true })
      await secret.waitFor()
      expect(await secret.getAttribute('type')).toBe('password')
      const copyGuide = dialog.getByText('How to copy cookies', { exact: true })
      expect(await copyGuide.evaluate(element => element.parentElement?.hasAttribute('open'))).toBe(false)
      await copyGuide.focus()
      await page.keyboard.press('Enter')
      await dialog.getByText('Choose Export → JSON to copy all cookies for that tab. Keep the complete JSON array and its metadata.', { exact: true }).waitFor()
      const exporter = dialog.getByRole('link', { name: 'Cookie-Editor', exact: true })
      expect(await exporter.getAttribute('href')).toBe('https://cookie-editor.com/')
      expect(await exporter.getAttribute('rel')).toBe('noopener noreferrer')
      await compareOrRefreshGolden(join(DIR, 'import.expected.md'),
        await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd), webSnapshotMode())
      await dialog.getByRole('button', { name: 'Continue', exact: true }).scrollIntoViewIfNeeded()
      await page.screenshot({ path: join(REPO_ROOT, '.artifacts', 'gemini-web-import.png') })
      await secret.fill('invalid-secret-json')
      await dialog.getByRole('button', { name: 'Continue', exact: true }).click()
      await dialog.getByText('Import a Google cookie JSON array or Playwright storage state, up to 64 KiB.', { exact: true }).waitFor()
      await dialog.getByRole('alert').waitFor()
      expect(await scaffold.ctx.credentials.readRecord(credentialKey('llm-account-auth', 'gemini-web'))).toBeUndefined()
      await compareOrRefreshGolden(join(DIR, 'import-invalid.expected.md'),
        await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd), webSnapshotMode())
      for (const theme of ['Light', 'Dark']) {
        await dialog.getByRole('button', { name: 'General', exact: true }).click()
        await dialog.getByRole('button', { name: theme, exact: true }).click()
        await dialog.getByRole('button', { name: 'Models', exact: true }).click()
        await dialog.getByRole('button', { name: 'Edit Gemini Web (gemini-web)', exact: true }).click()
        await dialog.getByRole('combobox', { name: 'Sign-in method' }).selectOption('cookies')
        await dialog.getByRole('button', { name: 'Import Cookies', exact: true }).click()
        await secret.waitFor()
        await copyGuide.click()
        for (const width of [1680, 560]) {
          await page.setViewportSize({ width, height: 1000 })
          await dialog.getByRole('button', { name: 'Continue', exact: true }).scrollIntoViewIfNeeded()
          expect(await secret.evaluate(element => getComputedStyle(element).fontSize)).toBe('14px')
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
          await page.screenshot({ path: join(REPO_ROOT, '.artifacts', `gemini-web-import-${theme.toLowerCase()}-${width}.png`) })
          await copyGuide.locator('..').screenshot({ path: join(REPO_ROOT, '.artifacts', `gemini-web-cookie-guide-${theme.toLowerCase()}-${width}.png`) })
        }
        await page.setViewportSize({ width: 1680, height: 1000 })
        await dialog.getByRole('button', { name: 'Cancel sign-in', exact: true }).click()
        await dialog.getByText('Sign-in cancelled.', { exact: true }).waitFor()
      }
      await dialog.getByRole('button', { name: 'Import Cookies', exact: true }).click()
      await dialog.getByLabel('Cookies JSON file', { exact: true }).setInputFiles({ name: 'cookies.json', mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify([{ name: '__Secure-1PSID', value: 'import-fixture-cookie', domain: '.google.com', path: '/',
          secure: true, httpOnly: true, hostOnly: false, session: true, sameSite: null, storeId: null }])) })
      await expect.poll(() => secret.inputValue()).toContain('import-fixture-cookie')
      await dialog.getByRole('button', { name: 'Continue', exact: true }).click()
      await dialog.getByText('Account connected. Apply to save provider settings.', { exact: true }).waitFor()
      expect(calls.filter(call => call === 'submit')).toHaveLength(0)
    }
    await dialog.getByText('fixture@example.test', { exact: true }).waitFor()
    expect(await dialog.getByRole('button', { name: scenario === 'image' ? 'Import Cookies' : 'Reconnect', exact: true }).count()).toBe(1)
    expect(await dialog.getByRole('button', { name: 'Remove fixture@example.test', exact: true }).count()).toBe(1)
    await dialog.getByText('Usage unavailable from provider', { exact: true }).waitFor()
    if (scenario === 'image') await compareOrRefreshGolden(join(DIR, 'account.expected.md'),
      await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd), webSnapshotMode())
    if (scenario === 'image') {
      const before = await scaffold.ctx.credentials.readRecord(credentialKey('llm-account-auth', 'gemini-web'))
      denyBootstrap = true
      await dialog.getByRole('button', { name: 'Import Cookies', exact: true }).click()
      await dialog.getByLabel('Gemini cookies JSON', { exact: true }).fill(JSON.stringify([{ name: '__Secure-1PSID', value: 'expired-fixture-cookie',
        domain: '.google.com', path: '/', secure: true, httpOnly: true }]))
      await dialog.getByRole('button', { name: 'Continue', exact: true }).click()
      await dialog.getByText('Gemini bootstrap: RECONNECT_REQUIRED (HTTP 403)', { exact: true }).waitFor()
      await dialog.getByRole('alert').waitFor()
      expect(await scaffold.ctx.credentials.readRecord(credentialKey('llm-account-auth', 'gemini-web'))).toEqual(before)
      const output = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)
      expect(output).not.toMatch(/expired-fixture-cookie|import-fixture-cookie/)
      await compareOrRefreshGolden(join(DIR, 'import-expired.expected.md'), output, webSnapshotMode())
      denyBootstrap = false
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
      await dialog.getByRole('button', { name: 'Edit Gemini Web (gemini-web)', exact: true }).click()
    }
    await dialog.getByText('Customized settings', { exact: true }).click()
    await dialog.getByRole('button', { name: 'Get all', exact: true }).click()
    await expect.poll(() => dialog.getByRole('textbox', { name: 'Model ID 1', exact: true }).inputValue()).toBe('gemini-web-image')
    await dialog.getByRole('button', { name: 'Apply', exact: true }).click()
    await dialog.getByRole('button', { name: 'Edit Gemini Web (gemini-web)', exact: true }).waitFor()
    await dialog.getByLabel('Image model', { exact: true }).selectOption(JSON.stringify(['gemini-web', 'gemini-web-image']))
    await dialog.getByLabel('Video model', { exact: true }).selectOption(JSON.stringify(['gemini-web', 'gemini-web-video']))
    await dialog.getByRole('region', { name: 'Image and video generation', exact: true }).getByRole('button', { name: 'Apply', exact: true }).click()
    await expect.poll(() => dialog.getByLabel('Image model', { exact: true }).isEnabled()).toBe(true)
    await expect.poll(() => dialog.getByLabel('Video model', { exact: true }).isEnabled()).toBe(true)
    expect(await dialog.getByLabel('Image model', { exact: true }).inputValue()).toBe(JSON.stringify(['gemini-web', 'gemini-web-image']))
    expect(await dialog.getByLabel('Video model', { exact: true }).inputValue()).toBe(JSON.stringify(['gemini-web', 'gemini-web-video']))
    if (scenario === 'image') await compareOrRefreshGolden(join(DIR, 'models.expected.md'),
      await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd), webSnapshotMode())
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    const input = page.locator('textarea').first()
    let sessionId: Awaited<ReturnType<WebScaffold['whenTurnSettled']>> | undefined
    for (const prompt of fixtureUserPrompts(await readFile(join(DIR, `${scenario}.jsonl`), 'utf8'))) {
      const settled = scaffold.whenTurnSettled()
      await input.fill(prompt); await input.press('Enter')
      sessionId = await settled
    }
    if (sessionId === undefined) throw new Error('Gemini fixture must contain a user prompt')
    const session = scaffold.ctx.sessions.get(sessionId)!
    const results = session.events.filter(event => event.type === 'tool/result')
    const result = results.at(-1)!
    if (references) {
      const ref = toolImageReferences(results[0]!.data.meta)[0]!
      expect(JSON.stringify(results[0]!.data.message)).toContain(ref.attachmentId)
      expect(results).toHaveLength(2)
      expect(calls.filter(call => call === '/upload/')).toHaveLength(2)
      await page.locator('[data-media-generation="image"] img').waitFor()
    }
    let jobId = JOB_ID
    if (failure) {
      expect(result.data.error).toBeDefined()
      const message = JSON.stringify(result.data)
      jobId = /jobId=([0-9a-f-]{36})/.exec(message)![1]!
      expect(jobId).toMatch(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/)
      expect(JSON.parse(await readFile(join(root, `${jobId}.json`), 'utf8'))).toMatchObject({ cid: 'c_fixture', rid: 'r_fixture', status: scenario === 'refusal' ? 'failed' : 'uncertain' })
      expect(message).not.toMatch(/fixture-session|fixture-image|https:\/\/|__Secure/)
      if (scenario === 'refusal') {
        expect(message).toContain('Gemini finished the reply without generating a video.')
        expect(message).toContain('This task has no video to retrieve; do not retry generation automatically.')
        expect(calls.filter(call => call === 'hNvQHb')).toHaveLength(2)
        expect(toolVideoReferences(result.data.meta)).toHaveLength(0)
      }
    } else {
      expect(result.data.error).toBeUndefined()
      expect(kind === 'image' ? toolImageReferences(result.data.meta) : toolVideoReferences(result.data.meta)).toHaveLength(1)
      const media = page.locator(kind === 'image' ? '[data-media-generation="image"] img' : '[data-media-generation="video"] video')
      await media.waitFor()
      if (kind === 'video') await media.evaluate(async (element) => { const video = element as HTMLVideoElement; await video.play(); video.pause() })
      const response = await page.request.get(`${scaffold.baseUrl}/api/session.export?sessionId=${sessionId}`)
      expect(response.ok()).toBe(true)
      const files = unzipSync(new Uint8Array(await response.body()))
      expect(Object.keys(files).some(path => path.endsWith(kind === 'image' ? '.png' : '.mp4'))).toBe(true)
    }
    expect(calls.filter(call => call === 'submit')).toHaveLength(scenario === 'retrieve' ? 0 : references ? 2 : 1)
    const card = `[data-media-generation="${kind}"]`
    await compareOrRefreshGolden(join(DIR, `${scenario}.expected.md`),
      (await captureStableAria(page, card, scaffold.workspaceCwd)).replaceAll(jobId, '{{jobId}}').replaceAll(scaffold.baseUrl, '{{host}}'), webSnapshotMode())
    await page.screenshot({ path: join(REPO_ROOT, '.artifacts', `gemini-web-${scenario}.png`) })
    await page.reload({ waitUntil: 'load' }); await page.waitForSelector(card)
    if (!failure) await page.locator(`${card} ${kind === 'image' ? 'img' : 'video'}`).waitFor()
    else await page.locator(card).getByRole('alert').waitFor()
  })
})

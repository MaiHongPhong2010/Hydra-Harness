/** Image API output through the shipped Web loop, durable replay, and gallery. */
import { createServer, type Server } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed, vi } from 'vitest'
import { credentialRef } from '@hydraharness/harness-credentials'
import { toolImageReferences } from '@hydraharness/harness-attachment'
import { accountRecordKey, createAccountPool } from '../../../packages/llm/llm-account-auth/src/accounts.ts'
import type PluginInventoryGateway from '@hydraharness/harness-host-plugin-inventory'
import { captureStableAria, compareOrRefreshGolden, fixtureUserPrompts, launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, REPO_ROOT } from './support.ts'

describe.skipIf(webSnapshotMode() === 'record').each(['OpenAI', 'Google', 'OpenAI fallback', 'Google configured', 'Antigravity', 'CLIProxy Gemini', 'Codex'] as const)('web e2e: %s image generation', (provider) => {
  const codex = provider === 'Codex'
  const antigravity = provider === 'Antigravity'
  const proxyGemini = provider === 'CLIProxy Gemini'
  const google = provider.startsWith('Google') || antigravity || proxyGemini
  const fallback = provider === 'OpenAI fallback'
  const configuredGoogle = provider === 'Google configured'
  const configured = fallback || configuredGoogle
  const providerLabel = codex ? 'chatgpt' : antigravity ? 'antigravity' : proxyGemini ? 'proxy-gemini' : configured ? 'fixture-images' : google ? 'Google' : 'OpenAI'
  const fixtureName = google ? 'image-generation-google' : 'image-generation'
  const FIXTURE = fileURLToPath(new URL(`./snapshots/${fixtureName}/session.jsonl`, import.meta.url))
  const GOLDEN = fileURLToPath(new URL(`./snapshots/${fixtureName}/${codex ? 'codex-' : antigravity ? 'antigravity-' : proxyGemini ? 'proxy-' : ''}gallery.expected.md`, import.meta.url))
  const SHOTS = join(REPO_ROOT, '.artifacts', codex ? 'image-generation-codex' : antigravity ? 'image-generation-antigravity' : proxyGemini ? 'image-generation-proxy' : fallback ? 'image-generation-fallback' : fixtureName)
  const callId = google ? 'image-google' : 'image-openai'
  const model = codex ? 'gpt-image-2' : google ? 'gemini-3.1-flash-image' : 'gpt-image-1.5'
  const imageChoice = google ? model : 'gpt-image-2'
  const videoChoice = google ? 'veo-3.1' : 'sora-2'
  const listing = google ? ['chat-fixture', model, videoChoice] : ['chat-fixture', 'gpt-image-2', 'gpt-image-1.5', videoChoice]
  let scaffold: WebScaffold
  let server: Server | undefined
  let browser: Browser
  let page: Page
  let imageBytes: Buffer
  let tripwire: ReturnType<typeof watchConsole>
  const requests: unknown[] = []
  const clientErrors: string[] = []
  let finishGeneration: (() => void) | undefined

  beforeAll(async () => {
    if (codex) {
      const upstream = fetch
      vi.stubGlobal('fetch', (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input
        return url.startsWith('https://chatgpt.com/backend-api/wham/')
          ? Promise.resolve(new Response(null, { status: 503 })) : upstream(input, init)
      })
    }
    imageBytes = await readFile(join(REPO_ROOT, `apps/web/tests/snapshots/image-generation/${google ? 'wide' : 'portrait'}.png`))
    server = createServer((request, reply) => { void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array))
      if (request.method === 'GET') {
        reply.writeHead(200, { 'Content-Type': 'application/json' })
        reply.end(JSON.stringify(codex ? { models: [{ slug: 'chat-fixture', display_name: 'Live conversation model' }] } : configuredGoogle
          ? { models: listing.map(id => ({ name: `models/${id}`, supportedGenerationMethods: [id === videoChoice ? 'predictLongRunning' : 'generateContent'] })) }
          : { data: listing.map(id => ({ id })) }))
        return
      }
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { model?: string }
      requests.push({
        path: request.url, auth: request.headers[google && !antigravity && !proxyGemini ? 'x-goog-api-key' : 'authorization'],
        body,
      })
      if (fallback && body.model === 'gpt-image-2') {
        reply.writeHead(404, { 'Content-Type': 'application/json' })
        reply.end(JSON.stringify({ error: 'model unavailable at fixture endpoint' }))
        return
      }
      await new Promise<void>((resolve) => { finishGeneration = resolve })
      reply.writeHead(200, { 'Content-Type': antigravity ? 'text/event-stream' : 'application/json' })
      const gemini = { candidates: [{ finishReason: 'STOP', content: { parts: [{ inlineData: { mimeType: 'image/png', data: imageBytes.toString('base64') } }] } }] }
      if (antigravity) { reply.end(`data: ${JSON.stringify({ response: gemini })}\n\n`); return }
      reply.end(JSON.stringify(proxyGemini
        ? { choices: [{ finish_reason: 'stop', message: { images: [{ image_url: { url: `data:image/png;base64,${imageBytes.toString('base64')}` } }] } }] }
        : google ? gemini : { data: [{ b64_json: imageBytes.toString('base64') }] }))
    })().catch((error: unknown) => { reply.destroy(error instanceof Error ? error : new Error(String(error))) }) })
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Image fixture server has no port')
    scaffold = await launchWebScaffold({ replayFixture: FIXTURE, extraPatches: [{
      id: 'tool-media',
      config: Object.fromEntries(['openai', 'google'].map(providerId => [providerId, {
        baseURL: `http://127.0.0.1:${address.port}/v1`, apiKeyEnv: 'HYDRA_IMAGE_FIXTURE_KEY',
        ...configured && providerId === (google ? 'google' : 'openai') ? { provider: 'fixture-images' } : {},
      }])),
    }, ...configured ? [{ id: 'llm-pi-ai', config: { providers: { 'fixture-images': {
      displayName: 'Fixture images', api: google ? 'google-generative-ai' : 'openai-completions', baseURL: `http://127.0.0.1:${address.port}/v1`,
      apiKeyEnv: 'HYDRA_IMAGE_FIXTURE_KEY', models: [{ id: 'chat-fixture' }],
    }, 'peer-images': {
      displayName: 'Peer images', api: 'openai-completions', baseURL: `http://127.0.0.1:${address.port}/v1`,
      models: [{ id: 'chat-fixture' }, { id: 'peer-model', endpoints: ['images/generations', 'videos'] }],
    } } } }] : [], ...antigravity ? [
      { id: 'llm-account-auth', config: { providers: { antigravity: { endpoint: `http://127.0.0.1:${address.port}`, models: [{ id: 'chat-fixture' }, { id: model }] } } } },
      { id: 'llm-pi-ai', config: { imageModel: { provider: 'antigravity', model } } },
    ] : [], ...codex ? [{ id: 'llm-account-auth', config: { providers: { chatgpt: { endpoint: `http://127.0.0.1:${address.port}`, models: [{ id: 'chat-fixture' }] } } } }] : [], ...proxyGemini ? [{ id: 'llm-pi-ai', config: {
      providers: { 'proxy-gemini': { api: 'openai-completions', baseURL: `http://127.0.0.1:${address.port}/v1`, apiKeyEnv: 'HYDRA_IMAGE_FIXTURE_KEY', models: [{ id: model }] } },
      imageModel: { provider: 'proxy-gemini', model },
    } }] : []] })
    if (codex) await createAccountPool({ ctx: scaffold.ctx, key: accountRecordKey('chatgpt'), providerId: 'chatgpt', providerLabel: 'ChatGPT' })
      .add('Fixture account', { type: 'oauth', access: 'fixture-only-token', refresh: 'fixture-only-refresh', expires: Date.now() + 60_000, accountId: 'fixture-account' })
    else if (antigravity) await createAccountPool({ ctx: scaffold.ctx, key: accountRecordKey('antigravity'), providerId: 'antigravity', providerLabel: 'Google Antigravity' })
      .add('Fixture account', { type: 'oauth', access: 'fixture-only-token', refresh: 'fixture-only-refresh', expires: Date.now() + 60_000, projectId: 'fixture-project' })
    else await scaffold.ctx.credentials.set(credentialRef('HYDRA_IMAGE_FIXTURE_KEY'), 'fixture-only-key')
    expect(scaffold.ctx.tools.get('image_generate')).toBeDefined()
    expect(scaffold.ctx.tools.get('image_generate_google')).toBeDefined()
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    page.on('console', (message) => { if (message.type() === 'error') clientErrors.push(message.text()) })
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    await mkdir(SHOTS, { recursive: true })

  }, 120_000)

  afterAll(async () => {
    try { await browser?.close() } finally {
      finishGeneration?.()
      try { await scaffold?.close() } finally {
        if (codex) vi.unstubAllGlobals()
        const running = server
        if (running !== undefined) {
          running.closeAllConnections()
          await new Promise<void>((resolve) => { running.close(() => { resolve() }) })
        }
      }
    }
  })

  it('mounts one media plugin and switches all image and video tools together', async () => {
    page.setDefaultTimeout(5_000)
    onTestFailed(() => page.screenshot({ path: join(SHOTS, 'plugins-failed.png') }).then(() => undefined))
    const inventory = scaffold.ctx.get('pluginInventory') as PluginInventoryGateway
    const mediaEntries = (await inventory.list()).entries.filter(entry => entry.moduleName === '@hydraharness/harness-tool-media')
    expect(mediaEntries).toHaveLength(1)
    expect(mediaEntries[0]).toMatchObject({ enabled: true, initialEnabled: true, fiberPhase: 'active', restartRequired: false })
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const settings = page.getByRole('dialog', { name: 'Settings' })
    await settings.getByRole('button', { name: 'Plugins', exact: true }).click()
    await settings.getByRole('tab', { name: 'Plugins', exact: true }).click()
    await settings.getByRole('searchbox', { name: 'Search plugins' }).fill('tool-media')
    const panel = settings.getByRole('tabpanel', { name: 'Plugins', exact: true })
    const row = panel.locator('[data-plugin-module="@hydraharness/harness-tool-media"]')
    await row.getByRole('switch', { name: 'Disable plugin tool-media', exact: true }).waitFor()
    expect(await panel.locator('[data-plugin-module]').count()).toBe(1)
    await row.getByText('Running', { exact: true }).waitFor()
    await compareOrRefreshGolden(join(REPO_ROOT, 'apps/web/tests/snapshots/image-generation/plugins.expected.md'),
      await captureStableAria(page, '[role="tabpanel"]:has([data-plugin-module="@hydraharness/harness-tool-media"])', scaffold.workspaceCwd), webSnapshotMode())
    await page.screenshot({ path: join(SHOTS, 'plugins.png') })
    if (provider === 'OpenAI') {
      await row.getByRole('switch', { name: 'Disable plugin tool-media', exact: true }).click()
      await panel.getByRole('button', { name: 'Save plugin settings', exact: true }).click()
      for (const tool of ['image_generate', 'image_generate_google', 'video_generate']) await expect.poll(() => scaffold.ctx.tools.get(tool)).toBeUndefined()
      await row.getByRole('switch', { name: 'Enable plugin tool-media', exact: true }).click()
      await panel.getByRole('button', { name: 'Save plugin settings', exact: true }).click()
      await row.getByText('Running', { exact: true }).waitFor()
      for (const tool of ['image_generate', 'image_generate_google', 'video_generate']) expect(scaffold.ctx.tools.get(tool)).toBeDefined()
    }
    expect(requests).toEqual([])
    await page.keyboard.press('Escape')
    await settings.waitFor({ state: 'hidden' })
    page.setDefaultTimeout(30_000)
  }, 30_000)

  it('shows the stored original, downloads exact bytes, and survives history reload in both themes', async () => {
    onTestFailed(async () => {
      await page.screenshot({ path: join(SHOTS, 'generation-failed.png') })
      console.log({ requests, alerts: await page.getByRole('alert').allTextContents(), text: codex ? await page.getByRole('dialog', { name: 'Settings' }).allTextContents() : [],
        ...codex ? { saved: await readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8'), catalog: await scaffold.ctx.llm.listModels('chatgpt') } : {} })
    })
    if (codex) {
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      const settings = page.getByRole('dialog', { name: 'Settings' })
      await settings.getByRole('button', { name: 'Models', exact: true }).click()
      await settings.getByRole('button', { name: 'Edit ChatGPT (chatgpt)', exact: true }).click()
      await settings.getByText('Customized settings', { exact: true }).click()
      await settings.getByText(/Codex Fetch combines/).waitFor()
      await settings.getByText('Usage unavailable from provider', { exact: true }).waitFor()
      await settings.getByRole('button', { name: 'Get all', exact: true }).click()
      await settings.getByLabel('Model ID 3', { exact: true }).waitFor()
      for (const [index, id] of ['chat-fixture', 'gpt-image-1.5', 'gpt-image-2'].entries()) {
        expect(await settings.getByLabel(`Model ID ${index + 1}`, { exact: true }).inputValue()).toBe(id)
      }
      expect(await settings.getByRole('combobox', { name: /^Model use/ }).count()).toBe(0)
      await compareOrRefreshGolden(join(REPO_ROOT, 'apps/web/tests/snapshots/image-generation/codex-catalog.expected.md'),
        await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd), webSnapshotMode())
      await settings.getByRole('button', { name: 'Apply', exact: true }).click()
      await settings.getByText('Saved ChatGPT (chatgpt).', { exact: true }).waitFor()
      const generation = settings.getByRole('region', { name: 'Image and video generation' })
      expect(await generation.getByRole('combobox').count()).toBe(2)
      const imageSelect = generation.getByLabel('Image model', { exact: true })
      await imageSelect.locator(`option[value='${JSON.stringify(['chatgpt', model])}']`).waitFor({ state: 'attached' })
      expect(await imageSelect.locator("optgroup[label='ChatGPT (chatgpt)'] option").evaluateAll(options => options.map(option => (option as HTMLOptionElement).value)))
        .toEqual(['gpt-image-1.5', 'gpt-image-2'].map(id => JSON.stringify(['chatgpt', id])))
      expect(await generation.getByLabel('Video model', { exact: true }).locator("optgroup[label='ChatGPT (chatgpt)']").count()).toBe(0)
      await generation.getByLabel('Image model', { exact: true }).selectOption(JSON.stringify(['chatgpt', model]))
      await generation.getByRole('button', { name: 'Apply', exact: true }).click()
      await generation.getByRole('button', { name: 'Discard', exact: true }).waitFor({ state: 'detached' })
      await expect.poll(() => generation.getByLabel('Image model', { exact: true }).inputValue()).toBe(JSON.stringify(['chatgpt', model]))
      await page.screenshot({ path: join(SHOTS, 'models-selection.png') })
      expect(requests).toEqual([])
      await page.keyboard.press('Escape')
      await settings.waitFor({ state: 'hidden' })
      const trigger = page.getByRole('button', { name: /^Select model/ }).first()
      await trigger.click()
      const menu = page.getByRole('menu', { name: 'Model and reasoning effort', exact: true })
      const selectedImage = (await scaffold.ctx.llm.listModels('chatgpt')).find(candidate => candidate.id === model)
      expect(selectedImage).toBeDefined()
      await expect.poll(() => menu.getByRole('menuitem', { name: /^Image model/ }).textContent())
        .toBe(`Image model${selectedImage!.name}`)
      await page.screenshot({ path: join(SHOTS, 'generation-menu.png') })
      await page.keyboard.press('Escape')
      await menu.waitFor({ state: 'hidden' })
    }
    if (configured) {
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      const settings = page.getByRole('dialog', { name: 'Settings' })
      await settings.getByRole('button', { name: 'Models', exact: true }).click()
      await settings.getByRole('button', { name: 'Edit Fixture images (fixture-images)', exact: true }).click()
      await settings.getByText('Customized settings', { exact: true }).click()
      await settings.getByRole('button', { name: 'Get all', exact: true }).click()
      await settings.getByLabel(`Model ID ${listing.length}`, { exact: true }).waitFor()
      expect(await settings.getByRole('combobox', { name: /^Model use/ }).count()).toBe(0)
      await settings.getByRole('button', { name: 'Apply', exact: true }).click()
      await settings.getByText('Saved Fixture images (fixture-images).', { exact: true }).waitFor()
      const generation = settings.getByRole('region', { name: 'Image and video generation' })
      expect(await generation.getByRole('combobox').count()).toBe(2)
      for (const [label, ids] of [['Image model', google ? [imageChoice] : ['gpt-image-2', 'gpt-image-1.5']], ['Video model', [videoChoice]]] as const) {
        const select = generation.getByLabel(label, { exact: true })
        await select.locator(`option[value='${JSON.stringify(['fixture-images', ids[0]])}']`).waitFor({ state: 'attached' })
        const options = await select.locator('option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value))
        expect(options).toEqual(['', ...ids.map(id => JSON.stringify(['fixture-images', id])), JSON.stringify(['peer-images', 'peer-model'])])
      }
      await generation.getByLabel('Image model', { exact: true }).selectOption(JSON.stringify(['fixture-images', imageChoice]))
      await generation.getByLabel('Video model', { exact: true }).selectOption(JSON.stringify(['fixture-images', videoChoice]))
      await compareOrRefreshGolden(join(REPO_ROOT, `apps/web/tests/snapshots/${fixtureName}/model-endpoints.expected.md`),
        await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd), webSnapshotMode())
      await page.screenshot({ path: join(SHOTS, 'model-endpoints.png') })
      await page.setViewportSize({ width: 800, height: 800 })
      await settings.getByLabel('Video model', { exact: true }).scrollIntoViewIfNeeded()
      await page.screenshot({ path: join(SHOTS, 'model-endpoints-narrow.png') })
      expect(await settings.getByLabel('Video model', { exact: true })
        .evaluate(element => element.getBoundingClientRect().right <= innerWidth)).toBe(true)
      await page.setViewportSize({ width: 1680, height: 1000 })
      await generation.getByRole('button', { name: 'Apply', exact: true }).click()
      await generation.getByRole('button', { name: 'Discard', exact: true }).waitFor({ state: 'detached' })
      const saved = await readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8')
      expect(saved).toContain('images/generations')
      expect(saved).toContain(`model: ${imageChoice}`)
      expect(saved).toContain(`model: ${videoChoice}`)
      await page.keyboard.press('Escape')
      await settings.waitFor({ state: 'hidden' })
      await page.getByRole('button', { name: /^Select model/ }).first().click()
      const menu = page.getByRole('menu', { name: 'Model and reasoning effort', exact: true })
      await menu.getByRole('menuitem', { name: /^Model/ }).click()
      const conversation = menu.getByRole('group', { name: 'Fixture images', exact: true })
      await conversation.getByRole('menuitemradio', { name: 'chat-fixture', exact: true }).waitFor()
      expect(await conversation.getByRole('menuitemradio').allTextContents()).toEqual(['chat-fixture'])
      await page.getByRole('button', { name: /^Select model/ }).first().click()
      await menu.waitFor({ state: 'hidden' })
    }
    if (antigravity) {
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      const settings = page.getByRole('dialog', { name: 'Settings' })
      await settings.getByRole('button', { name: 'Models', exact: true }).click()
      const generation = settings.getByRole('region', { name: 'Image and video generation' })
      expect(await generation.getByRole('combobox').count()).toBe(2)
      const imageSelect = generation.getByLabel('Image model', { exact: true })
      await expect.poll(() => imageSelect.isEnabled(), { timeout: 30_000 }).toBe(true)
      expect(await imageSelect.inputValue()).toBe(JSON.stringify(['antigravity', model]))
      expect(await imageSelect.locator('option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value)))
        .toEqual(['', JSON.stringify(['antigravity', model])])
      for (const choice of ['', JSON.stringify(['antigravity', model])]) {
        await imageSelect.selectOption(choice)
        await generation.getByRole('button', { name: 'Apply', exact: true }).click()
        await generation.getByRole('button', { name: 'Discard', exact: true }).waitFor({ state: 'detached' })
      }
      await page.screenshot({ path: join(SHOTS, 'models-selection.png') })
      await page.keyboard.press('Escape')
      await settings.waitFor({ state: 'hidden' })
      expect(requests).toEqual([])
    }
    const settled = scaffold.whenTurnSettled()
    const input = page.locator('textarea').first()
    await input.fill(fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))[0]!)
    await input.press('Enter')
    const pending = page.locator(`[data-media-generation="image"][data-chat-call-id="${callId}"]`)
    await pending.locator('[data-media-placeholder]').waitFor()
    expect(await pending.getAttribute('aria-busy')).toBe('true')
    expect(await pending.evaluate(element => element.closest('[data-chat-activity-group]') === null)).toBe(true)
    if (!google) expect(await pending.locator('[data-media-placeholder]').evaluate((element) => {
      const box = element.getBoundingClientRect()
      return box.width / box.height
    })).toBeCloseTo(2 / 3, 3)
    await page.screenshot({ path: join(SHOTS, 'creating-image.png') })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    expect(await pending.locator('[data-media-placeholder]').evaluate(element => getComputedStyle(element, '::before').animationName)).toBe('none')
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await page.waitForFunction(() => document.querySelector('[data-media-placeholder]') !== null)
    await new Promise<void>((resolve) => {
      const check = (): void => { if (finishGeneration !== undefined) { finishGeneration(); resolve() } else setTimeout(check, 10) }
      check()
    })
    const sessionId = await settled
    const row = page.locator(`[data-chat-call-id="${callId}"]`)
    const thumbnail = row.getByRole('button', { name: 'generated-1.png, click to view original' })
    await thumbnail.locator('img').waitFor()
    const expectedRatio = google ? 8 : 1 / 4
    const thumbnailDimensions = await thumbnail.evaluate((element) => {
      const box = element.getBoundingClientRect()
      return { width: box.width, height: box.height }
    })
    expect(Math.abs(thumbnailDimensions.height - thumbnailDimensions.width / expectedRatio)).toBeLessThan(1)
    expect(await thumbnail.locator('img').evaluate(element => getComputedStyle(element).objectFit)).toBe('contain')
    expect(await thumbnail.evaluate(element =>
      Math.abs(element.getBoundingClientRect().width - element.parentElement!.getBoundingClientRect().width))).toBeLessThan(1)
    if (codex) await expect.poll(() => row.locator('footer').textContent()).toBe('GPT Image 2')
    const prompt = await row.locator('p').first().textContent()
    expect(await row.locator('p').first().evaluate(element => getComputedStyle(element).userSelect)).toBe('text')
    await row.getByRole('button', { name: 'Copy prompt', exact: true }).click()
    await row.getByRole('button', { name: 'Copied', exact: true }).waitFor()
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(prompt)
    await row.getByRole('button', { name: 'View generation details' }).click()
    const details = page.getByRole('complementary', { name: 'Event details' })
    const payloadCopy = details.getByRole('button', { name: 'Copy payload', exact: true })
    await payloadCopy.click()
    await expect.poll(() => payloadCopy.textContent()).toBe('Copied')
    expect(JSON.parse(await page.evaluate(() => navigator.clipboard.readText()))).toMatchObject({ prompt })
    const resultCopy = details.getByRole('button', { name: 'Copy result', exact: true })
    await resultCopy.click()
    await expect.poll(() => resultCopy.textContent()).toBe('Copied')
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('Generated 1 image(s)')
    if (provider === 'OpenAI') {
      await details.getByRole('tab', { name: 'Payload', exact: true }).click()
      await compareOrRefreshGolden(join(REPO_ROOT, 'apps/web/tests/snapshots/image-generation/details-payload.expected.md'),
        await captureStableAria(page, '#trajectory-detail-panel', scaffold.workspaceCwd), webSnapshotMode())
      await details.getByRole('tab', { name: 'Result', exact: true }).click()
      await compareOrRefreshGolden(join(REPO_ROOT, 'apps/web/tests/snapshots/image-generation/details-result.expected.md'),
        await captureStableAria(page, '#trajectory-detail-panel', scaffold.workspaceCwd), webSnapshotMode())
    }
    await page.screenshot({ path: join(SHOTS, 'generation-details.png') })
    await details.getByRole('button', { name: 'Close details' }).click()
    await page.getByRole('tab', { name: 'Chat', exact: true }).click()
    await row.getByRole('button', { name: 'Copy prompt', exact: true }).waitFor()
    expect(await row.getAttribute('data-state')).toBe('complete')
    expect(await row.evaluate(element => element.closest('[data-chat-activity-group]') === null)).toBe(true)
    const session = scaffold.ctx.sessions.get(sessionId)!
    const event = session.events.find(event => event.type === 'tool/result')!
    const refs = toolImageReferences((event.data as { meta?: unknown }).meta)
    expect(refs).toHaveLength(1)
    expect(JSON.stringify(event)).not.toContain('b64_json')
    expect(JSON.stringify(event)).not.toContain('inlineData')
    expect(JSON.stringify(event)).not.toContain('fixture-only-key')
    const imageSummary = JSON.stringify([{
      attachmentId: `sha256:${createHash('sha256').update(imageBytes).digest('hex')}`, mediaType: 'image/png',
      width: google ? 1024 : 256, height: google ? 128 : 1024,
    }])
    expect((event.data as { message: { content: unknown[] } }).message.content).toEqual([{
      type: 'tool-result', toolCallId: callId, isError: false,
      content: [{ type: 'text', text: `Generated 1 image(s) with ${providerLabel} (${model}).\nImage attachments: ${imageSummary}` }],
    }])
    expect((await scaffold.ctx.attachments.readImage(refs[0]!)).data).toEqual(new Uint8Array(imageBytes))
    expect(requests).toHaveLength(fallback ? 2 : 1)
    if (fallback) expect(requests[0]).toMatchObject({ path: '/v1/images/generations', body: { model: 'gpt-image-2' } })
    if (codex) expect(requests.at(-1)).toEqual({
      path: '/codex/images/generations', auth: 'Bearer fixture-only-token',
      body: { model, prompt: 'A Hydra illustration', n: 1, size: '1024x1536', quality: 'low', output_format: 'png', background: 'auto' },
    })
    else if (antigravity) expect(requests.at(-1)).toEqual({
      path: '/v1internal:streamGenerateContent?alt=sse', auth: 'Bearer fixture-only-token',
      body: { project: 'fixture-project', model, userAgent: 'antigravity', requestType: 'image_gen',
        requestId: expect.stringMatching(/^image_gen\//) as string,
        request: { contents: [{ role: 'user', parts: [{ text: 'A Hydra illustration' }] }], generationConfig: { responseModalities: ['IMAGE'] } } },
    })
    else if (proxyGemini) expect(requests.at(-1)).toEqual({
      path: '/v1/chat/completions', auth: 'Bearer fixture-only-key',
      body: { model, stream: false, messages: [{ role: 'user', content: 'A Hydra illustration' }], modalities: ['image', 'text'], n: 1 },
    })
    else expect(requests.at(-1)).toEqual(google ? {
      path: `/v1/models/${model}:generateContent`, auth: 'fixture-only-key',
      body: { contents: [{ role: 'user', parts: [{ text: 'A Hydra illustration' }] }], generationConfig: { responseModalities: ['IMAGE'] } },
    } : {
      path: '/v1/images/generations', auth: 'Bearer fixture-only-key',
      body: { model, prompt: 'A Hydra illustration', n: 1, size: '1024x1536', quality: 'low', output_format: 'png', background: 'auto' },
    })
    if (configured) {
      const settings = page.getByRole('dialog', { name: 'Settings' })
      expect(tripwire.pageErrors).toEqual([])
      expect(tripwire.warnings).toEqual([])
      expect(clientErrors).toEqual([])
      const modelTrigger = page.getByRole('button', { name: /^Select model/ }).first()
      await modelTrigger.click()
      const menu = page.getByRole('menu', { name: 'Model and reasoning effort', exact: true })
      await menu.getByRole('menuitem', { name: /^Image model/ }).click()
      const peerGroup = menu.getByRole('group', { name: 'Peer images (peer-images)', exact: true })
      await peerGroup.getByRole('menuitemradio', { name: 'peer-model', exact: true }).click()
      await menu.waitFor({ state: 'hidden' })
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      await settings.getByRole('button', { name: 'Models', exact: true }).click()
      expect(await settings.getByLabel('Image model', { exact: true }).inputValue()).toBe(JSON.stringify(['peer-images', 'peer-model']))
      expect(await settings.getByLabel('Video model', { exact: true }).inputValue()).toBe(JSON.stringify(['fixture-images', videoChoice]))
      await settings.getByLabel('Image model', { exact: true }).selectOption(JSON.stringify(['fixture-images', imageChoice]))
      await settings.getByRole('region', { name: 'Image and video generation' }).getByRole('button', { name: 'Apply', exact: true }).click()
      await settings.getByRole('region', { name: 'Image and video generation' }).getByRole('button', { name: 'Discard', exact: true }).waitFor({ state: 'detached' })
      await page.keyboard.press('Escape')
      await settings.waitFor({ state: 'hidden' })
      await modelTrigger.click()
      await expect.poll(async () => menu.getByRole('menuitem', { name: /^Image model/ }).textContent())
        .toBe(`Image model${imageChoice}`)
      expect(await menu.getByRole('menuitem', { name: /^Video model/ }).textContent()).toBe(`Video model${videoChoice}`)
      await compareOrRefreshGolden(join(REPO_ROOT, `apps/web/tests/snapshots/${fixtureName}/generation-menu.expected.md`),
        await captureStableAria(page, '[role="menu"]', scaffold.workspaceCwd), webSnapshotMode())
      await page.screenshot({ path: join(SHOTS, 'generation-menu.png') })
      await menu.getByRole('menuitem', { name: /^Video model/ }).click()
      await menu.getByRole('group', { name: 'Peer images (peer-images)', exact: true })
        .getByRole('menuitemradio', { name: 'peer-model', exact: true }).waitFor()
      await menu.getByRole('group', { name: 'Fixture images (fixture-images)', exact: true })
        .getByRole('menuitemradio', { name: videoChoice, exact: true }).click()
      await menu.waitFor({ state: 'hidden' })
    }
    await compareOrRefreshGolden(configured ? GOLDEN.replace('gallery.expected.md', 'configured-gallery.expected.md') : GOLDEN,
      await captureStableAria(page, `[data-chat-call-id="${callId}"]`, scaffold.workspaceCwd), webSnapshotMode())
    await page.screenshot({ path: join(SHOTS, 'light-gallery.png') })
    await thumbnail.click()
    const preview = page.getByRole('dialog', { name: 'Original image preview' })
    await preview.waitFor()
    await page.screenshot({ path: join(SHOTS, 'light-preview.png') })
    const downloaded = page.waitForEvent('download')
    await preview.getByRole('link', { name: 'Download image' }).click()
    const download = await downloaded
    expect(download.suggestedFilename()).toBe('generated-1.png')
    expect(await readFile(await download.path())).toEqual(imageBytes)
    await page.keyboard.press('Escape')
    await preview.waitFor({ state: 'hidden' })
    await page.reload({ waitUntil: 'load' })
    await thumbnail.locator('img').waitFor()
    expect(requests).toHaveLength(fallback ? 2 : 1)
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const settings = page.getByRole('dialog', { name: 'Settings' })
    await settings.getByRole('button', { name: 'General', exact: true }).click()
    await settings.getByRole('button', { name: 'Dark', exact: true }).click()
    await page.keyboard.press('Escape')
    await settings.waitFor({ state: 'hidden' })
    await page.setViewportSize({ width: 800, height: 800 })
    const narrowDimensions = await thumbnail.evaluate((element) => {
      const box = element.getBoundingClientRect()
      return { width: box.width, height: box.height }
    })
    expect(Math.abs(narrowDimensions.height - narrowDimensions.width / expectedRatio)).toBeLessThan(1)
    expect(await thumbnail.evaluate(element =>
      Math.abs(element.getBoundingClientRect().width - element.parentElement!.getBoundingClientRect().width))).toBeLessThan(1)
    await page.screenshot({ path: join(SHOTS, 'dark-gallery-narrow.png') })
    expect(await thumbnail.evaluate(element => element.getBoundingClientRect().right <= innerWidth)).toBe(true)
    if (configured) {
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      await settings.getByRole('button', { name: 'Models', exact: true }).click()
      await settings.getByRole('button', { name: 'Edit Fixture images (fixture-images)', exact: true }).click()
      await settings.getByText('Customized settings', { exact: true }).click()
      const videoUse = settings.getByLabel('Video model', { exact: true })
      expect(await settings.getByLabel('Image model', { exact: true }).inputValue()).toBe(JSON.stringify(['fixture-images', imageChoice]))
      expect(await videoUse.inputValue()).toBe(JSON.stringify(['fixture-images', videoChoice]))
      await videoUse.scrollIntoViewIfNeeded()
      await page.screenshot({ path: join(SHOTS, 'model-endpoints-dark-narrow.png') })
      await page.keyboard.press('Escape')
      await settings.waitFor({ state: 'hidden' })
      await page.getByRole('button', { name: /^Select model/ }).first().click()
      const menu = page.getByRole('menu', { name: 'Model and reasoning effort', exact: true })
      await menu.getByRole('menuitem', { name: /^Image model/ }).waitFor()
      await page.screenshot({ path: join(SHOTS, 'generation-menu-dark-narrow.png') })
      expect(await menu.evaluate(element => element.getBoundingClientRect().right <= innerWidth)).toBe(true)
      await page.keyboard.press('Escape')
    }
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})

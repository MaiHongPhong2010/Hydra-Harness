/** Live default-provider discovery, settings adoption, and shared generation selectors. */
import { createServer, type Server } from 'node:http'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed, vi } from 'vitest'
import { credentialRef } from '@hydraharness/harness-credentials'
import { settingsNamespace } from '@hydraharness/harness-settings'
import * as Catalog from '../../../packages/llm/llm-pi-ai/src/catalog.ts'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, REPO_ROOT } from './support.ts'

describe.skipIf(webSnapshotMode() === 'record').each(['openai', 'google', 'xai'] as const)('web e2e: %s live default model discovery', (provider) => {
  let server: Server
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  const paths: string[] = []
  const headers: string[] = []
  const ids = [provider === 'xai' ? [...Catalog.catalogModels('xai').keys()][0]! : 'fresh-chat', 'fresh-raster-alias', 'fresh-motion-alias'] as const
  const resources = provider === 'xai' ? ['models', 'image-generation-models', 'video-generation-models'] : ['models']
  const expectedPaths = resources.map(resource => `GET /v1/${resource}`)
  const shots = join(REPO_ROOT, '.artifacts', 'live-model-discovery')

  beforeAll(async () => {
    // The fixture substitutes the external HTTP server, retaining the shipped
    // provider's endpoint selection, protocol, and authentication.
    server = createServer((request, response) => {
      paths.push(`${request.method} ${request.url}`)
      headers.push(String(request.headers[provider === 'google' ? 'x-goog-api-key' : 'authorization']))
      response.writeHead(200, { 'Content-Type': 'application/json' })
      if (provider === 'google') {
        response.end(JSON.stringify({ models: ids.map((id, index) => ({
          name: `models/${id}`, supportedGenerationMethods: [index === 2 ? 'predictLongRunning' : 'generateContent'],
        })) }))
      } else if (provider === 'xai') {
        response.end(JSON.stringify(request.url === '/v1/models' ? { data: [{ id: ids[0] }] }
          : { models: [{ id: ids[request.url === '/v1/image-generation-models' ? 1 : 2] }] }))
      } else {
        response.end(JSON.stringify({ data: ids.map((id, index) => ({
          id, endpoints: [index === 0 ? 'responses' : index === 1 ? 'images/generations' : 'videos'],
        })) }))
      }
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Discovery fixture has no port')
    const upstream = fetch
    const nativeBase = Catalog.catalogProvider(provider)!.baseUrl!
    vi.stubGlobal('fetch', (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(input)
      if (resources.some(resource => url.href.startsWith(`${nativeBase}/${resource}`))) {
        const target = `http://127.0.0.1:${address.port}/v1${url.href.slice(nativeBase.length)}`
        return upstream(input instanceof Request ? new Request(target, input) : target, init)
      }
      return upstream(input, init)
    })
    scaffold = await launchWebScaffold({ extraPatches: [{ id: 'llm-pi-ai', config: { providers: {
      [provider]: { displayName: 'Live discovery', apiKeyEnv: 'LIVE_MODELS_FIXTURE_KEY' },
    } } }] })
    await scaffold.ctx.credentials.set(credentialRef('LIVE_MODELS_FIXTURE_KEY'), 'fixture-only-key')
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    await page.getByRole('button', { name: /^Select model/ }).click()
    await page.getByRole('menuitem', { name: /^Image model/ }).waitFor()
    await page.keyboard.press('Escape')
    await mkdir(shots, { recursive: true })
    await mkdir(join(REPO_ROOT, 'apps/web/tests/snapshots/live-model-discovery'), { recursive: true })
  }, 120_000)

  afterAll(async () => {
    try { await browser?.close() } finally {
      try { await scaffold?.close() } finally {
        vi.unstubAllGlobals()
        server?.closeAllConnections()
        if (server !== undefined) await new Promise<void>(resolve => server.close(() => { resolve() }))
      }
    }
  })

  it('fetches without endpoint overrides and saves classification into the corresponding selectors after reload', async () => {
    page.setDefaultTimeout(5_000)
    onTestFailed(async () => {
      await page.screenshot({ path: join(shots, `${provider}-failure.png`) })
      console.log({ paths, alerts: await page.getByRole('alert').allTextContents() })
    })
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const settings = page.getByRole('dialog', { name: 'Settings' })
    await settings.getByRole('button', { name: 'Models', exact: true }).click()
    await settings.getByRole('button', { name: `Edit Live discovery (${provider})`, exact: true }).click()
    await settings.getByText('Customized settings', { exact: true }).click()
    expect(await settings.getByRole('textbox', { name: 'Base URL', exact: true }).inputValue()).toBe('')
    await settings.getByRole('button', { name: 'Get all', exact: true }).click()
    await settings.getByLabel('Model ID 3', { exact: true }).waitFor()
    expect(await settings.getByLabel('Model ID 1', { exact: true }).inputValue()).toBe(ids[0])
    expect(await settings.getByLabel('Model ID 3', { exact: true }).inputValue()).toBe(ids[2])
    expect(paths).toEqual(expectedPaths)
    expect(headers).toEqual(resources.map(() => provider === 'google' ? 'fixture-only-key' : 'Bearer fixture-only-key'))
    await settings.getByRole('button', { name: 'Fetch', exact: true }).click()
    const picker = page.getByRole('dialog', { name: 'Choose models to add' })
    await picker.waitFor()
    await picker.getByRole('checkbox', { name: `Image ${ids[1]}`, exact: true }).check()
    await picker.getByRole('checkbox', { name: `Video ${ids[2]}`, exact: true }).check()
    await picker.getByRole('checkbox', { name: ids[1], exact: true }).check()
    await picker.getByRole('checkbox', { name: ids[2], exact: true }).check()
    await picker.getByRole('button', { name: 'Add selected', exact: true }).click()
    await picker.waitFor({ state: 'hidden' })
    const catalog = settings.getByRole('region', { name: 'Models', exact: true })
    await catalog.getByRole('checkbox', { name: `Image ${ids[1]}`, exact: true }).uncheck()
    await catalog.getByRole('checkbox', { name: `Image ${ids[1]}`, exact: true }).check()
    await catalog.getByRole('checkbox', { name: `Video ${ids[1]}`, exact: true }).check()
    await catalog.getByRole('checkbox', { name: `Video ${ids[1]}`, exact: true }).uncheck()
    await settings.getByRole('region', { name: 'API keys', exact: true }).getByRole('button', { name: 'Apply', exact: true }).click()
    await settings.getByText(`Saved Live discovery (${provider}).`, { exact: true }).waitFor({ timeout: 15_000 })
    const generation = settings.getByRole('region', { name: 'Image and video generation' })
    for (const [label, id] of [['Image model', ids[1]], ['Video model', ids[2]]] as const) {
      const select = generation.getByLabel(label, { exact: true })
      await select.locator(`option[value='${JSON.stringify([provider, id])}']`).waitFor({ state: 'attached' })
      expect(await select.locator(`optgroup[label='Live discovery (${provider})'] option`)
        .evaluateAll(options => options.map(option => (option as HTMLOptionElement).value)))
        .toEqual([JSON.stringify([provider, id])])
      expect(await select.locator(`optgroup[label='Live discovery (${provider})'] option`).allTextContents()).toEqual([id])
    }
    await generation.getByLabel('Image model', { exact: true }).selectOption(JSON.stringify([provider, ids[1]]))
    await generation.getByLabel('Video model', { exact: true }).selectOption(JSON.stringify([provider, ids[2]]))
    await generation.getByRole('button', { name: 'Apply', exact: true }).click()
    await generation.getByRole('button', { name: 'Discard', exact: true }).waitFor({ state: 'detached' })
    for (const [label, id] of [['Image model', ids[1]], ['Video model', ids[2]]] as const) {
      await expect.poll(() => generation.getByLabel(label, { exact: true }).inputValue()).toBe(JSON.stringify([provider, id]))
    }
    const saved = await readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8')
    expect(saved).toContain(`model: ${ids[1]}`)
    expect(saved).toContain(`model: ${ids[2]}`)
    expect(saved).not.toContain('baseURL:')
    expect(saved).not.toContain('api:')
    await compareOrRefreshGolden(join(REPO_ROOT, `apps/web/tests/snapshots/live-model-discovery/${provider}.expected.md`),
      await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd), webSnapshotMode())
    await page.screenshot({ path: join(shots, `${provider}.png`) })
    expect(paths).toEqual([...expectedPaths, ...expectedPaths])
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: /^Select model/ }).click()
    const menu = page.getByRole('menu', { name: 'Model and reasoning effort' })
    for (const [label, id] of [['Image model', ids[1]], ['Video model', ids[2]]] as const) {
      await expect.poll(() => menu.getByRole('menuitem', { name: new RegExp(`^${label}`) }).textContent()).toBe(`${label}${id}`)
    }
    await compareOrRefreshGolden(join(REPO_ROOT, `apps/web/tests/snapshots/live-model-discovery/${provider}-composer.expected.md`),
      await captureStableAria(page, '[role="menu"]', scaffold.workspaceCwd), webSnapshotMode())
    await page.screenshot({ path: join(shots, `${provider}-composer.png`) })
    for (const [label, id] of [['Image model', ids[1]], ['Video model', ids[2]]] as const) {
      await menu.getByRole('menuitem', { name: new RegExp(`^${label}`) }).click()
      const selected = menu.getByRole('group', { name: `Live discovery (${provider})` }).getByRole('menuitemradio', { name: id, exact: true })
      await expect.poll(() => selected.getAttribute('aria-checked')).toBe('true')
      await page.getByRole('button', { name: /^Select model/ }).focus()
      await page.keyboard.press('Escape')
    }
    await page.keyboard.press('Escape')
    await page.reload({ waitUntil: 'load' })
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await settings.getByRole('button', { name: 'Models', exact: true }).click()
    for (const [label, id] of [['Image model', ids[1]], ['Video model', ids[2]]] as const) {
      const select = settings.getByLabel(label, { exact: true })
      await expect.poll(() => select.inputValue()).toBe(JSON.stringify([provider, id]))
      expect(await select.locator('option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value)))
        .toEqual(['', JSON.stringify([provider, id])])
    }
    await settings.getByRole('button', { name: `Edit Live discovery (${provider})`, exact: true }).click()
    await settings.getByText('Customized settings', { exact: true }).click()
    expect(await catalog.getByRole('checkbox', { name: `Image ${ids[1]}`, exact: true }).isChecked()).toBe(true)
    expect(await catalog.getByRole('checkbox', { name: `Video ${ids[1]}`, exact: true }).isChecked()).toBe(false)
    expect(await catalog.getByRole('checkbox', { name: `Video ${ids[2]}`, exact: true }).isChecked()).toBe(true)
  }, 60_000)

  it('deletes a selected video model and clears only its generation choice after Apply and reload', async () => {
    onTestFailed(async () => { await page.screenshot({ path: join(shots, `${provider}-deleted-failure.png`) }) })
    const settings = page.getByRole('dialog', { name: 'Settings' })
    await settings.getByRole('button', { name: 'Delete model 3', exact: true }).click()
    expect(scaffold.ctx.settings.get(settingsNamespace('llm-pi-ai'))).toMatchObject({
      videoModel: { provider, model: ids[2] },
    })
    await settings.getByRole('region', { name: 'API keys', exact: true }).getByRole('button', { name: 'Apply', exact: true }).click()
    await settings.getByText(`Saved Live discovery (${provider}).`, { exact: true }).waitFor({ timeout: 15_000 })
    const generation = settings.getByRole('region', { name: 'Image and video generation' })
    await expect.poll(() => generation.getByLabel('Image model', { exact: true }).isEnabled()).toBe(true)
    await expect.poll(() => generation.getByLabel('Video model', { exact: true }).isEnabled()).toBe(true)
    await expect.poll(() => generation.getByLabel('Video model', { exact: true }).inputValue()).toBe('')
    await expect.poll(() => generation.getByLabel('Image model', { exact: true }).inputValue()).toBe(JSON.stringify([provider, ids[1]]))
    const saved = await readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8')
    expect(saved).not.toContain(ids[2])
    expect(saved).toContain(`model: ${ids[1]}`)
    await page.reload({ waitUntil: 'load' })
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await settings.getByRole('button', { name: 'Models', exact: true }).click()
    await expect.poll(() => generation.getByLabel('Image model', { exact: true }).isEnabled()).toBe(true)
    await expect.poll(() => generation.getByLabel('Video model', { exact: true }).isEnabled()).toBe(true)
    await expect.poll(() => generation.getByLabel('Video model', { exact: true }).inputValue()).toBe('')
    await expect.poll(() => generation.getByLabel('Image model', { exact: true }).inputValue()).toBe(JSON.stringify([provider, ids[1]]))
    expect(await generation.getByLabel('Video model', { exact: true }).locator('option').allTextContents()).toEqual(['Automatic fallback'])
    await compareOrRefreshGolden(join(REPO_ROOT, `apps/web/tests/snapshots/live-model-discovery/${provider}-deleted.expected.md`),
      await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd), webSnapshotMode())
    await page.screenshot({ path: join(shots, `${provider}-deleted.png`) })
  }, 60_000)
})

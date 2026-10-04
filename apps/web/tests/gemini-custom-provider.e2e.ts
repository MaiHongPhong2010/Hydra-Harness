/** Gemini API template through the shipped custom-provider form and native listing. */
import { createServer, type Server } from 'node:http'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { settingsNamespace } from '@hydraharness/harness-settings'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold,
  watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, REPO_ROOT } from './support.ts'

const golden = fileURLToPath(new URL('./snapshots/gemini-custom-provider/create.expected.md', import.meta.url))
const shots = join(REPO_ROOT, '.artifacts/gemini-custom-provider')
let scaffold: WebScaffold
let browser: Browser
let page: Page
let server: Server
let endpoint: string
let tripwire: ReturnType<typeof watchConsole>
const requests: { path: string; key: string | string[] | undefined }[] = []

beforeAll(async () => {
  server = createServer((request, response) => {
    requests.push({ path: request.url ?? '', key: request.headers['x-goog-api-key'] })
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify(request.url?.includes('pageToken=second') ? {
      models: [{ name: 'models/veo-3.1-generate-preview', supportedGenerationMethods: ['predictLongRunning'] }],
    } : {
      models: [
        { name: 'models/gemini-chat', displayName: 'Gemini chat', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-3.1-flash-image', supportedGenerationMethods: ['generateContent'] },
      ], nextPageToken: 'second',
    }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Gemini fixture has no TCP port')
  endpoint = `http://127.0.0.1:${address.port}/v1beta`
  scaffold = await launchWebScaffold({ deepSeekMissingCredential: true })
  browser = await chromium.launch()
  page = await newEnglishPage(browser)
  tripwire = watchConsole(page)
  await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
  await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  await page.getByRole('dialog', { name: 'Settings', exact: true }).waitFor({ timeout: 30_000 })
  await mkdir(shots, { recursive: true })
  await mkdir(dirname(golden), { recursive: true })
}, 120_000)

afterAll(async () => {
  try { await browser?.close() } finally {
    try { await scaffold?.close() } finally {
      if (server !== undefined) {
        server.closeAllConnections()
        await new Promise<void>(resolve => server.close(() => { resolve() }))
      }
    }
  }
})

it('separates Google sign-in from API-key creation, loads all model pages, and removes saved API credentials', async () => {
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true })
  await dialog.waitFor()
  await dialog.getByRole('button', { name: 'Models', exact: true }).click()
  const accounts = dialog.getByRole('region', { name: 'Account sign-in', exact: true })
  await accounts.getByRole('button', { name: 'Add sign-in provider', exact: true }).click()
  await accounts.getByLabel('Provider', { exact: true }).selectOption('google')
  expect(await accounts.getByRole('combobox').count()).toBe(1)
  expect(await accounts.getByText('Sign in with Google to use Antigravity. No Cloud project ID is needed.', { exact: true }).count()).toBe(1)
  await expect.poll(() => accounts.getByRole('button', { name: 'Add account', exact: true }).isEnabled()).toBe(true)
  await compareOrRefreshGolden(join(dirname(golden), 'google-login.expected.md'),
    await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd), webSnapshotMode())
  expect(await accounts.getByLabel(/Google Cloud project ID/).count()).toBe(0)
  await accounts.getByRole('button', { name: 'Cancel', exact: true }).click()

  const apiKeys = dialog.getByRole('region', { name: 'API keys', exact: true })
  for (const theme of ['Light', 'Dark']) {
    await dialog.getByRole('button', { name: 'General', exact: true }).click()
    await dialog.getByRole('button', { name: theme, exact: true }).click()
    await dialog.getByRole('button', { name: 'Models', exact: true }).click()
    await apiKeys.getByRole('button', { name: 'Add a custom provider', exact: true }).click()
    await apiKeys.getByLabel('Provider template', { exact: true }).selectOption('gemini-api')
    expect(await apiKeys.getByLabel('Provider ID', { exact: true }).inputValue()).toBe('gemini')
    expect(await apiKeys.getByLabel('Display name', { exact: true }).inputValue()).toBe('Gemini API')
    expect(await apiKeys.getByLabel('Base URL', { exact: true }).inputValue()).toBe('https://generativelanguage.googleapis.com/v1beta')
    expect(await apiKeys.getByLabel('API protocol', { exact: true }).inputValue()).toBe('google-generative-ai')
    expect(await apiKeys.getByRole('button', { name: 'Add account', exact: true }).count()).toBe(0)
    await apiKeys.getByLabel('Base URL', { exact: true }).fill(endpoint)
    await apiKeys.getByLabel('API key', { exact: true }).fill('fixture-gemini-key')
    await apiKeys.getByRole('button', { name: 'Get all', exact: true }).click()
    await apiKeys.getByLabel('Model ID 3', { exact: true }).waitFor()
    expect(await apiKeys.getByLabel('Model ID 3', { exact: true }).inputValue()).toBe('veo-3.1-generate-preview')
    for (const width of [1680, 560]) {
      await page.setViewportSize({ width, height: 1000 })
      await apiKeys.getByLabel('Provider template', { exact: true }).scrollIntoViewIfNeeded()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      expect(await apiKeys.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
      await page.screenshot({ path: join(shots, `${theme.toLowerCase()}-${width}.png`) })
    }
    await page.setViewportSize({ width: 1680, height: 1000 })
  }
  expect(requests.filter(request => request.path.includes('pageToken=second'))).toHaveLength(2)
  expect(requests.every(request => request.key === 'fixture-gemini-key')).toBe(true)
  const snapshot = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)
  await compareOrRefreshGolden(golden, snapshot.replaceAll(endpoint, '<gemini-fixture>'), webSnapshotMode())
  await apiKeys.getByRole('button', { name: 'Create provider', exact: true }).click()
  await apiKeys.getByRole('button', { name: 'Edit Gemini API (gemini)', exact: true }).waitFor()
  const saved = scaffold.ctx.settings.get(settingsNamespace('llm-pi-ai')) as {
    providers: Record<string, { api: string; apiKeyEnv: string; models: { id: string; endpoints?: string[] }[] }>
  }
  expect(saved.providers['gemini']).toMatchObject({ api: 'google-generative-ai', apiKeyEnv: 'GEMINI_API_KEY', models: [
    { id: 'gemini-chat' }, { id: 'gemini-3.1-flash-image', endpoints: ['images/generations'] },
    { id: 'veo-3.1-generate-preview', endpoints: ['videos'] },
  ] })
  const credentialsPath = join(scaffold.harnessHome, '.credentials.yaml')
  expect(await readFile(credentialsPath, 'utf8')).toContain('fixture-gemini-key')
  expect(await readFile(credentialsPath, 'utf8')).toContain('GEMINI_API_KEY')
  expect(await readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8')).not.toContain('fixture-gemini-key')
  const google = scaffold.ctx.settings.get(settingsNamespace('llm-account-auth')) as { providers?: Record<string, unknown> }
  expect(google.providers?.['gemini-api']).toBeUndefined()
  expect(google.providers?.['antigravity']).toBeUndefined()
  await apiKeys.getByRole('button', { name: 'Edit Gemini API (gemini)', exact: true }).click()
  await apiKeys.getByText('Customized settings', { exact: true }).click()
  expect(await apiKeys.getByLabel('API protocol', { exact: true }).inputValue()).toBe('google-generative-ai')
  expect(await apiKeys.getByLabel('Base URL', { exact: true }).inputValue()).toBe(endpoint)
  await apiKeys.getByRole('button', { name: 'Cancel', exact: true }).click()
  await apiKeys.getByRole('button', { name: 'Delete Gemini API (gemini)', exact: true }).click()
  await page.getByRole('dialog', { name: 'Delete Gemini API (gemini)?', exact: true })
    .getByRole('button', { name: 'Delete Gemini API (gemini)', exact: true }).click()
  await expect.poll(() => readFile(credentialsPath, 'utf8')).not.toContain('fixture-gemini-key')
  expect(await readFile(credentialsPath, 'utf8')).not.toContain('GEMINI_API_KEY')
  await expect.poll(() => apiKeys.getByRole('button', { name: 'Edit Gemini API (gemini)', exact: true }).count()).toBe(0)
  expect(tripwire.pageErrors).toEqual([])
  expect(tripwire.warnings).toEqual([])
}, 90_000)

/** Shared Google account, independent catalogs, and Gemini OAuth requests in the shipped Web app. */
import { createServer, type Server } from 'node:http'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { settingsNamespace } from '@hydraharness/harness-settings'
import { MessageId } from '@hydraharness/harness-llm'
import { accountRecordKey, createAccountPool } from '../../../packages/llm/llm-account-auth/src/accounts.ts'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, REPO_ROOT } from './support.ts'

const golden = fileURLToPath(new URL('./snapshots/google-accounts/shared.expected.md', import.meta.url))
const shots = join(REPO_ROOT, '.artifacts/google-accounts')
let scaffold: WebScaffold
let browser: Browser
let page: Page
let server: Server
let endpoint: string
let tripwire: ReturnType<typeof watchConsole>
let geminiDiscoveryFailure = false
const requests: { path: string; authorization: string | undefined; project: string | undefined; body: string }[] = []
const realFetch = globalThis.fetch

beforeAll(async () => {
  server = createServer((request, response) => { void (async () => {
    let body = ''
    for await (const chunk of request) body += String(chunk)
    requests.push({ path: request.url ?? '', authorization: request.headers.authorization,
      project: typeof request.headers['x-goog-user-project'] === 'string' ? request.headers['x-goog-user-project'] : undefined, body })
    if (request.url?.includes('/token')) {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ access_token: 'login-access', refresh_token: 'login-refresh', expires_in: 3600 }))
    } else if (request.url?.includes('/userinfo')) {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ email: 'login@example.test' }))
    } else if (request.url?.includes(':retrieveUserQuota')) {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ buckets: [{ modelId: 'gemini-fixture', remainingFraction: 0.8 }] }))
    } else if (request.url?.includes(':loadCodeAssist')) {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ cloudaicompanionProject: 'code-assist-project', currentTier: { name: 'Fixture tier' } }))
    } else if (request.url?.includes(':fetchAvailableModels')) {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ models: {
        'gemini-fixture': { displayName: 'Antigravity fixture' },
        'gemini-3.1-flash-image': { displayName: 'Antigravity image' },
        'antigravity-only': { displayName: 'Antigravity only' },
      } }))
    } else if (request.url?.includes('/openai/chat/completions')) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.end('data: {"id":"fixture","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Shared Google grant works."},"finish_reason":null}]}\n\ndata: {"id":"fixture","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
    } else if (request.url?.includes(':generateContent')) {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'fixture-image' } }] } }] }))
    } else if (request.url?.includes(':streamGenerateContent')) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.end('data: {"candidates":[{"content":{"parts":[{"text":"Antigravity uses the shared grant."}]},"finishReason":"STOP"}]}\n\n')
    } else if (geminiDiscoveryFailure && request.url?.includes('/models')) {
      response.writeHead(403, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'Gemini fixture denied' } }))
    } else {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ models: [
        { name: 'models/gemini-fixture', displayName: 'Gemini fixture', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-3.1-flash-image', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-api-only', supportedGenerationMethods: ['generateContent'] },
      ] }))
    }
  })().catch(() => { response.writeHead(500).end() }) })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture listener failed')
  endpoint = `http://127.0.0.1:${address.port}/v1beta`
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    if (url.hostname.endsWith('googleapis.com')) return realFetch(`${endpoint}${url.pathname}${url.search}`, init)
    return realFetch(input, init)
  })
  scaffold = await launchWebScaffold({ deepSeekMissingCredential: true })
  await createAccountPool({ ctx: scaffold.ctx, key: accountRecordKey('antigravity'), providerId: 'antigravity',
    providerAliases: ['gemini-api'], providerLabel: 'Google' })
    .add('google@example.test · fixture-project', { type: 'oauth', access: 'shared-google-access', refresh: 'shared-google-refresh',
      expires: Date.now() + 3600_000, accountId: 'shared-google', projectId: 'code-assist-project', quotaProjectId: 'fixture-project' })
  browser = await chromium.launch()
  page = await newEnglishPage(browser)
  tripwire = watchConsole(page)
  await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
  await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  await page.getByRole('dialog', { name: 'Settings' }).waitFor({ timeout: 30_000 })
  await mkdir(shots, { recursive: true })
  await mkdir(dirname(golden), { recursive: true })
}, 120_000)

afterAll(async () => {
  vi.unstubAllGlobals()
  try { await browser?.close() } finally {
    try { await scaffold?.close() } finally {
      if (server !== undefined) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => { resolve() })) }
    }
  }
})

it.each(['antigravity', 'gemini-api'])('opens %s OAuth first and requests a quota project only for the API service', async (provider) => {
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await dialog.waitFor()
  await dialog.getByRole('button', { name: 'Models', exact: true }).click()
  const section = dialog
  if (provider === 'gemini-api') {
    await scaffold.ctx.settings.mutate(settingsNamespace('llm-account-auth'), [
      { op: 'set', path: ['providers', provider], value: {} },
    ])
    await dialog.getByRole('region', { name: 'API keys', exact: true })
      .getByRole('button', { name: 'Edit Google Gemini API OAuth (gemini-api)', exact: true }).click()
  } else {
    await section.getByRole('button', { name: 'Add sign-in provider', exact: true }).click()
    await section.getByLabel('Provider', { exact: true }).selectOption('google')
  }
  await expect.poll(() => section.getByRole('button', { name: 'Add account', exact: true }).isEnabled()).toBe(true)
  if (provider === 'gemini-api') await section.getByText('Usage unavailable from provider', { exact: true }).waitFor()
  await compareOrRefreshGolden(join(dirname(golden), `${provider}-login.expected.md`),
    await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd), webSnapshotMode())
  const requestCount = requests.length
  await section.getByRole('button', { name: 'Add account', exact: true }).click()
  const link = section.getByRole('link', { name: 'Open sign-in page', exact: true })
  await link.waitFor()
  const auth = new URL((await link.getAttribute('href'))!)
  expect(auth.hostname).toBe('accounts.google.com')
  await link.scrollIntoViewIfNeeded()
  expect(await section.getByLabel(/Google Cloud project ID/).count()).toBe(0)
  expect(await section.getByRole('list', { name: 'Accounts', exact: true }).count()).toBe(0)
  await page.screenshot({ path: join(shots, `${provider}-login-light.png`) })
  const callback = new URL(auth.searchParams.get('redirect_uri')!)
  callback.searchParams.set('state', auth.searchParams.get('state')!)
  callback.searchParams.set('code', 'login-code')
  await section.getByLabel('Paste the complete Antigravity OAuth callback URL after signing in.', { exact: true }).fill(callback.href)
  await section.getByRole('button', { name: 'Continue', exact: true }).click()
  if (provider === 'gemini-api') {
    await section.getByLabel(/Google Cloud project ID/).fill('fixture-project')
    await section.getByRole('button', { name: 'Continue', exact: true }).click()
  }
  await section.getByText('Account connected. Apply to save provider settings.', { exact: true }).waitFor()
  expect(requests.slice(requestCount).some(request => request.path.includes('/models'))).toBe(provider === 'gemini-api')
  await section.getByRole('button', { name: 'Cancel', exact: true }).click()
  await scaffold.ctx.authorization.removeAccount(accountRecordKey('antigravity'),
    (provider === 'gemini-api' ? 'login@example.test:fixture-project' : 'login@example.test') as never)
  expect(tripwire.pageErrors).toEqual([])
}, 60_000)

it('configures Google services explicitly, shares account removal, and sends both protocols with distinct projects', async () => {
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  if (!await dialog.isVisible()) await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await dialog.getByRole('button', { name: 'Models', exact: true }).click()
  const section = dialog
  await section.getByRole('button', { name: 'Add sign-in provider', exact: true }).click()
  const selection = section.getByLabel('Provider', { exact: true })
  await selection.selectOption('google')
  expect((await selection.locator('option').allTextContents()).filter(name => name === 'Google')).toHaveLength(1)
  expect(await section.getByRole('list', { name: 'Accounts', exact: true }).count()).toBe(0)
  expect(await section.getByText('google@example.test · fixture-project', { exact: true }).count()).toBe(0)
  expect(await section.getByRole('region', { name: 'Account sign-in', exact: true }).getByRole('combobox').count()).toBe(1)
  expect(await section.getByText('google@example.test · fixture-project', { exact: true }).count()).toBe(0)
  await section.getByRole('button', { name: 'Apply', exact: true }).click()
  await section.getByRole('button', { name: 'Edit Google Antigravity (antigravity)', exact: true }).waitFor()
  const ns = settingsNamespace('llm-account-auth')
  await scaffold.ctx.settings.mutate(ns, [
    { op: 'set', path: ['providers', 'gemini-api'], value: { endpoint, models: [{ id: 'gemini-fixture' }, { id: 'gemini-3.1-flash-image' }] } },
    { op: 'set', path: ['providers', 'antigravity'], value: { endpoint, models: [{ id: 'gemini-fixture' }] } },
  ])
  await expect.poll(() => scaffold.ctx.llm.listProviders().map(provider => provider.id)).toEqual(expect.arrayContaining(['antigravity', 'gemini-api']))
  const flows = scaffold.ctx.authorization.list()
  expect(flows.filter(flow => flow.label === 'Google' && flow.key.startsWith('llm-account-auth/'))).toHaveLength(1)
  const messages = [{ id: MessageId('input'), role: 'user' as const, source: { kind: 'user' as const }, content: [{ type: 'text' as const, text: 'Hello' }] }]
  for (const provider of ['antigravity', 'gemini-api']) {
    const chunks = []
    for await (const chunk of scaffold.ctx.llm.stream({ provider, model: 'gemini-fixture', messages })) chunks.push(chunk)
    expect(chunks.some(chunk => chunk.type === 'text-delta')).toBe(true)
    expect(chunks.some(chunk => chunk.type === 'finish')).toBe(true)
  }
  const native = requests.find(request => request.path.includes(':streamGenerateContent'))
  expect(native?.authorization).toBe('Bearer shared-google-access')
  expect(JSON.parse(native!.body)).toMatchObject({ project: 'code-assist-project' })
  const api = requests.find(request => request.path.includes('/openai/chat/completions'))
  expect(api?.authorization).toBe('Bearer shared-google-access')
  expect(api?.project).toBe('fixture-project')
  await section.getByRole('button', { name: 'Edit Google Gemini API OAuth (gemini-api)', exact: true }).click()
  await section.getByText('google@example.test · fixture-project', { exact: true }).waitFor()
  await section.locator('details > summary').click()
  expect(await section.getByRole('checkbox', { name: 'Image gemini-3.1-flash-image', exact: true }).isChecked()).toBe(true)
  geminiDiscoveryFailure = true
  await section.getByRole('button', { name: 'Fetch', exact: true }).click()
  const picker = page.getByRole('dialog', { name: 'Choose models to add' })
  await picker.waitFor()
  expect(await picker.getByRole('alert').innerText()).toContain('Gemini API:')
  expect(await picker.getByRole('rowgroup', { name: 'Antigravity' }).isVisible()).toBe(true)
  await picker.getByRole('button', { name: 'Cancel', exact: true }).click()
  geminiDiscoveryFailure = false
  await section.getByRole('button', { name: 'Fetch', exact: true }).click()
  await picker.waitFor()
  const apiModels = picker.getByRole('rowgroup', { name: 'Gemini API' })
  const agModels = picker.getByRole('rowgroup', { name: 'Antigravity' })
  expect(await apiModels.getByRole('textbox', { name: 'Model name gemini-3.1-flash-image', exact: true }).inputValue()).toBe('')
  await agModels.getByRole('textbox', { name: 'Model name gemini-3.1-flash-image', exact: true }).fill('Shared AG image')
  await compareOrRefreshGolden(join(dirname(golden), 'fetch.expected.md'),
    await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd), webSnapshotMode())
  await page.screenshot({ path: join(shots, 'shared-google-fetch-light.png') })
  await picker.getByRole('button', { name: 'Add selected', exact: true }).click()
  const acknowledged = page.waitForResponse(response => response.url().endsWith('/api/settings.mutate')
    && response.request().postData()?.includes('Shared AG image') === true)
  await section.getByRole('button', { name: 'Apply', exact: true }).click()
  expect((await (await acknowledged).json() as { result: { ok: boolean } }).result.ok).toBe(true)
  await section.getByRole('button', { name: 'Edit Google Gemini API OAuth (gemini-api)', exact: true }).waitFor()
  const saved = scaffold.ctx.settings.describe().find(section => section.ns === ns)?.value as {
    providers: Record<string, { endpoint: string; models: { id: string; name?: string }[] }>
  }
  expect(saved.providers['antigravity']?.models).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'gemini-fixture' }),
    expect.objectContaining({ id: 'gemini-3.1-flash-image', name: 'Shared AG image', endpoints: ['images/generations'] }),
    expect.objectContaining({ id: 'antigravity-only', name: 'Antigravity only' }),
  ]))
  expect(saved.providers['gemini-api']?.models.map(model => model.id)).toEqual([
    'gemini-fixture', 'gemini-3.1-flash-image', 'gemini-api-only',
  ])
  expect(saved.providers['antigravity']?.endpoint).toBe(endpoint)
  expect(saved.providers['gemini-api']?.endpoint).toBe(endpoint)
  const discovery = requests.find(request => request.path.includes(':fetchAvailableModels'))
  expect(discovery?.authorization).toBe('Bearer shared-google-access')
  expect(JSON.parse(discovery!.body)).toEqual({ project: 'code-assist-project' })
  await page.reload({ waitUntil: 'load' })
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await dialog.getByRole('button', { name: 'Models', exact: true }).click()
  await section.getByRole('button', { name: 'Edit Google Gemini API OAuth (gemini-api)', exact: true }).click()
  await section.locator('details > summary').click()
  expect(await section.getByRole('region', { name: 'Antigravity', exact: true })
    .getByRole('textbox', { name: 'Display name 3', exact: true }).inputValue()).toBe('Shared AG image')
  expect(await section.getByRole('region', { name: 'Gemini API', exact: true })
    .getByRole('textbox', { name: 'Model ID 3', exact: true }).inputValue()).toBe('gemini-api-only')
  await compareOrRefreshGolden(golden, await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd), webSnapshotMode())
  await page.screenshot({ path: join(shots, 'shared-google-light.png') })
  await dialog.getByRole('button', { name: 'General', exact: true }).click()
  await dialog.getByRole('button', { name: 'Dark', exact: true }).click()
  await expect.poll(() => page.locator('body').getAttribute('data-ds-dark-theme')).toBe('')
  await dialog.getByRole('button', { name: 'Models', exact: true }).click()
  await section.getByRole('button', { name: 'Edit Google Gemini API OAuth (gemini-api)', exact: true }).click()
  await section.getByText('google@example.test · fixture-project', { exact: true }).waitFor()
  await section.locator('details > summary').click()
  await section.getByRole('button', { name: 'Fetch', exact: true }).click()
  await picker.waitFor()
  await page.screenshot({ path: join(shots, 'shared-google-fetch-dark.png') })
  await page.setViewportSize({ width: 560, height: 1000 })
  await page.screenshot({ path: join(shots, 'shared-google-fetch-narrow.png') })
  expect(await picker.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  await picker.getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.setViewportSize({ width: 1680, height: 1000 })
  await page.screenshot({ path: join(shots, 'shared-google-dark.png') })
  await page.setViewportSize({ width: 560, height: 1000 })
  await section.getByText('google@example.test · fixture-project', { exact: true }).scrollIntoViewIfNeeded()
  expect(await section.getByRole('button', { name: 'Sign out google@example.test · fixture-project', exact: true })
    .evaluate(button => button.getBoundingClientRect().height)).toBeLessThanOrEqual(40)
  await page.screenshot({ path: join(shots, 'shared-google-narrow.png') })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.setViewportSize({ width: 1680, height: 1000 })
  await section.getByRole('button', { name: 'Sign out google@example.test · fixture-project', exact: true }).click()
  await section.getByText('No accounts connected.', { exact: true }).waitFor()
  await section.getByRole('button', { name: 'Cancel', exact: true }).click()
  await section.getByRole('button', { name: 'Edit Google Antigravity (antigravity)', exact: true }).click()
  await section.getByText('No accounts connected.', { exact: true }).waitFor()
  expect(tripwire.warnings).toEqual([])
  expect(tripwire.pageErrors).toEqual([])
}, 90_000)

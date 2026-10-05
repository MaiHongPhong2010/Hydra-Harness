// Assembled web coverage for account-backed ChatGPT and Google Antigravity
// providers. The provider transport is a deterministic test adapter, while
// authorization still crosses the real Host RPC and credentials services.
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { mkdir, readFile } from 'node:fs/promises'
import type { Browser, Locator, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { credentialKey } from '@hydraharness/harness-credentials'
import { settingsNamespace } from '@hydraharness/harness-settings'
import {
  ACCOUNT_AUTH_PROVIDERS,
  ACCOUNT_AUTH_NAMESPACE,
} from './account-auth-fixture.ts'
import {
  assertFixtureInventory,
  captureStableAria,
  compareOrRefreshGolden,
  launchWebScaffold,
  watchConsole,
  webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, REPO_ROOT, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/auth-accounts', import.meta.url))
const CONNECTED_EXPECTED = join(SNAPSHOT_DIR, 'connected.expected.md')
const GOOGLE_EXPECTED = join(SNAPSHOT_DIR, 'google.expected.md')
const ADD_EXPECTED = join(SNAPSHOT_DIR, 'add.expected.md')
const DELETE_EXPECTED = join(SNAPSHOT_DIR, 'delete.expected.md')
const DELETE_CHATGPT_EXPECTED = join(SNAPSHOT_DIR, 'delete-chatgpt.expected.md')
const RECONNECTED_EXPECTED = join(SNAPSHOT_DIR, 'reconnected.expected.md')
const SHOTS = join(REPO_ROOT, '.artifacts/provider-account-management')
const ACCOUNT_AUTH_OVERLAY = fileURLToPath(new URL('./auth-accounts.overlay.yml', import.meta.url))
const ACCOUNT_AUTH_FIXTURE = new URL('./account-auth-fixture.ts', import.meta.url).href
const MODE = webSnapshotMode()

async function openModels(page: Page): Promise<Locator> {
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  if (!await dialog.isVisible()) await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await dialog.waitFor({ timeout: 10_000 })
  await dialog.getByRole('button', { name: 'Models', exact: true }).click()
  await dialog.getByText('Sign in with your accounts or enter API keys to use models from these providers.', { exact: true })
    .waitFor({ timeout: 10_000 })
  return dialog
}

async function openEditor(dialog: Locator, buttonName: string): Promise<void> {
  await dialog.getByRole('button', { name: buttonName, exact: true }).click()
  await dialog.getByText('Accounts', { exact: true }).waitFor({ timeout: 10_000 })
}

async function openAddEditor(dialog: Locator, provider: string): Promise<void> {
  const section = dialog.getByRole('region', { name: 'Account sign-in', exact: true })
  await section.getByRole('button', { name: 'Add sign-in provider', exact: true }).click()
  await dialog.getByLabel('Provider', { exact: true }).selectOption(provider === 'antigravity' ? 'google' : provider)
  await expect.poll(() => section.getByRole('button', { name: 'Add account', exact: true }).isEnabled(), { timeout: 10_000 }).toBe(true)
  expect(await section.getByRole('list', { name: 'Accounts', exact: true }).count()).toBe(0)
  expect(await section.getByText('Accounts', { exact: true }).count()).toBe(0)
  expect(await section.getByRole('textbox', { name: 'API key', exact: true }).count()).toBe(0)
  expect(await section.getByLabel('Provider', { exact: true }).locator('option').allTextContents())
    .not.toContain('minimax-cn')
}

async function addAccount(dialog: Locator, providerName: string, label: string, mode: 'add' | 'manage'): Promise<void> {
  await dialog.getByRole('button', { name: 'Add account', exact: true }).click()
  expect(await dialog.getByRole('textbox', { name: `${providerName} account label`, exact: true }).count()).toBe(0)
  const link = dialog.getByRole('link', { name: 'Open sign-in page', exact: true })
  expect(await link.getAttribute('href')).toBe(
    `https://auth.example.test/${providerName === 'ChatGPT' ? 'chatgpt' : 'antigravity'}`,
  )
  await dialog.getByText('Account connected. Apply to save provider settings.', { exact: true })
    .waitFor({ timeout: 10_000 })
  await expect.poll(() => dialog.getByText(label, { exact: true }).count(), { timeout: 10_000 }).toBe(mode === 'manage' ? 1 : 0)
}

async function expectUsage(dialog: Locator, label: string, values: readonly string[]): Promise<void> {
  const expand = dialog.getByRole('button', { name: `Show usage for ${label}`, exact: true })
  if (await expand.count() > 0) await expand.click()
  const row = dialog.getByRole('listitem').filter({ hasText: label })
  for (const value of values) {
    await expect.poll(() => row.getByText(value, { exact: true }).count(), { timeout: 10_000 }).toBeGreaterThan(0)
  }
}

async function applyEditor(dialog: Locator, buttonName: string): Promise<void> {
  await dialog.getByRole('button', { name: 'Apply', exact: true }).click()
  await dialog.getByRole('button', { name: 'Apply', exact: true }).waitFor({ state: 'detached', timeout: 10_000 })
  await dialog.getByRole('button', { name: buttonName, exact: true }).waitFor({ timeout: 10_000 })
}

describe('web e2e: account-backed ChatGPT and Antigravity login', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({
      extraOverlayPath: ACCOUNT_AUTH_OVERLAY,
      extraPatches: [{ insert: [{ id: 'llm-account-auth-fixture', name: ACCOUNT_AUTH_FIXTURE }] }],
    })
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: 'en-US' })
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await mkdir(SHOTS, { recursive: true })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('keeps API keys independent while adding, removing, and restoring multiple accounts', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-auth-accounts'))
    const dialog = await openModels(page)

    const apiKeys = dialog.getByRole('region', { name: 'API keys', exact: true })
    await apiKeys.getByRole('button', { name: 'Add provider', exact: true }).click()
    const apiProvider = apiKeys.getByLabel('Provider', { exact: true })
    const options = await apiProvider.locator('option').allTextContents()
    expect(options).not.toContain('ChatGPT')
    expect(options).not.toContain('Google Antigravity')
    await apiProvider.selectOption('minimax-cn')
    await apiKeys.getByRole('textbox', { name: 'API key', exact: true }).fill('sk-e2e-independent-primary')
    await apiKeys.getByRole('button', { name: 'Add API key', exact: true }).click()
    await apiKeys.getByLabel('Fallback API key 1', { exact: true }).fill('sk-e2e-independent-fallback')
    await applyEditor(dialog, 'Edit minimax-cn')
    await apiKeys.getByRole('img', { name: 'API key configured', exact: true }).waitFor({ timeout: 10_000 })

    await openAddEditor(dialog, 'chatgpt')
    expect(await dialog.getByText('No accounts connected.', { exact: true }).count()).toBe(0)
    await addAccount(dialog, 'ChatGPT', 'alice@example.test', 'add')
    await applyEditor(dialog, 'Edit ChatGPT (chatgpt)')
    await openEditor(dialog, 'Edit ChatGPT (chatgpt)')
    await expectUsage(dialog, 'alice@example.test', [
      'Codex Plus', '5h', '75% left', 'Weekly', '45% left', 'Banked resets: 2',
    ])
    await addAccount(dialog, 'ChatGPT', 'bob@example.test', 'manage')
    await expectUsage(dialog, 'bob@example.test', [
      'Codex Pro', '5h', '25% left', 'Weekly', '88% left', 'Banked resets: 0',
    ])
    // This capture proves the UI holds both identities before either one is removed.
    await compareOrRefreshGolden(
      CONNECTED_EXPECTED,
      await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd),
      MODE,
    )
    await dialog.getByRole('button', { name: 'Sign out alice@example.test', exact: true }).click()
    await expect.poll(() => dialog.getByText('alice@example.test', { exact: true }).count(), { timeout: 10_000 }).toBe(0)
    await expect.poll(() => dialog.getByText('bob@example.test', { exact: true }).count(), { timeout: 10_000 }).toBe(1)
    await applyEditor(dialog, 'Edit ChatGPT (chatgpt)')

    await openAddEditor(dialog, 'antigravity')
    await addAccount(dialog, 'Google Antigravity', 'google@example.test', 'add')
    await applyEditor(dialog, 'Edit Google Antigravity (antigravity)')
    await openEditor(dialog, 'Edit Google Antigravity (antigravity)')
    await expectUsage(dialog, 'google@example.test', [
      'Google AI Pro', 'Gemini models', 'Claude and GPT models', 'Weekly', '5h',
      '82% left', '68% left', '60% left', '88% left', 'GOOGLE_ONE_AI: 1,200 credits',
    ])
    await compareOrRefreshGolden(
      GOOGLE_EXPECTED,
      await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd),
      MODE,
    )
    for (const theme of ['Light', 'Dark']) {
      await dialog.getByRole('button', { name: 'General', exact: true }).click()
      await dialog.getByRole('button', { name: theme, exact: true }).click()
      await dialog.getByRole('button', { name: 'Models', exact: true }).click()
      await openEditor(dialog, 'Edit Google Antigravity (antigravity)')
      await expectUsage(dialog, 'google@example.test', ['82% left'])
      await dialog.getByText('Customized settings', { exact: true }).click()
      const report = dialog.locator('[class*="usageReport"]')
      for (const width of [1680, 560]) {
        await page.setViewportSize({ width, height: 1000 })
        await report.scrollIntoViewIfNeeded()
        const bounds = await report.boundingBox()
        expect(bounds?.height).toBeLessThanOrEqual(width === 1680 ? 150 : 240)
        expect(await report.getByRole('progressbar').count()).toBe(4)
        const ring = await report.getByRole('progressbar').first().locator('svg').boundingBox()
        expect(ring?.width).toBe(36)
        expect(ring?.height).toBe(36)
        expect(await report.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
        if (width === 1680) {
          const fetch = await dialog.getByRole('button', { name: 'Fetch', exact: true }).boundingBox()
          expect(fetch).not.toBeNull()
          expect(fetch!.y + fetch!.height).toBeLessThanOrEqual(1000)
        }
        await page.screenshot({ path: join(SHOTS, `usage-${theme.toLowerCase()}-${width}.png`) })
      }
      await page.setViewportSize({ width: 1680, height: 1000 })
      const weekly = report.getByRole('progressbar', { name: 'Weekly usage limit', exact: true }).first()
      await weekly.focus()
      await page.keyboard.press('Tab')
      await page.keyboard.press('Shift+Tab')
      await page.getByRole('tooltip').filter({ hasText: '820 remaining' }).waitFor()
      expect(await page.getByRole('tooltip').textContent()).toContain('Resets ')
      expect(await weekly.evaluate(element => getComputedStyle(element).outlineStyle)).toBe('solid')
      await dialog.getByRole('button', { name: 'Fetch', exact: true }).focus()
      expect(await page.getByRole('tooltip').filter({ hasText: '820 remaining' }).count()).toBe(0)
    }
    await dialog.getByRole('button', { name: 'General', exact: true }).click()
    await dialog.getByRole('button', { name: 'Light', exact: true }).click()
    await dialog.getByRole('button', { name: 'Models', exact: true }).click()
    await openEditor(dialog, 'Edit Google Antigravity (antigravity)')
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()

    // The entry point stays usable after both provider profiles exist so the
    // editor can add another account to either provider.
    await openAddEditor(dialog, 'chatgpt')
    expect(await dialog.getByText('bob@example.test', { exact: true }).count()).toBe(0)
    await compareOrRefreshGolden(ADD_EXPECTED,
      await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd), MODE)
    await dialog.getByRole('button', { name: 'Apply', exact: true }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(SHOTS, 'add-light.png') })
    await page.setViewportSize({ width: 560, height: 1000 })
    await dialog.getByRole('button', { name: 'Apply', exact: true }).scrollIntoViewIfNeeded()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    expect(await dialog.getByRole('region', { name: 'Account sign-in', exact: true })
      .evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    await page.screenshot({ path: join(SHOTS, 'add-narrow.png') })
    await page.setViewportSize({ width: 1680, height: 1000 })
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()

    const chatgptRecord = await scaffold.ctx.credentials.readRecord(credentialKey('llm-account-auth', 'chatgpt'))
    expect(chatgptRecord).toMatchObject({
      kind: 'grant',
      payload: { accounts: [{ id: 'chatgpt-2', label: 'bob@example.test' }] },
    })
    const antigravityRecord = await scaffold.ctx.credentials.readRecord(credentialKey('llm-account-auth', 'antigravity'))
    expect(antigravityRecord).toMatchObject({
      kind: 'grant',
      payload: { accounts: [{ id: 'antigravity-1', label: 'google@example.test' }] },
    })

    // A browser reload must recover the account inventory from the persisted
    // records rather than from the React editor that just closed.
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    const reopened = await openModels(page)
    const restoredApiKeys = reopened.getByRole('region', { name: 'API keys', exact: true })
    await restoredApiKeys.getByRole('button', { name: 'Edit minimax-cn', exact: true }).click()
    await restoredApiKeys.getByLabel('Fallback API key 1', { exact: true }).waitFor({ timeout: 10_000 })
    expect(await restoredApiKeys.getByRole('textbox', { name: 'API key', exact: true }).inputValue()).toBe('')
    expect(await restoredApiKeys.getByLabel('Fallback API key 1', { exact: true }).inputValue()).toBe('')
    const storedKeys = await readFile(join(scaffold.harnessHome, '.credentials.yaml'), 'utf8')
    expect(storedKeys).toContain('sk-e2e-independent-primary')
    expect(storedKeys).toContain('sk-e2e-independent-fallback')
    await restoredApiKeys.getByRole('button', { name: 'Cancel', exact: true }).click()
    await openEditor(reopened, 'Edit ChatGPT (chatgpt)')
    await expect.poll(() => reopened.getByText('bob@example.test', { exact: true }).count(), { timeout: 10_000 }).toBe(1)
    await reopened.getByRole('button', { name: 'Cancel', exact: true }).click()
    await openEditor(reopened, 'Edit Google Antigravity (antigravity)')
    await expect.poll(() => reopened.getByText('google@example.test', { exact: true }).count(), { timeout: 10_000 }).toBe(1)
    await reopened.getByRole('button', { name: 'Cancel', exact: true }).click()
    await page.keyboard.press('Escape')

    await connectFreshWorkspace(page, scaffold.workspaceCwd, 'auth-accounts-e2e')
    const trigger = page.getByRole('button', { name: /^Select model/ })
    await trigger.waitFor({ timeout: 15_000 })
    await trigger.click()
    await page.getByRole('menuitem', { name: /Model/ }).click()
    const chatgptModel = page.getByRole('menuitemradio', { name: 'GPT-5 Test', exact: true })
    const antigravityModel = page.getByRole('menuitemradio', { name: 'Gemini 2.5 Test', exact: true })
    await chatgptModel.waitFor({ timeout: 10_000 })
    await antigravityModel.waitFor({ timeout: 10_000 })
    expect(await chatgptModel.isVisible()).toBe(true)
    expect(await antigravityModel.isVisible()).toBe(true)
    await page.getByRole('menuitemradio', { name: 'Gemini 2.5 Test', exact: true }).click()
    await expect.poll(() => trigger.getAttribute('aria-label'), { timeout: 10_000 })
      .toBe('Select model, current Gemini 2.5 Test')
    expect(tripwire.warnings).toEqual([])
    expect(tripwire.pageErrors).toEqual([])

    expect(ACCOUNT_AUTH_PROVIDERS.map(provider => provider.provider)).toEqual(['chatgpt', 'antigravity'])
  }, 90_000)

  it('deletes Antigravity configuration and shared credentials, then loads fresh account information after login', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-provider-delete'))
    await scaffold.ctx.settings.mutate(settingsNamespace(ACCOUNT_AUTH_NAMESPACE), [
      { op: 'set', path: ['providers', 'gemini-api'], value: {} },
    ])
    // Host-side fixture setup must be in the editor's initial settings revision.
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    const dialog = await openModels(page)
    const section = dialog.getByRole('region', { name: 'Account sign-in', exact: true })
    await openEditor(dialog, 'Edit Google Antigravity (antigravity)')
    await section.getByText('Customized settings', { exact: true }).click()
    const catalog = section.getByRole('region', { name: 'Antigravity', exact: true })
    await catalog.getByRole('button', { name: 'Add model', exact: true }).click()
    await catalog.getByRole('textbox', { name: /^Model ID \d+$/ }).last().fill('stale-antigravity-model')
    const saved = page.waitForResponse(response => response.url().endsWith('/api/settings.mutate')
      && response.request().postData()?.includes('stale-antigravity-model') === true)
    await applyEditor(dialog, 'Edit Google Antigravity (antigravity)')
    expect((await (await saved).json() as { result: { ok: boolean } }).result.ok).toBe(true)
    const siblingBefore = scaffold.ctx.settings.describe().find(value => value.ns === ACCOUNT_AUTH_NAMESPACE)?.value as {
      providers: Record<string, unknown>
    }
    const geminiProfile = siblingBefore.providers['gemini-api']
    const chatgptBefore = await scaffold.ctx.credentials.readRecord(credentialKey('llm-account-auth', 'chatgpt'))
    expect(geminiProfile).toBeDefined()
    expect(await readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8')).toContain('stale-antigravity-model')
    // Delete while Edit is open also disposes that account view and its drafts.
    await openEditor(dialog, 'Edit Google Antigravity (antigravity)')
    await section.getByRole('button', { name: 'Delete Google Antigravity (antigravity)', exact: true }).click()
    const confirmation = page.getByRole('dialog', { name: 'Delete Google Antigravity (antigravity)?', exact: true })
    await confirmation.waitFor()
    expect(await confirmation.innerText()).toContain('removes its configuration')
    expect(await confirmation.innerText()).toContain('shared Google sign-in details for Antigravity and Gemini API')
    expect(await confirmation.innerText()).toContain('Browser sign-ins are kept.')
    expect(await section.getByRole('list', { name: 'Accounts', exact: true }).count()).toBe(0)
    await compareOrRefreshGolden(DELETE_EXPECTED,
      await captureStableAria(page, '[role="dialog"][aria-label="Delete Google Antigravity (antigravity)?"]', scaffold.workspaceCwd), MODE)
    await page.screenshot({ path: join(SHOTS, 'delete-google.png') })
    await confirmation.getByRole('button', { name: 'Delete Google Antigravity (antigravity)', exact: true }).click()
    await expect.poll(() => section.getByRole('button', { name: 'Edit Google Antigravity (antigravity)', exact: true }).count())
      .toBe(0)
    expect(await scaffold.ctx.credentials.readRecord(credentialKey('llm-account-auth', 'antigravity')))
      .toBeUndefined()
    expect(await scaffold.ctx.credentials.readRecord(credentialKey('llm-account-auth', 'chatgpt'))).toEqual(chatgptBefore)
    const credentialsAfter = await readFile(join(scaffold.harnessHome, '.credentials.yaml'), 'utf8')
    expect(credentialsAfter).not.toContain('llm-account-auth/antigravity')
    expect(credentialsAfter).not.toContain('google@example.test')
    expect(credentialsAfter).toContain('sk-e2e-independent-primary')
    expect(credentialsAfter).toContain('sk-e2e-independent-fallback')
    const after = scaffold.ctx.settings.describe().find(value => value.ns === ACCOUNT_AUTH_NAMESPACE)?.value as {
      providers: Record<string, unknown>
    }
    expect(after.providers['antigravity']).toBeUndefined()
    expect(after.providers['gemini-api']).toEqual(geminiProfile)
    expect(await readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8')).not.toContain('stale-antigravity-model')

    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    const reopened = await openModels(page)
    expect(await scaffold.ctx.authorization.listAccounts(credentialKey('llm-account-auth', 'antigravity'))).toEqual([])
    await openAddEditor(reopened, 'antigravity')
    await reopened.getByText('Customized settings', { exact: true }).click()
    expect(await reopened.getByRole('region', { name: 'Antigravity', exact: true }).getByRole('textbox', { name: /^Model ID \d+$/ }).count()).toBe(0)
    await addAccount(reopened, 'Google Antigravity', 'google@example.test', 'add')
    await applyEditor(reopened, 'Edit Google Antigravity (antigravity)')
    await openEditor(reopened, 'Edit Google Antigravity (antigravity)')
    await expectUsage(reopened, 'google@example.test', ['Google AI Ultra', '93% left', '68% left'])
    expect(await reopened.getByRole('progressbar', { name: 'Weekly usage limit', exact: true }).first()
      .getAttribute('aria-description')).toContain('930 remaining')
    expect(await reopened.getByText('Google AI Pro', { exact: true }).count()).toBe(0)
    expect(await reopened.getByText('google@example.test', { exact: true }).count()).toBe(1)
    await reopened.getByText('Customized settings', { exact: true }).click()
    expect(await reopened.getByRole('textbox', { name: /^Model ID \d+$/ }).count()).toBe(0)
    await compareOrRefreshGolden(RECONNECTED_EXPECTED,
      await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd), MODE)
    await reopened.getByText('google@example.test', { exact: true }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(SHOTS, 'login-after-delete.png') })
    expect(tripwire.warnings).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
  }, 90_000)

  it('deletes every ChatGPT account without affecting another provider or stored API keys', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-chatgpt-delete'))
    const key = credentialKey('llm-account-auth', 'chatgpt')
    await scaffold.ctx.credentials.modifyRecord(key, async () => ({ kind: 'grant', payload: { accounts: [
      { id: 'chatgpt-1', label: 'alice@example.test' }, { id: 'chatgpt-2', label: 'bob@example.test' },
    ] } }))
    const googleBefore = await scaffold.ctx.credentials.readRecord(credentialKey('llm-account-auth', 'antigravity'))
    const dialog = await openModels(page)
    const section = dialog.getByRole('region', { name: 'Account sign-in', exact: true })
    await openEditor(dialog, 'Edit ChatGPT (chatgpt)')
    await dialog.getByText('alice@example.test', { exact: true }).waitFor()
    await dialog.getByText('bob@example.test', { exact: true }).waitFor()
    await section.getByRole('button', { name: 'Delete ChatGPT (chatgpt)', exact: true }).click()
    const confirmation = page.getByRole('dialog', { name: 'Delete ChatGPT (chatgpt)?', exact: true })
    await confirmation.waitFor()
    expect(await confirmation.innerText()).toContain('all accounts saved in Hydra')
    expect(await confirmation.innerText()).toContain('Browser sign-ins are kept.')
    await compareOrRefreshGolden(DELETE_CHATGPT_EXPECTED,
      await captureStableAria(page, '[role="dialog"][aria-label="Delete ChatGPT (chatgpt)?"]', scaffold.workspaceCwd), MODE)
    await confirmation.getByRole('button', { name: 'Delete ChatGPT (chatgpt)', exact: true }).click()
    await expect.poll(() => section.getByRole('button', { name: 'Edit ChatGPT (chatgpt)', exact: true }).count()).toBe(0)
    expect(await scaffold.ctx.credentials.readRecord(key)).toBeUndefined()
    expect(await scaffold.ctx.credentials.readRecord(credentialKey('llm-account-auth', 'antigravity'))).toEqual(googleBefore)
    const contents = await readFile(join(scaffold.harnessHome, '.credentials.yaml'), 'utf8')
    expect(contents).not.toContain('llm-account-auth/chatgpt')
    expect(contents).not.toContain('alice@example.test')
    expect(contents).not.toContain('bob@example.test')
    expect(contents).toContain('sk-e2e-independent-primary')
    expect(contents).toContain('sk-e2e-independent-fallback')
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    const reopened = await openModels(page)
    await openAddEditor(reopened, 'chatgpt')
    await addAccount(reopened, 'ChatGPT', 'alice@example.test', 'add')
    await applyEditor(reopened, 'Edit ChatGPT (chatgpt)')
    await openEditor(reopened, 'Edit ChatGPT (chatgpt)')
    await expect.poll(() => reopened.getByText('alice@example.test', { exact: true }).count(), { timeout: 10_000 }).toBe(1)
    expect(await reopened.getByText('bob@example.test', { exact: true }).count()).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it.skipIf(MODE === 'record')('keeps the fixture inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR,
      ['connected.expected.md', 'google.expected.md', 'add.expected.md', 'delete.expected.md', 'delete-chatgpt.expected.md', 'reconnected.expected.md'])
  })
})

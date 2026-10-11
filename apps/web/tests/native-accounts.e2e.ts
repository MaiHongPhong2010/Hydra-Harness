/** Native account directory and Host-owned credentials through the assembled Web settings. */
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, expect, it, onTestFailed } from 'vitest'
import { createAccountPool, accountRecordKey } from '../../../packages/llm/llm-account-auth/src/accounts.ts'
import { ACCOUNT_PROVIDER_LABELS, type AccountProvider } from '../../../packages/llm/llm-account-auth/src/config.ts'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, REPO_ROOT } from './support.ts'

const providers = ['claude', 'xai-account', 'kimi', 'cursor', 'kiro'] as const
const golden = fileURLToPath(new URL('./snapshots/native-accounts/configured.expected.md', import.meta.url))
const shots = join(REPO_ROOT, '.artifacts/native-accounts')
let scaffold: WebScaffold
let browser: Browser
let page: Page
let tripwire: ReturnType<typeof watchConsole>

beforeAll(async () => {
  scaffold = await launchWebScaffold({ deepSeekMissingCredential: true })
  for (const provider of providers) {
    await createAccountPool({ ctx: scaffold.ctx, key: accountRecordKey(provider), providerId: provider,
      providerLabel: ACCOUNT_PROVIDER_LABELS[provider] })
      .add(`${provider}@example.test`, { type: 'oauth', access: 'fixture-only-access', refresh: 'fixture-only-refresh', expires: Date.now() + 60_000 })
  }
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
  try { await browser?.close() } finally { await scaffold?.close() }
})

it('adds the five native sign-in providers, persists their accounts, and makes Cursor transport availability explicit', async () => {
  onTestFailed(async () => {
    await page.screenshot({ path: join(shots, 'catalog-failure.png') })
    console.log(await page.locator('[class*="error"], [class*="advancedHint"]').allTextContents())
  })
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await dialog.waitFor()
  await dialog.getByRole('button', { name: 'Models', exact: true }).click()
  const section = dialog.getByRole('region', { name: 'Account-backed models', exact: true })
  await section.getByRole('button', { name: 'Add provider', exact: true }).waitFor({ timeout: 15_000 })
  for (const provider of providers) {
    await section.getByRole('button', { name: 'Add provider', exact: true }).click()
    const selection = section.getByLabel('Provider', { exact: true })
    if (provider === providers[0]) {
      const choices = await selection.locator('option').allTextContents()
      for (const name of ['ChatGPT', 'Google Antigravity', 'Claude', 'xAI', 'Kimi Code', 'Cursor', 'Kiro']) expect(choices).toContain(name)
      await page.screenshot({ path: join(shots, 'provider-options.png') })
    }
    await selection.selectOption(provider)
    expect(await section.getByRole('list', { name: 'Accounts', exact: true }).count()).toBe(0)
    expect(await dialog.getByText(`${provider}@example.test`, { exact: true }).count()).toBe(0)
    expect(await section.getByRole('textbox', { name: 'API key', exact: true }).count()).toBe(0)
    expect(await section.getByRole('button', { name: 'Add account', exact: true }).count()).toBe(0)
    if (provider === 'cursor') {
      await section.getByText(/Cursor account management is available/).waitFor()
    }
    await section.getByText('Customized settings', { exact: true }).click()
    await section.getByRole('button', { name: 'Add model', exact: true }).click()
    await section.getByRole('textbox', { name: /^Model ID \d+$/ }).last().fill(`${provider}-catalog-alias`)
    await section.getByRole('checkbox', { name: `Image ${provider}-catalog-alias`, exact: true }).check()
    await section.getByRole('checkbox', { name: `Video ${provider}-catalog-alias`, exact: true }).check()
    if (provider === 'cursor') {
      expect(await section.getByRole('button', { name: 'Fetch', exact: true }).isDisabled()).toBe(true)
    }
    await section.getByRole('button', { name: 'Apply', exact: true }).click()
    const label = ACCOUNT_PROVIDER_LABELS[provider]
    await section.getByRole('button', { name: `Edit ${label} (${provider})`, exact: true }).waitFor({ timeout: 10_000 })
    if (provider === 'cursor') {
      for (const theme of ['Dark', 'Light']) {
        await dialog.getByRole('button', { name: 'General', exact: true }).click()
        await dialog.getByRole('button', { name: theme, exact: true }).click()
        await expect.poll(() => page.locator('body').getAttribute('data-ds-dark-theme')).toBe(theme === 'Dark' ? '' : null)
        await dialog.getByRole('button', { name: 'Models', exact: true }).click()
        await section.getByRole('button', { name: `Edit ${label} (${provider})`, exact: true }).click()
        await section.getByText(/Cursor account management is available/).scrollIntoViewIfNeeded()
        await page.screenshot({ path: join(shots, `cursor-${theme.toLowerCase()}.png`) })
        if (theme === 'Light') {
          await page.setViewportSize({ width: 720, height: 900 })
          await section.getByText(/Cursor account management is available/).scrollIntoViewIfNeeded()
          await page.screenshot({ path: join(shots, 'cursor-narrow.png') })
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
          await page.setViewportSize({ width: 1680, height: 1000 })
        }
        await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
      }
    }
  }
  for (const label of ['Image model', 'Video model']) {
    const select = dialog.getByLabel(label, { exact: true })
    await expect.poll(() => select.locator('option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value).sort()))
      .toEqual(['', ...providers.filter(provider => provider !== 'cursor').map(provider => JSON.stringify([provider, `${provider}-catalog-alias`]))].sort())
  }
  await compareOrRefreshGolden(golden, await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd), webSnapshotMode())
  expect(scaffold.ctx.llm.listProviders().map(provider => provider.id)).toEqual(expect.arrayContaining(['claude', 'xai-account', 'kimi', 'kiro']))
  expect(scaffold.ctx.llm.listProviders().map(provider => provider.id)).not.toContain('cursor')
  await page.reload()
  await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  if (!await dialog.isVisible()) await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Models', exact: true }).click()
  for (const provider of providers) {
    const label = ACCOUNT_PROVIDER_LABELS[provider as AccountProvider]
    await page.getByRole('button', { name: `Edit ${label} (${provider})`, exact: true }).waitFor({ timeout: 10_000 })
    await section.getByRole('button', { name: `Edit ${label} (${provider})`, exact: true }).click()
    expect(await section.getByText(provider + '@example.test', { exact: true }).count()).toBe(0)
    await section.getByText('Customized settings', { exact: true }).click()
    expect(await section.getByRole('checkbox', { name: `Image ${provider}-catalog-alias`, exact: true }).isChecked()).toBe(true)
    expect(await section.getByRole('checkbox', { name: `Video ${provider}-catalog-alias`, exact: true }).isChecked()).toBe(true)
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await dialog.getByRole('button', { name: 'Manage accounts', exact: true }).click()
    await dialog.getByLabel('Provider', { exact: true }).selectOption('llm-account-auth/' + provider)
    await dialog.getByText(provider + '@example.test', { exact: true }).waitFor()
    await dialog.getByRole('button', { name: 'Manage models', exact: true }).click()
  }
  expect(tripwire.warnings).toEqual([])
  expect(tripwire.pageErrors).toEqual([])
}, 90_000)

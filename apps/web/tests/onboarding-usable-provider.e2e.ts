// Keyless provider choice, dismissal, and restoration through the real application.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  acknowledgeReloadConnectionLoss, assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/onboarding-usable-provider', import.meta.url))
const DISMISSED_EXPECTED = join(SNAPSHOT_DIR, 'dismissed.expected.md')
const HIDDEN_CATALOG_EXPECTED = join(SNAPSHOT_DIR, 'hidden-catalog.expected.md')
const MODE = webSnapshotMode()
const CREDENTIAL_STEP = 'Add an API key to get started'

describe.skipIf(MODE === 'record')('web e2e: another usable provider ends first-run onboarding', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ deepSeekMissingCredential: true })
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: 'en-US' })
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('opens provider configuration with every editor closed and allows dismissal', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-onboarding-provider-choice'))
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
    await settings.waitFor({ timeout: 15_000 })
    await settings.getByRole('region', { name: 'API keys', exact: true }).getByRole('button', { name: 'Add provider', exact: true }).waitFor()
    expect(await page.getByRole('dialog', { name: CREDENTIAL_STEP }).count()).toBe(0)
    expect(await settings.getByRole('textbox', { name: 'API key', exact: true }).count()).toBe(0)
    await page.keyboard.press('Escape')
    await settings.waitFor({ state: 'detached' })
    expect(await page.locator('#root').evaluate(root => (root as HTMLElement).inert)).toBe(false)
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await settings.getByRole('button', { name: 'Models', exact: true }).click()

    const add = settings.getByRole('region', { name: 'API keys', exact: true }).getByRole('button', { name: 'Add provider' })
    await expect.poll(async () => add.isEnabled(), { timeout: 10_000 }).toBe(true)
    await add.click()
    const pick = settings.getByLabel('Provider')
    await pick.waitFor({ timeout: 10_000 })
    await pick.selectOption('minimax-cn')
    expect(await settings.getByRole('textbox', { name: 'API key', exact: true }).count()).toBe(1)
    expect(await settings.getByRole('button', { name: 'Edit DeepSeek (deepseek-official)' }).count()).toBe(0)
    const dismissed = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(DISMISSED_EXPECTED, dismissed, MODE)

    expect(tripwire.warnings).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('stops prompting for DeepSeek once the other provider can serve requests', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-onboarding-other-provider'))
    const settings = page.getByRole('dialog', { name: 'Settings' })
    await settings.getByRole('textbox', { name: 'API key', exact: true }).fill('sk-e2e-minimax')
    await settings.getByRole('button', { name: 'Apply', exact: true }).click()
    await settings.getByText('Saved minimax-cn.', { exact: true }).waitFor({ timeout: 15_000 })

    // Only minimax-cn is reachable; DeepSeek still holds no credential.
    const document = await readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8')
    expect(document).toContain('apiKeyEnv: MINIMAX_CN_API_KEY')
    const credentials = await readFile(join(scaffold.harnessHome, '.credentials.yaml'), 'utf8')
    expect(credentials).toContain('MINIMAX_CN_API_KEY: sk-e2e-minimax')
    expect(credentials).not.toContain('DEEPSEEK_API_KEY')

    const warningsBefore = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    acknowledgeReloadConnectionLoss(tripwire, warningsBefore)
    await page.waitForSelector('[class*="frame"]', { timeout: 15_000 })
    await expect.poll(
      async () => page.getByRole('dialog', { name: CREDENTIAL_STEP }).count(),
      { timeout: 10_000 },
    ).toBe(0)
    expect(await page.locator('#root').evaluate(root => (root as HTMLElement).inert)).toBe(false)
    expect(await page.getByRole('dialog', { name: 'Settings', exact: true }).count()).toBe(0)

    // The Models page keeps the unselected shipped route hidden after another
    // provider is configured; it does not reopen a DeepSeek setup card.
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await settings.waitFor({ timeout: 10_000 })
    await settings.getByRole('button', { name: 'Models' }).click()
    expect(await settings.getByRole('button', { name: 'Edit DeepSeek (deepseek-official)' }).count()).toBe(0)
    expect(await settings.getByRole('textbox', { name: 'API key', exact: true }).count()).toBe(0)

    expect((await page.content()).includes('sk-e2e-minimax')).toBe(false)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('removes DeepSeek from the live model picker on Delete and restores it on Add provider', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-deepseek-hidden-catalog'))
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const setup = page.getByRole('dialog', { name: 'Settings', exact: true })
    await setup.getByRole('button', { name: 'Models', exact: true }).click()
    await setup.getByRole('region', { name: 'API keys', exact: true }).getByRole('button', { name: 'Add provider', exact: true }).click()
    await setup.getByLabel('Provider', { exact: true }).selectOption('deepseek-official')
    await setup.getByRole('textbox', { name: 'API key', exact: true }).fill('sk-e2e-deepseek')
    await setup.getByRole('button', { name: 'Apply', exact: true }).click()
    await setup.getByRole('button', { name: 'Edit DeepSeek (deepseek-official)' }).waitFor({ timeout: 10_000 })
    await page.keyboard.press('Escape')
    await connectFreshWorkspace(page, scaffold.workspaceCwd, 'hidden-catalog')
    const trigger = page.getByRole('button', { name: /^Select model/ })
    await trigger.click()
    await page.getByRole('menuitem', { name: /Model/ }).click()
    const deepSeekModel = page.getByRole('menuitemradio', { name: 'DeepSeek-V4-Flash', exact: true })
    await deepSeekModel.waitFor({ timeout: 10_000 })
    await page.getByRole('menuitemradio', { name: 'MiniMax-M2.7', exact: true }).click()

    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
    await settings.getByRole('button', { name: 'Models', exact: true }).click()
    await settings.getByRole('button', { name: 'Delete DeepSeek (deepseek-official)', exact: true }).click()
    const confirmation = page.getByRole('dialog', { name: 'Delete DeepSeek (deepseek-official)?', exact: true })
    await confirmation.getByRole('button', { name: 'Delete DeepSeek (deepseek-official)', exact: true }).click()
    await confirmation.waitFor({ state: 'detached', timeout: 10_000 })
    expect(await settings.getByRole('button', { name: 'Edit DeepSeek (deepseek-official)' }).count()).toBe(0)
    await page.keyboard.press('Escape')
    await trigger.click()
    await page.getByRole('menuitem', { name: /Model/ }).click()
    await page.getByRole('menuitemradio', { name: 'MiniMax-M2.7', exact: true }).waitFor({ timeout: 10_000 })
    await expect.poll(() => deepSeekModel.count(), { timeout: 10_000 }).toBe(0)
    const snapshot = await captureStableAria(page, '[role="menu"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(HIDDEN_CATALOG_EXPECTED, snapshot, MODE)
    expect((await readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8')))
      .toContain('deepseekOfficialDeclined: true')

    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await settings.getByRole('button', { name: 'Models', exact: true }).click()
    await settings.getByRole('region', { name: 'API keys', exact: true }).getByRole('button', { name: 'Add provider', exact: true }).click()
    await settings.getByLabel('Provider', { exact: true }).selectOption('deepseek-official')
    await settings.getByRole('textbox', { name: 'API key', exact: true }).fill('sk-e2e-deepseek')
    await settings.getByRole('button', { name: 'Apply', exact: true }).click()
    await settings.getByRole('button', { name: 'Edit DeepSeek (deepseek-official)' }).waitFor({ timeout: 10_000 })
    await page.keyboard.press('Escape')
    await trigger.click()
    await page.getByRole('menuitem', { name: /Model/ }).click()
    await deepSeekModel.waitFor({ timeout: 10_000 })
    await page.getByRole('menuitemradio', { name: 'MiniMax-M2.7', exact: true }).waitFor({ timeout: 10_000 })
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('keeps the fixture inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['dismissed.expected.md', 'hidden-catalog.expected.md'])
  })
})

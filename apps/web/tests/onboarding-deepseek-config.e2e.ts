// Keyless first-run provider selection, write-only credentials, and live model settings.
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { settingsNamespace } from '@hydraharness/harness-settings'
import {
  acknowledgeReloadConnectionLoss, assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
  WELCOME_NOTICE_ACK_FIELD, WELCOME_NOTICE_COPY, WELCOME_NOTICE_SETTINGS_NAMESPACE,
  WELCOME_NOTICE_VERSION,
} from './scaffold.ts'
import { connectFreshWorkspace, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/onboarding-deepseek-config', import.meta.url))
const WELCOME_EXPECTED = join(SNAPSHOT_DIR, 'welcome.expected.md')
const MISSING_EXPECTED = join(SNAPSHOT_DIR, 'missing.expected.md')
const MODELS_EXPECTED = join(SNAPSHOT_DIR, 'models.expected.md')
const KEYS_EXPECTED = join(SNAPSHOT_DIR, 'keys.expected.md')
const MODE = webSnapshotMode()

describe.skipIf(MODE === 'record')('web e2e: first-run provider configuration', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  const browserConsole: string[] = []

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ deepSeekMissingCredential: true, welcomeNoticePending: true })
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: 'en-US' })
    tripwire = watchConsole(page)
    page.on('console', message => browserConsole.push(message.text()))
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('stores a key write-only and observes configured state without restarting', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-onboarding-deepseek-config'))
    const welcome = page.getByRole('dialog', { name: WELCOME_NOTICE_COPY.en.title })
    await welcome.waitFor({ timeout: 15_000 })
    expect(await page.locator('#root').evaluate(root => (root as HTMLElement).inert)).toBe(true)
    for (const paragraph of WELCOME_NOTICE_COPY.en.body.split('\n\n')) {
      expect(await welcome.getByText(paragraph, { exact: true }).count()).toBe(1)
    }
    expect(await welcome.getByRole('button').allTextContents()).toEqual([
      WELCOME_NOTICE_COPY.en.continueLabel,
    ])
    const welcomeAria = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(WELCOME_EXPECTED, welcomeAria, MODE)

    // Observation is not acknowledgement: the exact version is persisted
    // only by the explicit action, so a reload still presents this dialog.
    const firstReloadWarnings = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    acknowledgeReloadConnectionLoss(tripwire, firstReloadWarnings)
    await welcome.waitFor({ timeout: 15_000 })

    await welcome.getByRole('button', { name: WELCOME_NOTICE_COPY.en.continueLabel }).click()
    await welcome.waitFor({ state: 'detached', timeout: 15_000 })

    const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
    await settings.waitFor({ timeout: 15_000 })
    await settings.getByRole('region', { name: 'API keys', exact: true }).getByRole('button', { name: 'Add provider', exact: true }).waitFor()
    expect(await settings.getByRole('textbox', { name: 'API key', exact: true }).count()).toBe(0)
    expect(await page.getByRole('dialog', { name: 'Add an API key to get started' }).count()).toBe(0)
    const initial = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(MISSING_EXPECTED, initial, MODE)
    await page.screenshot({ path: '.hydra-build/provider-setup.png' })

    await settings.getByRole('region', { name: 'API keys', exact: true }).getByRole('button', { name: 'Add provider', exact: true }).click()
    await settings.getByLabel('Provider', { exact: true }).selectOption('deepseek-official')
    const keyInput = settings.getByRole('textbox', { name: 'API key', exact: true })
    const secret = `hydra_onboarding_${randomBytes(12).toString('hex')}`
    await keyInput.fill(secret)
    await settings.getByRole('button', { name: 'Apply', exact: true }).click()
    await keyInput.waitFor({ state: 'detached', timeout: 15_000 })
    expect(await page.locator('#root').evaluate(root => (root as HTMLElement).inert)).toBe(false)

    const stored = await readFile(join(scaffold.harnessHome, '.credentials.yaml'), 'utf8')
    expect(stored.includes(`DEEPSEEK_API_KEY: ${secret}`)).toBe(true)
    expect((await page.content()).includes(secret)).toBe(false)
    expect((await page.locator('body').ariaSnapshot()).includes(secret)).toBe(false)
    expect(browserConsole.some(line => line.includes(secret))).toBe(false)

    const acknowledgedSettings = await readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8')
    expect(acknowledgedSettings).toContain(`${WELCOME_NOTICE_ACK_FIELD}: ${WELCOME_NOTICE_VERSION}`)

    const deepSeekRow = settings.getByText('DeepSeek', { exact: true }).first()
    await deepSeekRow.waitFor({ timeout: 10_000 })
    await deepSeekRow.locator('xpath=ancestor::li').getByRole('button', { name: 'Edit' }).click()
    const configuredInput = settings.getByRole('textbox', { name: 'API key', exact: true })
    await configuredInput.waitFor({ timeout: 10_000 })
    await expect.poll(
      () => configuredInput.getAttribute('placeholder'),
      { timeout: 10_000 },
    ).toBe('Configured — enter a new value to replace')

    await settings.getByRole('button', { name: 'Add API key', exact: true }).click()
    const fallbackInput = settings.getByLabel('Fallback API key 1', { exact: true })
    const fallbackSecret = `hydra_fallback_${randomBytes(12).toString('hex')}`
    await fallbackInput.fill(fallbackSecret)
    await settings.getByRole('button', { name: 'Apply', exact: true }).click()
    await fallbackInput.waitFor({ state: 'detached', timeout: 15_000 })
    const savedKeys = await readFile(join(scaffold.harnessHome, '.credentials.yaml'), 'utf8')
    const savedProfile = await readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8')
    expect(savedKeys).toContain(fallbackSecret)
    expect(savedProfile).toContain('apiKeyFallbackEnvs:')
    expect(savedProfile).not.toContain(fallbackSecret)
    await settings.getByRole('button', { name: 'Edit DeepSeek (deepseek-official)', exact: true }).click()
    await expect.poll(() => settings.getByLabel('Fallback API key 1').getAttribute('placeholder'))
      .toBe('Configured — enter a new value to replace')
    expect(await settings.getByLabel('Fallback API key 1').inputValue()).toBe('')
    await compareOrRefreshGolden(KEYS_EXPECTED,
      await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd), MODE)
    await page.screenshot({ path: '.hydra-build/provider-multiple-keys.png' })
    expect((await page.content()).includes(fallbackSecret)).toBe(false)
    expect(browserConsole.some(line => line.includes(fallbackSecret))).toBe(false)

    const secondReloadWarnings = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    acknowledgeReloadConnectionLoss(tripwire, secondReloadWarnings)
    await page.waitForSelector('[class*="frame"]', { timeout: 15_000 })
    expect(await page.getByRole('dialog', { name: WELCOME_NOTICE_COPY.en.title }).count()).toBe(0)
    expect(await page.getByRole('dialog', { name: 'Add an API key to get started' }).count()).toBe(0)
    expect(await page.getByRole('dialog', { name: 'Settings', exact: true }).count()).toBe(0)

    // An old acknowledgement means materially revised copy: welcome returns,
    // while the already-configured provider step remains complete.
    await scaffold.ctx.settings.mutate(settingsNamespace(WELCOME_NOTICE_SETTINGS_NAMESPACE), [{
      op: 'set', path: [WELCOME_NOTICE_ACK_FIELD], value: 'previous-copy-version',
    }])
    const thirdReloadWarnings = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    acknowledgeReloadConnectionLoss(tripwire, thirdReloadWarnings)
    await welcome.waitFor({ timeout: 15_000 })
    await welcome.getByRole('button', { name: WELCOME_NOTICE_COPY.en.continueLabel }).click()
    await welcome.waitFor({ state: 'detached', timeout: 15_000 })
    expect(await page.getByRole('dialog', { name: 'Add an API key to get started' }).count()).toBe(0)

    expect((await page.content()).includes(secret)).toBe(false)
    expect((await page.locator('body').ariaSnapshot()).includes(secret)).toBe(false)
    expect(browserConsole.some(line => line.includes(secret))).toBe(false)
    expect(tripwire.warnings).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('never paints the takeover chrome on a configured reload, even with the settings join held open', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-onboarding-configured-reload'))
    // Regression pin for the reload flash: both steps are satisfied, yet each
    // must load private facts before deciding not to show. Dialog chrome lives
    // inside each visible branch, so the deciding window paints and blocks
    // nothing. Holding settings.describe widens that window from loopback
    // RTT scale to a deterministic hundreds of milliseconds, removing all
    // timing dependence from the sampler assertions below.
    //
    // The sampler init script persists across this shared page's later
    // navigations (init scripts re-run per navigation); that stays harmless
    // because no later scenario in this file legitimately shows the
    // takeover, and only this test reads __takeoverSightings.
    await page.addInitScript(() => {
      const sightings: string[] = []
      ;(window as unknown as { __takeoverSightings: string[] }).__takeoverSightings = sightings
      setInterval(() => {
        if (document.querySelector(
          '[role="dialog"][aria-label="Internal Testing Notice"], '
          + '[role="dialog"][aria-label="Add an API key to get started"]',
        ) !== null) {
          sightings.push('chrome')
        }
        if (document.getElementById('root')?.inert === true) sightings.push('inert')
      }, 8)
    })
    // EVERY settings.describe issued before the release is held — not just
    // the first — so the pin cannot silently collapse back to loopback
    // timing if a second boot-time consumer of the join ever appears.
    let released = false
    const heldRoutes: Array<() => void> = []
    const releaseDescribe = (): void => {
      released = true
      for (const resolve of heldRoutes.splice(0)) resolve()
    }
    await page.route('**/api/settings.describe', async (route) => {
      if (!released) await new Promise<void>((resolve) => { heldRoutes.push(resolve) })
      await route.continue()
    })
    const warningsBefore = tripwire.warnings.length
    await page.reload({ waitUntil: 'commit' })
    await page.waitForSelector('[class*="frame"]', { timeout: 15_000 })
    // The app is painted and interactive while the steps are still deciding.
    await page.waitForTimeout(600)
    releaseDescribe()
    await page.waitForTimeout(400)
    await page.unroute('**/api/settings.describe')
    acknowledgeReloadConnectionLoss(tripwire, warningsBefore)
    expect(await page.evaluate(() =>
      (window as unknown as { __takeoverSightings: string[] }).__takeoverSightings)).toEqual([])
    expect(await page.getByRole('dialog', { name: WELCOME_NOTICE_COPY.en.title }).count()).toBe(0)
    expect(await page.getByRole('dialog', { name: 'Add an API key to get started' }).count()).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('requires an explicit model choice on a fresh Web install', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-onboarding-deepseek-models'))
    await connectFreshWorkspace(page, scaffold.workspaceCwd, 'model-fallback-e2e')
    const composer = page.locator('[data-composer-card] textarea')
    await page.getByRole('button', { name: 'Select model', exact: true }).click()
    await page.getByRole('menuitem', { name: /Model/ }).click()
    await page.getByRole('menuitemradio', { name: 'DeepSeek-V4-Flash', exact: true }).click()
    await expect.poll(() => composer.isEnabled()).toBe(true)
    await composer.fill('Keep this draft until I select a model')
    // Opened here rather than inherited: the credential test reloads the page
    // after configuring the key, so nothing carries an open dialog across.
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const settings = page.getByRole('dialog', { name: 'Settings' })
    await settings.waitFor({ timeout: 10_000 })
    await settings.getByRole('button', { name: 'Models' }).click()
    const deepSeek = settings.getByText('DeepSeek', { exact: true }).first()
    await deepSeek.waitFor({ timeout: 10_000 })
    await deepSeek.locator('xpath=ancestor::li').getByRole('button', { name: 'Edit' }).click()
    await settings.getByText('Customized settings').click()
    await settings.getByRole('button', { name: /Delete model/ }).first().click()
    await settings.getByRole('button', { name: 'Add model' }).click()
    const customModelId = settings.getByLabel('Model ID 3')
    await customModelId.fill('private-preview')
    await settings.getByLabel('Display name 3').fill('Private Preview')
    // Capacities live behind the row's own disclosure, as in the pi-ai form.
    await settings.getByRole('button', { name: 'Capacities 3' }).click()
    await settings.getByLabel('Context window 3').fill('131072')
    await settings.getByLabel('Max output tokens 3').fill('64K')

    const modelEditor = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(MODELS_EXPECTED, modelEditor, MODE)
    await settings.getByRole('button', { name: 'Apply', exact: true }).click()
    await customModelId.waitFor({ state: 'detached', timeout: 15_000 })

    const document = await readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8')
    expect(document).toContain('id: deepseek-v4-pro')
    expect(document).toContain('id: deepseek-v4-flash-vision-exp')
    expect(document).toContain('inputModalities:')
    expect(document).toContain('- image')
    expect(document).toContain('id: private-preview')
    expect(document).toContain('name: Private Preview')
    expect(document).toContain('contextWindow: 131072')
    expect(document).toContain('maxTokens: 64000')
    expect(document).not.toMatch(/^\s*- id: deepseek-v4-flash$/m)

    await page.keyboard.press('Escape')
    await expect.poll(() => composer.isDisabled()).toBe(false)
    expect(await composer.inputValue()).toBe('Keep this draft until I select a model')
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'model-required.expected.md'),
      await captureStableAria(page, '[data-composer-card]', scaffold.workspaceCwd), MODE)

    const modelTrigger = page.getByRole('button', { name: 'Select model', exact: true })
    await modelTrigger.waitFor({ timeout: 10_000 })
    await modelTrigger.click()
    await page.getByRole('menuitem', { name: /Model/ }).click()
    expect(await page.getByText('deepseek-v4-flash', { exact: true }).count()).toBe(0)
    await page.getByRole('menuitemradio', { name: 'DeepSeek-V4-Flash-Vision-Exp' }).waitFor({ timeout: 10_000 })
    await page.getByRole('menuitemradio', { name: 'Private Preview' }).waitFor({ timeout: 10_000 })
    await page.getByRole('menuitemradio', { name: 'Private Preview' }).click()
    await expect.poll(() => composer.isDisabled()).toBe(false)
    expect(await composer.inputValue()).toBe('Keep this draft until I select a model')
    expect(tripwire.warnings).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('persists direct DeepSeek role edits and restores ordinary selection when both are cleared', async () => {
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
    await settings.getByRole('button', { name: 'Models', exact: true }).click()
    const edit = settings.getByRole('button', { name: 'Edit DeepSeek (deepseek-official)', exact: true })
    await edit.click()
    await settings.getByText('Customized settings', { exact: true }).click()
    await settings.getByRole('checkbox', { name: 'Image private-preview', exact: true }).check()
    await settings.getByRole('checkbox', { name: 'Video private-preview', exact: true }).check()
    await settings.getByRole('button', { name: 'Apply', exact: true }).click()
    await edit.waitFor()
    const value = JSON.stringify(['deepseek-official', 'private-preview'])
    for (const label of ['Image model', 'Video model']) {
      await expect.poll(() => settings.getByLabel(label, { exact: true }).locator('option').evaluateAll(
        options => options.map(option => (option as HTMLOptionElement).value),
      )).toEqual(['', value])
    }
    const warningsBeforeReload = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    acknowledgeReloadConnectionLoss(tripwire, warningsBeforeReload)
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await settings.getByRole('button', { name: 'Models', exact: true }).click()
    await edit.click()
    await settings.getByText('Customized settings', { exact: true }).click()
    expect(await settings.getByRole('checkbox', { name: 'Image private-preview', exact: true }).isChecked()).toBe(true)
    expect(await settings.getByRole('checkbox', { name: 'Video private-preview', exact: true }).isChecked()).toBe(true)
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'classification.expected.md'),
      await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd), MODE)
    await settings.getByRole('checkbox', { name: 'Image private-preview', exact: true }).uncheck()
    await settings.getByRole('checkbox', { name: 'Video private-preview', exact: true }).uncheck()
    await settings.getByRole('button', { name: 'Apply', exact: true }).click()
    await edit.waitFor()
    for (const label of ['Image model', 'Video model']) {
      await expect.poll(() => settings.getByLabel(label, { exact: true }).locator('option').evaluateAll(
        options => options.map(option => (option as HTMLOptionElement).value),
      )).toEqual([''])
    }
    await settings.getByRole('button', { name: 'Close', exact: true }).click()
    const trigger = page.getByRole('button', { name: /^Select model/ })
    await trigger.click()
    await page.getByRole('menuitem', { name: /^Model/ }).click()
    await page.getByRole('menuitemradio', { name: 'Private Preview', exact: true }).waitFor()
    await trigger.click()
    expect(tripwire.warnings).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('keeps the fixture inventory closed', async () => {
    await assertFixtureInventory(
      SNAPSHOT_DIR,
      ['welcome.expected.md', 'keys.expected.md', 'missing.expected.md', 'models.expected.md', 'model-required.expected.md', 'classification.expected.md'],
    )
  })
})

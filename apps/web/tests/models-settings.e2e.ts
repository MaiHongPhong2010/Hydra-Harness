// Web e2e scenario: the Models settings page end to end through the real
// wire — the add card offers the dormant pi-ai catalog, a blank key saves a
// reference-free profile for provider-native auth, and typing an API key later
// stores it write-only under the derived reference (`MINIMAX_CN_API_KEY`)
// while the settings document records only that reference. Each saved row
// appears after route topology invalidation without presenting liveness as
// provider status. The customized-settings fold writes its curated fields —
// the endpoint, and a declared route's own name and protocol — as merge
// patches against the stored profile. Zero model calls: configuration is pure
// settings/credentials/llm-domain traffic, so there is no fixture and a
// stray stream would fail loud because the adapter registry is empty. The provider under test is
// minimax-cn so a developer's real ANTHROPIC/OPENAI environment keys can
// never shadow the derived reference. The deletion dialog distinguishes a
// reference-free profile from a page-managed key before the credential and
// settings unsets reach the wire.
import { mkdir, readFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { Context } from '@hydraharness/cordis'
import { credentialKey } from '@hydraharness/harness-credentials'
import { Config as PiAiConfig } from '@hydraharness/harness-llm-pi-ai'
import { settingsNamespace } from '@hydraharness/harness-settings'
import FileSettingsProvider from '@hydraharness/harness-settings-file'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { REPO_ROOT, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/models-settings', import.meta.url))
const EMPTY_EXPECTED = join(SNAPSHOT_DIR, 'empty.expected.md')
const CONFIGURED_EXPECTED = join(SNAPSHOT_DIR, 'configured.expected.md')
const DECLARED_EXPECTED = join(SNAPSHOT_DIR, 'declared.expected.md')
const DECLARED_EDIT_EXPECTED = join(SNAPSHOT_DIR, 'declared-edit.expected.md')
const MODEL_PICKER_EXPECTED = join(SNAPSHOT_DIR, 'model-picker.expected.md')
const NATIVE_DELETE_EXPECTED = join(SNAPSHOT_DIR, 'native-delete.expected.md')
const DELETE_EXPECTED = join(SNAPSHOT_DIR, 'delete.expected.md')
const DELETED_EXPECTED = join(SNAPSHOT_DIR, 'deleted.expected.md')
const MODE = webSnapshotMode()

describe('web e2e: Models settings page configures a dormant provider', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let peer: Context | undefined
  let catalogServer: Server
  let catalogUrl: string

  beforeAll(async () => {
    catalogServer = createServer((_request, response) => {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ data: [
        { id: 'MiniMax-M2.7', name: 'MiniMax M2.7' },
        { id: 'MiniMax-M2.7-highspeed' },
        { id: 'MiniMax-M3' },
      ] }))
    })
    await new Promise<void>(resolve => catalogServer.listen(0, '127.0.0.1', resolve))
    const address = catalogServer.address()
    if (address === null || typeof address === 'string') throw new Error('Model fixture has no TCP port')
    catalogUrl = `http://127.0.0.1:${address.port}/v1`
    scaffold = await launchWebScaffold({})
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: 'en-US' })
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await peer?.fiber.dispose()
    await scaffold?.close()
    if (catalogServer !== undefined) {
      await new Promise<void>((resolve, reject) => {
        catalogServer.close((error) => {
          if (error === undefined) resolve()
          else reject(error)
        })
        catalogServer.closeAllConnections()
      })
    }
  })

  it('opens the add card over the dormant directory vocabulary', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-models-empty'))
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Settings' })
    await dialog.waitFor({ timeout: 10_000 })
    await dialog.getByRole('button', { name: 'Models' }).click()
    await dialog.getByText('Configure providers, API keys, model catalogs, and default models.').waitFor({ timeout: 10_000 })
    // The dormant pi-ai adapter contributes its whole installed catalog.
    const add = dialog.getByRole('region', { name: 'API keys', exact: true })
      .getByRole('button', { name: 'Add provider', exact: true })
    await add.waitFor({ timeout: 10_000 })
    // The button enables once the dormant catalog lands in the join.
    await expect.poll(async () => add.isEnabled(), { timeout: 10_000 }).toBe(true)
    await add.click()
    const pick = dialog.getByLabel('Provider')
    await pick.waitFor({ timeout: 10_000 })
    await expect.poll(async () => pick.locator('option').count(), { timeout: 10_000 }).toBeGreaterThan(30)
    const options = await pick.locator('option').allTextContents()
    expect(options).toContain('anthropic')
    expect(options).toContain('minimax-cn')
    await pick.selectOption('minimax-cn')
    await dialog.getByRole('textbox', { name: 'API key', exact: true }).waitFor({ timeout: 10_000 })
    const snapshot = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(EMPTY_EXPECTED, snapshot, MODE)
  }, 60_000)

  it('refuses a key no HTTP header can carry before anything is written', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-models-illegal-key'))
    const dialog = page.getByRole('dialog', { name: 'Settings' })
    const key = dialog.getByRole('textbox', { name: 'API key', exact: true })
    const save = dialog.getByRole('region', { name: 'API keys', exact: true }).getByRole('button', { name: 'Apply', exact: true })

    // A key no HTTP header can carry would save cleanly and fail the first
    // turn with a ByteString TypeError; the form names the offending field
    // instead.
    await key.fill('sk-\u{1F600}minimax')
    await dialog.getByText('This API key is not in a valid format. Please check it.').waitFor({ timeout: 10_000 })
    await expect.poll(async () => save.isEnabled(), { timeout: 10_000 }).toBe(false)

    // Clearing it restores submit: an empty field means "keep what is stored",
    // never a refusal, or editing any other setting would demand the key.
    await key.fill('')
    await expect.poll(async () => save.isEnabled(), { timeout: 10_000 }).toBe(true)
    expect(await dialog.getByText('This API key is not in a valid format. Please check it.').count()).toBe(0)
  }, 60_000)

  it('saves a blank key as a reference-free provider-native profile', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-models-native-auth'))
    const dialog = page.getByRole('dialog', { name: 'Settings' })
    await dialog.getByRole('region', { name: 'API keys', exact: true }).getByRole('button', { name: 'Apply', exact: true }).click()
    const row = dialog.getByText('minimax-cn', { exact: true }).first()
    await row.waitFor({ timeout: 10_000 })
    await dialog.getByText('Saved minimax-cn.', { exact: true }).waitFor({ timeout: 10_000 })
    expect(await dialog.getByRole('img', { name: 'API key configured' }).count()).toBe(0)
    expect(await dialog.getByRole('img', { name: 'API key missing' }).count()).toBe(0)
    const document = await readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8')
    expect(document).toContain('minimax-cn: {}')
    expect(document).not.toContain('MINIMAX_CN_API_KEY')
  }, 60_000)

  it('describes reference-free deletion without claiming a credential exists', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-models-native-delete'))
    const settingsDialog = page.getByRole('dialog', { name: 'Settings' })
    await settingsDialog.getByRole('button', { name: 'Delete minimax-cn', exact: true }).click()
    const deleteDialog = page.getByRole('dialog', { name: 'Delete minimax-cn?' })
    await deleteDialog.waitFor({ timeout: 10_000 })
    const snapshot = await captureStableAria(
      page,
      '[role="dialog"][aria-label="Delete minimax-cn?"]',
      scaffold.workspaceCwd,
    )
    await compareOrRefreshGolden(NATIVE_DELETE_EXPECTED, snapshot, MODE)
    await deleteDialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  }, 60_000)

  it('stores the key under the derived reference and keeps the route live', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-models-add'))
    const dialog = page.getByRole('dialog', { name: 'Settings' })
    await dialog.getByRole('button', { name: 'Edit minimax-cn' }).click()
    await dialog.getByRole('textbox', { name: 'API key', exact: true }).fill('sk-e2e-minimax')
    await dialog.getByRole('region', { name: 'API keys', exact: true }).getByRole('button', { name: 'Apply', exact: true }).click()
    // The profile lands in settings.yaml with only the derived reference, the
    // key value lands in the harness home's .credentials.yaml, the dormant route
    // registers, and the topology frame invalidates the page into the row.
    await expect.poll(
      async () => dialog.getByRole('textbox', { name: 'API key', exact: true }).count(),
      { timeout: 10_000 },
    ).toBe(0)
    await dialog.getByRole('img', { name: 'API key configured' }).waitFor({ timeout: 10_000 })
    await dialog.getByText('Saved minimax-cn.', { exact: true }).waitFor({ timeout: 10_000 })
    const document = await readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8')
    expect(document).toContain('minimax-cn:')
    expect(document).toContain('apiKeyEnv: MINIMAX_CN_API_KEY')
    expect(document).not.toContain('sk-e2e-minimax')
    const credentialFile = join(scaffold.harnessHome, '.credentials.yaml')
    await expect.poll(
      async () => readFile(credentialFile, 'utf8').catch(() => ''),
      { timeout: 10_000 },
    ).toContain('MINIMAX_CN_API_KEY: sk-e2e-minimax')
    expect(await page.content()).not.toContain('sk-e2e-minimax')
  }, 60_000)

  it('applies a customized-settings field as a merge patch', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-models-customized'))
    const dialog = page.getByRole('dialog', { name: 'Settings' })
    await dialog.getByRole('button', { name: 'Edit minimax-cn' }).click()
    await dialog.getByText('Customized settings').click()
    const url = dialog.getByLabel('Base URL')
    await url.waitFor({ timeout: 10_000 })
    await url.fill('https://gateway.minimax.example/v1')
    await dialog.getByRole('region', { name: 'API keys', exact: true }).getByRole('button', { name: 'Apply', exact: true }).click()
    // The editor closes back to the row; the fold's write merged into the
    // stored profile beside the reference.
    await expect.poll(async () => dialog.getByLabel('Base URL').count(), { timeout: 10_000 }).toBe(0)
    await dialog.getByText('Saved minimax-cn.', { exact: true }).waitFor({ timeout: 10_000 })
    const document = await readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8')
    expect(document).toContain('baseURL: https://gateway.minimax.example/v1')
    expect(document).toContain('apiKeyEnv: MINIMAX_CN_API_KEY')
    const snapshot = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(CONFIGURED_EXPECTED, snapshot, MODE)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('declares a route the adapter does not ship', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-models-declare'))
    const dialog = page.getByRole('dialog', { name: 'Settings' })
    const declare = dialog.getByRole('button', { name: 'Add a custom provider' })
    await expect.poll(async () => declare.isEnabled(), { timeout: 10_000 }).toBe(true)
    await declare.click()
    await dialog.getByLabel('Provider ID').fill('acme-gateway')
    await dialog.getByLabel('Display name').fill('Acme Gateway')
    await dialog.getByLabel('Base URL').fill('https://gateway.acme.example/v1')
    // No reasoning effort on a provider card at all: effort is a per-model
    // capability, the models under one provider disagree about it, and a
    // switch in the composer already records provider+model+effort together.
    expect(await dialog.getByLabel('Reasoning effort').count()).toBe(0)
    await dialog.getByRole('button', { name: 'Add model' }).click()
    await dialog.getByLabel('Model ID 1').fill('acme-large')
    await dialog.getByRole('button', { name: 'Model details 1', exact: true }).click()
    const output = dialog.getByLabel('Max output tokens 1', { exact: true })
    expect(await output.getAttribute('placeholder')).toBe('Unlimited')
    await output.fill('16K')
    await output.fill('')
    await dialog.getByRole('button', { name: 'Create provider', exact: true }).click()

    const row = dialog.getByText('Acme Gateway', { exact: true }).first()
    await row.waitFor({ timeout: 10_000 })
    const document = await readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8')
    expect(document).toContain('acme-gateway:')
    expect(document).not.toContain('maxTokens:')

    // The tag follows the adapter's installed catalog: this route is in no
    // catalog, while minimax-cn is — even though both now have profiles.
    const rowCard = (name: string) => dialog.locator('li').filter({ hasText: name }).first()
    await expect.poll(async () => rowCard('Acme Gateway').getByText('Custom').count(), { timeout: 10_000 }).toBe(1)
    expect(await rowCard('minimax-cn').getByText('Custom').count()).toBe(0)

    const snapshot = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(DECLARED_EXPECTED, snapshot, MODE)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('selects and clears the discovered model catalog in one action', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-models-picker'))
    const settingsDialog = page.getByRole('dialog', { name: 'Settings' })
    await settingsDialog.getByRole('button', { name: 'Edit Acme Gateway (acme-gateway)' }).click()
    await settingsDialog.getByText('Customized settings').click()
    await settingsDialog.getByLabel('Base URL').fill(catalogUrl)
    await settingsDialog.getByRole('button', { name: 'Fetch' }).click()

    const picker = page.getByRole('dialog', { name: 'Choose models to add' })
    await picker.waitFor({ timeout: 10_000 })
    expect(await picker.getByRole('columnheader').allTextContents()).toEqual(['Model ID', 'Model name', 'Image', 'Video'])
    expect(await picker.getByRole('textbox', { name: 'Model name MiniMax-M2.7', exact: true }).inputValue()).toBe('MiniMax M2.7')
    const unnamed = picker.getByRole('textbox', { name: 'Model name MiniMax-M3', exact: true })
    expect(await unnamed.inputValue()).toBe('')
    expect(await unnamed.getAttribute('placeholder')).toBe('')
    const boxes = picker.getByRole('checkbox', { name: /^MiniMax-/ })
    const count = await boxes.count()
    expect(count).toBeGreaterThan(0)
    expect(await boxes.evaluateAll(nodes => nodes.map(node => (node as HTMLInputElement).checked))).toEqual(
      Array.from({ length: count }, () => true),
    )

    await picker.getByRole('button', { name: 'Deselect all' }).click()
    expect(await boxes.evaluateAll(nodes => nodes.map(node => (node as HTMLInputElement).checked))).toEqual(
      Array.from({ length: count }, () => false),
    )
    await picker.getByRole('button', { name: 'Select all' }).waitFor()
    await picker.getByRole('checkbox', { name: 'Image MiniMax-M3', exact: true }).check()
    const snapshot = await captureStableAria(
      page,
      '[role="dialog"][aria-label="Choose models to add"]',
      scaffold.workspaceCwd,
    )
    await compareOrRefreshGolden(MODEL_PICKER_EXPECTED, snapshot, MODE)

    await picker.getByRole('button', { name: 'Select all' }).click()
    expect(await picker.getByRole('checkbox', { name: 'Image MiniMax-M3', exact: true }).isChecked()).toBe(true)
    expect(await boxes.evaluateAll(nodes => nodes.map(node => (node as HTMLInputElement).checked))).toEqual(
      Array.from({ length: count }, () => true),
    )
    const shots = join(REPO_ROOT, '.artifacts', 'model-fetch-picker')
    await mkdir(shots, { recursive: true })
    for (const theme of ['Light', 'Dark']) {
      if (theme === 'Dark') {
        await picker.getByRole('button', { name: 'Cancel', exact: true }).click()
        await settingsDialog.getByRole('button', { name: 'General', exact: true }).click()
        await settingsDialog.getByRole('button', { name: theme, exact: true }).click()
        await expect.poll(() => page.locator('body').getAttribute('data-ds-dark-theme')).toBe('')
        await settingsDialog.getByRole('button', { name: 'Models', exact: true }).click()
        await settingsDialog.getByRole('button', { name: 'Edit Acme Gateway (acme-gateway)' }).click()
        await settingsDialog.getByText('Customized settings').click()
        await settingsDialog.getByLabel('Base URL').fill(catalogUrl)
        await settingsDialog.getByRole('button', { name: 'Fetch' }).click()
        await picker.waitFor()
      }
      for (const width of [1680, 560]) {
        await page.setViewportSize({ width, height: 1000 })
        await expect.poll(() => picker.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
        if (width === 1680) expect((await picker.boundingBox())!.width).toBeGreaterThan(700)
        await page.screenshot({ path: join(shots, `${theme.toLowerCase()}-${width}.png`) })
        await picker.screenshot({ path: join(shots, `picker-${theme.toLowerCase()}-${width}.png`) })
      }
      await page.setViewportSize({ width: 1680, height: 1000 })
    }
    await unnamed.fill('My M3')
    await picker.getByRole('checkbox', { name: 'Image MiniMax-M3', exact: true }).check()
    await picker.getByRole('button', { name: 'Add selected', exact: true }).click()
    expect(await settingsDialog.getByLabel('Display name 4', { exact: true }).inputValue()).toBe('My M3')
    await settingsDialog.getByLabel('Model details 4', { exact: true }).click()
    expect(await settingsDialog.getByRole('checkbox', { name: 'Image MiniMax-M3', exact: true }).isChecked()).toBe(true)
    expect(await readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8')).not.toContain('My M3')
    await settingsDialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  }, 60_000)

  it('reopens the name and protocol a declared route was created with', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-models-declared-identity'))
    const dialog = page.getByRole('dialog', { name: 'Settings' })
    await dialog.getByRole('button', { name: 'Edit Acme Gateway (acme-gateway)' }).click()
    await dialog.getByText('Customized settings').click()
    // The create card asked this route for a name and a protocol because
    // nothing can default them; the editor reaches the same two fields rather
    // than sending the user to settings.yaml for what only this route names.
    const protocol = dialog.getByLabel('API protocol')
    await protocol.waitFor({ timeout: 10_000 })
    expect(await protocol.inputValue()).toBe('openai-completions')
    const name = dialog.getByLabel('Display name', { exact: true })
    expect(await name.inputValue()).toBe('Acme Gateway')
    expect(await dialog.getByRole('combobox', { name: /^Model use/ }).count()).toBe(0)
    await dialog.getByRole('button', { name: 'Model details 1', exact: true }).click()
    const output = dialog.getByLabel('Max output tokens 1', { exact: true })
    expect(await output.inputValue()).toBe('')
    expect(await output.getAttribute('placeholder')).toBe('Unlimited')
    await output.scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(REPO_ROOT, '.artifacts', 'unlimited-output-settings.png') })
    const snapshot = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(DECLARED_EDIT_EXPECTED, snapshot, MODE)

    const shots = join(REPO_ROOT, '.artifacts', 'models-without-use')
    await mkdir(shots, { recursive: true })
    for (const theme of ['Light', 'Dark']) {
      await dialog.getByRole('button', { name: 'General', exact: true }).click()
      await dialog.getByRole('button', { name: theme, exact: true }).click()
      await expect.poll(() => page.locator('body').getAttribute('data-ds-dark-theme')).toBe(theme === 'Dark' ? '' : null)
      await dialog.getByRole('button', { name: 'Models', exact: true }).click()
      await dialog.getByRole('button', { name: 'Edit Acme Gateway (acme-gateway)' }).click()
      await dialog.getByText('Customized settings').click()
      await dialog.getByLabel('Model ID 1').scrollIntoViewIfNeeded()
      await page.screenshot({ path: join(shots, `${theme.toLowerCase()}.png`) })
      for (const width of [1680, 720, 560]) {
        await page.setViewportSize({ width, height: 1000 })
        const catalog = dialog.getByRole('region', { name: 'Models', exact: true })
        const actions = catalog.getByRole('button').filter({ hasText: /Restore|Get all|Fetch/ })
        expect(await actions.count()).toBe(3)
        const geometry = await actions.evaluateAll(nodes => nodes.map((node) => {
          const bounds = node.getBoundingClientRect()
          return { top: bounds.top, height: bounds.height, fill: getComputedStyle(node).backgroundColor }
        }))
        expect(Math.max(...geometry.map(action => action.top)) - Math.min(...geometry.map(action => action.top))).toBeLessThan(1)
        expect(new Set(geometry.map(action => action.height)).size).toBe(1)
        expect(new Set(geometry.map(action => action.fill)).size).toBe(3)
        const hints = [
          'Restore the default model catalog. Apply to save.',
          'Fetch every available model and add it to the draft. Apply to save.',
          'Fetch available models and choose which ones to add. Apply to save.',
        ]
        for (const [index, action] of (await actions.all()).entries()) {
          await action.hover()
          expect(await action.getAttribute('title')).toBe(hints[index])
        }
        await page.screenshot({ path: join(shots, `${theme.toLowerCase()}-hover-${width}.png`) })
        await catalog.screenshot({ path: join(shots, `${theme.toLowerCase()}-catalog-${width}.png`) })
        expect(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
        expect(await catalog.getByRole('checkbox').evaluateAll(inputs => inputs.every((input) => {
          const bounds = input.getBoundingClientRect()
          const row = input.closest('[class*="modelRow"]')!.getBoundingClientRect()
          return bounds.left >= row.left && bounds.right <= row.right
        }))).toBe(true)
        expect(await actions.evaluateAll(nodes => nodes.map((node) => {
          const range = globalThis.document.createRange()
          range.selectNodeContents(node)
          const text = range.getBoundingClientRect()
          const button = node.getBoundingClientRect()
          const section = node.closest('section')!.getBoundingClientRect()
          return {
            label: node.textContent,
            fits: text.top >= button.top && text.bottom <= button.bottom
              && text.left >= button.left && text.right <= button.right
              && button.left >= section.left && button.right <= section.right,
          }
        }))).toEqual([
          { label: 'Restore', fits: true },
          { label: 'Get all', fits: true },
          { label: 'Fetch', fits: true },
        ])
      }
      await page.setViewportSize({ width: 1680, height: 1000 })
    }
    await page.setViewportSize({ width: 720, height: 900 })
    await dialog.getByLabel('Model ID 1').scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(shots, 'narrow.png') })
    await page.setViewportSize({ width: 1680, height: 1000 })

    await protocol.selectOption('anthropic-messages')
    await name.fill('Renamed Acme Gateway')
    await dialog.getByRole('region', { name: 'API keys', exact: true }).getByRole('button', { name: 'Apply', exact: true }).click()
    await expect.poll(async () => dialog.getByLabel('API protocol').count(), { timeout: 10_000 }).toBe(0)
    // The adapter re-resolved the route under the new protocol and re-registered
    // it under the new name: an unserviceable profile would have been refused
    // at the write instead, and a rename that did not re-register would leave
    // the old label on the row.
    await dialog.getByText('Renamed Acme Gateway', { exact: true }).first().waitFor({ timeout: 10_000 })
    // The status line names the route as the refreshed directory reports it;
    // the target captured when the card opened still carries the old name.
    await dialog.getByText('Saved Renamed Acme Gateway (acme-gateway).', { exact: true }).waitFor({ timeout: 10_000 })
    const document = await readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8')
    expect(document).toContain('api: anthropic-messages')
    expect(document).toContain('displayName: Renamed Acme Gateway')
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('removes a provider profile and owned API key while preserving its SDK credential record', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-models-delete'))
    const recordKey = credentialKey('llm-pi-ai', 'minimax-cn')
    await scaffold.ctx.credentials.modifyRecord(recordKey, async () => ({ kind: 'api-key', key: 'sk-sdk-minimax-stored' }))
    const settingsDialog = page.getByRole('dialog', { name: 'Settings' })
    await settingsDialog.getByRole('button', { name: 'Delete minimax-cn', exact: true }).click()
    const deleteDialog = page.getByRole('dialog', { name: 'Delete minimax-cn?' })
    await deleteDialog.waitFor({ timeout: 10_000 })
    const snapshot = await captureStableAria(
      page,
      '[role="dialog"][aria-label="Delete minimax-cn?"]',
      scaffold.workspaceCwd,
    )
    await compareOrRefreshGolden(DELETE_EXPECTED, snapshot, MODE)

    await deleteDialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    expect(await readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8')).toContain('minimax-cn:')
    expect(await scaffold.ctx.credentials.readRecord(recordKey)).toMatchObject({ kind: 'api-key', key: 'sk-sdk-minimax-stored' })
    // A second process can still hold the provider before the UI deletes it.
    peer = new Context()
    await peer.plugin(FileSettingsProvider, { hydraHome: scaffold.harnessHome, watch: false })
    const ns = settingsNamespace('llm-pi-ai')
    peer.settings.register(ns, PiAiConfig)
    await settingsDialog.getByRole('button', { name: 'Delete minimax-cn', exact: true }).click()
    await page.getByRole('dialog', { name: 'Delete minimax-cn?' })
      .getByRole('button', { name: 'Delete minimax-cn', exact: true }).click()
    await expect.poll(
      async () => readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8'),
      { timeout: 10_000 },
    ).not.toContain('minimax-cn:')
    expect(await readFile(join(scaffold.harnessHome, '.credentials.yaml'), 'utf8'))
      .not.toContain('MINIMAX_CN_API_KEY')
    expect(await scaffold.ctx.credentials.readRecord(recordKey)).toMatchObject({ kind: 'api-key', key: 'sk-sdk-minimax-stored' })
    const credentialsAfter = await readFile(join(scaffold.harnessHome, '.credentials.yaml'), 'utf8')
    expect(credentialsAfter).toContain('llm-pi-ai/minimax-cn')
    expect(credentialsAfter).toContain('sk-sdk-minimax-stored')
    await expect.poll(
      async () => page.getByRole('dialog', { name: 'Delete minimax-cn?' }).count(),
      { timeout: 10_000 },
    ).toBe(0)

    await peer.settings.mutate(ns, [{
      op: 'set', path: ['providers', 'acme-gateway', 'baseURL'], value: 'https://updated.acme.example/v1',
    }])
    const document = await readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8')
    expect(document).not.toContain('minimax-cn:')
    expect(document).toContain('https://updated.acme.example/v1')
    await expect.poll(() => scaffold.ctx.settings.get(ns)).toMatchObject({
      providers: { 'acme-gateway': { baseURL: 'https://updated.acme.example/v1' } },
    })
    await expect.poll(() => scaffold.ctx.llm.listProviders().map(provider => provider.id)).not.toContain('minimax-cn')

    await page.reload()
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const reopened = page.getByRole('dialog', { name: 'Settings' })
    await reopened.getByRole('button', { name: 'Models', exact: true }).click()
    await reopened.getByRole('button', { name: 'Edit Renamed Acme Gateway (acme-gateway)' }).waitFor()
    expect(await reopened.getByRole('button', { name: 'Edit minimax-cn', exact: true }).count()).toBe(0)
    await expect.poll(() => reopened.getByRole('button', { name: 'Refresh models', exact: true }).isEnabled()).toBe(true)
    await compareOrRefreshGolden(DELETED_EXPECTED,
      await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd), MODE)
    await page.keyboard.press('Escape')
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it.skipIf(MODE === 'record')('keeps the fixture inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, [
      'configured.expected.md', 'declared-edit.expected.md', 'declared.expected.md',
      'delete.expected.md', 'deleted.expected.md', 'empty.expected.md', 'model-picker.expected.md',
      'native-delete.expected.md',
    ])
  })
})

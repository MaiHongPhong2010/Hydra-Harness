// Assembled Web coverage for the optional Jev provider contribution.
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import type { Browser, Locator, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed, vi } from 'vitest'
import { credentialRef } from '@hydraharness/harness-credentials'
import { CallId } from '@hydraharness/harness-llm'
import { SessionId } from '@hydraharness/harness-session'
import type {} from '@hydraharness/harness-jev'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold, watchConsole,
  webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/jev-provider', import.meta.url))
const UI_EXPECTED = join(SNAPSHOT_DIR, 'ui.expected.md')
const SAVED_EXPECTED = join(SNAPSHOT_DIR, 'saved.expected.md')
const OVERLAY = fileURLToPath(new URL('./jev-provider.overlay.yml', import.meta.url))
const MODE = webSnapshotMode()

async function openModels(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await dialog.waitFor({ timeout: 10_000 })
  await dialog.getByRole('button', { name: 'Models', exact: true }).click()
  await dialog.getByText('Sign in with your accounts or enter API keys to use models from these providers.', { exact: true })
    .waitFor({ timeout: 10_000 })
  await expect.poll(() => dialog.getByRole('region', { name: 'Image and video generation', exact: true })
    .getByRole('button', { name: 'Refresh models', exact: true }).isEnabled()).toBe(true)
  return dialog
}

describe('web e2e: optional Jev provider', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY })
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: 'en-US' })
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    expect(tripwire?.warnings ?? []).toEqual([])
    expect(tripwire?.pageErrors ?? []).toEqual([])
    await browser?.close()
    await scaffold?.close()
  })

  it('adds Jev to the Models provider dropdown without a credential', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-jev-provider'))
    const dialog = await openModels(page)
    const apiKeys = dialog.getByRole('region', { name: 'API keys', exact: true })
    await apiKeys.getByRole('button', { name: 'Add provider', exact: true }).click()
    const provider = apiKeys.getByLabel('Provider', { exact: true })
    expect(await provider.locator('option').allTextContents()).toContain('Jev')
    await provider.selectOption('plugin:jev')
    await apiKeys.getByRole('heading', { name: 'Jev', exact: true }).waitFor({ timeout: 10_000 })
    expect(await apiKeys.getByLabel('API key', { exact: true }).inputValue()).toBe('')
    await compareOrRefreshGolden(
      UI_EXPECTED,
      await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd),
      MODE,
    )
  })

  async function saveKey(key: string): Promise<void> {
    const dialog = page.getByRole('dialog', { name: 'Settings' })
    if (!await dialog.isVisible().catch(() => false)) await openModels(page)
    const region = page.getByRole('region', { name: 'API keys', exact: true })
    if (await region.getByLabel('Provider', { exact: true }).count() === 0) {
      await region.getByRole('button', { name: 'Add provider', exact: true }).click()
    }
    await region.getByLabel('Provider', { exact: true }).selectOption('plugin:jev')
    await region.getByLabel('API key', { exact: true }).fill(key)
    await region.getByRole('button', { name: 'Apply', exact: true }).click()
    await expect.poll(() => region.getByRole('heading', { name: 'Jev', exact: true }).count()).toBe(0)
    await region.getByRole('button', { name: 'Edit Jev', exact: true }).waitFor()
    const resolved = await scaffold.ctx.credentials.resolve(credentialRef('HYDRA_JEV_UI_TEST_KEY'))
    expect(resolved?.value === key).toBe(true)
    expect((await readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8')).includes(key)).toBe(false)
  }

  it('saves the UI credential through the real Host and supplies it to the provider', async () => {
    await saveKey('jev-ui-fixture')
    const originalFetch = globalThis.fetch
    let sent = false
    const mock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (input !== 'https://www.jevai.org/api/v1/decisions') return originalFetch(input, init)
      sent = new Headers(init?.headers).get('authorization') === 'Bearer jev-ui-fixture'
      return Response.json({ code: 0, message: 'ok', data: {
        answers: { visible: { type: 'noul', noul: 0.99 } },
      } })
    })
    try {
      const result = await scaffold.ctx.jev.systemOne({ state: 'Continue button visible',
        questions: { visible: { type: 'noul', instructions: 'Is the button visible?' } } })
      expect(result.answers.visible).toEqual({ type: 'noul', noul: 0.99 })
      expect(sent).toBe(true)
    } finally { mock.mockRestore() }
  })

  it('keeps the configured Jev row after reload and opens a write-only editor from it', async () => {
    await saveKey('jev-reload-fixture')
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    const dialog = await openModels(page)
    const region = dialog.getByRole('region', { name: 'API keys', exact: true })
    const edit = region.getByRole('button', { name: 'Edit Jev', exact: true })
    await edit.waitFor()
    expect(await region.getByRole('img', { name: 'API key configured' }).count()).toBe(1)
    await compareOrRefreshGolden(
      SAVED_EXPECTED,
      await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd),
      MODE,
    )
    await edit.click()
    expect(await region.getByLabel('Provider', { exact: true }).inputValue()).toBe('plugin:jev')
    expect(await region.getByLabel('API key', { exact: true }).inputValue()).toBe('')
    await region.getByRole('button', { name: 'Cancel', exact: true }).click()
    await scaffold.ctx.credentials.unset(credentialRef('HYDRA_JEV_UI_TEST_KEY'))
    await expect.poll(() => edit.count()).toBe(0)
  })

  it('routes the saved credential through the bundled browser decision consumer', async () => {
    await saveKey('jev-browser-fixture')
    const originalFetch = globalThis.fetch
    const mock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (input !== 'https://www.jevai.org/api/v1/decisions') return originalFetch(input, init)
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer jev-browser-fixture')
      return Response.json({ code: 0, message: 'ok', data: {
        answers: { decision: { type: 'choice', choice: 'continue', confidence: 0.93 } },
      } })
    })
    const handle = await scaffold.ctx.agents.create({ sessionId: SessionId('jev-browser-ui'),
      meta: { cwd: scaffold.workspaceCwd },
      setup: ctx => scaffold.ctx.agentPresets.mount(ctx).then(() => undefined),
    })
    try {
      const output = await scaffold.ctx.tools.execute({ agent: handle.agent, callId: CallId('jev-browser-ui-call'),
        name: 'browser_decide', arguments: { state: 'Continue button is visible.', question: 'How to read more?', choices: ['continue', 'stop'] },
        signal: new AbortController().signal })
      expect(output.isError).not.toBe(true)
      expect(JSON.stringify(output)).toContain('Jev chose continue (93% confidence).')
    } finally {
      await handle.dispose()
      mock.mockRestore()
    }
  })
})

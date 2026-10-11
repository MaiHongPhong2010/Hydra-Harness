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
  await dialog.getByText('Configure providers, API keys, model catalogs, and default models.', { exact: true })
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

  it('places Jev in Decision after the default and media selectors without a credential', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-jev-provider'))
    const dialog = await openModels(page)
    const decision = dialog.getByRole('region', { name: 'Decision model', exact: true })
    const labels = await dialog.getByRole('combobox').evaluateAll(elements => elements.slice(0, 4).map(element => element.getAttribute('aria-label')))
    expect(labels).toEqual(['Default model', 'Image model', 'Video model', 'Decision model'])
    expect(await decision.getByRole('combobox', { name: 'Decision model', exact: true }).inputValue()).toBe('jev')
    await dialog.getByRole('region', { name: 'API keys', exact: true }).getByRole('button', { name: 'Add provider', exact: true }).click()
    expect(await dialog.getByLabel('Provider', { exact: true }).locator('option').allTextContents()).not.toContain('Jev')
    await dialog.getByRole('button', { name: 'Accounts', exact: true }).click()
    await dialog.getByRole('button', { name: 'Models', exact: true }).click()
    await decision.getByRole('button', { name: 'Configure Jev', exact: true }).click()
    expect(await decision.getByLabel('API key', { exact: true }).inputValue()).toBe('')
    await compareOrRefreshGolden(
      UI_EXPECTED,
      await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd),
      MODE,
    )
  })

  async function saveKey(key: string): Promise<void> {
    const dialog = page.getByRole('dialog', { name: 'Settings' })
    if (!await dialog.isVisible().catch(() => false)) await openModels(page)
    const region = page.getByRole('region', { name: 'Decision model', exact: true })
    if (await region.getByLabel('API key', { exact: true }).count() === 0) {
      await region.getByRole('button', { name: 'Configure Jev', exact: true }).click()
    }
    await region.getByLabel('API key', { exact: true }).fill(key)
    await region.getByRole('button', { name: 'Apply', exact: true }).click()
    await expect.poll(() => region.getByLabel('API key', { exact: true }).count()).toBe(0)
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
    const region = dialog.getByRole('region', { name: 'Decision model', exact: true })
    const edit = region.getByRole('button', { name: 'Configure Jev', exact: true })
    await edit.waitFor()
    await region.getByText('API key configured', { exact: true }).waitFor()
    await compareOrRefreshGolden(
      SAVED_EXPECTED,
      await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd),
      MODE,
    )
    await edit.click()
    expect(await region.getByLabel('API key', { exact: true }).inputValue()).toBe('')
    await region.getByRole('button', { name: 'Cancel', exact: true }).click()
    await scaffold.ctx.credentials.unset(credentialRef('HYDRA_JEV_UI_TEST_KEY'))
    await region.getByText('API key missing', { exact: true }).waitFor()
  })

  it('routes the saved credential through the bundled browser decision consumer', async () => {
    await saveKey('jev-browser-fixture')
    const originalFetch = globalThis.fetch
    let calls = 0
    const mock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (input !== 'https://www.jevai.org/api/v1/decisions') return originalFetch(input, init)
      calls++
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
      const select = page.getByRole('combobox', { name: 'Decision model', exact: true })
      await select.selectOption('off')
      await page.getByText('Decision preference saved. Applies to new calls.', { exact: true }).waitFor()
      const disabled = await scaffold.ctx.tools.execute({ agent: handle.agent, callId: CallId('jev-off-call'),
        name: 'browser_decide', arguments: { state: 'Continue button is visible.', question: 'How to read more?', choices: ['continue', 'stop'] },
        signal: new AbortController().signal })
      expect(JSON.stringify(disabled)).toContain('Decision model is Off.')
      expect(calls).toBe(1)
      expect(await scaffold.ctx.credentials.resolve(credentialRef('HYDRA_JEV_UI_TEST_KEY'))).toBeDefined()
      await page.reload({ waitUntil: 'load' })
      await openModels(page)
      expect(await page.getByRole('combobox', { name: 'Decision model', exact: true }).inputValue()).toBe('off')
      await page.getByRole('combobox', { name: 'Decision model', exact: true }).selectOption('jev')
      await page.getByText('Decision preference saved. Applies to new calls.', { exact: true }).waitFor()

    } finally {
      await handle.dispose()
      mock.mockRestore()
    }
  })
})

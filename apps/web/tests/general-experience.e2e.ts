/** Keyless shipped Web assembly: suggestions fill drafts, optional policy, and live-only confetti. */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@hydraharness/harness-llm'
import { SessionId } from '@hydraharness/harness-session'
import { settingsNamespace } from '@hydraharness/harness-settings'
import type {} from '@hydraharness/harness-optional-plugins'
import type {} from '@hydraharness/harness-commands'
import { assertFixtureInventory, captureStableAria, compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode } from './scaffold.ts'

const GOLDENS = fileURLToPath(new URL('./snapshots/general-experience/', import.meta.url))

it('keeps private standalone roots out of the project picker', async () => {
  const scaffold = await launchWebScaffold({})
  const browser = await chromium.launch()
  const page = await browser.newPage({ locale: 'en-US' })
  const consoleState = watchConsole(page)
  try {
    await page.goto(scaffold.baseUrl)
    await page.getByRole('button', { name: 'Standard mode', exact: true }).waitFor()
    await compareOrRefreshGolden(join(GOLDENS, 'projectless-picker.expected.md'),
      await captureStableAria(page, 'button[aria-label="Choose workspace"]', scaffold.workspaceCwd), webSnapshotMode())
    await page.getByRole('button', { name: 'Choose workspace', exact: true }).click()
    const directory = page.getByRole('dialog', { name: 'Select Workspace Directory', exact: true })
    await directory.waitFor()
    expect(await page.getByRole('menuitem', { name: 'Standalone chat', exact: true }).count()).toBe(0)
    await page.keyboard.press('Escape')
    await directory.waitFor({ state: 'hidden' })
    expect(await page.locator('textarea').first().inputValue()).toBe('')
    expect(consoleState.pageErrors).toEqual([])
    expect(consoleState.warnings).toEqual([])
  } finally {
    await browser.close()
    await scaffold.close()
  }
})

it('uses bounded suggestions as drafts and fires confetti only for a live opted-in command', async () => {
  const scaffold = await launchWebScaffold({})
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, locale: 'en-US' })
  const tripwire = watchConsole(page)
  class SuggestionAdapter extends LlmAdapter {
    readonly requests: GenerateOptions[] = []
    override providerInfo(provider: string) { return { id: provider, name: 'General fixture' } }
    override listModels(provider: string) { return Promise.resolve([{ provider, id: 'fixture', name: 'Fixture' }]) }
    override resolveModel(provider: string, model: string) { return Promise.resolve({ provider, id: model, name: model }) }
    override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
      expect(request.system).toMatch(/^Return a JSON array/)
      expect(this.requests.length).toBeLessThan(2)
      this.requests.push(request)
      yield { type: 'text-delta', index: 0, text: '["Explain this project","Run its tests"]' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  const adapter = new SuggestionAdapter()
  scaffold.ctx.llm.registerAdapter(['general-fixture'], adapter)
  try {
    await mkdir(GOLDENS, { recursive: true })
    await writeFile(join(scaffold.workspaceCwd, 'README.md'), 'A small project with a test runner.')
    await scaffold.ctx.settings.update(settingsNamespace('agent-default-model'), { provider: 'general-fixture', model: 'fixture' })
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const created = await (await fetch(`${scaffold.baseUrl}/api/session.create`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', method: 'session.create', rpcId: 'general-created', payload: { workspaceId: workspace.id } }),
    })).json() as { result: { ok: boolean; value: { sessionId: string } } }
    expect(created.result).toMatchObject({ ok: true })
    await page.goto(`${scaffold.baseUrl}?session=${encodeURIComponent(created.result.value.sessionId)}`, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]')
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Settings', exact: true })
    await dialog.getByRole('switch', { name: 'Suggested prompts', exact: true }).click()
    await expect.poll(() => adapter.requests.length).toBe(1)
    await page.keyboard.press('Escape')
    const suggestion = page.getByRole('button', { name: 'Explain this project', exact: true })
    await suggestion.waitFor()
    await suggestion.click()
    expect(await page.locator('textarea').first().inputValue()).toBe('Explain this project')
    const id = SessionId(String(adapter.requests[0]!.sessionId))
    const agent = scaffold.ctx.agents.get(id)!
    expect(agent.session.events.some(event => event.type === 'user/message' || event.type === 'turn/start')).toBe(false)
    await compareOrRefreshGolden(join(GOLDENS, 'suggestions.expected.md'),
      await captureStableAria(page, '[aria-label="Suggested prompts"]', scaffold.workspaceCwd), webSnapshotMode())
    await page.getByRole('button', { name: 'Refresh suggestions', exact: true }).click()
    await expect.poll(() => adapter.requests.length).toBe(2)
    await suggestion.waitFor()
    await compareOrRefreshGolden(join(GOLDENS, 'suggestions-log.expected.md'), JSON.stringify(agent.session.events
      .filter(event => event.type.startsWith('suggestions/')).map(event => ({ type: event.type, data: event.data })), null, 2), webSnapshotMode())

    await scaffold.ctx.settings.update(settingsNamespace('toys'), { confetti: true })
    const input = page.locator('textarea').first()
    await input.fill('/confetti')
    await input.press('Enter')
    await page.locator('[aria-hidden="true"]:has(> i[style*="--duration"])').first().waitFor()
    await expect.poll(() => agent.session.events.filter(event => event.type === 'command/done').length).toBe(1)
    await compareOrRefreshGolden(join(GOLDENS, 'confetti-log.expected.md'), JSON.stringify(agent.session.events
      .filter(event => event.type === 'command/done').map(event => ({ type: event.type, kind: event.data.kind, text: event.data.text })), null, 2), webSnapshotMode())
    await expect.poll(() => page.locator('[aria-hidden="true"]:has(> i[style*="--duration"])').count(), { timeout: 5000 }).toBe(0)
    await page.reload()
    await page.waitForSelector('[class*="frame"]')
    expect(await page.locator('[aria-hidden="true"]:has(> i[style*="--duration"])').count()).toBe(0)
    expect(adapter.requests).toHaveLength(2)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.locator('textarea').first().fill('/confetti')
    await page.locator('textarea').first().press('Enter')
    await expect.poll(() => agent.session.events.filter(event => event.type === 'command/done').length).toBe(2)
    expect(await page.locator('[aria-hidden="true"]:has(> i[style*="--duration"])').count()).toBe(0)
    await page.emulateMedia({ reducedMotion: 'no-preference' })

    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await dialog.getByRole('switch', { name: 'Plugins', exact: true }).click()
    await expect.poll(() => scaffold.ctx.optionalPlugins.enabled).toBe(false)
    expect(() => scaffold.ctx.optionalPlugins.acquire()).toThrow('disabled')
    await expect.poll(() => dialog.getByRole('switch', { name: 'Suggested prompts', exact: true }).count()).toBe(0)
    await page.reload()
    await page.waitForSelector('[class*="frame"]')
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    expect(await dialog.getByRole('switch', { name: 'Suggested prompts', exact: true }).count()).toBe(0)
    await dialog.getByRole('switch', { name: 'Plugins', exact: true }).click()
    await expect.poll(() => scaffold.ctx.optionalPlugins.enabled).toBe(true)
    await dialog.getByRole('switch', { name: 'Suggested prompts', exact: true }).waitFor()
    expect(await dialog.getByRole('switch', { name: 'Suggested prompts', exact: true }).getAttribute('aria-checked')).toBe('true')
    await dialog.getByRole('button', { name: 'Standard mode', exact: true }).waitFor()
    expect(tripwire.pageErrors).toEqual([])
    await assertFixtureInventory(GOLDENS, ['suggestions.expected.md', 'suggestions-log.expected.md', 'confetti-log.expected.md', 'projectless-picker.expected.md'])
    await dialog.getByRole('heading', { name: 'General', exact: true, level: 1 }).evaluate((node) => { node.scrollIntoView() })
    await mkdir('.artifacts/general-experience', { recursive: true })
    await page.screenshot({ path: '.artifacts/general-experience/light.png', animations: 'disabled' })
    await dialog.getByRole('button', { name: 'Dark', exact: true }).click()
    await expect.poll(() => page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'))).toBe(true)
    await page.screenshot({ path: '.artifacts/general-experience/dark.png', animations: 'disabled' })
    await page.setViewportSize({ width: 560, height: 700 })
    await page.screenshot({ path: '.artifacts/general-experience/narrow.png', animations: 'disabled' })
  } finally { await browser.close(); await scaffold.close() }
}, 120000)

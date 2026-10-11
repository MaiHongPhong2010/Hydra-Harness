/** Keyless Settings regressions over the real Host and browser composition. */
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@hydraharness/cordis'
import Schema from '@hydraharness/schemastery'
import FileSettingsProvider from '@hydraharness/harness-settings-file'
import { settingsNamespace } from '@hydraharness/harness-settings'
import { LocalMemoryStore } from '@hydraharness/harness-personalization'
import { load as parseYaml } from 'js-yaml'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/settings-regressions', import.meta.url))
const MODE = webSnapshotMode()

describe('web e2e: Settings drafts and dialog interaction', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let consoleState: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    if (MODE !== 'replay') await mkdir(SNAPSHOT_DIR, { recursive: true })
    scaffold = await launchWebScaffold({})
    browser = await chromium.launch()
  })
  beforeEach(async () => {
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: 'en-US' })
    page.setDefaultTimeout(10_000)
    consoleState = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
  })
  afterEach(async () => {
    await page?.close()
    expect(consoleState.pageErrors).toEqual([])
    expect(consoleState.warnings).toEqual([])
  })
  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('Escape closes the nested MCP editor while retaining Settings', async () => {
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
    await settings.getByRole('button', { name: 'Plugins', exact: true }).click()
    await settings.getByRole('tab', { name: 'MCP', exact: true }).click()
    await settings.getByRole('button', { name: 'Add server', exact: true }).click()
    const nested = page.getByRole('dialog', { name: 'Add MCP server', exact: true })
    await nested.getByLabel('Name', { exact: true }).fill('unsaved-audit')
    await page.keyboard.press('Escape')
    await nested.waitFor({ state: 'hidden' })
    expect(await settings.isVisible()).toBe(true)
    expect(await settings.getByRole('button', { name: 'Add server', exact: true }).evaluate(el => el === document.activeElement)).toBe(true)
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'nested-dismiss.expected.md'),
      await captureStableAria(page, '[role="tabpanel"]:not([hidden])', scaffold.workspaceCwd), MODE)
    await page.keyboard.press('Escape')
    await settings.waitFor({ state: 'hidden' })
    expect(await page.getByRole('button', { name: 'Settings', exact: true }).evaluate(el => el === document.activeElement)).toBe(true)
  })

  it('Tab keeps focus within the Settings modal', async () => {
    const outside: string[] = []
    for (let i = 0; i < 50; i++) {
      await page.keyboard.press(i < 25 ? 'Tab' : 'Shift+Tab')
      const focused = await page.evaluate(() => {
        const active = document.activeElement
        if (active?.closest('[role="dialog"]')) return null
        return active?.outerHTML.slice(0, 1500) ?? 'none'
      })
      if (focused !== null) { outside.push(focused); break }
    }
    expect(outside).toEqual([])
    await page.getByRole('button', { name: 'Settings', exact: true }).evaluate((el) => { el.focus() })
    expect(await page.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null)).toBe(true)
  })

  it('keeps the Language menu inside Settings and dismisses the menu first', async () => {
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
    await settings.getByRole('button', { name: 'Auto', exact: true }).click()
    const menu = settings.getByRole('menu')
    await menu.waitFor()
    const english = menu.getByRole('menuitem', { name: 'English', exact: true })
    await english.focus()
    expect(await english.evaluate(el => el === document.activeElement)).toBe(true)
    await page.keyboard.press('Escape')
    await menu.waitFor({ state: 'hidden' })
    expect(await settings.isVisible()).toBe(true)
  })

  it('retains instructions edited while a save request is pending', async () => {
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
    await settings.getByRole('button', { name: 'Personalization', exact: true }).click()
    await settings.locator('summary').filter({ hasText: 'Custom instructions' }).click()
    const input = settings.locator('textarea')
    await input.fill('Submitted instructions')
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const pattern = '**/api/settings.writeInstructions'
    await page.route(pattern, async (route) => {
      entered.resolve(undefined)
      await release.promise
      await route.continue()
    })
    try {
      await settings.getByRole('button', { name: 'Save', exact: true }).click()
      await entered.promise
      await input.fill('Newer unsaved instructions')
      release.resolve(undefined)
      await settings.getByRole('button', { name: 'Save', exact: true }).waitFor()
      expect(await readFile(join(scaffold.harnessHome, 'AGENTS.md'), 'utf8')).toBe('Submitted instructions')
      expect(await input.inputValue()).toBe('Newer unsaved instructions')
      expect(await settings.getByRole('button', { name: 'Save', exact: true }).isEnabled()).toBe(true)
      await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'pending-instructions.expected.md'),
        await captureStableAria(page, '[role="dialog"] section:first-of-type', scaffold.workspaceCwd), MODE)
    } finally {
      release.resolve(undefined)
      await page.unroute(pattern)
    }
  }, 20_000)

  it('retains the instructions draft when visiting another Settings section', async () => {
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
    await settings.getByRole('button', { name: 'Personalization', exact: true }).click()
    await settings.locator('summary').filter({ hasText: 'Custom instructions' }).click()
    const input = settings.locator('textarea')
    await input.fill('Unsaved instructions across sections')
    await settings.getByRole('button', { name: 'General', exact: true }).click()
    await settings.getByRole('button', { name: 'Personalization', exact: true }).click()
    expect(await input.isVisible()).toBe(false)
    await settings.locator('summary').filter({ hasText: 'Custom instructions' }).click()
    await expect.poll(() => input.isEnabled()).toBe(true)
    expect(await input.inputValue()).toBe('Unsaved instructions across sections')
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'revisited-instructions.expected.md'),
      await captureStableAria(page, '[role="dialog"] section:first-of-type', scaffold.workspaceCwd), MODE)
  })

  it('keeps prompts collapsed on entry and saves a personality only on Save', async () => {
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
    await settings.getByRole('button', { name: 'Personalization', exact: true }).click()
    const prompts = settings.getByRole('region', { name: 'System prompts' })
    expect(await prompts.getByRole('textbox').isVisible()).toBe(false)
    expect(await prompts.getByRole('combobox').isVisible()).toBe(false)
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'collapsed-prompts.expected.md'),
      await captureStableAria(page, 'section[aria-label="System prompts"]', scaffold.workspaceCwd), MODE)
    await prompts.locator('summary').filter({ hasText: 'Personality' }).click()
    const tone = prompts.getByRole('combobox', { name: 'Personality' })
    const selected = await tone.inputValue() === 'friendly' ? 'none' : 'friendly'
    let writes = 0
    const routePattern = '**/api/settings.mutate'
    await page.route(routePattern, async (route) => { writes++; await route.continue() })
    try {
      await tone.selectOption(selected)
      await settings.getByRole('button', { name: 'General', exact: true }).click()
      await settings.getByRole('button', { name: 'Personalization', exact: true }).click()
      expect(await tone.isVisible()).toBe(false)
      await prompts.locator('summary').filter({ hasText: 'Personality' }).click()
      expect(await tone.inputValue()).toBe(selected)
      expect(writes).toBe(0)
      const saved = page.waitForResponse(response => response.url().endsWith('/api/settings.mutate') && response.ok())
      await prompts.getByRole('button', { name: 'Save', exact: true }).click()
      await saved
      await expect.poll(() => prompts.getByRole('button', { name: 'Save', exact: true }).isDisabled()).toBe(true)
      expect(writes).toBe(1)
      await page.screenshot({ path: join(SNAPSHOT_DIR, '../../../../../.artifacts/personalization-audit/personalization.png') })
    } finally {
      await page.unroute(routePattern)
    }
  })

  it('retries a rejected credential after the created provider appears, then probes cleared overrides', async () => {
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
    await settings.getByRole('button', { name: 'Models', exact: true }).click()
    await settings.getByRole('button', { name: 'Add a custom provider', exact: true }).click()
    await settings.getByLabel('Provider ID', { exact: true }).fill('settings-fixture')
    await settings.getByLabel('Base URL', { exact: true }).fill('https://old.invalid/v1')
    await settings.getByLabel('Proxy', { exact: true }).fill('http://old.invalid:8080')
    await settings.getByRole('textbox', { name: 'API key', exact: true }).fill('fixture-key')
    await settings.getByRole('button', { name: 'Add model', exact: true }).click()
    await settings.getByLabel('Model ID 1', { exact: true }).fill('fixture-model')
    const credentialRoute = '**/api/credentials.set'
    await page.route(credentialRoute, async (route) => {
      const request = route.request().postDataJSON() as { rpcId: string }
      await route.fulfill({ json: {
        type: 'server-response', rpcId: request.rpcId,
        result: { ok: false, error: { code: 'internal', message: 'Fixture key write refused', details: {} } },
      } })
    })
    try {
      await settings.getByRole('button', { name: 'Create provider', exact: true }).click()
      await settings.getByText('Fixture key write refused', { exact: true }).waitFor()
      await settings.getByText('settings-fixture', { exact: true }).first().waitFor()
      expect(await settings.getByRole('button', { name: 'Create provider', exact: true }).isEnabled()).toBe(true)
      await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'credential-retry.expected.md'),
        await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd), MODE)
    } finally {
      await page.unroute(credentialRoute)
    }
    await settings.getByRole('button', { name: 'Create provider', exact: true }).click()
    await settings.getByLabel('Provider ID', { exact: true }).waitFor({ state: 'hidden' })
    expect(await readFile(join(scaffold.harnessHome, '.credentials.yaml'), 'utf8')).toContain('fixture-key')
    await settings.getByRole('button', { name: 'Edit settings-fixture', exact: true }).click()
    await settings.getByText('Customized settings', { exact: true }).click()
    await settings.getByLabel('Base URL', { exact: true }).fill('')
    await settings.getByLabel('Proxy', { exact: true }).fill('')
    let probe: unknown
    const discoveryRoute = '**/api/llm.discoverModels'
    await page.route(discoveryRoute, async (route) => {
      const request = route.request().postDataJSON() as { rpcId: string; payload: unknown }
      probe = request.payload
      await route.fulfill({ json: {
        type: 'server-response', rpcId: request.rpcId, result: { ok: true, value: { models: [] } },
      } })
    })
    try {
      await settings.getByRole('button', { name: 'Fetch', exact: true }).click()
      await expect.poll(() => probe).toEqual({ settingsNs: 'llm-pi-ai', provider: 'settings-fixture', api: 'openai-completions' })
    } finally {
      await page.unroute(discoveryRoute)
    }
  }, 30_000)

  it('persists memory switches and deletion across section entry and an independent file read', async () => {
    const memories = new LocalMemoryStore(scaffold.harnessHome)
    const entry = await memories.add('Settings synchronization fixture')
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
    await settings.getByRole('button', { name: 'Personalization', exact: true }).click()
    const memory = settings.locator('section').filter({ has: page.getByRole('heading', { name: 'Memory', exact: true }) })
    const enabled = memory.getByRole('checkbox', { name: 'Enable memories', exact: true })
    if (!await enabled.isChecked()) await enabled.click()
    await expect.poll(() => memory.getByRole('checkbox', { name: 'Use saved memories in new chats', exact: true }).isEnabled()).toBe(true)
    for (const label of ['Use saved memories in new chats', 'Let new chats save explicit memories', 'Enable memories']) {
      const checkbox = memory.getByRole('checkbox', { name: label, exact: true })
      if (await checkbox.isChecked()) await checkbox.click()
      await expect.poll(() => checkbox.isChecked()).toBe(false)
    }
    const path = join(scaffold.harnessHome, 'settings.yaml')
    await expect.poll(async () => parseYaml(await readFile(path, 'utf8'))).toMatchObject({
      memory: { enabled: false, useMemories: false, generateMemories: false },
    })
    await memory.getByRole('listitem').filter({ hasText: entry.text }).getByRole('button', { name: 'Delete', exact: true }).click()
    await memory.getByText('No saved local memories.', { exact: true }).waitFor()
    expect(await new LocalMemoryStore(scaffold.harnessHome).list()).toEqual([])
    expect(await readFile(join(scaffold.harnessHome, 'memories', 'memories.json'), 'utf8')).not.toContain(entry.id)
    await settings.getByRole('button', { name: 'General', exact: true }).click()
    await settings.getByRole('button', { name: 'Personalization', exact: true }).click()
    expect(await memory.getByRole('checkbox', { name: 'Enable memories', exact: true }).isChecked()).toBe(false)
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'memory-persisted.expected.md'),
      await captureStableAria(page, '[role="dialog"] section:has(input[type="checkbox"])', scaffold.workspaceCwd), MODE)

    const reader = new Context()
    try {
      await reader.plugin(FileSettingsProvider, { path, watch: false })
      for (const descriptor of scaffold.ctx.settings.describe()) {
        const scope = reader.settings.register(descriptor.ns, new Schema(descriptor.schema as Schema),
          descriptor.base === undefined ? {} : { base: descriptor.base as object })
        expect(scope.get(), descriptor.ns).toEqual(descriptor.value)
      }
      await reader.settings.mutate(settingsNamespace('memory'), [{ op: 'set', path: ['enabled'], value: true }])
      await expect.poll(() => enabled.isChecked()).toBe(true)
      expect(await memory.getByRole('checkbox', { name: 'Use saved memories in new chats', exact: true }).isChecked()).toBe(false)
    } finally {
      await reader.fiber.dispose()
    }
  })
})

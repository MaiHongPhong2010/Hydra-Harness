/** Keyless browser regressions for record creation, retained tabs, and pending saves. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@hydraharness/cordis'
import FileSettingsProvider from '@hydraharness/harness-settings-file'
import { SettingsConflictError } from '@hydraharness/harness-settings'
import SystemPrompt from '@hydraharness/harness-system-prompt'
import ToolRuntime from '@hydraharness/harness-tools'
import McpServerRegistry from '@hydraharness/harness-mcp-registry'
import HookRecordRegistry from '@hydraharness/harness-hooks-registry'
import {
  acknowledgeReloadConnectionLoss, assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/plugin-settings-regressions', import.meta.url))
const MODE = webSnapshotMode()

describe('web e2e: plugin settings regressions', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let marketplaceRoot: string
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    if (MODE !== 'replay') await mkdir(SNAPSHOT_DIR, { recursive: true })
    scaffold = await launchWebScaffold({
      deepSeekSearch: { baseURL: 'https://example.invalid', apiKeyEnv: 'HYDRA_PLUGIN_REGRESSION_KEY' },
    })
    marketplaceRoot = join(scaffold.harnessHome, 'regression-marketplace')
    const pluginRoot = join(marketplaceRoot, 'plugins', 'regression-plugin')
    await mkdir(join(pluginRoot, '.codex-plugin'), { recursive: true })
    await mkdir(join(pluginRoot, 'skills', 'regression-skill'), { recursive: true })
    await writeFile(join(pluginRoot, '.codex-plugin', 'plugin.json'), JSON.stringify({
      name: 'regression-plugin', version: '1.0.0', description: 'Regression fixture', skills: './skills/',
    }))
    await writeFile(join(pluginRoot, 'skills', 'regression-skill', 'SKILL.md'),
      '---\nname: regression-skill\ndescription: Verify refreshed catalogs\n---\nFixture instructions.\n')
    await writeFile(join(marketplaceRoot, 'marketplace.json'), JSON.stringify({
      name: 'regression-marketplace',
      plugins: [{ name: 'regression-plugin', source: { source: 'local', path: './plugins/regression-plugin/' } }],
    }))
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: 'en-US' })
    page.setDefaultTimeout(10_000)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('dialog', { name: 'Settings', exact: true })
      .getByRole('button', { name: 'Plugins', exact: true }).click()
  })

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('keeps Obsidian MCP visible for a module-name search', async () => {
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
    const search = settings.getByRole('searchbox', { name: 'Search plugins, skills, hooks, marketplaces, and MCP servers', exact: true })
    await search.fill('kno')
    await settings.getByRole('tab', { name: 'MCP', exact: true }).click()
    await settings.getByText('Enabled', { exact: true }).waitFor()
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'native-mcp-search.expected.md'),
      await captureStableAria(page, '[role="tabpanel"]:not([hidden])', scaffold.workspaceCwd), MODE)
    await settings.getByRole('button', { name: 'Show settings: Obsidian MCP', exact: true }).waitFor()
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'native-mcp-search.expected.md'),
      await captureStableAria(page, '[role="tabpanel"]:not([hidden])', scaffold.workspaceCwd), MODE)
    await search.fill('no-matching-native-mcp')
    expect(await settings.getByText('Obsidian MCP', { exact: true }).count()).toBe(0)
    await search.fill('')
    await expect.poll(() => search.inputValue()).toBe('')
    await settings.getByRole('tab', { name: 'Configuration', exact: true }).click()
  })

  it('keeps an edit made while a submitted value crosses the real wire', async () => {
    const dialog = page.getByRole('dialog', { name: 'Settings', exact: true })
    await dialog.getByRole('tab', { name: 'Configuration', exact: true }).click()
    await dialog.getByText('Shell', { exact: true }).click()
    const timeout = dialog.getByLabel('Command timeout (ms)')
    await timeout.fill('12000')
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const routePattern = '**/api/settings.mutate'
    await page.route(routePattern, async (route) => {
      entered.resolve(undefined)
      await release.promise
      await route.continue()
    })
    try {
      await dialog.getByRole('button', { name: 'Save', exact: true }).click()
      await entered.promise
      await timeout.fill('13000')
      release.resolve(undefined)
      await expect.poll(async () => readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8'), { timeout: 5_000 })
        .toContain('timeoutMs: 12000')
      await expect.poll(() => dialog.getByRole('button', { name: 'Save', exact: true }).isEnabled()).toBe(true)
      expect(await timeout.inputValue()).toBe('13000')
      await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'pending-edit.expected.md'),
        await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd), MODE)
      await dialog.getByRole('button', { name: 'Discard', exact: true }).click()
      expect(await timeout.inputValue()).toBe('12000')
    } finally {
      release.resolve(undefined)
      await page.unroute(routePattern)
    }
  }, 30_000)

  it('retains a rejected replacement key even when a key is already configured', async () => {
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
    await settings.getByRole('button', { name: 'Web Search', exact: true }).click()
    const card = settings.getByRole('region', { name: 'Web Search', exact: true })
    await card.getByLabel('Search Provider').selectOption({ label: 'DeepSeek' })
    const key = card.getByLabel('API Key / Header Value', { exact: true })
    await key.fill('fixture-old-key')
    await card.getByRole('button', { name: 'Save', exact: true }).click()
    await card.getByText('Configured', { exact: true }).waitFor()
    await expect.poll(() => key.inputValue()).toBe('')
    const path = join(scaffold.harnessHome, '.credentials.yaml')
    const stored = await readFile(path, 'utf8')
    const routePattern = '**/api/credentials.set'
    await page.route(routePattern, async (route) => {
      const request = route.request().postDataJSON() as { rpcId: string }
      await route.fulfill({ json: {
        type: 'server-response', rpcId: request.rpcId,
        result: { ok: false, error: { code: 'internal', message: 'Fixture write refused' } },
      } })
    })
    try {
      await card.getByRole('button', { name: 'Replace', exact: true }).click()
      await key.fill('fixture-replacement-key')
      await card.getByRole('button', { name: 'Save', exact: true }).click()
      await card.getByRole('alert').filter({
        hasText: 'The deployment did not accept these values; they were left for you to correct.',
      }).waitFor()
      expect(await key.inputValue()).toBe('fixture-replacement-key')
      expect(await readFile(path, 'utf8')).toBe(stored)
      await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'rejected-key.expected.md'),
        await captureStableAria(page, 'section[aria-label="Web Search"]', scaffold.workspaceCwd), MODE)
    } finally {
      await page.unroute(routePattern)
      await card.getByRole('button', { name: 'Discard', exact: true }).click()
      await settings.getByRole('button', { name: 'Plugins', exact: true }).click()
    }
  })

  it.each([
    { tab: 'MCP', add: 'Add server', title: 'Add MCP server', save: 'Save server', name: 'regression-server', field: 'Command', value: 'original-command', duplicate: 'A server with this name already exists. Edit it or choose another name.' },
    { tab: 'Hooks', add: 'Add hooks', title: 'Add hooks', save: 'Save hooks', name: 'regression-hooks', field: 'Hook definitions (JSON)', value: '{"Stop":[{"hooks":[{"type":"command","command":"echo original-hook"}]}]}', duplicate: 'A hook record with this name already exists. Edit it or choose another name.' },
  ])('refuses duplicate $tab records without replacing the saved definition', async (fixture) => {
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
    await settings.getByRole('tab', { name: fixture.tab, exact: true }).click()
    await settings.getByRole('button', { name: fixture.add, exact: true }).click()
    const add = page.getByRole('dialog', { name: fixture.title, exact: true })
    await add.getByLabel('Name', { exact: true }).fill(fixture.name)
    await add.getByLabel(fixture.field, { exact: true }).fill(fixture.value)
    await add.getByRole('button', { name: fixture.save, exact: true }).click()
    await add.waitFor({ state: 'hidden' })
    const before = await readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8')
    await settings.getByRole('button', { name: fixture.add, exact: true }).click()
    await add.getByLabel('Name', { exact: true }).fill(fixture.name)
    await add.getByLabel(fixture.field, { exact: true }).fill(fixture.value.replace('original', 'replacement'))
    await add.getByRole('button', { name: fixture.save, exact: true }).click()
    await add.getByRole('alert').waitFor()
    expect(await add.getByRole('alert').textContent()).toBe(fixture.duplicate)
    expect(await readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8')).toBe(before)
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, `${fixture.tab.toLowerCase()}-duplicate.expected.md`),
      await captureStableAria(page, `[role="dialog"]:has(#user-${fixture.tab.toLowerCase()}-form)`, scaffold.workspaceCwd), MODE)
    await add.getByRole('button', { name: 'Cancel', exact: true }).click()
  })

  it('refreshes visited catalogs after importing and removing a marketplace', async () => {
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
    for (const tab of ['Plugins', 'Skills']) {
      await settings.getByRole('tab', { name: tab, exact: true }).click()
      await settings.getByText(tab === 'Skills' ? 'No skills supplied by imported plugins.' : 'No OpenAI/Codex plugins have been imported.', { exact: true }).waitFor()
    }
    await settings.getByRole('tab', { name: 'Marketplace', exact: true }).click()
    await settings.getByRole('button', { name: 'Add marketplace', exact: true }).click()
    const add = page.getByRole('dialog', { name: 'Add plugin marketplace', exact: true })
    await add.getByLabel('Source', { exact: true }).fill(marketplaceRoot)
    await add.getByLabel('Install this plugin now (optional)', { exact: true }).fill('regression-plugin')
    await add.getByRole('button', { name: 'Add marketplace', exact: true }).click()
    await add.waitFor({ state: 'hidden' })
    for (const tab of ['Plugins', 'Skills']) {
      await settings.getByRole('tab', { name: tab, exact: true }).click()
      await settings.getByRole('tabpanel', { name: tab, exact: true }).getByText('regression-plugin', { exact: true }).waitFor()
    }
    await settings.getByText('regression-skill', { exact: true }).waitFor()
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'refreshed-skills.expected.md'),
      await captureStableAria(page, '[role="tabpanel"]:not([hidden]) ul ul', scaffold.workspaceCwd), MODE)
    await settings.getByRole('tab', { name: 'Marketplace', exact: true }).click()
    await settings.getByRole('button', { name: 'Remove marketplace', exact: true }).click()
    await settings.getByText('No marketplaces have been added.', { exact: true }).waitFor()
    for (const tab of ['Plugins', 'Skills']) {
      await settings.getByRole('tab', { name: tab, exact: true }).click()
      await settings.getByText(tab === 'Skills' ? 'No skills supplied by imported plugins.' : 'No OpenAI/Codex plugins have been imported.', { exact: true }).waitFor()
      expect(await settings.getByRole('tabpanel', { name: tab, exact: true }).getByText('regression-plugin', { exact: true }).count()).toBe(0)
    }
  })

  it('shows a failed MCP list read and recovers with Retry', async () => {
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
    const routePattern = '**/*listImportedPlugins*'
    await page.route(routePattern, async (route) => {
      const request = route.request().postDataJSON() as { rpcId: string }
      await route.fulfill({ json: {
        type: 'server-response', rpcId: request.rpcId,
        result: { ok: false, error: { code: 'internal', message: 'Fixture list unavailable' } },
      } })
    })
    try {
      await settings.getByRole('tab', { name: 'MCP', exact: true }).click()
      await settings.getByText('MCP servers could not be loaded.', { exact: true }).waitFor()
      await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'mcp-load-failed.expected.md'),
        await captureStableAria(page, '[role="tabpanel"]:not([hidden])', scaffold.workspaceCwd), MODE)
    } finally {
      await page.unroute(routePattern)
    }
    await settings.getByRole('button', { name: 'Retry', exact: true }).click()
    await settings.getByText('MCP servers could not be loaded.', { exact: true }).waitFor({ state: 'hidden' })
    expect(await settings.getByRole('alert').count()).toBe(0)
  })

  it.each(['MCP', 'Hooks'] as const)('keeps a UI-deleted %s record absent across a stale writer and reload', async (tab) => {
    const path = join(scaffold.harnessHome, 'settings.yaml')
    const peer = new Context()
    try {
      await peer.plugin(FileSettingsProvider, { path, watch: false })
      await peer.plugin(SystemPrompt)
      await peer.plugin(ToolRuntime)
      await peer.plugin(McpServerRegistry)
      peer.provide('shell', scaffold.ctx.shell)
      await peer.plugin(HookRecordRegistry, { hydraHome: scaffold.harnessHome })
      const name = tab === 'MCP' ? 'regression-server' : 'regression-hooks'
      const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
      await settings.getByRole('tab', { name: tab, exact: true }).click()
      const selector = tab === 'MCP' ? 'data-user-mcp' : 'data-user-hook'
      const row = settings.locator(`[${selector}="${name}"]`)
      await row.getByRole('button', { name: 'Remove', exact: true }).click()
      await row.waitFor({ state: 'hidden' })
      const stored = await readFile(path, 'utf8')
      expect(stored).not.toContain(`name: ${name}`)
      const write = () => tab === 'MCP'
        ? peer.mcpServers.define({ mode: 'create', name: 'sync-kept', transport: 'stdio', command: 'fixture-command' })
        : peer.hookRecords.define({ mode: 'create', name: 'sync-kept', dialect: 'claude-code',
          config: { Stop: [{ hooks: [{ type: 'command', command: 'echo fixture' }] }] } })
      await expect(write()).rejects.toBeInstanceOf(SettingsConflictError)
      expect(await readFile(path, 'utf8')).toBe(stored)
      await write()
      expect(await readFile(path, 'utf8')).not.toContain(`name: ${name}`)
      const warningStart = tripwire.warnings.length
      await page.reload({ waitUntil: 'load' })
      acknowledgeReloadConnectionLoss(tripwire, warningStart)
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      await settings.getByRole('button', { name: 'Plugins', exact: true }).click()
      await settings.getByRole('tab', { name: tab, exact: true }).click()
      await settings.locator(`[${selector}="sync-kept"]`).waitFor()
      expect(await row.count()).toBe(0)
      await compareOrRefreshGolden(join(SNAPSHOT_DIR, `${tab.toLowerCase()}-deleted.expected.md`),
        await captureStableAria(page, `[${selector}="sync-kept"]`, scaffold.workspaceCwd), MODE)
    } finally {
      await peer.fiber.dispose()
    }
  })

  it('keeps the fixture inventory closed and the browser free of errors', async () => {
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, [
      'pending-edit.expected.md', 'mcp-duplicate.expected.md', 'hooks-duplicate.expected.md',
      'refreshed-skills.expected.md', 'rejected-key.expected.md', 'mcp-load-failed.expected.md',
      'mcp-deleted.expected.md', 'hooks-deleted.expected.md',
      'native-mcp-search.expected.md',
    ])
  })
})

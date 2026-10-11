// Web e2e scenarios: the settings surface — the modal shell (trigger, nav,
// section switching, both close paths), the Appearance preference row (the
// real theme gesture — click Dark and the whole cascade runs: ThemeRuntime preference -> Host settings
// -> theme/change -> ui-layout's presenter -> body attribute -> alias token +
// browser theme-color metadata)
// the Language row and busy-state Enter preference (both Host-backed), plus
// Permission as the persisted default for subsequently created sessions.
// Zero model calls: everything is pure client + persistence state on a blank
// frame, so there is no fixture and a stray stream would fail loud on the
// open llm seam.
import { mkdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, beforeEach, describe, expect, it, onTestFailed } from 'vitest'
import { join } from 'node:path'
import { load as parseYaml } from 'js-yaml'
import { SessionId } from '@hydraharness/harness-session'
import type PluginInventoryGateway from '@hydraharness/harness-host-plugin-inventory'
import {
  acknowledgeReloadConnectionLoss, assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/settings-chrome', import.meta.url))
const DIALOG_EXPECTED = join(SNAPSHOT_DIR, 'dialog.expected.md')
const MCP_EXPECTED = join(SNAPSHOT_DIR, 'mcp.expected.md')
const PLUGINS_EXPECTED = join(SNAPSHOT_DIR, 'plugins.expected.md')
const PLUGIN_TOGGLE_EXPECTED = join(SNAPSHOT_DIR, 'plugin-toggle.expected.md')
// The English fallback surface: a browser naming no shipped language.
const DIALOG_EN_EXPECTED = join(SNAPSHOT_DIR, 'dialog-en.expected.md')
const PLUGIN_ROW_SELECTOR = '[data-plugin-entry$="ui-settings"]'
const PLUGIN_TOGGLE_ROW_SELECTOR = '[data-plugin-entry$="command-feedback"]'
const MODE = webSnapshotMode()

describe('web e2e: settings modal and General preferences', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: 'en-US' })
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  beforeEach(async () => {
    if (await page.getByRole('dialog', { name: 'Settings', exact: true }).count() > 0) {
      await page.keyboard.press('Escape')
      await page.keyboard.press('Escape')
    }
  })

  it('opens the Usage settings section before any model calls', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-settings-usage'))
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Settings' })
    await dialog.getByRole('button', { name: 'Usage' }).click()
    await dialog.getByRole('heading', { name: 'Usage', exact: true }).waitFor({ timeout: 10_000 })
    await dialog.getByText('No token usage yet.', { exact: true }).waitFor({ timeout: 10_000 })
    await page.keyboard.press('Escape')
    expect(tripwire.pageErrors).toEqual([])
  }, 30_000)

  it('finds General contributions and sections and reports an empty search', async () => {
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Settings' })
    const search = dialog.getByRole('searchbox', { name: 'Search settings' })
    await search.fill('Send shortcut')
    await dialog.getByRole('combobox', { name: 'Send shortcut' }).waitFor()
    expect(await dialog.getByRole('heading', { name: 'Composer', exact: true }).count()).toBe(1)
    expect(await dialog.getByRole('heading', { name: 'Permissions', exact: true }).count()).toBe(0)
    await search.fill('Models')
    expect(await dialog.getByRole('button', { name: 'Models', exact: true }).count()).toBe(1)
    await search.fill('missing-setting-xyz')
    await dialog.getByRole('status').filter({ hasText: 'No matching settings' }).waitFor()
    await search.fill('')
    await page.keyboard.press('Escape')
    expect(tripwire.pageErrors).toEqual([])
  }, 30_000)

  it('keeps the expanded settings panel inside the viewport across sections', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-settings-size'))
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Settings' })
    const shots = join('.artifacts', 'settings-size')
    await mkdir(shots, { recursive: true })
    try {
      for (const viewport of [
        { width: 1680, height: 1000 },
        { width: 1040, height: 900 },
        { width: 720, height: 900 },
        { width: 560, height: 700 },
      ]) {
        await page.setViewportSize(viewport)
        for (const section of ['General', 'Models', 'Accounts', 'Plugins']) {
          await dialog.getByRole('button', { name: section, exact: true }).click()
          await expect.poll(async () => {
            const bounds = await dialog.boundingBox()
            return bounds && {
              width: bounds.width,
              height: bounds.height,
              x: bounds.x,
              y: bounds.y,
            }
          }).toEqual({
            width: Math.min(1080, viewport.width - 48),
            height: Math.min(900, viewport.height - 48),
            x: Math.max(24, (viewport.width - 1080) / 2),
            y: Math.max(24, (viewport.height - 900) / 2),
          })
        }
        await page.screenshot({ path: join(shots, `settings-${viewport.width}.png`) })
      }
      expect(tripwire.pageErrors).toEqual([])
    } finally {
      await page.keyboard.press('Escape')
      await page.setViewportSize({ width: 1680, height: 1000 })
    }
  }, 30_000)

  it('opens the settings dialog, switches sections, and closes by every path', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-settings-shell'))
    const trigger = page.getByRole('button', { name: 'Settings', exact: true })
    expect(await trigger.getAttribute('aria-haspopup')).toBe('dialog')
    expect(await trigger.getAttribute('aria-expanded')).toBe('false')
    await trigger.click()
    const dialog = page.getByRole('dialog', { name: 'Settings' })
    await dialog.waitFor({ timeout: 10_000 })
    expect(await trigger.getAttribute('aria-expanded')).toBe('true')
    // General is active by default; Permission, Language and Appearance are functional.
    expect(await dialog.getByRole('button', { name: 'General' }).getAttribute('aria-current')).toBe('true')
    await dialog.getByRole('button', { name: 'Edit' }).waitFor({ timeout: 10_000 })
    await expect.poll(() => dialog.getByText('Language', { exact: true }).count(), { timeout: 5_000 }).toBe(1)
    await expect.poll(() => dialog.getByText('Appearance', { exact: true }).count(), { timeout: 5_000 }).toBe(1)
    const openDocument = dialog.getByRole('button', { name: 'Open configuration file' })
    await openDocument.waitFor({ timeout: 10_000 })
    let openRequests = 0
    await page.route('**/api/settings.openDocument', async (route) => {
      const envelope = route.request().postDataJSON() as {
        rpcId: string
        payload: Record<string, never>
      }
      expect(envelope.payload).toEqual({})
      openRequests += 1
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          type: 'server-response',
          rpcId: envelope.rpcId,
          result: { ok: true, value: { opened: true } },
        }),
      })
    })
    await openDocument.click()
    await expect.poll(() => openRequests, { timeout: 5_000 }).toBe(1)
    await expect.poll(() => openDocument.isEnabled(), { timeout: 5_000 }).toBe(true)
    await page.unroute('**/api/settings.openDocument')
    // Golden of the freshly opened dialog (English default, General active).
    const snapshot = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(DIALOG_EXPECTED, snapshot, MODE)
    // Section switch: aria-current moves (the Models page itself has its own scenario file).
    await dialog.getByRole('button', { name: 'Models', exact: true }).click()
    await expect.poll(() => dialog.getByRole('button', { name: 'Models', exact: true }).getAttribute('aria-current'), { timeout: 5_000 }).toBe('true')
    expect(await dialog.getByRole('button', { name: 'General' }).getAttribute('aria-current')).toBeNull()
    // Plugins projects and safely controls the same assembled Loader tree.
    // Capture one stable shipped row rather than the whole inventory so adding
    // an unrelated plugin does not rewrite this surface's golden.
    await dialog.getByRole('button', { name: 'Plugins', exact: true }).click()
    await dialog.getByRole('heading', { name: 'Plugins', exact: true }).waitFor({ timeout: 10_000 })
    const mcpTab = dialog.getByRole('tab', { name: 'MCP', exact: true })
    await mcpTab.click()
    await dialog.getByText('Obsidian MCP', { exact: true }).waitFor({ timeout: 10_000 })
    await dialog.getByText('Enabled', { exact: true }).waitFor()
    expect(await mcpTab.getAttribute('aria-selected')).toBe('true')
    const mcpSnapshot = await captureStableAria(
      page,
      '[role="tabpanel"][aria-labelledby$="-tab-mcp"]',
      scaffold.workspaceCwd,
    )
    await compareOrRefreshGolden(MCP_EXPECTED, mcpSnapshot, MODE)
    await dialog.getByRole('tab', { name: 'Plugins', exact: true }).click()
    const inventoryPanel = dialog.getByRole('tabpanel', { name: 'Plugins', exact: true })
    const pluginRow = inventoryPanel.locator(PLUGIN_ROW_SELECTOR)
    await pluginRow.waitFor({ timeout: 10_000 })
    const inventory = scaffold.ctx.get('pluginInventory') as PluginInventoryGateway
    const { entries } = await inventory.list()
    const expectedPluginCount = new Set(entries.map(entry => entry.moduleName)).size
    expect(await dialog.getByRole('searchbox', { name: 'Search plugins' }).count()).toBe(1)
    expect(await inventoryPanel.locator('[data-plugin-entry]').count()).toBe(entries.length)
    expect(await inventoryPanel.locator('[data-plugin-count]').getAttribute('data-plugin-count'))
      .toBe(String(expectedPluginCount))
    expect(await dialog.getByRole('button', { name: 'Plugins', exact: true }).getAttribute('aria-current')).toBe('true')
    expect(await dialog.getByRole('tab', { name: 'Plugins', exact: true }).getAttribute('aria-selected')).toBe('true')
    expect(await dialog.getByRole('button', { name: 'Models', exact: true }).getAttribute('aria-current')).toBeNull()
    const pluginsSnapshot = await captureStableAria(
      page,
      PLUGIN_ROW_SELECTOR,
      scaffold.workspaceCwd,
    )
    await compareOrRefreshGolden(PLUGINS_EXPECTED, pluginsSnapshot, MODE)
    const toggleRow = inventoryPanel.locator(PLUGIN_TOGGLE_ROW_SELECTOR)
    await toggleRow.getByRole('switch', { name: 'Disable plugin command-feedback', exact: true }).waitFor()
    const toggleSnapshot = await captureStableAria(
      page,
      PLUGIN_TOGGLE_ROW_SELECTOR,
      scaffold.workspaceCwd,
    )
    await compareOrRefreshGolden(PLUGIN_TOGGLE_EXPECTED, toggleSnapshot, MODE)
    await toggleRow.getByRole('switch', { name: 'Disable plugin command-feedback', exact: true }).click()
    await toggleRow.getByRole('switch', { name: 'Enable plugin command-feedback', exact: true }).waitFor()
    expect((await inventory.list()).entries.find(entry => entry.moduleName === '@hydraharness/harness-command-feedback')?.enabled).toBe(true)
    await toggleRow.locator('[role="button"]').click()
    const toggleDetails = page.getByRole('dialog', { name: 'command-feedback', exact: true })
    await toggleDetails.getByText('Unsaved change', { exact: true }).waitFor()
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'plugin-draft.expected.md'),
      await captureStableAria(page, '[role="dialog"][aria-label="command-feedback"]', scaffold.workspaceCwd), MODE)
    await toggleDetails.getByRole('button', { name: 'Close plugin details', exact: true }).click()
    await inventoryPanel.getByRole('button', { name: 'Save plugin settings', exact: true }).click()
    await expect.poll(async () => (await inventory.list()).entries
      .find(entry => entry.moduleName === '@hydraharness/harness-command-feedback' && entry.presetId === undefined)?.enabled).toBe(false)
    const settingsPath = join(scaffold.harnessHome, 'settings.yaml')
    expect(parseYaml(await readFile(settingsPath, 'utf8'))).toMatchObject({
      plugins: { enabled: { '@hydraharness/harness-command-feedback': false } },
    })
    await toggleRow.locator('[role="button"]').click()
    const savedToggleDetails = page.getByRole('dialog', { name: 'command-feedback', exact: true })
    await expect.poll(() => savedToggleDetails.getByText('Unsaved change', { exact: true }).count()).toBe(0)
    await savedToggleDetails.getByText('Changed since app start', { exact: true }).waitFor()
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'plugin-saved.expected.md'),
      await captureStableAria(page, '[role="dialog"][aria-label="command-feedback"]', scaffold.workspaceCwd), MODE)
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await trigger.click()
    await dialog.getByRole('button', { name: 'Plugins', exact: true }).click()
    await dialog.getByRole('tab', { name: 'Plugins', exact: true }).click()
    await toggleRow.locator('[role="button"]').click()
    const reopenedToggleDetails = page.getByRole('dialog', { name: 'command-feedback', exact: true })
    await reopenedToggleDetails.getByText('Changed since app start', { exact: true }).waitFor()
    await reopenedToggleDetails.getByRole('button', { name: 'Close plugin details', exact: true }).click()
    await toggleRow.getByRole('switch', { name: 'Enable plugin command-feedback', exact: true }).click()
    await toggleRow.getByRole('switch', { name: 'Disable plugin command-feedback', exact: true }).waitFor()
    await inventoryPanel.getByRole('button', { name: 'Save plugin settings', exact: true }).click()
    await expect.poll(async () => (await inventory.list()).entries
      .find(entry => entry.moduleName === '@hydraharness/harness-command-feedback' && entry.presetId === undefined)?.enabled).toBe(true)
    expect(parseYaml(await readFile(settingsPath, 'utf8'))).toMatchObject({
      plugins: { enabled: { '@hydraharness/harness-command-feedback': true } },
    })
    expect(await pluginRow.getByRole('switch').count()).toBe(0)
    expect((await inventory.list()).entries.find(entry => entry.moduleName === '@hydraharness/harness-client-ui-settings')?.required).toBe(true)
    await pluginRow.locator('[role="button"]').click()
    const pluginDetails = page.getByRole('dialog', { name: 'ui-settings', exact: true })
    await pluginDetails.getByText('Required by Hydra or another enabled plugin.', { exact: true }).waitFor()
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'plugin-core-pending.expected.md'),
      await captureStableAria(page, '[role="dialog"][aria-label="ui-settings"]', scaffold.workspaceCwd), MODE)
    await pluginDetails.getByRole('button', { name: 'Close plugin details', exact: true }).click()
    // Close path 1: Escape.
    await page.keyboard.press('Escape')
    await expect.poll(() => page.getByRole('dialog', { name: 'Settings' }).count(), { timeout: 5_000 }).toBe(0)
    expect(await trigger.getAttribute('aria-expanded')).toBe('false')
    // Close path 2: the header close button (focus lands there on open).
    await trigger.click()
    await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Close' }).click()
    await expect.poll(() => page.getByRole('dialog', { name: 'Settings' }).count(), { timeout: 5_000 }).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('stores Permission as the default for future sessions without changing an existing session', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-settings-permission'))
    const existing = scaffold.ctx.sessions.create(SessionId('settings-permission-before'))
    expect(existing.events.find(event => event.type === 'permission/preset')?.data)
      .toEqual({ preset: 'workspace-write', origin: 'default' })

    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Settings' })
    await dialog.waitFor({ timeout: 10_000 })
    const selector = dialog.getByRole('button', { name: 'Edit' })
    await selector.waitFor({ timeout: 10_000 })
    await expect.poll(() => selector.isEnabled(), { timeout: 5_000 }).toBe(true)
    await selector.click()
    await page.getByRole('menuitem', { name: 'Read only' }).click()
    await dialog.getByRole('button', { name: 'Read only' }).waitFor({ timeout: 10_000 })

    const document = await readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8')
    expect(document).toContain('permission:')
    expect(document).toContain('defaultPreset: read-only')
    expect(existing.events.find(event => event.type === 'permission/preset')?.data)
      .toEqual({ preset: 'workspace-write', origin: 'default' })

    const created = scaffold.ctx.sessions.create(SessionId('settings-permission-after'))
    expect(created.events.map(event => [event.type, event.data])).toEqual([
      ['permission/preset', { preset: 'read-only', origin: 'default' }],
      ['sandbox/mode', { mode: 'read-only' }],
      ['approval/policy', { policy: 'ask' }],
    ])

    await dialog.getByRole('button', { name: 'Read only' }).click()
    await page.getByRole('menuitem', { name: 'Auto-Pilot' }).click()
    const confirmation = page.getByRole('dialog', { name: 'Enable Auto-Pilot?' })
    const enable = confirmation.getByRole('button', { name: 'Enable Auto-Pilot' })
    expect(await enable.isDisabled()).toBe(true)
    await confirmation.getByRole('checkbox').click()
    await enable.click()
    await dialog.getByRole('button', { name: 'Auto-Pilot' }).waitFor({ timeout: 10_000 })
    const confirmedDocument = await readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8')
    expect(confirmedDocument).toContain('defaultPreset: danger-full-access')
    const confirmed = scaffold.ctx.sessions.create(SessionId('settings-permission-confirmed'))
    expect(confirmed.events.map(event => [event.type, event.data])).toEqual([
      ['permission/preset', { preset: 'danger-full-access', origin: 'default' }],
      ['sandbox/mode', { mode: 'danger-full-access' }],
      ['approval/policy', { policy: 'never' }],
    ])
    await page.keyboard.press('Escape')
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('uses the persisted dark preference while plugins are still loading', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-settings-boot-theme'))
    await page.emulateMedia({ colorScheme: 'light' })
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const initialDialog = page.getByRole('dialog', { name: 'Settings' })
    const darkCube = initialDialog.getByRole('button', { name: 'Dark' })
    const themeWrite = page.waitForResponse('**/api/settings.mutate')
    await darkCube.click()
    const themeResponse = await (await themeWrite).json() as { result: unknown }
    expect(themeResponse.result).toMatchObject({ ok: true })
    await expect.poll(() => darkCube.getAttribute('aria-pressed'), { timeout: 5_000 }).toBe('true')
    await expect.poll(async () => readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8'), { timeout: 5_000 })
      .toMatch(/ui-theme:\n\s+preference: dark/)
    await page.keyboard.press('Escape')

    // Hold real plugin bundles so the shell-owned loading page remains observable.
    const pluginPattern = /\/plugins\/@hydraharness\/harness-client-ui-theme\/client\.js(?:\?.*)?$/
    let releaseBundles = (): void => {}
    const bundlesReleased = new Promise<void>((resolve) => { releaseBundles = resolve })
    await page.route(pluginPattern, async (route) => {
      await bundlesReleased
      await route.continue()
    })

    const warningStart = tripwire.warnings.length
    let reload: ReturnType<Page['reload']> | undefined
    try {
      reload = page.reload({ waitUntil: 'domcontentloaded' })
      const loading = page.getByText('Loading plugins…', { exact: true })
      await loading.waitFor({ timeout: 10_000 })
      const state = await loading.evaluate((element) => {
        const boot = element.parentElement?.parentElement
        if (boot === undefined || boot === null) throw new Error('loading hint is detached from the boot page')
        return {
          attr: document.body.hasAttribute('data-ds-dark-theme'),
          background: getComputedStyle(boot).backgroundColor,
          colorScheme: document.documentElement.style.colorScheme,
        }
      })
      expect(state).toEqual({
        attr: true,
        background: 'rgb(21, 21, 23)',
        colorScheme: 'dark',
      })
    } finally {
      releaseBundles()
      await reload
      await page.unroute(pluginPattern)
    }

    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const restoredDialog = page.getByRole('dialog', { name: 'Settings' })
    const systemCube = restoredDialog.getByRole('button', { name: 'System' })
    await systemCube.click()
    await expect.poll(() => systemCube.getAttribute('aria-pressed'), { timeout: 5_000 }).toBe('true')
    await expect.poll(() => page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme')), {
      timeout: 5_000,
    }).toBe(false)
    await page.keyboard.press('Escape')
    expect(tripwire.pageErrors).toEqual([])
  }, 90_000)

  it('flips the theme through the Appearance cubes and persists across reload and a distinct port', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-settings-appearance'))
    interface ThemeState {
      attr: boolean
      background: string
      /** Pre-migration localStorage key; the Host-backed world never writes it. */
      legacy: string | null
      themeColor: string | null
      themeColorCount: number
      token: string
    }
    const readState = async (target: Page = page): Promise<ThemeState> => await target.evaluate(() => {
      const metas = document.head.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')
      const computed = getComputedStyle(document.body)
      return {
        attr: document.body.hasAttribute('data-ds-dark-theme'),
        background: computed.backgroundColor,
        legacy: localStorage.getItem('hydra.theme'),
        themeColor: metas[0]?.content ?? null,
        themeColorCount: metas.length,
        token: computed.getPropertyValue('--dsw-alias-bg-base').trim(),
      }
    })
    const expectThemeColorSynchronized = (state: ThemeState): void => {
      expect(state.themeColorCount).toBe(1)
      expect(state.background).not.toBe('rgba(0, 0, 0, 0)')
      expect(state.themeColor).toBe(state.background)
    }
    // Pin the OS scheme to light so the default `system` preference resolves
    // light and the dark flip below is unambiguously the gesture's doing.
    await page.emulateMedia({ colorScheme: 'light' })
    const light = await readState()
    expect(light.attr).toBe(false)
    expectThemeColorSynchronized(light)

    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Settings' })
    await dialog.waitFor({ timeout: 10_000 })
    const darkCube = dialog.getByRole('button', { name: 'Dark' })
    expect(await darkCube.getAttribute('aria-pressed')).toBe('false')
    await darkCube.click()
    // The full cascade: pressed state, Host-backed preference, body attribute,
    // alias token flip — all from one real user gesture.
    await expect.poll(() => darkCube.getAttribute('aria-pressed'), { timeout: 5_000 }).toBe('true')
    const dark = await readState()
    expect(dark.attr).toBe(true)
    expect(dark.legacy).toBeNull()
    expect(dark.token).not.toBe(light.token)
    expectThemeColorSynchronized(dark)
    await expect.poll(async () => readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8'), { timeout: 5_000 })
      .toMatch(/ui-theme:\n\s+preference: dark/)
    await page.keyboard.press('Escape')

    // Reload: the preference survives the background Host read + presenter update.
    const warningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    await page.emulateMedia({ colorScheme: 'light' })
    await expect.poll(async () => (await readState()).attr, { timeout: 5_000 }).toBe(true)
    const reloaded = await readState()
    expect(reloaded.legacy).toBeNull()
    expectThemeColorSynchronized(reloaded)

    // A second live Host binds another ephemeral port but shares the same
    // user-settings home. Its fresh origin has no theme localStorage and still
    // converges to dark before the settings dialog opens.
    const second = await launchWebScaffold({ harnessHome: scaffold.harnessHome })
    const secondPage = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: 'en-US' })
    const secondTripwire = watchConsole(secondPage)
    try {
      expect(second.baseUrl).not.toBe(scaffold.baseUrl)
      await secondPage.emulateMedia({ colorScheme: 'light' })
      await secondPage.goto(second.baseUrl, { waitUntil: 'load' })
      await secondPage.waitForSelector('[class*="frame"]', { timeout: 30_000 })
      await expect.poll(async () => (await readState(secondPage)).attr, { timeout: 5_000 }).toBe(true)
      const secondState = await readState(secondPage)
      expect(secondState.legacy).toBeNull()
      expectThemeColorSynchronized(secondState)
      expect(secondTripwire.pageErrors).toEqual([])
      expect(secondTripwire.warnings).toEqual([])
    } finally {
      await secondPage.close()
      await second.close()
    }

    // `system` follows the emulated OS scheme (dark stays dark, light clears).
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const systemCube = page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'System' })
    await systemCube.click()
    await expect.poll(() => systemCube.getAttribute('aria-pressed'), { timeout: 5_000 }).toBe('true')
    await expect.poll(async () => (await readState()).attr, { timeout: 5_000 }).toBe(false)
    expectThemeColorSynchronized(await readState())
    await page.emulateMedia({ colorScheme: 'dark' })
    await expect.poll(async () => (await readState()).attr, { timeout: 5_000 }).toBe(true)
    expectThemeColorSynchronized(await readState())
    // Restore for the specs that follow: light preference beats the emulated
    // dark OS scheme, leaving the shared page in the light default.
    await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Light' }).click()
    await expect.poll(async () => (await readState()).attr, { timeout: 5_000 }).toBe(false)
    expectThemeColorSynchronized(await readState())
    await page.keyboard.press('Escape')
    expect(tripwire.pageErrors).toEqual([])
  }, 90_000)

  it('persists the busy-state Enter behavior across reload and a distinct port', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-settings-enter-behavior'))
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Settings' })
    await dialog.waitFor({ timeout: 10_000 })
    await dialog.getByRole('combobox', { name: 'Follow-up behavior' }).selectOption('steer')
    await expect.poll(() => dialog.getByRole('combobox', { name: 'Follow-up behavior' }).inputValue()).toBe('steer')
    expect(await page.evaluate(() => localStorage.getItem('hydra.conversation.busyEnter'))).toBeNull()
    await expect.poll(async () => readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8'), { timeout: 5_000 })
      .toMatch(/ui-conversation:\n\s+busyEnter: steer/)
    await page.keyboard.press('Escape')

    const warningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const reloaded = page.getByRole('dialog', { name: 'Settings' })
    await expect.poll(() => reloaded.getByRole('combobox', { name: 'Follow-up behavior' }).inputValue()).toBe('steer')

    const second = await launchWebScaffold({ harnessHome: scaffold.harnessHome })
    const secondPage = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: 'en-US' })
    const secondTripwire = watchConsole(secondPage)
    try {
      expect(second.baseUrl).not.toBe(scaffold.baseUrl)
      await secondPage.goto(second.baseUrl, { waitUntil: 'load' })
      await secondPage.waitForSelector('[class*="frame"]', { timeout: 30_000 })
      await secondPage.getByRole('button', { name: 'Settings', exact: true }).click()
      await expect.poll(() => secondPage.getByRole('dialog', { name: 'Settings' }).getByRole('combobox', { name: 'Follow-up behavior' }).inputValue()).toBe('steer')
      expect(await secondPage.evaluate(() => localStorage.getItem('hydra.conversation.busyEnter'))).toBeNull()
      expect(secondTripwire.pageErrors).toEqual([])
      expect(secondTripwire.warnings).toEqual([])
    } finally {
      await secondPage.close()
      await second.close()
    }

    await reloaded.getByRole('combobox', { name: 'Follow-up behavior' }).selectOption('queue')
    await expect.poll(() => reloaded.getByRole('combobox', { name: 'Follow-up behavior' }).inputValue()).toBe('queue')
    expect(await page.evaluate(() => localStorage.getItem('hydra.conversation.busyEnter'))).toBeNull()
    await expect.poll(async () => readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8'), { timeout: 5_000 })
      .toMatch(/ui-conversation:\n\s+busyEnter: queue/)
    await page.keyboard.press('Escape')
    expect(tripwire.pageErrors).toEqual([])
  }, 90_000)

  it('opens an English browser in English without any stored preference', async () => {
    // A fresh Host home has no locale preference, so its surface follows the
    // browser. English is also FALLBACK_LOCALE and the only shipped locale, so
    // this and the unshipped-language scenario below are what pin the fallback
    // behavior (there is no second locale left to discriminate detection from
    // the default).
    const fresh = await launchWebScaffold({})
    const enPage = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: 'en-US' })
    const enTripwire = watchConsole(enPage)
    onTestFailed(() => saveFailureShot(enPage, 'web-e2e-settings-browser-language'))
    try {
      await enPage.goto(fresh.baseUrl, { waitUntil: 'load' })
      await enPage.waitForSelector('[class*="frame"]', { timeout: 30_000 })
      expect(await enPage.evaluate(() => localStorage.getItem('hydra.locale'))).toBeNull()
      await enPage.getByRole('button', { name: 'Settings', exact: true }).click()
      const dialog = enPage.getByRole('dialog', { name: 'Settings' })
      await dialog.waitFor({ timeout: 10_000 })
      await dialog.getByRole('button', { name: 'Auto', exact: true }).waitFor({ timeout: 10_000 })
      // This page has no closing inventory spec to sweep its console, so the
      // scenario clears both tripwire channels itself.
      expect(enTripwire.pageErrors).toEqual([])
      expect(enTripwire.warnings).toEqual([])
    } finally {
      await enPage.close()
      await fresh.close()
    }
  }, 90_000)

  it('opens a browser asking for no shipped language in English', async () => {
    // The product default for "no usable signal": a French browser asks for a
    // locale the app does not ship, so resolution falls to FALLBACK_LOCALE (en).
    const fresh = await launchWebScaffold({})
    const frPage = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: 'fr-FR' })
    const frTripwire = watchConsole(frPage)
    onTestFailed(() => saveFailureShot(frPage, 'web-e2e-settings-unshipped-language'))
    try {
      await frPage.goto(fresh.baseUrl, { waitUntil: 'load' })
      await frPage.waitForSelector('[class*="frame"]', { timeout: 30_000 })
      expect(await frPage.evaluate(() => localStorage.getItem('hydra.locale'))).toBeNull()
      await frPage.getByRole('button', { name: 'Settings', exact: true }).click()
      const dialog = frPage.getByRole('dialog', { name: 'Settings' })
      await dialog.waitFor({ timeout: 10_000 })
      await dialog.getByRole('button', { name: 'Auto', exact: true }).waitFor({ timeout: 10_000 })
      // The markup already ships `en`, so this alone cannot prove the sync ran;
      // asserted anyway so a future change that resolves en but writes the
      // wrong tag is caught.
      expect(await frPage.evaluate(() => document.documentElement.lang)).toBe('en')
      // Golden of the English fallback dialog — the visible output an
      // unshipped browser locale produces.
      const snapshot = await captureStableAria(frPage, '[role="dialog"]', fresh.workspaceCwd)
      await compareOrRefreshGolden(DIALOG_EN_EXPECTED, snapshot, MODE)
      expect(frTripwire.pageErrors).toEqual([])
      expect(frTripwire.warnings).toEqual([])
    } finally {
      await frPage.close()
      await fresh.close()
    }
  }, 90_000)

  it.skipIf(MODE === 'record')('keeps the fixture inventory closed', async () => {
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, [
      'dialog-en.expected.md',
      'dialog.expected.md',
      'mcp.expected.md',
      'plugin-toggle.expected.md',
      'plugin-draft.expected.md',
      'plugin-saved.expected.md',
      'plugin-core-pending.expected.md',
      'plugins.expected.md',
    ])
  })
})

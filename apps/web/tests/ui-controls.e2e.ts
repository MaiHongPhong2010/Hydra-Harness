/** Shared field chrome in the assembled application, including native editing and both themes. */
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { chromium, type Browser, type Locator, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, REPO_ROOT, saveFailureShot } from './support.ts'

const SNAPSHOT = fileURLToPath(new URL('./snapshots/ui-controls/chrome.expected.md', import.meta.url))
const OVERLAY = fileURLToPath(new URL('./jev-provider.overlay.yml', import.meta.url))
const SHOTS = join(REPO_ROOT, '.artifacts', 'ui-controls')

async function chrome(control: Locator) {
  return await control.evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      minHeight: style.minHeight, fontSize: style.fontSize, lineHeight: style.lineHeight,
      radius: style.borderRadius, borderWidth: style.borderWidth, fill: style.backgroundColor,
      text: style.color,
    }
  })
}

describe('web e2e: shared native controls', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY })
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: 'en-US', reducedMotion: 'reduce' })
    page.setDefaultTimeout(10_000)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    await mkdir(SHOTS, { recursive: true })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('keeps picker and field chrome consistent while editing, focusing, saving, and resizing', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-ui-controls'))
    const measured: Record<string, unknown> = {}
    for (const theme of ['Light', 'Dark']) {
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'Settings' })
      await dialog.getByRole('button', { name: 'General', exact: true }).click()
      await dialog.getByRole('button', { name: theme, exact: true }).click()
      await expect.poll(() => page.locator('body').getAttribute('data-ds-dark-theme')).toBe(theme === 'Dark' ? '' : null)
      const picker = dialog.locator('button[data-hydra-control="field"]').first()
      await picker.focus()
      await page.keyboard.press('Enter')
      await expect.poll(() => picker.getAttribute('aria-expanded')).toBe('true')
      await page.keyboard.press('Escape')
      expect(await picker.getAttribute('aria-expanded')).toBe('false')
      const pickerChrome = await chrome(picker)
      expect(pickerChrome).toMatchObject({ minHeight: '32px', fontSize: '14px', lineHeight: '22px', radius: '9px', borderWidth: '1px' })
      await page.screenshot({ path: join(SHOTS, `${theme.toLowerCase()}-general.png`) })

      await dialog.getByRole('button', { name: 'Models', exact: true }).click()
      const select = dialog.getByRole('combobox', { name: 'Decision model', exact: true })
      await dialog.getByRole('button', { name: 'Configure Jev', exact: true }).click()
      const input = dialog.getByLabel('API key', { exact: true })
      await expect.poll(() => input.isEnabled()).toBe(true)
      await input.fill('jev-style-fixture')
      await input.press('Tab')
      await page.keyboard.press('Shift+Tab')
      expect(await input.evaluate(element => getComputedStyle(element).outlineWidth)).toBe('2px')
      expect(await chrome(input)).toEqual(pickerChrome)
      const selectChrome = await chrome(select)
      expect(selectChrome.lineHeight).toMatch(/^(normal|22px)$/)
      expect({ ...selectChrome, lineHeight: pickerChrome.lineHeight }).toEqual(pickerChrome)
      expect((await select.boundingBox())?.height).toBe(32)
      expect(await select.evaluate(element => getComputedStyle(element).appearance)).toBe('auto')
      measured[theme] = pickerChrome
      await page.screenshot({ path: join(SHOTS, `${theme.toLowerCase()}-models.png`) })

      let release = (): void => {}
      const pending = new Promise<void>((resolve) => { release = resolve })
      await page.route('**/api/credentials.set', async (route) => { await pending; await route.continue() })
      try {
        await dialog.getByRole('button', { name: 'Apply', exact: true }).click()
        await expect.poll(() => input.isDisabled()).toBe(true)
        expect(await input.evaluate(element => getComputedStyle(element).opacity)).toBe('0.5')
      } finally { release() }
      await expect.poll(() => input.count()).toBe(0)
      await page.unroute('**/api/credentials.set')

      await dialog.getByRole('button', { name: 'Plugins', exact: true }).click()
      await dialog.getByText('Shell', { exact: true }).click()
      const timeout = dialog.getByLabel('Command timeout (ms)')
      const border = await timeout.evaluate(element => getComputedStyle(element).borderColor)
      await timeout.fill('soon')
      expect(await timeout.getAttribute('aria-invalid')).toBe('true')
      const invalidBorder = await timeout.evaluate(element => getComputedStyle(element).borderColor)
      const errorColor = await dialog.getByText('Enter a number, or leave blank to use the default.', { exact: true })
        .evaluate(element => getComputedStyle(element).color)
      expect(invalidBorder).toBe(errorColor)
      expect(invalidBorder).not.toBe(border)
      expect(await dialog.getByRole('button', { name: 'Save', exact: true }).isDisabled()).toBe(true)
      await dialog.getByRole('button', { name: 'Discard', exact: true }).click()
      await page.setViewportSize({ width: 800, height: 800 })
      expect(await timeout.evaluate(element => element.getBoundingClientRect().right <= innerWidth)).toBe(true)
      await page.screenshot({ path: join(SHOTS, `${theme.toLowerCase()}-plugins-narrow.png`) })
      await page.keyboard.press('Escape')
      await page.setViewportSize({ width: 1680, height: 1000 })

      const compact = page.locator('button[data-hydra-control="compact"]:visible').first()
      await compact.waitFor()
      const compactChrome = await chrome(compact)
      expect(compactChrome).toMatchObject({ minHeight: '28px', fontSize: '12px', lineHeight: '18px', radius: '9px', borderWidth: '1px' })
      measured[`${theme} compact`] = compactChrome
      await page.getByRole('button', { name: 'Search sessions', exact: true }).click()
      const search = page.getByPlaceholder('Search sessions...')
      const searchBox = search.locator('..')
      await search.fill('query')
      expect(await chrome(searchBox)).toEqual(compactChrome)
      expect((await searchBox.boundingBox())?.height).toBe(28)
      expect(await searchBox.evaluate(element => getComputedStyle(element).outlineWidth)).toBe('2px')
      await search.press('Escape')
    }
    await compareOrRefreshGolden(SNAPSHOT, `\`\`\`json\n${JSON.stringify(measured, null, 2)}\n\`\`\``, webSnapshotMode())
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})

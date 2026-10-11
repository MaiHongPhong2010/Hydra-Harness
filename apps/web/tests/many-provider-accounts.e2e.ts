/** Large account pools through the assembled Settings UI and real credential mutations. */
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { credentialKey } from '@hydraharness/harness-credentials'
import { ACCOUNT_AUTH_NAMESPACE } from './account-auth-fixture.ts'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, REPO_ROOT } from './support.ts'

const overlay = fileURLToPath(new URL('./auth-accounts.overlay.yml', import.meta.url))
const fixture = new URL('./account-auth-fixture.ts', import.meta.url).href
const golden = fileURLToPath(new URL('./snapshots/many-provider-accounts/list.expected.md', import.meta.url))
const shots = join(REPO_ROOT, '.artifacts/many-provider-accounts')
const key = credentialKey('llm-account-auth', 'chatgpt')
let scaffold: WebScaffold
let browser: Browser
let page: Page
let tripwire: ReturnType<typeof watchConsole>
let usageCalls = (): number => 0

beforeAll(async () => {
  scaffold = await launchWebScaffold({ extraOverlayPath: overlay,
    extraPatches: [{ insert: [{ id: 'llm-account-auth-fixture', name: fixture }] }] })
  await scaffold.ctx.credentials.modifyRecord(key, async () => ({ kind: 'grant', payload: {
    accounts: Array.from({ length: 100 }, (_, index) => ({ id: `seed-${index}`,
      label: `account-${String(index).padStart(3, '0')}@example.test` })),
  } }))
  await scaffold.ctx.settings.mutate(ACCOUNT_AUTH_NAMESPACE, [{ op: 'set', path: ['providers', 'chatgpt'], value: {} }])
  const usage = vi.spyOn(scaffold.ctx.authorization, 'getUsage')
  usageCalls = () => usage.mock.calls.length
  browser = await chromium.launch()
  page = await newEnglishPage(browser)
  tripwire = watchConsole(page)
  await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
  await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  await mkdir(shots, { recursive: true })
  await mkdir(dirname(golden), { recursive: true })
}, 120_000)

afterAll(async () => {
  await browser?.close()
  await scaffold?.close()
})

it('finds accounts outside the first page, loads one quota, and removes a reviewed selection across pages', async () => {
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true })
  if (!await dialog.isVisible()) await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await dialog.getByRole('button', { name: 'Accounts', exact: true }).click()
  const accounts = dialog.getByRole('list', { name: 'Accounts', exact: true })
  await accounts.getByText('account-000@example.test', { exact: true }).waitFor()
  expect(await accounts.getByRole('listitem').count()).toBe(10)
  expect(usageCalls()).toBe(0)
  await compareOrRefreshGolden(golden, await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd), webSnapshotMode())
  for (const theme of ['Light', 'Dark']) {
    await dialog.getByRole('button', { name: 'General', exact: true }).click()
    await dialog.getByRole('button', { name: theme, exact: true }).click()
    await dialog.getByRole('button', { name: 'Accounts', exact: true }).click()
    for (const width of [1680, 560]) {
      await page.setViewportSize({ width, height: 1000 })
      await accounts.scrollIntoViewIfNeeded()
      expect(await accounts.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      await page.screenshot({ path: join(shots, `${theme.toLowerCase()}-${width}.png`) })
    }
    await page.setViewportSize({ width: 1680, height: 1000 })
  }
  const search = dialog.getByRole('searchbox', { name: 'Search accounts', exact: true })
  await search.fill('ACCOUNT-099')
  await accounts.getByText('account-099@example.test', { exact: true }).waitFor()
  expect(await accounts.getByRole('listitem').count()).toBe(1)
  expect(usageCalls()).toBe(0)
  await accounts.getByRole('button', { name: 'Show usage for account-099@example.test', exact: true }).click()
  await accounts.getByText('75% left', { exact: true }).waitFor()
  expect(usageCalls()).toBe(1)
  await search.fill('missing-account')
  await dialog.getByText('No accounts match your search.', { exact: true }).waitFor()
  await search.fill('')
  await dialog.getByRole('checkbox', { name: 'Select this page', exact: true }).check()
  await dialog.getByRole('button', { name: 'Next accounts page', exact: true }).click()
  await accounts.getByRole('checkbox', { name: 'Select account-010@example.test', exact: true }).check()
  await dialog.getByRole('button', { name: 'Remove selected (11)', exact: true }).click()
  const confirm = page.getByRole('dialog', { name: 'Remove 11 accounts?', exact: true })
  await confirm.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(await scaffold.ctx.authorization.listAccounts(key)).toHaveLength(100)
  await dialog.getByRole('button', { name: 'Remove selected (11)', exact: true }).click()
  await confirm.getByRole('button', { name: 'Remove accounts', exact: true }).click()
  await expect.poll(async () => (await scaffold.ctx.authorization.listAccounts(key)).length, { timeout: 15_000 }).toBe(89)
  await confirm.waitFor({ state: 'detached' })
  expect(await dialog.getByRole('button', { name: /^Remove selected/ }).count()).toBe(0)
  expect(usageCalls()).toBe(1)
  await dialog.getByRole('button', { name: 'Add account', exact: true }).click()
  await dialog.getByText('Account connected. Configure or enable this provider in Models.', { exact: true }).waitFor()
  await accounts.waitFor()
  expect(await scaffold.ctx.authorization.listAccounts(key)).toHaveLength(90)
  await accounts.getByText('chatgpt-90@example.test', { exact: true }).waitFor()
  await expect.poll(usageCalls).toBe(2)
  await page.reload()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await dialog.getByRole('button', { name: 'Accounts', exact: true }).click()
  await accounts.getByText('account-011@example.test', { exact: true }).waitFor()
  expect(await accounts.getByText('account-000@example.test', { exact: true }).count()).toBe(0)
  expect(await accounts.getByRole('listitem').count()).toBe(10)
  expect(tripwire.pageErrors).toEqual([])
  expect(tripwire.warnings).toEqual([])
}, 90_000)

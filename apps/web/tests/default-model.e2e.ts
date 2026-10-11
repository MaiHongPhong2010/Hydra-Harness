/** Real Web acceptance for shared Settings/composer defaults and unavailable routes. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { SessionId } from '@hydraharness/harness-session'
import { settingsNamespace } from '@hydraharness/harness-settings'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, saveFailureShot } from './support.ts'

/** Points the global composition default at this scenario's own route. */
const OVERLAY = fileURLToPath(new URL('./default-model.overlay.yml', import.meta.url))

/** The route this scenario starts on, patched over the shipped default. */
const START_ROUTE = 'origin-gateway'
const START_MODEL = 'origin-large'
/** The route the switch lands on, which then becomes the saved default. */
const ROUTE = 'acme-gateway'
const MODEL = 'acme-large'

describe('web e2e: the composer model switch is the default for later sessions', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let workspacePath: string

  /** Create one session and its agent through the same wire face the browser uses. */
  const createSession = async (sessionId: string, cwd = workspacePath): Promise<string> => {
    const response = await scaffold.ctx.apiProxy.sessions.create({
      rpcId: `default-model-create-${sessionId}` as never,
      payload: { sessionId: SessionId(sessionId), cwd },
    })
    if (!response.result.ok) throw new Error(`session.create failed: ${response.result.error.message}`)
    return response.result.value.sessionId
  }

  /** The route the gateway reports for one session, through the real wire face. */
  const currentOf = async (sessionId: string): Promise<unknown> => {
    const response = await scaffold.ctx.apiProxy.sessions.models({
      rpcId: `default-model-${sessionId}` as never,
      payload: { sessionId: SessionId(sessionId) },
    })
    if (!response.result.ok) throw new Error(`session.models failed: ${response.result.error.message}`)
    return response.result.value.current
  }

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY })
    // Two routes so the picker has somewhere to start and somewhere to go.
    // Declared through the settings seam rather than the Models page: this
    // scenario is about the composer, and the declaring flow is covered by
    // models-settings.e2e.
    await scaffold.ctx.settings.update(settingsNamespace('llm-pi-ai'), {
      providers: {
        [START_ROUTE]: {
          displayName: 'Origin Gateway',
          api: 'openai-completions',
          baseURL: 'https://gateway.origin.example/v1',
          models: [{ id: START_MODEL, name: 'Origin Large' }],
        },
        [ROUTE]: {
          displayName: 'Acme Gateway',
          api: 'openai-completions',
          baseURL: 'https://gateway.acme.example/v1',
          models: [{ id: MODEL, name: 'Acme Large' }],
        },
      },
    })
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: 'en-US' })
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    // The composer's seats only exist once a workspace is connected: without
    // one the input is the locked placeholder and no session scope is open.
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    workspacePath = join(scaffold.workspaceCwd, 'workspace')
    const workspace = await scaffold.ctx.workspaceRegistry.resolveByPath(workspacePath)
    if (workspace === undefined) throw new Error('Workspace was not registered')
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('writes the switched model as the default and leaves a logged session alone', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-default-model'))
    // A session that has already run a turn, spelled as the fact a turn
    // leaves behind: its own logged route.
    const loggedId = await createSession('default-model-logged')
    scaffold.ctx.sessions.get(SessionId(loggedId))?.append('request/header', {
      header: { config: { provider: START_ROUTE, model: START_MODEL } },
      reason: 'initial',
    })

    const trigger = page.getByRole('button', { name: /^Select model/ })
    const projectPaths = ['settings.yaml', 'settings.local.yaml'].map(name => join(workspacePath, '.hydra', name))
    const projectBefore = await Promise.all(projectPaths.map(path => readFile(path, 'utf8')))
    await trigger.waitFor({ timeout: 15_000 })
    await trigger.click()
    await page.getByRole('menuitem', { name: /Model/ }).click()
    await page.getByRole('menuitemradio', { name: 'Acme Large' }).click()

    const settingsPath = join(scaffold.harnessHome, 'settings.yaml')
    await expect.poll(
      async () => readFile(settingsPath, 'utf8'),
      { timeout: 10_000 },
    ).toContain('agent-default-model:')
    const document = await readFile(settingsPath, 'utf8')
    expect(document).toContain(`provider: ${ROUTE}`)
    expect(document).toContain(`model: ${MODEL}`)
    expect(await Promise.all(projectPaths.map(path => readFile(path, 'utf8')))).toEqual(projectBefore)

    // A session created after the switch starts from it...
    expect(await currentOf(await createSession('default-model-after')))
      .toEqual({ provider: ROUTE, model: MODEL })
    expect(await currentOf(await createSession('default-model-other-workspace', scaffold.workspaceCwd)))
      .toEqual({ provider: ROUTE, model: MODEL })
    // ...while the one holding a logged route keeps deriving from its log.
    expect(await currentOf(loggedId)).toEqual({ provider: START_ROUTE, model: START_MODEL })
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
    await settings.getByRole('button', { name: 'Models', exact: true }).click()
    await settings.getByRole('heading', { name: 'Models', exact: true }).waitFor()
    const defaultModel = settings.getByRole('combobox', { name: 'Default model', exact: true })
    await expect.poll(() => defaultModel.inputValue()).toBe(JSON.stringify([ROUTE, MODEL]))
    await expect.poll(() => defaultModel.locator('option:checked').textContent()).toBe('Acme Large')
    expect(await currentOf(await createSession('default-model-settings')))
      .toEqual({ provider: ROUTE, model: MODEL })
    expect(await currentOf(loggedId)).toEqual({ provider: START_ROUTE, model: START_MODEL })
    expect(await readFile(settingsPath, 'utf8')).toContain(`model: ${MODEL}`)
    await settings.getByRole('button', { name: 'Close', exact: true }).click()
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('saves from Settings globally, syncs another window, and leaves logged sessions alone', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-default-model-settings'))
    const projectPaths = ['settings.yaml', 'settings.local.yaml'].map(name => join(workspacePath, '.hydra', name))
    const before = await Promise.all(projectPaths.map(path => readFile(path, 'utf8')))
    const loggedId = await createSession('default-settings-logged')
    scaffold.ctx.sessions.get(SessionId(loggedId))?.append('request/header', {
      header: { config: { provider: ROUTE, model: MODEL } }, reason: 'initial',
    })
    const open = async (surface: Page) => {
      await surface.getByRole('button', { name: 'Settings', exact: true }).click()
      const dialog = surface.getByRole('dialog', { name: 'Settings', exact: true })
      await dialog.getByRole('button', { name: 'Models', exact: true }).click()
      const select = dialog.getByRole('combobox', { name: 'Default model', exact: true })
      await expect.poll(() => select.isEnabled()).toBe(true)
      return { dialog, select }
    }
    const other = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: 'en-US' })
    try {
      await other.goto(scaffold.baseUrl, { waitUntil: 'load' })
      await other.waitForSelector('[class*="frame"]', { timeout: 30_000 })
      const mirror = await open(other)
      const main = await open(page)
      const labels = await main.dialog.getByRole('combobox').evaluateAll(elements => elements.slice(0, 4).map(element => element.getAttribute('aria-label')))
      expect(labels).toEqual(['Default model', 'Image model', 'Video model', 'Decision model'])
      expect(await main.dialog.getByRole('combobox', { name: 'Decision model', exact: true }).isDisabled()).toBe(true)
      let captured!: () => void
      let release!: () => void
      const intercepted = new Promise<void>((resolve) => { captured = resolve })
      const proceed = new Promise<void>((resolve) => { release = resolve })
      await page.route('**/api/settings.mutate', async (route) => { captured(); await proceed; await route.continue() })
      await main.select.selectOption(JSON.stringify([START_ROUTE, START_MODEL]))
      await intercepted
      await scaffold.ctx.settings.update(settingsNamespace('agent-default-model'), { provider: START_ROUTE, model: START_MODEL })
      release()
      await main.dialog.getByRole('alert').waitFor()
      expect(await main.select.inputValue()).toBe(JSON.stringify([START_ROUTE, START_MODEL]))
      await page.unroute('**/api/settings.mutate')
      await main.dialog.getByRole('button', { name: 'Retry', exact: true }).click()
      await main.dialog.getByText('Default model saved. Applies to new chats.', { exact: true }).waitFor()
      await expect.poll(() => mirror.select.inputValue()).toBe(JSON.stringify([START_ROUTE, START_MODEL]))
      await expect.poll(() => main.select.locator('option:checked').textContent()).toBe('Origin Large')
      expect(await currentOf(await createSession('default-settings-new'))).toEqual({ provider: START_ROUTE, model: START_MODEL })
      expect(await currentOf(loggedId)).toEqual({ provider: ROUTE, model: MODEL })
      expect(await Promise.all(projectPaths.map(path => readFile(path, 'utf8')))).toEqual(before)
      await main.select.focus()
      await page.keyboard.press('Tab')
      expect(await main.dialog.getByRole('button', { name: 'Refresh models', exact: true }).evaluate(element => element === document.activeElement)).toBe(true)
      await compareOrRefreshGolden(fileURLToPath(new URL('./snapshots/default-model/settings.expected.md', import.meta.url)),
        await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd), webSnapshotMode())
      await page.reload({ waitUntil: 'load' })
      const reloaded = await open(page)
      expect(await reloaded.select.inputValue()).toBe(JSON.stringify([START_ROUTE, START_MODEL]))
      await reloaded.select.selectOption(JSON.stringify([ROUTE, MODEL]))
      await reloaded.dialog.getByText('Default model saved. Applies to new chats.', { exact: true }).waitFor()
      await reloaded.dialog.getByRole('button', { name: 'Close', exact: true }).click()
    } finally { await other.close() }
  }, 60_000)

  it('goes inert when the route the default names stops being served', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-default-model-blocked'))
    const box = page.locator('textarea[data-input-phase], textarea').first()
    await expect.poll(async () => box.isEnabled(), { timeout: 10_000 }).toBe(true)

    // What removing the provider on the Models page leaves behind: the saved
    // default still names the route, and nothing serves it any more.
    // `replace`, not `update`: a merge patch of `{providers: {}}` leaves every
    // stored profile in place.
    await scaffold.ctx.settings.replace(settingsNamespace('llm-pi-ai'), { providers: {} })

    await expect.poll(async () => box.isEnabled(), { timeout: 15_000 }).toBe(false)
    expect(await box.getAttribute('placeholder')).toBe('This model is unavailable — select one to continue')

    // The block is an affordance; the refusal is the Host's. A client that
    // never disabled anything still cannot start a turn on a dead route.
    const refused = await scaffold.ctx.apiProxy.sessions.prompt({
      rpcId: 'default-model-refused' as never,
      payload: {
        sessionId: SessionId(await createSession('default-model-refusal')),
        mode: 'queue' as const,
        content: [{ type: 'text' as const, text: 'hi' }],
      },
    })
    expect(refused.result).toMatchObject({ ok: false, error: { code: 'model-unavailable' } })

    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
    await settings.getByRole('button', { name: 'Models', exact: true }).click()
    const missing = settings.getByRole('combobox', { name: 'Default model', exact: true })
    await expect.poll(() => missing.locator('option:checked').textContent()).toContain('unavailable')
    expect(await missing.inputValue()).toBe(JSON.stringify([ROUTE, MODEL]))
    expect(scaffold.ctx.agentDefaultModel.currentSelection()).toEqual({ provider: ROUTE, model: MODEL })
    await settings.getByRole('button', { name: 'Close', exact: true }).click()

    // The way out stays open. Locking the model seat with everything else
    // would leave the composer asking for the one thing it prevents.
    const seat = page.getByRole('button', { name: /^Select model/ })
    expect(await seat.isEnabled()).toBe(true)
    await seat.click()
    await page.getByRole('menuitem', { name: /Model/ }).click()
    await page.getByRole('menuitemradio').first().click()
    await expect.poll(async () => box.isEnabled(), { timeout: 15_000 }).toBe(true)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)
})

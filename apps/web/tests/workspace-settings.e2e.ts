/** Global Settings editing with automatic, isolated workspace file overrides. */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Locator, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { settingsNamespace } from '@hydraharness/harness-settings'
import type { WorkspaceId } from '@hydraharness/harness-workspace'
import type {} from '@hydraharness/harness-workspace-config'
import {
  acknowledgeReloadConnectionLoss, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const ACME = { provider: 'workspace-acme', model: 'acme-large' }
const GLOBAL = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }
const SHARED_ALPHA = 'permission:\n  defaultPreset: read-only\n'
const PERMISSION_NS = settingsNamespace('permission')
const SNAPSHOT = fileURLToPath(new URL('./snapshots/workspace-settings/global.expected.md', import.meta.url))

describe('web e2e: global Settings and workspace overrides', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let alpha: string
  let beta: string
  let alphaId: WorkspaceId
  let betaId: WorkspaceId

  const settings = (): Locator => page.getByRole('dialog', { name: 'Settings', exact: true })
  const file = (root: string, layer: 'shared' | 'local'): string =>
    join(root, '.hydra', layer === 'shared' ? 'settings.yaml' : 'settings.local.yaml')
  const resolvedPermission = async (id: WorkspaceId): Promise<unknown> =>
    (await scaffold.ctx.workspaceConfig.environmentFor(id)).settings.get(PERMISSION_NS)

  async function adopt(path: string): Promise<WorkspaceId> {
    await page.getByRole('button', { name: 'Add workspace', exact: true }).click()
    const picker = page.getByRole('dialog', { name: 'Select Workspace Directory', exact: true })
    await picker.getByRole('button', { name: 'Edit path', exact: true }).click()
    const pathInput = picker.getByRole('textbox', { name: 'Edit path', exact: true })
    await pathInput.fill(path)
    await pathInput.press('Enter')
    await picker.getByRole('button', { name: 'Open', exact: true }).click()
    await picker.waitFor({ state: 'hidden' })
    await expect.poll(() => scaffold.ctx.workspaceRegistry.resolveByPath(path)).not.toBeUndefined()
    const workspace = await scaffold.ctx.workspaceRegistry.resolveByPath(path)
    if (workspace === undefined) throw new Error('Workspace was not registered')
    await expect.poll(() => workspace.sessionIds.length).toBeGreaterThan(0)
    return workspace.id
  }

  beforeAll(async () => {
    scaffold = await launchWebScaffold()
    alpha = join(scaffold.workspaceCwd, 'alpha-settings')
    beta = join(scaffold.workspaceCwd, 'beta-settings')
    await mkdir(join(alpha, '.hydra'), { recursive: true })
    await mkdir(beta)
    await writeFile(file(alpha, 'shared'), SHARED_ALPHA)
    await scaffold.ctx.settings.update(settingsNamespace('llm-pi-ai'), {
      providers: {
        'workspace-acme': { displayName: 'Workspace Acme', api: 'openai-completions', baseURL: 'https://acme.example/v1', models: [{ id: 'acme-large', name: 'Acme Large' }] },
      },
    })
    await scaffold.ctx.settings.update(settingsNamespace('agent-default-model'), GLOBAL)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    page.setDefaultTimeout(15_000)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]')
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('keeps Settings global after workspace selection and preserves a denied trust decision', async () => {
    onTestFailed(() => saveFailureShot(page, 'workspace-settings-global'))
    alphaId = await adopt(alpha)
    const trust = page.getByRole('dialog', { name: 'Trust this workspace?', exact: true })
    await trust.waitFor()
    await trust.getByRole('button', { name: 'Cancel', exact: true }).click()
    await trust.waitFor({ state: 'hidden' })
    expect(await resolvedPermission(alphaId)).toEqual(scaffold.ctx.settings.get(PERMISSION_NS))
    betaId = await adopt(beta)
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    expect(await settings().getByLabel('Settings for', { exact: true }).count()).toBe(0)
    await settings().getByRole('button', { name: 'Usage', exact: true }).waitFor()
    await settings().getByRole('button', { name: 'Models', exact: true }).click()
    await settings().getByRole('combobox', { name: 'Default model', exact: true }).waitFor()
    expect(scaffold.ctx.agentDefaultModel.currentSelection()).toMatchObject(GLOBAL)
    await settings().getByRole('heading', { name: 'Account-backed models', exact: true }).waitFor()
    await settings().getByRole('heading', { name: 'API keys', exact: true }).waitFor()
    for (const root of [alpha, beta]) {
      expect(await readdir(join(root, '.hydra'))).toEqual(expect.arrayContaining(['settings.yaml', 'settings.local.yaml', 'AGENTS.md', '.gitignore']))
    }
    await settings().getByRole('button', { name: 'General', exact: true }).click()
    await expect.poll(() => settings().getByRole('button', { name: 'Standard mode', exact: true }).isEnabled()).toBe(true)
    await compareOrRefreshGolden(SNAPSHOT, await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd), webSnapshotMode())
  }, 90_000)

  it('keeps model and instructions global while project files override permissions only in their workspace', async () => {
    onTestFailed(() => saveFailureShot(page, 'workspace-settings-inheritance'))
    await scaffold.ctx.workspaceConfig.setTrusted(alphaId, true)
    await expect.poll(() => resolvedPermission(alphaId)).toEqual({ defaultPreset: 'read-only' })
    const globalPath = join(scaffold.harnessHome, 'settings.yaml')
    expect(await readFile(globalPath, 'utf8')).not.toContain('permission:')
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: /^Select model/ }).click()
    await page.getByRole('menuitem', { name: /Model/ }).click()
    await page.getByRole('menuitemradio', { name: 'Acme Large', exact: true }).click()
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await settings().getByRole('button', { name: 'Models', exact: true }).click()
    await expect.poll(() => readFile(globalPath, 'utf8')).toContain('acme-large')
    await expect.poll(() => scaffold.ctx.agentDefaultModel.currentSelection()).toMatchObject(ACME)
    expect(await resolvedPermission(alphaId)).toEqual({ defaultPreset: 'read-only' })
    expect(await resolvedPermission(betaId)).toEqual(scaffold.ctx.settings.get(PERMISSION_NS))
    expect(await readFile(file(alpha, 'shared'), 'utf8')).toBe(SHARED_ALPHA)
    await writeFile(file(alpha, 'local'), 'permission:\n  defaultPreset: danger-full-access\n')
    await expect.poll(() => resolvedPermission(alphaId)).toEqual({ defaultPreset: 'danger-full-access' })
    await writeFile(file(alpha, 'local'), '{}\n')
    await expect.poll(() => resolvedPermission(alphaId)).toEqual({ defaultPreset: 'read-only' })
    await settings().getByRole('button', { name: 'Personalization', exact: true }).click()
    await settings().locator('summary').filter({ hasText: 'Custom instructions' }).click()
    await settings().getByRole('textbox', { name: 'Custom instructions', exact: true }).fill('Global instructions.\n')
    await settings().getByRole('button', { name: 'Save', exact: true }).click()
    await expect.poll(() => readFile(join(scaffold.harnessHome, 'AGENTS.md'), 'utf8')).toBe('Global instructions.\n')
    expect(await readFile(join(alpha, '.hydra', 'AGENTS.md'), 'utf8')).not.toContain('Global instructions')
    expect(await readFile(join(beta, '.hydra', 'AGENTS.md'), 'utf8')).not.toContain('Global instructions')
  }, 90_000)

  it('retains global Settings after reload and keeps revocation local to its workspace', async () => {
    onTestFailed(() => saveFailureShot(page, 'workspace-settings-reload'))
    await scaffold.ctx.workspaceConfig.setTrusted(alphaId, false)
    await expect.poll(() => resolvedPermission(alphaId)).toEqual(scaffold.ctx.settings.get(PERMISSION_NS))
    expect(await readFile(file(alpha, 'shared'), 'utf8')).toBe(SHARED_ALPHA)
    const warningsBefore = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    acknowledgeReloadConnectionLoss(tripwire, warningsBefore)
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    expect(await settings().getByLabel('Settings for', { exact: true }).count()).toBe(0)
    await settings().getByRole('button', { name: 'Models', exact: true }).click()
    await expect.poll(() => scaffold.ctx.agentDefaultModel.currentSelection()).toMatchObject(ACME)
    await page.setViewportSize({ width: 1280, height: 720 })
    const bounds = await settings().boundingBox()
    expect(bounds).not.toBeNull()
    expect((bounds?.x ?? -1) >= 0 && (bounds?.y ?? -1) >= 0).toBe(true)
    expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(1280)
    expect((bounds?.y ?? 0) + (bounds?.height ?? 0)).toBeLessThanOrEqual(720)
    const artifacts = fileURLToPath(new URL('../../../.artifacts/', import.meta.url))
    await mkdir(artifacts, { recursive: true })
    await page.screenshot({ path: join(artifacts, 'workspace-settings-global.png'), fullPage: true })
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 90_000)
})

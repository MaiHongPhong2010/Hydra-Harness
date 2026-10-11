import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage } from './support.ts'
import { settingsNamespace } from '@hydraharness/harness-settings'

const fixture = fileURLToPath(new URL('./snapshots/file-review/session.jsonl', import.meta.url))
const golden = fileURLToPath(new URL('./snapshots/file-review/ui.expected.md', import.meta.url))
const panelGolden = fileURLToPath(new URL('./snapshots/file-review/panel-options.expected.md', import.meta.url))
const emptyPanelGolden = fileURLToPath(new URL('./snapshots/file-review/empty-panel.expected.md', import.meta.url))
const terminalsGolden = fileURLToPath(new URL('./snapshots/file-review/terminal-tabs.expected.md', import.meta.url))
const bottomTerminalsGolden = fileURLToPath(new URL('./snapshots/file-review/bottom-terminal-tabs.expected.md', import.meta.url))
const workspaceGolden = fileURLToPath(new URL('./snapshots/file-review/workspace.expected.md', import.meta.url))
const artifacts = fileURLToPath(new URL('../../../.artifacts', import.meta.url))

it('reviews real Write/Edit results, keeps, rejects an older Undo and restores in reverse order after reload', async () => {
  const scaffold = await launchWebScaffold({ replayFixture: fixture, toolsMode: 'native', paceMs: 5 })
  await scaffold.ctx.settings.update(settingsNamespace('desktop-ui'), { terminalLocation: 'right' })
  const browser = await chromium.launch()
  const target = join(scaffold.workspaceCwd, 'workspace', 'review.txt')
  const page = await newEnglishPage(browser)
  const errors = watchConsole(page)
  // Review lives in the desktop right panel, which AppFrame mounts only when
  // the preload surface exists; the bounds call is inert for this scenario.
  await page.addInitScript(() => {
    // Pin the unavailable terminal's placeholder shell across test hosts.
    Object.defineProperty(navigator, 'userAgent', { value: 'Hydra Web fixture (Linux)' })
    const target = window as unknown as { hydraDesktop?: unknown }
    target.hydraDesktop = { browser: { setBounds() {} } }
  })
  const openReview = async () => {
    await page.getByRole('button', { name: 'Toggle right panel' }).click()
    await page.getByRole('button', { name: 'Review', exact: true }).click()
  }
  try {
    await page.goto(scaffold.baseUrl)
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    const workspaceCwd = join(scaffold.workspaceCwd, 'workspace')
    const git = (...args: string[]) => promisify(execFile)('git', ['-C', workspaceCwd, ...args], { windowsHide: true })
    await git('init', '-q', '--initial-branch=review-fixture')
    const settled = scaffold.whenTurnSettled()
    const composer = page.locator('textarea').first()
    await composer.fill('Write review.txt with A then edit A to B. Reply REVIEW_READY.')
    await composer.press('Enter')
    const sessionId = await settled
    await expect.poll(async () => (await scaffold.ctx.fileReview.list(sessionId)).length).toBe(2)
    expect(await readFile(target, 'utf8')).toBe('B\n')
    const inline = page.getByRole('region', { name: 'review.txt active', exact: true })
    await expect.poll(() => inline.count(), { timeout: 15_000 }).toBe(2)
    await openReview()
    await compareOrRefreshGolden(panelGolden, await captureStableAria(page, '[aria-label="Right panel"] > header', scaffold.workspaceCwd), webSnapshotMode())
    await page.setViewportSize({ width: 1000, height: 760 })
    const rightPanel = page.getByRole('region', { name: 'Right panel', exact: true })
    const choices = rightPanel.getByRole('group', { name: 'Open panel' })
    await expect.poll(async () => {
      const bounds = await rightPanel.boundingBox()
      const controls = await page.getByRole('button', { name: 'Expand right panel' }).boundingBox()
      if (bounds === null || controls === null) return false
      const buttons = await choices.getByRole('button').all()
      for (const button of buttons) {
        const box = await button.boundingBox()
        if (box === null || box.width < 24 || box.x < bounds.x || box.x + box.width > controls.x) return false
      }
      return buttons.length === 5
    }).toBe(true)
    await mkdir(artifacts, { recursive: true })
    await page.screenshot({ path: join(artifacts, 'side-panel-narrow.png'), fullPage: true })
    await rightPanel.getByRole('button', { name: 'Terminal', exact: true }).click()
    await rightPanel.getByRole('button', { name: 'Terminal', exact: true }).click()
    await rightPanel.getByRole('tab', { name: 'Terminal 2', exact: true }).waitFor()
    await compareOrRefreshGolden(terminalsGolden, await captureStableAria(page, 'section[aria-label="Right panel"]', scaffold.workspaceCwd), webSnapshotMode())
    await page.screenshot({ path: join(artifacts, 'terminal-tabs.png'), fullPage: true })
    await page.getByRole('button', { name: 'Toggle bottom terminal' }).click()
    const bottomTerminal = page.getByRole('region', { name: 'Terminal', exact: true })
    await bottomTerminal.getByRole('button', { name: 'New Terminal' }).click()
    await bottomTerminal.getByRole('tab', { name: 'Terminal 2', exact: true }).waitFor()
    expect(await bottomTerminal.getByRole('button', { name: 'Split Terminal' }).count()).toBe(1)
    await compareOrRefreshGolden(bottomTerminalsGolden, await captureStableAria(page, 'section[aria-label="Terminal"]', scaffold.workspaceCwd), webSnapshotMode())
    await page.screenshot({ path: join(artifacts, 'bottom-terminal-tabs.png'), fullPage: true })
    await bottomTerminal.getByRole('button', { name: 'Split Terminal' }).click()
    expect(await bottomTerminal.getByRole('button', { name: 'Split Terminal' }).count()).toBe(2)
    await bottomTerminal.getByRole('tab', { name: 'Terminal', exact: true }).click()
    expect(await bottomTerminal.getByRole('button', { name: 'Split Terminal' }).count()).toBe(1)
    await bottomTerminal.getByRole('tab', { name: 'Terminal 2', exact: true }).click()
    expect(await bottomTerminal.getByRole('button', { name: 'Split Terminal' }).count()).toBe(2)
    await bottomTerminal.getByRole('button', { name: 'Close Terminal 2', exact: true }).click()
    await page.getByRole('button', { name: 'Toggle bottom terminal' }).click()
    await rightPanel.getByRole('button', { name: 'Close Terminal 2', exact: true }).click()
    await rightPanel.getByRole('button', { name: 'Close Terminal', exact: true }).click()
    await rightPanel.getByRole('button', { name: 'Close Review' }).click()
    await rightPanel.getByRole('button', { name: 'Close Browser' }).click()
    await rightPanel.getByRole('button', { name: 'Files', exact: true }).waitFor()
    await compareOrRefreshGolden(emptyPanelGolden, await captureStableAria(page, 'section[aria-label="Right panel"]', scaffold.workspaceCwd), webSnapshotMode())
    await page.screenshot({ path: join(artifacts, 'side-panel-empty.png'), fullPage: true })
    await rightPanel.getByRole('button', { name: 'Review', exact: true }).click()
    await page.setViewportSize({ width: 1680, height: 1000 })
    const panel = page.getByRole('region', { name: 'Review', exact: true })
    await panel.getByText('2 changes · 1 file', { exact: true }).waitFor()
    await panel.getByLabel('Review scope').selectOption('uncommitted')
    const liveFile = panel.getByRole('region', { name: 'review.txt workspace added', exact: true })
    await liveFile.waitFor()
    await liveFile.locator('summary').click()
    expect(await liveFile.getByLabel('Recorded diff for review.txt').textContent()).toContain('+B')
    expect(await panel.getByRole('button', { name: 'Keep All' }).count()).toBe(0)
    await liveFile.locator('summary').click()
    await compareOrRefreshGolden(workspaceGolden, await captureStableAria(page, 'section[aria-label="Review"]', scaffold.workspaceCwd), webSnapshotMode())
    await page.screenshot({ path: join(artifacts, 'file-review-workspace.png'), fullPage: true })
    await panel.getByLabel('Review scope').selectOption('staged')
    await panel.getByText('No changes in this comparison.').waitFor()
    await panel.getByLabel('Review scope').selectOption('session')
    const first = panel.getByRole('region', { name: 'review.txt active', exact: true }).first()
    await first.getByRole('button', { name: 'Keep', exact: true }).click()
    const kept = panel.getByRole('region', { name: 'review.txt kept', exact: true })
    await kept.getByRole('button', { name: 'Undo', exact: true }).click()
    await panel.getByRole('alert').waitFor()
    expect(await panel.getByRole('alert').textContent()).toContain('Undo was skipped')
    expect(await readFile(target, 'utf8')).toBe('B\n')
    await kept.locator('summary').click()
    expect(await kept.getByLabel('Recorded diff for review.txt').textContent()).toContain('+A')
    expect(await kept.textContent()).toContain('Tool call review-create')
    await mkdir(artifacts, { recursive: true })
    await page.screenshot({ path: join(artifacts, 'file-review-verified.png'), fullPage: true })
    await kept.locator('summary').click()
    await compareOrRefreshGolden(golden, await captureStableAria(page, 'section[aria-label="Review"]', scaffold.workspaceCwd), webSnapshotMode())
    await page.reload()
    await openReview()
    const latest = panel.getByRole('region', { name: 'review.txt active', exact: true })
    await latest.locator('summary').click()
    expect(await latest.getByLabel('Recorded diff for review.txt').textContent()).toContain('-A\n+B')
    expect(await latest.textContent()).toContain('Tool call review-edit')
    await latest.getByRole('button', { name: 'Undo', exact: true }).click()
    await expect.poll(() => readFile(target, 'utf8')).toBe('A\n')
    await kept.getByRole('button', { name: 'Undo', exact: true }).click()
    await expect.poll(async () => (await scaffold.ctx.fileReview.list(sessionId)).map(c => c.state)).toEqual(['rolledBack', 'rolledBack'])
    await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect.poll(() => panel.getByRole('region', { name: 'review.txt rolledBack', exact: true }).count()).toBe(2)
    expect(errors.pageErrors).toEqual([])
    expect(errors.warnings).toEqual([])
  } catch (error: unknown) {
    await mkdir(artifacts, { recursive: true })
    await writeFile(join(artifacts, 'file-review-debug.txt'), JSON.stringify(errors) + '\n' + await page.locator('body').ariaSnapshot())
    await page.screenshot({ path: join(artifacts, 'file-review.png'), fullPage: true })
    throw error
  } finally {
    await browser.close()
    await scaffold.close()
  }
}, 120_000)

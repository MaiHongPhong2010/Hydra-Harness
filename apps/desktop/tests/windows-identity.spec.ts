import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

interface ShortcutDetails {
  target: string
  args: string
  cwd: string
  description: string
  icon: string
  iconIndex: number
  appUserModelId: string
}
const { APP_ID, WINDOW_APP_ID, windowAppDetails, installDesktopShortcut } = createRequire(import.meta.url)('../windows-identity.cjs') as {
  APP_ID: string
  WINDOW_APP_ID: string
  windowAppDetails: (icon: string, executable: string, entry: string) => {
    appId: string
    appIconPath: string
    relaunchCommand: string
    relaunchDisplayName: string
  }
  installDesktopShortcut: (app: { getPath(name: string): string }, shell: object) => string
}
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'hydra-windows-identity-'))
  roots.push(root)
  let saved: ShortcutDetails
  const shell = {
    writeShortcutLink: vi.fn((path: string, _operation: string, details: ShortcutDetails) => {
      saved = details
      writeFileSync(path, 'shortcut fixture')
      return true
    }),
    readShortcutLink: vi.fn(() => saved),
  }
  const app = { getPath: () => root }
  return { root, shell, app }
}

it('keeps the same Hydra icon and identity on new and updated shortcuts and taskbar relaunches', () => {
  const b = fixture()
  const path = installDesktopShortcut(b.app, b.shell)
  expect(path).toBe(join(b.root, 'Hydra Harness.lnk'))
  expect(installDesktopShortcut(b.app, b.shell)).toBe(path)
  const first = b.shell.writeShortcutLink.mock.calls[0]
  const second = b.shell.writeShortcutLink.mock.calls[1]
  expect(first[1]).toBe('create')
  expect(second[1]).toBe('update')
  expect(first[2]).toEqual(second[2])
  const details = first[2]
  expect(details.appUserModelId).toBe('org.hydraharness.desktop.window')
  expect(details.iconIndex).toBe(0)
  expect(details.icon).toMatch(/hydra\.ico$/)
  const window = windowAppDetails(details.icon, details.target, 'desktop/main.cjs')
  expect(window).toMatchObject({ appId: WINDOW_APP_ID, appIconPath: details.icon,
    relaunchCommand: `"${process.execPath}" "desktop/main.cjs"`, relaunchDisplayName: 'Hydra harness' })
  expect(APP_ID).not.toBe(WINDOW_APP_ID)
})

it('reports a refused write or missing saved AppUserModelID', () => {
  const b = fixture()
  b.shell.writeShortcutLink.mockReturnValueOnce(false)
  expect(() => installDesktopShortcut(b.app, b.shell)).toThrow('did not save')
  b.shell.readShortcutLink.mockImplementationOnce(() => ({ ...b.shell.writeShortcutLink.mock.calls.at(-1)![2], appUserModelId: '' }))
  expect(() => installDesktopShortcut(b.app, b.shell)).toThrow('did not retain')
})

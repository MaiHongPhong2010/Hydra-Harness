/** Shared Windows identity, relaunch metadata, and native Desktop shortcut writer. */
const { existsSync } = require('node:fs')
const { join, resolve } = require('node:path')

const APP_ID = 'org.hydraharness.desktop'
const WINDOW_APP_ID = `${APP_ID}.window`

/** Window properties Windows preserves when pinning Hydra to the taskbar. */
function windowAppDetails(icon, executable, entry) {
  return {
    appId: WINDOW_APP_ID,
    appIconPath: icon,
    appIconIndex: 0,
    relaunchCommand: `"${executable}" "${entry}"`,
    relaunchDisplayName: 'Hydra harness',
  }
}

/** Save and verify a shortcut with the same identity as Hydra's native windows. */
function installDesktopShortcut(app, shell) {
  const path = join(app.getPath('desktop'), 'Hydra Harness.lnk')
  const details = {
    target: process.execPath,
    args: `"${join(__dirname, 'main.cjs')}"`,
    cwd: app.getPath('home'),
    description: 'Open Hydra Harness Desktop',
    icon: join(__dirname, 'assets', 'hydra.ico'),
    iconIndex: 0,
    appUserModelId: WINDOW_APP_ID,
  }
  if (!shell.writeShortcutLink(path, existsSync(path) ? 'update' : 'create', details)) {
    throw new Error('Windows did not save the Desktop shortcut')
  }
  const saved = shell.readShortcutLink(path)
  if (Object.entries(details).some(([key, value]) => saved[key] !== value)) {
    throw new Error('Windows did not retain the Desktop shortcut identity')
  }
  return path
}

module.exports = { APP_ID, WINDOW_APP_ID, windowAppDetails, installDesktopShortcut }

if (process.versions.electron && process.argv[1] && resolve(process.argv[1]) === __filename) {
  const { app, shell } = require('electron')
  app.whenReady().then(() => {
    process.stdout.write(`${installDesktopShortcut(app, shell)}\n`)
    app.exit(0)
  }).catch(error => {
    process.stderr.write(`${error.message}\n`)
    app.exit(1)
  })
}

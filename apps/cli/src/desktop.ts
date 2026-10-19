/** Electron launcher shared by the Desktop subcommand and interactive menu. */

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { constants } from 'node:os'
import { fileURLToPath } from 'node:url'

/**
 * Open the installed desktop app and wait until its window and Host close.
 * @param args - arguments forwarded to Electron and the desktop app.
 * @param cliEntry - CLI installation whose Electron and Desktop packages to open.
 * @returns the desktop process exit status, or 1 when Electron cannot start.
 */
export function runDesktop(args: readonly string[], cliEntry = fileURLToPath(new URL('../lib/bin.js', import.meta.url))): number {
  try {
    const require = createRequire(cliEntry)
    // Electron exports its executable path to plain Node and its API to Electron.
    const electron = require('electron') as string
    const desktop = require.resolve('@hydraharness/harness-desktop')
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      HYDRA_DESKTOP_CLI_ENTRY: cliEntry,
    }
    delete environment.ELECTRON_RUN_AS_NODE
    const child = spawnSync(electron, [desktop, ...args], {
      stdio: 'inherit', env: environment, windowsHide: false,
    })
    if (child.error !== undefined) throw child.error
    return child.status ?? (child.signal === null ? 1 : 128 + constants.signals[child.signal])
  } catch (error) {
    process.stderr.write(`hydra: could not start Desktop: ${error instanceof Error ? error.message : String(error)}\n`)
    process.stderr.write('Reinstall with npm install -g @hydraharness/harness@latest; include optional dependencies and allow install scripts for Electron.\n')
    return 1
  }
}

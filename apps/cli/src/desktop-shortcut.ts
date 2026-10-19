/** Windows Desktop shortcut creation for a verified persistent npm installation. */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isAbsolute } from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)

/**
 * Create or update the current Windows user's Hydra Harness Desktop shortcut.
 * @param cliEntry - Verified global CLI entry used to resolve Electron and Desktop.
 * @returns The saved shortcut's absolute path; rejects when creation fails.
 */
export async function createDesktopShortcut(cliEntry: string): Promise<string> {
  const require = createRequire(cliEntry)
  const writer = require.resolve('@hydraharness/harness-desktop/windows-identity.cjs')
  const environment = { ...process.env }
  delete environment.ELECTRON_RUN_AS_NODE
  const { stdout } = await execute(require('electron') as string, [writer], { windowsHide: true, env: environment })
  const shortcut = stdout.trim()
  if (!isAbsolute(shortcut) || !existsSync(shortcut)) throw new Error('Windows did not save the Desktop shortcut')
  return shortcut
}

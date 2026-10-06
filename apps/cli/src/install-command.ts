/** Persistent npm command setup for an interactive, bare npx invocation. */

import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)

/**
 * Install this release through npm's global installer and verify its command.
 * An existing command at the same version is reused. npm owns the prefix,
 * platform shims, and lifecycle scripts; PATH setup remains with the user.
 * @param version - Running CLI release to install.
 * @returns Completion after installation and version verification; rejects on failure.
 */
export async function installNpxCommand(version: string): Promise<void> {
  const npm = process.env.npm_execpath
  if (npm === undefined) throw new Error('hydra: npm_execpath is required for npx command setup')
  const { stdout } = await execute(process.execPath, [npm, 'prefix', '--global'], { windowsHide: true })
  const prefix = stdout.trim()
  if (!isAbsolute(prefix)) throw new Error('hydra: npm returned an invalid global prefix')
  const windows = process.platform === 'win32'
  const modules = windows ? join(prefix, 'node_modules') : join(prefix, 'lib/node_modules')
  const binDirectory = windows ? prefix : join(prefix, 'bin')
  const shim = join(binDirectory, windows ? 'hydra.cmd' : 'hydra')
  const entry = join(modules, '@hydraharness/harness/lib/bin.js')
  const installedVersion = existsSync(entry)
    ? (await execute(process.execPath, [entry, '--version'], { windowsHide: true })).stdout.trim()
    : undefined
  if (installedVersion !== version || !existsSync(shim)) {
    process.stdout.write(`Installing hydra ${version} with npm...\n`)
    await new Promise<void>((done, reject) => {
      const child = spawn(process.execPath, [npm, 'install', '--global', `@hydraharness/harness@${version}`, '--no-audit', '--no-fund'], {
        stdio: 'inherit', windowsHide: true,
      })
      child.once('error', reject)
      child.once('close', (code) => {
        if (code === 0) done()
        else reject(new Error(`hydra: npm global installation failed (exit ${String(code)}). Check npm's error above and global-prefix permissions.`))
      })
    })
    const result = await execute(process.execPath, [entry, '--version'], { windowsHide: true })
    if (result.stdout.trim() !== version || !existsSync(shim)) {
      throw new Error('hydra: npm installation did not provide the expected hydra command')
    }
  }
  const normalize = (path: string): string => windows ? resolve(path).toLowerCase() : resolve(path)
  const path = process.env.PATH ?? process.env.Path ?? ''
  if (path.split(delimiter).some(directory => normalize(directory) === normalize(binDirectory))) {
    process.stdout.write('hydra is ready. Next time, run: hydra\n')
  } else {
    process.stdout.write(`hydra is installed. Add ${binDirectory} to PATH, then run: hydra\n`)
  }
}

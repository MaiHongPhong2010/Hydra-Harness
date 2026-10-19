/** Simulate terminal handles for the assembled launcher, with ordinary pipe input. */
import childProcess from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

for (const stream of [process.stdin, process.stdout]) {
  Object.defineProperty(stream, 'isTTY', { value: process.env.HYDRA_INSTALL_TEST_TTY !== '0' })
}

// Replace only Windows shortcut creation; the assembled CLI still runs npm and its installed app.
if (process.env.HYDRA_INSTALL_TEST_DESKTOP === '1') {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  const original = childProcess.execFile
  const replacement = (...args) => original(...args)
  replacement[promisify.custom] = async (file, args, options) => {
    if (!args[0]?.endsWith('windows-identity.cjs')) return promisify(original)(file, args, options)
    if (process.env.HYDRA_INSTALL_TEST_SHORTCUT_FAILURE === '1') throw new Error('Desktop is not writable')
    const directory = join(process.env.HYDRA_INSTALL_TEST_PREFIX, 'Desktop')
    const path = join(directory, 'Hydra Harness.lnk')
    mkdirSync(directory, { recursive: true })
    writeFileSync(path, JSON.stringify({ target: file, entry: join(dirname(args[0]), 'main.cjs') }))
    return { stdout: path + '\n', stderr: '' }
  }
  childProcess.execFile = replacement
  syncBuiltinESMExports()
}

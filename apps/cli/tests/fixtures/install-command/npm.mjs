/** Keyless npm process fixture; the release probe separately drives the real installer. */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const args = process.argv.slice(2)
const prefix = process.env.HYDRA_INSTALL_TEST_PREFIX
appendFileSync(join(prefix, 'npm-calls'), JSON.stringify(args) + '\n')
if (args[0] === 'prefix') {
  console.log(prefix)
} else if (args[0] === 'install') {
  if (process.env.HYDRA_INSTALL_TEST_FAILURE === '1') {
    console.error('npm fixture: global prefix is not writable')
    process.exitCode = 1
  } else {
    const modules = process.platform === 'win32' ? join(prefix, 'node_modules') : join(prefix, 'lib/node_modules')
    const entry = join(modules, '@hydraharness/harness/lib/bin.js')
    mkdirSync(dirname(entry), { recursive: true })
    writeFileSync(entry, `console.log(${JSON.stringify(args[2].slice('@hydraharness/harness@'.length))})\n`)
    const shim = process.platform === 'win32' ? join(prefix, 'hydra.cmd') : join(prefix, 'bin/hydra')
    mkdirSync(dirname(shim), { recursive: true })
    writeFileSync(shim, '')
  }
} else {
  throw new Error('unexpected npm invocation: ' + JSON.stringify(args))
}

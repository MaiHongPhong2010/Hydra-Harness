/**
 * Install packed tarballs into a throwaway consumer outside the repository and
 * drive the installed executable with plain Node.
 *
 * The hydra entry package carries its internal runtime closure, so this check
 * installs only that tarball. The other packed directories are still read to
 * validate their identities, but no internal package is supplied as a consumer
 * dependency. Local and global installations retain normal lifecycle scripts.
 *
 * What this proves is that `files` selected a complete payload and that the
 * published dependency ranges resolve. A workspace link or a stale `lib/` in the
 * checkout cannot stand in for a missing file here.
 */

import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { releaseFamily } from './families.ts'
import { attempt, capture, isEntry } from './process.ts'
import { packedIdentity } from './tarball.ts'

/**
 * Environment for the installed artifact: no host Node hooks, no host DeepSeek
 * Harness home, and no ambient npm user agent that would confuse npm.
 * @param consumerRoot - the throwaway consumer directory.
 * @returns The child environment.
 */
function consumerEnvironment(consumerRoot: string): NodeJS.ProcessEnv {
  const environment = { ...process.env }
  delete environment.npm_config_user_agent
  delete environment.NPM_CONFIG_USER_AGENT
  delete environment.NODE_OPTIONS
  delete environment.NODE_PATH
  environment.HYDRA_HOME = resolve(consumerRoot, '.hydra')
  environment.HYDRA_AGENTS_HOME = resolve(consumerRoot, '.agents')
  environment.HYDRA_TELEMETRY_DISABLED = '1'
  return environment
}

/**
 * Every packed tarball in the given directories, as `file:` dependency entries.
 *
 * The directories are read by their contents rather than a pack order file: a
 * directory here can hold tarballs packed only to satisfy a cross-sequence
 * dependency, which no release order describes.
 * @param directories - absolute directories holding packed tarballs.
 * @returns Package name to tarball file URL, and the version each carries.
 */
function packedDependencies(directories: readonly string[]): Map<string, { url: string; version: string }> {
  const dependencies = new Map<string, { url: string; version: string }>()
  for (const directory of directories) {
    const tarballs = readdirSync(directory).filter(name => name.endsWith('.tgz')).sort()
    if (tarballs.length === 0) throw new Error(`${directory} holds no packed tarball`)
    for (const filename of tarballs) {
      const tarball = join(directory, filename)
      const { name, version } = packedIdentity(tarball)
      dependencies.set(name, { url: pathToFileURL(tarball).href, version })
    }
  }
  return dependencies
}

/**
 * Boot the installed Web profile and verify its renderer and entry asset over HTTP.
 * @param bin - Installed CLI entry.
 * @param consumerRoot - Isolated consumer directory.
 * @param environment - Environment with an isolated Harness home.
 * @returns Completion after the HTTP checks and child-process cleanup.
 */
export async function verifyWebBoot(bin: string, consumerRoot: string, environment: NodeJS.ProcessEnv): Promise<void> {
  const child = spawn(process.execPath, [bin, 'web', '--no-open', '--port', '0'], {
    cwd: consumerRoot, env: environment, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  let output = ''
  const exited = new Promise<void>((done) => {
    child.once('close', () => { done() })
  })
  child.once('error', (error) => { output += error.message })
  child.stdout.on('data', (chunk: Buffer) => { output = (output + chunk.toString()).slice(-65_536) })
  child.stderr.on('data', (chunk: Buffer) => { output = (output + chunk.toString()).slice(-65_536) })
  try {
    const deadline = Date.now() + 60_000
    while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
      const address = /http:\/\/127\.0\.0\.1:\d+/.exec(output)?.[0]
      if (address !== undefined) {
        const response = await fetch(address, { signal: AbortSignal.timeout(5_000) })
        const html = await response.text()
        const asset = /<script[^>]+src="([^"]+)"/.exec(html)?.[1]
        if (!response.ok || !html.includes('__HYDRA_BOOT__') || asset === undefined) {
          throw new Error(`installed Web profile returned an incomplete renderer: HTTP ${String(response.status)}`)
        }
        const script = await fetch(new URL(asset, address), { signal: AbortSignal.timeout(5_000) })
        if (!script.ok || !(script.headers.get('content-type') ?? '').includes('javascript')) {
          throw new Error(`installed Web renderer entry failed: HTTP ${String(script.status)}`)
        }
        await script.arrayBuffer()
        console.log('release verify-packed-install: installed Web profile serves its renderer and entry asset')
        return
      }
      await delay(100)
    }
    throw new Error(`installed Web profile did not become ready:\n${output}`)
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    const force = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') }, 5_000)
    try { await exited } finally { clearTimeout(force) }
  }
}

/**
 * Require the installed Desktop payload and Electron executable without opening a window.
 * @param bin - installed CLI entry used for dependency resolution.
 */
export function verifyDesktopPayload(bin: string): void {
  const require = createRequire(bin)
  const desktop = require.resolve('@hydraharness/harness-desktop')
  const electron: unknown = require('electron')
  require.resolve('node-pty')
  const files = ['main.cjs', 'preload.cjs', 'windows-identity.cjs', 'assets/hydra.ico', 'assets/hydra.png',
    'tests/snapshots/terminal-workspaces.expected.json', 'tests/snapshots/zoom-shortcuts.expected.md']
  for (const file of files) {
    if (!existsSync(join(dirname(desktop), file))) throw new Error(`installed Desktop is missing ${file}`)
  }
  if (typeof electron !== 'string' || !existsSync(electron)) {
    throw new Error('installed Desktop is missing the Electron executable')
  }
}

/** Install every tarball under `--from` and drive the `--family` entry. */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { family: { type: 'string' }, from: { type: 'string', multiple: true } },
    allowPositionals: false,
  })
  if (values.family === undefined || values.from === undefined || values.from.length === 0) {
    throw new Error('usage: verify-packed-install.ts --family <hydra|vendor> --from <packed directory> [--from ...]')
  }

  const family = releaseFamily(values.family)
  const entry = family.installedEntry
  if (entry === undefined) {
    console.log(`release verify-packed-install: family ${family.id} publishes no executable, nothing to drive`)
    return
  }

  const root = process.cwd()
  const packed = packedDependencies(values.from.map(directory => resolve(root, directory)))
  const expected = packed.get(entry.packageName)
  if (expected === undefined) throw new Error(`${entry.packageName} is not among the packed tarballs`)
  const install = family.id === 'hydra'
    ? new Map([[entry.packageName, expected]])
    : packed

  const consumerRoot = mkdtempSync(join(tmpdir(), `hydra-packed-${family.id}-`))
  try {
    writeFileSync(join(consumerRoot, 'package.json'), `${JSON.stringify({
      name: `hydra-packed-install-${family.id}`,
      version: '0.0.0',
      private: true,
      dependencies: Object.fromEntries([...install].map(([name, entryPacked]) => [name, entryPacked.url])),
    }, null, 2)}\n`)

    const environment = consumerEnvironment(consumerRoot)
    console.log(`release verify-packed-install: installing ${String(install.size)} tarball(s) into ${consumerRoot}`)
    // Keep optional dependencies enabled: native packages use optional
    // platform-specific prebuilds, and npm skips the platforms that do not
    // match the runner.
    capture('npm', ['install', '--no-audit', '--no-fund', '--package-lock=false'],
      { cwd: consumerRoot, env: environment })

    const bin = join(consumerRoot, 'node_modules', ...entry.packageName.split('/'), entry.binPath)
    const version = capture(process.execPath, [bin, '--version'], { cwd: consumerRoot, env: environment })
    if (version !== expected.version) {
      throw new Error(`installed ${entry.packageName} --version reported ${JSON.stringify(version)}, expected ${expected.version}`)
    }
    const help = capture(process.execPath, [bin, '--help'], { cwd: consumerRoot, env: environment })
    if (!help.startsWith('Usage: hydra ')) throw new Error(`${entry.packageName} --help did not print the CLI usage`)
    console.log(`release verify-packed-install: installed ${entry.packageName} reports ${version}`)
    if (family.id === 'hydra') verifyDesktopPayload(bin)
    const bare = attempt(process.execPath, [bin], {
      cwd: consumerRoot,
      env: { ...environment, CI: '1' },
    })
    if (bare.status !== 1 || bare.stdout !== '' || !bare.stderr.includes('requires an interactive terminal')) {
      throw new Error(`installed ${entry.packageName} bare launcher did not report the non-interactive guidance:\n${bare.stdout}\n${bare.stderr}`)
    }
    console.log('release verify-packed-install: bare launcher rejected non-interactive input as expected')
    await verifyWebBoot(bin, consumerRoot, environment)

    if (family.id === 'hydra') {
      const prefix = join(consumerRoot, 'global')
      capture('npm', ['install', '--global', '--prefix', prefix, expected.url, '--no-audit', '--no-fund'],
        { cwd: consumerRoot, env: environment })
      const windows = process.platform === 'win32'
      const globalModules = windows ? join(prefix, 'node_modules') : join(prefix, 'lib/node_modules')
      const globalDirectory = windows ? prefix : join(prefix, 'bin')
      const globalBin = join(globalModules, ...entry.packageName.split('/'), entry.binPath)
      verifyDesktopPayload(globalBin)
      const globalVersion = capture('hydra', ['--version'], {
        cwd: consumerRoot,
        env: { ...environment, PATH: `${globalDirectory}${delimiter}${environment.PATH ?? environment.Path ?? ''}` },
      })
      if (globalVersion !== expected.version) throw new Error('global hydra shim reported an unexpected version')
      await verifyWebBoot(globalBin, consumerRoot, environment)
      console.log('release verify-packed-install: global hydra command and Web profile passed')
    }
  } finally {
    rmSync(consumerRoot, { recursive: true, force: true })
  }
}

if (isEntry(import.meta.url)) await main()

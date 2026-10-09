/** Assembled CLI transcript for persistent command setup on the first bare npx run. */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { afterEach, expect, it } from 'vitest'

const roots: string[] = []
const version = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version
const source = fileURLToPath(new URL('../src/bin.ts', import.meta.url))
const built = fileURLToPath(new URL('../lib/bin.js', import.meta.url))
const hook = new URL('./fixtures/install-command/tty.mjs', import.meta.url).href
const npm = fileURLToPath(new URL('./fixtures/install-command/npm.mjs', import.meta.url))

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'hydra-install-command-'))
  roots.push(root)
  return root
}

async function run(root: string, args: string[] = [], overrides: NodeJS.ProcessEnv = {}) {
  const directory = process.platform === 'win32' ? root : join(root, 'bin')
  const builtMode = process.env.HYDRA_EXAMPLE_MODE === 'lib'
  return execa(process.execPath, [
    ...builtMode ? [] : ['--import', 'tsx/esm'],
    '--import', hook, builtMode ? built : source, ...args,
  ], {
    input: 'q\n', reject: false, timeout: 20_000,
    env: {
      ...process.env, CI: '', NODE_OPTIONS: '', NODE_PATH: '',
      npm_command: 'exec', npm_lifecycle_event: 'npx', npm_execpath: npm,
      HYDRA_INSTALL_TEST_PREFIX: root, HYDRA_INSTALL_TEST_FAILURE: '', HYDRA_INSTALL_TEST_TTY: '1',
      PATH: `${directory}${delimiter}${process.env.PATH ?? process.env.Path ?? ''}`,
      ...overrides,
    },
    extendEnv: false,
  })
}

function calls(root: string): string[][] {
  const path = join(root, 'npm-calls')
  return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]) : []
}

it('installs the running release, then reuses it and opens the ordinary menu', async () => {
  const root = fixture()
  const first = await run(root)
  const second = await run(root)
  expect({
    firstCode: first.exitCode,
    firstOutput: first.stdout.replaceAll(version, '{{version}}'),
    secondCode: second.exitCode,
    secondOutput: second.stdout,
    stderr: first.stderr + second.stderr,
    calls: calls(root).map(args => args.map(arg => arg.replaceAll(version, '{{version}}'))),
  }).toMatchSnapshot()
})

it('reports a missing PATH entry without claiming the command is ready', async () => {
  const root = fixture()
  const result = await run(root, [], { PATH: process.env.PATH ?? process.env.Path ?? '' })
  const directory = process.platform === 'win32' ? root : join(root, 'bin')
  expect({ code: result.exitCode, output: result.stdout.replaceAll(version, '{{version}}').replaceAll(directory, '{{bin}}'), stderr: result.stderr }).toMatchSnapshot()
})

it('reports failed installation and does not open the menu', async () => {
  const root = fixture()
  const result = await run(root, [], { HYDRA_INSTALL_TEST_FAILURE: '1' })
  expect({ code: result.exitCode, output: result.stdout.replaceAll(version, '{{version}}'), stderr: result.stderr }).toMatchSnapshot()
})

it('prints Desktop command help without installing globally or opening Electron', async () => {
  const root = fixture()
  const result = await run(root, ['desktop', '--help'])
  expect({ code: result.exitCode, output: result.stdout, stderr: result.stderr, calls: calls(root) }).toMatchSnapshot()
})

it.each([
  { args: ['--version'], env: {} },
  { args: ['--help'], env: {} },
  { args: ['desktop', '--help'], env: {} },
  { args: [], env: { npm_command: '', npm_lifecycle_event: '' } },
  { args: [], env: { CI: '1' } },
  { args: [], env: { HYDRA_INSTALL_TEST_TTY: '0' } },
])('leaves npm untouched for $args and $env', async ({ args, env }) => {
  const root = fixture()
  const result = await run(root, args, env)
  expect(calls(root)).toEqual([])
  expect(result.stdout).not.toContain('Installing hydra')
})

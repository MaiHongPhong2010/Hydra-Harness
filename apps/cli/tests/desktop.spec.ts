import { spawnSync } from 'node:child_process'
import { constants } from 'node:os'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runDesktop } from '../src/desktop.ts'

vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }))
vi.mock('node:module', () => ({
  createRequire: () => Object.assign(() => '/electron', { resolve: () => '/desktop/main.cjs' }),
}))

const result = { pid: 1, output: [], stdout: '', stderr: '', status: 0, signal: null }

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.mocked(spawnSync).mockReset()
})

describe('runDesktop', () => {
  it('starts Electron with the running CLI installation and preserves user environment', () => {
    vi.stubEnv('ELECTRON_RUN_AS_NODE', '1')
    vi.stubEnv('HYDRA_HOME', '/user-home')
    vi.stubEnv('HYDRA_DESKTOP_CLI_ENTRY', '/stale/cli.js')
    vi.mocked(spawnSync).mockReturnValue(result)
    expect(runDesktop(['--smoke'])).toBe(0)
    const [binary, args, options] = vi.mocked(spawnSync).mock.calls[0]!
    expect(binary).toBe('/electron')
    expect(args).toEqual(['/desktop/main.cjs', '--smoke'])
    expect(options).toMatchObject({ stdio: 'inherit', windowsHide: true, env: {
      HYDRA_HOME: '/user-home',
      HYDRA_DESKTOP_CLI_ENTRY: fileURLToPath(new URL('../lib/bin.js', import.meta.url)),
    } })
    expect(options?.env).not.toHaveProperty('ELECTRON_RUN_AS_NODE')
  })

  it('returns failures and signal termination from the desktop process', () => {
    vi.mocked(spawnSync).mockReturnValue({ ...result, status: 7 })
    expect(runDesktop([])).toBe(7)
    vi.mocked(spawnSync).mockReturnValue({ ...result, status: null, signal: 'SIGINT' })
    expect(runDesktop([])).toBe(128 + constants.signals.SIGINT)
    vi.mocked(spawnSync).mockReturnValue({ ...result, status: null })
    expect(runDesktop([])).toBe(1)
  })

  it('reports a missing Electron binary with npm repair instructions', () => {
    const output = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    vi.mocked(spawnSync).mockReturnValue({ ...result, error: new Error('spawn ENOENT') })
    expect(runDesktop([])).toBe(1)
    expect(output.mock.calls.flat().join('')).toContain('spawn ENOENT')
    expect(output.mock.calls.flat().join('')).toContain('include optional dependencies')
  })
})

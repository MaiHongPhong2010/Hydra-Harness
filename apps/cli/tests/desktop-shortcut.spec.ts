import type { ExecFileOptions } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDesktopShortcut } from '../src/desktop-shortcut.ts'

const { execute, exists } = vi.hoisted(() => ({
  execute: vi.fn<(binary: string, args: string[], options: ExecFileOptions) => Promise<{ stdout: string }>>(),
  exists: vi.fn<(path: string) => boolean>(),
}))
vi.mock('node:child_process', () => ({ execFile: execute }))
vi.mock('node:util', () => ({ promisify: (fn: unknown) => fn }))
vi.mock('node:fs', () => ({ existsSync: exists }))
vi.mock('node:module', () => ({
  createRequire: () => Object.assign(() => '/global/electron.exe', {
    resolve: () => "/global/Phong's $Desktop/windows-identity.cjs",
  }),
}))

beforeEach(() => {
  execute.mockReset().mockResolvedValue({ stdout: '/desktop/Hydra Harness.lnk\n' })
  exists.mockReset().mockReturnValue(true)
})
afterEach(() => { vi.unstubAllEnvs() })

describe('createDesktopShortcut', () => {
  it('runs the installed Electron shortcut writer without Node-only mode', async () => {
    vi.stubEnv('ELECTRON_RUN_AS_NODE', '1')
    expect(await createDesktopShortcut('/global/lib/bin.js')).toBe('/desktop/Hydra Harness.lnk')
    const [binary, args, options] = execute.mock.calls[0]!
    expect(binary).toBe('/global/electron.exe')
    expect(args).toEqual(["/global/Phong's $Desktop/windows-identity.cjs"])
    expect(options.windowsHide).toBe(true)
    expect(options.env).not.toHaveProperty('ELECTRON_RUN_AS_NODE')
  })

  it('rejects a failed Windows operation or a shortcut that was not saved', async () => {
    execute.mockRejectedValueOnce(new Error('Desktop is not writable'))
    await expect(createDesktopShortcut('/global/lib/bin.js')).rejects.toThrow('not writable')
    exists.mockReturnValueOnce(false)
    await expect(createDesktopShortcut('/global/lib/bin.js')).rejects.toThrow('did not save')
    execute.mockResolvedValueOnce({ stdout: 'relative.lnk' })
    await expect(createDesktopShortcut('/global/lib/bin.js')).rejects.toThrow('did not save')
  })
})

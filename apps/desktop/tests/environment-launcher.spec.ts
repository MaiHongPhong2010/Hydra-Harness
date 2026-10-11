/** Clean-shutdown environment switching and owned-pipe authentication. */
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

interface Selection { value: string; home?: string }
interface Launcher {
  initialize(): Promise<Selection>
  status(): Promise<{ choices: { value: string; ready: boolean }[] }>
  select(value: string): Promise<unknown>
  active(): Selection
  cleanShutdown(): Promise<void>
  nativePath(path: string): string
  hostPath(path: string): Promise<string>
}
const { createEnvironmentLauncher, launchWslHost } = createRequire(import.meta.url)('../environment-launcher.cjs') as {
  createEnvironmentLauncher: (options: object) => Launcher
  launchWslHost: (selection: object, spawn: (command: string, args: readonly string[], options: object) => EventEmitter,
    onLine: (line: string) => void) => EventEmitter
}
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

async function bench() {
  const root = await mkdtemp(join(tmpdir(), 'hydra-environment-'))
  roots.push(root)
  const run = vi.fn(async (_command: string, args: string[]) => args[0] === '--list' ? 'Ubuntu\nBroken\n'
    : args[1] === 'Broken' ? 'HYDRA_PREFLIGHT:{"nodeVersion":"20.0.0","bridgeVersion":1}\n'
      : args[3] === 'wslpath' ? '/mnt/c/work\n' : `HYDRA_PREFLIGHT:${JSON.stringify({ nodeVersion: '22.19.0', bridgeVersion: 1, node: '/usr/bin/node', entry: '/opt/hydra/bin.js', home: '/home/user/.hydra/desktop-host' })}\n`)
  const options = { storePath: join(root, 'environment.json'), platform: 'win32', run }
  return { options, run, launcher: createEnvironmentLauncher(options) }
}

describe('Desktop environment launcher', () => {
  it('checks runtimes and applies a pending choice only following clean shutdown', async () => {
    const b = await bench()
    expect(await b.launcher.initialize()).toEqual({ value: 'native' })
    expect((await b.launcher.status()).choices).toMatchObject([{ ready: true }, { value: 'wsl:Ubuntu', ready: true }, { value: 'wsl:Broken', ready: false }])
    await expect(b.launcher.select('wsl:Broken')).rejects.toThrow('Node')
    await b.launcher.select('wsl:Ubuntu')
    expect(b.launcher.active().value).toBe('native')
    const unclean = createEnvironmentLauncher(b.options)
    expect((await unclean.initialize()).value).toBe('native')
    await unclean.cleanShutdown()
    const restarted = createEnvironmentLauncher(b.options)
    expect((await restarted.initialize()).value).toBe('wsl:Ubuntu')
    expect(restarted.nativePath('/home/user/project')).toBe('\\\\wsl.localhost\\Ubuntu\\home\\user\\project')
    expect(await restarted.hostPath('\\\\wsl.localhost\\Ubuntu\\home\\user\\project')).toBe('/home/user/project')
    const saved = JSON.parse(await readFile(b.options.storePath, 'utf8')) as { active: Selection }
    expect(saved.active.home).toBe('/home/user/.hydra/desktop-host')
    expect(() => restarted.nativePath('/home/../etc')).toThrow('Invalid')
    await expect(restarted.select('wsl:Ubuntu\nmalicious')).rejects.toThrow('Invalid')
  })

  it('accepts bridge frames only from the owned child with its launch token', async () => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() })
    let handshake = ''
    child.stdin.on('data', (data) => { handshake += String(data) })
    const spawn = vi.fn((_command: string, _args: readonly string[], _options: object) => child)
    const log = vi.fn()
    const port = launchWslHost({ distro: 'Ubuntu', node: '/usr/bin/node', entry: '/opt/bin.js', home: '/home/user/.hydra' }, spawn, log)
    const message = vi.fn()
    port.on('message', message)
    const { token } = JSON.parse(handshake) as { token: string }
    child.stdout.write('Host ready\n')
    child.stdout.write(`HYDRA_DESKTOP_BRIDGE:${JSON.stringify({ token: 'wrong', message: { type: 'privileged' } })}\n`)
    child.stdout.write(`HYDRA_DESKTOP_BRIDGE:${JSON.stringify({ token, message: { type: 'ready' } })}\n`)
    expect(message).toHaveBeenCalledExactlyOnceWith({ type: 'ready' })
    expect(log).toHaveBeenCalledExactlyOnceWith('Host ready')
    expect(spawn.mock.calls[0]?.[2]).toMatchObject({ windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    child.stdout.end()
    child.stdin.end()
  })
})

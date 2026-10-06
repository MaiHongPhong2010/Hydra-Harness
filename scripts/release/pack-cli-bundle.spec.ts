/** Installed-consumer regression for pnpm patches embedded in the npm CLI. */

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { packCliBundle } from './pack-cli-bundle.ts'
import { tarballName, type ReleaseMember } from './families.ts'
import { capture, run } from './process.ts'

const roots: string[] = []

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function packed(root: string, output: string, name: string, directory: string,
  dependencies: Record<string, string>, code: string): ReleaseMember {
  const manifest = {
    name, version: '1.0.0', type: 'module', exports: './lib/index.js',
    files: ['lib'], dependencies, repository: { directory },
  }
  const member = { name, version: manifest.version, directory, manifest }
  const source = join(root, directory)
  write(join(source, 'package.json'), JSON.stringify(manifest))
  write(join(source, 'lib/index.js'), code)
  const stage = join(root, 'pack-' + directory.replaceAll('/', '-'), 'package')
  cpSync(source, stage, { recursive: true })
  run('tar', ['-czf', join(output, tarballName(member)), '-C', dirname(stage), 'package'])
  return member
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it.each(['1.0.0', '1.0.1'])('validates installed patched SDK version %s before bundling it', (sdkVersion) => {
  const root = mkdtempSync(join(tmpdir(), 'hydra-patched-bundle-'))
  roots.push(root)
  const hydra = join(root, 'hydra')
  const vendor = join(root, 'vendor')
  mkdirSync(hydra)
  mkdirSync(vendor)
  const cli = packed(root, hydra, '@hydraharness/harness', 'apps/cli',
    { '@hydraharness/harness-adapter': '1.0.0' },
    'import { value } from "@hydraharness/harness-adapter"; console.log(value)\n')
  packed(root, hydra, '@hydraharness/harness-adapter', 'packages/llm/adapter',
    { '@fixture/sdk': '1.0.0', 'node-pty': '1.0.0' }, 'export { value } from "@fixture/sdk/api/patched"\n')
  packed(root, vendor, '@hydraharness/cordis', 'vendor/cordis', {}, 'export {}\n')
  write(join(root, 'pnpm-workspace.yaml'), 'patchedDependencies:\n  "@fixture/sdk@1.0.0": patches/sdk.patch\n  "node-pty@1.0.0": patches/pty.patch\n')
  const sdk = join(root, 'packages/llm/adapter/node_modules/@fixture/sdk')
  write(join(sdk, 'package.json'), JSON.stringify({
    name: '@fixture/sdk', version: sdkVersion, type: 'module', files: ['dist'],
    exports: { '.': { import: './dist/index.js' }, './api/*': { import: './dist/api/*.js' } },
  }))
  write(join(sdk, 'dist/index.js'), 'export {}\n')
  write(join(sdk, 'dist/api/patched.js'), 'export const value = "installed-patch"\n')
  vi.spyOn(process, 'cwd').mockReturnValue(root)

  if (sdkVersion !== '1.0.0') {
    expect(() => packCliBundle(hydra, cli, vendor)).toThrow('not installed at a version selected by patchedDependencies')
    return
  }

  const tarball = packCliBundle(hydra, cli, vendor)
  const consumer = join(root, 'consumer')
  mkdirSync(consumer)
  run('tar', ['-xzf', join(hydra, tarball), '-C', consumer])
  const manifest = JSON.parse(readFileSync(join(consumer, 'package/package.json'), 'utf8')) as {
    bundleDependencies: string[]
    dependencies: Record<string, string>
  }
  expect(manifest.bundleDependencies).toContain('@fixture/sdk')
  expect(manifest.bundleDependencies).not.toContain('node-pty')
  expect(manifest.dependencies['node-pty']).toBe('1.0.0')
  expect(capture(process.execPath, [join(consumer, 'package/lib/index.js')], { cwd: consumer })).toBe('installed-patch')
}, 30_000)

it('installs external dependencies and their lifecycle scripts under a global prefix', () => {
  const root = mkdtempSync(join(tmpdir(), 'hydra-global~bundle-'))
  roots.push(root)
  const hydra = join(root, 'hydra')
  const vendor = join(root, 'vendor')
  const external = join(root, 'external')
  mkdirSync(hydra)
  mkdirSync(vendor)
  mkdirSync(external)
  write(join(external, 'package.json'), JSON.stringify({
    name: 'fixture-native', version: '1.0.0', type: 'module', exports: './index.js',
    scripts: { install: 'node install.js' },
  }))
  write(join(external, 'install.js'), 'import { writeFileSync } from "node:fs"; writeFileSync("installed", "ready")\n')
  write(join(external, 'index.js'), 'import { readFileSync } from "node:fs"; export const value = readFileSync(new URL("installed", import.meta.url), "utf8")\n')
  capture('npm', ['pack', '--pack-destination', root], { cwd: external })
  const cli = packed(root, hydra, '@hydraharness/harness', 'apps/cli',
    { '@hydraharness/harness-adapter': '1.0.0' },
    'import { value } from "@hydraharness/harness-adapter"; console.log(value)\n')
  packed(root, hydra, '@hydraharness/harness-adapter', 'packages/llm/adapter',
    // npm file specs keep Windows short-path tildes literal, unlike file URLs.
    { 'fixture-native': 'file:' + join(root, 'fixture-native-1.0.0.tgz').replaceAll('\\', '/') },
    'export { value } from "fixture-native"\n')
  packed(root, vendor, '@hydraharness/cordis', 'vendor/cordis', {}, 'export {}\n')
  write(join(root, 'pnpm-workspace.yaml'), 'patchedDependencies: {}\n')
  vi.spyOn(process, 'cwd').mockReturnValue(root)
  const tarball = packCliBundle(hydra, cli, vendor)
  const prefix = join(root, 'global')
  capture('npm', ['install', '--global', '--prefix', prefix, join(hydra, tarball), '--no-audit', '--no-fund'], { cwd: root })
  const modules = process.platform === 'win32' ? join(prefix, 'node_modules') : join(prefix, 'lib/node_modules')
  expect(capture(process.execPath, [join(modules, '@hydraharness/harness/lib/index.js')], { cwd: root })).toBe('ready')
}, 30_000)

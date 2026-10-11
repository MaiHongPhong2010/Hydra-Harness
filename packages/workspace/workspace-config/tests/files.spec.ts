import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { initializeFiles, withinRoot } from '../src/files.ts'

const directories: string[] = []

afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function directory(): Promise<string> {
  const result = await mkdtemp(join(tmpdir(), 'hydra-workspace-files-'))
  directories.push(result)
  return result
}

describe('workspace scaffolding', () => {
  it('creates missing regular files and preserves existing bytes on repeated initialization', async () => {
    const root = await directory()
    await mkdir(join(root, '.hydra'))
    await writeFile(join(root, '.hydra', 'settings.yaml'), '# keep this comment\npermission: {}\n')
    await initializeFiles(root)
    await initializeFiles(root)
    expect(await readFile(join(root, '.hydra', 'settings.yaml'), 'utf8')).toBe('# keep this comment\npermission: {}\n')
    expect(await readFile(join(root, '.hydra', 'settings.local.yaml'), 'utf8')).toBe('')
    expect(await readFile(join(root, '.hydra', '.gitignore'), 'utf8')).toBe('settings.local.yaml\nAGENTS.local.md\n')
    expect((await lstat(join(root, '.hydra', 'AGENTS.md'))).isFile()).toBe(true)
  })

  it('rejects an escaping .hydra junction without changing outside files', async () => {
    const root = await directory()
    const outside = await directory()
    await writeFile(join(outside, 'settings.yaml'), 'victim\n')
    await symlink(outside, join(root, '.hydra'), process.platform === 'win32' ? 'junction' : 'dir')
    try {
      await expect(initializeFiles(root)).rejects.toThrow('regular directory')
      expect(await readFile(join(outside, 'settings.yaml'), 'utf8')).toBe('victim\n')
    } finally {
      await unlink(join(root, '.hydra'))
    }
  })

  it('rejects a directory in a file slot before creating other missing files', async () => {
    const root = await directory()
    await mkdir(join(root, '.hydra', 'AGENTS.local.md'), { recursive: true })
    await expect(initializeFiles(root)).rejects.toThrow('regular file')
    await expect(lstat(join(root, '.hydra', 'settings.yaml'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('completes a partially initialized directory without replacing its ignore file', async () => {
    const root = await directory()
    await mkdir(join(root, '.hydra'))
    await writeFile(join(root, '.hydra', '.gitignore'), 'custom\n')
    await initializeFiles(root)
    expect(await readFile(join(root, '.hydra', '.gitignore'), 'utf8')).toBe('custom\n')
    expect((await lstat(join(root, '.hydra', 'settings.local.yaml'))).isFile()).toBe(true)
  })

  it('matches descendants by path segment', () => {
    const root = join(tmpdir(), 'project')
    expect(withinRoot(root, root)).toBe(true)
    expect(withinRoot(root, join(root, 'nested'))).toBe(true)
    expect(withinRoot(root, `${root}-other`)).toBe(false)
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('rejects a read-only workspace before creating its settings', async () => {
    const root = await directory()
    await chmod(root, 0o500)
    try {
      await expect(initializeFiles(root)).rejects.toMatchObject({ code: 'EACCES' })
    } finally {
      await chmod(root, 0o700)
    }
    await expect(lstat(join(root, '.hydra'))).rejects.toMatchObject({ code: 'ENOENT' })
    await initializeFiles(root)
    expect((await lstat(join(root, '.hydra', 'settings.yaml'))).isFile()).toBe(true)
  })
})

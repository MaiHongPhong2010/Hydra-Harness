/** Idempotent creation of regular workspace configuration files. @module */

import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'

/**
 * Whether a canonical candidate is within a canonical root, including the root itself.
 * @param root - Canonical ancestor directory.
 * @param candidate - Canonical path to test.
 * @returns whether the candidate is the root or one of its descendants.
 */
export function withinRoot(root: string, candidate: string): boolean {
  const suffix = relative(root, candidate)
  return suffix !== '..' && !suffix.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(suffix)
}

/** Validate a regular, confined path, optionally allowing an absent file. */
async function regular(root: string, path: string, directory: boolean, optional = false): Promise<void> {
  let entry
  try {
    entry = await lstat(path)
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (entry.isSymbolicLink() || (directory ? !entry.isDirectory() : !entry.isFile())) {
    throw new Error(`workspace-config: ${path} must be a regular ${directory ? 'directory' : 'file'}`)
  }
  if (!withinRoot(root, await realpath(path))) {
    throw new Error(`workspace-config: ${path} resolves outside workspace ${root}`)
  }
}

/**
 * Create only absent workspace files and retain all existing bytes.
 * Links, nonregular entries, and filesystem failures reject before publication.
 * @param root - Canonical existing workspace directory.
 */
export async function initializeFiles(root: string): Promise<void> {
  const directory = join(root, '.hydra')
  try {
    await mkdir(directory, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  await regular(root, directory, true)
  const files = [
    ['settings.yaml', ''],
    ['settings.local.yaml', ''],
    ['AGENTS.md', ''],
    ['.gitignore', 'settings.local.yaml\nAGENTS.local.md\n'],
  ] as const
  for (const [filename] of files) await regular(root, join(directory, filename), false, true)
  await regular(root, join(directory, 'AGENTS.local.md'), false, true)
  for (const [filename, content] of files) {
    await regular(root, directory, true)
    const path = join(directory, filename)
    try {
      await writeFile(path, content, { flag: 'wx', mode: 0o600 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    await regular(root, path, false)
  }
}

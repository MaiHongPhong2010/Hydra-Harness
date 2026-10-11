/**
 * Copying, reading, and deleting locally authored presets.
 *
 * Authoring is confined to a `user` root: the shipped `.system` set is part of
 * the deployment, and letting a browser rewrite it would turn "reset to a known
 * preset" into something the same caller could have broken first.
 *
 * The only authoring write is a whole-directory copy of an existing preset.
 * No caller supplies composition text: the inputs are ids the host resolves
 * against its own roots plus an optional display name, so authoring grants no
 * capability the copied preset did not already carry.
 * @module @hydraharness/harness-agent-presets/authoring
 */

import { chmod, cp, lstat, readdir, readFile, rm, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { writeFileAtomic } from '@hydraharness/harness-atomic-write'
import { canonicalizeWatchPath, expandHomePath } from '@hydraharness/harness-home-paths'
import { METADATA_FILE, renderPresetMetadata } from './metadata.ts'
import { PRESET_ID, type AgentPreset, type PresetRoot } from './preset.ts'

/** A preset id that cannot be used as a directory name under a root. */
export class InvalidPresetIdError extends Error {
  constructor(
    /** The rejected id. */
    readonly presetId: string,
  ) {
    super(
      `agent-presets: preset id ${JSON.stringify(presetId)} must match ${String(PRESET_ID)} — `
      + 'the id is a directory name, so anything else could escape the preset root',
    )
  }
}

/** A copy target that is already occupied — a copy never overwrites. */
export class PresetExistsError extends Error {
  constructor(
    /** The id that is already taken. */
    readonly presetId: string,
  ) {
    super(
      `agent-presets: preset "${presetId}" already exists — `
      + 'a copy never overwrites; delete the existing preset first or choose another id',
    )
  }
}

/** Authoring was attempted where the deployment allows none. */
export class PresetNotWritableError extends Error {
  constructor(
    /** What the caller tried to change, for the diagnostic. */
    readonly presetId: string,
    reason: string,
  ) {
    super(`agent-presets: preset "${presetId}" cannot be written: ${reason}`)
  }
}

/**
 * The root locally authored presets are written to.
 * @param roots - the configured roots in precedence order.
 * @returns the absolute path of the first `user` root.
 * @throws when the deployment configured no writable root.
 */
export function writableRoot(roots: readonly PresetRoot[]): string {
  const root = roots.find(candidate => candidate.trust === 'user')
  if (root === undefined) {
    throw new PresetNotWritableError('', 'this deployment configures no user-writable preset root')
  }
  return resolve(expandHomePath(root.path))
}

/**
 * Read one preset's composition text.
 * @param preset - the resolved preset.
 * @returns the file's contents.
 */
export async function readComposition(preset: AgentPreset): Promise<string> {
  return await readFile(preset.path, 'utf8')
}

/** Whether anything occupies the path (cp's own errorOnExist backstops races). */
async function occupied(path: string): Promise<boolean> {
  let present = true
  try {
    await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    present = false
  }
  return present
}

/** Whether a canonical path belongs to a directory rather than a sibling prefix. */
function withinDirectory(root: string, path: string): boolean {
  const offset = relative(root, path)
  return !isAbsolute(offset) && offset !== '..' && !offset.startsWith(`..${sep}`)
}

/** Check the real destination before an authoring operation follows directory links. */
async function confinedRoot(root: string, id: string, workspaceRoot?: string): Promise<string> {
  const canonical = await canonicalizeWatchPath(root)
  if (workspaceRoot !== undefined && !withinDirectory(workspaceRoot, canonical)) {
    throw new PresetNotWritableError(id, 'the preset root resolves outside its workspace')
  }
  return canonical
}

/**
 * Resolve one preset directory that its authoring root owns, refusing links that escape it.
 * @param roots - authoring roots; the first user root owns writable presets.
 * @param preset - preset whose directory or composition an editor will modify.
 * @param workspaceRoot - optional canonical workspace containing the authoring root.
 * @returns the writable directory after canonical path checks.
 * @throws when the preset ships, belongs to another root, or follows an escaping link.
 */
export async function authoringDirectory(
  roots: readonly PresetRoot[], preset: AgentPreset, workspaceRoot?: string,
): Promise<string> {
  if (preset.trust !== 'user') throw new PresetNotWritableError(preset.id, 'it ships with the deployment')
  const root = writableRoot(roots)
  const dir = join(root, preset.id)
  if (!isAbsolute(preset.path) || dirname(preset.path) !== dir) {
    throw new PresetNotWritableError(preset.id, 'it does not live under the writable preset root')
  }
  const canonicalRoot = await confinedRoot(root, preset.id, workspaceRoot)
  const canonicalDir = await canonicalizeWatchPath(dir)
  const canonicalFile = await canonicalizeWatchPath(preset.path)
  if (!withinDirectory(canonicalRoot, canonicalDir) || !withinDirectory(canonicalDir, canonicalFile)) {
    throw new PresetNotWritableError(preset.id, 'its directory or composition resolves outside the writable preset root')
  }
  if ((await lstat(dir)).isSymbolicLink()) {
    throw new PresetNotWritableError(preset.id, 'its directory is a symlink or junction')
  }
  return dir
}

/**
 * Re-tighten a copied tree to owner-only. A shipped preset is world-readable
 * in its install and `cp` preserves that; the copy carries the same weight as
 * the settings document beside it, so group/other access is stripped. A
 * file's owner-execute bit survives — a preset may ship runnable helpers.
 */
async function tightenModes(dir: string): Promise<void> {
  await chmod(dir, 0o700)
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const target = join(dir, entry.name)
    if (entry.isDirectory()) {
      await tightenModes(target)
    } else {
      /* v8 ignore next -- Windows exposes no POSIX owner-execute bit; the POSIX lane covers both file modes. */
      await chmod(target, ((await stat(target)).mode & 0o100) === 0 ? 0o600 : 0o700)
    }
  }
}

/**
 * Create a preset by copying an existing one's whole directory.
 *
 * The copy carries everything the source directory holds — composition,
 * metadata, skill directories, assets — because a preset is its directory,
 * not one file. Symlinks are dereferenced so the copy is self-contained
 * rather than a set of links back into the install it was copied from.
 *
 * The copied metadata is then rewritten: the source's description is kept
 * (the file is the author's to edit afterwards), but its name and roster
 * `order` are not — a copy presenting itself identically to its source, or
 * sorted into the shipped set's declared order, would make the roster stop
 * distinguishing them. With no name given and no description to keep, the
 * file is removed so the copy publishes nothing rather than a blank.
 * @param roots - the configured roots; the first `user` one receives the copy.
 * @param source - the resolved preset the copy starts from.
 * @param id - the new preset's id, which becomes its directory name.
 * @param name - display name for the copy; omitted falls back to the id.
 * @param workspaceRoot - optional canonical workspace containing the destination root.
 * @returns the absolute path of the new preset directory.
 * @throws when the id is unusable or already occupied on disk, or the
 * deployment configures no writable root.
 */
export async function copyComposition(
  roots: readonly PresetRoot[],
  source: AgentPreset,
  id: string,
  name?: string,
  workspaceRoot?: string,
): Promise<string> {
  if (!PRESET_ID.test(id)) throw new InvalidPresetIdError(id)
  const root = writableRoot(roots)
  await confinedRoot(root, id, workspaceRoot)
  const dir = join(root, id)
  // The roster check upstream only sees discovered presets; a directory with
  // no composition file still occupies the name and deserves a readable
  // refusal rather than a filesystem error code.
  if (await occupied(dir)) throw new PresetExistsError(id)
  try {
    await cp(dirname(source.path), dir, {
      recursive: true, dereference: true, force: false, errorOnExist: true,
    })
    await tightenModes(dir)
    const rendered = renderPresetMetadata({
      ...name === undefined ? {} : { name },
      ...source.description === undefined ? {} : { description: source.description },
    })
    const metadataPath = join(dir, METADATA_FILE)
    if (rendered === undefined) {
      await rm(metadataPath, { force: true })
    } else {
      await writeFileAtomic(metadataPath, rendered, { mode: 0o600, dirMode: 0o700 })
    }
  } catch (error) {
    // A half-copied directory would be invisible to discovery at best and a
    // mountable-but-incomplete preset at worst; a failed copy leaves nothing.
    await rm(dir, { recursive: true, force: true })
    throw error
  }
  return dir
}

/**
 * Delete a locally authored preset.
 *
 * A shipped preset is refused: it belongs to the deployment. A preset a live
 * session mounted is NOT refused — the composition was read at creation and is
 * never re-read, so that session keeps running exactly as it was.
 * @param roots - the configured roots.
 * @param preset - the resolved preset to remove.
 * @param workspaceRoot - optional canonical workspace containing the authoring root.
 * @throws when the preset ships with the deployment or lies outside the writable root.
 */
export async function deleteComposition(
  roots: readonly PresetRoot[],
  preset: AgentPreset,
  workspaceRoot?: string,
): Promise<void> {
  const dir = await authoringDirectory(roots, preset, workspaceRoot)
  await rm(dir, { recursive: true, force: true })
}

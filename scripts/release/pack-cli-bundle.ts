/** Pack the CLI with its internal and patched runtime packages for a bare npm install. */

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { findPackageJSON } from 'node:module'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { load } from 'js-yaml'
import { validateTarballPayload } from '../publication-payload.ts'
import { tarballFiles } from './tarball.ts'
import { tarballName, type ReleaseMember } from './families.ts'
import { capture, run } from './process.ts'

/** A packed package and its manifest. */
interface PackedPackage {
  /** Package name. */
  readonly name: string
  /** Package version. */
  readonly version: string
  /** Package manifest. */
  readonly manifest: Record<string, unknown>
  /** Source tarball. */
  readonly tarball: string
}

/** Dependency sections that can add an internal package to the bundled closure. */
const DEPENDENCY_SECTIONS = ['dependencies', 'optionalDependencies', 'peerDependencies'] as const

/** Read a JSON object from disk. */
function readManifest(path: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(path + ' is not a JSON object')
  }
  return value as Record<string, unknown>
}

/** Read a packed package manifest without extracting the package. */
function packedPackage(tarball: string): PackedPackage {
  const manifest: unknown = JSON.parse(capture('tar', ['-xOzf', tarball, 'package/package.json']))
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error(tarball + ' has no package manifest')
  }
  const record = manifest as Record<string, unknown>
  if (typeof record.name !== 'string' || typeof record.version !== 'string') {
    throw new Error(tarball + ' manifest lacks name/version')
  }
  return { name: record.name, version: record.version, manifest: record, tarball }
}

/** Return dependency declarations as a string map. */
function dependencyMap(value: unknown): Record<string, string> {
  if (value === undefined) return {}
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('package dependency declarations must be objects')
  }
  const result: Record<string, string> = {}
  for (const [name, range] of Object.entries(value)) {
    if (typeof range !== 'string' || range === '') throw new Error(name + ' has an invalid dependency range')
    result[name] = range
  }
  return result
}

/** Whether a peer declaration is marked optional. */
function isOptionalPeer(manifest: Record<string, unknown>, name: string): boolean {
  const metadata = manifest.peerDependenciesMeta
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) return false
  const entry = (metadata as Record<string, unknown>)[name]
  return entry !== null
    && typeof entry === 'object'
    && !Array.isArray(entry)
    && (entry as Record<string, unknown>).optional === true
}

/** Copy one packed package into the CLI's bundled node_modules tree. */
function unpackPackage(packageInfo: PackedPackage, nodeModules: string, temporary: string): void {
  const extract = join(temporary, 'extract-' + packageInfo.name.replaceAll('/', '-'))
  mkdirSync(extract)
  run('tar', ['-xzf', packageInfo.tarball, '-C', extract])
  const target = join(nodeModules, ...packageInfo.name.split('/'))
  mkdirSync(dirname(target), { recursive: true })
  if (existsSync(target)) rmSync(target, { recursive: true, force: true })
  cpSync(join(extract, 'package'), target, { recursive: true, dereference: true })
  rmSync(extract, { recursive: true, force: true })
}

/** Remove source and source-map files carried by vendored packages. */
function stripForbiddenNestedFiles(directory: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'src') {
        rmSync(path, { recursive: true, force: true })
      } else {
        stripForbiddenNestedFiles(path)
      }
    } else if (entry.name.endsWith('.d.ts.map') || entry.name.endsWith('.js.map')) {
      rmSync(path, { force: true })
    }
  }
}

/** Add one external dependency, retaining required declarations over optional ones. */
function addExternal(
  dependencies: Record<string, string>,
  optionalDependencies: Record<string, string>,
  name: string,
  range: string,
  optional: boolean,
): void {
  if (optional) {
    if (dependencies[name] === undefined && optionalDependencies[name] === undefined) {
      optionalDependencies[name] = range
    }
    return
  }
  dependencies[name] ??= range
  Reflect.deleteProperty(optionalDependencies, name)
}

/** Pack installed pnpm patches that the release packages depend on. */
function packPatchedDependencies(packages: readonly PackedPackage[], temporary: string): PackedPackage[] {
  const workspace: unknown = load(readFileSync(resolve('pnpm-workspace.yaml'), 'utf8'))
  if (workspace === null || typeof workspace !== 'object' || Array.isArray(workspace)) {
    throw new Error('pnpm-workspace.yaml must declare an object')
  }
  const patches = dependencyMap((workspace as Record<string, unknown>).patchedDependencies)
  const patched = new Map<string, PackedPackage>()
  for (const owner of packages) {
    for (const section of DEPENDENCY_SECTIONS) {
      for (const name of Object.keys(dependencyMap(owner.manifest[section]))) {
        // The node-pty patch serves embedded executables; plain Node installs need npm's platform prebuilds.
        if (name === 'node-pty') continue
        if (patched.has(name) || !Object.keys(patches).some(key => key === name || key.startsWith(`${name}@`))) continue
        const repository = owner.manifest.repository
        if (repository === null || typeof repository !== 'object' || Array.isArray(repository)
          || typeof (repository as Record<string, unknown>).directory !== 'string') {
          throw new Error(`${owner.name} must declare repository.directory to resolve its patched dependency ${name}`)
        }
        const directory = (repository as { directory: string }).directory
        const manifestPath = findPackageJSON(name, pathToFileURL(resolve(directory, 'package.json')))
        if (manifestPath === undefined) throw new Error(`${owner.name} cannot resolve patched dependency ${name}`)
        const manifest = readManifest(manifestPath)
        if (manifest.name !== name || typeof manifest.version !== 'string'
          || (patches[name] === undefined && patches[`${name}@${manifest.version}`] === undefined)) {
          throw new Error(`${name} is not installed at a version selected by patchedDependencies`)
        }
        const member: ReleaseMember = { directory: dirname(manifestPath), name, version: manifest.version, manifest }
        const stage = join(temporary, 'patched-' + name.replaceAll('/', '-'))
        cpSync(member.directory, stage, {
          recursive: true, dereference: true, filter: source => basename(source) !== 'node_modules',
        })
        run('npm', ['pack', '--ignore-scripts', '--pack-destination', temporary], { cwd: stage })
        patched.set(name, packedPackage(join(temporary, tarballName(member))))
      }
    }
  }
  return [...patched.values()]
}

/**
 * Pack the CLI with its internal dependency and peer closure and installed pnpm patches.
 * Bundled packages are opaque to npm's peer resolver; other external packages
 * stay ordinary dependencies so npm selects their platform-specific implementations.
 *
 * @param destination - directory holding hydra tarballs and receiving the replacement.
 * @param member - the CLI release member.
 * @param vendorDirectory - directory holding packed vendored framework packages.
 * @returns The final tarball filename.
 */
export function packCliBundle(
  destination: string,
  member: ReleaseMember,
  vendorDirectory: string,
): string {
  const temporary = mkdtempSync(join(tmpdir(), 'hydra-cli-bundle-'))
  const output = join(destination, tarballName(member))
  try {
    const hydraTarballs = readdirSync(destination)
      .filter(name => name.endsWith('.tgz') && name !== tarballName(member))
      .sort()
      .map(name => join(destination, name))
    const vendorRoot = resolve(vendorDirectory)
    const vendorTarballs = readdirSync(vendorRoot)
      .filter(name => name.endsWith('.tgz'))
      .sort()
      .map(name => join(vendorRoot, name))
    if (vendorTarballs.length === 0) throw new Error(vendorDirectory + ' holds no vendor tarballs')

    const packages = [...hydraTarballs, ...vendorTarballs].map(packedPackage)
    packages.push(...packPatchedDependencies(packages, temporary))
    const byName = new Map(packages.map(packageInfo => [packageInfo.name, packageInfo]))
    const cliTarball = packedPackage(output)
    byName.set(cliTarball.name, cliTarball)

    const vendorPackages = vendorTarballs.map(packedPackage)
    const temporaryCli = join(temporary, 'cli')
    mkdirSync(temporaryCli)
    run('tar', ['-xzf', output, '-C', temporaryCli])
    const stage = join(temporary, 'package')
    renameSync(join(temporaryCli, 'package'), stage)
    const nodeModules = join(stage, 'node_modules')
    mkdirSync(nodeModules)

    const internal = new Set<string>()
    const queue = [cliTarball.name, ...vendorPackages.map(packageInfo => packageInfo.name)]
    const external: Record<string, string> = {}
    const optionalExternal: Record<string, string> = {}
    const visited = new Set<string>()
    while (queue.length > 0) {
      const name = queue.shift()
      if (name === undefined || visited.has(name)) continue
      visited.add(name)
      const packageInfo = byName.get(name)
      if (packageInfo === undefined) throw new Error('bundled package ' + name + ' is missing from packed output')
      internal.add(name)
      for (const section of DEPENDENCY_SECTIONS) {
        const dependencies = dependencyMap(packageInfo.manifest[section])
        for (const [dependency, range] of Object.entries(dependencies)) {
          if (byName.has(dependency)) {
            queue.push(dependency)
          } else if (dependency.startsWith('@hydraharness/')
            && dependency !== '@hydraharness/node-addon-landlock-run') {
            throw new Error(packageInfo.name + ' refers to unbundled package ' + dependency)
          } else {
            addExternal(external, optionalExternal, dependency, range,
              section === 'optionalDependencies' || (section === 'peerDependencies'
                && isOptionalPeer(packageInfo.manifest, dependency)))
          }
        }
      }
    }

    for (const name of [...internal].sort()) {
      if (name === member.name) continue
      const packageInfo = byName.get(name)
      if (packageInfo === undefined) throw new Error('bundled package ' + name + ' has no tarball')
      unpackPackage(packageInfo, nodeModules, temporary)
    }
    stripForbiddenNestedFiles(nodeModules)

    const manifestPath = join(stage, 'package.json')
    const manifest = readManifest(manifestPath)
    const originalOptional = dependencyMap(manifest.optionalDependencies)
    const bundledNames = [...internal].filter(name => name !== member.name).sort()
    for (const name of bundledNames) {
      const packageInfo = byName.get(name)
      if (packageInfo === undefined) throw new Error('bundled package ' + name + ' has no tarball')
      external[name] = packageInfo.version
      Reflect.deleteProperty(optionalExternal, name)
    }
    for (const [name, range] of Object.entries(originalOptional)) {
      addExternal(external, optionalExternal, name, range, true)
    }
    manifest.dependencies = external
    manifest.optionalDependencies = optionalExternal
    manifest.bundleDependencies = bundledNames
    delete manifest.peerDependencies
    delete manifest.peerDependenciesMeta
    delete manifest.devDependencies
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')

    rmSync(output, { force: true })
    run('npm', ['pack', '--pack-destination', destination], { cwd: stage })
    validateTarballPayload(tarballFiles(output), member.name)
    return tarballName(member)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

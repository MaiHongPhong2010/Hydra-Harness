/**
 * The verify-cordis-config metadata contract: `disabled` is the one entry
 * metadata field whose `!!js` expression the Loader interpolates; every other
 * metadata field must stay static, and a disabled expression must parse.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  bundleManifestPaths,
  bundlePluginDependencyErrors,
  metadataExpressionErrors,
} from './verify-cordis-config.ts'

describe('verify-cordis-config metadata expressions', () => {
  it('keeps required functionality separate from restart-only metadata', () => {
    expect(metadataExpressionErrors({ pluginType: 'normal', pluginRequired: true }, '[0]')).toEqual([])
    expect(metadataExpressionErrors({ pluginType: 'core', pluginRequired: false }, '[0]')).toEqual([])
    expect(metadataExpressionErrors({ pluginRequired: 'core' }, '[0]')).toEqual(['[0].pluginRequired: must be boolean'])
  })
  it('validates plugin lifecycle metadata and rejects the snake_case spelling', () => {
    for (const pluginType of [undefined, 'core', 'normal']) {
      expect(metadataExpressionErrors({ pluginType, pluginGroup: 'settings-ui' }, '[0]')).toEqual([])
    }
    expect(metadataExpressionErrors({ plugin_type: 'core', pluginType: 'critical', pluginGroup: '' }, '[0]')).toEqual([
      '[0].pluginType: must be core or normal',
      '[0].pluginGroup: must be a non-empty string',
      '[0].plugin_type: use pluginType',
    ])
  })

  it('requires a browser-roster row to declare core classification', () => {
    const client = { id: 'ui-tool', name: '@hydraharness/harness-client-ui-tool' }
    expect(metadataExpressionErrors({ ...client, pluginType: 'core' }, '[0]')).toEqual([])
    expect(metadataExpressionErrors(client, '[0]')).toEqual([
      '[0].pluginType: a @hydraharness/harness-client-* row must be core',
    ])
    expect(metadataExpressionErrors({ id: 'fs-review', name: '@hydraharness/harness-fs-review' }, '[0]')).toEqual([])
  })
  it('accepts a disabled !!js expression', () => {
    const problems = metadataExpressionErrors(
      { id: 'tool-bash', name: '@hydraharness/harness-tool-bash', disabled: { __jsExpr: "process.platform === 'win32'" } },
      '[0]',
    )
    expect(problems).toEqual([])
  })

  it('rejects an expression in a static metadata field', () => {
    const problems = metadataExpressionErrors({ id: { __jsExpr: 'process.platform' }, name: 'pkg' }, '[0]')
    expect(problems).toContain('[0].id: !!js is not interpolated here')
  })

  it('rejects an expression nested below disabled (only the field itself interpolates)', () => {
    const problems = metadataExpressionErrors(
      { id: 'tool-bash', name: 'pkg', disabled: { when: { __jsExpr: 'process.platform' } } },
      '[0]',
    )
    expect(problems).toContain('[0].disabled.when: !!js is not interpolated here')
  })

  it('rejects a disabled expression that does not parse (the loader would fail the boot)', () => {
    const problems = metadataExpressionErrors(
      { id: 'tool-bash', name: 'pkg', disabled: { __jsExpr: 'process.platform ===' } },
      '[0]',
    )
    expect(problems.some(problem => problem.includes('[0].disabled: disabled expression does not parse'))).toBe(true)
  })
})

describe('workspace Bundle discovery and product dependency closures', () => {
  it('discovers a Bundle outside packages/bundle from its manifest declaration', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'hydra-bundle-discovery-'))
    try {
      const bundleDir = join(fixture, 'packages/subagent/example')
      const plainDir = join(fixture, 'packages/bundle/plain')
      mkdirSync(bundleDir, { recursive: true })
      mkdirSync(plainDir, { recursive: true })
      writeFileSync(join(bundleDir, 'package.json'), JSON.stringify({
        name: '@hydraharness/harness-subagent-example',
        hydra: { bundle: { patch: './cordis.patch.yml' } },
      }))
      writeFileSync(join(plainDir, 'package.json'), JSON.stringify({
        name: '@hydraharness/harness-plain',
      }))

      expect(bundleManifestPaths(fixture)).toEqual([
        'packages/subagent/example/package.json',
      ])
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })

  it('allows a Bundle to mount itself but rejects an undeclared plugin package', () => {
    const manifestPath = 'packages/subagent/example/package.json'
    const file = 'packages/subagent/example/cordis.patch.yml'
    const manifest = {
      name: '@hydraharness/harness-subagent-example',
      dependencies: {},
    }
    const self = { file, name: '@hydraharness/harness-subagent-example' }
    expect(bundlePluginDependencyErrors(manifestPath, manifest, [self])).toEqual([])
    expect(bundlePluginDependencyErrors(manifestPath, manifest, [
      self,
      { file, name: '@hydraharness/harness-missing-plugin' },
    ])).toEqual([
      `${file}: @hydraharness/harness-missing-plugin must be declared in ${manifestPath} dependencies`,
    ])
  })
})

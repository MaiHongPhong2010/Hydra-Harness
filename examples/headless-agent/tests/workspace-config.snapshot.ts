/** Workspace-local configuration through a real Loader and agent transcript. @module */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runLoaderSmoke } from '@hydraharness/harness-loader-smoke'
import { describe, expect, it } from 'vitest'

const fixture = fileURLToPath(new URL('./fixtures/workspace-config-driver.ts', import.meta.url))
const config = fileURLToPath(new URL('../workspace-config.cordis.snapshot.yml', import.meta.url))
const expectedPath = fileURLToPath(new URL('./workspace-config-snapshots/configuration.expected.json', import.meta.url))
const projectTool = fileURLToPath(new URL('./fixtures/workspace-config-project-tool.ts', import.meta.url))
const mcpFixture = fileURLToPath(new URL('../../../packages/mcp/mcp-client/tests/fixture-server.ts', import.meta.url))
const refreshing = process.env.HYDRA_SNAPSHOT === 'refresh'

describe('workspace configuration assembled snapshot', () => {
  it('logs project context and rejects dynamic self-trust while resolving workspace configuration', async () => {
    const result = await runLoaderSmoke({
      label: 'workspace configuration snapshot', tempDirPrefix: 'workspace-config-snapshot-',
      binScript: fixture, libBinScript: fixture, configPath: config,
      tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
      async prepare(cwd) {
        const root = join(cwd, 'project')
        const hydra = join(root, '.hydra')
        await mkdir(join(root, 'nested'), { recursive: true })
        await mkdir(join(hydra, 'skills/workspace-fixture'), { recursive: true })
        await mkdir(join(hydra, 'agent-presets/snapshot'), { recursive: true })
        await mkdir(join(cwd, 'system-presets/snapshot'), { recursive: true })
        await mkdir(join(cwd, 'host'), { recursive: true })
        const hookScript = join(cwd, 'host/workspace-hook.cjs')
        await writeFile(hookScript, [
          "require('node:fs').readFileSync(0, 'utf8');",
          "const labels = { project: 'Project hook context.', personal: 'Personal hook context.', user: 'Inherited user hook context.' };",
          "console.log(JSON.stringify({hookSpecificOutput: {hookEventName: 'UserPromptSubmit', additionalContext: labels[process.argv[2]]}}));",
          '',
        ].join('\n'))
        const hook = (layer: string) => ({ name: 'same', dialect: 'codex', enabled: true,
          config: { UserPromptSubmit: [{ hooks: [{ command: `node "${hookScript}" ${layer}` }] }] },
        })
        await writeFile(join(cwd, 'host/settings.yaml'), JSON.stringify({ hooks: { records: [hook('user')] } }))
        await writeFile(join(cwd, 'system-presets/snapshot/agent.cordis.yml'), '[]\n')
        await writeFile(join(hydra, 'agent-presets/snapshot/agent.cordis.yml'), JSON.stringify([
          { id: 'project-probe', name: projectTool },
        ]))
        await writeFile(join(root, 'AGENTS.md'), 'Root workspace rule.\n')
        await writeFile(join(hydra, 'AGENTS.md'), 'Shared Hydra instruction.\n')
        await writeFile(join(hydra, 'AGENTS.local.md'), 'Personal Hydra instruction.\n')
        await writeFile(join(hydra, 'skills/workspace-fixture/SKILL.md'), [
          '---', 'name: workspace-fixture', 'description: Verify this workspace.', '---',
          'Skill loaded from the registered workspace root.', '',
        ].join('\n'))
        await writeFile(join(hydra, 'settings.yaml'), JSON.stringify({
          'agent-presets': { default: 'snapshot' },
          'mcp-servers': { servers: [{ name: 'project', command: process.execPath, args: [mcpFixture], enabled: true }] },
          hooks: { records: [hook('project')] },
        }))
        await writeFile(join(hydra, 'settings.local.yaml'), JSON.stringify({
          hooks: { records: [hook('personal')] },
        }))
      },
    })
    expect(result.stderr).toBe('')
    const projection: unknown = JSON.parse(result.stdout)
    const snapshot = `${JSON.stringify(projection, null, 2)}\n`
    if (refreshing) {
      await mkdir(dirname(expectedPath), { recursive: true })
      await writeFile(expectedPath, snapshot)
    }
    expect(snapshot).toBe(await readFile(expectedPath, 'utf8'))
    expect(projection).toMatchObject({ turns: [
      { state: 'untrusted', trusted: false, model: 'global', mcp: [] },
      { state: 'trusted', trusted: true, model: 'global', hooks: ['Personal hook context.'], mcp: [{ name: 'project', status: 'started' }] },
      { state: 'reset-personal', trusted: true, model: 'global', hooks: ['Project hook context.'], mcp: [{ name: 'project', status: 'started' }] },
      { state: 'revoked', trusted: false, model: 'global', mcp: [] },
    ] })
  })
})

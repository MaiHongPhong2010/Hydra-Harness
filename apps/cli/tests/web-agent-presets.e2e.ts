import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Context } from '@hydraharness/cordis'
import { boot, healProfilesModuleFallback, loadOverlayPatches, loadProfile } from '@hydraharness/harness-app-boot'
import { provideCmdline } from '@hydraharness/harness-cmdline'
import { SessionId } from '@hydraharness/harness-session'
import { agentEvents, type Agent } from '@hydraharness/harness-agent'
import type { PatchOptions } from '@hydraharness/cordis-plugin-include'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { settingsNamespace } from '@hydraharness/harness-settings'
import { resolveSessionPreset, SETTINGS_NAMESPACE } from '@hydraharness/harness-agent-presets'
import { applyChildComposition, childSessionMeta } from '@hydraharness/harness-subagent'
import { CallId, createUserMessage } from '@hydraharness/harness-llm'
import type {} from '@hydraharness/harness-compaction-basic'
import type {} from '@hydraharness/harness-skill'
import type {} from '@hydraharness/harness-tools'
// Type-only: resolves `ctx.get('sessionProjections')` and `ctx.get('tokenMeter')`.
import type {} from '@hydraharness/harness-session-projection'
import type {} from '@hydraharness/harness-token-meter'

const CONFIG_DIR = fileURLToPath(new URL('../config/', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))
/** The shipped Web surface: the hydra-base and hydra-web-app bundle patches over an empty preset root. */
const BASE_PATCH = join(REPO_ROOT, 'packages/bundle/base/cordis.patch.yml')
const WEB_PATCH = join(REPO_ROOT, 'packages/bundle/web-app/cordis.patch.yml')
const CODEX_PACKAGE_DIR = join(REPO_ROOT, 'packages/subagent/subagent-codex')
const CLAUDE_CODE_PACKAGE_DIR = join(REPO_ROOT, 'packages/subagent/subagent-claude-code')
/** The installation anchor whose dependency surface the preset module fallback mirrors. */
const INSTALL_ANCHOR = join(REPO_ROOT, 'apps/cli/package.json')
const MINIMAL_PROMPT = 'You are a helpful software engineer assistant.'
const SHARED_HOST_TOOL_NAMES = [
  'gemini_web_retrieve', 'image_generate', 'image_generate_google',
  'session_version_list', 'session_version_read', 'video_generate',
]
const MINIMAL_BASH_DESCRIPTION = `Run commands in a bash shell
* When invoking this tool, the contents of the "command" parameter does NOT need to be XML-escaped.
* You don't have access to the internet via this tool.
* You do have access to a mirror of common linux and python packages via apt and pip.
* State is persistent across command calls and discussions with the user.
* To inspect a particular line range of a file, e.g. lines 10-25, try 'sed -n 10,25p /path/to/the/file'.
* Please avoid commands that may produce a very large amount of output.
* Please run long lived commands in the background, e.g. 'sleep 10 &' or start a server in the background.`

/**
 * Boot the shipped Web composition, minus the rows that would bind a port,
 * touch the network, or write outside the test. Everything that decides an
 * agent's capabilities is the real thing, including the shipped presets.
 */
async function bootWeb(
  settingsFile: string,
  extra: PatchOptions[] = [],
  profilePackages: readonly string[] = [],
  profileBundles?: readonly string[],
  lspCommand?: string,
): Promise<Context> {
  const storageRoot = join(dirname(settingsFile), 'storages')
  const overrides: PatchOptions[] = [
    // The settings row defaults to `$HYDRA_HOME/settings.yaml`. Left alone it
    // reads the developer's own document — and since the default preset is a
    // setting, a stored `agent-presets.default` would decide this file's
    // outcome. Point it at a temp file for the same reason the roster below
    // names only the shipped root.
    { id: 'settings', config: { path: settingsFile, watch: false } },
    // storage-json's root is anchored to the real $HYDRA_HOME. Unpinned, this
    // file writes the developer's own `~/.hydra/storages/` — and then reads it
    // back on the next run, so a stored document from any other build decides
    // this test's boot. Same reason the settings row above is pinned.
    { id: 'storage-json', config: { root: storageRoot } },
    // Host rows with side effects outside this process: a bound port, a served
    // asset tree, a telemetry exporter. `api-gateway` and `directory-picker`
    // stay ENABLED on purpose — the api-proxy is the host row that injects
    // `subagents`, `workspace`, and the rest of the agent plane, so disabling
    // it would hide exactly the breakage this file exists to catch: a service
    // moved into the presets that a host row still waits for. The boot audit
    // is that assertion.
    { id: 'webserver', disabled: true },
    // The web bundle's runtime row injects `webServer`, so it cannot
    // activate without the bound port disabled above. It owns dist serving
    // and the URL prompt line — surface glue, not anything that decides an
    // agent's capabilities, which is all this file asserts.
    { id: 'web-runtime', disabled: true },
    { id: 'session-telemetry-otel', disabled: true },
    // Keep this composition assertion focused on the shipped preset catalog;
    // browser, Obsidian, and page-memory tools are independent opt-in host
    // integrations.
    { id: 'obsidian-knowledge', disabled: true },
    { id: 'page-memory', disabled: true },
    { id: 'tool-web', config: { fetch: false, searchTimeoutMs: 60000 } },
    // A deployment-level skill on the host registry's GLOBAL layer — the same
    // registration shape a repository plugin's skill root uses. The layered
    // skills test below proves it reaches preset-composed agents.
    { id: 'skill-badge', disabled: false },
    { id: 'modules', disabled: true },
    { id: 'connection', disabled: true },
    // The always-on reload chain waits for the browser roster and bound port
    // disabled above.
    { id: 'client-hmr', disabled: true },
    // The shipped `-auto` chooser resolves its interaction from a running
    // host and so waits for the webserver disabled above; the browse variant
    // supplies `directoryPicker` without one.
    { id: 'directory-picker', disabled: true },
    { insert: [
      { id: 'directory-picker-browse', name: '@hydraharness/harness-host-directory-picker-browse' },
      { id: 'ui-directory-picker-browse', name: '@hydraharness/harness-client-ui-directory-picker-browse' },
    ] },
    // The roster AppCLIEntry would patch in; only the shipped root, so a
    // developer's own `~/.hydra/.preset` cannot change this test's outcome.
    // `default` here is the COMPOSITION default — the base layer the settings
    // document overrides.
    {
      id: 'agent-presets',
      config: {
        default: 'standard',
        roots: [{ path: join(CONFIG_DIR, 'agent-presets'), trust: 'system' }],
        includeUserRoot: false,
      },
    },
    ...extra,
  ]
  // The surface is patch layers over an empty preset root, so the root sits
  // outside this workspace and bare plugin names cannot resolve by Node's
  // upward walk. The flat fallback the preset boot maintains is what makes
  // them resolvable — the same mechanism, not a test-only shim.
  const home = dirname(settingsFile)
  const previousHome = process.env.HYDRA_HOME
  const previousLspCommand = process.env.HYDRA_LSP_COMMAND
  process.env.HYDRA_HOME = home
  if (lspCommand === undefined) delete process.env.HYDRA_LSP_COMMAND
  else process.env.HYDRA_LSP_COMMAND = lspCommand
  // plugin-inventory validates the active include against the launcher's
  // managed profile root. Keep this isolated fixture under its temporary home.
  healProfilesModuleFallback(INSTALL_ANCHOR, home)
  const profileDir = join(home, 'profiles', 'spec')
  await mkdir(profileDir, { recursive: true })
  await writeFile(join(profileDir, 'package.json'), JSON.stringify({
    name: 'hydra-profile-spec',
    private: true,
    dependencies: {},
    hydra: { profile: { bundles: profileBundles ?? [] } },
  }, null, 2) + '\n')
  // Product Bundles are installed into the Profile, not the hydra app. Model
  // pnpm's package link for only the selected products; their own production
  // dependencies resolve from the linked workspace packages, while shared
  // peers still resolve through the installation fallback above.
  for (const packageDir of profilePackages) {
    const manifest = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8')) as { name: string }
    const link = join(profileDir, 'node_modules', manifest.name)
    await mkdir(dirname(link), { recursive: true })
    await symlink(packageDir, link, 'junction')
  }
  let bundlePatches: PatchOptions[] = [
    ...loadOverlayPatches('hydra-test', BASE_PATCH),
    ...loadOverlayPatches('hydra-test', WEB_PATCH),
  ]
  if (profileBundles !== undefined) {
    await writeFile(join(profileDir, 'package.json'), JSON.stringify({
      name: 'hydra-profile-spec',
      private: true,
      dependencies: Object.fromEntries(profileBundles.map(name => [name, 'workspace:*'])),
      hydra: { profile: { bundles: profileBundles } },
    }, null, 2) + '\n')
    const profile = loadProfile('hydra-test', 'spec', INSTALL_ANCHOR, home, { userLayer: false })
    bundlePatches = profile.layers.flatMap(layer => layer.patches)
  }
  const rootConfig = join(profileDir, 'cordis.yml')
  await writeFile(rootConfig, '[]\n')
  try {
    const context = await boot('hydra-test', rootConfig, [...bundlePatches, ...overrides], (bootCtx) => {
      provideCmdline(bootCtx, { args: [], exit: () => {} })
    })
    // Browser support remains mounted so `tool-browser` has its declared
    // dependency, but this catalog test does not start or enumerate that
    // optional integration. Disable the preset row through its real settings
    // path, which is the same switch the product uses.
    const pluginEnablement = Object.fromEntries(
      (await context.agentPresets.list()).map(preset => [preset.id, { 'tool-browser': false }]),
    )
    await context.settings.update(settingsNamespace(SETTINGS_NAMESPACE), { pluginEnablement })
    return context
  } finally {
    if (previousHome === undefined) delete process.env.HYDRA_HOME
    else process.env.HYDRA_HOME = previousHome
    if (previousLspCommand === undefined) delete process.env.HYDRA_LSP_COMMAND
    else process.env.HYDRA_LSP_COMMAND = previousLspCommand
  }
}

const toolNames = (ctx: Context, agent?: Agent): string[] =>
  ctx.tools.schemas(agent).map(schema => schema.name).sort()

const coreToolNames = (ctx: Context, agent: Agent): string[] =>
  toolNames(ctx, agent).filter(name => !SHARED_HOST_TOOL_NAMES.includes(name))

function toolParameterNames(ctx: Context, agent: Agent, toolName: string): string[] {
  const schema = ctx.tools.schemas(agent).find(tool => tool.name === toolName)
  if (schema === undefined) throw new Error(`missing tool schema ${toolName}`)
  const properties = schema.parameters.properties
  if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) {
    throw new Error(`${toolName} has invalid parameter properties`)
  }
  return Object.keys(properties).sort()
}

function enablePresetTool(composition: string, id: string): string {
  const row = `    - id: ${id}\n`
  const start = composition.indexOf(row)
  if (start < 0) throw new Error(`missing preset row ${id}`)
  const end = composition.indexOf('\n    - id:', start + row.length)
  const disabled = composition.indexOf('      disabled: true\n', start)
  if (disabled < 0 || (end >= 0 && disabled > end)) {
    throw new Error(`preset row ${id} is not disabled`)
  }
  return composition.slice(0, disabled) + composition.slice(disabled + '      disabled: true\n'.length)
}

let ctx: Context
let ambientLspCommand: string | undefined
beforeAll(async () => {
  ambientLspCommand = process.env.HYDRA_LSP_COMMAND
  delete process.env.HYDRA_LSP_COMMAND
  const settingsFile = join(await mkdtemp(join(tmpdir(), 'hydra-web-presets-')), 'settings.yaml')
  await writeFile(settingsFile, '{}\n')
  ctx = await bootWeb(settingsFile)
}, 120_000)

afterAll(() => {
  if (ambientLspCommand === undefined) delete process.env.HYDRA_LSP_COMMAND
  else process.env.HYDRA_LSP_COMMAND = ambientLspCommand
})

describe('the shipped Web composition', () => {
  it('shares exactly the media and session-version tools from the Host', () => {
    expect(toolNames(ctx)).toEqual(SHARED_HOST_TOOL_NAMES)
  })

  it('keeps the token meter and its context-meter projections on the host plane', async () => {
    // Read before any preset in this file mounts, which is what makes this an
    // ownership assertion rather than a mount-order coincidence: a preset-side
    // meter sits behind an `isolate` realm and is invisible to `ctx.get`.
    //
    // The projection registry is process-wide rather than scope-layered, so a
    // preset-side meter would also make the browser's context meter appear for
    // a `minimal` session the moment some OTHER session mounted a preset that
    // carries one, and vanish entirely in a process that only ever ran
    // `minimal`. Host ownership is what makes the meter a per-session fact.
    expect(ctx.get('tokenMeter')).toBeDefined()
    const projections = ctx.get('sessionProjections')
    if (projections === undefined) throw new Error('the Web composition must compose a projection registry')
    const handle = await ctx.agents.create({
      sessionId: SessionId('preset-minimal-meter'),
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'minimal').then(() => undefined),
    })
    try {
      // A subset assertion: `tasks`, `goal`, and the rest register into the
      // same process-wide table, and this is about the meter's three units.
      expect(Object.keys(projections.snapshot(handle.agent.session).values))
        .toEqual(expect.arrayContaining(['contextBreakdown', 'contextPressure', 'tokenUsage']))
    } finally {
      await handle.dispose()
    }
  })

  it('supplies both shipped presets, and only those, from the system root', async () => {
    const listed = await ctx.agentPresets.list()

    expect(listed.map(preset => preset.id).sort()).toEqual(['code', 'cordis', 'minimal', 'standard'])
    expect(listed.every(preset => preset.trust === 'system')).toBe(true)
    expect(ctx.agentPresets.defaultId).toBe('standard')
  })

  it('composes the full agent from `standard`', async () => {
    const handle = await ctx.agents.create({
      sessionId: SessionId('preset-standard'),
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'standard').then(() => undefined),
    })
    try {
      const assembly = await ctx.systemPrompt.assemble({ scope: handle.agent })
      expect(assembly.sections.find(section => section.name === 'deployment:persona')?.text)
        .toContain('For coding work, complete the loop: edit the smallest owning files, run the narrowest focused check, inspect the resulting diff, and report changed files and exact checks')
      // The EXACT catalog, not a spot-check: an omission is this design's
      // quietest failure mode, because a row that registers into the wrong
      // layer mounts cleanly and simply contributes nothing. `glob`/`grep` are
      // excluded for the reason the TUI composition e2e excludes them — they
      // depend on ripgrep being present on the machine.
      expect(toolNames(ctx, handle.agent).filter(name => name !== 'glob' && name !== 'grep')).toEqual([
        ...SHARED_HOST_TOOL_NAMES,
        'ask_user_question', ...(process.platform === 'win32' ? [] : ['bash']), 'create_goal', 'edit', 'exit_plan_mode',
        'get_goal', 'interrupt_agent', 'job_kill', 'job_list', 'job_output', 'list_agents', ...(process.platform === 'win32' ? ['pwsh'] : []), 'ralph', 'read', 'read_image', 'send_message', 'skill', 'skill_search',
        'subagent', 'subagent_fork', 'todo_write', 'update_goal', 'web_fetch', 'web_search',
        'workflow', 'write',
      ].sort())
    } finally {
      await handle.dispose()
    }
  })

  it('composes the exact RL prompt and two preset tools alongside shared Host tools from `minimal`', async () => {
    const handle = await ctx.agents.create({
      sessionId: SessionId('preset-minimal'),
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'minimal').then(() => undefined),
    })
    try {
      const assembly = await ctx.systemPrompt.assemble({ scope: handle.agent })
      expect(assembly.sections).toEqual([
        { name: 'deployment:persona', text: MINIMAL_PROMPT },
      ])
      expect(assembly.tools.map(tool => tool.name).sort()).toEqual([
        ...SHARED_HOST_TOOL_NAMES,
        process.platform === 'win32' ? 'pwsh' : 'bash',
        'str_replace_editor',
      ].sort())
      const shellTool = assembly.tools.find(tool => tool.name === (process.platform === 'win32' ? 'pwsh' : 'bash'))
      expect(shellTool).toBeDefined()
      if (process.platform !== 'win32') expect(shellTool?.description).toBe(MINIMAL_BASH_DESCRIPTION)
      expect(JSON.stringify(assembly.tools.find(tool => tool.name === 'str_replace_editor')?.parameters))
        .toContain('Absolute path')
      expect(ctx.agentPresets.serviceFor(handle.agent, 'compaction')).toBeUndefined()
      expect(handle.agent.ctx.get('compaction')).toBeUndefined()
    } finally {
      await handle.dispose()
    }
  })

  it('keeps two differently composed sessions independent', async () => {
    const full = await ctx.agents.create({
      sessionId: SessionId('preset-both-full'),
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'standard').then(() => undefined),
    })
    const minimal = await ctx.agents.create({
      sessionId: SessionId('preset-both-minimal'),
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'minimal').then(() => undefined),
    })
    try {
      expect(coreToolNames(ctx, minimal.agent)).toEqual(process.platform === 'win32'
        ? ['pwsh', 'str_replace_editor']
        : ['bash', 'str_replace_editor'])
      expect(toolNames(ctx, full.agent).length).toBeGreaterThan(10)

      await minimal.dispose()

      // Tearing the minimal session down leaves the full one whole.
      expect(toolNames(ctx, full.agent).length).toBeGreaterThan(10)
      expect(toolNames(ctx)).toEqual(SHARED_HOST_TOOL_NAMES)
    } finally {
      await full.dispose()
    }
  })

  it('composes the cordis agent with its own toolset', async () => {
    const handle = await ctx.agents.create({
      sessionId: SessionId('preset-cordis'),
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'cordis').then(() => undefined),
    })
    try {
      const tools = toolNames(ctx, handle.agent)
      // The self-referential toolset is what distinguishes this preset.
      expect(tools).toEqual(expect.arrayContaining([
        'cordis_inspect_list', 'cordis_inspect_query', 'cordis_inspect_self',
        'cordis_define', 'cordis_run', 'cordis_stop', 'cordis_undefine',
      ]))
      // And it keeps the standard agent's own tools rather than replacing them.
      expect(tools).toEqual(expect.arrayContaining([process.platform === 'win32' ? 'pwsh' : 'bash', 'read', 'edit', 'skill']))
      expect(tools).not.toContain('str_replace_editor')

      // The preset's own authoring skill registers into ITS layer of the host
      // registry: the cordis agent's view carries it, the global view does not.
      const scoped = (await ctx.skills.list({ scope: handle.agent })).map(skill => skill.name)
      expect(scoped).toContain('editing-cordis-compositions')
      expect((await ctx.skills.list()).map(skill => skill.name)).not.toContain('editing-cordis-compositions')
    } finally {
      await handle.dispose()
    }
  })

  it('presents `code` as Code Mode without disturbing a native session beside it', async () => {
    const coded = await ctx.agents.create({
      sessionId: SessionId('preset-code'),
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'code').then(() => undefined),
    })
    const native = await ctx.agents.create({
      sessionId: SessionId('preset-code-native'),
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'standard').then(() => undefined),
    })
    try {
      // One tool reaches the MODEL: the transport. The registry's catalog for
      // this agent is unchanged — a code mode collapses the presentation, not
      // the capabilities — so the assembly is what carries the claim.
      const assembly = await ctx.systemPrompt.assemble({ scope: coded.agent })
      expect(assembly.sections.find(section => section.name === 'deployment:persona')?.text)
        .toContain('For coding work, complete the loop: edit the smallest owning files, run the narrowest focused check, inspect the resulting diff, and report changed files and exact checks')
      expect(assembly.tools.map(tool => tool.name)).toEqual(['run_code'])
      expect(toolNames(ctx, coded.agent)).not.toContain('str_replace_editor')
      const sdk = assembly.sections.find(section => section.name === 'tools:sdk')?.text ?? ''
      expect(sdk).not.toContain('str_replace_editor')
      expect(sdk).toContain('web_search')

      // The presentation is this agent's alone: the deployment default is
      // native, and the session composed from `standard` still sees it.
      const nativeAssembly = await ctx.systemPrompt.assemble({ scope: native.agent })
      expect(nativeAssembly.tools.map(tool => tool.name)).toContain(process.platform === 'win32' ? 'pwsh' : 'bash')
      expect(nativeAssembly.tools.map(tool => tool.name)).not.toContain('run_code')
      expect(nativeAssembly.sections.some(section => section.name === 'tools:sdk')).toBe(false)
    } finally {
      await native.dispose()
      await coded.dispose()
    }
  })

  it('boots with an LSP enablement override when its executable is missing', async () => {
    const settingsFile = join(await mkdtemp(join(tmpdir(), 'hydra-web-missing-lsp-')), 'settings.yaml')
    await writeFile(settingsFile, '{}\n')
    const context = await bootWeb(settingsFile, [{ id: 'lsp-stdio', disabled: false }], [], undefined,
      'hydra-missing-language-server-fixture')
    try {
      await writeFile(join(dirname(settingsFile), 'probe.ts'), 'const value = 1\n')
      const unavailable = context.lsp.query({
        operation: 'hover',
        filePath: 'probe.ts',
        position: { line: 0, character: 0 },
        workspaceRoot: dirname(settingsFile),
      })
      await expect(unavailable).rejects.toMatchObject({ code: 'LSP_UNAVAILABLE' })
      await expect(unavailable).rejects.toThrow('Install it on the host')
      expect(context.agentPresets).toBeDefined()
    } finally {
      await context.fiber.dispose()
    }
  })

  it('keeps LSP absent by default and enables it for standard and code when configured', async () => {
    await expect(ctx.lsp.query({
      operation: 'hover',
      filePath: 'probe.ts',
      position: { line: 0, character: 0 },
      workspaceRoot: process.cwd(),
    })).rejects.toMatchObject({ code: 'LSP_UNAVAILABLE' })

    const settingsFile = join(await mkdtemp(join(tmpdir(), 'hydra-web-lsp-')), 'settings.yaml')
    await writeFile(settingsFile, '{}\n')
    const previousLspCommand = process.env.HYDRA_LSP_COMMAND
    process.env.HYDRA_LSP_COMMAND = process.execPath
    let enabledCtx: Context | undefined
    try {
      enabledCtx = await bootWeb(settingsFile, [], [], undefined, process.execPath)
      const context = enabledCtx
      for (const id of ['standard', 'code'] as const) {
        const handle = await context.agents.create({
          sessionId: SessionId(`preset-lsp-${id}`),
          setup: agentCtx => context.agentPresets.mount(agentCtx, id).then(() => undefined),
        })
        try {
          expect(toolNames(context, handle.agent)).toContain('lsp')
          const assembly = await context.systemPrompt.assemble({ scope: handle.agent })
          if (id === 'standard') expect(assembly.tools.map(tool => tool.name)).toContain('lsp')
          else expect(assembly.tools.map(tool => tool.name)).toEqual(['run_code'])
        } finally {
          await handle.dispose()
        }
      }

      await writeFile(join(dirname(settingsFile), 'probe.ts'), 'const value = 1\n')
      let failure: unknown
      try {
        await context.lsp.query({
          operation: 'hover',
          filePath: 'probe.ts',
          position: { line: 0, character: 0 },
          workspaceRoot: dirname(settingsFile),
        })
      } catch (error) {
        failure = error
      }
      // The configured executable is intentionally only a lazy boot probe here;
      // route selection must reach it before its non-LSP process exits.
      expect(failure).toBeDefined()
      expect((failure as { code?: unknown }).code).not.toBe('LSP_UNAVAILABLE')
    } finally {
      if (enabledCtx !== undefined) await enabledCtx.fiber.dispose()
      if (previousLspCommand === undefined) delete process.env.HYDRA_LSP_COMMAND
      else process.env.HYDRA_LSP_COMMAND = previousLspCommand
    }
  }, 120_000)

  it('keeps the self-referential toolset out of every other preset', async () => {
    const handle = await ctx.agents.create({
      sessionId: SessionId('preset-no-cordis'),
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'standard').then(() => undefined),
    })
    try {
      // Editing the live runtime is opt-in per session, not ambient.
      expect(toolNames(ctx, handle.agent)).not.toContain('cordis_define')
    } finally {
      await handle.dispose()
    }
  })

  it('ships the composition-authoring skill inside the preset directory', async () => {
    // The preset's skill root is derived from its own `baseUrl`, so the skill
    // travels with the directory wherever the preset is installed.
    const skill = join(
      CONFIG_DIR, 'agent-presets', 'cordis', 'skills', 'editing-cordis-compositions', 'SKILL.md',
    )

    expect((await readFile(skill, 'utf8')).startsWith('---\nname: editing-cordis-compositions')).toBe(true)
  })

  it('merges the global skill layer into a preset agent\'s catalog, keeping local discovery preset-side', async () => {
    const proj = await mkdtemp(join(tmpdir(), 'hydra-preset-skill-proj-'))
    await mkdir(join(proj, '.hydra', 'skills', 'project-proof'), { recursive: true })
    await writeFile(join(proj, '.hydra', 'skills', 'project-proof', 'SKILL.md'), [
      '---',
      'name: project-proof',
      'description: Proves the preset layer discovers project skills beside global ones.',
      '---',
      '',
      'Project proof body.',
      '',
    ].join('\n'))
    await mkdir(join(proj, '.hydra', 'skills', 'obsidian-uat-test-design'), { recursive: true })
    await writeFile(join(proj, '.hydra', 'skills', 'obsidian-uat-test-design', 'SKILL.md'), [
      '---',
      'name: obsidian-uat-test-design',
      'description: Ground UAT testcase lookup and test design in Obsidian knowledge.',
      'whenToUse: Use for UAT testcase lookup, test design, or live validation.',
      '---',
      '',
      'Use obsidian_knowledge_recall before UAT testing.',
      '',
    ].join('\n'))

    const handle = await ctx.agents.create({
      // Unique per run: the composition persists into the ambient Hydra home,
      // and a fixed id would collide with a log an earlier run left there.
      sessionId: SessionId(`preset-skills-standard-${randomUUID()}`),
      meta: { cwd: proj },
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'standard').then(() => undefined),
    })
    try {
      // The host (global) view carries the deployment-level provider alone:
      // local discovery moved behind the presets with `skill-filesystem`.
      expect((await ctx.skills.list({ cwd: proj })).map(skill => skill.name)).toEqual(['hydra-badge'])

      // The standard agent's view merges the global layer with its preset's
      // own local discovery over the session cwd.
      const scoped = (await ctx.skills.list({ cwd: proj, scope: handle.agent })).map(skill => skill.name)
      expect(scoped).toContain('hydra-badge')
      expect(scoped).toContain('project-proof')

      // The preset's own loader tool resolves the global-layer skill.
      const loaded = await ctx.tools.execute({
        callId: CallId('preset-skills-load'),
        name: 'skill',
        arguments: { name: 'hydra-badge' },
        signal: new AbortController().signal,
        agent: handle.agent,
      })
      expect(loaded.isError).toBe(false)
      expect(JSON.stringify(loaded.content)).toContain('powered by Hydra harness')

      const request = createUserMessage({
        content: [{ type: 'text', text: 'test tính năng search request trên obsidian' }],
        source: { kind: 'user' },
      })
      const signal = new AbortController().signal
      const decision = await agentEvents(ctx, handle.agent).waterfall(
        'agent/pre-step',
        { messages: [request], turn: 1, step: 1, signal },
        () => Promise.resolve({ kind: 'enter' as const, messages: [request] }),
      )
      if (decision.kind !== 'enter') throw new Error('standard preset rejected the skill-routing step')
      const injection = decision.messages.find(message => message.source.kind === 'skill-invocation')
      expect(injection?.source).toEqual({
        kind: 'skill-invocation', name: 'obsidian-uat-test-design', trigger: 'automatic', form: 'instructions',
      })
      expect(JSON.stringify(injection?.content)).toContain('obsidian_knowledge_recall')
    } finally {
      await handle.dispose()
    }
  })

  it('shows a minimal agent the global layer but no loader tool', async () => {
    const handle = await ctx.agents.create({
      sessionId: SessionId(`preset-skills-minimal-${randomUUID()}`),
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'minimal').then(() => undefined),
    })
    try {
      // Layer visibility is the registry's; whether an agent can USE skills
      // stays the preset's choice — minimal mounts no `tool-skill`, so its
      // tool table has no loader even though the global layer is readable.
      expect((await ctx.skills.list({ scope: handle.agent })).map(skill => skill.name)).toContain('hydra-badge')
      expect(coreToolNames(ctx, handle.agent)).toEqual(process.platform === 'win32'
        ? ['pwsh', 'str_replace_editor']
        : ['bash', 'str_replace_editor'])
    } finally {
      await handle.dispose()
    }
  })

  it('never rewrites the preset file it composed from', async () => {
    // The Loader persists a tree whose plugin self-disposed, and tearing an
    // agent down disposes its whole subtree. Inherited, that rewrote the
    // shipped composition — truncating it to `[]` the first time a session
    // ended — so `PresetTree` refuses to write at all.
    const path = join(CONFIG_DIR, 'agent-presets', 'standard', 'agent.cordis.yml')
    const before = await readFile(path, 'utf8')

    const handle = await ctx.agents.create({
      sessionId: SessionId('preset-readonly'),
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'standard').then(() => undefined),
    })
    await handle.dispose()
    // Slack, not a race the number has to win. The write is driven by the
    // Loader's fiber-unload listener, which fires as the subtree's fibers
    // settle rather than when `dispose()` resolves, and the Loader exposes no
    // flush to await. A regression writes synchronously inside that listener,
    // so any wait past settlement fails; a longer one only slows the test.
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(await readFile(path, 'utf8')).toBe(before)
  })
})

describe('product Bundle and user-preset intersection', () => {
  const presetIds = ['products-none', 'products-codex', 'products-claude', 'products-both'] as const
  type Product = 'codex' | 'claude-code'
  type PresetId = typeof presetIds[number]

  async function bootProducts(installed: readonly Product[]): Promise<Context> {
    const root = await mkdtemp(join(tmpdir(), 'hydra-product-presets-'))
    const userRoot = join(root, 'presets')
    const settingsFile = join(root, 'settings.yaml')
    const standard = await readFile(join(CONFIG_DIR, 'agent-presets', 'standard', 'agent.cordis.yml'), 'utf8')
    await writeFile(settingsFile, '{}\n')
    for (const id of presetIds) {
      let composition = standard
      if (id === 'products-codex' || id === 'products-both') {
        composition = enablePresetTool(composition, 'tool-subagent-codex')
      }
      if (id === 'products-claude' || id === 'products-both') {
        composition = enablePresetTool(composition, 'tool-subagent-claude-code')
      }
      const directory = join(userRoot, id)
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, 'agent.cordis.yml'), composition)
    }
    const packageDir = (product: Product): string => (
      product === 'codex' ? CODEX_PACKAGE_DIR : CLAUDE_CODE_PACKAGE_DIR
    )
    const packageName = (product: Product): string => (
      product === 'codex'
        ? '@hydraharness/harness-subagent-codex'
        : '@hydraharness/harness-subagent-claude-code'
    )
    return await bootWeb(settingsFile, [
      {
        id: 'agent-presets',
        config: {
          default: 'standard',
          roots: [
            { path: join(CONFIG_DIR, 'agent-presets'), trust: 'system' },
            { path: userRoot, trust: 'user' },
          ],
          includeUserRoot: false,
        },
      },
    ], installed.map(packageDir), [
      '@hydraharness/harness-base',
      '@hydraharness/harness-web-app',
      ...installed.map(packageName),
    ])
  }

  it('composes the intersection of installed Bundles and enabled preset rows', async () => {
    const enabledByPreset: Record<PresetId, Product[]> = {
      'products-none': [],
      'products-codex': ['codex'],
      'products-claude': ['claude-code'],
      'products-both': ['codex', 'claude-code'],
    }
    const scenarios: Array<{ installed: Product[]; presets: readonly PresetId[] }> = [
      { installed: [], presets: ['products-both'] },
      { installed: ['codex'], presets: ['products-both'] },
      { installed: ['claude-code'], presets: ['products-both'] },
      { installed: ['codex', 'claude-code'], presets: presetIds },
    ]

    for (const { installed, presets } of scenarios) {
      const productCtx = await bootProducts(installed)
      const spawn = vi.spyOn(productCtx.subprocess, 'spawn')
      try {
        expect(productCtx.subagents.list()
          .filter(name => name === 'codex' || name === 'claude-code')
          .sort())
          .toEqual([...installed].sort())
        for (const id of presets) {
          const handle = await productCtx.agents.create({
            sessionId: SessionId(`preset-${id}-${installed.join('-') || 'none'}-${randomUUID()}`),
            setup: agentCtx => productCtx.agentPresets.mount(agentCtx, id).then(() => undefined),
          })
          try {
            const productTools = enabledByPreset[id]
              .filter(product => installed.includes(product))
              .map(product => product === 'codex' ? 'subagent_codex' : 'subagent_claude_code')
              .sort()
            const tools = toolNames(productCtx, handle.agent)
            expect(tools.filter(name => name === 'subagent_codex' || name === 'subagent_claude_code'))
              .toEqual(productTools)
            expect(tools).toEqual(expect.arrayContaining(['job_kill', 'job_list', 'job_output']))
            for (const productTool of productTools) {
              expect(toolParameterNames(productCtx, handle.agent, productTool)).toEqual([
                'description', 'prompt', 'run_in_background',
              ])
            }
          } finally {
            await handle.dispose()
          }
        }
        expect(spawn).not.toHaveBeenCalled()
      } finally {
        spawn.mockRestore()
        await productCtx.fiber.dispose()
      }
    }
  }, 120_000)

  it('applies a product-row edit only to later sessions on the preset', async () => {
    const productCtx = await bootProducts(['codex'])
    const preset = await productCtx.agentPresets.resolve('products-none')
    const original = await readFile(preset.path, 'utf8')
    const existing = await productCtx.agents.create({
      sessionId: SessionId('preset-product-generation-existing'),
      setup: agentCtx => productCtx.agentPresets.mount(agentCtx, 'products-none').then(() => undefined),
    })
    try {
      expect(toolNames(productCtx, existing.agent)).not.toContain('subagent_codex')
      await writeFile(preset.path, enablePresetTool(original, 'tool-subagent-codex'))

      const later = await productCtx.agents.create({
        sessionId: SessionId('preset-product-generation-later'),
        setup: agentCtx => productCtx.agentPresets.mount(agentCtx, 'products-none').then(() => undefined),
      })
      try {
        expect(toolNames(productCtx, existing.agent)).not.toContain('subagent_codex')
        expect(toolNames(productCtx, later.agent)).toContain('subagent_codex')
      } finally {
        await later.dispose()
      }
    } finally {
      await existing.dispose()
      await writeFile(preset.path, original)
      await productCtx.fiber.dispose()
    }
  }, 120_000)
})

describe('a switch survives the session', () => {
  it('records the choice so the log states what the agent runs', async () => {
    const handle = await ctx.agents.create({
      sessionId: SessionId('preset-switch-logged'),
      meta: { agentPreset: 'standard' },
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'standard').then(() => undefined),
    })
    try {
      // The api-proxy's select does exactly this pair while the session is blank.
      await ctx.agentPresets.recompose(handle.agent.ctx, 'minimal')
      handle.agent.session.append('agent-preset/selected', { agentPreset: 'minimal' })

      // The header keeps the creation fact; the log carries what it runs.
      expect(handle.agent.session.header.agentPreset).toBe('standard')
      expect(resolveSessionPreset(handle.agent.session)).toBe('minimal')
    } finally {
      await handle.dispose()
    }
  })

  it('rebuilds a switched session from the log, not the creation header', () => {
    // The exact shape a resume reads back from disk: the header says standard,
    // the log records the switch the user made while the session was blank.
    const rebuilt = resolveSessionPreset({
      header: { version: 0, id: SessionId('x'), createdAt: 0, agentPreset: 'standard' },
      events: [
        { type: 'agent-preset/selected', seq: 1, time: 0, data: { agentPreset: 'minimal' } },
        { type: 'turn/start', seq: 2, time: 0, data: { turn: 0, trigger: { kind: 'message', source: { kind: 'user' } } } },
      ] as never,
    })

    // Reading the header alone would compose the creation-time preset over a
    // history another one produced — the replay the blank-only lock prevents.
    expect(rebuilt).toBe('minimal')
  })
})

describe('a forked session', () => {
  it('inherits the composition its seeded history was produced under', async () => {
    const parent = await ctx.agents.create({
      sessionId: SessionId('preset-fork-parent'),
      meta: { agentPreset: 'minimal' },
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'minimal').then(() => undefined),
    })
    const inherited = resolveSessionPreset(parent.agent.session)
    const child = await ctx.agents.create({
      sessionId: SessionId('preset-fork-child'),
      meta: {
        parentSession: SessionId('preset-fork-parent'),
        seedLength: 0,
        ...inherited === undefined ? {} : { agentPreset: inherited },
      },
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, inherited).then(() => undefined),
    })
    try {
      // The preset supplies the child's shell and editor alongside the shared
      // Host tools.
      expect(toolNames(ctx, child.agent)).toEqual(toolNames(ctx, parent.agent))
      expect(coreToolNames(ctx, child.agent).length).toBeGreaterThan(0)
    } finally {
      await child.dispose()
      await parent.dispose()
    }
  })
})

describe('a delegated child', () => {
  it('runs on the composition its parent runs on', async () => {
    const parent = await ctx.agents.create({
      sessionId: SessionId('preset-child-parent'),
      meta: { agentPreset: 'standard' },
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'standard').then(() => undefined),
    })
    // Exactly what an in-process subagent driver's creation window does.
    const child = await parent.agent.ctx.agents.create({
      sessionId: SessionId('preset-child'),
      meta: childSessionMeta(parent.agent, 1, 0),
      setup: (agentCtx) => {
        applyChildComposition(agentCtx, parent.agent, {})
      },
    })
    try {
      expect(toolNames(ctx, child.agent)).toEqual(toolNames(ctx, parent.agent))
      // The shipped `standard` preset is the whole coding agent; an empty
      // child here is the defect, and equality alone would not catch it.
      expect(toolNames(ctx, child.agent)).toContain(process.platform === 'win32' ? 'pwsh' : 'bash')
      expect(child.agent.session.header.agentPreset).toBe('standard')
    } finally {
      await child.dispose()
      await parent.dispose()
    }
  })

  it('follows a parent that switched preset while blank', async () => {
    const parent = await ctx.agents.create({
      sessionId: SessionId('preset-child-switch-parent'),
      meta: { agentPreset: 'standard' },
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'standard').then(() => undefined),
    })
    await ctx.agentPresets.recompose(parent.agent.ctx, 'minimal')
    const child = await parent.agent.ctx.agents.create({
      sessionId: SessionId('preset-child-switch'),
      meta: childSessionMeta(parent.agent, 1, 0),
      setup: (agentCtx) => {
        applyChildComposition(agentCtx, parent.agent, {})
      },
    })
    try {
      // The live scope chain is the authority, not the parent's creation
      // header — which still names `standard`.
      expect(toolNames(ctx, child.agent)).toEqual(toolNames(ctx, parent.agent))
      expect(child.agent.session.header.agentPreset).toBe('minimal')
    } finally {
      await child.dispose()
      await parent.dispose()
    }
  })
})

describe('a launcher that configures no writable root', () => {
  // The claim this default exists for, asserted through the real shipped
  // bundles rather than a hand-built context: `apps/cli` patches in only the
  // system root, and a person's own presets are found anyway because the
  // roster derives `<hydraHome>/.agent-presets` itself. `$HYDRA_HOME` is pointed
  // at a temp home BEFORE boot — the derived root is resolved when the plugin
  // is constructed, and an unpinned run would read the developer's own.
  let derivedCtx: Context
  let previousHome: string | undefined

  beforeAll(async () => {
    const home = await mkdtemp(join(tmpdir(), 'hydra-preset-derived-'))
    previousHome = process.env.HYDRA_HOME
    process.env.HYDRA_HOME = home
    await mkdir(join(home, '.agent-presets', 'derived-mine'), { recursive: true })
    await writeFile(
      join(home, '.agent-presets', 'derived-mine', 'agent.cordis.yml'),
      '- id: tool-todo\n  name: \'@hydraharness/harness-tool-todo\'\n  config:\n    allowParallelInProgress: true\n',
    )
    const settingsFile = join(home, 'settings.yaml')
    await writeFile(settingsFile, '{}\n')
    // Only the shipped root, exactly what `composeProfile` supplies; the
    // writable one is the roster's own default rather than this patch's job.
    derivedCtx = await bootWeb(settingsFile, [{
      id: 'agent-presets',
      config: {
        default: 'standard',
        roots: [{ path: join(CONFIG_DIR, 'agent-presets'), trust: 'system' }],
        includeUserRoot: true,
      },
    }])
  }, 120_000)

  afterAll(async () => {
    if (previousHome === undefined) delete process.env.HYDRA_HOME
    else process.env.HYDRA_HOME = previousHome
    await derivedCtx.fiber.dispose()
  })

  it('discovers and mounts a preset the person authored under the harness home', async () => {
    const listed = await derivedCtx.agentPresets.list()

    const mine = listed.find(preset => preset.id === 'derived-mine')
    expect(mine).toMatchObject({ trust: 'user' })
    // Omitted rather than undefined: a healthy row carries no `broken` key.
    expect(mine?.broken).toBeUndefined()
    expect(derivedCtx.agentPresets.authorable).toBe(true)

    const handle = await derivedCtx.agents.create({
      sessionId: SessionId('preset-derived-root'),
      setup: agentCtx => derivedCtx.agentPresets.mount(agentCtx, 'derived-mine').then(() => undefined),
    })
    try {
      expect(toolNames(derivedCtx, handle.agent)).toContain('todo_write')
    } finally {
      await handle.dispose()
    }
  })
})

describe('authoring a preset on the shipped composition', () => {
  let authorCtx: Context
  let userRoot: string

  beforeAll(async () => {
    userRoot = join(await mkdtemp(join(tmpdir(), 'hydra-preset-authoring-')), 'profiles')
    const settingsFile = join(await mkdtemp(join(tmpdir(), 'hydra-preset-authoring-settings-')), 'settings.yaml')
    await writeFile(settingsFile, '{}\n')
    authorCtx = await bootWeb(settingsFile, [{
      id: 'agent-presets',
      config: {
        default: 'standard',
        roots: [
          { path: join(CONFIG_DIR, 'agent-presets'), trust: 'system' },
          // The root does not exist yet: a deployment whose user has authored
          // nothing is the normal first-run state.
          { path: userRoot, trust: 'user' },
        ],
        includeUserRoot: false,
      },
    }])
  })

  it('refuses to copy over or delete a shipped preset', async () => {
    await expect(authorCtx.agentPresets.copy('minimal', 'standard')).rejects.toThrow(/already exists/)
    await expect(authorCtx.agentPresets.remove('standard')).rejects.toThrow(/ships with the deployment/)
  })

  it.each(['../escape', 'a/b', '/abs', 'Upper'])('refuses the uncontainable id %j', async (id) => {
    // The id becomes a directory name under the user root, so containment is
    // checked on the id rather than on the joined path afterwards.
    await expect(authorCtx.agentPresets.copy('minimal', id)).rejects.toThrow()
  })

  it('copies a shipped preset a session then really composes from', async () => {
    await authorCtx.agentPresets.copy('minimal', 'my-agent', '我的模式')

    // Round-trips through the roster as a `user` row carrying the given name
    // and the source's description, over the source's own composition text.
    const preset = await authorCtx.agentPresets.resolve('my-agent')
    const source = await authorCtx.agentPresets.resolve('minimal')
    expect(preset.trust).toBe('user')
    expect(preset.name).toBe('我的模式')
    expect(preset.description).toBe(source.description)
    expect(await authorCtx.agentPresets.read('my-agent')).toBe(await authorCtx.agentPresets.read('minimal'))
    // Owner-only, in an owner-only directory: a composition is executable
    // configuration on a machine that may have other users.
    if (process.platform !== 'win32') expect((await stat(preset.path)).mode & 0o777).toBe(0o600)
    const handle = await authorCtx.agents.create({
      sessionId: SessionId('preset-authored'),
      setup: agentCtx => authorCtx.agentPresets.mount(agentCtx, 'my-agent').then(() => undefined),
    })
    try {
      // The same tools the shipped `minimal` composes, from a directory copied
      // through the service into a root outside the installed harness.
      expect(coreToolNames(authorCtx, handle.agent)).toEqual(process.platform === 'win32'
        ? ['pwsh', 'str_replace_editor']
        : ['bash', 'str_replace_editor'])
    } finally {
      await handle.dispose()
    }
  })

  it('deletes what it copied', async () => {
    await authorCtx.agentPresets.copy('minimal', 'doomed')

    await authorCtx.agentPresets.remove('doomed')

    expect((await authorCtx.agentPresets.list()).map(preset => preset.id)).not.toContain('doomed')
  })
})

/**
 * Which preset an unnamed session gets is a user setting layered over the
 * composition's own default. The package suite proves the layering against a
 * hand-built context; this proves it through the shipped `cordis.yml` — that
 * the roster and the settings provider are actually wired to each other, and
 * that the id the setting names is the one a session composes from.
 */
describe('the default preset as a user setting', () => {
  it('composes an unnamed session from the stored default, not the composed one', async () => {
    expect(ctx.agentPresets.defaultId).toBe('standard')

    await ctx.settings.update(settingsNamespace(SETTINGS_NAMESPACE), { default: 'minimal' })
    try {
      expect(ctx.agentPresets.defaultId).toBe('minimal')

      const handle = await ctx.agents.create({
        sessionId: SessionId('preset-user-default'),
        setup: agentCtx => ctx.agentPresets.mount(agentCtx).then(() => undefined),
      })
      try {
        // `mount()` with no id resolves the effective default. The preset
        // supplies the minimal shell and editor tools.
        expect(coreToolNames(ctx, handle.agent)).toEqual(process.platform === 'win32'
          ? ['pwsh', 'str_replace_editor']
          : ['bash', 'str_replace_editor'])
      } finally {
        await handle.dispose()
      }
    } finally {
      // The context is shared with the rest of the file. `replace({})` drops
      // the user section wholesale so the field re-inherits the composition
      // base; `update` merges, and would leave the override standing.
      await ctx.settings.replace(settingsNamespace(SETTINGS_NAMESPACE), {})
    }

    expect(ctx.agentPresets.defaultId).toBe('standard')
  })
})

describe('a session keeps the preset it was created with', () => {
  it('refuses to adopt a live session under a different preset', async () => {
    const handle = await ctx.agents.create({
      sessionId: SessionId('preset-locked'),
      meta: { agentPreset: 'minimal' },
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'minimal').then(() => undefined),
    })
    try {
      // The api-proxy guard reads exactly this: the header records what the
      // session runs, so naming anything else is a caller error rather than a
      // switch. Its history was produced under `minimal`'s two tools.
      expect(handle.agent.session.header.agentPreset).toBe('minimal')
    } finally {
      await handle.dispose()
    }
  })
})

// Boots the shipped Web composition over the built dist this lane already uses
// and asserts what that composition produces: the model-visible tool catalog
// and file-reference guidance plus its retry, sandbox, and approval defaults.
// No browser and no model call — these are composition facts, and the browser
// scenarios in this lane cover the surface itself.
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { CallId } from '@hydraharness/harness-llm'
import { canonicalPath, writableRoots } from '@hydraharness/harness-sandbox'
import { SessionId } from '@hydraharness/harness-session'
import { settingsNamespace } from '@hydraharness/harness-settings'
// Empty type imports carry the tools/sandboxPolicy/approval Context merges.
import type {} from '@hydraharness/harness-tools'
import type {} from '@hydraharness/harness-sandbox-policy'
import type {} from '@hydraharness/harness-user-approval'
import type {} from '@hydraharness/harness-permission-presets'
import type {} from '@hydraharness/harness-agent-presets'
import type {} from '@hydraharness/harness-commands'
import type {} from '@hydraharness/harness-system-prompt'
import { launchWebScaffold, type WebScaffold } from './scaffold.ts'

const FILE_REFERENCE_PROMPT = fileURLToPath(new URL(
  './snapshots/web-runtime-context/file-reference-prompt.expected.md', import.meta.url,
))

/** Shipped agent tools, including bounded Obsidian access and public HTTP fetch. */
const EXPECTED_TOOLS = [
  'ask_user_question',
  'create_goal',
  'edit',
  'exit_plan_mode',
  'gemini_web_retrieve',
  'get_goal',
  'image_generate',
  'image_generate_google',
  'interrupt_agent',
  'job_kill',
  'job_list',
  'job_output',
  'list_agents',
  'obsidian_knowledge_read',
  'obsidian_knowledge_recall',
  'obsidian_knowledge_save_approved',
  'ralph',
  'read',
  'read_image',
  'send_message',
  'session_version_list',
  'session_version_read',
  'skill',
  'skill_search',
  'subagent',
  'subagent_fork',
  'todo_write',
  'update_goal',
  'video_generate',
  'web_fetch',
  'web_search',
  'workflow',
  'write',
]

/**
 * `glob` and `grep` come from `hydra-tool-fs-search`, which spawns the PACKAGED
 * ripgrep binary (`@vscode/ripgrep`) through the subprocess seam, so the pair
 * is always present on every host — asserted as fixed members, not a host
 * dependency.
 */
const RIPGREP_TOOLS = ['glob', 'grep']
const SHELL_TOOL = process.platform === 'win32' ? 'pwsh' : 'bash'

let scaffold: WebScaffold | undefined

afterEach(async () => {
  await scaffold?.close()
  scaffold = undefined
})

it('assembles the shipped Web catalog, file-reference guidance, retry policy, and confined access default', async () => {
  scaffold = await launchWebScaffold({ deepSeekMissingCredential: true })
  const ctx = scaffold.ctx
  expect(ctx.llm.providerRetryPolicy('deepseek-official')).toMatchInlineSnapshot(`
    {
      "initialDelayMs": 500,
      "jitterRatio": 0.1,
      "maxDelayMs": 10000,
      "maxRetries": 5,
      "mode": "normal",
      "retryableCodes": [
        "EMPTY_RESPONSE",
        "RATE_LIMIT",
        "SERVER",
        "TIMEOUT",
        "TRANSPORT",
      ],
    }
  `)
  await ctx.settings.update(settingsNamespace('llm-deepseek'), {
    retryPolicy: { mode: 'always', maxRetries: 5 },
  })
  expect(ctx.llm.providerRetryPolicy('deepseek-official')).toMatchInlineSnapshot(`
    {
      "initialDelayMs": 500,
      "jitterRatio": 0.1,
      "maxDelayMs": 10000,
      "mode": "always",
    }
  `)
  await ctx.settings.update(settingsNamespace('llm-pi-ai'), {
    providers: {
      openai: {},
      anthropic: { retryPolicy: { mode: 'always' } },
    },
  })
  expect(ctx.llm.providerRetryPolicy('openai')).toMatchInlineSnapshot(`
    {
      "initialDelayMs": 500,
      "jitterRatio": 0.1,
      "maxDelayMs": 10000,
      "maxRetries": 5,
      "mode": "normal",
      "retryableCodes": [
        "EMPTY_RESPONSE",
        "RATE_LIMIT",
        "SERVER",
        "TIMEOUT",
        "TRANSPORT",
      ],
    }
  `)
  expect(ctx.llm.providerRetryPolicy('anthropic')).toMatchInlineSnapshot(`
    {
      "initialDelayMs": 500,
      "jitterRatio": 0.1,
      "maxDelayMs": 10000,
      "mode": "always",
    }
  `)
  expect(ctx.tools.schemas().map(schema => schema.name).sort()).toEqual([
    'gemini_web_retrieve',
    'image_generate', 'image_generate_google',
    'obsidian_knowledge_read', 'obsidian_knowledge_recall', 'obsidian_knowledge_save_approved',
    'session_version_list', 'session_version_read', 'video_generate',
  ])
  const handle = await ctx.agents.create({
    sessionId: SessionId('shipped-composition'),
    setup: agentCtx => ctx.agentPresets.mount(agentCtx).then(() => undefined),
  })
  try {
    const names = ctx.tools.schemas(handle.agent).map(schema => schema.name).sort()
    const browserTools = names.filter(name => name.startsWith('browser_'))
    expect(browserTools.length).toBeGreaterThan(0)
    expect(names.filter(name => !RIPGREP_TOOLS.includes(name) && !name.startsWith('browser_'))).toEqual([...EXPECTED_TOOLS, SHELL_TOOL].sort())
    // The packaged ripgrep binary ships with the dependency, so the pair is a
    // fixed roster member on every host.
    expect(names.filter(name => RIPGREP_TOOLS.includes(name))).toEqual(RIPGREP_TOOLS)
    const fileReferenceSection = (await ctx.systemPrompt.assemble({ scope: handle.agent })).sections
      .find(section => section.name === 'ui:deliverable-file-references')
    expect(fileReferenceSection?.text).toBe(readFileSync(FILE_REFERENCE_PROMPT, 'utf8').trimEnd())
  } finally {
    await handle.dispose()
  }
  // `workspace-write` is not "the workspace and nothing else": the shared roots
  // helper always admits the temp directories too. Pinning it against an
  // explicit mode keeps the claim independent of this surface's default, and
  // keeps a future sandbox-confinement test from being run inside /tmp — where an
  // "escape" write succeeds by design and reads as a sandbox failure.
  expect(writableRoots(scaffold.ctx.sandboxPolicy.resolve({ mode: 'workspace-write' }))).toEqual(
    expect.arrayContaining([canonicalPath('/tmp'), canonicalPath(tmpdir())]),
  )
  expect(scaffold.ctx.sandboxPolicy.defaultMode).toBe('workspace-write')
  expect(scaffold.ctx.approval.config.policy).toBe('ask')
  expect(scaffold.ctx.permissionPresets.defaultPreset).toBe('workspace-write')

  const commandHandle = await scaffold.ctx.agents.create({
    sessionId: SessionId('shipped-command-catalog'),
    meta: { cwd: scaffold.workspaceCwd },
    agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
  })
  try {
    expect(scaffold.ctx.commands.list(commandHandle.agent)).toContainEqual({
      name: 'feedback',
      description: 'record feedback about this session',
      input: { hint: '<text>' },
    })
  } finally {
    await commandHandle.dispose()
  }
}, 120_000)

it('lets a preset producer reach the background-job registry', async () => {
  scaffold = await launchWebScaffold()
  const ctx = scaffold.ctx
  const handle = await ctx.agents.create({
    sessionId: SessionId('shipped-background-job'),
    meta: { cwd: scaffold.workspaceCwd },
    setup: agentCtx => ctx.agentPresets.mount(agentCtx).then(() => undefined),
  })
  try {
    const signal = new AbortController().signal
    // The shell tool is a preset row and jobs is a host registry; the producer
    // resolves it with `ctx.get`, so a registry hidden behind a preset realm
    // fails here — with every task control still listed in the catalog above.
    const started = await ctx.tools.execute({
      signal,
      callId: CallId('shipped-bash-background'),
      name: SHELL_TOOL,
      arguments: {
        command: process.platform === 'win32' ? 'Write-Output SHIPPED_BACKGROUND_OK' : 'printf SHIPPED_BACKGROUND_OK',
        description: 'shipped background probe',
        run_in_background: true,
      },
      agent: handle.agent,
    })
    expect({ isError: started.isError, content: started.content }).toEqual({
      isError: false,
      content: [{ type: 'text', text: `started background job ${SHELL_TOOL}-1` }],
    })

    // The controller reads what the producer started: same registry, one
    // owner. A per-preset registry would list nothing here even on success.
    const listed = await ctx.tools.execute({
      signal,
      callId: CallId('shipped-task-list'),
      name: 'job_list',
      arguments: {},
      agent: handle.agent,
    })
    expect(listed.isError).toBe(false)
    expect(listed.content).toEqual([
      { type: 'text', text: expect.stringContaining(`${SHELL_TOOL}-1 [${SHELL_TOOL}]`) as unknown as string },
    ])

    // The full round trip: the output a host-plane producer wrote is collected
    // through a preset-plane control, which is the linkage the realm severed.
    const collected = await ctx.tools.execute({
      signal,
      callId: CallId('shipped-task-output'),
      name: 'job_output',
      arguments: { job_id: `${SHELL_TOOL}-1`, wait: true },
      agent: handle.agent,
    })
    expect(collected.isError).toBe(false)
    expect(collected.content).toEqual([
      { type: 'text', text: expect.stringContaining('SHIPPED_BACKGROUND_OK') as unknown as string },
    ])
  } finally {
    await handle.dispose()
  }
}, 120_000)

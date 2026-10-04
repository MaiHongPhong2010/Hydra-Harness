import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AgentHandle } from '@hydraharness/harness-agent'
import { CallId, createUserMessage } from '@hydraharness/harness-llm'
import { SessionId } from '@hydraharness/harness-session'
import type {} from '@hydraharness/harness-agent-presets'
import type {} from '@hydraharness/harness-system-prompt'
import { assertFixtureInventory, launchWebScaffold, type WebScaffold } from './scaffold.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/minimal-preset', import.meta.url))
const FIXTURE = join(SNAPSHOT_DIR, 'session.jsonl')
const PROMPT = 'Reply exactly MINIMAL_PRESET_REQUEST_OK and stop.'

describe('minimal agent preset', () => {
  let scaffold: WebScaffold
  let agentHandle: AgentHandle
  let disposeInjectedPrompt: () => void

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ replayFixture: FIXTURE })
    disposeInjectedPrompt = scaffold.ctx.systemPrompt.section({
      name: 'test:injected-prompt',
      order: 999,
      text: 'THIS TEXT MUST NOT REACH THE MODEL.',
    })
    agentHandle = await scaffold.ctx.agents.create({
      sessionId: SessionId('minimal-preset-smoke'),
      meta: { cwd: scaffold.workspaceCwd, agentPreset: 'minimal' },
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      setup: agentCtx => scaffold.ctx.agentPresets.mount(agentCtx, 'minimal').then(() => undefined),
    })
  })

  afterAll(async () => {
    const failures: unknown[] = []
    await agentHandle?.dispose().catch((error: unknown) => failures.push(error))
    try {
      disposeInjectedPrompt?.()
    } catch (error: unknown) {
      failures.push(error)
    }
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'minimal preset smoke teardown failed')
  })

  it('sends the exact RL prompt and schemas, then executes the persistent shell and editor', async () => {
    agentHandle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: PROMPT }],
      source: { kind: 'user' },
    }))
    await agentHandle.agent.whenIdle()

    const requestHeader = agentHandle.agent.session.requestHeader()
    if (requestHeader === undefined) throw new Error('the minimal agent issued no model request')
    expect(agentHandle.agent.session.events.some(event => event.type === 'user/message'
      && event.data.source.kind === 'plugin'
      && event.data.source.plugin === '@hydraharness/harness-system-prompt')).toBe(false)
    const presetFileSystem = scaffold.ctx.agentPresets.serviceFor(agentHandle.agent, 'fs')
    expect(presetFileSystem).toBeDefined()
    expect(presetFileSystem?.sandboxMode).toBeUndefined()
    expect(scaffold.ctx.agentPresets.serviceFor(agentHandle.agent, 'compaction')).toBeUndefined()

    const stateDir = join(scaffold.workspaceCwd, 'persistent-state')
    await mkdir(stateDir)
    const signal = new AbortController().signal
    const shell = process.platform === 'win32' ? 'pwsh' : 'bash'
    const otherShell = shell === 'pwsh' ? 'bash' : 'pwsh'
    const shellSetup = process.platform === 'win32'
      ? `Set-Location -LiteralPath '${stateDir.replaceAll("'", "''")}'; $env:HYDRA_MINIMAL_STATE = 'PERSISTED'`
      : `cd ${JSON.stringify(stateDir)} && export HYDRA_MINIMAL_STATE=PERSISTED`
    const shellRead = process.platform === 'win32'
      ? "Write-Output ($env:HYDRA_MINIMAL_STATE + ':' + $PWD.Path)"
      : 'printf \'%s:%s\\n\' "$HYDRA_MINIMAL_STATE" "$PWD"'
    await scaffold.ctx.tools.execute({
      signal,
      callId: CallId('minimal-bash-state-setup'),
      name: shell,
      arguments: { command: shellSetup },
      agent: agentHandle.agent,
    })
    const shellResult = await scaffold.ctx.tools.execute({
      signal,
      callId: CallId('minimal-bash-state-read'),
      name: shell,
      arguments: { command: shellRead },
      agent: agentHandle.agent,
    })
    const seedPath = join(scaffold.workspaceCwd, 'preset-smoke.txt')
    await writeFile(seedPath, 'MINIMAL_EDITOR_OK\n')
    const editor = await scaffold.ctx.tools.execute({
      signal,
      callId: CallId('minimal-editor-smoke'),
      name: 'str_replace_editor',
      arguments: { command: 'view', path: seedPath },
      agent: agentHandle.agent,
    })

    const text = (result: typeof shellResult): string => result.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
      .replaceAll(scaffold.workspaceCwd, '{{cwd}}')
      .replaceAll('\\', '/')
      .trimEnd()

    const toolNames = requestHeader.tools?.map(tool => tool.name) ?? []
    expect(toolNames).toContain(shell)
    expect(toolNames).not.toContain(otherShell)
    expect({
      prompt: requestHeader.system,
      tools: toolNames.map(name => name === shell ? 'shell' : name).toSorted(),
      shell: text(shellResult),
      editor: text(editor),
    }).toMatchInlineSnapshot(`
      {
        "editor": "Here's the content of {{cwd}}/preset-smoke.txt with line numbers (which has a total of 2 lines):
           1  MINIMAL_EDITOR_OK
           2",
        "prompt": "You are a helpful software engineer assistant.",
        "shell": "PERSISTED:{{cwd}}/persistent-state",
        "tools": [
          "image_generate",
          "image_generate_google",
          "obsidian_knowledge_read",
          "obsidian_knowledge_recall",
          "obsidian_knowledge_save_approved",
          "session_version_list",
          "session_version_read",
          "shell",
          "str_replace_editor",
          "video_generate",
        ],
      }
    `)
    expect(requestHeader.tools?.toSorted((left, right) => left.name.localeCompare(right.name)))
      .toEqual(scaffold.ctx.tools.schemas(agentHandle.agent).toSorted((left, right) => left.name.localeCompare(right.name)))
    await assertFixtureInventory(SNAPSHOT_DIR, ['session.jsonl'])
  })
})

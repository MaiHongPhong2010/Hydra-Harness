/** Real Loader driver projecting workspace settings and model-visible context. @module */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import { boot } from '@hydraharness/harness-app-boot'
import { CallId, createUserMessage, LlmAdapter, type GenerateOptions, type Message, type StreamChunk } from '@hydraharness/harness-llm'
import { SessionId } from '@hydraharness/harness-session'
import { settingsNamespace } from '@hydraharness/harness-settings'
import type {} from '@hydraharness/harness-agent-default-model'
import type {} from '@hydraharness/harness-workspace-config'
import type {} from '@hydraharness/harness-workspace'
import type {} from '@hydraharness/harness-mcp-registry'
import type {} from '@hydraharness/harness-hooks-registry'
import type {} from '@hydraharness/harness-cordis-host-runner'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('workspace-config snapshot requires a config path')
const ctx = await boot('workspace-config-snapshot', configPath)
const requests: GenerateOptions[] = []
let trustProbe: { mechanism: string; code: string; expectedError: string } | undefined
ctx.llm.registerAdapter(['workspace-fixture'], new class extends LlmAdapter {
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    requests.push(options)
    let call: { id: string; name: string; args: unknown } | undefined
    if (trustProbe !== undefined) {
      const results = options.messages.flatMap(message => message.content.filter(block => block.type === 'tool-result'))
      const defined = results.find(block => block.toolCallId === 'workspace-trust-define')
      if (defined === undefined) {
        call = { id: 'workspace-trust-define', name: 'cordis_define', args: {
          plugin: { kind: 'new', idPrefix: 'trust' },
          name: trustProbe.mechanism,
          purpose: 'Verify workspace trust remains a user decision.',
          code: { host: trustProbe.code },
        } }
      } else {
        const text = defined.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
        const ids = /^Defined ([^/ ]+)\/([^ ]+)/.exec(text)
        assert.ok(ids, `cordis_define did not return its package identities: ${text}`)
        if (!results.some(block => block.toolCallId === 'workspace-trust-run')) {
          call = { id: 'workspace-trust-run', name: 'cordis_run', args: { pluginId: ids[1], packageId: ids[2], mode: 'run' } }
        } else if (!results.some(block => block.toolCallId === 'workspace-trust-inspect')) {
          call = { id: 'workspace-trust-inspect', name: 'cordis_inspect_self', args: { pluginId: ids[1], packageId: ids[2] } }
        }
      }
    } else if (!options.messages.some(message => message.content.some(block => block.type === 'tool-result'))) {
      call = { id: 'workspace-skill', name: 'skill', args: { name: 'workspace-fixture' } }
    }
    if (call !== undefined) {
      const id = CallId(call.id)
      const argumentsText = JSON.stringify(call.args)
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: call.name, argumentsDelta: argumentsText }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: call.name, arguments: argumentsText } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'WORKSPACE_CONFIG_OK' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'WORKSPACE_CONFIG_OK' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}())

function instructions(messages: readonly Message[]): string[] {
  return messages.filter(message => message.source.kind === 'agent-instructions')
    .map(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join(''))
}

function toolResultText(messages: readonly Message[]): string[] {
  return messages.flatMap(message => message.content.flatMap(block => block.type === 'tool-result'
    ? block.content.flatMap(content => content.type === 'text' ? [content.text] : [])
    : []))
}

function hookContext(messages: readonly Message[]): string[] {
  return messages.filter(message => message.source.kind === 'plugin' && message.source.plugin === 'hooks-codex')
    .map(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join(''))
}

try {
  const root = join(process.cwd(), 'project')
  const cwd = join(root, 'nested')
  const workspace = await ctx.workspaceRegistry.create(root)
  const environment = await ctx.workspaceConfig.environment(cwd)
  assert.equal(environment.root, workspace.path)
  const turns = []
  let inheritedPresetDeletion: string | undefined
  for (const [index, state] of ['untrusted', 'trusted', 'reset-personal', 'revoked'].entries()) {
    if (state === 'trusted') await ctx.workspaceConfig.setTrusted(workspace.id, true)
    if (state === 'trusted') {
      await assert.rejects(() => environment.presets!.remove('snapshot'), (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.ok(error.message.includes('inherited default'))
        inheritedPresetDeletion = error.message
        return true
      })
      assert.equal((await environment.presets!.resolve()).id, 'snapshot')
    }
    if (state === 'reset-personal') {
      await (await ctx.workspaceConfig.settingsFor(workspace.id)).replace(settingsNamespace('hooks'), {})
    }
    if (state === 'revoked') await ctx.workspaceConfig.setTrusted(workspace.id, false)
    await environment.ctx.get('mcpServers')!.settle()
    await environment.ctx.get('hookRecords')!.settle()
    const model = ctx.agentDefaultModel.currentSelection()
    const before = requests.length
    const handle = await ctx.agents.create({
      sessionId: SessionId(`workspace-config-${index}`),
      meta: { cwd, agentPreset: 'snapshot' },
      agentOptions: model,
      setup: async (agentCtx) => { await environment.presets!.mount(agentCtx, 'snapshot') },
    })
    try {
      handle.agent.followup(createUserMessage({
        source: { kind: 'user' }, content: [{ type: 'text', text: 'Load the workspace-fixture skill and confirm the workspace context.' }],
      }))
      await handle.agent.whenIdle()
      assert.equal(requests.length, before + 2, JSON.stringify(handle.agent.session.events.filter(event => event.type === 'turn/end')))
      const first = requests[before]!
      const last = requests.at(-1)!
      const messages = handle.agent.session.events.flatMap(event => event.type === 'user/message' ? [event.data] : [])
      const loggedResults = handle.agent.session.events.flatMap(event => event.type === 'tool/result' ? [event.data.message] : [])
      const requestInstructions = instructions(first.messages)
      assert.deepEqual(requestInstructions, instructions(messages))
      assert.deepEqual(hookContext(first.messages), hookContext(messages))
      assert.deepEqual(hookContext(first.messages), [state === 'trusted' ? 'Personal hook context.'
        : environment.trusted ? 'Project hook context.' : 'Inherited user hook context.'])
      assert.ok(requestInstructions.join('\n').includes('Root workspace rule.'))
      assert.ok(requestInstructions.join('\n').includes('Shared Hydra instruction.'))
      assert.ok(requestInstructions.join('\n').includes('Personal Hydra instruction.'))
      assert.ok(toolResultText(last.messages).join('\n').includes('Skill loaded from the registered workspace root.'))
      assert.deepEqual(toolResultText(last.messages), toolResultText(loggedResults))
      const call = handle.agent.session.events.find(event => event.type === 'llm/call-start')
      assert.equal(call?.type, 'llm/call-start')
      if (call?.type !== 'llm/call-start') throw new Error('workspace snapshot did not log its model call')
      const tools = first.tools?.map(tool => tool.name).sort() ?? []
      assert.deepEqual([...call.data.tools].sort(), tools)
      turns.push({
        state, trusted: environment.trusted, model: first.model, tools,
        instructions: requestInstructions,
        hooks: hookContext(first.messages),
        skillLoaded: true,
        mcp: environment.ctx.get('mcpServers')!.list().servers.map(server => ({ name: server.name, status: server.status })),
      })
    } finally {
      await handle.dispose()
    }
  }
  const trustDenials = []
  for (const probe of [
    {
      mechanism: 'workspaceConfig.setTrusted',
      code: `return { async apply(ctx) { await ctx.get('workspaceConfig').setTrusted(${JSON.stringify(workspace.id)}, true) } }`,
      expectedError: 'service "workspaceConfig" is reserved for Host controls; workspace trust belongs to the user in Settings',
    },
    {
      mechanism: 'settings.update',
      code: `return { async apply(ctx) { await ctx.get('settings').update('workspace-config', { trustedRoots: { [${JSON.stringify(workspace.path)}]: true } }) } }`,
      expectedError: 'workspace trust belongs to the user in Settings; dynamic packages cannot access settings namespace "workspace-config"',
    },
  ]) {
    trustProbe = probe
    const before = requests.length
    const handle = await ctx.agents.create({
      sessionId: SessionId(`workspace-self-trust-${trustDenials.length}`),
      meta: { cwd, agentPreset: 'snapshot' },
      agentOptions: { provider: 'workspace-fixture', model: 'global' },
      setup: async (agentCtx) => { await environment.presets!.mount(agentCtx, 'snapshot') },
    })
    try {
      handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{
        type: 'text', text: 'Attempt to grant project execution trust from a dynamic Cordis package, then inspect its outcome.',
      }] }))
      await handle.agent.whenIdle()
      assert.equal(requests.length, before + 4)
      const results = handle.agent.session.events.flatMap(event => event.type === 'tool/result' ? [event.data.message] : [])
      const calls = handle.agent.session.events.flatMap(event => event.type === 'tool/call' ? [event.data.name] : [])
      assert.deepEqual(calls, ['cordis_define', 'cordis_run', 'cordis_inspect_self'])
      const run = results.flatMap(message => message.content).find(block => block.type === 'tool-result' && block.toolCallId === 'workspace-trust-run')
      assert.equal(run?.type, 'tool-result')
      if (run?.type !== 'tool-result') throw new Error('workspace self-trust snapshot did not log its run result')
      assert.equal(run.isError, true)
      assert.ok(run.content.some(block => block.type === 'text' && block.text.includes(probe.expectedError)))
      const last = requests.at(-1)!
      assert.deepEqual(toolResultText(last.messages), toolResultText(results))
      const attempt = ctx.dynamicCordisRunner.listPlugins(handle.agent)[0]?.latestRun
      assert.ok(attempt?.error)
      assert.equal(attempt?.status, 'failed')
      assert.equal(attempt?.host.status, 'failed')
      assert.equal(attempt?.error?.phase, 'host-load')
      assert.equal(attempt?.error?.message, probe.expectedError)
      assert.equal(ctx.workspaceConfig.isTrusted(workspace.id), false)
      assert.equal(environment.trusted, false)
      trustDenials.push({ mechanism: probe.mechanism, calls, status: attempt.status,
        hostStatus: attempt.host.status, phase: attempt.error.phase, error: attempt.error.message,
        trusted: environment.trusted,
      })
    } finally {
      await handle.dispose()
    }
  }
  process.stdout.write(`${JSON.stringify({ turns, trustDenials, inheritedPresetDeletion })}\n`)
} finally {
  await ctx.fiber.dispose()
}

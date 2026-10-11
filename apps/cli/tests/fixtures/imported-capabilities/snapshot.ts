import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { boot, loadOverlayPatches } from '@hydraharness/harness-app-boot'
import { CallId, createUserMessage, LlmAdapter, type GenerateOptions, type Message, type StreamChunk } from '@hydraharness/harness-llm'
import { SessionId } from '@hydraharness/harness-session'
import { bindScopeParent, scopeOf } from '@hydraharness/harness-scope'
import type {} from '@hydraharness/harness-workspace-config'
import type {} from '@hydraharness/harness-plugin-runtime'
import type {} from '@hydraharness/harness-tools'
import type {} from '@hydraharness/harness-hooks-registry'

const overlayPath = process.argv[2]
if (overlayPath === undefined) throw new Error('imported-capabilities snapshot requires an overlay path')
const rootConfig = fileURLToPath(new URL('../../../../../packages/bundle/base/tests/fixtures/root.cordis.yml', import.meta.url))
const basePatch = fileURLToPath(new URL('../../../../../packages/bundle/base/cordis.patch.yml', import.meta.url))
const ctx = await boot('imported-capabilities-snapshot', rootConfig, [
  ...loadOverlayPatches('imported-capabilities-snapshot', basePatch),
  ...loadOverlayPatches('imported-capabilities-snapshot', overlayPath),
])
const requests: GenerateOptions[] = []
const adapter = new class extends LlmAdapter {
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'ok' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}()
try {
  const identity = (await ctx.importedPlugins.import(join(process.cwd(), 'plugin'))).plugins[0]!.identity
  await ctx.importedPlugins.enable(identity)
  await ctx.importedPlugins.setMcpServerEnabled(identity, 'local', true)
  let enabled = await ctx.importedPlugins.info(identity)
  let server = enabled.mcpServers.find(candidate => candidate.name === 'local')
  if (server === undefined) throw new Error(`imported MCP server local is missing from ${identity}`)
  let toolName = server.tools.find(name => name.endsWith('__admin__reset'))
  const deadline = Date.now() + 10_000
  while (toolName === undefined && server.startupState !== 'failed' && Date.now() < deadline) {
    await setTimeout(50)
    enabled = await ctx.importedPlugins.info(identity)
    server = enabled.mcpServers.find(candidate => candidate.name === 'local')
    if (server === undefined) throw new Error(`imported MCP server local disappeared from ${identity}`)
    toolName = server.tools.find(name => name.endsWith('__admin__reset'))
  }
  if (toolName === undefined) {
    throw new Error(`imported MCP tool admin__reset not discovered (state=${server.startupState}, tools=${JSON.stringify(server.tools)})`)
  }
  const discoveredToolName = toolName
  async function tool() {
    const result = await ctx.tools.execute({ name: discoveredToolName, arguments: {}, callId: CallId('mcp-check'), signal: new AbortController().signal })
    return { isError: result.isError, text: result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('') }
  }
  const defaultDenied = (await tool()).isError
  await ctx.importedPlugins.setMcpToolApproval(identity, 'local', 'admin__reset', 'allow')
  const allowed = await tool()
  await ctx.importedPlugins.setMcpToolApproval(identity, 'local', 'admin__reset', 'deny')
  const denied = await tool()
  ctx.llm.registerAdapter(['capability-fixture'], adapter)
  function project(messages: readonly Message[]) {
    return messages.filter(message => message.source.kind === 'user'
      || message.source.kind === 'plugin' && ['hooks-codex', 'hooks-claude-code'].includes(message.source.plugin))
      .map(message => ({ source: message.source, text: message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('') }))
  }
  const turns = []
  for (const [index, state] of ['pending', 'trusted', 'untrusted', 'disabled', 'user-codex', 'user-claude'].entries()) {
    if (state === 'trusted') await ctx.importedPlugins.trustHooks(identity)
    if (state === 'untrusted') await ctx.importedPlugins.untrustHooks(identity)
    if (state === 'disabled') await ctx.importedPlugins.disable(identity)
    if (state === 'user-codex' || state === 'user-claude') {
      await ctx.hookRecords.define({
        mode: 'create', name: state, dialect: state === 'user-codex' ? 'codex' : 'claude-code', enabled: true,
        config: { UserPromptSubmit: [{ hooks: [{ command: 'node user-hook.cjs' }] }] },
      })
    }
    const handle = await ctx.agents.create({
      sessionId: SessionId(`capability-fixture-${index}`), meta: { cwd: process.cwd() },
      agentOptions: { provider: 'capability-fixture', model: 'fixture' },
      setup: (agentCtx) => { bindScopeParent(scopeOf(agentCtx)!, ctx.workspaceConfig.userEnvironment().scopeKey) },
    })
    try {
      handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: `Check ${state}` }], source: { kind: 'user' } }))
      await handle.agent.whenIdle()
      const request = requests.at(-1)
      if (requests.length !== index + 1 || request === undefined) {
        const outcomes = handle.agent.session.events.filter(event => /error|reject/.test(event.type) || event.type === 'turn/end')
        throw new Error(`fixture expected request ${index + 1} at ${state}, got ${requests.length}: ${JSON.stringify(outcomes)}`)
      }
      const logged = handle.agent.session.events.flatMap(event => event.type === 'user/message' ? [event.data] : [])
      const hooks = handle.agent.session.events.filter(event => event.type === 'hook/invoked' || event.type === 'hook/result')
        .map(event => event.type)
      turns.push({ state, request: project(request.messages), logged: project(logged), hooks })
    } finally {
      await handle.dispose()
      if (state === 'user-codex' || state === 'user-claude') await ctx.hookRecords.remove(state)
    }
  }
  const hookRuns = await readFile(join(enabled.dataPath, 'hook-runs.txt'), 'utf8')
  const remaining = ctx.tools.schemas().filter(tool => server.tools.includes(tool.name)).length
  process.stdout.write(`${JSON.stringify({ startup: server.startupState, defaultDenied, allowed, denied, turns, hookRuns, remaining })}\n`)
} finally {
  await ctx.fiber.dispose()
}

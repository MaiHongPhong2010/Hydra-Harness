/** Service tier serialization through the installed Responses client. */
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@hydraharness/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import LlmRuntime, { LlmAdapter, type GenerateOptions, type StreamChunk } from '@hydraharness/harness-llm'
import { settingsNamespace } from '@hydraharness/harness-settings'
import FileSettings from '@hydraharness/harness-settings-file'
import * as PiAi from '@hydraharness/harness-llm-pi-ai'
import { closeMockServers, mockServer } from './mock-server.ts'

afterEach(async () => { vi.unstubAllEnvs(); await closeMockServers() })

it('falls back for a global Priority preference and rejects an unsupported explicit tier before dispatch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hydra-tier-fallback-'))
  const ctx = new Context()
  class StandardOnlyAdapter extends LlmAdapter {
    async * stream(_request: GenerateOptions): AsyncIterable<StreamChunk> { yield { type: 'finish', reason: { kind: 'stop' } } }
  }
  try {
    await ctx.plugin(FileSettings, { path: join(root, 'settings.yaml'), watch: false })
    await ctx.plugin(LlmRuntime)
    ctx.llm.registerAdapter(['standard-only'], new StandardOnlyAdapter())
    await ctx.settings.update(settingsNamespace('llm-speed'), { tier: 'priority' })
    const prepared = await ctx.llm.prepareCall({ provider: 'standard-only', model: 'm' })
    expect(prepared.config).toMatchObject({ model: 'm', requestedServiceTier: 'priority' })
    expect(prepared.config).not.toHaveProperty('serviceTier')
    await expect(ctx.llm.prepareCall({ provider: 'standard-only', model: 'm', serviceTier: 'priority' })).rejects.toMatchObject({ code: 'UNSUPPORTED_SERVICE_TIER' })
  } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
})

it('sends Priority without changing model and carries the provider-reported fallback tier', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hydra-tier-'))
  const ctx = new Context()
  const response = { id: 'resp_fixture', object: 'response', status: 'completed', model: 'fixture-model', service_tier: 'default',
    output: [{ id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'hello', annotations: [] }] }],
    usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 } }
  const server = await mockServer([{ events: [JSON.stringify({ type: 'response.completed', response })] }, { status: 401, body: '{}' }])
  vi.stubEnv('TIER_FIXTURE_KEY', 'fixture-key')
  try {
    await ctx.plugin(FileSettings, { path: join(root, 'settings.yaml'), watch: false })
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(PiAi, { providers: { fixture: { api: 'openai-responses', apiKeyEnv: 'TIER_FIXTURE_KEY', baseURL: `${server.url}/v1`, models: [{ id: 'fixture-model' }] } } })
    await ctx.settings.update(settingsNamespace('llm-speed'), { tier: 'priority' })
    const prepared = await ctx.llm.prepareCall({ provider: 'fixture', model: 'fixture-model' })
    expect(prepared.config).toMatchObject({ model: 'fixture-model', serviceTier: 'priority', requestedServiceTier: 'priority' })
    const chunks = []
    for await (const chunk of prepared.stream({ ...prepared.config, messages: [] })) chunks.push(chunk)
    expect(server.requests[0]).toMatchObject({ model: 'fixture-model', service_tier: 'priority' })
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', serviceTier: 'default' })
    await ctx.settings.update(settingsNamespace('llm-speed'), { tier: 'standard' })
    for await (const _chunk of ctx.llm.stream({ provider: 'fixture', model: 'fixture-model', messages: [], purpose: 'compaction' })) { /* Consume real request. */ }
    expect(server.requests[1]).toHaveProperty('service_tier', 'default')
  } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
})

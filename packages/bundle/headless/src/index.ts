/**
 * @hydraharness/harness-headless — one-shot direct Agent driver. The bundle patch
 * rides over @hydraharness/harness-base without Host, HTTP, or browser plugins; this runner
 * creates one Agent through the core registry, drives the task to quiescence,
 * flushes its Session, prints the final assistant text, and exits.
 *
 * @module @hydraharness/harness-headless
 */

import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import type { Context } from '@hydraharness/cordis'
import z from '@hydraharness/schemastery'
import { installModelSelection } from '@hydraharness/harness-agent'
import type { ModelSelectionRef } from '@hydraharness/harness-agent'
import type {} from '@hydraharness/harness-agent-default-model'
import { createUserMessage } from '@hydraharness/harness-llm'
import { bindScopeParent, scopeOf } from '@hydraharness/harness-scope'
import type {} from '@hydraharness/harness-agent-presets'
import type {} from '@hydraharness/harness-workspace-config'
import { SessionId } from '@hydraharness/harness-session'
import type { SessionEvent } from '@hydraharness/harness-session'
// Empty type imports carry the loader Context merge for the settlement await
// and the cmdline Context merge for the appExit host value.
import type {} from '@hydraharness/cordis-plugin-loader'
import type {} from '@hydraharness/harness-cmdline'

/** Stable Cordis plugin name. */
export const name = 'headless-runner'

/** Core services required before the one-shot turn can start. */
export const inject = ['agentDefaultModel', 'agents', 'sessions']

/** Plugin config: the task resolved from this app's injected provider service. */
export interface Config {
  /** The prompt text for the single run. */
  task: string
}

export const Config: z<Config> = z.object({
  task: z.string().required(),
})

/** Outcome of one owned run interval. */
interface RunOutcome {
  text: string
  reason: SessionEvent<'turn/end'>['data']['reason'] | undefined
}

/** Process-facing effects of one run: output streams plus the launcher's bounded exit request. */
interface HeadlessIo {
  stdout: { write(chunk: string): unknown }
  stderr: { write(chunk: string): unknown }
  /** Request process exit with `code` after the tree disposes. */
  exit(code: number): void
}

/** The process streams the runner writes to; tests substitute captures. */
export const internals: { stdout: HeadlessIo['stdout']; stderr: HeadlessIo['stderr'] } = {
  stdout: process.stdout,
  stderr: process.stderr,
}

/** Aggregate the last assistant text and turn outcome in one owned interval. */
function summarize(events: readonly SessionEvent[], firstSeq: number): RunOutcome {
  let started = false
  let text = ''
  let reason: SessionEvent<'turn/end'>['data']['reason'] | undefined
  for (const event of events) {
    if (event.seq < firstSeq) continue
    if (event.type === 'turn/start') {
      started = true
      continue
    }
    if (!started) continue
    if (event.type === 'assistant/message') {
      const joined = event.data.message.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('')
      if (joined !== '') text = joined
    }
    if (event.type === 'turn/end') reason = event.data.reason
  }
  return { text, reason }
}

/** Report an unexpected direct-driver failure and request a failing exit. */
function fail(io: HeadlessIo, error: unknown): void {
  io.stderr.write(`hydra: ${error instanceof Error ? error.message : String(error)}\n`)
  io.exit(1)
}

/**
 * Run one task through a freshly created Agent and request process exit.
 * @param ctx - plugin context carrying the Agent, default model, Session, and launcher IO services.
 * @param task - one-shot task text.
 * @param io - process-facing effects.
 */
async function run(ctx: Context, task: string, io: HeadlessIo): Promise<void> {
  // Loader siblings mount concurrently. Await the complete application before
  // creating an Agent so its scoped tools and adapters are not half-composed.
  await ctx.get('loader')?.await()
  const agents = ctx.get('agents')
  const defaultModel = ctx.get('agentDefaultModel')
  const sessions = ctx.get('sessions')
  // Early process shutdown can dispose the tree while settlement is pending.
  if (agents === undefined || defaultModel === undefined || sessions === undefined) return

  const cwd = process.cwd()
  const environment = await ctx.get('workspaceConfig')?.environment(cwd)
  const selection = defaultModel.currentSelection()
  const presets = environment?.presets ?? ctx.get('agentPresets')
  const presetId = presets?.defaultId
  const { agent } = await agents.create({
    sessionId: SessionId(`session-${randomUUID()}`),
    meta: { cwd, ...presetId === undefined ? {} : { agentPreset: presetId } },
    agentOptions: { provider: selection.provider, model: selection.model },
    setup: async (agentCtx) => {
      if (presets !== undefined) await presets.mount(agentCtx, presetId)
      else if (environment !== undefined) {
        const agentScope = scopeOf(agentCtx)
        assert(agentScope !== undefined, 'headless workspace setup requires an agent scope')
        bindScopeParent(agentScope, environment.scopeKey)
      }
      const selected: ModelSelectionRef = { current: selection, assembled: undefined }
      installModelSelection(agentCtx, selected)
    },
  })
  await agent.whenIdle()
  const firstSeq = agent.session.seq
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: task }],
    source: { kind: 'user' },
  }))
  await agent.whenIdle()
  await sessions.flush(agent.session)
  const outcome = summarize(agent.session.events, firstSeq)
  io.stdout.write(outcome.text + '\n')
  if (outcome.reason?.kind === 'error') {
    io.stderr.write(`hydra: ${outcome.reason.error.code}: ${outcome.reason.error.message}\n`)
  }
  io.exit(outcome.reason?.kind === 'completed' ? 0 : 1)
}

/**
 * Mount the one-shot direct driver.
 * @param ctx - plugin context carrying core services and the launcher-provided exit request.
 * @param config - validated task config.
 */
export function apply(ctx: Context, config: Config): void {
  // Read through the global service store, not the property proxy: appExit is
  // an optional host value, never an injected dependency.
  const exit = ctx.get('appExit')
  if (exit === undefined) {
    throw new Error('headless-runner: the launcher must provide ctx.appExit before the tree mounts')
  }
  const io: HeadlessIo = { stdout: internals.stdout, stderr: internals.stderr, exit }
  void run(ctx, config.task, io).catch((error: unknown) => { fail(io, error) })
}

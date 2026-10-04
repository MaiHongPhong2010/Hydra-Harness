/** Google route enrollment preserves service-specific project metadata. */
import { Context } from '@hydraharness/cordis'
import type { AuthorizationSession } from '@hydraharness/harness-authorization'
import { afterEach, expect, it, vi } from 'vitest'
import { MemoryCredentials } from '../../../credentials/authorization/tests/memory.ts'
import { accountRecordKey, createAccountPool } from '../src/accounts.ts'
import { loginGoogle } from '../src/google-oauth.ts'
const oauth = vi.hoisted(() => ({ login: vi.fn<typeof import('../src/antigravity-oauth.ts').loginAntigravity>() }))
vi.mock('../src/antigravity-oauth.ts', async load => ({
  ...await load<typeof import('../src/antigravity-oauth.ts')>(), loginAntigravity: oauth.login,
}))
const contexts: Context[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  oauth.login.mockReset()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})
it.each(['oauth', 'gemini-api'])('enrolls %s with default and explicit callback controls, with or without email', async (method) => {
  for (const explicit of [false, true]) {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(MemoryCredentials)
    const pool = createAccountPool({ ctx, key: accountRecordKey('gemini-api'), providerId: 'gemini-api', providerAliases: ['antigravity'], providerLabel: 'Google' })
    const grant = { access: 'access', refresh: 'refresh', expires: Date.now() + 60_000, projectId: 'assist-project', ...explicit ? { email: 'user@example.test' } : {} }
    oauth.login.mockImplementation(async (interaction, controls) => {
      expect(controls).toEqual(explicit ? { callbackPort: 0, callbackPath: '/callback', onboardingAttempts: 2, onboardingDelayMs: 1 } : {})
      interaction.notify({ message: 'OAuth ready' })
      await interaction.prompt({ kind: 'secret', message: 'Provider prompt' })
      return grant
    })
    const session: AuthorizationSession = { method, signal: new AbortController().signal, notify: vi.fn(), prompt: vi.fn(async () => 'fixture-project') }
    const fetcher = vi.fn(async () => Response.json({ models: [] }))
    vi.stubGlobal('fetch', fetcher)
    await loginGoogle(session, pool, explicit ? { callbackPort: 0, callbackPath: '/callback', onboardingAttempts: 2, onboardingDelayMs: 1, loginTimeoutMs: 60_000 } : {},
      explicit ? { endpoint: 'http://localhost:1234/v1beta/', timeoutMs: 1000 } : {})
    const accounts = await pool.accounts.list()
    expect(accounts).toHaveLength(1)
    expect(accounts[0]?.label).toBe(`${explicit ? 'user@example.test' : 'Google account'}${method === 'gemini-api' ? ' · fixture-project' : ''}`)
    const stored = await pool.withAccount(accounts[0]!.id, () => pool.credentials.read('gemini-api'))
    expect(stored).toMatchObject({ type: 'oauth', ...grant, ...method === 'gemini-api' ? { quotaProjectId: 'fixture-project' } : {} })
    expect(stored?.type === 'oauth' ? stored.accountId : undefined).toBe(explicit ? `user@example.test${method === 'gemini-api' ? ':fixture-project' : ''}` : undefined)
    if (method === 'gemini-api') expect(fetcher).toHaveBeenCalledWith(`${explicit ? 'http://localhost:1234/v1beta' : 'https://generativelanguage.googleapis.com/v1beta'}/models?pageSize=1`, expect.anything())
    else expect(fetcher).not.toHaveBeenCalled()
  }
})

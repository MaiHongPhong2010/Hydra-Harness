/** Shared Antigravity OAuth grant and separate Gemini Developer API quota project. */
import type { OAuthCredential } from '@earendil-works/pi-ai'
import type { AuthorizationSession } from '@hydraharness/harness-authorization'
import { LlmError } from '@hydraharness/harness-llm'
import type { AccountPool } from './accounts.ts'
import { loginAntigravity, refreshAntigravity } from './antigravity-oauth.ts'
import type { AccountProviderProfile } from './config.ts'
import { accountJson } from './json-response.ts'

/** One Google grant serving both routes with separate project identities. */
export interface GoogleCredential extends OAuthCredential {
  /** Code Assist project used by Antigravity requests and quota discovery. */
  projectId: string
  /** Cloud project charged for Gemini Developer API requests. */
  quotaProjectId: string
}

function quotaProject(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(value)) {
    throw new LlmError('Enter a valid Google Cloud project ID for Gemini API quota and billing.', 'INVALID_AUTH_CONFIG')
  }
  return value
}

/**
 * Admit the project metadata required by the Gemini API route.
 * @param credential - Host-stored Google OAuth grant.
 * @returns the grant with its validated, independent quota project.
 */
export function googleCredential(credential: OAuthCredential): GoogleCredential {
  if (credential.quotaProjectId === undefined) throw new LlmError('Reconnect Google to set a Gemini API quota project.', 'INVALID_CREDENTIAL')
  if (typeof credential.projectId !== 'string' || credential.projectId.trim() === '' || /[\r\n]/.test(credential.projectId)) {
    throw new LlmError('Google account has no Code Assist project.', 'INVALID_CREDENTIAL')
  }
  return { ...credential, projectId: credential.projectId, quotaProjectId: quotaProject(credential.quotaProjectId) }
}

/**
 * Refresh the shared grant through the OAuth client that issued it.
 * @param current - Host-stored shared Google grant.
 * @param signal - cancellation and deadline for the refresh exchange.
 * @returns a replacement retaining both project identities and account metadata.
 */
export async function refreshGoogle(current: OAuthCredential, signal: AbortSignal): Promise<GoogleCredential> {
  const grant = googleCredential(current)
  const refreshed = await refreshAntigravity({ refresh: grant.refresh, projectId: grant.projectId,
    ...typeof grant.email === 'string' ? { email: grant.email } : {} }, {}, signal)
  signal.throwIfAborted()
  return { ...grant, ...refreshed }
}

/**
 * Resolve and refresh the selected shared account under the Host credential lock.
 * @param pool - account owner, already scoped to the selected account.
 * @param provider - route consuming the selected account.
 * @param signal - cancellation and deadline for the complete request.
 * @returns the current grant; a missing quota project requires reconnecting Google.
 */
export async function selectedGoogleCredential(pool: AccountPool, provider: 'antigravity' | 'gemini-api', signal: AbortSignal): Promise<GoogleCredential> {
  let selected!: GoogleCredential
  await pool.credentials.modify(provider, async (current) => {
    signal.throwIfAborted()
    if (current?.type !== 'oauth') throw new LlmError('Google has no connected account.', 'MISSING_CREDENTIAL')
    selected = googleCredential(current)
    if (selected.expires > Date.now()) return undefined
    selected = await refreshGoogle(selected, signal)
    return selected
  })
  signal.throwIfAborted()
  return selected
}

/**
 * Open Google OAuth immediately; Gemini API alone adds and verifies a quota project.
 * @param session - selected service, browser handoff, and cancellation.
 * @param pool - shared Host-only account owner for both routes.
 * @param profile - Google callback, onboarding, and complete-login controls.
 * @param apiProfile - Gemini API endpoint and request deadline controls.
 * @returns after the selected service accepts the grant and the account is durably stored.
 */
export async function loginGoogle(session: AuthorizationSession, pool: AccountPool, profile: AccountProviderProfile,
  apiProfile: AccountProviderProfile): Promise<void> {
  const signal = AbortSignal.any([session.signal, AbortSignal.timeout(profile.loginTimeoutMs ?? 900_000)])
  const grant = await loginAntigravity({ signal, notify: (notice) => { session.notify(notice) },
    prompt: question => session.prompt(question) }, {
    ...profile.callbackPort === undefined ? {} : { callbackPort: profile.callbackPort },
    ...profile.callbackPath === undefined ? {} : { callbackPath: profile.callbackPath },
    ...profile.onboardingAttempts === undefined ? {} : { onboardingAttempts: profile.onboardingAttempts },
    ...profile.onboardingDelayMs === undefined ? {} : { onboardingDelayMs: profile.onboardingDelayMs },
  })
  if (session.method !== 'gemini-api') {
    await pool.add(grant.email ?? 'Google account', { type: 'oauth', ...grant,
      ...grant.email === undefined ? {} : { accountId: grant.email } }, signal)
    return
  }
  const quotaProjectId = quotaProject((await session.prompt({ kind: 'text',
    message: 'Google Cloud project ID for Gemini API quota and billing. Enable the Generative Language API in this project.', signal })).trim())
  session.notify({ message: 'Checking Gemini API access using the same Google sign-in.' })
  const endpoint = (apiProfile.endpoint ?? 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '')
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(apiProfile.timeoutMs ?? 30_000)])
  const available = await fetch(`${endpoint}/models?pageSize=1`, { redirect: 'error', signal: bounded,
    headers: { Authorization: `Bearer ${grant.access}`, 'x-goog-user-project': quotaProjectId } })
  if (!available.ok) {
    await available.body?.cancel()
    throw new LlmError(`Google sign-in cannot access Gemini API in this project (HTTP ${available.status}). Check the Generative Language API and Service Usage Consumer permission.`, 'AUTH', { status: available.status })
  }
  const catalog = await accountJson(available, bounded)
  if (!Array.isArray(catalog['models'])) throw new LlmError('Gemini API did not return a model catalog.', 'DISCOVERY_FAILED')
  signal.throwIfAborted()
  const label = `${grant.email ?? 'Google account'} · ${quotaProjectId}`
  await pool.add(label, { type: 'oauth', ...grant, quotaProjectId,
    ...grant.email === undefined ? {} : { accountId: `${grant.email}:${quotaProjectId}` } }, signal)
}

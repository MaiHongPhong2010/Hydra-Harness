/**
 * Models settings page store: one snapshot joining the configurable-provider
 * directory (`llm.providers`), the settings namespaces (shared settings mirror),
 * and the referenced credentials (`credentials.describe`). The host stays the
 * single fact source — every mutation writes through the wire and the page
 * re-renders from the next describe, pushed or refetched.
 */

import type {
  ConfigurableProviderView, CredentialView, IApiClient, SettingsNamespaceView,
} from '@hydraharness/harness-api-remotes/client'
import type { SnapshotStore } from '@hydraharness/harness-client-runtime/client'
import { createSnapshotStore } from '@hydraharness/harness-client-runtime/client'
import type { SettingsDescribeFace } from '@hydraharness/harness-client-ui-settings/client'
import {
  OFFICIAL_DEEPSEEK_DECLINED_FIELD, OFFICIAL_DEEPSEEK_PROVIDER,
  OFFICIAL_DEEPSEEK_SETTINGS_NS, WELCOME_NOTICE_SETTINGS_NAMESPACE,
} from '../onboarding-copy.ts'
import type { SettingsSchemaOperations } from './schema-operations.ts'

/**
 * Any route key walks a dict schema to the same profile node, so the lookup
 * names one that cannot collide with a configured route.
 */
const PROBE_ROUTE = '\u0000probe'

/** One provider row the page renders. */
export interface ProviderRow {
  /** The directory entry (route id, display name, settings address, live state). */
  entry: ConfigurableProviderView
  /** Whether any layer configures this provider (its profile resolves). */
  configured: boolean
  /**
   * Whether this row can leave the configured list. Nested user-only profiles
   * restore the composition base; the shipped official DeepSeek route records
   * a durable hide flag instead of unsetting its composition section.
   */
  removable: boolean
  /** The credential reference the resolved profile names, when one does. */
  apiKeyEnv: string | undefined
  /** Credential state for {@link apiKeyEnv}, once described. */
  credential: CredentialView | undefined
  /** Fallback references joined with their write-only credential state. */
  fallbackCredentials: Readonly<Record<string, CredentialView | undefined>>
  /** Connected accounts; absent for API-key routes or failed account reads. */
  accountCount?: number
}

/** Page snapshot. */
export interface ModelsSettingsState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** Whole-load failure text; row-level write failures stay in the editor. */
  error: string | null
  /** Credential enrichment failure; provider/settings rows remain usable. */
  credentialError: string | null
  /** Value-free credential states, including whole-section non-chat providers. */
  credentials: Readonly<Record<string, CredentialView>>
  /** Whether the settings provider accepts writes. */
  writable: boolean
  /** Every configurable provider joined with its configured/credential state. */
  rows: readonly ProviderRow[]
  /** Namespace views by ns, for the editor's schema/layers/secrets. */
  namespaces: ReadonlyMap<string, SettingsNamespaceView>
  /**
   * Durable hide for the shipped official DeepSeek row and first-run prompt.
   * The adapter stays mounted; Add provider can restore the row.
   */
  officialDeepSeekDeclined: boolean
}

/**
 * Human text for a rejected wire call. A transport failure rejects with an
 * Error; a host or a runtime can reject with anything, and the page still has
 * to say something.
 * @param error - the rejection value.
 * @returns the message to show.
 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Derive the conventional credential reference for a provider route: the v1
 * page never asks for an environment-variable name, so a typed key stores
 * under this derived reference and the profile records it as `apiKeyEnv`.
 * @param provider - provider route id (e.g. `anthropic`, `minimax-cn`).
 * @returns the derived reference name (e.g. `MINIMAX_CN_API_KEY`).
 */
export function deriveKeyRef(provider: string): string {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
}

/**
 * Account-backed routes offered by the provider editor.
 * @param namespace - the adapter settings namespace.
 * @param provider - the provider route id.
 * @returns its authorization key, or undefined for API-key routes.
 */
export function providerAccountKey(namespace: string, provider: string): string | undefined {
  return namespace === 'llm-account-auth'
    ? `${namespace}/${provider === 'gemini-api' ? 'antigravity' : provider}` : undefined
}

/**
 * The wire protocols a hand-declared route may name, read out of the owning
 * namespace's own schema. This stays a schema read rather than a wire field so
 * the choices the page offers cannot drift from the ones the adapter accepts:
 * both come from the same `Config`.
 * @param namespace - the namespace view whose schema declares the profile shape.
 * @param schema - settings schema operations.
 * @returns the protocol identifiers, or an empty list when the schema has none.
 */
export function protocolChoices(
  namespace: SettingsNamespaceView | undefined,
  schema: SettingsSchemaOperations,
): string[] {
  if (namespace === undefined) return []
  const node = schema.nodeAtPath(schema.rehydrate(namespace.schema), ['providers', PROBE_ROUTE, 'api'])
  const list = (node as { type?: string; list?: readonly { value?: unknown }[] } | undefined)
  if (list?.type !== 'union' || list.list === undefined) return []
  return list.list.map(entry => entry.value).filter((value): value is string => typeof value === 'string')
}

/**
 * The shipped whole-section DeepSeek directory entry: empty settings path
 * under `llm-deepseek`, route id `deepseek-official`.
 * @param entry - a configurable-provider directory row.
 * @returns whether this is the official DeepSeek Models target.
 */
export function isOfficialDeepSeekEntry(entry: Pick<
  ConfigurableProviderView,
  'provider' | 'settingsNs' | 'settingsPath'
>): boolean {
  return entry.provider === OFFICIAL_DEEPSEEK_PROVIDER
    && entry.settingsNs === OFFICIAL_DEEPSEEK_SETTINGS_NS
    && entry.settingsPath.length === 0
}

/** The durable hide flag stored in the product-onboarding settings section. */
function officialDeepSeekDeclinedOf(
  namespaces: ReadonlyMap<string, SettingsNamespaceView>,
  schema: SettingsSchemaOperations,
): boolean {
  const view = namespaces.get(WELCOME_NOTICE_SETTINGS_NAMESPACE)
  if (view === undefined) return false
  return schema.getPath(view.value, [OFFICIAL_DEEPSEEK_DECLINED_FIELD]) === true
}

/** The credential reference a resolved profile names (its `apiKeyEnv` field). */
function apiKeyEnvOf(
  namespace: SettingsNamespaceView | undefined,
  path: readonly string[],
  schema: SettingsSchemaOperations,
): string | undefined {
  if (namespace === undefined) return undefined
  const profile = schema.getPath(namespace.value, path)
  if (typeof profile !== 'object' || profile === null) return undefined
  const ref = (profile as { apiKeyEnv?: unknown }).apiKeyEnv
  return typeof ref === 'string' && ref.length > 0 ? ref : undefined
}

/**
 * Read ordered fallback references from a described profile.
 * @param profile - effective settings subtree.
 * @returns distinct named fallback credentials.
 */
export function fallbackKeyRefs(profile: unknown): string[] {
  if (typeof profile !== 'object' || profile === null) return []
  const refs = (profile as { apiKeyFallbackEnvs?: unknown }).apiKeyFallbackEnvs
  return Array.isArray(refs) ? [...new Set(refs.filter((ref): ref is string => typeof ref === 'string' && ref.length > 0))] : []
}

/** The models settings page controller (one per settings surface). */
export class ModelsSettingsStore {
  /** The snapshot the section renders from (uSES-safe store). */
  readonly store: SnapshotStore<ModelsSettingsState> = createSnapshotStore<ModelsSettingsState>({
    status: 'idle',
    error: null,
    credentialError: null,
    credentials: {},
    writable: false,
    rows: [],
    namespaces: new Map(),
    officialDeepSeekDeclined: false,
  })

  /** Latest load wins; an older response never overwrites a newer one. */
  private generation = 0

  /**
   * @param api - the wire face (credentials/llm domains, and settings writes).
   * @param describeFace - the shared mirror's describe face (namespace views and writability).
   */
  constructor(
    private readonly api: Pick<IApiClient, 'settings' | 'credentials' | 'llm' | 'authorization'>,
    private readonly schema: SettingsSchemaOperations,
    private readonly describeFace: SettingsDescribeFace,
  ) {}

  /**
   * Refresh the whole page snapshot: the provider directory and the mirror's
   * settings answer in parallel, then one batched credential describe over
   * every referenced ref. Provider failure or absence of an initial settings
   * answer keeps the last good rows and surfaces an error; a failed settings
   * refresh reuses the mirror's held view.
   * @returns nothing; the snapshot carries the outcome.
   */
  async load(): Promise<void> {
    const generation = ++this.generation
    this.store.update((s) => { s.status = 'loading'; s.error = null })
    let providers: ConfigurableProviderView[]
    let writable: boolean
    let views: readonly SettingsNamespaceView[]
    try {
      const [providersResponse] = await Promise.all([
        this.api.llm.providers({}),
        this.describeFace.ensure(),
      ])
      if (!providersResponse.result.ok) throw new Error(providersResponse.result.error.message)
      const mirrored = this.describeFace.getSnapshot()
      if (mirrored.view === undefined) {
        throw new Error(mirrored.error ?? 'settings are unavailable in this browser')
      }
      providers = providersResponse.result.value.providers
      writable = mirrored.view.writable
      views = mirrored.view.namespaces
    } catch (error) {
      if (generation !== this.generation) return
      this.store.update((s) => {
        s.status = 'error'
        s.error = error instanceof Error ? error.message : String(error)
      })
      return
    }
    const namespaces = new Map(views.map(view => [view.ns, view]))
    const officialDeepSeekDeclined = officialDeepSeekDeclinedOf(namespaces, this.schema)
    const rows = providers.map((entry) => {
      const namespace = namespaces.get(entry.settingsNs)
      const pathConfigured = namespace !== undefined
        && (entry.settingsPath.length === 0 || this.schema.getPath(namespace.value, entry.settingsPath) !== undefined)
      const official = isOfficialDeepSeekEntry(entry)
      const configured = pathConfigured && !(official && officialDeepSeekDeclined)
      const removable = official
        ? configured
        : namespace !== undefined
          && entry.settingsPath.length > 0
          && this.schema.hasPath(namespace.user, entry.settingsPath)
          && !this.schema.hasPath(namespace.base, entry.settingsPath)
      return {
        entry,
        configured,
        removable,
        apiKeyEnv: apiKeyEnvOf(namespace, entry.settingsPath, this.schema),
        credential: undefined,
        fallbackCredentials: Object.fromEntries(
          fallbackKeyRefs(this.schema.getPath(namespace?.value, entry.settingsPath)).map(ref => [ref, undefined])),
      }
    })
    const refs = [...new Set([
      ...rows.flatMap(row => [
        ...row.apiKeyEnv === undefined ? [] : [row.apiKeyEnv], ...Object.keys(row.fallbackCredentials),
      ]),
      ...views.flatMap((view) => {
        const ref = apiKeyEnvOf(view, [], this.schema)
        return ref === undefined ? [] : [ref]
      }),
    ])]
    let credentials: Record<string, CredentialView> = {}
    let credentialError: string | null = null
    if (refs.length > 0) {
      try {
        const response = await this.api.credentials.describe({ refs })
        // Credential state is an enrichment for the Models page: neither a
        // business rejection nor a transport failure fails the load. The
        // onboarding projection below retains the failure distinction.
        if (response.result.ok) credentials = response.result.value.credentials
        else credentialError = response.result.error.message
      } catch (error) {
        credentialError = messageOf(error)
      }
    }
    const accounts = new Map<string, number>()
    let accountsLoaded = false
    if (rows.some(row => providerAccountKey(row.entry.settingsNs, row.entry.provider) !== undefined)) {
      try {
        const response = await this.api.authorization.list({})
        if (!response.result.ok) throw new Error(response.result.error.message)
        for (const entry of response.result.value.entries) accounts.set(entry.key, entry.accounts.length)
        accountsLoaded = true
      } catch (error) {
        credentialError = messageOf(error)
      }
    }
    if (generation !== this.generation) return
    this.store.update((s) => {
      s.status = 'ready'
      s.error = null
      s.credentialError = credentialError
      s.credentials = credentials
      s.writable = writable
      s.rows = rows.map((row) => {
        const accountKey = providerAccountKey(row.entry.settingsNs, row.entry.provider)
        return {
          ...row,
          ...accountKey === undefined || !accountsLoaded ? {} : { accountCount: accounts.get(accountKey) ?? 0 },
          fallbackCredentials: Object.fromEntries(Object.keys(row.fallbackCredentials).map(ref => [ref, credentials[ref]])),
          ...row.apiKeyEnv !== undefined && credentials[row.apiKeyEnv] !== undefined
            ? { credential: credentials[row.apiKeyEnv] }
            : {},
        }
      })
      s.namespaces = namespaces
      s.officialDeepSeekDeclined = officialDeepSeekDeclined
    })
  }
}

/**
 * Whether a joined row can serve model requests as it stands: the route is
 * registered with the adapter registry, and whatever credential its resolved
 * profile names is stored. A profile naming no reference authenticates through
 * the provider's own path (the Bedrock chain, Vertex ADC, a gateway that needs
 * nothing), as does a live route with no settings address at all, so neither
 * owes this page a key.
 * @param row - one joined provider row.
 * @returns whether the user already has this provider to talk to.
 */
export function providerUsable(row: ProviderRow): boolean {
  if (!row.entry.active) return false
  if (row.accountCount !== undefined) return row.accountCount > 0
  if (providerAccountKey(row.entry.settingsNs, row.entry.provider) !== undefined) return false
  if (row.apiKeyEnv === undefined && Object.keys(row.fallbackCredentials).length === 0) return true
  return row.credential?.configured === true || Object.values(row.fallbackCredentials).some(state => state?.configured === true)
}

/** First-run navigation readiness derived from the shared Models join. */
export type OnboardingReadiness =
  | { kind: 'loading' }
  | { kind: 'provider-ready' }
  | { kind: 'setup-needed' }
  | { kind: 'unavailable' }

/**
 * Offer provider configuration when no route is usable and Models can edit
 * a declared provider. Failed credential reads or failed or read-only
 * settings leave navigation to the user; no provider is selected implicitly.
 * @param state - current shared Models join snapshot.
 * @returns whether setup can help, without writing settings or credentials.
 */
export function onboardingReadiness(state: ModelsSettingsState): OnboardingReadiness {
  if (state.status === 'idle' || state.status === 'loading') return { kind: 'loading' }
  if (state.status === 'error') return { kind: 'unavailable' }
  if (state.rows.some(providerUsable)) return { kind: 'provider-ready' }
  if (!state.writable || state.credentialError !== null) return { kind: 'unavailable' }
  const configurable = state.rows.some(row => state.namespaces.has(row.entry.settingsNs))
  return { kind: configurable ? 'setup-needed' : 'unavailable' }
}

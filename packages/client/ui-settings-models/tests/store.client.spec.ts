/** Page-store join: directory × namespaces × credentials, with last-good rows on failure. */
import { describe, expect, it } from 'vitest'
import type { RpcResponse, SettingsNamespaceView } from '@hydraharness/harness-api-remotes/client'
import type { IApiClient } from '@hydraharness/harness-api-remotes/client'
import { SettingsDescribeMirror } from '@hydraharness/harness-client-ui-settings/src/client/settings-mirror.ts'
import { settingsSchema } from './settings-schema.client.ts'
import { isOfficialDeepSeekEntry, messageOf, ModelsSettingsStore } from '../src/client/store.ts'

let nextRpc = 0
function ok<T>(value: T): RpcResponse<T> {
  return { rpcId: `r-${nextRpc++}` as never, result: { ok: true, value } }
}
function fail<T>(message: string): RpcResponse<T> {
  return { rpcId: `r-${nextRpc++}` as never, result: { ok: false, error: { code: 'internal', message, details: {} } } }
}

const DIRECTORY = [
  { provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [], active: true },
  { provider: 'openai', displayName: 'openai', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai'], active: true },
  { provider: 'anthropic', displayName: 'anthropic', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'anthropic'], active: false },
  { provider: 'ghost', displayName: 'Ghost', settingsNs: '', settingsPath: [], active: true },
]

const NAMESPACES: SettingsNamespaceView[] = [
  {
    ns: 'llm-deepseek',
    schema: {},
    value: { apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://base' },
    base: { baseURL: 'https://base' },
    applies: 'live' as const,
    secrets: [],
    revision: 0,
  },
  {
    ns: 'llm-pi-ai',
    schema: {},
    value: { providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY' } } },
    user: { providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY' } } },
    applies: 'live' as const,
    secrets: [],
    revision: 0,
  },
]

function api(overrides: {
  providers?: () => Promise<RpcResponse<{ providers: typeof DIRECTORY }>>
  describeSettings?: () => Promise<RpcResponse<{
    writable: boolean
    hasDocument: boolean
    namespaces: SettingsNamespaceView[]
  }>>
  describeCredentials?: (refs: string[]) => Promise<RpcResponse<{ credentials: Record<string, unknown> }>>
  accounts?: IApiClient['authorization']['list']
} = {}) {
  const seenRefs: string[][] = []
  const face = {
    llm: {
      providers: overrides.providers ?? (() => Promise.resolve(ok({ providers: DIRECTORY }))),
      models: () => Promise.resolve(ok({ groups: [], failures: [] })),
    },
    settings: {
      describe: overrides.describeSettings ?? (() => Promise.resolve(ok({ writable: true, hasDocument: false, namespaces: NAMESPACES }))),
      update: () => Promise.resolve(fail('unused')),
      replace: () => Promise.resolve(fail('unused')),
    },
    authorization: { list: overrides.accounts ?? (() => Promise.resolve(ok({ entries: [] }))) },
    credentials: {
      describe: (payload: { refs: string[] }) => {
        seenRefs.push(payload.refs)
        return (overrides.describeCredentials ?? (refs => Promise.resolve(ok({
          credentials: Object.fromEntries(refs.map(ref => [ref, { configured: ref === 'OPENAI_API_KEY', writable: true }])),
        }))))(payload.refs)
      },
      set: () => Promise.resolve(ok({})),
      unset: () => Promise.resolve(ok({})),
    },
  }
  const wire = face as never
  return { face: wire, mirror: new SettingsDescribeMirror(wire), seenRefs }
}

describe('ModelsSettingsStore', () => {
  it.each(['accounts', 'missing', 'denied', 'transport'])('enriches account routes with %s authorization state', async (outcome) => {
    const { face, mirror } = api({
      providers: async () => ok({ providers: [{ provider: 'chatgpt', displayName: 'ChatGPT',
        settingsNs: 'llm-account-auth', settingsPath: ['providers', 'chatgpt'], active: true }] }),
      accounts: async () => {
        if (outcome === 'denied') return fail('authorization unavailable')
        if (outcome === 'transport') throw new Error('connection closed')
        return ok({ entries: outcome === 'missing' ? [] : [{ key: 'llm-account-auth/chatgpt', label: 'ChatGPT', methods: [],
          inFlight: false, accounts: [{ id: 'one', label: 'One' }, { id: 'two', label: 'Two' }] }] })
      },
    })
    const store = new ModelsSettingsStore(face, settingsSchema, mirror)
    await store.load()
    expect(store.store.getSnapshot()).toMatchObject({
      status: 'ready',
      credentialError: outcome === 'denied' ? 'authorization unavailable' : outcome === 'transport' ? 'connection closed' : null,
    })
    expect(store.store.getSnapshot().rows[0]?.accountCount).toBe(
      outcome === 'accounts' ? 2 : outcome === 'missing' ? 0 : undefined)
  })

  it('describes non-chat provider credentials without adding LLM directory rows', async () => {
    let configured = false
    const { face, mirror, seenRefs } = api({
      describeSettings: () => Promise.resolve(ok({ writable: true, hasDocument: true, namespaces: [
        ...NAMESPACES,
        { ns: 'jev', schema: {}, value: { apiKeyEnv: 'CUSTOM_JEV_KEY' }, applies: 'live', secrets: [], revision: 0 },
      ] })),
      describeCredentials: refs => Promise.resolve(ok({
        credentials: Object.fromEntries(refs.map(ref => [ref, { configured, writable: true }])),
      })),
    })
    const store = new ModelsSettingsStore(face, settingsSchema, mirror)
    await store.load()
    expect(seenRefs[0]).toContain('CUSTOM_JEV_KEY')
    expect(store.store.getSnapshot().credentials['CUSTOM_JEV_KEY']?.configured).toBe(false)
    configured = true
    await store.load()
    expect(store.store.getSnapshot().credentials['CUSTOM_JEV_KEY']?.configured).toBe(true)
    expect(store.store.getSnapshot().rows.map(row => row.entry.provider)).toEqual(DIRECTORY.map(row => row.provider))
  })

  it('joins rows with configured, removable, and credential state', async () => {
    const { face, mirror, seenRefs } = api()
    const store = new ModelsSettingsStore(face, settingsSchema, mirror)
    await store.load()
    const state = store.store.getSnapshot()
    expect(state.status).toBe('ready')
    expect(state.writable).toBe(true)
    expect(state.credentialError).toBeNull()
    expect(seenRefs).toEqual([['DEEPSEEK_API_KEY', 'OPENAI_API_KEY']])
    const byProvider = new Map(state.rows.map(row => [row.entry.provider, row]))
    expect(byProvider.get('deepseek-official')).toMatchObject({
      configured: true,
      removable: true,
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      credential: { configured: false, writable: true },
    })
    expect(byProvider.get('openai')).toMatchObject({
      configured: true,
      removable: true,
      apiKeyEnv: 'OPENAI_API_KEY',
      credential: { configured: true },
    })
    expect(byProvider.get('anthropic')).toMatchObject({ configured: false, removable: false })
    expect(byProvider.get('anthropic')?.apiKeyEnv).toBeUndefined()
    expect(byProvider.get('ghost')).toMatchObject({ configured: false, removable: false })
    expect(state.namespaces.get('llm-pi-ai')?.ns).toBe('llm-pi-ai')
    expect(state.officialDeepSeekDeclined).toBe(false)
  })

  it('hides official DeepSeek from the configured list when the durable hide flag is set', async () => {
    const { face, mirror } = api({
      describeSettings: () => Promise.resolve(ok({
        writable: true,
        hasDocument: false,
        namespaces: [
          ...NAMESPACES,
          {
            ns: 'ui-onboarding',
            schema: {},
            value: { deepseekOfficialDeclined: true },
            user: { deepseekOfficialDeclined: true },
            applies: 'live' as const,
            secrets: [],
            revision: 0,
          },
        ],
      })),
    })
    const store = new ModelsSettingsStore(face, settingsSchema, mirror)
    await store.load()
    const state = store.store.getSnapshot()
    expect(state.officialDeepSeekDeclined).toBe(true)
    const byProvider = new Map(state.rows.map(row => [row.entry.provider, row]))
    expect(byProvider.get('deepseek-official')).toMatchObject({
      configured: false,
      removable: false,
    })
    expect(byProvider.get('openai')).toMatchObject({ configured: true, removable: true })
  })

  it('degrades the credential badge, not the page, when the credential domain fails', async () => {
    const { face, mirror } = api({ describeCredentials: () => Promise.resolve(fail('no provider')) })
    const store = new ModelsSettingsStore(face, settingsSchema, mirror)
    await store.load()
    const state = store.store.getSnapshot()
    expect(state.status).toBe('ready')
    expect(state.credentialError).toBe('no provider')
    expect(state.rows.every(row => row.credential === undefined)).toBe(true)
  })

  it('settles a credential transport rejection without leaving the store loading', async () => {
    const { face, mirror } = api({
      describeCredentials: () => Promise.reject(new Error('credential transport down')),
    })
    const store = new ModelsSettingsStore(face, settingsSchema, mirror)
    await expect(store.load()).resolves.toBeUndefined()
    expect(store.store.getSnapshot()).toMatchObject({
      status: 'ready',
      credentialError: 'credential transport down',
    })
  })

  it('stringifies a non-Error credential transport rejection', async () => {
    const { face, mirror } = api({
      describeCredentials: async () => { throw 'credential transport refusal' },
    })
    const store = new ModelsSettingsStore(face, settingsSchema, mirror)
    await expect(store.load()).resolves.toBeUndefined()
    expect(store.store.getSnapshot().credentialError).toBe('credential transport refusal')
  })

  it('surfaces a directory failure and keeps the last good rows', async () => {
    const { face, mirror } = api()
    const store = new ModelsSettingsStore(face, settingsSchema, mirror)
    await store.load()
    expect(store.store.getSnapshot().rows).toHaveLength(4)
    const broken = api({ providers: () => Promise.resolve(fail('directory down')) })
    const failing = new ModelsSettingsStore(broken.face, settingsSchema, broken.mirror)
    await failing.load()
    expect(failing.store.getSnapshot()).toMatchObject({ status: 'error', error: 'directory down' })
    // The first store's snapshot is untouched by the second's failure.
    expect(store.store.getSnapshot().status).toBe('ready')
  })

  it('lets the newest load win over a stale slow response', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    let call = 0
    const { face, mirror } = api({
      providers: async () => {
        call += 1
        if (call === 1) {
          await gate
          return fail('stale slow failure')
        }
        return ok({ providers: DIRECTORY })
      },
    })
    const store = new ModelsSettingsStore(face, settingsSchema, mirror)
    const first = store.load()
    const second = store.load()
    release?.()
    await Promise.all([first, second])
    expect(store.store.getSnapshot().status).toBe('ready')
  })
})

describe('edge joins', () => {
  it('treats a non-object profile as having no credential reference', async () => {
    const { face, mirror } = api({
      describeSettings: () => Promise.resolve(ok({
        writable: true,
        hasDocument: false,
        namespaces: [{
          ns: 'llm-pi-ai',
          schema: {},
          value: { providers: { weird: 'oops' } },
          applies: 'live' as const,
          secrets: [],
          revision: 0,
        }] as never,
      })),
      providers: () => Promise.resolve(ok({
        providers: [
          { provider: 'weird', displayName: 'weird', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'weird'], active: false },
        ] as never,
      })),
    })
    const store = new ModelsSettingsStore(face, settingsSchema, mirror)
    await store.load()
    const state = store.store.getSnapshot()
    expect(state.rows[0]).toMatchObject({ configured: true, removable: false })
    expect(state.rows[0]?.apiKeyEnv).toBeUndefined()
  })

  it('skips the credential describe entirely when no row names a reference', async () => {
    const { face, mirror, seenRefs } = api({
      describeSettings: () => Promise.resolve(ok({
        writable: true,
        hasDocument: false,
        namespaces: [{ ns: 'llm-pi-ai', schema: {}, value: { providers: {} }, applies: 'live' as const, secrets: [], revision: 0 }] as never,
      })),
      providers: () => Promise.resolve(ok({
        providers: [
          { provider: 'anthropic', displayName: 'anthropic', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'anthropic'], active: false },
        ] as never,
      })),
    })
    const store = new ModelsSettingsStore(face, settingsSchema, mirror)
    await store.load()
    expect(seenRefs).toEqual([])
    expect(store.store.getSnapshot().status).toBe('ready')
  })

  it('surfaces a settings describe failure', async () => {
    const { face, mirror } = api({ describeSettings: () => Promise.resolve(fail('settings down')) })
    const store = new ModelsSettingsStore(face, settingsSchema, mirror)
    await store.load()
    expect(store.store.getSnapshot()).toMatchObject({ status: 'error', error: 'settings down' })
  })

  it('reports a terminally unavailable settings mirror precisely', async () => {
    const { face } = api()
    const store = new ModelsSettingsStore(
      face,
      settingsSchema,
      new SettingsDescribeMirror(face, 'memory'),
    )
    await store.load()
    expect(store.store.getSnapshot()).toMatchObject({
      status: 'error',
      error: 'settings are unavailable in this browser',
    })
  })

  it('reuses a held settings view after its refresh fails', async () => {
    let settingsCall = 0
    const { face, mirror } = api({
      describeSettings: () => {
        settingsCall += 1
        return Promise.resolve(settingsCall === 1
          ? ok({ writable: true, hasDocument: false, namespaces: NAMESPACES })
          : fail('settings refresh down'))
      },
    })
    const store = new ModelsSettingsStore(face, settingsSchema, mirror)
    await store.load()
    await mirror.load()
    expect(mirror.getSnapshot().error).toBe('settings refresh down')
    await store.load()
    expect(store.store.getSnapshot()).toMatchObject({ status: 'ready', error: null })
    expect(store.store.getSnapshot().rows).toHaveLength(4)
  })

  it('stringifies a non-Error load failure', async () => {
    // The wire can surface non-Error throwables; the store must stringify them.
    const { face, mirror } = api({ providers: async () => { throw 'plain refusal' } })
    const store = new ModelsSettingsStore(face, settingsSchema, mirror)
    await store.load()
    expect(store.store.getSnapshot()).toMatchObject({ status: 'error', error: 'plain refusal' })
  })

  it('drops a stale successful response after a newer load finished', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    let call = 0
    const { face, mirror } = api({
      providers: async () => {
        call += 1
        if (call === 1) {
          await gate
          return ok({ providers: [] as never })
        }
        return ok({ providers: DIRECTORY })
      },
    })
    const store = new ModelsSettingsStore(face, settingsSchema, mirror)
    const first = store.load()
    const second = store.load()
    await second
    release?.()
    await first
    // The stale empty directory never overwrote the newer join.
    expect(store.store.getSnapshot().rows).toHaveLength(4)
  })
})

describe('messageOf', () => {
  it('reads an Error message, and stringifies anything else a rejection may carry', () => {
    // The wire layer rejects with an Error, but a host or a runtime can reject
    // with any value, and the page still has to render something.
    expect(messageOf(new Error('connection lost'))).toBe('connection lost')
    expect(messageOf('the host refused')).toBe('the host refused')
    expect(messageOf(undefined)).toBe('undefined')
  })
})

describe('isOfficialDeepSeekEntry', () => {
  const official = {
    provider: 'deepseek-official',
    settingsNs: 'llm-deepseek',
    settingsPath: [] as string[],
  }

  it('matches only the shipped whole-section DeepSeek route', () => {
    expect(isOfficialDeepSeekEntry(official)).toBe(true)
    expect(isOfficialDeepSeekEntry({ ...official, provider: 'deepseek' })).toBe(false)
    expect(isOfficialDeepSeekEntry({ ...official, settingsNs: 'llm-pi-ai' })).toBe(false)
    expect(isOfficialDeepSeekEntry({ ...official, settingsPath: ['models'] })).toBe(false)
  })
})

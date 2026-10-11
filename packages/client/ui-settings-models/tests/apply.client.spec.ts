/** Models section registration: slot declaration injection, the locale-following label thunk, and HMR recovery. */
import { Context } from '@hydraharness/cordis'
import { describe, expect, it, vi } from 'vitest'
import { resolveSlotLabel } from '@hydraharness/harness-client-ui-slots'
import { SlotRegistry } from '@hydraharness/harness-client-runtime/client'
import { LocaleRuntime } from '@hydraharness/harness-client-locale/client'
import { TestRemote } from '@hydraharness/harness-client-test-runtime'
import { apply as settingsApply, inject as settingsInject } from '@hydraharness/harness-client-ui-settings/client'
import { apply, inject, refreshIfLoaded } from '@hydraharness/harness-client-ui-settings-models/client'
import {
  WELCOME_NOTICE_ACK_FIELD, WELCOME_NOTICE_SETTINGS_NAMESPACE, WELCOME_NOTICE_VERSION,
} from '../src/onboarding-copy.ts'
import { ModelsSection } from '../src/client/ModelsSection.tsx'
import { AccountsSection } from '../src/client/AccountsSection.tsx'
import { ProviderOnboarding } from '../src/client/ProviderOnboarding.tsx'
import { WelcomeNotice } from '../src/client/WelcomeNotice.tsx'

// The package ships an English-only dictionary, and 'en' is the only
// registered locale; the lane has no jsdom `window`, so browser-language
// detection never runs and a fresh LocaleRuntime opens on FALLBACK_LOCALE
// (en) with no explicit staging needed.

async function bench(isLoopback = true, settings?: object, services: object = {}) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  // The plugins inject `remote`; forwarded events reach them through the
  // same `$dispatch` handoff the connection sink makes.
  new TestRemote(ctx)
  // Without a settings face the mirror's reads fail and stay contained; the
  // Models join itself never fetches until a section actually loads. The real
  // ui-settings apply also provides the settingsSchema service.
  ctx.provide('connection', {
    api: settings === undefined ? services : { ...services, settings },
    isLoopback,
  } as never)
  await ctx.plugin({ inject: [...settingsInject], apply: settingsApply }).await()
  return { ctx, slots: ctx.get('slots') as SlotRegistry, locale }
}

function declare(slots: SlotRegistry): () => void {
  return slots.register(
    {
      name: 'root',
      children: {
        'settings.section': { kind: 'list', scope: 'root' },
        'settings.onboarding': { kind: 'list', scope: 'root' },
      },
    } as never,
    () => null,
  )
}

describe('ui-settings-models apply', () => {
  it('declares the services it uses', () => {
    expect(inject).toEqual(['slots', 'locale', 'connection', 'remote', 'settingsScope', 'settingsSchema'])
  })

  it('registers the models nav entry for declarations before or after apply', async () => {
    const before = await bench()
    declare(before.slots)
    await before.ctx.plugin({ inject: [...inject], apply }).await()
    const entry = before.slots.entries('settings.section')[0]!
    expect(entry.component).toBe(ModelsSection)
    expect(entry.options).toMatchObject({ id: 'models', order: 10 })
    // The nav label is a locale-following thunk; owners resolve at read time.
    expect(resolveSlotLabel(entry.options.label)).toBe('Models')
    const injected = (entry.inject as unknown as () => import('../src/client/ModelsSection.tsx').ModelsSectionInjected)()
    expect(injected.t('nav')).toBe('Models')
    expect(injected.t('deleteTitle')).toBe('Delete {provider}?')
    expect(typeof injected.controller.load).toBe('function')
    expect(injected.hooks.snapshot).toBe(injected.controller.store)
    const account = before.slots.entries('settings.section')[1]!
    expect(account.component).toBe(AccountsSection)
    expect(account.options).toMatchObject({ id: 'accounts', order: 11 })
    expect(resolveSlotLabel(account.options.label)).toBe('Accounts')
    const accountsInjected = (account.inject as unknown as () => import('../src/client/AccountsSection.tsx').AccountsSectionInjected)()
    expect(accountsInjected.controller).toBe(injected.controller)
    expect(accountsInjected.hooks.snapshot).toBe(injected.controller.store)
    expect(injected.api).toBeDefined()
    expect(injected.hooks.decisions.getSnapshot()).toBe(0)
    const changed = vi.fn()
    const unsubscribe = injected.hooks.decisions.subscribe(changed)
    const removeOption = before.slots.register({ name: 'settings.models.decision', id: 'optional-provider' }, () => null)
    expect(injected.hooks.decisions.getSnapshot()).toBe(1)
    await vi.waitFor(() => { expect(changed).toHaveBeenCalled() })
    unsubscribe()
    changed.mockClear()
    removeOption()
    expect(injected.hooks.decisions.getSnapshot()).toBe(0)
    await Promise.resolve()
    expect(changed).not.toHaveBeenCalled()
    const onboarding = before.slots.entries('settings.onboarding')
    expect(onboarding).toHaveLength(2)
    expect(onboarding.find(entry => entry.options.id === 'welcome-notice')).toMatchObject({
      component: WelcomeNotice,
      options: { id: 'welcome-notice', order: -100 },
    })
    const providerSetup = onboarding.find(entry => entry.options.id === 'provider-setup')!
    expect(providerSetup.component).toBe(ProviderOnboarding)
    expect(providerSetup.options).toMatchObject({ id: 'provider-setup', order: 0 })
    const providerInjected = (
      providerSetup.inject as unknown as () => import('../src/client/ProviderOnboarding.tsx').ProviderOnboardingInjected
    )()
    expect(providerInjected.hooks.models).toBe(injected.controller.store)

    const after = await bench()
    await after.ctx.plugin({ inject: [...inject], apply }).await()
    expect(after.slots.entries('settings.section')).toHaveLength(0)
    expect(after.slots.entries('settings.onboarding')).toHaveLength(0)
    declare(after.slots)
    await Promise.resolve()
    expect(after.slots.entries('settings.section')[0]!.component).toBe(ModelsSection)
    expect(after.slots.entries('settings.onboarding')).toHaveLength(2)
    // The self-inflicted ledger notifications hit the duplicate guard.
    expect(after.slots.entries('settings.section')).toHaveLength(2)
  })

  it('the label thunk follows the active locale without re-registration', async () => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    await b.locale.setLocale('en')
    expect(resolveSlotLabel(b.slots.entries('settings.section')[0]!.options.label)).toBe('Models')
    const injected = b.slots.entries('settings.section')[0]!.inject as unknown as () => import('../src/client/ModelsSection.tsx').ModelsSectionInjected
    expect(injected().t('deleteTitle')).toBe('Delete {provider}?')
    // Only one locale is shipped; re-selecting it still republishes through
    // the same durable-write path (see LocaleRuntime.setLocale), so the thunk
    // is re-read rather than assumed stale.
    await b.locale.setLocale('en')
    expect(resolveSlotLabel(b.slots.entries('settings.section')[0]!.options.label)).toBe('Models')
    expect(injected().t('deleteTitle')).toBe('Delete {provider}?')
  })

  it('locale change while the slot is undeclared stays a no-op', async () => {
    const b = await bench()
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    await b.locale.setLocale('en')
    expect(b.slots.entries('settings.section')).toHaveLength(0)
    await b.locale.setLocale('en')
  })

  it('re-registers after an HMR collapse re-declares the slot (stale disposer must not block)', async () => {
    const b = await bench()
    const redeclare = declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    expect(b.slots.entries('settings.section')).toHaveLength(2)
    // Declarer unload: the cascade removes our entry while our local
    // disposer variable goes stale.
    redeclare()
    expect(b.slots.entries('settings.section')).toHaveLength(0)
    expect(b.slots.entries('settings.onboarding')).toHaveLength(0)
    declare(b.slots)
    await Promise.resolve()
    expect(b.slots.entries('settings.section')[0]!.component).toBe(ModelsSection)
    expect(b.slots.entries('settings.onboarding')).toHaveLength(2)
    // The locale path also recovers through the same ledger re-check.
    await b.locale.setLocale('en')
    expect(resolveSlotLabel(b.slots.entries('settings.section')[0]!.options.label)).toBe('Models')
    await b.locale.setLocale('en')
  })

  it('registers the en nav dictionary and disposes everything with the fiber', async () => {
    const b = await bench()
    declare(b.slots)
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(b.locale.bind('settings.models')('nav')).toBe('Models')
    await fiber.dispose()
    expect(b.slots.entries('settings.section')).toHaveLength(0)
    expect(b.slots.entries('settings.onboarding')).toHaveLength(0)
    // The (ns, locale) seats are free again — the dictionary disposers ran.
    expect(() => b.locale.register('settings.models', 'en', {})).not.toThrow()
  })

  it('keeps remote-browser acknowledgement in process memory', async () => {
    const b = await bench(false)
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const entry = b.slots.entries('settings.onboarding')
      .find(candidate => candidate.options.id === 'welcome-notice')!
    const injected = (
      entry.inject as unknown as () => import('../src/client/WelcomeNotice.tsx').WelcomeNoticeInjected
    )()

    await injected.controller.load()
    expect(injected.controller.store.getSnapshot()).toEqual({
      status: 'ready', acknowledged: false, error: null,
    })
  })
})

describe('pushed invalidations', () => {
  it('ignores invalidations before the page ever loaded', async () => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    // The fake wire face has no methods: a fetch attempt would throw.
    b.ctx.remote.$dispatch('settings/document-updated', ['llm-pi-ai', 1])
    b.ctx.remote.$dispatch('credentials/reference-updated', ['OPENAI_API_KEY'])
    b.ctx.remote.$dispatch('llm/adapters-updated', [])
    b.ctx.emit('connection/reset')
  })

  it('refreshes a loaded page and skips an idle one', () => {
    const loads: number[] = []
    const controller = {
      store: { getSnapshot: () => ({ status: 'ready' }) },
      load: () => { loads.push(1); return Promise.resolve() },
    }
    refreshIfLoaded(controller as unknown as import('../src/client/store.ts').ModelsSettingsStore)
    expect(loads).toHaveLength(1)
    const idle = {
      store: { getSnapshot: () => ({ status: 'idle' }) },
      load: () => { loads.push(2); return Promise.resolve() },
    }
    refreshIfLoaded(idle as unknown as import('../src/client/store.ts').ModelsSettingsStore)
    expect(loads).toHaveLength(1)
  })

  it('routes pushed credential invalidation into the shared onboarding join', async () => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const entry = b.slots.entries('settings.onboarding')
      .find(candidate => candidate.options.id === 'provider-setup')!
    const injected = (
      entry.inject as unknown as
      () => import('../src/client/ProviderOnboarding.tsx').ProviderOnboardingInjected
    )()
    injected.controller.store.update((state) => { state.status = 'ready' })
    const load = vi.spyOn(injected.controller, 'load').mockResolvedValue()
    b.ctx.remote.$dispatch('credentials/reference-updated', ['DEEPSEEK_API_KEY'])
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('welcome state follows the shared mirror across document commits', async () => {
    // The welcome notice derives from its settings scope: a document commit
    // reaches it through the mirror's one refresh, with no routing here.
    const acknowledgement = { current: undefined as string | undefined }
    const settings = {
      describe: vi.fn(() => Promise.resolve({
        rpcId: 'apply-welcome' as never,
        result: {
          ok: true as const,
          value: {
            writable: true,
            hasDocument: false,
            namespaces: [{
              ns: WELCOME_NOTICE_SETTINGS_NAMESPACE,
              schema: {},
              value: acknowledgement.current === undefined ? {} : { [WELCOME_NOTICE_ACK_FIELD]: acknowledgement.current },
              applies: 'live' as const,
              secrets: [],
              revision: 0,
            }],
          },
        },
      })),
    }
    const b = await bench(true, settings)
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const entry = b.slots.entries('settings.onboarding')
      .find(candidate => candidate.options.id === 'welcome-notice')!
    const injected = (
      entry.inject as unknown as
      () => import('../src/client/WelcomeNotice.tsx').WelcomeNoticeInjected
    )()
    await injected.controller.load()
    await vi.waitFor(() => {
      expect(injected.hooks.welcome.getSnapshot()).toMatchObject({ status: 'ready', acknowledged: false })
    })
    acknowledgement.current = WELCOME_NOTICE_VERSION
    b.ctx.remote.$dispatch('settings/document-updated', ['ui-onboarding', 1])
    await vi.waitFor(() => {
      expect(injected.hooks.welcome.getSnapshot()).toMatchObject({ status: 'ready', acknowledged: true })
    })
  })

  it('joins the refreshed mirror view on a settings invalidation', async () => {
    let revision = 1
    const describe = vi.fn(() => Promise.resolve({
      rpcId: `apply-models-${revision}` as never,
      result: {
        ok: true as const,
        value: {
          writable: true,
          hasDocument: false,
          namespaces: [{
            ns: 'llm-test',
            schema: {},
            value: {},
            applies: 'live' as const,
            secrets: [],
            revision,
          }],
        },
      },
    }))
    const providers = vi.fn(() => Promise.resolve({
      rpcId: 'apply-models-providers' as never,
      result: { ok: true as const, value: { providers: [] } },
    }))
    const b = await bench(true, { describe }, { llm: { providers } })
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const entry = b.slots.entries('settings.section')
      .find(candidate => candidate.options.id === 'models')!
    const injected = (
      entry.inject as unknown as
      () => import('../src/client/ModelsSection.tsx').ModelsSectionInjected
    )()
    await injected.controller.load()
    expect(injected.hooks.snapshot.getSnapshot().namespaces.get('llm-test')?.revision).toBe(1)

    revision = 2
    b.ctx.remote.$dispatch('settings/document-updated', ['llm-test', revision])

    await vi.waitFor(() => {
      expect(injected.hooks.snapshot.getSnapshot().namespaces.get('llm-test')?.revision).toBe(2)
    })
    expect(describe).toHaveBeenCalledTimes(2)
  })
})

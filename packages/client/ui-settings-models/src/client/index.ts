/**
 * Models settings and product-onboarding plugin, browser half. It registers
 * the Models and Accounts pages plus the ordered internal-testing notice and provider-setup
 * navigation. The Host
 * settings and credential contracts stay behind their existing wire APIs.
 * Export discipline:
 * packages/client/AGENTS.md.
 */
import type { ClientContext } from '@hydraharness/harness-client-runtime/client'
import type { ConnectionHandle, CredentialView } from '@hydraharness/harness-api-remotes/client'
// Type-only: pulls the shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@hydraharness/harness-client-ui-settings/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@hydraharness/harness-client-locale/client'
// Type-only: pulls the ctx.remote merge and the forwarded-event key face
// (settings/credentials invalidations ride the allowlist) into this program.
import type {} from '@hydraharness/harness-api-remotes/client'
import { ModelsSection } from './ModelsSection.tsx'
import { AccountsSection } from './AccountsSection.tsx'
import type { ModelsSectionInjected } from './ModelsSection.tsx'
import { ProviderOnboarding } from './ProviderOnboarding.tsx'
import type { ProviderOnboardingInjected } from './ProviderOnboarding.tsx'
import { WelcomeNotice } from './WelcomeNotice.tsx'
import type { WelcomeNoticeInjected } from './WelcomeNotice.tsx'
import { decodeWelcomeSection, WelcomeNoticeStore } from './welcome-store.ts'
import { ModelsSettingsStore } from './store.ts'
import { createSettingsSchemaOperations } from './schema-operations.ts'
import { en, type ModelsKey } from './locales.ts'
import { SpeedPreferenceRow, type SpeedPreferenceRowInjected } from './SpeedPreferenceRow.tsx'
import { WELCOME_NOTICE_SETTINGS_NAMESPACE } from '../onboarding-copy.ts'

export type { ModelsSectionInjected, ModelsSectionProps } from './ModelsSection.tsx'
export type { ModelsKey } from './locales.ts'

declare module '@hydraharness/harness-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Models page + product-onboarding copy. */
    'settings.models': ModelsKey
  }

  interface SlotMap {
    /** Decision preferences and credential editors owned by their provider plugins. */
    'settings.models.decision': { kind: 'list'; scope: 'root'; owner: ModelsDecisionOwnerProps }
  }
}

/** Owner props for a decision provider's preferences and credential editor. */
export interface ModelsDecisionOwnerProps {
  /** Value-free states from the page's refreshed credential describe. */
  credentials: Readonly<Record<string, CredentialView>>
  /** Whether the host settings provider is read-only. */
  readOnly: boolean
  /** Navigate to another Settings section. */
  openSection: (id: string) => void
}

/** Dictionary namespace owned by this plugin. */
const NS = 'settings.models'
export type { ModelsSettingsState, ProviderRow } from './store.ts'

/**
 * Refetch the page snapshot only after its first load: an unopened Models
 * page must not fetch on background invalidations.
 * @param controller - the page store.
 */
export function refreshIfLoaded(controller: ModelsSettingsStore): void {
  if (controller.store.getSnapshot().status === 'idle') return
  void controller.load()
}

/**
 * Required services (cordis fiber inject). The target slot is declared by
 * ui-settings' apply, whose activation order relative to this one is NOT
 * constrained; registration depends on each slot through `slots.inject()`.
 */
export const inject = ['slots', 'locale', 'connection', 'remote', 'settingsScope', 'settingsSchema']

/**
 * Register the Models and Accounts sections once the `settings.section` declaration is on
 * the ledger, wire its store to the connection, and keep it fresh on every
 * pushed invalidation (settings, credentials, or provider topology).
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { en }), 'ui-settings-models: copy dictionaries')

  const connection = ctx.get('connection') as ConnectionHandle
  const speed = ctx.settingsScope.bind<{ tier: 'standard' | 'priority' }>({ namespace: 'llm-speed' })
  const defaultModel = ctx.settingsScope.bind<{ provider: string; model: string }>({ namespace: 'agent-default-model' })
  ctx.slots.inject('settings.general.general.item', () => ctx.slots.register({
    name: 'settings.general.general.item', id: 'speed', order: 75, label: () => ctx.locale.bind(NS)('speed.title'), locale: NS,
    inject: (): SpeedPreferenceRowInjected => ({ api: connection.api, current: () => ctx.get('sessions')?.list.getSnapshot().current,
      save: async (tier) => {
        await speed.set('tier', tier)
        if (speed.getSnapshot().value?.tier !== tier) throw new Error('Could not save the processing speed. Try again.')
      }, hooks: { speed, model: defaultModel } }),
  }, SpeedPreferenceRow))
  const schema = createSettingsSchemaOperations(ctx.settingsSchema)
  const settings = ctx.settingsScope.describe()
  const controller = new ModelsSettingsStore(connection.api, schema, settings)
  // Registration-time text (the nav label thunk) and the inject faces share
  // one bound translate; copy freshness rides the locale revision.
  const t = ctx.locale.bind(NS) as ModelsSectionInjected['t']
  const injected = (): ModelsSectionInjected => ({
    controller,
    hooks: {
      snapshot: controller.store,
      selection: ctx.settingsScope.selection(),
      decisions: {
        getSnapshot: () => ctx.slots.entries('settings.models.decision').length,
        subscribe: listener => ctx.slots.subscribe('settings.models.decision', listener),
      },
    },
    api: connection.api,
    schema,
    t,
    acceptSettings: (view) => { settings.acceptView(view) },
  })
  const providerOnboardingInjected = (): ProviderOnboardingInjected => ({
    controller,
    hooks: { models: controller.store },
  })
  // The scope's own memory mode is what keeps a remote browser process-local,
  // so the store needs no isLoopback branch of its own.
  const welcomeController = new WelcomeNoticeStore(ctx.settingsScope.bind({
    namespace: WELCOME_NOTICE_SETTINGS_NAMESPACE,
    decode: decodeWelcomeSection,
  }))
  const welcomeInjected = (): WelcomeNoticeInjected => ({
    controller: welcomeController,
    hooks: { welcome: welcomeController.store },
    t,
  })

  // Pushed invalidations converge every open surface without polling. The
  // settingsScope injection makes ui-settings activate first, and remote
  // dispatch preserves listener order; its listener therefore starts the
  // mirror refresh before this store joins that refresh. The welcome notice
  // follows its settings scope, so it needs no subscription here.
  ctx.effect(() => {
    const refreshModels = (): void => { refreshIfLoaded(controller) }
    const disposers = [
      ctx.remote.$on('settings/document-updated', () => { refreshModels() }),
      ctx.remote.$on('credentials/reference-updated', refreshModels),
      ctx.remote.$on('credentials/record-updated', refreshModels),
      ctx.remote.$on('llm/adapters-updated', refreshModels),
      ctx.on('connection/reset', refreshModels),
    ]
    return () => {
      welcomeController.dispose()
      for (const dispose of disposers) dispose()
    }
  }, 'ui-settings-models: pushed invalidations')

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'models',
    order: 10,
    label: () => t('nav'),
    inject: injected,
    children: { 'settings.models.decision': { kind: 'list', scope: 'root' } },
  }, ModelsSection))
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'accounts', order: 11, label: () => t('accountsTitle'),
    inject: () => ({ controller, api: connection.api, t, hooks: { snapshot: controller.store } }),
  }, AccountsSection))
  ctx.slots.inject('settings.onboarding', () => ctx.slots.register({
    name: 'settings.onboarding',
    id: 'welcome-notice',
    order: -100,
    inject: welcomeInjected,
  }, WelcomeNotice))
  ctx.slots.inject('settings.onboarding', () => ctx.slots.register({
    name: 'settings.onboarding',
    id: 'provider-setup',
    order: 0,
    inject: providerOnboardingInjected,
  }, ProviderOnboarding))
}

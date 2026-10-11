/** Suggested-prompt Settings and empty-chat presentation. */
import type { ClientContext } from '@hydraharness/harness-client-runtime/client'
import type {} from '@hydraharness/harness-client-locale/client'
import type { SessionId } from '@hydraharness/harness-api-remotes/client'
import type { ConnectionHandle } from '@hydraharness/harness-api-remotes/client'
import type {} from '@hydraharness/harness-client-ui-settings/client'
import type {} from '@hydraharness/harness-client-ui-conversation/client'
import { SuggestedPreferenceRow, Suggestions, type SuggestedPreferenceInjected, type SuggestionsInjected } from './Suggestions.tsx'
declare module '@hydraharness/harness-client-ui-slots' { interface LocaleNamespaceMap { suggestions: keyof typeof en } }
const en = { title: 'Suggested prompts', description: 'Create suggestions from readable project files and connected MCP resources. This sends bounded context to the selected model and consumes tokens.',
  saving: 'Saving…', applies: 'Applies when an empty chat opens or you refresh suggestions.', loading: 'Creating suggestions…', refresh: 'Refresh suggestions' }
/** Required presentation services. */
export const inject = ['slots', 'locale', 'connection', 'settingsScope']
/**
 * @param ctx - browser composition owner.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register('suggestions', { en }), 'suggestions: copy')
  const api = (ctx.get('connection') as ConnectionHandle).api
  const preferences = ctx.settingsScope.bind<{ enabled: boolean }>({ namespace: 'suggested-prompts' })
  const save = async (enabled: boolean): Promise<void> => {
    await preferences.set('enabled', enabled)
    if (preferences.getSnapshot().value?.enabled !== enabled) throw new Error('Could not save suggested prompts. Try again.')
  }
  ctx.slots.inject('settings.general.general.item', () => ctx.slots.register({ name: 'settings.general.general.item', id: 'suggested-prompts', order: 80,
    label: () => ctx.locale.bind('suggestions')('title'), locale: 'suggestions', inject: (): SuggestedPreferenceInjected => ({ save, hooks: { preferences } }),
  }, SuggestedPreferenceRow))
  const loads = new Map<SessionId, SuggestionsInjected['load']>()
  ctx.slots.inject('conversation.hero.suggestions', () => ctx.slots.register({ name: 'conversation.hero.suggestions', id: 'suggested-prompts', locale: 'suggestions',
    inject: (sessionId): SuggestionsInjected => {
      let load = loads.get(sessionId)
      if (load === undefined) {
        load = async (refresh) => {
          const response = await api.sessions.suggestions({ sessionId, refresh })
          if (!response.result.ok) throw new Error(response.result.error.message)
          return response.result.value
        }
        loads.set(sessionId, load)
      }
      return { load, save, hooks: { preferences } }
    },
  }, Suggestions))
  ctx.effect(() => () => { loads.clear() }, 'suggestions: client request callbacks')
}

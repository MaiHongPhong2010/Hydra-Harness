/** Browser contribution that adds Jev to the Models Decision group. */

import type { ClientContext } from '@hydraharness/harness-client-runtime/client'
import type { ConnectionHandle } from '@hydraharness/harness-api-remotes/client'
import type {} from '@hydraharness/harness-client-ui-settings-models/client'
import type {} from '@hydraharness/harness-client-ui-settings/client'
import { JevProviderOption } from './JevProviderOption.tsx'

/** Slots, the Host connection, and the shared settings mirror own the contribution. */
export const inject = ['slots', 'connection', 'settingsScope']

/** Register and dispose the Jev decision preference and credential editor. */
export function apply(ctx: ClientContext): void {
  const settings = ctx.settingsScope.describe()
  const api = (ctx.get('connection') as ConnectionHandle).api
  ctx.slots.inject('settings.models.decision', () => ctx.slots.register({
    name: 'settings.models.decision',
    id: 'jev',
    order: 100,
    label: 'Jev',
    locale: 'settings.models',
    inject: () => ({
      hooks: { settings },
      saveEnabled: async (enabled: boolean, revision: number): Promise<void> => {
        const response = await api.settings.mutate({ ns: 'browser-decisions', expectedRevision: revision,
          ops: [{ op: 'set', path: ['enabled'], value: enabled }] })
        if (!response.result.ok) {
          ctx.settingsScope.refresh()
          throw new Error(response.result.error.message)
        }
        settings.acceptView(response.result.value)
      },
      saveKey: async (ref: string, value: string): Promise<boolean> => {
        const response = await api.credentials.set({ ref, value })
        return response.result.ok
      },
    }),
  }, JevProviderOption))
}

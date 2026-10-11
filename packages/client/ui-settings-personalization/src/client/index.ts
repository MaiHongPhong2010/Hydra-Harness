/**
 * Personalization settings section, browser half: custom instructions
 * (`settings.readInstructions`/`writeInstructions`), local memory controls,
 * and the personality selector. The two settings namespaces are owned
 * host-side by `@hydraharness/harness-personalization`.
 */

import type { ConnectionHandle } from '@hydraharness/harness-api-remotes/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@hydraharness/harness-client-locale/client'
// Type-only: pulls the settings shell's SlotMap merge (the 'settings.section' entry) and ctx.settingsScope.
import type {} from '@hydraharness/harness-client-ui-settings/client'
import type { ClientContext } from '@hydraharness/harness-client-runtime/client'
import { createSnapshotStore } from '@hydraharness/harness-client-runtime/client'
import { InstructionsController } from './instructions-store.ts'
import { en } from './locales.ts'
import type { PersonalizationKey } from './locales.ts'
import { PersonalizationSection } from './PersonalizationSection.tsx'
import type { MemorySettings, PersonalityDraft, PersonalitySettings, PersonalizationSectionInjected } from './PersonalizationSection.tsx'

export type { MemorySettings, Personality, PersonalitySettings, PersonalizationSectionInjected, PersonalizationSectionProps } from './PersonalizationSection.tsx'
export type { InstructionsState, InstructionsStatus } from './instructions-store.ts'
export type { PersonalizationKey } from './locales.ts'

declare module '@hydraharness/harness-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.personalization': PersonalizationKey
  }
}

/** Settings namespace registered host-side by `@hydraharness/harness-personalization`. */
const PERSONALIZATION_NAMESPACE = 'personalization'
const MEMORY_NAMESPACE = 'memory'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'connection', 'settingsScope']

/**
 * Mount the Personalization settings section.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const { api } = ctx.get('connection') as ConnectionHandle
  const selection = ctx.settingsScope.selection()
  const documents = new Map<string, InstructionsController>()
  const document = (): InstructionsController => {
    const { target } = selection.getSnapshot()
    const key = `${target.workspaceId ?? 'global'}:${target.layer ?? ''}`
    let controller = documents.get(key)
    if (controller === undefined) { controller = new InstructionsController(api, target); documents.set(key, controller) }
    return controller
  }
  let instructions = document()
  const instructionView = createSnapshotStore(instructions.store.getSnapshot())
  let stopInstructions = instructions.store.subscribe(() => { instructionView.set(instructions.store.getSnapshot()) })
  const stopSelection = selection.subscribe(() => {
    const next = document()
    if (next === instructions) return
    stopInstructions()
    instructions = next
    instructionView.set(instructions.store.getSnapshot())
    stopInstructions = instructions.store.subscribe(() => { instructionView.set(instructions.store.getSnapshot()) })
  })
  const personality = ctx.settingsScope.bind<PersonalitySettings>({ namespace: PERSONALIZATION_NAMESPACE })
  const memory = ctx.settingsScope.bind<MemorySettings>({ namespace: MEMORY_NAMESPACE })
  const personalityDraft = createSnapshotStore<PersonalityDraft>({ value: undefined, saving: false, failed: false })
  const lifecycle = new AbortController()
  const isDisposed = (): boolean => lifecycle.signal.aborted

  ctx.effect(() => ctx.locale.register('settings.personalization', { en }), 'ui-settings-personalization: dictionaries')
  ctx.effect(() => () => { lifecycle.abort(); stopInstructions(); stopSelection(); for (const controller of documents.values()) controller.dispose() }, 'ui-settings-personalization: editor lifecycle')

  const sectionInjected = (): PersonalizationSectionInjected => ({
    hooks: { instructions: instructionView, personality, personalityDraft, memory, selection },
    load: () => instructions.ensure(),
    setDraft: (text: string) => { instructions.setDraft(text) },
    save: () => instructions.save(),
    reload: () => instructions.load(),
    setPersonality: (value) => { personalityDraft.update((draft) => { draft.value = value; draft.failed = false }) },
    savePersonality: async () => {
      const { value, saving } = personalityDraft.getSnapshot()
      const scope = personality.getSnapshot()
      if (isDisposed() || saving || value === undefined || scope.status !== 'ready' || !scope.writable) return
      personalityDraft.update((draft) => { draft.saving = true; draft.failed = false })
      try {
        await personality.set('personality', value)
        if (isDisposed()) return
        const accepted = personality.getSnapshot().value?.personality === value
        personalityDraft.update((draft) => {
          draft.failed = !accepted
          if (accepted && draft.value === value) draft.value = undefined
        })
      } catch (_personalityWriteFailure) {
        if (!isDisposed()) personalityDraft.update((draft) => { draft.failed = true })
      } finally {
        if (!isDisposed()) personalityDraft.update((draft) => { draft.saving = false })
      }
    },
    loadMemories: async () => {
      const response = await api.settings.listMemories({})
      if (!response.result.ok) throw new Error(response.result.error.message)
      return response.result.value.entries
    },
    removeMemory: async (id) => {
      const response = await api.settings.removeMemory({ id })
      if (!response.result.ok) throw new Error(response.result.error.message)
      return response.result.value.removed
    },
    setMemory: (key, value) => memory.set(key, value),
  })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'personalization',
    order: 1,
    label: () => ctx.locale.bind('settings.personalization')('nav'),
    locale: 'settings.personalization',
    inject: sectionInjected,
  }, PersonalizationSection))
}

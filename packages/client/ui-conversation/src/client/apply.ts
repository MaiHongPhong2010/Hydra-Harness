/** Registers the conversation components, shared store, and service callbacks. */
import type { Context } from '@hydraharness/cordis'
import { resolveSlotLabel, type BoundActions } from '@hydraharness/harness-client-ui-slots'
import {
  resolveWorkspacePath, type ISessions, type SessionId,
} from '@hydraharness/harness-client-runtime/client'
// Type-only: the ctx.settingsScope Context merge. Cross-plugin collaboration
// goes through the service, never a value import (client bundle purity gate).
import type {} from '@hydraharness/harness-client-ui-settings/client'
import type {} from '@hydraharness/harness-client-ui-layout/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@hydraharness/harness-client-locale/client'
import type { ViewTab } from './contract/views.ts'
import type {
  ApprovalWait, ChatNodeTurnDataInjected, ChatScrollPosition, ChatViewInjected, ComposerBarInjected,
  ComposerChainProps, ConversationInjected, ConversationSessionHeaderInjected, ConversationSessionInjected,
  DetailsInjected,
} from './contract/slots.ts'
import type { InputNotice } from './input/contract.ts'
import { createChatStore } from './stores.ts'
import { ConversationController, UnsupportedImageMediaTypeError } from './service.ts'
import type { BrowserAnnotationSelection, IConversation } from './service.ts'
import { ComposerBlockRegistry } from './input/blocks.ts'
import type { ComposerBlock } from './input/blocks.ts'
import { InputHub } from './input/hub.ts'
import { ComposerSubmissionPolicy } from './input/submission-policy.ts'
import { InputBar } from './skeleton/InputBar.tsx'
import { ComposerPreferenceRow } from './settings/ComposerPreferenceRow.tsx'
import type { ComposerPreferenceRowInjected } from './settings/ComposerPreferenceRow.tsx'
import { UsageSection } from './settings/UsageSection.tsx'
import type { UsageSectionInjected } from './settings/UsageSection.tsx'
import { ChatView } from './chat/ChatView.tsx'
import { StatsLine } from './chat/StatsLine.tsx'
import { ApprovalPanel } from './skeleton/ApprovalPanel.tsx'
import { todoDockEntry } from './skeleton/TodoPanel.tsx'
import { queueDockEntry } from './queue/QueueDock.tsx'
import { ConversationRoot } from './skeleton/ConversationRoot.tsx'
import { ConversationSession, ConversationSessionHeader } from './skeleton/ConversationSession.tsx'
import { DetailsPanel } from './skeleton/DetailsPanel.tsx'
import { en, NS, type ConversationKey } from './locales.ts'
import { registerConversationNodes } from './conversation-nodes/register.ts'
import { registerChatNodeRenderers } from './chat/register-node-renderers.ts'
import { CONVERSATION_SETTINGS_NAMESPACE, type ConversationSettings } from '../submission-settings.ts'

type BrowserAnnotation = BrowserAnnotationSelection & {
  readonly screenshot?: {
    readonly mediaType: string
    readonly data: string
  }
}

interface DesktopAnnotationBridge {
  hydraDesktop?: {
    browser?: {
      onAnnotation?: (listener: (annotation: unknown) => void) => () => void
    }
  }
}

/** Keep page URLs private while retaining the internal terminal quote route. */
function normalizedAnnotationUrl(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (url.protocol === 'terminal:') return url.href
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.href
  } catch {
    return undefined
  }
}

/** Validate renderer-provided annotation data before it enters draft state. */
function parseBrowserAnnotation(value: unknown): BrowserAnnotation | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const candidate = value as Record<string, unknown>
  const kind = candidate.kind
  const url = candidate.url
  const title = candidate.title
  const preview = candidate.preview
  const normalizedUrl = typeof url === 'string' ? normalizedAnnotationUrl(url) : undefined
  if ((kind !== 'browser-element' && kind !== 'browser-region')
    || normalizedUrl === undefined || typeof title !== 'string' || typeof preview !== 'string'
    || normalizedUrl.length > 2_048 || title.length > 160 || preview.length > 1_024) return undefined
  const index = candidate.index
  if (index !== undefined && (!Number.isSafeInteger(index) || typeof index !== 'number' || index < 0)) return undefined
  let rect: { x: number; y: number; width: number; height: number } | undefined
  if (candidate.rect !== undefined) {
    if (typeof candidate.rect !== 'object' || candidate.rect === null || Array.isArray(candidate.rect)) return undefined
    const source = candidate.rect as Record<string, unknown>
    const x = source.x
    const y = source.y
    const width = source.width
    const height = source.height
    if (typeof x !== 'number' || typeof y !== 'number' || typeof width !== 'number' || typeof height !== 'number'
      || ![x, y, width, height].every(Number.isSafeInteger)
      || x < 0 || y < 0 || width < 1 || height < 1 || width > 10_000 || height > 10_000) return undefined
    rect = { x, y, width, height }
  }
  if (kind === 'browser-region' && (index !== undefined || rect === undefined)) return undefined
  let screenshot: BrowserAnnotation['screenshot'] | undefined
  if (candidate.screenshot !== undefined) {
    if (typeof candidate.screenshot !== 'object' || candidate.screenshot === null || Array.isArray(candidate.screenshot)) return undefined
    const image = candidate.screenshot as Record<string, unknown>
    if (typeof image.mediaType !== 'string' || typeof image.data !== 'string') return undefined
    screenshot = { mediaType: image.mediaType, data: image.data }
  }
  if (kind === 'browser-region') {
    if (rect === undefined) return undefined
    return {
      kind, url: normalizedUrl, title, preview, rect,
      ...(screenshot === undefined ? {} : { screenshot }),
    }
  }
  return {
    kind, url: normalizedUrl, title, preview,
    ...(index === undefined ? {} : { index }),
    ...(rect === undefined ? {} : { rect }),
    ...(screenshot === undefined ? {} : { screenshot }),
  }
}

function annotationScreenshotFile(screenshot: BrowserAnnotation['screenshot']): File | undefined {
  if (screenshot === undefined || screenshot.mediaType !== 'image/png'
    || screenshot.data.length === 0 || screenshot.data.length > 4_700_000) return undefined
  try {
    const decoded = atob(screenshot.data)
    if (decoded.length === 0 || decoded.length > 3_500_000) return undefined
    const bytes = Uint8Array.from(decoded, character => character.charCodeAt(0))
    if (bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) return undefined
    return new File([bytes], 'browser-annotation.png', { type: 'image/png' })
  } catch {
    return undefined
  }
}

declare module '@hydraharness/harness-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The conversation skeleton, chat flow, commands, details, and docks copy. */
    conversation: ConversationKey
  }
}

/** Services required by the conversation plugin. */
export const inject = [
  'slots', 'layout', 'sessions', 'workspaces', 'locale', 'connection', 'remote', 'settingsScope',
  'conversationEvents', 'conversationViews',
]

// Static no-session sources for the composer-bar hooks compartment: module
// constants so the render side's per-source hook cache (observableHook) keeps
// one identity across every no-session render.
const ABSENT_NOTICES = {
  getSnapshot: (): InputNotice | null => null,
  subscribe: () => () => {},
}
/** No session, therefore nothing to block; same one-identity rule as above. */
const ABSENT_BLOCK = {
  getSnapshot: (): ComposerBlock | undefined => undefined,
  subscribe: () => () => {},
}
const EMPTY_LEXICON: ReadonlyMap<'/' | '@', readonly string[]> = new Map()
const ABSENT_LEXICON = {
  getSnapshot: () => EMPTY_LEXICON,
  subscribe: () => () => {},
}

const ABSENT_MENU_LAUNCHER = {
  getSnapshot: (): string | null => null,
  subscribe: () => () => {},
}

const CHAT_NODE_INJECT: ChatNodeTurnDataInjected = {
  hooks: {
    turnData: ({ useSession }, nodeKey) => function useTurnData(key) {
      return useSession((snapshot) => {
        const location = snapshot.chat.nodes.get(nodeKey)?.location
        return location?.kind === 'turn' || location?.kind === 'step'
          ? location.turn.data.get(key)
          : undefined
      })
    },
  },
}

/** Resolve the session-scoped conversation face (scope-addressed send/cancel), failing loud. */
function scopedConversation(sessions: ISessions, id: SessionId): IConversation {
  const scoped = sessions.scope(id)
  if (scoped === undefined) throw new Error(`ui-conversation: session "${id}" resolved no scope`)
  const conversation = scoped.get('conversation')
  if (conversation === undefined) throw new Error('ui-conversation: conversation service unavailable through the session scope')
  return conversation
}

/** Resolve package-internal attachment operations from the public service registration. */
function concreteConversation(ctx: Context): ConversationController {
  const conversation = ctx.get('conversation') as ConversationController | undefined
  if (conversation === undefined) throw new Error('ui-conversation: conversation service unavailable')
  return conversation
}

/** Chain routing: claim the composer while an approval wait is pending (pure — owner props only). */
function selectApproval({ interactions }: ComposerChainProps): ApprovalWait | null {
  return interactions.find((i): i is ApprovalWait => i.kind === 'approval') ?? null
}

/** Mounts the conversation plugin.
 * @param ctx - Client root context.
 */
export function apply(ctx: Context): void {
  const sessions = ctx.sessions
  const workspaces = ctx.workspaces
  const layout = ctx.layout
  const slots = ctx.slots

  registerConversationNodes(ctx)
  const revisionWorkspace = (sessionId: SessionId) => workspaces.list.getSnapshot().items
    .find(workspace => workspace.sessionIds.includes(sessionId))?.workspaceId ?? null
  registerChatNodeRenderers(ctx, async (sessionId, node, text, options) => {
    const childId = await sessions.revise({
      sessionId, workspaceId: revisionWorkspace(sessionId), idempotencyKey: options.idempotencyKey,
      edit: { messageSeq: node.seq, text },
    })
    sessions.open(childId)
  }, async (sessionId, idempotencyKey) => {
    const childId = await sessions.revise({ sessionId, workspaceId: revisionWorkspace(sessionId), idempotencyKey })
    sessions.open(childId)
  })

  ctx.effect(() => ctx.locale.register(NS, { en }), 'ui-conversation: dictionaries')

  // Registration-time text (the view tab label) reads through the bound
  // translate as a thunk, so it follows the active locale without
  // re-registration; components read the standard `t` seat instead.
  const t = ctx.locale.bind(NS)

  // Apply-time construction keeps store identity bound to this fiber.
  const chatStore = createChatStore()
  const submissionPolicy = new ComposerSubmissionPolicy(
    ctx.settingsScope.bind<ConversationSettings>({ namespace: CONVERSATION_SETTINGS_NAMESPACE }),
  )

  const composerRows = [
    { field: 'plainText', id: 'composer-plain', title: 'settings.plain.title', description: 'settings.plain.description' },
    { field: 'showContextUsage', id: 'composer-context', title: 'settings.context.title', description: 'settings.context.description' },
    { field: 'sendShortcut', id: 'composer-shortcut', title: 'settings.shortcut.title', description: 'settings.shortcut.description' },
    { field: 'busyEnter', id: 'composer-enter', title: 'settings.enter.title', description: 'settings.enter.description' },
  ] as const
  for (const [order, row] of composerRows.entries()) {
    ctx.slots.inject('settings.general.composer.item', () => ctx.slots.register({
      name: 'settings.general.composer.item', id: row.id, order, locale: NS,
      label: () => `${t(row.title)} ${t(row.description)}`,
      inject: (): ComposerPreferenceRowInjected => ({
        ...row,
        hooks: { preferences: submissionPolicy.preferences, writable: submissionPolicy.writable },
        save: value => submissionPolicy.save(row.field, value),
      }),
    }, ComposerPreferenceRow))
  }
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'usage',
    order: 12,
    label: () => t('settings.usage.nav'),
    locale: NS,
    inject: (): UsageSectionInjected => ({
      refresh: () => sessions.refresh(),
    }),
  }, UsageSection))

  // Chat semantic reader positions by session, surviving view switches and
  // width reflow when the tab ring remounts the view. Deliberately not
  // persisted: a fresh page load keeps the open-jump-to-bottom default.
  const chatScrollPositions = new Map<SessionId, ChatScrollPosition>()

  const viewTabs = (): ViewTab[] => {
    const tabs: ViewTab[] = []
    for (const entry of slots.entries('conversation.view')) {
      /* v8 ignore next -- unreachable: list registration validates id at load. */
      if (entry.options.id === undefined) continue
      tabs.push({ id: entry.options.id, label: resolveSlotLabel(entry.options.label) ?? entry.options.id })
    }
    return tabs
  }
  const views = {
    list: viewTabs,
    subscribe: (fn: () => void) => slots.subscribe('conversation.view', fn),
    version: () => slots.getVersion('conversation.view'),
  }

  // The per-session input machine registry (SessionInputResolver face; published as
  // ctx.conversation.input by the service below sharing this one instance).
  const inputHub = new InputHub(ctx, t)

  const onBrowserAnnotation = (globalThis as typeof globalThis & DesktopAnnotationBridge)
    .hydraDesktop?.browser?.onAnnotation
  if (onBrowserAnnotation !== undefined) {
    ctx.effect(() => onBrowserAnnotation((raw) => {
      const annotation = parseBrowserAnnotation(raw)
      if (annotation === undefined) return
      const sessionId = sessions.list.getSnapshot().current
      if (sessionId === undefined) return
      const shell = inputHub.shell(sessionId)
      const conversation = concreteConversation(ctx)
      const attachment = conversation.createDraftBrowserAnnotation(annotation)
      const screenshot = annotationScreenshotFile(annotation.screenshot)
      const images = screenshot === undefined ? [] : conversation.createDraftImages([screenshot])
      const imageIds = images.map(image => image.id)
      if (imageIds[0] !== undefined) conversation.attachDraftBrowserAnnotationScreenshot(attachment.id, imageIds[0])
      if (!shell.addBrowserAnnotations([attachment.id]) || !shell.addImages(imageIds)) {
        conversation.releaseDraftBrowserAnnotation(attachment.id)
        conversation.releaseDraftImages(images)
        shell.removeBrowserAnnotation(attachment.id)
        for (const id of imageIds) shell.removeImage(id)
      }
    }), 'ui-conversation: desktop browser annotation')
  }

  // The composer-block registry: a plugin that knows a session cannot send —
  // ui-model-selection, when no adapter serves the session's route — raises a block
  // here, and the bar reads its own session's store. It cannot flow the other
  // way: this package must not import the plugins that would know.
  const composerBlocks = new ComposerBlockRegistry()

  // The input machine feeds every session-scope slot
  // component through the standard provide channel — the 'input' hook plus
  // the two public actions. Materialization is the shell creation trigger
  // (per-session lazy; scope disposer tears down).
  ctx.effect(() => sessions.provide({
    hooks: ['input'],
    props: ['inputActions'],
    resolve: (binding) => {
      const shell = inputHub.shellFor(binding)
      return {
        hooks: { input: shell.state },
        props: { inputActions: shell.actions },
      }
    },
  }), 'ui-conversation: input standard-kit provider')

  // Resident current-session-optional shell. It owns the stable Hero/composer
  // frame while strict session slots fill only their session-bound regions.
  slots.register({
    name: 'conversation',
    locale: NS,
    children: {
      'conversation.session': { kind: 'single', scope: 'session' },
      'conversation.session.header': { kind: 'single', scope: 'session' },
      'conversation.composer': { kind: 'chain', scope: 'session' },
      'conversation.composer.bar': { kind: 'single', scope: 'session-maybe' },
      'conversation.input.overlay': { kind: 'list', scope: 'session' },
      'conversation.input.dock': { kind: 'list', scope: 'session' },
      'conversation.composer.dock': { kind: 'list', scope: 'session' },
      'conversation.input.left': { kind: 'list', scope: 'session' },
      'conversation.input.right': { kind: 'list', scope: 'session' },
      'conversation.hero.brand.mark': { kind: 'single', scope: 'root' },
      'conversation.hero.workspace': { kind: 'single', scope: 'root' },
      'conversation.hero.agentPreset': { kind: 'single', scope: 'root' },
      'conversation.hero.suggestions': { kind: 'list', scope: 'session' },
    },
    inject: (sessionId: SessionId | undefined): ConversationInjected => ({
      hooks: { composerBlock: sessionId === undefined ? ABSENT_BLOCK : composerBlocks.storeFor(sessionId) },
      selectWorkspace: async (workspaceId) => {
        const nextId = await workspaces.connectWorkspace(workspaceId)
        if (sessionId !== undefined && nextId !== sessionId) {
          const from = inputHub.shell(sessionId)
          const draft = from.snapshot.draft
          const imageIds = from.snapshot.imageIds
          const annotationIds = from.snapshot.browserAnnotationIds ?? []
          const next = inputHub.shell(nextId)
          const movedAnnotations = annotationIds.length === 0 || next.addBrowserAnnotations(annotationIds)
          const movedImages = imageIds.length === 0 || next.addImages(imageIds)
          if (movedAnnotations && movedImages) {
            if (draft !== '') {
              next.setDraft(draft)
              from.setDraft('')
            }
            if (imageIds.length > 0) {
              for (const id of imageIds) from.removeImage(id)
            }
            for (const id of annotationIds) from.removeBrowserAnnotation(id)
          } else {
            if (movedAnnotations) for (const id of annotationIds) next.removeBrowserAnnotation(id)
            if (movedImages) for (const id of imageIds) next.removeImage(id)
          }
        }
        sessions.open(nextId)
      },
    }),
  }, ConversationRoot)

  // The strict session body fills the resident scrollport without owning it;
  // the Hero/composer path therefore stays fixed while the first blank
  // session appears after a Workspace pick.
  slots.register({
    name: 'conversation.session',
    children: {
      'conversation.view': { kind: 'list', scope: 'session' },
    },
    store: chatStore,
    inject: (sessionId: SessionId, _actions: BoundActions<typeof chatStore>): ConversationSessionInjected => {
      const conversation = concreteConversation(ctx)
      return {
        views,
        releaseSessionImages: (id) => { conversation.releaseSessionImages(id) },
        bindDraftMirror: write => inputHub.shell(sessionId).bindMirror(write),
      }
    },
  }, ConversationSession)

  // Header chrome sits above the resident scrollport but shares the same
  // per-session chat store (active view) as its body and view entries.
  slots.register({
    name: 'conversation.session.header',
    locale: NS,
    children: {
      'conversation.session.header.lineage': { kind: 'single', scope: 'session' },
      'conversation.session.header.actions': { kind: 'list', scope: 'session' },
      'conversation.session.header.utilities': { kind: 'list', scope: 'session' },
    },
    store: chatStore,
    inject: (sessionId: SessionId): ConversationSessionHeaderInjected => ({
      views,
      open: (id) => { sessions.open(id) },
      openVersion: (id) => {
        if (sessions.list.getSnapshot().byId[sessionId]?.versionState !== undefined) return sessions.selectVersion(sessionId, id as import('@hydraharness/harness-session/types').SessionVersionId)
        sessions.open(id as SessionId)
      },
      referenceVersion: id => sessions.selectVersion(sessionId, id as import('@hydraharness/harness-session/types').SessionVersionId, 'reference'),
    }),
  }, ConversationSessionHeader)

  // The default composer body: its own single slot inside the composer
  // chain's fallback. Public machine surface arrives via the
  // provide channel above; the keyboard command face and the stop/retry
  // verbs ride this inject (package-internal — hub and bar are one plugin).
  // Session-maybe: with no current session the machine faces are absent and
  // the hooks compartment binds static empty sources (module constants, so
  // observableHook caching and hook order stay stable across transitions).
  slots.register({
    name: 'conversation.composer.bar',
    locale: NS,
    // The two named control seats in the bar's tool row (plan beside the
    // access control, model right); empty until their owning plugins
    // register.
    children: {
      'conversation.input.attachments': { kind: 'single', scope: 'session-maybe' },
      'conversation.input.plan': { kind: 'single', scope: 'session' },
      'conversation.input.model': { kind: 'single', scope: 'session' },
    },
    inject: (sessionId: SessionId | undefined): ComposerBarInjected => {
      if (sessionId === undefined) {
        return {
          keyboard: undefined,
          addImages: undefined,
          removeImage: undefined,
          draftImages: undefined,
          draftBrowserAnnotations: undefined,
          removeBrowserAnnotation: undefined,
          updateBrowserAnnotationComment: undefined,
          resolveSubmitMode: (running, gesture, steeringAvailable) =>
            submissionPolicy.resolve(running, gesture, steeringAvailable),
          toggleCommandMenu: undefined,
          stop: undefined,
          command: undefined,
          hooks: { notices: ABSENT_NOTICES, lexicon: ABSENT_LEXICON, menuLauncher: ABSENT_MENU_LAUNCHER,
            composerPreferences: submissionPolicy.preferences },
        }
      }
      const conversation = concreteConversation(ctx)
      const shell = inputHub.shell(sessionId)
      const inputTriggers = inputHub.inputTriggers(sessionId)
      return {
        keyboard: shell,
        addImages: (files) => {
          try {
            const images = conversation.createDraftImages(files)
            if (!shell.addImages(images.map(image => image.id))) {
              conversation.releaseDraftImages(images)
            }
            return null
          } catch (error: unknown) {
            if (error instanceof UnsupportedImageMediaTypeError) {
              // Positive copy: the supported list is fixed in imageMediaType,
              // and naming it beats echoing the rejected MIME type back.
              return t('image.unsupportedType')
            }
            return error instanceof Error ? error.message : String(error)
          }
        },
        removeImage: (id) => {
          conversation.releaseDraftImage(id)
          shell.removeImage(id)
        },
        draftImages: ids => conversation.draftImages(ids),
        draftBrowserAnnotations: ids => conversation.draftBrowserAnnotations(ids),
        removeBrowserAnnotation: (id) => {
          const screenshotId = conversation.draftBrowserAnnotations([id])[0]?.screenshotId
          conversation.releaseDraftBrowserAnnotation(id)
          shell.removeBrowserAnnotation(id)
          if (screenshotId !== undefined) shell.removeImage(screenshotId)
        },
        updateBrowserAnnotationComment: (id, comment) => {
          shell.updateBrowserAnnotationComment(id, comment)
        },
        resolveSubmitMode: (running, gesture, steeringAvailable) =>
          submissionPolicy.resolve(running, gesture, steeringAvailable),
        toggleCommandMenu: inputTriggers === undefined
          ? undefined
          : (selection) => {
            shell.dismissPopup()
            const snapshot = shell.snapshot
            inputTriggers.toggleSource('command', {
              trigger: '/',
              query: '',
              quoted: false,
              position: snapshot.draft.slice(0, selection.start).trim() === '' ? 'leading' : 'inline',
              span: { ...selection, draftRev: snapshot.draftRev },
            })
          },
        stop: () => {
          scopedConversation(sessions, sessionId).cancel().catch(() => {
            // Stop failure surfaces via snapshot.promptError; nothing to restore.
          })
        },
        command: async (line) => {
          const session = sessions.binding(sessionId)?.session
          if (session === undefined) return false
          const result = await session.command(line)
          return result.ok && result.value.matched
        },
        hooks: {
          notices: shell.notices, composerPreferences: submissionPolicy.preferences,
          lexicon: shell.lexicon,
          menuLauncher: inputTriggers?.launcher ?? ABSENT_MENU_LAUNCHER,
        },
      }
    },
  }, InputBar)

  // The approval takeover: a selector-routed entry of the chain this package
  // just declared (the ui-user-questions registration pattern; the entry lives here
  // because approval answering is core conversation UX, not an optional tool).
  // Zero business face — data and verbs both ride the matched carrier.
  // priority 1: question takeovers (default 0) win when both kinds are
  // pending — a question is a conversation the model is waiting on, while an
  // approval only blocks one tool call; answering the question first cannot
  // strand the approval (it re-elects the moment the question resolves).
  slots.register({ name: 'conversation.composer', select: selectApproval, priority: 1, locale: NS }, ApprovalPanel)

  // The chat view: first entry of the ring this package just declared.
  // ChatView owns only the stable ordered Node list. Business renderers are
  // independently keyed behind its one Node seat.
  slots.register({
    name: 'conversation.view',
    id: 'chat',
    order: 0,
    label: () => t('view.chat'),
    locale: NS,
    children: {
      'conversation.chat.node': { kind: 'keyed', scope: 'session', inject: CHAT_NODE_INJECT },
      'conversation.message.images': { kind: 'single', scope: 'session' },
    },
    store: chatStore,
    inject: (sessionId: SessionId, actions: BoundActions<typeof chatStore>): ChatViewInjected => {
      const conversation = concreteConversation(ctx)
      const scoped = scopedConversation(sessions, sessionId)
      return {
        openDetails: (target) => {
          actions.select(target)
          layout.openDetails()
        },
        fileMentions: owner => ctx.get('chatFileMentions')?.forClosing(owner),
        openFile: (path) => {
          const cwd = sessions.list.getSnapshot().byId[sessionId]?.cwd
          return workspaces.openPath(resolveWorkspacePath(cwd, path))
        },
        loadOlder: () => { void scoped.loadOlder() },
        loadMedia: attachment => conversation.resolveMedia(sessionId, attachment),
        // Unregistered 'trajectory' id is safe: the tab ring falls back to
        // the first view, and the untouched inspect target stays inert.
        inspectCall: (callId) => {
          actions.setInspect({ callId })
          actions.setView('trajectory')
        },
        chatScroll: {
          save: (position) => {
            if (position === null) chatScrollPositions.delete(sessionId)
            else chatScrollPositions.set(sessionId, position)
          },
          read: () => chatScrollPositions.get(sessionId) ?? null,
        },
        forkAt: (seq) => {
          sessions.fork({ sessionId, atSeq: seq, increaseTitle: true })
            .then((childId) => { sessions.open(childId) })
            .catch(() => {
              // Fork or child-rename failure keeps the source view untouched.
            })
        },
      }
    },
  }, ChatView)

  // Session stats stick with the composer (composer.dock = stats-line family).
  slots.register({ name: 'conversation.composer.dock', id: 'stats', order: 0, locale: NS }, StatsLine)

  // Class-plugin mount (packages/AGENTS.md service form): the service
  // registers itself as `conversation` and lives on its own child fiber.
  // Presentation registrants depend directly on their slot declarations;
  // this service remains only where conversation actions are required.
  ctx.plugin(ConversationController, { input: inputHub, blocks: composerBlocks })

  // The plan strip rides the input dock above the queue rows (same posture).
  ctx.plugin(todoDockEntry)

  // The read-only queue dock entry rides the same
  // registration path into the input dock declared above.
  ctx.plugin(queueDockEntry)

  slots.register({
    name: 'details',
    locale: NS,
    children: {
      'conversation.details.tool': { kind: 'single', scope: 'session' },
    },
    store: chatStore,
    inject: (): DetailsInjected => ({
      closeDetails: () => { layout.closeDetails() },
    }),
  }, DetailsPanel)

}

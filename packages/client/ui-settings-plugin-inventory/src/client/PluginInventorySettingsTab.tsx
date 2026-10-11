import { useEffect, useId, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react'
import type {
  ImportedPluginSnapshot, PluginEnablementResult, PluginImportSource, PluginInventorySnapshot,
} from '@hydraharness/harness-api-remotes/client'
import { Button, Modal, Switch } from '@hydraharness/harness-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@hydraharness/harness-client-ui-slots'
import type { InventoryDraftState } from './inventory-controller.ts'
import { groupByOwner, matchesQuery } from './marketplace-owner.ts'
import type { PluginInventoryLocaleKey } from './locales.ts'
import css from './PluginInventorySettingsTab.module.css'

type PluginInventoryEntry = PluginInventorySnapshot['entries'][number]
type PluginFiberPhase = PluginInventoryEntry['fiberPhase']
type ImportedPluginEntry = ImportedPluginSnapshot['plugins'][number]
type NativeTypeFilter = 'all' | 'core' | 'extension' | 'preset'
type StatusFilter = 'all' | 'enabled' | 'disabled' | 'restart'
type SortOrder = 'name' | 'status'
type RuntimeStatus = 'running' | 'stopped' | 'starting' | 'session-scoped' | 'unmounted' | 'error' | 'restart'

/** Local controls for the deployment's configured plugin entries. */
export interface NativePluginControls {
  /** Read the current Host plugin inventory. */
  list: () => Promise<PluginInventorySnapshot>
  /** Persist one configured plugin's enablement. */
  setEnabled: (entryId: PluginInventoryEntry['entryId'], enabled: boolean) => Promise<PluginEnablementResult>
  /** Remove one workspace preset plugin override and return its inherited state. */
  reset?: (entryId: PluginInventoryEntry['entryId']) => Promise<PluginInventorySnapshot>
  /** Whether the addressed document owns an override for this entry. */
  overridden?: (entryId: PluginInventoryEntry['entryId']) => boolean
}

/** Local controls for imported OpenAI/Codex bundles. */
export interface ImportedPluginControls {
  /** Read imported OpenAI/Codex bundle state. */
  list: () => Promise<ImportedPluginSnapshot>
  /** Import one direct source or marketplace entry into the Hydra home. */
  import: (source: PluginImportSource) => Promise<ImportedPluginSnapshot>
  enable: (identity: string) => Promise<ImportedPluginSnapshot>
  disable: (identity: string) => Promise<ImportedPluginSnapshot>
  remove: (identity: string) => Promise<ImportedPluginSnapshot>
}

/** Registration-side Remote face used by the Plugins tab. */
export interface PluginInventorySettingsTabInjected {
  hooks: { pluginDrafts: HostObservable<InventoryDraftState> }
  /** Commit all native and imported enablement drafts. */
  savePlugins: () => Promise<void>
  /** Restore the last saved states without resetting the startup comparison. */
  discardPluginChanges: () => void
  /** Native inventory controls are available only in the local desktop app. */
  nativePlugins?: NativePluginControls
  /** Imported OpenAI/Codex bundle controls; also available only in the local desktop app. */
  importedPlugins?: ImportedPluginControls
}

/** Full component props assembled by the Settings slot renderer. */
export type PluginInventorySettingsTabProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'settings.pluginInventory'>
  & InjectFace<PluginInventorySettingsTabInjected>

type NativeViewState =
  | { readonly status: 'unavailable' }
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly snapshot: PluginInventorySnapshot }

type ImportedViewState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly snapshot: ImportedPluginSnapshot }

const PHASE_KEYS = {
  pending: 'pending',
  loading: 'loadingPhase',
  active: 'active',
  failed: 'failed',
  unloading: 'unloading',
} satisfies Record<Exclude<PluginFiberPhase, null>, PluginInventoryLocaleKey>

/** Localized Host mount status or preset scope. */
function phaseLabel(entry: PluginInventoryEntry, t: PluginInventorySettingsTabProps['t']): string {
  if (entry.presetId !== undefined) return t('sessionScoped')
  return entry.fiberPhase === null ? t('unobserved') : t(PHASE_KEYS[entry.fiberPhase])
}

/** Compact a module specifier without guessing whether its Loader id was generated. */
function moduleShortName(moduleName: string): string {
  const unscoped = moduleName.startsWith('@') ? moduleName.slice(moduleName.indexOf('/') + 1) : moduleName
  return unscoped
    .replace(/^cordis:/, '')
    .replace(/^cordis-plugin-/, '')
    .replace(/^harness-(?:host-|client-)?/, '')
}

function isEnabled(entry: PluginInventoryEntry): boolean {
  return entry.pendingEnabled ?? entry.enabled
}

function runtimeStatus(entry: PluginInventoryEntry): RuntimeStatus {
  if (entry.presetId !== undefined) return 'session-scoped'
  if (entry.restartRequired) return 'restart'
  if (!isEnabled(entry)) return 'stopped'
  if (entry.fiberPhase === null) return 'unmounted'
  if (entry.fiberPhase === 'failed') return 'error'
  if (entry.fiberPhase === 'active') return 'running'
  return 'starting'
}

function runtimeLabel(status: RuntimeStatus, t: PluginInventorySettingsTabProps['t']): string {
  const key = {
    running: 'runtimeRunning',
    stopped: 'runtimeStopped',
    starting: 'runtimeStarting',
    'session-scoped': 'sessionScoped',
    unmounted: 'unobserved',
    error: 'runtimeError',
    restart: 'runtimeRestart',
  }[status] as Parameters<PluginInventorySettingsTabProps['t']>[0]
  return t(key)
}

function typeLabel(entry: PluginInventoryEntry, t: PluginInventorySettingsTabProps['t']): string {
  if (entry.presetId !== undefined) return t('presetType')
  return entry.pluginType === 'core' ? t('coreType') : t('extensionType')
}

function matchesType(entry: PluginInventoryEntry, filter: NativeTypeFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'core') return entry.pluginType === 'core'
  if (filter === 'preset') return entry.presetId !== undefined
  return entry.pluginType !== 'core' && entry.presetId === undefined
}

function matchesStatus(entry: PluginInventoryEntry, filter: StatusFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'restart') return entry.restartRequired
  return filter === 'enabled' ? isEnabled(entry) : !isEnabled(entry)
}

/** Render the deployment's plugin inventory and its safe in-app controls. */
function NativePluginCatalog({
  active,
  nativePlugins,
  onRestartRequiredChange,
  query,
  t,
  drafts,
  typeFilter,
  statusFilter,
  sortOrder,
}: Pick<PluginInventorySettingsTabProps, 'nativePlugins' | 't' | 'active'> & {
  onRestartRequiredChange: (count: number) => void
  query: string
  drafts: InventoryDraftState
  typeFilter: NativeTypeFilter
  statusFilter: StatusFilter
  sortOrder: SortOrder
}): ReactNode {
  const headingId = useId()
  const [request, setRequest] = useState(0)
  const [selectedEntryId, setSelectedEntryId] = useState<string>()
  const [state, setState] = useState<NativeViewState>(
    /* v8 ignore next -- the parent renders this catalog only with native plugin controls. */
    nativePlugins === undefined ? { status: 'unavailable' } : { status: 'loading' },
  )
  const [mutating, setMutating] = useState<PluginInventoryEntry['entryId'] | null>(null)
  const [mutationFailed, setMutationFailed] = useState(false)

  useEffect(() => {
    if (!active) return undefined
    /* v8 ignore if -- removing native controls unmounts this catalog in its parent. */
    if (nativePlugins === undefined) {
      setState({ status: 'unavailable' })
      onRestartRequiredChange(0)
      return undefined
    }
    let current = true
    setState({ status: 'loading' })
    onRestartRequiredChange(0)
    void Promise.resolve().then(() => nativePlugins.list()).then(
      (snapshot) => {
        if (current) {
          setState({ status: 'ready', snapshot })
          onRestartRequiredChange(snapshot.entries.filter(entry => entry.restartRequired).length)
        }
      },
      () => { if (current) setState({ status: 'error' }) },
    )
    return () => { current = false }
  }, [active, nativePlugins, onRestartRequiredChange, request, drafts.revision])

  const normalizedQuery = query.trim().toLocaleLowerCase()
  const groups = useMemo(
    () => {
      const grouped = new Map<string, PluginInventoryEntry[]>()
      if (state.status !== 'ready') return []
      const matching = state.snapshot.entries.filter(candidate => matchesQuery(
        [candidate.moduleName, candidate.entryId, ...(candidate.relatedModules ?? [])], normalizedQuery,
      ) && matchesType(candidate, typeFilter) && matchesStatus(candidate, statusFilter))
      for (const entry of matching) {
        const entries = grouped.get(entry.moduleName) ?? []
        entries.push(entry)
        grouped.set(entry.moduleName, entries)
      }
      return [...grouped.values()].sort((left, right) => {
        const a = left[0]
        const b = right[0]
        /* v8 ignore if -- grouped values are created only from non-empty matching entries. */
        if (a === undefined || b === undefined) return 0
        if (sortOrder === 'status') {
          const status = runtimeStatus(a).localeCompare(runtimeStatus(b))
          if (status !== 0) return status
        }
        return moduleShortName(a.moduleName).localeCompare(moduleShortName(b.moduleName))
      })
    },
    [normalizedQuery, sortOrder, state, statusFilter, typeFilter],
  )
  const retry = (): void => { setRequest(value => value + 1) }
  const toggle = (entry: PluginInventoryEntry): void => {
    /* v8 ignore if -- switches render only for toggleable entries with native controls. */
    if (nativePlugins === undefined || !entry.toggleable) return
    setMutating(entry.entryId)
    setMutationFailed(false)
    const enabled = entry.pendingEnabled ?? entry.enabled
    void nativePlugins.setEnabled(entry.entryId, !enabled).then(
      ({ snapshot }) => {
        setState({ status: 'ready', snapshot })
        onRestartRequiredChange(snapshot.entries.filter(candidate => candidate.restartRequired).length)
      },
      () => { setMutationFailed(true) },
    ).finally(() => { setMutating(null) })
  }
  const reset = (entry: PluginInventoryEntry): void => {
    if (nativePlugins?.reset === undefined) return
    setMutating(entry.entryId)
    setMutationFailed(false)
    void nativePlugins.reset(entry.entryId).then((snapshot) => {
      setState({ status: 'ready', snapshot })
      onRestartRequiredChange(snapshot.entries.filter(candidate => candidate.restartRequired).length)
    }, () => { setMutationFailed(true) }).finally(() => { setMutating(null) })
  }

  const selectedEntry = state.status === 'ready'
    ? state.snapshot.entries.find(entry => entry.entryId === selectedEntryId
      && groups.some(group => group.some(candidate => candidate.entryId === entry.entryId)))
    : undefined
  const selectEntry = (entry: PluginInventoryEntry): void => { setSelectedEntryId(entry.entryId) }
  const rowKeyDown = (event: KeyboardEvent<HTMLDivElement>, entry: PluginInventoryEntry): void => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    selectEntry(entry)
  }
  const renderControl = (entry: PluginInventoryEntry, title: string): ReactNode => {
    if (!entry.toggleable) return <span className={css.nativeStatus}>{t(isEnabled(entry) ? 'enabledTag' : 'disabledTag')}</span>
    const enabled = isEnabled(entry)
    const presetPrefix = entry.presetId === undefined ? '' : `agent-preset:${entry.presetId}:`
    const instance = entry.presetId === undefined
      ? title
      : `${title} (${entry.presetId}: ${entry.entryId.replace(presetPrefix, '')})`
    return (
      <label className={css.switchControl} onClick={(event) => { event.stopPropagation() }}>
        <span>{mutating === entry.entryId ? t('saving') : enabled ? t('enabledTag') : t('disabledTag')}</span>
        <Switch
          checked={enabled}
          disabled={drafts.saving || mutating !== null}
          aria-label={`${t(enabled ? 'disablePlugin' : 'enablePlugin')} ${instance}`}
          onClick={() => { toggle(entry) }}
        />
      </label>
    )
  }
  const renderRuntime = (entry: PluginInventoryEntry): ReactNode => {
    const status = runtimeStatus(entry)
    return <span className={css.runtime} data-status={status}><span className={css.statusDot} aria-hidden="true" />{runtimeLabel(status, t)}</span>
  }
  const renderDetails = (entry: PluginInventoryEntry): ReactNode => (
    <>
      <table className={css.detailTable}><tbody>
        <tr><th scope="row">{t('descriptionColumn')}</th><td className={css.detailText}>{entry.description ?? t('metadataMissing')}</td></tr>
        <tr><th scope="row">{t('applicationColumn')}</th><td className={css.detailText}>{entry.application ?? t('metadataMissing')}</td></tr>
        <tr><th scope="row">{t('scopeColumn')}</th><td>{entry.presetId ?? t('allSessions')}</td></tr>
        <tr><th scope="row">{t('cordis')}</th><td>{phaseLabel(entry, t)}</td></tr>
      </tbody></table>
      {entry.presetId === undefined ? null : <p className={css.status}>{t('presetRuntimeHint')}</p>}
      {entry.relatedModules?.length ? (
        <div className={css.related}><strong>{t('relatedPlugins')}</strong><ul>{entry.relatedModules.map(moduleName => <li key={moduleName}><code>{moduleName}</code></li>)}</ul></div>
      ) : null}
      {entry.newSessionsOnly ? <p className={css.status}>{t('newSessionsOnly')}</p> : null}
      {entry.mixedEnabled ? <p className={css.status}>{t('mixedEnabled')}</p> : null}
      {drafts.dirtyNative.includes(entry.entryId) ? <p className={css.status}>{t('unsaved')}</p> : null}
      {drafts.changedNative.includes(entry.entryId) ? <p className={css.status}>{t('changedSinceStart')}</p> : null}
      {entry.restartRequired ? <p className={css.status}>{t('restartRequired')}</p> : null}
      {!entry.toggleable ? <p className={css.status}>{t('requiredPlugin')}</p> : null}
      {nativePlugins?.reset === undefined || entry.presetId === undefined ? null : <Button
        variant="outline" size="sm" disabled={drafts.saving || mutating !== null || !nativePlugins.overridden?.(entry.entryId)}
        onClick={() => { reset(entry) }}
      >{t('resetInherited')}</Button>}
    </>
  )

  /* v8 ignore if -- the parent owns the unavailable state and does not mount this catalog for it. */
  if (state.status === 'unavailable') return <p className={css.status}>{t('pluginUnavailable')}</p>

  return (
    <section className={css.catalog} aria-labelledby={`${headingId}-title`} aria-busy={state.status === 'loading' || mutating !== null}>
      <div className={css.catalogHeading}>
        <h3 id={`${headingId}-title`}>{t('catalog')}</h3>
        {state.status === 'ready' ? <span data-plugin-count={groups.length}>{groups.length}</span> : null}
      </div>
      {state.status === 'loading' ? <p className={css.status}>{t('loading')}</p> : null}
      {state.status === 'error' ? (
        <div className={css.failure}>
          <p role="alert">{t('error')}</p>
          <button type="button" onClick={retry}>{t('retry')}</button>
        </div>
      ) : null}
      {mutationFailed ? <p className={css.mutationFailure} role="alert">{t('toggleError')}</p> : null}
      {state.status === 'ready' && state.snapshot.entries.length === 0 ? <p className={css.status}>{t('empty')}</p> : null}
      {state.status === 'ready' && state.snapshot.entries.length > 0 && groups.length === 0 ? <p className={css.status}>{t('emptySearch')}</p> : null}
      {groups.length > 0 ? (
        <div className={css.catalogLayout}>
          <div className={css.tableWrap}>
            <div className={css.tableHeader} role="presentation">
              <span>{t('nameColumn')}</span><span>{t('typeColumn')}</span><span>{t('runtimeColumn')}</span><span>{t('enabledColumn')}</span>
            </div>
            <ul className={css.inventoryRows}>
              {groups.map((group) => {
                const first = group[0]
                /* v8 ignore if -- each group is created by appending its first matching entry. */
                if (first === undefined) return null
                const title = moduleShortName(first.moduleName)
                const grouped = group.length > 1
                const row = (entry: PluginInventoryEntry, name: string): ReactNode => (
                  <div className={css.inventoryRow} key={entry.entryId} data-selected={selectedEntryId === entry.entryId ? 'true' : undefined}>
                    <div className={css.rowMain} role="button" tabIndex={0} aria-expanded={selectedEntryId === entry.entryId}
                      onClick={() => { selectEntry(entry) }} onKeyDown={(event) => { rowKeyDown(event, entry) }}>
                      <span className={css.pluginIdentity}>
                        <strong>{name}</strong>
                        <code>{entry.entryId === first.entryId ? entry.moduleName : entry.entryId}</code>
                      </span>
                      <span className={css.typeTag}>{typeLabel(entry, t)}</span>
                      {renderRuntime(entry)}
                    </div>
                    <div className={css.rowControl}>{renderControl(entry, title)}</div>
                  </div>
                )
                return (
                  <li className={css.inventoryGroup} key={first.moduleName} data-plugin-entry={grouped ? undefined : first.entryId}
                    data-plugin-module={first.moduleName}
                    data-restart-required={group.some(entry => entry.restartRequired) ? 'true' : undefined}
                    data-plugin-changed={group.some(entry => drafts.changedNative.includes(entry.entryId)) ? 'true' : undefined}>
                    {grouped ? (
                      <>
                        <div className={css.inventoryRow} data-selected={selectedEntryId === first.entryId ? 'true' : undefined}>
                          <div className={css.rowMain} role="button" tabIndex={0} aria-expanded={selectedEntryId === first.entryId}
                            onClick={() => { selectEntry(first) }} onKeyDown={(event) => { rowKeyDown(event, first) }}>
                            <span className={css.pluginIdentity}>
                              <strong title={first.moduleName}>{title}</strong>
                              <code>{first.moduleName}</code>
                            </span>
                            <span className={css.typeTag}>{typeLabel(first, t)}</span>
                            {renderRuntime(first)}
                          </div>
                          <div className={css.rowControl}><span className={css.nativeStatus}>{t('mixedTag')}</span></div>
                        </div>
                        <ul className={css.groupInstances}>
                          {group.map(entry => (
                            <li className={css.instanceItem} key={entry.entryId} data-plugin-entry={entry.entryId}>
                              {row(entry, entry.entryId.replace(`agent-preset:${entry.presetId ?? ''}:`, ''))}
                            </li>
                          ))}
                        </ul>
                      </>
                    ) : row(first, title)}
                  </li>
                )
              })}
            </ul>
          </div>
        </div>
      ) : null}
      {selectedEntry === undefined ? null : (
        <Modal
          open
          title={moduleShortName(selectedEntry.moduleName)}
          description={selectedEntry.moduleName}
          closeLabel={t('closeDetails')}
          onClose={() => { setSelectedEntryId(undefined) }}
        >
          {renderDetails(selectedEntry)}
        </Modal>
      )}
    </section>
  )
}

/** Render OpenAI/Codex bundle lifecycle controls without duplicating capability settings. */
function ImportedPluginCatalog(
  { active = true, importedPlugins, query, t, drafts, statusFilter, sortOrder }: { active?: boolean; importedPlugins: ImportedPluginControls; query: string; t: PluginInventorySettingsTabProps['t']; drafts: InventoryDraftState; statusFilter: StatusFilter; sortOrder: SortOrder },
): ReactNode {
  const sourceId = useId()
  const [request, setRequest] = useState(0)
  const [selectedIdentity, setSelectedIdentity] = useState<string>()
  const [state, setState] = useState<ImportedViewState>({ status: 'loading' })
  const [mutating, setMutating] = useState<string>()
  const [mutationFailed, setMutationFailed] = useState(false)

  useEffect(() => {
    if (!active) return undefined
    let current = true
    setState({ status: 'loading' })
    void importedPlugins.list().then(
      (snapshot) => { if (current) setState({ status: 'ready', snapshot }) },
      () => { if (current) setState({ status: 'error' }) },
    )
    return () => { current = false }
  }, [active, importedPlugins, request, drafts.revision])

  const normalizedQuery = query.trim().toLocaleLowerCase()
  const groups = useMemo(
    () => {
      if (state.status !== 'ready') return []
      const matching = state.snapshot.plugins.filter((plugin) => {
        const enabled = plugin.enabled
        return matchesQuery([plugin.name, plugin.identity], normalizedQuery)
          && (statusFilter === 'all' || (statusFilter === 'enabled' ? enabled : statusFilter === 'disabled' ? !enabled : false))
      })
      return groupByOwner(matching, plugin => plugin.source.marketplace ?? plugin.source.source)
        .map(group => ({ ...group, items: [...group.items].sort((a, b) => {
          if (sortOrder === 'status' && a.enabled !== b.enabled) return a.enabled ? -1 : 1
          return a.name.localeCompare(b.name)
        }) }))
    },
    [normalizedQuery, sortOrder, state, statusFilter],
  )
  const total = groups.reduce((sum, group) => sum + group.items.length, 0)
  const selectedPlugin = state.status === 'ready'
    ? state.snapshot.plugins.find(plugin => plugin.identity === selectedIdentity)
    : undefined

  const retry = (): void => { setRequest(value => value + 1) }
  const mutate = (identity: string, action: (value: string) => Promise<ImportedPluginSnapshot>): void => {
    setMutating(identity)
    setMutationFailed(false)
    void action(identity).then(
      (snapshot) => { setState({ status: 'ready', snapshot }) },
      () => { setMutationFailed(true) },
    ).finally(() => { setMutating(undefined) })
  }

  return (
    <section className={css.imported} aria-labelledby={`${sourceId}-title`}>
      <div className={css.catalogHeading}>
        <h3 id={`${sourceId}-title`}>{t('importedPlugins')}</h3>
        {state.status === 'ready' ? <span>{total}</span> : null}
      </div>
      {state.status === 'loading' ? <p className={css.status}>{t('loading')}</p> : null}
      {state.status === 'error' ? (
        <div className={css.failure}>
          <p role="alert">{t('importedPluginLoadError')}</p>
          <button type="button" onClick={retry}>{t('importedPluginRetry')}</button>
        </div>
      ) : null}
      {mutationFailed ? <p className={css.mutationFailure} role="alert">{t('importedPluginMutationError')}</p> : null}
      {state.status === 'ready' && state.snapshot.plugins.length === 0 ? <p className={css.status}>{t('importedPluginEmpty')}</p> : null}
      {state.status === 'ready' && state.snapshot.plugins.length > 0 && total === 0 ? <p className={css.status}>{t('emptySearch')}</p> : null}
      {groups.map(group => (
        <section className={css.marketplaceGroup} key={group.owner} aria-label={group.owner}>
          <h4 className={css.marketplaceGroupHeading}>{group.owner}</h4>
          <ul className={css.inventoryRows}>
            {group.items.map((plugin: ImportedPluginEntry) => (
              <li className={css.inventoryRow} key={plugin.identity} data-imported-plugin={plugin.identity} data-selected={selectedIdentity === plugin.identity ? 'true' : undefined} data-plugin-changed={drafts.changedImported.includes(plugin.identity) ? 'true' : undefined}>
                <div className={css.rowMain} role="button" tabIndex={0} aria-expanded={selectedIdentity === plugin.identity}
                  onClick={() => { setSelectedIdentity(plugin.identity) }} onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelectedIdentity(plugin.identity) }
                  }}>
                  <span className={css.pluginIdentity}><strong>{plugin.name}</strong><code>{plugin.identity}</code></span>
                  <span className={css.typeTag}>{t('extensionType')}</span>
                  <span className={css.runtime} data-status={plugin.enabled ? 'running' : 'stopped'}><span className={css.statusDot} aria-hidden="true" />{plugin.enabled ? t('runtimeRunning') : t('runtimeStopped')}</span>
                </div>
                <div className={css.rowControl}>
                  <label className={css.switchControl} onClick={(event) => { event.stopPropagation() }}>
                    <span>{mutating === plugin.identity ? t('saving') : plugin.enabled ? t('enabledTag') : t('disabledTag')}</span>
                    <Switch
                      checked={plugin.enabled}
                      disabled={drafts.saving || mutating === plugin.identity}
                      aria-label={`${t(plugin.enabled ? 'importedPluginDisable' : 'importedPluginEnable')} ${plugin.name}`}
                      onClick={() => { mutate(plugin.identity, plugin.enabled ? importedPlugins.disable : importedPlugins.enable) }}
                    />
                  </label>
                  <Button variant="outline" size="sm" disabled={drafts.saving || mutating === plugin.identity} onClick={(event) => { event.stopPropagation(); mutate(plugin.identity, importedPlugins.remove) }}>
                    {t('importedPluginRemove')}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
          {selectedPlugin === undefined || !group.items.some(plugin => plugin.identity === selectedPlugin.identity) ? null : (
            <Modal
              open
              title={selectedPlugin.name}
              description={selectedPlugin.identity}
              closeLabel={t('closeDetails')}
              onClose={() => { setSelectedIdentity(undefined) }}
            >
              <table className={css.detailTable}><tbody>
                <tr><th scope="row">{t('descriptionColumn')}</th><td className={css.detailText}>{selectedPlugin.description ?? t('metadataMissing')}</td></tr>
                <tr><th scope="row">{t('applicationColumn')}</th><td className={css.detailText}>{selectedPlugin.application ?? t('metadataMissing')}</td></tr>
                <tr><th scope="row">{t('versionColumn')}</th><td>{selectedPlugin.version}</td></tr>
                <tr><th scope="row">{t('sourceColumn')}</th><td><code>{selectedPlugin.source.kind}: {selectedPlugin.source.source}</code></td></tr>
                <tr><th scope="row">{t('skillsColumn')}</th><td>{selectedPlugin.skills.length}</td></tr>
                <tr><th scope="row">{t('mcpServersColumn')}</th><td>{selectedPlugin.mcpServers.length}</td></tr>
                <tr><th scope="row">{t('hooksColumn')}</th><td>{selectedPlugin.hooks.length}</td></tr>
              </tbody></table>
              {drafts.dirtyImported.includes(selectedPlugin.identity) ? <p className={css.status}>{t('unsaved')}</p> : null}
              {drafts.changedImported.includes(selectedPlugin.identity) ? <p className={css.status}>{t('changedSinceStart')}</p> : null}
            </Modal>
          )}
        </section>
      ))}
    </section>
  )
}

/** Render native Hydra plugins together with imported OpenAI/Codex bundles: everything the agent can use. */
export function PluginInventorySettingsTab(
  { active, nativePlugins, importedPlugins, query, t, usePluginDrafts, savePlugins, discardPluginChanges }: PluginInventorySettingsTabProps,
): ReactNode {
  const [restartCount, setRestartCount] = useState(0)
  const [typeFilter, setTypeFilter] = useState<NativeTypeFilter>('all')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [sortOrder, setSortOrder] = useState<SortOrder>('name')
  const drafts = usePluginDrafts(value => value)
  const dirty = drafts.dirtyNative.length + drafts.dirtyImported.length
  if (nativePlugins === undefined) return <p className={css.status}>{t('pluginUnavailable')}</p>
  return (
    <div className={css.section}>
      <div className={css.filterBar} aria-label={t('filters')}>
        <label><span>{t('typeColumn')}</span><select data-hydra-control="compact" value={typeFilter} onChange={(event) => { setTypeFilter(event.currentTarget.value as NativeTypeFilter) }}>
          <option value="all">{t('allTypes')}</option><option value="core">{t('coreType')}</option><option value="extension">{t('extensionType')}</option><option value="preset">{t('presetType')}</option>
        </select></label>
        <label><span>{t('statusFilter')}</span><select data-hydra-control="compact" value={statusFilter} onChange={(event) => { setStatusFilter(event.currentTarget.value as StatusFilter) }}>
          <option value="all">{t('allStatus')}</option><option value="enabled">{t('statusEnabled')}</option><option value="disabled">{t('statusDisabled')}</option><option value="restart">{t('statusRestart')}</option>
        </select></label>
        <label><span>{t('sortLabel')}</span><select data-hydra-control="compact" value={sortOrder} onChange={(event) => { setSortOrder(event.currentTarget.value as SortOrder) }}>
          <option value="name">{t('sortName')}</option><option value="status">{t('sortStatus')}</option>
        </select></label>
      </div>
      {restartCount > 0 ? <div className={css.coreBanner} role="status"><strong>{t('restartFooter')}</strong><span>{restartCount} {t('restartCount')}</span></div> : null}
      <NativePluginCatalog
        active={active} nativePlugins={nativePlugins} onRestartRequiredChange={setRestartCount} query={query} t={t} drafts={drafts}
        typeFilter={typeFilter} statusFilter={statusFilter} sortOrder={sortOrder}
      />
      {importedPlugins === undefined || (typeFilter !== 'all' && typeFilter !== 'extension') || statusFilter === 'restart' ? null : (
        <ImportedPluginCatalog
          active={active} importedPlugins={importedPlugins} query={query} t={t} drafts={drafts}
          statusFilter={statusFilter} sortOrder={sortOrder}
        />
      )}
      {dirty > 0 || drafts.error !== null ? <div className={css.saveFooter}>
        {drafts.error === null ? null : <p className={css.mutationFailure} role="alert">{t('saveError')} {drafts.error}</p>}
        <div className={css.saveActions}>
          <span>{`${dirty} ${t('pendingChanges')}`}</span>
          <Button variant="outline" size="sm" disabled={drafts.saving || dirty === 0} onClick={discardPluginChanges}>{t('discard')}</Button>
          <Button size="sm" disabled={drafts.saving || dirty === 0} onClick={() => { void savePlugins() }}>{t(drafts.saving ? 'saving' : 'saveAll')}</Button>
        </div>
      </div> : null}
    </div>
  )
}

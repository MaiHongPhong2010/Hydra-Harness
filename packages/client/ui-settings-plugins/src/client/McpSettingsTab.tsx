/** Obsidian and imported-plugin MCP controls in the dedicated Plugins tab. */

import { useEffect, useState } from 'react'
import type { ImportedPluginSnapshot, PluginInventorySnapshot } from '@hydraharness/harness-api-remotes/client'
import { Switch } from '@hydraharness/harness-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@hydraharness/harness-client-ui-slots'
import { SecretField } from './fields.tsx'
import { McpServerCatalog, type UserMcpControls } from './McpServerCatalog.tsx'
import { PluginCard } from './PluginCard.tsx'
import type { McpSettingsFace } from './mcp-settings-controller.ts'
import css from './PluginsSettingsSection.module.css'

/** Props the renderer binds for the MCP tab. */
export type McpSettingsTabProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'settings.plugins'>
  & InjectFace<McpSettingsFace & ImportedMcpSettingsFace & NativeMcpSettingsFace & UserMcpSettingsFace>

const OBSIDIAN_MCP_MODULE = '@hydraharness/harness-obsidian-knowledge'

type ImportedMcpStartupState = ImportedPluginSnapshot['plugins'][number]['mcpServers'][number]['startupState']
type ImportedMcpApproval = 'ask' | 'allow' | 'deny'

function importedMcpApprovalLabel(
  approval: ImportedMcpApproval,
  t: McpSettingsTabProps['t'],
): string {
  switch (approval) {
    case 'allow': return t('mcpApprovalAllow')
    case 'deny': return t('mcpApprovalDeny')
    case 'ask': return t('mcpApprovalAsk')
    /* v8 ignore next -- every ImportedMcpApproval member is handled above. */
    default: return approval
  }
}

function importedMcpStatusLabel(
  state: ImportedMcpStartupState,
  t: McpSettingsTabProps['t'],
): string {
  switch (state) {
    case 'not-started': return t('mcpServerNotStarted')
    case 'starting': return t('mcpServerStarting')
    case 'started': return t('mcpServerConnected')
    case 'failed': return t('mcpServerFailed')
    /* v8 ignore next -- every ImportedMcpStartupState member is handled above. */
    default: return state
  }
}

/** Imported MCP controls that remain separate from the owning bundle lifecycle. */
export interface ImportedMcpSettingsFace {
  importedMcp?: {
    list: () => Promise<ImportedPluginSnapshot>
    setEnabled: (identity: string, server: string, enabled: boolean) => Promise<ImportedPluginSnapshot>
    setToolApproval?: (
      identity: string,
      server: string,
      tool: string,
      approval: 'ask' | 'allow' | 'deny',
    ) => Promise<ImportedPluginSnapshot>
  }
}

/** The user's own MCP server records; available only in the local desktop app. */
export interface UserMcpSettingsFace {
  userMcp?: UserMcpControls
  /** Hide Host provider credentials on a workspace form. */
  workspace?: boolean
}

/** Local controls for the native Obsidian MCP plugin. */
export interface NativeMcpSettingsFace {
  nativeMcp?: {
    list: () => Promise<PluginInventorySnapshot>
  }
}

/** Render the current MCP setup without exposing its stored credential. */
export function McpSettingsTab(props: McpSettingsTabProps) {
  const { t, active } = props
  const state = props.useMcpSettings(snapshot => snapshot)
  const [request, setRequest] = useState(0)
  const [imported, setImported] = useState<ImportedPluginSnapshot>()
  const [native, setNative] = useState<PluginInventorySnapshot>()
  const [importedMutating, setImportedMutating] = useState<string>()
  const [importedFailed, setImportedFailed] = useState(false)
  const [nativeLoadFailed, setNativeLoadFailed] = useState(false)
  const [importedLoadFailed, setImportedLoadFailed] = useState(false)

  useEffect(() => {
    if (!active || props.importedMcp === undefined) return undefined
    let current = true
    setImportedLoadFailed(false)
    void props.importedMcp.list().then((snapshot) => {
      if (current) {
        setImported(snapshot)
      }
    }, () => { if (current) setImportedLoadFailed(true) })
    return () => { current = false }
  }, [active, props.importedMcp, request])

  useEffect(() => {
    if (!active || props.nativeMcp === undefined) return undefined
    let current = true
    setNativeLoadFailed(false)
    void props.nativeMcp.list().then(
      (snapshot) => { if (current) setNative(snapshot) },
      () => { if (current) setNativeLoadFailed(true) },
    )
    return () => { current = false }
  }, [active, props.nativeMcp, request])

  const setImportedEnabled = (identity: string, server: string, enabled: boolean): void => {
    /* v8 ignore if -- server switches render only while importedMcp is supplied. */
    if (props.importedMcp === undefined) return
    setImportedMutating(`${identity}:${server}`)
    setImportedFailed(false)
    void props.importedMcp.setEnabled(identity, server, enabled).then(
      setImported,
      () => { setImportedFailed(true); setRequest(value => value + 1) },
    ).finally(() => { setImportedMutating(undefined) })
  }

  const setImportedToolApproval = (
    identity: string,
    server: string,
    tool: string,
    approval: ImportedMcpApproval,
  ): void => {
    const action = props.importedMcp?.setToolApproval
    /* v8 ignore if -- approval controls render only when the setter is supplied. */
    if (action === undefined) return
    const mutation = `${identity}:${server}:${tool}`
    setImportedMutating(mutation)
    setImportedFailed(false)
    void action(identity, server, tool, approval).then(
      setImported,
      () => { setImportedFailed(true); setRequest(value => value + 1) },
    ).finally(() => { setImportedMutating(undefined) })
  }

  const normalizedQuery = props.query.trim().toLocaleLowerCase()
  const matchesQuery = (haystack: readonly string[]): boolean => normalizedQuery.length === 0
    || haystack.some(value => value.toLocaleLowerCase().includes(normalizedQuery))
  const nativeMatchesQuery = matchesQuery([t('mcpTitle'), OBSIDIAN_MCP_MODULE])
  const nativeEntry = native?.entries.find(entry => entry.moduleName === OBSIDIAN_MCP_MODULE)
  // The plugin inventory remains available while a disabled plugin's settings
  // namespace is absent. Its credential is independent, so keep the card
  // editable whenever the Host confirms that the plugin is composed.
  const nativeState = nativeEntry === undefined || state.available
    ? state
    : { ...state, available: true }
  const nativeControl = nativeEntry === undefined ? null : (
    <span className={css.nativeStatus}>{nativeEntry.enabled ? t('mcpEnabled') : t('disabled')}</span>
  )

  const importedRows = imported?.plugins.flatMap(plugin => plugin.mcpServers.map(server => ({ plugin, server })))
    .filter(({ plugin, server }) => matchesQuery([server.name, plugin.name, plugin.identity])) ?? []

  if (!state.available && props.importedMcp === undefined && props.nativeMcp === undefined && props.userMcp === undefined) return <p className={css.empty}>{t('mcpUnavailable')}</p>
  return (
    <div className={css.cards} role="list">
      {nativeLoadFailed || importedLoadFailed ? (
        <div>
          <p role="alert">{t('mcpLoadError')}</p>
          <button type="button" onClick={() => { setRequest(value => value + 1) }}>{t('mcpRetry')}</button>
        </div>
      ) : null}
      {props.userMcp === undefined
        ? null
        : <McpServerCatalog active={active} controls={props.userMcp} query={props.query} t={t} workspace={props.workspace ?? false} />}
      {!props.workspace && (state.available || nativeEntry !== undefined) && nativeMatchesQuery ? <PluginCard
        t={t}
        titleKey="mcpTitle"
        descriptionKey="mcpDescription"
        state={nativeState}
        onSave={props.save}
        onDiscard={props.discard}
        action={nativeControl}
      >
        <SecretField
          id="plugin-mcp-obsidian-key"
          label={t('mcpApiKey')}
          hint={t('mcpApiKeyHint')}
          disabled={!state.apiKeyWritable}
          text={state.apiKey.text}
          configured={state.apiKeyConfigured}
          stateLabel={state.apiKeyConfigured ? t('mcpApiKeySet') : t('mcpApiKeyUnset')}
          onEdit={(text) => { props.edit('apiKey', text) }}
        />
      </PluginCard> : null}
      {!state.available && native === undefined && !nativeLoadFailed && props.nativeMcp !== undefined ? <p className={css.empty}>{t('mcpLoading')}</p> : null}
      {props.importedMcp !== undefined ? (
        <section className={css.importedMcp} aria-labelledby="imported-mcp-title">
          <h3 id="imported-mcp-title">{t('importedMcpTitle')}</h3>
          {imported === undefined && !importedLoadFailed ? <p className={css.empty}>{t('mcpLoading')}</p> : null}
          {imported !== undefined && importedRows.length === 0
            ? <p className={css.empty}>{imported.plugins.length === 0 ? t('importedMcpEmpty') : t('importedMcpEmptySearch')}</p>
            : null}
          {importedFailed ? <p className={css.empty} role="alert">{t('mcpToggleFailed')}</p> : null}
          {importedRows.map(({ plugin, server }) => (
            <div className={css.importedMcpRow} key={`${plugin.identity}:${server.name}`}>
              <div><strong>{server.name}</strong><code>{plugin.name} · {plugin.identity}</code></div>
              <label className={css.switchControl}>
                <span>{importedMutating === `${plugin.identity}:${server.name}`
                  ? t('saving')
                  : server.enabled ? importedMcpStatusLabel(server.startupState, t) : t('disabled')}</span>
                <Switch
                  checked={server.enabled}
                  disabled={importedMutating !== undefined}
                  aria-label={`${server.enabled ? t('disable') : t('enable')} ${server.name}`}
                  onClick={() => { setImportedEnabled(plugin.identity, server.name, !server.enabled) }}
                />
              </label>
              {props.importedMcp?.setToolApproval === undefined || server.tools.length === 0 ? null : (
                <ul className={css.importedMcpTools}>
                  {server.tools.map((tool) => {
                    const approval = server.toolApproval[tool] ?? server.defaultToolsApprovalMode
                    const mutation = `${plugin.identity}:${server.name}:${tool}`
                    return (
                      <li key={tool} className={css.importedMcpTool}>
                        <code>{tool}</code>
                        <label>
                          <span className={css.visuallyHidden}>{t('mcpToolApproval')} {tool}</span>
                          <select
                            data-hydra-control="field"
                            aria-label={`${t('mcpToolApproval')} ${tool}`}
                            value={approval}
                            disabled={importedMutating !== undefined}
                            onChange={(event) => {
                              setImportedToolApproval(plugin.identity, server.name, tool, event.currentTarget.value as ImportedMcpApproval)
                            }}
                          >
                            {(['ask', 'allow', 'deny'] as const).map(value => (
                              <option key={value} value={value}>{importedMcpApprovalLabel(value, t)}</option>
                            ))}
                          </select>
                        </label>
                        {importedMutating === mutation ? <span>{t('saving')}</span> : null}
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          ))}
        </section>
      ) : null}
    </div>
  )
}

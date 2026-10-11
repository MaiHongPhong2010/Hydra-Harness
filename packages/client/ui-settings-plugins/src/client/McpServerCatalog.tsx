/**
 * The user's own MCP servers: the records stored in the harness settings
 * document, with the add, edit, toggle, and remove controls that write them.
 *
 * A record is created disabled and stays that way until the switch is used, so
 * adding one never starts a process the user has not yet reviewed. Credential
 * values are write-only by construction: the Host returns only the `env` and
 * `header` NAMES a record declares, and leaving those fields blank on an edit
 * keeps the stored values rather than clearing them.
 */

import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import type {
  McpServerDefinitionRequest, McpServerSnapshot, McpServerTransport,
} from '@hydraharness/harness-api-remotes/client'
import { Button, IconPlusOutline16, Input, Modal, Switch } from '@hydraharness/harness-client-ui-primitives'
import type { PluginsSettingsLocaleKey } from './locales.ts'
import css from './PluginsSettingsSection.module.css'

/** Remote controls for the user's own MCP server records. */
export interface UserMcpControls {
  /** Read every stored record with its live state. */
  list: () => Promise<McpServerSnapshot>
  /** Store one complete definition and converge its mount. */
  define: (request: McpServerDefinitionRequest) => Promise<McpServerSnapshot>
  /** Change one record's desired state. */
  setEnabled: (name: string, enabled: boolean) => Promise<McpServerSnapshot>
  /** Delete one record and unmount its server. */
  remove: (name: string) => Promise<McpServerSnapshot>
}

type McpServer = McpServerSnapshot['servers'][number]

type ViewState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly snapshot: McpServerSnapshot }

/** The add/edit form's staged text, before it becomes a definition request. */
interface Draft {
  /** The record this form replaces; empty while adding a new one. */
  editing: string
  name: string
  transport: McpServerTransport
  command: string
  args: string
  env: string
  cwd: string
  url: string
  /** Sanitized endpoint initially returned for an existing HTTP server. */
  originalUrl?: string
  headers: string
}

const EMPTY_DRAFT: Draft = {
  editing: '',
  name: '',
  transport: 'stdio',
  command: '',
  args: '',
  env: '',
  cwd: '',
  url: '',
  headers: '',
}

/** Seed the form from a stored record; the withheld credential maps stay blank. */
function draftFrom(server: McpServer): Draft {
  return {
    editing: server.name,
    name: server.name,
    transport: server.transport,
    command: server.command ?? '',
    args: (server.args ?? []).join('\n'),
    env: '',
    cwd: server.cwd ?? '',
    url: server.url ?? '',
    ...server.transport === 'streamable-http' && server.url !== undefined ? { originalUrl: server.url } : {},
    headers: '',
  }
}

/** Split a textarea into its non-blank trimmed lines. */
function lines(text: string): string[] {
  return text.split(/\r?\n/u).map(line => line.trim()).filter(line => line !== '')
}

/**
 * Parse `NAME=value` lines into a map. An empty text yields `undefined`, which
 * the Host reads as "keep what is stored" — the only way an edit can preserve a
 * value it never received. A line without a name yields `'invalid'`, which
 * blocks the save rather than storing a nameless entry.
 */
function parseAssignments(text: string): Record<string, string> | 'invalid' | undefined {
  const parsed = lines(text)
  if (parsed.length === 0) return undefined
  const entries: Record<string, string> = {}
  for (const line of parsed) {
    const separator = line.indexOf('=')
    const name = separator === -1 ? '' : line.slice(0, separator).trim()
    if (name === '') return 'invalid'
    entries[name] = line.slice(separator + 1).trim()
  }
  return entries
}

/** Which field's value a save refused, when one did. */
type AssignmentFailure = 'env' | 'headers' | 'url'

/** Build the definition request one draft describes, or name the field that blocked it. */
function toRequest(draft: Draft): McpServerDefinitionRequest | AssignmentFailure {
  const env = parseAssignments(draft.env)
  if (env === 'invalid') return 'env'
  const headers = parseAssignments(draft.headers)
  if (headers === 'invalid') return 'headers'
  const shared = {
    mode: draft.editing === '' ? 'create' as const : 'replace' as const,
    name: draft.name.trim(),
    // A blank credential map is an omission, not an empty map: the Host keeps
    // the stored values for an omitted one and clears them for a supplied one.
    ...env === undefined ? {} : { env },
    ...headers === undefined ? {} : { headers },
  }
  if (draft.transport === 'stdio') {
    return {
      ...shared,
      transport: 'stdio',
      command: draft.command.trim(),
      args: lines(draft.args),
      cwd: draft.cwd.trim(),
    }
  }
  const url = draft.url.trim()
  try {
    const parsed = new URL(url)
    if (parsed.username !== '' || parsed.password !== '') return 'url'
  } catch {
    // The Host owns full URL validation; the browser only blocks a secret that
    // must never be embedded in an endpoint or sent through a normal field.
  }
  return { ...shared, transport: 'streamable-http', ...draft.originalUrl === url ? {} : { url } }
}

/** Whether the draft carries enough for its transport to be submitted. */
function submittable(draft: Draft): boolean {
  if (draft.name.trim() === '') return false
  return draft.transport === 'stdio' ? draft.command.trim() !== '' : draft.url.trim() !== ''
}

/** Localized one-line status for one record. */
function statusLabel(server: McpServer, t: (key: PluginsSettingsLocaleKey) => string): string {
  switch (server.status) {
    case 'started': return t('userMcpStarted')
    case 'starting': return t('userMcpStarting')
    case 'failed': return t('userMcpFailed')
    case 'invalid': return t('userMcpInvalid')
    default: return t('disabled')
  }
}

/**
 * Render the user's own MCP server records with their write controls.
 * @param props.controls - the Host record operations.
 * @param props.query - the section's shared search text.
 * @param props.t - the section's bound dictionary.
 * @returns the catalog, its add/edit dialog, and any failure notice.
 */
export function McpServerCatalog({ active = true, controls, query, t, workspace = false }: {
  active?: boolean
  controls: UserMcpControls
  query: string
  t: (key: PluginsSettingsLocaleKey) => string
  workspace?: boolean
}): ReactNode {
  const [request, setRequest] = useState(0)
  const [state, setState] = useState<ViewState>({ status: 'loading' })
  const [draft, setDraft] = useState<Draft>()
  const [saving, setSaving] = useState(false)
  const [mutating, setMutating] = useState<string>()
  const [failure, setFailure] = useState<'save' | 'mutate' | 'env' | 'headers' | 'url' | 'name'>()

  useEffect(() => {
    if (!active) return undefined
    let current = true
    setState({ status: 'loading' })
    void controls.list().then(
      (snapshot) => { if (current) setState({ status: 'ready', snapshot }) },
      () => { if (current) setState({ status: 'error' }) },
    )
    return () => { current = false }
  }, [active, controls, request])

  const busy = saving || mutating !== undefined
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const servers = state.status === 'ready'
    ? state.snapshot.servers.filter(server => normalizedQuery === ''
      || [server.name, server.command ?? '', server.url ?? '', ...server.tools]
        .some(value => value.toLocaleLowerCase().includes(normalizedQuery)))
    : []

  const close = (): void => {
    if (saving) return
    setDraft(undefined)
    setFailure(undefined)
  }

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (draft === undefined || !submittable(draft)) return
    if (draft.editing === '' && state.status === 'ready'
      && state.snapshot.servers.some(server => server.name === draft.name.trim())) {
      setFailure('name')
      return
    }
    const definition = toRequest(draft)
    if (definition === 'env' || definition === 'headers' || definition === 'url') {
      setFailure(definition)
      return
    }
    setSaving(true)
    setFailure(undefined)
    void controls.define(definition).then(
      (snapshot) => {
        setState({ status: 'ready', snapshot })
        setDraft(undefined)
      },
      () => { setFailure('save') },
    ).finally(() => { setSaving(false) })
  }

  const mutate = (name: string, action: () => Promise<McpServerSnapshot>): void => {
    setMutating(name)
    setFailure(undefined)
    void action().then(
      (snapshot) => { setState({ status: 'ready', snapshot }) },
      () => { setFailure('mutate') },
    ).finally(() => { setMutating(undefined) })
  }

  return (
    <section className={css.userMcp} aria-labelledby="user-mcp-title" aria-busy={state.status === 'loading' || busy}>
      <div className={css.userMcpHeading}>
        <h3 id="user-mcp-title">{t('userMcpTitle')}</h3>
        <Button
          variant="toolbar"
          size="sm"
          icon={<IconPlusOutline16 aria-hidden="true" />}
          disabled={busy}
          onClick={() => { setFailure(undefined); setDraft(EMPTY_DRAFT) }}
        >
          {t('userMcpAdd')}
        </Button>
      </div>
      <p className={css.empty}>{t('userMcpDescription')}</p>
      {state.status === 'loading' ? <p className={css.empty}>{t('mcpLoading')}</p> : null}
      {state.status === 'error' ? (
        <div className={css.userMcpFailure}>
          <p role="alert">{t('userMcpLoadError')}</p>
          <button type="button" onClick={() => { setRequest(value => value + 1) }}>{t('userMcpRetry')}</button>
        </div>
      ) : null}
      {failure === 'mutate' ? <p className={css.empty} role="alert">{t('userMcpMutationError')}</p> : null}
      {state.status === 'ready' && state.snapshot.servers.length === 0
        ? <p className={css.empty}>{t('userMcpEmpty')}</p>
        : null}
      {state.status === 'ready' && state.snapshot.servers.length > 0 && servers.length === 0
        ? <p className={css.empty}>{t('userMcpEmptySearch')}</p>
        : null}
      {servers.map(server => (
        <div className={css.userMcpRow} key={server.name} data-user-mcp={server.name}>
          <div className={css.userMcpIdentity}>
            <strong>{server.name}</strong>
            <code>{server.transport === 'stdio'
              ? [server.command, ...server.args ?? []].join(' ')
              : server.url}</code>
            <span className={css.userMcpStatus}>{mutating === server.name ? t('saving') : statusLabel(server, t)}</span>
            {server.detail === undefined ? null : <span className={css.userMcpDetail}>{server.detail}</span>}
            {server.tools.length === 0
              ? null
              : <span className={css.userMcpStatus}>{t('userMcpTools')}: {server.tools.join(', ')}</span>}
            {server.envNames.length === 0
              ? null
              : <span className={css.userMcpStatus}>{t('userMcpEnvStored')}: {server.envNames.join(', ')}</span>}
            {server.headerNames.length === 0
              ? null
              : <span className={css.userMcpStatus}>{t('userMcpHeadersStored')}: {server.headerNames.join(', ')}</span>}
          </div>
          <div className={css.userMcpActions}>
            <label className={css.switchControl}>
              <span>{server.enabled ? t('mcpEnabled') : t('disabled')}</span>
              <Switch
                checked={server.enabled}
                disabled={busy}
                aria-label={`${server.enabled ? t('disable') : t('enable')} ${server.name}`}
                onClick={() => { mutate(server.name, () => controls.setEnabled(server.name, !server.enabled)) }}
              />
            </label>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => { setFailure(undefined); setDraft(draftFrom(server)) }}
            >
              {t('userMcpEdit')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => { mutate(server.name, () => controls.remove(server.name)) }}
            >
              {t('userMcpRemove')}
            </Button>
          </div>
        </div>
      ))}

      <Modal
        open={draft !== undefined}
        onClose={close}
        title={draft?.editing === '' ? t('userMcpAddTitle') : t('userMcpEditTitle')}
        closeLabel={t('userMcpClose')}
        description={t('userMcpFormDescription')}
        footer={(
          <>
            <Button variant="outline" disabled={saving} onClick={close}>{t('userMcpCancel')}</Button>
            <Button
              variant="primary"
              type="submit"
              form="user-mcp-form"
              disabled={saving || draft === undefined || !submittable(draft)}
            >
              {saving ? t('saving') : t('userMcpSave')}
            </Button>
          </>
        )}
      >
        {draft === undefined ? null : (
          <form id="user-mcp-form" className={css.userMcpForm} onSubmit={submit}>
            <label htmlFor="user-mcp-name">{t('userMcpName')}</label>
            <Input
              id="user-mcp-name"
              type="text"
              required
              autoFocus
              value={draft.name}
              placeholder="notes"
              // The name is a record's identity and its tool prefix; renaming
              // through this form would add a second record rather than move
              // the existing one, so an edit pins it.
              disabled={saving || draft.editing !== ''}
              onChange={(event) => { setDraft({ ...draft, name: event.currentTarget.value }) }}
            />
            <label htmlFor="user-mcp-transport">{t('userMcpTransport')}</label>
            <select data-hydra-control="field"
              id="user-mcp-transport"
              value={draft.transport}
              disabled={saving}
              onChange={(event) => {
                setDraft({ ...draft, transport: event.currentTarget.value as McpServerTransport })
              }}
            >
              <option value="stdio">{t('userMcpTransportStdio')}</option>
              <option value="streamable-http">{t('userMcpTransportHttp')}</option>
            </select>
            {draft.transport === 'stdio' ? (
              <>
                <label htmlFor="user-mcp-command">{t('userMcpCommand')}</label>
                <Input
                  id="user-mcp-command"
                  type="text"
                  required
                  value={draft.command}
                  placeholder="npx"
                  disabled={saving}
                  onChange={(event) => { setDraft({ ...draft, command: event.currentTarget.value }) }}
                />
                <label htmlFor="user-mcp-args">{t('userMcpArgs')}</label>
                <textarea data-hydra-control="field"
                  id="user-mcp-args"
                  rows={3}
                  value={draft.args}
                  placeholder={'-y\n@modelcontextprotocol/server-filesystem'}
                  disabled={saving}
                  onChange={(event) => { setDraft({ ...draft, args: event.currentTarget.value }) }}
                />
                <label htmlFor="user-mcp-cwd">{t('userMcpCwd')}</label>
                <Input
                  id="user-mcp-cwd"
                  type="text"
                  value={draft.cwd}
                  disabled={saving}
                  onChange={(event) => { setDraft({ ...draft, cwd: event.currentTarget.value }) }}
                />
                <p className={css.empty}>{t(workspace ? 'userMcpWorkspaceCwdHint' : 'userMcpCwdHint')}</p>
                <label htmlFor="user-mcp-env">{t('userMcpEnv')}</label>
                <textarea data-hydra-control="field"
                  id="user-mcp-env"
                  rows={3}
                  value={draft.env}
                  placeholder="API_TOKEN=…"
                  disabled={saving}
                  onChange={(event) => { setDraft({ ...draft, env: event.currentTarget.value }) }}
                />
                <p className={css.empty}>{t('userMcpEnvHint')}</p>
              </>
            ) : (
              <>
                <label htmlFor="user-mcp-url">{t('userMcpUrl')}</label>
                <Input
                  id="user-mcp-url"
                  type="url"
                  required
                  value={draft.url}
                  placeholder="https://mcp.example.com/v1"
                  disabled={saving}
                  onChange={(event) => { setDraft({ ...draft, url: event.currentTarget.value }) }}
                />
                <label htmlFor="user-mcp-headers">{t('userMcpHeaders')}</label>
                <textarea data-hydra-control="field"
                  id="user-mcp-headers"
                  rows={3}
                  value={draft.headers}
                  placeholder="Authorization=Bearer …"
                  disabled={saving}
                  onChange={(event) => { setDraft({ ...draft, headers: event.currentTarget.value }) }}
                />
                <p className={css.empty}>{t('userMcpHeadersHint')}</p>
              </>
            )}
            {failure === 'env' ? <p className={css.saveFailed} role="alert">{t('userMcpEnvInvalid')}</p> : null}
            {failure === 'headers' ? <p className={css.saveFailed} role="alert">{t('userMcpHeadersInvalid')}</p> : null}
            {failure === 'url' ? <p className={css.saveFailed} role="alert">{t('userMcpUrlInvalid')}</p> : null}
            {failure === 'save' ? <p className={css.saveFailed} role="alert">{t('userMcpSaveError')}</p> : null}
            {failure === 'name' ? <p className={css.saveFailed} role="alert">{t('userMcpNameTaken')}</p> : null}
          </form>
        )}
      </Modal>
    </section>
  )
}

/** Public types for the user-declared MCP server registry. */

import type {} from '@hydraharness/cordis'

/** Transport a stored record selects; the record carries both transports' fields. */
export type McpServerTransport = 'stdio' | 'streamable-http'

/**
 * Live state of one stored record. `invalid` is a stored record this registry
 * refuses to mount (a hand-edited document), never a transport failure.
 */
export type McpServerStatus = 'stopped' | 'starting' | 'started' | 'failed' | 'invalid'

/**
 * One stored server as a configuration surface sees it. Secret positions never
 * ride: `envNames` and `headerNames` carry only the names the record declares,
 * so a form can list and clear them without ever receiving a value.
 */
export interface McpServerView {
  readonly name: string
  readonly transport: McpServerTransport
  /** Desired state stored in the document, independent of {@link status}. */
  readonly enabled: boolean
  readonly status: McpServerStatus
  /** Why a record is `invalid`, or the mount failure summary; never carries a stored value. */
  readonly detail?: string
  /** Executable of a stdio record; absent for a remote one. */
  readonly command?: string
  readonly args?: readonly string[]
  /** Working directory of a stdio record; absent when the record leaves it empty. */
  readonly cwd?: string
  /** Endpoint without URL userinfo, query or fragment; absent for stdio. */
  readonly url?: string
  /** Declared child-environment names, values withheld. */
  readonly envNames: readonly string[]
  /** Declared request-header names, values withheld. */
  readonly headerNames: readonly string[]
  readonly toolCallTimeoutMs: number
  /** Currently registered, host-qualified MCP tool names. */
  readonly tools: readonly string[]
}

/** Complete immutable projection returned by every registry operation. */
export interface McpServerSnapshot {
  readonly servers: readonly McpServerView[]
}

/**
 * Complete definition of one server. A write replaces the named record
 * wholesale, so an omitted optional field clears the stored one — except
 * `env`, `headers` and `url`, whose omission keeps the stored values a redacted
 * caller never received.
 */
export interface McpServerDefinitionRequest {
  /** Create requires an unused name; replace requires an existing record. */
  readonly mode: 'create' | 'replace'
  /** Stable local namespace for this server's tool names; `[A-Za-z0-9_-]{1,32}`. */
  readonly name: string
  readonly transport: McpServerTransport
  /** Executable for a stdio record; required by that transport. */
  readonly command?: string
  readonly args?: readonly string[]
  /** Child environment merged over the scrubbed ambient environment. */
  readonly env?: Readonly<Record<string, string>>
  /** Working directory; omitted/relative values use the registry's owning cwd when configured. */
  readonly cwd?: string
  /** HTTP endpoint; required on create, omission on replace preserves its stored secret values. */
  readonly url?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly toolCallTimeoutMs?: number
  /** Desired state; a new record defaults to disabled. */
  readonly enabled?: boolean
}

/** Change one stored record's desired state without touching its definition. */
export interface McpServerEnablementRequest {
  readonly name: string
  readonly enabled: boolean
}

declare module '@hydraharness/cordis' {
  interface Events {
    /**
     * The mounted server set now matches the stored records. Emitted after each
     * reconciliation settles — including the one at startup and the ones a
     * document change triggers — so an observer never reads the projection
     * between a committed record change and the mount that follows it.
     * @param snapshot - the projection as of this reconciliation.
     * @mode emit
     */
    'mcp-servers/reconciled'(snapshot: McpServerSnapshot): void
  }
}

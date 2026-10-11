/**
 * Settings-backed MCP record storage and mount reconciliation. The MCP SDK is
 * mocked so a mount is observable without a real server process; what the
 * document holds is asserted against the file on disk.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@hydraharness/cordis'
import SystemPrompt from '@hydraharness/harness-system-prompt'
import ToolRuntime from '@hydraharness/harness-tools'
import FileSettingsProvider from '@hydraharness/harness-settings-file'
import { SettingsConflictError } from '@hydraharness/harness-settings'
import { createScope, scopeOf } from '@hydraharness/harness-scope'

const { mockConnect, mockClose, mockListTools, MockClient, mockStdioTransport } = vi.hoisted(() => {
  const mockConnect = vi.fn<() => Promise<void>>()
  const mockClose = vi.fn<() => Promise<void>>()
  const mockListTools = vi.fn<(_params?: Record<string, unknown>) => Promise<unknown>>()
  const mockRequest = vi.fn(async (request: { method: string; params?: Record<string, unknown> }): Promise<unknown> => {
    if (request.method === 'tools/list') return await mockListTools(request.params)
    throw new Error(`unexpected MCP request: ${request.method}`)
  })
  class MockClient {
    connect = mockConnect
    close = mockClose
    listTools = mockListTools
    request = mockRequest
    setNotificationHandler = vi.fn()
  }
  return { mockConnect, mockClose, mockListTools, MockClient, mockStdioTransport: vi.fn() }
})

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({ Client: MockClient }))
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({ StdioClientTransport: mockStdioTransport }))
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({ StreamableHTTPClientTransport: vi.fn() }))

import McpServerRegistry, { MCP_SERVERS_SETTINGS_NAMESPACE } from '@hydraharness/harness-mcp-registry/src/index.ts'
import type { McpServerSnapshot } from '@hydraharness/harness-mcp-registry/src/types.ts'

const contexts: Context[] = []
const directories: string[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
  mockConnect.mockReset()
  mockClose.mockReset()
  mockListTools.mockReset()
  mockStdioTransport.mockClear()
})

const STDIO = {
  mode: 'create' as const,
  name: 'notes',
  transport: 'stdio' as const,
  command: 'node',
  args: ['--version'],
  env: { NOTES_TOKEN: 'secret-value' },
}

async function mount(settingsPath: string): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(FileSettingsProvider, { path: settingsPath, watch: false })
  await ctx.plugin(McpServerRegistry)
  return ctx
}

async function harness(): Promise<{ ctx: Context; registry: McpServerRegistry; settingsPath: string }> {
  primeSdk()
  const root = await mkdtemp(join(tmpdir(), 'hydra-mcp-registry-'))
  directories.push(root)
  const settingsPath = join(root, 'settings.yaml')
  const ctx = await mount(settingsPath)
  return { ctx, registry: ctx.get('mcpServers') as McpServerRegistry, settingsPath }
}

/**
 * A server that connects and lists one tool. `close` fires `onclose` because
 * the supervisor waits for the transport-owned close signal before it treats a
 * generation as gone.
 */
function primeSdk(): void {
  mockConnect.mockResolvedValue(undefined)
  mockClose.mockImplementation(function (this: { onclose?: () => void }) {
    this.onclose?.()
    return Promise.resolve()
  })
  mockListTools.mockResolvedValue({
    tools: [{ name: 'read', description: 'Read one note', inputSchema: { type: 'object' } }],
    nextCursor: undefined,
  })
}

/**
 * An external document write returns as soon as the section is committed; the
 * mounts it implies follow on the registry's own chain. `mcp-servers/reconciled`
 * is the settled edge, so a test that asserts mount state waits for it.
 */
function nextReconciliation(ctx: Context): Promise<McpServerSnapshot> {
  const settled: PromiseWithResolvers<McpServerSnapshot> = Promise.withResolvers()
  const off = ctx.on('mcp-servers/reconciled', (snapshot) => {
    off()
    settled.resolve(snapshot)
  })
  return settled.promise
}

describe('stored records', () => {
  it('reports selected shared definitions as stopped when a different local definition runs', async () => {
    const { ctx, registry, settingsPath } = await harness()
    await registry.define({ ...STDIO, command: 'shared-a', enabled: true })
    const sharedCtx = createScope(ctx, { layer: 'shared-view' }).ctx.isolate('settings')
    const localCtx = createScope(ctx, { layer: 'local-view' }).ctx.isolate('settings').isolate('mcpServers')
    await sharedCtx.plugin(FileSettingsProvider, { path: `${settingsPath}.shared-view.yaml`, watch: false })
    await localCtx.plugin(FileSettingsProvider, { path: `${settingsPath}.local-view.yaml`, watch: false })
    const shared = sharedCtx.get('settings')!
    const local = localCtx.get('settings')!
    shared.inherit(ctx.get('settings')!, [MCP_SERVERS_SETTINGS_NAMESPACE])
    local.inherit(shared, [MCP_SERVERS_SETTINGS_NAMESPACE])
    await localCtx.plugin(McpServerRegistry)
    const runtime = localCtx.get('mcpServers')!
    await runtime.define({ ...STDIO, mode: 'replace', command: 'local-b', enabled: true }, local)
    expect(runtime.list().servers[0]).toMatchObject({ command: 'local-b', status: 'started', tools: ['mcp__notes__read'] })
    expect(runtime.list(shared).servers[0]).toMatchObject({ command: 'shared-a', status: 'stopped', tools: [] })
    await runtime.define({ ...STDIO, mode: 'replace', command: 'local-b', enabled: false }, shared)
    expect(runtime.list(shared).servers[0]).toMatchObject({ enabled: false, status: 'stopped', tools: [] })
  })

  it('resolves omitted and relative server working directories from the registry workspace', async () => {
    const { ctx, settingsPath } = await harness()
    const root = join(settingsPath, '..')
    const workspace = createScope(ctx, { workspace: 'cwd' })
    const owner = workspace.ctx.isolate('settings').isolate('mcpServers')
    await owner.plugin(FileSettingsProvider, { path: `${settingsPath}.workspace.yaml`, watch: false })
    await owner.plugin(McpServerRegistry, { cwd: root })
    const registry = owner.get('mcpServers')!
    await registry.define({ ...STDIO, enabled: true })
    expect(mockStdioTransport.mock.calls.at(-1)?.[0]).toMatchObject({ cwd: root })
    await registry.define({ ...STDIO, mode: 'replace', cwd: 'scripts', enabled: true })
    expect(mockStdioTransport.mock.calls.at(-1)?.[0]).toMatchObject({ cwd: join(root, 'scripts') })
    await expect(owner.isolate('mcpServers').plugin(McpServerRegistry, { cwd: 'relative' })).rejects.toThrow('cwd must be absolute')
  })

  it('withholds URL query and fragment values while preserving an omitted URL on replacement', async () => {
    const { registry, settingsPath } = await harness()
    const url = 'https://mcp.example.test/v1?token=private-query#private-fragment'
    await registry.define({ mode: 'create', name: 'remote', transport: 'streamable-http', url })
    expect(registry.list().servers[0]?.url).toBe('https://mcp.example.test/v1')
    expect(JSON.stringify(registry.list())).not.toContain('private-')
    mockConnect.mockRejectedValueOnce(new Error(`cannot reach ${url}`))
    await registry.define({ mode: 'replace', name: 'remote', transport: 'streamable-http', enabled: true })
    expect(registry.list().servers[0]?.status).toBe('failed')
    expect(JSON.stringify(registry.list())).not.toContain('private-')
    expect(await readFile(settingsPath, 'utf8')).toContain(url)
    await registry.define({ mode: 'replace', name: 'remote', transport: 'streamable-http', url: 'https://mcp.example.test/new' })
    expect(await readFile(settingsPath, 'utf8')).not.toContain('private-query')
  })
  it('writes the selected layer without copying local secrets and preserves edits when trust is off', async () => {
    const { ctx, registry, settingsPath } = await harness()
    await registry.define({ ...STDIO, command: 'global', env: { TOKEN: 'global-secret' } })
    const sharedScope = createScope(ctx, { layer: 'shared' })
    const localScope = createScope(ctx, { layer: 'local' })
    const sharedCtx = sharedScope.ctx.isolate('settings')
    const localCtx = localScope.ctx.isolate('settings')
    const sharedPath = `${settingsPath}.shared.yaml`
    const localPath = `${settingsPath}.local.yaml`
    await sharedCtx.plugin(FileSettingsProvider, { path: sharedPath, watch: false })
    await localCtx.plugin(FileSettingsProvider, { path: localPath, watch: false })
    const shared = sharedCtx.get('settings')!
    const local = localCtx.get('settings')!
    shared.inherit(ctx.get('settings')!, [MCP_SERVERS_SETTINGS_NAMESPACE])
    local.inherit(shared, [MCP_SERVERS_SETTINGS_NAMESPACE])
    await registry.define({ ...STDIO, mode: 'replace', command: 'shared', env: { TOKEN: 'shared-secret' } }, shared)
    await registry.define({ ...STDIO, mode: 'replace', command: 'local', env: { TOKEN: 'local-secret' } }, local)
    const localBefore = await readFile(localPath, 'utf8')
    await registry.define({ mode: 'replace', name: 'notes', transport: 'stdio', command: 'shared-new' }, shared)
    expect(await readFile(sharedPath, 'utf8')).toContain('shared-secret')
    expect(await readFile(sharedPath, 'utf8')).not.toContain('local-secret')
    expect(await readFile(localPath, 'utf8')).toBe(localBefore)

    shared.setLayerEnabled(false)
    await registry.setEnabled({ name: 'notes', enabled: true }, shared)
    expect(registry.list(shared).servers[0]).toMatchObject({ command: 'shared-new', enabled: true })
    expect(registry.list(local).servers[0]?.command).toBe('local')
    await registry.remove('notes', shared)
    await registry.settle()
    expect(registry.list(shared).servers).toEqual([])
    expect(registry.list(local).servers[0]?.command).toBe('local')
    expect(registry.list().servers[0]?.command).toBe('global')
  })

  it('keeps same-name workspace servers, writes, snapshots, and disposal independent', async () => {
    const { ctx, registry: globalRegistry, settingsPath } = await harness()
    await ctx.settings.replace(MCP_SERVERS_SETTINGS_NAMESPACE, { servers: [] })
    const before = await readFile(settingsPath, 'utf8')
    const first = createScope(ctx, { workspace: 'first' })
    const second = createScope(ctx, { workspace: 'second' })
    const owners = [first, second].map(scope => scope.ctx.isolate('settings').isolate('mcpServers'))
    for (const [index, owner] of owners.entries()) {
      await owner.plugin(FileSettingsProvider, { path: `${settingsPath}.${String(index)}.yaml`, watch: false })
      await owner.plugin(McpServerRegistry)
      await owner.get('mcpServers')!.define({ ...STDIO, command: `node-${String(index)}`, enabled: true })
    }
    const [ownerA, ownerB] = owners as [Context, Context]
    const registryA = ownerA.get('mcpServers')!
    const registryB = ownerB.get('mcpServers')!
    expect(registryA.list().servers[0]).toMatchObject({ command: 'node-0', status: 'started', tools: ['mcp__notes__read'] })
    expect(registryB.list().servers[0]).toMatchObject({ command: 'node-1', status: 'started', tools: ['mcp__notes__read'] })
    expect(globalRegistry.list().servers).toEqual([])
    expect(ctx.tools.schemas()).toEqual([])

    const caller = ctx.isolate('mcpServers', ownerA[Context.isolate].mcpServers)
    await caller.plugin({
      inject: ['mcpServers'],
      async apply(apiCtx) { await apiCtx.mcpServers.setEnabled({ name: 'notes', enabled: false }) },
    })
    expect(await readFile(settingsPath, 'utf8')).toBe(before)
    expect(registryA.list().servers[0]?.status).toBe('stopped')
    expect(registryB.list().servers[0]?.status).toBe('started')

    await first.dispose()
    expect(ctx.tools.get('mcp__notes__read', scopeOf(second.ctx))).toBeDefined()
    await second.dispose()
    expect(ctx.tools.get('mcp__notes__read', scopeOf(second.ctx))).toBeUndefined()
  })

  it.each(['create', 'replace', 'setEnabled', 'remove'] as const)(
    'refuses a stale %s without restoring another deleted server, then accepts a refreshed retry', async (mode) => {
      const { registry, settingsPath } = await harness()
      await registry.define(STDIO)
      await registry.define({ ...STDIO, name: 'removed' })
      const peer = await mount(settingsPath)
      await registry.remove('removed')
      const before = await readFile(settingsPath, 'utf8')
      const write = () => mode === 'setEnabled'
        ? peer.mcpServers.setEnabled({ name: 'notes', enabled: false })
        : mode === 'remove' ? peer.mcpServers.remove('notes')
          : peer.mcpServers.define({ ...STDIO, mode, name: mode === 'create' ? 'added' : 'notes', command: 'updated' })

      await expect(write()).rejects.toBeInstanceOf(SettingsConflictError)
      expect(await readFile(settingsPath, 'utf8')).toBe(before)
      expect(peer.mcpServers.list().servers.map(server => server.name)).toEqual(['notes'])
      const accepted = await write()
      expect(accepted.servers.map(server => server.name)).toEqual(mode === 'remove' ? [] : mode === 'create' ? ['notes', 'added'] : ['notes'])
      if (mode === 'replace') expect(accepted.servers[0]?.command).toBe('updated')
      const restarted = await mount(settingsPath)
      expect(restarted.mcpServers.list()).toEqual(accepted)
    })

  it('keeps a server mounted after the API caller is disposed', async () => {
    const { ctx, registry } = await harness()
    const caller = await ctx.plugin({
      inject: ['mcpServers'],
      async apply(caller) { await caller.mcpServers.define({ ...STDIO, enabled: true }) },
    })
    await caller.dispose()
    expect(ctx.tools.schemas().map(tool => tool.name)).toEqual(['mcp__notes__read'])
    await registry.setEnabled({ name: 'notes', enabled: false })
    expect(ctx.tools.schemas()).toEqual([])
  })

  it('rejects duplicate creates without changing or restarting the active server', async () => {
    const { registry, settingsPath } = await harness()
    await registry.define({ ...STDIO, enabled: true })
    const before = await readFile(settingsPath, 'utf8')
    await expect(registry.define({ ...STDIO, command: 'replacement' })).rejects.toThrow('already exists')
    expect(await readFile(settingsPath, 'utf8')).toBe(before)
    expect(registry.list().servers[0]).toMatchObject({ enabled: true, command: 'node', status: 'started' })
    expect(mockConnect).toHaveBeenCalledTimes(1)
  })

  it('serializes competing creates and refuses replacing a removed record', async () => {
    const { registry } = await harness()
    const results = await Promise.allSettled([registry.define(STDIO), registry.define(STDIO)])
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected'])
    await registry.remove('notes')
    await expect(registry.define({ ...STDIO, mode: 'replace' })).rejects.toThrow('not configured')
    expect(registry.list().servers).toEqual([])
  })
  it('persists a defined record into the settings document', async () => {
    const { registry, settingsPath } = await harness()

    const snapshot = await registry.define(STDIO)

    expect(snapshot.servers).toEqual([{
      name: 'notes',
      transport: 'stdio',
      enabled: false,
      status: 'stopped',
      command: 'node',
      args: ['--version'],
      envNames: ['NOTES_TOKEN'],
      headerNames: [],
      toolCallTimeoutMs: 60_000,
      tools: [],
    }])
    const document = await readFile(settingsPath, 'utf8')
    expect(document).toContain('mcp-servers:')
    expect(document).toContain('name: notes')
    expect(document).toContain('command: node')
  })

  it('reads records the document already carries, so a hand edit needs no restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hydra-mcp-registry-existing-'))
    directories.push(root)
    const settingsPath = join(root, 'settings.yaml')
    await writeFile(settingsPath, [
      'mcp-servers:',
      '  servers:',
      '    - name: handwritten',
      '      transport: streamable-http',
      '      url: https://mcp.example.test/v1',
      '      enabled: false',
      '',
    ].join('\n'))

    const ctx = await mount(settingsPath)

    expect((ctx.get('mcpServers') as McpServerRegistry).list().servers).toEqual([{
      name: 'handwritten',
      transport: 'streamable-http',
      enabled: false,
      status: 'stopped',
      url: 'https://mcp.example.test/v1',
      envNames: [],
      headerNames: [],
      toolCallTimeoutMs: 60_000,
      tools: [],
    }])
  })

  it('redacts credentials from a legacy HTTP URL projection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hydra-mcp-registry-redacted-'))
    directories.push(root)
    const settingsPath = join(root, 'settings.yaml')
    await writeFile(settingsPath, [
      'mcp-servers:',
      '  servers:',
      '    - name: legacy',
      '      transport: streamable-http',
      '      url: "https://user:password@mcp.example.test/v1"',
      '      enabled: false',
      '',
    ].join('\n'))

    const ctx = await mount(settingsPath)

    expect(ctx.mcpServers.list().servers[0]).toMatchObject({
      name: 'legacy',
      url: 'https://mcp.example.test/v1',
      status: 'stopped',
    })
  })

  it.each([
    ['//user:password@mcp.example.test/v1', '//mcp.example.test/v1'],
    ['user:password@mcp.example.test/v1', 'mcp.example.test/v1'],
    ['not-a-url', 'not-a-url'],
    ['not-a-url?token=private#private', 'not-a-url'],
  ])('projects malformed HTTP URLs safely: %s', async (url, projected) => {
    const root = await mkdtemp(join(tmpdir(), 'hydra-mcp-registry-malformed-url-'))
    directories.push(root)
    const settingsPath = join(root, 'settings.yaml')
    await writeFile(settingsPath, [
      'mcp-servers:',
      '  servers:',
      '    - name: malformed',
      '      transport: streamable-http',
      `      url: "${url}"`,
      '      enabled: false',
      '',
    ].join('\n'))

    const ctx = await mount(settingsPath)

    expect(ctx.mcpServers.list().servers[0]?.url).toBe(projected)
    expect(ctx.mcpServers.list().servers[0]?.url).not.toContain('password')
  })

  it('redacts MCP URLs from the generic settings descriptor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hydra-mcp-registry-descriptor-'))
    directories.push(root)
    const settingsPath = join(root, 'settings.yaml')
    await writeFile(settingsPath, [
      'mcp-servers:',
      '  servers:',
      '    - name: legacy',
      '      transport: streamable-http',
      '      url: "https://user:password@mcp.example.test/v1"',
      '      enabled: false',
      '',
    ].join('\n'))

    const ctx = await mount(settingsPath)
    const descriptor = ctx.settings.describe({ redactSecrets: true })
      .find(namespace => namespace.ns === MCP_SERVERS_SETTINGS_NAMESPACE)

    expect(JSON.stringify(descriptor)).not.toContain('user:password')
    expect(descriptor?.secrets).toContainEqual({ path: ['servers', '0', 'url'], set: true })
  })

  it('replaces one record wholesale but keeps the credential-shaped maps it cannot restate', async () => {
    const { registry } = await harness()
    await registry.define(STDIO)

    const snapshot = await registry.define({ mode: 'replace',
      name: 'notes',
      transport: 'stdio',
      command: 'node',
      args: [],
      cwd: 'C:\\notes',
    })

    expect(snapshot.servers[0]).toMatchObject({
      args: [],
      cwd: 'C:\\notes',
      envNames: ['NOTES_TOKEN'],
    })
  })

  it('clears a stored env map only when the caller supplies one', async () => {
    const { registry } = await harness()
    await registry.define(STDIO)

    const snapshot = await registry.define({ ...STDIO, mode: 'replace', env: {} })

    expect(snapshot.servers[0]?.envNames).toEqual([])
  })

  it('drops one record and reports it is no longer configured', async () => {
    const { registry, settingsPath } = await harness()
    await registry.define(STDIO)

    await expect(registry.remove('notes')).resolves.toEqual({ servers: [] })
    expect(await readFile(settingsPath, 'utf8')).not.toContain('name: notes')
    await expect(registry.remove('notes')).rejects.toThrow('server notes is not configured')
  })

  it('refuses a definition it could not mount before anything persists', async () => {
    const { registry, settingsPath } = await harness()

    await expect(registry.define({ mode: 'create', name: 'no name', transport: 'stdio', command: 'node' }))
      .rejects.toThrow('server name must match')
    await expect(registry.define({ mode: 'create', name: 'blank', transport: 'stdio', command: '  ' }))
      .rejects.toThrow('requires a command')
    await expect(registry.define({ mode: 'create', name: 'missing', transport: 'stdio' }))
      .rejects.toThrow('requires a command')
    await expect(registry.define({ mode: 'create', name: 'remote', transport: 'streamable-http', url: 'ftp://mcp.example.test' }))
      .rejects.toThrow('must use HTTP or HTTPS')
    await expect(registry.define({ mode: 'create', name: 'remote', transport: 'streamable-http', url: 'https://user:password@mcp.example.test/v1' }))
      .rejects.toThrow('must not include username or password')
    await expect(registry.define({ mode: 'create', name: 'remote', transport: 'streamable-http', url: 'not-a-url' }))
      .rejects.toThrow('url is not absolute')
    await expect(registry.define({ mode: 'create', name: 'remote', transport: 'streamable-http' }))
      .rejects.toThrow('requires a url')

    await expect(readFile(settingsPath, 'utf8')).rejects.toThrow()
    expect(registry.list().servers).toEqual([])
  })

  it('refuses a stored section that declares one name twice', async () => {
    const { ctx } = await harness()

    await expect(ctx.settings.replace(MCP_SERVERS_SETTINGS_NAMESPACE, {
      servers: [
        { name: 'notes', transport: 'stdio', command: 'node' },
        { name: 'notes', transport: 'stdio', command: 'python' },
      ],
    })).rejects.toThrow('is declared more than once')
  })
})

describe('mount reconciliation', () => {
  it('refuses a fifty-first server and preserves omitted definition fields on replacement', async () => {
    const { ctx, registry } = await harness()
    const reconciled = nextReconciliation(ctx)
    await ctx.settings.replace(MCP_SERVERS_SETTINGS_NAMESPACE, {
      servers: Array.from({ length: 50 }, (_, index) => ({ name: `server-${index}`, transport: 'stdio', command: 'node' })),
    })
    await reconciled
    await expect(registry.define({ ...STDIO, name: 'overflow' })).rejects.toThrow('at most 50 servers')
    const snapshot = await registry.define({ mode: 'replace', name: 'server-0', transport: 'stdio', command: 'python' })
    expect(snapshot.servers[0]).toMatchObject({ command: 'python', args: [], enabled: false })
    expect(snapshot.servers).toHaveLength(50)
  })

  it('keeps a completed settings write stopped when the registry disposes before its acknowledgment', async () => {
    primeSdk()
    const root = await mkdtemp(join(tmpdir(), 'hydra-mcp-disposing-'))
    directories.push(root)
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(FileSettingsProvider, { path: join(root, 'settings.yaml'), watch: false })
    const fiber = ctx.plugin(McpServerRegistry)
    await fiber
    const registry = ctx.mcpServers
    const entered: PromiseWithResolvers<void> = Promise.withResolvers()
    const release: PromiseWithResolvers<void> = Promise.withResolvers()
    const update = ctx.settings.update.bind(ctx.settings)
    vi.spyOn(ctx.settings, 'update').mockImplementationOnce(async (...args) => {
      await update(...args)
      entered.resolve()
      await release.promise
    })
    const pending = registry.define({ ...STDIO, enabled: true })
    await entered.promise
    const disposing = fiber.dispose()
    release.resolve()
    await pending
    await disposing
    expect(registry.list().servers).toMatchObject([{ name: 'notes', enabled: true, status: 'stopped' }])
    expect(mockConnect).not.toHaveBeenCalled()
  })

  it('mounts HTTP servers with headers and projects their discovered tools', async () => {
    const { registry } = await harness()
    const snapshot = await registry.define({ mode: 'create', name: 'remote', transport: 'streamable-http',
      url: 'http://mcp.example.test/v1', headers: { Authorization: 'Bearer private' }, enabled: true })
    expect(snapshot.servers).toMatchObject([{ name: 'remote', status: 'started', headerNames: ['Authorization'], tools: ['mcp__remote__read'] }])
  })

  it.each([
    { transport: 'stdio', command: 'node', url: 'https://example.test' },
    { transport: 'streamable-http', command: 'node', url: 'https://example.test' },
    { transport: 'stdio', command: 'node', env: { ' ': 'value' } },
    { transport: 'stdio', command: 'node', env: { NAME: 'x'.repeat(4097) } },
  ])('reports an unmountable persisted record: %j', async (record) => {
    const { ctx, registry } = await harness()
    const reconciled = nextReconciliation(ctx)
    await ctx.settings.replace(MCP_SERVERS_SETTINGS_NAMESPACE, { servers: [{ ...record, name: 'invalid', enabled: true }] })
    await reconciled
    expect(registry.list().servers).toMatchObject([{ name: 'invalid', status: 'invalid' }])
    expect(mockConnect).not.toHaveBeenCalled()
  })

  it('mounts an enabled record, registers its tools, and unmounts it again on disable', async () => {
    const { ctx, registry } = await harness()
    await registry.define(STDIO)

    const enabled = await registry.setEnabled({ name: 'notes', enabled: true })

    expect(enabled.servers[0]).toMatchObject({ enabled: true, status: 'started' })
    expect(enabled.servers[0]?.tools).toEqual(['mcp__notes__read'])
    expect(ctx.tools.schemas().map(tool => tool.name)).toContain('mcp__notes__read')

    const disabled = await registry.setEnabled({ name: 'notes', enabled: false })

    expect(disabled.servers[0]).toMatchObject({ enabled: false, status: 'stopped', tools: [] })
    expect(ctx.tools.schemas().map(tool => tool.name)).not.toContain('mcp__notes__read')
  })

  it('mounts every enabled record the document already carried at startup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hydra-mcp-registry-startup-'))
    directories.push(root)
    const settingsPath = join(root, 'settings.yaml')
    primeSdk()
    await writeFile(settingsPath, [
      'mcp-servers:',
      '  servers:',
      '    - name: notes',
      '      transport: stdio',
      '      command: node',
      '      enabled: true',
      '',
    ].join('\n'))

    const ctx = await mount(settingsPath)

    expect((ctx.get('mcpServers') as McpServerRegistry).list().servers[0])
      .toMatchObject({ enabled: true, status: 'started' })
    expect(ctx.tools.schemas().map(tool => tool.name)).toContain('mcp__notes__read')
  })

  it('remounts a live record when its definition changes', async () => {
    const { registry } = await harness()
    await registry.define({ ...STDIO, enabled: true })
    expect(mockConnect).toHaveBeenCalledTimes(1)

    await registry.define({ ...STDIO, mode: 'replace', command: 'python', enabled: true })

    expect(mockClose).toHaveBeenCalledTimes(1)
    expect(mockConnect).toHaveBeenCalledTimes(2)
    expect(registry.list().servers[0]).toMatchObject({ command: 'python', status: 'started' })
  })

  it('leaves a live record alone when an unrelated record changes', async () => {
    const { registry } = await harness()
    await registry.define({ ...STDIO, enabled: true })
    expect(mockConnect).toHaveBeenCalledTimes(1)

    await registry.define({ mode: 'create', name: 'other', transport: 'stdio', command: 'node' })

    expect(mockClose).not.toHaveBeenCalled()
    expect(mockConnect).toHaveBeenCalledTimes(1)
  })

  it('reports a stored record it refuses to mount instead of failing the process', async () => {
    const { ctx, registry } = await harness()

    const reconciled = nextReconciliation(ctx)
    await ctx.settings.replace(MCP_SERVERS_SETTINGS_NAMESPACE, {
      servers: [
        { name: 'broken', transport: 'stdio', command: '', enabled: true },
        { name: 'notes', transport: 'stdio', command: 'node', enabled: true },
      ],
    })
    await reconciled

    const [broken, notes] = registry.list().servers
    expect(broken).toMatchObject({ name: 'broken', enabled: true, status: 'invalid' })
    expect(broken?.detail).toContain('requires a command')
    // The refused record did not stop its sibling from mounting.
    expect(notes).toMatchObject({ name: 'notes', status: 'started' })
  })

  it.each([new Error('connection refused'), 'connection refused'])('reports a record whose connection failed: %s', async (error) => {
    const { registry } = await harness()
    mockConnect.mockRejectedValue(error)

    await registry.define({ ...STDIO, enabled: true })

    expect(registry.list().servers[0]).toMatchObject({ enabled: true, status: 'failed' })
  })

  it('refuses to change a record that is not configured', async () => {
    const { registry } = await harness()

    await expect(registry.setEnabled({ name: 'absent', enabled: true }))
      .rejects.toThrow('server absent is not configured')
  })

  it('unmounts every live record when the fiber disposes', async () => {
    const { ctx, registry } = await harness()
    await registry.define({ ...STDIO, enabled: true })

    await ctx.fiber.dispose()

    expect(mockClose).toHaveBeenCalledTimes(1)
  })
})

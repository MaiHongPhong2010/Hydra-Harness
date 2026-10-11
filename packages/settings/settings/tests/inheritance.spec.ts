import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@hydraharness/cordis'
import z from '@hydraharness/schemastery'
import { settingsNamespace, type SettingsScope } from '../src/index.ts'
import { MemorySettings } from './memory.ts'

const ns = settingsNamespace('workspace-settings')
const schema = z.object({
  retry: z.object({ attempts: z.number().default(2), delayMs: z.number().default(100) }),
  tags: z.array(z.string()).default(['default']),
  token: z.string().role('secret'),
})
const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
})

async function boot(doc: Record<string, unknown> = {}, persistDelayMs = 0): Promise<MemorySettings> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(MemorySettings, { doc, persistDelayMs })
  return ctx.settings as MemorySettings
}

describe('settings inheritance', () => {
  it('layers maps, replaces arrays, and resets through the latest parent value', async () => {
    const parent = await boot({ [ns]: { retry: { attempts: 3 }, token: 'private' } })
    parent.register(ns, schema, { base: { retry: { attempts: 4, delayMs: 200 } }, applies: 'restart' })
    const shared = await boot({ [ns]: { retry: { delayMs: 300 }, tags: ['project'] } })
    const local = await boot({ [ns]: { retry: { attempts: 5 }, tags: [] } })
    shared.inherit(parent, [ns])
    local.inherit(shared, [ns])

    expect(local.get(ns)).toEqual({ retry: { attempts: 5, delayMs: 300 }, tags: [], token: 'private' })
    expect(local.describe()[0]?.applies).toBe('restart')
    expect(JSON.stringify(local.describe({ redactSecrets: true }))).not.toContain('private')
    await parent.update(ns, { retry: { attempts: 6, delayMs: 250 } })
    expect(local.get(ns)).toMatchObject({ retry: { attempts: 5, delayMs: 300 } })
    await local.replace(ns, {})
    expect(local.get(ns)).toEqual(shared.get(ns))
    expect(local.doc[ns]).toEqual({})
    expect(parent.doc[ns]).toMatchObject({ retry: { attempts: 6, delayMs: 250 } })
    await shared.mutate(ns, [{ op: 'unset', path: ['retry', 'delayMs'] }])
    expect(local.get(ns)).toMatchObject({ retry: { attempts: 6, delayMs: 250 } })
  })

  it('keeps parent validation and current inherited values when an owner claims a namespace', async () => {
    const parent = await boot()
    parent.register(ns, schema, {
      validate: (value) => {
        if (value.retry.attempts < 1) throw new Error('attempts must be positive')
      },
    })
    const child = await boot()
    child.inherit(parent, [ns])
    const scope = child.register(ns, schema)
    const seen = vi.fn()
    scope.watch(seen)
    expect(() => child.register(ns, schema)).toThrow('already registered')
    await expect(scope.update({ retry: { attempts: 0 } })).rejects.toThrow('positive')
    expect(child.persisted).toEqual([])
    await parent.update(ns, { retry: { delayMs: 300 } })
    expect(scope.get()).toMatchObject({ retry: { delayMs: 300 } })
    await vi.waitFor(() => { expect(seen).toHaveBeenCalledTimes(1) })
  })

  it('follows registration lifecycle without retaining observers from a disposed owner', async () => {
    const parent = await boot()
    const child = await boot()
    const disposeInheritance = child.inherit(parent, [ns])
    parent.register(settingsNamespace('global-only'), schema)
    expect(child.describe()).toEqual([])
    const parentOwner = parent.ownerContext.plugin({
      inject: ['settings'],
      apply: (ctx: Context) => { ctx.settings.register(ns, schema) },
    })
    await parentOwner
    const seen = vi.fn()
    let scope: SettingsScope<ReturnType<typeof schema>> | undefined
    const childOwner = child.ownerContext.plugin({
      inject: ['settings'],
      apply: (ctx: Context) => {
        scope = ctx.settings.register(ns, schema)
        scope.watch(seen)
      },
    })
    await childOwner
    await childOwner.dispose()
    await parent.update(ns, { retry: { attempts: 4 } })
    await Promise.resolve()
    expect(scope?.get()).toMatchObject({ retry: { attempts: 4 } })
    expect(seen).not.toHaveBeenCalled()
    await parentOwner.dispose()
    expect(child.get(ns)).toBeUndefined()
    parent.register(ns, schema, { base: { tags: ['replacement'] } })
    expect(child.get(ns)).toMatchObject({ tags: ['replacement'] })
    await disposeInheritance()
    expect(child.describe()).toEqual([])
    await parent.update(ns, { tags: ['later'] })
    expect(child.describe()).toEqual([])
  })

  it('suppresses raw sections while retaining their descriptors and validated edits', async () => {
    const parent = await boot({ [ns]: { retry: { attempts: 3 } } })
    parent.register(ns, schema)
    const child = await boot({ [ns]: { retry: { attempts: 9 } } })
    child.setLayerEnabled(false)
    child.setLayerEnabled(false)
    child.inherit(parent, [ns])
    expect(child.get(ns)).toEqual(parent.get(ns))
    expect(child.describe()[0]?.user).toEqual({ retry: { attempts: 9 } })
    await child.update(ns, { tags: ['pending'] })
    expect(child.get(ns)).toEqual(parent.get(ns))
    await expect(child.update(ns, { retry: { attempts: 'invalid' } })).rejects.toThrow()
    child.setLayerEnabled(true)
    expect(child.get(ns)).toMatchObject({ retry: { attempts: 9 }, tags: ['pending'] })
    child.setLayerEnabled(false)
    await parent.update(ns, { retry: { attempts: 5 } })
    expect(child.get(ns)).toEqual(parent.get(ns))
    expect(child.doc[ns]).toEqual({ retry: { attempts: 9 }, tags: ['pending'] })
  })

  it('uses parent changes that arrive while a child write persists', async () => {
    const parent = await boot()
    parent.register(ns, schema)
    const child = await boot({}, 30)
    child.inherit(parent, [ns])
    const write = child.update(ns, { tags: ['local'] })
    await new Promise(resolve => setTimeout(resolve, 5))
    await parent.update(ns, { retry: { attempts: 8 } })
    await write
    expect(child.get(ns)).toMatchObject({ retry: { attempts: 8 }, tags: ['local'] })
  })

  it('rolls back invalid initial inheritance and rejects repeated parents and cycles', async () => {
    const parent = await boot()
    parent.register(ns, schema)
    const child = await boot({ [ns]: { retry: { attempts: 'invalid' } } })
    expect(() => child.inherit(parent, [ns])).toThrow()
    expect(child.describe()).toEqual([])
    child.setLayerEnabled(false)
    child.inherit(parent, [ns])
    expect(() => child.inherit(parent, [ns])).toThrow('already inherits')
    expect(() => parent.inherit(child, [ns])).toThrow('cycle')
  })

  it('refuses to inherit over a locally registered namespace', async () => {
    const parent = await boot()
    const child = await boot()
    parent.register(ns, schema)
    child.register(ns, schema)
    expect(() => child.inherit(parent, [ns])).toThrow('already registered')
  })

  it('detaches inheritance after a parent registration has already gone away', async () => {
    const parent = await boot()
    const owner = parent.ownerContext.plugin({
      inject: ['settings'], apply: (ctx: Context) => { ctx.settings.register(ns, schema) },
    })
    await owner
    const child = await boot()
    const dispose = child.inherit(parent, [ns])
    await owner.dispose()
    await dispose()
    parent.register(ns, schema)
    expect(child.get(ns)).toBeUndefined()
  })

  it('deactivates a claimed owner watcher when inheritance is disposed', async () => {
    const parent = await boot()
    parent.register(ns, schema)
    const child = await boot()
    const dispose = child.inherit(parent, [ns])
    const seen = vi.fn()
    child.register(ns, schema).watch(seen)
    parent.pushExternal({ [ns]: { retry: { attempts: 5 } } })
    await dispose()
    await Promise.resolve()
    expect(seen).not.toHaveBeenCalled()
    expect(child.get(ns)).toBeUndefined()
  })

  it('retains a last good child value after an invalid edit without freezing the inherited base', async () => {
    const parent = await boot()
    parent.register(ns, schema)
    const child = await boot()
    child.inherit(parent, [ns])
    const before = child.get(ns)
    child.pushExternal({ [ns]: { retry: { attempts: 'invalid' } } })
    await parent.update(ns, { retry: { delayMs: 500 } })
    expect(child.get(ns)).toEqual(before)
    expect(child.describe()[0]?.base).toMatchObject({ retry: { delayMs: 500 } })
    await child.replace(ns, {})
    expect(child.get(ns)).toEqual(parent.get(ns))
  })

  it('rethrows invariant failures from inherited commits', async () => {
    const parent = await boot()
    parent.register(ns, schema)
    const child = await boot()
    child.inherit(parent, [ns])
    child.ownerContext.on('settings/updated', () => { throw Object.assign(new Error('inherited invariant'), { code: 'INVARIANT' }) })
    await expect(parent.update(ns, { retry: { attempts: 5 } })).rejects.toThrow('inherited invariant')
    expect(child.get(ns)).toMatchObject({ retry: { attempts: 5 } })
  })

  it('notifies exact provider observers about raw and inherited descriptor changes', async () => {
    const parent = await boot()
    parent.register(ns, schema)
    const child = await boot({ [ns]: { retry: { attempts: 5 } } })
    child.inherit(parent, [ns])
    const sibling = await boot()
    sibling.inherit(parent, [ns])
    const childSeen = vi.fn()
    const siblingSeen = vi.fn()
    child.observe(() => { throw new Error('observer failed') })
    const disposeObserver = child.observe(childSeen)
    sibling.observe(siblingSeen)
    await child.update(ns, { retry: { attempts: 5 } })
    expect(childSeen).not.toHaveBeenCalled()
    await child.update(ns, { tags: ['default'] })
    expect(childSeen).toHaveBeenCalled()
    childSeen.mockClear()
    await child.update(ns, { token: 'secret' })
    expect(childSeen).toHaveBeenCalled()
    expect(siblingSeen).not.toHaveBeenCalled()
    childSeen.mockClear()
    await parent.update(ns, { retry: { attempts: 5 } })
    expect(childSeen).toHaveBeenCalled()
    expect(child.describe()[0]?.base).toMatchObject({ retry: { attempts: 5 } })
    await disposeObserver()
    childSeen.mockClear()
    await child.update(ns, { token: 'changed' })
    expect(childSeen).not.toHaveBeenCalled()
  })

  it('normalizes inherited nested collections without mutating frozen parent snapshots', async () => {
    const collectionSchema = z.object({
      records: z.array(z.object({ env: z.dict(z.string()) })),
      hooks: z.dict(z.dict(z.string())),
    })
    const parent = await boot({ [ns]: {
      records: [{ env: { TOKEN: 'parent' } }], hooks: { SessionStart: { command: 'parent' } },
    } })
    parent.register(ns, collectionSchema)
    const original = parent.get(ns)
    const child = await boot()
    child.inherit(parent, [ns])
    expect(child.get(ns)).toEqual(original)
    await child.update(ns, { hooks: { SessionStart: { command: 'child' } } })
    expect(child.get(ns)).toMatchObject({ hooks: { SessionStart: { command: 'child' } } })
    expect(parent.get(ns)).toEqual(original)
    expect(parent.get(ns)).toMatchObject({ hooks: { SessionStart: { command: 'parent' } } })
  })
})

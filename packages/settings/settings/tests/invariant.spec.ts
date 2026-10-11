import { describe, expect, it } from 'vitest'
import { Context } from '@hydraharness/cordis'
import z from '@hydraharness/schemastery'
import InvariantRegistry from '@hydraharness/harness-invariants'
import * as SettingsInvariant from '../src/invariant.ts'
import { settingsNamespace } from '../src/index.ts'
import { MemorySettings } from './memory.ts'

async function setup(withProvider: boolean): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(SettingsInvariant)
  if (withProvider) await ctx.plugin(MemorySettings)
  return ctx
}

describe('settings invariants', () => {
  it('checks isolated providers against their own values and routes ordinary listeners to their service realm', async () => {
    const ctx = await setup(true)
    const ns = settingsNamespace('ui-theme')
    const theme = z.object({ theme: z.string().default('dark') })
    ctx.settings.register(ns, theme)
    const isolated = ctx.isolate('settings')
    await isolated.plugin(MemorySettings)
    isolated.settings.register(ns, theme)
    const globalSeen: unknown[] = []
    const isolatedSeen: unknown[] = []
    ctx.on('settings/updated', (_ns, next) => { globalSeen.push(next) })
    isolated.on('settings/updated', (_ns, next) => { isolatedSeen.push(next) })

    await isolated.settings.update(ns, { theme: 'light' })
    expect(isolated.settings.get(ns)).toEqual({ theme: 'light' })
    expect(ctx.settings.get(ns)).toEqual({ theme: 'dark' })
    expect(globalSeen).toEqual([])
    expect(isolatedSeen).toEqual([{ theme: 'light' }])
    expect(() => {
      ctx.emit(isolated.settings, 'settings/updated', ns, { theme: 'forged' }, { theme: 'light' }, 'provider')
    })
      .toThrow('authoritative')
    await ctx.fiber.dispose()
  })

  it('fails a settings/updated emission without a live settings service', async () => {
    const ctx = await setup(false)
    expect(() => {
      ctx.emit('settings/updated', settingsNamespace('ghost'), { a: 1 }, { a: 2 }, 'provider')
    }).toThrow(/without a live settings service/)
  })

  it('fails a settings/updated emission for an unregistered namespace', async () => {
    const ctx = await setup(true)
    expect(() => {
      ctx.emit('settings/updated', settingsNamespace('ghost'), { a: 1 }, { a: 2 }, 'provider')
    }).toThrow(/unregistered/)
  })

  it('fails a settings/updated emission without a resolved-value change', async () => {
    const ctx = await setup(true)
    ctx.settings.register(settingsNamespace('ui-theme'), z.object({
      theme: z.string().default('dark'),
    }))
    expect(() => {
      ctx.emit('settings/updated', settingsNamespace('ui-theme'), { theme: 'dark' }, { theme: 'dark' }, 'update')
    }).toThrow(/without a resolved-value change/)
  })

  it('fails a settings/updated emission whose value diverges from the authoritative state', async () => {
    const ctx = await setup(true)
    ctx.settings.register(settingsNamespace('ui-theme'), z.object({
      theme: z.string().default('dark'),
    }))
    // Fabricated next ≠ the service's current resolved value ({theme: 'dark'}).
    expect(() => {
      ctx.emit('settings/updated', settingsNamespace('ui-theme'), { theme: 'forged' }, { theme: 'dark' }, 'update')
    }).toThrow(/authoritative/)
  })
})

import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

const { createNativePreferences } = createRequire(import.meta.url)('../native-preferences.cjs') as {
  createNativePreferences: (options: object) => {
    configure(value: object): { popoutHotkey: string }
    terminalShell(): string
    status(): { shells: { value: string }[]; startup: { enabled: boolean } }
    openStartup(): Promise<void>
    notify(value: object): { delivered: boolean } | Promise<{ delivered: boolean }>
    dispose(): void
  }
}

function bench() {
  const register = vi.fn(() => true)
  const unregister = vi.fn()
  const show = vi.fn()
  const click = vi.fn()
  const handlers = new Map<string, () => void>()
  class TestNotification {
    static isSupported() { return true }
    on(event: string, fn: () => void) { handlers.set(event, fn) }
    show() { show(); handlers.get('show')?.() }
    close() {}
  }
  const openExternal = vi.fn(async () => {})
  const controller = createNativePreferences({ app: { getLoginItemSettings: () => ({ openAtLogin: true }) },
    globalShortcut: { register, unregister }, Notification: TestNotification, shell: { openExternal },
    onPopout: vi.fn(), onNotificationClick: click, platform: 'win32', env: {}, exists: () => true })
  return { controller, register, unregister, show, click, handlers, openExternal }
}

describe('native preferences', () => {
  it('retains a registered hotkey on conflict and refuses unknown fields and missing shells', () => {
    const b = bench()
    b.controller.configure({ popoutHotkey: 'Control+Alt+H' })
    b.register.mockReturnValueOnce(false)
    expect(() => b.controller.configure({ popoutHotkey: 'Control+Alt+J' })).toThrow('previous hotkey remains active')
    expect(b.unregister).not.toHaveBeenCalled()
    expect(() => b.controller.configure({ popoutHotkey: 'H' })).toThrow('modifier')
    expect(() => b.controller.configure({ terminalShell: 'untrusted.exe' })).toThrow('unavailable')
    expect(() => b.controller.configure({ command: 'arbitrary.exe' })).toThrow('Invalid')
    b.controller.dispose()
    expect(b.unregister).toHaveBeenCalledWith('Control+Alt+H')
  })
  it('reads startup state, opens the OS settings, and changes only the selected new-terminal shell', async () => {
    const b = bench()
    expect(b.controller.status().startup.enabled).toBe(true)
    const selected = b.controller.status().shells[0]!.value
    b.controller.configure({ terminalShell: selected })
    expect(b.controller.terminalShell()).toBe(selected)
    await b.controller.openStartup()
    expect(b.openExternal).toHaveBeenCalledWith('ms-settings:startupapps')
  })
  it('deduplicates notifications across windows and routes clicks to the addressed chat', async () => {
    const b = bench()
    const value = { id: 'turn:s1:1', sessionId: 's1', title: 'Turn finished', body: '', silent: true }
    expect((await b.controller.notify(value)).delivered).toBe(true)
    expect((await b.controller.notify(value)).delivered).toBe(false)
    expect(b.show).toHaveBeenCalledTimes(1)
    b.handlers.get('click')!()
    expect(b.click).toHaveBeenCalledWith('s1')
    expect(() => b.controller.notify({ ...value, title: 'x'.repeat(257) })).toThrow('Invalid notification')
  })
  it('reports asynchronous OS refusal instead of claiming delivery', async () => {
    const b = bench()
    b.show.mockImplementationOnce(() => { b.handlers.get('failed')!() })
    await expect(b.controller.notify({ id: 'denied', sessionId: 's1', title: 'Hydra', body: '', silent: true })).rejects.toThrow('delivery failed')
  })
})

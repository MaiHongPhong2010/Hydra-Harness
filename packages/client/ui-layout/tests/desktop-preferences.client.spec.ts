// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { stubSettingsScope } from '@hydraharness/harness-client-test-runtime'
import type { DesktopPreferences } from '../src/preferences.ts'
import type { NativePreferencesApi } from '../src/client/desktop-preferences.ts'
import { DesktopPreferencesController } from '../src/client/DesktopPreferencesController.ts'

const defaults: DesktopPreferences = { terminalShell: '', closeConfirmation: 'never', popoutHotkey: '', popoutStandalone: false,
  fileOpenDestination: 'editor', fullView: false, bottomPanelControl: true, terminalLocation: 'bottom' }

describe('native preference acceptance', () => {
  it.each(['rejection', 'unacknowledged'] as const)('restores the previous native value after %s persistence', async (mode) => {
    const settings = stubSettingsScope<DesktopPreferences>()
    settings.publish({ value: defaults, writable: true, status: 'ready' })
    if (mode === 'rejection') settings.set.mockRejectedValueOnce(new Error('fixture write failure'))
    const configure = vi.fn(async () => defaults)
    const controller = new DesktopPreferencesController(settings.scope, { configure } as unknown as NativePreferencesApi)
    await expect(controller.save('popoutHotkey', 'Control+Alt+H')).rejects.toThrow()
    expect(configure.mock.calls).toEqual([[{ popoutHotkey: 'Control+Alt+H' }], [{ popoutHotkey: '' }]])
    expect(settings.scope.getSnapshot().value?.popoutHotkey).toBe('')
  })

  it('never writes a hotkey that the native owner rejected', async () => {
    const settings = stubSettingsScope<DesktopPreferences>()
    settings.publish({ value: defaults, writable: true, status: 'ready' })
    const controller = new DesktopPreferencesController(settings.scope, { configure: async () => { throw new Error('Hotkey conflict') } } as unknown as NativePreferencesApi)
    await expect(controller.save('popoutHotkey', 'Control+Alt+H')).rejects.toThrow('Hotkey conflict')
    expect(settings.set).not.toHaveBeenCalled()
  })

  it('restores another window\'s accepted value after a revision conflict', async () => {
    const settings = stubSettingsScope<DesktopPreferences>()
    settings.publish({ value: defaults, writable: true, status: 'ready' })
    settings.set.mockImplementation(() => {
      settings.publish({ value: { ...defaults, popoutHotkey: 'Control+Alt+J' }, revision: 2 })
      throw new Error('Revision conflict')
    })
    const configure = vi.fn(async () => defaults)
    const controller = new DesktopPreferencesController(settings.scope, { configure } as unknown as NativePreferencesApi)
    await expect(controller.save('popoutHotkey', 'Control+Alt+H')).rejects.toThrow('Revision conflict')
    expect(configure.mock.calls).toEqual([[{ popoutHotkey: 'Control+Alt+H' }], [{ popoutHotkey: 'Control+Alt+J' }]])
  })
})

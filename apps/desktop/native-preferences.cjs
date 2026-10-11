'use strict'

const { existsSync } = require('node:fs')
const { join, isAbsolute, win32 } = require('node:path')

/** Native preference execution; persistence remains with the Host settings owner. */
function createNativePreferences({ app, globalShortcut, Notification, shell, onPopout, onNotificationClick, platform = process.platform, env = process.env, exists = existsSync, deliveryTimeoutMs = 10000, maxDeliveryIds = 4096 }) {
  if (!Number.isSafeInteger(deliveryTimeoutMs) || deliveryTimeoutMs < 1 || !Number.isSafeInteger(maxDeliveryIds) || maxDeliveryIds < 1) throw new Error('Invalid notification delivery limits')
  let preferences = { terminalShell: '', closeConfirmation: 'never', popoutHotkey: '', popoutStandalone: false }
  const delivered = new Set()
  const notifications = new Set()
  function shells() {
    const candidates = platform === 'win32'
      ? [join(env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'),
        join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        env.ComSpec || join(env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe')]
      : [env.SHELL, '/bin/bash', '/bin/zsh', '/bin/sh'].filter(Boolean)
    return [...new Set(candidates)].filter(path => (platform === 'win32' ? win32.isAbsolute(path) : isAbsolute(path)) && exists(path)).map(path => ({
      value: path, label: path.split(/[\\/]/u).pop(),
    }))
  }
  function configure(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)
      || Object.keys(value).some(key => !['terminalShell', 'closeConfirmation', 'popoutHotkey', 'popoutStandalone'].includes(key))) throw new Error('Invalid native preferences')
    const next = { ...preferences, ...value }
    if (typeof next.terminalShell !== 'string' || (next.terminalShell !== '' && !shells().some(choice => choice.value === next.terminalShell))) throw new Error('Selected shell is unavailable')
    if (!['never', 'shortcut', 'always'].includes(next.closeConfirmation)) throw new Error('Invalid close confirmation')
    if (typeof next.popoutStandalone !== 'boolean') throw new Error('Invalid standalone chat preference')
    if (typeof next.popoutHotkey !== 'string' || (next.popoutHotkey !== ''
      && !/^(?:(?:CommandOrControl|Command|Control|Ctrl|Alt|Option|Shift|Super)\+)+(?:[A-Z0-9]|F(?:[1-9]|1[0-9]|2[0-4])|Space)$/iu.test(next.popoutHotkey))) throw new Error('Use a modifier and a letter, digit, function key, or Space for the hotkey')
    if (next.popoutHotkey !== preferences.popoutHotkey) {
      if (next.popoutHotkey !== '' && !globalShortcut.register(next.popoutHotkey, onPopout)) throw new Error('Hotkey is already in use; the previous hotkey remains active')
      if (preferences.popoutHotkey !== '') globalShortcut.unregister(preferences.popoutHotkey)
    }
    preferences = next
    return { ...preferences }
  }
  function status() {
    const login = platform === 'win32' || platform === 'darwin' ? app.getLoginItemSettings() : {}
    return { shells: shells(), startup: { enabled: login.openAtLogin === true,
      available: platform === 'win32' || platform === 'darwin' }, notifications: Notification.isSupported(),
      preferences: { ...preferences } }
  }
  async function openStartup() {
    if (platform === 'win32') return shell.openExternal('ms-settings:startupapps')
    if (platform === 'darwin') return shell.openExternal('x-apple.systempreferences:com.apple.LoginItems-Settings.extension')
    throw new Error('Startup settings are unavailable on this platform')
  }
  function notify(value) {
    if (!Notification.isSupported()) return { delivered: false, reason: 'Notifications are unavailable' }
    if (typeof value !== 'object' || value === null || typeof value.id !== 'string' || value.id.length > 512
      || typeof value.sessionId !== 'string' || value.sessionId.length > 256
      || typeof value.title !== 'string' || value.title.length > 256 || typeof value.body !== 'string' || value.body.length > 2048
      || typeof value.silent !== 'boolean') throw new Error('Invalid notification')
    if (delivered.has(value.id)) return { delivered: false, reason: 'Already delivered' }
    const notification = new Notification({ title: value.title, body: value.body, silent: value.silent })
    notifications.add(notification)
    notification.on('click', () => { onNotificationClick(value.sessionId) })
    notification.on('close', () => { notifications.delete(notification) })
    delivered.add(value.id)
    if (delivered.size > maxDeliveryIds) delivered.delete(delivered.values().next().value)
    return new Promise((resolveDelivery, rejectDelivery) => {
      const timeout = setTimeout(() => { rejectDelivery(new Error('The operating system did not confirm notification delivery')) }, deliveryTimeoutMs)
      timeout.unref?.()
      notification.on('show', () => { clearTimeout(timeout); resolveDelivery({ delivered: true }) })
      notification.on('failed', (_event, error) => {
        clearTimeout(timeout)
        notifications.delete(notification)
        rejectDelivery(new Error(`Notification delivery failed: ${String(error)}`))
      })
      try { notification.show() }
      catch (error) { clearTimeout(timeout); notifications.delete(notification); rejectDelivery(error) }
    })
  }
  return { configure, status, openStartup, notify,
    closeConfirmation: () => preferences.closeConfirmation,
    terminalShell: () => preferences.terminalShell,
    standaloneChat: () => preferences.popoutStandalone,
    dispose: () => {
      if (preferences.popoutHotkey !== '') globalShortcut.unregister(preferences.popoutHotkey)
      for (const notification of notifications) notification.close()
      notifications.clear()
    },
  }
}

module.exports = { createNativePreferences }

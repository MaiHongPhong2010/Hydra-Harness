'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('hydraDesktop', {
  environment: {
    status: () => ipcRenderer.invoke('hydra-desktop:environment-status'),
    select: value => ipcRenderer.invoke('hydra-desktop:environment-select', value),
  },
  preferences: {
    openNotificationSettings: () => ipcRenderer.invoke('hydra-desktop:notification-settings'),
    status: () => ipcRenderer.invoke('hydra-desktop:preferences-status'),
    configure: value => ipcRenderer.invoke('hydra-desktop:preferences-configure', value),
    openStartup: () => ipcRenderer.invoke('hydra-desktop:preferences-startup'),
    setContext: workspaceId => { ipcRenderer.send('hydra-desktop:window-context', workspaceId) },
    notify: value => ipcRenderer.invoke('hydra-desktop:notification', value),
  },
  openSessionWindow: sessionId => ipcRenderer.invoke('hydra-desktop:open-session-window', { sessionId }),
  openExternal: url => ipcRenderer.invoke('hydra-desktop:open-external', { url }),
  chrome: {
    dispatch: action => ipcRenderer.invoke('hydra-desktop:chrome-action', action),
    setTheme: theme => { ipcRenderer.send('hydra-desktop:chrome-theme', theme) },
  },
  browser: {
    setBounds: bounds => { ipcRenderer.send('hydra-desktop:browser-bounds', bounds) },
    setTheme: theme => { ipcRenderer.send('hydra-desktop:browser-theme', theme) },
    configure: settings => ipcRenderer.invoke('hydra-desktop:browser-configure', settings),
    confirmFullCdpAccess: () => ipcRenderer.invoke('hydra-desktop:browser-confirm-full-cdp'),
    clearData: scope => ipcRenderer.invoke('hydra-desktop:browser-clear-data', { scope }),
    openUrl: url => ipcRenderer.invoke('hydra-desktop:browser-open-url', { url }),
    history: () => ipcRenderer.invoke('hydra-desktop:browser-history'),
    removeHistory: id => ipcRenderer.invoke('hydra-desktop:browser-remove-history', { id }),
    downloads: () => ipcRenderer.invoke('hydra-desktop:browser-downloads'),
    removeDownload: id => ipcRenderer.invoke('hydra-desktop:browser-remove-download', { id }),
    openDownload: id => ipcRenderer.invoke('hydra-desktop:browser-open-download', { id }),
    sites: () => ipcRenderer.invoke('hydra-desktop:browser-sites'),
    setSite: value => ipcRenderer.invoke('hydra-desktop:browser-set-site', value),
    removeSite: origin => ipcRenderer.invoke('hydra-desktop:browser-remove-site', { origin }),
    autofillStatus: () => ipcRenderer.invoke('hydra-desktop:browser-autofill-status'),
    autofillListLogins: () => ipcRenderer.invoke('hydra-desktop:browser-autofill-list-logins'),
    autofillSaveLogin: value => ipcRenderer.invoke('hydra-desktop:browser-autofill-save-login', value),
    autofillRemoveLogin: id => ipcRenderer.invoke('hydra-desktop:browser-autofill-remove-login', { id }),
    autofillListContacts: () => ipcRenderer.invoke('hydra-desktop:browser-autofill-list-contacts'),
    autofillGetContact: id => ipcRenderer.invoke('hydra-desktop:browser-autofill-get-contact', { id }),
    autofillSaveContact: value => ipcRenderer.invoke('hydra-desktop:browser-autofill-save-contact', value),
    autofillRemoveContact: id => ipcRenderer.invoke('hydra-desktop:browser-autofill-remove-contact', { id }),
    emitAnnotation(annotation) {
      ipcRenderer.send('hydra-desktop:emit-annotation', annotation)
    },
    onAnnotation(listener) {
      const handler = (_event, annotation) => { listener(annotation) }
      ipcRenderer.on('hydra-desktop:browser-annotation', handler)
      return () => { ipcRenderer.removeListener('hydra-desktop:browser-annotation', handler) }
    },
  },
  terminal: {
    start: (terminalId, size, workspaceId, cwd) => ipcRenderer.invoke('hydra-desktop:terminal-start', { terminalId, size, workspaceId, cwd }),
    stop: terminalId => ipcRenderer.invoke('hydra-desktop:terminal-stop', { terminalId }),
    write: (terminalId, data) => { ipcRenderer.send('hydra-desktop:terminal-write', { terminalId, data }) },
    resize: (terminalId, size) => { ipcRenderer.send('hydra-desktop:terminal-resize', { terminalId, size }) },
    list: () => ipcRenderer.invoke('hydra-desktop:terminal-list'),
    onEvent(terminalId, listener) {
      const handler = (_event, value) => {
        if (value?.terminalId === terminalId) listener(value.event)
      }
      ipcRenderer.on('hydra-desktop:terminal-event', handler)
      return () => { ipcRenderer.removeListener('hydra-desktop:terminal-event', handler) }
    },
  },
  files: {
    openSystem: (path, workspaceId) => ipcRenderer.invoke('hydra-desktop:files-open-system', { path, workspaceId }),
    root: workspaceId => ipcRenderer.invoke('hydra-desktop:files-root', { workspaceId }),
    list: (path, workspaceId) => ipcRenderer.invoke('hydra-desktop:files-list', { path, workspaceId }),
    search: (query, workspaceId) => ipcRenderer.invoke('hydra-desktop:files-search', { query, workspaceId }),
    read: (path, workspaceId) => ipcRenderer.invoke('hydra-desktop:files-read', { path, workspaceId }),
    create: (parentPath, name, kind, workspaceId) =>
      ipcRenderer.invoke('hydra-desktop:files-create', { parentPath, name, kind, workspaceId }),
    rename: (path, newName, workspaceId) =>
      ipcRenderer.invoke('hydra-desktop:files-rename', { path, newName, workspaceId }),
    move: (path, destinationDirectory, workspaceId) =>
      ipcRenderer.invoke('hydra-desktop:files-move', { path, destinationDirectory, workspaceId }),
    delete: (path, workspaceId) =>
      ipcRenderer.invoke('hydra-desktop:files-delete', { path, workspaceId }),
    reveal: (path, workspaceId) =>
      ipcRenderer.invoke('hydra-desktop:files-reveal', { path, workspaceId }),
    save: (path, content, expectedVersion, workspaceId) =>
      ipcRenderer.invoke('hydra-desktop:files-save', { path, content, expectedVersion, workspaceId }),
    format: (path, content, workspaceId) =>
      ipcRenderer.invoke('hydra-desktop:files-format', { path, content, workspaceId }),
  },
  panels: {
    open: kind => ipcRenderer.invoke('hydra-desktop:panel-open', kind),
    onShortcut: listener => {
      const handler = (_event, shortcut) => { listener(shortcut) }
      ipcRenderer.on('hydra-desktop:panel-shortcut', handler)
      return () => { ipcRenderer.removeListener('hydra-desktop:panel-shortcut', handler) }
    },
    onClose: listener => {
      const handler = (_event, kind) => { listener(kind) }
      ipcRenderer.on('hydra-desktop:panel-close', handler)
      return () => { ipcRenderer.removeListener('hydra-desktop:panel-close', handler) }
    },
  },
})

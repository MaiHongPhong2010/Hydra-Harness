// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Context } from '@hydraharness/cordis'
import { bindSnapshotSelector, makeTranslate, stubSettingsScope } from '@hydraharness/harness-client-test-runtime'
import { SlotRegistry } from '@hydraharness/harness-client-runtime/client'
import { LocaleRuntime } from '@hydraharness/harness-client-locale/client'
import { ThemeRuntime, type ThemeSettings } from '@hydraharness/harness-client-ui-theme/client'
import { resolveSlotLabel } from '@hydraharness/harness-client-ui-slots'
import { apply, inject } from '@hydraharness/harness-client-ui-layout/client'
import { BrowserSection } from '../src/client/BrowserSection.tsx'
import type {
  BrowserSectionInjected, BrowserSectionProps, BrowserSettings,
} from '../src/client/BrowserSection.tsx'
import type {
  BrowserContact, BrowserContactInput, BrowserContactMetadata, BrowserDownloadEntry, BrowserHistoryEntry,
  BrowserLoginInput, BrowserLoginMetadata, BrowserNativeSettings, BrowserSitePermission, DesktopBrowserApi,
} from '../src/client/DesktopBrowserPanel.tsx'
import { en } from '../src/client/browser-locales.ts'

const unusedHook = (() => { throw new Error('unused by BrowserSection') }) as never
const kit = { useSessions: unusedHook, useWorkspaces: unusedHook, close: vi.fn(), openSection: vi.fn() }

const SETTINGS: BrowserSettings = {
  controlEnabled: true,
  webDestination: 'hydra',
  localDestination: 'hydra',
  annotationScreenshots: 'include',
  downloadDirectory: '',
  askWhereToSave: false,
  navigationPolicy: 'ask',
  downloadPolicy: 'ask',
  uploadPolicy: 'ask',
  historyAccessPolicy: 'ask',
  fullCdpAccess: false,
}

const NATIVE_SETTINGS: BrowserNativeSettings = {
  webDestination: 'hydra',
  localDestination: 'hydra',
  annotationScreenshots: 'include',
  downloadDirectory: '',
  askWhereToSave: false,
  navigationPolicy: 'ask',
  downloadPolicy: 'ask',
  uploadPolicy: 'ask',
  fullCdpAccess: false,
}

const HISTORY: BrowserHistoryEntry = {
  id: 'history-1',
  url: 'https://example.com/page',
  title: 'Example page',
  visitedAt: '2026-08-27T08:00:00.000Z',
}

const DOWNLOAD: BrowserDownloadEntry = {
  id: 'download-1',
  url: 'https://example.com/report.pdf',
  filename: 'report.pdf',
  path: 'C:\\Downloads\\report.pdf',
  state: 'completed',
  startedAt: '2026-08-27T08:00:00.000Z',
  endedAt: '2026-08-27T08:00:01.000Z',
}

const LOGIN: BrowserLoginMetadata = {
  id: '00000000-0000-4000-8000-000000000001',
  origin: 'https://example.com',
  username: 'user@example.com',
  createdAt: '2026-08-27T08:00:00.000Z',
  updatedAt: '2026-08-27T08:00:00.000Z',
}

const CONTACT_META: BrowserContactMetadata = {
  id: '00000000-0000-4000-8000-000000000002',
  label: 'Work contact',
  createdAt: '2026-08-27T08:00:00.000Z',
  updatedAt: '2026-08-27T08:00:00.000Z',
}

const CONTACT: BrowserContact = {
  ...CONTACT_META,
  fields: { name: 'Example Person', email: 'person@example.com', countryCode: 'DE' },
}

type NativeCallbacks = Pick<BrowserSectionInjected,
  | 'configureNative'
  | 'pickDownloadDirectory'
  | 'clearData'
  | 'openUrl'
  | 'history'
  | 'removeHistory'
  | 'downloads'
  | 'removeDownload'
  | 'sites'
  | 'setSite'
  | 'removeSite'
  | 'autofillStatus'
  | 'logins'
  | 'saveLogin'
  | 'removeLogin'
  | 'contacts'
  | 'getContact'
  | 'saveContact'
  | 'removeContact'
>

afterEach(() => {
  cleanup()
  delete window.hydraDesktop
})

function nativeCallbacks(overrides: Partial<NativeCallbacks> = {}): NativeCallbacks {
  return {
    configureNative: vi.fn(async () => ({ fullCdpAccessAllowed: true })),
    pickDownloadDirectory: vi.fn(async () => 'C:\\Browser downloads'),
    clearData: vi.fn(async () => {}),
    openUrl: vi.fn(async () => {}),
    history: vi.fn(async () => [HISTORY]),
    removeHistory: vi.fn(async () => {}),
    downloads: vi.fn(async () => [DOWNLOAD]),
    removeDownload: vi.fn(async () => {}),
    sites: vi.fn(async () => []),
    setSite: vi.fn(async () => {}),
    removeSite: vi.fn(async () => {}),
    autofillStatus: vi.fn(async () => ({ available: true })),
    logins: vi.fn(async () => []),
    saveLogin: vi.fn(async (value: BrowserLoginInput) => ({
      ...LOGIN, origin: value.origin, username: value.username,
    })),
    removeLogin: vi.fn(async () => true),
    contacts: vi.fn(async () => []),
    getContact: vi.fn(async () => CONTACT),
    saveContact: vi.fn(async (value: BrowserContactInput) => ({ ...CONTACT_META, label: value.label })),
    removeContact: vi.fn(async () => true),
    ...overrides,
  }
}

function mount(options: {
  status?: 'ready' | 'unavailable'
  writable?: boolean
  value?: Partial<BrowserSettings>
  native?: Partial<NativeCallbacks>
  historyOpen?: boolean
  renderSlot?: BrowserSectionProps['renderSlot']
} = {}) {
  const status = options.status ?? 'ready'
  const settings = stubSettingsScope<BrowserSettings>()
  settings.publish(status === 'ready'
    ? { status, value: { ...SETTINGS, ...options.value }, writable: options.writable ?? true }
    : { status, value: undefined, writable: false })
  const native = nativeCallbacks(options.native)
  if (options.historyOpen === false) delete native.openUrl
  const props: BrowserSectionProps = {
    ...kit,
    renderSlot: options.renderSlot ?? vi.fn(() => null),
    t: makeTranslate(en),
    setSetting: (key, value) => settings.scope.set(key, value),
    ...native,
    useSnapshot: bindSnapshotSelector(settings.scope),
  }
  return { settings, native, view: render(<BrowserSection {...props} />) }
}

describe('BrowserSection', () => {
  it('enables native-backed controls including available autofill managers', async () => {
    mount()
    expect(screen.getByRole('region', { name: 'Browser' })).toBeTruthy()
    expect(screen.getAllByRole('heading').map(heading => heading.textContent)).toEqual(expect.arrayContaining([
      'Browser', 'General', 'Autofill and passwords', 'Downloads',
      'Site permissions', 'Developer mode',
    ]))

    await waitFor(() => {
      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Browsing data Clear browsing data' }).disabled).toBe(false)
    })
    expect(screen.getByRole<HTMLButtonElement>('switch', { name: 'Browser' }).disabled).toBe(false)
    expect(screen.getByRole<HTMLButtonElement>('switch', { name: 'Ask where to save downloads' }).disabled).toBe(false)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Browsing history Manage' }).disabled).toBe(false)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Location Change' }).disabled).toBe(false)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Download history Manage' }).disabled).toBe(false)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Site settings Manage' }).disabled).toBe(false)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '+ Add' }).disabled).toBe(false)
    expect(screen.queryByRole('combobox', { name: 'Approval' })).toBeNull()
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: 'Downloads' }).disabled).toBe(false)
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: 'Uploads' }).disabled).toBe(false)
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: 'Browsing' }).disabled).toBe(false)
    const permissions = screen.getByRole('region', { name: 'Browser permissions' })
    expect(within(permissions).getAllByRole('combobox')).toHaveLength(3)
    for (const select of within(permissions).getAllByRole('combobox')) {
      expect(within(select).getAllByRole('option').map(option => option.textContent))
        .toEqual(['Requires approval', 'Always allow', 'Block'])
    }
    expect(screen.queryByRole('heading', { name: /^Permissions$/u })).toBeNull()

    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: 'Web URL and link open destination' }).disabled).toBe(false)
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: 'Local URL open destination' }).disabled).toBe(false)
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: 'Annotation screenshots' }).disabled).toBe(false)
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: 'History' }).disabled).toBe(false)
    await waitFor(() => {
      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Password manager Manage' }).disabled).toBe(false)
      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Contact info Manage' }).disabled).toBe(false)
    })
    await waitFor(() => {
      expect(screen.getByRole<HTMLButtonElement>('switch', { name: 'Enable full CDP access' }).disabled).toBe(false)
    })
  })

  it('keeps autofill managers disabled when secure storage or the preload capability is unavailable', async () => {
    mount({ native: { autofillStatus: vi.fn(async () => ({ available: false, reason: 'Vault locked.' })) } })
    await screen.findAllByText(content => content.endsWith('Vault locked.'))
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Password manager Manage' }).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Contact info Manage' }).disabled).toBe(true)
  })

  it('persists settings and configures native values only from accepted Host snapshots', async () => {
    const { settings, native } = mount()
    await waitFor(() => { expect(native.configureNative).toHaveBeenCalledWith(NATIVE_SETTINGS) })
    vi.mocked(native.configureNative).mockClear()

    fireEvent.change(screen.getByRole('combobox', { name: 'Browsing' }), { target: { value: 'allow' } })
    await waitFor(() => {
      expect(settings.set).toHaveBeenCalledWith('browserPermissions', { browsing: 'allow', downloads: 'ask', uploads: 'ask' })
    })

    fireEvent.click(screen.getByRole('switch', { name: 'Browser' }))
    await waitFor(() => { expect(settings.set).toHaveBeenCalledWith('controlEnabled', false) })

    fireEvent.click(screen.getByRole('switch', { name: 'Ask where to save downloads' }))
    await waitFor(() => { expect(settings.set).toHaveBeenCalledWith('askWhereToSave', true) })
    expect(native.configureNative).not.toHaveBeenCalled()
    settings.publish({ value: { ...SETTINGS, askWhereToSave: true } })
    await waitFor(() => {
      expect(native.configureNative).toHaveBeenCalledWith({ ...NATIVE_SETTINGS, askWhereToSave: true })
    })
    vi.mocked(native.configureNative).mockClear()

    fireEvent.change(screen.getByRole('combobox', { name: 'Web URL and link open destination' }), {
      target: { value: 'system' },
    })
    fireEvent.change(screen.getByRole('combobox', { name: 'Local URL open destination' }), {
      target: { value: 'system' },
    })
    fireEvent.change(screen.getByRole('combobox', { name: 'Annotation screenshots' }), {
      target: { value: 'never' },
    })
    fireEvent.change(screen.getByRole('combobox', { name: 'History' }), { target: { value: 'block' } })
    await waitFor(() => {
      expect(settings.set).toHaveBeenCalledWith('webDestination', 'system')
      expect(settings.set).toHaveBeenCalledWith('localDestination', 'system')
      expect(settings.set).toHaveBeenCalledWith('annotationScreenshots', 'never')
      expect(settings.set).toHaveBeenCalledWith('historyAccessPolicy', 'block')
    })

    fireEvent.click(screen.getByRole('button', { name: 'Location Change' }))
    await waitFor(() => {
      expect(native.pickDownloadDirectory).toHaveBeenCalledOnce()
      expect(settings.set).toHaveBeenCalledWith('downloadDirectory', 'C:\\Browser downloads')
    })
    expect(native.configureNative).not.toHaveBeenCalled()
  })

  it('does not persist Full CDP when native confirmation is rejected', async () => {
    const confirmFullCdpAccess = vi.fn(async () => false)
    window.hydraDesktop = { browser: { setBounds: vi.fn(), confirmFullCdpAccess } }
    const { settings } = mount()
    const toggle = screen.getByRole<HTMLButtonElement>('switch', { name: 'Enable full CDP access' })
    await waitFor(() => { expect(toggle.disabled).toBe(false) })

    fireEvent.click(toggle)
    await waitFor(() => { expect(confirmFullCdpAccess).toHaveBeenCalledOnce() })
    expect(settings.set).not.toHaveBeenCalledWith('fullCdpAccess', true)
  })

  it('persists Full CDP only after native confirmation is accepted', async () => {
    const confirmFullCdpAccess = vi.fn(async () => true)
    window.hydraDesktop = { browser: { setBounds: vi.fn(), confirmFullCdpAccess } }
    const { settings } = mount()
    const toggle = screen.getByRole<HTMLButtonElement>('switch', { name: 'Enable full CDP access' })
    await waitFor(() => { expect(toggle.disabled).toBe(false) })

    fireEvent.click(toggle)
    await waitFor(() => {
      expect(confirmFullCdpAccess).toHaveBeenCalledOnce()
      expect(settings.set).toHaveBeenCalledWith('fullCdpAccess', true)
    })
  })

  it('turns Full CDP off without confirmation', async () => {
    const confirmFullCdpAccess = vi.fn(async () => true)
    window.hydraDesktop = { browser: { setBounds: vi.fn(), confirmFullCdpAccess } }
    const { settings } = mount({ value: { fullCdpAccess: true } })
    const toggle = screen.getByRole<HTMLButtonElement>('switch', { name: 'Enable full CDP access' })
    await waitFor(() => { expect(toggle.disabled).toBe(false) })

    fireEvent.click(toggle)
    await waitFor(() => { expect(settings.set).toHaveBeenCalledWith('fullCdpAccess', false) })
    expect(confirmFullCdpAccess).not.toHaveBeenCalled()
  })

  it('locks Full CDP when the native capability is disabled', async () => {
    const confirmFullCdpAccess = vi.fn(async () => true)
    window.hydraDesktop = { browser: { setBounds: vi.fn(), confirmFullCdpAccess } }
    mount({ native: { configureNative: vi.fn(async () => ({ fullCdpAccessAllowed: false })) } })

    const toggle = screen.getByRole<HTMLButtonElement>('switch', { name: 'Enable full CDP access' })
    await waitFor(() => { expect(toggle.disabled).toBe(true) })
    expect(screen.getByText(content => content.endsWith(en['browser.fullCdpLocked']))).toBeTruthy()
    expect(confirmFullCdpAccess).not.toHaveBeenCalled()
  })

  it('adds and removes password-free login metadata and clears the transient password after save', async () => {
    const logins = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([LOGIN])
      .mockResolvedValueOnce([])
    const saveLogin = vi.fn(async () => LOGIN)
    const { native } = mount({ native: { logins, saveLogin } })
    const manage = screen.getByRole<HTMLButtonElement>('button', { name: 'Password manager Manage' })
    await waitFor(() => { expect(manage.disabled).toBe(false) })
    fireEvent.click(manage)
    const manager = await screen.findByRole('dialog', { name: 'Password manager' })
    fireEvent.click(within(manager).getByRole('button', { name: '+ Add' }))

    const editor = screen.getByRole('dialog', { name: en['browser.addLogin'] })
    fireEvent.change(within(editor).getByRole('textbox', { name: en['browser.loginOrigin'] }), {
      target: { value: LOGIN.origin },
    })
    fireEvent.change(within(editor).getByRole('textbox', { name: en['browser.loginUsername'] }), {
      target: { value: LOGIN.username },
    })
    const password = within(editor).getByLabelText<HTMLInputElement>(en['browser.loginPassword'])
    fireEvent.change(password, { target: { value: 'secret-value' } })
    fireEvent.click(within(editor).getByRole('button', { name: en['browser.save'] }))
    await waitFor(() => {
      expect(native.saveLogin).toHaveBeenCalledWith({
        origin: LOGIN.origin, username: LOGIN.username, password: 'secret-value',
      })
      expect(password.value).toBe('')
    })

    const reopened = await screen.findByRole('dialog', { name: 'Password manager' })
    expect(within(reopened).queryByText('secret-value')).toBeNull()
    expect(within(reopened).getByText(LOGIN.username)).toBeTruthy()
    fireEvent.click(within(reopened).getByRole('button', { name: `Remove ${LOGIN.origin} ${LOGIN.username}` }))
    await waitFor(() => { expect(native.removeLogin).toHaveBeenCalledWith(LOGIN.id) })
  })

  it('omits a blank password when editing a saved login', async () => {
    const saveLogin = vi.fn(async () => LOGIN)
    mount({ native: { logins: vi.fn(async () => [LOGIN]), saveLogin } })
    const manage = screen.getByRole<HTMLButtonElement>('button', { name: 'Password manager Manage' })
    await waitFor(() => { expect(manage.disabled).toBe(false) })
    fireEvent.click(manage)
    const manager = await screen.findByRole('dialog', { name: 'Password manager' })
    fireEvent.click(within(manager).getByRole('button', { name: en['browser.edit'] }))
    const editor = screen.getByRole('dialog', { name: en['browser.editLogin'] })
    const password = within(editor).getByLabelText<HTMLInputElement>(en['browser.loginPassword'])
    expect(password.value).toBe('')
    fireEvent.click(within(editor).getByRole('button', { name: en['browser.save'] }))
    await waitFor(() => {
      expect(saveLogin).toHaveBeenCalledWith({ id: LOGIN.id, origin: LOGIN.origin, username: LOGIN.username })
    })
  })

  it('loads full contact fields only for edit and saves only the vault allowlist', async () => {
    const contacts = vi.fn()
      .mockResolvedValueOnce([CONTACT_META])
      .mockResolvedValueOnce([CONTACT_META])
      .mockResolvedValueOnce([])
    const saveContact = vi.fn(async () => CONTACT_META)
    const { native } = mount({ native: { contacts, saveContact } })
    const manage = screen.getByRole<HTMLButtonElement>('button', { name: 'Contact info Manage' })
    await waitFor(() => { expect(manage.disabled).toBe(false) })
    fireEvent.click(manage)
    const manager = await screen.findByRole('dialog', { name: 'Contact info' })
    expect(within(manager).queryByText(CONTACT.fields.email!)).toBeNull()
    fireEvent.click(within(manager).getByRole('button', { name: en['browser.edit'] }))
    await waitFor(() => { expect(native.getContact).toHaveBeenCalledWith(CONTACT_META.id) })

    const editor = await screen.findByRole('dialog', { name: en['browser.editContact'] })
    expect(within(editor).getByRole<HTMLInputElement>('textbox', { name: en['browser.contactEmail'] }).value)
      .toBe(CONTACT.fields.email)
    fireEvent.change(within(editor).getByRole('textbox', { name: en['browser.contactTelephone'] }), {
      target: { value: ' 12345 ' },
    })
    fireEvent.click(within(editor).getByRole('button', { name: en['browser.save'] }))
    await waitFor(() => {
      expect(native.saveContact).toHaveBeenCalledWith({
        id: CONTACT.id,
        label: CONTACT.label,
        fields: { ...CONTACT.fields, tel: '12345' },
      })
    })

    const reopened = await screen.findByRole('dialog', { name: 'Contact info' })
    fireEvent.click(within(reopened).getByRole('button', { name: `Remove ${CONTACT_META.label}` }))
    await waitFor(() => { expect(native.removeContact).toHaveBeenCalledWith(CONTACT_META.id) })
  })

  it('keeps site mutations disabled for a read-only Host snapshot', async () => {
    const site: BrowserSitePermission = { origin: 'https://example.com', access: 'block', media: 'block' }
    mount({ writable: false, native: { sites: vi.fn(async () => [site]) } })

    expect(await screen.findByText(site.origin)).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en['browser.edit'] }).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: `Remove ${site.origin}` }).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '+ Add' }).disabled).toBe(true)
  })

  it('requires acknowledgement before clearing native browsing data', async () => {
    const { native } = mount()
    fireEvent.click(screen.getByRole('button', { name: 'Browsing data Clear browsing data' }))
    const dialog = screen.getByRole('dialog', { name: en['browser.clearTitle'] })
    const confirm = within(dialog).getByRole<HTMLButtonElement>('button', { name: en['browser.clearData'] })
    expect(confirm.disabled).toBe(true)

    fireEvent.click(within(dialog).getByRole('checkbox', { name: en['browser.clearAcknowledge'] }))
    expect(confirm.disabled).toBe(false)
    fireEvent.click(confirm)
    await waitFor(() => { expect(native.clearData).toHaveBeenCalledWith('all') })
    await waitFor(() => { expect(screen.queryByRole('dialog', { name: en['browser.clearTitle'] })).toBeNull() })
  })

  it('clears only the selected browser data scope', async () => {
    const { native } = mount()
    fireEvent.change(screen.getByRole('combobox', { name: en['browser.clearScope'] }), {
      target: { value: 'history' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Browsing data Clear browsing data' }))
    const dialog = screen.getByRole('dialog', { name: en['browser.clearTitle'] })
    expect(within(dialog).getByText(/Selected: Browsing history only\./u)).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('checkbox', { name: en['browser.clearAcknowledge'] }))
    fireEvent.click(within(dialog).getByRole('button', { name: en['browser.clearData'] }))
    await waitFor(() => { expect(native.clearData).toHaveBeenCalledWith('history') })
  })

  it('searches, reopens, and removes browser history and download history', async () => {
    const { native } = mount()
    fireEvent.click(screen.getByRole('button', { name: 'Browsing history Manage' }))
    const historyDialog = await screen.findByRole('dialog', { name: 'Browsing history' })
    expect(await within(historyDialog).findByText(HISTORY.url)).toBeTruthy()
    fireEvent.change(within(historyDialog).getByRole('searchbox', { name: en['browser.searchHistory'] }), {
      target: { value: 'example' },
    })
    fireEvent.click(within(historyDialog).getByRole('button', { name: `Open ${HISTORY.title}` }))
    await waitFor(() => { expect(native.openUrl).toHaveBeenCalledWith(HISTORY.url) })
    await waitFor(() => { expect(screen.queryByRole('dialog', { name: 'Browsing history' })).toBeNull() })

    fireEvent.click(screen.getByRole('button', { name: 'Browsing history Manage' }))
    const reopenedHistoryDialog = await screen.findByRole('dialog', { name: 'Browsing history' })
    fireEvent.click(within(reopenedHistoryDialog).getByRole('button', { name: `Remove ${HISTORY.title}` }))
    await waitFor(() => { expect(native.removeHistory).toHaveBeenCalledWith(HISTORY.id) })
    fireEvent.click(within(reopenedHistoryDialog).getByRole('button', { name: en['browser.close'] }))

    fireEvent.click(screen.getByRole('button', { name: 'Download history Manage' }))
    const downloadDialog = await screen.findByRole('dialog', { name: 'Download history' })
    expect(await within(downloadDialog).findByText(DOWNLOAD.path)).toBeTruthy()
    fireEvent.change(within(downloadDialog).getByRole('searchbox', { name: en['browser.searchDownloads'] }), {
      target: { value: 'report' },
    })
    fireEvent.click(within(downloadDialog).getByRole('button', { name: `Remove ${DOWNLOAD.filename}` }))
    await waitFor(() => { expect(native.removeDownload).toHaveBeenCalledWith(DOWNLOAD.id) })
  })

  it('omits the history reopen action when the desktop preload lacks it', async () => {
    mount({ historyOpen: false })
    fireEvent.click(screen.getByRole('button', { name: 'Browsing history Manage' }))
    const dialog = await screen.findByRole('dialog', { name: 'Browsing history' })
    expect(within(dialog).queryByRole('button', { name: `Open ${HISTORY.title}` })).toBeNull()
  })

  it('adds, edits, and removes canonical site overrides returned by the browser', async () => {
    const blocked: BrowserSitePermission = { origin: 'https://example.com', access: 'block', media: 'block' }
    const allowed: BrowserSitePermission = { ...blocked, access: 'allow' }
    const sites = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([blocked])
      .mockResolvedValueOnce([allowed])
      .mockResolvedValueOnce([])
    const { native } = mount({ native: { sites } })
    await screen.findByText(en['browser.noSiteOverrides'])

    fireEvent.click(screen.getByRole('button', { name: '+ Add' }))
    const addDialog = screen.getByRole('dialog', { name: en['browser.addSite'] })
    fireEvent.change(within(addDialog).getByRole('textbox', { name: en['browser.siteOrigin'] }), {
      target: { value: ' https://EXAMPLE.com/path ' },
    })
    fireEvent.click(within(addDialog).getByRole('button', { name: en['browser.save'] }))
    await waitFor(() => {
      expect(native.setSite).toHaveBeenCalledWith({
        origin: 'https://EXAMPLE.com/path', access: 'block', media: 'block',
      })
    })
    expect(await screen.findByText(blocked.origin)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: en['browser.edit'] }))
    const editDialog = screen.getByRole('dialog', { name: en['browser.editSite'] })
    const origin = within(editDialog).getByRole<HTMLInputElement>('textbox', { name: en['browser.siteOrigin'] })
    expect(origin.disabled).toBe(true)
    fireEvent.change(within(editDialog).getByRole('combobox', { name: en['browser.siteAccess'] }), {
      target: { value: 'allow' },
    })
    fireEvent.click(within(editDialog).getByRole('button', { name: en['browser.save'] }))
    await waitFor(() => {
      expect(native.setSite).toHaveBeenCalledWith(allowed)
      expect(screen.getByText(`${en['browser.siteAccess']}: ${en['browser.allow']} · ${en['browser.siteMedia']}: ${en['browser.block']}`)).toBeTruthy()
    })

    fireEvent.click(screen.getByRole('button', { name: `Remove ${blocked.origin}` }))
    await waitFor(() => { expect(native.removeSite).toHaveBeenCalledWith(blocked.origin) })
    await screen.findByText(en['browser.noSiteOverrides'])
  })

  it('renders feature-owned Browser items after the control', () => {
    const renderSlot = vi.fn(() => (
      <div data-slot="settings.browser.item">
        <div role="listitem">Web search</div>
      </div>
    ))
    mount({ renderSlot })

    expect(renderSlot).toHaveBeenCalledWith('settings.browser.item', {})
    const list = screen.getByText('Web search').closest('[role="list"]')
    expect(list).toBeTruthy()
    expect(list?.querySelector('ul')).toBeNull()
    expect(list?.querySelector('[data-slot] > [role="listitem"]')).toBeTruthy()
  })

  it('reports a rejected write and disables writes while settings are unavailable', async () => {
    const rejected = mount()
    rejected.settings.set.mockRejectedValueOnce(new Error('write failed'))
    fireEvent.click(screen.getByRole('switch', { name: 'Browser' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Error: write failed')
    cleanup()

    const unavailable = mount({ status: 'unavailable' })
    const control = screen.getByRole<HTMLButtonElement>('switch', { name: 'Browser' })
    expect(control.getAttribute('aria-checked')).toBe('true')
    expect(control.disabled).toBe(true)
    expect(screen.getByRole('status').textContent).toBe(en['browser.unavailable'])
    expect(unavailable.native.configureNative).not.toHaveBeenCalled()
  })
})

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  const scope = stubSettingsScope<BrowserSettings>()
  const bind = vi.fn(() => scope.scope)
  const pickDirectory = vi.fn(async () => 'C:\\Picked')
  ctx.provide('settingsScope', { bind } as never)
  ctx.provide('theme', new ThemeRuntime(ctx, stubSettingsScope<ThemeSettings>().scope))
  ctx.provide('sessions', {} as never)
  ctx.provide('workspaces', { pickDirectory } as never)
  return { ctx, slots: ctx.get('slots') as SlotRegistry, locale, scope, bind, pickDirectory }
}

function declareSettings(slots: SlotRegistry): void {
  slots.register({
    name: 'sidebar',
    children: { 'sidebar.settings': { kind: 'single', scope: 'root' } },
  } as never, () => null)
  slots.register({
    name: 'sidebar.settings',
    children: { 'settings.section': { kind: 'list', scope: 'root' } },
  } as never, () => null)
}

describe('Browser settings registration', () => {
  it('registers only on desktop and injects settings, picker, and native management callbacks', async () => {
    const web = await bench()
    await web.ctx.plugin({ inject: [...inject], apply }).await()
    declareSettings(web.slots)
    expect(web.slots.entries('settings.section')).toHaveLength(0)
    expect(web.bind).not.toHaveBeenCalledWith({ namespace: 'browser-electron' })

    window.hydraDesktop = { browser: { setBounds: vi.fn() } }
    const olderDesktop = await bench()
    await olderDesktop.ctx.plugin({ inject: [...inject], apply }).await()
    declareSettings(olderDesktop.slots)
    expect(olderDesktop.slots.entries('settings.section')).toHaveLength(0)
    expect(olderDesktop.bind).not.toHaveBeenCalledWith({ namespace: 'browser-electron' })

    const browser = {
      setBounds: vi.fn(),
      configure: vi.fn(async () => ({ fullCdpAccessAllowed: true })),
      confirmFullCdpAccess: vi.fn(async () => true),
      clearData: vi.fn(async () => {}),
      openUrl: vi.fn(async () => {}),
      history: vi.fn(async () => [HISTORY]),
      removeHistory: vi.fn(async () => {}),
      downloads: vi.fn(async () => [DOWNLOAD]),
      removeDownload: vi.fn(async () => {}),
      sites: vi.fn(async () => []),
      setSite: vi.fn(async () => {}),
      removeSite: vi.fn(async () => {}),
      autofillStatus: vi.fn(async () => ({ available: true })),
      autofillListLogins: vi.fn(async () => [LOGIN]),
      autofillSaveLogin: vi.fn(async () => LOGIN),
      autofillRemoveLogin: vi.fn(async () => true),
      autofillListContacts: vi.fn(async () => [CONTACT_META]),
      autofillGetContact: vi.fn(async () => CONTACT),
      autofillSaveContact: vi.fn(async () => CONTACT_META),
      autofillRemoveContact: vi.fn(async () => true),
    } satisfies DesktopBrowserApi
    window.hydraDesktop = { browser }
    const desktop = await bench()
    await desktop.ctx.plugin({ inject: [...inject], apply }).await()
    declareSettings(desktop.slots)
    expect(desktop.bind).toHaveBeenCalledWith({ namespace: 'browser-electron' })
    const entry = desktop.slots.entries('settings.section')[0]!
    expect(entry.component).toBe(BrowserSection)
    expect(entry.options).toMatchObject({ id: 'browser', order: 5 })
    expect(entry.locale).toBe('settings.browser')
    expect(desktop.slots.spec('settings.browser.item')).toMatchObject({ kind: 'list', scope: 'root' })
    expect(resolveSlotLabel(entry.options.label)).toBe('Browser')

    const injected = (entry.inject as unknown as () => BrowserSectionInjected)()
    expect(injected.hooks.snapshot).toBe(desktop.scope.scope)
    expect(injected).not.toHaveProperty('scope')
    await injected.setSetting('downloadPolicy', 'block')
    expect(desktop.scope.set).toHaveBeenCalledWith('downloadPolicy', 'block')
    await injected.configureNative(NATIVE_SETTINGS)
    expect(browser.configure).toHaveBeenCalledWith(NATIVE_SETTINGS)
    await expect(injected.pickDownloadDirectory()).resolves.toBe('C:\\Picked')
    expect(desktop.pickDirectory).toHaveBeenCalledOnce()
    await injected.clearData('all')
    await injected.openUrl?.(HISTORY.url)
    await injected.history()
    await injected.removeHistory(HISTORY.id)
    await injected.downloads()
    await injected.removeDownload(DOWNLOAD.id)
    await injected.sites()
    await injected.setSite({ origin: 'https://example.com', access: 'allow', media: 'block' })
    await injected.removeSite('https://example.com')
    await injected.autofillStatus()
    await injected.logins()
    await injected.saveLogin({ origin: LOGIN.origin, username: LOGIN.username, password: 'secret' })
    await injected.removeLogin(LOGIN.id)
    await injected.contacts()
    await injected.getContact(CONTACT.id)
    await injected.saveContact({ label: CONTACT.label, fields: CONTACT.fields })
    await injected.removeContact(CONTACT.id)
    expect(browser.clearData).toHaveBeenCalledWith('all')
    expect(browser.openUrl).toHaveBeenCalledWith(HISTORY.url)
    expect(browser.history).toHaveBeenCalledOnce()
    expect(browser.removeHistory).toHaveBeenCalledWith(HISTORY.id)
    expect(browser.downloads).toHaveBeenCalledOnce()
    expect(browser.removeDownload).toHaveBeenCalledWith(DOWNLOAD.id)
    expect(browser.sites).toHaveBeenCalledOnce()
    expect(browser.setSite).toHaveBeenCalledOnce()
    expect(browser.removeSite).toHaveBeenCalledWith('https://example.com')
    expect(browser.autofillStatus).toHaveBeenCalledOnce()
    expect(browser.autofillListLogins).toHaveBeenCalledOnce()
    expect(browser.autofillSaveLogin).toHaveBeenCalledOnce()
    expect(browser.autofillRemoveLogin).toHaveBeenCalledWith(LOGIN.id)
    expect(browser.autofillListContacts).toHaveBeenCalledOnce()
    expect(browser.autofillGetContact).toHaveBeenCalledWith(CONTACT.id)
    expect(browser.autofillSaveContact).toHaveBeenCalledOnce()
    expect(browser.autofillRemoveContact).toHaveBeenCalledWith(CONTACT.id)
  })

  it('keeps Browser settings registered but fails autofill closed for an older preload', async () => {
    const browser = {
      setBounds: vi.fn(),
      configure: vi.fn(async () => ({ fullCdpAccessAllowed: true })),
      clearData: vi.fn(async () => {}),
      history: vi.fn(async () => []),
      removeHistory: vi.fn(async () => {}),
      downloads: vi.fn(async () => []),
      removeDownload: vi.fn(async () => {}),
      sites: vi.fn(async () => []),
      setSite: vi.fn(async () => {}),
      removeSite: vi.fn(async () => {}),
    } satisfies DesktopBrowserApi
    window.hydraDesktop = { browser }
    const desktop = await bench()
    await desktop.ctx.plugin({ inject: [...inject], apply }).await()
    declareSettings(desktop.slots)
    const injected = (desktop.slots.entries('settings.section')[0]!.inject as unknown as () => BrowserSectionInjected)()
    expect(typeof injected.openUrl).toBe('undefined')
    await expect(injected.autofillStatus()).resolves.toEqual({ available: false })
    await expect(injected.logins()).rejects.toThrow('secure autofill storage is unavailable')
  })
})

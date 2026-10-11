/** Notices are bundled with this client artifact rather than fetched from a mutable checkout. */
import { useState } from 'react'
import { Button, Modal } from '@hydraharness/harness-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@hydraharness/harness-client-ui-slots'
import { artifactNotices } from './artifact-notices.ts'

/**
 * @param props - row locale.
 * @returns a viewer for the artifact's generated notices.
 */
export function LicensesRow({ t }: PropsRuntime<'settings.general.general.item'> & PropsLocale<'settings.desktop'>) {
  const [open, setOpen] = useState(false)
  return <div style={{ padding: '14px 0', display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'center' }}>
    <div style={{ flex: 1 }}><div>{t('licenses.title')}</div><small>{t('licenses.description')}</small></div>
    <Button size="sm" onClick={() => { setOpen(true) }}>{t('licenses.view')}</Button>
    <Modal open={open} onClose={() => { setOpen(false) }} title={t('licenses.title')}>
      <pre style={{ whiteSpace: 'pre-wrap', maxHeight: '65vh', overflow: 'auto', overflowWrap: 'anywhere' }}>{artifactNotices}</pre>
    </Modal>
  </div>
}

/** Layout preferences persisted by the Host and executed by the Desktop feature owner. */

/** Settings namespace for desktop chrome and panel behavior. */
export const DESKTOP_PREFERENCES_NAMESPACE = 'desktop-ui'

/** Scalar desktop preferences; the shell and close policy apply to new resources. */
export interface DesktopPreferences {
  /** Detected executable path, or automatic shell discovery. */
  terminalShell: string
  /** Close confirmation precedes window teardown. */
  closeConfirmation: 'never' | 'shortcut' | 'always'
  /** Global accelerator; empty disables it. */
  popoutHotkey: string
  /** Whether a popout creates a chat outside the selected project. */
  popoutStandalone: boolean
  /** Default destination for a clicked file. */
  fileOpenDestination: 'editor' | 'terminal' | 'system'
  /** Share the workspace tab host with a newly opened chat. */
  fullView: boolean
  /** Whether the title bar exposes the bottom panel control. */
  bottomPanelControl: boolean
  /** Default location of newly opened terminals. */
  terminalLocation: 'bottom' | 'right'
}

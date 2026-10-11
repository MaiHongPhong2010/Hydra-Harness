/**
 * Native backend of the directory-picker seam: registers `ctx.directoryPicker`
 * with the `native` capability, opening one native OS chooser on the host
 * display per pick (macOS `osascript`, Linux Zenity with a KDialog fallback;
 * Windows opens the modern `IFileOpenDialog` in a spawned child process — a
 * koffi-driven COM conversation on the child's main thread). Only viable when
 * the operator sits at the host's screen; remote deployments compose the
 * browse backend instead.
 * @module @hydraharness/harness-host-directory-picker-native
 */

import { DirectoryPicker } from '@hydraharness/harness-host-directory-picker'
import type { DirectoryPickerCapability } from '@hydraharness/harness-host-directory-picker'
import { pickNativeDirectory } from './native-picker.ts'
import { desktopNativeRequest, desktopPort } from '@hydraharness/harness-native-command/desktop-bridge'

export type { DirectoryPickerInternals, DirectoryPickerRunner } from './native-picker.ts'
export { pickNativeDirectory } from './native-picker.ts'

/** The `ctx.directoryPicker` native implementation (stable capability object per service life). */
export default class NativeDirectoryPicker extends DirectoryPicker {
  private readonly nativeCapability: DirectoryPickerCapability = {
    kind: 'native',
    /* v8 ignore next -- pure forward to pickNativeDirectory (its spec owns behavior); invoking here opens a real chooser. */
    pick: async (signal) => {
      if (desktopPort() === undefined) return pickNativeDirectory(signal)
      const value = await desktopNativeRequest('pick-directory', undefined, signal)
      if (value !== null && typeof value !== 'string') throw new Error('Desktop returned an invalid directory')
      return value
    },
  }

  /**
   * The native interaction capability.
   * @returns the stable `native` capability object.
   */
  capability(): DirectoryPickerCapability {
    return this.nativeCapability
  }
}

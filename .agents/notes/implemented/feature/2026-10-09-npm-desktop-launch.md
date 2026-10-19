# Agent Note: Launch Desktop from the npm CLI

Status: implemented

## Problem

The npm launcher offers a Desktop choice but cannot open the Electron app. A source-only workflow prevents users from starting the same native browser, terminal, and file panels through npx.

## Decision

The [CLI](../../../../apps/cli/src/desktop.ts) launches its installed Electron executable with the [Desktop entry](../../../../apps/desktop/main.cjs), forwards arguments, waits for termination, and returns its status. Both `hydra desktop` and the interactive Desktop choice use this runner. The launcher clears `ELECTRON_RUN_AS_NODE` and passes its own built CLI entry through `HYDRA_DESKTOP_CLI_ENTRY`, so the embedded Host comes from the running installation even under the GitHub Packages mirror name.

Electron launches with `windowsHide: false`: Windows process startup hiding suppresses its first native window even after `BrowserWindow.show()`. Hidden smoke runs verify renderer and Host behavior but cannot establish normal window visibility; normal Windows launches need a visible native window check.

On Windows, npx Desktop launches outside CI use the [persistent npm installer](2026-10-06-npx-persistent-command.md) before creating or updating `Hydra Harness.lnk`. The [CLI shortcut runner](../../../../apps/cli/src/desktop-shortcut.ts) starts the installed Electron [Windows identity module](../../../../apps/desktop/windows-identity.cjs), which writes and reads back the native shortcut through `shell.writeShortcutLink` and `shell.readShortcutLink`. Its AppUserModelID matches the window's `org.hydraharness.desktop.window`; the icon and relaunch command identify Hydra when Windows pins a running window. The process ID remains separate for Electron's notification registration. The shortcut uses the redirected Desktop known folder and targets the global Electron executable with the global Desktop entry, Hydra icon, and user home working directory. The initial npx launch also opens that verified global installation. Creation errors stop launch and report failure. Help, other explicit modes, direct Hydra, and source launches do not create shortcuts.

The CLI declares Desktop as a dependency; Desktop declares the CLI as a peer and development dependency. The [release order](../../../../scripts/release/families.ts) honors the install edge without creating an install cycle. The [CLI packer](../../../../scripts/release/pack-cli-bundle.ts) includes Desktop through its existing dependency closure. Electron and node-pty remain external platform dependencies installed by npm; the [patched-dependency note](../process/2026-10-05-patched-dependencies-in-npm-cli.md) owns that policy. Desktop's snapshot fixtures accompany its payload so the real native smoke can run from an isolated installation.

The [Desktop guide](../../../../docs/user/guide/desktop.md) documents npm and source launches. This extends the distribution described by the [guide publication note](2026-09-27-publish-desktop-guide.md); the [installer roadmap](../../proposed/process/2026-09-27-desktop-packaging-and-release-roadmap.md) still owns standalone installers, signing, updating, and crash reporting.

## Alternatives considered

**Require a source checkout.** This adds Git, pnpm, and a repository build to the requested npx workflow even though the Electron app already uses installed package resolution.

**Give Desktop an ordinary CLI dependency while the CLI installs Desktop.** That creates an install cycle which the release order correctly rejects. A peer identifies the host installation Desktop requires.

**Create a second desktop Host or installer.** The existing Web Host supplies the renderer and plugin runtime; duplicating it or adding installer policy exceeds npm launch support.

**Point the shortcut into the npx cache or invoke npx on every click.** Cache eviction can break the former; the latter requires npm again and opens a terminal. A verified global Electron installation supplies a stable native executable without another launcher or dependency.

## Consequences

The npm installation includes the Desktop shell and requires Electron's optional dependency and download script. A graphical session is required. Native smoke checks exercise the installed Host, embedded browser, Files, PowerShell terminals, and shutdown separately from Web HTTP checks. CLI snapshots retain the assembled menu and boot-free help output. Knip's unlisted-dependency exception is limited to the packed-install script, whose dependency lookups use the isolated consumer installation. npm remains responsible for updates and removal; signing and auto-update are not part of this distribution.

# Agent Note: Desktop title bar and application menus

Status: implemented

## Problem

The Electron shell used the platform titlebar and exposed no product-level Back, Forward, Sidebar, File, Edit, View, or Help controls. The desktop window also needed a stable content inset for native window controls without widening the renderer's IPC authority.

## Decision

Electron renders the web client with a custom top bar inside the titlebar overlay on supported desktop platforms. The bar provides Back and Forward controls, a Sidebar control, and File, Edit, View, and Help menus. Renderer menus use the shared `Menu` and `Tooltip` primitives, keep their triggers keyboard-operable, and route session, workspace, and panel actions through the existing client services. Actions that require the main process use a narrow allowlist for editing commands, zoom, fullscreen, close, and help. ChatGPT-only menu entries are not presented because Hydra does not provide their backing behavior.

The main-process `before-input-event` handler recognizes Ctrl+plus, Ctrl+equals, Ctrl+minus, and Ctrl+0 only in the application renderer. Keyboard and View-menu zoom actions use the same zoom-step implementation; a reset restores 100%. Alt combinations and shifted minus or zero do not trigger application zoom. Embedded Browser contents retain their own shortcut handling.

The theme's global base stylesheet reads Electron's `titlebar-area-x`, `titlebar-area-width`, and `titlebar-area-height` environment variables into inherited custom properties consumed by the titlebar's CSS Module. CSS Modules rename environment-variable identifiers in the client bundle, so the native geometry stays in the global sheet. The desktop grid sizes its first row from the bar; its height covers the native caption controls when renderer zoom falls below 100%, keeping panel headers and Review below them.

## Alternatives considered

**Keep the platform titlebar and native application menu.** Rejected because the desktop surface needs the same product controls and visual height across supported platforms, while the renderer owns session, workspace, and panel state.

**Expose a general renderer-to-main action channel.** Rejected because editing, zoom, fullscreen, close, and help are the complete native action set; an allowlist keeps the preload authority explicit.

**Copy ChatGPT's full menu catalog.** Rejected because entries without Hydra services would advertise behavior the product cannot execute.

**Reserve a fixed caption width and height.** Rejected because native controls retain their display size while renderer CSS pixels change with zoom, allowing panel controls and headers to enter the caption area.

## Consequences

The desktop shell reserves the native caption area and keeps the product bar at least 36 CSS pixels tall. Browser clients keep the existing web layout without the desktop bar. Menu keyboard handling and tooltips remain shared UI behavior, while native operations remain sender-validated and limited to the allowlisted actions.

## Testing

The desktop smoke and focused `ui-layout` checks cover the custom bar's rendered controls, menu actions, titlebar geometry, and native action dispatch; browser-only runs continue to exercise the web shell without desktop titlebar state.

`pnpm --filter @hydraharness/harness-desktop run smoke:zoom` sends native key events through the real Host and renderer and replays [the zoom shortcut snapshot](../../../../apps/desktop/tests/snapshots/zoom-shortcuts.expected.md), including shifted plus, zoom out below 100%, reset, and ignored modifier combinations. It also measures every titlebar button and the Review option against native caption geometry across four window sizes and six zoom levels with the right panel normal and expanded. It uses a separate process from the Files, Terminal, and embedded Browser smoke so zoom changes do not alter their initial viewport. Smoke runs require a temporary `HYDRA_HOME` to isolate user data.

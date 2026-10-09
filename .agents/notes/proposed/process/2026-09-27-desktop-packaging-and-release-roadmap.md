# Agent Note: Desktop packaging and release roadmap

Status: proposed

## Problem

Hydra Desktop is a Windows-first Electron developer preview launched from npm or a source checkout. The [npm Desktop launcher](../../implemented/feature/2026-10-09-npm-desktop-launch.md) supplies the Electron shell and embedded browser/terminal layout. Standalone installers, signing, updating, and crash-reporting policy remain future release work.

## Proposal

Keep the source desktop launch around the existing Web Host and React renderer in one Electron `BrowserWindow`. The controlled browser remains an isolated `WebContentsView`, terminal and browser panels can coexist and restore their layout, and the first distributable target is an unpacked x64 build followed by an NSIS installer after smoke validation.

The packaging work must produce deterministic artifacts containing the renderer, CLI runtime closure, profile configuration, Electron preload, product icon, metadata, and uninstall behavior. A clean Windows VM must verify install, first launch, upgrade, uninstall, and profile-data retention before release.

Release hardening waits for its own decisions: code signing and timestamping require available certificates; auto-update requires a release channel and rollback policy; crash reporting remains opt-in and excludes prompts, credentials, and session content by default.

The source desktop preview keeps one renderer, does not reuse the agent-controlled Electron child as trusted application chrome, and does not add an installer, updater, signing, or `file://` IPC migration until the packaging work is ready.

## Alternatives considered

**Keep the roadmap as a root `DESKTOP_BUILD_PLAN.md`.** Rejected because the plan is a decision record with future release policy, so it belongs in the Agent Note tree rather than beside the product README and current guides.

**Add an installer before defining release checks.** Rejected because install, upgrade, uninstall, profile retention, signing, rollback, and privacy behavior need one observable release acceptance path.

**Replace the Web Host with a second desktop renderer.** Rejected because it duplicates the existing React surface and would create a second product entry path before packaging is solved.

## Acceptance criteria

The packaged desktop artifact launches on a clean supported Windows VM, keeps the browser embedded in the application window, preserves browser and terminal behavior, and passes install, first-launch, upgrade, uninstall, and profile-retention checks. Release automation records signing, update rollback, and crash-reporting privacy decisions before enabling those features.

## Risks

Packaging the source runtime can omit a dynamic dependency or profile asset; the clean-VM checks must exercise the published artifact rather than the source checkout. Auto-update without rollback can strand users on a broken release, and crash reporting can expose private session data unless its payload is explicitly bounded.

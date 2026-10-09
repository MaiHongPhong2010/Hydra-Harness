# Agent Note: Publish the source desktop guide

Status: implemented

## Problem

The public documentation describes Hydra as a desktop application, but the published guide only explains `npx @hydraharness/harness web`. Readers cannot find the source command, desktop prerequisites, or the current lack of an installer.

## Decision

The documentation site publishes `docs/user/guide/desktop.md` at `/guide/desktop`. The page documents npm and source launches, the embedded Web Host, the desktop panels, the Electron data directory, and developer-preview limitations. The home page and Web UI guide link to it. The [npm Desktop launch note](2026-10-09-npm-desktop-launch.md) owns the runnable npm distribution.

## Alternatives considered

**Keep the desktop command only in the root README.** Rejected because the website's user guide is the public entry point and already advertises the desktop surface.

**Supply an npm Desktop launcher through documentation alone.** A runnable command requires the Electron entry and its dependency payload; the [npm Desktop launch note](2026-10-09-npm-desktop-launch.md) owns that implementation.

## Consequences

Readers can reach runnable npm and source desktop setups from the website. Standalone installer and auto-update work follows the [desktop packaging and release roadmap](../../proposed/process/2026-09-27-desktop-packaging-and-release-roadmap.md) and needs a separate guide update when those artifacts exist.

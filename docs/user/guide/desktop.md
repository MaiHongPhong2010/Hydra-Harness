# Use the desktop app

Hydra Desktop is a Windows-first Electron shell around the same Hydra Host and Web renderer. Launch it from npm or a source checkout during the developer preview.

## Prerequisites

Install Node.js **22.19 or later in the 22.x line, or 24 and newer**. Source builds also require Git and pnpm. npm installs Electron and the native terminal dependency, so keep optional dependencies and install scripts enabled. Desktop needs a graphical session.

## Launch from npm

From your workspace directory, run:

```sh
npx @hydraharness/harness@latest desktop
```

You can also run bare `npx @hydraharness/harness` and choose **3) Desktop**. That interactive first run installs the persistent command; later launches use `hydra desktop`. The [installation reference](../../../apps/cli/reference/README.md#persistent-command) covers updates, PATH, and removal.

## Build and launch

From the repository root, run:

```sh
git clone https://github.com/MaiHongPhong1902/Hydra-Harness.git
cd Hydra-Harness
pnpm install
pnpm run build
pnpm run desktop
```

The desktop process starts the Web profile internally on a local loopback port and loads it in one Electron window. Run `pnpm run build` again after source changes before launching the desktop app.

In **Settings → Models**, **Open sign-in page** opens your default browser. Google connects Antigravity through OAuth. For Gemini API, choose **API keys → Add a custom provider → Provider template → Gemini API** and enter an API key.

## Start a task

Open **Settings → Models** and configure a provider, then choose a workspace and start a session. The model and workspace setup is the same as the [Web UI quickstart](./index.md), and the [model guide](./providers.md) covers DeepSeek, catalog providers, and custom endpoints.

The desktop window includes the conversation UI, the controlled browser, terminal sessions, and workspace files. These panels share the selected session and workspace while the Host keeps their permissions and approvals.

Right-click a session to rename, pin, mark unread, organize it into a Section or display Project, fork, copy, archive or permanently delete it. Share displays Coming soon. Open in new window opens the selected session in another Electron window using the Web interface; the native Files, Terminal and embedded Browser panels remain in the main window. Moving a session to a display Project retains its original working directory.

Use **Ctrl++** (or **Ctrl+=**) to zoom in, **Ctrl+-** to zoom out, and **Ctrl+0** to restore 100% size while focus is in the application UI. The same actions are available in **View**. The embedded Browser keeps its own page shortcuts.

## Data location

Desktop-specific Electron data is stored below `$HYDRA_HOME/desktop-electron`. When `HYDRA_HOME` is not set, Hydra uses `~/.hydra` as the home directory.

## Troubleshooting

- **`Desktop Host is not built`** — run `pnpm run build` from the repository root, then run `pnpm run desktop` again.
- **`could not start Desktop`** — reinstall with `npm install -g @hydraharness/harness@latest`, including optional dependencies and allowing install scripts. Electron must finish downloading before it can launch.
- **BrowserAgent package errors during a source install** — confirm the tracked `packages/browser/browser-electron/third-party/browseragent` source is present, then run `pnpm install` again.
- **You want a downloadable installer** — the developer preview uses npm or a source checkout; signing and auto-update remain part of the installer roadmap.

## Continue

- [Use the Web UI](./index.md)
- [Configure models](./providers.md)
- [Reuse page workflows](./page-memory.md)
- [Use the Python SDK](./python-sdk.md)

# Use the desktop app

Hydra Desktop is a Windows-first Electron shell around the same Hydra Host and Web renderer. Launch it from npm or a source checkout during the developer preview.

## Prerequisites

Install Node.js **22.19 or later in the 22.x line, or 24 and newer**. Source builds also require Git and pnpm. npm installs Electron and the native terminal dependency, so keep optional dependencies and install scripts enabled. Desktop needs a graphical session.

## Launch from npm

From your workspace directory, run:

```sh
npx @hydraharness/harness@latest desktop
```

On Windows this installs the persistent command and adds a **Hydra Harness** shortcut to your Desktop. Open that shortcut for later launches; it also retains the Hydra icon when pinned to the taskbar. Replace an existing Electron pin by unpinning it, then pinning the updated Hydra shortcut. You can also run bare `npx @hydraharness/harness` and choose **3) Desktop**, or use `hydra desktop` after installation. The [installation reference](../../../apps/cli/reference/README.md#persistent-command) covers updates, PATH, and removal.

## Build and launch

From the repository root, run:

```sh
git clone https://github.com/MaiHongPhong2010/Hydra-Harness.git
cd Hydra-Harness
pnpm install
pnpm run build
pnpm run desktop
```

The desktop process starts the Web profile internally on a local loopback port and loads it in one Electron window. Run `pnpm run build` again after source changes before launching the desktop app.

To verify workspace Settings in the native renderer after building, run the focused smoke with a private `HYDRA_HOME` from the repository root:

```powershell
$env:HYDRA_HOME = Join-Path $env:TEMP ('hydra-workspace-settings-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $env:HYDRA_HOME | Out-Null
pnpm --filter @hydraharness/harness-desktop exec electron . --smoke-workspace-settings
```

The smoke checks global Settings without a workspace selector, global instruction saves that preserve project files, and global provider credential controls. It reports `desktop-workspace-settings-smoke` with `ok: true` on success and saves `desktop-workspace-settings.png` under `HYDRA_HOME`.

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

## General Settings

Open Settings → General to search preference names and sections. Individual controls save automatically and report errors and when they apply. Models and Plugins editors retain Save/Discard. Full access asks for acknowledgement and reports chats that could not accept the change.

Agent environment lists Native and checked WSL distributions. A distro needs Node 22.19 or 24+ and a Hydra installation supporting Desktop bridge version 1; Hydra does not install these automatically. The entire Host runs in the selected distro with separate data after a clean shutdown and restart. New terminals can still use a detected Windows shell. Changing the task folder affects new chats outside projects, each with its own directory.

Full view puts a new chat and its content in one workspace tab strip. Shell and terminal placement changes apply to new terminals; hiding a panel keeps processes alive. Popout windows share the Host and settings; closing the final window shuts it down. Launch at login opens the operating system settings and refreshes its status when Hydra regains focus.

Completion notifications default to Background. Display permission is separate from agent approval. Questions open their addressed chat when clicked. Suggested prompts are Off by default and only fill a draft when chosen. Speed shows requested and reported tiers where the adapter supports them; Priority may have a different cost. Compression changes affect new sessions after restart; existing logs keep their encoding. Enable Confetti cannon and type /confetti for a live effect; reduced motion suppresses it.

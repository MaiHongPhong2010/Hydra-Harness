# `@hydraharness/harness`

The `hydra` command is the product launcher for profiles: ordered stacks of plugin-bundle patch layers under the user's own overrides. [`src/args.ts`](src/args.ts) owns the command grammar, and [`src/bin.ts`](src/bin.ts) loads only the selected runner. Invalid commands, options from another mode, configuration errors, and boot failures exit nonzero.

## Entry modes

With no arguments, `hydra` opens a line-oriented menu for Web, Headless, or Desktop. The Desktop choice launches the bundled Electron app; the [Desktop guide](../../docs/user/guide/desktop.md) covers installation and setup.

A bare interactive `npx @hydraharness/harness` installs the running release globally through npm before opening that menu. Later launches use `hydra`. npm's global prefix must be writable and its command directory must be on PATH; the launcher reports installation failures or a missing PATH entry. Explicit commands, help, version, source launches, and non-interactive invocations do not install globally. The [installation reference](reference/README.md#persistent-command) owns update and removal commands.

| Command | Purpose |
|---|---|
| `hydra` | Choose Web, Headless, or Desktop interactively. Requires TTY stdin and stdout; CI and redirected input must use an explicit command. |
| `hydra --profile <name>` | Boot the named profile under `$HYDRA_HOME/profiles/<name>`. |
| `hydra --profile headless "job"` | Run one fresh persisted session, print the final answer, and exit. |
| `hydra web` | Alias of `--profile web`; use this explicit form in scripts and CI. |
| `hydra desktop` | Open the Electron app and wait until its window and Host close. |
| `hydra plugin --profile <name> <pnpm args>` | Manage a profile's plugins by forwarding to pnpm in the profile directory. |

The invoking directory is the default workspace root. The `web` and `headless` profiles auto-initialize on first use from shipped templates; any other profile must be created through `hydra plugin`.

## App arguments

The launcher parses only its own flags and hands everything after them to the booted profile, where any injected app plugin may parse the shared immutable snapshot ([`@hydraharness/harness-cmdline`](../../packages/boot/cmdline/README.md)). Launcher flags therefore come first, and the first token the launcher does not recognize starts the app's arguments:

```sh
hydra --profile web --port 8080       # --port belongs to the web app
hydra --profile tui --resume <id>     # example, assuming the tui profile is installed; --resume belongs to the terminal app
hydra --profile headless "run the tests"
hydra --profile web --help            # the web app's flags, not the launcher's
hydra --help                          # the launcher's own help
```

## Profiles

A profile directory holds a `package.json` (out-of-tree plugin dependencies plus the profile manifest `hydra.profile` with its ordered `bundles` list) and a `cordis.patch.yml` (the user's own patch layer).

The tree composes over an empty root:
- each bundle's patch in `hydra.profile.bundles` order
- then the profile's `cordis.patch.yml`, then the home-level `$HYDRA_HOME/cordis.patch.yml`
- then `--patch` overlays

Bundles named in `hydra.profile.bundles` resolve from the hydra installation first (`@hydraharness/harness-base`, `@hydraharness/harness-web-app`, `@hydraharness/harness-headless`), then from the profile's own `node_modules`, where pnpm installs out-of-tree plugins.

Use `--dump-default-config` and `--dump-config` to inspect the composed tree without booting it.

The [CLI behavior reference](reference/README.md) owns exact layer precedence, flags, shutdown behavior, deployment defaults, and source execution.

## Development

Production runs require built package and frontend artifacts. From the repository root, run `pnpm run build` separately, then use `pnpm hydra <args...>` to run the TypeScript entry and forward every argument; the [source-execution reference](reference/README.md#source-execution) owns the module-resolution contract.

The npm CLI includes its workspace runtime, Desktop app, and installed pnpm dependency patches. Release verification installs that tarball alone in local and global consumers, checks the global command, and starts Web to check its renderer and entry asset; [the packaging note](../../.agents/notes/implemented/process/2026-10-05-patched-dependencies-in-npm-cli.md) records the SDK requirements. [Desktop packaging](../../.agents/notes/implemented/feature/2026-10-09-npm-desktop-launch.md) owns the Electron launch and native checks.

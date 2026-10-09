# Hydra harness

Hydra harness (`hydra`) is an open-source workspace for working with AI agents through a Web UI, desktop app, or command line. **Hydra is a public fork of DeepSeek Harness, originally developed by [DeepSeek AI](https://deepseek.com).** The original project's code and design form the foundation of this fork.

Agents can read and edit project files, run commands, use browser tools, and delegate tasks. You choose the model provider, workspace, and permission policy.

## Built around plugins

Hydra follows DeepSeek Harness's **everything is a plugin** architecture, powered by [Cordis](https://github.com/cordiverse/cordis). Model adapters, tools, sessions, the user interface, and the agent loop are composed through plugins and configuration.

- **Work in your projects:** give agents a workspace and manage their access through permissions and approvals.
- **Choose your models:** configure DeepSeek, other catalog providers, or custom endpoints through [model settings](docs/user/guide/providers.md).
- **Continue your work:** resume or fork sessions backed by a durable event log.
- **Extend the runtime:** add tools, providers, and UI features with [your own plugins](docs/user/develop/basic/index.md).

See the [architecture guide](docs/architecture.md) for how these pieces fit together. Cordis's underlying design is described in [_A Programming Paradigm for Spatiotemporal Composability_](https://github.com/cordiverse/paper).

## Developer preview

Hydra is under active development. Expect breaking changes to APIs, configuration, and stored data during the developer preview.

## Run

Use Node.js **22.19 or later in the 22.x line, or 24 and newer**. Building from source also requires Git and pnpm; the repository pins its pnpm version in [package.json](package.json).

### Run from source

```sh
git clone https://github.com/MaiHongPhong1902/Hydra-Harness.git
cd Hydra-Harness
pnpm install
pnpm run build
pnpm hydra web
```

The repository includes the locally owned BrowserAgent source required by `pnpm install`. Build after source changes; `pnpm hydra web` uses the built artifacts without rebuilding them.

To open the desktop app after building:

```sh
pnpm run desktop
```

### Run from npm

Run the [npm package](https://www.npmjs.com/package/@hydraharness/harness) without cloning or building this repository:

```sh
npx @hydraharness/harness
```

The first interactive run installs the `hydra` command through npm. After that, start it from your workspace with `hydra`; [the installation reference](apps/cli/reference/README.md#persistent-command) covers PATH, updates, and removal.

The CLI is also mirrored as `@maihongphong1902/harness` in this repository's [GitHub Packages](https://github.com/MaiHongPhong1902/Hydra-Harness/pkgs/npm/harness). Installing from that registry requires [GitHub Packages authentication](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry#authenticating-to-github-packages).

The interactive launcher lets you choose Web, Headless, or Desktop. Web starts at `http://127.0.0.1:3080` and local launches open your browser automatically; SSH launches print the host URL so your SSH client or editor can handle forwarding. Desktop opens the Electron app with its embedded browser, terminals, and workspace files; see the [Desktop guide](docs/user/guide/desktop.md).

For scripts, CI, or redirected input, use an explicit command instead of the menu:

```sh
npx @hydraharness/harness web --no-open
npx @hydraharness/harness --profile headless "summarize this repository"
npx @hydraharness/harness desktop
```

### Start your first task

1. Open **Settings → Models** and configure a provider.
2. Select **Choose workspace** and add your project directory.
3. Start a session and ask: **“Summarize this repository and identify its main packages.”**

The [Web UI guide](docs/user/guide/index.md) walks through setup and the first session.

## Documentation

- [Development guide](docs/development.md) — contributor setup and local checks.
- [Architecture](docs/architecture.md) — plugin composition and agent execution.
- [Package map](packages/README.md) — the repository's capability groups.
- [CLI reference](apps/cli/README.md) — headless runs and other CLI modes.
- [Agent instructions](AGENTS.md) — repository rules for coding agents.

## Community and contributing

Share feedback and bug reports in [GitHub Discussions](https://github.com/MaiHongPhong1902/Hydra-Harness/discussions). Read [CONTRIBUTING.md](CONTRIBUTING.md) for the current contribution policy. If you publish a plugin, add the [`hydra-plugin`](https://github.com/topics/hydra-plugin) topic to help others find it.

## License

Released under the [MIT License](LICENSE), with the original DeepSeek copyright retained. Third-party dependencies and their licenses are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

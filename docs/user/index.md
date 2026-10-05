---
layout: page
title: Hydra harness
description: Open-source agent workspace for Web UI, desktop, CLI, browser tools, durable sessions, and Cordis plugins.
---

<section class="hydra-home-hero" aria-labelledby="hydra-home-title">
  <div class="hydra-home-copy">
    <p class="hydra-home-eyebrow">OPEN-SOURCE AGENT WORKSPACE</p>
    <h1 id="hydra-home-title">Build with agents that can act.</h1>
    <p class="hydra-home-lede">Run useful AI work across the Web UI, desktop app, command line, browser tools, and durable project sessions.</p>
    <div class="hydra-home-actions">
      <a class="hydra-home-button hydra-home-button-primary" href="https://maihongphong1902.github.io/Hydra-Harness/guide/quickstart">Open the guide</a>
      <a class="hydra-home-button" href="https://github.com/MaiHongPhong1902/Hydra-Harness">View on GitHub</a>
    </div>
    <p class="hydra-home-install"><span>Interactive launcher</span><code>npx @hydraharness/harness</code></p>
    <p class="hydra-home-install"><span>Web UI in scripts</span><code>npx @hydraharness/harness web</code></p>
    <p class="hydra-home-install"><span>Desktop from source</span><code>pnpm run desktop</code></p>
  </div>
  <div class="hydra-home-mark">
    <img src="https://maihongphong1902.github.io/Hydra-Harness/hydra.png" width="256" height="256" alt="Hydra three-headed dragon logo" />
  </div>
</section>

<section class="hydra-home-wiki" aria-labelledby="hydra-wiki-index">
  <div class="hydra-section-heading">
    <p class="hydra-section-kicker">WIKI INDEX</p>
    <h2 id="hydra-wiki-index">Explore Hydra</h2>
    <p>Start from the path that matches your work. Each page points to the runnable guide, reference, or package source behind it.</p>
  </div>
  <div class="hydra-feature-grid">
    <a class="hydra-feature-card" href="https://maihongphong1902.github.io/Hydra-Harness/guide/quickstart">
      <span class="hydra-feature-number">01 / RUN</span>
      <h3>Use the runtime</h3>
      <p>Launch Hydra in the browser, desktop app, CLI, ACP, JSON-RPC, or Python SDK.</p>
      <span class="hydra-feature-link">Read the guide →</span>
    </a>
    <a class="hydra-feature-card" href="https://maihongphong1902.github.io/Hydra-Harness/guide/providers">
      <span class="hydra-feature-number">02 / MODEL</span>
      <h3>Connect a model</h3>
      <p>Configure DeepSeek or another compatible endpoint with explicit profiles and permissions.</p>
      <span class="hydra-feature-link">Configure providers →</span>
    </a>
    <a class="hydra-feature-card" href="https://maihongphong1902.github.io/Hydra-Harness/reference/subsystems/web">
      <span class="hydra-feature-number">03 / WEB</span>
      <h3>Control the web</h3>
      <p>Give agents browser navigation, page inspection, screenshots, search, and fetch tools.</p>
      <span class="hydra-feature-link">Open browser docs →</span>
    </a>
    <a class="hydra-feature-card" href="https://maihongphong1902.github.io/Hydra-Harness/reference/subsystems/session">
      <span class="hydra-feature-number">04 / CONTEXT</span>
      <h3>Keep context</h3>
      <p>Resume, fork, compact, and reconstruct model-visible work from durable session logs.</p>
      <span class="hydra-feature-link">Learn about sessions →</span>
    </a>
    <a class="hydra-feature-card" href="https://maihongphong1902.github.io/Hydra-Harness/develop/basic/">
      <span class="hydra-feature-number">05 / EXTEND</span>
      <h3>Build plugins</h3>
      <p>Add tools, providers, storage, UI modules, skills, workflows, and hooks through Cordis.</p>
      <span class="hydra-feature-link">Develop a plugin →</span>
    </a>
    <a class="hydra-feature-card" href="https://maihongphong1902.github.io/Hydra-Harness/reference/">
      <span class="hydra-feature-number">06 / REFERENCE</span>
      <h3>Inspect every capability</h3>
      <p>Trace the package map, API contracts, configuration, and runtime composition in one place.</p>
      <span class="hydra-feature-link">Browse reference →</span>
    </a>
  </div>
</section>

Hydra is an open-source agent workspace for running useful AI work across the Web UI, desktop app, and command line.

Give an agent a workspace, a model, and the permissions it needs. Hydra keeps the session, tools, approvals, and extensions in one plugin-based runtime.

[Start with the Web UI](./guide/index.md) · [Use the desktop app](./guide/desktop.md) · [Configure a model](./guide/providers.md) · [Read the architecture](https://github.com/MaiHongPhong1902/Hydra-Harness/blob/main/docs/architecture.md)

## Run Hydra

### From npm

Run the [npm package](https://www.npmjs.com/package/@hydraharness/harness) without cloning or building this repository:

```sh
npx @hydraharness/harness
```

The interactive launcher offers Web, Headless, and Desktop. Desktop currently prints the source-checkout workflow because the npm package does not yet ship a supported Electron artifact. For scripts, CI, or redirected input, use `npx @hydraharness/harness web` or `npx @hydraharness/harness --profile headless "<task>"`; the Web UI starts at `http://127.0.0.1:3080`, and `--no-open` prevents the browser from opening automatically.

### From source

```sh
git clone https://github.com/MaiHongPhong1902/Hydra-Harness.git
cd Hydra-Harness
pnpm install
pnpm run build
pnpm hydra web
```

To open the desktop app after building, run:

```sh
pnpm run desktop
```

The [desktop guide](./guide/desktop.md) explains the source-only developer-preview setup.

For one headless task, run:

```sh
pnpm hydra --profile headless "summarize this repository"
```

## What Hydra can do

### Build and operate agents

- Run the same agent runtime through the Web UI, desktop app, CLI, ACP, JSON-RPC, or Python SDK.
- Choose a workspace, model provider, permission policy, and profile for each task.
- Start, resume, fork, query, title, and inspect durable sessions.
- Stream model responses with token usage, context management, compaction, and system-prompt assembly.

### Work directly in projects

- Read, write, review, diff, and undo files with workspace ownership and file locking.
- Run Bash, PowerShell, subprocesses, persistent PTY terminals, background jobs, and code-runtime tasks.
- Navigate code with language servers and compose project-specific skills.
- Use plans, goals, todos, human commands, and user questions to keep long tasks understandable.

### Use the browser and the web

- Open and control browser pages from the desktop browser integration.
- Navigate, click, type, select, scroll, upload, inspect pages, and capture screenshots.
- Search and fetch web content through the web capability.
- Keep browser actions behind host permissions and the configured interaction policy.

### Keep context across work

- Reconstruct model-visible work from the durable session event log.
- Resume after interruptions and fork a session when a task needs a separate direction.
- Compact long conversations while preserving the active task context.
- Store workspace, settings, credentials, page memory, and spill data through their owning plugins.

### Coordinate work

- Delegate work to subagents and collect their results in the parent session.
- Run workflows, scheduled reminders, and background jobs from the same capability system.
- Expose Hydra through the Web server, ACP automation server, JSON-RPC, TypeScript clients, and the Python SDK.
- Build repeatable profile bundles for Web, headless, and custom deployments.

### Control access and execution

- Require approvals for sensitive actions and select reusable permission presets.
- Apply sandbox and process policies to shells, subprocesses, files, and browser actions.
- Keep credentials in the credential capability instead of browser state or prompts.
- Fail closed when configuration, capability ownership, or durable data is invalid.

### Extend the runtime

Every product feature is a plugin. Add or replace model providers, tools, services, storage, UI modules, skills, workflows, hooks, and capability providers through Cordis composition and profile patches.

[Create your first plugin](./develop/basic/index.md) · [Build a tool](./develop/basic/tool.md) · [Configure a plugin](./develop/basic/config.md) · [Package and install it](./develop/basic/publish.md)

## Choose a starting point

| You want to… | Start here |
| --- | --- |
| Run an agent in a browser | [Web UI quickstart](./guide/index.md) |
| Run the Electron desktop app | [Desktop guide](./guide/desktop.md) |
| Connect DeepSeek or another endpoint | [Model providers](./guide/providers.md) |
| Run a task from CI or a terminal | [CLI reference](https://github.com/MaiHongPhong1902/Hydra-Harness/blob/main/apps/cli/README.md) |
| Automate Hydra from Python | [Python SDK](./guide/python-sdk.md) |
| Understand the runtime | [Architecture](https://github.com/MaiHongPhong1902/Hydra-Harness/blob/main/docs/architecture.md) |
| Explore every capability package | [Package map](https://github.com/MaiHongPhong1902/Hydra-Harness/blob/main/packages/README.md) |
| Add a feature | [Plugin development](./develop/basic/index.md) |

## First task

1. Open **Settings → Models** and configure a provider.
2. Select **Choose workspace** and add a project directory.
3. Start a session and ask: **“Summarize this repository and identify its main packages.”**

Hydra is a developer preview. APIs, configuration, and stored data can change while the foundation is being built.

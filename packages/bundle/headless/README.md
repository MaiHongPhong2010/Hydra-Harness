# `@hydraharness/harness-headless`

The hydra one-shot bundle. [`cordis.patch.yml`](cordis.patch.yml) rides directly over [`@hydraharness/harness-base`](../base/README.md): it supplies the coding persona and tool mode, disables HMR, mounts Code Mode's worker as a core execution capability, and inserts this package's `headless-runner` plugin (config `{task}`, resolved from the injected `headlessStartup` provider). It mounts no Host, HTTP server, Web runtime, or browser plugin.

After the Loader settles, the runner resolves the current directory through the optional [`workspace-config`](../../workspace/workspace-config/README.md) service, reads the global [`ctx.agentDefaultModel`](../../core/agent-default-model/README.md), and joins the preset or workspace scope before creating one fresh persisted Agent through `ctx.agents`. The runner submits the task as an ordinary user message and waits for quiescence. It flushes the Session before folding the owned durable event interval, writes the last non-empty assistant text to stdout, and requests exit through the launcher-provided `ctx.appExit` host hook ([`@hydraharness/harness-cmdline`](../../boot/cmdline/README.md)) (final `turn/end` completed → 0, otherwise 1). A terminal `error` reason also writes its code and message to stderr; successful runs keep stderr empty. The process opens no listening port. The task text is this app's command line: the ordinary `headless-startup` provider ([`src/startup.ts`](src/startup.ts)) injects `ctx.cmdlineArgs` ([`@hydraharness/harness-cmdline`](../../boot/cmdline/README.md)), reads the positional argument of `hydra --profile headless "task"`, prints the app's `--help`, and provides `headlessStartup`; the runner injects that service and reads its task from lazy config. A missing or whitespace-only task is rejected before the runner activates.

## Model Experience

None, as the runner submits the task as an ordinary user message; prompts and tools belong to the base and headless bundle rows.

#### KV Cache effect

None; the runner adds nothing to the request prefix.

## Known Limitations and Deferred Work

- **One submitted task only** — the runner has no interactive follow-up surface; it waits through any work the Agent completes before returning to idle and prints the last non-empty assistant message in that interval.
- **`ctx.appExit` is launcher-owned** — booting the headless profile outside the `hydra` launcher fails loud at activation until the host provides the exit request.

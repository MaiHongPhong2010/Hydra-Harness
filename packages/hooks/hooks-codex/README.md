# @hydraharness/harness-hooks-codex

A cordis plugin that runs the supported subset of a user's existing **Codex** hook config on the harness's canonical interception points. The **Codex dialect** half of the hooks subsystem. The dialect-agnostic primitives come from [`@hydraharness/harness-hook-protocol`](../hook-protocol/README.md); this bridge owns the Codex-shaped payloads, matcher mode, and decision mapping.

This bridge implements a deliberate subset of Codex's current hook protocol:

- **Seven hook points with Hydra seams:** `PreToolUse`, `PostToolUse`, `SessionStart`, `UserPromptSubmit`, `Stop`, `SubagentStart`, and `SubagentStop`.
- **Regex-only matchers** (no literal fast path; the matcher is always an unanchored regex).
- **snake_case stdin payloads** with `turn_id`/`model` extras, written **without** a trailing newline.
- **No config-time placeholder substitution** (the command still receives the executor's environment and runs through its shell; a host may add trusted plugin variables).
- **No pre-tool approval or rewrite path** — a hook can block, but the bridge does not pre-approve or replace tool input.

A native cordis plugin could do everything this bridge does, more powerfully; the bridge exists only as a compatibility path for the mapped Codex subset (see [the interception extension-points Agent Note](../../../.agents/notes/implemented/feature/2026-06-30-interception-extension-points.md)).

## Config

```ts
import type { Config } from '@hydraharness/harness-hooks-codex'
const config: Config = {
  configPath: '/path/to/.codex/hooks.json', // required
  model: 'deepseek-v4',                      // optional: stamped on every payload (Codex includes `model`)
  defaultTimeoutMs: 600_000,                 // optional: per-hook timeout when a hook sets none
  stderrSummaryMaxChars: 500,                // optional: char cap on the hook/result event's persisted stderr summary
}
```

In a `cordis.yml`:

```yaml
- hydra-hooks-codex:
    configPath: ./.codex/hooks.json
    model: deepseek-v4
```

The config is parsed once at load; a relative `configPath` resolves against the process launch cwd. Hooks receive events from agents below the mounting context's registration scope; an unscoped mount covers every agent. A read/parse failure logs and registers nothing, including an invalid regex matcher, whose diagnostic names its pattern and event. Only synchronous `type: 'command'` hooks run; non-command and `async: true` handlers are skipped with a warning. `timeout` and `timeoutSec` override the 10-minute protocol default. Events outside the seven supported points are dropped at parse.

Hook commands run in optional `Config.cwd`, or the agent's session `cwd` when omitted. Workspace registries supply the selected root, so relative scripts address that project even when the session started from a child directory.

## Hook points → typed Decisions

| Codex hook | Harness point | Mapping |
|---|---|---|
| `SessionStart` | `agent/session-start` (emit) | a plain-stdout hook's output → additionalContext → `agent.inject()` |
| `UserPromptSubmit` | `agent/pre-step` (waterfall) | `block` (exit 2) → `PreStepDecision.reject`; additionalContext-only → delegate via `next()` then append a separately sourced message to a downstream `enter` decision |
| `PreToolUse` | `tools/pre-execute` (waterfall) | `block` → `PreToolDecision.deny` (no `allow`/`ask`) |
| `PostToolUse` | `tools/post-execute` (waterfall) | `block` → `block` with feedback; additionalContext-only → delegate via `next()` then prepend a separately sourced context to the downstream decision; Code Mode defers sub-call contexts until the outer `run_code` result |
| `Stop` | `agent/turn-stopping` (serial) | a blocking Stop hook feeds its reason through `steer()`, forcing another step |
| `SubagentStart` | `subagent/start` (detached) | additionalContext → `agent.inject()` when the local child is available |
| `SubagentStop` | `subagent/end` (detached) | observe-only |

A tool call's payload carries the real `tool_name` (the same value the matcher tests) and Codex's `tool_input: { command }` shape (the `command` arg when present, else `''`). The matcher subject is the tool name (`PreToolUse`/`PostToolUse`), the session source (`SessionStart`), or the subagent type (`SubagentStart`/`SubagentStop`); `UserPromptSubmit`/`Stop` ignore matchers.

Every agent-scoped stdin payload carries `session_id` and `transcript_path`. The bridge resolves the latter through `ctx.sessionPersistence.locate(session.header)` when available and otherwise sends `null`, preserving the Codex `string | null` shape. Lookup does not create or flush the artifact, so a path can be absent before the first turn-end checkpoint or omit the current open turn.

`SessionStart`, `SubagentStart`, and `SubagentStop` run detached. Every hook run is tracked, including blocking prompt/tool/Stop hooks. Disposal aborts active processes and waits for their runs and detached continuations before resolving (`createDetachedRuns` in `@hydraharness/harness-hook-protocol`).

## Context source

Injected context carries an explicit `{ kind: 'plugin', plugin: 'hooks-codex' }` source so the durable message is never mistaken for a user prompt.

## Model Experience

### Hook-provided context

#### What the model sees

`SessionStart`, accepted prompt, and post-tool hooks can add source-attributed context messages; a blocking `Stop` hook adds its reason as next-step steering.

#### Token effect

No cost when hooks return no context. Hook text is data-dependent, logged, and resent until compaction.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Blocked prompt or tool outcome

#### What the model sees

Provider-supplied reasons pass through verbatim. When absent, a blocked prompt uses exactly `blocked by UserPromptSubmit hook`, a denied tool becomes `Error: blocked by PreToolUse hook`, blocked post-tool feedback is exactly `blocked by PostToolUse hook`, and a blocking stop adds steering exactly `continue: blocked by Stop hook`. Codex `systemMessage` is not surfaced.

#### Token effect

Blocking a prompt removes its request tokens; denial or feedback adds the retained fallback or provider text; forced continuation pays another full request.

#### KV Cache effect

A blocked prompt sends no request and invalidates nothing. Denial, feedback, and forced-continuation context append after the reusable prefix without rewriting it.

## Known Limitations and Deferred Work

- **Unsupported hook events:** `PermissionRequest`, `PreCompact`, `PostCompact`, `Interrupt`, and `SessionEnd` have no matching Hydra extension point and are dropped during parsing. `SubagentStart` and `SubagentStop` are supported through the shared subagent lifecycle seam. The comparison baseline is Codex's [official hook reference](https://learn.chatgpt.com/docs/hooks).
- **`SessionStart` is partial:** plain stdout and JSON `additionalContext` work, but the hook runs detached, so context can miss the first request (`TODO(session-start-gating)`).
- **`UserPromptSubmit` is partial:** blocking plus plain-stdout or JSON context work, but the common `systemMessage` and `{"continue": false}` controls are not enforced.
- **`PreToolUse` is partial:** blocking works, but `additionalContext`, `permissionDecision: "allow"`, and `updatedInput` are ignored. Every tool is represented as `tool_input: { command }`, so non-shell tool arguments are not faithfully exposed to the hook.
- **`PostToolUse` is partial:** blocking feedback and JSON `additionalContext` work, but `{"continue": false}` is not enforced, non-shell tool arguments are reduced to `{ command }`, and structured tool output is flattened to text in `tool_response`.
- **`Stop` is partial:** blocking forces another model turn, but `stop_hook_active` is always `false`, `last_assistant_message` is always `null`, and `{"continue": false}` is not enforced. An unconditionally blocking hook therefore force-continues every step unless it self-limits (`TODO(stop-loop-guard)`).
- **Common payload and output fields are partial:** every mapped event reports the statically configured `model` and `permission_mode: "default"` instead of current Codex runtime values. `systemMessage` is logged + warned but not surfaced, and `{"continue": false}` is recorded but does not apply Codex's event-specific stop behavior (`TODO(hook-continue-false)`).
- **Config loading and execution are partial:** each mount reads one document; [`hooks-registry`](../hooks-registry/README.md) supplies workspace records and reconciliation. Codex's complete native layer discovery and inline `config.toml` hook form are unsupported. Only synchronous `command` handlers run; metadata such as `statusMessage` and `commandWindows` is ignored, and matching handlers run serially. Plugin-bundled commands run with the session cwd; use `PLUGIN_ROOT` or `CLAUDE_PLUGIN_ROOT` for paths inside the installed bundle.

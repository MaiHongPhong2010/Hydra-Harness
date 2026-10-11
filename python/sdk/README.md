# Hydra harness Python SDK

Python subprocess SDK for driving Hydra harness over JSON-RPC stdio. The
runtime inherits normal Hydra harness environment variables such as
`DEEPSEEK_BASE_URL` and `DEEPSEEK_API_KEY`, so callers can use real model
endpoints directly or point those variables at a local proxy.

Install the `hydra-harness-sdk` distribution from PyPI; the import module remains `hydra_harness`:

```sh
python -m pip install hydra-harness-sdk
```

Installing `hydra-harness-sdk` installs the exact same-version `hydra-harness-runtime-bin` platform wheel. The normal entry point therefore needs no executable argument:

```py
from hydra_harness import HydraHarness

with HydraHarness() as harness:
    result = harness.run("Say hi.")
```

`HydraHarness` keeps its lazily started runtime subprocess for reuse across calls. Use it as a context manager, as above, or call `close()` explicitly when finished.

`close()` waits for runtime exit after the shutdown acknowledgement so disposal can drain session logs. `shutdown_timeout_seconds` bounds each shutdown, graceful-exit, and termination wait; an unresponsive process is eventually killed.

By default, the SDK launches the bundled single-file `hydra-jsonrpc-agent` executable from the `hydra-harness-runtime-bin` package and injects that package's default configuration (the stdio JSON-RPC server, agent core, preloaded DeepSeek adapter, JSONL session persistence with an explicitly composed semantic checkpoint policy, local bash) via `HYDRA_CORDIS_CONFIG`. To run a plugin composition of your own, keep the `@hydraharness/harness-sdk-jsonrpc-server` entry in the config and pass the Cordis config path.

```py
from hydra_harness import HydraHarness

with HydraHarness(
    provider="deepseek-official",
    model="deepseek-v4-flash",
    max_tokens=49_152,
    cordis="examples/jsonrpc-agent/cordis.yml",
) as harness:
    result = harness.run("Make the requested code change.")
```

Omit both `provider` and `model` to use the runtime's effective workspace default, then its composed user default. The bundled composition supplies DeepSeek Flash and loads `.hydra/` through workspace configuration. An explicit `provider` selects a route registered by the chosen Cordis composition; `model` is the model id resolved by that adapter. Supply both together. `max_tokens` is an optional positive per-request output-token cap for the root agent and its in-process descendants; omission leaves the provider default in control. Compaction summaries keep the separate limit configured by their compaction plugin. The bundled default composition registers `deepseek-official`. A custom composition can mount `llm-pi-ai`, configure provider-specific credentials/endpoints there, and select any provider/model present in pi-ai's installed catalog.

The [Python SDK tutorial](https://github.com/MaiHongPhong1902/Hydra-Harness/blob/master/docs/user/guide/python-sdk.md) provides an ordered installation and first-run path without the Web UI. The [`jsonrpc-agent` example](https://github.com/MaiHongPhong1902/Hydra-Harness/blob/master/examples/jsonrpc-agent/README.md) owns the complete standalone Cordis file used there.

`Session.run()` owns an activity interval from its prompt's durable inbox receipt through the next whole-agent idle and returns `RunResult(session_id, final_response, finish_reason, events, notifications, session_root)`. `final_response` is the last committed root-session assistant text in the interval. `finish_reason` is the `kind` of the last root-session `turn/end` in the interval, such as `completed`, `max-tokens`, or `error`, and is `None` when no turn ended. A `turn/end` without a string `data.reason.kind` violates the runtime protocol and raises `SdkProtocolError`. Both result fields describe the owned interval rather than an output or ending causally assigned to the prompt. Steering, injected context, and other queued work may contribute before idle.

`HarnessClient` retains discovered subagent ancestry for the lifetime of the runtime process. During each `Session.run()`, `RunResult.notifications` and `on_notification` receive the root session and all known descendant notifications in wire order, including nested subagent lifecycle and session events. `RunResult.events` contains root-session events only, so descendant messages cannot replace the root response. The low-level `session_prompt()` returns the queued `MessageId` immediately; callers that bypass `Session.run()` own any later activity boundary themselves.

The same behavior can be selected for the runtime subprocess with `HYDRA_CORDIS_CONFIG`. The injection lives in `HarnessClient.start()`, so the low-level client's default launch gets it too: when the launch resolves to the bundled runtime and neither `cordis` nor a non-empty `HYDRA_CORDIS_CONFIG` is set (the runtime treats an empty value as absent, and so does the injection check), the bundled default configuration is used; an explicit `runtime_bin`, `bridge_bin`, or `launch_args_override` disables the injection entirely. See the [sdk-runtime README](https://github.com/MaiHongPhong1902/Hydra-Harness/blob/master/python/sdk-runtime/README.md) for the runtime carriers (production exe vs dev-only node closure) and how to obtain them.

`cwd` and `runtime_cwd` are resolved to absolute paths before subprocess launch, environment injection, and the wire handshake. The public API exposes only applied options: deployment persona and persistence belong in `cordis.yml`, while `session_root` remains the high-level convenience that sets `HYDRA_SESSION_ROOT`.

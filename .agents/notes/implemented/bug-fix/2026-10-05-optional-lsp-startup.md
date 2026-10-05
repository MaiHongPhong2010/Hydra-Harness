# Agent Note: Optional language servers cannot block app startup

Status: implemented

## Problem

Core plugin enablement persists in the profile manifest and overrides bundle defaults. Copying a profile with `lsp-stdio` enabled to a host without `typescript-language-server`, or retaining an unavailable `HYDRA_LSP_COMMAND`, makes the Host fail before Desktop or Web becomes ready.

## Decision

The generic stdio provider accepts per-server `resolveAt: load | query`, defaulting to `load` for deployments that require executable validation before registration. The shipped base TypeScript route uses `query`: it resolves the executable through the subprocess service before starting each new workspace server and returns `LSP_UNAVAILABLE` when resolution fails. Failed lookups retain no process or cached failure. Caller cancellation and provider disposal cover executable lookup through the existing workspace queue.

The [coding preset decision](../feature/2026-09-27-coding-presets-lsp.md) still owns LSP opt-in and tool exposure. Saved plugin choices remain authoritative; availability belongs to the host that executes the command.

## Alternatives considered

**Clear saved enablement or ignore a failed plugin load.** Either loses the operator's desired state or masks unrelated configuration failures. Deferred resolution keeps bounds and extension mappings validated during load.

**Install or bundle a language server for every user.** Mandatory dependencies and automatic network installation add work to profiles that never use LSP. Each deployment supplies its own compatible executable.

**Defer resolution for every deployment.** Required servers should still reject an invalid installation during boot; the default load policy preserves that behavior.

## Consequences

Desktop and Web can start with an enabled but unavailable base LSP command. LSP queries fail visibly until the host has the server, while unrelated tools remain usable. Availability is not promised by registration. A keyless ACP transcript pins the tool error and completed turn; lifecycle tests cover cancellation, disposal, and recovery without restarting the provider.

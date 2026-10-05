# Agent Note: Coding presets expose bounded LSP navigation

Status: implemented

## Problem

The shipped `standard` and `code` presets offered text search and file reads but did not expose semantic definitions, references, implementations, or hover. The LSP packages existed only in example compositions, so production coding sessions could not use them.

## Decision

Mount the LSP service and generic stdio provider in the shared base composition, and mount the model-facing `lsp` tool in both coding presets. The provider remains disabled unless `HYDRA_LSP_COMMAND` is set, so installations without a language server keep starting successfully. When enabled, the configured command receives `--stdio` and owns TypeScript, TSX, JavaScript, and JSX extensions.

## Alternatives considered

**Invoke `npx` from the preset.** This would make startup and first use depend on network access and an unpinned external install.

**Bundle a language server unconditionally.** This would add a large runtime dependency to every profile, including sessions that never inspect code semantically.

## Consequences

Coding presets expose the read-only `lsp` schema and prompt guidance only when a deployment supplies a compatible stdio server through `HYDRA_LSP_COMMAND`. With no command configured, both the provider and its consumer stay disabled, so the default catalog has no tool that would always fail.

The [optional LSP startup policy](../bug-fix/2026-10-05-optional-lsp-startup.md) governs executable checks when a saved core enablement override activates the provider on another host.

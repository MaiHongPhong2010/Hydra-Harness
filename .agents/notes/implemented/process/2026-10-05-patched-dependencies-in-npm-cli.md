# Agent Note: Patched dependencies in the npm CLI

Status: implemented

## Problem

The source installation applies a pnpm patch to `@earendil-works/pi-ai` that adds an Azure completions module used by the LLM adapter. Installing an unmodified registry SDK leaves that import missing and prevents the Web profile from loading. CLI version and help probes do not load the complete profile.

## Decision

The [CLI packer](../../../../scripts/release/pack-cli-bundle.ts) includes installed dependencies selected by `patchedDependencies` in [the workspace configuration](../../../../pnpm-workspace.yaml). It resolves them from the declaring workspace package, checks their installed version against the patch selector, and packs their compiled payload from an isolated staging directory. Their dependencies join the CLI's ordinary external dependencies. `node-pty` remains external so npm selects its platform prebuilds; its spawn-helper patch serves embedded executables, while this CLI runs under plain Node. Patched SDKs are bundled copies, not separate publications under upstream package names or versions.

The CLI root declares the complete dependency closure. Copied bundled manifests omit dependency declarations: npm treats dependencies reached from bundled packages as bundled when they sit under the global installation, which can suppress extraction of an external package while still running its install script. Ordinary external dependencies, including native prebuild selectors, are installed by npm.

The [packed-install gate](../../../../scripts/release/verify-packed-install.ts) installs the CLI in local and global consumers, checks the global command shim, and boots each installed Web profile in a fresh consumer home. It retrieves the renderer and its entry JavaScript over localhost and waits for the child process to exit during cleanup. Missing profile imports or external lifecycle files fail before publication. The [npm release sequence](2026-08-10-npm-release-sequences.md) continues to own release ordering, tags, integrity checks, and credentials.

## Alternatives considered

**Install the registry SDK by version alone.** The same upstream version lacks the local patch. Pinning its version cannot provide the missing module.

**Remove the Azure API import.** That removes an existing adapter capability and still discards the other changes carried by the dependency patch.

**Check only CLI version and help.** Those paths bypass the Web plugin tree and accept an installation whose default Web command fails.

## Consequences

The CLI tarball includes the patched SDK and its license. Patch configuration and the installed dependency version must agree at pack time. Browser interaction, provider credentials, media quota, and [native Desktop behavior](../feature/2026-10-09-npm-desktop-launch.md) remain separate checks.

The regression fixture executes the patched API from an extracted CLI with no ambient SDK. The packed Web gate rejects the unpatched release artifact with its missing-module diagnostic.

# Agent Note: Persistent command after npx

Status: implemented

## Problem

npx exposes its cached executable to the launched process without installing a command for later terminal sessions. Users who start Hydra once with npx need a persistent `hydra` command in their workspace.

## Decision

The [bare CLI entry](../../../../apps/cli/src/bin.ts) recognizes npm exec's npx lifecycle in an interactive terminal outside CI. Before the mode menu, [command setup](../../../../apps/cli/src/install-command.ts) invokes the same npm executable through Node to install the running release globally. npm owns prefix selection, lifecycle scripts, and platform command shims. A matching installed version and shim are reused. Setup verifies the installed version and shim before announcing success; a missing PATH entry prints the command directory, and a failed installation exits before the menu.

The installer returns the verified global CLI entry. [Windows npx Desktop](2026-10-09-npm-desktop-launch.md) also uses it for persistent shortcut creation and launch, including with redirected input. Direct `hydra`, other explicit modes, help, version, and non-interactive bare invocations retain their existing execution paths. The [packaging note](../process/2026-10-05-patched-dependencies-in-npm-cli.md) owns dependency declarations and local/global artifact verification.

## Alternatives considered

**Require a separate global-install command.** npm already supports this path, but it adds a step to the requested first-npx workflow. It remains available for scripts and updates.

**Write custom shims or edit shell startup files.** npm already owns command installation across platforms. A second implementation would introduce competing cleanup, quoting, and PATH behavior.

**Install during every command or through a package install script.** Explicit profile calls and CI need a temporary execution path. Package consumers must not change a global installation merely by adding a dependency.

## Consequences

The first bare interactive npx run requires a writable npm global prefix. PATH remains a shell configuration requirement, reported with the exact directory when missing. Users update and remove the command through npm. The assembled keyless CLI snapshot verifies installation, reuse, failure, missing PATH guidance, and commands that leave npm untouched; the packed-artifact probe supplies real npm installation and Web boot evidence.

#!/usr/bin/env node
/**
 * hydra — command-line entry. Dynamic imports per mode keep unrelated modes out
 * of each dispatch path; the adapter prints and exits for
 * `--help`/`--version`/a parse error, so only a valid mode reaches the switch.
 * @module @hydraharness/harness/bin
 */

/* v8 ignore file -- built-bin acceptance exercises this self-executing dispatch. */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadLayeredEnv } from '@hydraharness/harness-app-boot'
import { parseHydraArgs, type HydraInvocation } from './args.ts'

// Both the source tree (apps/cli/src) and the bundled bin (apps/cli/lib) sit
// one directory under apps/cli, so the checked-in manifest resolves with the
// same relative hop from either artifact.
/** This app's version, read from its checked-in package.json. */
function readVersion(): string {
  const manifest = JSON.parse(
    readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
  ) as { version?: unknown }
  return typeof manifest.version === 'string' ? manifest.version : '0.0.0'
}

const invocation = parseHydraArgs(process.argv.slice(2), readVersion())
type RunnableInvocation = Exclude<HydraInvocation, { mode: 'menu' }>

async function dispatch(invocation: RunnableInvocation): Promise<void> {
  switch (invocation.mode) {
    case 'desktop': {
      const { runDesktop } = await import('./desktop.ts')
      process.exitCode = runDesktop(invocation.args)
      break
    }
    case 'profile': {
      const { runProfile } = await import('./profile-boot.ts')
      const running = await runProfile({
        environment: loadLayeredEnv('hydra'),
        profile: invocation.profile,
        patchFiles: invocation.patches,
        args: invocation.args,
      })
      const parentPort = (process as NodeJS.Process & {
        parentPort?: { on(event: 'message', listener: (event: unknown) => void): void }
      }).parentPort
      parentPort?.on('message', (event) => {
        const message = typeof event === 'object' && event !== null && 'data' in event ? event.data : event
        if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'shutdown') {
          running.shutdown.interrupt(0)
        }
      })
      break
    }
    case 'plugin': {
      const { runPlugin } = await import('./plugin.ts')
      process.exit(runPlugin(invocation.profile, invocation.args))
      break
    }
    case 'dump-config': {
      const { runDumpConfig } = await import('./dump-config.ts')
      runDumpConfig(invocation.profile, invocation.defaultOnly, invocation.patches)
      break
    }
    default:
      invocation satisfies never
      throw new Error(`hydra: unhandled invocation mode ${JSON.stringify(invocation)}`)
  }
}

if (invocation.mode === 'menu') {
  if (process.env.npm_command === 'exec' && process.env.npm_lifecycle_event === 'npx'
    && process.stdin.isTTY && process.stdout.isTTY && !process.env.CI) {
    const { installNpxCommand } = await import('./install-command.ts')
    try {
      await installNpxCommand(readVersion())
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      process.exit(1)
    }
  }
  const { runModeMenu } = await import('./mode-menu.ts')
  const selection = await runModeMenu()
  if (selection.kind === 'profile') {
    await dispatch({ mode: 'profile', profile: selection.profile, patches: [], args: selection.args })
  } else if (selection.kind === 'desktop') {
    await dispatch({ mode: 'desktop', args: [] })
  } else {
    process.exitCode = selection.code
  }
} else {
  await dispatch(invocation)
}

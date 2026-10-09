import { Buffer } from 'node:buffer'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { runModeMenu, type ModeMenuIO, type ModeMenuResult } from '../src/mode-menu.ts'

interface MenuRun {
  result: ModeMenuResult
  output: string
  error: string
}

async function runMenu(
  inputText: string,
  overrides: Partial<Pick<ModeMenuIO, 'stdinIsTTY' | 'stdoutIsTTY' | 'ci'>> = {},
): Promise<MenuRun> {
  const input = new PassThrough()
  const output = new PassThrough()
  const error = new PassThrough()
  let outputText = ''
  let errorText = ''
  output.on('data', (chunk: Buffer) => { outputText += chunk.toString() })
  error.on('data', (chunk: Buffer) => { errorText += chunk.toString() })
  const resultPromise = runModeMenu({
    input,
    output,
    error,
    stdinIsTTY: true,
    stdoutIsTTY: true,
    ...overrides,
  })
  input.end(inputText)
  return { result: await resultPromise, output: outputText, error: errorText }
}

describe('runModeMenu', () => {
  it('selects Web', async () => {
    const run = await runMenu('1\n')
    expect(run.result).toEqual({ kind: 'profile', profile: 'web', args: [] })
    expect(run.output).toContain('1) Web')
    expect(run.error).toBe('')
  })

  it('selects Headless and preserves task text that resembles a launcher command', async () => {
    for (const task of ['web', 'plugin', '--dry-run']) {
      const run = await runMenu(`2\n${task}\n`)
      expect(run.result).toEqual({ kind: 'profile', profile: 'headless', args: [task] })
    }
  })

  it('re-prompts blank Headless tasks', async () => {
    const run = await runMenu('2\n\nrun the tests\n')
    expect(run.result).toEqual({ kind: 'profile', profile: 'headless', args: ['run the tests'] })
    expect(run.error).toContain('a Headless task is required')
  })

  it('selects Desktop', async () => {
    const run = await runMenu('3\n')
    expect(run.result).toEqual({ kind: 'desktop' })
    expect(run.output).toContain('Open the Electron app')
  })

  it('exits successfully on q and EOF', async () => {
    await expect(runMenu('q\n')).resolves.toMatchObject({ result: { kind: 'exit', code: 0 } })
    await expect(runMenu('')).resolves.toMatchObject({ result: { kind: 'exit', code: 0 } })
  })

  it('does not prompt without two TTY streams or in CI', async () => {
    const nonTty = await runMenu('', { stdinIsTTY: false })
    expect(nonTty.result).toEqual({ kind: 'exit', code: 1 })
    expect(nonTty.error).toContain('requires an interactive terminal')
    const ci = await runMenu('', { ci: '1' })
    expect(ci.result).toEqual({ kind: 'exit', code: 1 })
    expect(ci.error).toContain('npx @hydraharness/harness web')
  })
})

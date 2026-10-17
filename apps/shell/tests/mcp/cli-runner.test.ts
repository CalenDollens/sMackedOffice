import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  cliErrorMessage,
  cliChildEnv,
  createCliRunner,
  MAX_CLI_OUTPUT_BYTES,
} from '../../src/main/mcp/cli-runner'

function script(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'genoffice-cli-runner-'))
  const file = join(dir, 'child.js')
  writeFileSync(file, body)
  return file
}

describe('createCliRunner output cap', () => {
  it('does not inherit unrelated secrets or Node code-injection options', () => {
    const env = cliChildEnv({
      GENOFFICE_ALLOWED_ROOTS: 'C:\\safe',
      AWS_SECRET_ACCESS_KEY: 'do-not-forward',
      NODE_OPTIONS: '--require C:\\evil.js',
    })
    expect(env.GENOFFICE_ALLOWED_ROOTS).toBe('C:\\safe')
    expect(env.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined()
    expect(env.NODE_OPTIONS).toBeUndefined()
  })

  it('kills a flooding child and bounds the buffered output', async () => {
    const runner = createCliRunner({
      executable: process.execPath,
      entry: script(
        `process.stdout.write('x'.repeat(${MAX_CLI_OUTPUT_BYTES + 1024 * 1024})); setInterval(() => {}, 1000)`,
      ),
    })
    const start = Date.now()
    const outcome = await runner.run(['ignored-arg'], { timeoutMs: 60_000 })
    expect(Date.now() - start).toBeLessThan(60_000)
    expect(outcome.ok).toBe(false)
    expect(outcome.stdout.length + outcome.stderr.length).toBeLessThanOrEqual(
      MAX_CLI_OUTPUT_BYTES + 2000,
    )
    expect(outcome.stderr).toContain('truncated')
    expect(cliErrorMessage(outcome)).toContain('genoffice failed')
  }, 60_000)

  it('passes normal runs through uncapped', async () => {
    const runner = createCliRunner({
      executable: process.execPath,
      entry: script(`console.log(JSON.stringify({ status: 'ok', command: 'x', summary: 'fine' }))`),
    })
    const outcome = await runner.run(['ignored-arg'])
    expect(outcome.ok).toBe(true)
    expect(outcome.json).toMatchObject({ status: 'ok' })
  }, 30_000)
})

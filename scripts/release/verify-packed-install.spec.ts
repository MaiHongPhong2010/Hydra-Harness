/** Rejected HTTP resources and awaited process cleanup in the installed Web probe. */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { verifyWebBoot } from './verify-packed-install.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it.each([
  { status: 404, type: 'application/javascript' },
  { status: 200, type: 'text/css' },
])('rejects an entry asset with HTTP $status and $type, and stops its server', async ({ status, type }) => {
  const root = mkdtempSync(join(tmpdir(), 'hydra-web-probe-'))
  roots.push(root)
  const bin = join(root, 'bin.mjs')
  const addressFile = join(root, 'address')
  writeFileSync(bin, `
import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'
const server = createServer((request, response) => {
  if (request.url === '/entry.js') {
    response.writeHead(${String(status)}, { 'content-type': ${JSON.stringify(type)} })
    response.end('export {}')
    return
  }
  response.writeHead(200, { 'content-type': 'text/html' })
  response.end('<script>window.__HYDRA_BOOT__={}</script><script src="/entry.js"></script>')
})
server.listen(0, '127.0.0.1', () => {
  const address = 'http://127.0.0.1:' + server.address().port
  writeFileSync(${JSON.stringify(addressFile)}, address)
  console.log(address)
})
`)

  await expect(verifyWebBoot(bin, root, process.env)).rejects.toThrow('installed Web renderer entry failed')
  await expect(fetch(readFileSync(addressFile, 'utf8'), { signal: AbortSignal.timeout(2_000) })).rejects.toThrow()
}, 15_000)

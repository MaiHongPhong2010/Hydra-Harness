import { createServer } from 'node:http'
import type { IncomingHttpHeaders } from 'node:http'
import { once } from 'node:events'
import { CookieJar } from 'tough-cookie'
import { describe, expect, it } from 'vitest'
import { GeminiWebHttp, GeminiWebFrames, GeminiWebError, geminiWebBootstrap,
  geminiWebCandidate, geminiWebMediaUrl } from './gemini-web-http.ts'
import type { GeminiWebJob } from './gemini-web-http.ts'

function frames(records: unknown[]): string {
  const body = JSON.stringify(records)
  return `)]}'\n\n${body.length + 1}\n${body}\n`
}

function imageCandidate(rcid = 'rc_fixture'): unknown[] {
  const candidate: unknown[] = new Array(13).fill(null)
  candidate[0] = rcid
  const image = [[null, null, null, [null, null, '舟 🛶', 'https://lh3.googleusercontent.com/preview']], ['image_fixture']]
  candidate[12] = [null, null, null, null, null, null, null, [[image]]]
  return candidate
}

function videoCandidate(rcid = 'rc_fixture'): unknown[] {
  const candidate: unknown[] = new Array(13).fill(null)
  candidate[0] = rcid
  const item: unknown[] = new Array(8).fill(null)
  item[7] = ['https://lh3.googleusercontent.com/thumb', 'https://contribution.usercontent.google.com/video']
  candidate[12] = [{ '60': [[[[item]]]] }]
  return candidate
}

interface Reply { status?: number; headers?: Record<string, string>; body: string | Uint8Array; split?: number }

function acceptedGeneration(): Reply {
  return { body: frames([['wrb.fr', null, JSON.stringify([null, ['c_fixture', 'r_fixture'], null, null, []])]]) }
}

async function fixture(reply: (path: string, headers: IncomingHttpHeaders, body: string, bytes: Buffer) => Reply,
  run: (fetcher: typeof fetch) => Promise<void>): Promise<void> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const requestBytes = Buffer.concat(chunks)
      const result = reply(request.url ?? '/', request.headers, requestBytes.toString('utf8'), requestBytes)
      response.writeHead(result.status ?? 200, result.headers ?? { 'content-type': 'application/json' })
      const bytes = Buffer.from(result.body)
      if (result.split !== undefined) response.write(bytes.subarray(0, result.split))
      response.end(result.split === undefined ? bytes : bytes.subarray(result.split))
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture has no port')
  const fetcher: typeof fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    return fetch(`http://127.0.0.1:${address.port}${url.pathname}${url.search}`, init)
  }
  try { await run(fetcher) }
  finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => { if (error) reject(error); else resolve() }))
  }
}

const bootstrap = '<script>window.WIZ_global_data={"SNlM0e":"fixture-token","cfb2h":"fixture-build","FdrFJe":"fixture-session","oPEP7c":"fixture@example.test"}</script>'
const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0])
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 16]), Buffer.from('ftypisom'), Buffer.from([0, 0, 0, 0])])
const job = (): GeminiWebJob => ({ id: '00000000-0000-4000-8000-000000000001', kind: 'image', cid: '', rid: '', rcid: '' } as GeminiWebJob)

describe('Gemini web HTTP feasibility', () => {
  it('ends a completed refusal after a pending video chip without submitting again or downloading', async () => {
    let submissions = 0; let polls = 0
    const selected: unknown[] = new Array(13).fill(null); selected[0] = 'rc_fixture'; selected[8] = [2]
    selected[1] = ['Tôi không thể hỗ trợ bạn việc đó, vì tôi chỉ là một mô hình ngôn ngữ và không có khả năng hiểu và phản hồi.']
    await fixture((path) => {
      if (path === '/app') return { body: bootstrap }
      if (path.includes('/StreamGenerate?')) {
        submissions++
        return acceptedGeneration()
      }
      if (path.includes('rpcids=hNvQHb')) {
        polls++
        const pending = [...selected]; pending[12] = [{ '65': [null, 'fixture-video-task'] }]
        return { body: frames([['wrb.fr', 'hNvQHb', JSON.stringify([
          [[[null, 'r_other'], null, null, [[selected]]], [[null, 'r_fixture'], null, null, [[polls === 1 ? pending : selected]]]],
        ])]]), split: 25 }
      }
      throw new Error('Refused media must not be downloaded')
    }, async (fetcher) => {
      const client = new GeminiWebHttp(new CookieJar(), AbortSignal.timeout(10000), fetcher)
      try {
        const task = { ...job(), kind: 'video' as const }
        await client.generate(task, 'Animate', async () => {})
        await expect(client.retrieve(task, 1)).rejects.toMatchObject({ code: 'NO_GENERATED_MEDIA' })
        expect(submissions).toBe(1); expect(polls).toBe(2)
      } finally { await client.close() }
    })
  })

  it('uploads exact binary references and retrieves a portrait MP4 without uploading or generating again', async () => {
    let submissions = 0; let uploads = 0
    await fixture((path, headers, body, bytes) => {
      if (path === '/app') return { body: bootstrap.replace('}</script>', ',"qKIAYe":"feeds/fixture"}</script>') }
      if (path.startsWith('/upload/')) {
        expect(headers['push-id']).toBe('feeds/fixture')
        expect(headers.cookie).toBe('session=fixture')
        if (headers['x-goog-upload-command'] === 'start') return {
          body: '', headers: { 'x-goog-upload-url': 'https://push.clients6.google.com/upload/?upload_id=fixture' },
        }
        uploads++; expect(bytes).toEqual(Buffer.from(png))
        return { body: '/contrib_service/ttl_1d/fixture' }
      }
      if (path.includes('/StreamGenerate?')) {
        submissions++
        const outer = JSON.parse(new URLSearchParams(body).get('f.req')!) as [unknown, string]
        const payload = JSON.parse(outer[1]) as unknown[]; expect(payload[55]).toEqual([[17]])
        expect((payload[0] as unknown[])[3]).toEqual([[['/contrib_service/ttl_1d/fixture', 1, null, 'image/png', expect.any(String)], 'reference-1.png']])
        return { body: frames([['wrb.fr', null, JSON.stringify([null, ['c_fixture', 'r_fixture'], null, null, []])]]) }
      }
      if (path.includes('rpcids=hNvQHb')) return { body: frames([['wrb.fr', 'hNvQHb', JSON.stringify([
        [[[null, 'r_fixture'], null, null, [[videoCandidate()]]]],
      ])]]) }
      if (path === '/video') return { body: mp4, headers: { 'content-type': 'video/mp4' } }
      throw new Error('Unexpected reference request')
    }, async (fetcher) => {
      const jar = new CookieJar(); await jar.setCookie('session=fixture; Domain=.google.com; Secure; Path=/', 'https://gemini.google.com')
      const task = { ...job(), kind: 'video' as const }
      const client = new GeminiWebHttp(jar, AbortSignal.timeout(10000), fetcher)
      try {
        await client.generate(task, 'Animate', async () => {}, { size: '720x1280', images: [{ data: png, mimeType: 'image/png' }] })
      } finally { await client.close() }
      const restarted = new GeminiWebHttp(jar, AbortSignal.timeout(10000), fetcher)
      try {
        const selected = await restarted.retrieve(task, 1)
        expect(Buffer.from((await restarted.download(selected.url, 'video')).data)).toEqual(mp4)
      } finally { await restarted.close() }
      expect(submissions).toBe(1); expect(uploads).toBe(1)
    })
  })
  it('decodes split XSSI, multiple frames and UTF-16 lengths without losing Unicode', () => {
    const first = frames([['wrb.fr', 'first', JSON.stringify(['舟 🛶'])]])
    const second = frames([['wrb.fr', 'second', '[]']]).slice(4)
    const parser = new GeminiWebFrames()
    const output = (first + second).split('').flatMap(character => parser.feed(character))
    parser.finish()
    expect(output).toEqual([['wrb.fr', 'first', JSON.stringify(['舟 🛶'])], ['wrb.fr', 'second', '[]']])
    const truncated = new GeminiWebFrames()
    truncated.feed(first.slice(0, -3))
    expect(() =>{  truncated.finish() }).toThrow('TRUNCATED_FRAME')
    expect(() => new GeminiWebFrames().feed('html')).toThrow('MISSING_XSSI_PREFIX')
  })

  it('rejects missing login metadata and assets outside the observed HTTPS hosts', () => {
    expect(geminiWebBootstrap(bootstrap)).toEqual({ SNlM0e: 'fixture-token', cfb2h: 'fixture-build', FdrFJe: 'fixture-session' })
    expect(() => geminiWebBootstrap('<html>Sign in</html>')).toThrow('RECONNECT_REQUIRED')
    for (const url of ['http://lh3.googleusercontent.com/a', 'https://lh3.googleusercontent.com.evil.test/a',
      'https://user:password@contribution.usercontent.google.com/a']) {
      expect(() => geminiWebMediaUrl(url)).toThrow('UNSUPPORTED_MEDIA_HOST')
    }
    const search: unknown[] = new Array(13).fill(null)
    search[12] = [null, [[[['https://lh3.googleusercontent.com/search']]]]]
    expect(geminiWebCandidate(search, 'image')).toBeUndefined()
  })

  it('submits once, checkpoints a job, resolves the original image and scopes cookies across redirects', async () => {
    let submissions = 0
    let checkpoints = 0
    const sentHeaders: { path: string; cookie: string | undefined }[] = []
    await fixture((path, headers, body) => {
      sentHeaders.push({ path, cookie: headers.cookie })
      expect(headers['user-agent']).toContain('hydra-harness/')
      if (path === '/app') return { body: bootstrap, headers: { 'content-type': 'text/html', 'set-cookie': 'fresh=ok; Secure; Path=/' } }
      if (path.includes('/StreamGenerate?')) {
        submissions++
        const fields = new URLSearchParams(body)
        expect(fields.get('at')).toBe('fixture-token')
        const encoded = JSON.parse(fields.get('f.req') ?? 'null') as [unknown, string]
        const inner = JSON.parse(encoded[1]) as unknown[]
        expect(inner[49]).toBe(14)
        expect(inner[0]).toEqual(['Generate a paper boat.', 0, null, null, null, null, 0])
        const result: unknown[] = new Array(5).fill(null)
        result[1] = ['c_fixture', 'r_fixture']
        result[4] = [imageCandidate()]
        const response = frames([['wrb.fr', null, JSON.stringify(result)]])
        return { body: response, split: Buffer.from(response).indexOf(Buffer.from('舟')) + 1 }
      }
      if (path.includes('rpcids=c8o8Fe')) return { body: frames([['wrb.fr', 'c8o8Fe', JSON.stringify(['https://lh3.google.com/original'])]]) }
      if (path === '/original') return { status: 302, headers: { location: 'https://work.fife.usercontent.google.com/fife' }, body: '' }
      if (path === '/fife') return { status: 302, headers: { location: 'https://lh3.googleusercontent.com/image' }, body: '' }
      if (path === '/image') return { headers: { 'content-type': 'image/png', 'content-length': String(png.length) }, body: png }
      throw new Error('unexpected fixture request')
    }, async (fetcher) => {
      const jar = new CookieJar()
      await jar.setCookie('__Secure-1PSID=fixture-cookie; Domain=.google.com; Secure; Path=/', 'https://gemini.google.com')
      const client = new GeminiWebHttp(jar, AbortSignal.timeout(10000), fetcher)
      try {
        const task = job()
        const media = await client.generate(task, 'Generate a paper boat.', async () => { checkpoints++ })
        expect(task).toMatchObject({ cid: 'c_fixture', rid: 'r_fixture', rcid: 'rc_fixture' } as GeminiWebJob)
        expect(media?.imageId).toBe('image_fixture')
        const asset = await client.download(await client.originalImage(task, media!), 'image')
        expect([...asset.data]).toEqual([...png])
        expect(checkpoints).toBeGreaterThan(0)
        expect(submissions).toBe(1)
        expect(sentHeaders.find(item => item.path === '/original')?.cookie).toContain('fixture-cookie')
        expect(sentHeaders.find(item => item.path === '/fife')?.cookie).toContain('fixture-cookie')
        expect(sentHeaders.find(item => item.path === '/image')?.cookie).toBeUndefined()
      } finally { await client.close() }
    })
  })

  it('retrieves the exact saved video reply after a download failure without another submission', async () => {
    let submissions = 0
    let failDownload = true
    await fixture((path) => {
      if (path === '/app') return { body: bootstrap }
      if (path.includes('/StreamGenerate?')) { submissions++; return { status: 500, body: 'do not expose provider body' } }
      if (path.includes('rpcids=hNvQHb')) {
        const turn = (rid: string, candidate: unknown[]) => [[null, rid], null, null, [[candidate]]]
        return { body: frames([['wrb.fr', 'hNvQHb', JSON.stringify([[turn('r_other', videoCandidate()),
          turn('r_fixture', videoCandidate('rc_other')), turn('r_fixture', videoCandidate())]])]]) }
      }
      if (path === '/video') return failDownload ? { status: 403, body: 'private signed asset URL must not appear' }
        : { status: 206, headers: { 'content-type': 'video/mp4', 'content-range': `bytes 0-${mp4.length - 1}/${mp4.length}` }, body: mp4 }
      throw new Error('unexpected fixture request')
    }, async (fetcher) => {
      const task = { ...job(), kind: 'video' as const, cid: 'c_fixture', rid: 'r_fixture', rcid: 'rc_fixture' } as GeminiWebJob
      const client = new GeminiWebHttp(new CookieJar(), AbortSignal.timeout(10000), fetcher)
      try {
        const media = await client.retrieve(task, 1)
        await expect(client.download(media.url, 'video')).rejects.toMatchObject({ stage: 'download', code: 'HTTP_ERROR', status: 403 })
        failDownload = false
        const recovered = await client.retrieve(task, 1)
        expect((await client.download(recovered.url, 'video')).data).toEqual(mp4)
        expect(submissions).toBe(0)
      } finally { await client.close() }
    })
  })

  it('rejects partial 206, unsupported redirects and unexpected MIME without retrying downloads', async () => {
    for (const reply of [
      { status: 206, headers: { 'content-type': 'video/mp4', 'content-range': 'bytes 0-3/100' }, body: mp4 },
      { status: 302, headers: { location: 'https://evil.test/signed' }, body: '' },
      { status: 200, headers: { 'content-type': 'text/html' }, body: 'Sign in' },
    ]) {
      let requests = 0
      await fixture(() => { requests++; return reply }, async (fetcher) => {
        const client = new GeminiWebHttp(new CookieJar(), AbortSignal.timeout(10000), fetcher)
        try {
          await expect(client.download('https://contribution.usercontent.google.com/video', 'video')).rejects.toBeInstanceOf(GeminiWebError)
          expect(requests).toBe(1)
        } finally { await client.close() }
      })
    }
  })

  it('recovers a queued video whose candidate id arrives after the submission stream', async () => {
    let submissions = 0
    let checkpoints = 0
    await fixture((path) => {
      if (path === '/app') return { body: bootstrap }
      if (path.includes('/StreamGenerate?')) {
        submissions++
        return acceptedGeneration()
      }
      if (path.includes('rpcids=hNvQHb')) return { body: frames([['wrb.fr', 'hNvQHb', JSON.stringify([
        [[[null, 'r_other'], null, null, [[videoCandidate('rc_other')]]],
          [[null, 'r_fixture'], null, null, [[videoCandidate()]]]],
      ])]]) }
      throw new Error('unexpected fixture request')
    }, async (fetcher) => {
      const client = new GeminiWebHttp(new CookieJar(), AbortSignal.timeout(10000), fetcher)
      try {
        const task = { ...job(), kind: 'video' as const }
        const save = async () => { checkpoints++ }
        expect(await client.generate(task, 'Generate a video.', save)).toBeUndefined()
        expect(task).toMatchObject({ cid: 'c_fixture', rid: 'r_fixture', rcid: '' })
        expect((await client.retrieve(task, 1, save)).url).toContain('/video')
        expect(task.rcid).toBe('rc_fixture')
        expect(checkpoints).toBe(2)
        expect(submissions).toBe(1)
      } finally { await client.close() }
    })
  })

  it('does not retry an uncertain generation and honors cancellation during polling', async () => {
    let submissions = 0
    const controller = new AbortController()
    await fixture((path) => {
      if (path === '/app') return { body: bootstrap }
      if (path.includes('/StreamGenerate?')) { submissions++; return { status: 500, body: 'uncertain' } }
      controller.abort()
      return { body: frames([['wrb.fr', 'hNvQHb', '[]']]) }
    }, async (fetcher) => {
      const client = new GeminiWebHttp(new CookieJar(), controller.signal, fetcher)
      try {
        await expect(client.generate(job(), 'Generate an image.', async () => {})).rejects.toMatchObject({ status: 500 })
        expect(submissions).toBe(1)
        await expect(client.retrieve({ ...job(), cid: 'c_fixture', rid: 'r_fixture', rcid: 'rc_fixture' } as GeminiWebJob, 1)).rejects.toBeDefined()
        expect(controller.signal.aborted).toBe(true)
        expect(submissions).toBe(1)
      } finally { await client.close() }
    })
  })
})

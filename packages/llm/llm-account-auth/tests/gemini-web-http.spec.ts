/** HTTP parser, bounded downloads, and provider failures without generation retries. */
import { expect, it, vi } from 'vitest'
import { CookieJar } from 'tough-cookie'
import { GeminiWebHttp, GeminiWebFrames, GeminiWebError, geminiWebBootstrap, geminiWebCandidate, geminiWebMediaUrl, geminiWebJob } from '../src/gemini-web-http.ts'

const html = '{"SNlM0e":"fixture","cfb2h":"build","FdrFJe":"session","oPEP7c":"fixture@example.test"}'
const uploadHtml = html.slice(0, -1) + ',"qKIAYe":"feeds/fixture"}'
const frame = (value: unknown) => { const body = JSON.stringify(value); return `)]}'\n${body.length + 1}\n${body}\n` }
const task = () => ({ ...geminiWebJob('00000000-0000-4000-8000-000000000001', 'video'), cid: 'c_one', rid: 'r_one', rcid: '' }) as ReturnType<typeof geminiWebJob>
const url = 'https://contribution.usercontent.google.com/video'
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 16]), Buffer.from('ftypisom'), Buffer.from([0, 0, 0, 0])])
const png = Buffer.from('89504e470d0a1a0a00000000', 'hex')
const videoCandidate = (id = 'rc_one', media = url): unknown[] => {
  const row: unknown[] = new Array(13).fill(null); row[0] = id
  const item: unknown[] = new Array(8).fill(null); item[7] = [null, media]
  row[12] = [{ '60': [[[[item]]]] }]; return row
}
const turn = (id: string, candidates: unknown[]) => [[null, id], null, null, [candidates]]
const refusedCandidate = (reply = 'Tôi không thể hỗ trợ bạn việc đó, vì tôi chỉ là một mô hình ngôn ngữ và không có khả năng hiểu và phản hồi.'): unknown[] => {
  const candidate: unknown[] = new Array(28).fill(null)
  candidate[0] = 'rc_one'; candidate[1] = [reply]; candidate[8] = [2]; candidate[9] = 'vi'
  candidate[12] = [null, null, null, null, null, null, null, []]; candidate[27] = []
  return candidate
}

it.each(['1280x720', '720x1280'] as const)('uploads reference bytes once and submits %s with the observed attachment fields', async (size) => {
  let uploads = 0; let submissions = 0
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const location = new URL(requestUrl(input))
    if (location.pathname === '/app') return new Response(uploadHtml)
    if (location.hostname === 'push.clients6.google.com') {
      const headers = new Headers(init?.headers)
      expect(headers.get('push-id')).toBe('feeds/fixture')
      if (headers.get('x-goog-upload-command') === 'start') {
        expect(headers.get('x-goog-upload-header-content-length')).toBe(String(png.byteLength))
        expect(init?.body).toBe('File name: reference-1.png')
        return new Response('', { headers: { 'x-goog-upload-url': 'https://push.clients6.google.com/upload/?upload_id=fixture' } })
      }
      uploads++
      expect(headers.get('x-goog-upload-offset')).toBe('0')
      expect(init?.body).toEqual(png)
      return new Response('/contrib_service/ttl_1d/fixture')
    }
    submissions++
    const outer = JSON.parse(new URLSearchParams(init?.body as URLSearchParams).get('f.req')!) as [unknown, string]
    const body = JSON.parse(outer[1]) as unknown[]
    expect((body[0] as unknown[])[3]).toEqual([[['/contrib_service/ttl_1d/fixture', 1, null, 'image/png', expect.any(String)], 'reference-1.png']])
    expect(body[30]).toEqual([4, 16])
    expect(body[55]).toEqual([[size === '720x1280' ? 17 : 16]])
    return new Response(frame([['wrb.fr', null, JSON.stringify([null, ['c_one', 'r_one'], null, null, [videoCandidate()]])]]))
  })
  await clientTest(fetcher, async (client) => {
    expect(await client.generate(geminiWebJob('id', 'video'), 'Animate', async () => {}, { size, images: [{ data: png, mimeType: 'image/png' }] })).toEqual({ url })
  })
  expect(uploads).toBe(1); expect(submissions).toBe(1)
})

it.each([
  [() => new Response(null, { status: 403 }), 'HTTP_ERROR'],
  [() => new Response(null), 'INVALID_UPLOAD_URL'],
  [() => new Response(null, { headers: { 'x-goog-upload-url': 'https://evil.test/upload/' } }), 'INVALID_UPLOAD_URL'],
  [() => new Response(null, { headers: { 'x-goog-upload-url': 'https://push.clients6.google.com/wrong' } }), 'INVALID_UPLOAD_URL'],
  [() => new Response(null, { headers: { 'x-goog-upload-url': 'https://user@push.clients6.google.com/upload/' } }), 'INVALID_UPLOAD_URL'],
  [() => new Response(null, { headers: { 'x-goog-upload-url': 'https://push.clients6.google.com/upload/#token' } }), 'INVALID_UPLOAD_URL'],
] as const)('refuses unsafe upload initiation without generation or retries %#', async (reply, code) => {
  const fetcher = vi.fn<typeof fetch>(async input => requestUrl(input).endsWith('/app') ? new Response(uploadHtml) : reply())
  await clientTest(fetcher, client => expect(client.generate(geminiWebJob('id', 'video'), 'Animate', async () => {},
    { images: [{ data: png, mimeType: 'image/png' }] })).rejects.toThrow(code))
  expect(fetcher).toHaveBeenCalledTimes(2)
})

it.each([
  [() => new Response(null, { status: 500 }), 'HTTP_ERROR'],
  [() => new Response('/unexpected/file'), 'INVALID_FILE_REFERENCE'],
  [() => new Response(new Uint8Array(4097)), 'BYTE_LIMIT'],
] as const)('stops after failed reference upload completion %#', async (reply, code) => {
  const fetcher = vi.fn<typeof fetch>(async (input, init) => requestUrl(input).endsWith('/app') ? new Response(uploadHtml)
    : new Headers(init?.headers).get('x-goog-upload-command') === 'start'
      ? new Response(null, { headers: { 'x-goog-upload-url': 'https://push.clients6.google.com/upload/?upload_id=fixture' } }) : reply())
  await clientTest(fetcher, client => expect(client.generate(geminiWebJob('id', 'video'), 'Animate', async () => {},
    { images: [{ data: png, mimeType: 'image/jpeg' }] })).rejects.toThrow(code))
  expect(fetcher).toHaveBeenCalledTimes(3)
})

it.each([html, html.slice(0, -1) + ',"qKIAYe":"invalid"}'])('requires the bootstrap upload id before sending bytes %#', async (page) => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(page))
  await clientTest(fetcher, client => expect(client.generate(geminiWebJob('id', 'video'), 'Animate', async () => {},
    { images: [{ data: png, mimeType: 'image/png' }] })).rejects.toThrow('MISSING_PUSH_ID'))
  expect(fetcher).toHaveBeenCalledOnce()
})

const requestUrl = (input: string | URL | Request) => input instanceof Request ? input.url : String(input)

async function clientTest(fetcher: typeof fetch, run: (client: GeminiWebHttp) => Promise<void>,
  signal = new AbortController().signal, jar = new CookieJar()) {
  const client = new GeminiWebHttp(jar, signal, fetcher)
  try { await run(client) } finally { await client.close() }
}

it('rejects malformed prefixes, lengths, JSON, and unfinished UTF-16 frames', () => {
  for (const [input, code] of [['oops', 'MISSING_XSSI_PREFIX'], [")]}'\nX", 'INVALID_FRAME_LENGTH'],
    [")]}'\n0\n", 'INVALID_FRAME_LENGTH'], [")]}'\n16777217\n", 'INVALID_FRAME_LENGTH'],
    [")]}'\n9007199254740992\n", 'INVALID_FRAME_LENGTH'], [")]}'\n3\nxx", 'INVALID_JSON']]) {
    expect(() => new GeminiWebFrames().feed(input!)).toThrow(code)
  }
  for (const input of ['', ")]}'\n10\n[1]"]) { const parser = new GeminiWebFrames(); parser.feed(input); expect(() =>{  parser.finish() }).toThrow('TRUNCATED_FRAME') }
  const parser = new GeminiWebFrames(); expect(parser.feed(")]}'\n1")).toEqual([])
  expect(parser.feed('0\n[1,2,3,4]')).toEqual([1, 2, 3, 4]); parser.finish()
  expect(new GeminiWebFrames().feed(frame({ ignored: true }))).toEqual([])
  expect(() => geminiWebBootstrap(html.replace('fixture', ''))).toThrow('INVALID_METADATA')
  expect(() => geminiWebBootstrap('')).toThrow('RECONNECT_REQUIRED')
})

it('selects only generated image records and observed video fields', () => {
  expect(geminiWebCandidate(null, 'image')).toBeUndefined()
  expect(geminiWebCandidate([], 'video')).toBeUndefined()
  const image: unknown[] = new Array(13).fill(null)
  const item = [[null, null, null, [null, null, null, 'https://lh3.google.com/image']], ['image-id']]
  image[12] = [{ '8': [[[], item]] }]
  expect(geminiWebCandidate(image, 'image')).toEqual({ url: 'https://lh3.google.com/image', imageId: 'image-id' })
  for (const value of [null, 'wrong', [], { '8': [] }]) { image[12] = [value]; expect(geminiWebCandidate(image, 'image')).toBeUndefined() }
  const omni: unknown[] = new Array(87).fill(null); omni[86] = [null, [null, [null, null, null, null, null, null, null, [null, url]]]]
  expect(geminiWebCandidate([...new Array<unknown>(12).fill(null), omni], 'video')).toEqual({ url })
  expect(geminiWebCandidate(videoCandidate('rc_one', ''), 'video')).toBeUndefined()
  const denied = videoCandidate('rc_one', '')
  denied[1] = ['I can create more videos as soon as your limit resets. Check your usage in Settings.']
  expect(() => geminiWebCandidate(denied, 'video')).toThrow('QUOTA_EXHAUSTED')
})

it.each(['image', 'video'] as const)('ends completed %s replies without media regardless of language', (kind) => {
  for (const reply of [undefined, 'Please upload an image.', 'No puedo generar este contenido.']) {
    expect(() => geminiWebCandidate(refusedCandidate(reply), kind)).toThrow('NO_GENERATED_MEDIA')
  }
  const pending = refusedCandidate(); pending[8] = [1]
  expect(geminiWebCandidate(pending, kind)).toBeUndefined()
  const blank = refusedCandidate('   ')
  expect(geminiWebCandidate(blank, kind)).toBeUndefined()
})

it('keeps a completed reply with a pending video chip polling and prefers returned media', () => {
  const pending = refusedCandidate('Your video is being generated.'); pending[12] = [{ '65': [null, 'fixture-video-task'] }]
  expect(geminiWebCandidate(pending, 'video')).toBeUndefined()
  expect(() => geminiWebCandidate(pending, 'image')).toThrow('NO_GENERATED_MEDIA')
  const ready = videoCandidate(); ready[1] = ['Your video is ready.']; ready[8] = [2]
  expect(geminiWebCandidate(ready, 'video')).toEqual({ url })
})

it('stops after one generation when its selected reply finishes without a video', async () => {
  const fetcher = vi.fn<typeof fetch>(async input => requestUrl(input).endsWith('/app') ? new Response(html)
    : new Response(frame([['wrb.fr', null, JSON.stringify([null, ['c_one', 'r_one'], null, null, [refusedCandidate()]])]])))
  await clientTest(fetcher, client => expect(client.generate(geminiWebJob('id', 'video'), 'Animate', async () => {})).rejects.toThrow('NO_GENERATED_MEDIA'))
  expect(fetcher).toHaveBeenCalledTimes(2)
  expect(fetcher.mock.calls.filter(([input]) => requestUrl(input).includes('StreamGenerate'))).toHaveLength(1)
})

it('admits only observed HTTPS hosts without credentials, ports, or fragments', () => {
  for (const value of ['invalid', 'http://lh3.google.com/x', 'https://user@lh3.google.com/x', 'https://:password@lh3.google.com/x',
    'https://lh3.google.com:444/x', 'https://lh3.google.com/x#secret', 'https://unobserved.google.com/x', 'https://evil.test/x']) {
    expect(() => geminiWebMediaUrl(value)).toThrow(GeminiWebError)
  }
})

it.each([undefined, null, 1, {}, { code: 3 }, { code: 'UNKNOWN' }, { code: 'ECONNRESET' }])('sanitizes transport causes %#', async (cause) => {
  const fetcher = vi.fn<typeof fetch>(async () => { throw new Error('private upstream text', { cause }) })
  await clientTest(fetcher, async (client) => {
    await expect(client.bootstrap()).rejects.toMatchObject({ code: typeof cause === 'object' && cause?.code === 'ECONNRESET' ? 'ECONNRESET' : 'TRANSPORT_ERROR' })
    expect(fetcher).toHaveBeenCalledOnce()
  })
})

it('sanitizes non-Error failures and preserves cancellation', async () => {
  await clientTest(async () => { throw 'private text' }, client => expect(client.bootstrap()).rejects.toThrow('TRANSPORT_ERROR'))
  const controller = new AbortController()
  await clientTest(async () => { controller.abort(); throw new Error('Private error') }, async (client) => {
    await expect(client.bootstrap()).rejects.toMatchObject({ name: 'AbortError' })
  }, controller.signal)
})

it.each([
  () => new Response(null),
  () => new Response(new Uint8Array(16 * 1024 * 1024 + 1)),
  () => new Response(html.replace(',"oPEP7c":"fixture@example.test"', '')),
  () => new Response(html.replace('fixture@example.test', 'not-email')),
  () => new Response(html.replace('fixture@example.test', 'a'.repeat(321))),
  () => new Response(null, { status: 403 }),
])('refuses invalid or excessive bootstrap responses %#', async (response) => {
  await clientTest(async () => response(), client => expect(client.bootstrap()).rejects.toBeInstanceOf(GeminiWebError))
})

it.each([null, 'body'])('cancels responses after an invalid Set-Cookie %#', async (body) => {
  await clientTest(async () => new Response(body, { headers: { 'set-cookie': 'broken' } }), client => expect(client.bootstrap()).rejects.toThrow('INVALID_SET_COOKIE'))
})

it.each([
  [302, {}, '', 'MISSING_REDIRECT'],
  [200, { 'content-type': 'image/png', 'content-length': '0' }, png, 'INCOMPLETE_BODY'],
  [200, { 'content-type': 'image/png', 'content-length': 'NaN' }, png, 'INCOMPLETE_BODY'],
  [200, { 'content-type': 'image/png', 'content-length': '33554433' }, png, 'INCOMPLETE_BODY'],
  [200, { 'content-type': 'image/png', 'content-length': '100' }, png, 'INCOMPLETE_BODY'],
  [200, { 'content-type': 'image/png' }, null, 'EMPTY_BODY'],
  [200, { 'content-type': 'image/png' }, new Uint8Array(), 'INCOMPLETE_BODY'],
  [200, { 'content-type': 'image/png' }, 'not PNG', 'INVALID_MEDIA_SIGNATURE'],
  [200, { 'content-type': 'image/png' }, new Uint8Array(32 * 1024 * 1024 + 1), 'BYTE_LIMIT'],
  [206, { 'content-type': 'image/png' }, png, 'INCOMPLETE_RANGE'],
  [206, { 'content-type': 'image/png', 'content-range': 'bytes 0-2/*' }, png, 'INCOMPLETE_RANGE'],
  [206, { 'content-type': 'image/png', 'content-range': 'bytes 0-9007199254740993/9007199254740994' }, png, 'INCOMPLETE_RANGE'],
  [206, { 'content-type': 'image/png', 'content-range': 'bytes 0-11/13' }, png, 'INCOMPLETE_RANGE'],
  [200, {}, png, 'INVALID_MEDIA_TYPE'],
] as const)('refuses invalid completed image downloads without retries %#', async (status, headers, body, code) => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(body, { status, headers }))
  await clientTest(fetcher, client => expect(client.download(url, 'image')).rejects.toThrow(code))
  expect(fetcher).toHaveBeenCalledOnce()
})

it('bounds redirect chains and accepts matching JPEG/WebP signatures', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 302, headers: { location: '/again' } }))
  await clientTest(fetcher, client => expect(client.download(url, 'video')).rejects.toThrow('REDIRECT_LIMIT'))
  expect(fetcher).toHaveBeenCalledTimes(6)
  for (const [type, bytes] of [['image/jpeg', Buffer.from([255, 216, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0])],
    ['image/webp', Buffer.from('RIFF1234WEBP')]] as const) {
    await clientTest(async () => new Response(bytes, { headers: { 'content-type': type } }), async (client) => {
      expect((await client.download(url, 'image')).mime).toBe(type)
    })
  }
  await clientTest(async () => new Response(mp4, { headers: { 'content-type': 'video/mp4', 'content-length': String(mp4.length) } }), async (client) => {
    expect((await client.download(url, 'video')).data).toEqual(mp4)
  })
  await clientTest(async () => new Response(png, { status: 206, headers: { 'content-type': 'image/png', 'content-range': 'bytes 0-11/12' } }), async (client) => {
    expect((await client.download(url, 'image')).data).toEqual(png)
  })
})

it('rejects invalid job and poll inputs before network requests', async () => {
  const fetcher = vi.fn<typeof fetch>()
  await clientTest(fetcher, async (client) => {
    for (const value of ['', 'x'.repeat(32001)]) await expect(client.generate(geminiWebJob('id', 'image'), value, async () => {})).rejects.toThrow('INVALID_NEW_JOB')
    for (const key of ['cid', 'rid', 'rcid'] as const) {
      await expect(client.generate({ ...geminiWebJob('id', 'image'), [key]: 'present' }, 'prompt', async () => {})).rejects.toThrow('INVALID_NEW_JOB')
    }
    await expect(client.retrieve(geminiWebJob('id', 'video'))).rejects.toThrow('NO_RECOVERABLE_JOB')
    await expect(client.retrieve(task(), 0)).rejects.toThrow('INVALID_POLL_INTERVAL')
    await expect(client.originalImage(task(), { url })).rejects.toThrow('MISSING_IMAGE_ID')
    const image = { ...task(), kind: 'image' as const }
    await expect(client.originalImage(image, { url })).rejects.toThrow('MISSING_IMAGE_ID')
    await expect(client.originalImage(image, { url, imageId: 'image' })).rejects.toThrow('BOOTSTRAP_REQUIRED')
  })
  expect(fetcher).not.toHaveBeenCalled()
})

it.each([
  () => new Response(null),
  () => new Response(new Uint8Array(16 * 1024 * 1024 + 1)),
  () => new Response(null, { status: 401 }),
  () => new Response('Private provider response', { status: 500 }),
  () => new Response(frame([['wrb.fr', null, '{}', null, null, [null, null, [[null, [4]]]]]])),
  () => new Response(frame([['wrb.fr', null, '{}']])),
])('stops after one failed submission response %#', async (response) => {
  const fetcher = vi.fn<typeof fetch>(async input => requestUrl(input).endsWith('/app') ? new Response(html) : response())
  await clientTest(fetcher, client => expect(client.generate(geminiWebJob('id', 'video'), 'Boat', async () => {})).rejects.toBeInstanceOf(GeminiWebError))
  expect(fetcher).toHaveBeenCalledTimes(2)
})

it('checkpoints only the selected generation reply and candidate', async () => {
  const job = geminiWebJob('id', 'video'); const save = vi.fn(async () => {})
  const result = (cid: string, rid: string, candidates: unknown[]) => [null, [cid, rid], null, null, candidates]
  const frames = [['unused'], ['wrb.fr', null, null], ['wrb.fr', null, JSON.stringify(result('', '', [[]]))],
    ['wrb.fr', null, JSON.stringify(result('c_one', '', [videoCandidate(), videoCandidate('rc_other')]))],
    ['wrb.fr', null, JSON.stringify(result('c_other', '', []))], ['wrb.fr', null, JSON.stringify(result('c_one', 'r_one', []))],
    ['wrb.fr', null, JSON.stringify(result('c_one', 'r_other', []))]]
  await clientTest(async input => requestUrl(input).endsWith('/app') ? new Response(html) : new Response(frame(frames)), async (client) => {
    expect(await client.generate(job, 'Boat', save)).toEqual({ url })
    expect(job).toMatchObject({ cid: 'c_one', rid: 'r_one', rcid: 'rc_one' })
    expect(save).toHaveBeenCalledTimes(3)
  })
})

it('polls until the selected candidate exists, saving a newly returned id', async () => {
  let polls = 0
  await clientTest(async (input) => {
    if (requestUrl(input).endsWith('/app')) return new Response(html)
    polls++
    return new Response(frame([['unrelated'], ['wrb.fr', 'other', '[]'], ['wrb.fr', 'hNvQHb', JSON.stringify([[
      turn('other', []), turn('r_one', [[], videoCandidate('rc_other', ''), ...(polls > 1 ? [videoCandidate('rc_other')] : [])]),
    ]])]]))
  }, async (client) => { expect(await client.retrieve(task(), 1)).toEqual({ url }); expect(polls).toBe(2) })
})

it('stops polling a saved task on the observed quota refusal without generation', async () => {
  const denied = videoCandidate('rc_one', '')
  denied[1] = ['I can create more videos as soon as your limit resets. Check your usage in Settings.']
  const fetcher = vi.fn<typeof fetch>(async input => requestUrl(input).endsWith('/app') ? new Response(html)
    : new Response(frame([['wrb.fr', 'hNvQHb', JSON.stringify([[turn('r_one', [denied])]])]])))
  await clientTest(fetcher, client => expect(client.retrieve(task(), 1)).rejects.toThrow('QUOTA_EXHAUSTED'))
  expect(fetcher).toHaveBeenCalledTimes(2)
  expect(fetcher.mock.calls.some(([input]) => requestUrl(input).includes('StreamGenerate'))).toBe(false)
})

it('ignores completed refusals from other replies, then stops the selected reply without resubmitting', async () => {
  let polls = 0
  const pending = refusedCandidate('Your video is being generated.'); pending[12] = [{ '65': [null, 'fixture-video-task'] }]
  const other = refusedCandidate(); other[0] = 'rc_other'
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    if (requestUrl(input).endsWith('/app')) return new Response(html)
    polls++
    return new Response(frame([['wrb.fr', 'hNvQHb', JSON.stringify([[
      turn('r_other', [refusedCandidate()]), turn('r_one', [other, polls === 1 ? pending : refusedCandidate()]),
    ]])]]))
  })
  const job = { ...task(), rcid: 'rc_one' } as ReturnType<typeof geminiWebJob>
  await clientTest(fetcher, client => expect(client.retrieve(job, 1)).rejects.toThrow('NO_GENERATED_MEDIA'))
  expect(polls).toBe(2)
  expect(fetcher.mock.calls.some(([input]) => requestUrl(input).includes('StreamGenerate'))).toBe(false)
})

it.each([null, JSON.stringify([])])('rejects missing RPC payload or original image URL %#', async (payload) => {
  await clientTest(async input => requestUrl(input).endsWith('/app') ? new Response(html) : new Response(frame([['wrb.fr', 'c8o8Fe', payload]])), async (client) => {
    await client.bootstrap()
    await expect(client.originalImage({ ...task(), kind: 'image' }, { url, imageId: 'image' })).rejects.toThrow(payload === null ? 'MISSING_RPC_RESULT' : 'NO_ORIGINAL_URL')
  })
})

it('reuses an HTTP bootstrap for image submission and original-image resolution', async () => {
  const jar = new CookieJar(); await jar.setCookie('session=fixture; Secure; Path=/', 'https://gemini.google.com')
  const row = [null, ['c_one', 'r_one'], null, null, [videoCandidate()]]
  const fetcher = vi.fn<typeof fetch>(async input => requestUrl(input).endsWith('/app') ? new Response(html)
    : requestUrl(input).includes('StreamGenerate') ? new Response(frame([['wrb.fr', null, JSON.stringify(row)]]))
      : new Response(frame([['wrb.fr', 'c8o8Fe', JSON.stringify(['https://lh3.google.com/image'])]])))
  await clientTest(fetcher, async (client) => {
    await client.bootstrap()
    await client.generate(geminiWebJob('id', 'image'), 'Boat', async () => {})
    expect(await client.originalImage({ ...task(), kind: 'image' }, { url, imageId: 'image' })).toBe('https://lh3.google.com/image')
    expect(fetcher).toHaveBeenCalledTimes(3)
  }, undefined, jar)
})

it('keeps polling the selected candidate after a previously chosen alternative', async () => {
  await clientTest(async input => requestUrl(input).endsWith('/app') ? new Response(html) : new Response(frame([['wrb.fr', 'hNvQHb', JSON.stringify([[
    turn('r_one', [videoCandidate('other'), videoCandidate('selected')]),
  ]])]])), async (client) => {
    await client.bootstrap(); expect(await client.retrieve({ ...task(), rcid: 'selected' } as ReturnType<typeof task>)).toEqual({ url })
  })
})

it.each([
  [206, { 'content-type': 'image/png', 'content-range': 'bytes 0-33554432/33554433' }, png, 'INCOMPLETE_RANGE'],
  [206, { 'content-type': 'image/png', 'content-range': 'bytes 0-12/13' }, png, 'INCOMPLETE_BODY'],
  [403, {}, null, 'HTTP_ERROR'],
  [200, { 'content-type': 'image/jpeg' }, Buffer.from([255, 0]), 'INVALID_MEDIA_SIGNATURE'],
  [200, { 'content-type': 'image/jpeg' }, Buffer.from([255, 216, 0]), 'INVALID_MEDIA_SIGNATURE'],
  [200, { 'content-type': 'image/webp' }, Buffer.from('RIFF1234NOPE'), 'INVALID_MEDIA_SIGNATURE'],
] as const)('checks completed range sizes and exact signatures %#', async (status, headers, body, code) => {
  await clientTest(async () => new Response(body, { status, headers }), client => expect(client.download(url, 'image')).rejects.toThrow(code))
})

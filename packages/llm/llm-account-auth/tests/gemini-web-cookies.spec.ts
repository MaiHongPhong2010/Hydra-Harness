/** Cookie export validation and domain, expiry and security preservation. */
import { expect, it } from 'vitest'
import { importGeminiWebCookies } from '../src/gemini-web-cookies.ts'

const session = { name: '__Secure-1PSID', value: 'fixture', domain: '.google.com', path: '/', secure: true, httpOnly: true }

it.each(['chrome', 'playwright'] as const)('preserves %s cookie metadata and excludes cookies from other hosts', async (format) => {
  const cookies = [session, { ...session, name: 'scoped', domain: 'gemini.google.com', path: '/app',
    hostOnly: true, sameSite: format === 'chrome' ? 'strict' : 'Strict',
    ...format === 'chrome' ? { expirationDate: 4_000_000_000 } : { expires: 4_000_000_000 },
  }]
  const jar = await importGeminiWebCookies(JSON.stringify(format === 'chrome' ? cookies : { cookies, origins: [] }))
  const saved = (await jar.getCookies('https://gemini.google.com/app')).find(cookie => cookie.key === 'scoped')!
  expect(saved).toMatchObject({ hostOnly: true, secure: true, httpOnly: true, sameSite: 'strict', path: '/app' })
  expect((saved.expires as Date).getTime()).toBe(4_000_000_000_000)
  expect(await jar.getCookieString('https://other.gemini.google.com/app')).toBe('__Secure-1PSID=fixture')
  expect(await jar.getCookieString('https://gemini.google.com/elsewhere')).toBe('__Secure-1PSID=fixture')
  expect(await jar.getCookieString('https://example.test/app')).toBe('')
})

it.each(['None', 'no_restriction', 'Lax', 'lax', 'unspecified', null] as const)('maps SameSite %s without changing cookie scope', async (sameSite) => {
  const jar = await importGeminiWebCookies(JSON.stringify([{ ...session, hostOnly: false, sameSite, expires: -1 }]))
  expect((await jar.getCookies('https://gemini.google.com'))[0]!.sameSite).toBe(
    sameSite === 'unspecified' || sameSite === null ? undefined : sameSite === 'None' || sameSite === 'no_restriction' ? 'none' : 'lax')
})

it('keeps session cookies without an expiry even when an exporter includes a timestamp', async () => {
  const jar = await importGeminiWebCookies(JSON.stringify([{ ...session, session: true, expirationDate: 0, partitionKey: null }]))
  expect((await jar.getCookies('https://gemini.google.com'))[0]!.expires).toBe('Infinity')
})

it.each([
  'not JSON', '{}', 'null', '[]', 'x'.repeat(65537), JSON.stringify([{ ...session, value: 'é'.repeat(33000) }]),
  ...[{ domain: 'google.com.evil.test' }, { domain: 'example.test' }, { name: 'bad;name' }, { value: 'bad\r\nvalue' },
    { path: '/;bad' }, { secure: false }, { httpOnly: 'true' }, { expires: 1 }, { expires: 1e300 }, { sameSite: 'unknown' },
  ].map(fields => JSON.stringify([{ ...session, ...fields }])),
])('rejects invalid exports without including secret input in diagnostics (%#)', async (input) => {
  await expect(importGeminiWebCookies(input)).rejects.toMatchObject({ code: 'INVALID_COOKIES' })
  await expect(importGeminiWebCookies(input)).rejects.not.toThrow('bad\r\nvalue')
})

it('refuses partitioned cookies rather than treating them as ordinary cookies', async () => {
  await expect(importGeminiWebCookies(JSON.stringify([{ ...session, partitionKey: { topLevelSite: 'https://google.com' } }])))
    .rejects.toMatchObject({ code: 'UNSUPPORTED_COOKIES' })
})

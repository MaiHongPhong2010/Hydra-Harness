/** Import browser cookie exports without exposing their values in diagnostics. */
import { Cookie, CookieJar } from 'tough-cookie'
import { z } from 'zod'
import { LlmError } from '@hydraharness/harness-llm'

const cookieSchema = z.object({
  name: z.string().regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/),
  value: z.string().regex(/^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/),
  domain: z.string().regex(/^\.?(?:[a-z0-9-]+\.)*google\.com$/i),
  path: z.string().regex(/^\/[^\r\n;]*$/),
  secure: z.boolean(),
  httpOnly: z.boolean(),
  hostOnly: z.boolean().optional(),
  session: z.boolean().optional(),
  expires: z.number().min(-1).optional(),
  expirationDate: z.number().nonnegative().optional(),
  sameSite: z.enum(['Strict', 'Lax', 'None', 'strict', 'lax', 'no_restriction', 'unspecified']).nullable().optional(),
  partitionKey: z.unknown().optional(),
})

/** Parse a Chrome/Edge cookie array or Playwright storage-state JSON.
 * @param text - Secret JSON, limited to 64 KiB; only Google cookies are accepted.
 * @returns A domain-scoped jar preserving expiry, HttpOnly, Secure, HostOnly and SameSite.
 * @throws When JSON, cookie metadata or the Gemini session cookie is invalid; partitioned cookies are unsupported.
 */
export async function importGeminiWebCookies(text: string): Promise<CookieJar> {
  const invalid = () => new LlmError('Import a Google cookie JSON array or Playwright storage state, up to 64 KiB.', 'INVALID_COOKIES')
  if (Buffer.byteLength(text, 'utf8') > 65536) throw invalid()
  let input: unknown
  try { input = JSON.parse(text) } catch { throw invalid() }
  const rows = z.union([z.array(cookieSchema), z.object({ cookies: z.array(cookieSchema) })]).safeParse(input)
  if (!rows.success) throw invalid()
  const cookies = Array.isArray(rows.data) ? rows.data : rows.data.cookies
  const jar = new CookieJar(undefined, { prefixSecurity: 'strict' })
  for (const row of cookies) {
    if (row.partitionKey !== undefined && row.partitionKey !== null) {
      throw new LlmError('Partitioned cookies are unsupported. Use Connect in the separate Hydra browser.', 'UNSUPPORTED_COOKIES')
    }
    const seconds = row.expirationDate ?? row.expires
    const expiry = row.session === true || seconds === undefined || seconds === -1 ? undefined : new Date(seconds * 1000)
    if (expiry !== undefined && !Number.isFinite(expiry.getTime())) throw invalid()
    const domain = row.domain.toLowerCase().replace(/^\./, '')
    const sameSite = row.sameSite === 'no_restriction' || row.sameSite === 'None' ? 'none'
      : row.sameSite === undefined || row.sameSite === null || row.sameSite === 'unspecified' ? undefined : row.sameSite.toLowerCase()
    const cookie = new Cookie({ key: row.name, value: row.value, domain, path: row.path,
      hostOnly: row.hostOnly ?? !row.domain.startsWith('.'), secure: row.secure, httpOnly: row.httpOnly,
      ...expiry === undefined ? {} : { expires: expiry }, ...sameSite === undefined ? {} : { sameSite },
    })
    try { await jar.setCookie(cookie, `https://${domain}${row.path}`) } catch { throw invalid() }
  }
  if (!(await jar.getCookies('https://gemini.google.com/app')).some(cookie => cookie.key === '__Secure-1PSID')) {
    throw new LlmError('The export needs an unexpired __Secure-1PSID cookie for Gemini. Export cookies from your signed-in browser.', 'INVALID_COOKIES')
  }
  return jar
}

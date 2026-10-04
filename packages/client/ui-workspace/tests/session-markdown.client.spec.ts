import { describe, expect, it, vi } from 'vitest'
import { sessionMarkdown } from '../src/client/session-markdown.ts'

describe('session Markdown copy', () => {
  it('reads older pages in order and omits injected context and replacements', async () => {
    const history = vi.fn()
      .mockResolvedValueOnce({ result: { ok: true, value: { hasMore: true, events: [
        { event: { seq: 4, type: 'assistant/message', surfaceOp: 'append', data: { message: { content: [{ type: 'text', text: 'Answer' }] } } } },
      ] } } })
      .mockResolvedValueOnce({ result: { ok: true, value: { hasMore: false, events: [
        { event: { seq: 1, type: 'user/message', surfaceOp: 'append', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Question' }] } } },
        { event: { seq: 2, type: 'user/message', surfaceOp: 'append', data: { source: { kind: 'plugin' }, content: [{ type: 'text', text: 'private context' }] } } },
        { event: { seq: 3, type: 'user/message', surfaceOp: { op: 'replace' }, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'model-only copy' }] } } },
      ] } } })
    expect(await sessionMarkdown({ sessions: { history } } as never, 'id' as never, 'Title'))
      .toBe('# Title\n\n## User\n\nQuestion\n\n## Assistant\n\nAnswer')
    expect(history).toHaveBeenNthCalledWith(2, { sessionId: 'id', beforeSeq: 4 })
  })

  it('rejects failed or non-advancing pages instead of copying an incomplete transcript', async () => {
    const history = vi.fn().mockResolvedValue({ result: { ok: false, error: { message: 'History unavailable' } } })
    await expect(sessionMarkdown({ sessions: { history } } as never, 'id' as never, 'Title')).rejects.toThrow('History unavailable')
    history.mockResolvedValue({ result: { ok: true, value: { hasMore: true, events: [] } } })
    await expect(sessionMarkdown({ sessions: { history } } as never, 'id' as never, 'Title')).rejects.toThrow('did not advance')
  })
})

it('omits image payloads and rejects repeated history cursors', async () => {
  const history = vi.fn().mockResolvedValue({ result: { ok: true, value: { hasMore: true, events: [
    { event: { seq: 4, type: 'user/message', surfaceOp: 'append', data: { source: { kind: 'user' }, content: [{ type: 'image', attachment: {} }] } } },
  ] } } })
  await expect(sessionMarkdown({ sessions: { history } } as never, 'id' as never, 'Title')).rejects.toThrow('did not advance')
  expect(history).toHaveBeenCalledTimes(2)
})

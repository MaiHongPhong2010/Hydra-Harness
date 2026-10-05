/** Bounded durable video admission shared by generation and saved-task recovery. */
import type { AttachmentStore, VideoAttachmentRef } from '@hydraharness/harness-attachment'
import { mediaJobId } from './media-job.ts'

/** Persist a completed video without retaining its stream in the transcript.
 * @param store - Durable attachment owner.
 * @param response - Completed MP4 or WebM response.
 * @param maxBytes - Deployment byte limit.
 * @param signal - Cancellation covering download and storage.
 * @returns A durable video reference after every byte has been stored.
 */
export async function admitGeneratedVideo(store: AttachmentStore, response: Response, maxBytes: number,
  signal: AbortSignal): Promise<VideoAttachmentRef> {
  try {
    const mediaType = response.headers.get('content-type')?.split(';')[0]?.trim()
    if (mediaType !== 'video/mp4' && mediaType !== 'video/webm') {
      await response.body?.cancel()
      throw new Error('Video provider did not return a completed MP4 or WebM video.')
    }
    if (response.body === null) throw new Error('Video provider returned no video bytes.')
    const stream = response.body
    async function* data(): AsyncIterable<Uint8Array> {
      let bytes = 0
      const reader = stream.getReader()
      try {
        while (true) {
          signal.throwIfAborted()
          const chunk = await reader.read()
          if (chunk.done) break
          bytes += chunk.value.byteLength
          if (bytes > maxBytes) throw new Error('Video response exceeds maxVideoBytes.')
          yield chunk.value
        }
        if (bytes === 0) throw new Error('Video provider returned an empty video.')
      } finally { try { await reader.cancel() } finally { reader.releaseLock() } }
    }
    const video = await store.saveFileStream({ data: data(), name: `generated-video.${mediaType === 'video/mp4' ? 'mp4' : 'webm'}`, signal })
    signal.throwIfAborted()
    return { ...video, mediaType }
  } catch (error) {
    const id = mediaJobId(response)
    if (id !== undefined) {
      throw new Error(`Video storage failed. jobId=${id}. Use gemini_web_retrieve to recover this job without sending the prompt again.`)
    }
    throw error
  }
}

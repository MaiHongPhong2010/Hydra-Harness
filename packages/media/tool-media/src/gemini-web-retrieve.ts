/** Retrieve a saved Gemini Web task through the selected account and durable attachment store. */
import type { Context } from '@hydraharness/cordis'
import { z } from 'zod'
import { defineTool } from '@hydraharness/harness-tools'
import { toolImageReferences, toolVideoReferences, toolMediaLabels } from '@hydraharness/harness-attachment'
import type { VideoAttachmentRef } from '@hydraharness/harness-attachment'
import { admitGeneratedImages, generatedImageSummary } from './generated-images.ts'
import { admitGeneratedVideo } from './generated-video.ts'
import type { VideoConfig } from './video.ts'
import type { GoogleImageConfig } from './image-google.ts'

/** Register read-only task recovery with the existing media presentation protocol.
 * @param ctx - Tools and attachment services, with optional LLM routes.
 * @param image - Image response and prompt-independent attachment limits.
 * @param video - Video polling, response, and attachment limits.
 */
export function registerGeminiWebRetrieve(ctx: Context, image: GoogleImageConfig, video: VideoConfig): void {
  const maxImageBytes = image.maxResponseBytes ?? 32 * 1024 * 1024
  const maxVideoBytes = video.maxVideoBytes ?? 100 * 1024 * 1024
  const timeoutMs = video.timeoutMs ?? 900_000
  ctx.tools.register(defineTool({
    name: 'gemini_web_retrieve',
    description: 'Retrieve an existing Gemini Web image or video using the jobId from an earlier error. Displays saved media in chat and never sends a new generation prompt. Reconnect Gemini Web first if the account session expired.',
    timeoutMs,
    parameters: {
      jobId: { type: 'string', required: true, description: 'Local jobId returned by the Gemini Web provider.' },
      kind: { type: 'string', required: true, enum: ['image', 'video'], description: 'Media kind of the original task.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        provider: { type: 'string', required: true }, model: { type: 'string', required: true },
        jobId: { type: 'string', required: true }, kind: { type: 'string', enum: ['image', 'video'], required: true },
        images: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
          attachmentId: { type: 'string', required: true }, name: { type: 'string' }, bytes: { type: 'integer', required: true },
          mediaType: { type: 'string', required: true, enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] },
          width: { type: 'integer', required: true }, height: { type: 'integer', required: true },
        } } },
        videos: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
          attachmentId: { type: 'string', required: true }, name: { type: 'string', required: true }, bytes: { type: 'integer', required: true },
          mediaType: { type: 'string', required: true, enum: ['video/mp4', 'video/webm'] },
        } } },
      } },
      render: (_args, value) => [{ type: 'text', text: `Retrieved Gemini Web ${value.kind}. jobId=${value.jobId}.`
        + (value.kind === 'image' ? `\n${generatedImageSummary(value.images)}` : '') }],
      presentationMeta: (_args, value) => value.kind === 'image'
        ? { kind: 'tool-images', images: value.images, provider: value.provider, model: value.model, jobId: value.jobId }
        : { kind: 'tool-videos', videos: value.videos, provider: value.provider, model: value.model, jobId: value.jobId },
    },
    presentCall: args => ({ card: 'media', kind: args.kind, title: 'Retrieve Gemini Web media', prompt: `Job ${args.jobId}` }),
    presentResult: (args, result) => result.isError ? undefined : ({ card: 'media', kind: args.kind, title: 'Retrieved Gemini Web media',
      content: args.kind === 'image' ? toolImageReferences(result.meta).map(attachment => ({ type: 'image' as const, attachment }))
        : toolVideoReferences(result.meta).map(attachment => ({ type: 'video' as const, attachment })), ...toolMediaLabels(result.meta) }),
    async execute(args, execution) {
      if (execution.parent !== undefined) throw new Error('gemini_web_retrieve requires Native tool mode for chat presentation.')
      if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(args.jobId)) throw new TypeError('Invalid Gemini Web jobId.')
      const signal = AbortSignal.any([execution.signal, AbortSignal.timeout(timeoutMs)])
      const generated = await ctx.get('llm')?.generateMedia({ provider: 'gemini-web', model: `gemini-web-${args.kind}`,
        endpoint: args.kind === 'image' ? 'images/generations' : 'videos', body: { jobId: args.jobId }, signal,
        maxResponseBytes: args.kind === 'image' ? maxImageBytes : video.maxResponseBytes ?? 1024 * 1024,
        pollIntervalMs: video.pollIntervalMs ?? 10_000,
      })
      if (generated === undefined) throw new Error('Apply Gemini Web in Account sign-in before retrieving media.')
      const response = generated.response
      if (args.kind === 'image') {
        const reader = response.body?.getReader()
        if (reader === undefined) throw new Error('Gemini Web returned no image bytes.')
        const chunks: Uint8Array[] = []; let bytes = 0
        try {
          while (true) {
            signal.throwIfAborted(); const chunk = await reader.read(); if (chunk.done) break
            bytes += chunk.value.byteLength; if (bytes > maxImageBytes) throw new Error('Gemini Web image exceeds the response limit.')
            chunks.push(chunk.value)
          }
        } finally { try { await reader.cancel() } finally { reader.releaseLock() } }
        const schema = z.object({ candidates: z.tuple([z.object({ finishReason: z.literal('STOP'), content: z.object({
          parts: z.tuple([z.object({ inlineData: z.object({ data: z.string().min(1), mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']) }) })]),
        }) })]) })
        const inline = schema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8'))).candidates[0].content.parts[0].inlineData
        const images = [...await admitGeneratedImages(ctx.attachments, [{ data: inline.data, mimeType: inline.mimeType }], args.jobId)]
        signal.throwIfAborted()
        return { provider: generated.provider, model: generated.model, kind: args.kind, jobId: args.jobId, images, videos: [] }
      }
      const videos: VideoAttachmentRef[] = [await admitGeneratedVideo(ctx.attachments, response, maxVideoBytes, signal)]
      return { provider: generated.provider, model: generated.model, kind: args.kind, jobId: args.jobId, images: [], videos }
    },
  }))
}

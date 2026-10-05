/** Configured video generation with bounded durable file storage. */
import type { Context } from '@hydraharness/cordis'
import z from '@hydraharness/schemastery'
import { toolVideoReferences, toolMediaLabels, toolImageReferences } from '@hydraharness/harness-attachment'
import type { VideoAttachmentRef, ImageAttachmentRef } from '@hydraharness/harness-attachment'
import { defineTool } from '@hydraharness/harness-tools'
import { admitGeneratedVideo } from './generated-video.ts'
import { mediaJobId } from './media-job.ts'

/** Video routing and storage limits; credentials belong to the selected provider. */
export interface VideoConfig {
  /** Restrict configured-model fallback to this provider route. */
  provider?: string
  /** Model hint after the saved video model selection. */
  model?: string
  /** Deadline covering submission, polling, download, and storage. */
  timeoutMs?: number
  /** Interval between status requests for an accepted video job. */
  pollIntervalMs?: number
  /** Maximum bytes in each provider job response. */
  maxResponseBytes?: number
  /** Maximum downloaded video bytes. */
  maxVideoBytes?: number
  /** Maximum prompt characters. */
  maxPromptChars?: number
}

/** Loader defaults for video polling and storage. */
export const VideoConfig: z<VideoConfig> = z.object({
  provider: z.string(),
  model: z.string(),
  timeoutMs: z.number().default(900_000),
  pollIntervalMs: z.number().default(10_000),
  maxResponseBytes: z.number().default(1024 * 1024),
  maxVideoBytes: z.number().default(100 * 1024 * 1024),
  maxPromptChars: z.number().default(32_000),
})

/** Register video_generate using the saved video provider and model.
 * @param ctx - Tool and attachment services, with optional configured LLM routes.
 * @param config - Loader-validated polling and storage limits.
 */
export function registerVideos(ctx: Context, config: VideoConfig): void {
  const resolved = config as Required<VideoConfig>
  for (const field of ['timeoutMs', 'pollIntervalMs', 'maxResponseBytes', 'maxVideoBytes', 'maxPromptChars'] as const) {
    if (!Number.isSafeInteger(resolved[field]) || resolved[field] < 1) throw new TypeError(`tool-media: video.${field} must be a positive safe integer`)
  }
  if (resolved.timeoutMs > 2_147_483_647 || resolved.pollIntervalMs > 2_147_483_647) throw new TypeError('tool-media: video timer limits must not exceed 2147483647')
  if (config.model?.trim() === '' || config.provider?.trim() === '') throw new TypeError('tool-media: video model and provider must not be empty')
  ctx.tools.register(defineTool({
    name: 'video_generate',
    description: 'Generate a video with the configured video model and display it in chat. Uses the connected provider\'s quota or API billing. Do not retry a timeout automatically.',
    timeoutMs: resolved.timeoutMs,
    parameters: {
      prompt: { type: 'string', required: true, description: 'Refine the user request into a video prompt using your current conversation context before calling this tool. Use precise terminology for shot framing, camera movement, subject motion, timing, lighting, and style where the request supports it. Preserve the subject, intent, exact quoted text and its language, counts, duration, aspect ratio, and all constraints or exclusions. Keep the prompt consistent with seconds and size when supplied. Do not invent requirements or add conflicting details. If the user requests an exact prompt or no rewriting, pass that prompt verbatim. Send the final generation prompt only, without commentary.' },
      seconds: { type: 'integer', minimum: 1, maximum: 15, description: 'Duration in seconds; omit unless the user requests it. Gemini Web uses its fixed default duration.' },
      size: { type: 'string', enum: ['1280x720', '720x1280'], description: 'Landscape or portrait video; omitted uses the provider default.' },
      reference_image_ids: { type: 'array', items: { type: 'string' },
        description: 'Image attachmentIds from earlier user uploads or image-generation results in this conversation. Required when animating an existing image. Use "latest" for the last image when an older result did not include its id. Currently supported by Gemini Web.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          provider: { type: 'string', required: true }, model: { type: 'string', required: true },
          jobId: { type: 'string' },
          videos: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
            attachmentId: { type: 'string', required: true }, name: { type: 'string', required: true },
            bytes: { type: 'integer', required: true, minimum: 1 }, mediaType: { type: 'string', required: true, enum: ['video/mp4', 'video/webm'] },
          } } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Generated video with ${value.provider} (${value.model}).` }],
      presentationMeta: (_args, value) => ({ kind: 'tool-videos', ...value }),
    },
    presentCall: args => ({ card: 'media', kind: 'video', title: 'Generate video', prompt: args.prompt,
      ...args.size === undefined ? {} : { aspectRatio: args.size === '1280x720' ? 16 / 9 : 9 / 16 },
    }),
    presentResult: (_args, result) => result.isError ? undefined : ({
      card: 'media', kind: 'video', title: 'Generated video',
      content: toolVideoReferences(result.meta).map(attachment => ({ type: 'video', attachment })), ...toolMediaLabels(result.meta),
    }),
    async execute(args, execution) {
      if (execution.parent !== undefined) throw new Error('video_generate requires Native tool mode for chat presentation.')
      if (args.prompt.trim() === '' || args.prompt.length > resolved.maxPromptChars) throw new TypeError(`Video prompt must contain 1–${resolved.maxPromptChars} characters.`)
      const signal = AbortSignal.any([execution.signal, AbortSignal.timeout(resolved.timeoutMs)])
      const referenceImages = []
      if (args.reference_image_ids !== undefined) {
        if (args.reference_image_ids.length < 1 || args.reference_image_ids.length > 5
          || new Set(args.reference_image_ids).size !== args.reference_image_ids.length) {
          throw new TypeError('Supply one to five distinct reference image ids.')
        }
        const session = execution.agent?.session
        if (session === undefined) throw new Error('Reference images require the calling conversation.')
        const refs: ImageAttachmentRef[] = []
        for (const event of session.activeEvents) {
          if (event.type === 'user/message') {
            for (const block of event.data.content) if (block.type === 'image') refs.push(block.attachment)
          } else if (event.type === 'tool/result') {
            refs.push(...toolImageReferences(event.data.meta))
            for (const content of event.data.message.content[0].content) {
              if (content.type === 'image') refs.push(content.attachment)
            }
          }
        }
        for (const id of args.reference_image_ids) {
          const ref = id === 'latest' ? refs.at(-1) : refs.find(ref => ref.attachmentId === id)
          if (ref === undefined) throw new Error('Reference image is absent from this conversation. Upload it or use an image attachmentId from an earlier result.')
          const stored = await ctx.attachments.readImage(ref, signal)
          referenceImages.push({ data: stored.data, mimeType: ref.mediaType })
        }
      }
      const generated = await ctx.get('llm')?.generateMedia({
        endpoint: 'videos', body: { prompt: args.prompt, ...args.seconds === undefined ? {} : { seconds: args.seconds },
          ...args.size === undefined ? {} : { size: args.size },
          ...args.reference_image_ids === undefined ? {} : { referenceImages } },
        ...config.provider === undefined ? {} : { provider: config.provider }, ...config.model === undefined ? {} : { model: config.model },
        signal, maxResponseBytes: resolved.maxResponseBytes, pollIntervalMs: resolved.pollIntervalMs,
      })
      if (generated === undefined) throw new Error('Configure a video model and its credentials on the Models page before generating videos.')
      const videos: VideoAttachmentRef[] = [await admitGeneratedVideo(ctx.attachments, generated.response, resolved.maxVideoBytes, signal)]
      const jobId = mediaJobId(generated.response)
      return { provider: generated.provider, model: generated.model, videos, ...jobId === undefined ? {} : { jobId } }
    },
  }))
}

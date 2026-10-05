/** OpenAI image generation with durable attachments and chat presentation.
 * @module @hydraharness/harness-tool-media
 */
import type { Context } from '@hydraharness/cordis'
import { admitGeneratedImages, generatedImageSummary } from './generated-images.ts'
import { mediaJobId } from './media-job.ts'
import z from '@hydraharness/schemastery'
import { z as zod } from 'zod'
import { toolImageReferences, toolMediaLabels } from '@hydraharness/harness-attachment'
import { credentialRef } from '@hydraharness/harness-credentials'
import { defineTool } from '@hydraharness/harness-tools'
import { isGenerationRejection } from '@hydraharness/harness-llm'


/** OpenAI routing and bounded request configuration; secrets remain in credentials. */
export interface OpenAIImageConfig {
  /** Use endpoint-compatible models saved on the Models page before the standalone route. */
  useProviderModels?: boolean
  /** Restrict configured-model fallback to this provider route. */
  provider?: string
  /** Additional models tried on the standalone route after an explicit HTTP rejection. */
  fallbackModels?: string[]
  /** OpenAI image model id. */
  model?: string
  /** Images API base URL; HTTP is allowed only on loopback. */
  baseURL?: string
  /** Environment-style credential reference. */
  apiKeyEnv?: string
  /** Cooperative request budget in milliseconds. */
  timeoutMs?: number
  /** Maximum encoded HTTP response bytes. */
  maxResponseBytes?: number
  /** Maximum prompt characters. */
  maxPromptChars?: number
  /** Maximum images per call, also bounded by attachment admission. */
  maxImages?: number
}

/** Loader defaults for the Images API. */
export const OpenAIImageConfig: z<OpenAIImageConfig> = z.object({
  useProviderModels: z.boolean().default(true),
  provider: z.string(),
  fallbackModels: z.array(z.string()),
  model: z.string().default('gpt-image-1.5'),
  baseURL: z.string().default('https://api.openai.com/v1'),
  apiKeyEnv: z.string().role('credential-ref').default('OPENAI_API_KEY'),
  timeoutMs: z.number().default(180_000),
  maxResponseBytes: z.number().default(32 * 1024 * 1024),
  maxPromptChars: z.number().default(32_000),
  maxImages: z.number().default(4),
})

const geminiResponse = zod.object({ candidates: zod.array(zod.object({
  finishReason: zod.literal('STOP'),
  content: zod.object({ parts: zod.array(zod.object({
    thought: zod.boolean().optional(),
    inlineData: zod.object({ mimeType: zod.enum(['image/png', 'image/jpeg', 'image/webp']), data: zod.string().min(1) }).optional(),
  })) }),
})).length(1) })
/* jscpd:ignore-start -- Both media consumers admit the same proxy reply formats before attachment storage. */
const chatResponse = zod.object({ choices: zod.array(zod.object({
  finish_reason: zod.literal('stop'),
  message: zod.object({ images: zod.array(zod.object({
    image_url: zod.object({ url: zod.string().regex(/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/) }),
  })).min(1) }),
})).length(1) }).transform(value => ({ candidates: value.choices.map(choice => ({
  finishReason: 'STOP' as const,
  content: { parts: choice.message.images.map((image) => {
    const url = image.image_url.url
    const comma = url.indexOf(',')
    return { inlineData: { mimeType: zod.enum(['image/png', 'image/jpeg', 'image/webp']).parse(url.slice(5, comma - 7)), data: url.slice(comma + 1) } }
  }) },
})) }))
const responseSchema = zod.union([
  zod.object({ data: zod.array(zod.object({ b64_json: zod.string().min(1) })) }),
  geminiResponse,
  zod.object({ response: geminiResponse }).transform(value => value.response),
  chatResponse,
])
/* jscpd:ignore-end */
const imageSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    attachmentId: { type: 'string', required: true },
    mediaType: { type: 'string', required: true, enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] },
    bytes: { type: 'integer', required: true, minimum: 1 }, width: { type: 'integer', required: true, minimum: 1 }, height: { type: 'integer', required: true, minimum: 1 },
    name: { type: 'string' },
  },
} as const

/**
 * Register image_generate over configured Images API routes. Explicit rejections
 * permit fallback; timeouts and ambiguous failures stop to avoid duplicate billing.
 * @param ctx - Tool, credential, and attachment services.
 * @param config - Loader-validated deployment configuration.
 */
export function registerOpenAIImages(ctx: Context, config: OpenAIImageConfig): void {
  const resolved = config as Required<OpenAIImageConfig>
  for (const field of ['timeoutMs', 'maxResponseBytes', 'maxPromptChars', 'maxImages'] as const) {
    if (!Number.isSafeInteger(resolved[field]) || resolved[field] < 1) throw new TypeError(`tool-media: openai. ${field} must be a positive safe integer`)
  }
  if (resolved.maxImages > 10) throw new TypeError('tool-media: openai. maxImages must not exceed 10')
  if (resolved.model.trim() === '') throw new TypeError('tool-media: openai. model must not be empty')
  if (resolved.fallbackModels.some(model => model.trim() === '')) throw new TypeError('tool-media: openai. fallbackModels must not contain empty ids')
  const endpoint = new URL(`${resolved.baseURL.replace(/\/$/, '')}/images/generations`)
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)))) {
    throw new TypeError('tool-media: openai. baseURL must use HTTPS or loopback HTTP without credentials, query, or fragment')
  }
  const ref = credentialRef(resolved.apiKeyEnv)
  const maxImages = Math.min(resolved.maxImages, ctx.attachments.imageLimits.maxImagesPerMessage)
  ctx.tools.register(defineTool({
    name: 'image_generate',
    description: 'Generate images with the configured image model and display them in chat. Uses the connected provider\'s quota or API billing. Do not retry a timeout automatically.',
    timeoutMs: resolved.timeoutMs,
    parameters: {
      prompt: { type: 'string', required: true, description: 'Refine the user request into an image prompt using your current conversation context before calling this tool. Use precise terminology for composition, framing, lighting, materials, and style where the request supports it. Preserve the subject, intent, exact quoted text and its language, counts, and all constraints or exclusions. Do not invent requirements or add conflicting details. If the user requests an exact prompt or no rewriting, pass that prompt verbatim. Send the final generation prompt only, without commentary.' },
      count: { type: 'integer', minimum: 1, maximum: maxImages, description: 'Number of images; defaults to 1.' },
      size: { type: 'string', enum: ['auto', '1024x1024', '1536x1024', '1024x1536'] },
      quality: { type: 'string', enum: ['auto', 'low', 'medium', 'high'] },
      format: { type: 'string', enum: ['png', 'jpeg', 'webp'] },
      background: { type: 'string', enum: ['auto', 'opaque', 'transparent'] },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { model: { type: 'string', required: true }, provider: { type: 'string' }, jobId: { type: 'string' }, images: { type: 'array', required: true, items: imageSchema } },
      },
      render: (_args, value) => [{ type: 'text', text:
        `Generated ${value.images.length} image(s) with ${value.provider ?? 'OpenAI'} (${value.model}).\n${generatedImageSummary(value.images)}` }],
      presentationMeta: (_args, value) => ({ kind: 'tool-images', ...value }),
    },
    presentCall: args => ({
      card: 'media', kind: 'image', title: 'Generate image', prompt: args.prompt,
      ...args.size === undefined || args.size === 'auto' ? {} : {
        aspectRatio: { '1024x1024': 1, '1536x1024': 1.5, '1024x1536': 2 / 3 }[args.size],
      },
    }),
    presentResult: (_args, result) => result.isError ? undefined : ({
      card: 'media', kind: 'image', title: 'Generated image',
      content: toolImageReferences(result.meta).map(attachment => ({ type: 'image', attachment })),
      ...toolMediaLabels(result.meta),
    }),
    async execute(args, execution) {
      if (execution.parent !== undefined) throw new Error('image_generate requires Native tool mode for chat presentation.')
      if (args.prompt.trim() === '' || args.prompt.length > resolved.maxPromptChars) {
        throw new TypeError(`Image prompt must contain 1–${resolved.maxPromptChars} characters.`)
      }
      const request = {
        model: resolved.model, prompt: args.prompt, n: args.count ?? 1,
        size: args.size ?? 'auto', quality: args.quality ?? 'auto',
        output_format: args.format ?? 'png', background: args.background ?? 'auto',
      }
      if (request.output_format === 'jpeg' && request.background === 'transparent') throw new TypeError('Transparent backgrounds require PNG or WebP.')
      const signal = AbortSignal.any([execution.signal, AbortSignal.timeout(resolved.timeoutMs)])
      const generated = resolved.useProviderModels ? await ctx.get('llm')?.generateMedia({
        endpoint: 'images/generations', body: request, model: resolved.model, signal, maxResponseBytes: resolved.maxResponseBytes,
        ...config.provider === undefined ? {} : { provider: config.provider },
      }) : undefined
      if (config.provider !== undefined && generated === undefined) throw new Error(`Provider ${config.provider} has no configured image generation models.`)
      let response: Response
      if (generated !== undefined) {
        response = generated.response
        request.model = generated.model
      } else {
        const credential = await ctx.credentials.resolve(ref)
        if (credential === undefined) throw new Error(`Configure ${resolved.apiKeyEnv} or an image model with credentials on the Models page before generating images.`)
        const post = (model: string): Promise<Response> => {
          signal.throwIfAborted()
          request.model = model
          return fetch(endpoint, {
            method: 'POST', redirect: 'error', signal,
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${credential.value}` },
            body: JSON.stringify(request),
          })
        }
        response = await post(resolved.model)
        for (const model of new Set(resolved.fallbackModels)) {
          if (model === resolved.model) continue
          if (!isGenerationRejection(response.status)) break
          await response.body?.cancel()
          response = await post(model)
        }
      }
      if (!response.ok) {
        await response.body?.cancel()
        throw new Error(`OpenAI image request failed (HTTP ${response.status}). Check credentials, model access, and account limits before retrying.`)
      }
      let bytes = 0
      const body = response.body?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          bytes += chunk.byteLength
          if (bytes > resolved.maxResponseBytes) throw new Error('OpenAI image response exceeds maxResponseBytes.')
          controller.enqueue(chunk)
        },
      }))
      const value = responseSchema.parse(await new Response(body).json())
      signal.throwIfAborted()
      const output = 'data' in value ? value.data.map(image => ({ data: image.b64_json, mimeType: `image/${request.output_format}` as const }))
        : value.candidates.flatMap(candidate => candidate.content.parts.flatMap(part =>
          ('thought' in part && part.thought) || part.inlineData === undefined ? [] : [part.inlineData]))
      if (output.length !== request.n) throw new Error('Image provider returned an unexpected image count.')
      const images = await admitGeneratedImages(ctx.attachments, output, response.headers.get('x-hydra-job-id'))
      signal.throwIfAborted()
      const jobId = mediaJobId(response)
      return { model: request.model, images: [...images], ...generated === undefined ? {} : { provider: generated.provider },
        ...jobId === undefined ? {} : { jobId } }
    },
  }))
}

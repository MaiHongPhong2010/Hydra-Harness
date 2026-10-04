/** Google Gemini image generation with durable chat attachments.
 * @module @hydraharness/harness-tool-media
 */
import type { Context } from '@hydraharness/cordis'
import { admitGeneratedImages } from './generated-images.ts'
import z from '@hydraharness/schemastery'
import { z as zod } from 'zod'
import { toolImageReferences, toolMediaLabels } from '@hydraharness/harness-attachment'
import { credentialRef } from '@hydraharness/harness-credentials'
import { defineTool } from '@hydraharness/harness-tools'


/* jscpd:ignore-start */
// Each provider owns its patchable configuration and defaults independently.
/** Gemini routing and response limits; credentials hold the secret value. */
export interface GoogleImageConfig {
  /** Use saved image models before the standalone Gemini route. */
  useProviderModels?: boolean
  /** Restrict configured-model fallback to this provider route. */
  provider?: string
  /** Bare Gemini image model id. */
  model?: string
  /** Gemini REST base URL; HTTP is allowed only on loopback. */
  baseURL?: string
  /** Environment-style credential reference. */
  apiKeyEnv?: string
  /** Cooperative request budget in milliseconds. */
  timeoutMs?: number
  /** Maximum encoded HTTP response bytes, including thought parts. */
  maxResponseBytes?: number
  /** Maximum prompt characters. */
  maxPromptChars?: number
  /** Maximum final images admitted from one response. */
  maxImages?: number
}

/** Loader defaults for Gemini image generation. */
export const GoogleImageConfig: z<GoogleImageConfig> = z.object({
  useProviderModels: z.boolean().default(true),
  provider: z.string(),
  model: z.string().default('gemini-3.1-flash-image'),
  baseURL: z.string().default('https://generativelanguage.googleapis.com/v1'),
  apiKeyEnv: z.string().role('credential-ref').default('GEMINI_API_KEY'),
  timeoutMs: z.number().default(180_000),
  maxResponseBytes: z.number().default(32 * 1024 * 1024),
  maxPromptChars: z.number().default(32_000),
  maxImages: z.number().default(4),
})
/* jscpd:ignore-end */

const geminiResponse = zod.object({
  candidates: zod.array(zod.object({
    finishReason: zod.string(),
    content: zod.object({ parts: zod.array(zod.object({
      thought: zod.boolean().optional(),
      inlineData: zod.object({ mimeType: zod.enum(['image/png', 'image/jpeg', 'image/webp']), data: zod.string().min(1) }).optional(),
    })) }).optional(),
  })).max(1).optional(),
})
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
  zod.object({ response: geminiResponse }).transform(value => value.response),
  chatResponse,
  geminiResponse,
])
/* jscpd:ignore-end */

/**
 * Register image_generate_google with final images in presentation metadata.
 * Each call makes one stateless generateContent request without automatic retries.
 * @param ctx - Tool, credential, and attachment services.
 * @param config - Loader-validated deployment configuration.
 */
export function registerGoogleImages(ctx: Context, config: GoogleImageConfig): void {
  const resolved = config as Required<GoogleImageConfig>
  for (const field of ['timeoutMs', 'maxResponseBytes', 'maxPromptChars', 'maxImages'] as const) {
    if (!Number.isSafeInteger(resolved[field]) || resolved[field] < 1) throw new TypeError(`tool-media: google. ${field} must be a positive safe integer`)
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(resolved.model)) throw new TypeError('tool-media: google. model must be a bare Gemini model id')
  const endpoint = new URL(`${resolved.baseURL.replace(/\/$/, '')}/models/${resolved.model}:generateContent`)
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)))) {
    throw new TypeError('tool-media: google. baseURL must use HTTPS or loopback HTTP without credentials, query, or fragment')
  }
  const ref = credentialRef(resolved.apiKeyEnv)
  const maxImages = Math.min(resolved.maxImages, ctx.attachments.imageLimits.maxImagesPerMessage)
  ctx.tools.register(defineTool({
    name: 'image_generate_google',
    description: 'Generate images with Google Gemini and display them in chat. Uses the connected provider\'s quota or API billing. Do not retry a timeout automatically.',
    timeoutMs: resolved.timeoutMs,
    parameters: { prompt: { type: 'string', required: true, description: 'Refine the user request into an image prompt using your current conversation context before calling this tool. Use precise terminology for composition, framing, lighting, materials, and style where the request supports it. Preserve the subject, intent, exact quoted text and its language, counts, and all constraints or exclusions. Do not invent requirements or add conflicting details. If the user requests an exact prompt or no rewriting, pass that prompt verbatim. Send the final generation prompt only, without commentary.' } },
    /* jscpd:ignore-start */
    // Tool schemas stay in their consumers; attachment refs use the shared presentation protocol.
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          model: { type: 'string', required: true },
          provider: { type: 'string' },
          images: { type: 'array', required: true, items: {
            type: 'object', additionalProperties: false,
            properties: {
              attachmentId: { type: 'string', required: true },
              mediaType: { type: 'string', required: true, enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] },
              bytes: { type: 'integer', required: true, minimum: 1 },
              width: { type: 'integer', required: true, minimum: 1 },
              height: { type: 'integer', required: true, minimum: 1 },
              name: { type: 'string' },
            },
          } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Generated ${value.images.length} image(s) with ${value.provider ?? 'Google'} (${value.model}).` }],
      presentationMeta: (_args, value) => ({ kind: 'tool-images', images: value.images, model: value.model, ...value.provider === undefined ? {} : { provider: value.provider } }),
    },
    presentCall: args => ({ card: 'media', kind: 'image', title: 'Generate image with Google', prompt: args.prompt }),
    presentResult: (_args, result) => result.isError ? undefined : ({
      card: 'media', kind: 'image', title: 'Generated image',
      content: toolImageReferences(result.meta).map(attachment => ({ type: 'image', attachment })),
      ...toolMediaLabels(result.meta),
    }),
    /* jscpd:ignore-end */
    async execute(args, execution) {
      if (execution.parent !== undefined) throw new Error('image_generate_google requires Native tool mode for chat presentation.')
      if (args.prompt.trim() === '' || args.prompt.length > resolved.maxPromptChars) {
        throw new TypeError(`Image prompt must contain 1–${resolved.maxPromptChars} characters.`)
      }
      const request = {
        contents: [{ role: 'user', parts: [{ text: args.prompt }] }],
        generationConfig: { responseModalities: ['IMAGE'] },
      }
      const signal = AbortSignal.any([execution.signal, AbortSignal.timeout(resolved.timeoutMs)])
      const generated = resolved.useProviderModels ? await ctx.get('llm')?.generateMedia({
        endpoint: 'images/generations', body: { prompt: args.prompt, n: 1, output_format: 'png' }, model: resolved.model, signal, maxResponseBytes: resolved.maxResponseBytes,
        ...config.provider === undefined ? {} : { provider: config.provider },
      }) : undefined
      if (config.provider !== undefined && generated === undefined) throw new Error(`Provider ${config.provider} has no configured image generation models.`)
      let response: Response
      if (generated !== undefined) response = generated.response
      else {
        const credential = await ctx.credentials.resolve(ref)
        if (credential === undefined) throw new Error(`Configure ${resolved.apiKeyEnv} or an image model on the Models page before generating images.`)
        response = await fetch(endpoint, {
          method: 'POST', redirect: 'error', signal,
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': credential.value },
          body: JSON.stringify(request),
        })
      }
      if (!response.ok) {
        await response.body?.cancel()
        throw new Error(`Google image request failed (HTTP ${response.status}). Check credentials, model access, and account limits before retrying.`)
      }
      let bytes = 0
      const body = response.body?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          bytes += chunk.byteLength
          if (bytes > resolved.maxResponseBytes) throw new Error('Google image response exceeds maxResponseBytes.')
          controller.enqueue(chunk)
        },
      }))
      const value = responseSchema.parse(await new Response(body).json())
      signal.throwIfAborted()
      const output = (() => {
        if ('data' in value) return value.data.map(image => ({ data: image.b64_json, mimeType: 'image/png' as const }))
        const candidate = value.candidates?.[0]
        if (candidate?.finishReason !== 'STOP' || candidate.content === undefined) {
          throw new Error('Google did not return a complete image response. Check the prompt and model access before retrying.')
        }
        return candidate.content.parts.flatMap(part => ('thought' in part && part.thought) || part.inlineData === undefined ? [] : [part.inlineData])
      })()
      if (output.length === 0 || output.length > maxImages) throw new Error(`Google must return 1–${maxImages} final images.`)
      const images = await admitGeneratedImages(ctx.attachments, output)
      signal.throwIfAborted()
      return {
        model: generated?.model ?? resolved.model, images: [...images],
        ...generated === undefined ? {} : { provider: generated.provider },
      }
    },
  }))
}

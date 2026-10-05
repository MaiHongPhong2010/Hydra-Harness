/** Image and video generation tools under one disposable Cordis plugin.
 * @module @hydraharness/harness-tool-media
 */
import type { Context } from '@hydraharness/cordis'
import z from '@hydraharness/schemastery'
import { OpenAIImageConfig, registerOpenAIImages } from './image-openai.ts'
import { GoogleImageConfig, registerGoogleImages } from './image-google.ts'
import { VideoConfig, registerVideos } from './video.ts'
import { registerGeminiWebRetrieve } from './gemini-web-retrieve.ts'

/** Cordis plugin name. */
export const name = 'tool-media'
/** Services consumed by image and video generation. */
export const inject = ['tools', 'credentials', 'attachments']

/** Provider settings for the tools controlled by the shared plugin switch. */
export interface Config {
  /** OpenAI-compatible image routing and admission. */
  openai?: OpenAIImageConfig
  /** Native Gemini image routing and admission. */
  google?: GoogleImageConfig
  /** Configured video routing, polling, and storage limits. */
  video?: VideoConfig
}

/** Loader defaults for all media tools. */
export const Config: z<Config> = z.object({
  openai: OpenAIImageConfig.default({}),
  google: GoogleImageConfig.default({}),
  video: VideoConfig.default({}),
})

/** Register all media tools in the same fiber so one switch disposes them together.
 * @param ctx - Tool, credential, and attachment services.
 * @param config - Loader-validated settings for each generation API.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as Required<Config>
  registerOpenAIImages(ctx, resolved.openai)
  registerGoogleImages(ctx, resolved.google)
  registerVideos(ctx, resolved.video)
  registerGeminiWebRetrieve(ctx, resolved.google, resolved.video)
}

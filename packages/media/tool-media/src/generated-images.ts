/** Durable attachment admission for decoded provider image results. */
import { admitEncodedImages, type AttachmentStore, type ImageMediaType } from '@hydraharness/harness-attachment'

/** Describe stored images without loading image bytes into model history.
 * @param images - Durable image references available to later media calls.
 * @returns Attachment ids and image properties in a bounded JSON summary.
 */
export function generatedImageSummary(images: readonly {
  attachmentId: string
  mediaType: string
  width: number
  height: number
}[]): string {
  return `Image attachments: ${JSON.stringify(images.map(({ attachmentId, mediaType, width, height }) =>
    ({ attachmentId, mediaType, width, height })))}`
}

/** Store each generated image using its position and media type as the filename.
 * @param store - session attachment owner.
 * @param images - encoded final provider images.
 * @param jobId - Optional provider job id for recovery after attachment admission fails.
 * @returns admitted references in provider order.
 */
export function admitGeneratedImages(
  store: AttachmentStore, images: readonly { data: string; mimeType: ImageMediaType }[], jobId?: string | null,
): ReturnType<typeof admitEncodedImages> {
  return admitEncodedImages(store, images.map((image, index) => ({
    data: image.data, mediaType: image.mimeType,
    name: `generated-${index + 1}.${image.mimeType.slice('image/'.length)}`,
  }))).catch((error: unknown) => {
    if (jobId !== undefined && jobId !== null && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(jobId)) {
      throw new Error(`Image storage failed. jobId=${jobId}. Use gemini_web_retrieve without sending the prompt again.`)
    }
    throw error
  })
}

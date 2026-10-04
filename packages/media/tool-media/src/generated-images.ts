/** Durable attachment admission for decoded provider image results. */
import { admitEncodedImages, type AttachmentStore, type ImageMediaType } from '@hydraharness/harness-attachment'

/** Store each generated image using its position and media type as the filename.
 * @param store - session attachment owner.
 * @param images - encoded final provider images.
 * @returns admitted references in provider order.
 */
export function admitGeneratedImages(
  store: AttachmentStore, images: readonly { data: string; mimeType: ImageMediaType }[],
): ReturnType<typeof admitEncodedImages> {
  return admitEncodedImages(store, images.map((image, index) => ({
    data: image.data, mediaType: image.mimeType,
    name: `generated-${index + 1}.${image.mimeType.slice('image/'.length)}`,
  })))
}

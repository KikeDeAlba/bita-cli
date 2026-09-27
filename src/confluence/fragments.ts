import type { AttachmentInfo } from './client.ts'

export interface PixelSize {
  width: number
  height: number
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const RENDER_SCALE = 2
const MAX_DISPLAY_WIDTH = 1200

export function pngSize(bytes: Uint8Array): PixelSize | null {
  if (bytes.length < 24) return null
  if (!PNG_SIGNATURE.every((value, at) => bytes[at] === value)) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

export function displaySize(pixels: PixelSize | null): PixelSize | null {
  if (pixels === null) return null
  const width = Math.round(pixels.width / RENDER_SCALE)
  const height = Math.round(pixels.height / RENDER_SCALE)
  if (width <= MAX_DISPLAY_WIDTH) return { width, height }
  return { width: MAX_DISPLAY_WIDTH, height: Math.round((height * MAX_DISPLAY_WIDTH) / width) }
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

export function storageImage(filename: string, size: PixelSize | null): string {
  const width = size ? ` ac:width="${size.width}"` : ''
  return `<ac:image ac:align="center"${width}><ri:attachment ri:filename="${escapeAttribute(filename)}" /></ac:image>`
}

export function adfImage(confluencePageId: string, attachment: AttachmentInfo, size: PixelSize | null): Record<string, unknown> | null {
  if (attachment.fileId === null) return null
  return {
    type: 'mediaSingle',
    attrs: { layout: 'center', ...(size ? { width: size.width, widthType: 'pixel' } : {}) },
    content: [
      {
        type: 'media',
        attrs: {
          type: 'file',
          id: attachment.fileId,
          collection: `contentId-${confluencePageId}`,
          ...(size ? { width: size.width, height: size.height } : {}),
        },
      },
    ],
  }
}

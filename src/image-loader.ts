import type { Diagnostic, ImageAsset } from './model'

export interface LoadedImage {
  id: string
  width: number
  height: number
  pixels: Uint8Array
  objectUrl: string
}

const imageCache = new Map<string, Promise<LoadedImage>>()

function downloadableUrl(url: string): string {
  if (typeof window === 'undefined') return url
  const local = window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost' || window.location.hostname === '::1'
  return local ? `/__online_image?url=${encodeURIComponent(url)}` : url
}

async function decodeImage(asset: ImageAsset): Promise<LoadedImage> {
  const response = await fetch(downloadableUrl(asset.url!))
  if (!response.ok) throw new Error(`Online image returned HTTP ${response.status}: ${asset.url}`)
  const blob = await response.blob()
  const bitmap = await createImageBitmap(blob)
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Browser image decoding is unavailable.')
    context.drawImage(bitmap, 0, 0)
    const rgba = context.getImageData(0, 0, bitmap.width, bitmap.height).data
    const pixels = new Uint8Array(rgba.length)
    for (let index = 0; index < rgba.length; index += 4) {
      pixels[index] = rgba[index + 2]
      pixels[index + 1] = rgba[index + 1]
      pixels[index + 2] = rgba[index]
      pixels[index + 3] = rgba[index + 3]
    }
    return { id: asset.id, width: bitmap.width, height: bitmap.height, pixels, objectUrl: URL.createObjectURL(blob) }
  } finally {
    bitmap.close()
  }
}

async function loadImage(asset: ImageAsset): Promise<LoadedImage> {
  const key = `${asset.id}:${asset.url}`
  let request = imageCache.get(key)
  if (!request) {
    request = decodeImage(asset)
    imageCache.set(key, request)
  }
  try { return await request }
  catch (error) { imageCache.delete(key); throw error }
}

export async function loadOnlineImages(assets: ImageAsset[]): Promise<{ images: LoadedImage[], diagnostics: Diagnostic[] }> {
  const onlineAssets = assets.filter((asset) => asset.platform === 'online_image' && asset.url)
  const settled = await Promise.allSettled(onlineAssets.map(loadImage))
  const images: LoadedImage[] = []
  const diagnostics: Diagnostic[] = []
  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') images.push(result.value)
    else diagnostics.push({
      severity: 'warning',
      message: result.reason instanceof Error ? result.reason.message : `Online image could not be downloaded: ${onlineAssets[index].url}`,
      source: onlineAssets[index].id,
    })
  })
  return { images, diagnostics }
}
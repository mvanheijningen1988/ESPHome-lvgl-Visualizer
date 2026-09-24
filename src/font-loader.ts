import type { Diagnostic, FontDefinition, FontSource } from './model'

export interface LoadedFont {
  definition: FontDefinition
  sources: ArrayBuffer[]
}

const googleFontCache = new Map<string, Promise<ArrayBuffer>>()
const uploadedFontCache = new WeakMap<File, Promise<ArrayBuffer>>()

function weightName(weight: number): string {
  const names: Record<number, string> = { 100: 'Thin', 200: 'ExtraLight', 300: 'Light', 400: 'Regular', 500: 'Medium', 600: 'SemiBold', 700: 'Bold', 800: 'ExtraBold', 900: 'Black' }
  return names[weight] ?? String(weight)
}

function fontFileScore(name: string, family: string, weight: number): number {
  const normalized = name.toLowerCase()
  if (!normalized.endsWith('.ttf')) return -1
  const compactFamily = family.replace(/[^a-z0-9]/gi, '').toLowerCase()
  if (!normalized.replace(/[^a-z0-9]/g, '').includes(compactFamily)) return -1
  const styleScore = normalized.includes('italic') ? -20 : 0
  const requestedWeight = weightName(weight).toLowerCase()
  if (normalized.includes(`-${requestedWeight}.ttf`)) return 100 + styleScore
  if (weight === 400 && normalized.includes('-regular.ttf')) return 100 + styleScore
  if (normalized.includes('[wght]')) return 50 + styleScore
  if (normalized.includes('[wdth,wght]')) return 45 + styleScore
  return 10 + styleScore
}

async function googleFontBytes(family: string, weight: number): Promise<ArrayBuffer> {
  const cacheKey = `${family}:${weight}`
  let request = googleFontCache.get(cacheKey)
  if (!request) {
    request = (async () => {
      const directory = family.toLowerCase().replace(/[^a-z0-9]/g, '')
      const apiBase = `https://api.github.com/repos/google/fonts/contents`
      for (const license of ['ofl', 'apache', 'ufl']) {
        for (const suffix of ['/static', '']) {
          const response = await fetch(`${apiBase}/${license}/${directory}${suffix}`)
          if (response.status === 404) continue
          if (!response.ok) throw new Error(`Google Fonts catalog returned HTTP ${response.status}.`)
          const entries = await response.json() as Array<{ name?: string, download_url?: string }>
          const match = entries
            .filter((entry) => entry.name && entry.download_url)
            .map((entry) => ({ entry, score: fontFileScore(entry.name!, family, weight) }))
            .filter((candidate) => candidate.score >= 0)
            .sort((left, right) => right.score - left.score)[0]?.entry
          if (!match?.download_url) continue
          const fontResponse = await fetch(match.download_url)
          if (!fontResponse.ok) throw new Error(`Google Font download returned HTTP ${fontResponse.status}.`)
          return fontResponse.arrayBuffer()
        }
      }
      throw new Error(`No TrueType file was found for Google Font “${family}”.`)
    })()
    googleFontCache.set(cacheKey, request)
  }
  try { return await request }
  catch (error) { googleFontCache.delete(cacheKey); throw error }
}

function uploadedFont(source: FontSource, assets: Map<string, File>): Promise<ArrayBuffer> {
  const path = source.path ?? ''
  const basename = path.split('/').pop() ?? path
  const file = assets.get(path) ?? assets.get(basename)
  if (!file) throw new Error(`Local font must be uploaded through Assets: ${path}`)
  let bytes = uploadedFontCache.get(file)
  if (!bytes) {
    bytes = file.arrayBuffer()
    uploadedFontCache.set(file, bytes)
  }
  return bytes
}

async function sourceBytes(source: FontSource, assets: Map<string, File>): Promise<ArrayBuffer> {
  if (source.type === 'gfonts' && source.family) return googleFontBytes(source.family, source.weight)
  return uploadedFont(source, assets)
}

export async function loadRequestedFonts(fonts: FontDefinition[], assets: Map<string, File>): Promise<{ fonts: LoadedFont[], diagnostics: Diagnostic[] }> {
  const loaded: LoadedFont[] = []
  const diagnostics: Diagnostic[] = []
  for (const definition of fonts) {
    try {
      loaded.push({ definition, sources: await Promise.all([definition.source, ...definition.extras].map((source) => sourceBytes(source, assets))) })
    } catch (error) {
      diagnostics.push({ severity: 'warning', message: error instanceof Error ? error.message : `Font ${definition.id} could not be loaded.`, source: definition.id })
    }
  }
  return { fonts: loaded, diagnostics }
}
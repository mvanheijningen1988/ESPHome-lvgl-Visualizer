import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FontDefinition } from './model'
import { loadRequestedFonts } from './font-loader'

const localFont: FontDefinition = {
  id: 'icons',
  size: 24,
  source: { type: 'local', path: 'fonts/icons.ttf', weight: 400 },
  extras: [],
}

afterEach(() => vi.restoreAllMocks())

describe('loadRequestedFonts', () => {
  it('does not access the network when YAML declares no fonts', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const result = await loadRequestedFonts([], new Map())

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(result.fonts).toEqual([])
  })

  it('requires local font paths to be uploaded through Assets', async () => {
    const result = await loadRequestedFonts([localFont], new Map())

    expect(result.fonts).toEqual([])
    expect(result.diagnostics[0]?.message).toContain('uploaded through Assets: fonts/icons.ttf')
  })

  it('reads a matching uploaded local font without a network request', async () => {
    const bytes = new Uint8Array([0, 1, 0, 0]).buffer
    const file = { arrayBuffer: vi.fn().mockResolvedValue(bytes) } as unknown as File
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const result = await loadRequestedFonts([localFont], new Map([['icons.ttf', file]]))

    expect(result.fonts[0]?.sources).toEqual([bytes])
    expect(file.arrayBuffer).toHaveBeenCalledOnce()
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
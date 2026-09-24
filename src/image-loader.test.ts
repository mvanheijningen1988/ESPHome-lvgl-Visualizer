import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadOnlineImages } from './image-loader'

afterEach(() => vi.restoreAllMocks())

describe('loadOnlineImages', () => {
  it('does not fetch local or absent image declarations', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const result = await loadOnlineImages([{ id: 'local', platform: 'file', file: 'image.png' }])

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(result.images).toEqual([])
  })

  it('reports failed online image downloads', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 404 }))
    const result = await loadOnlineImages([{ id: 'weather', platform: 'online_image', url: 'https://example.com/missing.png' }])

    expect(result.images).toEqual([])
    expect(result.diagnostics[0]?.message).toContain('HTTP 404')
  })
})
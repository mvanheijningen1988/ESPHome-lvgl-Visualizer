import { describe, expect, it } from 'vitest'
import { clickPreview, createSelectionState, enterPreview, hoverPreview, leavePreview, selectFromEditor, setSelectionLinkEnabled } from './selection'

describe('preview selection state', () => {
  it('keeps a clicked widget selected until the pointer leaves and re-enters the preview', () => {
    let state = enterPreview(createSelectionState<string>())
    state = hoverPreview(state, 'first')
    state = clickPreview(state, 'first')
    state = hoverPreview(state, 'second')

    expect(state.selected).toBe('first')

    state = leavePreview(state)
    expect(state.selected).toBe('first')
    state = enterPreview(state)
    state = hoverPreview(state, 'second')

    expect(state.selected).toBe('second')
  })

  it('lets another explicit preview click replace a locked selection', () => {
    let state = clickPreview(enterPreview(createSelectionState<string>()), 'first')
    state = clickPreview(state, 'second')

    expect(state.selected).toBe('second')
    expect(state.lockedUntilPreviewReentry).toBe(true)
  })

  it('lets an editor selection take control and clears linked selection when disabled', () => {
    let state = clickPreview(enterPreview(createSelectionState<string>()), 'preview')
    state = selectFromEditor(state, 'yaml')
    expect(state).toMatchObject({ selected: 'yaml', lockedUntilPreviewReentry: false })

    state = setSelectionLinkEnabled(state, false)
    expect(state).toMatchObject({ selected: undefined, enabled: false })
  })
})
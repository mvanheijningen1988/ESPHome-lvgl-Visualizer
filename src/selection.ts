export interface SelectionState<T> {
  enabled: boolean
  insidePreview: boolean
  lockedUntilPreviewReentry: boolean
  selected: T | undefined
}

export function createSelectionState<T>(): SelectionState<T> {
  return { enabled: true, insidePreview: false, lockedUntilPreviewReentry: false, selected: undefined }
}

export function enterPreview<T>(state: SelectionState<T>): SelectionState<T> {
  return { ...state, insidePreview: true, lockedUntilPreviewReentry: false }
}

export function leavePreview<T>(state: SelectionState<T>): SelectionState<T> {
  return { ...state, insidePreview: false }
}

export function hoverPreview<T>(state: SelectionState<T>, selection: T | undefined): SelectionState<T> {
  if (!state.enabled || !state.insidePreview || state.lockedUntilPreviewReentry) return state
  return { ...state, selected: selection }
}

export function clickPreview<T>(state: SelectionState<T>, selection: T | undefined): SelectionState<T> {
  if (!state.enabled || !state.insidePreview) return state
  return { ...state, selected: selection, lockedUntilPreviewReentry: true }
}

export function selectFromEditor<T>(state: SelectionState<T>, selection: T | undefined): SelectionState<T> {
  if (!state.enabled) return state
  return { ...state, selected: selection, lockedUntilPreviewReentry: false }
}

export function setSelectionLinkEnabled<T>(state: SelectionState<T>, enabled: boolean): SelectionState<T> {
  return { ...state, enabled, selected: enabled ? state.selected : undefined, lockedUntilPreviewReentry: false }
}
import './style.css'
import type { Diagnostic, LvglWidget, MockEntity, MockValue, ImageAsset, VisualizerModel, WidgetAutomation } from './model'
import { parseProjectYaml } from './yaml'
import { WasmLvglRenderer } from './lvgl-wasm'
import { loadRequestedFonts } from './font-loader'
import { loadOnlineImages } from './image-loader'
import { YamlEditor } from './yaml-editor'
import { clickPreview, createSelectionState, enterPreview, hoverPreview, leavePreview, selectFromEditor, setSelectionLinkEnabled } from './selection'

const initialYaml = `display:
  width: 480
  height: 480
  rotation: 270
lvgl:
  pages:
    - id: dashboard
      width: 480
      height: 480
      widgets:
        - obj:
            id: climate_card
            x: 24
            y: 24
            width: 432
            height: 190
            bg_color: "#21313a"
            widgets:
              - label:
                  x: 24
                  y: 22
                  text: "Kitchen climate"
              - label:
                  x: 24
                  y: 74
                  text: "21.4°"
              - bar:
                  x: 24
                  y: 142
                  width: 360
                  height: 12
                  value: 68
        - button:
            id: lights
            x: 24
            y: 238
            width: 204
            height: 110
            bg_color: "#f5c451"
            widgets:
              - label:
                  x: 18
                  y: 18
                  text: "Lights"
              - label:
                  x: 18
                  y: 54
                  text: "8 active"
        - image:
            id: weather
            x: 252
            y: 238
            width: 204
            height: 110
            bg_color: "#29465a"
            widgets:
              - label:
                  x: 18
                  y: 18
                  text: "Weather"
              - label:
                  x: 18
                  y: 54
                  text: "Partly cloudy"
  top_layer:
    - label:
        x: 24
        y: 438
        text: "LVGL 9.5 preview"
`

const app = document.querySelector<HTMLDivElement>('#app')!
let yamlSource = initialYaml
let selectedPage = 'dashboard'
let manualWidth: number | undefined
let manualHeight: number | undefined
let scaleMode: 'fit' | 'actual' = 'fit'
let surfaceWidth = 480
let surfaceHeight = 480
const projectFiles: Record<string, string> = {}
const assetUrls: Record<string, string> = {}
const assetFiles = new Map<string, File>()
const mockValues: Record<string, MockValue> = {}
let useDefaultMockValues = false
let wasmRenderer: WasmLvglRenderer | undefined
let fontDiagnostics: Diagnostic[] = []
let imageDiagnostics: Diagnostic[] = []
let fontLoadGeneration = 0
let imageLoadGeneration = 0
let sourceExpanded = true
let selectionLinkEnabled = true
let linkedSourceOffset: number | undefined
let rootSourceName = 'editor.yaml'
let selectionState = createSelectionState<LvglWidget>()
const visibleSeverities = new Set<Diagnostic['severity']>(['error', 'warning', 'info'])

app.innerHTML = `
  <header class="topbar"><div class="brand"><span class="brand-mark">W</span><div><strong>WallDisplay</strong><small>ESPHome / LVGL visualizer</small></div></div><div class="topbar-status"><span class="status-dot"></span> LIVE PARSER <span class="version">WASM target · 9.5</span></div></header>
  <main class="workspace"><section class="intro"><div><p class="eyebrow">CONTROL ROOM / 01</p><h1>See the screen<br><em>before it ships.</em></h1></div><p class="intro-copy">Drop in your ESPHome configuration, tune the viewport, and inspect the LVGL surface as it takes shape.</p></section>
    <section class="toolbar"><label class="file-button"><span>＋</span> Add YAML<input id="yaml-file" type="file" accept=".yaml,.yml" multiple hidden></label><label class="file-button secondary"><span>↥</span> Assets<input id="asset-files" type="file" multiple hidden></label><div id="drop-zone" class="drop-zone" tabindex="0">Drop YAML or assets here</div><div class="toolbar-spacer"></div><span class="parse-state" id="parse-state">Parsed just now</span></section>
    <section class="content-grid is-source-expanded"><article class="panel editor-panel"><div class="panel-head"><div><span class="panel-kicker">SOURCE</span><h2>ESPHome YAML</h2></div><div class="editor-actions"><label class="link-selection"><input id="link-selection" type="checkbox" checked> Link selection</label><span class="line-count" id="line-count"></span><button id="collapse-source" class="icon-button" type="button" title="Collapse source" aria-label="Collapse source">↙</button><button id="apply-yaml" type="button">Apply YAML</button></div></div><div class="yaml-editor-wrap"><div id="yaml-line-numbers" class="yaml-line-numbers" aria-hidden="true"></div><textarea id="yaml-editor" class="yaml-editor" aria-label="ESPHome YAML editor" spellcheck="false" wrap="off"></textarea><div id="yaml-selection-highlight" class="yaml-selection-highlight" aria-hidden="true"></div></div><div class="editor-foot"><span>Editable · preview updates automatically</span><span id="editor-status">Ready</span></div></article>
      <article class="panel preview-panel"><div class="panel-head"><div><span class="panel-kicker">RENDER SURFACE</span><h2>LVGL Preview</h2></div><div class="preview-tools"><label>Page <select id="page-select"></select></label><div class="scale-control" role="group" aria-label="Preview scale"><button type="button" data-scale="fit" class="is-active">Fit</button><button type="button" data-scale="actual">1:1</button></div><button id="reset-size" title="Use YAML dimensions">↺</button></div></div><div id="preview-stage" class="preview-stage"><div id="preview-viewport" class="preview-viewport"><div class="device-frame"><canvas id="lvgl-canvas" class="lvgl-canvas" aria-label="Real LVGL WebAssembly preview"></canvas><div id="lvgl-preview" class="lvgl-preview"></div></div></div></div></article>
      <article class="panel diagnostics-panel"><div class="problems-bar"><div class="problems-tab is-active">Problems <span class="signal-count" id="signal-count">0</span></div><div class="problem-filters" aria-label="Problem filters"><button type="button" data-severity="error" class="is-active" aria-pressed="true"><span class="severity-error">●</span> Errors <b id="error-count">0</b></button><button type="button" data-severity="warning" class="is-active" aria-pressed="true"><span class="severity-warning">▲</span> Warnings <b id="warning-count">0</b></button><button type="button" data-severity="info" class="is-active" aria-pressed="true"><span class="severity-info">●</span> Info <b id="info-count">0</b></button></div></div><div id="diagnostics" class="diagnostics" role="list"></div></article>
      <aside class="side-column"><article class="panel controls-panel"><div class="panel-head"><div><span class="panel-kicker">VIEWPORT</span><h2>Dimensions</h2></div></div><div class="dimension-grid"><label>Width<input id="width-input" type="number" min="1" placeholder="auto"></label><label>Height<input id="height-input" type="number" min="1" placeholder="auto"></label></div><label class="rotation-row"><span>Rotation</span><input id="rotation-input" type="number" min="0" max="270" step="90"></label></article><article class="panel scenarios-panel"><div class="panel-head"><div><span class="panel-kicker">MOCK ENTITIES</span><h2>Scenario values</h2></div><label class="default-mocks"><input id="default-mocks" type="checkbox"> Defaults</label></div><div id="entity-controls" class="entity-controls"><span class="muted-copy">Entities appear when declared in YAML.</span></div></article></aside>
    </section></main><footer><span>SPEC_FLOW tracked</span><a href="./SPEC_FLOW.md">Open specification ↗</a></footer>`

const editorWrap = document.querySelector<HTMLDivElement>('.yaml-editor-wrap')!
document.querySelector('#yaml-line-numbers')?.remove()
document.querySelector('#yaml-selection-highlight')?.remove()
document.querySelector('#yaml-editor')?.remove()
const editorHost = document.createElement('div')
editorHost.id = 'yaml-editor'
editorHost.className = 'yaml-editor'
editorWrap.append(editorHost)
const editor = new YamlEditor(editorHost, initialYaml)
const sourceFileSelect = document.createElement('select')
sourceFileSelect.id = 'source-file-select'
sourceFileSelect.setAttribute('aria-label', 'YAML source file')
const sourceFileLabel = document.createElement('label')
sourceFileLabel.className = 'source-file-control'
sourceFileLabel.append('File ', sourceFileSelect)
document.querySelector('.editor-actions')!.prepend(sourceFileLabel)
const foldYamlButton = document.createElement('button')
foldYamlButton.id = 'fold-yaml'
foldYamlButton.type = 'button'
foldYamlButton.title = 'Fold all YAML sections'
foldYamlButton.setAttribute('aria-label', foldYamlButton.title)
foldYamlButton.textContent = '−'
const unfoldYamlButton = document.createElement('button')
unfoldYamlButton.id = 'unfold-yaml'
unfoldYamlButton.type = 'button'
unfoldYamlButton.title = 'Unfold all YAML sections'
unfoldYamlButton.setAttribute('aria-label', unfoldYamlButton.title)
unfoldYamlButton.textContent = '+'
sourceFileLabel.after(foldYamlButton, unfoldYamlButton)
foldYamlButton.addEventListener('click', () => editor.foldAll())
unfoldYamlButton.addEventListener('click', () => editor.unfoldAll())
const preview = document.querySelector<HTMLDivElement>('#lvgl-preview')!
const diagnostics = document.querySelector<HTMLDivElement>('#diagnostics')!
const pageSelect = document.querySelector<HTMLSelectElement>('#page-select')!
const widthInput = document.querySelector<HTMLInputElement>('#width-input')!
const heightInput = document.querySelector<HTMLInputElement>('#height-input')!
const rotationInput = document.querySelector<HTMLInputElement>('#rotation-input')!
const previewStage = document.querySelector<HTMLDivElement>('#preview-stage')!
const previewViewport = document.querySelector<HTMLDivElement>('#preview-viewport')!
const contentGrid = document.querySelector<HTMLElement>('.content-grid')!
editor.value = yamlSource

function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[character] ?? character) }
function replaceMockTokens(value: string): string {
  let result = value
  let start = result.indexOf('{{')
  while (start >= 0) {
    const end = result.indexOf('}}', start + 2)
    if (end < 0) break
    const key = result.slice(start + 2, end).trim()
    const replacement = String(mockValues[key] ?? result.slice(start, end + 2))
    result = `${result.slice(0, start)}${replacement}${result.slice(end + 2)}`
    start = result.indexOf('{{', start + replacement.length)
  }
  return result
}
function imageSource(asset: ImageAsset | undefined): string | undefined {
  if (!asset) return undefined
  if (assetUrls[asset.id]) return assetUrls[asset.id]
  if (!asset.file) return asset.url
  return assetUrls[asset.file] ?? assetUrls[asset.file.split('/').pop() ?? '']
}
function renderWidget(widget: LvglWidget, assets: ImageAsset[], widgetValues: Record<string, string | number | boolean>, widgetTextColors: Record<string, string | number>): string {
  const children = widget.children.map((child) => renderWidget(child, assets, widgetValues, widgetTextColors)).join('')
  const asset = widget.source ? assets.find((candidate) => candidate.id === widget.source) : undefined
  const source = imageSource(asset)
  const dimensions = (value: number | string | undefined, suffix = 'px') => typeof value === 'number' ? `${value}${suffix}` : value ?? ''
  const textColor = widget.id ? widgetTextColors[widget.id] : undefined
  const textColorValue = typeof textColor === 'number' ? '#' + textColor.toString(16).padStart(6, '0') : textColor
  const textColorStyle = textColorValue === undefined ? '' : `color:${textColorValue}`
  const style = [`left:${dimensions(widget.x ?? 0)}`, `top:${dimensions(widget.y ?? 0)}`, widget.width ? `width:${dimensions(widget.width)}` : '', widget.height ? `height:${dimensions(widget.height)}` : '', widget.color ? `--widget-color:${widget.color}` : '', textColorStyle, source ? `background-image:url("${source}")` : ''].filter(Boolean).join(';')
  const configuredText = widget.id && Object.hasOwn(widgetValues, widget.id) ? String(widgetValues[widget.id]) : widget.text
  const textValue = configuredText ? replaceMockTokens(configuredText) : undefined
  const text = textValue ? `<span>${escapeHtml(textValue)}</span>` : ''
  const checked = widget.type === 'switch' && (widgetValues[widget.id ?? ''] === true || widget.raw.state === true || widget.raw.checked === true) ? ' is-checked' : ''
  return `<div class="lvgl-widget widget-${widget.type}${checked}" data-widget-key="${escapeHtml(widget.instanceKey ?? '')}" style="${style}">${text}${children}</div>`
}
function diagnosticMarkup(item: Diagnostic): string {
  let icon = 'i'
  if (item.severity === 'error') icon = '!'
  else if (item.severity === 'warning') icon = '△'
  const source = item.source ? `<span class="diagnostic-source">${escapeHtml(item.source)}</span>` : ''
  return `<div class="diagnostic diagnostic-${item.severity}" role="listitem"><span class="diagnostic-icon">${icon}</span><strong>${item.severity}</strong><span class="diagnostic-message">${escapeHtml(item.message)}</span>${source}</div>`
}
function entityControls(entities: MockEntity[], widgetValues: Record<string, MockValue>): string {
  return entities.length ? entities.map((entity) => {
    const renderedValue = entity.targetWidgetId ? widgetValues[entity.targetWidgetId] : undefined
    const value = entity.type === 'lvgl_switch' && typeof renderedValue === 'boolean' ? renderedValue : mockValues[entity.id] ?? entity.value
    if (entity.type !== 'script_value' && !Object.hasOwn(mockValues, entity.id)) mockValues[entity.id] = value
    let control: string
    if (typeof value === 'boolean') control = `<input type="checkbox" data-entity="${escapeHtml(entity.id)}" ${value ? 'checked' : ''}>`
    else control = `<input class="entity-input" data-entity="${escapeHtml(entity.id)}" value="${escapeHtml(String(value))}" placeholder="mock value">`
    return `<label class="entity-control"><span title="${escapeHtml(entity.id)}">${escapeHtml(entity.id)}<small>${escapeHtml(entity.type)}</small></span>${control}</label>`
  }).join('') : '<span class="muted-copy">Entities appear when declared in YAML.</span>'
}
function numericMockValue(value: MockValue): number {
  if (typeof value === 'boolean') return value ? 1 : 0
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}
function conditionalBranch(expression: string, value: MockValue): string {
  if (!expression.includes('x > 0')) return expression
  const question = expression.indexOf('?')
  const colon = expression.indexOf(':', question + 1)
  if (question < 0 || colon < 0) return expression
  const selected = numericMockValue(value) > 0 ? expression.slice(question + 1, colon) : expression.slice(colon + 1)
  return selected.replace(/;\s*$/, '').trim()
}
function evaluateFormattedValue(value: unknown, sourceValue: MockValue): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const format = (value as { format?: unknown }).format
  if (typeof format !== 'string') return undefined
  const precision = /%\.(\d+)f/.exec(format)?.[1]
  const formatted = numericMockValue(sourceValue).toFixed(precision === undefined ? 0 : Number(precision))
  return format.replace(/%\.?\d*f/, formatted).replaceAll('%%', '%')
}
function evaluateAutomation(automation: WidgetAutomation, sourceValue: MockValue): MockValue | undefined {
  if (automation.property === 'checked') {
    if (typeof automation.value === 'boolean') return automation.value
    if (typeof automation.value === 'string' && /return\s+x\s*>\s*0/.test(automation.value)) return numericMockValue(sourceValue) > 0
    return undefined
  }
  const formatted = evaluateFormattedValue(automation.value, sourceValue)
  if (formatted !== undefined) return formatted
  if (typeof automation.value !== 'string') return automation.value as string | number | undefined
  const selected = conditionalBranch(automation.value, sourceValue)
  if (automation.property === 'text_color') {
    const colorMatch = /lv_color_hex\((0x[\da-f]+|\d+)\)/i.exec(selected)
    return colorMatch ? Number(colorMatch[1]) : undefined
  }
  const stringMatch = /(?:std::string\()?['"]([^'"]*)['"]/.exec(selected)
  return stringMatch?.[1]
}
function resolveWidgetMocks(model: VisualizerModel): { values: Record<string, MockValue>; textColors: Record<string, string | number> } {
  const values = Object.fromEntries(model.entities.flatMap((entity) => entity.targetWidgetId && Object.hasOwn(mockValues, entity.id) ? [[entity.targetWidgetId, mockValues[entity.id]]] : []))
  const textColors: Record<string, string | number> = {}
  for (const automation of model.automations) {
    const sourceValue = mockValues[automation.sourceId]
    if (sourceValue === undefined || sourceValue === '') continue
    const result = evaluateAutomation(automation, sourceValue)
    if (result === undefined) continue
    if (automation.property === 'text_color' && (typeof result === 'string' || typeof result === 'number')) textColors[automation.targetWidgetId] = result
    else values[automation.targetWidgetId] = result
  }
  return { values, textColors }
}
function propagateSwitchMock(model: VisualizerModel, switchId: string, checked: boolean): void {
  const source = model.automations.find((automation) => automation.property === 'checked' && automation.targetWidgetId === switchId)?.sourceId
  if (source) mockValues[source] = checked ? 1 : 0
}
type SourceRange = { start: number; end: number; startLine: number; endLine: number; sourceFile?: string }

function widgetsInTree(widgets: LvglWidget[]): LvglWidget[] {
  return widgets.flatMap((widget) => [widget, ...widgetsInTree(widget.children)])
}
function allModelWidgets(model: VisualizerModel): LvglWidget[] {
  return widgetsInTree([...model.bottomLayer, ...model.pages.flatMap((page) => page.widgets), ...model.topLayer])
}
function pageContainingWidget(model: VisualizerModel, widget: LvglWidget): string | undefined {
  return model.pages.find((page) => widgetsInTree(page.widgets).includes(widget))?.id
}
function currentWidgetBounds(): Array<{ widget: LvglWidget; x: number; y: number; width: number; height: number }> {
  const nativeBounds = wasmRenderer?.getWidgetBounds()
  if (nativeBounds?.length) return [...nativeBounds]
  return Array.from(preview.querySelectorAll<HTMLElement>('.lvgl-widget')).flatMap((element) => {
    const key = element.dataset.widgetKey
    const widget = key ? allModelWidgets(currentModel).find((candidate) => candidate.instanceKey === key) : undefined
    if (!widget) return []
    const previewRect = preview.getBoundingClientRect()
    const elementRect = element.getBoundingClientRect()
    return [{
      widget,
      x: (elementRect.left - previewRect.left) * surfaceWidth / previewRect.width,
      y: (elementRect.top - previewRect.top) * surfaceHeight / previewRect.height,
      width: elementRect.width * surfaceWidth / previewRect.width,
      height: elementRect.height * surfaceHeight / previewRect.height,
    }]
  })
}
function widgetAtPoint(x: number, y: number): LvglWidget | undefined {
  return currentWidgetBounds().reverse().find((bounds) => {
    const hitWidth = Math.max(18, bounds.width)
    const hitHeight = Math.max(18, bounds.height)
    const hitX = bounds.x - (hitWidth - bounds.width) / 2
    const hitY = bounds.y - (hitHeight - bounds.height) / 2
    return x >= hitX && x <= hitX + hitWidth && y >= hitY && y <= hitY + hitHeight
  })?.widget
}
function widgetSourceRange(widget: LvglWidget): SourceRange | undefined {
  return widget.sourceRange
}
function widgetAtSourceOffset(sourceOffset: number): LvglWidget | undefined {
  const matching = allModelWidgets(currentModel).map((widget) => ({ widget, range: widgetSourceRange(widget) })).filter((item): item is { widget: LvglWidget; range: SourceRange } => item.range !== undefined && (item.range.sourceFile ?? rootSourceName) === editor.documentName && sourceOffset >= item.range.start && sourceOffset < item.range.end)
  return matching.sort((left, right) => (left.range.end - left.range.start) - (right.range.end - right.range.start))[0]?.widget
}
function showWidgetSelection(widget: LvglWidget | undefined): void {
  document.querySelector('.widget-selection')?.remove()
  if (!selectionLinkEnabled || !widget) return
  const bounds = currentWidgetBounds().find((item) => item.widget === widget)
  const frame = document.querySelector<HTMLElement>('.device-frame')
  if (!bounds || !frame) return
  const scaleX = wasmRenderer ? surfaceWidth / wasmCanvas.width : 1
  const scaleY = wasmRenderer ? surfaceHeight / wasmCanvas.height : 1
  const markerWidth = Math.max(6, bounds.width * scaleX)
  const markerHeight = Math.max(6, bounds.height * scaleY)
  const marker = document.createElement('div')
  marker.className = 'widget-selection'
  marker.style.left = `${bounds.x * scaleX + 10 - (markerWidth - bounds.width * scaleX) / 2}px`
  marker.style.top = `${bounds.y * scaleY + 10 - (markerHeight - bounds.height * scaleY) / 2}px`
  marker.style.width = `${markerWidth}px`
  marker.style.height = `${markerHeight}px`
  frame.append(marker)
}
function syncEditorDecorations(): void {
  showYamlSelection(selectionState.selected)
}
function showYamlSelection(widget: LvglWidget | undefined): void {
  const range = widget?.sourceRange
  if (!selectionLinkEnabled || !range || (range.sourceFile ?? rootSourceName) !== editor.documentName) {
    editor.setSourceDecoration(undefined)
    return
  }
  editor.setSourceDecoration(range.start, range.end)
}
function linkYamlSelection(): void {
  if (!selectionLinkEnabled) return
  linkedSourceOffset = editor.selectionEnd
  const widget = widgetAtSourceOffset(linkedSourceOffset)
  selectionState = selectFromEditor(selectionState, widget)
  showYamlSelection(widget)
  const widgetPage = widget ? pageContainingWidget(currentModel, widget) : undefined
  if (widgetPage && widgetPage !== selectedPage) {
    selectedPage = widgetPage
    render(currentModel)
    return
  }
  showWidgetSelection(widget)
}
function selectWidgetSource(widget: LvglWidget, focusEditor: boolean): void {
  if (!selectionLinkEnabled) return
  const range = widgetSourceRange(widget)
  if (!range) return
  const sourceFile = range.sourceFile ?? rootSourceName
  if (sourceFile !== editor.documentName) {
    editor.addDocument(sourceFile, projectFiles[sourceFile] ?? '')
    editor.openDocument(sourceFile)
    document.querySelector<HTMLSelectElement>('#source-file-select')?.setAttribute('data-active-file', sourceFile)
  }
  linkedSourceOffset = range.start
  editor.revealOffset(range.start, range.end)
  if (focusEditor) editor.focus()
  showYamlSelection(widget)
  showWidgetSelection(widget)
}
function hoverWidgetSource(widget: LvglWidget | undefined): void {
  if (!selectionLinkEnabled) return
  selectionState = hoverPreview(selectionState, widget)
  if (selectionState.selected !== widget) return
  if (widget?.sourceRange) selectWidgetSource(widget, false)
  else {
    linkedSourceOffset = undefined
    showYamlSelection(undefined)
    showWidgetSelection(undefined)
  }
}
function updatePreviewScale(): void {
  const frameInset = 22
  const availableWidth = Math.max(1, previewStage.clientWidth - 60)
  const availableHeight = Math.max(1, previewStage.clientHeight - 60)
  const scale = scaleMode === 'actual' ? 1 : Math.min(availableWidth / (surfaceWidth + frameInset), availableHeight / (surfaceHeight + frameInset))
  previewViewport.style.width = `${(surfaceWidth + frameInset) * scale}px`
  previewViewport.style.height = `${(surfaceHeight + frameInset) * scale}px`
  previewViewport.style.setProperty('--preview-scale', String(scale))
  previewStage.classList.toggle('is-one-to-one', scaleMode === 'actual')
}
function render(model: VisualizerModel): void {
  const allDiagnostics = [...model.diagnostics, ...fontDiagnostics, ...imageDiagnostics]
  const filteredDiagnostics = allDiagnostics.filter((item) => visibleSeverities.has(item.severity))
  const { values: widgetValues, textColors: widgetTextColors } = resolveWidgetMocks(model)
  pageSelect.innerHTML = model.pages.map((page) => `<option value="${escapeHtml(page.id)}">${escapeHtml(page.id)}</option>`).join('') || '<option value="">No pages</option>'
  if (model.pages.some((page) => page.id === selectedPage)) pageSelect.value = selectedPage
  else selectedPage = model.pages[0]?.id ?? ''
  const page = model.pages.find((candidate) => candidate.id === selectedPage) ?? model.pages[0]
  const width = manualWidth ?? page?.width ?? model.displayWidth ?? 480
  const height = manualHeight ?? page?.height ?? model.displayHeight ?? 480
  surfaceWidth = width
  surfaceHeight = height
  preview.style.setProperty('--surface-width', `${width}px`)
  preview.style.setProperty('--surface-height', `${height}px`)
  updatePreviewScale()
  preview.innerHTML = page ? [...model.bottomLayer, ...page.widgets, ...model.topLayer].map((widget) => renderWidget(widget, model.assets, widgetValues, widgetTextColors)).join('') : '<div class="empty-preview">Add an <code>lvgl.pages</code> block to begin.</div>'
  if (selectionState.selected) {
    const key = selectionState.selected.instanceKey
    let selected = key ? allModelWidgets(model).find((widget) => widget.instanceKey === key) : undefined
    const sourceFile = selectionState.selected.sourceRange?.sourceFile ?? rootSourceName
    if (!selected && sourceFile === editor.documentName) {
      const trackedRange = editor.getTrackedSourceRange(sourceFile)
      if (trackedRange) selected = widgetAtSourceOffset(trackedRange.start)
    }
    selectionState = { ...selectionState, selected }
  }
  document.querySelector<HTMLDivElement>('#entity-controls')!.innerHTML = entityControls(model.entities, widgetValues)
  let diagnosticContent = filteredDiagnostics.map(diagnosticMarkup).join('')
  if (!diagnosticContent) {
    const emptyMessage = allDiagnostics.length ? 'No problems match the active filters' : '✓ No parser signals'
    diagnosticContent = `<div class="all-clear">${emptyMessage}</div>`
  }
  diagnostics.innerHTML = diagnosticContent
  document.querySelector('#signal-count')!.textContent = String(allDiagnostics.length)
  for (const severity of ['error', 'warning', 'info'] as const) document.querySelector(`#${severity}-count`)!.textContent = String(allDiagnostics.filter((item) => item.severity === severity).length)
  document.querySelector('#line-count')!.textContent = `${(yamlSource ?? '').split('\n').length} lines`
  if (document.activeElement !== rotationInput) rotationInput.value = String(model.rotation ?? 0)
  document.querySelector('#parse-state')!.textContent = allDiagnostics.some((item) => item.severity === 'error') ? 'Needs attention' : 'Parsed just now'
  if (wasmRenderer) wasmRenderer.render(model, selectedPage, widgetValues, widgetTextColors)
  showYamlSelection(selectionState.selected)
  showWidgetSelection(selectionState.selected)
}
function renderPreservingInput(model: VisualizerModel, selector: string, value: string | undefined, selectionStart: number | null, selectionEnd: number | null): void {
  render(model)
  const input = document.querySelector<HTMLInputElement>(selector)
  if (!input) return
  input.focus()
  if (value !== undefined) input.value = value
  input.setSelectionRange(selectionStart ?? input.value.length, selectionEnd ?? input.value.length)
}
let currentModel: VisualizerModel = parseProjectYaml(initialYaml)
async function synchronizeFonts(model: VisualizerModel): Promise<void> {
  const renderer = wasmRenderer
  if (!renderer) return
  const generation = ++fontLoadGeneration
  const result = await loadRequestedFonts(model.fonts, assetFiles)
  if (generation !== fontLoadGeneration || model !== currentModel) return
  renderer.registerFonts(result.fonts)
  fontDiagnostics = result.diagnostics
  render(model)
}
async function synchronizeImages(model: VisualizerModel): Promise<void> {
  const renderer = wasmRenderer
  if (!renderer) return
  const generation = ++imageLoadGeneration
  const result = await loadOnlineImages(model.assets)
  if (generation !== imageLoadGeneration || model !== currentModel) return
  result.images.forEach((image) => { assetUrls[image.id] = image.objectUrl })
  renderer.registerImages(result.images)
  imageDiagnostics = result.diagnostics
  render(model)
}
function parseAndRender(): void {
  yamlSource = editor.getDocumentValue(rootSourceName) ?? editor.value
  try {
    currentModel = parseProjectYaml(yamlSource, rootSourceName, projectFiles)
    fontDiagnostics = []
    imageDiagnostics = []
    render(currentModel)
    void synchronizeFonts(currentModel)
    void synchronizeImages(currentModel)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Preview could not be updated.'
    currentModel = { ...currentModel, diagnostics: [{ severity: 'error', message, source: rootSourceName }] }
    render(currentModel)
  }
}
function setSourceExpanded(expanded: boolean): void {
  sourceExpanded = expanded
  contentGrid.classList.toggle('is-source-expanded', expanded)
  const button = document.querySelector<HTMLButtonElement>('#collapse-source')!
  button.textContent = expanded ? '↙' : '↗'
  button.title = expanded ? 'Collapse source' : 'Expand source over preview'
  button.setAttribute('aria-label', button.title)
  window.requestAnimationFrame(updatePreviewScale)
}
function updateYamlRotation(value: number): void {
  if (!editor.hasDocument(rootSourceName)) editor.addDocument(rootSourceName, yamlSource)
  editor.openDocument(rootSourceName)
  sourceFileSelect.value = rootSourceName
  const rotation = Math.max(0, Math.min(270, Math.round(value / 90) * 90))
  const lines = editor.value.split('\n')
  const displayStart = lines.findIndex((line) => /^display\s*:\s*(?:#.*)?$/.test(line))
  if (displayStart < 0) lines.unshift(`display:\n  rotation: ${rotation}`)
  else {
    let displayEnd = lines.length
    for (let index = displayStart + 1; index < lines.length; index += 1) {
      const trimmed = lines[index].trimStart()
      if (trimmed === lines[index] && !trimmed.startsWith('#') && trimmed.includes(':')) { displayEnd = index; break }
    }
    const rotationLine = lines.findIndex((line, index) => index > displayStart && index < displayEnd && /^\s+rotation\s*:/.test(line))
    if (rotationLine >= 0) lines[rotationLine] = lines[rotationLine].replace(/^(\s*rotation\s*:)\s*[^#]*/, `$1 ${rotation}`)
    else lines.splice(displayStart + 1, 0, `  rotation: ${rotation}`)
  }
  editor.replaceValue(lines.join('\n'))
  rotationInput.value = String(rotation)
  parseAndRender()
  document.querySelector('#editor-status')!.textContent = 'Rotation updated in YAML'
}
let debounceTimer: number | undefined
editor.onDidChange((sourceFile, value) => {
  projectFiles[sourceFile] = value
  document.querySelector('#editor-status')!.textContent = 'Unsaved changes'
  window.clearTimeout(debounceTimer)
  debounceTimer = window.setTimeout(() => { parseAndRender(); document.querySelector('#editor-status')!.textContent = 'Preview updated' }, 260)
})
editor.onDidChangeSelection((sourceFile, start, end, programmatic) => {
  sourceFileSelect.value = sourceFile
  if (programmatic || !selectionLinkEnabled) return
  linkedSourceOffset = end > start ? end - 1 : end
  const widget = widgetAtSourceOffset(linkedSourceOffset)
  selectionState = selectFromEditor(selectionState, widget)
  editor.trackSourceRange(sourceFile, widget?.sourceRange?.start, widget?.sourceRange?.end)
  const widgetPage = widget ? pageContainingWidget(currentModel, widget) : undefined
  if (widgetPage && widgetPage !== selectedPage) {
    selectedPage = widgetPage
    render(currentModel)
  } else {
    showYamlSelection(widget)
    showWidgetSelection(widget)
  }
})
editor.onDidScroll(syncEditorDecorations)
sourceFileSelect.addEventListener('change', () => {
  editor.openDocument(sourceFileSelect.value)
  selectionState = selectFromEditor(selectionState, undefined)
  linkedSourceOffset = undefined
  editor.trackSourceRange(editor.documentName, undefined)
  showYamlSelection(undefined)
  showWidgetSelection(undefined)
})
function refreshSourceFileSelect(): void {
  const selected = editor.documentName
  const files = [...new Set([rootSourceName, ...Object.keys(projectFiles)])]
  sourceFileSelect.innerHTML = files.map((file) => `<option value="${escapeHtml(file)}">${escapeHtml(file)}${file === rootSourceName ? ' (root)' : ''}</option>`).join('')
  sourceFileSelect.value = selected
}
refreshSourceFileSelect()
document.querySelector<HTMLButtonElement>('#apply-yaml')!.addEventListener('click', () => {
  window.clearTimeout(debounceTimer)
  parseAndRender()
  setSourceExpanded(false)
  document.querySelector('#editor-status')!.textContent = 'Preview updated'
})
document.querySelector<HTMLButtonElement>('#collapse-source')!.addEventListener('click', () => setSourceExpanded(!sourceExpanded))
document.querySelector<HTMLInputElement>('#link-selection')!.addEventListener('change', (event) => {
  selectionLinkEnabled = (event.target as HTMLInputElement).checked
  selectionState = setSelectionLinkEnabled(selectionState, selectionLinkEnabled)
  if (!selectionLinkEnabled) {
    document.querySelector('.widget-selection')?.remove()
    editor.setSourceDecoration(undefined)
    editor.clearTrackedSourceRanges()
  }
  else linkYamlSelection()
})
document.querySelectorAll<HTMLButtonElement>('[data-severity]').forEach((button) => button.addEventListener('click', () => {
  const severity = button.dataset.severity as Diagnostic['severity']
  if (visibleSeverities.has(severity)) visibleSeverities.delete(severity)
  else visibleSeverities.add(severity)
  button.classList.toggle('is-active', visibleSeverities.has(severity))
  button.setAttribute('aria-pressed', String(visibleSeverities.has(severity)))
  render(currentModel)
}))
pageSelect.addEventListener('change', () => { selectedPage = pageSelect.value; parseAndRender() })
widthInput.addEventListener('input', () => { manualWidth = widthInput.value ? Number(widthInput.value) : undefined; render(currentModel) })
heightInput.addEventListener('input', () => { manualHeight = heightInput.value ? Number(heightInput.value) : undefined; render(currentModel) })
rotationInput.addEventListener('change', () => updateYamlRotation(Number(rotationInput.value)))
document.querySelector('#reset-size')!.addEventListener('click', () => { manualWidth = undefined; manualHeight = undefined; widthInput.value = ''; heightInput.value = ''; parseAndRender() })
document.querySelectorAll<HTMLButtonElement>('[data-scale]').forEach((button) => button.addEventListener('click', () => {
  scaleMode = button.dataset.scale === 'actual' ? 'actual' : 'fit'
  document.querySelectorAll<HTMLButtonElement>('[data-scale]').forEach((candidate) => candidate.classList.toggle('is-active', candidate === button))
  updatePreviewScale()
}))
new ResizeObserver(updatePreviewScale).observe(previewStage)
async function handleYamlFiles(files: File[]): Promise<void> {
  if (!files.length) return
  for (const file of files) {
    const sourceFile = file.webkitRelativePath || file.name
    projectFiles[sourceFile] = await file.text()
    editor.addDocument(sourceFile, projectFiles[sourceFile])
  }
  const root = files.find((file) => /\.ya?ml$/i.test(file.name))
  if (root) {
    rootSourceName = root.webkitRelativePath || root.name
    editor.openDocument(rootSourceName)
    sourceFileSelect.value = rootSourceName
    refreshSourceFileSelect()
    parseAndRender()
  }
  document.querySelector('#parse-state')!.textContent = `${files.length} YAML files staged`
}
function handleAssetFiles(files: File[]): void {
  files.forEach((file) => {
    const relativePath = file.webkitRelativePath || file.name
    assetFiles.set(relativePath, file)
    assetFiles.set(file.name, file)
    assetUrls[relativePath] = URL.createObjectURL(file)
    assetUrls[file.name] = assetUrls[relativePath]
  })
  document.querySelector('#parse-state')!.textContent = files.length ? `${files.length} assets staged` : 'Parsed just now'
  if (currentModel) render(currentModel)
  if (currentModel) void synchronizeFonts(currentModel)
}
document.querySelector<HTMLInputElement>('#yaml-file')!.addEventListener('change', async (event) => { await handleYamlFiles(Array.from((event.target as HTMLInputElement).files ?? [])) })
document.querySelector<HTMLInputElement>('#asset-files')!.addEventListener('change', (event) => { handleAssetFiles(Array.from((event.target as HTMLInputElement).files ?? [])) })
const dropZone = document.querySelector<HTMLDivElement>('#drop-zone')!
async function processDroppedFiles(files: File[]): Promise<void> {
  const yamlFiles = files.filter((file) => /\.ya?ml$/i.test(file.name))
  const assetFiles = files.filter((file) => !/\.ya?ml$/i.test(file.name))
  if (yamlFiles.length) await handleYamlFiles(yamlFiles)
  if (assetFiles.length) handleAssetFiles(assetFiles)
  if (!files.length) document.querySelector('#parse-state')!.textContent = 'No files dropped'
}
dropZone.addEventListener('dragover', (event) => { event.preventDefault(); dropZone.classList.add('is-over'); if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy' })
dropZone.addEventListener('dragleave', () => { dropZone.classList.remove('is-over') })
dropZone.addEventListener('drop', async (event) => {
  event.preventDefault()
  event.stopPropagation()
  dropZone.classList.remove('is-over')
  await processDroppedFiles(Array.from(event.dataTransfer?.files ?? []))
})
app.addEventListener('dragover', (event) => { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy' })
app.addEventListener('drop', async (event) => { event.preventDefault(); await processDroppedFiles(Array.from(event.dataTransfer?.files ?? [])) })
document.querySelector('#entity-controls')!.addEventListener('input', (event) => {
  const control = event.target as HTMLInputElement
  const id = control.dataset.entity
  if (!id) return
  mockValues[id] = control.type === 'checkbox' ? control.checked : control.value
  if (control.type === 'checkbox') propagateSwitchMock(currentModel, id, control.checked)
  if (control.type === 'checkbox') render(currentModel)
  else renderPreservingInput(currentModel, `[data-entity="${CSS.escape(id)}"]`, control.value, control.selectionStart, control.selectionEnd)
})
document.querySelector<HTMLInputElement>('#default-mocks')!.addEventListener('change', (event) => {
  useDefaultMockValues = (event.target as HTMLInputElement).checked
  for (const entity of currentModel.entities) mockValues[entity.id] = useDefaultMockValues ? entity.defaultValue ?? entity.value : entity.value
  render(currentModel)
})
parseAndRender()

const wasmCanvas = document.querySelector<HTMLCanvasElement>('#lvgl-canvas')!
previewStage.addEventListener('pointerenter', () => { selectionState = enterPreview(selectionState) })
previewStage.addEventListener('pointerleave', () => { selectionState = leavePreview(selectionState) })
function widgetUnderPreviewPointer(event: PointerEvent): LvglWidget | undefined {
  if (event.target === wasmCanvas) {
    const rect = wasmCanvas.getBoundingClientRect()
    return widgetAtPoint((event.clientX - rect.left) * wasmCanvas.width / rect.width, (event.clientY - rect.top) * wasmCanvas.height / rect.height)
  }
  const element = (event.target as HTMLElement).closest<HTMLElement>('.lvgl-widget')
  const key = element?.dataset.widgetKey
  return key ? allModelWidgets(currentModel).find((widget) => widget.instanceKey === key) : undefined
}
previewStage.addEventListener('pointermove', (event) => hoverWidgetSource(widgetUnderPreviewPointer(event)))
previewStage.addEventListener('click', (event) => {
  const widget = widgetUnderPreviewPointer(event as PointerEvent)
  selectionState = clickPreview(selectionState, widget)
  linkedSourceOffset = widget?.sourceRange?.start
  if (widget) selectWidgetSource(widget, false)
  else {
    showYamlSelection(undefined)
    showWidgetSelection(undefined)
    editor.trackSourceRange(editor.documentName, undefined)
  }
})
async function initializeWasm(): Promise<void> {
  try {
    const renderer = await WasmLvglRenderer.create(wasmCanvas)
    wasmRenderer = renderer
    document.body.classList.add('wasm-ready')
    document.body.dataset.lvglRuntime = 'active'
    document.querySelector('#parse-state')!.textContent = 'LVGL WASM active'
    render(currentModel)
    void synchronizeFonts(currentModel)
    void synchronizeImages(currentModel)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'LVGL WebAssembly runtime could not be loaded.'
    document.body.dataset.lvglRuntime = 'fallback'
    currentModel.diagnostics.push({ severity: 'warning', message, source: 'lvgl_runtime.js' })
    render(currentModel)
  }
}
window.setTimeout(() => { void initializeWasm() }, 0)

import { load } from 'js-yaml'
import type { Diagnostic, FontDefinition, FontSource, ImageAsset, LvglPage, LvglWidget, MockEntity, MockValue, VisualizerModel, WidgetAutomation } from './model'

const supportedWidgets = new Set(['obj', 'container', 'label', 'button', 'switch', 'bar', 'image', 'animimg', 'arc', 'checkbox', 'dropdown', 'slider', 'spinner', 'textarea', 'qrcode', 'meter', 'line', 'led', 'roller', 'spinbox', 'buttonmatrix', 'keyboard', 'tabview', 'tileview', 'msgbox', 'canvas'])

type YamlMap = Record<string, unknown>

function asMap(value: unknown): YamlMap { return value && typeof value === 'object' && !Array.isArray(value) ? value as YamlMap : {} }
function asNumber(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) ? value : undefined }
function normalizeTags(source: string): string { return source.replace(/!(?:lambda|include|secret)\b/g, '') }
function replaceSubstitutions(source: string, substitutions: Record<string, string>): string { return source.replace(/\$\{([^}]+)\}/g, (_, key: string) => substitutions[key] ?? `\${${key}}`) }
function mergeMaps(base: YamlMap, extra: YamlMap): YamlMap {
  const result: YamlMap = { ...base }
  for (const [key, value] of Object.entries(extra)) {
    if (Array.isArray(result[key]) && Array.isArray(value)) result[key] = [...result[key] as unknown[], ...value]
    else if (result[key] && typeof result[key] === 'object' && value && typeof value === 'object' && !Array.isArray(value)) result[key] = mergeMaps(asMap(result[key]), asMap(value))
    else result[key] = value
  }
  return result
}

function resolveIncludes(source: string, sourceName: string, files: Record<string, string>, diagnostics: Diagnostic[], stack: string[]): string {
  return source.split('\n').map((line) => {
    const marker = line.indexOf('!include')
    if (marker < 0 || line.slice(0, marker).includes('#')) return line
    const prefix = line.slice(0, marker)
    let indentationLength = 0
    while (indentationLength < prefix.length && (prefix[indentationLength] === ' ' || prefix[indentationLength] === '\t')) indentationLength += 1
    const indentation = prefix.slice(0, indentationLength)
    const valuePrefix = prefix.slice(indentationLength)
    const includePath = line.slice(marker + '!include'.length).trim().split(/[ \t#]/, 1)[0]
    const normalized = includePath.replace(/^['"]|['"]$/g, '')
    const target = files[normalized] ?? files[`${sourceName.split('/').slice(0, -1).join('/')}/${normalized}`]
    if (stack.includes(normalized)) {
      diagnostics.push({ severity: 'error', message: `Cyclic !include detected: ${[...stack, normalized].join(' → ')}`, source: sourceName })
      return `${indentation}${valuePrefix}null`
    }
    if (target === undefined) {
      diagnostics.push({ severity: 'warning', message: `Included file not uploaded: ${normalized}`, source: sourceName })
      return `${indentation}${valuePrefix}null`
    }
    const nested = resolveIncludes(target, normalized, files, diagnostics, [...stack, normalized])
    const lines = nested.split('\n')
    return lines.map((includedLine, index) => index === 0 ? `${indentation}${valuePrefix}${includedLine}` : `${indentation}${includedLine}`).join('\n')
  }).join('\n')
}

function widgetFromEntry(entry: unknown, diagnostics: Diagnostic[], source: string): LvglWidget | undefined {
  const record = asMap(entry)
  const type = Object.keys(record).find((key) => supportedWidgets.has(key))
  if (!type) {
    if (Object.keys(record).length) diagnostics.push({ severity: 'warning', message: 'LVGL widget type could not be identified.', source })
    return undefined
  }
  const raw = asMap(record[type])
  const children = Array.isArray(raw.widgets) ? raw.widgets.map((child) => widgetFromEntry(child, diagnostics, source)).filter((child): child is LvglWidget => Boolean(child)) : []
  let text: string | undefined
  if (typeof raw.text === 'string' && raw.text.includes('${')) {
    const widgetName = typeof raw.id === 'string' ? `${type} ${raw.id}` : type
    diagnostics.push({ severity: 'error', message: `Unresolved substitution in ${widgetName}: ${raw.text}`, source })
    text = ''
  } else if (typeof raw.text === 'string') text = raw.text
  else if (typeof raw.text === 'number') text = String(raw.text)
  return {
    type,
    id: typeof raw.id === 'string' ? raw.id : undefined,
    text,
    value: asNumber(raw.value),
    x: asNumber(raw.x),
    y: asNumber(raw.y),
    width: typeof raw.width === 'number' || typeof raw.width === 'string' ? raw.width : undefined,
    height: typeof raw.height === 'number' || typeof raw.height === 'string' ? raw.height : undefined,
    color: typeof raw.bg_color === 'string' ? raw.bg_color : undefined,
    source: typeof raw.src === 'string' ? raw.src : undefined,
    children,
    raw,
  }
}
function listWidgets(value: unknown, diagnostics: Diagnostic[], source: string): LvglWidget[] { return Array.isArray(value) ? value.map((entry) => widgetFromEntry(entry, diagnostics, source)).filter((widget): widget is LvglWidget => Boolean(widget)) : [] }

type WidgetSourceCandidate = NonNullable<LvglWidget['sourceRange']> & { type: string; id?: string; text?: string; layer: 'page' | 'top' | 'bottom' }

function sectionLines(lines: string[], name: string, requiredIndent?: number): { start: number; end: number } | undefined {
  const expression = new RegExp(String.raw`^(\s*)${name}:`)
  const start = lines.findIndex((line) => {
    const match = expression.exec(line)
    return match !== null && (requiredIndent === undefined || match[1].length === requiredIndent)
  })
  if (start < 0) return undefined
  const indent = lines[start].length - lines[start].trimStart().length
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (!lines[index].trim() || lines[index].trimStart().startsWith('#')) continue
    const nextIndent = lines[index].length - lines[index].trimStart().length
    if (nextIndent <= indent) { end = index; break }
  }
  return { start, end }
}

function widgetBlockEnd(lines: string[], start: number, limit: number, indent: number): number {
  for (let index = start + 1; index < limit; index += 1) {
    if (!lines[index].trim() || lines[index].trimStart().startsWith('#')) continue
    if (lines[index].length - lines[index].trimStart().length <= indent) return index
  }
  return limit
}

function directWidgetProperty(lines: string[], start: number, end: number, widgetIndent: number, key: string): string | undefined {
  const propertyLines = lines.slice(start + 1, end).map((line, index) => ({ line, index: start + index + 1 })).filter(({ line }) => line.trim() && !line.trimStart().startsWith('#') && line.length - line.trimStart().length > widgetIndent)
  const propertyIndent = Math.min(...propertyLines.map(({ line }) => line.length - line.trimStart().length))
  const property = propertyLines.find(({ line }) => line.length - line.trimStart().length === propertyIndent && line.trimStart().startsWith(`${key}:`))
  if (!property) return undefined
  let value = property.line.trimStart().slice(key.length + 1).trim()
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
  return value
}

function widgetLayer(line: number, top: { start: number; end: number } | undefined, bottom: { start: number; end: number } | undefined): WidgetSourceCandidate['layer'] {
  if (top && line > top.start && line < top.end) return 'top'
  if (bottom && line > bottom.start && line < bottom.end) return 'bottom'
  return 'page'
}

function scanWidgetSources(source: string): WidgetSourceCandidate[] {
  const lines = source.split('\n')
  const offsets: number[] = []
  let offset = 0
  for (const line of lines) { offsets.push(offset); offset += line.length + 1 }
  const lvgl = sectionLines(lines, 'lvgl', 0)
  if (!lvgl) return []
  const top = sectionLines(lines.slice(lvgl.start, lvgl.end), 'top_layer')
  const bottom = sectionLines(lines.slice(lvgl.start, lvgl.end), 'bottom_layer')
  const topRange = top ? { start: top.start + lvgl.start, end: top.end + lvgl.start } : undefined
  const bottomRange = bottom ? { start: bottom.start + lvgl.start, end: bottom.end + lvgl.start } : undefined
  const widgetPattern = new RegExp(String.raw`^(\s*)-\s+(${[...supportedWidgets].join('|')}):`)
  const candidates: WidgetSourceCandidate[] = []
  for (let index = lvgl.start + 1; index < lvgl.end; index += 1) {
    const match = widgetPattern.exec(lines[index])
    if (!match) continue
    const indent = match[1].length
    const endLine = widgetBlockEnd(lines, index, lvgl.end, indent)
    const id = directWidgetProperty(lines, index, endLine, indent, 'id')
    const text = directWidgetProperty(lines, index, endLine, indent, 'text')
    const layer = widgetLayer(index, topRange, bottomRange)
    candidates.push({ type: match[2], id, text, layer, start: offsets[index], end: endLine < offsets.length ? offsets[endLine] : source.length, startLine: index, endLine })
  }
  return candidates
}

function assignWidgetSources(source: string, pages: LvglPage[], topLayer: LvglWidget[], bottomLayer: LvglWidget[]): void {
  const candidates = scanWidgetSources(source)
  const used = new Set<WidgetSourceCandidate>()
  const assign = (widgets: LvglWidget[], layer: WidgetSourceCandidate['layer']): void => {
    for (const widget of widgets) {
      const available = candidates.filter((candidate) => candidate.layer === layer && candidate.type === widget.type && !used.has(candidate))
      let candidate = widget.id ? available.find((item) => item.id === widget.id) : undefined
      if (!candidate && widget.text) candidate = available.find((item) => item.text === widget.text)
      candidate ??= available[0]
      if (candidate) {
        widget.sourceRange = { start: candidate.start, end: candidate.end, startLine: candidate.startLine, endLine: candidate.endLine }
        used.add(candidate)
      }
      assign(widget.children, layer)
    }
  }
  assign(pages.flatMap((page) => page.widgets), 'page')
  assign(topLayer, 'top')
  assign(bottomLayer, 'bottom')
}

function discoverAssets(root: YamlMap): ImageAsset[] {
  const entries = Array.isArray(root.image) ? root.image : []
  return entries.flatMap((entry) => {
    const item = asMap(entry)
    const platform = typeof item.platform === 'string' ? item.platform : 'file'
    const id = typeof item.id === 'string' ? item.id : undefined
    if (!id) return []
    const files = Array.isArray(item.files) ? item.files : [item]
    return files.map((fileEntry) => {
      const file = asMap(fileEntry)
      return { id: typeof file.id === 'string' ? file.id : id, platform, file: typeof file.file === 'string' ? file.file : undefined, url: typeof file.url === 'string' ? file.url : undefined, frames: Array.isArray(file.images) ? file.images.filter((frame): frame is string => typeof frame === 'string') : undefined }
    })
  })
}

function defaultMockValue(section: string, item: YamlMap): MockValue {
  if (section === 'binary_sensor' || section === 'switch') return false
  if (section === 'text_sensor') return 'Mock text'
  if (section === 'select') return Array.isArray(item.options) && typeof item.options[0] === 'string' ? item.options[0] : 'Mock option'
  if (section === 'number') {
    const minimum = asNumber(item.min_value) ?? 0
    const maximum = asNumber(item.max_value) ?? 100
    return (minimum + maximum) / 2
  }
  if (item.device_class === 'temperature') return 20
  if (item.device_class === 'humidity') return 50
  return 1
}

function mockEntityId(section: string, item: YamlMap, index: number): string {
  if (typeof item.id === 'string') return item.id
  if (typeof item.entity_id === 'string') return item.entity_id
  return `${section}_${index + 1}`
}

function discoverEntities(root: YamlMap): MockEntity[] {
  return ['sensor', 'text_sensor', 'binary_sensor', 'switch', 'number', 'select'].flatMap((section) => {
    const entries = Array.isArray(root[section]) ? root[section] : []
    return entries.flatMap((entry, index) => {
      const item = asMap(entry)
      const platform = asMap(item.platform)
      const id = mockEntityId(section, item, index)
      let entityId: string | undefined
      if (typeof platform.entity_id === 'string') entityId = platform.entity_id
      else if (typeof item.entity_id === 'string') entityId = item.entity_id
      const value = section === 'binary_sensor' || section === 'switch' ? false : ''
      return [{ id, type: section, entityId, value, defaultValue: defaultMockValue(section, item) }]
    })
  })
}

function discoverAutomations(root: YamlMap): WidgetAutomation[] {
  return ['sensor', 'text_sensor', 'binary_sensor', 'switch', 'number', 'select'].flatMap((section) => {
    const entries = Array.isArray(root[section]) ? root[section] : []
    return entries.flatMap((entry, index) => {
      const item = asMap(entry)
      const sourceId = mockEntityId(section, item, index)
      const trigger = asMap(item.on_value)
      const actions = Array.isArray(trigger.then) ? trigger.then : []
      return actions.flatMap((action): WidgetAutomation[] => {
        const actionMap = asMap(action)
        const labelUpdate = asMap(actionMap['lvgl.label.update'])
        if (typeof labelUpdate.id === 'string') {
          return (['text', 'text_color'] as const).flatMap((property) => labelUpdate[property] === undefined ? [] : [{ sourceId, targetWidgetId: labelUpdate.id as string, property, value: labelUpdate[property] }])
        }
        const switchUpdate = asMap(actionMap['lvgl.switch.update'])
        const checked = asMap(switchUpdate.state).checked
        if (typeof switchUpdate.id === 'string' && checked !== undefined) return [{ sourceId, targetWidgetId: switchUpdate.id, property: 'checked', value: checked }]
        return []
      })
    })
  })
}

function visitWidgets(widgets: LvglWidget[], visitor: (widget: LvglWidget) => void): void {
  for (const widget of widgets) {
    visitor(widget)
    visitWidgets(widget.children, visitor)
  }
}

function discoverWidgetMocks(pages: LvglPage[], topLayer: LvglWidget[], bottomLayer: LvglWidget[]): MockEntity[] {
  const mocks: MockEntity[] = []
  visitWidgets([...pages.flatMap((page) => page.widgets), ...topLayer, ...bottomLayer], (widget) => {
    if (widget.type !== 'switch' || !widget.id) return
    const initial = widget.raw.state === true || widget.raw.checked === true
    mocks.push({ id: widget.id!, type: 'lvgl_switch', targetWidgetId: widget.id, value: initial, defaultValue: initial })
  })
  return mocks
}

function discoverScriptMocks(root: YamlMap): MockEntity[] {
  const scripts = Array.isArray(root.script) ? root.script : []
  return scripts.flatMap((entry, scriptIndex) => {
    const script = asMap(entry)
    const scriptId = typeof script.id === 'string' ? script.id : `script_${scriptIndex + 1}`
    const actions = Array.isArray(script.then) ? script.then : []
    return actions.flatMap((action) => {
      const update = asMap(asMap(action)['lvgl.label.update'])
      if (typeof update.id !== 'string') return []
      return [{ id: `${scriptId}.${update.id}`, type: 'script_value', targetWidgetId: update.id, value: '', defaultValue: 'Mock text' }]
    })
  })
}

function discoverFontSizes(root: YamlMap): Record<string, number> {
  const entries = Array.isArray(root.font) ? root.font : []
  return Object.fromEntries(entries.flatMap((entry) => {
    const font = asMap(entry)
    return typeof font.id === 'string' && typeof font.size === 'number' ? [[font.id, font.size]] : []
  }))
}

function normalizeFontSource(value: unknown, inheritedWeight = 400): FontSource | undefined {
  if (typeof value === 'string') {
    if (value.startsWith('gfonts://')) return { type: 'gfonts', family: value.slice('gfonts://'.length), weight: inheritedWeight }
    return { type: 'local', path: value, weight: inheritedWeight }
  }
  const source = asMap(value)
  const weight = asNumber(source.weight) ?? inheritedWeight
  if (source.type === 'gfonts' && typeof source.family === 'string') return { type: 'gfonts', family: source.family, weight }
  if (typeof source.path === 'string') return { type: 'local', path: source.path, weight }
  return undefined
}

function discoverFonts(root: YamlMap): FontDefinition[] {
  const entries = Array.isArray(root.font) ? root.font : []
  return entries.flatMap((entry) => {
    const font = asMap(entry)
    if (typeof font.id !== 'string' || typeof font.size !== 'number') return []
    const source = normalizeFontSource(font.file, asNumber(font.weight) ?? 400)
    if (!source) return []
    const extras = Array.isArray(font.extras)
      ? font.extras.flatMap((extra) => {
          const extraRecord = asMap(extra)
          const normalized = normalizeFontSource(extraRecord.file, asNumber(extraRecord.weight) ?? 400)
          return normalized ? [normalized] : []
        })
      : []
    return [{ id: font.id, size: font.size, source, extras }]
  })
}

function normalizeSource(source: string, sourceName: string, files: Record<string, string>, substitutions: Record<string, string>, diagnostics: Diagnostic[]): YamlMap {
  const expanded = replaceSubstitutions(resolveIncludes(source, sourceName, files, diagnostics, [sourceName]), substitutions)
  try { return asMap(load(normalizeTags(expanded))) }
  catch (error) { diagnostics.push({ severity: 'error', message: error instanceof Error ? error.message : 'YAML could not be parsed.', source: sourceName }); return {} }
}

export function parseProjectYaml(source: string, sourceName = 'editor.yaml', files: Record<string, string> = {}): VisualizerModel {
  const diagnostics: Diagnostic[] = []
  const first = normalizeSource(source, sourceName, files, {}, diagnostics)
  const substitutions = Object.fromEntries(Object.entries(asMap(first.substitutions)).map(([key, value]) => [key, typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : '']))
  let root = normalizeSource(source, sourceName, files, substitutions, diagnostics)
  const packages = asMap(root.packages)
  for (const packagePath of Object.values(packages)) {
    if (typeof packagePath !== 'string') continue
    const packageSource = files[packagePath]
    if (packageSource) root = mergeMaps(normalizeSource(packageSource, packagePath, files, substitutions, diagnostics), root)
    else diagnostics.push({ severity: 'warning', message: `Package file not uploaded: ${packagePath}`, source: sourceName })
  }
  const lvgl = asMap(root.lvgl)
  const display = asMap(root.display)
  let pagesValue: unknown[] = []
  if (Array.isArray(lvgl.pages)) pagesValue = lvgl.pages
  else if (lvgl.pages && typeof lvgl.pages === 'object') pagesValue = [lvgl.pages]
  const pages: LvglPage[] = pagesValue.map((page, index) => {
    const pageRecord = asMap(page)
    return { id: typeof pageRecord.id === 'string' ? pageRecord.id : `page_${index + 1}`, width: asNumber(pageRecord.width), height: asNumber(pageRecord.height), widgets: listWidgets(pageRecord.widgets, diagnostics, sourceName), raw: pageRecord }
  })
  if (!pages.length && Array.isArray(lvgl.widgets)) pages.push({ id: 'main', widgets: listWidgets(lvgl.widgets, diagnostics, sourceName), raw: lvgl })
  if (!pages.length) diagnostics.push({ severity: 'info', message: 'No LVGL pages were found yet.', source: sourceName })
  const topLayer = listWidgets(lvgl.top_layer, diagnostics, sourceName)
  const bottomLayer = listWidgets(lvgl.bottom_layer, diagnostics, sourceName)
  assignWidgetSources(source, pages, topLayer, bottomLayer)
  const declaredEntities = discoverEntities(root)
  const mockEntities = [...declaredEntities, ...discoverWidgetMocks(pages, topLayer, bottomLayer), ...discoverScriptMocks(root)]
  const uniqueEntities = [...new Map(mockEntities.map((entity) => {
    const existing = mockEntities.find((candidate) => candidate.id === entity.id)
    const target = mockEntities.find((candidate) => candidate.id === entity.id && candidate.targetWidgetId)?.targetWidgetId
    return [entity.id, { ...existing, targetWidgetId: target ?? existing?.targetWidgetId } as MockEntity]
  })).values()]
  return {
    pages,
    topLayer,
    bottomLayer,
    displayWidth: asNumber(display.width) ?? asNumber(root.width),
    displayHeight: asNumber(display.height) ?? asNumber(root.height),
    rotation: asNumber(display.rotation) ?? asNumber(lvgl.rotation),
    fontSizes: discoverFontSizes(root),
    fonts: discoverFonts(root),
    assets: discoverAssets(root),
    entities: uniqueEntities,
    automations: discoverAutomations(root),
    substitutions,
    diagnostics,
  }
}

export function parseVisualizerYaml(source: string, sourceName = 'editor.yaml'): VisualizerModel { return parseProjectYaml(source, sourceName) }

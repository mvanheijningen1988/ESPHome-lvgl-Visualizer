import { isMap, isScalar, isSeq, parseDocument, type Scalar } from 'yaml'
import type { Diagnostic, FontDefinition, FontSource, ImageAsset, LvglPage, LvglWidget, MockEntity, MockValue, VisualizerModel, WidgetAutomation } from './model'

const supportedWidgets = new Set(['obj', 'container', 'label', 'button', 'switch', 'bar', 'image', 'animimg', 'arc', 'checkbox', 'dropdown', 'slider', 'spinner', 'textarea', 'qrcode', 'meter', 'line', 'led', 'roller', 'spinbox', 'buttonmatrix', 'keyboard', 'tabview', 'tileview', 'msgbox', 'canvas'])

type YamlMap = Record<string, unknown>

function asMap(value: unknown): YamlMap { return value && typeof value === 'object' && !Array.isArray(value) ? value as YamlMap : {} }
function asNumber(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) ? value : undefined }
function normalizeTags(source: string): string { return source.replace(/!(?:lambda|include|secret)\b/g, '') }
function substitutionEnd(value: string, start: number): number {
  let depth = 1
  for (let index = start + 2; index < value.length; index += 1) {
    if (value.startsWith('${', index)) { depth += 1; index += 1 }
    else if (value[index] === '}') {
      depth -= 1
      if (depth === 0) return index + 1
    }
  }
  return -1
}

function substituteScalar(value: string, substitutions: Record<string, unknown>, diagnostics: Diagnostic[], source: string, line: number, stack: string[] = []): unknown {
  const parts: Array<{ text: string; value?: unknown; resolved: boolean }> = []
  let cursor = 0
  while (cursor < value.length) {
    const start = value.indexOf('$', cursor)
    if (start < 0 || value[start + 1] === '$') break
    const end = value[start + 1] === '{' ? substitutionEnd(value, start) : start + 1 + (/^[A-Za-z_][\w.-]*/.exec(value.slice(start + 1))?.[0].length ?? 0)
    if (end <= start + 1) { cursor = start + 1; continue }
    const expression = value.slice(start + (value[start + 1] === '{' ? 2 : 1), end - (value[end - 1] === '}' ? 1 : 0)).trim()
    parts.push({ text: value.slice(cursor, start), resolved: false })
    const token = value.slice(start, end)
    if (!/^[A-Za-z_][\w.-]*$/.test(expression) && !expression.includes('${')) {
      diagnostics.push({ severity: 'warning', message: `Jinja substitution expression is not supported: ${token}`, source, line })
      parts.push({ text: token, resolved: false })
    } else {
      const key = substituteScalar(expression, substitutions, diagnostics, source, line, stack)
      const resolvedKey = String(key)
      if (stack.includes(resolvedKey)) {
        diagnostics.push({ severity: 'warning', message: `Cyclic substitution: ${[...stack, resolvedKey].join(' → ')}`, source, line })
        parts.push({ text: token, resolved: false })
      } else if (!Object.hasOwn(substitutions, resolvedKey)) {
        diagnostics.push({ severity: 'warning', message: `Unknown substitution: ${resolvedKey}`, source, line })
        parts.push({ text: token, resolved: false })
      } else {
        const replacement = substitutions[resolvedKey]
        const resolvedValue = typeof replacement === 'string'
          ? substituteScalar(replacement, substitutions, diagnostics, source, line, [...stack, resolvedKey])
          : replacement
        parts.push({ text: String(resolvedValue ?? ''), value: resolvedValue, resolved: true })
      }
    }
    cursor = end
  }
  if (!parts.length) return value
  parts.push({ text: value.slice(cursor), resolved: false })
  if (parts.length === 3 && parts[0].text === '' && parts[1].resolved && parts[2].text === '') return parts[1].value
  return parts.map((part) => part.text).join('')
}

function substituteDocument(sourceText: string, substitutions: Record<string, unknown>, diagnostics: Diagnostic[], source: string, origins?: SourceLine[]): YamlMap {
  const document = parseDocument(normalizeTags(sourceText), { merge: true, uniqueKeys: false, prettyErrors: true })
  if (document.errors.length) throw document.errors[0]
  const visit = (node: unknown): void => {
    if (isScalar(node)) {
      if (typeof node.value === 'string') {
        const position = node.range?.[0] ?? 0
        const lineIndex = sourceText.slice(0, position).split('\n').length - 1
        const origin = origins?.[lineIndex]
        const line = origin ? origin.line + 1 : lineIndex + 1
        node.value = substituteScalar(node.value, origin?.substitutions ?? substitutions, diagnostics, origin?.sourceFile ?? source, line) as Scalar<unknown>['value']
      }
    } else if (isSeq(node)) node.items.forEach(visit)
    else if (isMap(node)) {
      const resolvedKeys = new Set<string>()
      for (const pair of node.items) {
        visit(pair.key)
        visit(pair.value)
        const keyNode = isScalar(pair.key) ? pair.key : undefined
        const key = keyNode ? String(keyNode.value) : undefined
        if (key !== undefined && resolvedKeys.has(key)) {
          const position = keyNode?.range?.[0] ?? 0
          const lineIndex = sourceText.slice(0, position).split('\n').length - 1
          const origin = origins?.[lineIndex]
          const line = origin ? origin.line + 1 : lineIndex + 1
          diagnostics.push({ severity: 'error', message: `Substitution creates duplicate YAML key: ${key}`, source: origin?.sourceFile ?? source, line })
        }
        if (key !== undefined) resolvedKeys.add(key)
      }
    }
  }
  visit(document.contents)
  return asMap(document.toJS())
}
function mergeMaps(base: YamlMap, extra: YamlMap): YamlMap {
  const result: YamlMap = { ...base }
  for (const [key, value] of Object.entries(extra)) {
    if (Array.isArray(result[key]) && Array.isArray(value)) result[key] = [...result[key] as unknown[], ...value]
    else if (result[key] && typeof result[key] === 'object' && value && typeof value === 'object' && !Array.isArray(value)) result[key] = mergeMaps(asMap(result[key]), asMap(value))
    else result[key] = value
  }
  return result
}

type SourceLine = { sourceFile: string; line: number; offset: number; length: number; hasNewline: boolean; substitutions: YamlMap }
type ExpandedSource = { text: string; origins: SourceLine[] }

function includeSpecification(tail: string, lines: string[], lineIndex: number, includeIndent: number): { path: string; variables: YamlMap; consumedThrough: number } | undefined {
  let specification: unknown
  let consumedThrough = lineIndex
  if (tail.startsWith('{')) {
    const document = parseDocument(tail, { merge: true, uniqueKeys: false })
    if (document.errors.length) return undefined
    specification = document.toJS()
  } else if (!tail) {
    let end = lineIndex + 1
    while (end < lines.length) {
      const candidate = lines[end]
      if (!candidate.trim()) { end += 1; continue }
      const indent = candidate.length - candidate.trimStart().length
      if (indent <= includeIndent) break
      end += 1
    }
    if (end > lineIndex + 1) {
      const contentIndent = Math.min(...lines.slice(lineIndex + 1, end).filter((line) => line.trim()).map((line) => line.length - line.trimStart().length))
      const content = lines.slice(lineIndex + 1, end).map((line) => line.slice(contentIndent)).join('\n')
      const document = parseDocument(content, { merge: true, uniqueKeys: false })
      if (document.errors.length) return undefined
      specification = document.toJS()
      consumedThrough = end - 1
    }
  } else return { path: tail.split(/[ \t#]/, 1)[0].replace(/^['"]|['"]$/g, ''), variables: {}, consumedThrough }
  const record = asMap(specification)
  return typeof record.file === 'string' ? { path: record.file, variables: asMap(record.vars), consumedThrough } : undefined
}

function resolveIncludes(source: string, sourceName: string, files: Record<string, string>, diagnostics: Diagnostic[], stack: string[], substitutions: YamlMap = {}): ExpandedSource {
  const inputLines = source.split('\n')
  const inputOrigins: SourceLine[] = []
  let sourceOffset = 0
  inputLines.forEach((line, index) => {
    inputOrigins.push({ sourceFile: sourceName, line: index, offset: sourceOffset, length: line.length, hasNewline: index < inputLines.length - 1, substitutions })
    sourceOffset += line.length + 1
  })
  const outputLines: string[] = []
  const outputOrigins: SourceLine[] = []
  let consumedThrough = -1
  inputLines.forEach((line, lineIndex) => {
    if (lineIndex <= consumedThrough) return
    const marker = line.indexOf('!include')
    if (marker < 0 || line.slice(0, marker).includes('#')) {
      outputLines.push(line)
      outputOrigins.push(inputOrigins[lineIndex])
      return
    }
    const prefix = line.slice(0, marker)
    let indentationLength = 0
    while (indentationLength < prefix.length && (prefix[indentationLength] === ' ' || prefix[indentationLength] === '\t')) indentationLength += 1
    const indentation = prefix.slice(0, indentationLength)
    const valuePrefix = prefix.slice(indentationLength)
    const includeTail = line.slice(marker + '!include'.length).trim()
    const specification = includeSpecification(includeTail, inputLines, lineIndex, indentationLength)
    if (!specification) {
      diagnostics.push({ severity: 'warning', message: 'Unsupported !include syntax; expected a filename or file/vars mapping.', source: sourceName, line: lineIndex + 1 })
      outputLines.push(`${indentation}${valuePrefix}null`)
      outputOrigins.push(inputOrigins[lineIndex])
      return
    }
    consumedThrough = specification.consumedThrough
    const normalized = specification.path
    const resolvedIncludePath = String(substituteScalar(normalized, substitutions, diagnostics, sourceName, lineIndex + 1))
    const relativePath = `${sourceName.split('/').slice(0, -1).join('/')}/${resolvedIncludePath}`.replace(/^\//, '')
    const targetName = files[relativePath] !== undefined ? relativePath : resolvedIncludePath
    const target = files[targetName]
    if (stack.includes(targetName)) {
      diagnostics.push({ severity: 'error', message: `Cyclic !include detected: ${[...stack, targetName].join(' → ')}`, source: sourceName, line: lineIndex + 1 })
      outputLines.push(`${indentation}${valuePrefix}null`)
      outputOrigins.push(inputOrigins[lineIndex])
      return
    }
    if (target === undefined) {
      diagnostics.push({ severity: 'warning', message: `Included file not uploaded: ${normalized}`, source: sourceName, line: lineIndex + 1 })
      outputLines.push(`${indentation}${valuePrefix}null`)
      outputOrigins.push(inputOrigins[lineIndex])
      return
    }
    const includeVariables = Object.fromEntries(Object.entries(specification.variables).map(([key, value]) => [key, typeof value === 'string' ? substituteScalar(value, substitutions, diagnostics, sourceName, lineIndex + 1) : value]))
    const scopedSubstitutions = { ...substitutions, ...includeVariables }
    const nested = resolveIncludes(target, targetName, files, diagnostics, [...stack, targetName], scopedSubstitutions)
    const includedFirstLine = nested.text.split('\n').find((includedLine) => includedLine.trim() && !includedLine.trimStart().startsWith('#')) ?? ''
    const blockMappingValue = /^\s*[^:]+:\s+$/.test(valuePrefix) && /^[^\s#][^:]*\s*:/.test(includedFirstLine)
    if (blockMappingValue) {
      outputLines.push(`${indentation}${valuePrefix.trimEnd()}`)
      outputOrigins.push(inputOrigins[lineIndex])
      nested.text.split('\n').forEach((includedLine, index) => {
        outputLines.push(`${indentation}${' '.repeat(valuePrefix.length)}${includedLine}`)
        outputOrigins.push(nested.origins[index] ?? inputOrigins[lineIndex])
      })
      return
    }
    const continuationIndent = `${indentation}${' '.repeat(valuePrefix.length)}`
    nested.text.split('\n').forEach((includedLine, index) => {
      outputLines.push(index === 0 ? `${indentation}${valuePrefix}${includedLine}` : `${continuationIndent}${includedLine}`)
      outputOrigins.push(nested.origins[index] ?? inputOrigins[lineIndex])
    })
  })
  return { text: outputLines.join('\n'), origins: outputOrigins }
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
  if (typeof raw.text === 'string') text = raw.text
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

function scanWidgetSources(expanded: ExpandedSource): WidgetSourceCandidate[] {
  const lines = expanded.text.split('\n')
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
    const startOrigin = expanded.origins[index]
    let endIndex = Math.min(lines.length - 1, Math.max(index, endLine - 1))
    while (endIndex > index && expanded.origins[endIndex]?.sourceFile !== startOrigin?.sourceFile) endIndex -= 1
    const endOrigin = expanded.origins[endIndex]
    if (!startOrigin || !endOrigin) continue
    candidates.push({
      type: match[2], id, text, layer,
      start: startOrigin.offset,
      end: endOrigin.offset + endOrigin.length + (endOrigin.hasNewline ? 1 : 0),
      startLine: startOrigin.line,
      endLine: endOrigin.line + 1,
      sourceFile: startOrigin.sourceFile,
    })
  }
  return candidates
}

function assignWidgetSources(candidates: WidgetSourceCandidate[], pages: LvglPage[], topLayer: LvglWidget[], bottomLayer: LvglWidget[]): void {
  const used = new Set<WidgetSourceCandidate>()
  let instanceIndex = 0
  const instanceOccurrences = new Map<string, number>()
  const assign = (widgets: LvglWidget[], layer: WidgetSourceCandidate['layer']): void => {
    for (const widget of widgets) {
      const available = candidates.filter((candidate) => candidate.layer === layer && candidate.type === widget.type && !used.has(candidate))
      let candidate = widget.id ? available.find((item) => item.id === widget.id) : undefined
      if (!candidate && widget.text) candidate = available.find((item) => item.text === widget.text)
      candidate ??= available[0]
      if (candidate) {
        widget.sourceRange = { start: candidate.start, end: candidate.end, startLine: candidate.startLine, endLine: candidate.endLine, sourceFile: candidate.sourceFile }
        const identity = widget.id
          ? `${layer}:${candidate.sourceFile}:id:${widget.id}`
          : `${layer}:${candidate.sourceFile}:offset:${candidate.start}:${widget.type}`
        const occurrence = instanceOccurrences.get(identity) ?? 0
        instanceOccurrences.set(identity, occurrence + 1)
        widget.instanceKey = `${identity}:${occurrence}`
        used.add(candidate)
      } else widget.instanceKey = `${layer}:unmapped:${instanceIndex++}`
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

function normalizeSource(source: string, sourceName: string, files: Record<string, string>, substitutions: YamlMap, diagnostics: Diagnostic[]): YamlMap {
  const expanded = resolveIncludes(source, sourceName, files, diagnostics, [sourceName], substitutions)
  try { return substituteDocument(expanded.text, substitutions, diagnostics, sourceName, expanded.origins) }
  catch (error) { diagnostics.push({ severity: 'error', message: error instanceof Error ? error.message : 'YAML could not be parsed.', source: sourceName }); return {} }
}

export function parseProjectYaml(source: string, sourceName = 'editor.yaml', files: Record<string, string> = {}): VisualizerModel {
  const diagnostics: Diagnostic[] = []
  const first = normalizeSource(source, sourceName, files, {}, [])
  const substitutions = asMap(first.substitutions)
  let root = normalizeSource(source, sourceName, files, substitutions, diagnostics)
  const packageCandidates: WidgetSourceCandidate[] = []
  const packageReferences = Array.isArray(root.packages) ? root.packages : Object.values(asMap(root.packages))
  for (const packageReference of packageReferences) {
    if (packageReference && typeof packageReference === 'object' && !Array.isArray(packageReference)) {
      root = mergeMaps(asMap(packageReference), root)
      continue
    }
    if (typeof packageReference !== 'string') continue
    const packagePath = packageReference
    const packageSource = files[packagePath]
    if (packageSource) {
      packageCandidates.push(...scanWidgetSources(resolveIncludes(packageSource, packagePath, files, [], [packagePath], substitutions)))
      root = mergeMaps(normalizeSource(packageSource, packagePath, files, substitutions, diagnostics), root)
    }
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
  const expandedRoot = resolveIncludes(source, sourceName, files, [], [sourceName], substitutions)
  const includedFiles = [...new Set(expandedRoot.origins.map((origin) => origin.sourceFile).filter((file) => file !== sourceName))]
  const includedCandidates = includedFiles.flatMap((file) => files[file]
    ? scanWidgetSources(resolveIncludes(files[file], file, files, [], [file], substitutions))
    : [])
  assignWidgetSources([...scanWidgetSources(expandedRoot), ...includedCandidates, ...packageCandidates], pages, topLayer, bottomLayer)
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

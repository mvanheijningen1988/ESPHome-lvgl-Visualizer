import type { MockValue, VisualizerModel, WidgetAutomation } from './model'

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

export function evaluateAutomation(automation: WidgetAutomation, sourceValue: MockValue): MockValue | undefined {
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
  if (/^return\s+x\s*;?$/.test(selected.trim())) return sourceValue
  const stringMatch = /(?:std::string\()?['"]([^'"]*)['"]/.exec(selected)
  return stringMatch?.[1]
}

export function resolveWidgetMocks(model: VisualizerModel, mockValues: Record<string, MockValue>): { values: Record<string, MockValue>; textColors: Record<string, string | number> } {
  const values = Object.fromEntries(model.entities.flatMap((entity) => entity.targetWidgetId && Object.hasOwn(mockValues, entity.id) ? [[entity.targetWidgetId, mockValues[entity.id]]] : []))
  const textColors: Record<string, string | number> = {}
  for (const automation of model.automations) {
    const sourceValue = mockValues[automation.sourceId]
    if (sourceValue === undefined) continue
    const result = evaluateAutomation(automation, sourceValue)
    if (result === undefined) continue
    if (automation.property === 'text_color' && (typeof result === 'string' || typeof result === 'number')) textColors[automation.targetWidgetId] = result
    else values[automation.targetWidgetId] = result
  }
  return { values, textColors }
}
export type DiagnosticSeverity = 'error' | 'warning' | 'info'

export interface Diagnostic {
  severity: DiagnosticSeverity
  message: string
  source?: string
  line?: number
}

export interface LvglWidget {
  type: string
  id?: string
  text?: string
  value?: number
  x?: number
  y?: number
  width?: number | string
  height?: number | string
  color?: string
  source?: string
  sourceRange?: { start: number; end: number; startLine: number; endLine: number }
  children: LvglWidget[]
  raw: Record<string, unknown>
}

export interface ImageAsset {
  id: string
  platform: string
  file?: string
  url?: string
  frames?: string[]
}

export interface FontSource {
  type: 'gfonts' | 'local'
  family?: string
  path?: string
  weight: number
}

export interface FontDefinition {
  id: string
  size: number
  source: FontSource
  extras: FontSource[]
}

export type MockValue = string | number | boolean

export interface MockEntity {
  id: string
  type: string
  entityId?: string
  targetWidgetId?: string
  value: MockValue
  defaultValue?: MockValue
}

export interface WidgetAutomation {
  sourceId: string
  targetWidgetId: string
  property: 'text' | 'text_color' | 'checked'
  value: unknown
}

export interface LvglPage {
  id: string
  width?: number
  height?: number
  widgets: LvglWidget[]
  raw: Record<string, unknown>
}

export interface VisualizerModel {
  pages: LvglPage[]
  topLayer: LvglWidget[]
  bottomLayer: LvglWidget[]
  displayWidth?: number
  displayHeight?: number
  rotation?: number
  fontSizes: Record<string, number>
  fonts: FontDefinition[]
  assets: ImageAsset[]
  entities: MockEntity[]
  automations: WidgetAutomation[]
  substitutions: Record<string, string>
  diagnostics: Diagnostic[]
}

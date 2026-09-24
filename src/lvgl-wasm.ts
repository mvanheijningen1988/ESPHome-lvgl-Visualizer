import type { FontDefinition, LvglWidget, MockValue, VisualizerModel } from './model'
import type { LoadedFont } from './font-loader'
import type { LoadedImage } from './image-loader'

type LvglModule = {
  ccall: (name: string, returnType: string | null, argumentTypes: string[], args: unknown[]) => number | void
  _malloc: (size: number) => number
  _free: (pointer: number) => void
  writeArrayToMemory: (array: Uint8Array, pointer: number) => void
}
type ModuleFactory = (options: { canvas: HTMLCanvasElement }) => Promise<LvglModule>

export type RenderedWidgetBounds = { widget: LvglWidget; x: number; y: number; width: number; height: number }
type WidgetGeometry = { x: number; y: number; width: number; height: number }

declare global {
  interface Window {
    wallDisplayLvglFactory?: Promise<ModuleFactory>
  }
}

function integer(value: number | string | undefined, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

function color(value: unknown, fallback = -1): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return fallback
  const normalized = value.trim().replace(/^#|^0x/i, '')
  const parsed = Number.parseInt(normalized, 16)
  return Number.isFinite(parsed) ? parsed : fallback
}

function opacity(value: unknown): number {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'transp' || normalized === 'transparent') return 0
    if (normalized === 'cover' || normalized === 'opaque') return 255
    if (normalized.endsWith('%')) return Math.round(Math.max(0, Math.min(100, Number.parseFloat(normalized))) * 2.55)
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) return -1
  return Math.round(Math.max(0, Math.min(255, value <= 1 ? value * 255 : value)))
}

function optionalInteger(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : -1
}

function dimension(value: number | string | undefined): string {
  return value === undefined ? '' : String(value)
}

function switchIsChecked(widget: LvglWidget, mockValue: MockValue | undefined): boolean {
  if (typeof mockValue === 'boolean') return mockValue
  return widget.raw.state === true || widget.raw.checked === true
}

export class WasmLvglRenderer {
  private readonly module: LvglModule
  private readonly canvas: HTMLCanvasElement
  private width = 0
  private height = 0
  private fontSignature = ''
  private imageSignature = ''
  private widgetHandles: Array<{ widget: LvglWidget; handle: number }> = []
  private widgetBounds: RenderedWidgetBounds[] = []

  private constructor(module: LvglModule, canvas: HTMLCanvasElement) {
    this.module = module
    this.canvas = canvas
  }

  static async create(canvas: HTMLCanvasElement): Promise<WasmLvglRenderer> {
    const factory = await WasmLvglRenderer.waitForFactory()
    if (!factory) throw new Error('LVGL runtime loader was not initialized.')
    const module = await factory({ canvas })
    const renderer = new WasmLvglRenderer(module, canvas)
    renderer.initialize(480, 480)
    return renderer
  }

  private static waitForFactory(): Promise<ModuleFactory | undefined> {
    return new Promise((resolve) => {
      const started = performance.now()
      const check = (): void => {
        if (window.wallDisplayLvglFactory !== undefined) {
          window.wallDisplayLvglFactory.then(resolve).catch(() => resolve(undefined))
          return
        }
        if (performance.now() - started > 5000) {
          resolve(undefined)
          return
        }
        window.setTimeout(check, 25)
      }
      check()
    })
  }

  render(model: VisualizerModel, pageId: string, widgetValues: Record<string, MockValue> = {}, widgetTextColors: Record<string, string | number> = {}): void {
    const page = model.pages.find((candidate) => candidate.id === pageId) ?? model.pages[0]
    if (!page) return
    const width = page.width ?? model.displayWidth ?? 480
    const height = page.height ?? model.displayHeight ?? 480
    if (width !== this.width || height !== this.height) {
      if (this.width > 0) this.call('lvgl_bridge_destroy', null, [], [])
      this.call('lvgl_bridge_init', 'number', ['number', 'number'], [width, height])
      this.width = width
      this.height = height
    }
    this.canvas.width = width
    this.canvas.height = height
    this.canvas.style.aspectRatio = `${width} / ${height}`
    this.call('lvgl_bridge_reset', null, [], [])
    this.widgetHandles = []
    this.widgetBounds = []
    this.call('lvgl_bridge_configure_screen', null, ['number', 'number', 'number', 'number'], [
      color(page.raw.bg_color ?? 0x000000), opacity(page.raw.bg_opa ?? 'cover'),
      optionalInteger(page.raw.border_width ?? 0), optionalInteger(page.raw.pad_all ?? 0),
    ])
    const bottomLayer = this.call('lvgl_bridge_get_bottom_layer', 'number', [], [])
    const topLayer = this.call('lvgl_bridge_get_top_layer', 'number', [], [])
    for (const widget of model.bottomLayer) this.createWidget(widget, bottomLayer, model, widgetValues, widgetTextColors)
    for (const widget of page.widgets) this.createWidget(widget, 0, model, widgetValues, widgetTextColors)
    for (const widget of model.topLayer) this.createWidget(widget, topLayer, model, widgetValues, widgetTextColors)
    this.call('lvgl_bridge_update_layout', null, [], [])
    this.widgetBounds = this.widgetHandles.map(({ widget, handle }) => ({
      widget,
      x: this.call('lvgl_bridge_get_obj_x', 'number', ['number'], [handle]),
      y: this.call('lvgl_bridge_get_obj_y', 'number', ['number'], [handle]),
      width: this.call('lvgl_bridge_get_obj_width', 'number', ['number'], [handle]),
      height: this.call('lvgl_bridge_get_obj_height', 'number', ['number'], [handle]),
    }))
  }

  getWidgetBounds(): readonly RenderedWidgetBounds[] { return this.widgetBounds }

  registerFonts(fonts: LoadedFont[]): void {
    const signature = JSON.stringify(fonts.map(({ definition, sources }) => [definition, sources.map((bytes) => {
      const view = new Uint8Array(bytes)
      return [view.byteLength, view[0], view[view.byteLength - 1]]
    })]))
    if (signature === this.fontSignature) return
    this.call('lvgl_bridge_reset', null, [], [])
    this.call('lvgl_bridge_clear_fonts', null, [], [])
    for (const loaded of fonts) {
      loaded.sources.forEach((bytes, index) => this.registerFontSource(loaded.definition, bytes, index > 0))
    }
    this.fontSignature = signature
  }

  registerImages(images: LoadedImage[]): void {
    const signature = JSON.stringify(images.map((image) => [image.id, image.width, image.height, image.pixels.byteLength, image.objectUrl]))
    if (signature === this.imageSignature) return
    this.call('lvgl_bridge_reset', null, [], [])
    this.call('lvgl_bridge_clear_images', null, [], [])
    for (const image of images) {
      const pointer = this.module._malloc(image.pixels.byteLength)
      this.module.writeArrayToMemory(image.pixels, pointer)
      const registered = this.call('lvgl_bridge_register_image', 'number', ['string', 'number', 'number', 'number', 'number'], [image.id, pointer, image.pixels.byteLength, image.width, image.height])
      if (!registered) this.module._free(pointer)
    }
    this.imageSignature = signature
  }

  private registerFontSource(definition: FontDefinition, bytes: ArrayBuffer, fallback: boolean): void {
    const pointer = this.module._malloc(bytes.byteLength)
    this.module.writeArrayToMemory(new Uint8Array(bytes), pointer)
    const registered = this.call('lvgl_bridge_register_font', 'number', ['string', 'number', 'number', 'number', 'number'], [definition.id, pointer, bytes.byteLength, definition.size, fallback ? 1 : 0])
    if (!registered) this.module._free(pointer)
  }

  private initialize(width: number, height: number): void {
    this.call('lvgl_bridge_init', 'number', ['number', 'number'], [width, height])
    this.width = width
    this.height = height
  }

  private createWidget(widget: LvglWidget, parent: number, model: VisualizerModel, widgetValues: Record<string, MockValue>, widgetTextColors: Record<string, string | number>): number {
    const x = integer(widget.x, 0)
    const y = integer(widget.y, 0)
    const width = integer(widget.width, widget.type === 'switch' ? 50 : 120)
    const height = integer(widget.height, widget.type === 'switch' ? 25 : 48)
    const mockValue = widget.id ? widgetValues[widget.id] : undefined
    const text = mockValue !== undefined && typeof mockValue !== 'boolean' ? String(mockValue) : widget.text ?? ''
    const handle = this.createNativeWidget(widget, parent, { x, y, width, height }, text, mockValue)
    const raw = widget.raw
    const fontId = typeof raw.text_font === 'string' ? raw.text_font : ''
    const configuredWidth = widget.width ?? (widget.type === 'switch' ? width : undefined)
    const configuredHeight = widget.height ?? (widget.type === 'switch' ? height : undefined)
    this.call('lvgl_bridge_configure_obj', null,
      ['number', 'string', 'string', 'number', 'number', 'string', 'number', 'number', 'number', 'number', 'number', 'number', 'number', 'string'],
      [handle, dimension(configuredWidth), dimension(configuredHeight), x, y, typeof raw.align === 'string' ? raw.align.toLowerCase() : '',
        color(raw.bg_color), opacity(raw.bg_opa), optionalInteger(raw.border_width), optionalInteger(raw.radius), optionalInteger(raw.pad_all),
        color(widget.id && widgetTextColors[widget.id] !== undefined ? widgetTextColors[widget.id] : raw.text_color), model.fontSizes[fontId] ?? optionalInteger(raw.text_font), fontId])
    if (raw.scrollable === false) this.call('lvgl_bridge_set_scrollable', null, ['number', 'number'], [handle, 0])
    this.widgetHandles.push({ widget, handle })
    for (const child of widget.children) this.createWidget(child, handle, model, widgetValues, widgetTextColors)
    return handle
  }

  private createNativeWidget(widget: LvglWidget, parent: number, geometry: WidgetGeometry, text: string, mockValue: MockValue | undefined): number {
    const { x, y, width, height } = geometry
    if (widget.type === 'label') return this.call('lvgl_bridge_create_label', 'number', ['number', 'string', 'number', 'number'], [parent, text, x, y])
    if (widget.type === 'image') return this.call('lvgl_bridge_create_image', 'number', ['number', 'string', 'number', 'number', 'number', 'number'], [parent, widget.source ?? '', x, y, width, height])
    if (widget.type === 'switch') {
      const checked = switchIsChecked(widget, mockValue)
      return this.call('lvgl_bridge_create_switch', 'number', ['number', 'number', 'number', 'number', 'number', 'number'], [parent, x, y, width, height, checked ? 1 : 0])
    }
    if (widget.type === 'button') return this.call('lvgl_bridge_create_button', 'number', ['number', 'string', 'number', 'number', 'number', 'number', 'number'], [parent, text, x, y, width, height, color(widget.color)])
    return this.call('lvgl_bridge_create_obj', 'number', ['number', 'number', 'number', 'number', 'number', 'number'], [parent, x, y, width, height, color(widget.color)])
  }

  private call(name: string, returnType: string | null, argumentTypes: string[], args: unknown[]): number {
    return Number(this.module.ccall(name, returnType, argumentTypes, args) ?? 0)
  }
}

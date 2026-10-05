import { describe, expect, it } from 'vitest'
import { parseProjectYaml } from './yaml'

describe('parseProjectYaml', () => {
  it('normalizes pages, layers, assets and entities', () => {
    const model = parseProjectYaml(`
substitutions:
  accent: '#f5c451'
image:
  - platform: file
    id: weather
    file: background/weather.png
sensor:
  - platform: homeassistant
    id: indoor_temp
    entity_id: sensor.indoor_temperature
lvgl:
  bottom_layer:
    - obj:
        id: background
  pages:
    - id: home
      width: 800
      height: 480
      widgets:
        - image:
            id: weather_widget
            src: weather
            bg_color: \${accent}
  top_layer:
    - label:
        text: '{{ indoor_temp }}'
`)

    expect(model.pages[0]).toMatchObject({ id: 'home', width: 800, height: 480 })
    expect(model.pages[0].widgets[0]).toMatchObject({ type: 'image', source: 'weather' })
    expect(model.pages[0].widgets[0].color).toBe('#f5c451')
    expect(model.assets[0]).toMatchObject({ id: 'weather', file: 'background/weather.png' })
    expect(model.entities[0]).toMatchObject({ id: 'indoor_temp', entityId: 'sensor.indoor_temperature' })
    expect(model.topLayer[0].text).toBe('{{ indoor_temp }}')
    expect(model.diagnostics.filter((item) => item.severity === 'error')).toHaveLength(0)
  })

  it('resolves uploaded includes and reports missing files', () => {
    const model = parseProjectYaml('!include page.yaml', 'main.yaml', {
      'page.yaml': 'lvgl:\n  pages:\n    - id: included\n      widgets: []\n',
    })
    expect(model.pages[0]?.id).toBe('included')

    const missing = parseProjectYaml('!include missing.yaml', 'main.yaml', {})
    expect(missing.diagnostics.some((item) => item.message.includes('not uploaded'))).toBe(true)
  })

  it('resolves an include relative to its source directory before matching a duplicate basename', () => {
    const model = parseProjectYaml('!include widget.yaml', 'devices/main.yaml', {
      'devices/widget.yaml': 'lvgl:\n  pages:\n    - id: relative\n      widgets: []\n',
      'widget.yaml': 'lvgl:\n  pages:\n    - id: wrong\n      widgets: []\n',
    })

    expect(model.pages[0]?.id).toBe('relative')
  })

  it('keeps included widget source ranges attached to the included file', () => {
    const included = 'label:\n  id: imported_label\n  text: Imported\n'
    const source = `lvgl:
  pages:
    - id: main
      widgets:
        - label:
            id: local_label
            text: Local
        - !include imported.yaml
`
    const model = parseProjectYaml(source, 'main.yaml', { 'imported.yaml': included })
    const imported = model.pages[0].widgets.find((widget) => widget.id === 'imported_label')

    expect(imported?.sourceRange, JSON.stringify(model.pages[0].widgets.map(({ id, sourceRange }) => ({ id, sourceRange })))).toMatchObject({ start: 0, sourceFile: 'imported.yaml', startLine: 0 })
    expect(included.slice(imported!.sourceRange!.start, imported!.sourceRange!.end)).toContain('id: imported_label')
    expect(model.pages[0].widgets.find((widget) => widget.id === 'local_label')?.sourceRange?.sourceFile).toBe('main.yaml')
  })

  it('expands mapping includes without flattening their nested YAML fields', () => {
    const model = parseProjectYaml(`
display: !include display.yaml
lvgl:
  pages:
    - id: main
      widgets: []
`, 'main.yaml', { 'display.yaml': 'width: 320\nheight: 240\n' })

    expect(model.displayWidth).toBe(320)
    expect(model.displayHeight).toBe(240)
    expect(model.diagnostics.filter((item) => item.severity === 'error')).toHaveLength(0)
  })

  it('resolves substitutions in include filenames and preserves imported widget locations', () => {
    const included = 'label:\n  id: dynamic_label\n  text: Dynamic\n'
    const model = parseProjectYaml(`
substitutions:
  panel: kitchen
lvgl:
  pages:
    - id: main
      widgets:
        - !include widget_${'$'}{panel}.yaml
`, 'main.yaml', { 'widget_kitchen.yaml': included })

    expect(model.pages[0].widgets[0]).toMatchObject({ id: 'dynamic_label', sourceRange: { sourceFile: 'widget_kitchen.yaml', start: 0 } })
  })

  it('applies scoped variables from multiline local includes', () => {
    const included = 'label:\n  id: ${widget_id}\n  text: ${caption}\n'
    const model = parseProjectYaml(`lvgl:
  pages:
    - id: main
      widgets:
        - !include
            file: widget.yaml
            vars:
              widget_id: room_title
              caption: Bedroom
`, 'main.yaml', { 'widget.yaml': included })

    expect(model.pages[0].widgets[0]).toMatchObject({ id: 'room_title', text: 'Bedroom' })
    expect(model.diagnostics.filter((item) => item.severity === 'error')).toHaveLength(0)
  })

  it('merges locally included packages from list syntax and retains their widget source', () => {
    const packageSource = `lvgl:
  pages:
    - id: packaged
      widgets:
        - label:
            id: package_title
            text: Package title
`
    const model = parseProjectYaml('packages:\n  - !include common.yaml\n', 'main.yaml', { 'common.yaml': packageSource })

    expect(model.pages[0]?.widgets[0]).toMatchObject({ id: 'package_title', sourceRange: { sourceFile: 'common.yaml', startLine: 4 } })
  })

  it('resolves typed, chained and embedded substitutions without changing YAML meaning', () => {
    const model = parseProjectYaml(`
substitutions:
  accent: '#f5c451'
  width_value: 240
  base_id: climate
  widget_id: ${'$'}{base_id}
  chained_id: ${'$'}{widget_id}
lvgl:
  pages:
    - id: main
      width: "${'$'}{width_value}"
      widgets:
        - label:
            id: ${'$'}{chained_id}
            x: ${'$'}{width_value}
            bg_color: ${'$'}{accent}
            text: "Width ${'$'}{width_value}"
`)

    expect(model.substitutions).toMatchObject({ width_value: 240 })
    expect(model.pages[0], JSON.stringify(model.diagnostics)).toMatchObject({ width: 240 })
    expect(model.pages[0].widgets[0]).toMatchObject({ id: 'climate', x: 240, color: '#f5c451', text: 'Width 240' })
  })

  it('keeps malformed YAML in diagnostics instead of throwing', () => {
    const model = parseProjectYaml('lvgl:\n  pages: [', 'broken.yaml')
    expect(model.pages).toHaveLength(0)
    expect(model.diagnostics[0]).toMatchObject({ severity: 'error', source: 'broken.yaml' })
  })

  it('accepts ESPHome single-page mapping syntax', () => {
    const model = parseProjectYaml(`
lvgl:
  rotation: 270
  pages:
    id: dashboard
    width: 1280
    height: 800
    widgets:
      - obj:
          width: 95%
          height: 2
      - label:
          id: label_temperature
          text: "-- °C"
`)

    expect(model.pages).toHaveLength(1)
    expect(model.pages[0]).toMatchObject({ id: 'dashboard', width: 1280, height: 800 })
    expect(model.pages[0].widgets).toHaveLength(2)
    expect(model.pages[0].widgets[1]).toMatchObject({ type: 'label', id: 'label_temperature' })
    expect(model.diagnostics.some((item) => item.message.includes('No LVGL pages'))).toBe(false)
  })

  it('normalizes requested Google and uploaded local fonts without loading them', () => {
    const model = parseProjectYaml(`
font:
  - file:
      type: gfonts
      family: Montserrat
      weight: 700
    id: heading
    size: 36
    extras:
      - file: fonts/materialdesignicons-webfont.ttf
lvgl:
  pages:
    - id: main
      widgets: []
`)

    expect(model.fonts).toEqual([{
      id: 'heading',
      size: 36,
      source: { type: 'gfonts', family: 'Montserrat', weight: 700 },
      extras: [{ type: 'local', path: 'fonts/materialdesignicons-webfont.ttf', weight: 400 }],
    }])
  })

  it('normalizes online images for demand-driven downloading', () => {
    const model = parseProjectYaml(`
image:
  - platform: online_image
    id: weather_background
    url: https://example.com/weather.png
    format: PNG
lvgl:
  pages:
    - id: main
      widgets:
        - image:
            id: background
            src: weather_background
`)

    expect(model.assets).toContainEqual(expect.objectContaining({
      id: 'weather_background',
      platform: 'online_image',
      url: 'https://example.com/weather.png',
    }))
    expect(model.pages[0]?.widgets[0]).toMatchObject({ type: 'image', source: 'weather_background' })
  })

  it('discovers LVGL switch state and individual script update values as mocks', () => {
    const model = parseProjectYaml(`
script:
  - id: refresh_clock
    then:
      - lvgl.label.update:
          id: clock_label
          text: !lambda return "12:34";
lvgl:
  pages:
    - id: main
      widgets:
        - switch:
            id: heating_enabled
            checked: true
        - label:
            id: clock_label
            text: "--:--"
`)

    expect(model.entities).toContainEqual({ id: 'heating_enabled', type: 'lvgl_switch', targetWidgetId: 'heating_enabled', value: true, defaultValue: true })
    expect(model.entities).toContainEqual({ id: 'refresh_clock.clock_label', type: 'script_value', targetWidgetId: 'clock_label', value: '', defaultValue: 'Mock text' })
  })

  it('assigns type-appropriate optional defaults to declared mock entities', () => {
    const model = parseProjectYaml(`
sensor:
  - id: room_temperature
    device_class: temperature
text_sensor:
  - id: weather_state
binary_sensor:
  - id: window_open
number:
  - id: target_temperature
    min_value: 10
    max_value: 30
select:
  - id: heating_mode
    options: [Off, Heat]
`)

    expect(model.entities).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'room_temperature', value: '', defaultValue: 20 }),
      expect.objectContaining({ id: 'weather_state', value: '', defaultValue: 'Mock text' }),
      expect.objectContaining({ id: 'window_open', value: false, defaultValue: false }),
      expect.objectContaining({ id: 'target_temperature', value: '', defaultValue: 20 }),
      expect.objectContaining({ id: 'heating_mode', value: '', defaultValue: 'Off' }),
    ]))
  })

  it('discovers entity-driven LVGL label and switch updates', () => {
    const model = parseProjectYaml(`
sensor:
  - id: light_brightness
    on_value:
      then:
        - lvgl.label.update:
            id: light_icon
            text: !lambda 'return (x > 0) ? std::string("ON") : std::string("OFF");'
            text_color: !lambda 'return (x > 0) ? lv_color_hex(0xFFFF00) : lv_color_hex(0x888888);'
        - lvgl.switch.update:
            id: light_toggle
            state:
              checked: !lambda 'return x > 0;'
lvgl:
  pages:
    - id: main
      widgets:
        - label:
            id: light_icon
            text: '?'
        - switch:
            id: light_toggle
`)

    expect(model.automations).toEqual([
      expect.objectContaining({ sourceId: 'light_brightness', targetWidgetId: 'light_icon', property: 'text' }),
      expect.objectContaining({ sourceId: 'light_brightness', targetWidgetId: 'light_icon', property: 'text_color' }),
      expect.objectContaining({ sourceId: 'light_brightness', targetWidgetId: 'light_toggle', property: 'checked' }),
    ])
  })

  it('assigns distinct source ranges to duplicate anonymous widgets', () => {
    const source = `lvgl:
  pages:
    - id: main
      widgets:
        - obj:
            widgets:
              - label:
                  text: Same
              - label:
                  text: Same
        - label:
            text: Same
`
    const model = parseProjectYaml(source)
    const nestedLabels = model.pages[0].widgets[0].children
    const finalLabel = model.pages[0].widgets[1]

    expect(nestedLabels[0].sourceRange?.start).toBeLessThan(nestedLabels[1].sourceRange!.start)
    expect(nestedLabels[1].sourceRange?.start).toBeLessThan(finalLabel.sourceRange!.start)
    expect(source.slice(nestedLabels[1].sourceRange!.start, nestedLabels[1].sourceRange!.end)).toContain('- label:')
  })

  it('assigns widget ranges from the top-level LVGL block when logger has an lvgl key', () => {
    const source = `logger:
  logs:
    lvgl: DEBUG
lvgl:
  pages:
    - id: main
      widgets:
        - label:
            id: status_label
            text: Ready
`
    const model = parseProjectYaml(source)
    const widget = model.pages[0]?.widgets[0]

    expect(widget?.sourceRange?.startLine).toBe(7)
    expect(source.slice(widget!.sourceRange!.start, widget!.sourceRange!.end)).toContain('id: status_label')
  })
})

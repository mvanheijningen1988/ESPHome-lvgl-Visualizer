import { expect, test } from '@playwright/test'

const pageErrors = new WeakMap<object, string[]>()

test.beforeEach(async ({ page }) => {
  const errors: string[] = []
  pageErrors.set(page, errors)
  page.on('pageerror', (error) => errors.push(error.message))
  await page.route('**/wasm/lvgl-loader.js', (route) => route.abort())
  await page.setViewportSize({ width: 1500, height: 1000 })
  await page.goto('/')
  await page.locator('.monaco-editor').waitFor()
  await page.locator('#collapse-source').click()
  await expect(page.locator('body')).toHaveAttribute('data-lvgl-runtime', 'fallback', { timeout: 10_000 })
})

test.afterEach(async ({ page }) => {
  expect(pageErrors.get(page)).toEqual([])
})

test('text sensor mock updates its bound LVGL label', async ({ page }) => {
  await page.locator('#yaml-file').setInputFiles({
    name: 'text-sensor.yaml',
    mimeType: 'text/yaml',
    buffer: Buffer.from(`text_sensor:
  - id: weather_state
    on_value:
      then:
        - lvgl.label.update:
            id: weather_label
            text: !lambda return x;
lvgl:
  pages:
    - id: main
      widgets:
        - label:
            id: weather_label
            text: Waiting
`),
  })

  const label = page.locator('#lvgl-preview .widget-label span')
  const mockInput = page.locator('#entity-controls [data-entity="weather_state"]')
  await expect(label).toHaveText('Waiting')
  await mockInput.fill('Rain expected')
  await expect(label).toHaveText('Rain expected')
  await mockInput.fill('')
  await expect(label).toHaveText('')
})

test('slider and bar render their configured range and orientation', async ({ page }) => {
  await page.locator('#yaml-file').setInputFiles({
    name: 'ranges.yaml',
    mimeType: 'text/yaml',
    buffer: Buffer.from(`lvgl:
  pages:
    - id: main
      widgets:
        - slider:
            id: horizontal
            min_value: 0
            max_value: 100
            value: 50
            width: 200
            height: 24
        - slider:
            id: vertical
            min_value: -20
            max_value: 20
            value: 0
            width: 24
            height: 200
        - bar:
            id: progress
            min_value: 0
            max_value: 200
            value: 50
            width: 200
            height: 14
`),
  })

  const sliders = page.locator('#lvgl-preview .widget-slider')
  const bar = page.locator('#lvgl-preview .widget-bar')
  await expect(sliders).toHaveCount(2)
  await expect(sliders.nth(0)).not.toHaveClass(/is-vertical/)
  await expect(sliders.nth(1)).toHaveClass(/is-vertical/)
  await expect(sliders.nth(0).locator('.widget-knob')).toBeVisible()
  await expect(sliders.nth(0).locator('.widget-indicator')).toBeVisible()
  await expect(bar.locator('.widget-indicator')).toBeVisible()
  await expect(bar).toHaveCSS('height', '14px')
  await expect.poll(() => sliders.nth(0).evaluate((element) => getComputedStyle(element).getPropertyValue('--widget-value').trim())).toBe('50%')
  await expect.poll(() => bar.evaluate((element) => getComputedStyle(element).getPropertyValue('--widget-value').trim())).toBe('25%')
})

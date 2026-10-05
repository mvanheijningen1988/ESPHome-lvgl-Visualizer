import { expect, test } from '@playwright/test'

const pageErrors = new WeakMap<object, string[]>()

test.beforeEach(async ({ page }) => {
  const errors: string[] = []
  pageErrors.set(page, errors)
  page.on('pageerror', (error) => errors.push(error.message))
  await page.setViewportSize({ width: 1500, height: 1000 })
  await page.goto('/')
  await page.locator('.monaco-editor').waitFor()
  await page.locator('#collapse-source').click()
  await page.evaluate(() => document.body.classList.remove('wasm-ready'))
})

test.afterEach(async ({ page }) => {
  expect(pageErrors.get(page)).toEqual([])
})

async function selectionTop(page: import('@playwright/test').Page): Promise<number | undefined> {
  const positions = await page.locator('.yaml-source-selection').evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().top))
  return positions.length ? Math.min(...positions) : undefined
}

async function textBoundary(page: import('@playwright/test').Page, charactersFromEnd = 0) {
  return page.evaluate((remaining) => {
    const line = document.querySelector('.view-line')!
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT)
    let offset = line.textContent!.length - remaining
    let node = walker.nextNode()
    while (node && offset > node.textContent!.length) {
      offset -= node.textContent!.length
      node = walker.nextNode()
    }
    if (!node) throw new Error('No text at the expected cursor position.')
    const range = document.createRange()
    range.setStart(node, offset)
    range.collapse(true)
    const bounds = range.getBoundingClientRect()
    const caret = document.querySelector('.monaco-editor .cursor')!.getBoundingClientRect()
    return { x: bounds.left, y: bounds.top + bounds.height / 2, error: Math.abs(caret.left - bounds.left) }
  }, charactersFromEnd)
}

test('preview click stays linked until leaving and returning to the preview', async ({ page }) => {
  const widgets = page.locator('#lvgl-preview .lvgl-widget')
  await widgets.nth(0).hover()
  await expect.poll(() => selectionTop(page)).toBeDefined()
  const firstSelection = await selectionTop(page)
  await widgets.nth(0).click()
  await widgets.nth(1).hover()

  await expect.poll(() => selectionTop(page)).toBe(firstSelection)

  await page.locator('#collapse-source').hover()
  await widgets.nth(1).hover()
  expect(await selectionTop(page)).not.toBe(firstSelection)
})

test('native canvas uses the same preview-visit selection lock', async ({ page }) => {
  await page.waitForFunction(() => document.body.dataset.lvglRuntime === 'active')
  await page.evaluate(() => document.body.classList.add('wasm-ready'))
  const canvas = page.locator('#lvgl-canvas')
  const bounds = await canvas.boundingBox()
  if (!bounds) throw new Error('Native LVGL canvas is not visible.')

  const firstPoint = { x: bounds.x + bounds.width * 0.1, y: bounds.y + bounds.height * 0.55 }
  const secondPoint = { x: bounds.x + bounds.width * 0.7, y: bounds.y + bounds.height * 0.55 }
  await page.mouse.move(firstPoint.x, firstPoint.y)
  await expect.poll(() => selectionTop(page)).toBeDefined()
  const firstSelection = await selectionTop(page)
  await page.mouse.click(firstPoint.x, firstPoint.y)
  await page.mouse.move(secondPoint.x, secondPoint.y)
  await expect.poll(() => selectionTop(page)).toBe(firstSelection)

  await page.locator('#collapse-source').hover()
  await page.mouse.move(secondPoint.x, secondPoint.y)
  await expect.poll(() => selectionTop(page)).not.toBe(firstSelection)
})

test('native preview outline scales with manual display dimensions', async ({ page }) => {
  await page.waitForFunction(() => document.body.dataset.lvglRuntime === 'active')
  await page.evaluate(() => document.body.classList.add('wasm-ready'))
  const canvas = await page.locator('#lvgl-canvas').boundingBox()
  if (!canvas) throw new Error('Native LVGL canvas is not visible.')
  await page.mouse.click(canvas.x + canvas.width * 0.1, canvas.y + canvas.height * 0.55)
  await expect(page.locator('.device-frame > .widget-selection')).toHaveCount(1)
  await page.locator('#width-input').fill('960')
  await expect(page.locator('.device-frame > .widget-selection')).toHaveAttribute('style', /left: 58px/)
  await expect(page.locator('.device-frame > .widget-selection')).toHaveAttribute('style', /width: 408px/)
})

test('duplicate anonymous widgets each select their own YAML block', async ({ page }) => {
  await page.locator('#yaml-file').setInputFiles({
    name: 'duplicate.yaml',
    mimeType: 'text/yaml',
    buffer: Buffer.from(`lvgl:
  pages:
    - id: main
      widgets:
        - label:
            x: 20
            y: 20
            text: Same
        - label:
            x: 140
            y: 80
            text: Same
`),
  })
  await expect(page.locator('#lvgl-preview .lvgl-widget')).toHaveCount(2)

  const widgets = page.locator('#lvgl-preview .lvgl-widget')
  await widgets.nth(0).click()
  await expect.poll(() => selectionTop(page)).toBeDefined()
  const firstSelection = await selectionTop(page)
  await page.locator('#collapse-source').hover()
  await widgets.nth(1).click()

  await expect.poll(() => selectionTop(page)).not.toBe(firstSelection)
  await expect(page.locator('.device-frame > .widget-selection')).toHaveCount(1)
})

test('YAML cursor selection outlines the matching preview widget', async ({ page }) => {
  await page.locator('#yaml-file').setInputFiles({
    name: 'duplicate.yaml',
    mimeType: 'text/yaml',
    buffer: Buffer.from(`lvgl:
  pages:
    - id: main
      widgets:
        - label:
            x: 20
            y: 20
            text: Same
        - label:
            x: 140
            y: 80
            text: Same
`),
  })
  const widgets = page.locator('#lvgl-preview .lvgl-widget')
  await expect(widgets).toHaveCount(2)
  const secondTextLine = page.locator('.view-line').filter({ hasText: 'text: Same' }).nth(1)
  await secondTextLine.click({ position: { x: 170, y: 10 } })
  await expect(page.locator('.device-frame > .widget-selection')).toHaveAttribute('style', /left: 150px/)
})

test('preview click opens the source document for an included widget', async ({ page }) => {
  await page.locator('#yaml-file').setInputFiles([
    {
      name: 'main.yaml',
      mimeType: 'text/yaml',
      buffer: Buffer.from(`lvgl:
  pages:
    - id: main
      widgets:
        - label:
            id: local_label
            x: 20
            text: Local
        - !include imported.yaml
`),
    },
    {
      name: 'imported.yaml',
      mimeType: 'text/yaml',
      buffer: Buffer.from(`label:
  id: imported_label
  x: 140
  text: Imported
`),
    },
  ])
  const importedWidget = page.locator('#lvgl-preview .lvgl-widget').nth(1)
  await expect(importedWidget).toBeVisible()
  await importedWidget.click()
  await expect(page.locator('#source-file-select')).toHaveValue('imported.yaml')
  await expect(page.locator('.view-lines')).toContainText('imported_label')
})

test('Monaco undo and redo restore YAML edits', async ({ page }) => {
  const editor = page.locator('.monaco-editor')
  await editor.click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type('\n# history marker')
  await page.keyboard.press('Control+Z')
  await expect(page.locator('.view-lines')).not.toContainText('history marker')
  await page.keyboard.press('Control+Y')
  await expect(page.locator('.view-lines')).toContainText('history marker')
})

for (const width of [1500, 390]) {
  test(`caret matches visible text, clicks and edits at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 })
    const source = '# cursor position: ABCDEFGHIJKLMNOPQRSTUVWXYZ 0123456789'
    await page.locator('#yaml-file').setInputFiles({
      name: 'cursor.yaml',
      mimeType: 'text/yaml',
      buffer: Buffer.from(source),
    })
    await page.locator('#collapse-source').click()
    await page.evaluate(() => document.fonts.ready)
    const line = page.locator('.view-line').first()
    await expect(line).toHaveText(source)
    await line.click({ position: { x: 10, y: 10 } })
    await page.keyboard.press('End')

    await expect.poll(async () => (await textBoundary(page)).error).toBeLessThan(1.5)
    await page.keyboard.press('Backspace')
    await expect(line).toHaveText(source.slice(0, -1))
    await expect.poll(async () => (await textBoundary(page)).error).toBeLessThan(1.5)
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('ArrowLeft')
    await expect.poll(async () => (await textBoundary(page, 2)).error).toBeLessThan(1.5)
    await page.keyboard.press('Delete')
    const afterDelete = source.slice(0, -3) + '8'
    await expect(line).toHaveText(afterDelete)

    const clickPosition = await textBoundary(page, 4)
    await page.mouse.click(clickPosition.x, clickPosition.y)
    await expect.poll(async () => (await textBoundary(page, 4)).error).toBeLessThan(1.5)
    await page.keyboard.press('Backspace')
    await expect(line).toHaveText(afterDelete.slice(0, -5) + afterDelete.slice(-4))
    await expect.poll(async () => (await textBoundary(page, 4)).error).toBeLessThan(1.5)
    await page.keyboard.type('X')
    await expect(line).toHaveText(afterDelete.slice(0, -5) + 'X' + afterDelete.slice(-4))
    await expect.poll(async () => (await textBoundary(page, 4)).error).toBeLessThan(1.5)
  })
}

test('caret measurements refresh when an editor font loads later', async ({ page }) => {
  const source = '# late font: ABCDEFGHIJKLMNOPQRSTUVWXYZ 0123456789'
  await page.locator('#yaml-file').setInputFiles({
    name: 'font.yaml',
    mimeType: 'text/yaml',
    buffer: Buffer.from(source),
  })
  await page.locator('#collapse-source').click()
  await page.evaluate(() => document.fonts.ready)
  const line = page.locator('.view-line').first()
  await expect(line).toHaveText(source)
  await line.click({ position: { x: 10, y: 10 } })
  await page.keyboard.press('End')
  await expect.poll(async () => (await textBoundary(page)).error).toBeLessThan(1.5)
  const before = await textBoundary(page)
  await page.evaluate(async () => {
    const font = new FontFace('DM Mono', 'local("Courier New"), local("Liberation Mono"), local("DejaVu Sans Mono"), local("Menlo")', { sizeAdjust: '150%' })
    document.fonts.add(font)
    await document.fonts.load('12px "DM Mono"')
    await document.fonts.ready
    if (font.status !== 'loaded') throw new Error('Late editor font did not load.')
  })
  await expect.poll(async () => (await textBoundary(page)).x - before.x).toBeGreaterThan(50)
  await expect.poll(async () => (await textBoundary(page)).error).toBeLessThan(1.5)
  await page.keyboard.press('Backspace')
  await expect(line).toHaveText(source.slice(0, -1))
  await expect.poll(async () => (await textBoundary(page)).error).toBeLessThan(1.5)
})

test('nested YAML sections can be folded and expanded', async ({ page }) => {
  await page.locator('#yaml-file').setInputFiles({
    name: 'folding.yaml',
    mimeType: 'text/yaml',
    buffer: Buffer.from(`lvgl:
  pages:
    - id: main
      widgets:
        - label:
            id: fold_target
            text: Folded content
`),
  })
  await page.locator('#fold-yaml').click()
  await expect(page.locator('.view-lines')).not.toContainText('Folded content')
  await page.locator('#lvgl-preview .lvgl-widget').click()
  await expect(page.locator('.view-lines')).toContainText('Folded content')
  await page.locator('#fold-yaml').click()
  await expect(page.locator('.view-lines')).not.toContainText('Folded content')
  await page.locator('#unfold-yaml').click()
  await expect(page.locator('.view-lines')).toContainText('Folded content')
})

test('editor find opens the local Monaco find widget', async ({ page }) => {
  await page.locator('.monaco-editor').click()
  await page.keyboard.press('Control+F')
  await expect(page.locator('.find-widget')).toBeVisible()
})
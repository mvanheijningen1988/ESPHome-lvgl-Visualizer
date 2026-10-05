import * as monaco from '../node_modules/monaco-editor/esm/vs/editor/editor.api.js'
import EditorWorker from '../node_modules/monaco-editor/esm/vs/editor/editor.worker.js?worker'
import '../node_modules/monaco-editor/esm/vs/editor/contrib/folding/browser/folding.js'
import '../node_modules/monaco-editor/esm/vs/editor/contrib/find/browser/findController.js'

type MonacoWorkerEnvironment = { getWorker(workerId: string, label: string): Worker }
type MonacoGlobal = typeof globalThis & { MonacoEnvironment?: MonacoWorkerEnvironment }

;(globalThis as MonacoGlobal).MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
}

monaco.languages.register({ id: 'yaml' })
monaco.languages.setMonarchTokensProvider('yaml', {
  tokenizer: {
    root: [
      [/^\s*#.*/, 'comment'],
      [/["'](?:[^"'\\]|\\.)*["']/, 'string'],
      [/\$\{[^}]*\}|\$[A-Za-z_][\w.]*/, 'variable'],
      [/^\s*[^\s#][^:]*?(?=\s*:\s*(?:$|[^:]))/, 'key'],
      [/(?:^|\s)#.*$/, 'comment'],
      [/\b(?:true|false|null|yes|no|on|off)\b/i, 'keyword'],
      [/\b0x[\da-f]+\b/i, 'number.hex'],
      [/[+-]?\d+(?:\.\d+)?%?/, 'number'],
      [/[{}\[\],]/, 'delimiter'],
      [/[|>&*!]/, 'operator'],
    ],
  },
})
monaco.languages.setLanguageConfiguration('yaml', {
  comments: { lineComment: '#' },
  brackets: [['{', '}'], ['[', ']']],
  autoClosingPairs: [{ open: '[', close: ']' }, { open: '{', close: '}' }, { open: '"', close: '"' }, { open: "'", close: "'" }],
})
type FoldRange = { start: number; end: number }

function yamlFoldRanges(model: monaco.editor.ITextModel): FoldRange[] {
  const content = Array.from({ length: model.getLineCount() }, (_, index) => ({
    line: index + 1,
    text: model.getLineContent(index + 1),
  })).filter(({ text }) => text.trim() && !text.trimStart().startsWith('#'))
  return content.flatMap((current, index) => {
    const indent = current.text.length - current.text.trimStart().length
    const next = content[index + 1]
    if (!next || next.text.length - next.text.trimStart().length <= indent) return []
    let end = model.getLineCount()
    for (const later of content.slice(index + 1)) {
      if (later.text.length - later.text.trimStart().length <= indent) {
        end = later.line - 1
        break
      }
    }
    return end > current.line ? [{ start: current.line, end }] : []
  })
}

monaco.languages.registerFoldingRangeProvider('yaml', {
  provideFoldingRanges(model) {
    return yamlFoldRanges(model).map(({ start, end }) => ({ start, end, kind: monaco.languages.FoldingRangeKind.Region }))
  },
})

type DocumentModel = {
  model: monaco.editor.ITextModel
  viewState?: monaco.editor.ICodeEditorViewState | null
}

export class YamlEditor {
  private readonly editor: monaco.editor.IStandaloneCodeEditor
  private readonly documents = new Map<string, DocumentModel>()
  private readonly changeListeners = new Set<(document: string, value: string) => void>()
  private readonly selectionListeners = new Set<(document: string, start: number, end: number, programmatic: boolean) => void>()
  private readonly scrollListeners = new Set<() => void>()
  private readonly trackedSourceRanges = new Map<string, string[]>()
  private activeDocument = 'editor.yaml'
  private programmaticSelection = false
  private decorationIds: string[] = []
  private decorationGeneration = 0
  private disposed = false
  private readonly refreshFontMetrics = (): void => {
    if (!this.disposed) monaco.editor.remeasureFonts()
  }

  constructor(container: HTMLElement, initialValue: string) {
    const model = monaco.editor.createModel(initialValue, 'yaml', this.uriFor(this.activeDocument))
    this.documents.set(this.activeDocument, { model })
    this.editor = monaco.editor.create(container, {
      model,
      ariaLabel: 'ESPHome YAML editor',
      automaticLayout: true,
      folding: true,
      foldingHighlight: true,
      foldingStrategy: 'auto',
      showFoldingControls: 'always',
      fontFamily: "'DM Mono', monospace",
      fontSize: 12,
      lineHeight: 20,
      lineNumbersMinChars: 4,
      glyphMargin: true,
      minimap: { enabled: false },
      padding: { top: 22, bottom: 22 },
      scrollBeyondLastLine: false,
      tabSize: 2,
      insertSpaces: true,
      wordWrap: 'off',
      renderLineHighlight: 'line',
      overviewRulerLanes: 0,
      scrollbar: { alwaysConsumeMouseWheel: false },
      theme: 'vs-dark',
    })
    monaco.editor.defineTheme('wall-display-yaml', {
      base: 'vs-dark',
      inherit: true,
      rules: [],
      colors: {
        'editor.background': '#101a1c',
        'editor.foreground': '#c4d4ce',
        'editorLineNumber.foreground': '#526865',
        'editorLineNumber.activeForeground': '#f5c451',
        'editor.lineHighlightBackground': '#182426',
        'editor.selectionBackground': '#49615f88',
        'editorCursor.foreground': '#f5c451',
        'editorGutter.background': '#101a1c',
        'editorWidget.background': '#152022',
      },
    })
    monaco.editor.setTheme('wall-display-yaml')
    document.fonts.addEventListener('loadingdone', this.refreshFontMetrics)
    void document.fonts.ready.then(this.refreshFontMetrics)
    this.editor.onDidChangeModelContent(() => this.notifyChanges())
    this.editor.onDidChangeCursorSelection((event) => {
      const selection = event.selection
      const model = this.editor.getModel()
      if (!model) return
      const start = model.getOffsetAt(selection.getStartPosition())
      const end = model.getOffsetAt(selection.getEndPosition())
      const programmatic = this.programmaticSelection || event.source === 'api' || event.source === 'model'
      for (const listener of this.selectionListeners) listener(this.activeDocument, start, end, programmatic)
    })
    this.editor.onDidScrollChange(() => this.scrollListeners.forEach((listener) => listener()))
    this.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.BracketLeft, () => this.foldAtCursor())
  }

  get value(): string { return this.editor.getValue() }
  set value(value: string) { this.editor.setValue(value) }
  get selectionStart(): number { return this.selectionOffsets()[0] }
  get selectionEnd(): number { return this.selectionOffsets()[1] }
  get scrollTop(): number { return this.editor.getScrollTop() }
  set scrollTop(value: number) { this.editor.setScrollTop(value) }
  get clientHeight(): number { return this.editor.getLayoutInfo().height }
  get documentName(): string { return this.activeDocument }
  get model(): monaco.editor.ITextModel { return this.editor.getModel()! }
  getDocumentValue(name: string): string | undefined { return this.documents.get(name)?.model.getValue() }
  hasDocument(name: string): boolean { return this.documents.has(name) }

  private uriFor(document: string): monaco.Uri {
    return monaco.Uri.parse(`inmemory://yaml/${encodeURIComponent(document).replaceAll('%2F', '/')}`)
  }

  private selectionOffsets(): [number, number] {
    const selection = this.editor.getSelection()
    if (!selection) return [0, 0]
    return [this.model.getOffsetAt(selection.getStartPosition()), this.model.getOffsetAt(selection.getEndPosition())]
  }

  private notifyChanges(): void {
    for (const listener of this.changeListeners) listener(this.activeDocument, this.value)
  }

  onDidChange(listener: (document: string, value: string) => void): void { this.changeListeners.add(listener) }
  onDidChangeSelection(listener: (document: string, start: number, end: number, programmatic: boolean) => void): void { this.selectionListeners.add(listener) }
  onDidScroll(listener: () => void): void { this.scrollListeners.add(listener) }

  trackSourceRange(document: string, start: number | undefined, end = start): void {
    const entry = this.documents.get(document)
    if (!entry) return
    const existing = this.trackedSourceRanges.get(document) ?? []
    if (start === undefined) {
      this.trackedSourceRanges.set(document, entry.model.deltaDecorations(existing, []))
      return
    }
    const startPosition = entry.model.getPositionAt(start)
    const endPosition = entry.model.getPositionAt(end ?? start)
    this.trackedSourceRanges.set(document, entry.model.deltaDecorations(existing, [{
      range: new monaco.Range(startPosition.lineNumber, startPosition.column, endPosition.lineNumber, endPosition.column),
      options: { stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges },
    }]))
  }

  getTrackedSourceRange(document: string): { start: number; end: number } | undefined {
    const entry = this.documents.get(document)
    const ids = this.trackedSourceRanges.get(document)
    const range = entry && ids?.length ? entry.model.getDecorationRange(ids[0]) : undefined
    return range && entry ? { start: entry.model.getOffsetAt(range.getStartPosition()), end: entry.model.getOffsetAt(range.getEndPosition()) } : undefined
  }

  clearTrackedSourceRanges(): void {
    for (const [document, ids] of this.trackedSourceRanges) {
      const model = this.documents.get(document)?.model
      if (model) this.trackedSourceRanges.set(document, model.deltaDecorations(ids, []))
    }
  }

  addDocument(name: string, value: string): void {
    const existing = this.documents.get(name)
    if (existing) {
      if (existing.model.getValue() !== value) existing.model.setValue(value)
      return
    }
    this.documents.set(name, { model: monaco.editor.createModel(value, 'yaml', this.uriFor(name)) })
  }

  openDocument(name: string, value?: string): void {
    if (name === this.activeDocument) return
    if (!this.documents.has(name)) this.addDocument(name, value ?? '')
    else if (value !== undefined && this.documents.get(name)!.model.getValue() !== value) this.documents.get(name)!.model.setValue(value)
    const current = this.documents.get(this.activeDocument)
    if (current) current.viewState = this.editor.saveViewState()
    this.activeDocument = name
    const next = this.documents.get(name)!
    this.programmaticSelection = true
    this.editor.setModel(next.model)
    if (next.viewState) this.editor.restoreViewState(next.viewState)
    this.programmaticSelection = false
  }

  setSelectionRange(start: number, end = start): void {
    this.programmaticSelection = true
    try {
      const startPosition = this.model.getPositionAt(start)
      const endPosition = this.model.getPositionAt(end)
      this.editor.setSelection(new monaco.Selection(startPosition.lineNumber, startPosition.column, endPosition.lineNumber, endPosition.column))
    } finally { this.programmaticSelection = false }
  }

  focus(): void { this.editor.focus() }

  revealOffset(start: number, end: number): void {
    const startPosition = this.model.getPositionAt(start)
    const endPosition = this.model.getPositionAt(end)
    this.editor.setSelection(new monaco.Selection(startPosition.lineNumber, startPosition.column, endPosition.lineNumber, endPosition.column))
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const visible = this.editor.getVisibleRanges().some((range) => startPosition.lineNumber >= range.startLineNumber && startPosition.lineNumber <= range.endLineNumber)
      if (visible) break
      void this.editor.getAction('editor.unfold')?.run()
    }
    this.editor.revealLineInCenter(startPosition.lineNumber)
  }

  revealLineInCenter(line: number): void { this.editor.revealLineInCenter(line) }

  setSourceDecoration(start: number | undefined, end = start): void {
    const generation = ++this.decorationGeneration
    window.requestAnimationFrame(() => {
      if (generation !== this.decorationGeneration) return
      if (start === undefined) {
        this.decorationIds = this.editor.deltaDecorations(this.decorationIds, [])
        return
      }
      const startPosition = this.model.getPositionAt(start)
      const endPosition = this.model.getPositionAt(end ?? start)
      this.decorationIds = this.editor.deltaDecorations(this.decorationIds, [{
        range: new monaco.Range(startPosition.lineNumber, 1, Math.max(startPosition.lineNumber, endPosition.lineNumber), 1),
        options: { isWholeLine: true, className: 'yaml-source-selection', linesDecorationsClassName: 'yaml-source-selection-gutter' },
      }])
    })
  }

  replaceRange(start: number, end: number, text: string): void {
    this.editor.pushUndoStop()
    const startPosition = this.model.getPositionAt(start)
    const endPosition = this.model.getPositionAt(end)
    this.editor.executeEdits('yaml-editor', [{ range: new monaco.Range(startPosition.lineNumber, startPosition.column, endPosition.lineNumber, endPosition.column), text }])
    this.editor.pushUndoStop()
  }

  replaceValue(value: string): void {
    const previous = this.value
    if (previous === value) return
    let start = 0
    while (start < previous.length && start < value.length && previous[start] === value[start]) start += 1
    let previousEnd = previous.length
    let nextEnd = value.length
    while (previousEnd > start && nextEnd > start && previous[previousEnd - 1] === value[nextEnd - 1]) {
      previousEnd -= 1
      nextEnd -= 1
    }
    this.replaceRange(start, previousEnd, value.slice(start, nextEnd))
  }

  undo(): void { this.editor.trigger('yaml-editor', 'undo', null) }
  redo(): void { this.editor.trigger('yaml-editor', 'redo', null) }
  foldAtCursor(): void { void this.editor.getAction('editor.fold')?.run() }
  foldAll(): void { void this.editor.getAction('editor.foldAll')?.run() }
  unfoldAll(): void { void this.editor.getAction('editor.unfoldAll')?.run() }
  layout(): void { this.editor.layout() }
  dispose(): void {
    this.disposed = true
    document.fonts.removeEventListener('loadingdone', this.refreshFontMetrics)
    this.editor.dispose()
    for (const { model } of this.documents.values()) model.dispose()
  }
}
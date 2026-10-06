# Project instructions for coding agents

## Project purpose

This repository is the ESPHome LVGL Visualizer. It is a TypeScript/Vite browser application that:

- parses uploaded ESPHome YAML and local includes/packages;
- resolves supported substitutions without executing unknown C++ lambdas;
- renders a native LVGL WebAssembly preview with a DOM fallback;
- keeps per-file Monaco editor models, folding, history, source navigation, and linked preview selection;
- provides responsive controls, diagnostics, fonts, images, mock entities, and scenario state.

The application is intentionally framework-free outside Monaco, Vite, the generated LVGL runtime, and the `yaml` package.

## Required workflow

1. Read the relevant specification and tests before changing behavior:
   - `SPEC_FLOW.md` for functional requirements;
   - `README.md` for supported user workflows;
   - `CHANGELOG.md` for user-visible changes;
   - `src/*.test.ts` and `e2e/*.e2e.ts` for established regression coverage.
2. Make the smallest change that fixes the root cause. Do not add a workaround that bypasses parser, editor, source provenance, or preview behavior.
3. Add or update a regression test before or with the fix. Tests should exercise real text/editing, model, parser, or browser behavior rather than asserting only on mocks.
4. Run the focused checks, then the full checks:
   - `npx vitest run`
   - `npm run typecheck`
   - `npx vite build`
   - `npx playwright test` with the Edge executable when managed Chromium is unavailable
5. Do not claim completion until the command output is fresh and all required checks pass.

## Commands and environment

Use the project root as the current directory.

- `npm run dev` starts Vite locally on `http://localhost:5173/`.
- `npm run dev -- --host 127.0.0.1 --port 4174` is the Playwright web-server command.
- `npm run test:e2e` runs Playwright tests. It may reuse an existing server.
- `npx playwright test --grep "..."` runs a focused browser test.
- `npx vitest run` runs unit tests without invoking the LVGL bootstrap hook.
- `npm run typecheck` runs strict TypeScript checks.
- `npx vite build` creates the production bundle without running the upstream bootstrap hook.
- `npm run build:wasm` requires the Emscripten toolchain and generates the local LVGL runtime.
- `npm run setup:lvgl` or `npm run prebuild` may download/replace `third_party/lvgl`; do not trigger it for ordinary code validation unless explicitly requested.
- Docker builds use `Dockerfile` and `docker-compose.yml`. The image is a production Vite preview service on port 5173 and must be validated with `docker compose config` and an actual `docker compose build` where Docker is installed.

The project currently targets LVGL 9.5 and ESPHome 2026.8-era syntax. Do not silently broaden compatibility without tests and documentation.

## Important package and script behavior

- `package.json` is currently version `1.0.0`, private, and should remain private unless the release policy explicitly changes.
- The `predev`, `pretest`, `prepreview`, `prebuild`, and `prebuild:wasm` hooks can bootstrap LVGL. A changed `package.json` or a failed bootstrap can therefore make `npm run dev` unexpectedly modify or replace dependency files.
- The Vite image proxy permits only loopback requests and HTTP/HTTPS image URLs. Keep local-only security behavior intact.
- `playwright.config.ts` starts a Vite server, while manual browser runs should use the same host/port and a local Edge/Chromium executable when managed Chromium is not installed.

## Monaco editor rules

The editor is implemented in `src/yaml-editor.ts`; import Monaco from the locally installed ESM distribution and keep bundle workers local.

- Use `editor.api.js` for the public API, `editor.worker.js?worker` for the editor worker, and explicit local contributions for folding and find.
- Do not import a guessed Monaco path such as `contrib/find/browser/find.js`; the current working path is `contrib/find/browser/findController.js`.
- Do not add a broad `monaco-editor` import if it causes large bundle churn; ship only the required editor API and contributions.
- Keep one Monaco model per logical uploaded YAML file and preserve its own view state and undo/redo history.
- Programmatic renders, orientation changes, folding, selection navigation, and source navigation must not create or clear editor history unless the operation is an actual user edit.
- Use `executeEdits` plus `pushUndoStop`/`pushUndoStop` for atomic YAML updates. Keep rotation edits in the root document and avoid replacing the entire document unnecessarily.
- When changing source decorations, use a generation token and `requestAnimationFrame` or an explicit coalescing step. Monaco's `deltaDecorations` must not be invoked recursively from a decoration listener or model-content callback.
- Monaco source decorations must remain focus-independent and be synchronized with preview selection, scrolling, document switching, and renders.
- Re-measure fonts with `monaco.editor.remeasureFonts()` after asynchronous webfont loading and clean up font listeners during disposal.
- `setSourceDecoration` must not dereference an inactive model or dispose a model while a queued animation frame still runs.

## Cursor and editing lessons

Earlier work reproduced a real mismatch: Monaco could retain fallback font metrics after `DM Mono` loaded, producing a visible caret far from the actual text position. The fix must preserve text offsets and actual model positions, not infer cursor location from visual glyph coordinates.

When changing editor behavior, verify:

- caret position at the end of long lines;
- ArrowLeft/ArrowRight and Home/End movement;
- mouse click positions and text boundaries;
- typing, Backspace, and Delete against the model value;
- correct editing after font loading, resizing, folding, scrolling, and document switching;
- no visible characters are skipped or deleted at the wrong position;
- editor model offsets remain UTF-16-compatible when using Monaco positions and ranges.

Do not claim the cursor is fixed based only on a screenshot or a decoration DOM top. Compare the Monaco model position/offset with actual text and caret behavior in a browser.

## Preview and source-linking lessons

Keep the bidirectional selection path deterministic and source-aware.

- The preview click lock must survive pointer movement within the same preview visit; hover resumes only after leaving and re-entering.
- A second explicit click may replace an earlier selection; a preview render, resize, font/image load, or scroll must not replace it.
- A source selection must never match an unrelated widget only by type or text. Anonymous duplicates need unique instance identity.
- Source ranges must include the original uploaded file and a correct UTF-16 half-open offset. Include/package provenance must not be lost.
- Preview navigation must open the correct source document and select the exact source block without stealing editor focus unnecessarily.
- Native and DOM preview paths must use the same selection-state semantics and the same effective coordinate system.
- Use actual rendered DOM bounds for fallback hit testing and final native bounds for the WASM renderer. Do not fall back to estimated offsets or type/text matching.
- When a source node is deleted, reordered, or invalidated by an edit, clear or remap linked selection safely instead of selecting a neighbor.

## YAML parsing and substitutions

- Preserve original YAML AST/node provenance before resolving includes or substitutions.
- Do not rely on raw text replacement for substitutions, because hashes, quotes, numeric types, multiline values, and source mapping can be corrupted.
- Preserve scalar types for full-value substitutions and resolve embedded substitutions as strings.
- Support `$name`, `${name}`, chained references, nested/compound names, and typed values; do not evaluate unsupported Jinja expressions.
- Unknown, cyclic, malformed, or unsupported substitutions must produce precise diagnostics rather than silently previewing guessed values.
- Includes and packages must retain original file, line, and offset information; relative include paths must resolve from the virtual upload directory.
- Root substitutions must override package defaults, and local package mappings/lists must merge with documented precedence.
- Keep `!lambda`, `!include`, `!secret`, and `!literal` compatibility where the existing implementation supports it; unknown lambdas must never execute.
- The parser must keep source ranges correct after malformed YAML, missing files, reorders, and edits.

## Tests and regression policy

- Add focused unit tests in `src/*.test.ts` for parser, substitution, source provenance, selection state, and normalization.
- Add real browser tests in `e2e/*.e2e.ts` for editor text editing, cursor position, preview linking, source navigation, folding, history, responsive layout, and native/DOM preview paths.
- Browser tests must check the actual model/document value, caret position, and interaction result. Do not accept a passing assertion that only checks a decoration or a mocked element.
- Capture browser `pageerror` events and fail the test if a runtime error is emitted.
- For a test that depends on a font or asynchronous renderer, wait for the real event or readiness condition and verify the resulting model/caret behavior.
- When a test runs through Playwright, use a local Edge executable when Chromium is unavailable. Do not silently skip browser coverage.
- The existing Playwright test suite is isolated by `testMatch: '**/*.e2e.ts'`; do not let it be collected by Vitest.

## Performance and correctness cautions

- Avoid repeatedly rebuilding Monaco models, decoder workers, Parsed YAML, or the LVGL preview for every tiny keystroke.
- Debounce parsing and rebuilds, but invalidate pending selection/source mappings when the document changes.
- Do not mutate the active model while another document's model or source range is being edited.
- Keep the original root document separate from the currently active included/package document.
- The DOM preview must remain available when the WASM runtime fails; never make the editor depend on native LVGL startup.
- Don't predownload, embed, or execute arbitrary project assets. Font/image loading must be demand-driven, loopback-protected, and diagnostics-backed.

## Release and repository hygiene

- Keep the existing release version and dependency metadata synchronized; `package.json` and the lockfile must agree.
- Do not publish to npm while `private` remains `true` unless the release policy explicitly changes it.
- Do not commit generated `test-results`, build output, or downloaded LVGL build artifacts unless the repository policy explicitly requires them.
- Preserve user working-tree changes and do not overwrite an existing uncommitted implementation.
- Do not use destructive Git commands such as resetting, force-pushing, or cleaning untracked files without explicit approval.
- Before shipping, review the diff, run the exact validation commands, and report the exact test counts and any remaining environment blockers.

## Files that require extra care

- `src/yaml-editor.ts`: Monaco model lifecycle, font remeasure, decorations, history and source ranges.
- `src/main.ts`: root/project file ownership, preview coordination, linked selection, rendering and async rebuilds.
- `src/yaml.ts`: structured parsing, substitutions, include/package provenance, diagnostics.
- `src/model.ts`: source ranges, instance identity and typed substitutions.
- `src/selection.ts`: explicit click/hover state and preview-visit locking.
- `src/style.css`: Monaco CSS, font family, responsive layout and selection decorations.
- `e2e/editor-preview.e2e.ts`: real browser interaction and cursor regression coverage.
- `playwright.config.ts`: local browser server, browser executable and test isolation.
- `vite.config.ts`: loopback-only online image proxy and local asset serving.
- `package.json`: version, scripts, dependencies and bootstrap behavior.

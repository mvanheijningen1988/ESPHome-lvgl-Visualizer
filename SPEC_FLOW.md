# SpecFlow: WallDisplay Visualizer

This document is the living functional specification. Every behavior change updates the relevant scenario and its test mapping in the same change.

## Decisions

- Real LVGL 9.5 through WebAssembly is the target renderer.
- The generated LVGL runtime initializes an SDL canvas, creates actual LVGL objects, drives `lv_timer_handler` through Emscripten's browser loop, and tears down safely on resize/reload.
- ESPHome 2026.8.2 is primary; older syntax is best-effort with warnings.
- Manual resolution overrides active page dimensions, which override display dimensions.
- One page is active at a time; `bottom_layer` is below it and `top_layer` above it.
- File, animation, online_image, and Sendspin are supported. Sendspin is simulated, not connected live.
- Unknown C++ lambdas are not executed; initial values remain visible with a precise warning.
- Preview interactions execute safe visible LVGL actions locally. External Home Assistant and hardware actions are logged only.
- Fonts are not predownloaded or embedded from project YAML. Google Fonts are fetched only when declared; local font paths resolve only from browser asset uploads.
- Initial `online_image` URLs are downloaded on demand and registered as native LVGL image data. The local development server proxies sources without CORS headers.
- The preview defaults to a responsive fit scale and offers exact 1:1 pixels with scrolling.
- Native LVGL switches and script label-update targets are mockable without executing external actions or lambdas.
- Workspace panels have bounded responsive heights and independent scroll areas so long content cannot expand the render row.

## Acceptance scenarios

### SF-001 Live YAML preview

Given valid ESPHome YAML containing `lvgl.pages`
When the YAML editor changes
Then the preview is rebuilt after debounce
And diagnostics identify the source when a rebuild fails.

### SF-002 Resolution priority

Given a manual width and height
When a page and display also specify dimensions
Then the manual dimensions control the preview.

Given no manual dimensions
And an active page has dimensions
Then the active page dimensions control the preview.

### SF-003 Page layers

Given a selected page with `bottom_layer` and `top_layer`
When the preview renders
Then bottom content is below the page and top content is above it.

### SF-004 Unknown lambda

Given an unsupported `!lambda` expression
When the model is normalized
Then its initial value remains visible
And a warning names the affected property and source location.

### SF-005 Uploaded files

Given multiple uploaded YAML files with `!include`
When the root file is selected
Then includes resolve from the virtual upload map
And missing or cyclic includes produce diagnostics.

### SF-006 Image scenarios

Given file, animation, online_image, or Sendspin image declarations
When a scenario changes the selected state or image
Then the visible image source changes without rebuilding unrelated widgets.

### SF-007 Safe interaction

Given a preview button, switch, or page action
When the user interacts with it
Then supported visible LVGL actions run locally
And external ESPHome/Home Assistant actions are logged without network or hardware access.

### SF-008 Static deployment

Given a production build served over HTTP
When YAML and assets are uploaded in the browser
Then the visualizer works without access to the local workspace filesystem.

### SF-009 Real LVGL runtime

Given `public/wasm/lvgl_runtime.js` and `public/wasm/lvgl_runtime.wasm` are served over HTTP
When the visualizer loads
Then the SDL canvas is initialized through the exported LVGL bridge
And parsed objects, labels and buttons are created as real LVGL objects.

Given the runtime cannot be loaded
When the visualizer starts
Then the normalized DOM preview remains available
And diagnostics identify the WASM runtime failure.

### SF-010 Drag-and-drop upload

Given one or more YAML files or assets are dragged onto any part of the application
When the drop completes
Then YAML files are parsed immediately
And the first YAML file becomes the root configuration
And additional YAML files remain available for includes/packages
And non-YAML files are registered as assets.

### SF-011 Editor startup independence

Given the LVGL WebAssembly runtime is slow, unavailable, or still loading
When the application starts
Then the YAML editor and DOM preview are visible immediately
And typing and applying YAML still updates diagnostics and the preview
And WASM loading is reported separately without blocking the editor.

### SF-012 ESPHome single-page syntax

Given `lvgl.pages` is a mapping with `id`, dimensions, and `widgets`
When an ESPHome YAML file is parsed
Then it is normalized as one LVGL page
And the page widgets are rendered without a “No LVGL pages” diagnostic.

### SF-013 Demand-loaded fonts

Given YAML with no `font` declarations
When the preview renders
Then no external font request is made.

Given YAML with a `gfonts://` or typed Google Fonts declaration
When that YAML is parsed
Then only the declared family and weight are downloaded and registered with LVGL TinyTTF.

Given YAML with a hard-coded local font path, including an `extras` icon font
When the matching file was uploaded through Assets
Then its bytes are registered with the primary LVGL font or its fallback chain.

Given the matching local file was not uploaded
When font resolution runs
Then diagnostics name the missing path and the preview keeps a safe fallback font.

### SF-014 Online image downloads

Given an `image` declaration with `platform: online_image` and an initial `url`
When the YAML is parsed
Then the browser downloads and decodes that URL
And the resulting pixels are registered with the native LVGL image widget.

Given the visualizer runs through the local Vite server
And the remote image server omits CORS headers
When the image is requested
Then the loopback-only development proxy downloads it with protocol and size limits.

Given an online image download or decode fails
When synchronization completes
Then diagnostics identify the image ID and failure without blocking the rest of the preview.

### SF-015 Native switches and script mocks

Given an LVGL `switch` widget
When the preview renders or its mock checkbox changes
Then a native 50x25 LVGL switch displays its main, indicator, and knob parts
And it reflects the configured or mocked checked state.

Given a sensor `on_value` contains declarative `lvgl.label.update` or `lvgl.switch.update` actions
When its mock value or a linked LVGL switch mock changes
Then supported numeric formats and simple `x > 0` text, color, and checked branches update together
And arbitrary C++ lambdas are not executed.

Given mock entities are available
When Defaults is enabled
Then every mock receives a value appropriate to its sensor, text, boolean, number, select, or widget data type
And disabling Defaults restores the empty or false scenario.

Given a script containing one or more `lvgl.label.update` actions
When the YAML is parsed
Then each target label appears as an independent script mock
And entering a mock value updates every visible widget with that target ID
And the original label text remains until a mock value is entered.

Given a mock ID is wider than its control row
When the pointer hovers over the truncated name
Then the browser tooltip shows its complete ID.

### SF-016 Render scaling

Given a display resolution larger or smaller than the render panel
When Fit mode is active or the panel resizes
Then the complete surface scales proportionally into the available space without changing its render resolution.

Given 1:1 mode is selected
When the display exceeds the available panel size
Then every configured pixel maps to one screen pixel and the stage provides scrolling.

### SF-017 Bounded panel scrolling

Given YAML, mock entities, diagnostics, dimensions, or a 1:1 preview exceeds its panel height
When the workspace renders on desktop, tablet, or mobile
Then that content scrolls inside its own panel
And the panel header and neighboring render surface remain in place
And wheel or trackpad overscroll does not unexpectedly move a neighboring panel.

### SF-018 Problems panel and expanded mocks

Given diagnostics and mock entities are available
When the workspace renders on desktop or tablet
Then diagnostics appear as compact Problems-style rows in a full-width panel below the main workspace row
And the Mock Entities panel occupies the remaining side-column height with larger rows and controls.

Given the workspace renders on mobile
When panels stack vertically
Then Problems appears directly after the render surface
And diagnostics and mock entities retain independent scrolling without horizontal overflow.

### SF-019 Expandable source

Given the workspace opens on desktop or tablet
Then Source spans the editor and render columns
And Apply YAML or the source arrow collapses it to reveal the render column
And the arrow can expand it again.

### SF-020 Severity filters and rotation editing

Given Problems contains errors, warnings, or information
When a severity filter is toggled
Then only that severity changes visibility while all severity counts remain accurate.

Given Rotation is changed to a 90-degree step
Then `display.rotation` is inserted or updated in the editable YAML
And the reparsed model reflects that value.

### SF-021 Native LVGL layers

Given widgets are declared in `top_layer` or `bottom_layer`
When native LVGL renders
Then those widgets use the matching LVGL display layer
And top-layer labels remain readable on a dark transparent layer.

### SF-022 Linked widget selection

Given Link selection is enabled
When a YAML widget block is selected
Then its final native LVGL bounds are outlined over the preview
And the preview switches pages when the widget belongs to another page.

Given a nested configuration key is also named `lvgl`, such as `logger.logs.lvgl`
When source ranges are assigned
Then only the top-level `lvgl` section is scanned for widget definitions.

Given widgets use content sizing, percentages, alignment, parent padding, duplicate content, or overlapping bounds
When a preview widget is hovered or clicked
Then hit testing uses final LVGL coordinates and z-order
And empty or zero-width widgets have a minimum interaction target around their native anchor
And the exact source file and YAML block are revealed
And clicking selects that block in the editor
And its first line is centered in the editor when scroll limits allow
And a visible editor decoration remains synchronized when the editor loses focus or scrolls.

Given a widget is clicked in the preview
When the pointer moves across other widgets in the same preview visit
Then the clicked widget remains selected in both surfaces
And rendering, resizing, and asynchronous asset completion do not change the selection.

When the pointer leaves the preview and later enters it again
Then hover can select a different widget
And an explicit click can always replace the current selection.

Given two anonymous widgets have the same type and content
When either is clicked
Then its unique source block is selected without matching by type or text alone.

Given Link selection is disabled
Then neither surface changes or displays linked selection state
And both existing linked highlights are removed immediately.

### SF-023 YAML editing

Given a YAML document is open
Then mappings and sequences with nested content can be folded and unfolded
And standard editor undo and redo restore text edits, paste, and indentation
And selection, folding, preview navigation, and rendering do not create text-history entries.

Given the editor is initialized before its webfont finishes loading
When the font becomes available or another font loads later
Then the caret and mouse hit testing use the current rendered character widths
And End, arrow navigation, typing, Backspace, and Delete operate at the visible caret position
And this remains true when long lines scroll horizontally on a narrow viewport.

Given more than one YAML file is uploaded
Then each file keeps its own editor model and undo history
And opening an included or packaged widget selects its source file without changing the root file used for parsing.

### SF-024 Substitution resolution

Given YAML uses `$name`, `${name}`, a chained value, or a substituted local include filename
When the visualizer parses the project
Then preview properties receive the resolved value without rewriting the editor source
And complete scalar substitutions preserve YAML types
And hash colors remain strings instead of YAML comments.

Given a substitution is missing, cyclic, or uses an unsupported Jinja expression
Then a diagnostic identifies the problem rather than silently previewing a guessed value.

### SF-025 Local package and include provenance

Given a widget is expanded from an uploaded local include or package
When that widget is selected in the preview
Then the editor opens its original uploaded source file and selects its source block.

Given a mapping or list package uses an uploaded local YAML file
Then package widgets are merged into the preview and retain their source provenance.

## Change protocol

For every later functional change:

1. Update the affected requirement or add a new scenario here.
2. Record parser, normalized model, WASM bridge, UI, asset, and compatibility impact.
3. Add or update automated tests, or state why manual verification is required.
4. Update README and CHANGELOG when user-visible behavior or support changes.

## Implementation mapping

| Scenario | Automated verification |
| --- | --- |
| SF-001, SF-004, SF-005 | `src/yaml.test.ts` |
| SF-009 | `npm run build:wasm`, generated `public/wasm` artifacts, and browser smoke test |
| SF-002, SF-003, SF-006, SF-007, SF-008 | Browser UI regression coverage and manual static-server verification |
| SF-010, SF-011 | Root command smoke test, typecheck, and browser startup verification |
| SF-013 | `src/yaml.test.ts`, `src/font-loader.test.ts`, `npm run build:wasm` |
| SF-014 | `src/yaml.test.ts`, `src/image-loader.test.ts`, `npm run build:wasm`, browser smoke test |
| SF-015 | `src/yaml.test.ts`, `npm run build:wasm`, browser interaction smoke test |
| SF-016 | Browser Fit/1:1 interaction and screenshot verification |
| SF-017 | Responsive browser screenshot verification with `kitchen.yaml` |
| SF-018 | Responsive browser layout and overflow verification with `kitchen.yaml` |
| SF-019, SF-020 | Browser interaction verification for source controls, severity filters, and YAML rotation updates |
| SF-021 | `npm run build:wasm` and native canvas screenshot verification |
| SF-022 | Native coordinate bridge build, duplicate source-range test, and browser round-trip verification with aligned fixtures and `kitchen.yaml` |
| SF-023 | `src/selection.test.ts`, `src/yaml.test.ts`, and `npm run test:e2e` for folding, history, both selection directions, file navigation, caret/text alignment, mouse editing, late fonts, and horizontal scrolling at desktop/mobile widths |
| SF-024 | `src/yaml.test.ts` for typed, chained, embedded, color, and include-filename substitutions; Jinja remains out of scope |
| SF-025 | `src/yaml.test.ts` and `npm run test:e2e` for include/package source ranges and file switching |

SF-022 through SF-025 update the YAML parser/model and browser editor integration. The native LVGL bridge remains unchanged; both native and DOM preview selection paths are covered in the browser where available.

The SF-023 caret correction refreshes Monaco font measurements after initial and subsequent browser font loads. It changes editor rendering and mouse hit testing only; parser, normalized model, WASM bridge, preview assets, and ESPHome compatibility remain unchanged.

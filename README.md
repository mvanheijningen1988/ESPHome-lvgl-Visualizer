# ESPHome Visualizer

Browser-based ESPHome LVGL visualizer. The browser slice includes live YAML parsing, multi-file includes/packages, LVGL page/widget normalization, diagnostics, uploaded image previews, mock entity controls, and a responsive preview adapter. The target renderer is LVGL 9.5 compiled to WebAssembly.

## Development

```bash
npm install
npm run dev
npm run build:wasm
npm run build
npm run build:all
```

The project now bootstraps `./third_party/lvgl` automatically before npm scripts run. By default it resolves the latest LVGL GitHub release, and you can pin an explicit version either through the environment or the script argument:

```bash
LVGL_VERSION=9.5.0 npm run build:wasm
npm run setup:lvgl -- --version 9.5.0
```

From the workspace root, the same commands are available through the forwarding scripts in `../package.json`.

`npm run build:wasm` compiles LVGL from `./third_party/lvgl` with Emscripten and copies the real runtime to `public/wasm`. The app must be served over HTTP. Opening the WebAssembly build through `file://` is not supported by browsers.

The editable YAML surface is initialized before the optional WASM renderer. A slow or failed LVGL load therefore cannot hide the editor or stop live preview parsing.

Fonts are loaded on demand from the active YAML. `gfonts://Family` and `{ type: gfonts, family, weight }` declarations fetch a matching TrueType file only after parsing that declaration. Hard-coded local paths such as `fonts/icons.ttf` are never read from the host filesystem: add the matching file through **Assets**. Missing or invalid fonts produce a diagnostic and use the built-in LVGL fallback. `extras` fonts are registered as fallback fonts for icon glyphs.

Images declared with `platform: online_image` are downloaded automatically from their initial `url`, decoded by the browser, and registered as native LVGL images. The local Vite server proxies these downloads so LAN image servers without CORS headers work during development. Static deployments fetch remote images directly, so those image servers must allow browser CORS requests. Dynamic `online_image.set_url` lambdas are not executed by the visualizer.

The render surface defaults to **Fit**, preserving the configured resolution while scaling the complete display into the available preview area. Select **1:1** to inspect native pixels with scrolling when the display is larger than the panel. LVGL switches use the real native 50x25 switch widget with visible main, indicator, and knob parts. Their mock checkbox reflects both direct values and supported sensor-driven `lvgl.switch.update` actions. Related `lvgl.label.update` format values and simple `x > 0` text/color branches update with the same mock; arbitrary C++ is never executed. Script label targets remain available as independent mock values. Hover a truncated mock name to see its full ID.

Mock entities start empty or false. Enable **Defaults** to populate every mock with a value appropriate to its data type, including numeric sensor values, text, booleans, number midpoints, and the first select option. Disabling it restores the empty/false scenario.

Workspace panels keep a bounded responsive height. Long YAML, mock entity lists, diagnostics, dimensions, and 1:1 previews scroll inside their own panels, so one growing list cannot push the render surface out of view. Diagnostics use a compact VS Code Problems-style panel below the workspace, while the expanded Mock Entities panel uses larger rows and controls.

Source opens expanded across the editor and render columns. **Apply YAML** or the source arrow returns it to the compact editor column. The YAML editor shows scroll-synchronized line numbers. The Problems toolbar filters errors, warnings, and information independently while retaining per-severity counts. Rotation is editable in 90-degree steps and updates `display.rotation` in the YAML source.

With **Link selection** enabled, selecting a YAML widget outlines its final LVGL bounds in the preview; selecting a widget on another page switches the preview to that page. Hovering a native or fallback preview widget reveals its exact YAML block with a focus-independent, scroll-synchronized highlight band, while clicking also selects that block in the editor. Duplicate anonymous widgets remain distinct, overlapping widgets follow LVGL z-order, and empty or zero-width widgets receive a small interaction target around their real LVGL anchor. Disable the checkbox to remove both linked highlights and inspect or edit the surfaces independently. Native `top_layer` and `bottom_layer` widgets render on their matching LVGL display layers, with readable default label text unless YAML specifies `text_color`.

## Scope

ESPHome 2026.8 is the primary syntax target. Select all related YAML files together or drag them anywhere onto the application; the first YAML file is the root and the rest are available to `!include` and package resolution. Local uploads, includes, packages, demand-loaded fonts, all official LVGL widget names, image platforms, mock entity scenarios, and static deployment are tracked in [SPEC_FLOW.md](./SPEC_FLOW.md). Unknown C++ lambdas are never executed; only the documented format and simple conditional update patterns are interpreted for preview state.

The native Emscripten compiler is an environment dependency (`emcc`, `emcmake`, CMake). The checked-in `public/wasm/lvgl_runtime.js` and `.wasm` are the generated LVGL runtime artifacts; if a browser cannot load them, the DOM preview remains visible and reports the runtime diagnostic.

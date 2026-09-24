# Changelog

## Unreleased

- Started the ESPHome LVGL visualizer project.
- Added live YAML parsing with ESPHome tag placeholders and LVGL page/widget normalization.
- Added the first editor, diagnostics, resolution controls, and preview shell.
- Added multi-file YAML upload with include/package resolution, image asset previews, mock entity controls, and parser regression tests.
- Added the compiled LVGL 9.5 WebAssembly runtime, SDL canvas bridge, real LVGL object creation, runtime resize/reset, and DOM fallback diagnostics.
- Fixed YAML upload by adding drag-and-drop support across the entire application, including multi-file includes and asset registration.
- Fixed startup so the editor does not wait for LVGL WASM, and added root-level npm command forwarding for the workspace launch command.
- Fixed parsing of ESPHome's single-page `lvgl.pages` mapping syntax used by `kitchen.yaml`.
- Fixed SDL keyboard capture so the YAML editor remains editable while the LVGL runtime is active.
- Replaced prebundled project fonts with demand-driven LVGL TinyTTF registration. Declared Google Fonts download after parsing, while hard-coded local and `extras` fonts must be supplied through Assets and report precise missing-file diagnostics.
- Added automatic downloads for declared `online_image` URLs, browser decoding, native LVGL image rendering, download diagnostics, and a loopback-only development proxy for LAN sources without CORS headers.
- Added native LVGL switch rendering with mockable checked state, per-target script label mocks, full mock IDs on hover, and responsive Fit/1:1 render-surface scaling.
- Constrained workspace panels to responsive heights and added independent scrolling for YAML, render, dimensions, mock entities, and diagnostics so long lists no longer push the preview out of view.
- Moved diagnostics into a compact Problems-style panel below the workspace and expanded Mock Entities with more space, larger rows, and larger controls.
- Added an expandable Source overlay, independent Problems severity filters, YAML-synchronized rotation editing, native LVGL top/bottom layers, and optional linked selection between YAML widgets and preview bounds.
- Fixed linked selection to use deterministic YAML ranges and final native LVGL coordinates, including content-sized/aligned widgets, duplicates, overlapping z-order, accurate editor reveal, and automatic page switching.
- Fixed linked-selection visibility by adding a focus-independent YAML block highlight that remains synchronized with editor scrolling and pairs with the renderer outline in both directions.
- Fixed renderer-to-YAML selection for empty and zero-width widgets with native-anchor hit targets, kept hover from replacing a clicked editor selection, and added scroll-synchronized YAML line numbers.
- Fixed native switches to retain ESPHome/LVGL's 50x25 default size and render visible main, indicator, and knob states.
- Added typed opt-in mock defaults and local propagation of supported sensor-driven label text, text color, and switch checked updates.
- Fixed renderer-to-YAML highlighting when an earlier nested key such as `logger.logs.lvgl` previously hid all top-level widget source ranges.

# ESPHome LVGL Visualizer

ESPHome LVGL Visualizer is a browser-based tool for previewing and validating ESPHome YAML configurations that use LVGL widgets. It parses YAML, resolves includes and substitutions, links preview elements back to the source YAML, and provides a live visual preview of the rendered UI.

## Features

- ESPHome YAML parsing and diagnostics
- LVGL preview with native WebAssembly rendering
- DOM fallback when native rendering is unavailable
- Multi-file include and package support
- Source-to-preview and preview-to-source linking
- Monaco-based YAML editor with folding and history
- Support for substitutions, includes, and package resolution

## Quick start

Run the image locally:

```bash
docker run --rm -p 5173:5173 <your-dockerhub-user>/esp-home-lvgl-visualizer:latest
```

Then open:

```text
http://localhost:5173/
```

## Available tags

- `latest` — latest stable build from the `main` branch
- `1.0.0` — stable release version
- `1.0.0-dev` — development build from the `development` branch

Example:

```bash
docker run --rm -p 5173:5173 <your-dockerhub-user>/esp-home-lvgl-visualizer:1.0.0-dev
```

## What this image contains

This image runs the production preview server for the application and exposes port `5173`.

## Project status

This project is designed to help visualize ESPHome + LVGL UI layouts directly in a browser, making it easier to validate YAML structure and preview layout behavior before deploying to hardware.

## Notes

The image is intended for local use and browser-based preview. It does not compile or flash ESPHome firmware; it focuses on visual validation of YAML and LVGL layout behavior.

For the latest project details and source code, see the project repository.

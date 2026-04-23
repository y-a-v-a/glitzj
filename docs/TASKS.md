# Glitzj — Tasks

## Phase 1: Project scaffold

- [x] Create `index.html` with basic page structure, before/after panel layout, and `<meta name="viewport">` for mobile scaling
- [x] Create `style.css` with responsive before/after layout: side-by-side on desktop, stacked on mobile (breakpoint at ~768px)
- [x] Implement dark and light mode via `prefers-color-scheme` media query; all colours defined as CSS custom properties
- [x] Ensure all interactive controls (buttons, sliders, inputs) have touch-friendly tap targets (minimum 44×44px)
- [x] Create `main.js` as the entry point (no build toolchain required for v1)

## Phase 2: JPEG loading and validation

- [x] Implement file input (click to open + drag-and-drop onto the before panel)
- [x] Guard: reject files > 10 MB immediately from the `File` object, before reading
- [x] Decode the file into an `<img>` element and guard: reject if width > 4000 or height > 4000
- [x] Implement JPEG marker-walk to parse the segment structure
- [x] Guard: reject malformed JPEGs that do not contain a valid frame marker (`SOFn`)
- [x] Walk entropy-coded data across all `SOS` segments, treating `0xFF00` as byte-stuffing and `RSTn` markers (`0xFFD0`–`0xFFD7`) as protected boundaries rather than mutable bytes
- [x] Extract and store the mutable scan ranges plus total logical scan length for use by strategies
- [x] Display clear, specific error messages for each rejection condition

## Phase 3: Controls and UI state

- [x] Render the original image in the before panel after successful load
- [x] Intensity slider (0–100) shared across all strategies
- [x] Seed number input with a "Randomise" button that picks a new random seed
- [x] Six strategy toggle buttons: Static, Dropout, Echo, Drift, Smear, Crumble
- [x] Reset button: clears all active strategies and resets intensity/seed, restoring after panel to match before
- [x] Export button: initially disabled; enabled only when the after panel shows a renderable result

## Phase 4: Strategy engine

- [x] Implement the strategy pipeline: copy the original `Uint8Array`, apply all active strategies in fixed order (Static → Dropout → Echo → Drift → Smear → Crumble), return the mutated buffer
- [x] Re-run the pipeline whenever intensity, seed, or active strategies change
- [x] **Static:** XOR-mask scan bytes with seeded PRNG values; intensity drives mutation density (0–100% of scan bytes)
- [x] **Dropout:** zero out 1–5 randomly placed byte runs; intensity drives total zeroed length (0–30% of scan data); run count scales with intensity
- [x] **Echo:** locate a source block at a seed-derived offset (fixed length: 2% of scan data); paste it over adjacent ranges; intensity drives repetition count (1–8)
- [x] **Drift:** shift a run of scan bytes forward by N positions; intensity drives shift distance (0–5% of scan data length)
- [x] **Smear:** add random byte-value offsets to the early scan data region; intensity drives how far into the scan data the corruption reaches (0–25% of scan data length)
- [x] **Crumble:** add random byte-value offsets to the late scan data region; intensity drives how far back from the end the corruption reaches (0–25% of scan data length)

## Phase 5: Renderability and export

- [x] After each pipeline run, attempt to render the mutated buffer as a `Blob` URL in the after `<img>` element
- [x] Listen for the `<img>` `error` event to detect unrenderable output; show "image broken" message in the after panel and disable the export button
- [x] On successful render, update the after panel and enable the export button
- [x] Export: on click, trigger a download of the current mutated `Uint8Array` as a `.jpg` file

## Phase 6: Auto-retry (opt-in)

- [x] Add an opt-in toggle for auto-retry (off by default)
- [x] When enabled and output is unrenderable, increment the seed and re-run the pipeline; repeat up to a configurable maximum number of attempts
- [x] If a renderable result is found, update the seed input in the UI to reflect the successful seed
- [x] If max attempts are exhausted without a renderable result, show "image broken" as normal

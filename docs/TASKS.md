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

## Phase 7: Robustness and polish

- [x] Marker protection pass after the pipeline (rewrite fake `0xFF xx` pairs inside scan ranges to `0xFE xx`), on by default with a "Protect markers" toggle
- [x] Render generation counter so a superseded pipeline result can never overwrite a newer one, including mid auto-retry chain
- [x] Coalesce bursts of input events into one pipeline run per animation frame
- [x] Revoke stale blob URLs for both panels; keep exactly one live URL per panel
- [x] Apply active strategies immediately after a file loads
- [x] Tolerate JPEGs without an `EOI` marker
- [x] Sniff file type from magic bytes; specific errors for PNG/GIF/WebP/HEIC/SVG
- [x] Inline error region (`role="alert"`) instead of `alert()`
- [x] Drop files anywhere on the page; paste images from the clipboard
- [x] Keyboard-accessible drop zone, `aria-pressed` on strategy toggles, visible focus rings, `R`/`E` shortcuts
- [x] Info line: dimensions, size, frame type, scan count; after-panel note when auto-retry changed the seed
- [x] Settings mirrored in the URL hash and restored on load
- [x] Reproducible export filename with strategies, intensity and seed
- [x] Node test suite with synthetic JPEG builder (`npm test`)

## Phase 8: PNG support

- [x] PNG chunk walk: signature, IHDR first, consecutive IDAT, specific errors; tolerate a missing IEND or a file cut off inside IDAT
- [x] Keep ancillary chunks that stay valid when pixels change; drop unsafe-to-copy chunks (`iDOT`, APNG animation chunks)
- [x] Row layout for every color type and bit depth, including Adam7 interlacing
- [x] Inflate IDAT once at load with `DecompressionStream`, capped at the size the header promises
- [x] Guard: reject PNGs whose decompressed image data exceeds 64 MB, before inflating
- [x] Unfilter and re-filter rows (None, Sub, Up, Average, Paeth) with per-type loops
- [x] Run the existing strategies on the raw stream, with per-filter density weights for Static, Smear and Crumble and sparse sampling on the PNG path; JPEG output unchanged (pinned by a digest test)
- [x] Filter protection: restore every row's filter byte after the strategies, on by default ("Protect filters")
- [x] Prism strategy (PNG only): swap the filter type of 0–10% of rows
- [x] Filter control: re-encode the base image with one filter before glitching
- [x] Keep alpha: restore the original transparency after glitching, on by default
- [x] Encode previews as stored deflate blocks written straight into one IDAT chunk, with fresh Adler-32 and CRCs (slice-by-8)
- [x] Export: re-pick filters per row and compress with `CompressionStream`, prepared in the background in time slices; superseded jobs cancelled
- [x] Sparse strategies and Prism make a fixed number of hits (at least one) with integer-exact arithmetic, so shared links reproduce across browsers
- [x] Cut-off PNGs: strategies and density skip rows that never inflated
- [x] Export name marks protection off (`_raw`) and alpha off (`_noalpha`)
- [x] Format-aware UI: info line, tooltips, PNG-only controls, checkerboard behind transparent images, PNG settings in the URL hash and export name
- [x] Ignore stale loads when files are opened in quick succession; export the result on screen with its own name and data
- [x] Node test suite for PNG with synthetic files built by Node's `zlib`

## Phase 9: Glitch JPEG as PNG

- [x] "Glitch as PNG" toggle for JPEG files, mirrored in the hash as `png=1`
- [x] Draw the JPEG to a canvas and build an RGB PNG source from its pixels, with libpng-style per-row filters as its "original" filters
- [x] Keep the JPEG scan data so the toggle switches back at once; cache the PNG source per file
- [x] Show "converting to PNG…" until the source is ready; discard conversions for replaced files
- [x] Export the converted result as PNG

## Phase 10: GIF support

- [x] GIF block walk: header, color tables, extensions, frames; NETSCAPE loop count and transparent index; specific errors; tolerate a missing trailer or a file cut off inside a block
- [x] Measure how Chrome, Firefox and macOS ImageIO treat damaged LZW data: bad codes, early end codes, short and long frames, palette indices past the table
- [x] Unpack each frame's LZW codes once at load; run the existing strategies on the codes, so moved codes keep their meaning (strategy helpers keep the buffer's type; JPEG output unchanged, pinned by the digest test)
- [x] Code repair ("Protect codes", on by default): replace codes decoders give up on, wrap palette indices, trim long frames, roll short frames around to their top
- [x] Raw mode: pack damaged codes as they are and report frames decoders cut off in the after panel
- [x] Prism on GIF: rotate the channels of palette entries, flip a top bit of grays; picks weighted by pixel count
- [x] All frames glitched; Steady toggle for the same random choices on every frame, mirrored in the hash as `steady=1` and in the export name as `_steady`
- [x] Guard: reject GIFs whose frames add up to more than 200 million pixels, before unpacking
- [x] Format-aware UI: info line, tooltips, "Protect codes", checkerboard, Prism, GIF export
- [x] Node test suite for GIF with an independent LZW encoder and reference decoder
- [x] Verify repaired output renders identically in Chrome, Firefox and ImageIO

## Phase 11: GIF dither page

- [x] Separate page `gif.html` that renders an image as a dithered GIF instead of glitching it; nav between the two pages
- [x] Pure module `dither.js`: shrink by dot size (alpha-weighted block average), brightness and contrast, palettes (median cut, grayscale, duotone, web-safe, RGB), dithering (seven error-diffusion kernels with serpentine scanning, Bayer 2/4/8, seeded noise, off), strength
- [x] GIF89a writer with its own LZW encoder; end code written at the width decoders read it with
- [x] Transparency: pixels below half opacity get a reserved index in a graphic control extension
- [x] Nearest-color search sorted by red with early exit, cached per 6-bit cell
- [x] Settings mirrored in the hash; renders coalesced per animation frame; 1:1 view; export at dot or original size
- [x] Node tests with an independent LZW decoder; Chrome's decoder matched it pixel for pixel on every tested setting

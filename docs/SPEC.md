# Glitzj

The glitch making app

## Purpose

A glitch in an image is a visual representation of data deformation without totally breaking the image's data signature. In other words, a glitch is bended data — an erroneous derivative of the original, but one whose data is still understood by common image rendering engines (the browser, OS image previews, etc.).

The app lets a user load a JPEG or PNG image and apply one or more glitch strategies to it in a controlled way. Only renderable results can be exported — the output is always a valid file of the same format.

JPEG was the first target format because its compressed scan data is tolerant of byte-level corruption, producing visually interesting artifacts. PNG guards its pixel data with a zlib stream and per-chunk CRC checksums, so damaging the file in place only produces broken images. Glitzj therefore glitches PNG one level down, in the decompressed scanline data, and re-encodes the result (see [PNG](#png)).

**v1 operates on any JPEG layout the browser can decode, including baseline sequential JPEGs, progressive JPEGs, and files that use restart markers.** Rather than assuming one contiguous scan between a single `SOS` and `EOI`, the parser walks the full marker structure, gathers every entropy-coded byte range across all scans, and leaves structural markers untouched.

Validation happens in two stages before any strategy processing begins:
1. Perform a full marker-walk through the JPEG structure to locate a frame marker (`SOFn`) and every entropy-coded scan range.
2. While scanning entropy data, treat `0xFF00` as byte-stuffing and `RSTn` (`0xFFD0`–`0xFFD7`) as protected restart markers, splitting the mutable ranges around them instead of rejecting the file.

## Interface

- **Before/after layout:** the original image on the left, the glitched result on the right. An info line above the original shows dimensions and file size, then for JPEG the frame type (baseline/progressive) and scan count, and for PNG the color type, bit depth, interlacing and whether animation frames were dropped. PNG panels show a checkerboard behind the image so transparency is visible.
- **Loading:** click or press Enter/Space on the before panel to open a file picker, drop a file anywhere on the page, or paste an image from the clipboard (screenshots paste as PNG). The file type is sniffed from its first bytes, so a mislabeled MIME type does not matter and GIF/WebP/HEIC/SVG input gets a specific error. Errors appear inline below the panels, never as a blocking dialog. When files are opened in quick succession, only the last one is loaded.
- **Live update:** the after panel updates as soon as a file is loaded and on every settings change. Bursts of input (dragging the intensity slider) are coalesced into one pipeline run per animation frame, and a result that belongs to superseded settings is discarded rather than shown.
- **Shareable settings:** active strategies, intensity, seed, protection, and for PNG the filter and alpha setting are mirrored into the URL hash (`#fx=static,prism&i=40&s=3&f=paeth`). Opening that link restores the settings; combined with the same source image it reproduces the exact result. Strategies the loaded format cannot use stay in the hash but are ignored.
- **Broken state:** if the current settings produce a file that cannot be rendered, the "after" panel shows a simple "image broken" message instead of crashing or showing nothing.
- **Reset button:** reverts all glitch settings (strategies, intensity, seed and PNG filter), restoring "after" to match "before".
- **Export button:** saves the glitched image to disk as `<original>_glitzj_<strategies>_i<intensity>_s<seed>.jpg`, or `…_s<seed>[_<filter>].png` for PNG, with `_raw` appended when protection is off and `_noalpha` when Keep alpha is off, so the filename alone documents how to reproduce it. The name and contents belong to the result on screen, even while a newer render is still pending. Disabled whenever the current output is in a broken state — export is only available for renderable results.
- **Keyboard:** `R` picks a random seed, `E` exports (when not typing in an input).

### Controls

Two shared controls apply to all active strategies:

- **Intensity** — a 0–100 slider controlling the magnitude of the effect across all active strategies
- **Seed** — a numeric value that influences the random decisions in each strategy (which ranges are targeted, where blocks are placed, which bytes are selected). It steers the character of the glitch rather than guaranteeing bit-identical output. Includes a "randomise" button to pick a new seed at random.

Shown only while a PNG is loaded:

- **Filter** — Original, None, Sub, Up, Average or Paeth: the PNG filter the image is re-encoded with before glitching (see [Why filters matter](#why-filters-matter)).
- **Prism** strategy button, and **Keep alpha** for images with an alpha channel. The protection toggle reads "Protect filters" instead of "Protect markers".

Shown only while a JPEG is loaded:

- **Glitch as PNG** — glitches the JPEG through the PNG pipeline instead (see [JPEG as PNG](#jpeg-as-png)). Mirrored in the hash as `png=1`; it stays set when a PNG is loaded, for the next JPEG.

## Glitch strategies

The strategies below are described in JPEG terms. How they behave on PNG data, and the PNG-only Prism strategy, are covered under [PNG](#png).

JPEG stores compressed image data in one or more entropy-coded scans. Baseline files usually place this data in one long run; progressive files spread it across multiple passes; restart markers may split a scan into smaller chunks. Glitzj flattens those mutable byte ranges into one logical scan stream so the strategies can still target the "early", "middle", and "late" parts of the compressed data without corrupting the JPEG markers themselves. This gives corruption a predictable visual character depending on *where* in the logical scan data it is applied:

- **Early bytes** → low-frequency data → color smears, tone shifts, large-scale distortion
- **Late bytes** → high-frequency data → edge/detail destruction, image stays recognisable
- **Contiguous runs** → entire rows of blocks break at once → TV signal dropout appearance

The user can enable any combination of the following named strategies. Each strategy manages its own target range and pattern internally — the user only exposes intensity (0–100) and seed. What intensity *means* is defined per strategy below.

### Strategy catalogue

**Static**
XOR-masks the full scan data with seeded pseudo-random values.
- *Intensity drives:* mutation density — the percentage of scan bytes that are XOR'd. At 0 nothing is touched; at 100 every byte is affected.
- *Visual character:* scattered pixel noise distributed across the whole image.

**Dropout**
Zeroes out one or more contiguous byte ranges in the scan data.
- *Intensity drives:* total zeroed length as a percentage of scan data (0–30%), distributed across 1–5 randomly placed runs (run count also scales with intensity).
- *Visual character:* solid colour patches and missing blocks.

**Echo**
Copies a source block and pastes it over adjacent byte ranges repeatedly. The source block's start offset within the scan data is derived from the seed. Source block length is fixed at 2% of scan data.
- *Intensity drives:* number of repetitions (1 at minimum intensity, up to 8 at maximum).
- *Visual character:* banding and repeated horizontal patterns.

**Drift**
Shifts a run of scan bytes forward by N positions, displacing their neighbours.
- *Intensity drives:* shift distance — 0 to 5% of scan data length in bytes.
- *Visual character:* image tears and displaced rows.

**Smear**
Adds random byte-value offsets to the early portion of the scan data (low-frequency DCT coefficients).
- *Intensity drives:* how far into the scan data the corruption reaches — 0 to 25% of scan data length.
- *Visual character:* colour bleeds and large-area distortion; overall structure survives.

**Crumble**
Adds random byte-value offsets to the late portion of the scan data (high-frequency DCT coefficients).
- *Intensity drives:* how far back from the end of the scan data the corruption reaches — 0 to 25% of scan data length.
- *Visual character:* edge and detail destruction; overall image stays recognisable.

Multiple strategies can be active simultaneously. Their effects are applied to the same byte buffer in fixed catalogue order: Static → Dropout → Echo → Drift → Smear → Crumble. This order is invariant and not user-configurable in v1.

## PNG

### Pipeline

1. **Load (once per file).** Walk the chunks, check the decompressed size against the limit from the header alone, concatenate the IDAT data and inflate it with `DecompressionStream`. The result is the *raw stream*: for every row, one filter-type byte followed by the row's filtered bytes; interlaced (Adam7) images have seven passes of such rows. A row layout records where every row and filter byte sits. Inflating stops at the size the header promises, so a stream that inflates to more cannot exhaust memory. A cut-off stream keeps the rows that did inflate; the rows that never arrived are all zeros, so strategies and the density scale leave them out.
2. **Base.** By default the raw stream as stored in the file. With the Filter control set to None, Sub, Up, Average or Paeth, the image is unfiltered once and every row re-encoded with that filter. Re-filtering is lossless; it only changes how later damage spreads. Only the most recent re-filtered base is cached, and switching back to Original releases it.
3. **Byte strategies** (Static → Crumble, the catalogue order above) run on a copy of the base, treating the whole raw stream, filter bytes included, as one logical scan.
4. **Filter protection** (optional, on by default) restores every row's filter byte from the base.
5. **Prism** (PNG only) runs after protection, because changing filter bytes is its purpose.
6. **Alpha restore** (optional, on by default, images with an alpha channel only) decodes the rows and copies the original alpha back.
7. **Encode.** The raw stream is written as a zlib stream of stored (uncompressed) deflate blocks straight into a single IDAT chunk, with fresh Adler-32 and CRCs. Stored blocks are much faster than compressing, which matters for the live preview. A single IDAT of the maximum size (61 MB) decoded in Chrome, Firefox and ImageIO.

The output keeps IHDR, PLTE and every ancillary chunk that stays valid when only pixel values change (the standard ones plus any marked safe-to-copy). Chunks marked unsafe-to-copy are dropped, among them Apple's `iDOT` (which points at IDAT offsets) and the APNG animation chunks, so an animated PNG becomes a still image of its default frame. A missing IEND or a file cut off inside IDAT is accepted, since browsers render such files.

### Why filters matter

PNG predicts each byte from its left neighbor (Sub), the byte above (Up), their average (Average) or a choice among left, above and upper-left (Paeth); None predicts nothing. The decoder adds the prediction back, so a damaged byte carries on into every pixel predicted from it. On test images this gave each filter a recognizable look: None leaves single damaged pixels, Sub horizontal streaks, Up vertical streaks, Average soft diagonal smears and Paeth blocky mosaics. That is why the Filter control exists.

### Strategies on PNG

- **Static, Smear, Crumble** would bury the image in noise at JPEG densities, because every hit spreads. On PNG their per-byte odds are scaled by the average of a per-row weight taken from the base's filter types: None 2%, Sub/Up/Average 0.05%, Paeth 0.01% (on a textured test image Paeth cascaded furthest). The scale is recomputed when the Filter control changes. At these densities a random number per byte would be wasted work, so the PNG path makes a fixed number of hits, `round(length × density)` and at least one when intensity is above 0, at seeded random positions, each changing its byte by a nonzero amount. This involves only integer-exact arithmetic, so a seed gives the same result in every browser. The JPEG path keeps drawing one number per byte, so JPEG results for a given seed are unchanged. "Early" and "late" data are the top and bottom rows of the image.
- **Dropout, Echo, Drift** work unchanged. Because filtered bytes are differences, zeroed runs make pixels repeat what they are predicted from, and shifted runs slide pixels and color channels out of place.
- **Prism** swaps the filter type of randomly chosen rows to a different valid type without re-encoding them, so those rows, and the rows predicted from them, decode into bands of shifted color. An invalid filter byte (protection off) is left as it is. *Intensity drives:* the share of rows picked, 0–10%, at least one row above intensity 0.

### Filter protection

Without protection, strategies hit filter bytes too. A changed but valid filter byte re-reads every following row through the wrong filter, which buries whatever the strategy did, and a value above 4 is invalid. Observed behavior for a file with one invalid filter byte: Chrome decodes up to that row and leaves the rest transparent; Firefox shows no image; macOS ImageIO, the decoder Safari and Preview build on (tested through `sips`), decodes past it. "Protect filters" restores the original filter bytes so damage stays in the pixel data; with it on, Chrome, Firefox and ImageIO all showed every test image in full; turning it off gives the raw behavior, which differs per viewer.

### Alpha restore

Damaged alpha bytes punch holes, and because filters predict each row from the one above, a single damaged row can leave everything below it transparent; on an opaque RGBA test image most results were simply empty. "Keep alpha" decodes the glitched rows (stopping at an invalid filter byte, so the raw behavior is preserved), copies the original alpha back and stores the rows unfiltered. At 8 and 16 bits per channel every filter predicts a byte only from the same channel, so color damage is untouched by this.

### Export

The preview file is uncompressed and can be many times larger than the source. Export instead re-picks each row's filter, keeping whichever of the row as it stands and the five filters applied to the decoded row has the lowest libpng-style score (sum of filtered bytes read as signed values), and compresses with `CompressionStream`. Decoded pixels are identical to the preview; rows from an invalid filter byte on are left alone. Scoring six candidates per row takes seconds at the size limit, so this work yields to the page every 12 ms. The compressed file is prepared in the background once a result has been on screen for 400 ms, so a click usually downloads at once; a job for a result that has since been replaced is cancelled unless an export is waiting for it. Results above 16 MB of raw data are compressed on click instead, with the button showing "Exporting…". The export name and data belong to the result on screen, taken when that output was built. If compression fails, the uncompressed encoding of the same result is downloaded instead.

### JPEG as PNG

With "Glitch as PNG" on, a loaded JPEG is drawn to a canvas as the browser shows it (orientation applied, colors in the canvas color space) and its pixels become an 8-bit RGB PNG source in memory. From there everything in this section applies unchanged, and export produces a PNG named `….png`. A JPEG has no PNG filters of its own, so "Original" means the per-row filter choice libpng-style encoders make (the same scoring as export). The JPEG's scan data stays loaded, so switching the toggle off returns to the JPEG pipeline at once; the PNG source is built on first use and cached per file. Until it is ready, the after panel shows "converting to PNG…" rather than a result for the other format; on test images this took about 0.4 s at 2000 × 1500 and 1.7 s at 4000 × 3000, with the page responsive throughout. A conversion for a file that has since been replaced is discarded.

The exported PNG carries no metadata from the JPEG. Browsers may decode the same JPEG to slightly different pixels, so a `png=1` link reproduces exactly only in the browser that made it.

## Iteration / validity

### Marker protection

Inside entropy-coded data a `0xFF` byte may only be followed by `0x00` (byte stuffing); any other pair is a marker. Byte-level mutation inevitably creates such pairs, or breaks an existing stuffing pair by changing its `0x00`. Decoders react to a fake marker by leaving the scan early: libjpeg (Chrome, Firefox) pads the rest with zero bits, so everything below that point decodes as flat color. On a test image, Static and Smear left roughly 90% of the block rows flat without protection and 0% with it.

After the pipeline has run, an optional pass rewrites every offending `0xFF` inside the mutable ranges to `0xFE`. Structural markers, restart markers and legitimate stuffing pairs are untouched, and the glitch itself is preserved. This is on by default ("Protect markers"); turning it off restores the raw behavior for those who want the cut-off look.

For PNG, "Protect filters" plays the same role; see [Filter protection](#filter-protection).

### Renderability check

The output is always tested for renderability before the export button is enabled. When active strategies produce an unrenderable file, the app can optionally auto-retry with incremented seeds until a renderable result is found (up to a configurable maximum number of attempts). If a retry succeeds, the successful seed replaces the current seed value in the UI and becomes the new reproducible state. This is opt-in and off by default.

## Technology

Web app (HTML + JavaScript):
- `FileReader` + `Uint8Array` for byte manipulation
- `DecompressionStream` / `CompressionStream` for PNG image data
- `<img>` / `Canvas` for real-time rendering and broken-state detection
- `Blob` + `URL.createObjectURL` for the live preview
- `FileSaver` or a download anchor for export
- No install required, runs in any browser

### Guardrails

All byte manipulation runs in the browser's main thread, so large inputs will block the UI. Two independent hard limits are enforced at load time — both must pass:

- **File size ≤ 10 MB** — checked immediately from the `File` object before any reading occurs.
- **Dimensions ≤ 4000 × 4000 px** — checked after decoding the image into an `<img>` element, before any canvas or byte work begins. Decoded pixel data costs `width × height × 4 bytes` in memory regardless of file size; a compressed 3 MB JPEG at 8000×6000 decodes to ~183 MB.

For PNG a third limit applies: **decompressed image data ≤ 64 MB**, checked from the header before anything is inflated. A 4000 × 4000 RGBA image at 8 bits fits; the same size at 16 bits does not.

If any limit is exceeded, the file is rejected with a clear error message stating which limit was hit. No processing is attempted.

A JPEG that ends without an `EOI` marker (a common result of truncated downloads) is accepted, since browsers render such files; the trailing bytes are treated as scan data.

### Tests

`npm test` runs a Node test suite (`test/`) against the parsers and strategies.

- JPEG (`glitzj.test.js`), with synthetic baseline, restart-marker and progressive JPEGs: range extraction, error cases, determinism, that no strategy ever touches bytes outside the scan ranges, that marker protection removes every fake marker, and a digest of fixed-settings output that pins JPEG results so changes made for other formats cannot alter them.
- PNG (`png.test.js`), with synthetic PNGs built by Node's own `zlib` for every color type and bit depth, interlaced or not: chunk handling and error cases, the row layout (Adam7 checked against a brute-force pass assignment), inflate limits, hand-computed filter rows, the optimized filter kernels against a literal transcription of the spec for every pixel size, lossless re-filtering, filter protection, Prism, alpha restore, density scaling, sparse sampling, cut-off files, cancellation of export work, building a source from RGBA pixels, that every strategy changes even a small image at low intensity, and that every strategy yields a PNG whose CRCs and zlib stream verify.

If needed in a later version, larger files can be handled by moving manipulation to a Web Worker, but this is out of scope for now.

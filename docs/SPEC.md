# Glitzj

The glitch making app

## Purpose

A glitch in an image is a visual representation of data deformation without totally breaking the image's data signature. In other words, a glitch is bended data — an erroneous derivative of the original, but one whose data is still understood by common image rendering engines (the browser, OS image previews, etc.).

The app lets a user load a JPEG, PNG or GIF image and apply one or more glitch strategies to it in a controlled way. Further pages break pictures in other ways, each by misusing a real mechanism instead of damaging a file: see [GIF dither](#gif-dither-page), [JPEG crush](#jpeg-crush-page) and [the pixel tools](#the-pixel-tools). Only renderable results can be exported — the output is always a valid file of the same format.

JPEG was the first target format because its compressed scan data is tolerant of byte-level corruption, producing visually interesting artifacts. PNG guards its pixel data with a zlib stream and per-chunk CRC checksums, so damaging the file in place only produces broken images. Glitzj therefore glitches PNG one level down, in the decompressed scanline data, and re-encodes the result (see [PNG](#png)). GIF has no checksums, but its LZW codes are packed across byte boundaries and only mean something relative to the dictionary built before them, so Glitzj glitches GIF at the level of whole codes and packs them again (see [GIF](#gif)).

**v1 operates on any JPEG layout the browser can decode, including baseline sequential JPEGs, progressive JPEGs, and files that use restart markers.** Rather than assuming one contiguous scan between a single `SOS` and `EOI`, the parser walks the full marker structure, gathers every entropy-coded byte range across all scans, and leaves structural markers untouched.

Validation happens in two stages before any strategy processing begins:
1. Perform a full marker-walk through the JPEG structure to locate a frame marker (`SOFn`) and every entropy-coded scan range.
2. While scanning entropy data, treat `0xFF00` as byte-stuffing and `RSTn` (`0xFFD0`–`0xFFD7`) as protected restart markers, splitting the mutable ranges around them instead of rejecting the file.

## Interface

- **Before/after layout:** the original image on the left, the glitched result on the right. An info line above the original shows dimensions and file size, then for JPEG the frame type (baseline/progressive) and scan count, for PNG the color type, bit depth, interlacing and whether animation frames were dropped, and for GIF the version, frame count, palette size (or the number of color tables) and interlacing. PNG and GIF panels show a checkerboard behind the image so transparency is visible; animated GIFs play in both panels.
- **Loading:** click or press Enter/Space on the before panel to open a file picker, drop a file anywhere on the page, or paste an image from the clipboard (screenshots paste as PNG). The file type is sniffed from its first bytes, so a mislabeled MIME type does not matter and WebP/HEIC/SVG input gets a specific error. Errors appear inline below the panels, never as a blocking dialog. When files are opened in quick succession, only the last one is loaded.
- **Live update:** the after panel updates as soon as a file is loaded and on every settings change. Bursts of input (dragging the intensity slider) are coalesced into one pipeline run per animation frame, and a result that belongs to superseded settings is discarded rather than shown.
- **Shareable settings:** active strategies, intensity, seed, protection, for PNG the filter and alpha setting, and for GIF the Steady setting are mirrored into the URL hash (`#fx=static,prism&i=40&s=3&f=paeth`, `steady=1`). Opening that link restores the settings; combined with the same source image it reproduces the exact result. Strategies the loaded format cannot use stay in the hash but are ignored.
- **Broken state:** if the current settings produce a file that cannot be rendered, the "after" panel shows a simple "image broken" message instead of crashing or showing nothing.
- **Reset button:** reverts all glitch settings (strategies, intensity, seed and PNG filter), restoring "after" to match "before".
- **Export button:** saves the glitched image to disk as `<original>_glitzj_<strategies>_i<intensity>_s<seed>.jpg`, or `…_s<seed>[_<filter>].png` for PNG, or `….gif` for GIF, with `_raw` appended when protection is off, `_noalpha` when Keep alpha is off and `_steady` when Steady is on for an animated GIF, so the filename alone documents how to reproduce it. The name and contents belong to the result on screen, even while a newer render is still pending. Disabled whenever the current output is in a broken state — export is only available for renderable results.
- **Keyboard:** `R` picks a random seed, `E` exports (when not typing in an input).

### Controls

Two shared controls apply to all active strategies:

- **Intensity** — a 0–100 slider controlling the magnitude of the effect across all active strategies
- **Seed** — a numeric value that influences the random decisions in each strategy (which ranges are targeted, where blocks are placed, which bytes are selected). It steers the character of the glitch rather than guaranteeing bit-identical output. Includes a "randomise" button to pick a new seed at random.

Shown only while a PNG is loaded:

- **Filter** — Original, None, Sub, Up, Average or Paeth: the PNG filter the image is re-encoded with before glitching (see [Why filters matter](#why-filters-matter)).
- **Prism** strategy button, and **Keep alpha** for images with an alpha channel. The protection toggle reads "Protect filters" instead of "Protect markers".

Shown only while a GIF is loaded:

- **Prism** strategy button, with its GIF meaning (see [Prism on GIF](#prism-on-gif)). The protection toggle reads "Protect codes".
- **Steady**, for animated GIFs only (see [Animation](#animation)). Mirrored in the hash as `steady=1`.

Shown only while a JPEG is loaded:

- **Glitch as PNG** — glitches the JPEG through the PNG pipeline instead (see [JPEG as PNG](#jpeg-as-png)). Mirrored in the hash as `png=1`; it stays set when a PNG is loaded, for the next JPEG.

## Glitch strategies

The strategies below are described in JPEG terms. How they behave on PNG and GIF data, and the Prism strategy, are covered under [PNG](#png) and [GIF](#gif).

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

## GIF

### Pipeline

1. **Load (once per file).** Walk the blocks: header, global color table, extensions, and per frame its image descriptor, local color table, LZW minimum code size and data sub-blocks. Each frame's sub-block payloads are joined and unpacked into its *codes*, one array entry per LZW code, read at the width a decoder uses. A file that ends without a trailer, or inside a frame's data, is accepted; the frame keeps the data that arrived, and any other block cut off is left out. A minimum code size of 1, which the GIF spec does not allow, is read the way Chrome and ImageIO decoded such a file (the code width is checked after every code, the first one included); Firefox showed nothing for it.
2. **Strategies** (Static → Crumble, the catalogue order above) run on a copy of each frame's codes, treating them as one logical scan. Frame *k* uses the seed mixed with *k* (frame 0 uses the seed itself), unless Steady is on.
3. **Code repair** (optional, on by default) or raw packing turns the codes back into data; see [Code repair](#code-repair).
4. **Prism** changes palette entries; see [Prism on GIF](#prism-on-gif).
5. **Encode.** The file is copied with every frame's data replaced by the new codes in sub-blocks of 255 bytes, and closed with a trailer. Everything else (extensions, delays, loop count, frame positions and disposal) is kept byte for byte. With no strategies on, the output decodes to the same pixels, and a file written in full 255-byte sub-blocks, as every encoder tested writes them, comes back byte for byte.

Repacking needs no compression step, so the preview file is the export.

### Why codes rather than bytes

LZW codes are up to 12 bits wide and packed across byte boundaries, and a code refers to a dictionary entry built from the codes before it since the last clear code. In tests, damaging the packed bytes made Echo and Drift produce pure noise, because moved bytes no longer line up with code boundaries and land in a different dictionary. Working on whole codes keeps their meaning: a repeated or shifted run of codes still refers to the same dictionary entries, so Echo repeats and Drift displaces real fragments of the picture. The strategy helpers copy into an array of the buffer's own type and let it wrap values, so 12-bit codes move intact; for JPEG and PNG, whose buffers are bytes, nothing changes, which the JPEG digest test pins.

### Strategies on GIF

- A damaged code decodes to a different run of pixels, usually of a different length, so everything after it shifts sideways, and dictionary entries built from it carry the damage on until the next clear code. A damaged clear code, or a new one, makes the rest of the codes read against a different dictionary.
- **Static, Smear, Crumble** scale their odds by 0.0005: at intensity 100, one hit per 2000 codes, at least one hit above intensity 0. A highly compressed frame has few codes and no clear codes, so even one hit can wreck everything after it.
- **Dropout** zeroes runs of codes; code 0 is a single pixel of color 0, so the frame loses the pixels those codes stood for and comes up short (see [Code repair](#code-repair)).
- "Early" and "late" codes are the top and bottom of a frame. In an interlaced frame the first codes cover every eighth row, so damage spreads over the whole frame in stripes.

### Code repair

Observed behavior for damaged LZW data (Chrome, Firefox, and macOS ImageIO through `sips`):

| Damage | Chrome | Firefox | ImageIO |
| --- | --- | --- | --- |
| Code past the dictionary, or end code before the frame is full | stops drawing; rest transparent | still image: nothing drawn, yet the `load` event fires | carries on |
| Data runs out before the frame is full | rest transparent | rest white | rest white |
| Pixel index past the end of the color table | black | wraps around the table | arbitrary colors |
| Codes after the frame is full | ignored | ignored | ignored |

"Protect codes" walks the codes as a decoder does, tracking only the length of every dictionary entry, which is enough to count pixels. It keeps every code a decoder accepts, clear codes included wherever the damage left them, and replaces the rest: an end code before the frame is full, or a code past the dictionary, becomes a valid code derived from its value; a pixel index past the color table wraps around it, as Firefox shows it. Codes beyond a full frame are dropped. A frame that comes up short continues with a clear code and its own codes from the start, which decode exactly like the top of the frame, so the picture rolls around like a TV losing vertical hold. Every frame ends with an end code at exactly its size.

Repairing undamaged codes reproduces the original data bit for bit. On every repaired test file Chrome, Firefox and ImageIO showed identical pixels, matching an independent reference decoder.

Earlier designs were measured and dropped: filling a short frame by repeating the last code gave a flat band; forcing clear codes back to their original positions turned shifted codes into noise.

Without protection the codes are packed exactly as damaged. Firefox fires `load` even for a GIF it cannot draw, so the render check cannot catch it; instead the after panel reports how many frames decoders give up on (`data cut off`, or `3 of 12 frames cut off`).

### Prism on GIF

Prism rotates the red, green and blue values of randomly picked palette entries (to green-blue-red or blue-red-green), so every pixel drawn in such a color shifts hue. A gray has no hue to rotate; one of its channels gets its top bit flipped instead. Entries are drawn among the colors the frames use, weighted by how many pixels each covers (transparent pixels left out) and never twice, so the colors that fill most of the picture are the likeliest to change. The pixel counts take one pass over the codes, done on first use and cached. *Intensity drives:* the share of used colors picked, 0–25%, at least one above 0. Every color table gets the same random choices.

### Animation

Every frame is glitched. With Steady off, frame *k* uses the seed mixed with *k*, so the damage differs per frame and jumps around as the animation plays. With Steady on, every frame uses the same seed, so the strategies pick the same relative positions in each frame's codes; on a panning test animation, Drift then kept a stable band while Smear still varied. Animations that only redraw the parts of a frame that change keep earlier damage on screen until something draws over it.

## GIF dither page

`gif.html` is a second mode that does not glitch: it renders any image the browser can decode as a single-frame GIF89a with a small palette and gives control over the dithering. It shares `style.css` with the glitch page (plus `gif.css`), and its logic lives in `dither.js` (pure, no DOM, tested in Node) and `gif-page.js` (the page).

### Pipeline

The image is drawn to a canvas once at load. Every settings change then runs, coalesced to one run per animation frame:

1. **Shrink** by the dot size: every dot × dot block of the original becomes one pixel, its color averaged weighted by alpha.
2. **Tone**: contrast and brightness (−100 to 100); for grayscale and duotone palettes, colors become their luminance (Rec. 601 weights) first.
3. **Palette**: median cut over a 5-bit-per-channel histogram (2–256 colors), a gray ramp (2–256 levels), the 216-color web-safe cube or the 8 RGB primaries. Duotone dithers against a gray ramp and swaps in a ramp from the dark to the light color when writing the table.
4. **Dither** to palette indices: error diffusion (Floyd–Steinberg, Atkinson, Jarvis–Judice–Ninke, Stucki, Burkes, Sierra, Sierra Lite; optional serpentine scanning), ordered (Bayer 2 × 2, 4 × 4, 8 × 8) or seeded noise, scaled by strength. Ordered and noise dither push each pixel by up to the palette's step size: the mean distance from each color to its nearest neighbor on the channel where they differ most.
5. **Encode** as GIF89a with a global color table padded to a power of two, and LZW codes that clear when the dictionary is full.

Pixels below half opacity get their own index, marked transparent in a graphic control extension; they neither take nor pass on dither error. Export writes the dot-sized GIF, or with "Export at original size" the indices enlarged back to the original dimensions.

### Determinism

The same image and settings give the same bytes. Only noise dither uses the seed. Settings are mirrored in the hash (`#dither=atkinson&palette=duotone&colors=2&dot=4`), leaving out values that equal the defaults.

## JPEG crush page

`crush.html` is a third mode that does not glitch: it encodes any image the browser can decode as a baseline JPEG and shows the result live. It shares `style.css` and `gif.css` with the other pages (plus `crush.css`); its logic lives in `crush.js` (pure, no DOM, tested in Node) and `crush-page.js` (the page).

The encoder is Glitzj's own instead of `canvas.toBlob('image/jpeg', q)`: `toBlob` differs per browser, cannot be steered beyond one quality number and gives no way to run generations without decoding through the browser. With its own encoder the same image and settings give the same bytes everywhere.

### Pipeline

1. **Flatten** the RGBA pixels over white.
2. **Generations** 1 to N − 1: convert to YCbCr (JFIF, full range), pad to whole MCUs by repeating the edge pixels, average the chroma down by the subsampling factors, run the forward DCT (AAN, as libjpeg's float DCT), quantize, dequantize, run the inverse DCT, upsample the chroma by repeating it and convert back to RGB. Then roll the picture right and down by the shift, wrapping around. After the last of these generations the picture is rolled back by the total shift, so the result lines up with the original.
3. **Final generation**: the same steps up to quantizing; the quantized coefficients are kept.
4. **Encode** a baseline JFIF file: SOI, APP0, one DQT with both tables, SOF0 with three components (luma sampled `h × v`, both chroma at 1 × 1), one DHT with four tables, one interleaved SOS, the entropy-coded data with `0xFF` stuffing, EOI. The Huffman tables are optimal for the image, built the way libjpeg's `jpeg_gen_optimal_table` does: limited to 16 bits, with a reserved symbol so no code is all ones.

Quality scaling is IJG's: `scale = q < 50 ? floor(5000 / q) : 200 − 2q`, each step `floor((base × scale + 50) / 100)` clamped to 1–255, with the Annex K tables as base. Quality 0 is treated as 1, as libjpeg does. Chroma subsampling factors are 1 × 1, 2 × 1, 2 × 2, 4 × 1 and 4 × 2; 4 × 2 makes 10 blocks per MCU, the most baseline JPEG allows.

The pipeline is a generator that yields after every plane conversion and every component, so the page runs it in slices of about 12 ms, shows "crushing… generation n of N" while it takes longer than one slice, and abandons a job as soon as the settings or the file change. The result on screen carries its own bytes and export name.

### Verification

A 203 × 117 test image, encoded at every subsampling at quality 0 and 100, and at quality 30 with 6 generations and shift 3, decoded at the right size in Chrome 157 and Firefox 159; the quality 0 and 100 files also in macOS ImageIO (through `sips`). Mean error against the source was the same in Chrome and Firefox for every file, and ImageIO's was within 1.4 of theirs; at 4:4:4 quality 100 it was under 0.5 in all three.

On a synthetic test image, generations without a shift stopped changing after the second one (quality 50: mean error 5.89, then 5.93 from generation 2 to 50). With a shift of 1 at quality 10, the mean error grew from 10.3 after one generation to 82.7 after 50.

### Determinism

Settings are mirrored in the hash (`#q=90&split=1&cq=10&sub=410&gen=20&shift=5`), leaving out values that equal the defaults. The export is named `<original>_crush_q<quality>[_cq<color quality>]_<subsampling>[_gen<n>_shift<px>].jpg`.

## The pixel tools

Seven more pages break pictures in other ways than damaging a file's bytes: JPEG surgery, Split, Sort, Bend, Misread, Signal and Mosh. They share one rule with the rest of the app: no effect is painted on. Each page implements a real mechanism (a codec, an algorithm, a color model, a signal chain) and misuses it, so every artifact is something that mechanism does.

Each tool is a pure module (no DOM, tested in Node) that exposes a generator, `<tool>Steps(source, settings)`, plus a small page script. `source` is `{ rgba, width, height, cache }`; `cache` belongs to the loaded image and holds whatever is expensive and does not depend on the settings that change most (color planes, the written byte stream, the encoded signal, the quantized coefficients). The generator yields now and then, optionally a progress fraction, and returns either pixels `{ rgba, width, height }` or a finished file `{ bytes, type, ext, width, height }`.

### The page shell

`tool.js` holds what the seven pages have in common, so a page script is little more than a description of its settings:

- **Settings** are declared once, each with a default and either a range of whole numbers, a list of choices, a boolean, or a list of whole numbers. From that one description the shell sanitizes values, mirrors them in the hash (defaults left out) and wires the controls.
- **Controls** are bound from the markup: `data-setting` on inputs, selects and checkboxes, `data-for` + `data-step` on stepper buttons, `data-choice` + `data-value` on buttons that pick one of a list, `data-toggle` on on/off buttons, and `id="<key>-value"` for a readout.
- **Loading** is as on the dither and crush pages: click, drop or paste, any image the browser can decode, 10 MB and 4000 × 4000 px at most, the first frame of an animation. The picture then goes through the [source view](#source-view) before the tool sees it.
- **Rendering** runs the generator in slices of about 12 ms. A render that takes longer than one slice shows its progress in the line above the result; a newer render replaces a running one. Pixels are drawn on a canvas; a finished file is shown in an `<img>`, so the browser's own decoder renders it. Saving either is the work of [Export](#export).
- **1:1**, **Reset**, **Export** (`E`), **Randomise** (`R`, where a tool has a seed) **Surprise me** (`X`) and **Feed back** behave the same on every page. Surprise me replaces all settings with a random look; each page supplies its own function for that, so a roll stays within what looks like something (a few pedals instead of all eight, small offsets instead of the full range). The export is named `<original>_<tool>_<settings>.<ext>`.

`pixels.js` has the helpers the tools share: a seeded random number generator, a hash-based one for values that must be looked up by row and frame, bell-curve noise, compositing over white, and resizing (area averaging down, linear interpolation up).

### Hand-off

`handoff.js` keeps the image the page is working on in IndexedDB (database `glitzj`), so it is there when another page of the app is opened. Every tab stores its image under an id of its own, made up once and kept in `sessionStorage`: navigating within a tab carries the image along, a new tab starts empty, and two tabs never see each other's image. A closed tab cannot remove its record, so each save also removes records of other tabs that are more than a day old. Every page stores the file it opened and, on start, loads the stored one if nothing else has been opened. A carried-over image skips the 10 MB limit (it may be the result of a tool) and fails silently where a page cannot use it: the Glitch page ignores anything that is not a JPEG, PNG or GIF. Where storage is unavailable nothing is kept and nothing breaks.

**Feed back** hands the result on screen to the page's own `loadFile` as a file named like the export, which also stores it for the other pages. On the Glitch page a PNG result is compressed first, as for export.

### Source view

`source.js` lets every page work on the opened picture turned, mirrored and zoomed, without changing the file. A view is `{ turns, mirror, zoom, cx, cy }`: quarter turns clockwise (0–3), a mirror left to right applied after turning, a zoom in percent (100–800, in the steps 100, 150, 200, 300, 400, 600, 800 from the buttons), and the middle of the visible part in thousandths of the turned picture's width and height. Turns and the mirror together are the eight orientations of a rectangle, so flipping top to bottom is stored as a mirror and a half turn.

- **Buttons act on what is on screen.** Turning clockwise turns the shown picture clockwise even when it is mirrored (the stored turn then goes the other way), and the middle of a zoomed view is carried along, so the part being looked at stays the part being looked at. The tests check every button from all eight orientations against literal pixel-by-pixel turns and flips.
- **A zoom is a crop.** The visible rectangle is `round(size × 100 / zoom)` pixels in each direction, at least one, placed around the middle and pushed back inside the picture where it would stick out. The page gets exactly those pixels; nothing is resampled. An untouched view hands back the original pixel array, not a copy.
- **Toolbar**: turn left and right, mirror, flip, zoom out and in, and back to the whole picture; `[`, `]`, `H`, `V`, `+`, `−`. While zoomed, dragging the Before picture moves the visible part by the share of it that the pointer travelled; a drag does not count as the click that opens a file.
- **In the address**: `src=<turns>[m][@<zoom>,<cx>,<cy>]`, for example `src=1`, `src=3m`, `src=0@200,250,500`; left out for an untouched view. A view in the address applies to the picture that is open, or to the first one opened after the page loads. A file the user opens later starts untouched, and so does a result that is fed back.
- **Hand-off**: the view is stored next to the picture, so the next page shows it the same way.

On the pixel pages (the seven tools, GIF dither and JPEG crush) `SourceView.manage` holds the decoded picture and its view, draws what the view shows on the Before panel, which is a canvas there, and calls the page with the pixels whenever either changes. The line above the picture gives the size of what is shown and how it is turned.

The Glitch page works on the bytes of a file, so it cannot apply a view to pixels on the way in. It keeps the file as opened and, for any view other than the untouched one, draws the picture as the view shows it, encodes that with `canvas.toBlob` (JPEG at quality 0.95 for a JPEG, otherwise PNG, which comes out as 8-bit RGBA) and loads the result as the file to glitch. While one such file is being made, further changes only ask for another round, so dragging a zoomed picture does not queue up work. Going back to the untouched view loads the opened file again, so its own bytes are glitched, as before. For a GIF the toolbar is off: it is glitched frame by frame as the file it is.

### Export

`export.js` takes over the Export button of every page. A page describes its result as `{ name, width, height, ext, file(), image?, animated? }`; `file()` returns the result as made, `image` is a canvas that already holds it.

- **Options** (kept in `localStorage`, not in the address): size as 25, 50, 100, 200, 300 or 400% or a width in pixels; sharp or smooth scaling; format as made, PNG, JPEG or WebP; a quality for JPEG and WebP.
- **Plan**: the target size keeps the shape of the result and is at least one pixel each way; it is shrunk to fit 16384 px a side and 120 million pixels, which the menu then says. If the size is the result's own and the format is the result's own (or "as made"), the file from `file()` is saved untouched and the name is exactly what it was before these options existed. Otherwise a copy is rendered: the result is drawn (from `image`, or by decoding the file as the page does to show it) onto a canvas of the target size, with smoothing off for sharp scaling, over white for JPEG, and encoded with `canvas.toBlob`. A resized copy with the format "as made" stays a JPEG if the result was one and is otherwise a PNG; browsers cannot write GIF. If the browser cannot write the format asked for and returns a PNG, the name follows.
- **Names**: a resized copy gets `_<width>x<height>` before the extension.
- **Copy** renders a PNG at the chosen size onto the clipboard (handed over as a promise so that it still counts as the result of the click). **Share** is shown where `navigator.canShare` accepts files.
- A rendered copy of an animated GIF is its first frame; the menu says so.

## JPEG surgery page

`surgery.html` uses the encoder of the crush page (`crush.js`) up to the quantized coefficients, then works on them and on the header (`surgery.js`).

### Pipeline

1. **Encode honestly**: flatten over white, convert, subsample, DCT and quantize at the chosen quality and subsampling, exactly as JPEG crush does. The coefficients are cached per quality and subsampling; every later step works on a copy.
2. **Cut**, in this order: Drift, then per component Transplant, Mirror blocks, Shift, Invert detail and the band limits, then Swap color channels.
   - *Drift* walks the MCUs in scan order. At a number of random MCUs that grows with the setting, a random offset is added to the DC of that MCU's blocks and of all that follow, until the next such MCU (which sets it to zero one time in four). Offsets are in pixel values, converted with the DC step, 0.6 as large for the color components, and the DC is clamped to ±1023.
   - *Transplant* copies the 63 AC coefficients of a random block of the same component over a share of the blocks.
   - *Mirror blocks* moves the coefficient for pattern (u, v) to (v, u), using a table derived from the zigzag order.
   - *Shift* rotates the AC coefficients by k places along the zigzag.
   - *Invert detail* negates the AC coefficients.
   - *Coarsest* and *Finest* zero every coefficient whose zigzag index is outside the range, the DC included.
3. **Lie**: build the header.
   - *Quality*: the DQT holds the tables for the claimed quality.
   - *Swap the step tables*: table 0 and 1 change places.
   - *Claimed color*: the frame header names other sampling factors. The scan is unchanged, so the decoder assigns its blocks to the wrong components. Each component would then be decoded with another's Huffman tables, so in this case the file has one DC and one AC table that all components share.
   - *Claimed width*: with `B` blocks stored and `b` blocks per MCU under the claimed sampling, the decoder can be given `floor(B / b)` MCUs. The header claims `cols` MCUs per row, the honest number plus the setting, and `floor(MCUs / cols)` rows, so the scan always holds at least what the header asks for. Neither side may exceed the 16 bits a JPEG header has for it, and a picture that holds less than one MCU of the claimed layout keeps its honest header. Data left over after the last claimed MCU is ignored by decoders.
4. **Write** a baseline JFIF file as crush does: optimal Huffman tables for the coefficients as cut.

### Verification

With no cuts and no lies the output is byte for byte that of `crushJpeg` at every subsampling. Cuts are checked by reading the file back with the independent decoder of the crush tests. In Chrome 156, 450 combinations of subsampling, claimed sampling, claimed width and cuts all decoded, at the claimed size; 180 of them also in macOS ImageIO (through `sips`).

### Determinism

Hash: `#q=50&sub=420&low=1&high=40&shift=3&transplant=20&drift=30&mirror=1&negate=1&swapc=1&s=4&lie=0&claim=10&widen=2&claimsub=444&swapt=1`. The export is named `<original>_surgery_q<quality>_<subsampling>[_band<lo>-<hi>][_shift<n>][_transplant<n>][_drift<n>][_mirror][_inverted][_swapcolors][_s<seed>][_claims-q<n>][_claims-w<±n>][_claims-<sampling>][_swaptables].jpg`.

## Split page

`split.html` (`split.js`) separates the picture into the planes of a color model, moves each plane and recombines them.

### Pipeline

1. **Planes**, one byte per pixel each, cached per model. RGB: the three channels. CMYK: `K = 255 − max(R, G, B)` and each of C, M, Y as the rest of its channel relative to `255 − K`. YCbCr: JFIF, full range.
2. **Move** each plane by inverse mapping without interpolation: output pixel (x, y) takes the plane's value at the position found by undoing the plane's offset and tear, then its rotation and zoom around the center. A plane's place in the stack, from −1 for the first to +1 for the last, scales its zoom (up to ±25%) and twist (up to ±15°), so the outer planes move in opposite directions and the middle plane of three stays put. With no zoom or twist, rows are copied whole.
3. **Tear**: the rows are cut into bands of random height (the same bands for all planes). About half the bands tear; each plane gets its own shift, half shared with the other planes and half its own, up to a quarter of the width.
4. **Edges**: positions outside the plane wrap around, repeat the nearest edge pixel, or are blank: 0 for light, 0 for ink (bare paper), 128 for the two color signals.
5. **Wiring** decides which source plane fills each place: straight, one over, one back, or mirrored.
6. **Stack**: RGB directly; CMYK as `(255 − ink) × (255 − K) / 255`; YCbCr by the inverse transform. Alpha is copied from the source unmoved.

### Interaction

Dragging on the result moves the chosen plane; the pointer distance is scaled by the ratio of canvas pixels to screen pixels, so the plane follows the pointer at any zoom. Arrow keys move it by 1 px, 10 px with Shift; `S` scatters all planes by up to 3% of the width, `A` aligns them.

### Determinism

Hash: `#m=cmyk&o=12,-3,0,0,-8,5,0,0&zoom=20&twist=-10&tear=30&band=20&s=4&edge=blank&w=next`, the offsets as x, y per plane. The export is named `<original>_split_<model>[_<plane><dx>x<dy>…][_zoom<n>][_twist<n>][_tear<n>_band<n>_s<seed>][_<wiring>][_<edge>].png`.

## Sort page

`sort.html` (`sort.js`) runs sorting algorithms over spans of each row or column and stops them at a chosen fraction of their work.

### Pipeline

For every line (row, or column for the vertical directions):

1. **Keys**: one whole number per pixel. Brightness, hue, saturation and the single channels use 10 bits; "the number itself" is `0xRRGGBB`, 24 bits. For the two reversed directions the key is subtracted from its maximum.
2. **Pack**: each pixel becomes `key × 4096 + position` in a `Float64Array`. Comparing two entries compares keys first and positions second, which makes every algorithm stable for free, and the position says which source pixel to copy afterwards.
3. **Spans**: runs of pixels whose brightness is within the range, chunks of random length, or the whole line.
4. **Sort** each span partway, at progress `t` from 0 to 1 (plus or minus up to half of *Unevenly*, per line).
5. **Copy** the pixels to their new places. Pixels outside the spans are not touched.

### The algorithms, interrupted

Each is the state the real algorithm would be in, computed directly where running it literally would be too slow:

- **Bubble**: after `k = round(t² × (n − 1))` passes. Computed with a min-heap of `k + 1` entries: push the entries in order and, once the heap is full, pop the smallest into the next place. That is exactly the result of k passes, in O(n log k).
- **Insertion**: the first `round(t × n)` entries sorted, the rest untouched.
- **Selection**: `round(t × n)` rounds, each swapping the smallest remaining entry into place; the swaps are replayed with an index of where each entry is.
- **Quick**: Hoare partitioning around the middle entry, recursing to depth `round(t × (⌈log₂ n⌉ + 2))` and no further.
- **Merge**: bottom-up, after `round(t × ⌈log₂ n⌉)` rounds: sorted runs of 2^rounds entries.
- **Shell**: gaps n/2, n/4, …, 1; after the first `round(t × number of gaps)` of them. Each gap pass leaves every gap-th entry sorted among themselves.
- **Heap**: up to `t = 0.25` a share of the sift-downs that build the max-heap; after that, a share of the n − 1 removals of the largest entry to the end.
- **Radix**: least significant bit first, after `round(t × key bits)` stable passes, so in stable order of the low bits only.
- **Bogo**: `round(t × n)` swaps of two random entries.

At `t = 0` every algorithm leaves the span as it is and at `t = 1` it is fully sorted, so at 100 all nine give the same picture.

### Determinism

Hash: `#a=shell&p=40&jitter=20&by=hue&dir=down&span=chunks&low=20&high=70&size=40&s=3`. The export is named `<original>_sort_<algorithm>_p<progress>_<key>_<direction>_<span>[_uneven<n>][_s<seed>].png`. The seed is used by random chunks, uneven stops and Bogo. **Play** steps the progress up by one after each finished render.

## Bend page

`bend.html` (`bend.js`) treats the pixel data as sound.

### Pipeline

1. **Scan**: the order in which pixels go onto the tape. Rows; back and forth (every other row reversed); columns; or a generalized Hilbert curve (after Jakub Červený's `gilbert`), which covers a rectangle of any size with a path that only ever steps to a neighboring pixel.
2. **Tracks**: one track with R, G, B of each pixel in turn (3 samples per pixel), or three tracks of one channel each, processed separately.
3. **Decode** bytes to samples from −1 to 1: linear (`(b − 128) / 128`, unsigned 8-bit PCM) or G.711 µ-law.
4. **Pedals**, in fixed order, each in place: Speed (resampling by `2^((knob − 50) / 50)³` with linear interpolation, silence past the end), Drive (gain 1 to 24 and an offset), Crush (8 down to 1 bit, sample-and-hold of 1 to 96 samples), Filter (Chamberlin state-variable; low, high or band; Q 0.5 to 40), Phaser (four first-order all-pass stages with a swept coefficient and feedback), Vibrato (a delay line whose length swings), Echo (`y[n] = (1 − f) x[n] + f y[n − d]`, which keeps a flat tape at its level), Reverb (Schroeder: four parallel combs and two all-passes). Lengths and rates are relative to one line of the picture in samples. With *Play backwards* the tape is reversed before and after the pedals.
5. **Encode** samples to bytes: clipped to the range, or wrapped around it, then linear or µ-law.

With every pedal off the picture comes back unchanged (except that a µ-law byte 0x7F, negative zero, returns as 0xFF).

### Sound

**Listen** plays the tape at 44.1 kHz through Web Audio, queued a quarter of a second at a time from the result that is on screen at that moment, so a change of settings is heard within half a second. A marker shows which pixel the current sample came from: a line across for row scans, a line down for columns, a dot for the Hilbert curve. **Export WAV** writes the tape as 8-bit mono PCM.

### Determinism

Hash: `#scan=hilbert&tracks=three&codec=ulaw&overflow=wrap&rev=1&echo=0&reverb=1&reverbA=60&reverbB=80…`; each pedal has an on/off key and one or two knob keys. Nothing is random. The export name lists the scan, the tracks and every active pedal with its knobs.

## Misread page

`misread.html` (`misread.js`) writes the picture as raw bytes and reads them back under other assumptions. Nothing is random.

### Pipeline

1. **Write** (cached per format), after compositing over white: RGB or BGR at 3 bytes a pixel, RGBA at 4, RGB 5-6-5 little-endian at 2, gray at 1, black and white at 1 bit (threshold 128, highest bit first), planar RGB, I420 (a full brightness plane, then two color planes at half resolution each way), or YUYV (two pixels share one pair of color bytes).
2. **Text editor** (optional): CRLF inserts 0x0D before every 0x0A not already preceded by one; UTF-8 decodes the bytes as UTF-8 and encodes them again, with `TextDecoder` and `TextEncoder`, so every invalid sequence becomes EF BF BD; Latin-1 to UTF-8 turns each byte above 0x7F into two; 7-bit clears the top bit; caps lock maps 0x61–0x7A to 0x41–0x5A; and one drops every zero byte. Editors that lengthen the data stop at the length the reader can use.
3. **Align**: drop the first 0 to 16 bytes; shift the whole stream left by 0 to 7 bits; reverse the bits of every byte; swap every pair of bytes.
4. **Read** in the chosen format at the original width plus or minus up to 400 px. The height follows from the amount of data: `⌈bytes / (width × bytes per pixel)⌉` rows, at most four times the original height and at most 4000. Where the data runs out the picture is black. The fourth byte of RGBA is skipped instead of being used as transparency.

### Determinism

Hash: `#w=rgb24&r=i420&dw=3&ed=crlf&skip=1&bits=3&rev=1&swap=1`. The export is named `<original>_misread_<written>-as-<read>[_w<±n>][_<editor>][_skip<n>][_bits<n>][_reversed][_swapped].png`.

## Signal page

`signal.html` (`signal.js`) encodes the picture as an NTSC composite video signal, damages it and decodes it.

### Pipeline

1. **Raster**: the picture is resized to the chosen number of lines (never more than it has) and to a width of `lines × aspect` pixels; the signal has 754 / 640 samples per pixel, the ratio of four times the color subcarrier to square pixels in a 4:3 NTSC frame.
2. **Encode** (cached per number of lines): per sample `Y = 0.299 R + 0.587 G + 0.114 B` and the color difference signals I and Q, band-limited by box filters of 7 and 15 samples. The composite signal is `Y + I cos φ + Q sin φ` with `φ = π/2 × sample`, four samples per subcarrier cycle. The color part is negated on every other line and every other frame, which is NTSC's 227.5 cycles per line.
3. **Transmit**, per line: a start offset (horizontal hold as a slope over the frame; jitter; a slow wobble with the top of the frame bending; tape trouble), with the line wrapped around a blanking gap of 16% of its length and fetched with linear interpolation; a ghost (the signal added to itself a few samples later, and subtracted at half that delay); Gaussian noise; dropouts (a white dash with a linear tail). Vertical hold shifts which line arrives on which row, around a gap of 8% of the frame. The tracking band is a stretch of lines with extra offset and noise, 40% of them at its center without color; the last 1.4% of the lines get the offset and noise of a head switch.
4. **Separate** brightness from color. Notch: `Y = ¼ s[n − 2] + ½ s[n] + ¼ s[n + 2]`, which cancels the subcarrier, and color is the rest. Comb: half the sum and half the difference of this line and the previous one. Black and white: the signal is the brightness.
5. **Demodulate**: multiply the color part by `2 cos` and `2 sin` of the reference, which starts as late as the line does (the receiver locks to each line's burst) plus the tint and the per-line hue drift; average four samples to remove the double-frequency part; smooth with a one-pole filter (Bleed); scale by Color.
6. **Display**: a one-pole filter on the brightness (Soft), YIQ to RGB, resampled to the raster width.

With everything in step 3 off and no smoothing, a soft test picture comes back with a mean error under 5 of 255 with either color receiver.

### Live and recording

**Live** renders frame after frame at up to 30 a second: each frame has its own noise, the subcarrier flips (so dots crawl), the wobble and the tracking band move on, and pictures that have lost horizontal or vertical hold slide. It stops when the page is hidden. **Record** captures the canvas with `MediaRecorder` (WebM, or MP4 where that is what the browser offers) and switches Live on. On a 768 × 512 test photo at 480 lines a frame took about 30 ms, so Live ran at 28 frames a second in Chrome.

### Determinism

Hash: `#lines=240&set=comb&color=120&tint=20&noise=30&ghost=40&hue=20&bleed=60&soft=40&jitter=30&wobble=20&hhold=15&vhold=10&tracking=40&dropouts=30&s=5`. A still is always frame 0 of its seed, so the same link gives the same picture; Live is not mirrored in the hash. The export is named after the lines, the receiver and every setting that is not zero.

## Mosh page

`mosh.html` (`mosh.js`) does to a still what datamoshing does to video: it derives the instructions a video encoder would write for the step from one frame to the next, and carries them out repeatedly without ever inserting a keyframe.

### Pipeline

1. **Frame**: the picture, composited over white and resized so that its longest side is at most 640 or 1280 px (or left as it is).
2. **Next frame** (not for Fall and Scatter): the frame zoomed by up to 8%, shifted by up to 3% of its longest side in the chosen direction, or turned by up to 6°, sampled without smoothing with the edges repeated; or another picture, resized to the frame.
3. **Motion search**: for every block of 8, 16 or 32 px of the next frame, a vector to the place in the first frame it matches best, by the sum of absolute differences in brightness. The search is logarithmic, as in fast encoders: from the best position so far it tries the eight neighbors at half a block, moves while that improves the match, halves the step, and so on down to one pixel, within two blocks' distance. It gets stuck in local minima and has nothing to hold on to in flat areas, which is the point.
   - *Fall* invents the vectors instead: each block's vector is its mean brightness times 1.5 blocks at full strength, against the chosen direction. *Scatter* gives every block a random vector of up to 1.5 blocks.
4. **Correction**: the next frame minus the first frame moved by the vectors, per pixel and channel.
5. **Run**: frame n + 1 is frame n with every block fetched from where its vector points (positions outside the frame repeat the edge), plus the correction times the Correction setting. At 100% frame 1 equals the next frame exactly, as in a real decoder; every later frame adds the same correction again.

The vectors and the correction are cached per motion settings, and the run is kept: asking for more frames continues from the last one computed, so Play costs one frame of work per frame.

### Determinism

Hash: `#m=spin&strength=-60&dir=180&block=32&size=640&fix=20&s=3&f=40`. The other picture is not part of the link. The export is named `<original>_mosh_<motion>_<strength>[_dir<n>]_b<block>_f<frames>[_fix<n>][_s<seed>].png`; a recording gets the same name as a video file. On a 768 × 512 test photo Play ran at 21 frames a second in Chrome.

## Iteration / validity

### Marker protection

Inside entropy-coded data a `0xFF` byte may only be followed by `0x00` (byte stuffing); any other pair is a marker. Byte-level mutation inevitably creates such pairs, or breaks an existing stuffing pair by changing its `0x00`. Decoders react to a fake marker by leaving the scan early: libjpeg (Chrome, Firefox) pads the rest with zero bits, so everything below that point decodes as flat color. On a test image, Static and Smear left roughly 90% of the block rows flat without protection and 0% with it.

After the pipeline has run, an optional pass rewrites every offending `0xFF` inside the mutable ranges to `0xFE`. Structural markers, restart markers and legitimate stuffing pairs are untouched, and the glitch itself is preserved. This is on by default ("Protect markers"); turning it off restores the raw behavior for those who want the cut-off look.

For PNG, "Protect filters" plays the same role; see [Filter protection](#filter-protection). For GIF, "Protect codes" does; see [Code repair](#code-repair).

### Renderability check

The output is always tested for renderability before the export button is enabled. When active strategies produce an unrenderable file, the app can optionally auto-retry with incremented seeds until a renderable result is found (up to a configurable maximum number of attempts). If a retry succeeds, the successful seed replaces the current seed value in the UI and becomes the new reproducible state. This is opt-in and off by default.

## Technology

Web app (HTML + JavaScript):
- `FileReader` + `Uint8Array` for byte manipulation
- `DecompressionStream` / `CompressionStream` for PNG image data
- Hand-written LZW code packing for GIF
- `<img>` / `Canvas` for real-time rendering and broken-state detection
- `Blob` + `URL.createObjectURL` for the live preview
- `FileSaver` or a download anchor for export
- `IndexedDB` and `sessionStorage` to carry the image from page to page
- Web Audio for listening to the tape on the Bend page; `MediaRecorder` for recording on the Signal page
- No install required, runs in any browser

### Guardrails

All byte manipulation runs in the browser's main thread, so large inputs will block the UI. Two independent hard limits are enforced at load time — both must pass:

- **File size ≤ 10 MB** — checked immediately from the `File` object before any reading occurs.
- **Dimensions ≤ 4000 × 4000 px** — checked after decoding the image into an `<img>` element, before any canvas or byte work begins. Decoded pixel data costs `width × height × 4 bytes` in memory regardless of file size; a compressed 3 MB JPEG at 8000×6000 decodes to ~183 MB.

For PNG a third limit applies: **decompressed image data ≤ 64 MB**, checked from the header before anything is inflated. A 4000 × 4000 RGBA image at 8 bits fits; the same size at 16 bits does not.

For GIF the frames may add up to at most **200 million pixels**, checked from the frame descriptors before any codes are unpacked. Most of the work per render scales with the number of codes, which the file size bounds; only filling frames that came up short scales with pixels. In tests a render took about 1.5 ms per million pixels, 17 ms for a 2800 × 1900 photo.

If any limit is exceeded, the file is rejected with a clear error message stating which limit was hit. No processing is attempted.

A JPEG that ends without an `EOI` marker (a common result of truncated downloads) is accepted, since browsers render such files; the trailing bytes are treated as scan data.

### Tests

`npm test` runs a Node test suite (`test/`) against the parsers and strategies.

- JPEG (`glitzj.test.js`), with synthetic baseline, restart-marker and progressive JPEGs: range extraction, error cases, determinism, that no strategy ever touches bytes outside the scan ranges, that marker protection removes every fake marker, and a digest of fixed-settings output that pins JPEG results so changes made for other formats cannot alter them.
- PNG (`png.test.js`), with synthetic PNGs built by Node's own `zlib` for every color type and bit depth, interlaced or not: chunk handling and error cases, the row layout (Adam7 checked against a brute-force pass assignment), inflate limits, hand-computed filter rows, the optimized filter kernels against a literal transcription of the spec for every pixel size, lossless re-filtering, filter protection, Prism, alpha restore, density scaling, sparse sampling, cut-off files, cancellation of export work, building a source from RGBA pixels, that every strategy changes even a small image at low intensity, and that every strategy yields a PNG whose CRCs and zlib stream verify.

- GIF dither (`dither.test.js`), with an LZW decoder written independently of `dither.js`: round trips of the GIF writer at several palette sizes, dictionary clears, the end code at every image length, every method and palette keeping indices inside the palette, determinism and the seed, dot size and enlarging, the share of white dots on mid gray, strength 0, duotone colors, transparency, median cut, palette spread, Bayer matrices and the nearest-color search. In Chrome, its decoder gave the same pixels as this independent decoder for every setting tested.

- JPEG crush (`crush.test.js`), with a baseline decoder written independently of `crush.js`: the zigzag order, IJG quality scaling, the AAN DCTs against the textbook formulas, Huffman length limiting, that decoded coefficients equal the encoded ones, decoding at every subsampling and at sizes that are not whole MCUs, closeness to the source at quality 100, separate color quality, generations, rolling, compositing over white and determinism.

- GIF (`gif.test.js`), with synthetic GIFs from an LZW encoder and checked by a reference decoder, both written independently of the app (the decoder gave the same pixels as Chrome, Firefox and ImageIO on every file they decoded in full): block walk and error cases, cut-off files and frames of zero size, minimum code size 1, bit-exact repair of undamaged codes (with and without clear codes when the dictionary fills), replacement of bad codes, the wrap-around of short frames, trimming, palette wraparound, that starting over stays fast on codes that are nearly all clear codes, that raw mode's cut-off count matches the reference decoder, that 12-bit codes survive Echo and Drift, Prism's pixel counts, picks and color rules, that every frame decodes in full with every index inside its palette under random settings, that everything outside the image data stays the same, determinism, Steady, and the pixel limit.

- Shared helpers (`pixels.test.js`): the random number generators, compositing over white, and resizing.

- Split (`split.test.js`): the picture comes back when nothing is moved; an offset moves exactly one plane; the three edge modes; blank planes per model; wiring; zoom and twist leave the middle plane alone; tear bands are shared between planes and follow the seed; alpha stays in place.

- Sort (`sort.test.js`): every algorithm only rearranges, does nothing at 0 and finishes at 1; bubble and selection sort against literal versions of themselves; the invariants of insertion, merge, shell, heap, quick and radix sort when interrupted; key ranges; directions; pixels never leave their line; pixels outside the brightness range never move.

- Misread (`misread.test.js`): round trips of every format; stream sizes; the shear of a width that is one off; what each text editor does, byte for byte; bit shifts, reversal and swaps; the height limits.

- Bend (`bend.test.js`): the Hilbert curve covers rectangles of any size in steps to a neighbor; µ-law against G.711; the picture comes back with every pedal off, for every scan and track layout; an echo's impulse response; echoes cross colors on one track only; backwards echoes come first; no pedal produces values that run away at any knob setting; the WAV header.

- Signal (`signal.test.js`): the raster; the subcarrier's four samples per cycle; a clean cable returns a soft picture; stripes at the subcarrier frequency turn into color with the notch filter; a black and white set shows a flat color as dots; the color and tint knobs; vertical hold moves whole lines around a black bar; horizontal hold leans; the seed and the frame number.

- Mosh (`mosh.test.js`): the search finds a known pan; nothing moves in a flat picture; with the full correction one frame equals the next frame exactly; without correction every pixel of a result is a pixel of the source; a continued run equals one started over; the invented vectors; another picture as next frame; tiny and odd sizes.

- Source view (`source.test.js`): every button from all eight orientations against literal turns and flips; four quarter turns and double flips return to the start; a zoom is exactly a crop; turning a zoomed view keeps the same part in view; the address form and junk in it; one-pixel-wide pictures.

- Export (`export.test.js`): the default saves the result itself under its old name; sizes keep the shape; when a copy is rendered and in which format; the limits; names; remembered options are checked.

- JPEG surgery (`surgery.test.js`), with the independent decoder of the crush tests (shared from `test/helpers/`): without cuts or lies the bytes equal JPEG crush's; every cut read back from the file; the header lies; a claimed size never asks for more blocks than the file holds, at every pair of real and claimed sampling; shared Huffman tables when the layout is lied about.

If needed in a later version, larger files can be handled by moving manipulation to a Web Worker, but this is out of scope for now.

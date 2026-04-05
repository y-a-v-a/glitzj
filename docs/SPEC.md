# Glitzj

The glitch making app

## Purpose

A glitch in an image is a visual representation of data deformation without totally breaking the image's data signature. In other words, a glitch is bended data — an erroneous derivative of the original, but one whose data is still understood by common image rendering engines (the browser, OS image previews, etc.).

The app lets a user load a JPEG image and apply one or more glitch strategies to it in a controlled way. Only renderable results can be exported — the output is always a valid JPEG.

JPEG is the primary target format because its compressed scan data is tolerant of byte-level corruption, producing visually interesting artifacts. PNG's per-chunk CRC checksums make most corruption invalid to renderers and is out of scope for now.

**v1 is restricted to baseline sequential JPEGs (SOF0) with no restart markers.** Progressive JPEGs (SOF2) interleave multiple scan passes and have a fundamentally different scan data layout; CMYK JPEGs add a fourth channel that changes byte geometry; restart markers (RSTn, `0xFFD0`–`0xFFD7`) appear inside the entropy-coded scan data and interact unpredictably with byte-shifting strategies.

A baseline SOF0 file can still contain restart markers, so the SOF check alone is not sufficient. Files are rejected at load time if either condition is true:

1. The SOF marker is not SOF0 (i.e. not `0xFFC0`).
2. Any RSTn marker (`0xFFD0`–`0xFFD7`) is found while scanning the entropy-coded data between the `SOS` and `EOI` markers.

Validation happens in two stages before any strategy processing begins:
1. Perform a normal marker-walk through the JPEG structure to confirm the file is baseline sequential and to locate the `SOS` and `EOI` bounds.
2. Scan the bytes inside that scan-data region for restart markers, treating `0xFF00` as byte-stuffing rather than a marker.

## Interface

- **Before/after layout:** the original image on the left, the glitched result on the right.
- **Broken state:** if the current settings produce a file that cannot be rendered, the "after" panel shows a simple "image broken" message instead of crashing or showing nothing.
- **Reset button:** reverts all glitch settings, restoring "after" to match "before".
- **Export button:** saves the glitched JPEG to disk. Disabled whenever the current output is in a broken state — export is only available for renderable results.

### Controls

Two shared controls apply to all active strategies:

- **Intensity** — a 0–100 slider controlling the magnitude of the effect across all active strategies
- **Seed** — a numeric value that influences the random decisions in each strategy (which ranges are targeted, where blocks are placed, which bytes are selected). It steers the character of the glitch rather than guaranteeing bit-identical output. Includes a "randomise" button to pick a new seed at random.

## Glitch strategies

Baseline sequential JPEG compresses image data as a single, top-to-bottom sequence of 8×8 pixel blocks of DCT (frequency domain) coefficients. The file stores these blocks in one contiguous scan data region (between the SOS marker and the EOI marker). This layout is what makes the byte-targeting strategies below predictable — progressive or non-standard encodings would break these assumptions. This structure gives corruption a predictable visual character depending on *where* in the scan data it is applied:

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
Copies a seeded source block and pastes it over adjacent byte ranges repeatedly.
- *Intensity drives:* number of repetitions (1 at minimum intensity, up to 8 at maximum). Source block length is fixed at 2% of scan data.
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

## Iteration / validity

The output is always tested for renderability before the export button is enabled. When active strategies produce an unrenderable file, the app can optionally auto-retry with incremented seeds until a renderable result is found (up to a configurable maximum number of attempts). If a retry succeeds, the successful seed replaces the current seed value in the UI and becomes the new reproducible state. This is opt-in and off by default.

## Technology

Web app (HTML + JavaScript):
- `FileReader` + `Uint8Array` for JPEG byte manipulation
- `<img>` / `Canvas` for real-time rendering and broken-state detection
- `Blob` + `URL.createObjectURL` for the live preview
- `FileSaver` or a download anchor for export
- No install required, runs in any browser

### Guardrails

All byte manipulation runs in the browser's main thread, so large inputs will block the UI. Two independent hard limits are enforced at load time — both must pass:

- **File size ≤ 10 MB** — checked immediately from the `File` object before any reading occurs.
- **Dimensions ≤ 4000 × 4000 px** — checked after decoding the image into an `<img>` element, before any canvas or byte work begins. Decoded pixel data costs `width × height × 4 bytes` in memory regardless of file size; a compressed 3 MB JPEG at 8000×6000 decodes to ~183 MB.

If either limit is exceeded, the file is rejected with a clear error message stating which limit was hit. No processing is attempted.

If needed in a later version, larger files can be handled by moving manipulation to a Web Worker, but this is out of scope for now.

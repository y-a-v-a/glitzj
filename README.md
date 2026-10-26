# Glitzj

A glitch tool for JPEG and PNG images that runs entirely in your browser. Nothing is uploaded; your photos never leave your machine.

## What it does

A glitch is bent data: an image whose bytes have been deliberately damaged, yet still open in any viewer. JPEG suits this well. Its compressed picture data tolerates corruption and answers with color smears, torn rows, repeated bands and scattered noise. Glitzj damages only that picture data and leaves the file's structure intact, so every export is a real JPEG that opens anywhere.

PNG protects its picture data with checksums, so Glitzj goes one level deeper: it unpacks the rows of pixels, damages them, and packs them up again with fresh checksums. PNG stores each row as differences from neighboring pixels, so one damaged byte runs on as a streak, a smear or a block of color depending on the row's filter. Every export is a real PNG.

## How to use it

1. Drop a JPEG or PNG onto the page, paste one from the clipboard (a screenshot works), or click the left panel to open a file.
2. Switch on one or more strategies. The right panel updates instantly.
3. Move the intensity slider to set how hard the effect hits.
4. Change the seed, or press Randomise, to reroll where the damage lands. The same image, seed and settings always give the same result.
5. Export when you like what you see.

Your settings are mirrored in the page address, so you can bookmark a look or send it to someone who has the same source image. Exported files carry the strategies, intensity and seed in their name.

## Strategies

- **Static** sprinkles noise across the whole image.
- **Dropout** blanks out contiguous runs, leaving solid patches.
- **Echo** repeats one block over its neighbors, producing bands.
- **Drift** shifts data forward, tearing and displacing rows.
- **Smear** corrupts early data for color bleeds and large-scale distortion.
- **Crumble** corrupts late data, destroying edges while the image stays recognizable.
- **Prism** (PNG only) decodes random rows with the wrong filter, giving bands of shifted color.

Strategies combine freely. On PNG, early and late data are the top and bottom of the image.

### PNG filters

PNG predicts every byte from its neighbors, and the way it does so decides how damage spreads. The **Filter** control re-encodes the image with one filter before glitching; the picture itself does not change, only how it breaks:

- **None** keeps damage to single pixels.
- **Sub** streaks it sideways.
- **Up** streaks it downward.
- **Average** smears it diagonally.
- **Paeth** breaks it into blocks.

**Original** keeps whatever filters the file came with.

### Glitch a JPEG as PNG

Prefer the PNG look for a photo? With a JPEG loaded, switch on **Glitch as PNG**. Glitzj takes the picture as your browser shows it, turns it into a PNG in memory and glitches that, so the Filter control, Prism and the PNG-style streaks all apply. The export is then a PNG, which is larger than the JPEG it came from, and it carries no camera metadata. Switch it off to return to the JPEG glitch.

## Keeping results viewable

Damaged bytes can accidentally form control codes that make a decoder give up partway, leaving the lower part of the image flat gray. **Protect markers**, on by default, quietly repairs those codes so the whole glitch survives. Turn it off if you want the cut-off look. **Auto-retry** steps through seeds until one renders whenever a result breaks.

For PNG the same toggle reads **Protect filters**: it keeps each row's filter intact so the damage stays in the pixels. Without it, damaged filter bytes reinterpret whole stretches of the image, and an invalid one makes viewers disagree: in testing, Chrome stopped drawing at that row, Firefox showed nothing and the macOS image decoder behind Safari and Preview carried on. **Keep alpha**, on by default for images with transparency, restores the original transparency so damage changes colors instead of punching holes.

## Limits

JPEG and PNG, up to 10 MB and 4000 × 4000 pixels; for PNG the unpacked picture data may be at most 64 MB, which a 16-bit 4000 × 4000 image exceeds. Animated PNGs are glitched as a still of their first frame. Very large files would freeze the page.

## Running it

There is nothing to install or build. Serve the folder that contains index.html with any static web server and open it in a modern browser.

---

© 2026 Vincent Bruijn

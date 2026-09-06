# Glitzj

A glitch tool for JPEG images that runs entirely in your browser. Nothing is uploaded; your photos never leave your machine.

## What it does

A glitch is bent data: an image whose bytes have been deliberately damaged, yet still open in any viewer. JPEG suits this well. Its compressed picture data tolerates corruption and answers with color smears, torn rows, repeated bands and scattered noise. Glitzj damages only that picture data and leaves the file's structure intact, so every export is a real JPEG that opens anywhere.

## How to use it

1. Drop a JPEG onto the page, paste one from the clipboard, or click the left panel to open a file.
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

Strategies combine freely.

## Keeping results viewable

Damaged bytes can accidentally form control codes that make a decoder give up partway, leaving the lower part of the image flat gray. **Protect markers**, on by default, quietly repairs those codes so the whole glitch survives. Turn it off if you want the cut-off look. **Auto-retry** steps through seeds until one renders whenever a result breaks.

## Limits

JPEG only, up to 10 MB and 4000 × 4000 pixels. Very large files would freeze the page.

## Running it

There is nothing to install or build. Serve the folder that contains index.html with any static web server and open it in a modern browser.

---

© 2026 Vincent Bruijn

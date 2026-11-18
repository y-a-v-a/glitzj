# Glitzj

A workshop for breaking images on purpose, running entirely in your browser. Nothing is uploaded; your photos never leave your machine.

It started as a glitch tool for JPEG, PNG and GIF files and grew into ten tools. None of them paints an effect on top of a picture. Each one takes a real mechanism (a file format, a sorting algorithm, a printing press, a tape recorder, a television) and uses it wrongly, so what you see is what that mechanism does when it goes wrong.

| | |
|---|---|
| **Glitch** | damage the bytes of a JPEG, PNG or GIF and keep the file valid |
| **GIF dither** | redraw a picture in a handful of colors and shape the dots |
| **JPEG crush** | compress down to quality 0, again and again |
| **JPEG surgery** | operate on the numbers inside a JPEG, then lie in its header |
| **Split** | pull the color planes of a picture apart with your hands |
| **Sort** | run a sorting algorithm over the pixels and pull the plug halfway |
| **Bend** | play the picture through audio effects, and listen to it |
| **Misread** | read the right bytes with the wrong width, format or alignment |
| **Signal** | send the picture as analog television and receive it badly |
| **Mosh** | apply the motion of a video to a still, over and over, with no keyframe |

An image you open in one tool is there in the next, and every result can be fed back in as a new source, so the tools chain: sort it, send it through the television, crush what arrives.

**Try it at [y-a-v-a.github.io/glitzj](https://y-a-v-a.github.io/glitzj/).**

![Glitzj with a portrait photo on the left and its glitched version on the right, using the Static strategy and the Paeth filter](docs/screenshot.png)

## What it does

A glitch is bent data: an image whose bytes have been deliberately damaged, yet still open in any viewer. JPEG suits this well. Its compressed picture data tolerates corruption and answers with color smears, torn rows, repeated bands and scattered noise. Glitzj damages only that picture data and leaves the file's structure intact, so every export is a real JPEG that opens anywhere.

PNG protects its picture data with checksums, so Glitzj goes one level deeper: it unpacks the rows of pixels, damages them, and packs them up again with fresh checksums. PNG stores each row as differences from neighboring pixels, so one damaged byte runs on as a streak, a smear or a block of color depending on the row's filter. Every export is a real PNG.

GIF compresses its pixels with LZW, which builds a dictionary of pixel runs as it goes and refers back to it with numbered codes. Glitzj damages those codes. A damaged code decodes to a different run of pixels, often a longer or shorter one, so everything after it tears and shifts sideways, and the dictionary entries built from it carry the damage on. Every frame of an animated GIF is glitched and the animation keeps playing. Every export is a real GIF.

## How to use it

1. Drop a JPEG, PNG or GIF onto the page, paste one from the clipboard (a screenshot works), or click the left panel to open a file.
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
- **Prism** (PNG and GIF) decodes random rows of a PNG with the wrong filter, giving bands of shifted color. On a GIF it shifts the colors of random palette entries.

Strategies combine freely. On PNG and GIF, early and late data are the top and bottom of the image.

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

### GIF

On a GIF the strategies work on the LZW codes of each frame:

- **Static** swaps random codes for others, so the picture tears at each one and shifts sideways from there.
- **Dropout** turns runs of codes into single pixels. The picture loses the pixels those codes stood for, slides up, and the space left at the bottom rolls around to the top of the frame, like a TV losing its vertical hold.
- **Echo** repeats a run of codes, so fragments of the picture repeat.
- **Drift** shifts a run of codes forward, displacing the picture below it.
- **Smear** and **Crumble** damage the first or last codes: tears near the top that run on down, or damage near the bottom.
- **Prism** rotates the red, green and blue values of random palette entries, so every pixel in such a color changes hue. A photo squeezed into 256 colors spreads each tone over many entries, so this lays bare the bands its palette is built from. Grays have no hue to rotate and get split into colors instead. Colors that cover more of the picture are more likely to be picked.

In interlaced GIFs the early codes describe every eighth row, so damage spreads over the whole image in stripes.

Every frame of an animation gets its own random choices, so the glitch jumps around as it plays. Switch on **Steady** to make the same choices on every frame; the damage then tends to stay in place. Many animated GIFs only redraw the parts of each frame that change, so damage can linger on screen until something draws over it.

## Keeping results viewable

Damaged bytes can accidentally form control codes that make a decoder give up partway, leaving the lower part of the image flat gray. **Protect markers**, on by default, quietly repairs those codes so the whole glitch survives. Turn it off if you want the cut-off look. **Auto-retry** steps through seeds until one renders whenever a result breaks.

For PNG the same toggle reads **Protect filters**: it keeps each row's filter intact so the damage stays in the pixels. Without it, damaged filter bytes reinterpret whole stretches of the image, and an invalid one makes viewers disagree: in testing, Chrome stopped drawing at that row, Firefox showed nothing and the macOS image decoder behind Safari and Preview carried on. **Keep alpha**, on by default for images with transparency, restores the original transparency so damage changes colors instead of punching holes.

For GIF the toggle reads **Protect codes**. Viewers react very differently to damaged LZW data. In testing, Chrome stopped drawing at the first code it could not use and left the rest transparent; Firefox showed nothing at all for such a still image, while still reporting it as loaded; the macOS image decoder carried on. Protect codes replaces every code a viewer would give up on, makes every frame exactly as long as it should be, and keeps palette indices inside the palette. Chrome, Firefox and the macOS decoder then showed identical pixels in every test. Without it, the panel says how many frames viewers will cut off, since Firefox gives no sign of it.

## GIF dither

The second page, **GIF dither** (`gif.html`), does not glitch. It redraws any image your browser can open as a GIF with a small palette and lets you shape the dithering: the pattern of dots that fakes the colors the palette lacks.

- **Method**: error diffusion (Floyd–Steinberg, Atkinson, Jarvis–Judice–Ninke, Stucki, Burkes, Sierra, Sierra Lite) passes each pixel's rounding error on to its neighbors, giving a grainy, organic pattern. Ordered dither (Bayer 2 × 2, 4 × 4, 8 × 8) gives a regular crosshatch. Noise adds random jitter; change the seed to reroll it. Off maps every pixel to its nearest color, giving flat bands.
- **Strength** scales how much error or pattern is added. At 0 every method looks like Off.
- **Serpentine** runs every other row right to left, which breaks up the diagonal lines error diffusion can leave.
- **Colors from**: the image itself (a median-cut palette of 2 to 256 colors), grayscale or duotone with 2 to 256 levels, the 216 web-safe colors, or the 8 RGB primaries. Duotone dithers in gray and then paints the levels from your dark color to your light color. The − and + buttons beside the slider step one color at a time.
- **Dot size** makes every dot cover 1 to 16 pixels of the original in each direction. A GIF stores no DPI, only a width and height in pixels, so fewer pixels per inch means fewer pixels: at dot size 4 a 1600 px wide photo is dithered at 400 px and every dot shows as a 4 × 4 block.
- **Brightness** and **Contrast** are applied before dithering, so they change the dot pattern itself, not just the colors.
- **1:1** above the result shows it without scaling it down, so you see the dots as they are.

**Export at original size**, on by default, saves the GIF at the size of the original with each dot drawn as a block of pixels. Switch it off to save one pixel per dot. Pixels that are less than half opaque become transparent; GIF has no partial transparency. An animated GIF is dithered as a still of its first frame. Settings are mirrored in the page address here too.

## JPEG crush

The third page, **JPEG crush** (`crush.html`), does not glitch either. It compresses any image your browser can open as a JPEG and shows the result live, so you can drag the quality all the way down to 0 and watch the 8 × 8 blocks take over. Glitzj uses its own JPEG encoder for this rather than the browser's, so the same image and settings give the same file in every browser, and so it can offer the knobs browsers hide.

- **Quality** runs from 0 to 100 on the IJG scale that libjpeg, GIMP and ImageMagick use. 0 gives the same file as 1: every quantization step is already at 255, the most a baseline JPEG allows. Press **0** to jump there.
- **Separate color quality** splits the slider in two: detail (brightness) and color. Crush the color and keep the detail for smeared, blocky color over a sharp picture, or the other way around.
- **Color resolution** sets how many pixels share one color sample: 4:4:4 (none), 4:2:2, 4:2:0 (what most cameras and encoders use), 4:1:1 and 4:1:0, one color sample per 4 × 2 pixels. The detail stays; the color gets coarser.
- **Generations** compresses, decodes and compresses again, up to 50 times. On its own this changes little: in tests the picture stopped changing after the second generation. **Shift** moves the picture a few pixels right and down between generations, so the blocks land somewhere new every time and the damage adds up. It is moved back before the last generation, so the result lines up with the original.
- **1:1** above the result shows it without scaling it down.

Transparent pixels are composited over white, since JPEG has no transparency. The panel shows the file size, the bits per pixel and the size as a share of the original file; hover it for the quantization steps. Settings are mirrored in the page address, and the export name lists them.

## JPEG surgery

**JPEG surgery** (`surgery.html`) opens a JPEG up instead of hitting it from outside. A JPEG does not store pixels: it cuts the picture into blocks of 8 × 8, describes each block as a mix of 64 wave patterns, from flat to a fine checkerboard, and stores how much of each pattern the block holds, divided by a table of step sizes. That table travels in the file's header, next to the picture's size and the way its color was shrunk, and a decoder believes all of it. So there are two things to do here: **cut** the numbers, and **lie** in the header. The result is always a correct JPEG that any viewer opens without complaint; it shows exactly what the file tells it to.

Cuts:

- **Coarsest** and **Finest** drop the patterns outside a range. With Coarsest at 1 every block loses its average, and only edges are left on gray. With Finest at 0 every block is one flat color.
- **Shift** moves every pattern a number of places toward the fine end: soft shading turns into stripes and checks.
- **Transplant** gives a share of the blocks the patterns of a random other block. Each block keeps its own average, so the picture stays where it is and only its texture moves.
- **Drift** uses the fact that a JPEG stores each block's average as the difference from the block before it, so one wrong value shifts everything after it. This is the banding the Glitch page produces by accident, here on purpose and under control.
- **Mirror blocks** mirrors every block along its diagonal while the blocks stay in place. **Invert detail** turns the detail of every block inside out. **Swap color channels** stores the two color signals in each other's place.

Lies:

- **Lie about the quality** writes step sizes for another quality into the header than the ones the picture was divided by. Claim a lower quality than the truth and the decoder multiplies everything by too much: contrast and color explode. Claim a higher one and the picture fades to gray.
- **Claimed width** says the picture is a few blocks wider or narrower than it is, so the decoder breaks the rows in the wrong place and the picture leans over, in steps of whole blocks. The claimed height is adjusted so the file still holds enough data.
- **Claimed color** names another color resolution than the real one. The decoder then deals the blocks out wrongly: brightness blocks are read as color and color as brightness.
- **Swap the step tables** hands the decoder the color step sizes for the brightness, and the other way around.

With no cuts and no lies the file is byte for byte what JPEG crush makes. In tests Chrome and the macOS image decoder opened every combination tried.

## Split

**Split** (`split.html`) treats a color picture as what it is: several pictures stacked on top of each other, which only look like one while they stay exactly aligned. It takes them apart, moves each on its own and stacks them again.

- **RGB**, **CMYK** or **YCbCr** chooses what the picture is taken apart into: three lights as on a screen, four inks as on a printing press, or one brightness and two color signals as in video. A light that is missing leaves the picture dark, an ink that is missing shows the paper, and a color signal that has moved colors the wrong part of the picture.
- Pick a plane and **drag the picture** on the right to move it. The arrow keys nudge it one pixel, ten with Shift; double-click a plane to put it back. **Scatter** throws every plane somewhere else, **Align** puts them all back.
- **Zoom** makes the first plane smaller and the last one larger, so they agree in the middle and drift apart toward the edges, like a cheap lens. **Twist** turns them against each other.
- **Tear** cuts the picture into horizontal bands and pushes about half of them sideways, every plane by its own amount. **Band** sets how tall the bands are.
- **Wiring** plugs each plane into another's place: the red picture into the green light, the black plate into the cyan ink.
- **Edges** decides what shows where a moved plane no longer covers the picture: it wraps around, smears its last pixel, or is left blank.

Planes are moved without smoothing, so a pixel stays a pixel however far it travels.

## Sort

**Sort** (`sort.html`) does pixel sorting, with a twist. Putting the pixels of every row in order of brightness turns a photo into streaks, and a finished sort looks the same whichever algorithm did the work. A sort that is stopped halfway does not: every algorithm leaves its own kind of mess. So this page runs real sorting algorithms and pulls the plug.

- **Bubble** drags bright pixels along the line like wet paint. **Insertion** has finished the first part of each span and not looked at the rest. **Selection** has put the darkest pixels in place and thrown whatever stood there to wherever they came from. **Quick** has split everything into darker and lighter, again and again, with a jumble inside every part. **Merge** leaves a comb of small gradients. **Shell** weaves several half-sorted copies of the picture into each other. **Heap** lays the pixels out as the tree it is building. **Radix** has carefully sorted by the lowest bits only, the least meaningful part of every pixel. **Bogo** shuffles and hopes.
- **Progress** is how far the algorithm got. At 100 it finished, and every algorithm gives the same picture. **Unevenly** stops every line at a different moment. **Play** runs the sort from start to finish while you watch.
- **Sort by** brightness, hue, saturation, one color, or the number itself: the pixel as the single value it is stored as. The arrows set the direction.
- **Sort** runs within a brightness range (pixels outside the range stay put and end a span), random chunks, or whole lines.

Bubble sort would take far too long done literally, so it is computed in a way that gives exactly the result of that many passes; the tests check it against a literal bubble sort.

## Bend

**Bend** (`bend.html`) is the oldest trick in databending: open a picture in a sound editor as if it were a recording, run it through audio effects, and save it as a picture again. Here the picture becomes one long tape of samples, the tape goes through a pedalboard, and comes back as pixels. An echo in sound is a ghost in the picture, a filter that rings leaves ripples beside every edge, and a tape that runs a little fast tilts the whole frame.

- The tape runs along **Rows**, **Back and forth**, down **Columns**, or along a **Hilbert curve**, a line that winds through the whole picture so that what is close on the tape is close in the picture. The same echo that lands to the right in a row scan spreads in blocks along the curve.
- **One track** puts red, green and blue in turn on a single track, as in a raw image file. An echo that is not a whole number of pixels long then lands on the wrong color, which is where the rainbows come from. **Three tracks** gives every color its own.
- **Imported as** 8-bit PCM or µ-law, the telephone encoding in which white is silence and mid gray is the loudest sound there is, so the same pedals do something else entirely. **Too loud** decides whether samples that no longer fit are clipped or wrap around. **Play backwards** runs the tape through the pedals from the end, so echoes come before the thing they echo.
- Eight pedals, each with a switch and one or two knobs: **Speed**, **Drive**, **Crush**, **Filter**, **Phaser**, **Vibrato**, **Echo** and **Reverb**. They are ordinary textbook audio effects, applied in that order.
- **Listen** plays the tape, with a marker on the picture showing where the sound is. Turn the knobs while it plays. **Export WAV** saves the tape as sound.

## Misread

**Misread** (`misread.html`) has no randomness and no effects. A picture file without its header is a long row of bytes that mean nothing by themselves: the width, the order of the colors and the number of bits per pixel are an agreement between whoever wrote the bytes and whoever reads them. This page writes the picture down correctly and then breaks the agreement.

- **Written as** and **Read as** choose from nine formats, among them RGB, RGBA, 16-bit RGB, one bit per pixel, planar RGB and the YUV layouts video uses. Write RGB and read RGBA, and every pixel swallows a byte of the next one.
- **Width** is how wide the reader believes the picture is. One pixel off and every row starts one pixel late, which tilts the picture; further off and it falls apart into stripes. The arrow keys step it, **0** returns to the right width.
- **Then saved by** passes the bytes through a text editor on the way, which is what actually happens to binary files that get opened as text: an editor that writes Windows line endings adds a byte before every byte that happens to be a line feed; an editor that expects UTF-8 replaces every byte that is not valid text with three others; a conversion from Latin-1 doubles every byte above 127. Editors that make the data longer push everything after each change further along.
- **Skip bytes** and **Shift bits** start reading late, by whole bytes or by single bits. **Bits backwards** reads every byte lowest bit first. **Swap byte pairs** is what a machine with the other byte order would do.

Every result is exactly what a program would show that was told the wrong thing about the same bytes.

## Signal

**Signal** (`signal.html`) sends the picture as analog color television. That system puts a whole picture on one wire as a single wavering voltage: brightness is the voltage itself, and color rides on top as a small fast wave whose height says how strong the color is and whose timing says which color. The receiver has to pull the two apart again and never quite can. The rainbows on a striped shirt, the dots crawling along a color edge and the hue that smears to the right are not drawn on here. The page builds the signal (NTSC), damages it, and receives it the way a television does; the artifacts are what a correct receiver makes of a signal that is slightly wrong.

- **Lines** is how many scan lines carry the picture: 240, 480, 720, or as many as the picture has rows. The result has that many rows.
- Three receivers. **Notch filter** is the cheap set: fine detail turns into rainbows. **Comb filter** compares each line with the one above: sharper, but dots hang under every color edge. **Black and white** knows nothing of color and shows the color wave as what it is, a fine pattern of dots wherever the picture is colorful.
- **Color** and **Tint** are the knobs a television had.
- **Snow** is a weak signal. **Ghost** is the signal arriving twice, the second time off a building; the late copy has the wrong colors because its color wave arrives shifted. **Hue drift**, **Bleed** and **Soft** are a receiver that follows the signal sloppily.
- **Jitter** and **Wobble** move lines sideways. **H-hold** and **V-hold** are the hold knobs turned too far: the picture leans over or rolls, and the gaps between lines and between frames show as dark bars.
- **Tracking** and **Dropouts** are a video recorder with a worn tape: a band of torn, colorless lines, a ragged strip at the bottom, white dashes.
- **Live** receives frame after frame: the snow moves, the dots crawl, whatever has lost its hold rolls. **Record** saves the moving picture as a video file.

## Mosh

**Mosh** (`mosh.html`) is datamoshing for a single picture. Video is not stored as pictures: a codec stores a full picture now and then, a keyframe, and for the frames in between only instructions: cut the previous frame into blocks, take each block from where it was a moment ago, and add a small correction. Datamoshing removes the keyframes, so instructions meant for one picture are carried out on another, again and again, and nothing ever puts it right.

A still has no frames in between, so this page makes one, and then does what a video encoder does: it searches, block by block, for where each block of the next frame came from. The search is a real one and makes the mistakes real encoders make. In a flat sky every position matches equally well, so the vectors there point anywhere, and those mistakes are what the smears grow from.

- **Zoom**, **Pan** and **Spin** make the next frame by moving the picture a little. **Strength** sets how far, **Direction** which way.
- **Another picture** uses a different picture as the next frame. The encoder still finds a place in your picture for every block of the other one, so the first frame is the other picture rebuilt from pieces of yours.
- **Fall** and **Scatter** skip the search: the brighter a block, the further it moves, or every block takes its pixels from somewhere nearby.
- **Blocks** is the size of the pieces, 8, 16 or 32 pixels. **Frame size** is the size of the video frame, and of the result.
- **Frames** is how many times the instructions are carried out, each time on the result of the time before. **Play** runs them one by one; **Record** saves the run as a video file.
- **Correction** is what a codec adds for whatever the vectors cannot explain. At 0 it is thrown away. Turned all the way up, the first frame is exactly the next frame, as in a working codec, and after that the same correction is added again every frame and burns in.

## The original: turn, mirror, zoom

Every page has a small toolbar on the Before panel, for deciding what goes in:

- **Turn** a quarter to the left or right (**[** and **]**), **mirror** left to right (**H**) or flip top to bottom (**V**).
- **Zoom in** on a part of the picture, up to 8× (**+** and **−**), and drag the picture to move around. A zoom is a crop: the tool gets the pixels you see, at their own size, and nothing is resampled.
- The **×** button goes back to the whole picture, the right way up.

It matters more than it sounds. Most of these tools work along rows: a sort streaks sideways, an echo lands to the right, a television tears horizontally. Turn the picture a quarter and all of that runs down instead. Zoom in first and a 4000-pixel photo becomes a 500-pixel one, in which every glitch is eight times as large.

Your file is never changed; the view is only a note of how to look at it. It is part of the page address, like the other settings, and it travels with the picture from page to page.

The Glitch page is the exception in how it does this, since it damages the bytes of a file and not its pixels: there the picture is redrawn the way the view shows it, saved as a new JPEG or PNG, and that file is glitched. With the view untouched it glitches your file's own bytes, as it always did. A GIF cannot be turned or zoomed on that page.

## Export

**Export** (or **E**) saves the result as made: the file itself, byte for byte. The arrow next to it opens the options, which are remembered:

- **Size**: a quarter, half, 2×, 3× or 4× of the result's size, or a width in pixels. A resized copy carries its size in its name, so it never overwrites the original export.
- **Scaling**: **Sharp pixels** keeps every pixel a hard-edged square, which is what a glitch wants when it is enlarged. **Smooth** blends them.
- **Format**: as made, or PNG, JPEG or WebP, with a quality for the last two.
- **Copy** puts the picture on the clipboard, and **Share** hands the file to another app where the system offers that.

Anything other than "as made" saves a rendered copy: the picture as your browser shows it. For the pages that make real files (Glitch, GIF dither, JPEG crush, JPEG surgery) that copy is worth having for its own sake. Viewers disagree about damaged JPEGs and GIFs, and a PNG of what you saw looks the same everywhere. A rendered copy of an animated GIF is a still of its first frame.

## From tool to tool

The image you open follows you from page to page for as long as the tab is open, turned and zoomed the way you left it, so you can try the same picture in every tool without opening it again. It is kept in your browser's own storage, tied to that tab, and nowhere else.

**Surprise me** (or the **X** key), on the seven newer tools, rolls every setting at once for a look you did not ask for. **Reset** takes you back.

**Feed back**, next to Export on every page, makes the result on screen the new source. That turns the ten tools into one chain, in any order and as long as you like, and the name of the exported file keeps the whole recipe.

## Limits

The Glitch page opens JPEG, PNG and GIF; the other pages open any image your browser can show. All of them accept up to 10 MB and 4000 × 4000 pixels. On the Glitch page, for PNG the unpacked picture data may be at most 64 MB, which a 16-bit 4000 × 4000 image exceeds, and a GIF's frames may add up to at most 200 million pixels. Animated PNGs are glitched as a still of their first frame; animated GIFs keep all their frames. Very large files would freeze the page.

The pixel tools work on the whole picture at its real size and show their progress when that takes a moment. Signal works at the number of lines you choose, and Misread can give a result of another size than the source: at most 4000 pixels wide and four times as tall as the picture.

## Running it

There is nothing to install or build. Serve the folder that contains index.html with any static web server and open it in a modern browser.

Every push to `main` runs the tests and publishes the `webapp` folder to GitHub Pages.

---

© 2026 Vincent Bruijn

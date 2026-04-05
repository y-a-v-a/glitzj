// ── JPEG marker-walk ──────────────────────────────────────────────────────────
//
// Validates that a JPEG is baseline sequential (SOF0) with no restart markers,
// and locates the entropy-coded scan data region.
//
// Returns: { scanStart, scanEnd }
//   scanStart — byte offset of the first entropy-coded byte (after SOS header)
//   scanEnd   — byte offset of the 0xFF that begins the EOI marker
//
// Throws a descriptive Error for any unsupported or malformed input.

function parseJpeg(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xFF || bytes[1] !== 0xD8) {
    throw new Error('Not a valid JPEG (missing SOI marker).');
  }

  let i = 2; // skip SOI
  let foundSOF0 = false;
  let scanStart = -1;
  let scanEnd   = -1;

  while (i < bytes.length - 1) {
    if (bytes[i] !== 0xFF) {
      throw new Error(`Malformed JPEG structure at byte offset ${i}.`);
    }
    i++;

    // JPEG allows 0xFF padding bytes between segments — skip them.
    while (i < bytes.length && bytes[i] === 0xFF) i++;
    if (i >= bytes.length) break;

    const marker = bytes[i++];

    // ── Standalone markers (no length field) ──────────────────────────────────
    if (marker === 0xD9) break;                    // EOI — done
    if (marker === 0xD8) continue;                 // SOI (duplicate, skip)
    if (marker >= 0xD0 && marker <= 0xD7) continue; // RSTn outside scan data (skip)

    // ── Reject non-baseline SOF types ────────────────────────────────────────
    const nonBaselineSOF = [
      0xC1, 0xC2, 0xC3,
      0xC5, 0xC6, 0xC7,
      0xC9, 0xCA, 0xCB,
      0xCD, 0xCE, 0xCF,
    ];
    if (nonBaselineSOF.includes(marker)) {
      throw new Error(
        'Unsupported JPEG type (not baseline sequential). ' +
        'Only SOF0 JPEGs are supported in v1.'
      );
    }

    // ── Read segment length (big-endian, includes the 2 length bytes) ─────────
    if (i + 1 >= bytes.length) break;
    const segLen = (bytes[i] << 8) | bytes[i + 1];

    if (marker === 0xC0) {
      // SOF0 — baseline sequential DCT
      foundSOF0 = true;
      i += segLen;

    } else if (marker === 0xDA) {
      // SOS — scan header immediately followed by entropy-coded data
      i += segLen;       // skip past the SOS header
      scanStart = i;     // entropy-coded data begins here

      // Walk entropy-coded data, honouring byte-stuffing (0xFF00).
      while (i < bytes.length - 1) {
        if (bytes[i] !== 0xFF) {
          i++;
          continue;
        }

        const next = bytes[i + 1];

        if (next === 0x00) {
          i += 2;  // byte-stuffing: literal 0xFF in data, not a marker
        } else if (next >= 0xD0 && next <= 0xD7) {
          throw new Error(
            'JPEG contains restart markers (RSTn), which are not supported in v1. ' +
            'Re-save the image without restart markers and try again.'
          );
        } else if (next === 0xD9) {
          scanEnd = i;   // 0xFF of EOI marker
          i += 2;
          break;
        } else {
          // Some other marker embedded in scan data — move past the 0xFF.
          i++;
        }
      }

      break; // SOS is always the last header segment

    } else {
      i += segLen; // skip unrecognised/unneeded segment
    }
  }

  if (!foundSOF0) {
    throw new Error(
      'Not a baseline JPEG (SOF0 marker not found). ' +
      'Only baseline sequential JPEGs are supported in v1.'
    );
  }

  if (scanStart === -1 || scanEnd === -1) {
    throw new Error('Could not locate scan data region in this JPEG.');
  }

  return { scanStart, scanEnd };
}

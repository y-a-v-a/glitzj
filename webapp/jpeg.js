// ── JPEG marker-walk ──────────────────────────────────────────────────────────
//
// Locates every mutable entropy-coded byte range in a JPEG while preserving the
// marker structure around it. This supports multi-scan files such as
// progressive JPEGs and baseline files that use restart markers.
//
// Returns:
// {
//   frameMarker,
//   frameType,
//   scanStart,
//   scanEnd,
//   scanLength,
//   scanCount,
//   scanRanges: [{ start, end }, ...],
// }
//
// A file that ends without an EOI marker is accepted: browsers render such
// files, so the trailing bytes are treated as scan data.
//
// Throws a descriptive Error for malformed input.

const SOF_MARKERS = new Set([
  0xC0, 0xC1, 0xC2, 0xC3,
  0xC5, 0xC6, 0xC7,
  0xC9, 0xCA, 0xCB,
  0xCD, 0xCE, 0xCF,
]);

function describeFrameMarker(marker) {
  switch (marker) {
    case 0xC0: return 'baseline sequential DCT';
    case 0xC1: return 'extended sequential DCT';
    case 0xC2: return 'progressive DCT';
    case 0xC3: return 'lossless';
    case 0xC5: return 'differential sequential DCT';
    case 0xC6: return 'differential progressive DCT';
    case 0xC7: return 'differential lossless';
    case 0xC9: return 'arithmetic sequential DCT';
    case 0xCA: return 'arithmetic progressive DCT';
    case 0xCB: return 'arithmetic lossless';
    case 0xCD: return 'differential arithmetic sequential DCT';
    case 0xCE: return 'differential arithmetic progressive DCT';
    case 0xCF: return 'differential arithmetic lossless';
    default:   return 'unknown';
  }
}

function readSegmentLength(bytes, offset) {
  if (offset + 1 >= bytes.length) {
    throw new Error(`Truncated JPEG segment length at byte offset ${offset}.`);
  }

  const segLen = (bytes[offset] << 8) | bytes[offset + 1];

  if (segLen < 2) {
    throw new Error(`Invalid JPEG segment length ${segLen} at byte offset ${offset}.`);
  }
  if (offset + segLen > bytes.length) {
    throw new Error(`JPEG segment overruns file at byte offset ${offset}.`);
  }

  return segLen;
}

// Collects mutable entropy bytes for a single SOS payload only.
// It stops at the first non-RST marker so the outer marker-walk can resume
// from that marker and, in progressive JPEGs, call this again for later scans.
function collectEntropyRanges(bytes, scanStart) {
  const scanRanges = [];
  let i = scanStart;
  let rangeStart = scanStart;

  while (i < bytes.length - 1) {
    if (bytes[i] !== 0xFF) {
      i++;
      continue;
    }

    const next = bytes[i + 1];

    if (next === 0x00) {
      i += 2;
      continue;
    }

    let j = i + 1;
    while (j < bytes.length && bytes[j] === 0xFF) j++;
    if (j >= bytes.length) {
      if (rangeStart < i) scanRanges.push({ start: rangeStart, end: i });
      return { scanRanges, nextMarkerPos: bytes.length };
    }

    const marker = bytes[j];

    if (rangeStart < i) {
      scanRanges.push({ start: rangeStart, end: i });
    }

    if (marker >= 0xD0 && marker <= 0xD7) {
      i = j + 1;
      rangeStart = i;
      continue;
    }

    // Hand control back to parseJpeg() at the next structural marker.
    return { scanRanges, nextMarkerPos: i };
  }

  if (rangeStart < bytes.length) {
    scanRanges.push({ start: rangeStart, end: bytes.length });
  }
  return { scanRanges, nextMarkerPos: bytes.length };
}

function parseJpeg(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xFF || bytes[1] !== 0xD8) {
    throw new Error('Not a valid JPEG (missing SOI marker).');
  }

  let i = 2; // skip SOI
  let frameMarker = null;
  let scanCount = 0;
  const scanRanges = [];

  while (i < bytes.length) {
    if (bytes[i] !== 0xFF) {
      throw new Error(`Malformed JPEG structure at byte offset ${i}.`);
    }

    while (i < bytes.length && bytes[i] === 0xFF) i++;
    if (i >= bytes.length) {
      throw new Error('Truncated JPEG marker at end of file.');
    }

    const marker = bytes[i++];

    // ── Standalone markers (no length field) ──────────────────────────────────
    if (marker === 0xD9) break; // EOI
    if (marker === 0xD8) continue; // SOI
    if (marker === 0x01) continue; // TEM
    if (marker >= 0xD0 && marker <= 0xD7) continue; // RSTn outside scan data

    const segLen = readSegmentLength(bytes, i);

    if (SOF_MARKERS.has(marker)) {
      frameMarker = marker;
      i += segLen;
      continue;
    }

    if (marker === 0xDA) {
      i += segLen;
      scanCount++;
      // One call handles one SOS payload. If the next marker is another SOS,
      // the outer loop will continue and collect the next progressive pass.
      const scan = collectEntropyRanges(bytes, i);
      scanRanges.push(...scan.scanRanges);
      i = scan.nextMarkerPos;
      continue;
    }

    i += segLen;
  }

  if (!frameMarker) {
    throw new Error('Could not locate a JPEG frame marker (SOFn).');
  }
  if (scanRanges.length === 0) {
    throw new Error('Could not locate scan data region in this JPEG.');
  }

  let scanLength = 0;
  for (const range of scanRanges) {
    scanLength += range.end - range.start;
  }

  return {
    frameMarker,
    frameType: describeFrameMarker(frameMarker),
    scanStart: scanRanges[0].start,
    scanEnd: scanRanges[scanRanges.length - 1].end,
    scanLength,
    scanCount,
    scanRanges,
  };
}

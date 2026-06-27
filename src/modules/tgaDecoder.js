'use strict';
/**
 * Minimal TGA decoder (pure Node.js, zero dependencies).
 * Supports Type 2 (uncompressed true-color) and Type 10 (RLE true-color).
 * Output: raw RGBA Uint8Array + width + height.
 */

function decodeTGA(buffer) {
  const buf = buffer instanceof Buffer ? buffer : Buffer.from(buffer);
  const idLen    = buf[0];
  const colorMap = buf[1];
  const imgType  = buf[2];
  // skip color map spec (5 bytes @ 3)
  const xOrigin  = buf.readUInt16LE(8);
  const yOrigin  = buf.readUInt16LE(10);
  const width    = buf.readUInt16LE(12);
  const height   = buf.readUInt16LE(14);
  const bpp      = buf[16];          // bits per pixel: 24 or 32
  const imgDesc  = buf[17];
  const bytesPerPixel = bpp >> 3;    // 3 or 4

  if (width === 0 || height === 0) throw new Error('TGA: zero size');
  if (bpp !== 24 && bpp !== 32) throw new Error(`TGA: unsupported bpp ${bpp}`);
  if (imgType !== 2 && imgType !== 10) throw new Error(`TGA: unsupported type ${imgType}`);

  const colorMapBytes = colorMap ? buf.readUInt16LE(5) * ((buf[7]) >> 3) : 0;
  let offset = 18 + idLen + colorMapBytes;

  const totalPixels = width * height;
  const rgba = new Uint8Array(totalPixels * 4);

  if (imgType === 2) {
    // Uncompressed
    for (let i = 0; i < totalPixels; i++) {
      const b = buf[offset];
      const g = buf[offset + 1];
      const r = buf[offset + 2];
      const a = bytesPerPixel === 4 ? buf[offset + 3] : 255;
      const idx = i * 4;
      rgba[idx] = r; rgba[idx+1] = g; rgba[idx+2] = b; rgba[idx+3] = a;
      offset += bytesPerPixel;
    }
  } else {
    // RLE compressed
    let i = 0;
    while (i < totalPixels) {
      const rep = buf[offset++];
      const count = (rep & 0x7f) + 1;
      if (rep & 0x80) {
        // Run-length packet
        const b = buf[offset];
        const g = buf[offset + 1];
        const r = buf[offset + 2];
        const a = bytesPerPixel === 4 ? buf[offset + 3] : 255;
        offset += bytesPerPixel;
        for (let j = 0; j < count; j++, i++) {
          const idx = i * 4;
          rgba[idx] = r; rgba[idx+1] = g; rgba[idx+2] = b; rgba[idx+3] = a;
        }
      } else {
        // Raw packet
        for (let j = 0; j < count; j++, i++) {
          const b = buf[offset];
          const g = buf[offset + 1];
          const r = buf[offset + 2];
          const a = bytesPerPixel === 4 ? buf[offset + 3] : 255;
          offset += bytesPerPixel;
          const idx = i * 4;
          rgba[idx] = r; rgba[idx+1] = g; rgba[idx+2] = b; rgba[idx+3] = a;
        }
      }
    }
  }

  // TGA origin: bit 5 of imgDesc controls vertical flip
  // 0 = bottom-left origin → need to flip rows
  const flipY = !(imgDesc & 0x20);
  if (flipY) {
    const rowBytes = width * 4;
    const rowBuf = new Uint8Array(rowBytes);
    for (let y = 0; y < (height >> 1); y++) {
      const topOff = y * rowBytes;
      const botOff = (height - 1 - y) * rowBytes;
      rowBuf.set(rgba.subarray(topOff, topOff + rowBytes));
      rgba.copyWithin(topOff, botOff, botOff + rowBytes);
      rgba.set(rowBuf, botOff);
    }
  }

  return { rgba, width, height };
}

/**
 * Converts a TGA file to a PNG data URI using the 'canvas' npm package.
 * Falls back to null if canvas is not available.
 * @param {string} tgaPath - absolute path to .tga file
 * @returns {string|null} data URI or null on failure
 */
function tgaToDataUri(tgaPath, fs) {
  try {
    const buf = fs.readFileSync(tgaPath);
    const { rgba, width, height } = decodeTGA(buf);

    // Build a minimal PNG from raw RGBA using pure JS (no canvas needed)
    return buildPngDataUri(rgba, width, height);
  } catch(e) {
    return null;
  }
}

// ── Minimal PNG encoder (pure JS, no deps) ────────────────────────
// Implements PNG with RGBA color type (6), deflate uncompressed blocks.

function buildPngDataUri(rgba, width, height) {
  const buf = encodePNG(rgba, width, height);
  const b64 = Buffer.from(buf).toString('base64');
  return `data:image/png;base64,${b64}`;
}

function encodePNG(rgba, w, h) {
  const sig = [137,80,78,71,13,10,26,10];

  // IHDR
  const ihdr = chunk('IHDR', [
    ...u32be(w), ...u32be(h),
    8,           // bit depth
    6,           // color type: RGBA
    0, 0, 0      // compression, filter, interlace
  ]);

  // IDAT — raw filtered scanlines, deflate store (uncompressed)
  const scanlines = [];
  for (let y = 0; y < h; y++) {
    scanlines.push(0); // filter type None
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      scanlines.push(rgba[i], rgba[i+1], rgba[i+2], rgba[i+3]);
    }
  }
  const raw = new Uint8Array(scanlines);
  const compressed = deflateStore(raw);
  const idat = chunk('IDAT', compressed);

  // IEND
  const iend = chunk('IEND', []);

  const totalLen = sig.length + ihdr.length + idat.length + iend.length;
  const out = new Uint8Array(totalLen);
  let off = 0;
  for (const part of [sig, ihdr, idat, iend]) {
    out.set(part, off);
    off += part.length;
  }
  return out;
}

function chunk(type, data) {
  const typeBytes = type.split('').map(c => c.charCodeAt(0));
  const len = data.length;
  const crcData = [...typeBytes, ...data];
  const crcVal  = crc32(crcData);
  return new Uint8Array([
    ...u32be(len),
    ...typeBytes,
    ...data,
    ...u32be(crcVal)
  ]);
}

function deflateStore(data) {
  // zlib header: CMF=0x78 (deflate, window 32K), FLG=0x01 (no dict, check)
  // Then one or more DEFLATE stored blocks (BFINAL, BTYPE=00, LEN, NLEN, data)
  const MAX_BLOCK = 65535;
  const blocks = [];
  let offset = 0;
  while (offset < data.length) {
    const end   = Math.min(offset + MAX_BLOCK, data.length);
    const slice = data.subarray(offset, end);
    const last  = end >= data.length ? 1 : 0;
    const len   = slice.length;
    const nlen  = (~len) & 0xffff;
    blocks.push(last, len & 0xff, (len >> 8) & 0xff, nlen & 0xff, (nlen >> 8) & 0xff, ...slice);
    offset = end;
  }
  // Adler-32 checksum
  const adler = adler32(data);
  return new Uint8Array([0x78, 0x01, ...blocks, ...u32be(adler)]);
}

function adler32(data) {
  let s1 = 1, s2 = 0;
  for (const b of data) { s1 = (s1 + b) % 65521; s2 = (s2 + s1) % 65521; }
  return (s2 << 16) | s1;
}

function crc32(data) {
  let crc = 0xffffffff;
  for (const b of data) {
    crc ^= b;
    for (let i = 0; i < 8; i++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u32be(n) {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

module.exports = { decodeTGA, tgaToDataUri };

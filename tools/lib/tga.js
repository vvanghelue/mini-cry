// TGA decoder (true colour 24 / 32 bit, raw or RLE; what 3ds Max exports) -> raw RGBA for sharp.
export function decodeTGA(buf) {
  const idLen = buf[0], cmapType = buf[1], type = buf[2];
  const w = buf.readUInt16LE(12), h = buf.readUInt16LE(14), bpp = buf[16], desc = buf[17];
  if (cmapType || (type !== 2 && type !== 10) || (bpp !== 24 && bpp !== 32)) throw new Error(`unsupported TGA (type ${type}, ${bpp} bpp)`);
  const px = bpp / 8, n = w * h;
  const raw = Buffer.alloc(n * px);
  let o = 18 + idLen + (buf.readUInt16LE(5) * buf[7]) / 8;
  if (type === 2) buf.copy(raw, 0, o, o + n * px);
  else {
    for (let i = 0; i < n;) {
      const c = buf[o++], count = (c & 0x7f) + 1;
      if (c & 0x80) { for (let k = 0; k < count; k++) buf.copy(raw, (i + k) * px, o, o + px); o += px; }
      else { buf.copy(raw, i * px, o, o + count * px); o += count * px; }
      i += count;
    }
  }
  // BGR(A) -> RGBA, rows bottom-up unless the descriptor says top-down
  const out = Buffer.alloc(n * 4), topDown = (desc & 0x20) !== 0;
  for (let y = 0; y < h; y++) {
    const sy = topDown ? y : h - 1 - y;
    for (let x = 0; x < w; x++) {
      const s = (sy * w + x) * px, d = (y * w + x) * 4;
      out[d] = raw[s + 2]; out[d + 1] = raw[s + 1]; out[d + 2] = raw[s]; out[d + 3] = px === 4 ? raw[s + 3] : 255;
    }
  }
  return { data: out, width: w, height: h };
}

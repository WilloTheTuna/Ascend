"""
upk_thumbnail_extractor.py
Extracts thumbnail PNGs directly from Rocket League _T_SF.upk files.
Works like Shift's internal extractor - zero external dependencies beyond Pillow.

Usage:
    python upk_thumbnail_extractor.py

Requirements:
    pip install Pillow
"""

import struct, os, zlib, json, sys, io, time
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    print("Run: pip install Pillow")
    sys.exit(1)

# ── Paths ─────────────────────────────────────────────────────────────────────
COOKED_PC = r"C:\Program Files\Epic Games\rocketleague\TAGame\CookedPCConsole"
APP_DATA  = os.path.join(os.path.expanduser("~"), "AppData", "Roaming", "ascend")
THUMBS_DIR = os.path.join(APP_DATA, "thumbnails_local")
NAMES_FILE = os.path.join(os.path.dirname(__file__), "..", "src", "modules", "item_names.json")
MAP_FILE   = os.path.join(APP_DATA, "thumbnails_map.json")
CATALOG_FILE = os.path.join(APP_DATA, "catalog.json")

os.makedirs(THUMBS_DIR, exist_ok=True)

# ── UPK / UE3 Parser ──────────────────────────────────────────────────────────

UE3_MAGIC = 0x9E2A83C1
BULK_FLAG_NONE      = 0
BULK_FLAG_ZLIB      = 0x02
BULK_FLAG_FORCE_INLINE = 0x10
BULK_FLAG_SERIALIZE_UNUSED = 0x20
BULK_FLAG_STORED_IN_SEPARATE_FILE = 0x40

PIXEL_FORMAT_NAMES = {
    "PF_DXT1":  "dxt1",
    "PF_DXT5":  "dxt5",
    "PF_A8R8G8B8": "bgra8",
    "PF_B8G8R8A8": "bgra8",
}


class Reader:
    def __init__(self, data: bytes):
        self.data = data
        self.pos = 0

    def seek(self, pos):
        self.pos = pos

    def read(self, n):
        b = self.data[self.pos:self.pos + n]
        self.pos += n
        return b

    def int32(self):
        return struct.unpack_from("<i", self.data, self.pos)[0]; self.pos += 4

    def uint32(self):
        v = struct.unpack_from("<I", self.data, self.pos)[0]
        self.pos += 4
        return v

    def int64(self):
        v = struct.unpack_from("<q", self.data, self.pos)[0]
        self.pos += 8
        return v

    def int16(self):
        v = struct.unpack_from("<h", self.data, self.pos)[0]
        self.pos += 2
        return v

    def uint16(self):
        v = struct.unpack_from("<H", self.data, self.pos)[0]
        self.pos += 2
        return v

    def i32(self):
        v = struct.unpack_from("<i", self.data, self.pos)[0]
        self.pos += 4
        return v

    def u32(self):
        v = struct.unpack_from("<I", self.data, self.pos)[0]
        self.pos += 4
        return v

    def fstring(self):
        length = self.i32()
        if length == 0:
            return ""
        if length > 0:
            raw = self.read(length)
            return raw.rstrip(b"\x00").decode("latin-1")
        else:
            raw = self.read(-length * 2)
            return raw.decode("utf-16-le").rstrip("\x00")

    def fname(self, names):
        idx = self.i32()
        num = self.i32()
        if 0 <= idx < len(names):
            return names[idx]
        return f"<name:{idx}>"


def decompress_upk(data: bytes) -> bytes:
    """Decompress a zlib-compressed UE3 package."""
    r = Reader(data)
    magic = r.u32()
    assert magic == UE3_MAGIC, f"Bad magic: {magic:08X}"
    r.seek(0)

    # Scan for compression blocks info in the header
    # We'll parse just enough of the header to find CompressionFlags and CompressedChunks
    r.seek(4)
    file_ver = r.uint16()
    lic_ver  = r.uint16()
    total_header = r.u32()

    # FolderName string
    folder = r.fstring()

    package_flags = r.u32()

    COMPRESS_FLAG_ZLIB = 0x04
    COMPRESS_FLAG_LZO  = 0x02
    compressed = package_flags & (COMPRESS_FLAG_ZLIB | COMPRESS_FLAG_LZO)

    if not compressed:
        return data  # Already uncompressed

    # Read NameCount/NameOffset to skip to CompressedChunks
    name_count  = r.u32()
    name_offset = r.u32()
    exp_count   = r.u32()
    exp_offset  = r.u32()
    imp_count   = r.u32()
    imp_offset  = r.u32()
    dep_offset  = r.u32()

    # Skip more header fields until we get to CompressedChunks
    # These vary by version but CompressedChunks is near the end of the summary
    # Try to find them by scanning from total_header backwards
    # Actually for RL version 868, CompressionFlags and chunks appear later
    # Let's just try to find zlib compressed blocks by scanning

    # Approach: scan for zlib streams (starts with 0x78 0x9C or 0x78 0xDA)
    # and concatenate decompressed output
    result = bytearray()
    i = 0
    while i < len(data) - 4:
        # Check for zlib header
        if data[i] in (0x78,) and data[i+1] in (0x9C, 0xDA, 0x01, 0x5E):
            # Try to read chunk size header before it (RL uses: comp_size, uncomp_size, then data)
            if i >= 8:
                comp_size   = struct.unpack_from("<I", data, i - 8)[0]
                uncomp_size = struct.unpack_from("<I", data, i - 4)[0]
                if (0 < comp_size < len(data) - i and
                    0 < uncomp_size < 16 * 1024 * 1024):
                    try:
                        chunk = zlib.decompress(data[i:i + comp_size])
                        if len(chunk) == uncomp_size:
                            result.extend(chunk)
                            i += comp_size
                            continue
                    except Exception:
                        pass
        i += 1

    return bytes(result) if result else data


def parse_upk(data: bytes):
    """Parse a UE3 package. Returns (names, exports_info, reader)."""
    r = Reader(data)
    magic = r.u32()
    if magic != UE3_MAGIC:
        return None, None, None

    file_ver = r.uint16()
    lic_ver  = r.uint16()
    total_header = r.u32()
    folder = r.fstring()
    pkg_flags = r.u32()

    name_count  = r.u32()
    name_offset = r.u32()
    exp_count   = r.u32()
    exp_offset  = r.u32()
    imp_count   = r.u32()
    imp_offset  = r.u32()

    # Read name table
    r.seek(name_offset)
    names = []
    for _ in range(name_count):
        name = r.fstring()
        flags = r.u32()
        names.append(name)

    # Read export table (each entry ~68 bytes for version 868)
    r.seek(exp_offset)
    exports = []
    for _ in range(exp_count):
        class_idx  = r.i32()
        super_idx  = r.i32()
        outer_idx  = r.i32()
        name_idx   = r.i32()
        name_num   = r.i32()
        pkg_flags2 = r.u32()
        serial_sz  = r.i32()
        serial_off = r.i32()
        obj_flags  = r.u32(); r.u32()  # 8 bytes flags
        exp_flags  = r.u32()
        # net objects (variable) - try fixed skip for now
        net_count  = r.u32()
        if net_count > 0:
            r.read(net_count * 4)
        # guid
        r.read(16)
        # more flags
        r.u32()

        exports.append({
            "class_idx": class_idx,
            "name_idx": name_idx,
            "serial_size": serial_sz,
            "serial_offset": serial_off,
            "name": names[name_idx] if 0 <= name_idx < len(names) else "",
        })

    return names, exports, r


# ── DXT Decoder (pure Python) ─────────────────────────────────────────────────

def decode_dxt1_block(block: bytes, x: int, y: int, img_data: bytearray, w: int):
    c0 = struct.unpack_from("<H", block, 0)[0]
    c1 = struct.unpack_from("<H", block, 2)[0]
    bits = struct.unpack_from("<I", block, 4)[0]

    def rgb565(c):
        r = ((c >> 11) & 0x1F) * 255 // 31
        g = ((c >> 5)  & 0x3F) * 255 // 63
        b = (c & 0x1F) * 255 // 31
        return (r, g, b, 255)

    r0, g0, b0, _ = rgb565(c0)
    r1, g1, b1, _ = rgb565(c1)

    if c0 > c1:
        colors = [
            (r0, g0, b0, 255),
            (r1, g1, b1, 255),
            ((2*r0+r1)//3, (2*g0+g1)//3, (2*b0+b1)//3, 255),
            ((r0+2*r1)//3, (g0+2*g1)//3, (b0+2*b1)//3, 255),
        ]
    else:
        colors = [
            (r0, g0, b0, 255),
            (r1, g1, b1, 255),
            ((r0+r1)//2, (g0+g1)//2, (b0+b1)//2, 255),
            (0, 0, 0, 0),
        ]

    for py in range(4):
        for px in range(4):
            idx = (bits >> (2 * (py * 4 + px))) & 3
            r, g, b, a = colors[idx]
            pos = ((y + py) * w + (x + px)) * 4
            img_data[pos:pos+4] = (r, g, b, a)


def decode_dxt5_block(block: bytes, x: int, y: int, img_data: bytearray, w: int):
    a0, a1 = block[0], block[1]
    abits = int.from_bytes(block[2:8], "little")

    if a0 > a1:
        alphas = [a0, a1] + [
            (6-i)*a0//7 + (i+1)*a1//7 for i in range(6)  # wrong, fix:
        ]
        alphas = [a0, a1,
                  (6*a0 + 1*a1)//7, (5*a0 + 2*a1)//7,
                  (4*a0 + 3*a1)//7, (3*a0 + 4*a1)//7,
                  (2*a0 + 5*a1)//7, (1*a0 + 6*a1)//7]
    else:
        alphas = [a0, a1,
                  (4*a0 + 1*a1)//5, (3*a0 + 2*a1)//5,
                  (2*a0 + 3*a1)//5, (1*a0 + 4*a1)//5,
                  0, 255]

    c0 = struct.unpack_from("<H", block, 8)[0]
    c1 = struct.unpack_from("<H", block, 10)[0]
    cbits = struct.unpack_from("<I", block, 12)[0]

    def rgb565(c):
        r = ((c >> 11) & 0x1F) * 255 // 31
        g = ((c >> 5)  & 0x3F) * 255 // 63
        b = (c & 0x1F) * 255 // 31
        return (r, g, b)

    r0, g0, b0 = rgb565(c0)
    r1, g1, b1 = rgb565(c1)
    colors = [
        (r0, g0, b0),
        (r1, g1, b1),
        ((2*r0+r1)//3, (2*g0+g1)//3, (2*b0+b1)//3),
        ((r0+2*r1)//3, (g0+2*g1)//3, (b0+2*b1)//3),
    ]

    for py in range(4):
        for px in range(4):
            pi = py * 4 + px
            ai = (abits >> (3 * pi)) & 7
            ci = (cbits >> (2 * pi)) & 3
            r, g, b = colors[ci]
            a = alphas[ai]
            pos = ((y + py) * w + (x + px)) * 4
            img_data[pos:pos+4] = (r, g, b, a)


def decode_texture(pixel_fmt: str, width: int, height: int, data: bytes):
    """Decode raw texture bytes to RGBA PIL Image."""
    fmt = pixel_fmt.lower()

    if fmt == "bgra8":
        # Raw BGRA — just swap channels
        img = Image.frombytes("RGBA", (width, height), data, "raw", "BGRA")
        return img

    if fmt in ("dxt1", "dxt5"):
        img_data = bytearray(width * height * 4)
        block_size = 8 if fmt == "dxt1" else 16
        bx, by = 0, 0
        for i in range(0, len(data), block_size):
            block = data[i:i + block_size]
            if len(block) < block_size:
                break
            if fmt == "dxt1":
                decode_dxt1_block(block, bx, by, img_data, width)
            else:
                decode_dxt5_block(block, bx, by, img_data, width)
            bx += 4
            if bx >= width:
                bx = 0
                by += 4
        img = Image.frombytes("RGBA", (width, height), bytes(img_data))
        return img

    return None


# ── Texture reader from UPK data stream ───────────────────────────────────────

def read_texture_from_stream(data: bytes, offset: int, names: list):
    """Read UTexture2D object at offset, return (pil_image, width, height) or None."""
    r = Reader(data)
    r.seek(offset)

    pixel_format = "PF_DXT5"
    width = 256
    height = 256

    # Read tagged properties until "None"
    for _ in range(200):
        prop_name_idx = r.i32()
        _prop_num = r.i32()
        if not (0 <= prop_name_idx < len(names)):
            break
        prop_name = names[prop_name_idx]
        if prop_name == "None":
            break

        type_name_idx = r.i32()
        _type_num = r.i32()
        if not (0 <= type_name_idx < len(names)):
            break
        type_name = names[type_name_idx]

        prop_size = r.i32()
        array_idx = r.i32()

        if prop_name == "Format" and type_name == "ByteProperty":
            _enum_idx = r.i32(); _enum_num = r.i32()
            val_idx = r.i32(); val_num = r.i32()
            if 0 <= val_idx < len(names):
                pixel_format = names[val_idx]
        elif prop_name == "SizeX":
            width = r.i32()
        elif prop_name == "SizeY":
            height = r.i32()
        else:
            r.read(prop_size)

    # After properties: mip maps
    # MipMaps bulk data format:
    # int32 mip_count
    # for each mip:
    #   int32 BulkDataFlags
    #   int32 ElementCount
    #   int32 BulkDataSizeOnDisk
    #   int64 BulkDataOffsetInFile (-1 if inline)
    #   bytes[BulkDataSizeOnDisk] data (if inline)
    #   int32 mip_width
    #   int32 mip_height

    try:
        mip_count = r.i32()
        if mip_count <= 0 or mip_count > 16:
            mip_count = abs(mip_count)
        if mip_count > 16:
            return None

        for mi in range(mip_count):
            bulk_flags = r.u32()
            elem_count = r.i32()
            bulk_sz_disk = r.i32()
            bulk_offset = r.int64()

            bulk_data = None
            if bulk_sz_disk > 0:
                if bulk_flags & BULK_FLAG_ZLIB:
                    compressed = r.read(bulk_sz_disk)
                    bulk_data = zlib.decompress(compressed)
                else:
                    bulk_data = r.read(bulk_sz_disk)

            mip_w = r.i32()
            mip_h = r.i32()

            # Use the largest mip (first one with valid data)
            if bulk_data and len(bulk_data) > 0 and mip_w > 0 and mip_h > 0:
                fmt = PIXEL_FORMAT_NAMES.get(pixel_format, None)
                if fmt:
                    img = decode_texture(fmt, mip_w, mip_h, bulk_data)
                    if img:
                        return img, mip_w, mip_h

    except Exception as e:
        pass

    return None


# ── Main extractor ────────────────────────────────────────────────────────────

def extract_thumbnail(upk_path: str) -> Image.Image | None:
    """Try to extract thumbnail from a _T_SF.upk file."""
    try:
        with open(upk_path, "rb") as f:
            raw = f.read()
    except Exception:
        return None

    # Check if compressed
    data = raw
    names, exports, reader = parse_upk(data)
    if names is None:
        return None

    # Find the Texture2D export
    for exp in exports:
        if exp["serial_size"] > 0 and exp["serial_offset"] > 0:
            result = read_texture_from_stream(data, exp["serial_offset"], names)
            if result:
                img, w, h = result
                # Resize to 256x256 if needed
                if w != 256 or h != 256:
                    img = img.resize((256, 256), Image.LANCZOS)
                return img

    return None


def main():
    print("=== Ascend UPK Thumbnail Extractor ===\n")

    if not os.path.exists(COOKED_PC):
        print(f"ERROR: CookedPCConsole not found at {COOKED_PC}")
        sys.exit(1)

    # Load catalog and names
    with open(CATALOG_FILE) as f:
        catalog_data = json.load(f)
    catalog = catalog_data.get("items", [])

    item_names = {}
    if os.path.exists(NAMES_FILE):
        with open(NAMES_FILE) as f:
            item_names = json.load(f)

    # Load existing thumbnails_map
    tmap = {}
    if os.path.exists(MAP_FILE):
        with open(MAP_FILE) as f:
            tmap = json.load(f)

    # Find items with missing icons
    missing = []
    for item in catalog:
        if item.get("category") == "Anthems":
            continue
        code = item["code"].lower().replace("_sf", "")
        is_t = code.endswith("_t")
        base_code = code[:-2] if is_t else code
        display = item_names.get(base_code, item.get("label", "Unknown"))
        if is_t and not display.lower().endswith(" t"):
            display = display + " T"
        key = display.lower()
        if tmap.get(key, "") == "" or key not in tmap:
            missing.append((item, display, key))

    print(f"Items with missing icons: {len(missing)}")
    print(f"Looking for UPK files in: {COOKED_PC}\n")

    extracted = 0
    failed = 0
    t0 = time.time()

    for item, display, key in missing:
        # Build UPK filename pattern
        code_sf = item["code"]  # e.g. "Body_Aftershock_T_SF"
        upk_path = os.path.join(COOKED_PC, code_sf + ".upk")

        if not os.path.exists(upk_path):
            # Try case variations
            for fname in [f for f in os.listdir(COOKED_PC) if f.lower() == code_sf.lower() + ".upk"]:
                upk_path = os.path.join(COOKED_PC, fname)
                break
            else:
                failed += 1
                tmap[key] = ""
                continue

        img = extract_thumbnail(upk_path)
        if img:
            # Save PNG locally
            out_name = f"{code_sf}.png"
            out_path = os.path.join(THUMBS_DIR, out_name)
            img.save(out_path, "PNG")
            # Store as local file:// URL
            tmap[key] = f"file://{out_path.replace(chr(92), '/')}"
            extracted += 1
        else:
            tmap[key] = ""
            failed += 1

        done = extracted + failed
        if done % 10 == 0:
            elapsed = time.time() - t0
            rate = done / elapsed if elapsed > 0 else 0
            remaining = (len(missing) - done) / rate if rate > 0 else 0
            sys.stdout.write(f"\r  {done}/{len(missing)} | ✓{extracted} extracted | ✗{failed} failed | ETA {remaining:.0f}s")
            sys.stdout.flush()

    print(f"\n\nSaved thumbnails_map.json")
    with open(MAP_FILE, "w") as f:
        json.dump(tmap, f, indent=2)

    print(f"\n=== DONE ===")
    print(f"  Extracted: {extracted}")
    print(f"  Failed:    {failed}")
    print(f"  Saved to:  {THUMBS_DIR}")


if __name__ == "__main__":
    main()

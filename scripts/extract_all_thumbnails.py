import struct, os, zlib, json, sys, time, urllib.request, re
from Crypto.Cipher import AES
from PIL import Image

# ── Paths ─────────────────────────────────────────────────────────────────────
APP_DATA = os.path.join(os.path.expanduser("~"), "AppData", "Roaming", "ascend")
SETTINGS_FILE = os.path.join(APP_DATA, "settings.json")
CATALOG_FILE = os.path.join(APP_DATA, "catalog.json")
MAP_FILE = os.path.join(APP_DATA, "thumbnails_map.json")
THUMBS_DIR = os.path.join(APP_DATA, "thumbnails")

# Load settings to get cookedDir
cooked_dir = r"C:\Program Files\Epic Games\rocketleague\TAGame\CookedPCConsole"
if os.path.exists(SETTINGS_FILE):
    try:
        with open(SETTINGS_FILE, "r", encoding="utf-8") as f:
            settings = json.load(f)
            target = settings.get("target", {})
            cooked_dir = target.get("cookedDir", cooked_dir)
    except Exception as e:
        print(f"Warning: could not read settings.json: {e}")

print(f"Using game cooked directory: {cooked_dir}")
print(f"Saving thumbnails to: {THUMBS_DIR}")
os.makedirs(THUMBS_DIR, exist_ok=True)

# ── RLG / CDN Configuration ───────────────────────────────────────────────────
CAT_MAP = {
    'Antennas': 'antennas', 'Bodies': 'bodies', 'Decals': 'decals', 'Boosts': 'boosts',
    'EngineSounds': 'engine-sounds', 'GoalExplosions': 'goal-explosions', 'Toppers': 'toppers',
    'PaintFinishes': 'paint-finishes', 'PlayerBanners': 'player-banners', 'Trails': 'trails',
    'Wheels': 'wheels', 'AvatarBorders': 'avatar-borders'
}

ESPORTS_DECAL_URLS = {
    'alpine':              'octane/alpine-esports',
    'cloud9':              'octane/cloud9',
    'complexity':          'octane/complexity',
    'dignitas':            'octane/dignitas',
    'elevate':             'fennec/elevate-2024',
    'evilgeniuses':        'octane/evil-geniuses',
    'fazeclan':            'fennec/faze-clan',
    'furia':               'octane/furia',
    'g2':                  'octane/g2-esports',
    'ghostgaming':         'octane/ghost-gaming',
    'giants':              'octane/giants',
    'groundzerogaming':    'octane/ground-zero-gaming',
    'karminecorp':         'fennec/karmine-corp',
    'mousesports':         'octane/mousesports',
    'nrg':                 'octane/nrg-esports',
    'psg':                 'octane/psg-esports',
    'pwr':                 'octane/pwr',
    'rebellion':           'octane/rebellion',
    'renegades':           'octane/renegades',
    'rogue':               'octane/rogue',
    'skgaming':            'octane/sk-gaming',
    'semperesports':       'octane/semper-esports',
    'spacestationgaming':  'octane/spacestation-gaming',
    'tsm':                 'octane/tsm',
    'teamqueso':           'octane/team-queso',
    'teamsingularity':     'octane/team-singularity',
    'torrent':             'octane/torrent',
    'trueneutral':         'octane/true-neutral',
    'version1':            'octane/version1',
    'xset':                'octane/xset',
    'renaultvitality':     'octane/team-vitality',
    'resolve':             'octane/resolve-2024',
    'splyce':              'octane/splyce',
    'endpoint':            'octane/endpoint',
    'eunited':             'octane/eunited',
    'guild':               'octane/guild-esports',
    'oxygen':              'octane/oxygen-esports',
    'pittsburghknights':   'octane/pittsburgh-knights',
    'reciprocity':         'octane/reciprocity',
    'solary':              'octane/solary',
    'susquehannasoniqs':   'octane/susquehanna-soniqs',
    'teambds':             'octane/team-bds',
    'teamenvy':            'octane/team-envy',
    'teamliquid':          'octane/team-liquid'
}

def get_slug(s):
    s = s.lower()
    replacements = {
        'à': 'a', 'á': 'a', 'â': 'a', 'ã': 'a', 'ä': 'a', 'å': 'a',
        'è': 'e', 'é': 'e', 'ê': 'e', 'ë': 'e',
        'ì': 'i', 'í': 'i', 'î': 'i', 'ï': 'i',
        'ò': 'o', 'ó': 'o', 'ô': 'o', 'õ': 'o', 'ö': 'o',
        'ù': 'u', 'ú': 'u', 'û': 'u', 'ü': 'u',
        'ç': 'c', 'ñ': 'n'
    }
    for char, repl in replacements.items():
        s = s.replace(char, repl)
    s = s.replace('.', '')
    s = re.sub(r'[^a-z0-9]+', '-', s)
    return s.strip('-')

def get_rlg_url(display_name, category):
    cat_slug = CAT_MAP.get(category)
    if not cat_slug:
        return None
    name = display_name
    if name.lower().endswith(' t'):
        name = name[:-2].strip()
        
    if category == 'Decals':
        if ':' in name:
            parts = name.split(':')
            body = parts[0].strip()
            decal = parts[1].strip()
            return f"https://rocket-league.com/items/decals/{get_slug(body)}/{get_slug(decal)}"
        label_key = get_slug(name).replace('-', '')
        if label_key in ESPORTS_DECAL_URLS:
            return f"https://rocket-league.com/items/decals/{ESPORTS_DECAL_URLS[label_key]}"
        return None
    return f"https://rocket-league.com/items/{cat_slug}/{get_slug(name)}"

def scrape_rlg(url):
    try:
        req = urllib.request.Request(
            url,
            headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}
        )
        with urllib.request.urlopen(req, timeout=10) as response:
            html = response.read().decode('utf-8')
            m = re.search(r'<meta\s+property=["\']og:image["\']\s+content=["\']([^"\']+)["\']', html, re.IGNORECASE)
            if not m:
                m = re.search(r'<meta\s+name=["\']twitter:image["\']\s+content=["\']([^"\']+)["\']', html, re.IGNORECASE)
            if m:
                img = m.group(1)
                if not img.startswith('http'):
                    img = 'https://rocket-league.com' + img
                return img
    except Exception:
        pass
    return None

# ── UPK / UE3 Parser ──────────────────────────────────────────────────────────
class UPKVirtualReader:
    def __init__(self, filepath):
        self.filepath = filepath
        with open(filepath, "rb") as f:
            self.raw_data = f.read()
            
        self.AES_KEY = bytes([
            0xC7, 0xDF, 0x6B, 0x13, 0x25, 0x2A, 0xCC, 0x71,
            0x47, 0xBB, 0x51, 0xC9, 0x8A, 0xD7, 0xE3, 0x4B,
            0x7F, 0xE5, 0x00, 0xB7, 0x7F, 0xA5, 0xFA, 0xB2,
            0x93, 0xE2, 0xF2, 0x4E, 0x6B, 0x17, 0xE7, 0x79
        ])
        
        self.parse_summary()
        self.decrypt_header()
        self.parse_names()
        self.parse_imports()
        self.parse_exports()
        
    def parse_summary(self):
        data = self.raw_data
        pos = 0
        self.magic = struct.unpack_from("<I", data, pos)[0]; pos += 4
        self.ver_lo = struct.unpack_from("<H", data, pos)[0]; pos += 2
        self.ver_hi = struct.unpack_from("<H", data, pos)[0]; pos += 2
        self.total_hdr = struct.unpack_from("<I", data, pos)[0]; pos += 4

        folder_len = struct.unpack_from("<i", data, pos)[0]; pos += 4
        if folder_len > 0:
            self.folder = data[pos:pos+folder_len].rstrip(b"\x00").decode("latin-1")
            pos += folder_len
        else:
            self.folder = ""

        self.package_flags = struct.unpack_from("<I", data, pos)[0]; pos += 4
        self.name_count = struct.unpack_from("<I", data, pos)[0]; pos += 4
        self.name_offset = struct.unpack_from("<I", data, pos)[0]; pos += 4
        self.export_count = struct.unpack_from("<I", data, pos)[0]; pos += 4
        self.export_offset = struct.unpack_from("<I", data, pos)[0]; pos += 4
        self.import_count = struct.unpack_from("<I", data, pos)[0]; pos += 4
        self.import_offset = struct.unpack_from("<I", data, pos)[0]; pos += 4
        self.depends_offset = struct.unpack_from("<I", data, pos)[0]; pos += 4

        self.import_export_guids_offset = struct.unpack_from("<I", data, pos)[0]; pos += 4
        self.import_guids_count = struct.unpack_from("<I", data, pos)[0]; pos += 4
        self.export_guids_count = struct.unpack_from("<I", data, pos)[0]; pos += 4
        self.thumbnail_table_offset = struct.unpack_from("<I", data, pos)[0]; pos += 4

        self.guid = data[pos:pos+16]; pos += 16
        self.generation_count = struct.unpack_from("<I", data, pos)[0]; pos += 4

        for _ in range(self.generation_count):
            pos += 12

        self.engine_version = struct.unpack_from("<I", data, pos)[0]; pos += 4
        self.cooker_version = struct.unpack_from("<I", data, pos)[0]; pos += 4
        self.compression_flags = struct.unpack_from("<I", data, pos)[0]; pos += 4

        chunk_count = struct.unpack_from("<I", data, pos)[0]; pos += 4
        pos += chunk_count * 24

        self.unknown5 = struct.unpack_from("<I", data, pos)[0]; pos += 4

        str_arr_count = struct.unpack_from("<I", data, pos)[0]; pos += 4
        for _ in range(str_arr_count):
            slen = struct.unpack_from("<i", data, pos)[0]; pos += 4
            if slen > 0:
                pos += slen
            elif slen < 0:
                pos += -slen * 2

        type_arr_count = struct.unpack_from("<I", data, pos)[0]; pos += 4
        for _ in range(type_arr_count):
            pos += 20
            int_count = struct.unpack_from("<I", data, pos)[0]; pos += 4
            pos += int_count * 4

        self.garbage_size = struct.unpack_from("<i", data, pos)[0]; pos += 4
        self.compressed_chunk_info_offset = struct.unpack_from("<i", data, pos)[0]; pos += 4
        self.last_block_size = struct.unpack_from("<i", data, pos)[0]; pos += 4

    def decrypt_header(self):
        encrypted_size = self.total_hdr - self.garbage_size - self.name_offset
        encrypted_size = (encrypted_size + 15) & ~15
        encrypted_data = self.raw_data[self.name_offset : self.name_offset + encrypted_size]
        if self.magic == 0x9E2A83C1 and self.raw_data[0:4] == b"\xC1\x83\x2A\x9E":
            self.decrypted_data = encrypted_data
        else:
            cipher = AES.new(self.AES_KEY, AES.MODE_ECB)
            self.decrypted_data = cipher.decrypt(encrypted_data)

    def parse_names(self):
        pos = 0
        self.names = []
        for _ in range(self.name_count):
            slen = struct.unpack_from("<i", self.decrypted_data, pos)[0]; pos += 4
            if slen > 0:
                s = self.decrypted_data[pos : pos+slen].rstrip(b"\x00").decode("latin-1")
                pos += slen
            else:
                s = self.decrypted_data[pos : pos-slen*2].decode("utf-16-le").rstrip("\x00")
                pos += -slen*2
            pos += 8
            self.names.append(s)
            
        pos = self.compressed_chunk_info_offset
        chunk_count = struct.unpack_from("<i", self.decrypted_data, pos)[0]; pos += 4
        self.chunks = []
        for _ in range(chunk_count):
            uncomp_off = struct.unpack_from("<q", self.decrypted_data, pos)[0]; pos += 8
            uncomp_size = struct.unpack_from("<i", self.decrypted_data, pos)[0]; pos += 4
            comp_off = struct.unpack_from("<q", self.decrypted_data, pos)[0]; pos += 8
            comp_size = struct.unpack_from("<i", self.decrypted_data, pos)[0]; pos += 4
            self.chunks.append({
                "uncomp_off": uncomp_off,
                "uncomp_size": uncomp_size,
                "comp_off": comp_off,
                "comp_size": comp_size,
                "decompressed_cache": None
            })

    def fname_at(self, pos):
        idx = struct.unpack_from("<i", self.decrypted_data, pos)[0]
        num = struct.unpack_from("<i", self.decrypted_data, pos+4)[0]
        return idx, num

    def parse_imports(self):
        pos = self.import_offset - self.name_offset
        self.imports = []
        for _ in range(self.import_count):
            class_package_idx, class_package_num = self.fname_at(pos); pos += 8
            class_name_idx, class_name_num = self.fname_at(pos); pos += 8
            outer_index = struct.unpack_from("<i", self.decrypted_data, pos)[0]; pos += 4
            object_name_idx, object_name_num = self.fname_at(pos); pos += 8
            
            cname = self.names[class_name_idx]
            oname = self.names[object_name_idx]
            self.imports.append((cname, oname))

    def parse_exports(self):
        pos = self.export_offset - self.name_offset
        self.exports = []
        for _ in range(self.export_count):
            class_idx = struct.unpack_from("<i", self.decrypted_data, pos)[0]; pos += 4
            super_idx = struct.unpack_from("<i", self.decrypted_data, pos)[0]; pos += 4
            pkg_idx = struct.unpack_from("<i", self.decrypted_data, pos)[0]; pos += 4
            obj_name_idx, obj_name_num = self.fname_at(pos); pos += 8
            archetype = struct.unpack_from("<i", self.decrypted_data, pos)[0]; pos += 4
            obj_flags = struct.unpack_from("<Q", self.decrypted_data, pos)[0]; pos += 8
            serial_size = struct.unpack_from("<i", self.decrypted_data, pos)[0]; pos += 4
            serial_offset = struct.unpack_from("<q", self.decrypted_data, pos)[0]; pos += 8
            export_flags = struct.unpack_from("<i", self.decrypted_data, pos)[0]; pos += 4
            
            net_count = struct.unpack_from("<i", self.decrypted_data, pos)[0]; pos += 4
            pos += net_count * 4
            pos += 16
            pos += 4
            
            oname = self.names[obj_name_idx]
            if class_idx < 0:
                cname = self.imports[-class_idx - 1][1]
            elif class_idx > 0:
                cname = "ExportClass"
            else:
                cname = "Class"
                
            self.exports.append({
                "name": oname,
                "class": cname,
                "serial_size": serial_size,
                "serial_offset": serial_offset
            })

    def get_chunk_bytes(self, chunk):
        if chunk["decompressed_cache"] is not None:
            return chunk["decompressed_cache"]
            
        comp_off = chunk["comp_off"]
        comp_size = chunk["comp_size"]
        chunk_bytes = self.raw_data[comp_off : comp_off + comp_size]
        
        pos = 0
        tag = struct.unpack_from("<I", chunk_bytes, pos)[0]; pos += 4
        block_size = struct.unpack_from("<I", chunk_bytes, pos)[0]; pos += 4
        sum_comp = struct.unpack_from("<I", chunk_bytes, pos)[0]; pos += 4
        sum_uncomp = struct.unpack_from("<I", chunk_bytes, pos)[0]; pos += 4
        
        blocks = []
        total_uncomp = 0
        while total_uncomp < sum_uncomp:
            b_comp = struct.unpack_from("<I", chunk_bytes, pos)[0]; pos += 4
            b_uncomp = struct.unpack_from("<I", chunk_bytes, pos)[0]; pos += 4
            blocks.append((b_comp, b_uncomp))
            total_uncomp += b_uncomp
            
        decompressed = bytearray()
        for b_comp, b_uncomp in blocks:
            comp_data = chunk_bytes[pos : pos + b_comp]
            pos += b_comp
            decompressed.extend(zlib.decompress(comp_data))
            
        chunk["decompressed_cache"] = bytes(decompressed)
        return chunk["decompressed_cache"]

    def read_uncompressed_bytes(self, uncomp_offset, size):
        result = bytearray()
        remaining_size = size
        curr_offset = uncomp_offset
        sorted_chunks = sorted(self.chunks, key=lambda c: c["uncomp_off"])
        for chunk in sorted_chunks:
            chunk_start = chunk["uncomp_off"]
            chunk_end = chunk_start + chunk["uncomp_size"]
            if curr_offset >= chunk_start and curr_offset < chunk_end:
                chunk_bytes = self.get_chunk_bytes(chunk)
                offset_in_chunk = curr_offset - chunk_start
                size_to_read = min(remaining_size, chunk_end - curr_offset)
                result.extend(chunk_bytes[offset_in_chunk : offset_in_chunk + size_to_read])
                curr_offset += size_to_read
                remaining_size -= size_to_read
                if remaining_size <= 0:
                    break
        return bytes(result)

def extract_thumbnail_from_upk(upk_path):
    try:
        reader = UPKVirtualReader(upk_path)
        # Find texture export
        tex_export = None
        for exp in reader.exports:
            if exp["class"] == "Texture2D" and "thumbnail" in exp["name"].lower():
                tex_export = exp
                break
        if not tex_export:
            # Fallback to any export with "thumbnail" in name
            for exp in reader.exports:
                if "thumbnail" in exp["name"].lower() and exp["serial_size"] > 5000:
                    tex_export = exp
                    break
        
        if not tex_export:
            return None
            
        obj_bytes = reader.read_uncompressed_bytes(tex_export["serial_offset"], tex_export["serial_size"])
        
        # Parse properties to find pixel format and end of properties
        pos = 4 # Skip archetype
        pixel_format = "PF_A8R8G8B8"
        while pos < len(obj_bytes):
            name_idx = struct.unpack_from("<q", obj_bytes, pos)[0]
            name = reader.names[name_idx] if 0 <= name_idx < len(reader.names) else f"<name:{name_idx}>"
            if name == "None":
                pos += 8
                break
                
            type_idx = struct.unpack_from("<q", obj_bytes, pos+8)[0]
            type_name = reader.names[type_idx] if 0 <= type_idx < len(reader.names) else f"<name:{type_idx}>"
            size = struct.unpack_from("<i", obj_bytes, pos+16)[0]
            
            val_pos = pos + 24
            if type_name == "ByteProperty":
                enum_idx = struct.unpack_from("<q", obj_bytes, val_pos)[0]
                val_name_idx = struct.unpack_from("<q", obj_bytes, val_pos + 8)[0]
                val_name = reader.names[val_name_idx] if 0 <= val_name_idx < len(reader.names) else ""
                if name == "Format":
                    pixel_format = val_name
                pos += 24 + 8 + size
            elif type_name == "BoolProperty" and size == 0:
                pos += 24 + 1
            else:
                pos += 24 + size

        # After properties, elements count is at pos + 20, size_on_disk at pos + 24, pixel data starts at pos + 28
        elem_count = struct.unpack_from("<i", obj_bytes, pos + 20)[0]
        pixel_start = pos + 28
        pixel_data = obj_bytes[pixel_start : pixel_start + elem_count]
        
        # Read SizeX and SizeY after pixel data to double check
        pos_after_pixels = pixel_start + elem_count
        size_x = struct.unpack_from("<i", obj_bytes, pos_after_pixels)[0]
        size_y = struct.unpack_from("<i", obj_bytes, pos_after_pixels+4)[0]
        
        if size_x <= 0 or size_y <= 0 or size_x > 1024 or size_y > 1024:
            return None
            
        # Swap B and R channels for BGRA -> RGBA
        rgba_data = bytearray(len(pixel_data))
        for j in range(0, len(pixel_data), 4):
            if j + 3 < len(pixel_data):
                b = pixel_data[j]
                g = pixel_data[j+1]
                r = pixel_data[j+2]
                a = pixel_data[j+3]
                rgba_data[j] = r
                rgba_data[j+1] = g
                rgba_data[j+2] = b
                rgba_data[j+3] = a
                
        img = Image.frombytes("RGBA", (size_x, size_y), bytes(rgba_data))
        return img
    except Exception as e:
        return None

# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    print("=== Complete Unified Icon Installer ===")
    
    if not os.path.exists(CATALOG_FILE):
        print(f"Error: catalog.json not found at {CATALOG_FILE}")
        sys.exit(1)
        
    with open(CATALOG_FILE, "r", encoding="utf-8") as f:
        catalog = json.load(f)
        
    items = catalog.get("items", [])
    print(f"Catalog has {len(items)} items.")
    
    # Load existing thumbnails map to skip already resolved items
    tmap = {}
    if os.path.exists(MAP_FILE):
        try:
            with open(MAP_FILE, "r", encoding="utf-8") as f:
                tmap = json.load(f)
            print(f"Loaded existing thumbnails_map.json with {len(tmap)} entries.")
        except Exception:
            print("Resetting thumbnails_map.json...")
    else:
        print("Resetting thumbnails_map.json...")
    
    # Load item_names.json to match keys exactly
    item_names = {}
    names_file = os.path.join(os.path.dirname(__file__), "..", "src", "modules", "item_names.json")
    if os.path.exists(names_file):
        with open(names_file, "r", encoding="utf-8") as f:
            item_names = json.load(f)
            
    def get_real_item_name(item):
        code = (item.get("code") or "").lower().replace("_sf", "")
        is_painted_t = False
        if code.endswith("_t"):
            code = code[:-2]
            is_painted_t = True
            
        display_name = item_names.get(code, item.get("label", "Unknown"))
        if is_painted_t and display_name and not display_name.lower().endswith(" t"):
            display_name = f"{display_name} T"
        return display_name

    upk_items = []
    for item in items:
        if item.get("category") == "Anthems":
            continue
        upk_items.append(item)
        
    CATEGORY_PRIORITY = {
        'PlayerBanners': 1,
        'EngineSounds': 2,
        'AvatarBorders': 3,
        'Antennas': 4,
        'Trails': 5,
        'Toppers': 6,
        'Boosts': 7,
        'GoalExplosions': 8,
        'Wheels': 9,
        'Decals': 10,
        'Bodies': 11
    }
    upk_items.sort(key=lambda x: CATEGORY_PRIORITY.get(x.get("category"), 0))
    
    total_items = len(upk_items)
    
    # ── Phase 1: Local UPK extraction ─────────────────────────────────────────
    print(f"\nPhase 1/4: Extracting thumbnails from local UPK packages...")
    extracted_count = 0
    skipped_count = 0
    failed_count = 0
    t0 = time.time()
    
    for idx, item in enumerate(upk_items):
        display_name = get_real_item_name(item)
        key = display_name.lower()
        
        # Check if already extracted locally
        code_sf = item.get("code")
        out_path = os.path.join(THUMBS_DIR, f"{code_sf}.png")
        if os.path.exists(out_path):
            tmap[key] = f"file:///{out_path.replace(chr(92), '/')}"
            skipped_count += 1
            continue
            
        # Look for the UPK file
        upk_name = f"{code_sf}.upk"
        upk_path = os.path.join(cooked_dir, upk_name)
        
        if not os.path.exists(upk_path):
            upk_name_lower = upk_name.lower()
            for fn in os.listdir(cooked_dir):
                if fn.lower() == upk_name_lower:
                    upk_path = os.path.join(cooked_dir, fn)
                    break
                    
        if not os.path.exists(upk_path):
            failed_count += 1
            continue
            
        img = extract_thumbnail_from_upk(upk_path)
        if img:
            img.save(out_path, "PNG")
            tmap[key] = f"file:///{out_path.replace(chr(92), '/')}"
            extracted_count += 1
        else:
            failed_count += 1
            
        if (extracted_count + failed_count) % 20 == 0:
            elapsed = time.time() - t0
            done = extracted_count + failed_count
            rate = done / elapsed if elapsed > 0 else 0
            eta = (total_items - done - skipped_count) / rate if rate > 0 else 0
            sys.stdout.write(f"\r  Progress: {done + skipped_count}/{total_items} | Extracted: {extracted_count} | Skipped: {skipped_count} | Failed: {failed_count} | ETA: {eta:.0f}s")
            sys.stdout.flush()

    print(f"\n  Done! Extracted: {extracted_count} | Skipped: {skipped_count} | Failed/Missing: {failed_count}")

    # ── Phase 2: Bidirectional inheritance ────────────────────────────────────
    print(f"\nPhase 2/4: Performing bidirectional inheritance...")
    inherited_to_t = 0
    inherited_to_base = 0
    
    # Pass 2.1: Inherit from base to T
    for item in upk_items:
        disp = get_real_item_name(item)
        key = disp.lower()
        if key.endswith(" t") and (key not in tmap or not tmap[key]):
            base_key = key[:-2].strip()
            if base_key in tmap and tmap[base_key]:
                tmap[key] = tmap[base_key]
                inherited_to_t += 1

    # Pass 2.2: Inherit from T to base
    for item in upk_items:
        disp = get_real_item_name(item)
        key = disp.lower()
        if not key.endswith(" t") and (key not in tmap or not tmap[key]):
            t_key = f"{key} t"
            if t_key in tmap and tmap[t_key]:
                tmap[key] = tmap[t_key]
                inherited_to_base += 1
                
    print(f"  Done! Inherited to T: {inherited_to_t} | Inherited to Base: {inherited_to_base}")

    # ── Phase 3: CDN Fallback ─────────────────────────────────────────────────
    print(f"\nPhase 3/4: Loading CDN fallback map...")
    cdn_map = {}
    try:
        req = urllib.request.Request(
            'https://cdn.jsdelivr.net/gh/kaiserdj/rl-garage-assets@main/output/data.json',
            headers={'User-Agent': 'Mozilla/5.0'}
        )
        with urllib.request.urlopen(req, timeout=10) as response:
            cdn_data = json.loads(response.read().decode('utf-8'))
            for e in cdn_data:
                if e.get("name") and e.get("src"):
                    cdn_map[e["name"].lower()] = e["src"]
        print(f"  Loaded {len(cdn_map)} CDN entries successfully.")
    except Exception as e:
        print(f"  Warning: failed to load CDN map: {e}")

    cdn_hits = 0
    for item in upk_items:
        disp = get_real_item_name(item)
        key = disp.lower()
        if key not in tmap or not tmap[key]:
            if key in cdn_map:
                tmap[key] = cdn_map[key]
                cdn_hits += 1
            else:
                # T-variant fallback in CDN
                if key.endswith(" t"):
                    base_key = key[:-2].strip()
                    if base_key in cdn_map:
                        tmap[key] = cdn_map[base_key]
                        cdn_hits += 1
                        
    print(f"  Done! CDN hits: {cdn_hits}")

    # ── Phase 4: RLG Scraping Fallback ────────────────────────────────────────
    rlg_queue = []
    for item in upk_items:
        disp = get_real_item_name(item)
        key = disp.lower()
        if key not in tmap or not tmap[key]:
            url = get_rlg_url(disp, item.get("category"))
            if url:
                rlg_queue.append((key, url))
                
    print(f"\nPhase 4/4: Scraping RLG fallback for {len(rlg_queue)} items concurrently...")
    scraped_hits = 0
    scraped_fails = 0
    t0 = time.time()
    
    from concurrent.futures import ThreadPoolExecutor, as_completed
    
    def worker(entry):
        key, url = entry
        img_url = scrape_rlg(url)
        return key, img_url
        
    with ThreadPoolExecutor(max_workers=30) as executor:
        futures = {executor.submit(worker, item): item for item in rlg_queue}
        for idx, future in enumerate(as_completed(futures)):
            key, img_url = future.result()
            if img_url:
                tmap[key] = img_url
                scraped_hits += 1
            else:
                tmap[key] = ""
                scraped_fails += 1
                
            if (idx + 1) % 20 == 0 or (idx + 1) == len(rlg_queue):
                elapsed = time.time() - t0
                done = idx + 1
                rate = done / elapsed if elapsed > 0 else 0
                eta = (len(rlg_queue) - done) / rate if rate > 0 else 0
                sys.stdout.write(f"\r  Scraping: {done}/{len(rlg_queue)} | Scraped: {scraped_hits} | Failed: {scraped_fails} | ETA: {eta:.0f}s")
                sys.stdout.flush()

    # Save mapping
    with open(MAP_FILE, "w", encoding="utf-8") as f:
        json.dump(tmap, f, indent=2)
        
    print(f"\n\n=== Final Installation Summary ===")
    total_resolved = len([v for v in tmap.values() if v])
    total_unresolved = len([v for v in tmap.values() if not v])
    print(f"  Total items processed: {total_items}")
    print(f"  [+] With icon:           {total_resolved}")
    print(f"  [-] No icon:             {total_unresolved}")
    print(f"  Map saved to:          {MAP_FILE}")

if __name__ == "__main__":
    main()

import sys
import os
import re
from pathlib import Path
from typing import Dict, List

# Add script directory to sys.path so we can import rl_upk_editor
script_dir = Path(__file__).resolve().parent
sys.path.append(str(script_dir))

import rl_upk_editor

# Class patterns used by Shift Swapper (restricted to ProductAsset to avoid internal attribute mismatch crashes)
class_patterns = [
    re.compile(r"^ProductAsset(?:Reference)?\w*_TA$", re.IGNORECASE),
    re.compile(r"^ProductThumbnailAsset_TA$", re.IGNORECASE),
    re.compile(r"^Product_TA$", re.IGNORECASE)
]

include_textures = False

def is_product_class(class_name: str) -> bool:
    if include_textures and class_name.lower() == "texture2d":
        return True
    return any(pat.match(class_name) for pat in class_patterns)


def get_product_exports(file_path: Path, provider) -> Dict[str, List[str]]:
    temp_unpacked = file_path.with_name(file_path.name + ".temp_extract_exports")
    try:
        rl_upk_editor.unpack_package(str(file_path), str(temp_unpacked), provider)
        pkg = rl_upk_editor.parse_decrypted_package(temp_unpacked)
        
        exports_by_class = {}
        for exp in pkg.exports:
            class_name = pkg.export_class_name(exp)
            if is_product_class(class_name):
                obj_name = pkg.resolve_name(exp.object_name)
                exports_by_class.setdefault(class_name, []).append(obj_name)
        return exports_by_class
    except Exception as err:
        print(f"Warning: Failed to extract product exports from {file_path.name}: {err}")
        return {}
    finally:
        if temp_unpacked.exists():
            temp_unpacked.unlink()

def main():
    global include_textures
    if len(sys.argv) < 4:
        print("Usage: swap_package_names.py <targetPath> <srcBase> <tgtBase> [backupPath] [sourcePath]")
        sys.exit(1)
        
    target_path = Path(sys.argv[1])
    target_name_lower = target_path.name.lower()
    if "_t_sf" in target_name_lower or "_t.upk" in target_name_lower:
        include_textures = True
        print("Texture companion file detected. Enabling Texture2D swap mapping.")
        
    src_base = sys.argv[2]

    tgt_base = sys.argv[3]
    
    keys_path = script_dir / "keys.txt"
    if not keys_path.exists():
        print(f"Error: keys.txt not found at {keys_path}")
        sys.exit(1)
        
    print(f"Decrypting and unpacking {target_path}...")
    provider = rl_upk_editor.DecryptionProvider(key_file_path=str(keys_path))
    
    # Unpack to a temp file
    temp_unpacked = target_path.with_name(target_path.name + ".temp_unpacked")
    try:
        rl_upk_editor.unpack_package(str(target_path), str(temp_unpacked), provider)
        pkg = rl_upk_editor.parse_decrypted_package(temp_unpacked)
    except Exception as e:
        print(f"Error unpacking package: {e}")
        if temp_unpacked.exists():
            temp_unpacked.unlink()
        sys.exit(1)
        
    # Build rename mappings
    rename_map = {
        src_base.lower(): tgt_base
    }
    
    # Also map texture companion if applicable
    if src_base.lower().endswith("_sf") and tgt_base.lower().endswith("_sf"):
        src_tex = src_base[:-3] + "_T_SF"
        tgt_tex = tgt_base[:-3] + "_T_SF"
        rename_map[src_tex.lower()] = tgt_tex

    # Special mapping for legacy boosts (Standard, Flamethrower, etc.) that have color suffixes in their internal MIC, ParticleSystem, and LensFlare names
    src_match = re.match(r"^Boost_(Standard|Flamethrower)(?:_([a-zA-Z]+))?_SF$", src_base, re.IGNORECASE)
    tgt_match = re.match(r"^Boost_(Standard|Flamethrower)(?:_([a-zA-Z]+))?_SF$", tgt_base, re.IGNORECASE)
    
    if src_match and tgt_match:
        boost_type = src_match.group(1)
        src_color = src_match.group(2) or ""
        tgt_color = tgt_match.group(2) or ""
        
        src_color_cap = src_color.capitalize()
        tgt_color_cap = tgt_color.capitalize() if tgt_color else ""
        
        if boost_type.lower() == "standard":
            # Map MIC: MasterBoost_Standard{Color}_MIC
            src_mic = f"MasterBoost_Standard{src_color_cap}_MIC" if src_color_cap else "MasterBoost_Standard_MIC"
            tgt_mic = f"MasterBoost_Standard{tgt_color_cap}_MIC" if tgt_color_cap else "MasterBoost_Standard_MIC"
            if src_mic.lower() != tgt_mic.lower():
                rename_map[src_mic.lower()] = tgt_mic
                
            # Map ParticleSystem: Boost_PS or Boost_Painted_PS
            src_ps = "Boost_PS" if src_color_cap else "Boost_Painted_PS"
            tgt_ps = "Boost_PS" if tgt_color_cap else "Boost_Painted_PS"
            if src_ps.lower() != tgt_ps.lower():
                rename_map[src_ps.lower()] = tgt_ps
                
            # Map LensFlare: BoostFlare_LF or BoostFlare_Painted_LF
            src_lf = "BoostFlare_LF" if src_color_cap else "BoostFlare_Painted_LF"
            tgt_lf = "BoostFlare_LF" if tgt_color_cap else "BoostFlare_Painted_LF"
            if src_lf.lower() != tgt_lf.lower():
                rename_map[src_lf.lower()] = tgt_lf
                
        elif boost_type.lower() == "flamethrower":
            # Map MIC: Flamethrower{Color}_MIC
            src_mic = f"Flamethrower{src_color_cap}_MIC" if src_color_cap else "Flamethrower_MIC"
            tgt_mic = f"Flamethrower{tgt_color_cap}_MIC" if tgt_color_cap else "Flamethrower_MIC"
            if src_mic.lower() != tgt_mic.lower():
                rename_map[src_mic.lower()] = tgt_mic
                
            # Map Drive_PS: Drive_PS or Drive_Painted_PS
            src_drive = "Drive_PS" if src_color_cap else "Drive_Painted_PS"
            tgt_drive = "Drive_PS" if tgt_color_cap else "Drive_Painted_PS"
            if src_drive.lower() != tgt_drive.lower():
                rename_map[src_drive.lower()] = tgt_drive
                
            # Map Boost_PS: Boost_PS or Boost_Painted_PS
            src_ps = "Boost_PS" if src_color_cap else "Boost_Painted_PS"
            tgt_ps = "Boost_PS" if tgt_color_cap else "Boost_Painted_PS"
            if src_ps.lower() != tgt_ps.lower():
                rename_map[src_ps.lower()] = tgt_ps
                
            # Map LensFlare: BoostFlare_LF or BoostFlare_Painted_LF
            src_lf = "BoostFlare_LF" if src_color_cap else "BoostFlare_Painted_LF"
            tgt_lf = "BoostFlare_LF" if tgt_color_cap else "BoostFlare_Painted_LF"
            if src_lf.lower() != tgt_lf.lower():
                rename_map[src_lf.lower()] = tgt_lf

    # Special mapping for legacy Goal Explosions that have custom suffixes/prefixes in their internal names
    explosion_match_src = re.match(r"^explosion_([a-zA-Z0-9]+)_SF$", src_base, re.IGNORECASE)
    tgt_default_match = re.match(r"^Explosion_Default_SF$", tgt_base, re.IGNORECASE)
    
    if explosion_match_src and tgt_default_match:
        src_name = explosion_match_src.group(1)
        src_name_cap = src_name.capitalize()
        
        # Map FXActor: FXActor_Explosion_{Color} -> Explosion_Default_FXActor
        src_fx = f"FXActor_Explosion_{src_name_cap}"
        rename_map[src_fx.lower()] = "Explosion_Default_FXActor"
        
        # Map ParticleSystems: {Color}_PS and PS_{Color} -> Explosion_Default_PS
        src_ps1 = f"{src_name_cap}_PS"
        src_ps2 = f"PS_{src_name_cap}"
        rename_map[src_ps1.lower()] = "Explosion_Default_PS"
        rename_map[src_ps2.lower()] = "Explosion_Default_PS"
        
        # Map Sound: SFX_GoalExplosion_{Color} -> SFX_GoalExplosion_Default
        src_sfx = f"SFX_GoalExplosion_{src_name_cap}"
        rename_map[src_sfx.lower()] = "SFX_GoalExplosion_Default"

    # Scan source and target backups to extract ProductAsset exports dynamically
    src_exports = {}
    if len(sys.argv) >= 6 and sys.argv[5]:
        source_path = Path(sys.argv[5])
        if source_path.exists():
            print(f"Scanning source product assets from {source_path}...")
            src_exports = get_product_exports(source_path, provider)
            
    tgt_exports = {}
    if len(sys.argv) >= 5 and sys.argv[4]:
        backup_path = Path(sys.argv[4])
        if backup_path.exists():
            print(f"Scanning target product assets from {backup_path}...")
            tgt_exports = get_product_exports(backup_path, provider)

    # Merge dynamic exports mapping into rename_map
    for class_name, src_objs in src_exports.items():
        if class_name in tgt_exports:
            tgt_objs = tgt_exports[class_name]
            for i in range(min(len(src_objs), len(tgt_objs))):
                s_name = src_objs[i]
                t_name = tgt_objs[i]
                if s_name.lower() != t_name.lower():
                    print(f"Mapping dynamic ProductAsset export: '{s_name}' -> '{t_name}' (class: {class_name})")
                    rename_map[s_name.lower()] = t_name

        
    modified = False
    
    # We must loop and rename one by one. Since rename_name_entry returns a fresh package
    # and re-indexes, we find the entry index on each pass.
    for src_name_lower, new_name in rename_map.items():
        found_idx = -1
        for idx, entry in enumerate(pkg.names):
            if entry.name.lower() == src_name_lower:
                # Do not rename if it already matches the target
                if entry.name == new_name:
                    continue
                found_idx = idx
                break
                
        if found_idx != -1:
            print(f"Renaming Name Table entry '{pkg.names[found_idx].name}' -> '{new_name}'")
            try:
                pkg = rl_upk_editor.rename_name_entry(pkg, found_idx, new_name)
                modified = True
            except Exception as rename_err:
                print(f"Warning: Failed to rename entry: {rename_err}")
                
    # Extract target key if backup path is provided (arg 5)
    target_key = None
    if len(sys.argv) >= 5 and sys.argv[4]:
        backup_path = Path(sys.argv[4])
        if backup_path.exists():
            try:
                _, _, _, target_key = rl_upk_editor.find_valid_key(backup_path, provider)
                print(f"Loaded target encryption key from backup: {target_key.hex()[:8]}...")
            except Exception as key_err:
                print(f"Warning: Could not extract target key from backup: {key_err}")

    # Use source path as original_encrypted_path if provided (arg 6)
    # This allows build_reencrypted_package to read the correct chunk structure
    # from the original source file instead of the already-overwritten target.
    original_for_rebuild = target_path
    if len(sys.argv) >= 6 and sys.argv[5]:
        source_candidate = Path(sys.argv[5])
        if source_candidate.exists():
            original_for_rebuild = source_candidate
            print(f"Using source file for rebuild structure: {original_for_rebuild}")

    if temp_unpacked.exists():
        temp_unpacked.unlink()
        
    if not modified:
        print("No name entries required renaming.")
        sys.exit(0)
        
    print("Rebuilding encrypted package with new package references...")
    try:
        data = bytearray(pkg.file_bytes)
        rl_upk_editor.build_reencrypted_package(original_for_rebuild, data, provider, target_path, override_key=target_key)
        print("Package names updated successfully!")
    except Exception as e:
        print(f"Error rebuilding package: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()

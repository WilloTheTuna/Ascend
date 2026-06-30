import sys
import os
import struct
from pathlib import Path

# Add script directory to sys.path so we can import rl_upk_editor
script_dir = Path(__file__).resolve().parent
sys.path.append(str(script_dir))

import rl_upk_editor

# Custom colors for Standard Boost (requires high glow/intensity)
COLORS_BOOST = {
    "titanium_white": {
        "dist": (3.0, 3.0, 3.0),
        "mic_inner": (0.9, 0.9, 1.0, 3.0),
        "mic_outer": (1.0, 1.0, 1.0, 6.0)
    },
    "grey": {
        "dist": (1.2, 1.2, 1.2),
        "mic_inner": (0.3, 0.3, 0.32, 2.0),
        "mic_outer": (0.4, 0.4, 0.4, 4.0)
    },
    "crimson": {
        "dist": (3.0, 0.15, 0.15),
        "mic_inner": (1.0, 0.05, 0.05, 3.0),
        "mic_outer": (1.0, 0.0, 0.0, 6.0)
    },
    "pink": {
        "dist": (3.0, 0.9, 2.1),
        "mic_inner": (1.0, 0.2, 0.6, 3.0),
        "mic_outer": (1.0, 0.3, 0.7, 6.0)
    },
    "cobalt": {
        "dist": (0.15, 0.3, 3.0),
        "mic_inner": (0.05, 0.1, 1.0, 3.0),
        "mic_outer": (0.0, 0.05, 1.0, 6.0)
    },
    "sky_blue": {
        "dist": (0.9, 2.1, 3.0),
        "mic_inner": (0.2, 0.6, 1.0, 3.0),
        "mic_outer": (0.3, 0.7, 1.0, 6.0)
    },
    "burnt_sienna": {
        "dist": (1.5, 0.6, 0.15),
        "mic_inner": (0.4, 0.15, 0.05, 2.0),
        "mic_outer": (0.5, 0.2, 0.05, 4.0)
    },
    "saffron": {
        "dist": (2.7, 3.0, 0.3),
        "mic_inner": (0.9, 1.0, 0.1, 3.0),
        "mic_outer": (1.0, 1.0, 0.1, 6.0)
    },
    "lime": {
        "dist": (0.9, 3.0, 0.3),
        "mic_inner": (0.3, 1.0, 0.1, 3.0),
        "mic_outer": (0.4, 1.0, 0.1, 6.0)
    },
    "forest_green": {
        "dist": (0.3, 2.7, 0.3),
        "mic_inner": (0.1, 0.8, 0.1, 3.0),
        "mic_outer": (0.1, 0.9, 0.1, 6.0)
    },
    "orange": {
        "dist": (3.0, 1.5, 0.15),
        "mic_inner": (1.0, 0.4, 0.05, 3.0),
        "mic_outer": (1.0, 0.5, 0.0, 6.0)
    },
    "purple": {
        "dist": (1.35, 0.42, 3.0),
        "mic_inner": (0.414, 0.166, 1.0, 3.0),
        "mic_outer": (0.451, 0.136, 1.0, 6.0)
    },
    "gold": {
        "dist": (3.0, 2.25, 0.6),
        "mic_inner": (1.0, 0.7, 0.15, 3.0),
        "mic_outer": (1.0, 0.75, 0.2, 6.0)
    },
    "black": {
        "dist": (0.01, 0.01, 0.01),
        "mic_inner": (0.01, 0.01, 0.01, 1.0),
        "mic_outer": (0.01, 0.01, 0.01, 1.0)
    }
}

# General paint colors for bodies, wheels, and decals (RGBA floats)
COLORS_GENERAL = {
    "titanium_white": (1.0, 1.0, 1.0, 1.0),
    "grey": (0.3, 0.3, 0.3, 1.0),
    "crimson": (1.0, 0.0, 0.0, 1.0),
    "pink": (1.0, 0.4, 0.7, 1.0),
    "cobalt": (0.0, 0.1, 1.0, 1.0),
    "sky_blue": (0.2, 0.7, 1.0, 1.0),
    "burnt_sienna": (0.4, 0.15, 0.05, 1.0),
    "saffron": (1.0, 1.0, 0.0, 1.0),
    "lime": (0.4, 1.0, 0.0, 1.0),
    "forest_green": (0.0, 0.6, 0.0, 1.0),
    "orange": (1.0, 0.3, 0.0, 1.0),
    "purple": (0.4, 0.0, 1.0, 1.0),
    "gold": (1.0, 0.75, 0.15, 1.0),
    "black": (0.0, 0.0, 0.0, 1.0)
}

def main():
    if len(sys.argv) < 3:
        print("Usage: paint_item.py <targetPath> <paintColor> [backupPath]")
        sys.exit(1)
        
    target_path = Path(sys.argv[1])
    color_key = sys.argv[2].lower()
    backup_path = Path(sys.argv[3]) if len(sys.argv) >= 4 else None
    
    if color_key == "none":
        print("Paint is 'none', skipping.")
        sys.exit(0)

    is_boost = "boost_standard" in target_path.name.lower()
    available_colors = COLORS_BOOST if is_boost else COLORS_GENERAL

    if color_key not in available_colors:
        print(f"Error: Unknown color '{color_key}'")
        sys.exit(1)
        
    color_data = available_colors[color_key]
    
    keys_path = script_dir / "keys.txt"
    if not keys_path.exists():
        print(f"Error: keys.txt not found at {keys_path}")
        sys.exit(1)
        
    print(f"Decrypting and unpacking {target_path}...")
    provider = rl_upk_editor.DecryptionProvider(key_file_path=str(keys_path))
    
    # Extract target key if backup path is provided
    target_key = None
    if backup_path and backup_path.exists():
        try:
            _, _, _, target_key = rl_upk_editor.find_valid_key(backup_path, provider)
            if target_key:
                print(f"Loaded target encryption key from backup: {target_key.hex()[:8]}...")
        except Exception as key_err:
            print(f"Warning: Could not extract target key from backup: {key_err}")
    
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
        
    # Find the name index for "None"
    none_idx = -1
    for idx, entry in enumerate(pkg.names):
        if entry.name == "None":
            none_idx = idx
            break
            
    if none_idx == -1:
        print("Error: 'None' not found in name table")
        if temp_unpacked.exists():
            temp_unpacked.unlink()
        sys.exit(1)
        
    data = bytearray(pkg.file_bytes)
    
    def write_fname(offset, name_idx, inst=0):
        struct.pack_into("<ii", data, offset, name_idx, inst)
        
    def write_vector(offset, x, y, z):
        struct.pack_into("<fff", data, offset, x, y, z)
        
    def write_linear_color(offset, r, g, b, a):
        struct.pack_into("<ffff", data, offset, r, g, b, a)
        
    modified = False

    if is_boost:
        # Standard Boost painting logic
        target_dist_color = color_data["dist"]
        target_mic_inner = color_data["mic_inner"]
        target_mic_outer = color_data["mic_outer"]
        
        for exp in pkg.exports:
            class_name = pkg.export_class_name(exp)
            obj_name = pkg.resolve_name(exp.object_name)
            serial_offset = exp.serial_offset
            
            if class_name == "DistributionVectorParticleParameter":
                props = rl_upk_editor.parse_serialized_properties(pkg, exp, None)
                for prop in props:
                    global_val_offset = serial_offset + prop.value_offset
                    if prop.name == "ParameterName" and prop.value in ("Color", "CustomColor", "InnerColor"):
                        write_fname(global_val_offset, none_idx)
                        modified = True
                    elif prop.name in ("Constant", "MaxOutput", "MinOutput"):
                        write_vector(global_val_offset + 8, *target_dist_color)
                        modified = True
                        
            elif class_name == "MaterialInstanceConstant" and "Standard" in obj_name:
                props = rl_upk_editor.parse_serialized_properties(pkg, exp, None)
                for prop in props:
                    global_val_offset = serial_offset + prop.value_offset
                    if prop.name == "VectorParameterValues":
                        val_bytes = data[global_val_offset : global_val_offset + prop.size]
                        r = rl_upk_editor.BinaryReader(rl_upk_editor.io.BytesIO(val_bytes))
                        try:
                            count = r.read_i32()
                            for elem_idx in range(count):
                                elem_start = r.tell()
                                while True:
                                    prop_name_idx = r.read_i32()
                                    r.read_i32() # instance
                                    prop_name = pkg.names[prop_name_idx].name
                                    if prop_name == "None":
                                        break
                                    prop_type_idx = r.read_i32()
                                    r.read_i32() # instance
                                    prop_type = pkg.names[prop_type_idx].name
                                    prop_size = r.read_i32()
                                    r.read_i32() # array_idx
                                    prop_val_offset = global_val_offset + r.tell()
                                    
                                    if prop_type == "StructProperty":
                                        r.read_i32() # struct type idx
                                        r.read_i32() # struct type inst
                                        floats_offset = global_val_offset + r.tell()
                                        r.read_exact(prop_size)
                                        
                                        if prop_name == "ParameterValue":
                                            if elem_idx == 0:
                                                write_linear_color(floats_offset, *target_mic_inner)
                                            else:
                                                write_linear_color(floats_offset, *target_mic_outer)
                                            modified = True
                                    elif prop_name == "ParameterName":
                                        val_idx = r.read_i32()
                                        r.read_i32()
                                        val_name = pkg.names[val_idx].name
                                        if val_name in ("Inner_Color", "Outer_Color"):
                                            write_fname(prop_val_offset, none_idx)
                                            modified = True
                                    else:
                                        r.read_exact(prop_size)
                        except Exception as e:
                            print(f"Error parsing MIC: {e}")
    else:
        # General item painting logic (bodies, wheels, decals)
        target_color = color_data
        
        for exp in pkg.exports:
            class_name = pkg.export_class_name(exp)
            obj_name = pkg.resolve_name(exp.object_name)
            serial_offset = exp.serial_offset
            
            if class_name == "MaterialInstanceConstant":
                props = rl_upk_editor.parse_serialized_properties(pkg, exp, None)
                for prop in props:
                    global_val_offset = serial_offset + prop.value_offset
                    if prop.name == "VectorParameterValues":
                        val_bytes = data[global_val_offset : global_val_offset + prop.size]
                        r = rl_upk_editor.BinaryReader(rl_upk_editor.io.BytesIO(val_bytes))
                        try:
                            count = r.read_i32()
                            for elem_idx in range(count):
                                param_is_paint = False
                                value_floats_offset = None
                                
                                while True:
                                    prop_name_idx = r.read_i32()
                                    r.read_i32()
                                    prop_name = pkg.names[prop_name_idx].name
                                    if prop_name == "None":
                                        break
                                    prop_type_idx = r.read_i32()
                                    r.read_i32()
                                    prop_type = pkg.names[prop_type_idx].name
                                    prop_size = r.read_i32()
                                    r.read_i32()
                                    prop_val_offset = global_val_offset + r.tell()
                                    
                                    if prop_type == "StructProperty":
                                        r.read_i32()
                                        r.read_i32()
                                        floats_offset = global_val_offset + r.tell()
                                        r.read_exact(prop_size)
                                        
                                        if prop_name == "ParameterValue":
                                            value_floats_offset = floats_offset
                                    elif prop_name == "ParameterName":
                                        val_idx = r.read_i32()
                                        r.read_i32()
                                        val_name = pkg.names[val_idx].name
                                        if val_name.lower() in ("paint_color", "paintcolor", "paint_color_primary"):
                                            param_is_paint = True
                                    else:
                                        r.read_exact(prop_size)
                                        
                                if param_is_paint and value_floats_offset is not None:
                                    print(f"Patching Paint_Color in MIC {obj_name} to {target_color}")
                                    write_linear_color(value_floats_offset, *target_color)
                                    modified = True
                        except Exception as e:
                            print(f"Error parsing MIC properties: {e}")

    if temp_unpacked.exists():
        temp_unpacked.unlink()
        
    if not modified:
        print("No paintable properties found in the package.")
        sys.exit(0)
        
    print("Rebuilding encrypted package...")
    try:
        rl_upk_editor.build_reencrypted_package(target_path, data, provider, target_path, override_key=target_key)
        print("Package painted successfully!")
    except Exception as e:
        print(f"Error rebuilding package: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()

"""
reencrypt_swap.py - Swap UPK the Shift way: direct file copy.
The game tries all known keys on any UPK file, so no re-encryption needed.

Usage: python reencrypt_swap.py <source_path> <target_path> <backup_path>
"""
import sys
import shutil
from pathlib import Path

def main():
    if len(sys.argv) < 3:
        print("Usage: reencrypt_swap.py <source_path> <target_path> <backup_path>")
        sys.exit(1)

    source_path = Path(sys.argv[1])
    target_path = Path(sys.argv[2])
    # backup_path = sys.argv[3]  # kept for API compatibility, not used

    if not source_path.exists():
        print(f"Error: source not found: {source_path}")
        sys.exit(1)

    print(f"Copying {source_path.name} -> {target_path.name}")
    try:
        shutil.copy2(str(source_path), str(target_path))
        print("Swap applied successfully!")
    except Exception as e:
        print(f"Error: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Extract optional artwork from a locally installed Minecraft client; never download it."""
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import sys
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('client_jar', type=Path, help='Path to your installed Minecraft Java client JAR')
    args = parser.parse_args()
    if not (ROOT / 'data/editor-blocks.json').exists():
        from prepare_registry import prepare
        prepare()
    jar = args.client_jar.resolve(strict=True)
    with ZipFile(jar) as archive:
        for name in archive.namelist():
            prefix = 'assets/minecraft/textures/'
            if name.startswith(prefix) and name.endswith('.png'):
                relative = Path(name[len(prefix):])
                if relative.parts[0] not in ('block', 'item') or '..' in relative.parts:
                    continue
                target = ROOT / 'static/textures' / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(archive.read(name))
        language = 'assets/minecraft/lang/ru_ru.json'
        if language in archive.namelist():
            (ROOT / 'data/ru_ru_blocks.json').write_bytes(archive.read(language))
    subprocess.run([sys.executable, str(ROOT / 'frontend/build-minecraft-assets.py'), str(jar)], check=True)
    # The model atlas is sufficient for geometry and 3D previews. Icon generation is a separate browser step.
    print('Local Minecraft assets prepared. Run the frontend icon generator for the block catalogue.')


if __name__ == '__main__':
    main()

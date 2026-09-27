import sys
from pathlib import Path
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED

source, destination = map(Path, sys.argv[1:])
with ZipFile(destination, "w", compression=ZIP_DEFLATED) as archive:
    for file in sorted(source.rglob("*")):
        if file.is_file():
            entry = ZipInfo(file.relative_to(source).as_posix(), date_time=(2026, 1, 1, 0, 0, 0))
            entry.compress_type = ZIP_DEFLATED
            entry.external_attr = 0o644 << 16
            archive.writestr(entry, file.read_bytes())
print(f"XPI criado: {destination}")

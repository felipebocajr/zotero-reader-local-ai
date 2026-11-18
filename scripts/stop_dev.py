#!/usr/bin/env python3
"""Stop only Zotero processes explicitly using this project's development profile."""
import os
from pathlib import Path
import signal

profile = (Path(__file__).resolve().parents[1] / ".runtime/zotero-profile").resolve()
for proc in Path("/proc").glob("[0-9]*"):
    try:
        args = (proc / "cmdline").read_bytes().decode().split("\0")
        if "-profile" not in args:
            continue
        selected = Path(args[args.index("-profile") + 1]).expanduser()
        if selected.resolve() == profile and "zotero" in Path(args[0]).name.lower():
            os.kill(int(proc.name), signal.SIGTERM)
            print(f"Encerrando somente o Zotero de desenvolvimento (PID {proc.name}).")
    except (OSError, IndexError):
        pass

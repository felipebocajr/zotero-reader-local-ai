#!/usr/bin/env python3
"""Stop only Zotero processes explicitly using this project's development profile."""
import os
from pathlib import Path
import signal

profile = str(Path(__file__).resolve().parents[1] / ".runtime/zotero-profile")
for proc in Path("/proc").glob("[0-9]*"):
    try:
        args = (proc / "cmdline").read_bytes().decode().split("\0")
        if "-profile" in args and args[args.index("-profile") + 1] == profile and "zotero" in args[0].lower():
            os.kill(int(proc.name), signal.SIGTERM)
            print(f"Encerrando somente o Zotero de desenvolvimento (PID {proc.name}).")
    except (OSError, IndexError):
        pass

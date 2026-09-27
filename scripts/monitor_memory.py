#!/usr/bin/env python3
"""Record kernel RSS high-water marks for this project's benchmark servers."""
import json
from pathlib import Path
import re
import time

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "experiments/results/memory-highwater.json"
LOCK = json.loads((ROOT / "runtime.lock.json").read_text())
variants = {v["filename"]: k for k, v in LOCK["model"]["variants"].items()}
records = {}


def processes():
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit(): continue
        try:
            args = (entry / "cmdline").read_bytes().decode().split("\0")[:-1]
            yield entry, args
        except (OSError, UnicodeError): pass


def main():
    benchmark_seen = False
    while True:
        benchmark_active = False
        for entry, args in processes():
            if not args: continue
            try:
                if Path(args[0]).name == "node" and "scripts/experiment.ts" in args and (entry / "cwd").resolve() == ROOT:
                    benchmark_active = True
                if Path(args[0]).name != "llama-server" or "--model" not in args: continue
                model = Path(args[args.index("--model") + 1])
                if model.parent != ROOT / ".runtime/models" or model.name not in variants: continue
                if "--port" not in args or args[args.index("--port") + 1] != "18084": continue
                status = (entry / "status").read_text()
                highwater = float(re.search(r"VmHWM:\s+(\d+)", status)[1]) / 1024
                precision = variants[model.name]
                old = records.get(precision, {})
                records[precision] = {"precision": precision, "pid": int(entry.name), "ramHighwaterMiB": max(highwater, old.get("ramHighwaterMiB", 0)), "includesStartup": True}
            except (OSError, ValueError, TypeError): pass
        benchmark_seen |= benchmark_active
        OUT.write_text(json.dumps({"source": "Linux /proc VmHWM, process lifetime", "records":list(records.values())}, indent=2)+"\n")
        if benchmark_seen and not benchmark_active: break
        time.sleep(.5)
    print("Kernel memory high-water marks saved.")


if __name__ == "__main__": main()

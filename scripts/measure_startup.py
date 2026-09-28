#!/usr/bin/env python3
"""Measure model-loading memory separately from the request-time experiment."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--backend", choices=["cpu", "cuda"], default="cuda")
    parser.add_argument("--gpu-layers", type=int, default=24)
    parser.add_argument("--precisions", default="F16,Q8_0,Q4_K_M")
    parser.add_argument("--output", type=Path, default=ROOT / "experiments/results/load-memory.json")
    args = parser.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    rows = []
    for precision in args.precisions.split(","):
        log_path = ROOT / f".runtime/startup-{precision}.log"
        with log_path.open("w") as log:
            child = subprocess.Popen(["python3", str(ROOT / "scripts/serve.py"), "--precision", precision,
                "--backend", args.backend, "--context", "32768", "--gpu-layers", str(args.gpu_layers if args.backend == "cuda" else 0), "--port", "18086"],
                cwd=ROOT, stdout=log, stderr=log)
            highwater = 0
            vram_peak = None
            started = time.monotonic()
            ready = False
            try:
                while child.poll() is None and time.monotonic()-started < 120:
                    try:
                        status = Path(f"/proc/{child.pid}/status").read_text()
                        match = re.search(r"VmHWM:\s+(\d+)", status)
                        if match: highwater = max(highwater, int(match[1])/1024)
                    except OSError: pass
                    if args.backend == "cuda":
                        try:
                            report = subprocess.check_output(["nvidia-smi", "--query-compute-apps=pid,used_gpu_memory", "--format=csv,noheader,nounits"],text=True,timeout=3)
                            for line in report.splitlines():
                                pid, memory = line.split(",")
                                if int(pid.strip()) == child.pid: vram_peak=max(vram_peak or 0,float(memory.strip()))
                        except (OSError,ValueError,subprocess.SubprocessError): pass
                    try:
                        with urllib.request.urlopen("http://127.0.0.1:18086/health",timeout=.3) as response: ready=response.status == 200
                    except OSError: pass
                    if ready:
                        time.sleep(.1)
                        status = Path(f"/proc/{child.pid}/status").read_text()
                        highwater=max(highwater,int(re.search(r"VmHWM:\s+(\d+)",status)[1])/1024)
                        break
                    time.sleep(.1)
                rows.append({"precision":precision,"backend":args.backend,"gpuLayers":args.gpu_layers if args.backend == "cuda" else 0,
                             "contextTokens":32768,"cacheTypes":"f16/f16","ready":ready,"ramHighwaterMiB":highwater,
                             "vramLoadSamplePeakMiB":vram_peak,"loadSeconds":time.monotonic()-started,"fileCache":"not cleared; warm files"})
            finally:
                child.terminate()
                try: child.wait(timeout=10)
                except subprocess.TimeoutExpired: child.kill();child.wait()
        args.output.write_text(json.dumps(rows,indent=2)+"\n")
        print(f"{precision}: ready={ready}, RAM high-water {highwater:.1f} MiB, VRAM load {vram_peak} MiB",flush=True)


if __name__ == "__main__": main()

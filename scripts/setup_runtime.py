#!/usr/bin/env python3
"""Prepare pinned CUDA and CPU runtimes for automatic GPU-first inference."""
import argparse
import hashlib
import json
import platform
from pathlib import Path
import tarfile
import tempfile
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
LOCK = json.loads((ROOT / "runtime.lock.json").read_text())
DEFAULT_MODEL = "lfm2.5-2.6b"
MODELS = {DEFAULT_MODEL: LOCK["model"], **LOCK["additionalModels"]}


def checksum(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def download(url, destination, digest):
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists() and checksum(destination) == digest:
        print(f"Verificado: {destination.name}", flush=True)
        return
    partial = destination.with_suffix(destination.suffix + ".part")
    request = urllib.request.Request(url, headers={"User-Agent": "zotero-reader-local-ai/0.1"})
    print(f"Baixando {destination.name}…", flush=True)
    with urllib.request.urlopen(request, timeout=120) as response, partial.open("wb") as output:
        count = 0
        last = time.monotonic()
        while chunk := response.read(8 * 1024 * 1024):
            output.write(chunk)
            count += len(chunk)
            if time.monotonic() - last > 15:
                print(f"  {count / 1024**2:.0f} MiB", flush=True)
                last = time.monotonic()
    if checksum(partial) != digest:
        raise RuntimeError(f"Checksum incorreto: {partial}")
    partial.replace(destination)
    print(f"Verificado: {destination.name}", flush=True)


def install_archive(archive, destination):
    # Never truncate libraries/executables that a running server has mapped.
    # Extract completely first, then publish new inodes on the same filesystem.
    destination.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".runtime-install-", dir=destination.parent) as directory:
        staging = Path(directory)
        with tarfile.open(archive) as bundle:
            bundle.extractall(staging, filter="data")
        for source in staging.rglob("*"):
            target = destination / source.relative_to(staging)
            if source.is_dir() and not source.is_symlink():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                source.replace(target)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", choices=MODELS, default=DEFAULT_MODEL)
    parser.add_argument("--precision", choices=[*LOCK["model"]["variants"], "all"], default="Q4_K_M")
    parser.add_argument("--backend", choices=["auto", "cpu", "cuda"], default="auto")
    args = parser.parse_args()
    if platform.system() != "Linux" or platform.machine() not in ("x86_64", "AMD64"):
        parser.error("O instalador de runtime inicial é para Linux x86_64.")
    for backend in ["cuda", "cpu"] if args.backend == "auto" else [args.backend]:
        binary = LOCK["llamaCpp"]["linuxX64Cpu" if backend == "cpu" else "linuxX64Cuda"]
        destination = ROOT / ".runtime" / ("llama" if backend == "cpu" else "llama-cuda")
        destination.mkdir(parents=True, exist_ok=True)
        packages = [(binary, "llama-" + backend)]
        if backend == "cuda": packages.append((LOCK["llamaCpp"]["cudaLibraries"], "cuda-libraries"))
        for package, name in packages:
            archive = ROOT / ".runtime" / "downloads" / (name + ".tar.gz")
            download(package["url"], archive, package["sha256"])
            marker = destination / (name + ".sha256")
            if not marker.exists() or marker.read_text().strip() != package["sha256"]:
                install_archive(archive, destination)
                marker.write_text(package["sha256"] + "\n")
    model = MODELS[args.model]
    variants = model["variants"]
    for precision in variants if args.precision == "all" else [args.precision]:
        variant = variants[precision]
        url = f'https://huggingface.co/{model["repository"]}/resolve/{model["revision"]}/{variant["filename"]}'
        download(url, ROOT / ".runtime" / "models" / variant["filename"], variant["sha256"])
    mode = "" if args.backend == "auto" else " --backend " + args.backend
    precision = "Q4_K_M" if args.precision == "all" else args.precision
    print(f"Runtime preparado. Inicie com: python3 scripts/serve.py --model {args.model} --precision {precision}{mode}", flush=True)


if __name__ == "__main__":
    main()

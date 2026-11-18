#!/usr/bin/env python3
"""Prepare pinned CUDA and CPU runtimes for automatic GPU-first inference."""
import argparse
import hashlib
import json
import os
import platform
from pathlib import Path
import re
import shutil
import struct
import sys
import tarfile
import tempfile
import time
import urllib.request
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[1]
LOCK = json.loads((ROOT / "runtime.lock.json").read_text(encoding="utf-8"))
DEFAULT_MODEL = "lfm2.5-8b-a1b"
MODELS = {"lfm2.5-2.6b": LOCK["model"], **LOCK["additionalModels"]}
MIN_PYTHON = (3, 12)


def checksum(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def download(url, destination, digest):
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists() and checksum(destination) == digest:
        print(f"Verificado: {destination.name}", flush=True)
        return
    partial = destination.with_suffix(destination.suffix + ".part")
    request = urllib.request.Request(url, headers={"User-Agent": "zotero-reader-local-ai/0.2"})
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
    archive = Path(archive)
    if archive.suffix.lower() == ".zip":
        install_zip(archive, destination)
    else:
        install_tar(archive, destination)


def publish_tree(staging, destination):
    for source in staging.rglob("*"):
        target = destination / source.relative_to(staging)
        if source.is_dir() and not source.is_symlink():
            target.mkdir(parents=True, exist_ok=True)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            source.replace(target)


def install_tar(archive, destination):
    # Never truncate libraries/executables that a running server has mapped.
    # Extract completely first, then publish new inodes on the same filesystem.
    destination.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".runtime-install-", dir=destination.parent) as directory:
        staging = Path(directory)
        with tarfile.open(archive) as bundle:
            bundle.extractall(staging, filter="data")
        publish_tree(staging, destination)


def install_zip(archive, destination):
    """Extract a ZIP after rejecting traversal and symbolic-link entries."""
    destination.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".runtime-install-", dir=destination.parent) as directory:
        staging = Path(directory)
        with ZipFile(archive) as bundle:
            for info in bundle.infolist():
                name = info.filename.replace("\\", "/")
                if not name or name.startswith("/") or re.match(r"^[A-Za-z]:", name):
                    raise RuntimeError(f"Caminho inválido no ZIP: {info.filename}")
                target = (staging / name).resolve()
                if target != staging.resolve() and staging.resolve() not in target.parents:
                    raise RuntimeError(f"Caminho inválido no ZIP: {info.filename}")
                mode = info.external_attr >> 16
                if mode & 0o170000 == 0o120000:
                    raise RuntimeError(f"Link simbólico não permitido no ZIP: {info.filename}")
                if info.is_dir():
                    target.mkdir(parents=True, exist_ok=True)
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                with bundle.open(info) as source, target.open("wb") as output:
                    shutil.copyfileobj(source, output)
        publish_tree(staging, destination)


def runtime_platform():
    system = platform.system()
    machine = platform.machine().lower()
    if struct.calcsize("P") != 8:
        raise RuntimeError("Use Python 3.12+ de 64 bits. Python de 32 bits não é suportado.")
    if system == "Windows":
        processor = " ".join(
            os.environ.get(name, "") for name in ("PROCESSOR_ARCHITECTURE", "PROCESSOR_ARCHITEW6432")
        ).lower()
        if "arm64" in machine or "arm64" in processor:
            raise RuntimeError("Windows ARM64 não é suportado. Use Windows x64.")
        if machine not in ("amd64", "x86_64"):
            raise RuntimeError("O runtime Windows requer Windows 10/11 x64.")
        return "windows-x64"
    if system == "Linux" and machine in ("x86_64", "amd64"):
        return "linux-x64"
    raise RuntimeError("O instalador de runtime é para Linux x86_64 ou Windows x64.")


def runtime_packages(platform_key, backend):
    if platform_key == "windows-x64":
        binary = LOCK["llamaCpp"]["windowsX64Cpu" if backend == "cpu" else "windowsX64Cuda"]
        packages = [(binary, "llama-" + backend)]
        if backend == "cuda":
            packages.append((LOCK["llamaCpp"]["cudaLibrariesWindows"], "cuda-libraries"))
        return packages, ".zip"
    binary = LOCK["llamaCpp"]["linuxX64Cpu" if backend == "cpu" else "linuxX64Cuda"]
    packages = [(binary, "llama-" + backend)]
    if backend == "cuda":
        packages.append((LOCK["llamaCpp"]["cudaLibraries"], "cuda-libraries"))
    return packages, ".tar.gz"


def install_linux_runtime(backend):
    packages, suffix = runtime_packages("linux-x64", backend)
    destination = ROOT / ".runtime" / ("llama" if backend == "cpu" else "llama-cuda")
    destination.mkdir(parents=True, exist_ok=True)
    for package, label in packages:
        marker = destination / (label + ".sha256")
        if marker.is_file() and marker.read_text(encoding="utf-8").strip() == package["sha256"]:
            print(f"Verificado: {label}", flush=True)
            continue
        archive = ROOT / ".runtime" / "downloads" / (label + suffix)
        download(package["url"], archive, package["sha256"])
        install_archive(archive, destination)
        marker.write_text(package["sha256"] + "\n", encoding="utf-8")
    return destination


def install_windows_runtime(backend):
    """Publish each Windows runtime into its own directory, never over a loaded EXE/DLL."""
    packages, suffix = runtime_packages("windows-x64", backend)
    fingerprint = hashlib.sha256("".join(package["sha256"] for package, _ in packages).encode()).hexdigest()[:12]
    name = ("llama-cuda" if backend == "cuda" else "llama-cpu") + f"-{LOCK['llamaCpp']['tag']}-{fingerprint}"
    destination = ROOT / ".runtime" / "runtimes" / name
    expected = [package["sha256"] for package, _ in packages]
    ready = destination / ".ready"
    if ready.is_file():
        try:
            state = json.loads(ready.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            state = {}
        if state.get("sha256") == expected:
            print(f"Verificado: {destination.name}", flush=True)
            return destination
        raise RuntimeError(
            f"A pasta {destination} existe sem o marcador esperado. Pare o servidor e remova-a antes de reinstalar."
        )
    if destination.exists():
        # A published directory always has .ready. Never remove an EXE/DLL that may be loaded.
        raise RuntimeError(
            f"A pasta {destination} existe sem .ready. Pare o servidor e remova-a antes de reinstalar."
        )
    destination.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=".install-", dir=destination.parent))
    try:
        for package, label in packages:
            archive = ROOT / ".runtime" / "downloads" / (label + suffix)
            download(package["url"], archive, package["sha256"])
            install_archive(archive, staging)
        if not any(path.is_file() for path in staging.rglob("llama-server.exe")):
            raise RuntimeError("O runtime Windows baixado não contém llama-server.exe.")
        (staging / ".ready").write_text(json.dumps({
            "backend": backend,
            "tag": LOCK["llamaCpp"]["tag"],
            "sha256": expected,
        }, indent=2) + "\n", encoding="utf-8")
        staging.replace(destination)
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    print(f"Publicado: {destination.name}", flush=True)
    return destination


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", choices=MODELS, default=DEFAULT_MODEL)
    parser.add_argument("--precision", choices=[*LOCK["model"]["variants"], "all"], default="Q4_K_M")
    parser.add_argument("--backend", choices=["auto", "cpu", "cuda"], default="auto")
    args = parser.parse_args()
    if sys.version_info < MIN_PYTHON:
        parser.error("Use Python 3.12 ou superior para preparar o runtime.")
    try:
        platform_key = runtime_platform()
    except RuntimeError as error:
        parser.error(str(error))
    for backend in ["cuda", "cpu"] if args.backend == "auto" else [args.backend]:
        if platform_key == "windows-x64":
            install_windows_runtime(backend)
        else:
            install_linux_runtime(backend)
    model = MODELS[args.model]
    variants = model["variants"]
    for precision in variants if args.precision == "all" else [args.precision]:
        variant = variants[precision]
        url = f'https://huggingface.co/{model["repository"]}/resolve/{model["revision"]}/{variant["filename"]}'
        download(url, ROOT / ".runtime" / "models" / variant["filename"], variant["sha256"])
    mode = "" if args.backend == "auto" else " --backend " + args.backend
    precision = "Q4_K_M" if args.precision == "all" else args.precision
    python = "python" if platform_key == "windows-x64" else "python3"
    print(f"Runtime preparado. Inicie com: {python} scripts/serve.py --model {args.model} --precision {precision}{mode}", flush=True)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Supervise the local embedding server used by retrieval."""
import argparse
from collections import deque
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import threading
import time
import urllib.error

# Reuse the verified llama.cpp discovery, environment and shutdown helpers.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from serve import (  # noqa: E402
    LOCK,
    ROOT,
    WINDOWS,
    configure_output,
    cuda_available,
    environment,
    find_executable,
    gpu_memory_error,
    gpu_unavailable_error,
    install_stop_handlers,
    local_json,
    popen_group_kwargs,
    stop_child,
    watch_managed_lifetime,
)

EMBEDDING_MODELS = LOCK.get("embeddingModels", {})
DEFAULT_MODEL = "qwen3-embedding-0.6b"
DEFAULT_CONTEXT = 8192


def command(args, backend, layers):
    model = EMBEDDING_MODELS[args.model]
    variant = model["variants"][args.precision]
    path = ROOT / ".runtime" / "models" / variant["filename"]
    executable = find_executable(backend)
    if not executable or not Path(executable).is_file():
        raise RuntimeError("Runtime do llama.cpp ausente. Execute scripts/setup_runtime.py --backend auto.")
    if not path.is_file():
        raise RuntimeError(f"Modelo de embeddings ausente: {variant['filename']}. Execute scripts/setup_runtime.py --backend auto.")
    return [str(executable), "--model", str(path), "--alias", args.model,
            "--host", "127.0.0.1", "--port", str(args.port), "--ctx-size", str(args.context),
            "--threads", str(args.threads), "--threads-batch", str(args.threads),
            "--n-gpu-layers", str(layers), "--embedding", "--pooling", model.get("pooling", "last"),
            "--embd-normalize", "2", "--no-webui"]


class EmbeddingSupervisor:
    def __init__(self, args, stopped):
        self.args, self.stopped = args, stopped
        self.status_path = ROOT / f".runtime/embedding-{args.port}.json"
        self.status = {"supervisorPid": os.getpid(), "model": args.model,
                       "precision": args.precision, "contextTokens": args.context,
                       "port": args.port, "phase": "starting"}

    def publish(self, **fields):
        self.status.update(fields)
        self.status_path.parent.mkdir(parents=True, exist_ok=True)
        temp = self.status_path.with_suffix(f".{os.getpid()}.tmp")
        temp.write_text(json.dumps(self.status, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        temp.replace(self.status_path)

    def run_attempt(self, backend, layers):
        launch = command(self.args, backend, layers)
        child = subprocess.Popen(launch, env=environment(backend, launch[0]), stdout=subprocess.PIPE,
                                 stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace",
                                 bufsize=1, **popen_group_kwargs())
        tail, oom, unavailable = deque(maxlen=30), threading.Event(), threading.Event()

        def pump():
            for line in child.stdout:
                tail.append(line)
                if gpu_memory_error(line): oom.set()
                if gpu_unavailable_error(line): unavailable.set()
                print(line, end="", flush=True)

        reader = threading.Thread(target=pump, daemon=True)
        reader.start()
        self.publish(phase="loading", childPid=child.pid, backend=backend, gpuLayers=layers)
        started, ready = time.monotonic(), False
        try:
            while not self.stopped.is_set():
                code = child.poll()
                if code is not None:
                    reader.join(timeout=2)
                    if backend == "cuda" and unavailable.is_set(): return "unavailable"
                    if backend == "cuda" and oom.is_set(): return "oom"
                    if code: raise RuntimeError("O servidor de embeddings encerrou com erro:\n" + "".join(tail))
                    return "exited"
                if backend == "cuda" and (oom.is_set() or unavailable.is_set()):
                    stop_child(child); reader.join(timeout=2)
                    return "unavailable" if unavailable.is_set() else "oom"
                if not ready:
                    if time.monotonic() - started > 120:
                        raise RuntimeError("O servidor de embeddings não iniciou em 120 segundos. Confira o log.")
                    try:
                        local_json(self.args.port, "/health")
                        models = local_json(self.args.port, "/v1/models")
                    except (OSError, ValueError, urllib.error.URLError):
                        self.stopped.wait(.25)
                        continue
                    found = models.get("data", [{}])[0].get("id")
                    if found != self.args.model:
                        raise RuntimeError(f"O servidor na porta {self.args.port} respondeu com o modelo {found!r}, não {self.args.model!r}.")
                    ready = True
                    self.publish(phase="ready")
                    label = "GPU" if backend == "cuda" else "CPU"
                    print(f"Pronto: {self.args.model}; embeddings; {label}; http://127.0.0.1:{self.args.port}", flush=True)
                self.stopped.wait(.25)
            return "stopped"
        finally:
            stop_child(child)
            reader.join(timeout=2)
            child.stdout.close()
            self.publish(childPid=None)

    def run(self):
        with socket.socket() as probe:
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            probe.bind(("127.0.0.1", self.args.port))
        if self.args.backend == "cpu":
            result = self.run_attempt("cpu", 0)
        else:
            cuda = find_executable("cuda")
            available = bool(cuda) and cuda_available(str(cuda), environment("cuda", str(cuda)))
            if self.args.backend == "cuda" and not available:
                raise RuntimeError("O backend CUDA foi solicitado, mas nenhuma GPU CUDA utilizável foi encontrada.")
            if available:
                result = self.run_attempt("cuda", 99)
                if result in ("oom", "unavailable") and not self.stopped.is_set():
                    print("GPU sem memória para os embeddings. Usando CPU…", flush=True)
                    result = self.run_attempt("cpu", 0)
            else:
                result = self.run_attempt("cpu", 0)
        self.publish(phase="stopped", childPid=None)
        return 0 if result in ("stopped", "exited") else 0


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", choices=list(EMBEDDING_MODELS), default=DEFAULT_MODEL)
    parser.add_argument("--precision", choices=["Q8_0", "F16"], default="Q8_0")
    parser.add_argument("--context", type=int, default=DEFAULT_CONTEXT)
    parser.add_argument("--port", type=int, default=18081)
    parser.add_argument("--threads", type=int, default=8)
    parser.add_argument("--backend", choices=["auto", "cpu", "cuda"], default="auto")
    parser.add_argument("--managed", action="store_true", help="EOF de stdin ou saída do Zotero encerra o servidor")
    parser.add_argument("--parent-pid", type=int, help="PID do Zotero que iniciou este launcher")
    args = parser.parse_args(argv)
    model = EMBEDDING_MODELS[args.model]
    if not 512 <= args.context <= model["maxContextTokens"]:
        parser.error(f"O contexto de {args.model} deve ficar entre 512 e {model['maxContextTokens']} tokens.")
    if not 1 <= args.port <= 65535 or args.threads < 1:
        parser.error("Porta ou número de threads inválido.")
    if args.managed and (args.backend != "auto" or not args.parent_pid or args.parent_pid < 1):
        parser.error("O modo gerenciado requer --parent-pid positivo e backend automático.")
    if args.parent_pid is not None and not args.managed:
        parser.error("Use --parent-pid somente com --managed.")
    return args


def main():
    configure_output()
    args = parse_args()
    if sys.version_info < (3, 12):
        print("Use Python 3.12 ou superior para iniciar o runtime.", flush=True)
        return 1
    stopped = threading.Event()
    install_stop_handlers(stopped)
    if args.managed:
        watch_managed_lifetime(stopped, args.parent_pid, sys.stdin.buffer)
    try:
        return EmbeddingSupervisor(args, stopped).run()
    except (RuntimeError, OSError) as error:
        print(str(error), flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

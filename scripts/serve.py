#!/usr/bin/env python3
"""Prefer full GPU inference; on GPU OOM try shared GPU/CPU, then CPU."""
import argparse
from collections import deque
import json
import os
from pathlib import Path
import re
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
LOCK = json.loads((ROOT / "runtime.lock.json").read_text())
DEFAULT_MODEL = "lfm2.5-2.6b"
MODELS = {DEFAULT_MODEL: LOCK["model"], **LOCK["additionalModels"]}


DEFAULT_CONTEXT = 64000


def command(precision="Q4_K_M", context=DEFAULT_CONTEXT, port=8080, threads=8, binary=None,
            gpu_layers=0, backend="cpu", fit=False, model_id=DEFAULT_MODEL):
    candidates = sorted((ROOT / ".runtime" / ("llama-cuda" if backend == "cuda" else "llama")).rglob("llama-server"))
    executable = Path(binary) if binary else (candidates[0] if candidates else None)
    model = ROOT / ".runtime" / "models" / MODELS[model_id]["variants"][precision]["filename"]
    if not executable or not executable.is_file() or not model.is_file():
        raise RuntimeError(f"Runtime/modelo ausente. Execute: python3 scripts/setup_runtime.py --model {model_id} --precision {precision} --backend auto")
    return [str(executable), "--model", str(model), "--alias", model_id,
            "--host", "127.0.0.1", "--port", str(port), "--ctx-size", str(context),
            "--parallel", "1", "--threads", str(threads), "--threads-batch", str(threads),
            "--n-gpu-layers", str(gpu_layers), "--fit", "on" if fit else "off", "--cache-type-k", "f16",
            "--cache-type-v", "f16", "--no-context-shift", "--cache-ram", "0",
            "--jinja", "--reasoning-format", "deepseek", "--no-webui",
            *(["--fit-ctx", str(context), "--fit-target", "512"] if fit else []),
            *(["--device", "none", "--no-op-offload"] if backend == "cpu" else [])]


def environment(backend, binary=None):
    env = os.environ.copy()
    if binary or backend == "cuda":
        library_dirs = sorted({str(p.parent) for p in (ROOT / ".runtime/llama-cuda").rglob("*.so*")})
        env["LD_LIBRARY_PATH"] = ":".join(library_dirs + ([env["LD_LIBRARY_PATH"]] if env.get("LD_LIBRARY_PATH") else []))
    return env


def cuda_available(executable, env):
    try:
        result = subprocess.run([executable, "--list-devices"], env=env, capture_output=True,
                                text=True, timeout=15)
        return result.returncode == 0 and bool(re.search(r"^\s*CUDA\d+:", result.stdout, re.MULTILINE))
    except (OSError, subprocess.TimeoutExpired):
        return False


def gpu_memory_error(text):
    text = text.lower()
    return "cuda" in text and ("out of memory" in text or "cuda_error_out_of_memory" in text
        or bool(re.search(r"alloc.*fail|fail.*alloc", text)))


def gpu_unavailable_error(text):
    text = text.lower()
    return any(message in text for message in ["no usable gpu found", "no cuda-capable device",
        "cuda driver version is insufficient", "failed to initialize cuda", "cuda error: unknown error"])


def stop_child(child):
    if child.poll() is None:
        child.terminate()
        try: child.wait(timeout=10)
        except subprocess.TimeoutExpired: child.kill(); child.wait()


def local_json(port, path):
    # Ignore proxy environment variables for loopback runtime checks.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(f"http://127.0.0.1:{port}{path}", timeout=1) as response:
        return json.load(response)


def watch_managed_lifetime(stopped, parent_pid, stream):
    """The Zotero-owned launcher stops on control-pipe EOF or parent exit."""
    def watch_pipe():
        try:
            # No commands or prompts travel over this pipe; closing it means stop.
            while stream.read(1):
                pass
        finally:
            stopped.set()

    def watch_parent():
        while not stopped.wait(.5):
            try: os.kill(parent_pid, 0)
            except ProcessLookupError:
                stopped.set(); return
            except PermissionError:
                pass

    threading.Thread(target=watch_pipe, daemon=True).start()
    threading.Thread(target=watch_parent, daemon=True).start()


class RuntimeSupervisor:
    def __init__(self, args, stopped):
        self.args, self.stopped = args, stopped
        self.status_path = ROOT / f".runtime/server-{args.port}.json"
        self.status = {"supervisorPid": os.getpid(), "model": args.model, "precision": args.precision,
                       "contextTokens": args.context, "cacheTypes": "f16/f16", "attempts": []}

    def publish(self, **fields):
        self.status.update(fields)
        self.status_path.parent.mkdir(parents=True, exist_ok=True)
        temp = self.status_path.with_suffix(f".{os.getpid()}.tmp")
        temp.write_text(json.dumps(self.status, ensure_ascii=False, indent=2) + "\n")
        temp.replace(self.status_path)

    def run_attempt(self, backend, layers, fit=False):
        args = self.args
        launch = command(args.precision, args.context, args.port, args.threads,
                         gpu_layers=layers, backend=backend, fit=fit, model_id=args.model)
        child = subprocess.Popen(launch, env=environment(backend), stdout=subprocess.PIPE,
                                 stderr=subprocess.STDOUT, text=True, errors="replace", bufsize=1)
        tail, oom, unavailable = deque(maxlen=30), threading.Event(), threading.Event()

        def pump():
            for line in child.stdout:
                tail.append(line)
                if gpu_memory_error(line): oom.set()
                if gpu_unavailable_error(line): unavailable.set()
                print(line, end="", flush=True)

        reader = threading.Thread(target=pump, daemon=True); reader.start()
        attempt = {"backend": backend, "gpuLayers": layers, "fit": fit, "pid": child.pid}
        self.status["attempts"].append(attempt)
        self.publish(phase="loading", childPid=child.pid, backend=backend, gpuLayers=layers)
        started, ready = time.monotonic(), False
        try:
            while not self.stopped.is_set():
                code = child.poll()
                if code is not None:
                    reader.join(timeout=2)
                    attempt.update(exitCode=code, gpuMemoryError=oom.is_set(), ready=ready)
                    if backend == "cuda" and unavailable.is_set(): return "unavailable"
                    if backend == "cuda" and oom.is_set(): return "oom"
                    if code: raise RuntimeError("O servidor local encerrou com erro:\n" + "".join(tail))
                    return "exited"
                # OOM may return an HTTP error without terminating llama-server.
                if backend == "cuda" and (oom.is_set() or unavailable.is_set()):
                    stop_child(child); reader.join(timeout=2)
                    attempt.update(exitCode=child.returncode, gpuMemoryError=oom.is_set(), ready=ready)
                    return "unavailable" if unavailable.is_set() else "oom"
                if not ready:
                    if time.monotonic() - started > 120:
                        raise RuntimeError("O servidor não iniciou em 120 segundos. Confira o log; o contexto não foi reduzido.")
                    try:
                        local_json(args.port, "/health")
                        props = local_json(args.port, "/props")
                    except (OSError, ValueError, urllib.error.URLError):
                        self.stopped.wait(.25); continue
                    if props.get("default_generation_settings", {}).get("n_ctx") != args.context or props.get("total_slots") != 1:
                        raise RuntimeError("O runtime alterou contexto/slots; a inicialização foi recusada.")
                    ready = True
                    attempt["ready"] = True
                    self.publish(phase="ready")
                    label = "GPU inteira" if layers == "all" else "GPU/CPU ajustadas à memória" if fit else "CPU"
                    print(f"Pronto: {args.model}; {label}; contexto {args.context}; http://127.0.0.1:{args.port}", flush=True)
                self.stopped.wait(.25)
            return "stopped"
        finally:
            stop_child(child); reader.join(timeout=2); child.stdout.close()
            self.publish(childPid=None)

    def run(self):
        # Fail on a busy port rather than accidentally checking another server's health.
        with socket.socket() as probe:
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            probe.bind(("127.0.0.1", self.args.port))
        cuda = None
        try:
            cuda = command(self.args.precision, self.args.context, self.args.port,
                           self.args.threads, backend="cuda", gpu_layers="all", model_id=self.args.model)[0]
        except RuntimeError:
            # A missing CUDA runtime cannot silently select CPU on a GPU machine.
            raise RuntimeError(f"Prepare runtime e modelo com: python3 scripts/setup_runtime.py --model {self.args.model} --precision {self.args.precision} --backend auto")
        try:
            available = cuda_available(cuda, environment("cuda"))
            if self.stopped.is_set():
                self.publish(phase="stopped", childPid=None); return
            if available:
                print("Tentando executar todas as camadas na GPU…", flush=True)
                result = self.run_attempt("cuda", "all")
                if result == "oom" and not self.stopped.is_set():
                    print("Faltou VRAM. Ajustando a distribuição entre GPU e CPU, mantendo o contexto…", flush=True)
                    result = self.run_attempt("cuda", "auto", fit=True)
                if result in ("oom", "unavailable") and not self.stopped.is_set():
                    print("GPU indisponível ou sem memória suficiente no modo compartilhado. Usando CPU…", flush=True)
                    self.run_attempt("cpu", 0)
            elif not self.stopped.is_set():
                print("O runtime não encontrou uma GPU CUDA utilizável. Usando CPU…", flush=True)
                self.run_attempt("cpu", 0)
            self.publish(phase="stopped", childPid=None)
        except Exception:
            self.publish(phase="failed", childPid=None)
            raise


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", choices=MODELS, default=DEFAULT_MODEL)
    parser.add_argument("--precision", choices=LOCK["model"]["variants"], default="Q4_K_M")
    parser.add_argument("--context", type=int, default=DEFAULT_CONTEXT)
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--threads", type=int, default=8)
    parser.add_argument("--backend", choices=["auto", "cpu", "cuda"], default="auto",
                        help="auto: GPU inteira → GPU/CPU → CPU; modos explícitos não fazem fallback")
    parser.add_argument("--binary", help="Optional separately verified GPU binary")
    parser.add_argument("--gpu-layers", type=int, help="Distribuição fixa, sem fallback; -1 = todas as camadas")
    parser.add_argument("--managed", action="store_true", help="Controle de ciclo de vida pelo Zotero: EOF de stdin encerra o servidor")
    parser.add_argument("--parent-pid", type=int, help="PID do Zotero que iniciou este launcher")
    args = parser.parse_args(argv)
    if not 8192 <= args.context <= MODELS[args.model]["maxContextTokens"]:
        parser.error(f"O contexto de {args.model} deve ficar entre 8192 e {MODELS[args.model]['maxContextTokens']} tokens.")
    if not 1 <= args.port <= 65535 or args.threads < 1 or (args.gpu_layers is not None and args.gpu_layers < -1):
        parser.error("Contexto, porta ou número de threads inválido.")
    if args.gpu_layers and args.backend == "cpu":
        parser.error("Use --backend cuda para habilitar camadas na GPU.")
    if args.managed and (args.backend != "auto" or args.gpu_layers is not None or args.binary or not args.parent_pid or args.parent_pid < 1):
        parser.error("O modo gerenciado requer --parent-pid positivo e distribuição automática.")
    if args.parent_pid is not None and not args.managed:
        parser.error("Use --parent-pid somente com --managed.")
    return args


def main():
    args = parse_args()
    if args.backend == "auto" and args.gpu_layers is None and not args.binary:
        stopped = threading.Event()
        for signum in (signal.SIGINT, signal.SIGTERM):
            signal.signal(signum, lambda *_: stopped.set())
        if args.managed:
            watch_managed_lifetime(stopped, args.parent_pid, sys.stdin.buffer)
        try: RuntimeSupervisor(args, stopped).run()
        except (RuntimeError, OSError) as error:
            print(str(error), flush=True); return 1
        return 0
    backend = args.backend if args.backend != "auto" else "cpu" if args.gpu_layers == 0 else "cuda"
    layers = args.gpu_layers if args.gpu_layers is not None else (0 if backend == "cpu" else -1)
    launch = command(args.precision, args.context, args.port, args.threads, args.binary, layers, backend, model_id=args.model)
    print(f"{args.model} {args.precision}, distribuição fixa {backend}/{layers}, contexto {args.context}, http://127.0.0.1:{args.port}", flush=True)
    os.execve(launch[0], launch, environment(backend, args.binary))


if __name__ == "__main__":
    raise SystemExit(main())

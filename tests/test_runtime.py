import importlib.util
import io
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch, Mock

spec = importlib.util.spec_from_file_location("serve", Path(__file__).resolve().parents[1] / "scripts/serve.py")
serve = importlib.util.module_from_spec(spec)
spec.loader.exec_module(serve)


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for directory in ["llama", "llama-cuda"]:
            path = self.root / ".runtime" / directory / "llama-server"
            path.parent.mkdir(parents=True); path.touch()
        for definition in serve.MODELS.values():
            model = self.root / ".runtime/models" / definition["variants"]["Q4_K_M"]["filename"]
            model.parent.mkdir(parents=True, exist_ok=True); model.touch()
        self.root_patch = patch.object(serve, "ROOT", self.root)
        self.root_patch.start(); self.addCleanup(self.root_patch.stop)

    def run_policy(self, outcomes, available=True, stopped=None, argv=None):
        supervisor = serve.RuntimeSupervisor(serve.parse_args(argv or []), stopped or threading.Event())
        supervisor.run_attempt = Mock(side_effect=outcomes)
        with patch.object(serve.socket, "socket"), patch.object(serve, "cuda_available", return_value=available):
            supervisor.run()
        return supervisor

    def test_default_is_gpu_first_and_full_gpu_success_never_uses_cpu(self):
        self.assertEqual(serve.parse_args([]).backend, "auto")
        supervisor = self.run_policy(["exited"])
        self.assertEqual(supervisor.run_attempt.call_args_list[0].args, ("cuda", "all"))
        self.assertEqual(supervisor.run_attempt.call_count, 1)

    def test_gpu_oom_prefers_sharing_over_cpu(self):
        supervisor = self.run_policy(["oom", "exited"])
        self.assertEqual([call.args for call in supervisor.run_attempt.call_args_list], [("cuda", "all"), ("cuda", "auto")])
        self.assertTrue(supervisor.run_attempt.call_args_list[1].kwargs["fit"])

    def test_cpu_is_last_resort_after_both_gpu_attempts_fail(self):
        supervisor = self.run_policy(["oom", "oom", "exited"])
        self.assertEqual([call.args for call in supervisor.run_attempt.call_args_list], [("cuda", "all"), ("cuda", "auto"), ("cpu", 0)])
        supervisor = self.run_policy(["exited"], available=False)
        supervisor.run_attempt.assert_called_once_with("cpu", 0)

    def test_fitting_cannot_reduce_context_change_weights_or_quantize_cache(self):
        full = serve.command(backend="cuda", gpu_layers="all")
        shared = serve.command(backend="cuda", gpu_layers="auto", fit=True)
        cpu = serve.command(backend="cpu", gpu_layers=0)
        for launch in [full, shared, cpu]:
            for flag, value in [("--ctx-size", "64000"), ("--parallel", "1"), ("--cache-type-k", "f16"), ("--cache-type-v", "f16")]:
                self.assertEqual(launch[launch.index(flag) + 1], value)
            self.assertEqual(launch[launch.index("--model") + 1], full[full.index("--model") + 1])
            self.assertIn("--no-context-shift", launch)
        self.assertEqual(shared[shared.index("--fit-ctx") + 1], "64000")
        self.assertEqual(full[full.index("--fit") + 1], "off")
        self.assertEqual(cpu[cpu.index("--device") + 1], "none")

    def test_explicit_placement_stays_fixed_for_experiments(self):
        args = serve.parse_args(["--backend", "cuda", "--gpu-layers", "24", "--context", "32768"])
        launch = serve.command(backend=args.backend, gpu_layers=args.gpu_layers, context=args.context)
        self.assertEqual(launch[launch.index("--n-gpu-layers") + 1], "24")
        self.assertEqual(launch[launch.index("--fit") + 1], "off")
        self.assertEqual(launch[launch.index("--ctx-size") + 1], "32768")
        self.assertIsNone(serve.parse_args(["--backend", "cuda"]).gpu_layers)

    def test_selected_moe_model_keeps_its_weights_alias_and_context_across_fallback(self):
        model_id = "lfm2.5-8b-a1b"
        supervisor = self.run_policy(["oom", "oom", "exited"], argv=["--model", model_id])
        self.assertEqual(supervisor.status["model"], model_id)
        launches = [serve.command(backend=backend, gpu_layers=layers, model_id=supervisor.args.model, **call.kwargs)
                    for call in supervisor.run_attempt.call_args_list for backend, layers in [call.args]]
        for launch in launches:
            self.assertEqual(Path(launch[launch.index("--model") + 1]).name, "LFM2.5-8B-A1B-Q4_K_M.gguf")
            for flag, value in [("--alias", model_id), ("--ctx-size", "64000"), ("--cache-type-k", "f16"), ("--cache-type-v", "f16")]:
                self.assertEqual(launch[launch.index(flag) + 1], value)

    def test_model_specific_context_limit_and_missing_weight_do_not_select_another_model(self):
        self.assertEqual(serve.parse_args(["--model", "lfm2.5-8b-a1b", "--context", "128000"]).context, 128000)
        self.assertEqual(serve.parse_args(["--context", "131072"]).context, 131072)
        with patch("sys.stderr", new=io.StringIO()), self.assertRaises(SystemExit):
            serve.parse_args(["--model", "lfm2.5-8b-a1b", "--context", "131072"])
        weight = self.root / ".runtime/models/LFM2.5-8B-A1B-Q4_K_M.gguf"
        weight.unlink()
        with self.assertRaisesRegex(RuntimeError, "--model lfm2.5-8b-a1b --precision Q4_K_M"):
            serve.command(model_id="lfm2.5-8b-a1b")

    def test_unrelated_failures_are_not_masked_as_memory_fallback(self):
        self.assertTrue(serve.gpu_memory_error("CUDA error: out of memory"))
        self.assertTrue(serve.gpu_memory_error("ggml_backend_cuda_buffer_type_alloc_buffer: allocation failed"))
        self.assertFalse(serve.gpu_memory_error("model not found"))
        self.assertFalse(serve.gpu_memory_error("CPU buffer allocation failed"))
        with self.assertRaisesRegex(RuntimeError, "bad model"):
            self.run_policy([RuntimeError("bad model")])

    def test_cancellation_during_device_probe_does_not_start_a_server(self):
        stopped = threading.Event(); stopped.set()
        supervisor = self.run_policy([], stopped=stopped)
        supervisor.run_attempt.assert_not_called()

    def test_changed_runtime_context_is_rejected_and_child_is_stopped(self):
        supervisor = serve.RuntimeSupervisor(serve.parse_args([]), threading.Event())
        child = Mock(pid=12345, stdout=io.StringIO("")); child.poll.return_value = None
        props = {"default_generation_settings": {"n_ctx": 8192}, "total_slots": 1}
        with patch.object(serve.subprocess, "Popen", return_value=child), patch.object(serve, "local_json", side_effect=[{}, props]), patch.object(serve, "stop_child") as stop:
            with self.assertRaisesRegex(RuntimeError, "alterou contexto"):
                supervisor.run_attempt("cuda", "all")
            stop.assert_called_once_with(child)
        self.assertIsNone(supervisor.status["childPid"])

    def test_ctrl_c_after_ready_stops_owned_child_without_fallback(self):
        stopped = threading.Event()
        supervisor = serve.RuntimeSupervisor(serve.parse_args([]), stopped)
        child = Mock(pid=12345, stdout=io.StringIO("")); child.poll.return_value = None
        original = supervisor.publish
        def publish(**fields):
            original(**fields)
            if fields.get("phase") == "ready": stopped.set()
        supervisor.publish = publish
        props = {"default_generation_settings": {"n_ctx": serve.DEFAULT_CONTEXT}, "total_slots": 1}
        with patch.object(serve.subprocess, "Popen", return_value=child), patch.object(serve, "local_json", side_effect=[{}, props]), patch.object(serve, "stop_child") as stop:
            self.assertEqual(supervisor.run_attempt("cuda", "all"), "stopped")
            stop.assert_called_once_with(child)
        self.assertEqual(len(supervisor.status["attempts"]), 1)

    def test_oom_after_ready_restarts_instead_of_leaving_failed_server_alive(self):
        oom_log = "CUDA error: out of memory\n"
        consumed = threading.Event()
        release = threading.Event()
        class Output(io.StringIO):
            def __iter__(self):
                release.wait(timeout=2)
                yield oom_log
                consumed.set()
        supervisor = serve.RuntimeSupervisor(serve.parse_args([]), threading.Event())
        child = Mock(pid=12345, stdout=Output()); child.poll.return_value = None
        child.returncode = -15
        original = supervisor.publish
        def publish(**fields):
            original(**fields)
            if fields.get("phase") == "ready":
                release.set()
                self.assertTrue(consumed.wait(timeout=2))
        supervisor.publish = publish
        props = {"default_generation_settings": {"n_ctx": serve.DEFAULT_CONTEXT}, "total_slots": 1}
        with patch.object(serve.subprocess, "Popen", return_value=child), patch.object(serve, "local_json", side_effect=[{}, props]), patch.object(serve, "stop_child") as stop:
            self.assertEqual(supervisor.run_attempt("cuda", "all"), "oom")
            stop.assert_called_with(child)
        attempt = supervisor.status["attempts"][0]
        self.assertTrue(attempt["ready"])
        self.assertTrue(attempt["gpuMemoryError"])

    def test_managed_launcher_stops_when_zotero_closes_control_pipe(self):
        stopped = threading.Event()
        serve.watch_managed_lifetime(stopped, 12345, io.BytesIO(b""))
        self.assertTrue(stopped.wait(timeout=1))

    def test_managed_launcher_stops_when_parent_exits_even_with_pipe_open(self):
        stopped, release = threading.Event(), threading.Event()
        class OpenPipe:
            def read(self, _):
                release.wait(timeout=2); return b""
        with patch.object(serve.os, "kill", side_effect=ProcessLookupError):
            serve.watch_managed_lifetime(stopped, 12345, OpenPipe())
            self.assertTrue(stopped.wait(timeout=1))
        release.set()

    def test_managed_mode_does_not_change_fixed_experiment_placement(self):
        args = serve.parse_args(["--managed", "--parent-pid", "12345"])
        self.assertTrue(args.managed); self.assertEqual(args.backend, "auto")
        for argv in [["--managed"], ["--parent-pid", "12345"], ["--managed", "--parent-pid", "12345", "--backend", "cuda"],
                     ["--managed", "--parent-pid", "12345", "--gpu-layers", "24"]]:
            with patch("sys.stderr", new=io.StringIO()), self.assertRaises(SystemExit):
                serve.parse_args(argv)
        self.assertFalse(serve.parse_args(["--backend", "cuda", "--gpu-layers", "24"]).managed)


if __name__ == "__main__": unittest.main()

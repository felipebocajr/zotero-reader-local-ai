import importlib.util
import io
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch
from zipfile import ZipFile

spec = importlib.util.spec_from_file_location("setup_runtime", Path(__file__).resolve().parents[1] / "scripts/setup_runtime.py")
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)


class SetupTests(unittest.TestCase):
    def test_selected_model_downloads_only_its_pinned_weights_and_checksum(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            selected = setup.MODELS["lfm2.5-8b-a1b"]
            with patch.object(setup, "ROOT", root), patch("sys.argv", ["setup_runtime.py", "--model", "lfm2.5-8b-a1b", "--precision", "Q4_K_M"]), \
                 patch.object(setup, "runtime_platform", return_value="linux-x64"), \
                 patch.object(setup, "download") as download, patch.object(setup, "install_archive"):
                setup.main()
            weight_calls = [call for call in download.call_args_list if call.args[1].suffix == ".gguf"]
            self.assertEqual(len(weight_calls), 1)
            url, destination, digest = weight_calls[0].args
            self.assertIn(selected["repository"] + "/resolve/" + selected["revision"] + "/", url)
            self.assertEqual(destination.name, "LFM2.5-8B-A1B-Q4_K_M.gguf")
            self.assertEqual(digest, selected["variants"]["Q4_K_M"]["sha256"])

    def archive(self, path, entries):
        with tarfile.open(path, "w") as bundle:
            for name, contents in entries:
                entry = tarfile.TarInfo(name)
                entry.size = len(contents)
                entry.mode = 0o755
                bundle.addfile(entry, io.BytesIO(contents))

    @unittest.skipIf(os.name == "nt", "Windows locks open files; versioned installers avoid replacement")
    def test_reinstall_keeps_existing_mapped_files_intact_and_preserves_executable_mode(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            destination = root / "installed"
            library = destination / "build/lib.so"
            library.parent.mkdir(parents=True)
            library.write_bytes(b"old library")
            archive = root / "runtime.tar"
            self.archive(archive, [("build/lib.so", b"new library"), ("build/llama-server", b"new server")])
            with library.open("rb") as mapped:
                setup.install_archive(archive, destination)
                self.assertEqual(mapped.read(), b"old library")
            self.assertEqual(library.read_bytes(), b"new library")
            self.assertTrue((destination / "build/llama-server").stat().st_mode & 0o111)

    def test_rejected_archive_does_not_publish_partial_runtime(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            destination = root / "installed"
            destination.mkdir()
            library = destination / "lib.so"
            library.write_bytes(b"old library")
            archive = root / "runtime.tar"
            self.archive(archive, [("lib.so", b"new library"), ("../../escaped.so", b"invalid")])
            with self.assertRaises(tarfile.FilterError):
                setup.install_archive(archive, destination)
            self.assertEqual(library.read_bytes(), b"old library")

    @unittest.skipIf(os.name == "nt", "Windows locks open files; versioned installers avoid replacement")
    def test_zip_install_publishes_new_files_without_truncating_mapped_ones(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            destination = root / "installed"
            library = destination / "lib.dll"
            library.parent.mkdir(parents=True)
            library.write_bytes(b"old library")
            archive = root / "runtime.zip"
            with ZipFile(archive, "w") as bundle:
                bundle.writestr("lib.dll", b"new library")
                bundle.writestr("llama-server.exe", b"new server")
            with library.open("rb") as mapped:
                setup.install_archive(archive, destination)
                self.assertEqual(mapped.read(), b"old library")
            self.assertEqual(library.read_bytes(), b"new library")
            self.assertTrue((destination / "llama-server.exe").is_file())

    def test_zip_traversal_is_rejected_before_publishing(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            destination = root / "installed"
            destination.mkdir()
            library = destination / "lib.dll"
            library.write_bytes(b"old library")
            archive = root / "runtime.zip"
            with ZipFile(archive, "w") as bundle:
                bundle.writestr("lib.dll", b"new library")
                bundle.writestr("../../escaped.dll", b"invalid")
            with self.assertRaisesRegex(RuntimeError, "Caminho inválido"):
                setup.install_archive(archive, destination)
            self.assertEqual(library.read_bytes(), b"old library")

    def test_platform_matrix_rejects_arm64_and_32_bit(self):
        with patch.object(setup.platform, "system", return_value="Windows"), \
             patch.object(setup.platform, "machine", return_value="AMD64"), \
             patch.object(setup.struct, "calcsize", return_value=8), \
             patch.dict(setup.os.environ, {}, clear=True):
            self.assertEqual(setup.runtime_platform(), "windows-x64")
        with patch.object(setup.platform, "system", return_value="Windows"), \
             patch.object(setup.platform, "machine", return_value="ARM64"), \
             patch.object(setup.struct, "calcsize", return_value=8):
            with self.assertRaisesRegex(RuntimeError, "ARM64"):
                setup.runtime_platform()
        with patch.object(setup.platform, "system", return_value="Windows"), \
             patch.object(setup.platform, "machine", return_value="AMD64"), \
             patch.object(setup.struct, "calcsize", return_value=4):
            with self.assertRaisesRegex(RuntimeError, "64 bits"):
                setup.runtime_platform()
        with patch.object(setup.platform, "system", return_value="Darwin"), \
             patch.object(setup.platform, "machine", return_value="x86_64"), \
             patch.object(setup.struct, "calcsize", return_value=8):
            with self.assertRaisesRegex(RuntimeError, "Linux x86_64 ou Windows x64"):
                setup.runtime_platform()

    def test_windows_runtime_is_versioned_and_reused_by_ready_marker(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            installed = []

            def fake_install(_archive, destination):
                destination.mkdir(parents=True, exist_ok=True)
                (destination / "llama-server.exe").write_bytes(b"server")
                installed.append(destination)

            with patch.object(setup, "ROOT", root), patch.object(setup, "download"), \
                 patch.object(setup, "install_archive", side_effect=fake_install):
                first = setup.install_windows_runtime("cpu")
                second = setup.install_windows_runtime("cpu")
            self.assertEqual(first, second)
            self.assertEqual(len(installed), 1)
            self.assertTrue((first / ".ready").is_file())
            self.assertTrue(first.name.startswith(f"llama-cpu-{setup.LOCK['llamaCpp']['tag']}-"))

    def test_windows_runtime_rejects_an_archive_without_the_server(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)

            def fake_install(_archive, destination):
                destination.mkdir(parents=True, exist_ok=True)
                (destination / "ggml.dll").write_bytes(b"library")

            with patch.object(setup, "ROOT", root), patch.object(setup, "download"), \
                 patch.object(setup, "install_archive", side_effect=fake_install):
                with self.assertRaisesRegex(RuntimeError, "não contém llama-server.exe"):
                    setup.install_windows_runtime("cpu")
            self.assertFalse((root / ".runtime/runtimes").exists() and any((root / ".runtime/runtimes").iterdir()))

    def test_windows_runtime_never_removes_an_unmarked_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            installed = []

            def fake_install(_archive, destination):
                destination.mkdir(parents=True, exist_ok=True)
                (destination / "llama-server.exe").write_bytes(b"server")
                installed.append(destination)

            with patch.object(setup, "ROOT", root), patch.object(setup, "download"), \
                 patch.object(setup, "install_archive", side_effect=fake_install):
                first = setup.install_windows_runtime("cpu")
                (first / ".ready").unlink()
                with self.assertRaisesRegex(RuntimeError, "sem .ready"):
                    setup.install_windows_runtime("cpu")
            self.assertEqual(len(installed), 1)

    def test_windows_main_prepares_both_backends_with_zip_assets(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with patch.object(setup, "ROOT", root), patch.object(setup, "runtime_platform", return_value="windows-x64"), \
                 patch.object(setup, "install_windows_runtime") as install, patch.object(setup, "download"), \
                 patch("sys.argv", ["setup_runtime.py", "--backend", "auto", "--precision", "Q4_K_M"]):
                setup.main()
            self.assertEqual([call.args[0] for call in install.call_args_list], ["cuda", "cpu"])
            packages, suffix = setup.runtime_packages("windows-x64", "cuda")
            self.assertEqual(suffix, ".zip")
            self.assertTrue(packages[0][0]["url"].endswith("win-cuda-12.4-x64.zip"))


if __name__ == "__main__": unittest.main()

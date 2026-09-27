import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("setup_runtime", Path(__file__).resolve().parents[1] / "scripts/setup_runtime.py")
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)


class SetupTests(unittest.TestCase):
    def test_selected_model_downloads_only_its_pinned_weights_and_checksum(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            selected = setup.MODELS["lfm2.5-8b-a1b"]
            with patch.object(setup, "ROOT", root), patch("sys.argv", ["setup_runtime.py", "--model", "lfm2.5-8b-a1b", "--precision", "Q4_K_M"]), \
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


if __name__ == "__main__": unittest.main()

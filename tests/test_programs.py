# SPDX-License-Identifier: Apache-2.0
"""Tests of the programs embedded in the `vu` binary (`vu hf`, `vu compile`), run with the runtime's interpreter:

    <prefix>/bin/python3 -m unittest discover -s tests
"""

import http.server
import importlib.util
import os
import subprocess
import sys
import tempfile
import threading
import unittest
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, os.path.join(ROOT, "crates/vu-runtime/py", filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


hf = load("vu_hf", "hf.py")
compiler = load("vu_compile", "compile.py")
COMMIT = "a" * 40


class Hub(http.server.BaseHTTPRequestHandler):
    requests = []

    def do_GET(self):  # noqa: N802 - http.server API
        Hub.requests.append((self.path, self.headers.get("Authorization")))
        if self.path.endswith("/missing"):
            self.send_response(404)
            self.end_headers()
            return
        body = b"weights"
        self.send_response(200)
        self.send_header("x-repo-commit", COMMIT)
        self.send_header("x-linked-etag", '"deadbeef01"')
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


class HfTests(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp()
        Hub.requests = []
        self.server = http.server.HTTPServer(("127.0.0.1", 0), Hub)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.endpoint = "http://127.0.0.1:%d" % self.server.server_port

    def tearDown(self):
        self.server.shutdown()

    def env(self, **extra):
        return {"HF_HOME": os.path.join(self.home, "hf"), "HF_ENDPOINT": self.endpoint, **extra}

    def test_defaults_follow_huggingface_hub(self):
        self.assertEqual(hf.resolve({}, "/h")["hubCache"], "/h/.cache/huggingface/hub")
        self.assertEqual(hf.resolve({"XDG_CACHE_HOME": "/x"}, "/h")["home"], "/x/huggingface")
        self.assertEqual(hf.resolve({"HF_HUB_CACHE": "/c"}, "/h")["hubCache"], "/c")

    def test_token_precedence_and_it_is_never_reported(self):
        os.makedirs(os.path.join(self.home, ".cache/huggingface"))
        with open(os.path.join(self.home, ".cache/huggingface/token"), "w") as handle:
            handle.write("hf_file\n")
        self.assertEqual(hf.read_token({}, self.home), ("hf_file", "file"))
        self.assertEqual(hf.read_token({"HF_TOKEN": "hf_env"}, self.home)[1], "HF_TOKEN")
        report = repr(hf.resolve({"HF_TOKEN": "hf_secret"}, self.home))
        self.assertNotIn("hf_secret", report)

    def test_repository_ids_are_validated(self):
        self.assertEqual(hf.repo_folder("org/name"), "models--org--name")
        with self.assertRaises(ValueError):
            hf.repo_folder("../etc/passwd")

    def test_download_writes_the_hub_layout_and_the_second_call_is_cached(self):
        env = self.env(HF_TOKEN="hf_secret")
        first = hf.download_file("org/model", "dir/config.json", env=env)
        self.assertFalse(first["cached"])
        self.assertEqual(Hub.requests[0], ("/org/model/resolve/main/dir/config.json", "Bearer hf_secret"))
        folder = os.path.join(self.home, "hf/hub/models--org--model")
        with open(os.path.join(folder, "refs/main")) as handle:
            self.assertEqual(handle.read(), COMMIT)
        self.assertTrue(os.path.islink(first["path"]))
        self.assertEqual(os.readlink(first["path"]), "../../../blobs/deadbeef01")
        with open(first["path"]) as handle:
            self.assertEqual(handle.read(), "weights")
        second = hf.download_file("org/model", "dir/config.json", env=env)
        self.assertTrue(second["cached"])
        self.assertEqual(len(Hub.requests), 1)

    def test_offline_refuses_to_fetch(self):
        with self.assertRaises(RuntimeError):
            hf.download_file("org/model", "x", env=self.env(HF_HUB_OFFLINE="1"))

    def test_main_status_json_does_not_print_the_token(self):
        out = subprocess.run(
            [sys.executable, os.path.join(ROOT, "crates/vu-runtime/py/hf.py"), "status", "--json"],
            env={**os.environ, "HF_HOME": self.home, "HF_TOKEN": "hf_secret"},
            capture_output=True,
            text=True,
        )
        self.assertEqual(out.returncode, 0)
        self.assertNotIn("hf_secret", out.stdout)
        self.assertIn('"present": true', out.stdout)


class CompileTests(unittest.TestCase):
    def setUp(self):
        self.work = tempfile.mkdtemp()
        self.app = os.path.join(self.work, "app", "pkg")
        os.makedirs(self.app)
        with open(os.path.join(self.app, "__init__.py"), "w") as handle:
            handle.write("def main():\n    print('hello from zipapp')\n")

    def test_byte_compilation_writes_unchecked_hash_pycs(self):
        self.assertEqual(compiler.compile_tree(os.path.join(self.work, "app"), 0), 0)
        cache = os.path.join(self.app, "__pycache__")
        pycs = [name for name in os.listdir(cache) if name.endswith(".pyc")]
        self.assertEqual(len(pycs), 1)
        with open(os.path.join(cache, pycs[0]), "rb") as handle:
            header = handle.read(16)
        # flags word 0b01: hash-based, not checked against the source
        self.assertEqual(int.from_bytes(header[4:8], "little") & 0b11, 0b01)

    def test_a_syntax_error_fails_the_compilation(self):
        with open(os.path.join(self.app, "bad.py"), "w") as handle:
            handle.write("def (:\n")
        self.assertEqual(compiler.compile_tree(os.path.join(self.work, "app"), 0), 1)

    def test_zipapp_is_executable_and_runs(self):
        output = os.path.join(self.work, "app.pyz")
        compiler.build_zipapp(os.path.join(self.work, "app"), "pkg:main", output, 0)
        with open(output, "rb") as handle:
            self.assertEqual(handle.readline(), b"#!/usr/bin/env -S vu python\n")
        with zipfile.ZipFile(output) as archive:
            names = archive.namelist()
        self.assertIn("__main__.py", names)
        self.assertTrue(any(name.endswith(".pyc") for name in names))
        result = subprocess.run([sys.executable, output], capture_output=True, text=True)
        self.assertEqual(result.stdout.strip(), "hello from zipapp")

    def test_main_requires_module_function_for_zipapp(self):
        self.assertEqual(compiler.main([os.path.join(self.work, "app"), "--zipapp"]), 64)


if __name__ == "__main__":
    unittest.main()

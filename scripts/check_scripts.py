"""Self-check for the two helper scripts: stdlib HTTP, no `requests`.

Starts a local HTTP server, then exercises `download_models.download` end to end:
a fresh download, a resume from a `.part` file, and the `416` skip path. The CUDA
script is only compiled (its payload is a 900 MB NVIDIA redist at a fixed URL).

Usage: python scripts/check_scripts.py
"""

import http.server
import importlib.util
import os
import shutil
import sys
import time
import threading

HERE = os.path.dirname(os.path.abspath(__file__))


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Handler(http.server.SimpleHTTPRequestHandler):
    """Serve `directory` and honour `Range` requests."""

    def log_message(self, *_args):
        pass

    def send_head(self):
        path = self.translate_path(self.path)
        if not os.path.isfile(path):
            self.send_error(404)
            return None
        size = os.path.getsize(path)
        start = 0
        header = self.headers.get("Range")
        if header and header.startswith("bytes="):
            start = int(header[6:].split("-")[0])
        if start >= size:
            self.send_response(416)
            self.send_header("Content-Range", f"bytes */{size}")
            self.end_headers()
            return None
        fileobj = open(path, "rb")
        fileobj.seek(start)
        self.send_response(206 if start else 200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(size - start))
        if start:
            self.send_header("Content-Range", f"bytes {start}-{size - 1}/{size}")
        self.end_headers()
        return fileobj


def main() -> int:
    models = load("download_models", "download_models.py")
    load("fetch_cuda_runtime", "fetch_cuda_runtime.py")  # import-only compile check

    # Scratch inside the package (writable in a confined shell), not %TEMP%.
    scratch = os.path.join(os.path.dirname(HERE), "state", "tmp")
    os.makedirs(scratch, exist_ok=True)
    workdir = os.path.join(scratch, f"scripts-check-{os.getpid()}-{int(time.time())}")
    served = os.path.join(workdir, "served", "repo", "resolve", "main")
    os.makedirs(os.path.join(served, "models"), exist_ok=True)
    payload = bytes(range(256)) * 8192  # 2 MiB
    with open(os.path.join(served, "models", "sample.gguf"), "wb") as handle:
        handle.write(payload)

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), lambda *a, **k: Handler(*a, directory=os.path.join(workdir, "served"), **k))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_address[1]}"

    results = []

    def check(name, ok, detail=""):
        results.append(ok)
        print(f"{'PASS' if ok else 'FAIL'}  {name}{' — ' + detail if detail else ''}")

    try:
        target = os.path.join(workdir, "out", "sample.gguf")
        models.download("repo", "models/sample.gguf", target, "", base_url=base)
        check("fresh download writes the whole file", os.path.getsize(target) == len(payload))

        # Resume: keep the first 512 KiB in a .part file and verify the tail arrives.
        os.remove(target)
        part = target + ".part"
        with open(part, "wb") as handle:
            handle.write(payload[: 512 * 1024])
        models.download("repo", "models/sample.gguf", target, "", base_url=base)
        with open(target, "rb") as handle:
            check("resume produces byte-identical output", handle.read() == payload)

        # 416 path: a complete .part must be promoted without another download.
        os.remove(target)
        with open(part, "wb") as handle:
            handle.write(payload)
        models.download("repo", "models/sample.gguf", target, "", base_url=base)
        check("a complete .part is promoted (416 skip)", os.path.getsize(target) == len(payload))
    finally:
        server.shutdown()
        shutil.rmtree(workdir, ignore_errors=True)

    failed = results.count(False)
    print(f"\n{len(results) - failed}/{len(results)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

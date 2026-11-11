"""Fetch the CUDA 13 runtime DLLs required by the audio.cpp CUDA Windows release.

The v0.9.4 `cuda13.3` Windows release imports `cufft64_12.dll` (cuFFT 12.x ships
with CUDA 13), `cublas64_13.dll` / `cublasLt64_13.dll` and `cudart64_13.dll`.
Only the DLLs are copied, next to `audiocpp_cli.exe`, so the whole package stays
self-contained under `bin/audio.cpp/`.

Standard library only — no `requests`.

Usage:
    python scripts/fetch_cuda_runtime.py [--proxy URL] [--no-proxy] [--dest DIR]
"""

import argparse
import io
import json
import os
import shutil
import urllib.request
import zipfile

REDIST = "https://developer.download.nvidia.com/compute/cuda/redist"
CUDA_VERSION = "13.3.0"
DEFAULT_PROXY = os.environ.get("DSH_PROXY", "http://127.0.0.1:7890")

# redist component -> DLLs copied into the audio.cpp bin directory
COMPONENTS = {
    "cuda_cudart": ["cudart64_13.dll"],
    "libcufft": ["cufft64_12.dll"],
    "libcublas": ["cublas64_13.dll", "cublasLt64_13.dll"],
}


def repo_root() -> str:
    # scripts/ lives at the repository root, so one level up is enough.
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def opener_for(proxy: str):
    if proxy:
        handler = urllib.request.ProxyHandler({"http": proxy, "https": proxy})
    else:
        handler = urllib.request.ProxyHandler({})
    return urllib.request.build_opener(handler)


def fetch(url: str, proxy: str, timeout: float) -> bytes:
    request = urllib.request.Request(url)
    with opener_for(proxy).open(request, timeout=timeout) as response:
        return response.read()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--proxy", default=DEFAULT_PROXY)
    parser.add_argument("--no-proxy", action="store_true", help="忽略代理设置（含 DSH_PROXY）")
    parser.add_argument("--dest", default=os.path.join(repo_root(), "bin", "audio.cpp"))
    args = parser.parse_args()

    proxy = "" if args.no_proxy else args.proxy
    manifest = json.loads(fetch(f"{REDIST}/redistrib_{CUDA_VERSION}.json", proxy, 60))
    os.makedirs(args.dest, exist_ok=True)

    for component, dlls in COMPONENTS.items():
        entry = manifest[component]["windows-x86_64"]
        url = f"{REDIST}/{entry['relative_path']}"
        print(f"[get] {component}: {url} ({int(entry['size']) / 1e6:.1f} MB)", flush=True)
        blob = fetch(url, proxy, 900)
        with zipfile.ZipFile(io.BytesIO(blob)) as archive:
            available = {
                os.path.basename(name).lower(): name
                for name in archive.namelist()
                if name.lower().endswith(".dll")
            }
            for dll in dlls:
                member = available.get(dll.lower())
                if member is None:
                    print(f"  !! {dll} 不在 {component} 压缩包里", flush=True)
                    continue
                target = os.path.join(args.dest, dll)
                if os.path.exists(target) and os.path.getsize(target) > 0:
                    print(f"  == {target} 已存在，跳过", flush=True)
                    continue
                with archive.open(member) as source, open(target, "wb") as destination:
                    shutil.copyfileobj(source, destination)
                print(f"  -> {target} ({os.path.getsize(target) / 1e6:.1f} MB)", flush=True)


if __name__ == "__main__":
    main()

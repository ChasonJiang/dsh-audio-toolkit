"""Download the audio.cpp GGUF models used by dsh-audio-toolkit.

Everything lands under `<repo>/bin/models`. Downloads go through an optional
local HTTP proxy and resume from a `.part` file.

Standard library only — no `requests` — so this runs in the bundled Python
runtime without extra installs.

Usage:
    python scripts/download_models.py [--proxy URL] [--no-proxy] [--models-dir PATH]
"""

import argparse
import os
import time
import urllib.error
import urllib.request

DEFAULT_PROXY = os.environ.get("DSH_PROXY", "http://127.0.0.1:7890")
HUGGINGFACE = "https://huggingface.co"

# (repo, remote path, local path under models dir)
FILES = [
    (
        "audio-cpp/audio.cpp-gguf",
        "IndexTTS2.5-GGUF/index-tts2_5-f16.gguf",
        "IndexTTS2.5-GGUF/index-tts2_5-f16.gguf",
    ),
    (
        "audio-cpp/audio.cpp-gguf",
        "IndexTTS2.5-GGUF/index-tts2_5-q8_0.gguf",
        "IndexTTS2.5-GGUF/index-tts2_5-q8_0.gguf",
    ),
    (
        "FunAudioLLM/SenseVoiceSmall-GGUF-audiocpp",
        "sensevoice-small-q8-audiocpp-v1.gguf",
        "SenseVoice-Small-GGUF/sensevoice-small-q8-audiocpp-v1.gguf",
    ),
    (
        "audio-cpp/audio.cpp-gguf",
        "PulseVAD-GGUF/pulsevad-2.1k-f32.gguf",
        "PulseVAD-GGUF/pulsevad-2.1k-f32.gguf",
    ),
]


def repo_root() -> str:
    # scripts/ lives at the repository root, so one level up is enough.
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def opener_for(proxy: str):
    """An opener that uses `proxy` when set, and no proxy (incl. env) otherwise."""
    if proxy:
        handler = urllib.request.ProxyHandler({"http": proxy, "https": proxy})
    else:
        handler = urllib.request.ProxyHandler({})
    return urllib.request.build_opener(handler)


def open_url(url: str, headers: dict, proxy: str):
    request = urllib.request.Request(url, headers=headers)
    return opener_for(proxy).open(request, timeout=120)


def human(size: float) -> str:
    for unit in ("B", "KiB", "MiB", "GiB"):
        if size < 1024 or unit == "GiB":
            return f"{size:.1f} {unit}"
        size /= 1024
    return f"{size:.1f} GiB"


def download(repo: str, remote: str, local: str, proxy: str, base_url: str = HUGGINGFACE) -> None:
    url = f"{base_url}/{repo}/resolve/main/{remote}"
    os.makedirs(os.path.dirname(local), exist_ok=True)
    part = local + ".part"
    pos = os.path.getsize(part) if os.path.exists(part) else 0
    headers = {"Range": f"bytes={pos}-"} if pos else {}
    try:
        response = open_url(url, headers, proxy)
    except urllib.error.HTTPError as error:
        if error.code == 416:  # nothing left to fetch
            os.replace(part, local)
            print(f"[skip] {local} 已完整")
            return
        raise

    with response:
        if pos and response.status != 206:
            pos = 0  # server ignored the range request
        mode = "ab" if pos else "wb"
        length = int(response.headers.get("Content-Length") or 0)
        total = length + pos
        print(f"[get ] {repo}/{remote}\n       -> {local} ({human(pos)} / {human(total)})", flush=True)
        done = pos
        last = 0.0
        with open(part, mode) as handle:
            while True:
                chunk = response.read(4 * 1024 * 1024)
                if not chunk:
                    break
                handle.write(chunk)
                done += len(chunk)
                now = time.time()
                if now - last > 5:
                    percent = (done / total * 100) if total else 0
                    print(f"       {human(done)} / {human(total)}  {percent:5.1f}%", flush=True)
                    last = now

    if total and os.path.getsize(part) != total:
        raise SystemExit(f"下载不完整：{part} {os.path.getsize(part)} != {total}")
    os.replace(part, local)
    print(f"[done] {local} {human(os.path.getsize(local))}", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--proxy", default=DEFAULT_PROXY)
    parser.add_argument("--no-proxy", action="store_true", help="忽略代理设置（含 DSH_PROXY）")
    parser.add_argument("--models-dir", default=os.path.join(repo_root(), "bin", "models"))
    parser.add_argument(
        "--only",
        default="",
        help="只下载文件名包含该子串的条目，例如 --only index-tts2_5-f16",
    )
    args = parser.parse_args()

    proxy = "" if args.no_proxy else args.proxy
    print(f"proxy={proxy or '(none)'}\nmodels_dir={args.models_dir}", flush=True)
    for repo, remote, relative in FILES:
        if args.only and args.only not in relative:
            continue
        local = os.path.join(args.models_dir, relative.replace("/", os.sep))
        if os.path.exists(local):
            print(f"[have] {local} ({human(os.path.getsize(local))})", flush=True)
            continue
        download(repo, remote, local, proxy)


if __name__ == "__main__":
    main()

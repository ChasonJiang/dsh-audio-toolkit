# dsh-audio-toolkit

Local **TTS and ASR for DeepSeek Harness (DSH)**, backed by a resident
[audio.cpp](https://github.com/0xShug0/audio.cpp) engine.

[中文说明](#中文说明)

- **7 native tools** (`audio_toolkit_tts_speak`, `audio_toolkit_asr_transcribe`, …) — no MCP naming prefix
- **Resident engine**: weights load once; warm TTS ≈0.6 s, ASR RTF ≈0.006
- **Sentence-level timestamps** (VAD segmentation) and **any audio container** (ffmpeg auto-transcode)
- Configured from the DSH plugin panel; edits apply without a restart

## What is (and is not) in this repository

| Path | Tracked | Contents |
|---|---|---|
| `src/`, `mcp/`, `scripts/` | yes | The plugin (this repository **is** the npm package) |
| `audio.cpp/` | no (git-ignored) | Optional upstream checkout for development — **not needed to run** |
| `bin/`, `voices/`, `audio_samples/` | no (git-ignored) | Local runtime assets: release binaries, models, voice references, dev fixtures |

Binaries and model weights are **not** distributed here. You provide them (see below).

## Requirements

| Requirement | Notes |
|---|---|
| Windows x64 + NVIDIA GPU | Primary target (audio.cpp also ships other platform builds) |
| Node.js `^22.19` or `>=24` | Declared in `engines` |
| DeepSeek Harness | Tested against DSH `0.2.2-rc.1` desktop (nightly channel) |
| [audio.cpp release](https://github.com/0xShug0/audio.cpp/releases) | `audiocpp_server.exe` + `audiocpp_cli.exe` + DLLs → `bin/audio.cpp/` (Apache-2.0) |
| GGUF models | IndexTTS2.5 fp16 (≈4.5 GB), SenseVoice-Small q8 (≈254 MB), PulseVAD (≈81 KB) → `bin/models/` |
| ffmpeg | Optional; needed for non-WAV or non-16 kHz-mono input |

Model files and their licences are the responsibility of the user; the download helper
(`scripts/download_models.py`) fetches them from Hugging Face.

## Install

**A. From npm (recommended once published)**

```text
plugin_manager(action="install_bundle", target="dsh-audio-toolkit@0.7.0")
```

**B. From a local checkout (development)**

```text
plugin_manager(action="install_bundle", target="link:<absolute path to this repo>")
```

**C. From a clone** — clone this repo and use B against the clone root. Because the
package sits at the repository root, `github:<owner>/dsh-audio-toolkit` install specs work too.

If your binaries or models live elsewhere, set `binDir`, `modelsDir` and `ffmpegPath` in
the plugin panel — no file moves required.

## First run

1. Put the audio.cpp release in `bin/audio.cpp/` and the three GGUF files in `bin/models/`.
2. Enable the plugin, open its panel and press **启动引擎** (start engine).
3. `audio_toolkit_engine_status` → expect `install_ok: true` and `engine.running: true`.
4. Try `audio_toolkit_tts_speak` (needs a reference voice) or
   `audio_toolkit_asr_transcribe` (any audio file).

Full details — configuration fields, the tool contract, troubleshooting — are in
[docs/GUIDE.zh.md](docs/GUIDE.zh.md) (Chinese).

## Development

```bash
npm test            # syntax + unit tests; engine checks SKIP when bin/models are absent
npm run test:smoke  # end-to-end, needs the release, models and a GPU
npm run docs:contract  # regenerate the tool contract in docs/GUIDE.zh.md
```

CI runs the unit suite on Linux and Windows with Node 22 and 24; no binaries, models or
GPU are required there (see [.github/workflows/ci.yml](.github/workflows/ci.yml)).

## Security notes

- The engine listens on `127.0.0.1` **without authentication** — keep `engineHost` on loopback.
- `binDir`, `cliPath` and `ffmpegPath` select executables the plugin will run; only point
  them at trusted files.
- Tools may write to any absolute `output_path` the caller gives.

## Licence

Plugin code: **MIT** ([LICENSE](LICENSE)).
`audio.cpp` is Apache-2.0; each GGUF model keeps its upstream licence. No binaries or
weights are distributed in this repository.

---

## 中文说明

把 **audio.cpp** 的本地 TTS / ASR 接进 DeepSeek Harness：一个常驻引擎 + 一组原生工具
（`audio_toolkit_*`）+ 一个可在面板里配置的插件。引擎随 DSH 启停，权重只加载一次；
支持句级时间戳（VAD 切句）、任意音频格式（ffmpeg 自动转码）。

- **仓库不含**二进制、模型与测试音频：`bin/`、`voices/`、`audio_samples/` 均已 git 忽略。
- 顶层 `audio.cpp/` 只是上游检出，运行插件**不需要**它。
- 安装：`plugin_manager(action="install_bundle", target="link:<仓库路径>")`，
  或发布后使用 npm 包名；二进制/模型放到 `bin/audio.cpp` 与 `bin/models`，或用面板改路径。
- 详细文档（配置字段、工具契约、排障）：[docs/GUIDE.zh.md](docs/GUIDE.zh.md)。
- 许可证：插件 MIT；audio.cpp 为 Apache-2.0；模型遵循各自的上游许可。

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
| Windows x64 + NVIDIA GPU | Primary target; Linux/macOS builds (CPU/Vulkan/Metal/ROCm) are selectable in the panel |
| Node.js `^22.19` or `>=24` | Declared in `engines` |
| DeepSeek Harness | Tested against DSH `0.2.2-rc.1` desktop (nightly channel) |
| [audio.cpp release](https://github.com/0xShug0/audio.cpp/releases) | Downloaded automatically on first start (Apache-2.0) |
| GGUF models | IndexTTS2.5 fp16 (≈4.5 GB), SenseVoice-Small q8 (≈254 MB), PulseVAD (≈81 KB) — also automatic |
| ffmpeg | Optional; needed for non-WAV or non-16 kHz-mono input |
| Disk + network | ≈6 GB once, on the first engine start |

The release and the models are fetched into `~/.dsh/audio-toolkit` (`assetsDir` overrides
it; `link:` installs use the repository's own `bin/`). Model licences are the user's
responsibility; the downloader honours `HF_ENDPOINT` and falls back to `hf-mirror.com` when
Hugging Face is unreachable.

## Install

Any of these works; nothing has to be placed by hand.

```text
plugin_manager(action="install_bundle", target="github:<owner>/dsh-audio-toolkit")
plugin_manager(action="install_bundle", target="dsh-audio-toolkit@0.8.0")
plugin_manager(action="install_bundle", target="link:<absolute path to this repo>")
```

**A. From Git / npm** — the package ships only code. The plugin panel shows a
**Runtime assets** card: status, what is missing, install options (runtime / models, target platform and backend) and,
once you press **Install missing assets**, a live progress bar with cancel. The release archive is chosen for the selected platform/backend. Assets go to
`~/.dsh/audio-toolkit` (≈6 GB, once); set `assetsProxy` if your network needs one, and
`assetsDir` to reuse an existing install. Nothing is downloaded without your click unless
you turn on `assetsAutoDownload`.

**B. From a local checkout** — `link:` installs use the repository's own `bin/`, so an
existing 6 GB install is reused as-is.

Already have the assets somewhere else? Point `assetsDir` at that directory in the panel;
`binDir` / `modelsDir` still override individual paths.

## First run

1. Enable the plugin and open its panel. In **Runtime assets** press **Install missing
   assets** (pick runtime and/or models) — the card shows progress and the installed size.
2. Press **启动引擎** (start engine). `audio_toolkit_engine_status` should report
   `assets.ready: true`, `install_ok: true`, `engine.running: true`.
3. Try `audio_toolkit_tts_speak` (needs a reference voice) or
   `audio_toolkit_asr_transcribe` (any audio file).

Full details — configuration fields, the tool contract, troubleshooting — are in
[docs/GUIDE.zh.md](docs/GUIDE.zh.md) (Chinese).

## Development

```bash
npm test            # syntax + unit + asset-bootstrap tests; engine checks SKIP without bin/models
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

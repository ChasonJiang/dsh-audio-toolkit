# dsh-audio-toolkit

Local **TTS and ASR for DeepSeek Harness (DSH)**, backed by a resident
[audio.cpp](https://github.com/0xShug0/audio.cpp) engine.

[中文说明](#中文说明)

- **7 native tools** (`audio_toolkit_tts_speak`, `audio_toolkit_asr_transcribe`, …) — no MCP naming prefix
- **Resident engine**: weights load once; warm TTS ≈0.6 s, ASR RTF ≈0.006
- **Sentence-level timestamps** (VAD segmentation) and **any audio container** (ffmpeg auto-transcode)
- **Panel-driven setup**: the first open shows only a setup guide; everything else appears after the
  runtime assets are in place

## What is (and is not) in this repository

| Path | Tracked | Contents |
|---|---|---|
| `src/`, `mcp/`, `scripts/` | yes | The plugin (this repository **is** the npm package) |
| `audio.cpp/` | no (git-ignored) | Optional upstream checkout for development — **not needed to run** |
| `bin/`, `voices/`, `audio_samples/` | no (git-ignored) | Local runtime assets: release binaries, models, voice references, dev fixtures |

Binaries and model weights are **not** distributed here; the panel installs them into a
per-user directory on first use.

## Requirements

| Requirement | Notes |
|---|---|
| Windows x64 + NVIDIA GPU | Primary target; Linux/macOS builds (CPU/Vulkan/Metal/ROCm) are selectable in the panel |
| Node.js `^22.19` or `>=24` | Declared in `engines` |
| DeepSeek Harness | Tested against DSH `0.2.2-rc.1` desktop (nightly channel) |
| [audio.cpp release](https://github.com/0xShug0/audio.cpp/releases) | Installed by the panel (Apache-2.0) |
| GGUF models | IndexTTS2.5 fp16 (≈4.5 GB), SenseVoice-Small q8 (≈254 MB), PulseVAD (≈81 KB) — same |
| ffmpeg | **Required.** Installed by the panel on Windows (≈110 MB) and macOS (osxexperts arm64/intel builds); on Linux install it first (package manager / PATH) |
| Disk + network | ≈6.1 GB once, only when you press **Install missing assets** (ffmpeg included) |

The release, models and ffmpeg land in `~/.dsh/audio-toolkit` (`assetsDir` overrides it;
`link:` installs use the repository's own `bin/`). Model licences are the user's
responsibility; the downloader honours `HF_ENDPOINT` and falls back to `hf-mirror.com` when
Hugging Face is unreachable.

## Install

Any of these works; nothing has to be placed by hand.

```text
plugin_manager(action="install_bundle", target="github:<owner>/dsh-audio-toolkit")
plugin_manager(action="install_bundle", target="dsh-audio-toolkit@0.8.0")
plugin_manager(action="install_bundle", target="link:<absolute path to this repo>")
```

**A. From Git / npm** — the package ships only code. On the first open the panel shows
**only** a setup guide:

1. choose **Install automatically** (recommended) or **Download manually**;
2. automatic: press **Install missing assets** on the card — live progress, cancel, target
   platform/backend, optional proxy (off by default); Windows and macOS also install ffmpeg, and
   the install fails if ffmpeg cannot be obtained (it is required for transcoding);
3. manual: the guide shows the release archive that matches the current platform / arch /
   backend (e.g. `audio-vX-bin-ubuntu-x64-cpu.tar.gz`; `chmod +x audiocpp_server` on POSIX;
   the matching `cudart` for CUDA), where the three models and ffmpeg go, plus an `assetsDir`
   field and **Refresh**.

Nothing is downloaded until you press the install button. Once the assets are ready the guide
disappears and the normal settings appear; the assets row collapses to
`✓ Ready · size · [Delete assets]`. Deleting stops the engine and removes the managed
directories, then the guide returns.

**B. From a local checkout** — `link:` installs use the repository's own `bin/`, so an
existing install is reused as-is.

Proxy, mirror and reuse notes:

- proxy is **opt-in** and configured only in the first-run guide: `assetsProxyEnabled` must be on\n  before `assetsProxy` is used (the fields are not shown in the settings list);
- Hugging Face is often unreachable from mainland China — the downloader falls back to
  `hf-mirror.com`, or set `HF_ENDPOINT` yourself;
- already have the assets? point `assetsDir` at that directory and press **Refresh**.

The derived paths (`binDir`, `cliPath`, `modelsDir`, `ttsModel`, `asrModel`, `asrVadModel`,
`ffmpegPath`, `assetsApiPort`) are no longer shown in the panel; they still exist in the
config, so old configs and the MCP server keep working.

## First run

1. Enable the plugin and open its panel. Pick **automatic** or **manual**, then install /
   place the assets (the card reports progress and the installed size).
2. Press **启动引擎** (start engine). `audio_toolkit_engine_status` should report
   `assets.ready: true`, `install_ok: true`, `engine.running: true`.
3. Try `audio_toolkit_tts_speak` (needs a reference voice) or
   `audio_toolkit_asr_transcribe` (any audio file; relative paths resolve against the
   session working directory).

Full details — configuration fields, the tool contract, troubleshooting — are in
[docs/GUIDE.zh.md](docs/GUIDE.zh.md) (Chinese).

## Development

```bash
npm test            # syntax + unit + API + asset-bootstrap tests; engine checks SKIP without assets
npm run test:smoke  # end-to-end, needs the release, models and a GPU
npm run docs:contract  # regenerate the tool contract in docs/GUIDE.zh.md
```

The suite currently covers config 75, client 33, http 15, api 10 and assets 37 checks; CI runs
it on Linux and Windows with Node 22 and 24, without binaries, models or a GPU
(see [.github/workflows/ci.yml](.github/workflows/ci.yml)).

## Security notes

- The engine listens on `127.0.0.1` **without authentication** — keep `engineHost` on loopback.
- The asset service also binds `127.0.0.1` and only accepts install/delete calls from the DSH
  UI origin.
- `binDir`, `cliPath` and `ffmpegPath` select executables the plugin will run; only point
  them at trusted files.
- Tools may write to any absolute `output_path` the caller gives.

## Licence

Plugin code: **MIT** ([LICENSE](LICENSE)).
`audio.cpp` is Apache-2.0; each GGUF model and ffmpeg keep their upstream licences. No
binaries or weights are distributed in this repository.

---

## 中文说明

把 **audio.cpp** 的本地 TTS / ASR 接进 DeepSeek Harness：一个常驻引擎 + 一组原生工具
（`audio_toolkit_*`）+ 一个可在面板里配置的插件。引擎随 DSH 启停，权重只加载一次；
支持句级时间戳（VAD 切句）、任意音频格式（ffmpeg 自动转码）。

- **首次打开只有安装引导**：选「自动安装」或「手动下载」；依赖就绪前不显示其他配置项。
- **自动安装**：点「安装所缺依赖」才下载（约 6.1 GB，Windows 含 ffmpeg），带进度与取消，
  可选平台/后端；代理默认关闭，勾选「使用代理下载」后才生效。
- **手动下载**：卡片给出放置路径与 `assetsDir` 输入，放好后点「刷新状态」。
- **安装完成**：引导与安装控件消失，只剩 `✓ 已就绪 · 体积 · [删除依赖]`；删除会先停引擎再删目录。
- **仓库不含**二进制、模型与测试音频：`bin/`、`voices/`、`audio_samples/` 均已 git 忽略；
  顶层 `audio.cpp/` 只是上游检出，运行插件不需要它。
- 派生路径（`binDir` / `modelsDir` / `ttsModel` … ）不再显示在面板，但仍可通过配置文件或
  MCP 覆盖；旧配置照常可用。
- 详细文档（配置字段、工具契约、排障）：[docs/GUIDE.zh.md](docs/GUIDE.zh.md)。
- 许可证：插件 MIT；audio.cpp 为 Apache-2.0；模型与 ffmpeg 遵循各自的上游许可。

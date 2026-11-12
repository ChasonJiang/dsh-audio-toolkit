# Changelog

All notable changes to this project are documented here. The package version lives in
`dsh-audio-toolkit/package.json` and is the single source of truth (`TOOLKIT_VERSION`).

## 0.8.1

### Fixed

- **macOS inference backend.** The panel and Config schema only offered
  `cuda/cpu/vulkan`, and the default was always `cuda`, so a Mac could not select
  `metal` and a profile copied from Windows made the engine fail at startup. The
  backend list is now platform-aware (Windows CUDA/CPU/Vulkan, macOS Metal/CPU,
  Linux CUDA/CPU/Vulkan/ROCm), the default follows the host, and an unsupported
  saved value falls back to the platform default with a warning in `host.log`.
- **macOS/Linux automatic install.** The panel disabled "安装所缺依赖" outside
  Windows and told the user automatic install was Windows-only, although the asset
  layer supported all three platforms. The install button now follows the actual
  platform support, and the install checkboxes (`audio.cpp runtime` / `GGUF
  models`) are honoured instead of always downloading everything.
- **macOS ffmpeg provisioning.** The panel sends release tokens (`macos`) while
  the installer compared against host tokens (`darwin`), so `ffmpegSourceUrl()`
  returned an empty URL and the install failed with "Linux 不提供内置构建".
  Platform tokens are normalized in both directions.
- **POSIX executable bit.** A `.tar.gz` release extracted with `writeFileSync`
  landed as `0644`, so the engine died with `EACCES` after a "successful" install.
  tar modes are preserved and `audiocpp_server` / `audiocpp_cli` are explicitly
  made executable on POSIX.
- **ffmpeg path resolution** now looks for the platform binary (`ffmpeg` vs
  `ffmpeg.exe`) when a directory is configured, and the CLI runner uses the
  platform PATH separator instead of a hard-coded `;`.
- **Tool calls that never returned.** A JSON-RPC request whose dispatch threw
  outside the handler (config read, serialization) produced no response at all, so
  the client waited for its timeout. Dispatch now always answers, results are
  serialized defensively, and both the MCP server and the native host tools run
  every call under a watchdog derived from `toolCallTimeoutMs` plus a grace period.
- **Engine lifecycle races.** Boot auto-start, the panel's start button, a
  config-driven restart and plugin disposal could run concurrently on the first
  launch, spawning two servers on one port and orphaning one. Start/stop/restart
  are now serialized; `engineAutoStart` also actually overrides a stale
  `engineEnabled: false` (the boot call was previously vetoed by it).
- **Health-check hangs.** `engine.start()` / `stop()` could await `/health`
  forever when the peer closed mid-response or trickled bytes; the HTTP check now
  settles on error/abort/close and enforces an overall deadline.
- The panel's asset poll and action requests have timeouts, so a busy host loop no
  longer leaves the card stuck on its loading state (the request deadline covers the
  body read too, not just the headers).
- **Delete assets** now also removes the managed `bin/ffmpeg` directory, not only
  `bin/audio.cpp` and `bin/models`.
- Concurrent TTS/ASR calls use unique scratch directories (`randomUUID`) and the
  engine log stream is ended on `close` with guarded writes, so two parallel calls
  cannot delete each other's converted audio and a late engine-exit footer cannot
  crash the host with `write after end`.

### Tests

- Backend/platform normalization, macOS install gating, stale-backend fallback,
  install-part selection, tar executable bits and health-check deadlines are
  covered in the offline suite; CI now also runs on macOS.

## 0.8.0

### Added

- **Panel-driven install.** The plugin panel shows a Runtime assets card with status, install
  options (runtime / models), a target **platform and backend**, live progress and cancel,
  backed by a loopback API on `assetsApiPort`. `assetsAutoDownload` defaults to off, so
  nothing is downloaded without a click.
- **Platform/backend-aware assets.** The release archive is chosen from the selected
  platform + backend: Windows `.zip`, Linux/macOS `.tar.gz`, plus the matching `cudart`
  archive for CUDA. Archive readers cover ZIP and tar.gz, and `audiocpp_server` /
  `audiocpp_cli` names follow the platform.
- `assetsDir`, `assetsAutoDownload`, `assetsProxy` and `assetsApiPort` config fields; every
  path field now defaults to "auto" instead of a machine-specific absolute path.
- Model downloads fall back to `hf-mirror.com` when `huggingface.co` is unreachable, and
  honour `HF_ENDPOINT`; downloads resume from `.part` files.
- `test/assets.mjs`: offline end-to-end test of target selection, download, ZIP/tar.gz
  extraction, resume, mirror fallback and the guards (31 checks).

### Changed

- ffmpeg binary name follows the platform (`ffmpeg` on POSIX, `ffmpeg.exe` on Windows).
- Automatic provisioning follows the panel `backend`; cross-platform installs are refused
  with an explanation instead of producing a half-working install.

### Fixed

- Fresh clones / CI resolved the asset root to the *parent* of the repository, because the
  package can sit at the repo root but has no `bin/` yet.
## 0.7.0

### Breaking

- Tool names now end in a verb: `audio_toolkit_tts` → `audio_toolkit_tts_speak`,
  `audio_toolkit_status` → `audio_toolkit_engine_status`, `audio_toolkit_submit` →
  `audio_toolkit_submit_tasks`, `audio_toolkit_jobs` → `audio_toolkit_job_status`,
  `audio_toolkit_cancel` → `audio_toolkit_cancel_jobs`.
- Parameter renames: `voice_ref` → `voice_path`, `out_path` → `output_path`,
  `save` → `save_to_file`, `enable_itn` → `normalize_text`, `include_text` → `return_text`,
  `dir` → `voice_dir`. `include_tags` and `keep_tags` were removed (transcripts are always plain text).

### Added

- ffmpeg auto-transcode for TTS reference audio and ASR input, with a configurable
  `ffmpegPath` (defaults to `bin/ffmpeg/ffmpeg.exe`, falls back to `PATH`).
- Sentence timestamps are documented as VAD segmentation (sentence level, not word level).
- Per-call `chunk_mode` / `chunk_seconds` for ASR.
- `audio_toolkit_engine_status` reports the effective ffmpeg and per-check paths only on failure.
- Tool contract generated from code (`scripts/tool_contract.mjs`, checked in CI).
- Windows-safe output folder names, log rotation, state-directory override.

### Changed

- Tool results are minimal: paths plus requested text, no echoed request or diagnostic fields.
- `maxConcurrentCalls` now also limits native TTS/ASR calls; control tools stay unbounded.

### Fixed

- Panel edits restart the engine with the live config instead of the config captured at load.
- HTTP timeouts cover the response body; pre-aborted signals never reach the network.
- Engine cancellation: `notifications/cancelled` aborts running tool calls; queued calls never start.
- `JobQueue.dispose()` persists its final snapshot.
- VAD silence falls back to one whole-file transcript instead of an empty result.
- `WAVE_FORMAT_EXTENSIBLE` / 24-bit / float WAV files decode in the sentence-timeline path.

## Earlier

Versions before 0.7.0 were developed in place without a published changelog.

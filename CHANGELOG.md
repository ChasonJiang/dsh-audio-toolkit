# Changelog

All notable changes to this project are documented here. The package version lives in
`dsh-audio-toolkit/package.json` and is the single source of truth (`TOOLKIT_VERSION`).

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

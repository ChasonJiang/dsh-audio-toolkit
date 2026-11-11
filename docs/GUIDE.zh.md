# dsh-audio-toolkit

把 **audio.cpp** 的本地 TTS / ASR 接进 DeepSeek Harness：一个**常驻引擎** + 一组**原生工具** + 一个 DSH 插件。
插件负责配置面板与引擎生命周期，工具真正干活时只是向常驻引擎发一次 HTTP 请求——不再"一次调用一个进程"。

```
DSH 侧栏「插件」→ 点开 dsh-audio-toolkit 卡片 → 配置区
   │  33 个可编辑字段，保存即生效（volatile）
   ▼
dsh-audio-toolkit 宿主插件（src/index.js）
   ├─ 注册 7 个原生工具 audio_toolkit_*
   ├─ 托管常驻引擎 audiocpp_server（子进程）
   │    · 随 DSH 启动（engineAutoStart）
   │    · 插件卸载 / DSH 退出时自动停止（ctx.effect 兜底）
   │    · 面板 engineEnabled / 启动引擎 / 停止引擎 手动启停
   └─ 发布解析后的配置到 state/config.json
   ▼
mcp/server.mjs（可选，给外部 MCP 客户端用）──HTTP──▶ audiocpp_server :8788
                                                      ├─ TTS: index_tts2 + IndexTTS2.5 **fp16**
                                                      └─ ASR: sense_asr  + SenseVoice-Small q8
```

> **为什么工具是原生的而不是 MCP？**
> `@deepseek-ai/dsh-mcp-client` 会把工具统一命名成 `mcp__<serverName>__<tool>`，无法得到
> `audio_toolkit_tts_speak` 这种精确名字。因此 DSH 里挂的是宿主原生工具（同一套 handler），
> 而 `mcp/server.mjs` 仍作为独立 MCP 服务保留：`node mcp/server.mjs` 可被任何 MCP 客户端接入。

| 目录 / 文件 | 作用 |
|---|---|
| `src/index.js` | 宿主插件：33 个扁平 `Config` 字段、引擎启停、状态发布 |
| `src/client.js` | 浏览器半边：在**插件页**注册配置区（`plugins.bundle.config`，key=包名）并渲染表单（手写 `__ModuleLoader__` bundle，无需构建） |
| `src/host-tools.js` | 原生工具定义：`audio_toolkit_tts_speak` 等 7 个，复用 `mcp/tools.mjs` 的 handler |
| `src/engine.js` | 常驻引擎管理器：启动、健康等待、端口释放、停止、重启、配置变更判定（启动时读取面板的最新配置） |
| `src/config.js` | 扁平配置归一化、`state/engine.json` 生成、状态文件读写 |
| `mcp/server.mjs` | 零依赖 MCP stdio 服务（JSON-RPC 2.0，支持 `notifications/cancelled`） |
| `mcp/engine.mjs` | 引擎 HTTP 客户端（speech / transcriptions / health / models）；超时覆盖整个响应体 |
| `mcp/tools.mjs` | 7 个工具实现 |
| `mcp/audiocpp.mjs` | 仅用于 `audio_status` 的 `--list-devices` 一次性 CLI 调用 |
| `mcp/slots.mjs` | 可取消的并发闸门：被取消的排队调用不会执行 |
| `mcp/transcode.mjs` | ffmpeg 转码：任意音频 → 16 kHz 单声道 WAV，含 ffmpeg 解析与临时文件清理 |
| `cordis.patch.yml` | bundle 补丁：插件配置行 + mcp-client 行 |
| `state/config.json` | 插件写、MCP 读的运行时配置（自动生成） |
| `state/engine.json` | 每次启动引擎时生成的 audiocpp_server 配置 |
| `state/engine.log` | 引擎日志（排障先看这里） |
| `test/config.mjs` | 配置/引擎配置/面板表单契约/原生工具/任务队列 |
| `test/client.mjs` | 浏览器半边的无头渲染测试（32 字段、控件与暂存值契约） |
| `test/http.mjs` | 网络层：超时覆盖响应体、已取消信号不发请求、取消正在执行的调用 |
| `test/smoke.mjs` | 端到端：起一个私有引擎→跑全部工具→停引擎→验证错误提示 |
| `scripts/tool_contract.mjs` | 从代码生成本文档的「工具契约」章节，并校验它与代码一致（`--write` / `--check`） |
| `scripts/download_models.py` | 拉取 GGUF 模型（可选代理，断点续传；纯标准库） |
| `scripts/fetch_cuda_runtime.py` | 拉取 CUDA 13 运行时 DLL 到 `bin/audio.cpp`（纯标准库） |
| `scripts/check_scripts.py` | 两个 Python 脚本的自检：起本地 HTTP 服务验证下载/续传/416，不依赖 `requests` |

二进制与模型不在包内，放在仓库 `./bin`：

```
bin/
  audio.cpp/                              # 官方 Windows CUDA 13.3 release + CUDA 13 运行时 DLL
  models/
    IndexTTS2.5-GGUF/index-tts2_5-f16.gguf # 4.2 GiB，默认
    IndexTTS2.5-GGUF/index-tts2_5-q8_0.gguf
    SenseVoice-Small-GGUF/sensevoice-small-q8-audiocpp-v1.gguf
    PulseVAD-GGUF/pulsevad-2.1k-f32.gguf
```

`./audio_samples` 只是开发期测试素材；正式音色放 `./voices`，或在面板里设「默认参考音色」。

---

## 一、插件面板怎么用

1. 侧栏点 **插件**（Plugins）。
2. 列表里找到 **`dsh-audio-toolkit`** 卡片，点开它的详情页。
3. 详情页里会出现 **配置区**（`data-plugin-config` 那一段）：
   - 顶部 **状态条**：引擎启停状态、端口、是否有未保存修改；
   - **启动引擎 / 停止引擎** 按钮（等价于把 `engineEnabled` 改成 true/false 再保存，当前状态下自动置灰）；
   - 六张 **分组卡片**（引擎 / MCP / audio.cpp / TTS / ASR / 输出），共 33 个字段；
   - 控件按类型选：**开关**（布尔）、**分段控件**（后端、语言、分块方式）、**数字输入 + 单位标签**（超时、端口、线程数、分块秒数）、**输入框**（路径/文本）、**输入框 + 分词标签**（extraArgs / session options）；
   - 每个字段显示中文名、真实配置键（等宽小字）与说明；被覆盖过的字段出现 **已覆盖** 标签和 **恢复默认** 按钮，非法输入就地提示。
4. 改完点 **保存**：配置写入 profile patch → 引擎按需重启/启停 → 工具下次调用即用新值。**不需要重启 DSH**。

> **为什么之前面板是空的**：DSH 插件页的配置区来自一个 **keyed slot `plugins.bundle.config`，key = 包名**；
> 页面上 `configured` 的判定就是 `ledger.bundles.has(pkg.name)`。只注册 `plugins.item`（官方插件列表）时，
> 第三方 bundle 的详情页不会渲染任何表单——现在两处都注册了。
>
> 只有 `.volatile()` 字段会出现在表单里，且 DSH 的表单模型只认**单段路径**，所以所有字段都是扁平的顶层键（`ttsModel`，而不是 `tts.model`）。

## 二、配置字段

| 字段 | 默认 | 说明 |
|---|---|---|
| `engineEnabled` | `true` | 引擎总开关：面板上的手动启停 |
| `engineAutoStart` | `true` | DSH 启动/插件启用时自动拉起引擎 |
| `engineHost` / `enginePort` | `127.0.0.1` / `8788` | 引擎监听地址与端口（被占用就改端口） |
| `mcpServerName` | `audio` | 独立 MCP 服务的 `serverInfo.name`；原生工具名固定为 `audio_toolkit_*` |
| `toolCallTimeoutMs` | `900000` | 单次引擎请求的超时（覆盖响应体读取） |
| `maxConcurrentCalls` | `2` | 并发上限：异步任务队列 + 原生 TTS/ASR 工具都受它约束 |
| `binDir` / `cliPath` / `modelsDir` | 自动 | audio.cpp 目录与可执行文件 |
| `ffmpegPath` | `<仓库>/bin/ffmpeg/ffmpeg`（Windows 为 `ffmpeg.exe`） | 转码用的 ffmpeg：可填可执行文件或所在目录；找不到时回退到 PATH 上的 `ffmpeg` |
| `backend` / `device` / `threads` | `cuda` / `0` / `0` | 后端与设备（改动会重启引擎；VAD 也跟随 device/threads） |
| `extraArgs` | 空 | 追加给 `audiocpp_server` 的启动参数（空格分隔，最后一个生效） |
| `ttsFamily` / `ttsModel` | `index_tts2` / **fp16 GGUF** | TTS 模型 |
| `ttsDefaultVoiceRef` | 空 | 默认参考音色；IndexTTS2.5 必须有参考音色 |
| `ttsVoiceDir` | `<仓库>/voices` | `audio_toolkit_tts_list_voices` 列这里的 wav |
| `ttsLanguage` / `ttsEmotion` / `ttsSessionOptions` | `auto` / 空 / 空 | 默认语言、默认情绪、额外 session option |
| `asrFamily` / `asrModel` / `asrVadModel` | `sense_asr` / q8 GGUF / PulseVAD | ASR 模型与 VAD |
| `asrChunkMode` / `asrChunkSeconds` | `fixed` / `30` | 分块策略；`auto/vad` 需要 VAD 且 16k 单声道输入 |
| `asrLanguage` / `asrEnableItn` | `auto` / `true` | 识别语言、逆文本规整 |
| `asrMinSegmentMs` / `asrMergeGapMs` | `300` / `400` | 句级时间戳：丢弃过短的 VAD 段、合并间隔过小的相邻段 |
| `outputFolder` | `audio_toolkit_outputs` | 输出文件夹**名称**，创建在当前会话工作目录下；引擎/临时文件在 `state/tmp` |

> 状态目录默认是包内的 `state/`。如果包装在只读位置（例如 `node_modules` 下），设置环境变量
> `AUDIO_TOOLKIT_STATE_DIR=<可写目录>` 即可，配置发布、引擎配置、日志和任务快照都会改到那里。
> `state/engine.log` 超过 8 MiB 会在下次启动时轮转为 `engine.log.1`（`--log` 没有级别开关，单个文件会一直长大）。

## 三、工具契约

> 下面的工具总表与各工具的参数/返回由 `scripts/tool_contract.mjs` 从 `mcp/tools.mjs`（工具、描述、参数）和 `src/host-tools.js`（DSH 侧命名）生成，**不要手改这一块**。
> 改完代码运行 `node scripts/tool_contract.mjs --write`；`npm test` 会校验它与代码是否一致。

<!-- BEGIN GENERATED:tool-contract -->
### 工具总表

| DSH 工具（`audio_toolkit_*`） | MCP 原始名 | 作用 |
|---|---|---|
| `audio_toolkit_tts_speak` | `tts_speak` | 文本→wav；支持情绪、语速、固定种子 |
| `audio_toolkit_asr_transcribe` | `asr_transcribe` | 音频→文本；默认只给路径，可选句级时间轴 |
| `audio_toolkit_tts_list_voices` | `tts_list_voices` | 列出可用的参考音色 wav |
| `audio_toolkit_engine_status` | `audio_status` | 引擎、模型、GPU 与配置的自检 |
| `audio_toolkit_submit_tasks` | `submit_tasks` | 异步批量提交，立即返回 job_id |
| `audio_toolkit_job_status` | `job_status` | 按 job_id 查进度与结果 |
| `audio_toolkit_cancel_jobs` | `cancel_jobs` | 取消排队或运行中的任务 |

### 参数与返回

#### `audio_toolkit_tts_speak` ／ MCP `tts_speak`

把文本合成为语音，返回生成的 wav 文件路径。音色由 voice_path 指向的参考音频决定；省略时使用部署配置的默认音色，两者都没有会报错。支持情绪、语速（duration_scale，大于 1 更慢）与固定随机种子。单次上限 2000 字符，更长的文本请拆成多次调用。引擎常驻，连续调用很快。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `text` | string | 是 | 要合成的文本；单次上限 2000 字符，超出会报错，请分段调用。 |
| `voice_path` | string | 否 | 参考音色的音频文件路径（绝对路径或相对会话工作目录），决定合成音色；省略时用部署的默认音色。任意格式（wav / mp3 / flac / ogg / m4a …），不是 16 kHz 单声道 WAV 时会先用 ffmpeg 自动转码。 |
| `language` | string（`auto` / `zh` / `en` / `ja` / `es` / `ar`） | 否 | 语言提示；auto 表示按文本自动推断。 |
| `emotion` | string | 否 | 情绪描述，例如「平静但开心」；可省略。 |
| `emotion_alpha` | number | 否 | 情绪强度，0-1，仅在提供 emotion 时生效。 |
| `duration_scale` | number | 否 | 时长/语速缩放：大于 1 更慢，小于 1 更快，默认 1。 |
| `seed` | integer | 否 | 随机种子；固定同一个值可复现同一句话。 |
| `output_path` | string | 否 | 输出 wav 路径；省略时写入输出文件夹并自动命名。只给文件名时保存在输出文件夹。 |

**返回**：`audio_path`（生成的 wav 绝对路径（唯一字段，其余都是回显或诊断信息））。

**失败**：`text` 为空，或超过单次 2000 字符上限；参考音色缺失（参数没给、部署也没有默认值），或文件不存在；参考音频无法被 ffmpeg 解码 / ffmpeg 不可用（转码失败时给出原因）；引擎未运行 / 配置为禁用（提示里给出启动办法）；`audiocpp_server` 或 TTS 模型文件缺失。

#### `audio_toolkit_asr_transcribe` ／ MCP `asr_transcribe`

把音频文件转写成文本（SenseVoice，输出纯文本，不含事件/情绪标签）。默认写入输出文件、返回值只给路径（text_path）；需要正文时传 return_text=true。timestamps=true 时改用 VAD（语音活动检测）切句：先把音频切成句子，再逐句识别，时间戳是句级 start_ms/end_ms——不是词级，也不是模型原生输出；更慢，且切片上下文变短可能略降低准确率。长音频分块默认用面板配置，可用 chunk_mode / chunk_seconds 单次覆盖。输入可以是任意音频格式，内部先统一转成 16 kHz 单声道 WAV；支持中/英/粤/日/韩等 20+ 语言。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `audio_path` | string | 是 | 音频文件路径（绝对路径或相对会话工作目录）。任意格式（wav / mp3 / flac / ogg / m4a …）；不是 16 kHz 单声道 WAV 时会先用 ffmpeg 自动转码，转码失败会给出原因。 |
| `output_path` | string | 否 | 转写文本的输出路径；省略时写入输出文件夹并自动命名 asr-<时间>-<音频名>.txt。句级模式另写同名 .segments.json。 |
| `save_to_file` | boolean | 否 | false 时不写任何文件、直接在返回值里给出正文（此时 return_text 无意义）；默认 true。 |
| `return_text` | boolean | 否 | true 时在返回值里附带正文与分段；默认 false，只给路径（长转写更省上下文）。 |
| `language` | string | 否 | 识别语言：auto，或 zh / en / yue / ja / ko 等语言代码；默认 auto。 |
| `timestamps` | boolean | 否 | true 时用 VAD 切句后逐句识别，返回句级时间轴（每段 start_ms/end_ms，不是词级）；更慢。未检出语音时会退化为整段转写，此时返回的 timestamps 为 whole-file。 |
| `normalize_text` | boolean | 否 | true（默认）把数字、日期、标点规整成书面形式（例如「三点」写成「3点」）；false 保留模型原始输出。 |
| `chunk_mode` | string（`auto` / `fixed` / `vad` / `none`） | 否 | 高级选项：长音频分块方式，默认沿用面板配置（fixed）。auto / vad 需要 VAD 模型与 16 kHz 单声道输入。 |
| `chunk_seconds` | number | 否 | 高级选项：分块时长（秒，1-600），默认沿用面板配置（30）。fixed 时是每段时长，auto / vad 时是单段上限。 |

**返回**：`text_path`（转写文本路径；`save_to_file: false` 时为 null）、`text`（仅 `save_to_file: false` 或 `return_text: true` 时返回）、`segments_path`（仅 `timestamps: true` 时返回）、`segments`（仅 `timestamps: true` 且附带正文时返回，每项 `index` / `start_ms` / `end_ms` / `duration_ms` / `text`）。

默认只返回路径。`timestamps: true` 时 `segments_path` 指向 `.segments.json`（含 `fallback` 标记：`true` 表示 VAD 没检出语音、整段回退）。

**失败**：找不到音频文件，或路径指向目录；输入音频无法被 ffmpeg 解码（或 ffmpeg 未安装 / 路径不对），转码失败；VAD 模型未配置或文件缺失；引擎未运行 / 配置为禁用；ASR 模型文件缺失。

#### `audio_toolkit_tts_list_voices` ／ MCP `tts_list_voices`

列出参考音色目录里的 wav 文件，返回名称与路径。把返回的 path 作为文本转语音工具的 voice_path 参数。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `query` | string | 否 | 按文件名子串过滤，例如「三月」。 |
| `voice_dir` | string | 否 | 覆盖默认音色目录，例如指向 audio_samples 目录。 |

**返回**：`voice_dir`（实际扫描的目录）、`default_voice_path`（部署配置的默认音色；没有时为 null）、`voices`（每项含 `name` 与 `path`（直接作为 `voice_path` 使用））。

**失败**：目录不存在或为空时不报错，返回空的 `voices`。

#### `audio_toolkit_engine_status` ／ MCP `audio_status`

检查常驻语音引擎：是否在运行、哪些模型已加载、模型/VAD/可执行文件是否就绪、GPU 设备与当前配置。排障或不确定参数时先调用它。

无参数。

**返回**：`toolkit_version`（工具箱版本）、`config_source`（配置来源：插件发布的状态文件，或环境变量覆盖）、`engine`（`url` / `enabled` / `running` / `health`（status/backend/version）/ `models[]`（id/loaded）/ `log`）、`install_ok`（必需文件是否齐全；看 checks 定位缺哪个）、`checks`（每项 `label` / `ok`；只有失败的项才带 `path`）、`audio_cpp`（`backend` / `device` / `ffmpeg`（实际会执行的 ffmpeg，未找到为 null））、`tts`（`family` / `model` / `default_voice_path` / `voices`（数量））、`asr`（`family` / `model` / `vad_model` / `chunk_mode`）、`output`（`dir` / `files`）、`jobs`（各状态计数 + `limit`；当前入口没有队列时为 null）、`gpu`（每项 `name` / `free_bytes` / `total_bytes`；枚举失败时是带 error 的对象）。

**失败**：只读诊断，不报错；异常体现在 `checks` / `install_ok` / `gpu` 里。

#### `audio_toolkit_submit_tasks` ／ MCP `submit_tasks`

批量提交语音任务（文本转语音 / 语音转文字），立即返回 job_id，不阻塞等待。每个任务的字段与对应工具的参数一致：文本转语音任务给 text（可选 voice_path 等），语音转文字任务给 audio_path；也可以把字段放进 params 对象。提交后用任务查询工具按 job_ids 轮询。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `tasks` | array&lt;object&gt; | 是 | 任务列表（一次最多 20 个）。每项必须含 kind，其余字段同该工具参数，例如 {"kind":"tts","text":"…","voice_path":"…"} 或 {"kind":"asr","audio_path":"…"}；也可写成 {"kind":"tts","params":{…}}。 |

**`tasks[]` 元素**：`kind`（必填）：tts（文本转语音）或 asr（语音转文字）；其余字段同对应工具的参数，也可以整体放进 `params` 对象。

**返回**：`submitted`（已受理任务，每项 `job_id` / `kind` / `status`）、`rejected`（被拒任务，每项含 kind / reason；非法条目不会拖垮整批）、`queue`（`queued` / `running` / `done` / `error` / `cancelled`）。

**失败**：`tasks` 为空或超过 20 个；当前入口没有任务队列（独立 MCP 服务与宿主插件都有，其它调用方式可能没有）。

#### `audio_toolkit_job_status` ／ MCP `job_status`

按 job_ids 查询任务状态与结果（done 时 result 里是音频/文本路径）；不传 job_ids 则列出最近的作业。用 all_settled 判断是否全部结束，summary 给出各状态计数。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `job_ids` | array | 否 | 要查询的 job_id 列表；省略则列出最近作业。 |
| `status` | string（`queued` / `running` / `done` / `error` / `cancelled`） | 否 | 只看某个状态的任务。 |
| `limit` | number | 否 | 最多返回多少条（默认 20，上限 100）。 |

**返回**：`jobs`（每项 `job_id` / `kind` / `status`，以及 `error` 或 `result`（即对应工具的返回））、`all_settled`（全部结束**且**请求的 id 都存在）、`missing`（请求了但查不到的 job_id；仅在不带 status 过滤时出现）、`summary`（`queued` / `running` / `done` / `error` / `cancelled`）。

**失败**：当前入口没有任务队列。

#### `audio_toolkit_cancel_jobs` ／ MCP `cancel_jobs`

取消排队中或运行中的任务；已结束的任务不会被改动。返回 cancelled / skipped 列表。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `job_ids` | array | 是 | 要取消的 job_id 列表。 |

**返回**：`cancelled`（已取消的 job_id）、`skipped`（未改动的任务，每项含 job_id 与 reason，reason 为 not-found / already-done 等）。

**失败**：`job_ids` 为空；当前入口没有任务队列。

<!-- END GENERATED:tool-contract -->

### 公共约定

**命名**：DSH 侧工具名是 `audio_toolkit_*`，同一套 handler 也以原始名（`tts_speak` …）通过独立 MCP 服务暴露，**参数完全一致**；MCP 客户端侧会再加 `mcp__<server>__` 前缀。DSH 名字以动词或精确名词结尾（`..._speak` / `..._transcribe` / `..._engine_status` / `..._job_status`），参数里路径统一 `*_path`、开关统一 `include_*` / `save_to_file`，不让模型猜缩写。

**音频格式**：工具接受**任意常见音频**，内部先统一成 16 kHz 单声道 PCM16 WAV 再交给引擎。

| 用途 | 接受 | 处理 |
|---|---|---|
| ASR 输入（`audio_path`） | wav / mp3 / flac / ogg / m4a / aac … | 非 16 kHz 单声道时用 ffmpeg 转成 16 kHz 单声道 WAV（引擎只解 WAV，且 VAD 分块要求 16 kHz 单声道） |
| 句级时间戳（`timestamps: true`） | 同上 | 转码后由 Node 侧流式解码切句——所以 mp3 也能出时间轴 |
| TTS 参考音频（`voice_path`） | 同上 | 同样先转码；建议 3–10 秒单人干声 |

已经是 16 kHz 单声道 WAV 的输入会**跳过转码**（不启动 ffmpeg），其余一律走一次转换；转码产物在 `state/tmp` 下的临时目录里，调用结束即删除。ffmpeg 解析顺序：

1. 面板 `ffmpegPath`（填文件或目录都行）；
2. 找不到就回退到 `PATH` 上的 `ffmpeg`；
3. 都没有 → 报错并提示把 ffmpeg 放到 `bin/ffmpeg` 或设置面板路径（不会静默降级）。

`audio_toolkit_engine_status` 的 `audio_cpp` 里会显示 `ffmpeg_path`（配置值）与 `ffmpeg`（实际会执行的那个），排障时先看它。

**哪些没暴露给模型**：ASR 的**事件/情绪标签**不在工具参数里——标签固定剥离，工具只产出纯文本。**分块方式/秒数**（`chunk_mode` / `chunk_seconds`）是暴露的，默认沿用面板 `asrChunkMode` / `asrChunkSeconds`，模型只在需要时单次覆盖。

**路径**：`*_path` 参数接受三种写法——裸文件名 → 落进输出文件夹；含目录分隔符 → 相对**会话工作目录**；绝对路径 → 原样使用。输出文件夹默认是会话工作目录下的 `audio_toolkit_outputs/`（面板里的 `outputFolder` 只填名字，传路径会被取末段并清洗）。

**返回值**：每次调用返回一个 JSON 对象（工具结果里的单个 JSON 文本块）。失败时 `isError: true`，正文形如 `{ "error": "可执行的说明", "details"?: { … } }`，`details` 里带尝试过的路径、HTTP 状态或引擎错误码。

**引擎前提**：TTS、ASR、句级时间戳都要求常驻引擎在跑。引擎不可达时工具不会崩，而是返回同一句可执行提示（去面板点「启动引擎」，或看 `state/engine.log`）；模型可以先用 `audio_toolkit_engine_status` 自查。

**并发与超时**：只有 `audio_toolkit_tts_speak` / `audio_toolkit_asr_transcribe` 受面板 `maxConcurrentCalls`（默认 2）限制并排队，`engine_status` / `job_status` / `cancel_jobs` 不受限——否则一次长合成会把轮询堵死。`toolCallTimeoutMs` 覆盖**整次引擎请求（含响应体读取）**，超时与取消分别以 `TIMEOUT` / `ABORTED` 报告。

**取消**：调用方的取消信号会中止对应的引擎请求；独立 MCP 端支持 `notifications/cancelled`（按 JSON-RPC id 配对），排队中的任务被取消后**不会**再执行。

### 异步任务（批量提交）

一次提交多个任务，立刻拿到 job_id，随后轮询——适合"一次给多段文本/多条录音"的场景：

```jsonc
// audio_toolkit_submit_tasks
{ "tasks": [
    { "kind": "tts", "text": "第一段。", "voice_path": "…/ref.wav", "output_path": "batch-1.wav" },
    { "kind": "asr", "audio_path": "…/meeting.wav", "language": "zh" },
    { "kind": "asr", "audio_path": "…/call.wav", "timestamps": true }
] }
→ { "submitted": [ {"job_id":"job-…-001","kind":"tts","status":"running"}, … ], "rejected": [], "queue": {"queued":1,"running":2,"done":0,"error":0,"cancelled":0} }

// audio_toolkit_job_status
{ "job_ids": ["job-…-001","job-…-002"] }
→ { "jobs": [ { "job_id":"…", "kind":"asr", "status":"done", "result": { "text_path": "…" } } ],
    "all_settled": true, "summary": { "queued":0,"running":0,"done":2,"error":0,"cancelled":0 } }

// audio_toolkit_cancel_jobs
{ "job_ids": ["job-…-003"] } → { "cancelled": ["job-…-003"], "skipped": [] }
```

要点：

- 并发上限就是面板里的 `maxConcurrentCalls`（默认 2），超出部分排队；`audio_toolkit_engine_status` 与每次 `audio_toolkit_job_status` 都带各状态计数。
- 状态：`queued` / `running` / `done` / `error` / `cancelled`；`done` 时 `result` 就是对应工具原本的返回（TTS 是 `audio_path`，ASR 是 `text_path`/`segments_path`）。
- 任务注册表会落到 `state/jobs.json`（最多保留 100 条），插件重载后**已结束**的任务仍可查询；重载前还在排队/运行的任务会被标记为 `error`（"插件重启，任务已中断"），不会自动续跑。
- 取消运行中的任务会 abort 对应的引擎请求；已完成的任务不受影响。
- 单个任务仍受 `toolCallTimeoutMs` 约束。

### 句级时间戳（`timestamps: true`）

SenseVoice 本身**不产出**句子/词边界（CTC 模型，输出整段文本 + 标签），当前 v0.9.4 release 连 `return_timestamps` 选项都没有（实测 `/v1/audio/transcriptions/details` 只回 `text/language/timing`）。所以工具层自己造时间轴：

1. 把输入解码成 **16 kHz 单声道**（非 16 kHz 单声道输入先用 ffmpeg 转码；解码是纯 Node 的**流式分块**实现，长录音不会把原文件与三份副本同时放内存）；
2. 用 **PulseVAD**（`asrVadModel`）经 audio.cpp CLI 找出语音区间（跟随 `backend` / `device` / `threads`）；
3. 按 `asrMinSegmentMs` 丢弃过短片段、按 `asrMergeGapMs` 合并相邻片段成句；
4. 每句切片交给**常驻引擎**识别，附带 `start_ms` / `end_ms`。

若 VAD 没找到任何可用语音（纯音乐、噪声、参数不匹配），**不会**返回"成功但空文本"：会退化成整段转写，时间轴压成一段覆盖全文件，`.segments.json` 里标 `fallback: true`。

返回示例（`return_text: true`，实测 7.2 s 三句话）：

```json
{
  "text_path": "…/asr-20261111-…-call.txt",
  "segments_path": "…/asr-20261111-…-call.segments.json",
  "text": "第一句…\n第二句…\n第三句…",
  "segments": [
    { "index": 0, "start_ms": 200, "end_ms": 1900, "duration_ms": 1700, "text": "…" },
    { "index": 1, "start_ms": 2600, "end_ms": 5400, "duration_ms": 2800, "text": "…" }
  ]
}
```

不带 `return_text` 时只有两个路径；`.segments.json` 里另有 `vad_regions`、`fallback` 等排障字段。

注意：这套时间戳是**句级**的（边界由 VAD 切点决定），**不是词级**，也**不是模型原生输出**——SenseVoice 只给整段文本。切片后每段上下文变短，识别结果可能略差于整段识别；需要最高准确率时用默认（不带 `timestamps`）模式。

要点：

- 返回的是**文件路径**，音频不会进模型上下文；要展示给用户就 `present` 该 wav。
- **ASR 转写默认落盘且只返回路径**：写到输出文件夹的 `asr-<时间戳>-<音频名>.txt`（句级模式再写 `<同名>.segments.json`），返回里只有 `text_path`（句级还有 `segments_path`）与耗时等元数据，**不带正文**。需要正文时传 `return_text: true`；`output_path` 可指定文件名（裸名进输出文件夹、带分隔符相对会话工作目录、绝对路径原样），`save_to_file: false` 则只返回文本不落盘。
- 输出默认落在**当前会话工作目录下的 `audio_toolkit_outputs/`**：工具按 `ctx.workingDirectory` 解析会话目录，再拼上面板里的 `outputFolder` 名称（只填名字，传路径会被取末段并清洗）。`output_path` 给裸文件名 → 进该文件夹；带目录分隔符 → 相对会话工作目录；绝对路径原样使用。
- 引擎**懒加载权重**：DSH 启动后引擎进程立刻在，但第一次 TTS/ASR 才把权重读进显存。

实测（RTX PRO 6000 96 GB，fp16）：

| 场景 | 墙钟 |
|---|---|
| TTS 首次（加载 4.2 GiB fp16） | ≈17.5 s |
| TTS 后续（模型常驻） | **≈0.87 s** |
| ASR 后续（4.95 s 音频，RTF 0.008） | **≈0.04 s**（首次含加载另计） |

## 四、安装 / 生效 / 卸载

```text
plugin_manager(action="install_bundle", target="link:<绝对路径>/dsh-audio-toolkit")
```

改完 `src/` 或 `cordis.patch.yml` 后重载（会连带重启引擎）：

```text
plugin_manager(action="set_bundle", target="dsh-audio-toolkit", enabled=false)
plugin_manager(action="set_bundle", target="dsh-audio-toolkit", enabled=true)
```

卸载：

```text
plugin_manager(action="remove_bundle", target="dsh-audio-toolkit")
```

卸载/禁用会让引擎子进程一起退出——这正是"引擎跟随 DSH 生命周期"的实现：`apply()` 里用 `ctx.effect` 注册了停止动作，DSH 关闭或插件重载都会触发。

## 五、测试

```powershell
# 在仓库根目录执行；node 需 >= 22.19
node .\test\config.mjs    # 配置/表单契约/原生工具/队列/WAV 流式解码/静音回退（73 项）
node .\test\client.mjs    # 浏览器半边无头渲染与暂存值契约（25 项）
node .\test\http.mjs      # 超时/取消/分块透传（受限沙箱 14 项，含 MCP 端到端共 20 项）
node .\test\smoke.mjs --extended  # 独立 MCP 服务端到端，需 danger-full-access
node .\scripts\tool_contract.mjs --check  # 校验 README 的工具契约与代码一致
python .\scripts\check_scripts.py        # Python 辅助脚本自检（本地 HTTP，无需联网）
```

仓库根目录下也可以直接跑 `npm test`（语法检查 + 前三个文件 + 契约校验）。缺少 `bin/`/模型时（新克隆、CI）引擎相关用例自动 SKIP，`AUDIO_TOOLKIT_NO_ASSETS=1` 可强制该模式；测试音频由用例自己生成，仓库不依赖 `audio_samples/`。改了工具名/参数/描述后，记得：

```powershell
node .\scripts\tool_contract.mjs --write   # 或 npm run docs:contract
```

否则 `npm test` 的契约校验会失败并提示重新生成。

`test/smoke.mjs` 会在 **8799** 端口起一个私有引擎（不碰 DSH 那个 8788），用临时状态文件把 MCP 服务指过去，跑完后停引擎并验证"引擎已停止"时的错误提示。

> 受限沙箱里 `child_process.spawn` 用管道 stdio 会 `EPERM`；端到端测试需要 `danger-full-access` 或直接在普通终端跑。`config.mjs` / `client.mjs` 不受影响。

## 六、排障

宿主进程的 console 在桌面版里看不到，所以插件把自己所有的启动/配置/引擎/工具日志都写进 **`state/host.log`**（UTF-8，带时间戳）。先看它。

| 现象 | 处理 |
|---|---|
| 插件面板详情页没有配置区 | 先确认 `state/host.log` 里有 `配置：...` 和 `已注册工具：...`；再确认 bundle 已启用、`package.json` 的 `dsh.client.platform = "web"` 且 `exports["./client"]` 指向 `src/client.js`。改过 client 要重载插件并**刷新页面**（浏览器需重新拉 client bundle） |
| 配置区在但字段为空 | 宿主没提供该命名空间：命名空间 = Loader 条目 id `audio-toolkit`，`settings.describe()` 必须返回它（`test/config.mjs` 校验过 33 个扁平字段） |
| 工具没出现 | `state/host.log` 里找 `已注册工具` 或 `注册 audio_toolkit_* 工具失败`；该插件必须 `inject: ['tools']`，否则 Cordis 会拒绝读取 `ctx.tools` |
| 工具报"引擎未运行" | 面板里点 **启动引擎**（或把 `engineEnabled` 设 true 保存）；看 `state/engine.log` |
| 端口被占用 | 面板改 `enginePort` 保存，引擎会自动重启到新端口 |
| `audiocpp_server.exe` 立刻退出 | 缺 CUDA 13 运行时 DLL：`python scripts/fetch_cuda_runtime.py` |
| ASR 报 `PulseVAD requires 16000 Hz mono audio` | `auto/vad` 分块要求 16k 单声道；把 `asrChunkMode` 改回 `fixed` |
| TTS 报"需要参考音色" | 传 `voice_path`，或面板设「默认参考音色」，或把 wav 放进 `voices/` |
| 想换回 q8 权重 | 面板把 `ttsModel` 改成 `.../index-tts2_5-q8_0.gguf` 并保存 |

## 七、已知限制

- 引擎是**单进程、每模型单请求串行**：并发 2 时 TTS 与 ASR 可同时跑，同模型会排队。
- 词级时间戳：本 release 的 `sense_asr` 规格没有 `return_timestamps`（`--words-out` 无输出）；工具改用 VAD 切句的**句级**时间戳（`timestamps: true`）。
- 情绪文本只对 IndexTTS 家族有效（内部映射为 `use_emotion_text` + `emotion_text`）。
- 配置面板里的路径字段是**输入框**（没有系统文件选择器可选）；列表字段用空格分隔，输入框下方会用标签把解析结果展示出来。
- 原生工具名固定为 `audio_toolkit_*`；`mcpServerName` 只作为独立 MCP 服务的 `serverInfo.name`，工具前缀（`mcp__<server>__`）由 DSH 侧 MCP 客户端那一行决定，不受它影响。

## 八、目录约定

- 引擎与模型：`./bin`（不随插件包分发）；
- 开发期音频素材：`./audio_samples`（仅测试）；
- 产物：`<当前会话工作目录>/audio_toolkit_outputs/` —— TTS 的 `*.wav`、ASR 的 `asr-*.txt` 与句级模式的 `*.segments.json`（文件夹名由面板 `outputFolder` 决定）；
- 参考音色：`./voices`（可选）；
- 运行态：`state/`（`config.json` / `engine.json` / `engine.log` / `host.log` / `tmp/`，已在 `.gitignore`）。

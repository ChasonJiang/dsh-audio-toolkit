/**
 * dsh-audio-toolkit — browser half.
 *
 * Hand-authored client bundle in DSH's module-loader envelope: it registers a
 * card on the sidebar **插件** page (slot `plugins.item`) that renders the
 * plugin's Config fields and saves them through the settings service. Without
 * this half the plugin has a schema but no UI, which is exactly what a missing
 * panel form looks like.
 *
 * The panel form model addresses fields by single-segment paths, so every field
 * is a top-level Config key and every value is edited as text (booleans and
 * enums get quick-set buttons on top).
 */

window.__ModuleLoader__.load({
	id: 'dsh-audio-toolkit',
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

		const { jsx, jsxs } = require('react/jsx-runtime')
		const prim = require('@deepseek-ai/dsh-client-ui-primitives')

		/** Loader entry id of the host plugin; also the settings namespace. */
		const NAMESPACE = 'audio-toolkit'
		/** Locale dictionary namespace owned by this bundle. */
		const LOCALE_NS = 'settings.audioToolkit'

		const zh = {
			title: 'audio 工具链',
			summary: '本地 audio.cpp 常驻引擎：IndexTTS2.5 语音合成 + SenseVoice 语音识别，工具为 audio_toolkit_*。点开可配置引擎、模型与路径。',
			unavailable: '宿主没有提供该配置，暂时无法编辑。',
			readOnly: '本次部署的配置是只读的。',
			save: '保存',
			saving: '保存中…',
			saveFailed: '宿主没有接受这些值，已保留供你修改。',
			overriddenLabel: '已覆盖',
			resetLabel: '恢复默认',
			invalidLabel: '值无效，请检查格式。',
			sectionEngine: '引擎（常驻进程）',
			sectionMcp: 'MCP 服务',
			sectionAudioCpp: 'audio.cpp 运行时',
			sectionTts: 'TTS 模型（IndexTTS2.5）',
			sectionAsr: 'ASR 模型（SenseVoice）',
			sectionOutput: '输出',
			startEngine: '启动引擎',
			stopEngine: '停止引擎',
			engineHint: '「引擎启用」= 手动启停；保存后立即生效，无需重启 DSH。',
			engineOn: '引擎：已启用',
			engineOff: '引擎：已停用',
			on: '开',
			off: '关',
			dirty: '有未保存修改',
			saved: '已同步',
			setupTitle: '首次设置：准备运行时依赖',
			setupIntro: '安装包只包含代码。audio.cpp 运行时与三个模型（约 6 GB）需要单独准备，装好后才能使用语音工具。',
			setupStep1: '选择准备方式',
			setupStep1Body: '自动安装会下载到 ~/.dsh/audio-toolkit；手动下载则由你把文件放到资产目录。',
			setupProxy: '下载代理（可选）',
			setupProxyEmpty: '⚠ 还没填代理。直连 GitHub / Hugging Face 不通时自动安装会失败，请填本地代理地址。',
			setupProxyFilled: '已配置代理，自动安装会走它。',
			setupAuto: '自动安装（推荐）',
			setupManual: '手动下载',
			setupLater: '安装完成后才会显示其他配置项；依赖未就绪时引擎无法启动。',
			autoRunning: '正在准备运行时依赖：下方显示实时进度，装完会自动出现其余配置项。',
			setupProxyEnable: '使用代理下载（仅在需要时勾选）',
			setupProxyOptional: '未勾选时不使用代理；直连 GitHub / Hugging Face 不通时再打开并填写地址。',
			manualWaiting: '把依赖放到下面这些位置后点「刷新状态」，就绪后会自动出现其余配置项。',
			switchToManual: '改用手动下载',
			switchToAuto: '改用自动安装',
			manualSources: '模型来源：Hugging Face 的 audio-cpp/audio.cpp-gguf 与 FunAudioLLM/SenseVoiceSmall-GGUF-audiocpp（国内可用 hf-mirror.com 镜像）；release 见 audio.cpp 的 Releases 页。',
			manualTitle: '手动放置依赖',
			manualBody: '把文件放到下面这些位置，然后点「刷新状态」。',
			manualRefresh: '刷新状态',
			manualDirPlaceholder: '已有资产目录（可留空）',
			assetsNotReady: '依赖尚未安装完成：引擎无法启动，请在上方卡片点「安装所缺依赖」。',
			assetsProxyMissing: '⚠ 未配置代理，直连 GitHub / Hugging Face 不通时下载会失败（在「首次设置」或 audio.cpp 分组里填 assetsProxy）。',
			assetsTitle: '运行时依赖',
			assetsHint: 'audio.cpp、模型与 CUDA 运行时。从 Git / npm 安装时不在包内，需要时在这里安装。',
			assetsReady: '已就绪',
			assetsMissing: '缺少',
			assetsInstall: '安装依赖',
			assetsInstallAll: '安装所缺依赖',
			assetsCancel: '取消安装',
			assetsRefresh: '刷新状态',
			assetsInstalling: '正在安装',
			assetsDone: '安装完成',
			assetsFailed: '安装失败',
			assetsRelease: 'audio.cpp 运行时',
			assetsModels: 'GGUF 模型',
			assetsRoot: '资产目录',
			assetsPortDown: '依赖服务未就绪（插件刚重载时稍等再刷新）',
			assetsUnavailable: '当前平台不支持自动安装（仅 Windows/CUDA）',
			assetsOptions: '安装内容',
			assetsTarget: '目标平台 / 后端',
			assetsDelete: '删除依赖',
			assetsDeleteConfirm: '删除已安装的运行时依赖？会停止引擎并删除 bin/audio.cpp 与 bin/models。',
		}

		const en = {
			title: 'audio toolkit',
			summary: 'Resident audio.cpp engine: IndexTTS2.5 speech synthesis + SenseVoice recognition, exposed as audio_toolkit_* tools.',
			unavailable: 'The host does not serve this configuration.',
			readOnly: 'This deployment stores settings read-only.',
			save: 'Save',
			saving: 'Saving…',
			saveFailed: 'The host did not accept these values; they were kept for you to fix.',
			overriddenLabel: 'Overridden',
			resetLabel: 'Reset',
			invalidLabel: 'Invalid value; check the format.',
			sectionEngine: 'Engine (resident process)',
			sectionMcp: 'MCP service',
			sectionAudioCpp: 'audio.cpp runtime',
			sectionTts: 'TTS model (IndexTTS2.5)',
			sectionAsr: 'ASR model (SenseVoice)',
			sectionOutput: 'Output',
			startEngine: 'Start engine',
			stopEngine: 'Stop engine',
			engineHint: '"Engine enabled" is the manual start/stop switch; saving applies immediately.',
			engineOn: 'Engine: enabled',
			engineOff: 'Engine: disabled',
			on: 'on',
			off: 'off',
			dirty: 'Unsaved changes',
			saved: 'In sync',
			assetsTitle: 'Runtime assets',
			assetsHint: 'audio.cpp, models and the CUDA runtime. Git/npm installs ship only code; install them here when needed.',
			assetsReady: 'Ready',
			assetsMissing: 'Missing',
			assetsInstall: 'Install assets',
			assetsInstallAll: 'Install missing assets',
			assetsCancel: 'Cancel install',
			assetsRefresh: 'Refresh',
			assetsInstalling: 'Installing',
			assetsDone: 'Install finished',
			assetsFailed: 'Install failed',
			assetsRelease: 'audio.cpp runtime',
			assetsModels: 'GGUF models',
			assetsRoot: 'Asset directory',
			assetsPortDown: 'Asset service not reachable yet (retry after the plugin finishes reloading)',
			assetsUnavailable: 'Automatic install is Windows/CUDA only',
			assetsOptions: 'Install',
			assetsTarget: 'Platform / backend',
			assetsDelete: 'Delete assets',
			assetsDeleteConfirm: 'Delete the installed runtime assets? This stops the engine and removes bin/audio.cpp and bin/models.',
			assetsNotReady: 'Assets are not installed yet: the engine cannot start. Use “Install missing assets” above.',
			assetsProxyMissing: '⚠ No proxy configured; downloads fail when GitHub / Hugging Face is unreachable (set assetsProxy).',
			setupTitle: 'First run: prepare runtime assets',
			setupIntro: 'The package ships only code. The audio.cpp runtime and three models (~6 GB) must be fetched once before the speech tools work.',
			setupStep1: 'How do you want to get them?',
			setupStep1Body: 'Automatic install downloads into ~/.dsh/audio-toolkit; manual means you place the files yourself.',
			setupProxy: 'Download proxy (optional)',
			setupProxyEmpty: '⚠ No proxy configured. If GitHub / Hugging Face is unreachable the install will fail — set your local proxy here.',
			setupProxyFilled: 'Proxy configured; the installer will use it.',
			setupAuto: 'Install automatically (recommended)',
			setupManual: 'Download manually',
			setupLater: 'Other settings appear only after the install finishes; the engine cannot start until then.',
			autoRunning: 'Preparing the runtime assets: live progress below. The rest of the form appears when it finishes.',
			setupProxyEnable: 'Use a proxy for downloads (only if needed)',
			setupProxyOptional: 'No proxy is used unless enabled; turn it on and fill the address if GitHub / Hugging Face is unreachable.',
			manualWaiting: 'Place the files below and press Refresh; the rest of the form appears once they are ready.',
			switchToManual: 'Switch to manual download',
			switchToAuto: 'Switch to automatic install',
			manualSources: 'Models: Hugging Face repositories audio-cpp/audio.cpp-gguf and FunAudioLLM/SenseVoiceSmall-GGUF-audiocpp (hf-mirror.com works from mainland China); releases: the audio.cpp Releases page.',
			manualTitle: 'Place the assets manually',
			manualBody: 'Put the files at the locations below, then press “Refresh”.',
			manualRefresh: 'Refresh',
			manualDirPlaceholder: 'Existing asset directory (optional)',
		}

		/** Form labels the shared SettingsForm renders. */
		function formLabels(t) {
			return {
				unavailable: t('unavailable'),
				readOnly: t('readOnly'),
				saveFailed: t('saveFailed'),
				save: t('save'),
				saving: t('saving'),
			}
		}

		//#region field specs
		/** Text field: whitespace preserved, blank clears the override. */
		function textSpec(field) {
			return {
				field,
				format: (value) => (typeof value === 'string' ? value : ''),
				parse: (text) => {
					const trimmed = text.trim()
					return trimmed === '' ? { kind: 'clear' } : { kind: 'set', value: trimmed }
				},
			}
		}

		/** Number field. */
		function numberSpec(field) {
			return {
				field,
				format: (value) => (typeof value === 'number' ? String(value) : ''),
				parse: (text) => {
					const trimmed = text.trim()
					if (trimmed === '') return { kind: 'clear' }
					const parsed = Number(trimmed)
					return Number.isFinite(parsed) ? { kind: 'set', value: parsed } : undefined
				},
			}
		}

		/** Boolean field rendered as a text input plus quick-set buttons. */
		function booleanSpec(field) {
			return {
				field,
				format: (value) => (typeof value === 'boolean' ? String(value) : ''),
				parse: (text) => {
					const trimmed = text.trim().toLowerCase()
					if (trimmed === '') return { kind: 'clear' }
					if (['true', '1', 'yes', 'on'].includes(trimmed)) return { kind: 'set', value: true }
					if (['false', '0', 'no', 'off'].includes(trimmed)) return { kind: 'set', value: false }
					return undefined
				},
			}
		}

		/** Enum field: only the listed values are accepted. */
		function enumSpec(field, values) {
			return {
				field,
				format: (value) => (typeof value === 'string' ? value : ''),
				parse: (text) => {
					const trimmed = text.trim()
					if (trimmed === '') return { kind: 'clear' }
					return values.includes(trimmed) ? { kind: 'set', value: trimmed } : undefined
				},
			}
		}

		/** Whitespace-separated list field backed by one space-separated string. */
		function listSpec(field) {
			return {
				field,
				// Legacy values may already be arrays; render both shapes.
				format: (value) => (Array.isArray(value) ? value.join(' ') : typeof value === 'string' ? value : ''),
				parse: (text) => {
					const trimmed = text.trim()
					if (trimmed === '') return { kind: 'clear' }
					// The Config field is `Schema.string()` and the host tokenizes it with
					// splitTokens. Saving an array here would pass the settings write path
					// (it only checks volatility) and then fail schema validation on the
					// next load, so normalize to a single-spaced string.
					return { kind: 'set', value: trimmed.split(/\s+/).join(' ') }
				},
			}
		}
		//#endregion

		//#region field table
		/**
		 * `kind` drives which control renders the field: text | number | boolean |
		 * enum (with `values`) | list. `fallback` is what a switch shows when the
		 * field has never been overridden; `unit` labels numeric controls.
		 */
		const SECTIONS = [
			{
				key: 'sectionEngine',
				fields: [
					{ field: 'engineAutoStart', label: '随 DSH 自动启动', hint: 'DSH 启动/插件启用时自动拉起引擎（懒加载，首次请求才占显存）。', kind: 'boolean', fallback: true },
					{ field: 'engineHost', label: '监听地址', hint: '保持 127.0.0.1。', kind: 'text' },
					{ field: 'enginePort', label: '端口', hint: '被占用时改这里并保存（引擎会自动重启）。', kind: 'number' },
				],
			},
			{
				key: 'sectionMcp',
				fields: [
					{ field: 'mcpServerName', label: 'MCP 服务名', hint: '仅独立 MCP 服务使用；原生工具名固定为 audio_toolkit_*。', kind: 'text' },
					{ field: 'toolCallTimeoutMs', label: '调用超时', hint: '单次 TTS/ASR 请求的等待上限。', kind: 'number', unit: 'ms' },
					{ field: 'maxConcurrentCalls', label: '并发请求数', hint: '常驻引擎每模型串行，1-2 足够。', kind: 'number', unit: '个' },
				],
			},
			{
				key: 'sectionAudioCpp',
				fields: [
					{ field: 'assetsDir', label: '资产根目录', hint: '存放 bin/audio.cpp、bin/models 与 bin/ffmpeg。留空 = 自动：包内 bin/ → 环境变量 DSH_AUDIO_TOOLKIT_ASSETS → ~/.dsh/audio-toolkit。', kind: 'text', placeholder: '自动' },
					{ field: 'backend', label: '推理后端', hint: '改后引擎自动重启；须与安装依赖时选择的后端一致（例如装的是 CUDA 版就选 cuda）。', kind: 'enum', values: ['cuda', 'cpu', 'vulkan'] },
					{ field: 'device', label: 'GPU 序号', hint: '多卡时选择设备。', kind: 'number' },
					{ field: 'threads', label: '线程数', hint: '0 = 自动。', kind: 'number' },
					{ field: 'extraArgs', label: '额外参数', hint: '空格分隔；一般留空。', kind: 'list' },
				],
			},
			{
				key: 'sectionTts',
				fields: [
					{ field: 'ttsFamily', label: '模型家族', hint: 'audio.cpp --family，例如 index_tts2。', kind: 'text' },
					{ field: 'ttsDefaultVoiceRef', label: '默认参考音色', hint: 'IndexTTS2.5 必须给参考音色；留空则调用时需传 voice_path。', kind: 'text', placeholder: '选择或留空' },
					{ field: 'ttsVoiceDir', label: '音色目录', hint: '留空 = <assetsDir>/voices，audio_toolkit_tts_list_voices 列这里的 wav。', kind: 'text', placeholder: '自动' },
					{ field: 'ttsLanguage', label: '默认语言', hint: 'auto 按文本推断。', kind: 'enum', values: ['auto', 'zh', 'en', 'ja', 'es', 'ar'] },
					{ field: 'ttsEmotion', label: '默认情绪文本', hint: '可留空；调用时也能覆盖。', kind: 'text', placeholder: '例如：平静友好' },
					{ field: 'ttsSessionOptions', label: 'session options', hint: '空格分隔，形如 index_tts2.mem_saver=true。', kind: 'list' },
				],
			},
			{
				key: 'sectionAsr',
				fields: [
					{ field: 'asrFamily', label: '模型家族', hint: 'audio.cpp --family，例如 sense_asr。', kind: 'text' },
					{ field: 'asrChunkMode', label: '分块方式', hint: 'fixed 最稳；auto/vad 会用 VAD 切分（输入会自动转成 16k 单声道）。', kind: 'enum', values: ['fixed', 'auto', 'vad', 'none'] },
					{ field: 'asrChunkSeconds', label: '分块秒数', hint: 'fixed 时是每段时长；auto/vad 时是单段上限。', kind: 'number', unit: 's' },
					{ field: 'asrLanguage', label: '默认识别语言', hint: 'auto 或 zh/en/yue/ja/ko…。', kind: 'text' },
					{ field: 'asrEnableItn', label: '逆文本规整', hint: '开 = 数字与标点会被规整。', kind: 'boolean', fallback: true },
					{ field: 'asrMinSegmentMs', label: '最短句段', hint: '句级时间戳：短于该时长的 VAD 段丢弃。', kind: 'number', unit: 'ms' },
					{ field: 'asrMergeGapMs', label: '合并间隔', hint: '句级时间戳：间隔小于该值的相邻语音段合并成一句。', kind: 'number', unit: 'ms' },
					{ field: 'asrSessionOptions', label: 'session options', hint: '空格分隔，形如 sense_asr.weight_type=q8_0。', kind: 'list' },
				],
			},
			{
				key: 'sectionOutput',
				fields: [{ field: 'outputFolder', label: '输出文件夹名', hint: '在当前会话工作目录下创建该文件夹；只填名称，默认 audio_toolkit_outputs。', kind: 'text', placeholder: 'audio_toolkit_outputs' }],
			},
		]

		/** Build the spec list the form model requires (one per editable field). */
		function buildSpecs() {
			const specs = []
			for (const section of SECTIONS) {
				for (const entry of section.fields) {
					if (entry.kind === 'number') specs.push(numberSpec(entry.field))
					else if (entry.kind === 'boolean') specs.push(booleanSpec(entry.field))
					else if (entry.kind === 'enum') specs.push(enumSpec(entry.field, entry.values))
					else if (entry.kind === 'list') specs.push(listSpec(entry.field))
					else specs.push(textSpec(entry.field))
				}
			}
			// Not rendered as rows: the gate writes setupChoice and the start/stop
			// buttons write engineEnabled.
			specs.push(textSpec('setupChoice'))
			specs.push(booleanSpec('engineEnabled'))
			// Only edited from the first-run guide (auto install page).
			specs.push(booleanSpec('assetsAutoDownload'))
			specs.push(booleanSpec('assetsProxyEnabled'))
			specs.push(textSpec('assetsProxy'))
			return specs
		}
		//#endregion

		//#region controller
		/** Bridges the `audio-toolkit` settings namespace onto the page's staged form. */
		class AudioToolkitCardController {
			constructor(scope) {
				this.form = new prim.SettingsFormModel(scope, buildSpecs())
				this.store = this.form.bind(() => this.projection())
				this.assets = new AssetsStatusStore()
			}

			projection() {
				const projected = { ...this.form.shell() }
				for (const section of SECTIONS) {
					for (const entry of section.fields) projected[entry.field] = this.form.field(entry.field)
				}
				projected.setupChoice = this.form.field('setupChoice')
				projected.engineEnabled = this.form.field('engineEnabled')
				projected.assetsAutoDownload = this.form.field('assetsAutoDownload')
				projected.assetsProxyEnabled = this.form.field('assetsProxyEnabled')
				projected.assetsProxy = this.form.field('assetsProxy')
				return projected
			}

			inject() {
				return {
					hooks: { audioToolkitCard: this.store, audioToolkitAssets: this.assets.store },
					...this.form.actions(),
				}
			}

			dispose() {
				this.assets.dispose()
				this.form.dispose()
			}
		}
		//#endregion

		//#region assets card
		/** Platforms the release ships builds for (release tokens). */
		const ASSET_PLATFORMS = ['windows', 'ubuntu', 'macos']
		/** Backends the release ships builds for; uto follows the platform. */
		const ASSET_BACKENDS = ['auto', 'cuda', 'cpu', 'vulkan', 'rocm', 'metal']
		/** Host token → release platform token. */
		const HOST_PLATFORM = { win32: 'windows', linux: 'ubuntu', darwin: 'macos' }
		/** Small helper so the card does not import a formatter. */
		function formatBytes(value) {
			const units = ['B', 'KiB', 'MiB', 'GiB']
			let size = Number(value) || 0
			let unit = 0
			while (size >= 1024 && unit < units.length - 1) {
				size /= 1024
				unit += 1
			}
			return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
		}

		/**
		 * Polls the host's loopback assets API (`/status`, `/install`, `/cancel`).
		 *
		 * The settings form only speaks config, so asset state and progress come
		 * from that little server. Polling runs only while the card is mounted.
		 */
		class AssetsStatusStore {
			constructor() {
				this.subscribers = new Set()
				this.timer = null
				this.basePort = 8789
				this.port = 0
				this.inflight = false
				this.view = {
					loading: true,
					error: '',
					actionError: '',
					status: null,
					options: { release: true, models: true, platform: '', backend: '' },
				}
				this.subscribe = (notify) => {
					this.subscribers.add(notify)
					if (!this.timer) {
						this.refresh()
						this.timer = setInterval(() => this.refresh(), 1500)
					}
					return () => {
						this.subscribers.delete(notify)
						if (this.subscribers.size === 0) {
							clearInterval(this.timer)
							this.timer = null
						}
					}
				}
				this.getSnapshot = () => this.view
				// The host wraps this store into a React hook (same contract as the
				// form store), so the bundle itself never touches React hooks.
				this.store = {
					subscribe: this.subscribe,
					getSnapshot: this.getSnapshot,
					// React's useSyncExternalStore accepts an optional third argument;
					// providing it keeps the wrapper happy if the host passes all three.
					getServerSnapshot: this.getSnapshot,
				}
				this.install = this.install.bind(this)
				this.cancel = this.cancel.bind(this)
				this.refresh = this.refresh.bind(this)
				this.toggle = this.toggle.bind(this)
				this.choose = this.choose.bind(this)
				this.remove = this.remove.bind(this)
				this.setPort = this.setPort.bind(this)
				this.view = {
					...this.view,
					install: this.install,
					cancel: this.cancel,
					refresh: this.refresh,
					toggle: this.toggle,
					choose: this.choose,
					remove: this.remove,
					setPort: this.setPort,
				}
			}

			emit(patch) {
				this.view = { ...this.view, ...patch }
				for (const notify of this.subscribers) notify()
			}

			dispose() {
				if (this.timer) clearInterval(this.timer)
				this.timer = null
				this.subscribers.clear()
			}

			setPort(value) {
				const port = Number(value)
				if (!Number.isFinite(port) || port < 1024 || port === this.basePort) return
				this.basePort = port
				this.port = 0
			}

			toggle(key) {
				if (!(key in this.view.options)) return
				this.emit({ options: { ...this.view.options, [key]: !this.view.options[key] } })
			}

			choose(key, value) {
				if (key !== 'platform' && key !== 'backend') return
				this.emit({ options: { ...this.view.options, [key]: value } })
			}

			async refresh() {
				if (this.inflight) return
				this.inflight = true
				try {
					const candidates = this.port ? [this.port] : Array.from({ length: 6 }, (_, index) => this.basePort + index)
					for (const port of candidates) {
						try {
							const response = await fetch(`http://127.0.0.1:${port}/status`, { cache: 'no-store' })
							if (!response.ok) continue
							const status = await response.json()
							this.port = port
							this.emit({ loading: false, error: '', status })
							return
						} catch {
							/* try the next port */
						}
					}
					this.port = 0
					this.emit({ loading: false, error: 'unreachable', status: null })
				} finally {
					this.inflight = false
				}
			}

			async post(pathname, body) {
				if (!this.port) await this.refresh()
				if (!this.port) {
					this.emit({ actionError: '依赖服务不可达（插件刚重载时稍等再试）' })
					return
				}
				try {
					const response = await fetch(`http://127.0.0.1:${this.port}${pathname}`, {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify(body ?? {}),
					})
					if (!response.ok) {
						const detail = await response.text().catch(() => '')
						this.emit({ actionError: `安装请求被拒绝：HTTP ${response.status}${detail ? ` · ${detail.slice(0, 160)}` : ''}` })
						return
					}
					this.emit({ actionError: '' })
				} catch (error) {
					this.emit({ actionError: `安装请求失败：${error?.message ?? error}` })
					return
				}
				await this.refresh()
			}

			install() {
				return this.post('/install', { ...this.view.options })
			}

			async remove(question) {
				if (typeof window !== 'undefined' && typeof window.confirm === 'function' && question && !window.confirm(question)) return
				await this.post('/delete', {})
			}

			cancel() {
				return this.post('/cancel', {})
			}
		}

		/**
		 * First-run guide: pick how to obtain the runtime assets. The guide does not
		 * reveal the rest of the form — finishing the install does.
		 */
		function SetupGuide(props) {
			const { t, state, onAuto, onManual } = props
			const step = (title, body) =>
				jsxs(
					'div',
					{ style: { marginBottom: 10 }, children: [jsx('p', { style: { margin: '0 0 2px', fontSize: 13, fontWeight: 600 }, children: title }, 't'), jsx('p', { style: STYLE.cardHint, children: body }, 'b')] },
					title,
				)

			return jsxs(
				'div',
				{
					style: { maxWidth: 720 },
					children: [
						jsx('p', { style: { margin: '0 0 4px', fontSize: 15, fontWeight: 600 }, children: t('setupTitle') }, 'title'),
						jsx('p', { style: { margin: '0 0 14px', fontSize: 12, opacity: 0.75 }, children: t('setupIntro') }, 'intro'),
						step(t('setupStep1'), t('setupStep1Body')),
						jsx('div', {
							style: { ...STYLE.control, marginTop: 12 },
							children: [
								jsx(prim.Button, { variant: 'primary', onClick: () => onAuto(), children: t('setupAuto') }, 'auto'),
								jsx(prim.Button, { variant: 'outline', onClick: () => onManual(), children: t('setupManual') }, 'manual'),
							],
						}, 'actions'),
						jsx('p', { style: { ...STYLE.hint, marginTop: 10 }, children: t('setupLater') }, 'later'),
					],
				},
				'setup',
			)
		}
		/** The "runtime assets" card: status, install options, progress. */
		function AssetsCard(props) {
			const { t, state, assets, manual, form } = props
			if (!assets) return null
			const status = assets.status
			const install = status?.install
			const running = Boolean(install?.running)
			const ready = Boolean(status?.ready)
			const missing = status?.missing ?? []
			const total = Number(install?.total) || 0
			const done = Number(install?.done) || 0
			const percent = running && total > 0 ? Math.min(100, Math.floor((done / total) * 100)) : 0
			const writable = Boolean(state?.writable)
			const windows = status?.platform === 'win32'
			// Ready: the guide and the install controls disappear; only a compact
			// status row with a delete action remains.
			if (ready && !manual) {
				return jsxs(
					'div',
					{
						style: { ...STYLE.row, padding: '4px 0' },
						children: [
							jsx(prim.Tag, { tone: 'neutral', children: `✓ ${t('assetsReady')}` }, 'badge'),
							jsx('code', { style: STYLE.code, children: formatBytes(status.sizes.release + status.sizes.models) }, 'size'),
							jsx('span', { style: { ...STYLE.hint, flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis' }, children: status.root }, 'root'),
							jsx(
								prim.Button,
								{
									variant: 'outline',
									onClick: () => assets.remove(t('assetsDeleteConfirm')),
									children: t('assetsDelete'),
								},
								'delete',
							),
						],
					},
					'assets',
				)
			}

			const badge = jsx(
				prim.Tag,
				{
					tone: ready ? 'neutral' : 'outline',
					children: ready ? `✓ ${t('assetsReady')}` : `${t('assetsMissing')}: ${missing.join('、') || '—'}`,
				},
				'badge',
			)

			const sizes = status
				? jsx('code', { style: STYLE.code, children: `${formatBytes(status.sizes.release + status.sizes.models)}` }, 'sizes')
				: null

			const progress = running
				? jsxs(
						'div',
						{
							style: STYLE.rowStacked,
							children: [
								jsx('progress', { value: percent, max: 100, style: STYLE.full }, 'bar'),
								jsx(
									'span',
									{
										style: STYLE.hint,
										children: `${t('assetsInstalling')} · ${install.phase || ''} ${install.file || ''} ${percent}% (${formatBytes(done)} / ${total ? formatBytes(total) : '?'})`,
									},
									'detail',
								),
							],
						},
						'progress',
					)
				: null

			const failureText = assets.actionError || (install?.error && !running ? install.error : '')
			const failure = failureText ? jsx('p', { style: STYLE.invalid, children: failureText }, 'error') : null

			const options = jsxs(
				'div',
				{
					style: STYLE.row,
					children: [
						jsx('span', { style: STYLE.hint, children: t('assetsOptions') }, 'label'),
						jsx('label', { style: STYLE.hint, children: [jsx('input', { type: 'checkbox', checked: assets.options.release, onChange: () => assets.toggle('release'), disabled: running }, 'release'), ` ${t('assetsRelease')}`] }, 'optRelease'),
						jsx('label', { style: STYLE.hint, children: [jsx('input', { type: 'checkbox', checked: assets.options.models, onChange: () => assets.toggle('models'), disabled: running }, 'models'), ` ${t('assetsModels')}`] }, 'optModels'),
					],
				},
				'options',
			)

			const platform = assets.options.platform || HOST_PLATFORM[status?.platform] || 'windows'
			const configuredBackend = String(state?.backend?.text ?? '')
			const backend = assets.options.backend || (['cuda', 'cpu', 'vulkan'].includes(configuredBackend) ? configuredBackend : 'auto')
			const selects = jsxs(
				'div',
				{
					style: STYLE.row,
					children: [
						jsx('span', { style: STYLE.hint, children: t('assetsTarget') }, 'label'),
						jsx(
							'select',
							{
								value: platform,
								disabled: running,
								onChange: (event) => assets.choose('platform', event.target.value),
								children: ASSET_PLATFORMS.map((value) => jsx('option', { value, children: value }, value)),
							},
							'platform',
						),
						jsx(
							'select',
							{
								value: backend,
								disabled: running,
								onChange: (event) => assets.choose('backend', event.target.value),
								children: ASSET_BACKENDS.map((value) => jsx('option', { value, children: value }, value)),
							},
							'backend',
						),
					],
				},
				'target',
			)

			// Manual mode: the user drops the files in place and only refreshes.
			const manualInfo = manual
				? jsxs(
						'div',
						{
							style: STYLE.rowStacked,
							children: [
								jsx('p', { style: { ...STYLE.hint, fontWeight: 600 }, children: t('manualTitle') }, 'title'),
								jsx('p', { style: STYLE.hint, children: t('manualBody') }, 'body'),
								jsx('code', { style: STYLE.code, children: `${status?.root ?? ''}/bin/audio.cpp` }, 'bin'),
								jsx('code', { style: STYLE.code, children: `${status?.root ?? ''}/bin/models/…` }, 'models'),
							],
						},
						'manual',
					)
				: null


			const actions = manual
				? jsxs(
						'div',
						{ style: { ...STYLE.control, marginTop: 8 }, children: [jsx(prim.Button, { variant: 'outline', onClick: () => assets.refresh(), children: t('manualRefresh') }, 'refresh')] },
						'actions',
					)
				: jsxs(
						'div',
						{
							style: STYLE.control,
							children: [
								jsx(prim.Button, { variant: 'primary', disabled: ready || running || !writable || !windows, onClick: () => assets.install(), children: t('assetsInstallAll') }, 'install'),
								jsx(prim.Button, { variant: 'outline', disabled: !running, onClick: () => assets.cancel(), children: t('assetsCancel') }, 'cancel'),
								jsx(prim.Button, { variant: 'outline', onClick: () => assets.refresh(), children: t('assetsRefresh') }, 'refresh'),
							],
						},
						'actions',
					)

			const note = status
				? jsx('p', { style: STYLE.hint, children: `${t('assetsRoot')}: ${status.root}${windows ? '' : ` · ${t('assetsUnavailable')}`}` }, 'note')
				: jsx('p', { style: STYLE.hint, children: assets.loading ? '…' : t('assetsPortDown') }, 'note')

			return jsxs(
				'div',
				{
					style: STYLE.card,
					children: [
						jsxs('div', { style: STYLE.cardHead, children: [jsx('p', { style: STYLE.cardTitle, children: t('assetsTitle') }, 'title'), badge, sizes] }, 'head'),
						jsx('p', { style: STYLE.cardHint, children: t('assetsHint') }, 'hint'),
						manual ? null : options,
						manual ? null : selects,
						progress,
						failure,
						manualInfo,
						actions,
						note,
					],
				},
				'assets',
			)
		}
		//#endregion
		//#region page
		// Layout tokens: the page only gets inline styles, so keep them in one place.
		const STYLE = {
			card: {
				border: '1px solid rgba(127,127,127,0.22)',
				borderRadius: 10,
				padding: '12px 14px',
				marginBottom: 12,
			},
			cardHead: { display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 10 },
			cardTitle: { margin: 0, fontSize: 13, fontWeight: 600 },
			cardHint: { margin: 0, fontSize: 11, opacity: 0.6 },
			row: { display: 'flex', alignItems: 'center', gap: 12, padding: '7px 0' },
			rowStacked: { display: 'grid', gap: 6, padding: '7px 0' },
			labelGroup: { flex: '1 1 auto', minWidth: 0 },
			labelLine: { display: 'flex', alignItems: 'center', gap: 6 },
			label: { fontSize: 13 },
			code: { fontSize: 10.5, opacity: 0.45 },
			hint: { margin: '2px 0 0', fontSize: 11, opacity: 0.62, lineHeight: 1.45 },
			invalid: { margin: '2px 0 0', fontSize: 11, color: '#d9534f', lineHeight: 1.45 },
			control: { flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 8 },
			full: { width: '100%' },
			badgeRow: { display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 },
			strip: {
				display: 'flex',
				alignItems: 'center',
				gap: 8,
				flexWrap: 'wrap',
				padding: '10px 12px',
				borderRadius: 10,
				background: 'rgba(127,127,127,0.08)',
				marginBottom: 12,
			},
		}

		/** One labeled row: name + JSON key + hint on the left, control on the right. */
		function Row(props) {
			const { entry, state, t, onReset, stacked, children } = props
			const fieldState = state[entry.field] ?? { text: '', overridden: false, invalid: false }
			const meta = jsx(
				'div',
				{
					style: STYLE.labelGroup,
					children: [
						jsxs(
							'div',
							{
								style: STYLE.labelLine,
								children: [
									jsx('span', { style: STYLE.label, children: entry.label }, 'label'),
									jsx('code', { style: STYLE.code, children: entry.field }, 'key'),
									fieldState.overridden
										? jsx(prim.Tag, { tone: 'neutral', children: t('overriddenLabel') }, 'overridden')
										: null,
									fieldState.overridden
										? jsx(
												prim.Button,
												{
													variant: 'outline',
													disabled: !state.writable,
													onClick: onReset,
													children: t('resetLabel'),
												},
												'reset',
											)
										: null,
								],
							},
							'line',
						),
						fieldState.invalid
							? jsx('p', { style: STYLE.invalid, role: 'status', children: t('invalidLabel') }, 'invalid')
							: entry.hint
								? jsx('p', { style: STYLE.hint, children: entry.hint }, 'hint')
								: null,
					],
				},
				'meta',
			)
			return jsx('div', { style: stacked ? STYLE.rowStacked : STYLE.row, children: [meta, children] }, entry.field)
		}

		/** Text / path field. */
		function TextField(props) {
			const { entry, state, edit, resetField, t } = props
			const fieldState = state[entry.field] ?? { text: '' }
			return jsx(
				Row,
				{
					entry,
					state,
					t,
					stacked: true,
					onReset: () => resetField(entry.field),
					children: jsx(
						prim.Input,
						{
							id: `audio-toolkit-${entry.field}`,
							style: STYLE.full,
							value: fieldState.text,
							placeholder: entry.placeholder ?? '',
							disabled: !state.writable,
							spellCheck: false,
							onChange: (event) => edit(entry.field, event.target.value),
						},
						'input',
					),
				},
				entry.field,
			)
		}

		/** Numeric field; `unit` is shown as a suffix tag. */
		function NumberField(props) {
			const { entry, state, edit, resetField, t } = props
			const fieldState = state[entry.field] ?? { text: '' }
			return jsx(
				Row,
				{
					entry,
					state,
					t,
					onReset: () => resetField(entry.field),
					children: jsxs(
						'div',
						{
							style: STYLE.control,
							children: [
								jsx(
									prim.Input,
									{
										id: `audio-toolkit-${entry.field}`,
										style: { width: 110, textAlign: 'right' },
										value: fieldState.text,
										inputMode: 'numeric',
										disabled: !state.writable,
										onChange: (event) => edit(entry.field, event.target.value),
									},
									'input',
								),
								entry.unit ? jsx(prim.Tag, { tone: 'quiet', children: entry.unit }, 'unit') : null,
							],
						},
						'control',
					),
				},
				entry.field,
			)
		}

		/** Boolean field rendered as a real switch. */
		function BooleanField(props) {
			const { entry, state, edit, resetField, t } = props
			const fieldState = state[entry.field] ?? { text: '' }
			const text = String(fieldState.text).toLowerCase()
			const checked = text === '' ? entry.fallback === true : text === 'true'
			return jsx(
				Row,
				{
					entry,
					state,
					t,
					onReset: () => resetField(entry.field),
					children: jsxs(
						'div',
						{
							style: STYLE.control,
							children: [
								jsx(prim.Tag, { tone: checked ? 'info' : 'quiet', children: checked ? t('on') : t('off') }, 'state'),
								jsx(
									prim.Switch,
									{
										checked,
										label: entry.label,
										disabled: !state.writable,
										onChange: (next) => edit(entry.field, next ? 'true' : 'false'),
									},
									'switch',
								),
							],
						},
						'control',
					),
				},
				entry.field,
			)
		}

		/** Enum field rendered as a segmented control. */
		function EnumField(props) {
			const { entry, state, edit, resetField, t } = props
			const fieldState = state[entry.field] ?? { text: '' }
			const options = entry.values.map((value) => ({ value, label: value }))
			const value = entry.values.includes(fieldState.text) ? fieldState.text : entry.values[0]
			return jsx(
				Row,
				{
					entry,
					state,
					t,
					stacked: true,
					onReset: () => resetField(entry.field),
					children: jsx(
						'div',
						{
							style: { paddingTop: 2 },
							children: jsx(
								prim.SegmentedControl,
								{
									id: `audio-toolkit-${entry.field}`,
									value,
									options,
									label: entry.label,
									disabled: !state.writable,
									onChange: (next) => edit(entry.field, next),
								},
								'segments',
							),
						},
						'segments-host',
					),
				},
				entry.field,
			)
		}

		/** Whitespace-separated list field: text input plus parsed-token tags. */
		function ListField(props) {
			const { entry, state, edit, resetField, t } = props
			const fieldState = state[entry.field] ?? { text: '' }
			const tokens = String(fieldState.text).trim().split(/\s+/).filter(Boolean)
			return jsx(
				Row,
				{
					entry,
					state,
					t,
					stacked: true,
					onReset: () => resetField(entry.field),
					children: jsxs(
						'div',
						{
							children: [
								jsx(
									prim.Input,
									{
										id: `audio-toolkit-${entry.field}`,
										style: STYLE.full,
										value: fieldState.text,
										placeholder: entry.placeholder ?? '',
										disabled: !state.writable,
										onChange: (event) => edit(entry.field, event.target.value),
									},
									'input',
								),
								tokens.length > 0
									? jsx(
											'div',
											{
												style: STYLE.badgeRow,
												children: tokens.map((token) =>
													jsx(prim.Tag, { tone: 'outline', children: token }, `${entry.field}-${token}`),
												),
											},
											'tokens',
										)
									: null,
							],
						},
						'control',
					),
				},
				entry.field,
			)
		}

		/** Pick the control for one field entry. */
		function Field(props) {
			const { entry } = props
			if (entry.kind === 'boolean') return jsx(BooleanField, props, entry.field)
			if (entry.kind === 'enum') return jsx(EnumField, props, entry.field)
			if (entry.kind === 'number') return jsx(NumberField, props, entry.field)
			if (entry.kind === 'list') return jsx(ListField, props, entry.field)
			return jsx(TextField, props, entry.field)
		}

		/** The bundle page's config section: heading, status strip, then the full form. */
		function AudioToolkitPage(props) {
			// `renderSlot` injects the slot's locale reader as `t`; fall back to the zh
			// dictionary so the page still renders when a host omits it.
			const t = typeof props.t === 'function' ? props.t : (key) => zh[key] ?? key
			if (props.view !== 'page') return t('summary')
			const state =
				typeof props.useAudioToolkitCard === 'function'
					? props.useAudioToolkitCard((snapshot) => snapshot)
					: { available: false, writable: false, dirty: false, invalid: false, saving: false, failed: false }
			const engineEnabledText = String(state.engineEnabled?.text ?? '').toLowerCase()
			const engineOn = engineEnabledText === '' ? true : engineEnabledText === 'true'

			// Asset status/progress come from the host's loopback service; the hook
			// only polls while the card is mounted.
			// The host exposes the injected store as useSelector(store, selector), so a
			// selector is mandatory — same call shape as the form store above.
			const assets =
				typeof props.useAudioToolkitAssets === 'function'
					? props.useAudioToolkitAssets((snapshot) => snapshot)
					: null
			if (assets && typeof assets.setPort === 'function') assets.setPort(state.assetsApiPort?.text)
			const setupChoice = String(state.setupChoice?.text ?? '')
			const assetsCard = jsx(AssetsCard, { t, state, assets, manual: setupChoice === 'manual', form: props }, 'assets')

			const header = jsxs(
				'div',
				{
					style: { marginBottom: 10 },
					children: [
						jsx('p', { style: { margin: 0, fontSize: 14, fontWeight: 600 }, children: t('title') }, 'title'),
						jsx('p', { style: { margin: '4px 0 0', fontSize: 12, opacity: 0.72 }, children: t('summary') }, 'summary'),
					],
				},
				'header',
			)

			// First run: nothing else is usable until the assets exist. The gate is
			// tied to `ready`, not to the choice, so picking a mode does not reveal
			// the rest of the form — and it never starts a download by itself.
			const assetsReady = Boolean(assets?.status?.ready)
			if (assets && assets.status && !assetsReady) {
				const chooseAuto = () => {
					props.edit('setupChoice', 'auto')
					props.save()
				}
				const chooseManual = () => {
					props.edit('setupChoice', 'manual')
					props.save()
				}
				const proxyEnabled = String(state.assetsProxyEnabled?.text ?? '').toLowerCase() === 'true'

				// Platform-specific manual instructions (the release names differ).
				const statusPlatform = assets?.status?.platform ?? ''
				const osToken = { win32: 'windows', linux: 'ubuntu', darwin: 'macos' }[statusPlatform] ?? 'windows'
				const arch = assets?.status?.arch === 'arm64' ? 'arm64' : 'x64'
				const manualBackend = String(state.backend?.text ?? '') || (osToken === 'macos' ? 'metal' : 'cuda')
				const archiveExt = osToken === 'windows' ? '.zip' : '.tar.gz'
				const releaseExample = `audio-vX-bin-${osToken}-${arch}-${manualBackend}${archiveExt}`
				const serverName = osToken === 'windows' ? 'audiocpp_server.exe' : 'audiocpp_server'
				const ffmpegName = osToken === 'windows' ? 'ffmpeg.exe' : 'ffmpeg'
				const manualAssets =
					osToken === 'windows'
						? [
								['release', `下载 ${releaseExample}，解压后把 ${serverName} 等文件放到 <root>/bin/audio.cpp。`],
								['models', '三个模型放到 <root>/bin/models/{IndexTTS2.5-GGUF,SenseVoice-Small-GGUF,PulseVAD-GGUF}。'],
								['ffmpeg', `ffmpeg 放到 <root>/bin/ffmpeg/${ffmpegName}（或 PATH 上）。`],
							]
						: osToken === 'macos'
							? [
									['release', `下载 ${releaseExample}（release 目前只提供 arm64 的 metal 构建），解压到 <root>/bin/audio.cpp，并 chmod +x ${serverName}。`],
									['models', '三个模型放到 <root>/bin/models/{IndexTTS2.5-GGUF,SenseVoice-Small-GGUF,PulseVAD-GGUF}。'],
									['ffmpeg', `自动安装会下载 osxexperts 的 ffmpeg（按 arm64/intel 选择）；手动时用 brew install ffmpeg，或放到 <root>/bin/ffmpeg/${ffmpegName}。`],
								]
							: [
									['release', `下载 ${releaseExample}（CUDA 选 cuda 还需同版本 cudart 包），解压到 <root>/bin/audio.cpp，并 chmod +x ${serverName}。`],
									['models', '三个模型放到 <root>/bin/models/{IndexTTS2.5-GGUF,SenseVoice-Small-GGUF,PulseVAD-GGUF}。'],
									['ffmpeg', `用系统包管理器安装 ffmpeg（或放到 <root>/bin/ffmpeg/${ffmpegName}）。`],
								]

				let body
				if (setupChoice === 'auto') {
					body = jsxs(
						'div',
						{
							children: [
								jsx('p', { style: STYLE.hint, children: t('autoRunning') }, 'auto-hint'),
								jsx('label', {
									style: { ...STYLE.hint, display: 'flex', alignItems: 'center', gap: 6 },
									children: [
										jsx('input', {
											type: 'checkbox',
											checked: proxyEnabled,
											onChange: (event) => {
												props.edit('assetsProxyEnabled', event.target.checked ? 'true' : 'false')
												props.save()
											},
										}, 'proxy-toggle'),
										t('setupProxyEnable'),
									],
								}, 'proxy-label'),
								jsx('input', {
									style: { ...STYLE.full, opacity: proxyEnabled ? 1 : 0.5 },
									value: String(state.assetsProxy?.text ?? ''),
									placeholder: 'http://127.0.0.1:7890',
									disabled: !proxyEnabled,
									onChange: (event) => props.edit('assetsProxy', event.target.value),
									// Persist before the install button reads the config.
									onBlur: () => props.save(),
								}, 'proxy'),
								jsx('p', { style: STYLE.hint, children: t('setupProxyOptional') }, 'proxy-hint'),
								assetsCard,
								jsx(prim.Button, { variant: 'outline', onClick: () => { props.edit('setupChoice', 'manual'); props.save() }, children: t('switchToManual') }, 'switch-manual'),
							],
						},
						'auto',
					)
				} else if (setupChoice === 'manual') {
					body = jsxs(
						'div',
						{
							children: [
								jsx('p', { style: STYLE.hint, children: t('manualWaiting') }, 'manual-hint'),
								...manualAssets.map(([key, text]) => jsx('p', { style: STYLE.hint, children: text }, key)),
								jsx('p', { style: STYLE.hint, children: t('manualSources') }, 'manual-sources'),
								assetsCard,
								jsx(prim.Button, { variant: 'outline', onClick: () => { props.edit('setupChoice', 'auto'); props.save() }, children: t('switchToAuto') }, 'switch-auto'),
							],
						},
						'manual',
					)
				} else {
					body = jsx(SetupGuide, { t, state, onAuto: chooseAuto, onManual: chooseManual }, 'setup')
				}

				// No SettingsForm here: its Save/Discard bar has nothing to do during
				// onboarding, and the guide writes values through the form actions.
				return jsxs('div', { children: [header, body] }, 'fields')
			}
			const strip = jsxs(
				'div',
				{
					style: STYLE.strip,
					children: [
						jsx(prim.Tag, { tone: engineOn ? 'info' : 'danger', children: engineOn ? t('engineOn') : t('engineOff') }, 'engine-state'),
						jsx(prim.Tag, { tone: 'outline', children: `:${state.enginePort?.text || '8788'}` }, 'port'),
						jsx(prim.Tag, {
							tone: state.dirty ? 'neutral' : 'quiet',
							children: state.dirty ? t('dirty') : t('saved'),
						}, 'dirty'),
						jsx('span', { style: { fontSize: 12, opacity: 0.7 }, children: t('engineHint') }, 'hint'),
					],
				},
				'strip',
			)

			const engineBar = jsxs(
				'div',
				{
					style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', margin: '0 0 12px' },
					children: [
						jsx(
							prim.Button,
							{
								variant: 'primary',
								disabled: !state.writable || engineOn,
								onClick: () => {
									props.edit('engineEnabled', 'true')
									props.save()
								},
								children: t('startEngine'),
							},
							'start',
						),
						jsx(
							prim.Button,
							{
								variant: 'outline',
								disabled: !state.writable || !engineOn,
								onClick: () => {
									props.edit('engineEnabled', 'false')
									props.save()
								},
								children: t('stopEngine'),
							},
							'stop',
						),
					],
				},
				'engine-bar',
			)

			const sections = SECTIONS.map((section) =>
				jsxs(
					'section',
					{
						style: STYLE.card,
						children: [
							jsxs(
								'div',
								{
									style: STYLE.cardHead,
									children: [
										jsx('p', { style: STYLE.cardTitle, children: t(section.key) }, 'title'),
									],
								},
								'head',
							),
							...section.fields.map((entry) =>
								jsx(Field, { t, entry, state, edit: props.edit, resetField: props.resetField }, entry.field),
							),
						],
					},
					section.key,
				),
			)

			return jsx(prim.SettingsForm, {
				labels: formLabels(t),
				state,
				onSave: props.save,
				onDiscard: props.discard,
				children: jsxs('div', { children: [header, strip, assetsCard, engineBar, ...sections] }, 'fields'),
			})
		}
		//#endregion

		//#region page registration
		/** Required client services. */
		const inject = ['slots', 'locale', 'configForms']

		/** Bundle package name: the key the Plugins page filters its config slot by. */
		const BUNDLE = 'dsh-audio-toolkit'

		/**
		 * Mount the form on the Plugins page.
		 *
		 * The page renders the config section of a bundle's detail view from the
		 * `plugins.bundle.config` **keyed** slot, filtered by the bundle's package
		 * name (`entryKey`); `configured` on that page is exactly
		 * `ledger.bundles.has(pkg.name)`. Registering only into `plugins.item` (the
		 * official-plugin list) leaves a third-party bundle with no visible form, so
		 * both surfaces are registered and share one form store.
		 *
		 * @param ctx - the browser plugin context.
		 */
		function apply(ctx) {
			ctx.effect(
				() => ctx.locale.register(LOCALE_NS, { zh, en }),
				'dsh-audio-toolkit: dictionaries',
			)
			const t = ctx.locale.bind(LOCALE_NS)
			const card = new AudioToolkitCardController(ctx.configForms.get(NAMESPACE))
			ctx.effect(() => () => card.dispose(), 'dsh-audio-toolkit: form subscription')
			ctx.effect(
				() =>
					ctx.configForms.whileServed([NAMESPACE], () => {
						const offs = []
						// Primary: the "configuration" section on this bundle's own page.
						offs.push(
							ctx.slots.inject('plugins.bundle.config', () =>
								ctx.slots.register(
									{
										name: 'plugins.bundle.config',
										key: BUNDLE,
										locale: LOCALE_NS,
										inject: () => card.inject(),
									},
									AudioToolkitPage,
								),
							),
						)
						// Also expose a labelled entry for shells that list plugin items.
						offs.push(
							ctx.slots.inject('plugins.item', () =>
								ctx.slots.register(
									{
										name: 'plugins.item',
										id: BUNDLE,
										order: 40,
										label: () => t('title'),
										locale: LOCALE_NS,
										inject: () => card.inject(),
									},
									AudioToolkitPage,
								),
							),
						)
						return () => {
							for (const off of offs) if (typeof off === 'function') off()
						}
					}),
				'dsh-audio-toolkit: page',
			)
		}
		//#endregion

		exports.NS = LOCALE_NS
		exports.apply = apply
		exports.inject = inject
		return module.exports
	},
})

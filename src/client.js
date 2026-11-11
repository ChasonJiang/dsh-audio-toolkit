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
			hintEngine: '常驻进程与端口，保存后按需重启',
			hintMcp: '工具调用超时与并发',
			hintAudioCpp: '运行时目录与推理后端',
			hintTts: 'IndexTTS2.5 fp16 模型与音色',
			hintAsr: 'SenseVoice 模型与分块策略',
			hintOutput: '合成产物落在哪里',
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
			hintEngine: 'Resident process and port',
			hintMcp: 'Tool timeout and concurrency',
			hintAudioCpp: 'Runtime paths and backend',
			hintTts: 'IndexTTS2.5 fp16 model and voices',
			hintAsr: 'SenseVoice model and chunking',
			hintOutput: 'Where synthesized audio lands',
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
				hintKey: 'hintEngine',
				fields: [
					{ field: 'engineEnabled', label: '引擎启用（手动启停）', hint: '开 = 启动并保持运行；关 = 停止引擎。保存后立即生效。', kind: 'boolean', fallback: true },
					{ field: 'engineAutoStart', label: '随 DSH 自动启动', hint: 'DSH 启动/插件启用时自动拉起引擎（懒加载，首次请求才占显存）。', kind: 'boolean', fallback: true },
					{ field: 'engineHost', label: '监听地址', hint: '保持 127.0.0.1。', kind: 'text' },
					{ field: 'enginePort', label: '端口', hint: '被占用时改这里并保存（引擎会自动重启）。', kind: 'number' },
				],
			},
			{
				key: 'sectionMcp',
				hintKey: 'hintMcp',
				fields: [
					{ field: 'mcpServerName', label: 'MCP 服务名', hint: '仅独立 MCP 服务使用；原生工具名固定为 audio_toolkit_*。', kind: 'text' },
					{ field: 'toolCallTimeoutMs', label: '调用超时', hint: '单次 TTS/ASR 请求的等待上限。', kind: 'number', unit: 'ms' },
					{ field: 'maxConcurrentCalls', label: '并发请求数', hint: '常驻引擎每模型串行，1-2 足够。', kind: 'number', unit: '个' },
				],
			},
			{
				key: 'sectionAudioCpp',
				hintKey: 'hintAudioCpp',
				fields: [
					{ field: 'binDir', label: 'audio.cpp 目录', hint: '留空 = <仓库>/bin/audio.cpp。', kind: 'text', placeholder: '自动' },
					{ field: 'cliPath', label: 'audiocpp_cli 路径', hint: '仅状态检查用；留空 = <binDir>/audiocpp_cli.exe。', kind: 'text', placeholder: '自动' },
					{ field: 'ffmpegPath', label: 'ffmpeg 路径', hint: '留空 = <仓库>/bin/ffmpeg/ffmpeg.exe（找不到时回退 PATH）；也可填所在目录。用于音频转码。', kind: 'text', placeholder: '自动' },
					{ field: 'modelsDir', label: '模型目录', hint: '留空 = <仓库>/bin/models。', kind: 'text', placeholder: '自动' },
					{ field: 'backend', label: '推理后端', hint: '改后引擎自动重启。', kind: 'enum', values: ['cuda', 'cpu', 'vulkan'] },
					{ field: 'device', label: 'GPU 序号', hint: '多卡时选择设备。', kind: 'number' },
					{ field: 'threads', label: '线程数', hint: '0 = 自动。', kind: 'number' },
					{ field: 'extraArgs', label: '额外参数', hint: '空格分隔；一般留空。', kind: 'list' },
				],
			},
			{
				key: 'sectionTts',
				hintKey: 'hintTts',
				fields: [
					{ field: 'ttsFamily', label: '模型家族', hint: 'audio.cpp --family，例如 index_tts2。', kind: 'text' },
					{ field: 'ttsModel', label: '模型路径', hint: '留空 = <modelsDir>/IndexTTS2.5-GGUF/index-tts2_5-f16.gguf（fp16）。', kind: 'text' },
					{ field: 'ttsDefaultVoiceRef', label: '默认参考音色', hint: 'IndexTTS2.5 必须给参考音色；留空则调用时需传 voice_path。', kind: 'text', placeholder: '选择或留空' },
					{ field: 'ttsVoiceDir', label: '音色目录', hint: '留空 = <仓库>/voices，audio_toolkit_tts_list_voices 列这里的 wav。', kind: 'text', placeholder: '自动' },
					{ field: 'ttsLanguage', label: '默认语言', hint: 'auto 按文本推断。', kind: 'enum', values: ['auto', 'zh', 'en', 'ja', 'es', 'ar'] },
					{ field: 'ttsEmotion', label: '默认情绪文本', hint: '可留空；调用时也能覆盖。', kind: 'text', placeholder: '例如：平静友好' },
					{ field: 'ttsSessionOptions', label: 'session options', hint: '空格分隔，形如 index_tts2.mem_saver=true。', kind: 'list' },
				],
			},
			{
				key: 'sectionAsr',
				hintKey: 'hintAsr',
				fields: [
					{ field: 'asrFamily', label: '模型家族', hint: 'audio.cpp --family，例如 sense_asr。', kind: 'text' },
					{ field: 'asrModel', label: '模型路径', hint: '留空 = <modelsDir>/SenseVoice-Small-GGUF/sensevoice-small-q8-audiocpp-v1.gguf。', kind: 'text' },
					{ field: 'asrVadModel', label: 'VAD 模型', hint: 'auto/vad 分块用；留空 = <modelsDir>/PulseVAD-GGUF/pulsevad-2.1k-f32.gguf。', kind: 'text' },
					{ field: 'asrChunkMode', label: '分块方式', hint: 'fixed 最稳；auto/vad 需要 VAD 且要求 16k 单声道输入。', kind: 'enum', values: ['fixed', 'auto', 'vad', 'none'] },
					{ field: 'asrChunkSeconds', label: '分块秒数', hint: 'fixed 模式下每段时长。', kind: 'number', unit: 's' },
					{ field: 'asrLanguage', label: '默认识别语言', hint: 'auto 或 zh/en/yue/ja/ko…。', kind: 'text' },
					{ field: 'asrEnableItn', label: '逆文本规整', hint: '开 = 数字与标点会被规整。', kind: 'boolean', fallback: true },
					{ field: 'asrMinSegmentMs', label: '最短句段', hint: '句级时间戳：短于该时长的 VAD 段丢弃。', kind: 'number', unit: 'ms' },
					{ field: 'asrMergeGapMs', label: '合并间隔', hint: '句级时间戳：间隔小于该值的相邻语音段合并成一句。', kind: 'number', unit: 'ms' },
					{ field: 'asrSessionOptions', label: 'session options', hint: '空格分隔，形如 sense_asr.weight_type=q8_0。', kind: 'list' },
				],
			},
			{
				key: 'sectionOutput',
				hintKey: 'hintOutput',
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
			return specs
		}
		//#endregion

		//#region controller
		/** Bridges the `audio-toolkit` settings namespace onto the page's staged form. */
		class AudioToolkitCardController {
			constructor(scope) {
				this.form = new prim.SettingsFormModel(scope, buildSpecs())
				this.store = this.form.bind(() => this.projection())
			}

			projection() {
				const projected = { ...this.form.shell() }
				for (const section of SECTIONS) {
					for (const entry of section.fields) projected[entry.field] = this.form.field(entry.field)
				}
				return projected
			}

			inject() {
				return {
					hooks: { audioToolkitCard: this.store },
					...this.form.actions(),
				}
			}

			dispose() {
				this.form.dispose()
			}
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
										section.hintKey ? jsx('p', { style: STYLE.cardHint, children: t(section.hintKey) }, 'hint') : null,
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
				children: jsxs('div', { children: [header, strip, engineBar, ...sections] }, 'fields'),
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

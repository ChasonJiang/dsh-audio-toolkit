#!/usr/bin/env node
/**
 * Headless checks for the browser half (`src/client.js`).
 *
 * The bundle is loaded by DSH's browser module loader, which is not available
 * here. This harness provides the same `window.__ModuleLoader__`/`require` shape
 * with tiny React and primitives stubs, then:
 *  - runs the factory,
 *  - calls `apply()` against a fake client context to capture the `plugins.item`
 *    registration,
 *  - calls the registered card component and counts the rendered fields.
 *
 * It cannot prove pixel layout, but it does prove the bundle parses, registers the
 * page for the right namespace, and renders one field per Config key.
 *
 * Usage: node test/client.mjs
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = resolve(HERE, '..')
const CLIENT = join(PACKAGE_ROOT, 'src', 'client.js')

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

// ---- stubs -----------------------------------------------------------------
// React is replaced by a plain-object renderer: `jsx()` records the element name
// so the test can walk the tree without React.
const jsx = (type, props, key) => ({
  type: typeof type === 'function' ? type.displayName || type.name : type,
  component: type,
  props,
  key,
  children: props?.children,
})
function SettingsForm(props) {
  return { type: 'SettingsForm', props }
}
function SettingsValueField(props) {
  return { type: 'SettingsValueField', props }
}
function Button(props) {
  return { type: 'Button', props }
}
function Input(props) {
  return { type: 'Input', props }
}
function Switch(props) {
  return { type: 'Switch', props }
}
function SegmentedControl(props) {
  return { type: 'SegmentedControl', props }
}
function Tag(props) {
  return { type: 'Tag', props }
}
const reactStub = {
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useMemo: (factory) => factory(),
  useCallback: (fn) => fn,
}
const primitives = {
  SettingsForm,
  SettingsValueField,
  Button,
  Input,
  Switch,
  SegmentedControl,
  Tag,
  SettingsFormModel: class {
    constructor(scope, specs) {
      this.scope = scope
      this.specs = specs
      formSpecs = specs
      this.staged = new Map()
    }
    field(name) {
      return { text: '', overridden: false, invalid: false }
    }
    shell() {
      return { available: true, writable: true, dirty: false, invalid: false, saving: false, failed: false }
    }
    bind(projection) {
      return { getSnapshot: projection, set() {} }
    }
    actions() {
      return {
        edit: (name, text) => this.staged.set(name, text),
        resetField: (name) => this.staged.delete(name),
        save: () => {},
        discard: () => {},
      }
    }
    dispose() {}
  },
}

let loaded
/** Specs the card hands to `SettingsFormModel`, captured for the shape checks. */
let formSpecs = []
const windowStub = {
  __ModuleLoader__: {
    load: (definition) => {
      loaded = definition
    },
  },
}
globalThis.window = windowStub

const requireStub = (specifier) => {
  if (specifier === 'react/jsx-runtime') return { jsx, jsxs: jsx }
  if (specifier === 'react') return reactStub
  if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return primitives
  throw new Error(`unexpected require: ${specifier}`)
}

async function main() {
  // 1. factory + registration shape
  const source = readFileSync(CLIENT, 'utf8')
  // Evaluate as a classic script, like the browser does for a bundle entry.
  new Function('window', source)(windowStub)
  check('bundle registers with __ModuleLoader__', loaded !== undefined, loaded?.id)

  const module = loaded.factory(requireStub)
  check('bundle exports apply/inject', typeof module.apply === 'function' && Array.isArray(module.inject), module.inject?.join(','))

  // 2. apply() against a fake client context
  const registrations = []
  const disposers = []
  let servedNamespace
  const fakeCtx = {
    effect: (fn) => {
      const disposer = fn()
      if (typeof disposer === 'function') disposers.push(disposer)
    },
    locale: {
      register: () => () => {},
      bind: () => (key) => `t:${key}`,
    },
    configForms: {
      get: (namespace) => {
        check('card binds the audio-toolkit namespace', namespace === 'audio-toolkit', namespace)
        return { subscribe: () => () => {}, getSnapshot: () => ({}) }
      },
      whileServed: (namespaces, register) => {
        servedNamespace = namespaces[0]
        return register()
      },
    },
    slots: {
      inject: (slot, register) => register(),
      register: (definition, component) => {
        registrations.push({ definition, component })
        return () => {}
      },
    },
  }
  module.apply(fakeCtx)
  check('page waits for the served namespace', servedNamespace === 'audio-toolkit', servedNamespace)
  const bundleSection = registrations.find((entry) => entry.definition.name === 'plugins.bundle.config')
  const itemEntry = registrations.find((entry) => entry.definition.name === 'plugins.item')
  check('registers the bundle config section', bundleSection !== undefined, bundleSection?.definition.key)
  check('also registers a labelled plugin item', itemEntry !== undefined, itemEntry?.definition.id)
  const injected = typeof bundleSection?.definition?.inject === 'function' ? bundleSection.definition.inject() : {}
  const assetsHook = injected?.hooks?.audioToolkitAssets
  check(
    'asset hook is a store, not a hook function',
    typeof assetsHook?.subscribe === 'function' && typeof assetsHook?.getSnapshot === 'function',
    typeof assetsHook,
  )

  const { definition, component } = bundleSection ?? { definition: {}, component: () => null }
  check('config section is keyed by the bundle name', definition.key === 'dsh-audio-toolkit', definition.key)

  // 3. render through the component function
  const t = (key) => 't:' + key
  const summary = component({ view: 'summary', t })
  check('summary view returns text', typeof summary === 'string' && summary.length > 0, String(summary).slice(0, 40))

  const projection = {
    available: true,
    writable: true,
    dirty: false,
    invalid: false,
    saving: false,
    failed: false,
    engineEnabled: { text: 'true', overridden: false, invalid: false },
    enginePort: { text: '8788', overridden: false, invalid: false },
  }
  const inputs = []
  const switches = []
  const segments = []
  const tags = []
  // The dependency card reads its own store; feed it a ready snapshot so the
  // card renders without touching the network.
  const assetsView = {
    loading: false,
    error: '',
    status: { ready: true, missing: [], platform: 'win32', root: 'C:/assets', sizes: { release: 1, models: 2 }, install: { running: false } },
    options: { release: true, models: true },
    install: () => {},
    cancel: () => {},
    refresh: () => {},
    toggle: () => {},
    setPort: () => {},
  }
  const tree = component({
    view: 'page',
    t,
    useAudioToolkitCard: (selector) => selector(projection),
    // Mirror the host: useSelector(store, selector) requires a selector and
    // throws without one (this is what broke the live panel).
    useAudioToolkitAssets: (selector) => {
      if (typeof selector !== 'function') throw new TypeError('selector is not a function')
      return selector(assetsView)
    },
    save: () => {},
    discard: () => {},
    edit: () => {},
    resetField: () => {},
  })
  walkTree(tree, (node) => {
    if (node.type === 'Input') inputs.push(node)
    if (node.type === 'Switch') switches.push(node)
    if (node.type === 'SegmentedControl') segments.push(node)
    if (node.type === 'Tag') tags.push(node)
  })
  check('page view renders a form', tree?.type === 'SettingsForm')
  check('boolean fields use switches', switches.length === 4, `${switches.length} switches`)
  check('enum fields use segmented controls', segments.length === 3, `${segments.length} segmented controls`)
  check('text/number/list fields use inputs', inputs.length === 22, `${inputs.length} inputs`)
  check('no plain SettingsValueField rows remain', !countType(tree, 'SettingsValueField'))
  check('status strip tags render', tags.length >= 8, `${tags.length} tags`)
  check(
    'controls expose labels/ids',
    [...inputs, ...switches, ...segments].every((node) => node.props.label !== undefined || node.props.id !== undefined),
  )
  const buttonCount = countButtons(tree)
  check('engine start/stop and asset delete buttons render', buttonCount === 3, `${buttonCount} buttons`)

  // engine start/stop controls
  const labels = collectText(tree)
  check('engine controls are rendered', labels.includes('t:startEngine') && labels.includes('t:stopEngine'), labels.filter((l) => l.startsWith('t:')).slice(0, 4).join(', '))
  check(
    'ready assets row shows status and delete only',
    labels.some((label) => label.includes('t:assetsReady')) && labels.includes('t:assetsDelete') && !labels.includes('t:assetsInstallAll'),
    labels.filter((l) => l.startsWith('t:assets')).join(', '),
  )

  // First run: assets missing and no choice yet -> only the setup guide renders.
  const setupTree = component({
    view: 'page',
    t,
    useAudioToolkitCard: (selector) =>
      selector({ ...projection, setupChoice: { text: '', overridden: false, invalid: false } }),
    useAudioToolkitAssets: (selector) =>
      selector({
        ...assetsView,
        status: { ...assetsView.status, ready: false, missing: ['audio.cpp 运行时'], sizes: { release: 0, models: 0 } },
      }),
    save: () => {},
    discard: () => {},
    edit: () => {},
  })
  const setupLabels = collectText(setupTree)
  check(
    'first-run guide gates the form',
    setupLabels.some((label) => label.includes('t:setupAuto')) &&
      setupLabels.some((label) => label.includes('t:setupManual')),
    setupLabels.filter((label) => label.startsWith('t:setup')).join(', '),
  )
  check('no config rows before choosing', countType(setupTree, 'Input') === 0, `${countType(setupTree, 'Input')} inputs`)
  check('guide has no SettingsForm bar', countType(setupTree, 'SettingsForm') === 0, 'settings form absent')

  // Choosing "auto" starts the install but must NOT reveal the rest of the form.
  const autoTree = component({
    view: 'page',
    t,
    useAudioToolkitCard: (selector) =>
      selector({ ...projection, setupChoice: { text: 'auto', overridden: false, invalid: false } }),
    useAudioToolkitAssets: (selector) =>
      selector({
        ...assetsView,
        status: { ...assetsView.status, ready: false, missing: ['audio.cpp 运行时'], sizes: { release: 0, models: 0 } },
        install: () => {},
      }),
    save: () => {},
    discard: () => {},
    edit: () => {},
  })
  const autoLabels = collectText(autoTree)
  check(
    'auto mode still hides the form',
    countType(autoTree, 'Input') === 0 &&
      autoLabels.some((label) => label.includes('t:assetsInstallAll')) &&
      !autoLabels.some((label) => label.includes('t:setupAuto')) &&
      autoLabels.some((label) => label.includes('t:switchToManual')),
    `${countType(autoTree, 'Input')} inputs`,
  )

  // Manual mode: platform-specific instructions, no settings inputs.
  const manualTree = component({
    view: 'page',
    t,
    useAudioToolkitCard: (selector) =>
      selector({ ...projection, setupChoice: { text: 'manual', overridden: false, invalid: false } }),
    useAudioToolkitAssets: (selector) =>
      selector({
        ...assetsView,
        status: { ...assetsView.status, ready: false, platform: 'win32', arch: 'x64', missing: ['audio.cpp 运行时'] },
      }),
    save: () => {},
    discard: () => {},
    edit: () => {},
  })
  check(
    'manual mode shows platform steps and a way back',
    countType(manualTree, 'Input') === 0 && collectText(manualTree).some((label) => label.includes('t:switchToAuto')),
    `${countType(manualTree, 'Input')} inputs`,
  )

  // Once assets are ready the normal form returns.
  check('form returns after the assets are ready', countType(tree, 'Input') > 0, `${countType(tree, 'Input')} inputs`)

  // 4. staged values must match the host Config types (DSH writes them verbatim)
  const specOf = (field) => formSpecs.find((spec) => spec.field === field)
  check('one spec per editable Config field', formSpecs.length === 31, `${formSpecs.length} specs`)
  for (const field of ['extraArgs', 'ttsSessionOptions', 'asrSessionOptions']) {
    // The host declares these as `Schema.string()`; an array here would be
    // persisted and then fail schema validation on the next load.
    const parsed = specOf(field)?.parse('--foo   bar\tbaz')
    check(
      `${field} saves one space-separated string`,
      parsed?.kind === 'set' && parsed.value === '--foo bar baz',
      JSON.stringify(parsed),
    )
  }
  check('list fields still render legacy arrays', specOf('extraArgs')?.format(['a', 'b']) === 'a b', specOf('extraArgs')?.format(['a', 'b']))
  check('list fields clear on blank input', specOf('extraArgs')?.parse('   ')?.kind === 'clear')
  check(
    'number fields reject non-numbers',
    specOf('enginePort')?.parse('12abc') === undefined && specOf('enginePort')?.parse(' 8788 ')?.value === 8788,
  )
  check(
    'boolean fields only accept boolean words',
    specOf('engineEnabled')?.parse('yes')?.value === true && specOf('engineEnabled')?.parse('增') === undefined,
  )

  const failed = results.filter((result) => !result.ok)
  console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`)
  if (failed.length > 0) {
    console.log('failed:', failed.map((result) => result.name).join(', '))
    process.exitCode = 1
  }
}

/** Count every Button element in a stub tree, resolving component elements. */
function countButtons(node) {
  let count = 0
  walkTree(node, (element) => {
    if (element.type === 'Button') count += 1
  })
  return count
}

/** Count elements of one primitive type in a stub tree. */
function countType(node, type) {
  let count = 0
  walkTree(node, (element) => {
    if (element.type === type) count += 1
  })
  return count
}

/** Collect all text children from a stub tree. */
function collectText(node) {
  const out = []
  walkTree(node, (element) => {
    if (typeof element.type === 'string') {
      for (const child of flatten(element.props?.children)) if (typeof child === 'string') out.push(child)
    }
  })
  return out
}

function flatten(value, out = []) {
  if (Array.isArray(value)) {
    for (const item of value) flatten(item, out)
  } else if (value !== undefined && value !== null) {
    out.push(value)
  }
  return out
}

/** Shared traversal: primitives are leaves, custom components are invoked. */
function walkTree(node, visit) {
  const LEAF = new Set(['SettingsForm', 'SettingsValueField', 'Button', 'Input', 'Switch', 'SegmentedControl', 'Tag'])
  const recurse = (current) => {
    if (current === null || current === undefined) return
    if (Array.isArray(current)) {
      for (const child of current) recurse(child)
      return
    }
    if (typeof current !== 'object') return
    if (typeof current.type === 'string' && LEAF.has(current.type)) {
      visit(current)
      recurse(current.props?.children)
      return
    }
    if (typeof current.component === 'function') {
      recurse(current.component(current.props))
      return
    }
    recurse(current.props?.children)
  }
  recurse(node)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

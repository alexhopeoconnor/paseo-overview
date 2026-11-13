const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const vm = require('node:vm');
const { build } = require('/fork/node_modules/esbuild');
const React = require('/fork/node_modules/react');
const { create, act } = require('/fork/node_modules/react-test-renderer');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const output = process.env.OVERVIEW_ACCEPTANCE_OUTPUT || '/out';

(async () => {
  const uiStub = [
    'import React from "react";',
    'import { Pressable, Text, View } from "react-native";',
    'const h = React.createElement;',
    'export function SettingsSection({ title, trailing, testID, children }) { return h(View, { testID }, h(Text, null, title), trailing ? h(Text, null, trailing) : null, children); }',
    'export const SettingsGroup = SettingsSection;',
    'export function SettingsCard({ testID, children }) { return h(View, { testID }, children); }',
    'export function SettingsRow({ testID, label, hint, error, children }) { return h(View, { testID, accessibilityValue: hint ? { text: hint } : undefined }, h(Text, null, label), children, hint ? h(Text, null, hint) : null, error ? h(Text, null, error) : null); }',
    'export function SettingsSelect({ testID, label, value, options, onValueChange, disabled, hint, error }) { return h(View, { testID, accessibilityValue: { text: value } }, h(Text, null, label), ...options.map(option => h(Pressable, { key: option.value, testID: [testID, option.value].join(":"), accessibilityRole: "radio", accessibilityLabel: option.label, accessibilityState: { checked: value === option.value, disabled }, disabled, onPress: () => { if (!disabled) onValueChange(option.value); } }, h(Text, null, option.label))), hint ? h(Text, null, hint) : null, error ? h(Text, null, error) : null); }',
    'export function SettingsAction({ testID, label, actionLabel, onPress, disabled, hint, error }) { return h(View, { testID }, h(Text, null, label), h(Pressable, { testID: [testID, "action"].join(":"), accessibilityRole: "button", accessibilityLabel: actionLabel, disabled, onPress: () => { if (!disabled) onPress(); } }, h(Text, null, actionLabel)), hint ? h(Text, null, hint) : null, error ? h(Text, null, error) : null); }',
  ].join('\n');
  const stubPlugin = { name: 'overview-acceptance-stubs', setup(build) {
    build.onResolve({ filter: /^@getpaseo\/plugin\/client\/ui$/ }, () => ({ path: 'ui', namespace: 'stub' }));
    build.onResolve({ filter: /^@getpaseo\/plugin\/client$/ }, () => ({ path: 'client', namespace: 'stub' }));
    build.onResolve({ filter: /^@getpaseo\/plugin$/ }, () => ({ path: 'sdk', namespace: 'stub' }));
    build.onLoad({ filter: /^ui$/, namespace: 'stub' }, () => ({ contents: uiStub, loader: 'js' }));
    build.onLoad({ filter: /^client$/, namespace: 'stub' }, () => ({ contents: 'import { useSyncExternalStore } from "react";\nexport function useSettings() { const state = useSyncExternalStore(globalThis.__overviewSettingsSubscribe, globalThis.__overviewSettingsSnapshot); return { ...state, save: globalThis.__overviewSettingsSave, reset: globalThis.__overviewSettingsReset, reload: globalThis.__overviewSettingsReload }; }', loader: 'js' }));
    build.onLoad({ filter: /^sdk$/, namespace: 'stub' }, () => ({ contents: 'export function defineSettings(definition) { return definition; }', loader: 'js' }));
  } };
  const built = await build({ stdin: { contents: 'export { NativeHarness } from "/plugin/acceptance/native-harness"; export { AppearanceSettings } from "/plugin/client/settings"; export { appearancePalettes } from "/plugin/client/appearance-policy"; export { DEFAULT_APPEARANCE } from "/plugin/shared/settings"; export { nativeFixture } from "/plugin/acceptance/native-fixture"; export { lightTheme } from "/plugin/acceptance/fixture"; export { mountGraphFullscreen, mountOverview, mountFloatingCard } from "/plugin/client/web";', resolveDir: '/plugin' }, plugins: [stubPlugin], bundle: true, format: 'cjs', platform: 'node', target: 'node22', jsx: 'automatic', external: ['react', 'react-native'], write: false });
  const listeners = { app: new Set(), motion: new Set() };
  const active = new Map(), animationCalls = [];
  let animationId = 0;
  class Value {
    constructor(value) { this.value = value; }
    interpolate(options) { return { value: this, options }; }
    setValue(value) { this.value = value; }
    stopAnimation(callback) { callback?.(this.value); }
  }
  const host = type => props => React.createElement(type, props, props.children);
  const native = {
    Platform: { OS: 'android' }, View: host('View'), ScrollView: host('ScrollView'), Text: host('Text'),
    Pressable: host('Pressable'), Image: host('Image'), StyleSheet: { create: value => value },
    Animated: {
      Value, View: host('AnimatedView'),
      timing(value, options) {
        const id = ++animationId;
        const record = { id, value, options, callback: null, initial: value.value };
        return {
          start(callback) { record.callback = callback; active.set(id, record); animationCalls.push(record); },
          stop() { active.delete(id); },
        };
      },
    },
    Easing: { linear: value => value },
    AccessibilityInfo: {
      isReduceMotionEnabled: async () => false,
      addEventListener(_event, callback) { listeners.motion.add(callback); return { remove() { listeners.motion.delete(callback); } }; },
    },
    AppState: {
      currentState: 'active',
      addEventListener(_event, callback) { listeners.app.add(callback); return { remove() { listeners.app.delete(callback); } }; },
    },
  };
  const module = { exports: {} };
  let settingsSnapshot = null;
  const settingsListeners = new Set();
  const settingsSaveCalls = [];
  let settingsResetCalls = 0, settingsReloadCalls = 0, settingsSaveResult = true, settingsSavedRevision = 'rev-2';
  const setSettings = next => { settingsSnapshot = next; for (const listener of settingsListeners) listener(); };
  const context = vm.createContext({ module, exports: module.exports, console, setTimeout, clearTimeout,
    require(name) {
      if (name === 'react') return React;
      if (name === 'react/jsx-runtime') return require('/fork/node_modules/react/jsx-runtime');
      if (name === 'react-native') return native;
      throw new Error(`Unexpected native-only import: ${name}`);
    },
  });
  context.__overviewSettingsSubscribe = listener => { settingsListeners.add(listener); return () => settingsListeners.delete(listener); };
  context.__overviewSettingsSnapshot = () => settingsSnapshot;
  context.__overviewSettingsSave = async (values, revision) => {
    settingsSaveCalls.push({ values, revision });
    const current = settingsSnapshot;
    if (!settingsSaveResult) {
      setSettings({ ...current, saving: false, saveError: 'Another client changed appearance settings.' });
      return false;
    }
    setSettings({ ...current, status: 'ready', values, revision: settingsSavedRevision, saving: false, saveError: null });
    return true;
  };
  context.__overviewSettingsReset = async () => {
    settingsResetCalls += 1;
    setSettings({ status: 'ready', values: { ...module.exports.DEFAULT_APPEARANCE }, revision: 'rev-reset', saving: false, saveError: null });
    return true;
  };
  context.__overviewSettingsReload = async () => {
    settingsReloadCalls += 1;
    const current = settingsSnapshot;
    const values = current.status === 'ready' ? current.values : { ...module.exports.DEFAULT_APPEARANCE };
    setSettings({ status: 'ready', values, revision: current.revision ? `${current.revision}-reloaded` : 'rev-reloaded', saving: false, saveError: null });
  };
  for (const name of ['document', 'window']) Object.defineProperty(context, name, {
    get() { throw new Error(`Native graph accessed browser global ${name}`); },
  });
  vm.runInContext(built.outputFiles[0].text, context);
  const nativeRoot = new Proxy({}, { get(_target, property) { throw new Error(`Browser initialization accessed native root ${String(property)}`); } });
  const unexpectedCallback = () => { throw new Error('Browser callback ran on native'); };
  for (const platform of ['android', 'ios']) {
    native.Platform.OS = platform;
    assert.equal(module.exports.mountGraphFullscreen(nativeRoot, unexpectedCallback), null);
    assert.equal(module.exports.mountOverview(nativeRoot, {}), null);
    assert.equal(module.exports.mountFloatingCard(nativeRoot, nativeRoot, unexpectedCallback), null);
  }
  native.Platform.OS = 'android';
  let model = { ...module.exports.nativeFixture, nodes: module.exports.nativeFixture.nodes.map(node => node.id === "a9-0" ? { ...node, state: "working" } : node) };
  let visible = true, state, tree, settingsTree, appearanceState, appearancePolicy;
  const onState = next => { state = next; };
  const onAppearance = (value, policy) => { appearanceState = value; appearancePolicy = policy; };
  const element = () => React.createElement(module.exports.NativeHarness, { model, theme: module.exports.lightTheme, visible, onState, onAppearance });
  const hostsIn = root => root.root.findAll(node => typeof node.type === 'string');
  const hosts = () => hostsIn(tree);
  const byIdIn = (root, id) => hostsIn(root).find(node => node.props.testID === id);
  const byId = id => byIdIn(tree, id);
  const settingsById = id => byIdIn(settingsTree, id);
  const prefixed = prefix => hosts().filter(node => String(node.props.testID || '').startsWith(prefix));
  const text = node => node.children.map(child => typeof child === 'string' ? child : text(child)).join('');
  const update = async () => { await act(async () => tree.update(element())); };
  const pressIn = async (root, id) => {
    const control = byIdIn(root, id);
    assert.ok(control && typeof control.props.onPress === 'function', `Missing control ${id}`);
    await act(async () => control.props.onPress());
  };
  const press = id => pressIn(tree, id);
  const pressSettings = id => pressIn(settingsTree, id);
  const styleValues = node => (Array.isArray(node.props.style) ? node.props.style.flat(Infinity) : [node.props.style]).filter(Boolean);
  const styleValue = (node, key) => styleValues(node).map(style => style[key]).find(value => value !== undefined);
  const mount = async () => {
    await act(async () => { tree = create(element(), { createNodeMock: element => element.type === 'ScrollView' ? { scrollTo() {} } : null }); });
  };
  await mount();
  await act(async () => byId('overview-native-graph').props.onLayout({ nativeEvent: { layout: { width: 390, height: 800 } } }));
  assert.equal(prefixed('overview-native-project:').length, 7);
  assert.equal(prefixed('overview-native-workspace:').length, 0);
  assert.equal(text(byId('overview-scope-title')), 'All projects');
  assert.ok(active.size > 0, 'Working roots animate');
  assert.ok(animationCalls.every(call => call.options.useNativeDriver === true));
  assert.ok(new Set(animationCalls.map(call => call.initial)).size > 1, 'Stable identities seed different phases');

  // A rate change continues from the existing phase, and late callbacks from a
  // stopped animation must not resurrect its old loop.
  const old = [...active.values()];
  for (const call of old) call.value.setValue(0.42);
  const beforeRateChange = animationCalls.length;
  model = { ...model, nodes: model.nodes.map(node => node.id === 'a0-1' ? { ...node, state: 'idle' } : node) };
  await update();
  const restarted = animationCalls.slice(beforeRateChange);
  assert.ok(restarted.length > 0);
  assert.ok(restarted.every(call => call.initial === 0.42), 'Rate change preserves the existing phase');
  const beforeLateCallback = active.size;
  await act(async () => { for (const call of old) if (!active.has(call.id)) call.callback({ finished: true }); });
  assert.equal(active.size, beforeLateCallback);

  // The shared header quick appearance uses the real controlled appearance
  // state and policy without disturbing scope or counts.
  assert.ok(appearanceState && appearancePolicy, 'Native harness reports appearance and policy');
  assert.equal(appearanceState.theme, 'paseo');
  assert.equal(appearancePolicy.depthStrength, 0.7);
  const appearanceTitle = text(byId('overview-scope-title'));
  const appearanceCounts = text(byId('overview-scope-counts'));
  const appearanceScope = state.scope;
  await press('overview-appearance');
  assert.ok(byId('overview-appearance-panel'));
  for (const id of ['overview-appearance', 'overview-theme-paseo', 'overview-theme-light', 'overview-theme-dark',
    'overview-background-animated', 'overview-background-static', 'overview-background-off']) {
    const control = byId(id);
    assert.equal(styleValue(control, 'minWidth'), 44, `${id} keeps a 44px width`);
    assert.equal(styleValue(control, 'minHeight'), 44, `${id} keeps a 44px height`);
  }
  await press('overview-theme-dark');
  assert.equal(appearanceState.theme, 'dark');
  assert.equal(byId('overview-native-screen').props.style.backgroundColor, module.exports.appearancePalettes.dark.background);
  assert.equal(byId('overview-theme-dark').props.accessibilityState.checked, true);
  assert.deepEqual(state.scope, appearanceScope);
  assert.equal(text(byId('overview-scope-title')), appearanceTitle);
  assert.equal(text(byId('overview-scope-counts')), appearanceCounts);
  await press('overview-background-off');
  assert.equal(appearanceState.background, 'off');
  assert.equal(byId('overview-background-off').props.accessibilityState.checked, true);
  assert.equal(appearancePolicy.backgroundRate, 1);
  await press('overview-theme-paseo');
  await press('overview-background-animated');
  assert.equal(byId('overview-native-screen').props.style.backgroundColor, module.exports.lightTheme.background);
  assert.deepEqual(state.scope, appearanceScope);
  await press('overview-appearance');
  assert.equal(byId('overview-appearance-panel'), undefined);

  await press('overview-native-project:p0');
  assert.equal(text(byId('overview-scope-title')), 'Application');
  assert.match(text(byId('overview-scope-counts')), /4 workspaces/);
  await press('overview-native-workspace:w0');
  assert.equal(text(byId('overview-scope-title')), 'Deployment and release review');
  assert.match(byId('overview-native-agent:a0-0').props.accessibilityLabel, /Agent\./);
  assert.match(byId('overview-native-agent:a0-3').props.accessibilityLabel, /Subagent\./);
  for (const id of ['n0', 'n1', 'n2', 'n6']) assert.ok(byId(`overview-native-agent:${id}`));
  const group = prefixed('overview-native-completed:')[0];
  assert.ok(group);
  for (const outcome of ['finished', '1 idle', '1 closed', '1 canceled']) assert.ok(group.props.accessibilityLabel.includes(outcome), `Mixed group describes ${outcome}`);
  const groupId = group.props.testID.slice('overview-native-completed:'.length);
  await press(group.props.testID);
  assert.equal(state.groups.get(groupId), 'expanded');
  assert.ok(byId('overview-native-agent:n10'));
  assert.match(text(byId('overview-native-agent:closed-child')), /Closed/);
  assert.match(byId('overview-native-agent:closed-child').props.accessibilityLabel, /Closed/);
  assert.match(text(byId('overview-native-agent:n10')), /Canceled/);
  assert.match(byId('overview-native-agent:n10').props.accessibilityLabel, /Canceled/);
  await press('overview-native-agent:closed-child');
  assert.equal(state.selectedId, 'closed-child');
  await press('overview-native-agent:n10');
  assert.equal(state.selectedId, 'n10');
  const collapse = byId(`overview-native-collapse:${groupId}`);
  assert.equal(collapse.props.style.minWidth, 44);
  assert.equal(collapse.props.style.minHeight, 44);
  assert.match(text(collapse), /^Collapse \d+$/);
  await press('overview-back');
  await press('overview-native-workspace:w0');
  assert.ok(byId('overview-native-agent:n10'), 'Explicit expansion survives focus changes');
  await press(`overview-native-collapse:${groupId}`);
  assert.equal(state.groups.get(groupId), 'collapsed');
  await press('overview-native-agent:n0');
  assert.equal(state.selectedId, 'n0');
  assert.ok(!JSON.stringify(tree.toJSON()).includes('Command finished'), 'Phone remains free of speech bubbles');
  await press('overview-all-projects');

  visible = false; await update(); assert.equal(active.size, 0);
  visible = true; await update(); assert.ok(active.size > 0);
  await press('overview-motion'); assert.equal(active.size, 0);
  await press('overview-motion'); assert.ok(active.size > 0);
  await act(async () => { for (const callback of listeners.app) callback('background'); }); assert.equal(active.size, 0);
  await act(async () => { for (const callback of listeners.app) callback('active'); }); assert.ok(active.size > 0);
  await act(async () => { for (const callback of listeners.motion) callback(true); }); assert.equal(active.size, 0);
  await act(async () => { for (const callback of listeners.motion) callback(false); }); assert.ok(active.size > 0);
  const rendered = tree.toJSON();
  await act(async () => tree.unmount());
  assert.equal(active.size, 0); assert.equal(listeners.app.size, 0); assert.equal(listeners.motion.size, 0);

  let resolveMotion;
  native.AccessibilityInfo.isReduceMotionEnabled = () => new Promise(resolve => { resolveMotion = resolve; });
  await mount();
  await act(async () => { for (const callback of listeners.motion) callback(true); resolveMotion(false); });
  assert.equal(active.size, 0, 'A stale initial motion read cannot override a later event');
  await act(async () => { for (const callback of listeners.motion) callback(false); });
  assert.ok(active.size > 0);
  await act(async () => tree.unmount());
  assert.equal(active.size, 0); assert.equal(listeners.app.size, 0); assert.equal(listeners.motion.size, 0);
  // Host settings screen states. The stub mirrors useSettings' discriminated
  // state, full-document save and revision contract without Paseo internals.
  const settingsElement = () => React.createElement(module.exports.AppearanceSettings);
  const updateSettings = async () => { await act(async () => settingsTree.update(settingsElement())); };
  const applySettings = async next => { await act(async () => { setSettings(next); settingsTree.update(settingsElement()); }); };
  const normalize = value => JSON.parse(JSON.stringify(value));
  await act(async () => {
    setSettings({ status: 'loading', saving: false, saveError: null });
    settingsTree = create(settingsElement(), { createNodeMock: () => null });
  });
  assert.ok(settingsById('overview-appearance-loading'));
  assert.equal(settingsById('overview-appearance-theme'), undefined);
  assert.equal(settingsSaveCalls.length, 0);

  await applySettings({ status: 'error', error: 'Host unavailable', saving: false, saveError: null });
  assert.match(text(settingsById('overview-appearance-error')), /could not be loaded/);
  assert.equal(settingsSaveCalls.length, 0);
  await pressSettings('overview-appearance-retry:action');
  await updateSettings();
  assert.equal(settingsReloadCalls, 1);
  assert.equal(settingsSaveCalls.length, 0);

  await applySettings({ status: 'invalid', error: 'Stored values do not match the schema', revision: 'rev-bad', saving: false, saveError: null });
  assert.match(text(settingsById('overview-appearance-invalid')), /invalid/);
  assert.equal(settingsById('overview-appearance-theme'), undefined);
  assert.equal(settingsSaveCalls.length, 0);
  await pressSettings('overview-appearance-invalid-reset:action');
  await updateSettings();
  assert.equal(settingsResetCalls, 1);
  assert.equal(settingsSaveCalls.length, 0);

  await applySettings({ status: 'ready', values: { ...module.exports.DEFAULT_APPEARANCE }, revision: 'rev-1', saving: false, saveError: null });
  assert.equal(settingsById('overview-appearance-theme').props.accessibilityValue.text, 'paseo');
  assert.equal(settingsById('overview-appearance-background').props.accessibilityValue.text, 'animated');
  settingsSaveResult = true;
  settingsSavedRevision = 'rev-2';
  await pressSettings('overview-appearance-theme:dark');
  await updateSettings();
  assert.equal(settingsSaveCalls.length, 1);
  assert.deepEqual(normalize(settingsSaveCalls[0]), normalize({ values: { ...module.exports.DEFAULT_APPEARANCE, theme: 'dark' }, revision: 'rev-1' }));
  assert.equal(settingsSnapshot.revision, 'rev-2');
  assert.equal(settingsById('overview-appearance-theme').props.accessibilityValue.text, 'dark');

  // A rejected save preserves the last good values and exposes Reload; a
  // successful reload clears the conflict without retaining the draft.
  settingsSaveResult = false;
  await pressSettings('overview-appearance-background:off');
  await updateSettings();
  assert.equal(settingsSaveCalls.length, 2);
  assert.deepEqual(normalize(settingsSaveCalls[1]), normalize({
    values: { ...module.exports.DEFAULT_APPEARANCE, theme: 'dark', background: 'off' }, revision: 'rev-2',
  }));
  assert.equal(settingsById('overview-appearance-background').props.accessibilityValue.text, 'animated');
  assert.match(text(settingsById('overview-appearance-save-error')), /Changes were not saved/);
  assert.match(text(settingsById('overview-appearance-save-error')), /Another client changed appearance settings/);
  const savesBeforeReload = settingsSaveCalls.length;
  await pressSettings('overview-appearance-save-error:action');
  await updateSettings();
  assert.equal(settingsReloadCalls, 2);
  assert.equal(settingsSaveCalls.length, savesBeforeReload);
  assert.equal(settingsById('overview-appearance-save-error'), undefined);
  assert.equal(settingsById('overview-appearance-theme').props.accessibilityValue.text, 'dark');
  assert.equal(settingsById('overview-appearance-background').props.accessibilityValue.text, 'animated');
  await act(async () => settingsTree.unmount());

  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(`${output}/native-interaction-results.json`, JSON.stringify({ ok: true, actualComponents: true, nativePrimitivesAndAnimationMocked: true, settingsHostBoundaryMocked: true, withoutDOM: true, withoutThree: true,
    checks: ['android/iOS browser fullscreen/renderer/positioner guards', 'controlled header scope', 'quick appearance theme/background with stable scope', '44px appearance targets', 'settings loading/error/invalid never save', 'ready full-document revision save', 'conflict preserves last good values and reload recovers', 'stable role-aware emoji nodes', 'mixed inactive group outcomes', 'visible closed/canceled statuses and selection', 'group focus persistence and collapse', '44px collapse target', 'phase continuity', 'late animation callbacks', 'visibility/pause/AppState/reduced motion', 'listener cleanup'], rendered }, null, 2));
  console.log(JSON.stringify({ ok: true, output, animationsObserved: animationCalls.length }));
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });

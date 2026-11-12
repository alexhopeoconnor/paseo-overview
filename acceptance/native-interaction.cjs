const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const vm = require('node:vm');
const { build } = require('/fork/node_modules/esbuild');
const React = require('/fork/node_modules/react');
const { create, act } = require('/fork/node_modules/react-test-renderer');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const output = process.env.OVERVIEW_ACCEPTANCE_OUTPUT || '/out';

(async () => {
  const built = await build({ stdin: { contents: 'export { NativeHarness } from "/plugin/acceptance/native-harness"; export { nativeFixture } from "/plugin/acceptance/native-fixture"; export { lightTheme } from "/plugin/acceptance/fixture"; export { mountGraphFullscreen, mountOverview, mountFloatingCard } from "/plugin/client/web";', resolveDir: '/plugin' }, bundle: true, format: 'cjs', platform: 'node', target: 'node22', jsx: 'automatic', external: ['react', 'react-native'], write: false });
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
  const context = vm.createContext({ module, exports: module.exports, console, setTimeout, clearTimeout,
    require(name) {
      if (name === 'react') return React;
      if (name === 'react/jsx-runtime') return require('/fork/node_modules/react/jsx-runtime');
      if (name === 'react-native') return native;
      throw new Error(`Unexpected native-only import: ${name}`);
    },
  });
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
  let visible = true, state, tree;
  const onState = next => { state = next; };
  const element = () => React.createElement(module.exports.NativeHarness, { model, theme: module.exports.lightTheme, visible, onState });
  const hosts = () => tree.root.findAll(node => typeof node.type === 'string');
  const byId = id => hosts().find(node => node.props.testID === id);
  const prefixed = prefix => hosts().filter(node => String(node.props.testID || '').startsWith(prefix));
  const text = node => node.children.map(child => typeof child === 'string' ? child : text(child)).join('');
  const update = async () => { await act(async () => tree.update(element())); };
  const press = async id => {
    const control = byId(id);
    assert.ok(control && typeof control.props.onPress === 'function', `Missing control ${id}`);
    await act(async () => control.props.onPress());
  };
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
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(`${output}/native-interaction-results.json`, JSON.stringify({ ok: true, actualComponents: true, nativePrimitivesAndAnimationMocked: true, withoutDOM: true, withoutThree: true,
    checks: ['android/iOS browser fullscreen/renderer/positioner guards', 'controlled header scope', 'stable role-aware emoji nodes', 'mixed inactive group outcomes', 'visible closed/canceled statuses and selection', 'group focus persistence and collapse', '44px collapse target', 'phase continuity', 'late animation callbacks', 'visibility/pause/AppState/reduced motion', 'listener cleanup'], rendered }, null, 2));
  console.log(JSON.stringify({ ok: true, output, animationsObserved: animationCalls.length }));
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });

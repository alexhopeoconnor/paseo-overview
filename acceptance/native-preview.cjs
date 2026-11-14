const { build } = require('/fork/node_modules/esbuild');
const { chromium } = require('/fork/node_modules/playwright');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');
const output = process.env.OVERVIEW_ACCEPTANCE_OUTPUT || '/out';

const waitChecked = (page, testID) => page.waitForFunction(id => document.querySelector(`[data-testid="${id}"]`)?.getAttribute('aria-checked') === 'true', testID);

const inspect = page => page.evaluate(() => {
  const bounds = element => {
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  };
  return {
    title: document.querySelector('[data-testid="overview-scope-title"]')?.textContent,
    breadcrumb: document.querySelector('[data-testid="overview-scope-breadcrumb"]') ? 'present' : undefined,
    filterTitle: document.querySelector('[data-testid="overview-project-filter-title"]')?.textContent,
    counts: document.querySelector('[data-testid="overview-scope-counts"]')?.textContent,
    header: bounds(document.querySelector('[data-testid="overview-header"]')),
    screenBackground: getComputedStyle(document.querySelector('[data-testid="overview-native-screen"]')).backgroundColor,
    active: document.activeElement?.getAttribute('data-testid'),
    nodes: [...document.querySelectorAll('[data-testid^="overview-native-project:"],[data-testid^="overview-native-workspace:"],[data-testid^="overview-native-agent:"],[data-testid^="overview-native-completed:"]')].map(node => ({ id: node.dataset.testid, label: node.getAttribute('aria-label'), box: bounds(node) })),
  };
});
(async () => {
  await fs.mkdir(output, { recursive: true });
  const uiStub = [
    'import React from "react";',
    'import { createPortal } from "react-dom";',
    'import { Pressable, ScrollView as NativeScrollView, Text, View } from "react-native";',
    'const h = React.createElement;',
    'export function Icon({ name }) { return h(View, { accessibilityLabel: `Icon ${name}` }); }',
    'export function ScrollView(props) { return h(NativeScrollView, props); }',
    'export function Modal({ title, open, onOpenChange, children }) {',
    '  if (!open) return null;',
    '  const surface = h(View, { testID: `overview-modal:${title}`, style: { position: "fixed", top: 0, right: 0, bottom: 0, left: 0, zIndex: 10000, backgroundColor: "#00000055", alignItems: "center", justifyContent: "center", padding: 16 } },',
    '    h(View, { style: { backgroundColor: "#ffffff", borderRadius: 16, padding: 12, width: "100%", maxWidth: 420, maxHeight: "82%", overflow: "hidden", gap: 8 } },',
    '      h(View, { style: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 } },',
    '        h(Text, { style: { fontWeight: "600", fontSize: 16 } }, title),',
    '        h(Pressable, { testID: "overview-modal-close", accessibilityRole: "button", onPress: () => onOpenChange(false), style: { minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center" } }, h(Text, null, "Close"))),',
    '      children));',
    '  return createPortal(surface, document.body);',
    '}',
    'Modal.Content = function Content({ children }) { return h(NativeScrollView, { style: { maxHeight: "58vh" } }, children); };',
  ].join('\n');
  const stubPlugin = { name: 'overview-preview-ui-stub', setup(build) {
    build.onResolve({ filter: /^@getpaseo\/plugin\/client\/ui$/ }, () => ({ path: 'ui', namespace: 'stub' }));
    build.onLoad({ filter: /^ui$/, namespace: 'stub' }, () => ({ contents: uiStub, loader: 'js' }));
  } };
  const sharedBuild = { bundle: true, format: 'iife', platform: 'browser', target: 'es2020', jsx: 'automatic', define: { global: 'globalThis' }, alias: {
    'react-native': '/fork/node_modules/react-native-web', react: '/fork/node_modules/react', 'react-dom': '/fork/node_modules/react-dom',
  }, plugins: [stubPlugin] };
  await build({ ...sharedBuild, entryPoints: ['/plugin/acceptance/native-entry.tsx'], outfile: `${output}/native-preview.js` });
  const multiSource = `
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { NativeHarness } from "/plugin/acceptance/native-harness";
import { lightTheme, multiHostFixture } from "/plugin/acceptance/fixture";
function App() {
  const [state, setState] = useState(null);
  (window as any).multiPreview = { state };
  return <NativeHarness model={multiHostFixture()} theme={lightTheme} compact={false}
    hostChoices={[{ id: "first", label: "first host", status: "online" }, { id: "second", label: "second host", status: "online" }, { id: "offline", label: "Offline host", status: "offline" }]}
    onState={value => { (window as any).multiPreview.state = value; setState(value); }} />;
}
createRoot(document.getElementById("app")!).render(<App />);`;
  await build({ ...sharedBuild, stdin: { contents: multiSource, resolveDir: '/plugin', loader: 'tsx' }, outfile: `${output}/native-multi.js` });
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const errors = [];
  let page;
  try {
    page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent('<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;width:100%;height:100%;font-family:Arial,sans-serif;background:#f7f8fb}#app{height:100%;display:flex;flex-direction:column}</style><div id="app"></div></html>');
    await page.addScriptTag({ path: `${output}/native-preview.js` });
    await page.getByTestId('overview-native-project:p0').waitFor({ state: 'visible' });
    const initial = await inspect(page);
    assert.equal(initial.nodes.length, 7);
    assert.equal(initial.title, undefined);
    assert.equal(initial.breadcrumb, undefined);
    assert.equal(initial.filterTitle, 'All');
    assert.match(initial.counts, /^7 projects/);
    assert.equal(await page.getByTestId('overview-host-filter').innerText(), 'All hosts');
    assert.ok(initial.header.height < 120);
    assert.ok(!/Tap a project to explore/i.test(await page.locator('body').innerText()));
    await page.screenshot({ path: `${output}/phone-roots.png` });

    // Quick appearance stays in the shared header: readable targets, live theme
    // and background updates, and the same scope/counts throughout.
    await page.getByTestId('overview-appearance').tap();
    await page.getByTestId('overview-appearance-panel').waitFor({ state: 'visible' });
    for (const id of ['overview-appearance', 'overview-theme-paseo', 'overview-theme-light', 'overview-theme-dark',
      'overview-background-animated', 'overview-background-static', 'overview-background-off',
      'overview-host-filter', 'overview-project-filter', 'overview-motion']) {
      const box = await page.getByTestId(id).boundingBox();
      assert.ok(box && box.width >= 44 && box.height >= 44, `${id} keeps a 44px touch target`);
    }
    await page.getByTestId('overview-theme-dark').tap();
    await waitChecked(page, 'overview-theme-dark');
    assert.equal(await page.getByTestId('overview-theme-dark').getAttribute('aria-checked'), 'true');
    await page.waitForTimeout(50);
    const darkHeader = await inspect(page);
    assert.equal(darkHeader.filterTitle, initial.filterTitle);
    assert.equal(darkHeader.counts, initial.counts);
    assert.equal(darkHeader.screenBackground, 'rgb(11, 17, 24)');
    await page.getByTestId('overview-background-off').tap();
    await waitChecked(page, 'overview-background-off');
    assert.equal(await page.getByTestId('overview-background-off').getAttribute('aria-checked'), 'true');
    await page.getByTestId('overview-theme-paseo').tap();
    await page.getByTestId('overview-background-animated').tap();
    await waitChecked(page, 'overview-theme-paseo');
    await waitChecked(page, 'overview-background-animated');
    await page.waitForTimeout(50);
    const restored = await inspect(page);
    assert.equal(restored.filterTitle, initial.filterTitle);
    assert.equal(restored.counts, initial.counts);
    assert.equal(restored.screenBackground, 'rgb(247, 248, 251)');
    await page.getByTestId('overview-modal-close').tap();
    await page.getByTestId('overview-appearance-panel').waitFor({ state: 'hidden' });

    await page.getByTestId('overview-native-project:p0').tap();
    await page.getByTestId('overview-native-workspace:w0').waitFor({ state: 'visible' });
    const project = await inspect(page);
    assert.equal(project.title, 'Application');
    assert.match(project.counts, /4 workspaces/);
    await page.screenshot({ path: `${output}/phone-project.png` });
    await page.getByTestId('overview-native-workspace:w0').tap();
    await page.getByTestId('overview-native-agent:a0-0').waitFor({ state: 'visible' });
    await page.waitForTimeout(150);
    const workspace = await inspect(page);
    assert.equal(workspace.title, 'Application › Deployment and release review');
    assert.match(workspace.counts, /5 agents/);
    assert.match(workspace.nodes.find(node => node.id === 'overview-native-agent:a0-3').label, /Subagent\./);
    const primary = workspace.nodes.find(node => node.id === 'overview-native-agent:a0-0');
    const primaryCentre = primary.box.x + primary.box.width / 2;
    assert.ok(primaryCentre >= 16 && primaryCentre <= 374, 'Initial viewport shows the primary agent body fully');
    await page.screenshot({ path: `${output}/phone-workspace.png` });
    const count = page.locator('[data-testid^="overview-native-completed:"]').first();
    await count.scrollIntoViewIfNeeded();
    const groupId = (await count.getAttribute('data-testid')).slice('overview-native-completed:'.length);
    const inactiveLabel = await count.getAttribute('aria-label');
    for (const outcome of ['finished', '1 idle', '1 closed', '1 canceled']) assert.ok(inactiveLabel.includes(outcome), `Mixed group describes ${outcome}`);
    await count.tap();
    await page.waitForTimeout(100);
    const closed = page.getByTestId('overview-native-agent:closed-child');
    const canceled = page.getByTestId('overview-native-agent:n10');
    assert.match(await closed.innerText(), /Closed/);
    assert.match(await closed.getAttribute('aria-label'), /Closed/);
    assert.match(await canceled.innerText(), /Canceled/);
    assert.match(await canceled.getAttribute('aria-label'), /Canceled/);
    await closed.scrollIntoViewIfNeeded();
    await closed.tap();
    assert.equal(await page.evaluate(() => window.nativePreview.state.selected), 'closed-child');
    await canceled.scrollIntoViewIfNeeded();
    await canceled.tap();
    assert.equal(await page.evaluate(() => window.nativePreview.state.selected), 'n10');
    const collapse = page.getByTestId(`overview-native-collapse:${groupId}`);
    await collapse.scrollIntoViewIfNeeded();
    const collapseBox = await collapse.boundingBox();
    assert.ok(collapseBox.width >= 44 && collapseBox.height >= 44);
    assert.match(await collapse.innerText(), /^Collapse \d+$/);
    await page.screenshot({ path: `${output}/phone-expanded.png` });
    await collapse.tap();
    await page.getByTestId('overview-native-agent:n0').scrollIntoViewIfNeeded();
    await page.getByTestId('overview-native-agent:n0').tap();
    assert.equal(await page.evaluate(() => window.nativePreview.state.selected), 'n0');
    await page.screenshot({ path: `${output}/phone-selected.png` });
    await page.getByTestId('overview-back').tap();
    await page.getByTestId('overview-back').tap();
    await page.waitForTimeout(100);
    const reset = await inspect(page);
    assert.equal(reset.title, undefined);
    assert.equal(reset.breadcrumb, undefined);
    assert.equal(reset.filterTitle, 'All');
    assert.equal(reset.nodes.length, 7);
    assert.ok(reset.nodes.every(node => node.box.x >= -1 && node.box.x + node.box.width <= 391));

    // One Projects filter: draft checkboxes never move the graph until Apply,
    // Cancel/Show all are distinct, explicit all stays an explicit list, empty
    // selection has a native recovery, and focus/back/expansion retain it.
    const filterMenu = page.getByTestId('overview-project-filter-menu');
    await page.getByTestId('overview-project-filter').tap();
    await filterMenu.waitFor({ state: 'visible' });
    await page.screenshot({ path: `${output}/phone-filter-open.png` });
    assert.equal(await page.getByTestId('overview-project-filter-draft-count').innerText(), 'All 7 selected');
    assert.equal(await page.getByTestId('overview-project-filter-option-p0').getAttribute('aria-checked'), 'true');
    for (const id of ['overview-project-filter-option-p0', 'overview-project-filter-option-p6',
      'overview-project-filter-search', 'overview-project-filter-show-all', 'overview-project-filter-cancel', 'overview-project-filter-apply']) {
      const box = await page.getByTestId(id).boundingBox();
      assert.ok(box && box.width >= 44 && box.height >= 44, `${id} keeps a 44px touch target`);
    }
    await page.getByTestId('overview-project-filter-option-p0').tap();
    assert.equal(await page.getByTestId('overview-project-filter-option-p0').getAttribute('aria-checked'), 'false');
    assert.equal(await page.getByTestId('overview-project-filter-draft-count').innerText(), '6 selected');
    assert.equal((await inspect(page)).nodes.length, 7, 'Draft edits never change the graph');
    assert.equal((await inspect(page)).filterTitle, 'All');
    await page.getByTestId('overview-project-filter-cancel').tap();
    await filterMenu.waitFor({ state: 'hidden' });
    assert.equal((await inspect(page)).filterTitle, 'All');
    await page.getByTestId('overview-project-filter').tap();
    assert.equal(await page.getByTestId('overview-project-filter-option-p0').getAttribute('aria-checked'), 'true');
    for (const id of ['p2', 'p3', 'p4', 'p5', 'p6']) await page.getByTestId(`overview-project-filter-option-${id}`).tap();
    await page.getByTestId('overview-project-filter-apply').tap();
    await filterMenu.waitFor({ state: 'hidden' });
    let filtered = await inspect(page);
    assert.equal(filtered.filterTitle, '2/7');
    assert.match(filtered.counts, /2 of 7 projects/);
    assert.deepEqual(filtered.nodes.map(node => node.id).sort(), ['overview-native-project:p0', 'overview-native-project:p1']);
    await page.getByTestId('overview-project-filter').tap();
    await page.getByTestId('overview-project-filter-option-p1').tap();
    await page.getByTestId('overview-project-filter-apply').tap();
    filtered = await inspect(page);
    assert.equal(filtered.filterTitle, '1/7');
    assert.deepEqual(filtered.nodes.map(node => node.id), ['overview-native-project:p0']);
    await page.getByTestId('overview-project-filter').tap();
    await page.getByTestId('overview-project-filter-option-p2').tap();
    assert.equal((await inspect(page)).nodes.length, 1);
    await page.getByTestId('overview-project-filter-show-all').tap();
    await filterMenu.waitFor({ state: 'hidden' });
    assert.equal((await inspect(page)).filterTitle, 'All');
    assert.equal((await inspect(page)).nodes.length, 7);
    await page.getByTestId('overview-project-filter').tap();
    await page.getByTestId('overview-project-filter-option-p0').tap();
    await page.getByTestId('overview-project-filter-option-p0').tap();
    assert.equal(await page.getByTestId('overview-project-filter-draft-count').innerText(), '7 selected');
    await page.getByTestId('overview-project-filter-apply').tap();
    const explicitAll = await inspect(page);
    assert.equal(explicitAll.filterTitle, '7/7');
    assert.match(explicitAll.counts, /7 of 7 projects/);
    assert.equal(explicitAll.nodes.length, 7);
    await page.getByTestId('overview-project-filter').tap();
    await page.getByTestId('overview-project-filter-show-all').tap();

    // Focus is a plain breadcrumb only while focused; back returns to the
    // filtered root and expansion survives the round trip.
    await page.getByTestId('overview-project-filter').tap();
    for (const id of ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']) await page.getByTestId(`overview-project-filter-option-${id}`).tap();
    await page.getByTestId('overview-project-filter-apply').tap();
    await page.getByTestId('overview-native-project:p0').tap();
    await page.getByTestId('overview-native-workspace:w0').waitFor({ state: 'visible' });
    assert.equal((await inspect(page)).title, 'Application');
    await page.getByTestId('overview-native-workspace:w0').tap();
    const filteredGroup = page.locator('[data-testid^="overview-native-completed:"]').first();
    await filteredGroup.scrollIntoViewIfNeeded();
    await filteredGroup.tap();
    await page.getByTestId('overview-native-agent:closed-child').waitFor({ state: 'visible' });
    await page.getByTestId('overview-back').tap();
    await page.getByTestId('overview-back').tap();
    const filteredRoot = await inspect(page);
    assert.equal(filteredRoot.title, undefined);
    assert.equal(filteredRoot.filterTitle, '1/7');
    assert.equal(filteredRoot.nodes.length, 1);
    assert.equal(filteredRoot.nodes[0].id, 'overview-native-project:p0');
    await page.getByTestId('overview-native-project:p0').tap();
    await page.getByTestId('overview-native-workspace:w0').tap();
    assert.ok(await page.getByTestId('overview-native-agent:closed-child').isVisible(), 'Expansion survives filtered focus changes');
    await page.getByTestId('overview-back').tap();
    await page.getByTestId('overview-back').tap();

    await page.getByTestId('overview-project-filter').tap();
    await page.getByTestId('overview-project-filter-option-p0').tap();
    await page.getByTestId('overview-project-filter-apply').tap();
    const emptyFilter = await inspect(page);
    assert.equal(emptyFilter.filterTitle, 'None');
    assert.match(emptyFilter.counts, /0 of 7 projects/);
    assert.equal(emptyFilter.nodes.length, 0);
    assert.match(await page.locator('body').innerText(), /No projects selected/);
    const emptyShowAll = page.getByTestId('overview-native-show-all');
    const emptyShowAllBox = await emptyShowAll.boundingBox();
    assert.ok(emptyShowAllBox && emptyShowAllBox.width >= 44 && emptyShowAllBox.height >= 44);
    await emptyShowAll.tap();
    const recovered = await inspect(page);
    assert.equal(recovered.filterTitle, 'All');
    assert.equal(recovered.nodes.length, 7);
    await page.getByTestId('overview-motion').tap();
    assert.equal(await page.getByTestId('overview-motion').getAttribute('aria-label'), 'Resume animation');
    await page.screenshot({ path: `${output}/phone-reset.png` });

    // Desktop toolbar: complete host list versus filtered graph, duplicate
    // project disambiguation, absolute menus that do not resize the graph,
    // keyboard navigation and Escape/focus restoration.
    const desktop = await browser.newPage({ viewport: { width: 980, height: 800 } });
    desktop.on('pageerror', error => errors.push(error.message));
    await desktop.setContent('<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;width:100%;height:100%;font-family:Arial,sans-serif;background:#f7f8fb}#app{height:100%;display:flex;flex-direction:column}</style><div id="app"></div></html>');
    await desktop.addScriptTag({ path: `${output}/native-multi.js` });
    await desktop.getByTestId('overview-native-project:first:project:same').waitFor({ state: 'visible' });
    assert.ok(await desktop.getByTestId('overview-native-project:second:project:same').isVisible());
    assert.match(await desktop.getByTestId('overview-host-status:offline').innerText(), /Offline host: offline/);
    const headerBefore = await desktop.getByTestId('overview-header').boundingBox();
    const graphBefore = await desktop.getByTestId('overview-native-graph').boundingBox();
    await desktop.getByTestId('overview-project-filter').click();
    const desktopFilter = desktop.getByTestId('overview-project-filter-menu');
    await desktopFilter.waitFor({ state: 'visible' });
    await desktop.screenshot({ path: `${output}/desktop-filter-open.png` });
    assert.equal(await desktop.getByTestId('overview-project-filter-draft-count').innerText(), 'All 2 selected');
    assert.match(await desktop.getByTestId('overview-project-filter-option-first:project:same').innerText(), /Shared name[\s\S]*first host/);
    assert.match(await desktop.getByTestId('overview-project-filter-option-second:project:same').innerText(), /Shared name[\s\S]*second host/);
    // Search keeps native Home/End/arrow caret editing; the document-level
    // menu handler must not steal those keys while matching menu rows exist.
    // The caret/focus checks come before any query edit that could empty the
    // result list, so the original nonempty-menu hijack is exercised.
    const search = desktop.getByTestId('overview-project-filter-search');
    await search.click();
    await search.fill('Shared');
    assert.ok(await desktop.locator('[data-testid^="overview-project-filter-option-"]').count() >= 1, 'search keeps at least one checkbox row');
    assert.ok(await desktopFilter.isVisible());
    await search.press('Home');
    assert.equal(await search.evaluate(input => input.selectionStart), 0, 'Home keeps the text caret');
    await search.press('End');
    assert.equal(await search.evaluate(input => input.selectionStart), 'Shared'.length, 'End keeps the text caret');
    await search.press('ArrowLeft');
    assert.equal(await search.evaluate(input => input.selectionStart), 'Shared'.length - 1, 'ArrowLeft moves the text caret');
    await search.press('ArrowRight');
    assert.equal(await search.evaluate(input => input.selectionStart), 'Shared'.length, 'ArrowRight moves the text caret');
    await search.press('ArrowUp');
    assert.equal(await desktop.evaluate(() => document.activeElement?.getAttribute('data-testid')), 'overview-project-filter-search', 'ArrowUp stays in the search field');
    await search.press('ArrowDown');
    assert.equal(await desktop.evaluate(() => document.activeElement?.getAttribute('data-testid')), 'overview-project-filter-search', 'ArrowDown stays in the search field');
    assert.ok(await desktopFilter.isVisible());
    assert.ok(await desktop.getByTestId('overview-project-filter-option-first:project:same').isVisible());
    // Editing through Home/End/ArrowLeft uses the native caret once the
    // keyboard checks above are complete; fill() then restores the row set.
    await search.press('Home');
    await desktop.keyboard.type('x');
    assert.equal(await search.inputValue(), 'xShared');
    await search.press('End');
    await desktop.keyboard.type('z');
    assert.equal(await search.inputValue(), 'xSharedz');
    await search.press('ArrowLeft');
    await desktop.keyboard.type('!');
    assert.equal(await search.inputValue(), 'xShared!z');
    await search.fill('Shared');
    assert.ok(await desktop.locator('[data-testid^="overview-project-filter-option-"]').count() >= 1);
    await search.press('Escape');
    await desktopFilter.waitFor({ state: 'hidden' });
    assert.equal(await desktop.evaluate(() => document.activeElement?.getAttribute('data-testid')), 'overview-project-filter');
    assert.equal(await desktop.getByTestId('overview-project-filter-title').innerText(), 'Projects: All');
    await desktop.getByTestId('overview-project-filter').click();
    await desktopFilter.waitFor({ state: 'visible' });
    assert.equal(await search.inputValue(), '', 'Reopening the filter resets the search');
    assert.equal(await desktop.getByTestId('overview-project-filter-option-first:project:same').getAttribute('aria-checked'), 'true');
    assert.equal(await desktop.getByTestId('overview-project-filter-option-second:project:same').getAttribute('role'), 'checkbox');
    for (const id of ['overview-project-filter-option-first:project:same', 'overview-project-filter-option-second:project:same',
      'overview-project-filter-search', 'overview-project-filter-show-all', 'overview-project-filter-cancel', 'overview-project-filter-apply']) {
      const box = await desktop.getByTestId(id).boundingBox();
      assert.ok(box && box.height >= 44 && (id.startsWith('overview-project-filter-option-') || box.width >= 44), `${id} keeps a 44px target`);
    }
    const headerOpen = await desktop.getByTestId('overview-header').boundingBox();
    const graphOpen = await desktop.getByTestId('overview-native-graph').boundingBox();
    assert.equal(headerOpen.height, headerBefore.height, 'desktop menu does not expand the header');
    assert.equal(graphOpen.height, graphBefore.height, 'desktop menu does not resize the graph');
    await desktop.getByTestId('overview-project-filter-option-second:project:same').click();
    assert.equal(await desktop.getByTestId('overview-project-filter-option-second:project:same').getAttribute('aria-checked'), 'false');
    assert.equal(await desktop.getByTestId('overview-project-filter-draft-count').innerText(), '1 selected');
    assert.ok(await desktop.getByTestId('overview-native-project:first:project:same').isVisible());
    assert.ok(await desktop.getByTestId('overview-native-project:second:project:same').isVisible());
    assert.equal(await desktop.getByTestId('overview-project-filter-title').innerText(), 'Projects: All');
    await desktop.keyboard.press('Escape');
    await desktopFilter.waitFor({ state: 'hidden' });
    assert.equal(await desktop.evaluate(() => document.activeElement?.getAttribute('data-testid')), 'overview-project-filter');
    assert.equal(await desktop.getByTestId('overview-project-filter-title').innerText(), 'Projects: All');
    await desktop.getByTestId('overview-project-filter').click();
    await desktop.getByTestId('overview-project-filter-option-second:project:same').click();
    await desktop.mouse.click(700, 700);
    await desktopFilter.waitFor({ state: 'hidden' });
    assert.equal(await desktop.evaluate(() => document.activeElement?.getAttribute('data-testid')), 'overview-project-filter');
    assert.equal(await desktop.getByTestId('overview-project-filter-title').innerText(), 'Projects: All');
    await desktop.getByTestId('overview-project-filter').click();
    await desktop.getByTestId('overview-project-filter-option-second:project:same').click();
    await desktop.getByTestId('overview-project-filter-cancel').click();
    await desktopFilter.waitFor({ state: 'hidden' });
    assert.equal(await desktop.getByTestId('overview-project-filter-title').innerText(), 'Projects: All');
    await desktop.getByTestId('overview-project-filter').click();
    await desktop.getByTestId('overview-project-filter-option-second:project:same').click();
    await desktop.getByTestId('overview-project-filter-apply').click();
    await desktop.waitForFunction(() => document.querySelector('[data-testid="overview-project-filter-title"]')?.textContent === 'Projects: 1/2');
    assert.match(await desktop.getByTestId('overview-scope-counts').innerText(), /1 of 2 projects/);
    assert.ok(await desktop.getByTestId('overview-native-project:first:project:same').isVisible());
    await desktop.waitForFunction(() => !document.querySelector('[data-testid="overview-native-project:second:project:same"]'));
    await desktop.getByTestId('overview-native-project:first:project:same').click();
    await desktop.waitForFunction(() => document.querySelector('[data-testid="overview-scope-title"]')?.textContent === 'Shared name');
    await desktop.getByTestId('overview-back').click();
    await desktop.waitForFunction(() => !document.querySelector('[data-testid="overview-scope-title"]'));
    assert.ok(await desktop.getByTestId('overview-native-project:first:project:same').isVisible());
    assert.equal(await desktop.getByTestId('overview-project-filter-title').innerText(), 'Projects: 1/2');
    await desktop.getByTestId('overview-project-filter').click();
    await desktop.getByTestId('overview-project-filter-show-all').click();
    await desktopFilter.waitFor({ state: 'hidden' });
    assert.ok(await desktop.getByTestId('overview-native-project:first:project:same').isVisible());
    assert.ok(await desktop.getByTestId('overview-native-project:second:project:same').isVisible());
    assert.equal(await desktop.getByTestId('overview-project-filter-title').innerText(), 'Projects: All');
    await desktop.getByTestId('overview-host-filter').click();
    await desktop.keyboard.press('ArrowDown');
    await desktop.keyboard.press('ArrowDown');
    await desktop.keyboard.press('Enter');
    await desktop.getByTestId('overview-native-project:second:project:same').waitFor({ state: 'visible' });
    await desktop.waitForFunction(() => !document.querySelector('[data-testid="overview-native-project:first:project:same"]'));
    assert.equal(await desktop.getByTestId('overview-host-filter').innerText(), 'second host');
    assert.equal(await desktop.getByTestId('overview-project-filter-title').innerText(), 'Projects: All');
    await desktop.getByTestId('overview-project-filter').click();
    assert.equal(await desktop.getByTestId('overview-project-filter-option-second:project:same').getAttribute('aria-checked'), 'true');
    await desktop.getByTestId('overview-project-filter-option-second:project:same').click();
    await desktop.getByTestId('overview-project-filter-option-second:project:same').click();
    await desktop.getByTestId('overview-project-filter-apply').click();
    await desktop.waitForFunction(() => document.querySelector('[data-testid="overview-project-filter-title"]')?.textContent === 'Projects: 1/1');
    assert.ok(await desktop.getByTestId('overview-native-project:second:project:same').isVisible());
    await desktop.getByTestId('overview-host-filter').click();
    await desktop.getByTestId('overview-host-option-all').click();
    assert.equal(await desktop.getByTestId('overview-project-filter-title').innerText(), 'Projects: All');
    await desktop.getByTestId('overview-native-project:first:project:same').waitFor({ state: 'visible' });
    await desktop.getByTestId('overview-native-project:second:project:same').waitFor({ state: 'visible' });
    await desktop.close();
    assert.deepEqual(errors, []);
    await fs.writeFile(`${output}/native-preview-results.json`, JSON.stringify({ ok: true, actualComponent: true, environment: 'React Native Web at 390×844, touch and DPR2; physical phone acceptance remains separate', inactiveLabel, terminalLabels: ['Closed', 'Canceled'], appearance: { dark: darkHeader, restored }, initial, project, workspace, reset, filtered, explicitAll, filteredRoot, emptyFilter, recovered, errors }, null, 2));
    console.log(JSON.stringify({ ok: true, output, checks: 'controlled scope/header with a plain focused breadcrumb, one Projects filter with real draft checkboxes (no graph change before Apply), Cancel/Escape/outside dismissal preserving the applied filter and restoring the trigger, Show all automatic reset, explicit all-applied list distinct from automatic all, native empty-selection recovery, host/project duplicate-name disambiguation, offline host isolation, absolute desktop menus with keyboard/focus restoration, quick appearance theme/background without scope loss, 44px touch targets and aria-checked, actual emoji nodes, mixed inactive outcomes, visible closed/canceled statuses and selection, group expansion retention through filtered focus, parent selection, reset and motion controls' }));
  } catch (error) {
    if (page) {
      await page.screenshot({ path: `${output}/native-preview-failure.png` }).catch(() => {});
      await fs.writeFile(`${output}/native-preview-failure.json`, JSON.stringify({ message: error.message, errors, body: await page.locator('body').innerText().catch(() => '') }, null, 2));
    }
    throw error;
  } finally { await browser.close(); }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });

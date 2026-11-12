const { build } = require('/fork/node_modules/esbuild');
const { chromium } = require('/fork/node_modules/playwright');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');
const output = process.env.OVERVIEW_ACCEPTANCE_OUTPUT || '/out';

const inspect = page => page.evaluate(() => {
  const bounds = element => {
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  };
  return {
    title: document.querySelector('[data-testid="overview-scope-title"]')?.textContent,
    counts: document.querySelector('[data-testid="overview-scope-counts"]')?.textContent,
    header: bounds(document.querySelector('[data-testid="overview-header"]')),
    nodes: [...document.querySelectorAll('[data-testid^="overview-native-project:"],[data-testid^="overview-native-workspace:"],[data-testid^="overview-native-agent:"],[data-testid^="overview-native-completed:"]')].map(node => ({ id: node.dataset.testid, label: node.getAttribute('aria-label'), box: bounds(node) })),
  };
});
(async () => {
  await fs.mkdir(output, { recursive: true });
  await build({ entryPoints: ['/plugin/acceptance/native-entry.tsx'], bundle: true, format: 'iife', platform: 'browser', target: 'es2020', outfile: `${output}/native-preview.js`, jsx: 'automatic', define: { global: 'globalThis' }, alias: {
    'react-native': '/fork/node_modules/react-native-web', react: '/fork/node_modules/react', 'react-dom': '/fork/node_modules/react-dom',
  } });
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
    assert.equal(initial.title, 'All projects');
    assert.ok(initial.header.height < 120);
    assert.ok(!/Tap a project to explore/i.test(await page.locator('body').innerText()));
    await page.screenshot({ path: `${output}/phone-roots.png` });
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
    assert.equal(workspace.title, 'Deployment and release review');
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
    await page.getByTestId('overview-all-projects').tap();
    await page.waitForTimeout(100);
    const reset = await inspect(page);
    assert.equal(reset.title, 'All projects');
    assert.equal(reset.nodes.length, 7);
    assert.ok(reset.nodes.every(node => node.box.x >= -1 && node.box.x + node.box.width <= 391));
    await page.getByTestId('overview-motion').tap();
    assert.equal(await page.getByTestId('overview-motion').getAttribute('aria-label'), 'Resume animation');
    await page.screenshot({ path: `${output}/phone-reset.png` });
    assert.deepEqual(errors, []);
    await fs.writeFile(`${output}/native-preview-results.json`, JSON.stringify({ ok: true, actualComponent: true, environment: 'React Native Web at 390×844, touch and DPR2; physical phone acceptance remains separate', inactiveLabel, terminalLabels: ['Closed', 'Canceled'], initial, project, workspace, reset, errors }, null, 2));
    console.log(JSON.stringify({ ok: true, output, checks: 'controlled scope/header, actual emoji nodes, mixed inactive outcomes, visible closed/canceled statuses and selection, group expansion/collapse, 44px targets, parent selection, reset and motion controls' }));
  } catch (error) {
    if (page) {
      await page.screenshot({ path: `${output}/native-preview-failure.png` }).catch(() => {});
      await fs.writeFile(`${output}/native-preview-failure.json`, JSON.stringify({ message: error.message, errors, body: await page.locator('body').innerText().catch(() => '') }, null, 2));
    }
    throw error;
  } finally { await browser.close(); }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });

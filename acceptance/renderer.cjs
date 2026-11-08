const { build } = require('/fork/node_modules/esbuild');
const { chromium } = require('/fork/node_modules/playwright');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');

const output = process.env.OVERVIEW_ACCEPTANCE_OUTPUT || '/out';
const node = (page, id) => page.locator(`[data-overview-id="${id}"]`);
const inspect = page => page.evaluate(() => {
  const bounds = element => {
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  };
  return [...document.querySelectorAll('[data-overview-kind]')].map(element => ({
    id: element.dataset.overviewId, kind: element.dataset.overviewKind,
    role: element.dataset.overviewRole, avatar: element.dataset.overviewAvatar,
    highlighted: element.dataset.overviewHighlighted,
    members: JSON.parse(element.dataset.overviewMembers || '[]'),
    box: bounds(element), text: element.innerText,
  }));
});
function sameGeometry(before, after) {
  assert.deepEqual(after.map(item => item.id).sort(), before.map(item => item.id).sort());
  for (const prior of before) {
    const next = after.find(item => item.id === prior.id);
    for (const axis of ['x', 'y', 'width', 'height']) {
      assert.ok(Math.abs(next.box[axis] - prior.box[axis]) < 1, `${prior.id} moved on ${axis}`);
    }
  }
}
function checkRepresentation(nodes) {
  const native = nodes.flatMap(item => item.kind === 'provider-subagent' ? [item.id] : item.members.filter(id => /^n\d+$/.test(id)));
  assert.equal(new Set(native).size, native.length);
  assert.deepEqual(native.sort(), Array.from({ length: 43 }, (_, index) => `n${index}`).sort());
  for (const id of ['n0', 'n1', 'n2', 'n6']) assert.ok(nodes.some(item => item.id === id), `${id} must stay visible`);
}

(async () => {
  await fs.mkdir(output, { recursive: true });
  await build({ entryPoints: ['/plugin/acceptance/renderer-entry.ts'], bundle: true, format: 'iife', platform: 'browser', target: 'es2020', outfile: `${output}/renderer.js` });
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const errors = [];
  let page;
  try {
    page = await browser.newPage({ viewport: { width: 1516, height: 1220 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent('<!doctype html><html><style>*{box-sizing:border-box}html,body{margin:0;height:100%;background:#f7f8fb;font-family:Arial,sans-serif}header{height:56px;padding:18px 24px;color:#18223b;font-weight:600;border-bottom:1px solid #dbe1ec}#graph{position:relative;width:100%;height:calc(100vh - 56px)}</style><header>Overview · Sanitised acceptance fixture</header><main id="graph"></main></html>');
    await page.addScriptTag({ path: `${output}/renderer.js` });
    for (const stage of ['loadProjects', 'loadWorkspaces', 'loadManaged', 'loadNative']) {
      await page.evaluate(name => window.overviewTest[name](), stage);
      await page.waitForTimeout(150);
    }
    await page.evaluate(() => window.overviewTest.motion(false));
    await page.waitForTimeout(100);
    assert.equal(await page.locator('canvas').count(), 1);
    const full = await inspect(page);
    assert.equal(full.filter(item => item.kind === 'project').length, 7);
    assert.equal(full.filter(item => item.kind === 'workspace').length, 14);
    checkRepresentation(full);
    assert.equal(full.find(item => item.id === 'a0-0').role, 'agent');
    assert.equal(full.find(item => item.id === 'a0-3').role, 'subagent', 'Managed subordinate uses child styling');
    assert.equal(full.find(item => item.id === 'a8-0').role, 'agent', 'Remote delegation retains workspace ownership');
    assert.ok(full.filter(item => ['agent', 'provider-subagent'].includes(item.kind)).every(item => item.avatar.length > 0));
    await page.screenshot({ path: `${output}/desktop-full.png` });

    const group = full.find(item => item.kind === 'completed-group');
    const background = full.filter(item => item.kind === 'project' && item.id !== 'p0');
    const backgroundGeometry = current => current.filter(item => background.some(root => root.id === item.id));
    assert.ok(group && group.members.length > 1);
    await node(page, 'p0').click();
    await page.waitForTimeout(100);
    assert.deepEqual(await page.evaluate(() => window.overviewTest.state.focused), { kind: 'project', id: 'p0' });
    assert.equal(await node(page, group.id).count(), 1, 'Focus preserves explicit group choices');
    sameGeometry(background, backgroundGeometry(await inspect(page)));
    await page.screenshot({ path: `${output}/desktop-project.png` });
    await node(page, 'w0').click();
    await page.waitForTimeout(100);
    await node(page, group.id).click();
    await page.waitForTimeout(100);
    for (const id of group.members) assert.equal(await node(page, id).count(), 1);
    sameGeometry(background, backgroundGeometry(await inspect(page)));
    await page.screenshot({ path: `${output}/desktop-expanded.png` });
    await page.locator(`[data-overview-collapse="${group.id}"]`).click();
    await page.waitForTimeout(100);
    assert.equal(await node(page, group.id).count(), 1);
    sameGeometry(background, backgroundGeometry(await inspect(page)));

    await node(page, 'n0').click();
    await page.waitForTimeout(100);
    const selected = await inspect(page);
    for (const id of ['n0', 'a0-0', 'w0', 'p0']) assert.equal(selected.find(item => item.id === id).highlighted, 'true');
    await page.screenshot({ path: `${output}/desktop-selected.png` });
    const avatars = selected.map(item => [item.id, item.avatar]);
    await page.evaluate(() => { window.overviewTest.visibility(false); window.overviewTest.visibility(true); window.overviewTest.refresh(); });
    await page.waitForTimeout(100);
    sameGeometry(selected, await inspect(page));
    assert.equal(await page.evaluate(() => window.overviewTest.state.selected), 'n0');
    assert.deepEqual((await inspect(page)).map(item => [item.id, item.avatar]), avatars);

    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => window.overviewTest.state.selected), null);
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => window.overviewTest.state.focused), null);
    await page.waitForTimeout(100);
    sameGeometry(full, await inspect(page));
    const beforeWheel = await inspect(page);
    await page.mouse.wheel(0, 600);
    await page.waitForTimeout(100);
    sameGeometry(beforeWheel, await inspect(page));
    const beforeIcon = await inspect(page);
    await page.evaluate(() => window.overviewTest.updateIcon());
    await page.waitForTimeout(100);
    sameGeometry(beforeIcon, await inspect(page));

    await node(page, 'w0').click();
    await page.evaluate(() => { window.overviewTest.motion(true); window.overviewTest.activity(); });
    await page.waitForTimeout(200);
    const bubble = page.locator('[data-overview-bubble="n0"]');
    await bubble.waitFor({ state: 'visible' });
    const bubbleText = await bubble.innerText();
    assert.ok(bubbleText.includes('Command finished'));
    assert.ok(bubbleText.length < 600, 'A long event remains a bounded preview');
    const bubbleBox = await bubble.boundingBox(), sourceBox = await node(page, 'n0').boundingBox();
    assert.ok(bubbleBox.height < 120 && bubbleBox.width < 360, 'Bubble has a compact measured footprint');
    assert.ok(Math.hypot(bubbleBox.x - sourceBox.x, bubbleBox.y - sourceBox.y) < 420, 'Bubble stays near its source');
    await page.screenshot({ path: `${output}/desktop-activity.png` });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.evaluate(() => window.overviewTest.motion(false));
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 1024, height: 900 });
    await page.waitForTimeout(100);
    checkRepresentation(await inspect(page));
    await page.screenshot({ path: `${output}/desktop-compact.png` });
    await page.evaluate(() => window.overviewTest.dark());
    await page.screenshot({ path: `${output}/desktop-dark.png` });
    for (let index = 0; index < 4; index++) {
      await page.evaluate(() => window.overviewTest.dispose());
      assert.equal(await page.locator('#graph canvas,#graph button').count(), 0);
      await page.evaluate(() => window.overviewTest.recreate());
      await page.waitForTimeout(75);
      assert.equal(await page.locator('canvas').count(), 1);
    }
    assert.deepEqual(await page.evaluate(() => window.overviewTest.state.errors), []);
    assert.deepEqual(errors, []);
    await fs.writeFile(`${output}/renderer-results.json`, JSON.stringify({ ok: true, renderer: 'Actual Three.js renderer, Chromium SwiftShader; not hardware performance evidence', full, selected, bubbleText, errors }, null, 2));
    console.log(JSON.stringify({ ok: true, output, checks: 'cold load, ownership roles, stable avatars, grouping, selection, visibility, icons, no wheel zoom, bounded bubbles, themes, cleanup' }));
  } catch (error) {
    if (page) {
      await page.screenshot({ path: `${output}/renderer-failure.png` }).catch(() => {});
      await fs.writeFile(`${output}/renderer-failure.json`, JSON.stringify({ message: error.message, errors, nodes: await inspect(page).catch(() => []) }, null, 2));
    }
    throw error;
  } finally { await browser.close(); }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });

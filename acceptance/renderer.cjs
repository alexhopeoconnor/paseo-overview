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
    const collapse = page.locator(`[data-overview-collapse="${group.id}"]`);
    assert.equal(await collapse.innerText(), `Collapse ${group.members.length}`);
    assert.equal(await collapse.evaluate(button => button.scrollWidth <= button.clientWidth), true, 'Measured control fits its full label');
    await collapse.click();
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
    await page.waitForTimeout(100);
    await page.screenshot({ path: `${output}/desktop-dark.png` });

    // Exercise real scale transforms and pulse rendering together, without debug hooks in the product.
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.setViewportSize({ width: 1516, height: 1220 });
    await page.mouse.move(4, 4);
    await page.evaluate(() => window.overviewTest.depthFixture());
    await page.waitForTimeout(150);
    const depthBefore = await inspect(page);
    const graphBefore = (await page.evaluate(() => window.overviewTest.telemetry())).graphs;
    const regions = graphBefore.slice(0, 2).map(graph => ({ x: graph.x - 45, y: graph.y - 45, width: graph.width + 90, height: graph.height + 90 }));
    const beforeIllumination = await page.evaluate(regions => window.overviewTest.ambientEvidence('local', 3, regions), regions);
    await page.evaluate(() => { window.overviewTest.motion(true); window.overviewTest.resetTelemetry(); window.overviewTest.burst(); });
    await page.waitForTimeout(160);
    assert.ok((await page.evaluate(() => window.overviewTest.telemetry())).pulseUpdates >= 2, 'Activity depth preserves real travelling pulse updates');
    const pulseTheme = await page.evaluate(() => {
      const before = window.overviewTest.pulseEvidence();
      window.overviewTest.theme(false);
      return { before, after: window.overviewTest.pulseEvidence() };
    });
    assert.ok(pulseTheme.before.length > 0, 'Theme acceptance observes an existing fibre journey');
    assert.deepEqual(pulseTheme.after.map(item => item.id), pulseTheme.before.map(item => item.id), 'Theme change preserves existing journeys');
    assert.notDeepEqual(pulseTheme.after.map(item => item.colours), pulseTheme.before.map(item => item.colours), 'Theme updates the materials of pulses already in flight');
    await page.evaluate(() => window.overviewTest.theme(true));
    await page.waitForTimeout(1800);
    const depthAfter = await inspect(page);
    assert.ok(depthAfter.find(item => item.id === 'p0').box.width > depthBefore.find(item => item.id === 'p0').box.width * 1.01, 'Busy project becomes modestly larger');
    assert.ok(depthAfter.find(item => item.id === 'p1').box.width < depthBefore.find(item => item.id === 'p1').box.width * 0.99, 'Quiet project gently recedes');
    const graphAfter = (await page.evaluate(() => window.overviewTest.telemetry())).graphs;
    for (const before of graphBefore) {
      const after = graphAfter.find(item => item.id === before.id);
      assert.ok(Math.abs((after.x + after.width / 2) - (before.x + before.width / 2)) < 1.5 && Math.abs((after.y + after.height / 2) - (before.y + before.height / 2)) < 1.5, 'Packed graph centres stay fixed');
      assert.ok(Math.abs(after.width - before.width) <= 16.01 && Math.abs(after.height - before.height) <= 16.01, 'Depth remains within eight pixels per side');
    }
    const centre = graph => ({ x: graph.x + graph.width / 2, y: graph.y + graph.height / 2 });
    const localGrid = await page.evaluate(({ busy, quiet }) => ({ busy: window.overviewTest.gridFieldAt(busy.x, busy.y), quiet: window.overviewTest.gridFieldAt(quiet.x, quiet.y) }), {
      busy: centre(graphAfter[0]), quiet: centre(graphAfter[1]),
    });
    const gridSummary = await page.evaluate(() => window.overviewTest.gridFieldSummary());
    assert.ok(localGrid.busy.intensity > localGrid.quiet.intensity, `Busy project receives stronger local grid illumination than a quiet project: ${JSON.stringify({ localGrid, gridSummary, graphAfter })}`);
    assert.ok(localGrid.busy.warp <= 12 && localGrid.quiet.warp <= 12, 'Displayed influence warp stays bounded');
    const afterIllumination = await page.evaluate(regions => window.overviewTest.ambientEvidence('local', 3, regions), regions);
    const illuminationGain = afterIllumination.local.map((region, index) => region.meanAlpha - beforeIllumination.local[index].meanAlpha);
    assert.ok(illuminationGain[0] > 0.05 && illuminationGain[0] > illuminationGain[1], `Rendered grid brightens locally around real activity: ${JSON.stringify(illuminationGain)}`);
    const inspecting = await node(page, 'depth-a').boundingBox();
    await page.mouse.move(inspecting.x + inspecting.width / 2, inspecting.y + inspecting.height / 2);
    await page.waitForTimeout(75);
    const heldDepth = (await inspect(page)).filter(item => ['p0', 'depth-a'].includes(item.id));
    await page.evaluate(() => window.overviewTest.burst());
    await page.waitForTimeout(300);
    sameGeometry(heldDepth, (await inspect(page)).filter(item => ['p0', 'depth-a'].includes(item.id)));
    await node(page, 'depth-a').click();
    await page.mouse.move(4, 4);
    await page.waitForTimeout(250);
    sameGeometry(heldDepth, (await inspect(page)).filter(item => ['p0', 'depth-a'].includes(item.id)));

    // Pause freezes influence values even when fresh work arrives; observations still update.
    await page.evaluate(() => window.overviewTest.motion(false));
    await page.waitForTimeout(100);
    const frozenField = await page.evaluate(() => window.overviewTest.fieldEvidence());
    await page.evaluate(() => window.overviewTest.burst());
    await page.waitForTimeout(200);
    assert.deepEqual(await page.evaluate(() => window.overviewTest.fieldEvidence()), frozenField, 'Fresh activity does not move the paused grid');
    await page.evaluate(() => window.overviewTest.motion(true));

    // An empty connected scene isolates ambient scheduling from working heartbeats.
    await page.evaluate(() => window.overviewTest.empty());
    await page.waitForTimeout(150);
    const ambientEvidence = await page.evaluate(() => window.overviewTest.ambientEvidence('moving'));
    const fieldBeforeIdle = await page.evaluate(() => window.overviewTest.fieldEvidence());
    assert.ok(ambientEvidence.visiblePixels > 800, `Grid has meaningful visible structure (${JSON.stringify(ambientEvidence)})`);
    assert.ok(ambientEvidence.meanAlpha > 10, 'Grid lines remain visibly separated from the transparent canvas');
    await page.evaluate(() => window.overviewTest.resetTelemetry());
    const ambientBefore = (await page.evaluate(() => window.overviewTest.telemetry())).ambient;
    await page.waitForTimeout(500);
    const ambientAfter = await page.evaluate(() => window.overviewTest.telemetry());
    assert.ok(ambientAfter.frames >= 5 && ambientAfter.frames <= 18, `Ambient-only rendering stays at a low cadence (${ambientAfter.frames} frames)`);
    assert.notDeepEqual(ambientAfter.ambient, ambientBefore);
    assert.equal(ambientAfter.layoutBuilds, 0, 'Ambient-only ticks do not rebuild layout');
    assert.deepEqual(await page.evaluate(() => window.overviewTest.fieldEvidence()), fieldBeforeIdle, 'Unchanged ambient-only frames reuse GPU field attributes');
    const renderedMovement = await page.evaluate(() => window.overviewTest.ambientEvidence('moving'));
    assert.ok(renderedMovement.changedPixels > 100, `Actual grid pixels move, independently of the time uniform: ${renderedMovement.changedPixels}`);
    await page.evaluate(() => { window.overviewTest.motion(false); window.overviewTest.theme(false); });
    await page.waitForTimeout(100);
    const lightGrid = await page.evaluate(() => window.overviewTest.ambientEvidence('theme', 3));
    await page.evaluate(() => window.overviewTest.theme(true));
    await page.waitForTimeout(100);
    const darkGrid = await page.evaluate(() => window.overviewTest.ambientEvidence('theme', 3));
    assert.ok(lightGrid.visiblePixels > 800 && darkGrid.visiblePixels > 800, 'Both themes render visible grid structure');
    assert.ok(darkGrid.changedPixels > 800 && Math.abs(lightGrid.meanColour - darkGrid.meanColour) > 1, 'Effective theme changes rendered grid colours');
    await page.evaluate(() => window.overviewTest.motion(true));
    for (const mode of ['pause', 'reduce', 'hidden', 'disconnected']) {
      if (mode === 'pause') await page.evaluate(() => window.overviewTest.motion(false));
      if (mode === 'reduce') { await page.evaluate(() => window.overviewTest.motion(true)); await page.emulateMedia({ reducedMotion: 'reduce' }); }
      if (mode === 'hidden') { await page.emulateMedia({ reducedMotion: 'no-preference' }); await page.evaluate(() => window.overviewTest.visibility(false)); }
      if (mode === 'disconnected') await page.evaluate(() => { window.overviewTest.visibility(true); window.overviewTest.connection('disconnected'); });
      await page.waitForTimeout(100);
      await page.evaluate(() => window.overviewTest.resetTelemetry());
      await page.waitForTimeout(250);
      assert.equal((await page.evaluate(() => window.overviewTest.telemetry())).frames, 0, `${mode} stops the ambient render loop`);
    }
    await page.evaluate(() => window.overviewTest.connection('connected'));
    await page.waitForTimeout(150);
    assert.ok((await page.evaluate(() => window.overviewTest.telemetry())).frames > 0, 'Reconnect restarts the shared scheduler');
    await page.evaluate(() => window.overviewTest.loadNative());
    await page.waitForTimeout(100);
    await page.evaluate(() => window.overviewTest.installShaderObserver());
    assert.equal(await page.evaluate(() => window.overviewTest.injectAmbientShaderFailure()), true, 'Acceptance can inject an ambient-only shader failure');
    await page.waitForTimeout(150);
    assert.equal(await page.evaluate(() => window.overviewTest.gridPresent()), false, 'Failed grid material is removed independently');
    assert.ok(await page.locator('[data-overview-kind="project"]').count() > 0, 'Foreground graph remains usable after a grid shader failure');
    assert.deepEqual(await page.evaluate(() => window.overviewTest.shaderObserverEvidence()), { restored: true, unrelatedErrors: 0 }, 'Background compilation restores the existing shader-error handler');
    const resources = [];
    for (let index = 0; index < 4; index++) {
      await page.evaluate(() => window.overviewTest.dispose());
      assert.equal(await page.locator('#graph canvas,#graph button').count(), 0);
      await page.evaluate(() => window.overviewTest.recreate());
      await page.waitForTimeout(75);
      assert.equal(await page.locator('canvas').count(), 1);
      resources.push(await page.evaluate(() => window.overviewTest.resourceEvidence()));
    }
    for (const memory of resources.slice(1)) {
      assert.ok(memory.geometries <= resources[0].geometries + 2 && memory.textures <= resources[0].textures + 2 && memory.programs <= resources[0].programs + 1,
        `Repeated renderer creation retains bounded GPU resources: ${JSON.stringify(resources)}`);
    }
    assert.deepEqual(await page.evaluate(() => window.overviewTest.state.errors), []);
    assert.deepEqual(errors, []);
    await fs.writeFile(`${output}/renderer-results.json`, JSON.stringify({ ok: true, renderer: 'Actual Three.js renderer, Chromium SwiftShader; not hardware performance evidence', full, selected, bubbleText, depthBefore, depthAfter, ambientEvidence, renderedMovement, lightGrid, darkGrid, illuminationGain, resources, ambientFrames: ambientAfter.frames, errors }, null, 2));
    console.log(JSON.stringify({ ok: true, output, checks: 'cold load, ownership roles, stable avatars, grouping, selection, visibility, icons, no wheel zoom, bounded bubbles, activity depth, stable centres, preserved pulses, frozen inspection, visible grid structure and motion, idle/paused/hidden/disconnected scheduler, themes, shader fallback, cleanup' }));
  } catch (error) {
    if (page) {
      await page.screenshot({ path: `${output}/renderer-failure.png` }).catch(() => {});
      await fs.writeFile(`${output}/renderer-failure.json`, JSON.stringify({ message: error.message, errors, nodes: await inspect(page).catch(() => []) }, null, 2));
    }
    throw error;
  } finally { await browser.close(); }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });

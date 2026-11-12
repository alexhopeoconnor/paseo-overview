// Run against an explicitly supplied browser. This keeps hardware measurements
// distinct from the software-rendered correctness runner.
const { build } = require('/fork/node_modules/esbuild');
const { chromium } = require('/fork/node_modules/playwright');
const fs = require('node:fs/promises');
const http = require('node:http');
const assert = require('node:assert/strict');

const output = process.env.OVERVIEW_ACCEPTANCE_OUTPUT || '/out';
const endpoint = process.env.OVERVIEW_BROWSER_CDP;
if (!endpoint) throw new Error('Set OVERVIEW_BROWSER_CDP to an isolated hardware-browser CDP endpoint.');
const percentile = (values, fraction) => {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * fraction))] ?? 0;
};

(async () => {
  await fs.mkdir(output, { recursive: true });
  await build({ entryPoints: ['/plugin/acceptance/renderer-entry.ts'], bundle: true, format: 'iife', platform: 'browser', target: 'es2020', outfile: `${output}/performance.js` });
  const script = await fs.readFile(`${output}/performance.js`);
  const server = http.createServer((request, response) => {
    if (request.url === '/fixture.js') {
      response.writeHead(200, { 'content-type': 'text/javascript' }); response.end(script); return;
    }
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<!doctype html><html><style>*{box-sizing:border-box}html,body,#graph{margin:0;width:100%;height:100%;font-family:Arial,sans-serif;background:#f7f8fb}#graph{position:relative}</style><main id="graph"></main><script src="/fixture.js"></script></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser, context;
  try {
    browser = await chromium.connectOverCDP(endpoint);
    context = await browser.newContext({ viewport: { width: 1516, height: 1100 }, deviceScaleFactor: 1 });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => { errors.push(error.message); console.error('Fixture:', error.message); });
    await page.goto(`http://127.0.0.1:${server.address().port}/?performance=1`);
    await page.waitForFunction(() => !!window.overviewTest);
    const gpu = await page.evaluate(() => {
      const gl = document.querySelector('canvas').getContext('webgl2');
      const debug = gl.getExtension('WEBGL_debug_renderer_info');
      return { vendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
        renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
        pixelRatio: devicePixelRatio };
    });
    assert.ok(!/swiftshader|llvmpipe|software/i.test(gpu.renderer), `Hardware rendering required: ${gpu.renderer}`);
    const session = await context.newCDPSession(page);
    await session.send('Performance.enable');
    const metrics = async () => Object.fromEntries((await session.send('Performance.getMetrics')).metrics.map(value => [value.name, value.value]));
    async function sample(name, milliseconds = 4000) {
      await page.evaluate(() => window.overviewTest.resetTelemetry());
      const before = await metrics(), start = Date.now();
      await page.waitForTimeout(milliseconds);
      const after = await metrics(), elapsed = (Date.now() - start) / 1000;
      const telemetry = await page.evaluate(() => window.overviewTest.telemetry());
      const times = telemetry.frameTimes;
      const intervals = times.slice(1).map((time, index) => time - times[index]);
      return { name, seconds: elapsed, frames: telemetry.frames, framesPerSecond: telemetry.frames / elapsed,
        frameIntervalMs: { median: percentile(intervals, 0.5), p95: percentile(intervals, 0.95), maximum: Math.max(0, ...intervals) },
        mainThreadMsPerSecond: (after.TaskDuration - before.TaskDuration) * 1000 / elapsed,
        scriptMsPerSecond: (after.ScriptDuration - before.ScriptDuration) * 1000 / elapsed,
        layoutBuilds: telemetry.layoutBuilds, resources: await page.evaluate(() => window.overviewTest.resourceEvidence()) };
    }
    for (const stage of ['loadProjects', 'loadWorkspaces', 'loadManaged', 'loadNative']) await page.evaluate(name => window.overviewTest[name](), stage);
    await page.waitForTimeout(1500);
    const results = [];
    // The same foreground and scheduler are retained for this draw-cost comparison.
    for (const enabled of [true, false, true]) {
      await page.evaluate(value => window.overviewTest.background(value), enabled);
      await page.waitForTimeout(500);
      results.push(await sample(`active-grid-${enabled ? 'on' : 'off'}`));
    }
    await page.screenshot({ path: `${output}/hardware-light.png` });
    const selections = [];
    for (let index = 0; index < 5; index++) {
      const start = Date.now();
      await page.locator('[data-overview-id="a0-0"]').click();
      await page.waitForFunction(() => window.overviewTest.state.selected === 'a0-0');
      selections.push(Date.now() - start);
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
    }
    await page.evaluate(() => window.overviewTest.dark());
    await page.waitForTimeout(1000);
    await page.screenshot({ path: `${output}/hardware-dark.png` });
    await page.evaluate(() => { window.overviewTest.empty(); window.overviewTest.motion(true); });
    await page.waitForTimeout(1500);
    results.push(await sample('ambient-only'));
    await page.evaluate(() => window.overviewTest.motion(false));
    await page.waitForTimeout(100);
    results.push(await sample('paused', 1000));
    await page.evaluate(() => { window.overviewTest.motion(true); window.overviewTest.visibility(false); });
    results.push(await sample('hidden', 1000));
    assert.equal(results.find(item => item.name === 'paused').frames, 0);
    assert.equal(results.find(item => item.name === 'hidden').frames, 0);
    assert.ok(results.every(item => item.layoutBuilds === 0), 'Steady animation does not rebuild layout');
    assert.deepEqual(errors, []);
    await fs.writeFile(`${output}/performance-results.json`, JSON.stringify({ gpu, viewport: { width: 1516, height: 1100 },
      comparison: 'Same foreground/scheduler; grid draw enabled versus disabled. CPU metrics include browser work.',
      pointerSelectionMs: selections, results, errors }, null, 2));
    console.log(JSON.stringify({ gpu, pointerSelectionMs: selections, results }, null, 2));
  } finally {
    await context?.close();
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

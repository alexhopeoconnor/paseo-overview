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
  const card = document.getElementById('card');
  return { graph: bounds(document.getElementById('graph')), card: bounds(card),
    placement: card.dataset.overviewPlacement, visibility: card.style.visibility };
});
function bounded(value, label) {
  const { graph, card } = value;
  assert.ok(card.x >= graph.x + 11.5, `${label}: left boundary ${JSON.stringify(value)}`);
  assert.ok(card.y >= graph.y + 11.5, `${label}: top boundary ${JSON.stringify(value)}`);
  assert.ok(card.x + card.width <= graph.x + graph.width - 11.5, `${label}: right boundary ${JSON.stringify(value)}`);
  assert.ok(card.y + card.height <= graph.y + graph.height - 11.5, `${label}: bottom boundary ${JSON.stringify(value)}`);
}

(async () => {
  await fs.mkdir(output, { recursive: true });
  await build({ entryPoints: ['/plugin/acceptance/floating-entry.ts'], bundle: true, format: 'iife', platform: 'browser', target: 'es2020', outfile: `${output}/floating.js` });
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const errors = [], cases = [];
  let page;
  try {
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent(`<!doctype html><html><style>
      *{box-sizing:border-box}html,body{margin:0;overflow:hidden;font-family:Arial,sans-serif;background:#f6f7fa}
      #shell{position:relative}#area{position:absolute;right:0;bottom:0;overflow:hidden}
      #graph{position:absolute;right:0;bottom:0;background:#fff;overflow:hidden}
      .node{position:absolute;opacity:1;border:1px solid #e0e3e9;border-radius:12px;background:#f8fafc}
      #card{position:absolute;top:8px;left:8px;width:304px;max-width:94%;max-height:85%;border:1px solid #ccd1db;border-radius:16px;overflow:hidden;box-shadow:0 12px 36px #0002;background:#fff;z-index:20;display:flex;flex-direction:column}
      #content{padding:13px;overflow:auto;flex-shrink:1;min-height:0;font-size:14px;line-height:19px}h3{font-size:14px;line-height:19px;margin:0 0 12px}p{margin:0 0 9px}button{min-height:44px;width:100%;border:1px solid #ccd1db;border-radius:10px;background:#fff;color:#315fc4;font-weight:600}
    </style><div id="shell"><div id="area"><div id="graph">
      <div class="node" data-overview-id="left" data-overview-highlighted="true" style="left:18%;top:10%;width:32%;height:70%"></div>
      <div class="node" data-overview-id="right" data-overview-highlighted="true" style="left:54%;top:10%;width:32%;height:70%"></div>
    </div><div id="card"><div id="content"><h3>${'Review routes and passive observations across multiple concurrent projects. '.repeat(9)}</h3><p>Finished · unread result</p><p>Application / Deployment and release review</p><p>${'Recent bounded activity preview. '.repeat(12)}</p><button id="open">Open chat →</button></div></div></div></div></html>`);
    await page.addScriptTag({ path: `${output}/floating.js` });
    const runCase = async (name, x, y) => {
      const before = (await inspect(page)).graph;
      await page.evaluate(({ x, y }) => window.floatingTest.place(x, y), { x, y });
      const value = await inspect(page);
      bounded(value, name);
      assert.deepEqual(value.graph, before, `${name}: opening must not resize the graph`);
      cases.push({ name, ...value });
    };
    await runCase('tall-centre', 0.5, 0.5);
    await page.setViewportSize({ width: 1440, height: 440 });
    await page.waitForFunction(() => Math.abs(document.getElementById('graph').getBoundingClientRect().height - 323) < 1);
    for (const [name, x, y] of [['centre', 0.5, 0.5], ['top-left', 0, 0], ['top-right', 1, 0], ['bottom-left', 0, 1], ['bottom-right', 1, 1], ['top-centre', 0.5, 0], ['bottom-centre', 0.5, 1]]) await runCase(`short-${name}`, x, y);
    const beforeScroll = (await inspect(page)).graph;
    await page.locator('#open').scrollIntoViewIfNeeded();
    assert.ok(await page.locator('#content').evaluate(content => content.scrollTop > 0 && content.scrollHeight > content.clientHeight), 'Long content remains internally scrollable');
    assert.deepEqual((await inspect(page)).graph, beforeScroll, 'Details scrolling must not move the graph');
    await page.screenshot({ path: `${output}/floating-short.png` });
    await page.evaluate(() => window.floatingTest.rapid());
    bounded(await inspect(page), 'rapid-consecutive-updates');
    await page.evaluate(() => window.floatingTest.setZoom(1.25));
    for (const [name, x, y] of [['centre', 0.5, 0.5], ['top', 0.5, 0], ['bottom', 0.5, 1]]) await runCase(`zoom125-${name}`, x, y);
    await page.screenshot({ path: `${output}/floating-zoom125.png` });
    await page.evaluate(() => window.floatingTest.offsetParentVariant());
    await runCase('bordered-scrolled-offset-parent', 0.5, 0.5);
    await page.screenshot({ path: `${output}/floating-offset-parent.png` });
    await page.locator('#open').focus();
    await page.keyboard.press('Escape');
    assert.deepEqual(await page.evaluate(() => window.floatingTest.state), { dismissals: 1, backgroundEscapes: 0 });
    assert.equal((await inspect(page)).visibility, 'hidden');
    await page.evaluate(() => window.floatingTest.dispose());
    assert.equal(await page.locator('#card').getAttribute('role'), null);
    assert.deepEqual(errors, []);
    await fs.writeFile(`${output}/floating-results.json`, JSON.stringify({ ok: true, actualPositioner: true, environment: 'Chromium DOM fixture matching long scrollable details geometry; no private app components', cases, errors,
      checks: ['long card at graph y117 height323', 'corners and centre', '1000-to-440 viewport resize', 'CSS zoom125', 'bordered scrolled offset parent', 'rapid updates', '12px containment', 'unchanged graph bounds', 'single Escape dismissal', 'cleanup'] }, null, 2));
    console.log(JSON.stringify({ ok: true, output, cases: cases.length }));
  } catch (error) {
    if (page) {
      await page.screenshot({ path: `${output}/floating-failure.png` }).catch(() => {});
      await fs.writeFile(`${output}/floating-failure.json`, JSON.stringify({ message: error.message, errors, cases, current: await inspect(page).catch(() => null) }, null, 2));
    }
    throw error;
  } finally { await browser.close(); }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });

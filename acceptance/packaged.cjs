const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");
const { createHash } = require("node:crypto");
const { checkMultipleHosts } = require("./multi-host.cjs");

function readExpectation(env) {
  const runtimeVersion = env.OVERVIEW_EXPECT_RUNTIME_VERSION;
  const packageSha256 = env.OVERVIEW_EXPECT_PACKAGE_SHA256;
  const chatPreviewSettings = env.OVERVIEW_EXPECT_CHAT_PREVIEW_SETTINGS;
  assert.match(runtimeVersion ?? "", /^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?$/, "Set OVERVIEW_EXPECT_RUNTIME_VERSION to the tested package runtime version");
  assert.match(packageSha256 ?? "", /^[a-f0-9]{64}$/, "Set OVERVIEW_EXPECT_PACKAGE_SHA256 to the exact tested package SHA256");
  assert.ok(chatPreviewSettings === "required" || chatPreviewSettings === "not-applicable", "Set OVERVIEW_EXPECT_CHAT_PREVIEW_SETTINGS to required or not-applicable");
  return { runtimeVersion, packageSha256, chatPreviewSettings };
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitFor(test, label, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { const result = await test(); if (result) return result; } catch (error) { last = error; }
    await delay(150);
  }
  throw new Error(`Timed out: ${label}${last ? ` (${last.message})` : ""}`);
}

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

function copySourceCheckout(destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const name of ["package.json", "package-lock.json", "paseo-plugin.json", "index.client.tsx", "index.server.ts", "client", "server", "shared", "OVERVIEW.md"])
    fs.cpSync(path.join("/plugin-source", name), path.join(destination, name), { recursive: true });
  for (const name of ["three", "d3-hierarchy", "@floating-ui"])
    fs.cpSync(path.join("/plugin-source/node_modules", name), path.join(destination, "node_modules", name), { recursive: true });
}

function readPluginIdentity(pluginDir) {
  const manifestPath = path.join(pluginDir, "paseo-plugin.json");
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`Overview plugin needs a readable paseo-plugin.json: ${manifestPath}`, { cause: error });
  }
  assert.equal(manifest?.id, "overview", "Overview plugin manifest must declare id overview");
  assert.ok(typeof manifest?.name === "string" && manifest.name.trim().length > 0, "Overview plugin manifest must declare a name");
  let version = null;
  const packageJsonPath = path.join(pluginDir, "package.json");
  if (fs.existsSync(packageJsonPath)) {
    const metadata = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    if (typeof metadata?.version === "string" && metadata.version.length > 0) version = metadata.version;
  }
  return { id: manifest.id, name: manifest.name, version };
}

// Decode actual compositor screenshots in the isolated browser, avoiding a new PNG
// dependency and any private product debug interface. The initial empty graph
// isolates grid pixels from foreground heartbeat/pulse animation.
async function packagedGridPixels(page, key) {
  const target = page.getByTestId("overview-canvas-host").locator("canvas");
  const bounds = await target.boundingBox();
  const emptyLabel = await page.getByText("Your projects will appear here", { exact: true }).boundingBox();
  const screenshot = await target.screenshot();
  return page.evaluate(async ({ encoded, key, bounds, emptyLabel }) => {
    const image = new Image();
    image.src = `data:image/png;base64,${encoded}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const captures = window.overviewAcceptancePixels ??= new Map();
    const previous = captures.get(key);
    const frequencies = new Map();
    for (let index = 0; index < pixels.length; index += 16) {
      const rgb = `${pixels[index]},${pixels[index + 1]},${pixels[index + 2]}`;
      frequencies.set(rgb, (frequencies.get(rgb) ?? 0) + 1);
    }
    const base = [...frequencies].sort((a, b) => b[1] - a[1])[0][0].split(",").map(Number);
    let structurePixels = 0, changedPixels = 0, strongChangedPixels = 0, maximumDelta = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      // A compositor screenshot includes the foreground empty-state label over
      // the canvas. Its readable text must remain when Background is Off.
      const x = (index / 4 % canvas.width) * bounds.width / canvas.width + bounds.x;
      const y = Math.floor(index / 4 / canvas.width) * bounds.height / canvas.height + bounds.y;
      if (emptyLabel && x >= emptyLabel.x - 2 && x <= emptyLabel.x + emptyLabel.width + 2 &&
          y >= emptyLabel.y - 2 && y <= emptyLabel.y + emptyLabel.height + 2) continue;
      if (Math.max(Math.abs(pixels[index] - base[0]), Math.abs(pixels[index + 1] - base[1]), Math.abs(pixels[index + 2] - base[2])) > 4) structurePixels++;
      if (previous?.length === pixels.length) {
        const delta = Math.max(Math.abs(pixels[index] - previous[index]), Math.abs(pixels[index + 1] - previous[index + 1]), Math.abs(pixels[index + 2] - previous[index + 2]));
        maximumDelta = Math.max(maximumDelta, delta);
        if (delta > 3) changedPixels++;
        if (delta > 18) strongChangedPixels++;
      }
    }
    captures.set(key, pixels);
    return { width: canvas.width, height: canvas.height, base, structurePixels, changedPixels, strongChangedPixels, maximumDelta };
  }, { encoded: screenshot.toString("base64"), key, bounds, emptyLabel });
}

async function run() {
  if (process.env.OVERVIEW_TEST_ARTIFACT || process.env.OVERVIEW_TEST_ARTIFACT_DIR) {
    throw new Error("OVERVIEW_TEST_ARTIFACT/OVERVIEW_TEST_ARTIFACT_DIR are no longer supported. Set OVERVIEW_TEST_PLUGIN_DIR to a prepared plugin directory, or omit it to test /plugin-source.");
  }
  const expectation = readExpectation(process.env);
  const packageFile = process.env.OVERVIEW_TEST_PACKAGE_FILE;
  assert.ok(packageFile, "Acceptance requires the exact package file for both plugin input origins");
  const packageSha256 = await sha256(packageFile);
  assert.equal(packageSha256, expectation.packageSha256, "Tested package SHA256 differs from the explicit acceptance expectation");
  const { chromium } = require("/fork/node_modules/playwright");
  const { WebSocket } = require("/fork/node_modules/ws");
  const packageRoot = process.env.OVERVIEW_TEST_PACKAGE_ROOT || "/package";
  const preparedPluginDir = process.env.OVERVIEW_TEST_PLUGIN_DIR;
  const output = fs.mkdtempSync("/out/run-");
  const state = path.join(output, "state");
  fs.mkdirSync(state, { mode: 0o700 });
  const listen = `127.0.0.1:${await freePort()}`;
  fs.writeFileSync(path.join(state, "config.json"), JSON.stringify({
    version: 1, daemon: { listen, relay: { enabled: false }, mcp: { enabled: false, injectIntoAgents: false } },
    features: { webUi: { enabled: true }, dictation: { enabled: false }, voiceMode: { enabled: false } }, pluginsEnabled: true,
    agents: { providers: { "overview-test": { extends: "acp", label: "Overview acceptance provider", command: [process.execPath, path.join(__dirname, "provider.mjs")], env: { OVERVIEW_TEST_PROVIDER_LOG: path.join(output, "provider-operations.jsonl") } } } },
  }, null, 2));
  const pluginSource = preparedPluginDir || "/plugin-source";
  assert.ok(fs.existsSync(pluginSource) && fs.statSync(pluginSource).isDirectory(), `Overview plugin source is not a directory: ${pluginSource}`);
  const plugin = readPluginIdentity(pluginSource);
  const identity = {
    origin: preparedPluginDir ? "prepared-plugin-directory" : "source-checkout",
    plugin,
    packageSha256,
  };
  const payload = path.join(output, "overview-payload");
  if (preparedPluginDir) fs.cpSync(pluginSource, payload, { recursive: true });
  else copySourceCheckout(payload);
  const cli = path.join(packageRoot, "opt/Paseo/resources/bin/paseo");
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PASEO_")));
  env.PASEO_HOME = state;
  env.PASEO_LISTEN = listen;
  const daemon = spawn(cli, ["daemon", "run", "--home", state], { env, stdio: ["ignore", "pipe", "pipe"] });
  const log = fs.createWriteStream(path.join(output, "daemon.log"));
  daemon.stdout.pipe(log, { end: false });
  daemon.stderr.pipe(log, { end: false });
  let browser;
  let client;
  let page;
  const pageErrors = [];
  const consoleErrors = [];
  const expectedOfflineErrors = [];
  let expectedOfflineError = null;
  const onRemoteShutdown = remotePort => {
    expectedOfflineError = `WebSocket connection to 'ws://localhost:${remotePort}/ws' failed: Error in connection establishment: net::ERR_CONNECTION_REFUSED`;
  };
  const browserRequests = [];
  const received = [];
  const liveRows = [];
  try {
    await waitFor(async () => {
      if (daemon.exitCode !== null) throw new Error(`Packaged daemon exited with ${daemon.exitCode}`);
      const response = await fetch(`http://${listen}/`);
      return response.status === 200;
    }, "packaged web UI");
    const { DaemonClient } = await import("/fork/packages/client/dist/daemon-client.js");
    client = new DaemonClient({ url: `ws://${listen}/ws`, clientId: "overview-packaged-acceptance", webSocketFactory: (url, options) => new WebSocket(url, options?.protocols, { headers: options?.headers }) });
    await client.connect();
    const status = await client.getDaemonStatus();
    assert.equal(status.version, expectation.runtimeVersion, "Connected daemon version differs from the explicit acceptance expectation");
    const installed = await client.installDirectoryPlugin(payload);
    assert.equal(installed.id, "overview");
    assert.equal(installed.status, "running");
    const catalog = await client.getPluginCatalog();
    assert.ok(catalog.some(plugin => plugin.id === "overview" && plugin.clientBundle));
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.on("pageerror", error => pageErrors.push(error.message));
    page.on("console", message => {
      if (message.type() !== "error") return;
      const text = message.text();
      if (expectedOfflineError !== null && text === expectedOfflineError) expectedOfflineErrors.push(text);
      else consoleErrors.push(text);
    });
    page.on("websocket", socket => {
      console.log(`Browser WebSocket: ${socket.url()}`);
      socket.on("framesent", frame => {
        try { const packet = JSON.parse(String(frame.payload)); browserRequests.push(packet.message?.type ?? packet.type ?? "unknown"); } catch {}
      });
      socket.on("framereceived", frame => {
        const raw = String(frame.payload);
        if (!raw.includes("project.update") && !raw.includes("plugin.rpc.invoke.response") && !raw.includes("project.list.response") && !raw.includes("agent.provider_subagents.snapshot.response")) return;
        try { received.push(JSON.parse(JSON.stringify(JSON.parse(raw), (_, value) => typeof value === "string" && value.length > 220 ? `<${value.length} characters>` : value))); } catch {}
      });
    });
    const rosterRequests = new Map();
    let nativeParent = null;
    const nativeParents = new Map();
    const nativeActivity = new Map();
    let proxiedPages = 0;
    await page.routeWebSocket(() => true, routed => {
      console.log("Intercepting isolated browser WebSocket");
      const upstream = routed.connectToServer();
      routed.onMessage(raw => {
        const packet = JSON.parse(String(raw));
        const message = packet.message || packet;
        if (message.type === "fetch_agents_request" || message.type === "fetch_workspaces_request") {
          message.page = { ...(message.page || {}), limit: 5 };
          proxiedPages++;
        }
        if (message.type === "agent.provider_subagents.snapshot.request") rosterRequests.set(message.requestId, message.parentAgentId);
        upstream.send(JSON.stringify(packet));
      });
      upstream.onMessage(async raw => {
        const packet = JSON.parse(String(raw));
        const message = packet.message || packet;
        if (message.type === "agent_stream") liveRows.push(message);
        if (message.type === "agent.provider_subagents.snapshot.response" && nativeParents.has(rosterRequests.get(message.payload.requestId))) {
          const snapshot = message.payload;
          rosterRequests.delete(message.payload.requestId);
          // The real public per-host passive read executes before this dense fixture is substituted.
          snapshot.subagents = Array.from({ length: nativeParents.get(snapshot.parentAgentId) }, (_, index) => ({
            id: `fixture-native-${String(index).padStart(3, "0")}`, parentAgentId: snapshot.parentAgentId,
            parentSubagentId: null,
            provider: "overview-test", title: `Inspect subsystem ${index + 1}`, description: `Sanitised native child ${index + 1}`,
            status: nativeActivity.get(`${snapshot.parentAgentId}:${index}`) ?? "completed", subtitle: null,
            createdAt: "2026-01-01T00:00:00.000Z", updatedAt: new Date().toISOString(), toolCallId: `fixture-tool-${index}`,
          }));
          await delay(1400);
        }
        try { routed.send(JSON.stringify(packet)); } catch {}
      });
    });
    await page.addInitScript(() => localStorage.setItem("@paseo:onboarding", JSON.stringify({ completedAt: "1970-01-01" })));
    const response = await page.goto(`http://${listen}/`);
    assert.equal(response.status(), 200);
    assert.equal(await page.evaluate(() => typeof window.paseoDesktop), "undefined");
    assert.equal(await page.evaluate(() => window.__PASEO_INITIAL_DAEMON_CONNECTION__?.listen), listen);
    await page.getByRole("button", { name: "Overview", exact: true }).click();
    await page.getByTestId("overview-screen").waitFor({ state: "visible" });
    await page.getByTestId("overview-canvas-host").locator("canvas").waitFor({ state: "visible" });
    for (const control of ["overview-host-filter", "overview-project-filter", "overview-motion", "overview-appearance", "overview-fullscreen"]) {
      assert.ok(await page.getByTestId(control).locator("svg").count() > 0, `${control} renders its public host icon`);
    }
    const overviewUrl = page.url();
    await waitFor(async () => await page.locator('[data-overview-kind="project"]').count() === 0, "empty initial project graph");
    await page.screenshot({ path: path.join(output, "empty.png") });
    await delay(250);
    const gridLight = await packagedGridPixels(page, "motion");
    await delay(600);
    const gridMoved = await packagedGridPixels(page, "motion");
    assert.ok(gridLight.structurePixels > 800, "Prepared plugin renders visible grid structure in the empty graph");
    // Sparse ambient transit is decorative; real activity feeds are covered by
    // the event-driven fixture. Neither requires invented cloud activity here.
    assert.ok(gridMoved.structurePixels > 800, "Empty room remains covered during ambient transit");
    await page.emulateMedia({ colorScheme: "dark" });
    await delay(250);
    const gridDark = await packagedGridPixels(page, "dark");
    assert.ok(gridDark.structurePixels > 800, "Prepared plugin retains visible structure in dark theme");
    assert.ok(Math.abs(gridDark.base.reduce((sum, value) => sum + value, 0) - gridLight.base.reduce((sum, value) => sum + value, 0)) > 90,
      "Application theme changes reach the packaged graph surface");
    await page.getByTestId("overview-motion").click();
    await delay(100);
    await packagedGridPixels(page, "paused");
    await delay(350);
    const gridPaused = await packagedGridPixels(page, "paused");
    assert.ok(gridPaused.changedPixels <= 20, "Pausing motion freezes the compiled background");
    await page.getByTestId("overview-motion").click();
    await page.emulateMedia({ colorScheme: "light" });
    await delay(100);
    const packagedGrid = { light: gridLight, moved: gridMoved, dark: gridDark, paused: gridPaused };
    await page.evaluate(() => { delete window.overviewAcceptancePixels; });
    await page.getByTestId("overview-appearance").click();
    await page.getByTestId("overview-theme-dark").click();
    await waitFor(async () => {
      const value = await page.getByTestId("overview-screen").evaluate(element => getComputedStyle(element).backgroundColor);
      return value === "rgb(11, 17, 24)";
    }, "Overview-only dark override");
    await page.getByTestId("overview-background-off").click();
    await page.getByTestId("overview-appearance").click();
    await delay(150);
    const off = await packagedGridPixels(page, "off");
    assert.ok(off.structurePixels < 50, "Background Off removes the room without removing the canvas");
    await page.getByTestId("overview-appearance").click();
    await page.getByTestId("overview-theme-light").click();
    await waitFor(async () => (await page.getByTestId("overview-screen").evaluate(element => getComputedStyle(element).backgroundColor)) === "rgb(245, 248, 251)", "Overview-only light override");
    await page.getByTestId("overview-background-static").click();
    await page.getByTestId("overview-appearance").click();
    await delay(150);
    await packagedGridPixels(page, "static");
    await delay(300);
    assert.ok((await packagedGridPixels(page, "static")).changedPixels <= 20, "Static preference freezes the background with graph motion enabled");
    await page.getByTestId("overview-appearance").click();
    await page.getByTestId("overview-theme-paseo").click();
    await page.getByTestId("overview-background-animated").click();
    await page.getByTestId("overview-appearance").click();
    console.log(`Packaged fixture ready at ${output}`);
    const requestsBeforeFixtures = browserRequests.length;
    const projectNames = ["Projects", "public", "private", "private-web", "private-infra", "private-dev", "public-dev"];
    const workspaceCounts = [4, 0, 0, 3, 2, 4, 1];
    const directories = [];
    const projectIds = [];
    for (let index = 0; index < projectNames.length; index++) {
      const directory = path.join(output, `project-${index}`);
      fs.mkdirSync(directory);
      fs.writeFileSync(path.join(directory, "README.md"), "Sanitised Overview acceptance project\n");
      const result = await client.addProject(directory);
      assert.equal(result.error, null);
      assert.ok(result.project);
      const projectId = result.project.projectId;
      await client.renameProject(projectId, projectNames[index]);
      directories.push(directory); projectIds.push(projectId);
    }
    await waitFor(async () => await page.locator('[data-overview-kind="project"]').count() === 7, "seven live empty project roots");
    const workspaces = [];
    for (let project = 0; project < workspaceCounts.length; project++) for (let item = 0; item < workspaceCounts[project]; item++) {
      const created = await client.createWorkspace({ source: { kind: "directory", path: directories[project] }, title: `Workspace ${workspaces.length + 1} — ${projectNames[project]} maintenance` });
      const workspaceId = created.workspaceId ?? created.workspace?.id;
      assert.ok(workspaceId);
      workspaces.push({ workspaceId, project, directory: directories[project] });
    }
    // Exercise the angular orientation that failed in the live graph: the dense
    // branch belongs to the final workspace in its project's stable ID order.
    const denseWorkspace = workspaces.filter(workspace => workspace.project === 0)
      .sort((a, b) => a.workspaceId.localeCompare(b.workspaceId)).at(-1);
    assert.ok(denseWorkspace);
    const agentWorkspaces = [denseWorkspace, ...workspaces.filter(workspace => workspace !== denseWorkspace)];
    const agents = [];
    for (let index = 0; index < agentWorkspaces.length; index++) {
      const workspace = agentWorkspaces[index];
      const count = index === 0 ? 4 : index === 1 ? 2 : 1;
      for (let item = 0; item < count; item++) {
        const agent = await client.createAgent({ provider: "overview-test", cwd: workspace.directory, workspaceId: workspace.workspaceId, title: `Acceptance agent ${index + 1}.${item + 1}${index === 0 && item === 0 ? " — Review the complete ownership tree, workspace layout, delegation routes and passive observations across multiple concurrent projects. ".repeat(3) : ""}`.slice(0,200) });
        agents.push(agent);
      }
    }
    const denseParents = agents.slice(0, 4).sort((a, b) => a.id.localeCompare(b.id));
    nativeParent = denseParents[0].id;
    // The deployed roster exposed a flat 37-child branch with 36 quiet children.
    // Expanding it used to put the parent's collapse button over outgoing rays.
    // Synthetic identities preserve that density without retaining private data.
    for (const [parent,count] of [[denseParents[0],37],[denseParents[1],8],[denseParents[2],3],[agents[13],4]]) nativeParents.set(parent.id,count);
    nativeActivity.set(`${nativeParent}:36`, "running");
    nativeActivity.set(`${denseParents[1].id}:0`, "running");
    nativeActivity.set(`${denseParents[1].id}:1`, "failed");
    nativeActivity.set(`${denseParents[2].id}:0`, "running");
    const nativeFixtureCount = [...nativeParents.values()].reduce((sum, count) => sum + count, 0);
    console.log("Created 7 projects, 14 workspaces and 18 managed agents");
    const operations = () => {
      const logPath = path.join(output, "provider-operations.jsonl");
      return fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line).operation) : [];
    };
    await waitFor(() => operations().filter(op => op === "newSession").length >= 18, "fixture provider creation completed");
    // ACP capability probes also create short-lived sessions during fixture creation.
    await delay(2000);
    const baselineWakeups = operations().filter(op => ["newSession", "loadSession"].includes(op));
    // A fresh open starts empty and receives real five-item pages plus a delayed native snapshot.
    await page.reload();
    await page.getByTestId("overview-screen").waitFor({ state: "visible" });
    await waitFor(async () => await page.locator('[data-overview-kind="project"]').count() === 7, "all project roots after cold reload");
    await waitFor(async () => await page.locator('[data-overview-kind="workspace"]').count() === 14, "all paginated workspaces");
    await waitFor(async () => await page.locator('[data-overview-kind="agent"]').count() === 18, "all paginated managed agents");
    await waitFor(async () => await page.locator('[data-overview-kind="provider-subagent"]').count() >= 3, "delayed native branch");
    await waitFor(async () => await page.locator('[data-overview-kind]').evaluateAll(nodes => new Set(nodes.flatMap(node => node.dataset.overviewKind === "provider-subagent" ? [node.dataset.overviewId]
      : node.dataset.overviewKind === "completed-group" ? JSON.parse(node.dataset.overviewMembers || "[]") : [])).size) === nativeFixtureCount, "every delayed native fixture member");
    console.log("Cold paginated load and delayed native snapshot rendered");
    const geometry = await page.getByTestId("overview-canvas-host").evaluate(host => {
      const rect = element => { const box = element.getBoundingClientRect(); return {x:box.x,y:box.y,width:box.width,height:box.height}; };
      return { host:rect(host), nodes:[...host.querySelectorAll('[data-overview-kind]')].map(element => ({ id:element.dataset.overviewId, kind:element.dataset.overviewKind,members:JSON.parse(element.dataset.overviewMembers||"[]"), box:rect(element) })) };
    });
    assert.ok(new Set(geometry.nodes.filter(node => node.kind === "project").map(node => Math.round(node.box.x))).size > 1, "Cold loaded graph must not retain a single column");
    const representedNative=geometry.nodes.flatMap(node=>node.kind==='provider-subagent'?[node.id]:node.kind==='completed-group'?node.members:[]);
    assert.equal(new Set(representedNative).size,nativeFixtureCount,"Native fixture members remain represented exactly once");
    await page.screenshot({ path: path.join(output, "full.png") });
    const projectDisplayIds = projectIds.map(id => geometry.nodes.find(node => node.kind === "project" && node.id.endsWith(`:project:${encodeURIComponent(id)}`)).id);
    const filterOption = id => page.getByTestId(`overview-project-filter-option-${id}`);
    await page.getByTestId("overview-project-filter").click();
    await filterOption(projectDisplayIds[0]).click();
    assert.equal(await page.locator('[data-overview-kind="project"]').count(), 7, "Draft changes do not touch the graph");
    await page.getByTestId("overview-project-filter-cancel").click();
    assert.equal(await page.locator('[data-overview-kind="project"]').count(), 7);
    await page.getByTestId("overview-project-filter").click();
    await page.getByTestId("overview-project-filter-search").fill("private");
    assert.equal(await page.locator('[data-testid^="overview-project-filter-option-"]').count(), 4, "Search uses the complete catalogue");
    await page.getByTestId("overview-project-filter-search").fill("");
    for (const index of [1, 2, 4, 5]) await filterOption(projectDisplayIds[index]).click();
    await page.getByTestId("overview-project-filter-apply").click();
    await waitFor(async () => await page.locator('[data-overview-kind="project"]').count() === 3, "three selected project graphs");
    assert.match(await page.getByTestId("overview-scope-counts").innerText(), /3 of 7 projects/);
    await page.getByTestId("overview-project-filter").click();
    assert.equal(await page.locator('[data-testid^="overview-project-filter-option-"]').count(), 7, "Excluded projects stay available");
    await filterOption(projectDisplayIds[0]).click();
    await page.keyboard.press("Escape");
    assert.equal(await page.locator('[data-overview-kind="project"]').count(), 3, "Escape discards the draft");
    await page.screenshot({ path: path.join(output, "filtered-three.png") });
    await page.locator(`[data-overview-id="${projectDisplayIds[0]}"]`).click();
    await page.getByTestId("overview-back").click();
    assert.equal(await page.locator('[data-overview-kind="project"]').count(), 3, "Back stays within the filter");
    await page.getByTestId("overview-project-filter").click();
    for (const index of [0, 3, 6]) await filterOption(projectDisplayIds[index]).click();
    await page.getByTestId("overview-project-filter-apply").click();
    await waitFor(async () => await page.locator('[data-overview-id]').count() === 0, "explicit empty selection");
    await page.getByText("No projects selected", { exact: true }).waitFor({ state: "visible" });
    await page.getByTestId("overview-no-projects-show-all").click();
    await waitFor(async () => await page.locator('[data-overview-kind="project"]').count() === 7, "Show all restores the catalogue");
    const projectRoot = page.locator('[data-overview-kind="project"][aria-label^="Projects,"]');
    await projectRoot.click();
    await delay(500);
    const groupsBeforeFocus = await page.locator('[data-overview-kind="completed-group"]').count();
    assert.ok(groupsBeforeFocus > 0, "Focus preserves explicit inactive groups");
    const denseGroup = geometry.nodes.find(node => node.kind === "completed-group" && node.members.length === 36);
    assert.ok(denseGroup, "The actual-density 36-inactive branch starts collapsed");
    const inactive = page.locator(`[data-overview-id="${denseGroup.id}"]`);
    const members = JSON.parse(await inactive.getAttribute("data-overview-members"));
    await inactive.click();
    const allExpanded = async () => {
      const visible = new Set(await page.locator('[data-overview-id]').evaluateAll(nodes => nodes.map(node => node.dataset.overviewId)));
      return members.every(id => visible.has(id));
    };
    assert.deepEqual(pageErrors, [], "Dense expansion must not throw a layout error");
    await waitFor(allExpanded, "all 36 inactive members expand explicitly");
    const collapse = page.locator(`[data-overview-collapse="${denseGroup.id}"]`);
    assert.equal(await collapse.count(), 1, "Expanded dense group has its own collapse control");
    await collapse.click();
    await waitFor(async () => await inactive.count() === 1, "explicit dense-group collapse");
    await inactive.click();
    await waitFor(allExpanded, "repeat dense expansion preserves every member");
    assert.deepEqual(pageErrors, [], "Repeated dense expansion remains valid");
    await page.screenshot({ path: path.join(output, "project-focus.png") });
    const workspaceRoot = page.locator(`[data-overview-kind="workspace"][data-overview-id$=":${encodeURIComponent(denseWorkspace.workspaceId)}"]`);
    await workspaceRoot.click();
    await delay(500);
    await page.screenshot({ path: path.join(output, "workspace-focus.png") });
    const node = page.locator(`[data-overview-kind="agent"][data-overview-id$=":${encodeURIComponent(agents[0].id)}"]`);
    const canvasBeforeSelection = await page.getByTestId("overview-canvas-host").boundingBox();
    await node.click();
    await page.getByTestId("overview-selection").waitFor({ state: "visible" });
    assert.deepEqual(await page.getByTestId("overview-canvas-host").boundingBox(), canvasBeforeSelection, "Details float without shrinking the graph");
    assert.ok(await node.getAttribute("data-overview-avatar"), "Emoji is the agent node glyph");
    assert.equal(await node.getAttribute("data-overview-role"), "agent");
    const child = page.locator(`[data-overview-kind="provider-subagent"][data-overview-workspace$=":${encodeURIComponent(denseWorkspace.workspaceId)}"]`).first();
    assert.equal(await child.getAttribute("data-overview-role"), "subagent");
    // A floating card may legitimately cover a nearby child in a dense graph.
    // Dismiss it through the real control before inspecting another node.
    await page.getByTestId("overview-details-close").click();
    await child.click();
    const childId = await child.getAttribute("data-overview-id");
    const fullscreenButton = page.getByTestId("overview-fullscreen");
    await fullscreenButton.waitFor({ state: "visible" });
    const scopeBeforeFullscreen = await page.getByTestId("overview-scope-title").innerText();
    await page.getByTestId("overview-canvas-host").locator("canvas").evaluate(canvas => { window.acceptanceCanvas = canvas; });
    for (const exitMethod of ["button", "Escape"]) {
      await fullscreenButton.click();
      await waitFor(() => page.evaluate(() => document.fullscreenElement?.getAttribute("data-testid") === "overview-screen"), "real element fullscreen");
      await page.getByRole("button", { name: "Exit fullscreen", exact: true }).waitFor({ state: "visible" });
      assert.equal(await page.getByTestId("overview-details-popover").evaluate(card => document.fullscreenElement.contains(card)), true);
      assert.equal(await page.getByTestId("overview-header").evaluate(header => document.fullscreenElement.contains(header)), true);
      assert.equal(await page.getByTestId("overview-canvas-host").locator("canvas").evaluate(canvas => canvas === window.acceptanceCanvas), true, "Fullscreen preserves the renderer instance");
      if (exitMethod === "button") await fullscreenButton.click();
      else await child.press("Escape");
      await waitFor(() => page.evaluate(() => document.fullscreenElement === null), "fullscreen exit");
      assert.equal(await child.getAttribute("aria-pressed"), "true", "Fullscreen Escape preserves selection");
      assert.equal(await page.getByTestId("overview-scope-title").innerText(), scopeBeforeFullscreen);
      assert.equal(await collapse.count(), 1, "Fullscreen preserves expanded groups");
    }
    const ids = () => page.locator('[data-overview-id]').evaluateAll(nodes => nodes.map(node => node.dataset.overviewId).sort());
    const knownBefore = await ids();
    const childrenBefore = await page.locator('[data-overview-kind="provider-subagent"]').count();
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await delay(80);
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await delay(500);
    assert.deepEqual(await ids(), knownBefore, "Refresh retains every node while delayed native rosters are pending");
    assert.equal(await page.locator('[data-overview-kind="provider-subagent"]').count(), childrenBefore);
    assert.equal(await page.locator(`[data-overview-id="${childId}"]`).getAttribute("aria-pressed"), "true", "Selected child survives refresh");
    await delay(1600);
    assert.deepEqual(await ids(), knownBefore, "Coherent refreshed roster preserves group choices");
    await page.screenshot({ path: path.join(output, "selected.png") });
    await page.getByTestId("overview-motion").click();
    await delay(100);
    await node.press("Escape");
    await page.getByTestId("overview-selection").waitFor({ state: "hidden" });
    // Details dismissal leaves logical viewport dimensions unchanged.
    await delay(100);
    const emptyProject = page.locator('[data-overview-kind="project"][aria-label^="public,"]');
    const emptyProjectId = await emptyProject.getAttribute("data-overview-id");
    const iconRoot = page.locator(`[data-overview-kind="project"][data-overview-id="${emptyProjectId}"]`);
    const iconBefore = await iconRoot.boundingBox();
    const iconData = await page.evaluate(() => {
      const canvas=document.createElement("canvas");canvas.width=64;canvas.height=64;
      const context=canvas.getContext("2d");context.fillStyle="#4d78c8";context.fillRect(0,0,64,64);context.fillStyle="#fff";context.font="bold 44px sans-serif";context.textAlign="center";context.fillText("O",32,48);
      return canvas.toDataURL("image/png").split(",")[1];
    });
    await client.setProjectIcon(projectIds[1], {type:"upload",data:iconData});
    await client.renameProject(projectIds[1], "Public renamed");
    await waitFor(async () => (await iconRoot.locator("img").getAttribute("src"))?.startsWith("data:image/png"), "empty project live icon");
    await waitFor(async () => (await iconRoot.innerText()).includes("Public renamed"), "live project rename");
    const iconAfter = await iconRoot.boundingBox();
    fs.writeFileSync(path.join(output,"icon-positions.json"),JSON.stringify({before:iconBefore,after:iconAfter},null,2));
    assert.ok(Math.abs(iconBefore.x-iconAfter.x)<1 && Math.abs(iconBefore.y-iconAfter.y)<1, "Icon/rename preserves root position");
    await page.screenshot({path:path.join(output,"icon.png")});
    const extraDirectory=path.join(output,"eighth-project");fs.mkdirSync(extraDirectory);
    const extra=await client.addProject(extraDirectory);
    await waitFor(async()=>await page.locator('[data-overview-kind="project"]').count()===8,"dynamic eighth project");
    await client.removeProject(extra.project.projectId);
    await waitFor(async()=>await page.locator('[data-overview-kind="project"]').count()===7,"project removal");
    assert.deepEqual(operations().filter(op=>["newSession","loadSession"].includes(op)),baselineWakeups,"Overview opening/focus/icon changes cause no provider create/load calls");
    await page.getByTestId("overview-motion").click();
    await client.sendAgentMessage(agents[0].id,"Run the deterministic acceptance stream.");
    await delay(400);
    await page.screenshot({path:path.join(output,"activity.png")});
    // Let the previous terminal bubble's established six-second priority window
    // expire before verifying a new lower-priority streaming preview.
    await delay(8200);
    await workspaceRoot.click();
    const fragmentedPrompt = client.sendAgentMessage(agents[0].id, "Run the fragmented preview check.");
    await waitFor(async () => await page.locator('[data-overview-bubble]').filter({ hasText: /The tests have passed|I am checking the next operation/ }).count() > 0, "readable additive streaming preview");
    const fragmentedPreview = await page.locator('[data-overview-bubble]').filter({ hasText: /The tests have passed|I am checking the next operation/ }).first().innerText();
    assert.ok(!/^Assistant response\s+\S+\s*$/.test(fragmentedPreview), "Token fragments do not replace readable text");
    // A formatting-only line follows the prose while the turn is still running.
    // Inspect the intermediate rendered bubbles, not just the terminal excerpt.
    for (let sample = 0; sample < 16; sample++) {
      await delay(150);
      const previews = await page.locator('[data-overview-bubble]').allInnerTexts();
      assert.ok(previews.every(text => !/Assistant update\s+---\s*$/.test(text)), "Markdown separators do not replace readable previews");
    }
    await fragmentedPrompt;
    await delay(2800);
    const overviewRequests=browserRequests.slice(requestsBeforeFixtures);
    const forbidden=overviewRequests.filter(type=>/^(?:create_agent_request|agent\.create\.request|send_agent_message_request|agent\.message\.send\.request|agent\.stop\.request|stop_agent_request|archive_agent_request|agent\.archive\.request|workspace\.clear_attention\.request|agent\.clear_attention\.request|permission_response)$/.test(type));
    assert.deepEqual(forbidden,[],"Observing Overview must not send mutation operations");
    assert.ok(!overviewRequests.includes("agent.provider_subagents.list.request"));
    assert.ok(!overviewRequests.includes("fetch_agent_timeline_request"));
    assert.ok(proxiedPages>6,"Acceptance exercised real daemon pagination");
    assert.deepEqual(pageErrors,[]);assert.deepEqual(consoleErrors,[]);
    assert.equal(await page.getByText(/Showing the simple view/).count(),0);
    await page.locator('[data-overview-kind="agent"][aria-label^="Acceptance agent 1.1"]').click();
    await page.getByTestId("overview-selection").waitFor({state:"visible"});
    await page.setViewportSize({width:1440,height:440});
    await delay(300);
    const inspector=page.getByTestId("overview-selection");
    const cardBox = await page.getByTestId("overview-details-popover").boundingBox();
    const graphBox = await page.getByTestId("overview-canvas-host").boundingBox();
    assert.ok(cardBox.y >= graphBox.y && cardBox.y + cardBox.height <= graphBox.y + graphBox.height + 1, "Details card stays within a short viewport");
    await page.screenshot({path:path.join(output,"inspector-scroll.png")});
    // Navigation is an explicit user action, outside the passive observation assertions above.
    await fullscreenButton.click();
    await waitFor(() => page.evaluate(() => !!document.fullscreenElement), "fullscreen for navigation check");
    await inspector.getByRole("button",{name:"Open chat →",exact:true}).click();
    await page.waitForURL(/\/workspace\//);
    await waitFor(() => page.evaluate(() => document.fullscreenElement === null), "Open chat leaves Overview fullscreen");
    await page.setViewportSize({width:1440,height:1000});
    await page.getByRole("button",{name:"Overview",exact:true}).click();
    await waitFor(async()=>await page.locator('[data-overview-kind="project"]').count()===7,"remount after explicit chat navigation");
    if (expectation.chatPreviewSettings === "required") {
      // Isolated browser preferences only. Overview never imports the chat hook.
      const previewSetting = async enabled => {
        await page.evaluate(value => {
          const key = "@paseo:app-settings";
          const settings = JSON.parse(localStorage.getItem(key) || "{}");
          settings.assistantMessagePreview = { enabled: value, characterLimit: 1200 };
          localStorage.setItem(key, JSON.stringify(settings));
        }, enabled);
        await page.reload();
      };
      await previewSetting(false);
      await waitFor(async () => await page.locator('[data-overview-kind="agent"]').count() === 18, "Overview after isolated chat setting change");
      await workspaceRoot.click();
      await delay(400);
      await client.sendAgentMessage(agents[0].id,"Run the long preview independence check.");
      await waitFor(async () => await page.locator('[data-overview-bubble]').filter({hasText:"Bounded Overview"}).count() > 0, "bounded live long response preview");
      const preview = page.locator('[data-overview-bubble]').filter({hasText:"Bounded Overview"}).first();
      const previewText = await preview.innerText();
      assert.ok(previewText.length < 320 && previewText.includes("…"), "Disabled chat truncation cannot enlarge Overview's bounded preview");
      await delay(2200);
      await page.locator('[data-overview-kind="agent"][aria-label^="Acceptance agent 1.1"]').click();
      await page.getByTestId("overview-open-chat").click();
      await page.waitForURL(/\/workspace\//);
      await waitFor(async () => (await page.locator("body").innerText()).includes("ACCEPTANCE_RESPONSE_END"), "disabled chat preview shows complete response");
      assert.equal(await page.getByText("Show full response",{exact:true}).count(),0);
      await previewSetting(true);
      await page.getByText("Show full response",{exact:true}).waitFor({state:"visible"});
      await page.getByText("Show full response",{exact:true}).click();
      await waitFor(async () => (await page.locator("body").innerText()).includes("ACCEPTANCE_RESPONSE_END"), "one-way chat expansion still works");
      assert.equal(await page.getByText("Show less",{exact:true}).count(),0);
    }
    const multipleHosts = await checkMultipleHosts({ page, cli, env, output, overviewUrl, directory: directories[0], freePort, waitFor, DaemonClient, WebSocket, runtimeVersion: status.version, expectedOfflineErrors, onRemoteShutdown });
    fs.writeFileSync(path.join(output, "multi-host.json"), JSON.stringify(multipleHosts, null, 2));
    assert.deepEqual(pageErrors,[]);
    assert.deepEqual(consoleErrors,[]);
    const result={ok:true,...identity,expectation,runtimeVersion:status.version,packagedGrid,multipleHosts,expectedOfflineErrors,projectCount:7,workspaceCount:14,managedCount:18,nativeFixtureCount,nativeRosterSource:"sanitised delayed transport fixture after real passive RPC",proxiedPages,geometry,consoleErrors,pageErrors,overviewRequestTypes:[...new Set(overviewRequests)],checks:["two exact hosts without remote Overview installation", "host/project filters and correct-host chat", "project checkbox draft Apply/Cancel/Escape and selected-set framing", "explicit empty selection and Show all", "offline-host isolation without provider wakeups", "exact packaged daemon","compiled grid visible in both themes","compiled perspective room coverage","compiled grid pause","persisted quick theme and background modes","real plugin compiler","served browser UI","cold multi-project load","real five-item directory pagination","delayed native branch fixture","all projects including empty","project/workspace focus","selection/Escape","empty project live icon and rename without movement","dynamic project add/remove","zero provider wakeups","live activity","readable additive streaming","real element fullscreen and state preservation","fullscreen navigation exit","no Overview mutations","bounded floating details card", "stable tab restore with delayed rosters", "explicit inactive groups", "36-member dense group expand/collapse/re-expand", "stable emoji roles", "unchanged graph dimensions on selection","explicit Open chat navigation","Overview remount after chat", ...(expectation.chatPreviewSettings === "required" ? ["bounded Overview previews independent of chat preferences", "stock chat preview disable/enable and one-way expansion"] : [])]};
    fs.writeFileSync(path.join(output, "results.json"), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ ok: true, output, runtimeVersion: status.version, origin: identity.origin }));
  } catch (error) {
    if (page) {
      await page.screenshot({ path: path.join(output, "failure.png") }).catch(() => {});
      fs.writeFileSync(path.join(output, "page.txt"), await page.locator("body").innerText().catch(() => ""));
    }
    fs.writeFileSync(path.join(output, "failure.json"), JSON.stringify({ message: error.message, pageErrors, consoleErrors, expectedOfflineErrors, requestTypes: [...new Set(browserRequests)] }, null, 2));
    fs.writeFileSync(path.join(output, "received.json"), JSON.stringify(received, null, 2));
    fs.writeFileSync(path.join(output, "live-rows.json"), JSON.stringify(liveRows, null, 2));
    console.error(`Acceptance failed. Artifacts: ${output}`);
    throw error;
  } finally {
    await browser?.close().catch(() => {});
    await client?.close().catch(() => {});
    daemon.kill("SIGTERM");
    await Promise.race([new Promise(resolve => daemon.once("exit", resolve)), delay(10_000)]);
    if (daemon.exitCode === null) daemon.kill("SIGKILL");
    log.end();
  }
}

module.exports = { readExpectation };
if (require.main === module) run().catch(error => { console.error(error.stack || error); process.exitCode = 1; });

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");

/** Exercise borrowed host APIs with the plugin installed only on the first host. */
async function checkMultipleHosts({ page, cli, env, output, overviewUrl, directory, freePort, waitFor, DaemonClient, WebSocket, runtimeVersion, expectedOfflineErrors, onRemoteShutdown }) {
  const home = path.join(output, "remote-state");
  fs.mkdirSync(home, { mode: 0o700 });
  const listen = `127.0.0.1:${await freePort()}`;
  const remotePort = new URL(`http://${listen}`).port;
  const providerLog = path.join(output, "remote-provider-operations.jsonl");
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({
    version: 1, daemon: { listen, cors: { allowedOrigins: [new URL(overviewUrl).origin] },
      relay: { enabled: false }, mcp: { enabled: false, injectIntoAgents: false } },
    features: { webUi: { enabled: true }, dictation: { enabled: false }, voiceMode: { enabled: false } }, pluginsEnabled: true,
    agents: { providers: { "overview-test": { extends: "acp", label: "Overview acceptance provider", command: [process.execPath, path.join(__dirname, "provider.mjs")], env: { OVERVIEW_TEST_PROVIDER_LOG: providerLog } } } },
  }));
  const daemon = spawn(cli, ["daemon", "run", "--home", home], { env: { ...env, PASEO_HOME: home, PASEO_LISTEN: listen }, stdio: ["ignore", "pipe", "pipe"] });
  const log = fs.createWriteStream(path.join(output, "remote-daemon.log"));
  daemon.stdout.pipe(log, { end: false }); daemon.stderr.pipe(log, { end: false });
  let client, stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await client?.close().catch(() => {});
    const exited = new Promise(resolve => daemon.once("exit", resolve));
    daemon.kill("SIGTERM");
    if (daemon.exitCode === null) await Promise.race([exited, delay(5000)]);
    if (daemon.exitCode === null) daemon.kill("SIGKILL");
    log.end();
  };
  try {
    await waitFor(async () => (await fetch(`http://${listen}/`)).ok, "second isolated host");
    client = new DaemonClient({ url: `ws://${listen}/ws`, clientId: "overview-remote-acceptance", webSocketFactory: (url, options) => new WebSocket(url, options?.protocols, { headers: options?.headers }) });
    await client.connect();
    assert.equal((await client.getDaemonStatus()).version, runtimeVersion);
    const serverId = client.getLastServerInfoMessage().serverId;
    assert.ok(serverId);
    assert.equal((await client.getPluginCatalog()).some(plugin => plugin.id === "overview"), false);
    // The same directory deliberately yields an overlapping host-local project ID.
    const project = (await client.addProject(directory)).project;
    assert.ok(project);
    await client.renameProject(project.projectId, "Remote acceptance project");
    const workspace = await client.createWorkspace({ source: { kind: "directory", path: directory }, title: "Remote acceptance workspace" });
    const agent = await client.createAgent({ provider: "overview-test", cwd: directory, workspaceId: workspace.workspaceId ?? workspace.workspace?.id, title: "Remote acceptance agent" });
    const wakeups = () => fs.existsSync(providerLog) ? fs.readFileSync(providerLog, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line).operation).filter(operation => operation === "newSession" || operation === "loadSession") : [];
    await waitFor(() => wakeups().includes("newSession"), "remote fixture provider creation");
    await delay(1000);
    const baselineWakeups = wakeups();
    await page.goto(overviewUrl);
    await page.getByTestId("overview-screen").waitFor({ state: "visible" });
    await page.evaluate(({ serverId, listen }) => {
      const key = "@paseo:daemon-registry";
      const entries = JSON.parse(localStorage.getItem(key) || "[]").filter(entry => entry.serverId !== serverId);
      entries.push({ serverId, label: "Remote acceptance", connections: [{ type: "directTcp", endpoint: listen, useTls: false }] });
      localStorage.setItem(key, JSON.stringify(entries));
    }, { serverId, listen });
    await page.reload();
    await waitFor(async () => await page.locator('[data-overview-kind="project"]').count() === 8, "two actual host directories in Overview");
    const displayId = `${encodeURIComponent(serverId)}:project:${encodeURIComponent(project.projectId)}`;
    const remoteAgentId = `${encodeURIComponent(serverId)}:agent:${encodeURIComponent(agent.id)}`;
    const remoteAgent = page.locator(`[data-overview-id="${remoteAgentId}"]`);
    await remoteAgent.waitFor({ state: "visible" });
    assert.deepEqual(wakeups(), baselineWakeups, "Observing a remote host does not start its provider");
    const wasMoving = await page.getByTestId("overview-motion").getAttribute("aria-label") === "Pause animation";
    if (wasMoving) await page.getByTestId("overview-motion").click();
    const canvas = await page.getByTestId("overview-canvas-host").boundingBox();
    await page.getByTestId("overview-host-filter").click();
    assert.deepEqual(await page.getByTestId("overview-canvas-host").boundingBox(), canvas, "Host menu overlays the graph");
    await page.getByTestId(`overview-host-option-${serverId}`).click();
    await waitFor(async () => await page.locator('[data-overview-kind="project"]').count() === 1, "remote host filter");
    const displayedGeometry = () => page.locator('[data-overview-kind]').evaluateAll(nodes => nodes.map(node => {
      const box = node.getBoundingClientRect();
      return { id: node.dataset.overviewId, x: box.x, y: box.y, width: box.width, height: box.height };
    }).sort((a, b) => a.id.localeCompare(b.id)));
    await delay(150);
    const hostFit = await displayedGeometry();
    await page.getByTestId("overview-project-filter").click();
    assert.equal(await page.getByTestId(`overview-project-filter-option-${displayId}`).getAttribute("aria-checked"), "true");
    // Switching automatic All to an explicit one-project set forces a fit
    // without recreating the cluster or changing its paused depth state.
    await page.getByTestId(`overview-project-filter-option-${displayId}`).click();
    await page.getByTestId(`overview-project-filter-option-${displayId}`).click();
    await page.getByTestId("overview-project-filter-apply").click();
    await waitFor(async () => await page.locator('[data-overview-kind]').count() === hostFit.length, "explicit remote project fit");
    await delay(150);
    const explicitFit = await displayedGeometry();
    assert.deepEqual(hostFit.map(node => node.id), explicitFit.map(node => node.id));
    for (let index = 0; index < hostFit.length; index++) for (const key of ["x", "y", "width", "height"])
      assert.ok(Math.abs(hostFit[index][key] - explicitFit[index][key]) < 0.5, "Host narrowing fits the settled catalogue, matching explicit project Apply");
    if (wasMoving) await page.getByTestId("overview-motion").click();
    await remoteAgent.click();
    await page.getByTestId("overview-open-chat").click();
    await page.waitForURL(url => url.pathname.includes(`/h/${serverId}/`) && url.pathname.includes("/workspace/"));
    await page.goto(overviewUrl);
    await page.getByTestId("overview-host-filter").click();
    await page.getByTestId("overview-host-option-all").click();
    await waitFor(async () => await page.locator('[data-overview-kind="project"]').count() === 8, "All hosts restored");
    onRemoteShutdown(remotePort);
    await stop();
    await waitFor(async () => (await page.getByTestId("overview-host-filter").getAttribute("aria-label"))?.includes("offline") || (await page.locator("body").innerText()).toLowerCase().includes("offline"), "remote offline indicator");
    assert.equal(await page.locator('[data-overview-kind="project"]').count(), 8, "Disconnected host retains its known graph");
    await page.screenshot({ path: path.join(output, "two-hosts-offline.png") });
    return { ok: true, pluginInstalledOnRemote: false, projectCount: 8, remoteChatHost: serverId, passiveRemoteObservation: true, hostFilterRefit: true, expectedOfflineErrors };
  } finally { await stop(); }
}

module.exports = { checkMultipleHosts };

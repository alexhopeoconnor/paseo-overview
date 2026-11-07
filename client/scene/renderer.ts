import * as THREE from "three";
import type { OverviewEvent, OverviewModel, OverviewNode, OverviewState } from "../../shared/model";
import type { OverviewMountOptions, OverviewRenderer, OverviewTheme } from "../../shared/renderer";
import { ActivityTracker, heartbeatBpm, normaliseActivity, PulseLimiter } from "../activity";
import { BubbleStore } from "../bubbles";
import { BACKGROUND_GROUP, groupForNode, StableLayout, type WorkspaceLayout } from "../layout";
import { GraphOverlay } from "./overlay";

interface NodeVisual {
  mesh: THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial>;
  halo: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  phase: number;
}
interface Cluster {
  layout: WorkspaceLayout;
  group: THREE.Group;
  root: THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial>;
  halo: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  nodes: Map<string, NodeVisual>;
  lines: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>[];
  signature: string;
  phase: number;
  opacity: number;
  intensity: number;
}
interface Delegation {
  source: string;
  target: string;
  line: THREE.Line<THREE.BufferGeometry, THREE.LineDashedMaterial>;
}
interface TravellingPulse {
  mesh: THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial>;
  path: string[];
  started: number;
  duration: number;
  workspaceId: string;
}

function colourFor(state: OverviewState, attention: boolean, theme: OverviewTheme): string {
  if (state === "error") return theme.error;
  if (attention || state === "waiting") return theme.waiting;
  if (state === "working") return theme.working;
  if (state === "finished") return theme.accent;
  return theme.muted;
}

function initialPhase(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return (hash >>> 0) / 0xffffffff;
}

function heartbeat(phase: number): number {
  // A compact double beat, followed by rest. Phase continues as rate changes.
  const beat = (centre: number, width: number) => Math.exp(-Math.pow((phase - centre) / width, 2));
  return Math.min(1, beat(0.12, 0.055) + 0.48 * beat(0.29, 0.075));
}

function safeParent(parent: unknown): HTMLElement {
  if (!parent || typeof (parent as HTMLElement).appendChild !== "function" || typeof (parent as HTMLElement).getBoundingClientRect !== "function") {
    throw new Error("The browser graph could not attach to its screen.");
  }
  return parent as HTMLElement;
}

/** One scene per screen; labels are DOM overlays in the existing React-owned surface. */
export function createOverviewRenderer(parentValue: unknown, options: OverviewMountOptions): OverviewRenderer {
  const parent = safeParent(parentValue);
  let model = options.model;
  let theme = options.theme;
  let nodeModels = new Map(model.nodes.map((node) => [node.id, node]));
  let focusedId: string | null = null;
  let selectedId: string | null = null;
  let requestedMotion = options.motion !== false;
  let visible = true;
  let disposed = false;
  let failed = false;
  let width = 1;
  let height = 1;
  let frame = 0;
  let lastTime = 0;
  let wakeTimer: ReturnType<typeof setTimeout> | undefined;
  const media = window.matchMedia("(prefers-reduced-motion: reduce)");
  const motion = () => requestedMotion && !media.matches;
  const canRender = () => !disposed && !failed && visible && document.visibilityState !== "hidden";
  const layout = new StableLayout();
  const activity = new ActivityTracker();
  const limiter = new PulseLimiter();
  const bubbles = new BubbleStore();
  const heldNodes = new Set<string>();
  const nodeEventsAt = new Map<string, number>();
  const rootArrivalsAt = new Map<string, number>();
  const clusters = new Map<string, Cluster>();
  const delegations = new Map<string, Delegation>();
  const pulses: TravellingPulse[] = [];
  const pulsePool: TravellingPulse["mesh"][] = [];
  const point = new THREE.Vector3();
  const pointB = new THREE.Vector3();
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 3000);
  camera.position.set(0, 0, 1000);
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: "low-power" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.domElement.setAttribute("role", "img");
  renderer.domElement.setAttribute("aria-label", "Workspace activity graph. Use the workspace and agent controls to inspect it.");
  renderer.domElement.tabIndex = -1;
  renderer.domElement.style.cssText = "position:absolute;inset:0;display:block;width:100%;height:100%;outline:none;";
  const previousPosition = parent.style.position;
  const previousOverflow = parent.style.overflow;
  if (getComputedStyle(parent).position === "static") parent.style.position = "relative";
  parent.style.overflow = "hidden";
  parent.appendChild(renderer.domElement);

  const circleGeometry = new THREE.CircleGeometry(1, 24);
  const haloGeometry = new THREE.RingGeometry(0.86, 1, 40);

  function requestFrame(): void {
    if (canRender() && !frame) frame = requestAnimationFrame(renderFrame);
  }

  function setSelected(id: string | null): void {
    if (selectedId === id) return;
    if (selectedId && !heldNodes.has(selectedId)) bubbles.hold(selectedId, false);
    selectedId = id;
    if (id) bubbles.hold(id, true);
    options.onSelect(id);
  }

  function focus(id: string | null, notify = true): void {
    const next = id && clusters.has(id) ? id : null;
    focusedId = next;
    if (next === null) setSelected(null);
    if (notify) options.onFocus(next === BACKGROUND_GROUP ? null : next);
    requestFrame();
  }

  function selectNode(id: string): void {
    const node = nodeModels.get(id);
    if (!node) return;
    focus(groupForNode(node));
    setSelected(id);
    requestFrame();
  }

  const overlay = new GraphOverlay(parent, theme, {
    root(id) { setSelected(null); focus(id); },
    node: selectNode,
    hold(id, held) {
      if (held) heldNodes.add(id);
      else heldNodes.delete(id);
      bubbles.hold(id, held || selectedId === id);
      requestFrame();
    },
  });

  function material(colour: string, opacity = 1): THREE.MeshBasicMaterial {
    return new THREE.MeshBasicMaterial({ color: colour, transparent: true, opacity, depthWrite: false });
  }

  function createCluster(next: WorkspaceLayout): Cluster {
    const group = new THREE.Group();
    group.position.set(next.position.x, next.position.y, 0);
    group.scale.setScalar(next.scale);
    scene.add(group);
    const root = new THREE.Mesh(circleGeometry, material(theme.surface));
    root.scale.setScalar(18);
    root.position.z = 2;
    root.userData = { workspaceId: next.id };
    const halo = new THREE.Mesh(haloGeometry, material(theme.accent, 0.4));
    halo.scale.setScalar(24);
    group.add(root, halo);
    return { layout: next, group, root, halo, nodes: new Map(), lines: [], signature: "", phase: initialPhase(next.id), opacity: 1, intensity: 0 };
  }

  function removeCluster(cluster: Cluster): void {
    for (const node of cluster.nodes.values()) { node.mesh.material.dispose(); node.halo.material.dispose(); }
    for (const line of cluster.lines) { line.geometry.dispose(); line.material.dispose(); }
    cluster.root.material.dispose();
    cluster.halo.material.dispose();
    scene.remove(cluster.group);
  }

  function updateCluster(cluster: Cluster, next: WorkspaceLayout): void {
    cluster.layout = next;
    const ids = new Set(next.nodes.map((node) => node.id));
    for (const [id, node] of cluster.nodes) {
      if (!ids.has(id)) {
        cluster.group.remove(node.mesh, node.halo);
        node.mesh.material.dispose();
        node.halo.material.dispose();
        cluster.nodes.delete(id);
      }
    }
    for (const node of next.nodes) {
      let visual = cluster.nodes.get(node.id);
      if (!visual) {
        const mesh = new THREE.Mesh(circleGeometry, material(colourFor(node.state, node.attention, theme)));
        mesh.scale.setScalar(node.kind === "agent" ? 6.2 : 4.7);
        mesh.userData = { nodeId: node.id };
        const halo = new THREE.Mesh(haloGeometry, material(theme.working, 0));
        halo.scale.setScalar(node.kind === "agent" ? 10 : 8);
        cluster.group.add(mesh, halo);
        visual = { mesh, halo, phase: initialPhase(node.id) };
        cluster.nodes.set(node.id, visual);
      }
      const location = next.points.get(node.id)!;
      visual.mesh.position.set(location.x, location.y, 4);
      visual.halo.position.set(location.x, location.y, 3);
      const colour = colourFor(node.state, node.attention, theme);
      visual.mesh.material.color.set(colour);
      visual.halo.material.color.set(colour);
    }
    const signature = [...next.parents].map(([child, ancestor]) => `${child}\0${ancestor}`).sort().join("\n");
    if (signature !== cluster.signature) {
      for (const line of cluster.lines) { cluster.group.remove(line); line.geometry.dispose(); line.material.dispose(); }
      cluster.lines = [];
      for (const [child, ancestor] of next.parents) {
        const a = next.points.get(child)!;
        const b = next.points.get(ancestor) ?? { x: 0, y: 0 };
        const geometry = new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(a.x, a.y, -2), new THREE.Vector3(b.x, b.y, -2),
        ]);
        const line = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: theme.muted, transparent: true, opacity: 0.56, depthWrite: false }));
        cluster.group.add(line);
        cluster.lines.push(line);
      }
      cluster.signature = signature;
    }
  }

  function rebuildLayout(): void {
    const layouts = layout.update(model, width, height);
    const ids = new Set(layouts.map((item) => item.id));
    for (const [id, cluster] of clusters) if (!ids.has(id)) { removeCluster(cluster); clusters.delete(id); }
    for (const next of layouts) {
      let cluster = clusters.get(next.id);
      if (!cluster) { cluster = createCluster(next); clusters.set(next.id, cluster); }
      updateCluster(cluster, next);
    }
    overlay.sync(layouts, nodeModels);
    if (focusedId && !clusters.has(focusedId)) focus(null);
    if (selectedId && !nodeModels.has(selectedId)) setSelected(null);
    const edgeIds = new Set(model.edges.filter((edge) => edge.kind === "delegation").map((edge) => edge.id));
    for (const [id, edge] of delegations) {
      if (!edgeIds.has(id)) { scene.remove(edge.line); edge.line.geometry.dispose(); edge.line.material.dispose(); delegations.delete(id); }
    }
    for (const edge of model.edges) {
      if (edge.kind !== "delegation") continue;
      let delegation = delegations.get(edge.id);
      if (!delegation) {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(6), 3));
        const line = new THREE.Line(geometry, new THREE.LineDashedMaterial({ color: theme.accent, dashSize: 5, gapSize: 5, transparent: true, opacity: 0.45, depthWrite: false }));
        scene.add(line);
        delegation = { source: edge.source, target: edge.target, line };
        delegations.set(edge.id, delegation);
      }
      delegation.source = edge.source;
      delegation.target = edge.target;
    }
  }

  function worldPosition(id: string, target: THREE.Vector3): boolean {
    const root = clusters.get(id);
    if (root) { root.group.getWorldPosition(target); return true; }
    const node = nodeModels.get(id);
    const visual = node && clusters.get(groupForNode(node))?.nodes.get(id);
    if (!visual) return false;
    visual.mesh.getWorldPosition(target);
    return true;
  }

  function pulsePath(node: OverviewNode): string[] {
    const cluster = clusters.get(groupForNode(node));
    if (!cluster) return [];
    const path = [node.id];
    const visited = new Set(path);
    let id = cluster.layout.parents.get(node.id);
    while (id && !visited.has(id)) {
      path.push(id);
      visited.add(id);
      if (id === cluster.layout.id) break;
      id = cluster.layout.parents.get(id);
    }
    return path;
  }

  function addPulse(path: string[], workspaceId: string, now: number, colour: string): void {
    if (path.length < 2 || pulses.length >= 24) return;
    if (pulses.filter((pulse) => pulse.workspaceId === workspaceId).length >= 8) return;
    let distance = 0;
    for (let index = 1; index < path.length; index++) {
      if (worldPosition(path[index - 1]!, point) && worldPosition(path[index]!, pointB)) distance += point.distanceTo(pointB);
    }
    const mesh = pulsePool.pop() ?? new THREE.Mesh(circleGeometry, material(colour));
    mesh.material.color.set(colour);
    mesh.scale.setScalar(3);
    mesh.visible = true;
    scene.add(mesh);
    pulses.push({ mesh, path, started: now, duration: Math.min(900, Math.max(220, distance / 0.28)), workspaceId });
  }

  function acceptEvents(events: readonly OverviewEvent[]): void {
    const now = Date.now();
    const fresh = activity.ingest(events, now);
    if (!canRender() || model.connection !== "connected") {
      bubbles.discard(events, now);
      return;
    }
    bubbles.ingest(events, nodeModels, now);
    if (!motion()) return;
    scene.updateMatrixWorld(true);
    for (const event of fresh) {
      const node = nodeModels.get(event.nodeId);
      if (!node) continue;
      const group = groupForNode(node);
      if (!limiter.admit(node.id, group, now)) continue;
      nodeEventsAt.set(node.id, now);
      addPulse(pulsePath(node), group, now, colourFor(node.state, node.attention, theme));
      // A turn-completion/attention signal may travel back over its explicit delegation edge.
      if (event.kind === "finished" || event.kind === "attention" || event.kind === "error") {
        const link = [...delegations.values()].find((edge) => edge.target === node.id);
        if (link && pulses.length < 24) addPulse([link.target, link.source], group, now, theme.accent);
      }
    }
  }

  function clearPulses(): void {
    for (const pulse of pulses) { pulse.mesh.visible = false; scene.remove(pulse.mesh); pulsePool.push(pulse.mesh); }
    pulses.length = 0;
    limiter.clear();
    nodeEventsAt.clear();
    rootArrivalsAt.clear();
  }

  function renderFrame(time: number): void {
    frame = 0;
    if (!canRender()) return;
    const now = Date.now();
    const elapsed = lastTime ? Math.min(0.05, Math.max(0, (time - lastTime) / 1000)) : 1 / 60;
    lastTime = time;
    const animate = motion();
    const smooth = animate ? 1 - Math.exp(-elapsed * 10) : 1;
    const live = model.connection === "connected";
    let continuous = false;
    const alphaByNode = new Map<string, number>();

    const shownBubbles = bubbles.current(now);
    const bubbleNodeIds = new Set(shownBubbles.map((bubble) => bubble.nodeId));
    for (const [id, cluster] of clusters) {
      const working = live && cluster.layout.nodes.some((node) => node.state === "working");
      const score = live ? cluster.layout.nodes.reduce((sum, node) => sum + activity.score(node.id, now), 0) : 0;
      const intensity = normaliseActivity(score);
      cluster.intensity += (intensity - cluster.intensity) * smooth;
      const focused = id === focusedId;
      const background = focusedId !== null && !focused;
      const fit = Math.min((width - 110) / (cluster.layout.radius * 2), (height - 120) / (cluster.layout.radius * 2), 2.4);
      const targetScale = focused ? Math.max(cluster.layout.scale, fit) : cluster.layout.scale * (1 + intensity * 0.1);
      const targetX = focused ? 0 : cluster.layout.position.x;
      const targetY = focused ? 8 : cluster.layout.position.y;
      const targetZ = focused ? 140 : background ? -180 : intensity * 36;
      const targetOpacity = background ? 0.14 : focused ? 1 : 0.84 + intensity * 0.16;
      const previousX = cluster.group.position.x;
      cluster.group.position.x += (targetX - cluster.group.position.x) * smooth;
      cluster.group.position.y += (targetY - cluster.group.position.y) * smooth;
      cluster.group.position.z += (targetZ - cluster.group.position.z) * smooth;
      cluster.group.scale.setScalar(cluster.group.scale.x + (targetScale - cluster.group.scale.x) * smooth);
      cluster.opacity += (targetOpacity - cluster.opacity) * smooth;
      const transitioning = Math.abs(previousX - targetX) > 0.15 || Math.abs(cluster.group.position.y - targetY) > 0.15 || Math.abs(cluster.group.scale.x - targetScale) > 0.001 || Math.abs(cluster.opacity - targetOpacity) > 0.005;
      if (animate && (working || score > 0.01 || transitioning)) continuous = true;
      const bpm = heartbeatBpm(working, intensity);
      if (animate) cluster.phase = (cluster.phase + elapsed * bpm / 60) % 1;
      const arrivalAge = now - (rootArrivalsAt.get(id) ?? -Infinity);
      const arrival = animate && arrivalAge < 900 ? Math.exp(-arrivalAge / 220) : 0;
      const wave = Math.max(animate && working ? heartbeat(cluster.phase) : 0, arrival);
      if (arrival > 0.02) continuous = true;
      const attention = cluster.layout.nodes.some((node) => node.attention || node.state === "error");
      cluster.halo.material.color.set(attention ? theme.waiting : working ? theme.working : theme.border);
      cluster.halo.material.opacity = cluster.opacity * (working ? 0.28 + wave * 0.5 : 0.42 + wave * 0.35);
      cluster.halo.scale.setScalar(24 + wave * 8);
      cluster.root.material.opacity = cluster.opacity;
      for (const line of cluster.lines) line.material.opacity = cluster.opacity * 0.56;
      for (const node of cluster.layout.nodes) {
        const visual = cluster.nodes.get(node.id)!;
        const nodeWorking = live && node.state === "working";
        const nodeIntensity = normaliseActivity(activity.score(node.id, now));
        if (animate) visual.phase = (visual.phase + elapsed * heartbeatBpm(nodeWorking, nodeIntensity) / 60) % 1;
        const eventAge = now - (nodeEventsAt.get(node.id) ?? -Infinity);
        const eventPulse = animate && eventAge < 900 ? Math.exp(-eventAge / 260) : 0;
        const pulse = Math.max(animate && nodeWorking ? heartbeat(visual.phase) : 0, eventPulse);
        visual.halo.scale.setScalar((node.kind === "agent" ? 10 : 8) + pulse * 5);
        visual.halo.material.opacity = cluster.opacity * (nodeWorking ? 0.18 + pulse * 0.5 : Math.max(node.attention ? 0.3 : 0, pulse * 0.6));
        visual.mesh.material.opacity = cluster.opacity;
        alphaByNode.set(node.id, cluster.opacity);
      }
      alphaByNode.set(id, cluster.opacity);
    }

    scene.updateMatrixWorld(true);
    for (const delegation of delegations.values()) {
      const exists = worldPosition(delegation.source, point) && worldPosition(delegation.target, pointB);
      delegation.line.visible = exists;
      if (!exists) continue;
      const positions = delegation.line.geometry.getAttribute("position") as THREE.BufferAttribute;
      positions.setXYZ(0, point.x, point.y, point.z - 4);
      positions.setXYZ(1, pointB.x, pointB.y, pointB.z - 4);
      positions.needsUpdate = true;
      delegation.line.computeLineDistances();
      delegation.line.material.opacity = 0.45 * Math.max(alphaByNode.get(delegation.source) ?? 0, alphaByNode.get(delegation.target) ?? 0);
    }

    for (let index = pulses.length - 1; index >= 0; index--) {
      const pulse = pulses[index]!;
      const progress = (now - pulse.started) / pulse.duration;
      if (progress >= 1 || !animate || !live) {
        if (progress >= 1 && animate && live) {
          const destination = pulse.path[pulse.path.length - 1];
          if (destination && clusters.has(destination)) rootArrivalsAt.set(destination, now);
          else if (destination && nodeModels.has(destination)) nodeEventsAt.set(destination, now);
          continuous = true;
        }
        pulse.mesh.visible = false;
        scene.remove(pulse.mesh);
        pulsePool.push(pulse.mesh);
        pulses.splice(index, 1);
        continue;
      }
      const pathPoints: THREE.Vector3[] = [];
      for (const id of pulse.path) if (worldPosition(id, point)) pathPoints.push(point.clone());
      const lengths = pathPoints.slice(1).map((item, part) => item.distanceTo(pathPoints[part]!));
      let remaining = Math.max(0, progress) * lengths.reduce((sum, item) => sum + item, 0);
      for (let part = 0; part < lengths.length; part++) {
        const length = lengths[part]!;
        if (remaining <= length || part === lengths.length - 1) {
          pulse.mesh.position.copy(pathPoints[part]!).lerp(pathPoints[part + 1]!, length ? remaining / length : 1);
          pulse.mesh.position.z += 8;
          break;
        }
        remaining -= length;
      }
      pulse.mesh.material.opacity = clusters.get(pulse.workspaceId)?.opacity ?? 0;
      continuous = true;
    }

    const project = (position: THREE.Vector3): { x: number; y: number } => {
      position.project(camera);
      return { x: (position.x + 1) * width / 2, y: (1 - position.y) * height / 2 };
    };
    overlay.beginPositions();
    for (const [id, cluster] of clusters) {
      const rootPosition = project(cluster.group.getWorldPosition(point));
      overlay.positionRoot(id, rootPosition.x, rootPosition.y, cluster.opacity, id === focusedId);
      const visibleLabels = new Set(cluster.layout.nodes
        .filter((node) => node.attention || (id === focusedId && node.state === "working") || node.id === selectedId)
        .sort((a, b) => Number(b.attention) - Number(a.attention) || a.id.localeCompare(b.id))
        .slice(0, id === focusedId ? 10 : 3).map((node) => node.id));
      for (const node of cluster.layout.nodes) {
        const location = project(cluster.nodes.get(node.id)!.mesh.getWorldPosition(point));
        overlay.positionNode(node.id, location.x, location.y, cluster.opacity, selectedId === node.id,
          !bubbleNodeIds.has(node.id) && (focusedId === null || focusedId === id) &&
          (visibleLabels.has(node.id) || (focusedId === id && cluster.layout.nodes.length <= 12)),
          (cluster.layout.points.get(node.id)?.y ?? 0) < -10);
      }
    }
    overlay.syncBubbles(shownBubbles);
    for (const bubble of shownBubbles) {
      if (!worldPosition(bubble.nodeId, point)) continue;
      const location = project(point);
      overlay.positionBubble(bubble.nodeId, location.x, location.y, width, height, alphaByNode.get(bubble.nodeId) ?? 0);
    }
    renderer.render(scene, camera);
    if (continuous && animate) requestFrame();
    else if (shownBubbles.length && wakeTimer === undefined) {
      // Text expiry still runs with motion disabled, without a permanent animation loop.
      wakeTimer = setTimeout(() => { wakeTimer = undefined; requestFrame(); }, 500);
    }
  }

  function resize(): void {
    if (disposed) return;
    const rect = parent.getBoundingClientRect();
    width = Math.max(1, rect.width);
    height = Math.max(1, rect.height);
    camera.left = -width / 2;
    camera.right = width / 2;
    camera.top = height / 2;
    camera.bottom = -height / 2;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(width, height, false);
    rebuildLayout();
    requestFrame();
  }

  function onPointer(event: PointerEvent): void {
    if (event.button !== 0) return;
    renderer.domElement.focus({ preventScroll: true });
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.set((event.clientX - rect.left) / width * 2 - 1, -(event.clientY - rect.top) / height * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    const targets: THREE.Object3D[] = [];
    for (const cluster of clusters.values()) { targets.push(cluster.root); for (const node of cluster.nodes.values()) targets.push(node.mesh); }
    const hit = raycaster.intersectObjects(targets, false)[0]?.object;
    if (typeof hit?.userData.nodeId === "string") selectNode(hit.userData.nodeId);
    else if (typeof hit?.userData.workspaceId === "string") { setSelected(null); focus(hit.userData.workspaceId); }
    else focus(null);
  }

  function onKey(event: KeyboardEvent): void {
    if (event.key !== "Escape" || event.defaultPrevented || !focusedId) return;
    const target = event.target as HTMLElement | null;
    if (!target || !parent.contains(target) || target.closest("input, textarea, select, [contenteditable='true'], [role='dialog'], [aria-modal='true']")) return;
    event.preventDefault();
    event.stopPropagation();
    focus(null);
  }

  function pauseFrames(): void {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    lastTime = 0;
    if (wakeTimer !== undefined) clearTimeout(wakeTimer);
    wakeTimer = undefined;
    clearPulses();
    bubbles.discard(model.events, Date.now());
    bubbles.clear();
    overlay.clearBubbles();
  }

  function onVisibility(): void {
    if (!canRender()) pauseFrames();
    else { lastTime = 0; resize(); }
  }

  function onMotion(): void {
    if (!motion()) clearPulses();
    requestFrame();
  }

  function onContextLost(event: Event): void {
    event.preventDefault();
    failed = true;
    pauseFrames();
    options.onError?.("The graphics context was lost. The workspace summary is still available.");
  }

  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(parent);
  renderer.domElement.addEventListener("pointerdown", onPointer);
  renderer.domElement.addEventListener("webglcontextlost", onContextLost);
  parent.addEventListener("keydown", onKey);
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("resize", resize);
  media.addEventListener("change", onMotion);
  resize();
  acceptEvents(model.events);

  return {
    update(next) {
      if (disposed) return;
      model = next;
      nodeModels = new Map(model.nodes.map((node) => [node.id, node]));
      const ids = new Set(nodeModels.keys());
      activity.prune(ids);
      bubbles.prune(ids);
      for (const id of nodeEventsAt.keys()) if (!ids.has(id)) nodeEventsAt.delete(id);
      for (const id of rootArrivalsAt.keys()) if (!model.workspaces.some((workspace) => workspace.id === id) && id !== BACKGROUND_GROUP) rootArrivalsAt.delete(id);
      rebuildLayout();
      if (model.connection !== "connected") { clearPulses(); bubbles.clear(); }
      acceptEvents(model.events);
      requestFrame();
    },
    updateTheme(next) {
      if (disposed) return;
      theme = next;
      for (const cluster of clusters.values()) {
        cluster.root.material.color.set(theme.surface);
        for (const line of cluster.lines) line.material.color.set(theme.muted);
        for (const node of cluster.layout.nodes) {
          const visual = cluster.nodes.get(node.id)!;
          const colour = colourFor(node.state, node.attention, theme);
          visual.mesh.material.color.set(colour);
          visual.halo.material.color.set(colour);
        }
      }
      for (const delegation of delegations.values()) delegation.line.material.color.set(theme.accent);
      overlay.updateTheme(next);
      requestFrame();
    },
    setFocus(id) { if (!disposed) focus(id, false); },
    setMotion(enabled) { requestedMotion = enabled; onMotion(); },
    setVisible(next) { visible = next; onVisibility(); },
    dispose() {
      if (disposed) return;
      disposed = true;
      pauseFrames();
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener("pointerdown", onPointer);
      renderer.domElement.removeEventListener("webglcontextlost", onContextLost);
      parent.removeEventListener("keydown", onKey);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("resize", resize);
      media.removeEventListener("change", onMotion);
      for (const cluster of clusters.values()) removeCluster(cluster);
      for (const delegation of delegations.values()) { delegation.line.geometry.dispose(); delegation.line.material.dispose(); }
      for (const mesh of pulsePool) mesh.material.dispose();
      clusters.clear();
      delegations.clear();
      circleGeometry.dispose();
      haloGeometry.dispose();
      overlay.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
      scene.clear();
      parent.style.position = previousPosition;
      parent.style.overflow = previousOverflow;
      activity.clear();
    },
  };
}

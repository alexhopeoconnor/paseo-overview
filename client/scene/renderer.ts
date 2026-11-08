import * as THREE from "three";
import type { OverviewModel } from "../../shared/model";
import type { OverviewFocus, OverviewMountOptions, OverviewRenderer } from "../../shared/renderer";
import { ActivityTracker, aggregateOwnedActivity, heartbeatBpm, normaliseActivity, PulseLimiter } from "../activity";
import { BubbleStore } from "../bubbles";
import { buildOwnershipIndex } from "../normalize";
import { StableLayout, type PositionedNode, type ProjectLayout, type SceneLayout } from "../layout";
import { pointAlongRoute, routeDelegation, type RoutedEdge, type RouteNode } from "../routing";
import { unionRects, type Rect, type Point } from "../geometry";
import { statusColour } from "../status";
import { GraphOverlay } from "./overlay";

interface VisualNode { halo: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>; phase: number }
interface Cluster {
  layout: ProjectLayout; group: THREE.Group; wash: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  nodes: Map<string, VisualNode>; lines: Map<string, THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>>;
  signature: string; opacity: number;
}
interface Pulse {
  nodeId: string; projectId: string; routeIds: string[]; started: number; duration: number;
  mesh: THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial>;
}
interface Delegation {
  route: RoutedEdge;
  line: THREE.Line<THREE.BufferGeometry, THREE.LineDashedMaterial>;
  arrow: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>;
}
const phaseFor = (id: string) => { let value = 0; for (const char of id) value = (value * 31 + char.charCodeAt(0)) | 0; return (value >>> 0) / 0xffffffff; };
const beat = (phase: number) => Math.min(1, Math.exp(-Math.pow((phase - 0.12) / 0.055, 2)) + 0.48 * Math.exp(-Math.pow((phase - 0.29) / 0.075, 2)));
const sameFocus = (a: OverviewFocus, b: OverviewFocus) => a?.kind === b?.kind && a?.id === b?.id;

/** One orthographic scene, with measured DOM controls sharing every layout transform. */
export function createOverviewRenderer(parentValue: unknown, options: OverviewMountOptions): OverviewRenderer {
  const parent = parentValue as HTMLElement;
  if (!parent || typeof parent.appendChild !== "function" || typeof parent.getBoundingClientRect !== "function") throw new Error("The browser graph could not attach to its screen.");
  let model = options.model, theme = options.theme;
  let ownership = buildOwnershipIndex(model);
  let focused: OverviewFocus = null, selected: string | null = null, hovered: string | null = null;
  let width = 1, height = 1, visible = true, disposed = false, failed = false;
  let requestedMotion = options.motion !== false, frame = 0, lastTime = 0;
  let wakeTimer: ReturnType<typeof setTimeout> | undefined;
  let delegationDirty = true;
  const media = window.matchMedia("(prefers-reduced-motion: reduce)");
  const motion = () => requestedMotion && !media.matches;
  const canRender = () => !disposed && !failed && visible && document.visibilityState !== "hidden";
  const layoutEngine = new StableLayout();
  let layout: SceneLayout = { projects: [], nodes: new Map(), ownershipEdges: [], delegationEdges: [], width, height };
  const activity = new ActivityTracker(), limiter = new PulseLimiter(), bubbles = new BubbleStore();
  const clusters = new Map<string, Cluster>(), delegations = new Map<string, Delegation>();
  const pulses: Pulse[] = [], pool: Pulse["mesh"][] = [];
  const arrivals = new Map<string, number>(), held = new Set<string>();
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(0, 1, 0, 1, 0.1, 3000);
  camera.position.set(0, 0, 1000);
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: "low-power" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.domElement.style.cssText = "position:absolute;inset:0;display:block;width:100%;height:100%;outline:none;";
  renderer.domElement.setAttribute("role", "img");
  renderer.domElement.setAttribute("aria-label", "Live project activity. Select a project or workspace to explore.");
  renderer.domElement.tabIndex = -1;
  const previousPosition = parent.style.position, previousOverflow = parent.style.overflow;
  if (getComputedStyle(parent).position === "static") parent.style.position = "relative";
  parent.style.overflow = "hidden"; parent.appendChild(renderer.domElement);
  const plane = new THREE.PlaneGeometry(1, 1), circle = new THREE.CircleGeometry(1, 20);
  const glowCanvas = document.createElement("canvas"); glowCanvas.width = 64; glowCanvas.height = 64;
  const glowContext = glowCanvas.getContext("2d")!;
  const gradient = glowContext.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, "#ffffffff"); gradient.addColorStop(0.4, "#ffffff88"); gradient.addColorStop(1, "#ffffff00");
  glowContext.fillStyle = gradient; glowContext.fillRect(0, 0, 64, 64);
  const glowTexture = new THREE.CanvasTexture(glowCanvas);
  const point = new THREE.Vector3();
  const material = (colour: string, glow = false) => new THREE.MeshBasicMaterial({ color: colour, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide, ...(glow ? { map: glowTexture } : {}) });
  const requestFrame = () => { if (canRender() && !frame) frame = requestAnimationFrame(renderFrame); };

  function setSelection(id: string | null): void {
    const next = id && model.nodes.some(node => node.id === id) ? id : null;
    if (next === selected) return;
    if (selected && !held.has(selected)) bubbles.hold(selected, false);
    selected = next;
    if (selected) bubbles.hold(selected, true);
    options.onSelect(selected); requestFrame();
  }
  function setFocus(target: OverviewFocus): void {
    let next = target;
    if (target && !layout.nodes.has(target.id)) next = null;
    if (sameFocus(next, focused)) return;
    focused = next; delegationDirty = true; clearPulses();
    if (!next) setSelection(null);
    options.onFocus(next); requestFrame();
  }
  function activate(id: string): void {
    const node = layout.nodes.get(id);
    if (!node) return;
    if (node.kind === "project" || node.kind === "workspace") { setSelection(null); setFocus({ kind: node.kind, id }); }
    else {
      setFocus(node.workspaceId ? { kind: "workspace", id: node.workspaceId } : { kind: "project", id: node.projectId });
      setSelection(id);
    }
  }
  const overlay = new GraphOverlay(parent, theme, {
    activate,
    hover(id) { hovered = id; requestFrame(); },
    hold(id, hold) { if (hold) held.add(id); else held.delete(id); bubbles.hold(id, hold || id === selected); requestFrame(); },
  });

  function removeCluster(cluster: Cluster): void {
    for (const node of cluster.nodes.values()) node.halo.material.dispose();
    for (const line of cluster.lines.values()) { line.geometry.dispose(); line.material.dispose(); }
    cluster.wash.material.dispose(); scene.remove(cluster.group);
  }
  function rebuildLayout(): void {
    const next = layoutEngine.update(model, width, height);
    const routeChanged = next.delegationEdges !== layout.delegationEdges ||
      next.projects.length !== layout.projects.length || next.projects.some(project => {
        const old = layout.projects.find(item => item.id === project.id);
        return !old || old.edges !== project.edges || old.position.x !== project.position.x ||
          old.position.y !== project.position.y || old.scale !== project.scale;
      });
    const ids = new Set(next.projects.map(project => project.id));
    for (const [id, cluster] of clusters) if (!ids.has(id)) { removeCluster(cluster); clusters.delete(id); }
    for (const project of next.projects) {
      let cluster = clusters.get(project.id);
      if (!cluster) {
        const group = new THREE.Group(); group.position.set(project.position.x, project.position.y, 0); group.scale.setScalar(project.scale);
        const wash = new THREE.Mesh(plane, material(theme.accent, true)); wash.position.z = -8; group.add(wash); scene.add(group);
        cluster = { layout: project, group, wash, nodes: new Map(), lines: new Map(), signature: "", opacity: 1 }; clusters.set(project.id, cluster);
      }
      cluster.layout = project;
      cluster.wash.position.set(project.bounds.x + project.bounds.width / 2, project.bounds.y + project.bounds.height / 2, -8);
      cluster.wash.scale.set(project.bounds.width * 1.15, project.bounds.height * 1.15, 1);
      const nodeIds = new Set(project.nodes.map(node => node.id));
      for (const [id, visual] of cluster.nodes) if (!nodeIds.has(id)) { cluster.group.remove(visual.halo); visual.halo.material.dispose(); cluster.nodes.delete(id); }
      for (const node of project.nodes) {
        let visual = cluster.nodes.get(node.id);
        if (!visual) { visual = { halo: new THREE.Mesh(plane, material(theme.accent, true)), phase: phaseFor(node.id) }; cluster.group.add(visual.halo); cluster.nodes.set(node.id, visual); }
        visual.halo.position.set(node.position.x, node.position.y, 1);
      }
      const signature = project.edges.map(edge => `${edge.id}:${edge.points.map(point => `${point.x},${point.y}`).join(";")}`).join("|");
      if (signature !== cluster.signature) {
        clearPulses();
        for (const line of cluster.lines.values()) { cluster.group.remove(line); line.geometry.dispose(); line.material.dispose(); }
        cluster.lines.clear();
        for (const edge of project.edges) {
          const geometry = new THREE.BufferGeometry().setFromPoints(edge.points.map(point => new THREE.Vector3(point.x, point.y, -2)));
          const line = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: theme.muted, transparent: true, opacity: 0.4, depthWrite: false }));
          cluster.group.add(line); cluster.lines.set(edge.id, line);
        }
        cluster.signature = signature;
      }
    }
    layout = next; ownership = buildOwnershipIndex(model); delegationDirty ||= routeChanged;
    overlay.sync(layout, model);
    if (focused && !layout.nodes.has(focused.id)) setFocus(null);
    if (selected && !layout.nodes.has(selected)) setSelection(null);
  }

  function transformNode(node: PositionedNode): RouteNode {
    const group = clusters.get(node.projectId)!.group, scale = group.scale.x;
    const rect = (value: Rect): Rect => ({ x: group.position.x + value.x * scale, y: group.position.y + value.y * scale, width: value.width * scale, height: value.height * scale });
    return { id: node.id, position: { x: group.position.x + node.position.x * scale, y: group.position.y + node.position.y * scale }, body: rect(node.body), bounds: rect(node.bounds) };
  }
  function rebuildDelegations(): void {
    for (const item of delegations.values()) {
      scene.remove(item.line, item.arrow);
      item.line.geometry.dispose(); item.line.material.dispose();
      item.arrow.geometry.dispose(); item.arrow.material.dispose();
    }
    delegations.clear();
    const nodes = new Map([...layout.nodes.values()].map(node => [node.id, transformNode(node)]));
    for (const edge of model.edges) {
      if (edge.kind !== "delegation") continue;
      const source = nodes.get(edge.source), target = nodes.get(edge.target);
      if (!source || !target) continue;
      const route = routeDelegation({ id: edge.id, source, target,
        obstacles: [...nodes.values()].filter(node => node.id !== edge.source && node.id !== edge.target).map(node => node.bounds),
        viewport: { x: 8, y: 8, width: width - 16, height: height - 16 } });
      if (!route.points.length) continue;
      const geometry = new THREE.BufferGeometry().setFromPoints(route.points.map(point => new THREE.Vector3(point.x, point.y, 12)));
      const line = new THREE.Line(geometry, new THREE.LineDashedMaterial({ color: theme.accent, dashSize: 5, gapSize: 6, transparent: true, opacity: 0.35, depthWrite: false }));
      const tip = pointAlongRoute(route, 1), before = pointAlongRoute(route, Math.max(0, 1 - 8 / Math.max(1, route.length)));
      const angle = Math.atan2(tip.y - before.y, tip.x - before.x);
      const back = { x: tip.x - Math.cos(angle) * 7, y: tip.y - Math.sin(angle) * 7 };
      const arrow = new THREE.Line(new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(back.x - Math.sin(angle) * 3, back.y + Math.cos(angle) * 3, 12),
        new THREE.Vector3(tip.x, tip.y, 12),
        new THREE.Vector3(back.x + Math.sin(angle) * 3, back.y - Math.cos(angle) * 3, 12),
      ]), new THREE.LineBasicMaterial({ color: theme.accent, transparent: true, opacity: 0.5, depthWrite: false }));
      line.computeLineDistances(); scene.add(line, arrow); delegations.set(edge.id, { route, line, arrow });
    }
    delegationDirty = false;
  }
  function clearPulses(): void {
    for (const pulse of pulses) { scene.remove(pulse.mesh); pulse.mesh.visible = false; pool.push(pulse.mesh); }
    pulses.length = 0; limiter.clear(); arrivals.clear();
  }
  function acceptEvents(): void {
    const now = Date.now(), fresh = activity.ingest(model.events, now);
    if (!canRender() || model.connection !== "connected") { bubbles.discard(model.events, now); return; }
    const agents = new Map(model.nodes.map(node => [node.id, node]));
    bubbles.ingest(model.events, agents, now);
    if (!motion()) return;
    for (const event of fresh) {
      const node = layout.nodes.get(event.nodeId), agent = agents.get(event.nodeId);
      if (!node || !agent || !limiter.admit(node.id, node.workspaceId ?? node.projectId, now)) continue;
      const project = clusters.get(node.projectId)?.layout;
      if (!project) continue;
      const routeIds: string[] = [], seen = new Set<string>();
      let child: string | undefined = node.id;
      while (child && !seen.has(child)) {
        seen.add(child);
        const edge = project.edges.find(edge => edge.target === child);
        if (!edge) break;
        routeIds.push(edge.id); child = edge.source;
      }
      if (!routeIds.length || pulses.length >= 24) continue;
      const mesh = pool.pop() ?? new THREE.Mesh(circle, material(statusColour(agent, theme)));
      mesh.material.color.set(statusColour(agent, theme)); mesh.scale.setScalar(2.8); mesh.visible = true; scene.add(mesh);
      const length = project.edges.filter(edge => routeIds.includes(edge.id)).reduce((sum, edge) => sum + edge.length, 0) * project.scale;
      pulses.push({ nodeId: node.id, projectId: node.projectId, routeIds, started: now, duration: Math.min(900, Math.max(350, length / 0.5)), mesh });
      arrivals.set(node.id, now);
    }
  }

  function renderFrame(time: number): void {
    frame = 0;
    if (!canRender()) return;
    const now = Date.now(), dt = lastTime ? Math.min(0.05, (time - lastTime) / 1000) : 1 / 60;
    lastTime = time;
    const animate = motion(), smooth = animate ? 1 - Math.exp(-dt * 12) : 1;
    const live = model.connection === "connected";
    const summaries = aggregateOwnedActivity(model, ownership, activity, now);
    const agentById = new Map(model.nodes.map(node => [node.id, node]));
    const focusNode = focused ? layout.nodes.get(focused.id) : undefined;
    const focusProject = focusNode?.projectId;
    const ancestry = new Set<string>();
    let ancestor: string | undefined = hovered ?? selected ?? undefined;
    while (ancestor && !ancestry.has(ancestor)) { ancestry.add(ancestor); ancestor = layout.nodes.get(ancestor)?.parentId; }
    let continuous = false, transitioning = false;
    const opacityByNode = new Map<string, number>();
    for (const [id, cluster] of clusters) {
      const summary = summaries.get(id), intensity = live ? normaliseActivity(summary?.score ?? 0) : 0;
      const foreground = focusProject === id, background = !!focused && !foreground;
      let bounds = cluster.layout.bounds;
      if (foreground && focused?.kind === "workspace") {
        const workspaceId = focused.id;
        const branch = cluster.layout.nodes.filter(node => node.id === id || node.id === workspaceId || node.workspaceId === workspaceId);
        bounds = unionRects(branch.map(node => node.bounds));
      }
      const fit = Math.min((width - 80) / bounds.width, (height - 90) / bounds.height, 1.65);
      const scale = foreground ? Math.max(cluster.layout.scale, fit) : cluster.layout.scale;
      const targetX = foreground ? width / 2 - (bounds.x + bounds.width / 2) * scale : cluster.layout.position.x;
      const targetY = foreground ? height / 2 - (bounds.y + bounds.height / 2) * scale : cluster.layout.position.y;
      const z = foreground ? 140 : background ? -180 : intensity * 32;
      const alpha = background ? 0.13 : 1;
      const moving = animate && (Math.abs(cluster.group.position.x - targetX) + Math.abs(cluster.group.position.y - targetY) > 0.25 || Math.abs(cluster.group.scale.x - scale) > 0.001 || Math.abs(cluster.opacity - alpha) > 0.005);
      transitioning ||= moving;
      cluster.group.position.x += (targetX - cluster.group.position.x) * smooth;
      cluster.group.position.y += (targetY - cluster.group.position.y) * smooth;
      cluster.group.position.z += (z - cluster.group.position.z) * smooth;
      cluster.group.scale.setScalar(cluster.group.scale.x + (scale - cluster.group.scale.x) * smooth);
      cluster.opacity += (alpha - cluster.opacity) * smooth;
      cluster.wash.material.color.set(theme.accent); cluster.wash.material.opacity = cluster.opacity * (0.028 + intensity * 0.035);
      for (const node of cluster.layout.nodes) {
        const visual = cluster.nodes.get(node.id)!, count = summaries.get(node.id), agent = agentById.get(node.id);
        const working = live && (count?.working ?? 0) > 0;
        const score = live ? normaliseActivity(count?.score ?? 0) : 0;
        const dimmedBranch = foreground && focused?.kind === "workspace" && node.id !== id && node.id !== focused.id && node.workspaceId !== focused.id;
        const nodeAlpha = cluster.opacity * (dimmedBranch ? 0.2 : 1);
        opacityByNode.set(node.id, nodeAlpha);
        if (animate) visual.phase = (visual.phase + dt * heartbeatBpm(working, score) / 60) % 1;
        const age = now - (arrivals.get(node.id) ?? -Infinity), arrival = age < 800 ? Math.exp(-age / 240) : 0;
        const wave = animate ? Math.max(working ? beat(visual.phase) : 0, arrival) : 0;
        visual.halo.material.color.set(agent ? statusColour(agent, theme) : count?.errors ? theme.error : count?.waiting ? theme.waiting : working ? theme.working : theme.accent);
        visual.halo.material.opacity = nodeAlpha * (working ? 0.22 + wave * 0.48 : wave * 0.5);
        visual.halo.scale.set(node.body.width + 28 + wave * 18, node.body.height + 28 + wave * 18, 1);
        if (animate && (working || score > 0.01 || arrival > 0.02)) continuous = true;
      }
      for (const edge of cluster.layout.edges) {
        const line = cluster.lines.get(edge.id)!;
        const highlighted = ancestry.has(edge.source) && ancestry.has(edge.target);
        line.material.color.set(highlighted ? theme.accent : theme.muted);
        line.material.opacity = Math.min(opacityByNode.get(edge.source) ?? 1, opacityByNode.get(edge.target) ?? 1) * (highlighted ? 0.9 : 0.36);
      }
    }
    scene.updateMatrixWorld(true);
    if (transitioning) { delegationDirty = true; continuous = true; }
    else if (delegationDirty) rebuildDelegations();
    for (const item of delegations.values()) {
      item.line.visible = item.arrow.visible = !transitioning;
      const highlighted = hovered === item.route.source || hovered === item.route.target || selected === item.route.source || selected === item.route.target;
      item.line.material.color.set(theme.accent); item.arrow.material.color.set(theme.accent);
      item.line.material.opacity = highlighted ? 0.9 : focused ? 0.18 : 0.3;
      item.arrow.material.opacity = highlighted ? 1 : focused ? 0.3 : 0.65;
    }
    for (let i = pulses.length - 1; i >= 0; i--) {
      const pulse = pulses[i]!, cluster = clusters.get(pulse.projectId), progress = (now - pulse.started) / pulse.duration;
      if (!cluster || progress >= 1 || !animate || !live || transitioning) {
        if (cluster && progress >= 1 && animate && live) arrivals.set(pulse.projectId, now);
        scene.remove(pulse.mesh); pulse.mesh.visible = false; pool.push(pulse.mesh); pulses.splice(i, 1); continue;
      }
      const routes = pulse.routeIds.map(id => cluster.layout.edges.find(edge => edge.id === id)).filter((edge): edge is RoutedEdge => !!edge);
      let remaining = progress * routes.reduce((sum, edge) => sum + edge.length, 0);
      for (let routeIndex = 0; routeIndex < routes.length; routeIndex++) {
        const route = routes[routeIndex]!;
        if (remaining <= route.length || routeIndex === routes.length - 1) {
          const location = pointAlongRoute(route, 1 - (route.length ? remaining / route.length : 1));
          pulse.mesh.position.set(location.x, location.y, 6); cluster.group.localToWorld(pulse.mesh.position);
          break;
        }
        arrivals.set(route.source, now); remaining -= route.length;
      }
      pulse.mesh.material.opacity = cluster.opacity; continuous = true;
    }
    overlay.beginPositions();
    for (const cluster of clusters.values()) for (const node of cluster.layout.nodes) {
      point.set(node.position.x, node.position.y, 0); cluster.group.localToWorld(point);
      overlay.positionNode(node.id, point.x, point.y, cluster.group.scale.x, opacityByNode.get(node.id) ?? 1, selected === node.id, focused?.id === node.id, ancestry.has(node.id), focusProject === cluster.layout.id);
    }
    const screenRoutes: Point[][] = [];
    for (const cluster of clusters.values()) {
      if (cluster.opacity < 0.25) continue;
      for (const edge of cluster.layout.edges) screenRoutes.push(edge.points.map(location => ({ x: cluster.group.position.x + location.x * cluster.group.scale.x, y: cluster.group.position.y + location.y * cluster.group.scale.x })));
    }
    for (const item of delegations.values()) if (item.line.visible) screenRoutes.push([...item.route.points]);
    overlay.setRoutes(screenRoutes);
    const shown = bubbles.current(now).filter(bubble => (opacityByNode.get(bubble.nodeId) ?? 0) > 0.25);
    overlay.finishPositions(shown, width, height);
    renderer.render(scene, camera);
    if (continuous && animate) requestFrame();
    else if (shown.length && wakeTimer === undefined) wakeTimer = setTimeout(() => { wakeTimer = undefined; requestFrame(); }, 500);
  }

  function resize(): void {
    if (disposed) return;
    const rect = parent.getBoundingClientRect();
    // A newly mounted or hidden React Native Web view can have no size yet.
    // Wait for ResizeObserver instead of treating that transient state as failure.
    if (rect.width < 32 || rect.height < 32) return;
    width = rect.width; height = rect.height;
    camera.left = 0; camera.right = width; camera.top = 0; camera.bottom = height; camera.updateProjectionMatrix();
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2)); renderer.setSize(width, height, false);
    rebuildLayout(); requestFrame();
  }
  const background = (event: PointerEvent) => { if (event.button === 0) { renderer.domElement.focus({ preventScroll: true }); setFocus(null); setSelection(null); } };
  const onKey = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement | null;
    if (event.key !== "Escape" || event.defaultPrevented || !target || !parent.contains(target) || target.closest("input,textarea,select,[contenteditable='true'],[role='dialog'],[aria-modal='true']")) return;
    event.preventDefault(); event.stopPropagation(); setFocus(null); setSelection(null);
  };
  const onVisibility = () => {
    lastTime = 0;
    if (!canRender()) { if (frame) cancelAnimationFrame(frame); frame = 0; clearPulses(); bubbles.clear(); activity.clear(); }
    else {
      for (const id of held) bubbles.hold(id, true);
      if (selected) bubbles.hold(selected, true);
      requestFrame();
    }
  };
  const onMotion = () => { clearPulses(); requestFrame(); };
  const onContextLost = (event: Event) => { event.preventDefault(); failed = true; options.onError?.("The graphics context was lost. Showing the simple view."); };
  renderer.domElement.addEventListener("pointerdown", background);
  renderer.domElement.addEventListener("webglcontextlost", onContextLost);
  parent.addEventListener("keydown", onKey);
  document.addEventListener("visibilitychange", onVisibility);
  media.addEventListener("change", onMotion);
  const observer = new ResizeObserver(() => {
    if (disposed || failed) return;
    try { resize(); }
    catch (error) { failed = true; options.onError?.(error instanceof Error ? error.message : "The graph could not fit this viewport."); }
  }); observer.observe(parent);
  const dispose = () => {
      if (disposed) return; disposed = true;
      if (frame) cancelAnimationFrame(frame);
      if (wakeTimer !== undefined) clearTimeout(wakeTimer);
      observer.disconnect(); parent.removeEventListener("keydown", onKey);
      document.removeEventListener("visibilitychange", onVisibility); media.removeEventListener("change", onMotion);
      renderer.domElement.removeEventListener("pointerdown", background); renderer.domElement.removeEventListener("webglcontextlost", onContextLost);
      clearPulses(); for (const mesh of pool) mesh.material.dispose();
      for (const cluster of clusters.values()) removeCluster(cluster);
      for (const item of delegations.values()) {
        item.line.geometry.dispose(); item.line.material.dispose(); item.arrow.geometry.dispose(); item.arrow.material.dispose();
      }
      clusters.clear(); delegations.clear(); overlay.dispose(); plane.dispose(); circle.dispose(); glowTexture.dispose(); renderer.dispose(); renderer.domElement.remove();
      parent.style.position = previousPosition; parent.style.overflow = previousOverflow;
  };
  try { resize(); acceptEvents(); } catch (error) { dispose(); throw error; }
  return {
    update(next) {
      if (disposed || failed) return;
      model = next;
      const nodeIds = new Set(model.nodes.map(node => node.id));
      activity.prune(nodeIds); bubbles.prune(nodeIds);
      for (const id of held) if (!nodeIds.has(id)) held.delete(id);
      try { rebuildLayout(); acceptEvents(); requestFrame(); }
      catch (error) { failed = true; options.onError?.(error instanceof Error ? error.message : "The graph layout is unavailable."); }
    },
    updateTheme(next) { theme = next; overlay.updateTheme(next); requestFrame(); },
    setFocus, setSelection,
    setMotion(enabled) { requestedMotion = enabled; onMotion(); },
    setVisible(next) { visible = next; onVisibility(); },
    dispose,
  };
}

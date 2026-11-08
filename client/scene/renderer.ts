import * as THREE from "three";
import type { OverviewModel } from "../../shared/model";
import type { OverviewAnchor, OverviewFocus, OverviewMountOptions, OverviewRenderer } from "../../shared/renderer";
import { ActivityTracker, aggregateOwnedActivity, heartbeatBpm, normaliseActivity, PulseLimiter } from "../activity";
import { BubbleStore, type ActivityBubble } from "../bubbles";
import { buildOwnershipIndex } from "../normalize";
import { StableLayout, type PositionedNode, type ProjectLayout, type SceneLayout } from "../layout";
import { pointAlongRoute, routeDelegation, type RoutedEdge, type RouteNode } from "../routing";
import { unionRects, type Rect, type Point } from "../geometry";
import { statusColour } from "../status";
import { GraphOverlay } from "./overlay";
import { selectionColour } from "../appearance";
import type { GroupPreferences } from "../../shared/presentation";
import { canRetainSelection } from "../presentation";
import { createGraphLine, FibreLight } from "./lines";
import { advancePulseJourney, createPulseJourney, type PulseJourney } from "./pulses";
import type { Line2 } from "three/addons/lines/Line2.js";

interface VisualNode { halo: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>; phase: number }
interface Cluster {
  layout: ProjectLayout; group: THREE.Group; wash: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  nodes: Map<string, VisualNode>; lines: Map<string, Line2>;
  signature: string; opacity: number; routedAt: number;
}
interface Pulse {
  nodeId: string; projectId: string; journey: PulseJourney; light: FibreLight;
}
interface Delegation { route: RoutedEdge; line: Line2; arrow: Line2 }
interface ProjectAnchor { x: number; y: number; scale: number }
const phaseFor = (id: string) => { let value = 0; for (const char of id) value = (value * 31 + char.charCodeAt(0)) | 0; return (value >>> 0) / 0xffffffff; };
const beat = (phase: number) => Math.min(1, Math.exp(-Math.pow((phase - 0.12) / 0.055, 2)) + 0.48 * Math.exp(-Math.pow((phase - 0.29) / 0.075, 2)));
const sameFocus = (a: OverviewFocus, b: OverviewFocus) => a?.kind === b?.kind && a?.id === b?.id;

/** One orthographic scene, with measured DOM controls sharing every layout transform. */
export function createOverviewRenderer(parentValue: unknown, options: OverviewMountOptions): OverviewRenderer {
  const parent = parentValue as HTMLElement;
  if (!parent || typeof parent.appendChild !== "function" || typeof parent.getBoundingClientRect !== "function") throw new Error("The browser graph could not attach to its screen.");
  let model = options.model, theme = options.theme;
  let ownership = buildOwnershipIndex(model);
  let focused: OverviewFocus = options.presentation?.scope ?? null;
  let selected: string | null = options.presentation?.selectedId ?? null, hovered: string | null = null;
  let groupPreferences: GroupPreferences = options.presentation?.groups ?? new Map();
  let lastAnchor: OverviewAnchor | null = null;
  let width = 1, height = 1, pixelRatio = 0, visible = true, disposed = false, failed = false;
  let requestedMotion = options.motion !== false, frame = 0, lastTime = 0;
  let wakeTimer: ReturnType<typeof setTimeout> | undefined;
  let delegationDirty = true;
  const media = window.matchMedia("(prefers-reduced-motion: reduce)");
  const motion = () => requestedMotion && !media.matches;
  const canRender = () => !disposed && !failed && visible && document.visibilityState !== "hidden";
  const layoutEngine = new StableLayout();
  let layout: SceneLayout = { projects: [], nodes: new Map(), ownershipEdges: [], delegationEdges: [], memberToDisplay: new Map(), groups: [], width, height };
  const activity = new ActivityTracker(), limiter = new PulseLimiter(), bubbles = new BubbleStore();
  const clusters = new Map<string, Cluster>(), delegations = new Map<string, Delegation>();
  const focusAnchors = new Map<string, ProjectAnchor>();
  const pulses: Pulse[] = [], pool: FibreLight[] = [];
  const arrivals = new Map<string, number>(), held = new Map<string, readonly string[]>();
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
  const plane = new THREE.PlaneGeometry(1, 1);
  const glowCanvas = document.createElement("canvas"); glowCanvas.width = 64; glowCanvas.height = 64;
  const glowContext = glowCanvas.getContext("2d")!;
  const gradient = glowContext.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, "#ffffffff"); gradient.addColorStop(0.4, "#ffffff88"); gradient.addColorStop(1, "#ffffff00");
  glowContext.fillStyle = gradient; glowContext.fillRect(0, 0, 64, 64);
  const glowTexture = new THREE.CanvasTexture(glowCanvas);
  const point = new THREE.Vector3();
  const material = (colour: string, glow = false) => new THREE.MeshBasicMaterial({ color: colour, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide, ...(glow ? { map: glowTexture } : {}) });
  const requestFrame = () => { if (canRender() && !frame) frame = requestAnimationFrame(renderFrame); };

  const authoritative = () => Object.values(model.readiness).every(Boolean) && (!model.freshness || model.freshness === "current");
  function reportAnchor(anchor: OverviewAnchor | null): void {
    if (anchor && lastAnchor && Math.abs(anchor.x - lastAnchor.x) < 0.1 && Math.abs(anchor.y - lastAnchor.y) < 0.1 && anchor.width === lastAnchor.width && anchor.height === lastAnchor.height) return;
    if (!anchor && !lastAnchor) return;
    lastAnchor = anchor ? { ...anchor } : null;
    options.onSelectionAnchor?.(lastAnchor);
  }
  function setSelection(id: string | null): void {
    const next = id && canRetainSelection(model, id) ? id : null;
    if (next === selected) return;
    if (selected && !held.has(selected)) bubbles.hold(selected, false);
    selected = next;
    if (selected) bubbles.hold(selected, true);
    if (!selected) reportAnchor(null);
    options.onSelect(selected); requestFrame();
  }
  function setFocus(target: OverviewFocus): void {
    let next = target;
    if (target && authoritative() && !layout.nodes.has(target.id)) next = null;
    if (sameFocus(next, focused)) return;
    if (!focused && next) rememberFocusAnchors();
    if (!next) focusAnchors.clear();
    focused = next; delegationDirty = true; clearPulses();
    if (!next) setSelection(null);
    try { rebuildLayout(); }
    catch (error) { failed = true; options.onError?.(error instanceof Error ? error.message : "The focused graph is unavailable."); }
    options.onFocus(next); requestFrame();
  }
  function changeGroup(id: string, expanded: boolean): void {
    const group = layout.groups.find(group => group.id === id);
    if (!expanded && group?.memberIds.includes(selected ?? "")) setSelection(null);
    hovered = null;
    groupPreferences = new Map([...groupPreferences, [id, expanded ? "expanded" : "collapsed"]]);
    options.onGroupChange?.(id, expanded);
    rebuildLayout();
    if (group) overlay.focusNode(group.parentId);
    requestFrame();
  }
  function activate(id: string): void {
    const node = layout.nodes.get(id);
    if (!node) return;
    if (node.kind === "completed-group") { changeGroup(id, true); return; }
    if (node.kind === "project" || node.kind === "workspace") {
      setSelection(null);
      setFocus({ kind: node.kind === "project" && clusters.get(node.id)?.layout.background ? "unassigned" : node.kind, id });
    } else {
      // Selection does not change focus or available graph space.
      setSelection(id);
    }
  }
  const overlay = new GraphOverlay(parent, theme, {
    activate,
    collapse(id) { changeGroup(id, false); },
    hover(id) { hovered = id; requestFrame(); },
    hold(id, hold) {
      const members = held.get(id) ?? layout.nodes.get(id)?.memberIds ?? [id];
      if (hold) held.set(id, members); else held.delete(id);
      for (const member of members) bubbles.hold(member, hold || member === selected);
      requestFrame();
    },
  });

  function removeCluster(cluster: Cluster): void {
    for (const node of cluster.nodes.values()) node.halo.material.dispose();
    for (const line of cluster.lines.values()) { line.geometry.dispose(); line.material.dispose(); }
    cluster.wash.material.dispose(); scene.remove(cluster.group);
  }
  function rememberFocusAnchors(): void {
    focusAnchors.clear();
    for (const project of layout.projects) focusAnchors.set(project.id, { ...project.position, scale: project.scale });
  }
  function rebuildLayout(): void {
    const protectedIds = new Set<string>([...held.keys(), ...[selected, hovered].filter((id): id is string => !!id)]);
    const now = Date.now();
    for (const event of model.events) if (event.timestamp >= now - 6500) protectedIds.add(event.nodeId);
    const next = layoutEngine.update(model, width, height, focused, { groups: groupPreferences, protectedIds });
    const routeChanged = next.delegationEdges !== layout.delegationEdges ||
      next.projects.length !== layout.projects.length || next.projects.some(project => {
        const old = layout.projects.find(item => item.id === project.id);
        return !old || old.edges !== project.edges || old.position.x !== project.position.x ||
          old.position.y !== project.position.y || old.scale !== project.scale;
      });
    const ids = new Set(next.projects.map(project => project.id));
    for (const [id, cluster] of clusters) if (!ids.has(id)) { removeCluster(cluster); clusters.delete(id); focusAnchors.delete(id); }
    for (const project of next.projects) {
      let cluster = clusters.get(project.id);
      if (!cluster) {
        const group = new THREE.Group(); group.position.set(project.position.x, project.position.y, 0); group.scale.setScalar(project.scale);
        const wash = new THREE.Mesh(plane, material(theme.accent, true)); wash.position.z = -8; group.add(wash); scene.add(group);
        cluster = { layout: project, group, wash, nodes: new Map(), lines: new Map(), signature: "", opacity: 1, routedAt: 0 }; clusters.set(project.id, cluster);
      }
      cluster.layout = project;
      if (focused && !focusAnchors.has(project.id)) focusAnchors.set(project.id, { ...project.position, scale: project.scale });
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
          const line = createGraphLine(edge.points, theme.muted);
          cluster.group.add(line); cluster.lines.set(edge.id, line);
        }
        cluster.signature = signature;
        cluster.routedAt = performance.now();
      }
    }
    layout = next; ownership = buildOwnershipIndex(model); delegationDirty ||= routeChanged;
    overlay.sync(layout, model);
    for (const [id, members] of held) if (!layout.nodes.has(id)) {
      for (const member of members) bubbles.hold(member, member === selected);
      held.delete(id);
    }
    if (focused && authoritative() && !layout.nodes.has(focused.id)) setFocus(null);
    if (selected && !canRetainSelection(model, selected)) setSelection(null);
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
      const line = createGraphLine(route.points, theme.accent, 1.35, 12, true);
      const tip = pointAlongRoute(route, 1), before = pointAlongRoute(route, Math.max(0, 1 - 8 / Math.max(1, route.length)));
      const angle = Math.atan2(tip.y - before.y, tip.x - before.x);
      const back = { x: tip.x - Math.cos(angle) * 7, y: tip.y - Math.sin(angle) * 7 };
      const arrow = createGraphLine([
        { x: back.x - Math.sin(angle) * 3, y: back.y + Math.cos(angle) * 3 },
        tip,
        { x: back.x + Math.sin(angle) * 3, y: back.y - Math.cos(angle) * 3 },
      ], theme.accent, 1.35, 12);
      line.computeLineDistances(); scene.add(line, arrow); delegations.set(edge.id, { route, line, arrow });
    }
    delegationDirty = false;
  }
  function clearPulses(): void {
    for (const pulse of pulses) { pulse.light.object.removeFromParent(); pulse.light.object.visible = false; pool.push(pulse.light); }
    pulses.length = 0; limiter.clear(); arrivals.clear();
  }
  function acceptEvents(): void {
    const now = Date.now(), fresh = activity.ingest(model.events, now);
    if (!canRender() || model.connection !== "connected") { bubbles.discard(model.events, now); return; }
    const agents = new Map(model.nodes.map(node => [node.id, node]));
    bubbles.ingest(model.events, agents, now);
    if (!motion()) return;
    for (const event of fresh) {
      const node = layout.nodes.get(layout.memberToDisplay.get(event.nodeId) ?? event.nodeId), agent = agents.get(event.nodeId);
      if (!node || !agent || (agent.freshness && agent.freshness !== "current") || !limiter.admit(node.id, node.workspaceId ?? node.projectId, now)) continue;
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
      const light = pool.pop() ?? new FibreLight();
      light.setColour(statusColour(agent, theme)); light.object.visible = true;
      clusters.get(node.projectId)!.group.add(light.object);
      const routes = routeIds.flatMap(id => { const route = project.edges.find(edge => edge.id === id); return route ? [route] : []; });
      const started = performance.now();
      pulses.push({ nodeId: node.id, projectId: node.projectId, journey: createPulseJourney(routes, started, clusters.get(node.projectId)!.group.scale.x), light });
      arrivals.set(node.id, started);
    }
  }

  function renderFrame(time: number): void {
    frame = 0;
    if (wakeTimer !== undefined) { clearTimeout(wakeTimer); wakeTimer = undefined; }
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
      // Focus is a presentation transform. Expanding its branch may need a new
      // full-view packing, but distant projects retain their recognisable size
      // and anchors until the user returns to that full view.
      const baseline = background ? focusAnchors.get(id) : undefined;
      const scale = foreground ? Math.max(cluster.layout.scale, fit) : baseline?.scale ?? cluster.layout.scale;
      const targetX = foreground ? width / 2 - (bounds.x + bounds.width / 2) * scale : baseline?.x ?? cluster.layout.position.x;
      const targetY = foreground ? height / 2 - (bounds.y + bounds.height / 2) * scale : baseline?.y ?? cluster.layout.position.y;
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
        const score = live ? normaliseActivity(node.memberIds
          ? node.memberIds.reduce((sum, member) => sum + activity.score(member, now), 0)
          : count?.score ?? 0) : 0;
        const dimmedBranch = foreground && focused?.kind === "workspace" && node.id !== id && node.id !== focused.id && node.workspaceId !== focused.id;
        const nodeAlpha = cluster.opacity * (dimmedBranch ? 0.2 : 1);
        opacityByNode.set(node.id, nodeAlpha);
        if (animate) visual.phase = (visual.phase + dt * heartbeatBpm(working, score) / 60) % 1;
        const age = time - (arrivals.get(node.id) ?? -Infinity), arrival = age < 800 ? Math.exp(-age / 240) : 0;
        const wave = animate ? Math.max(working ? beat(visual.phase) * 0.35 : 0, arrival) : 0;
        visual.halo.material.color.set(agent ? statusColour(agent, theme) : count?.errors ? theme.error : count?.waiting ? theme.waiting : working ? theme.working : theme.accent);
        visual.halo.material.opacity = nodeAlpha * (working ? 0.08 + wave * 0.5 : wave * 0.4);
        visual.halo.scale.set(node.body.width + 14 + wave * 15, node.body.height + 14 + wave * 15, 1);
        if (animate && (working || score > 0.01 || arrival > 0.02)) continuous = true;
      }
      for (const edge of cluster.layout.edges) {
        const line = cluster.lines.get(edge.id)!;
        const highlighted = ancestry.has(edge.source) && ancestry.has(edge.target);
        const reveal = animate ? Math.min(1, (time - cluster.routedAt) / 180) : 1;
        if (reveal < 1) continuous = true;
        line.material.color.set(highlighted ? theme.selection ?? selectionColour(theme) : theme.muted);
        line.material.linewidth = highlighted ? 2.1 : 1.35;
        line.material.opacity = Math.min(opacityByNode.get(edge.source) ?? 1, opacityByNode.get(edge.target) ?? 1) * (highlighted ? 0.9 : 0.36) * reveal;
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
      const pulse = pulses[i]!, cluster = clusters.get(pulse.projectId);
      const permitted = !!cluster && animate && live && !transitioning;
      const complete = permitted && advancePulseJourney(pulse.journey, time, (id, at) => {
        arrivals.set(id, at);
        // Halo evaluation precedes journey advancement. Even a final arrival
        // on an otherwise idle graph needs one frame to reveal its response.
        continuous = true;
      });
      if (!permitted || complete) {
        pulse.light.object.removeFromParent(); pulse.light.object.visible = false; pool.push(pulse.light); pulses.splice(i, 1); continue;
      }
      pulse.light.update(pulse.journey, time, cluster.group.scale.x, cluster.opacity); continuous = true;
    }
    overlay.beginPositions();
    for (const cluster of clusters.values()) for (const node of cluster.layout.nodes) {
      point.set(node.position.x, node.position.y, 0); cluster.group.localToWorld(point);
      overlay.positionNode(node.id, point.x, point.y, cluster.group.scale.x, opacityByNode.get(node.id) ?? 1, selected === node.id, focused?.id === node.id, ancestry.has(node.id), focusProject === cluster.layout.id);
    }
    reportAnchor(selected ? overlay.anchor(selected) : null);
    const screenRoutes: Point[][] = [];
    for (const cluster of clusters.values()) {
      if (cluster.opacity < 0.25) continue;
      for (const edge of cluster.layout.edges) screenRoutes.push(edge.points.map(location => ({ x: cluster.group.position.x + location.x * cluster.group.scale.x, y: cluster.group.position.y + location.y * cluster.group.scale.x })));
    }
    for (const item of delegations.values()) if (item.line.visible) screenRoutes.push([...item.route.points]);
    overlay.setRoutes(screenRoutes);
    const displayedBubbles = new Map<string, ActivityBubble>();
    for (const bubble of bubbles.current(now)) {
      const nodeId = layout.memberToDisplay.get(bubble.nodeId) ?? bubble.nodeId;
      if ((opacityByNode.get(nodeId) ?? 0) <= 0.25) continue;
      const previous = displayedBubbles.get(nodeId);
      if (!previous || bubble.priority > previous.priority || bubble.priority === previous.priority && bubble.timestamp > previous.timestamp) {
        displayedBubbles.set(nodeId, { ...bubble, nodeId });
      }
    }
    const shown = [...displayedBubbles.values()];
    overlay.finishPositions(shown, width, height);
    renderer.render(scene, camera);
    if (continuous && animate) requestFrame();
    else {
      // Static or held text does not need a polling render loop. The next real
      // input requests a frame; otherwise wake exactly when unheld text expires.
      const nextExpiry = shown.reduce((expiry, bubble) => selected === bubble.nodeId || held.has(bubble.nodeId)
        ? expiry : Math.min(expiry, bubble.expiresAt), Infinity);
      if (Number.isFinite(nextExpiry)) wakeTimer = setTimeout(() => { wakeTimer = undefined; requestFrame(); }, Math.max(16, nextExpiry - now + 1));
    }
  }

  function resize(): void {
    if (disposed) return;
    const logicalWidth = parent.clientWidth, logicalHeight = parent.clientHeight;
    // A newly mounted or hidden React Native Web view can have no size yet.
    // Wait for ResizeObserver instead of treating that transient state as failure.
    if (logicalWidth < 32 || logicalHeight < 32) return;
    const nextPixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    const sizeChanged = logicalWidth !== width || logicalHeight !== height;
    if (!sizeChanged && nextPixelRatio === pixelRatio) return;
    width = logicalWidth; height = logicalHeight; pixelRatio = nextPixelRatio;
    camera.left = 0; camera.right = width; camera.top = 0; camera.bottom = height; camera.updateProjectionMatrix();
    renderer.setPixelRatio(pixelRatio); renderer.setSize(width, height, false);
    if (sizeChanged) { rebuildLayout(); if (focused) rememberFocusAnchors(); }
    requestFrame();
  }
  const dismiss = () => {
    if (selected) { const previous = selected; setSelection(null); overlay.focusNode(previous); }
    else { renderer.domElement.focus({ preventScroll: true }); setFocus(null); }
  };
  const background = (event: PointerEvent) => { if (event.button === 0) dismiss(); };
  const onKey = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement | null;
    if (event.key !== "Escape" || event.defaultPrevented || !target || !parent.contains(target) || target.closest("input,textarea,select,[contenteditable='true'],[role='dialog'],[aria-modal='true']")) return;
    event.preventDefault(); event.stopPropagation(); dismiss();
  };
  const onVisibility = () => {
    lastTime = 0;
    if (!canRender()) {
      if (frame) cancelAnimationFrame(frame); frame = 0;
      if (wakeTimer !== undefined) { clearTimeout(wakeTimer); wakeTimer = undefined; }
      clearPulses(); bubbles.clear(); bubbles.discard(model.events, Date.now());
    }
    else {
      for (const members of held.values()) for (const id of members) bubbles.hold(id, true);
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
      clearPulses(); for (const light of pool) light.dispose();
      for (const cluster of clusters.values()) removeCluster(cluster);
      for (const item of delegations.values()) {
        item.line.geometry.dispose(); item.line.material.dispose(); item.arrow.geometry.dispose(); item.arrow.material.dispose();
      }
      clusters.clear(); delegations.clear(); overlay.dispose(); plane.dispose(); glowTexture.dispose(); renderer.dispose(); renderer.domElement.remove();
      parent.style.position = previousPosition; parent.style.overflow = previousOverflow;
  };
  try { resize(); acceptEvents(); } catch (error) { dispose(); throw error; }
  return {
    update(next) {
      if (disposed || failed) return;
      model = next;
      const nodeIds = new Set(model.nodes.map(node => node.id));
      activity.prune(nodeIds); bubbles.prune(nodeIds);
      try { rebuildLayout(); acceptEvents(); requestFrame(); }
      catch (error) { failed = true; options.onError?.(error instanceof Error ? error.message : "The graph layout is unavailable."); }
    },
    updateTheme(next) { theme = next; overlay.updateTheme(next); requestFrame(); },
    setFocus, setSelection,
    setGroups(next) {
      const same = next.size === groupPreferences.size && [...next].every(([id, state]) => groupPreferences.get(id) === state);
      if (same) return;
      groupPreferences = new Map(next); rebuildLayout(); requestFrame();
    },
    focusNode(id) { overlay.focusNode(id); },
    setMotion(enabled) { requestedMotion = enabled; onMotion(); },
    setVisible(next) { visible = next; onVisibility(); },
    dispose,
  };
}

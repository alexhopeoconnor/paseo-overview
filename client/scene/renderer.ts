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
import { GraphOverlay, createCollapseTextMeasure, type NodePresentation } from "./overlay";
import { selectionColour } from "../appearance";
import type { GroupPreferences } from "../../shared/presentation";
import { canRetainSelection } from "../presentation";
import { createGraphLine, FibreLight } from "./lines";
import { advancePulseJourney, createPulseJourney, type PulseJourney } from "./pulses";
import type { Line2 } from "three/addons/lines/Line2.js";
import { depthTransform, transformRouteNode, type DepthRange } from "./depth";
import { advanceElevation, elevationTarget, scaleForElevation, type ElevationInput } from "./elevation";
import { planDepthDelegations, updateMovingDelegation, type CachedDelegation } from "./delegation";
import { ProceduralAmbientGrid } from "./ambient";
import { viewDepthForScale, type ProjectSpatialPresentation } from "./spatial";
import { DEFAULT_APPEARANCE } from "../../shared/settings";
import { appearancePolicy } from "../appearance-policy";

interface VisualNode { halo: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>; phase: number }
interface Cluster {
  layout: ProjectLayout; group: THREE.Group;
  nodes: Map<string, VisualNode>; lines: Map<string, Line2>;
  signature: string; opacity: number; routedAt: number;
  depth: number; depthHeld: boolean; depthRange: DepthRange;
  elevation: number; fullViewElevation: number; relation: ElevationInput["relation"];
}
interface Pulse {
  nodeId: string; projectId: string; journey: PulseJourney; light: FibreLight;
}
interface Delegation extends CachedDelegation { line: Line2; arrow: Line2; transforms: Float64Array }
interface ProjectAnchor { x: number; y: number; scale: number }
const phaseFor = (id: string) => { let value = 0; for (const char of id) value = (value * 31 + char.charCodeAt(0)) | 0; return (value >>> 0) / 0xffffffff; };
const beat = (phase: number) => Math.min(1, Math.exp(-Math.pow((phase - 0.12) / 0.055, 2)) + 0.48 * Math.exp(-Math.pow((phase - 0.29) / 0.075, 2)));
const sameFocus = (a: OverviewFocus, b: OverviewFocus) => a?.kind === b?.kind && a?.id === b?.id;

/** Reuse the line buffers while attachments move; the expensive spine stays cached. */
function updateLinePoints(line: Line2, points: readonly Point[]): void {
  const starts = line.geometry.getAttribute("instanceStart"), ends = line.geometry.getAttribute("instanceEnd");
  const distanceStarts = line.geometry.getAttribute("instanceDistanceStart"), distanceEnds = line.geometry.getAttribute("instanceDistanceEnd");
  let length = 0;
  for (let index = 0; index < points.length - 1; index++) {
    const a = points[index]!, b = points[index + 1]!;
    starts.setXYZ(index, a.x, a.y, 12); ends.setXYZ(index, b.x, b.y, 12);
    distanceStarts?.setX(index, length); length += Math.hypot(b.x - a.x, b.y - a.y); distanceEnds?.setX(index, length);
  }
  starts.needsUpdate = ends.needsUpdate = true;
  if (distanceStarts) distanceStarts.needsUpdate = true;
  if (distanceEnds) distanceEnds.needsUpdate = true;
}

/** One renderer: perspective background followed by the measured orthographic graph. */
export function createOverviewRenderer(parentValue: unknown, options: OverviewMountOptions): OverviewRenderer {
  const parent = parentValue as HTMLElement;
  if (!parent || typeof parent.appendChild !== "function" || typeof parent.getBoundingClientRect !== "function") throw new Error("The browser graph could not attach to its screen.");
  let model = options.model, theme = options.theme;
  let appearance = options.appearance ?? DEFAULT_APPEARANCE;
  let policy = appearancePolicy(appearance);
  let ownership = buildOwnershipIndex(model);
  let focused: OverviewFocus = options.presentation?.scope ?? null;
  let selected: string | null = options.presentation?.selectedId ?? null, hovered: string | null = null;
  let groupPreferences: GroupPreferences = options.presentation?.groups ?? new Map();
  let lastAnchor: OverviewAnchor | null = null;
  let width = 1, height = 1, pixelRatio = 0, visible = true, disposed = false, failed = false;
  let requestedMotion = options.motion !== false, frame = 0, lastTime = 0;
  let wakeTimer: ReturnType<typeof setTimeout> | undefined;
  let delegationDirty = true, delegationPlanDirty = true, structuralTransition = true;
  let graphDirty = true, graphAnimating = false, nextBubbleExpiry = Infinity, nextActivityUpdate = Infinity;
  let depthRoutes = new Map<string, CachedDelegation>();
  const media = window.matchMedia("(prefers-reduced-motion: reduce)");
  const motion = () => requestedMotion && !media.matches;
  const canRender = () => !disposed && !failed && visible && document.visibilityState !== "hidden";
  const layoutEngine = new StableLayout(createCollapseTextMeasure());
  layoutEngine.setDepthReservation(0.1 * policy.depthStrength);
  let layout: SceneLayout = { projects: [], nodes: new Map(), ownershipEdges: [], delegationEdges: [], memberToDisplay: new Map(), groups: [], width, height };
  const activity = new ActivityTracker(), limiter = new PulseLimiter(), bubbles = new BubbleStore();
  const clusters = new Map<string, Cluster>(), delegations = new Map<string, Delegation>();
  const focusAnchors = new Map<string, ProjectAnchor>();
  const pulses: Pulse[] = [], pool: FibreLight[] = [];
  const arrivals = new Map<string, number>(), held = new Map<string, readonly string[]>();
  const scene = new THREE.Scene();
  scene.name = "overview-foreground";
  const camera = new THREE.OrthographicCamera(0, 1, 0, 1, 0.1, 3000);
  camera.position.set(0, 0, 1000);
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: "low-power" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.autoClear = false;
  renderer.info.autoReset = false;
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
  const ambient = new ProceduralAmbientGrid(scene, renderer, theme);
  ambient.setAppearance(appearance);
  const renderScene = (): void => renderer.render(scene, camera);
  const renderComposite = (): void => {
    renderer.info.reset();
    renderer.clear();
    ambient.renderWithBackgroundFallback(renderScene);
  };
  const point = new THREE.Vector3();
  const material = (colour: string, glow = false) => new THREE.MeshBasicMaterial({ color: colour, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide, ...(glow ? { map: glowTexture } : {}) });
  const requestFrame = (dirty = true) => {
    graphDirty ||= dirty;
    if (wakeTimer !== undefined) { clearTimeout(wakeTimer); wakeTimer = undefined; }
    if (canRender() && !frame) frame = requestAnimationFrame(renderFrame);
  };

  function scheduleFrame(now: number): void {
    if (!canRender()) return;
    if (graphAnimating && motion()) { requestFrame(false); return; }
    const delay = Math.min(motion() && model.connection === "connected" && ambient.isAnimating() ? 1000 / 24 : Infinity,
      Math.min(nextBubbleExpiry, nextActivityUpdate) - now + 1);
    if (Number.isFinite(delay)) wakeTimer = setTimeout(() => { wakeTimer = undefined; requestFrame(false); }, Math.max(16, delay));
  }

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
    focused = next; delegationDirty = true; delegationPlanDirty = true; structuralTransition = true; clearPulses();
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
    scene.remove(cluster.group);
  }
  function rememberFocusAnchors(resized = false): void {
    focusAnchors.clear();
    for (const [id, cluster] of clusters) focusAnchors.set(id, resized ? depthTransform(cluster.layout, cluster.depth)
      : { x: cluster.group.position.x, y: cluster.group.position.y, scale: cluster.group.scale.x });
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
        scene.add(group);
        cluster = { layout: project, group, nodes: new Map(), lines: new Map(), signature: "", opacity: 1, routedAt: 0,
          depth: 1, depthHeld: false, depthRange: { min: 1, max: 1 },
          elevation: 0.25, fullViewElevation: 0.25, relation: "full-view" }; clusters.set(project.id, cluster);
      }
      cluster.layout = project;
      if (focused && !focusAnchors.has(project.id)) focusAnchors.set(project.id, { ...project.position, scale: project.scale });
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
    delegationPlanDirty ||= routeChanged; structuralTransition ||= routeChanged;
    if (!focused && delegationPlanDirty) {
      const plan = planDepthDelegations(layout.projects, model.edges, layout.memberToDisplay, { x: 8, y: 8, width: width - 16, height: height - 16 });
      depthRoutes = plan.routes;
      for (const [id, cluster] of clusters) {
        cluster.depthRange = plan.ranges.get(id)!;
        cluster.depth = Math.max(cluster.depthRange.min, Math.min(cluster.depthRange.max, cluster.depth));
      }
      delegationPlanDirty = false;
    }
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
    return transformRouteNode(node, { x: group.position.x, y: group.position.y, scale });
  }
  function arrowPoints(route: RoutedEdge): Point[] {
    const tip = pointAlongRoute(route, 1), before = pointAlongRoute(route, Math.max(0, 1 - 8 / Math.max(1, route.length)));
    const angle = Math.atan2(tip.y - before.y, tip.x - before.x);
    const back = { x: tip.x - Math.cos(angle) * 7, y: tip.y - Math.sin(angle) * 7 };
    return [
      { x: back.x - Math.sin(angle) * 3, y: back.y + Math.cos(angle) * 3 }, tip,
      { x: back.x + Math.sin(angle) * 3, y: back.y - Math.cos(angle) * 3 },
    ];
  }
  function rebuildDelegations(): void {
    for (const item of delegations.values()) {
      scene.remove(item.line, item.arrow);
      item.line.geometry.dispose(); item.line.material.dispose();
      item.arrow.geometry.dispose(); item.arrow.material.dispose();
    }
    delegations.clear();
    const nodes = new Map([...layout.nodes.values()].map(node => [node.id, transformNode(node)]));
    const routes = focused ? new Map<string, CachedDelegation>() : depthRoutes;
    if (focused) for (const edge of model.edges) {
      if (edge.kind !== "delegation") continue;
      const source = nodes.get(layout.memberToDisplay.get(edge.source) ?? edge.source);
      const target = nodes.get(layout.memberToDisplay.get(edge.target) ?? edge.target);
      if (!source || !target || source.id === target.id) continue;
      const route = routeDelegation({ id: edge.id, source, target,
        obstacles: [...nodes.values()].filter(node => node.id !== source.id && node.id !== target.id).map(node => node.bounds),
        viewport: { x: 8, y: 8, width: width - 16, height: height - 16 } });
      if (route.points.length) routes.set(edge.id, { route });
    }
    for (const [id, cached] of routes) {
      const { route } = cached, source = nodes.get(route.source), target = nodes.get(route.target);
      if (!source || !target) continue;
      updateMovingDelegation(cached, source, target);
      const line = createGraphLine(route.points, theme.accent, 1.35, 12, true);
      const arrow = createGraphLine(arrowPoints(route), theme.accent, 1.35, 12);
      line.frustumCulled = arrow.frustumCulled = false;
      scene.add(line, arrow); delegations.set(id, { ...cached, line, arrow, transforms: new Float64Array(6).fill(NaN) });
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
      if (!node || !agent || (agent.freshness && agent.freshness !== "current")) continue;
      // Background feeds share the fresh observed event source, with their own
      // bounded per-project admission. A visual arrival never creates work.
      ambient.admitActivity(node.projectId);
      if (!limiter.admit(node.id, node.workspaceId ?? node.projectId, now)) continue;
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
    const now = Date.now();
    const elapsedSeconds = lastTime ? Math.max(0, (time - lastTime) / 1000) : 1 / 60;
    // Keep graph integration bounded without slowing the ambient clock on a
    // busy frame. Visibility restoration resets lastTime before either resumes.
    const dt = Math.min(0.05, elapsedSeconds);
    lastTime = time;
    const animate = motion(), smooth = animate ? 1 - Math.exp(-dt * 12) : 1;
    const live = model.connection === "connected";
    if (!graphDirty && !graphAnimating && now < Math.min(nextBubbleExpiry, nextActivityUpdate)) {
      ambient.advanceTime(elapsedSeconds, animate && live);
      renderComposite(); scheduleFrame(now); return;
    }
    graphDirty = false;
    nextActivityUpdate = Infinity;
    const summaries = aggregateOwnedActivity(model, ownership, activity, now);
    const totalProjectActivity = [...clusters.keys()].reduce((sum, id) => sum + normaliseActivity(summaries.get(id)?.score ?? 0), 0);
    const agentById = new Map(model.nodes.map(node => [node.id, node]));
    const focusNode = focused ? layout.nodes.get(focused.id) : undefined;
    const focusProject = focusNode?.projectId;
    const ancestry = new Set<string>();
    let ancestor: string | undefined = hovered ?? selected ?? undefined;
    while (ancestor && !ancestry.has(ancestor)) { ancestry.add(ancestor); ancestor = layout.nodes.get(ancestor)?.parentId; }
    const inspectedProjects = new Set([...held.keys(), ...[selected, hovered].filter((id): id is string => !!id)]
      .map(id => layout.nodes.get(layout.memberToDisplay.get(id) ?? id)?.projectId));
    let continuous = false, transitioning = false;
    const opacityByNode = new Map<string, number>();
    const presentationByNode = new Map<string, NodePresentation>();
    const bubbleNodes = new Set<string>();
    const spatialProjects: ProjectSpatialPresentation[] = [];
    for (const [id, cluster] of clusters) {
      const summary = summaries.get(id), intensity = live ? normaliseActivity(summary?.score ?? 0) : 0;
      if (animate && intensity > 0.001) nextActivityUpdate = now + 250;
      const foreground = focusProject === id, background = !!focused && !foreground;
      const heldDepth = inspectedProjects.has(id);
      const relation = foreground ? "foreground" : background ? "background" : "full-view";
      const relationChanged = relation !== cluster.relation;
      const targetElevation = elevationTarget({ activity: intensity, working: (summary?.working ?? 0) > 0,
        fresh: live && authoritative(), relation,
        otherActivity: 1 - Math.exp(-2 * Math.max(0, totalProjectActivity - intensity)) });
      // One displayed elevation drives scaling and grid deformation. Inspection
      // holds automatic motion; an explicit scope change still takes effect.
      if (relationChanged && relation === "full-view") cluster.elevation = cluster.fullViewElevation;
      else if (relationChanged && !animate) cluster.elevation = targetElevation;
      else if (animate && (live || relation !== "full-view") && (!heldDepth || relation !== "full-view") &&
        (!structuralTransition || relation !== "full-view")) {
        cluster.elevation = advanceElevation(cluster.elevation, targetElevation, elapsedSeconds, policy.responseRate);
        if (Math.abs(cluster.elevation - targetElevation) > 0.00001) continuous = true;
      }
      cluster.relation = relation;
      if (!focused) {
        // Focus has its own elevation. Restore the retained full-view value
        // before the return transform, avoiding a second scale jump afterwards.
        cluster.fullViewElevation = cluster.elevation;
        if (heldDepth && !cluster.depthHeld && !structuralTransition) cluster.depth = cluster.group.scale.x / cluster.layout.scale;
        cluster.depthHeld = heldDepth;
        if (animate && live && !heldDepth && !structuralTransition) cluster.depth = 1 + (scaleForElevation(cluster.elevation, cluster.depthRange) - 1) * policy.depthStrength;
      }
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
      const full = depthTransform(cluster.layout, cluster.depth);
      const scale = foreground ? Math.max(cluster.layout.scale, fit) : baseline?.scale ?? full.scale;
      const targetX = foreground ? width / 2 - (bounds.x + bounds.width / 2) * scale : baseline?.x ?? full.x;
      const targetY = foreground ? height / 2 - (bounds.y + bounds.height / 2) * scale : baseline?.y ?? full.y;
      const z = foreground ? 140 : background ? -180 : cluster.elevation * 42;
      const alpha = background ? 0.3 : 1;
      const moving = animate && (Math.abs(cluster.group.position.x - targetX) + Math.abs(cluster.group.position.y - targetY) > 0.25 || Math.abs(cluster.group.scale.x - scale) > 0.001 || Math.abs(cluster.opacity - alpha) > 0.005);
      transitioning ||= structuralTransition && moving;
      continuous ||= moving;
      const transformSmooth = structuralTransition ? smooth : 1;
      cluster.group.position.x += (targetX - cluster.group.position.x) * transformSmooth;
      cluster.group.position.y += (targetY - cluster.group.position.y) * transformSmooth;
      cluster.group.position.z += (z - cluster.group.position.z) * smooth;
      cluster.group.scale.setScalar(cluster.group.scale.x + (scale - cluster.group.scale.x) * transformSmooth);
      cluster.opacity += (alpha - cluster.opacity) * smooth;
      for (const node of cluster.layout.nodes) {
        const visual = cluster.nodes.get(node.id)!, count = summaries.get(node.id), agent = agentById.get(node.id);
        const working = live && (count?.working ?? 0) > 0;
        const score = live ? normaliseActivity(node.memberIds
          ? node.memberIds.reduce((sum, member) => sum + activity.score(member, now), 0)
          : count?.score ?? 0) : 0;
        const dimmedBranch = foreground && focused?.kind === "workspace" && node.id !== id && node.id !== focused.id && node.workspaceId !== focused.id;
        const nodeAlpha = cluster.opacity * (dimmedBranch ? 0.38 : 1);
        const emphasized = ancestry.has(node.id);
        opacityByNode.set(node.id, emphasized ? Math.max(0.85, nodeAlpha) : nodeAlpha);
        const distant = background || dimmedBranch;
        const root = node.kind === "project";
        const important = !!agent?.attention || (count?.errors ?? 0) > 0 || (count?.waiting ?? 0) > 0;
        presentationByNode.set(node.id, {
          surfaceOpacity: emphasized ? 1 : distant ? Math.max(root ? 0.46 : 0.24, nodeAlpha) : 1,
          textOpacity: emphasized ? 1 : distant ? root ? 0.8 : 0.55 : 1,
          badgeOpacity: emphasized ? 1 : distant ? important ? 0.95 : 0.7 : 1,
          edgeOpacity: emphasized ? Math.max(0.85, nodeAlpha) : nodeAlpha,
          interactive: true,
          elevation: distant ? 0.06 : cluster.elevation,
        });
        if (!distant || selected === node.id || hovered === node.id || held.has(node.id)) bubbleNodes.add(node.id);
        if (animate) visual.phase = (visual.phase + dt * heartbeatBpm(working, score) / 60) % 1;
        const age = time - (arrivals.get(node.id) ?? -Infinity), arrival = age < 800 ? Math.exp(-age / 240) : 0;
        const wave = animate ? Math.max(working ? beat(visual.phase) * 0.35 : 0, arrival) : 0;
        visual.halo.material.color.set(agent ? statusColour(agent, theme) : count?.errors ? theme.error : count?.waiting ? theme.waiting : working ? theme.working : theme.accent);
        visual.halo.material.opacity = nodeAlpha * (working ? 0.08 + wave * 0.5 : wave * 0.4);
        visual.halo.scale.set(node.body.width + 14 + wave * 15, node.body.height + 14 + wave * 15, 1);
        if (animate && (working || arrival > 0.02)) continuous = true;
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
      const displayedScale = Math.abs(cluster.group.scale.x);
      const displayedBounds = {
        x: cluster.group.position.x + bounds.x * cluster.group.scale.x,
        y: cluster.group.position.y + bounds.y * cluster.group.scale.y,
        width: bounds.width * displayedScale,
        height: bounds.height * displayedScale,
      };
      const workingFloor = live && authoritative() && (summary?.working ?? 0) > 0 ? 0.12 : 0;
      const scaleMultiplier = displayedScale / Math.max(0.01, cluster.layout.scale);
      spatialProjects.push({
        projectId: id,
        screenCentre: { x: displayedBounds.x + displayedBounds.width / 2, y: displayedBounds.y + displayedBounds.height / 2 },
        screenBounds: displayedBounds,
        scaleMultiplier,
        viewDepth: viewDepthForScale(scaleMultiplier),
        energy: Math.max(workingFloor, intensity),
        visibility: cluster.opacity,
        elevation: cluster.elevation,
        inspected: heldDepth,
        focused: foreground,
      });
    }
    scene.updateMatrixWorld(true);
    // The field follows the presentation transform rather than the packed layout.
    // An unchanged influence list leaves its typed-array attributes untouched.
    ambient.updateProjects(spatialProjects);
    ambient.advanceTime(elapsedSeconds, animate && live);
    if (structuralTransition && !transitioning) { structuralTransition = false; continuous = true; }
    if (transitioning) { delegationDirty = true; continuous = true; }
    else if (delegationDirty) rebuildDelegations();
    for (const item of delegations.values()) {
      item.line.visible = item.arrow.visible = !transitioning;
      if (!transitioning && item.sourceSide) {
        const source = layout.nodes.get(item.route.source), target = layout.nodes.get(item.route.target);
        if (source && target) {
          const a = clusters.get(source.projectId)!.group, b = clusters.get(target.projectId)!.group, previous = item.transforms;
          if (previous[0] !== a.position.x || previous[1] !== a.position.y || previous[2] !== a.scale.x ||
            previous[3] !== b.position.x || previous[4] !== b.position.y || previous[5] !== b.scale.x) {
            updateMovingDelegation(item, transformNode(source), transformNode(target));
            updateLinePoints(item.line, item.route.points); updateLinePoints(item.arrow, arrowPoints(item.route));
            previous[0] = a.position.x; previous[1] = a.position.y; previous[2] = a.scale.x;
            previous[3] = b.position.x; previous[4] = b.position.y; previous[5] = b.scale.x;
          }
        }
      }
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
      overlay.positionNode(node.id, point.x, point.y, cluster.group.scale.x, presentationByNode.get(node.id)!, selected === node.id, focused?.id === node.id, ancestry.has(node.id), focusProject === cluster.layout.id);
    }
    reportAnchor(selected ? overlay.anchor(selected) : null);
    const screenRoutes: Point[][] = [];
    for (const cluster of clusters.values()) {
      for (const edge of cluster.layout.edges) screenRoutes.push(edge.points.map(location => ({ x: cluster.group.position.x + location.x * cluster.group.scale.x, y: cluster.group.position.y + location.y * cluster.group.scale.x })));
    }
    for (const item of delegations.values()) if (item.line.visible) screenRoutes.push([...item.route.points]);
    overlay.setRoutes(screenRoutes);
    const displayedBubbles = new Map<string, ActivityBubble>();
    for (const bubble of bubbles.current(now)) {
      const nodeId = layout.memberToDisplay.get(bubble.nodeId) ?? bubble.nodeId;
      if (!bubbleNodes.has(nodeId)) continue;
      const previous = displayedBubbles.get(nodeId);
      if (!previous || bubble.priority > previous.priority || bubble.priority === previous.priority && bubble.timestamp > previous.timestamp) {
        displayedBubbles.set(nodeId, { ...bubble, nodeId });
      }
    }
    const shown = [...displayedBubbles.values()];
    overlay.finishPositions(shown, width, height);
    renderComposite();
    graphAnimating = continuous && animate;
    nextBubbleExpiry = shown.reduce((expiry, bubble) => selected === bubble.nodeId || held.has(bubble.nodeId)
      ? expiry : Math.min(expiry, bubble.expiresAt), Infinity);
    scheduleFrame(now);
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
    ambient.resize(width, height, pixelRatio);
    if (sizeChanged) { rebuildLayout(); if (focused) rememberFocusAnchors(true); }
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
    if (document.fullscreenElement?.contains(parent)) return;
    event.preventDefault(); event.stopPropagation(); dismiss();
  };
  const onVisibility = () => {
    lastTime = 0;
    if (!canRender()) {
      if (frame) cancelAnimationFrame(frame); frame = 0;
      if (wakeTimer !== undefined) { clearTimeout(wakeTimer); wakeTimer = undefined; }
      clearPulses(); ambient.clearTransient(); bubbles.clear(); bubbles.discard(model.events, Date.now());
    }
    else {
      for (const members of held.values()) for (const id of members) bubbles.hold(id, true);
      if (selected) bubbles.hold(selected, true);
      requestFrame();
    }
  };
  const onMotion = () => {
    if (!motion() && !focused && !structuralTransition) for (const cluster of clusters.values()) cluster.depth = cluster.group.scale.x / cluster.layout.scale;
    lastTime = 0;
    clearPulses(); ambient.clearTransient(); requestFrame();
  };
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
      clusters.clear(); delegations.clear(); overlay.dispose(); ambient.dispose(); plane.dispose(); glowTexture.dispose(); renderer.dispose(); renderer.domElement.remove();
      parent.style.position = previousPosition; parent.style.overflow = previousOverflow;
  };
  try { resize(); acceptEvents(); } catch (error) { dispose(); throw error; }
  return {
    update(next) {
      if (disposed || failed) return;
      // Offline time is not visible animation time. Reconnection must resume
      // the retained grid phase without catching up the unscheduled interval.
      if (next.connection !== model.connection) {
        lastTime = 0;
        ambient.clearTransient(); clearPulses(); bubbles.clear();
        bubbles.discard(next.events, Date.now());
      }
      model = next;
      const nodeIds = new Set(model.nodes.map(node => node.id));
      activity.prune(nodeIds); bubbles.prune(nodeIds);
      try { rebuildLayout(); acceptEvents(); requestFrame(); }
      catch (error) { failed = true; options.onError?.(error instanceof Error ? error.message : "The graph layout is unavailable."); }
    },
    updateTheme(next) {
      theme = next; overlay.updateTheme(next); ambient.updateTheme(next);
      for (const pulse of pulses) {
        const node = model.nodes.find(candidate => candidate.id === pulse.nodeId);
        if (node) pulse.light.setColour(statusColour(node, next));
      }
      requestFrame();
    },
    setAppearance(next) {
      if (JSON.stringify(next) === JSON.stringify(appearance)) return;
      const previousDepth = policy.depthStrength;
      appearance = next; policy = appearancePolicy(next); ambient.setAppearance(next);
      if (policy.depthStrength !== previousDepth) {
        layoutEngine.setDepthReservation(0.1 * policy.depthStrength);
        delegationPlanDirty = true;
        rebuildLayout();
        // An explicit preference may change the permitted envelope. Resolve it
        // immediately when motion is paused, otherwise use the normal transition.
        for (const cluster of clusters.values()) cluster.depth = 1 +
          (scaleForElevation(cluster.fullViewElevation, cluster.depthRange) - 1) * policy.depthStrength;
        structuralTransition = true;
        if (focused) rememberFocusAnchors(true);
      }
      requestFrame();
    },
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

import * as THREE from "three";
import type { OverviewTheme } from "../../shared/renderer";
import type { OverviewCommunication } from "../../shared/model";
import type { Point, Rect } from "../geometry";
import { boundaryPoint, pointInRect, segmentIntersectsRect } from "../geometry";
import { pointAlongRoute, routeBetweenPoints, routedEdge, type RoutedEdge } from "../routing";
import { createGraphLine } from "./lines";
import type { Line2 } from "three/addons/lines/Line2.js";

const MAX_COMMUNICATIONS = 12;
const MAX_CONSUMED_IDS = 256;
const MAX_LIFETIME_SECONDS = 8;
const TRAVEL_SECONDS = 2.4;
const MAX_STEP_SECONDS = 10;

export type CommunicationInput = OverviewCommunication;
export type CommunicationEndpoint = Point;

interface ActiveCommunication {
  readonly pairKey: string;
  record: CommunicationInput;
  route: RoutedEdge;
  line: Line2;
  arrow: Line2;
  head: THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial>;
  age: number;
  lifetime: number;
  emphasized: boolean;
  routeKey: string;
  presentationKey: string;
}

const pairKeyFor = (record: Pick<CommunicationInput, "senderId" | "recipientId">) =>
  `${record.senderId}\u0000${record.recipientId}`;

function finiteRecord(record: CommunicationInput): boolean {
  return !!record.id && !!record.senderId && !!record.recipientId && record.senderId !== record.recipientId &&
    Number.isFinite(record.observedAt) && Number.isFinite(record.expiresAt);
}

function arrowPoints(route: RoutedEdge): Point[] {
  const tip = pointAlongRoute(route, 1);
  const before = pointAlongRoute(route, Math.max(0, 1 - 10 / Math.max(1, route.length)));
  const angle = Math.atan2(tip.y - before.y, tip.x - before.x);
  const back = { x: tip.x - Math.cos(angle) * 8, y: tip.y - Math.sin(angle) * 8 };
  return [
    { x: back.x - Math.sin(angle) * 3.5, y: back.y + Math.cos(angle) * 3.5 }, tip,
    { x: back.x + Math.sin(angle) * 3.5, y: back.y - Math.cos(angle) * 3.5 },
  ];
}

function routeKey(route: RoutedEdge): string {
  return route.points.map(point => `${point.x.toFixed(3)},${point.y.toFixed(3)}`).join(";");
}

/**
 * Fresh, directed communication routes. Recent history never enters this API:
 * consumed/dropped IDs and clear() make later filter/reveal updates non-replaying.
 */
export class Communications {
  readonly object = new THREE.Group();
  private readonly active = new Map<string, ActiveCommunication>();
  private readonly consumed = new Set<string>();
  private readonly headGeometry = new THREE.CircleGeometry(3, 16);
  private theme: OverviewTheme;
  private disposed = false;
  private readonly diagnostics = { active: 0, moving: 0, coalesced: 0, dropped: 0 };

  constructor(scene: THREE.Scene, theme: OverviewTheme) {
    this.theme = theme;
    this.object.name = "paseo-overview-communications";
    this.object.userData.overviewCommunications = true;
    this.object.userData.overviewCommunicationState = this.diagnostics;
    scene.add(this.object);
  }

  private remember(id: string): void {
    if (this.consumed.has(id)) return;
    this.consumed.add(id);
    // The renderer owns the durable discard set. This small local ring only
    // absorbs duplicate delivery between its updates, including across clear().
    if (this.consumed.size > MAX_CONSUMED_IDS) this.consumed.delete(this.consumed.values().next().value!);
  }

  private colour(kind: CommunicationInput["kind"]): string {
    if (kind === "errored") return this.theme.error;
    if (kind === "permission-required") return this.theme.waiting;
    return this.theme.working;
  }

  private sourceRoute(
    record: CommunicationInput,
    endpoints: ReadonlyMap<string, CommunicationEndpoint>,
    obstacles: readonly Rect[],
    viewport?: Rect,
    previous?: RoutedEdge,
  ): RoutedEdge | null {
    const centre = endpoints.get(record.senderId), destination = endpoints.get(record.recipientId);
    if (!centre || !destination) return null;
    const sourceBounds = obstacles.find(obstacle => pointInRect(centre, obstacle));
    const targetBounds = obstacles.find(obstacle => pointInRect(destination, obstacle));
    // Endpoints are deliberately centres. Clip only their own containing node
    // bounds; every unrelated body/label obstacle stays authoritative.
    const from = sourceBounds ? boundaryPoint(sourceBounds, destination, 2) : centre;
    const to = targetBounds ? boundaryPoint(targetBounds, centre, 2) : destination;
    const unrelated = obstacles.filter(obstacle => obstacle !== sourceBounds && obstacle !== targetBounds &&
      !pointInRect(from, obstacle) && !pointInRect(to, obstacle));
    const make = (points: readonly Point[]) => routedEdge({
      id: `communication:${record.id}`, source: record.senderId, target: record.recipientId,
      kind: "delegation", projectId: null,
      segments: points.slice(1).map((point, index) => ({ kind: "line", from: points[index]!, to: point })),
    });
    const clear = (points: readonly Point[]) => points.slice(1).every((point, index) =>
      unrelated.every(obstacle => !segmentIntersectsRect(points[index]!, point, obstacle)));
    // Focus/depth easing should move the existing endpoints, not re-run a full
    // corridor search each frame. Replan only when its retained path is blocked.
    if (previous) {
      const moved = [from, ...previous.points.slice(1, -1), to];
      if (clear(moved)) return make(moved);
    }
    if (clear([from, to])) return make([from, to]);
    const points = viewport ? routeBetweenPoints(from, to, unrelated, viewport) : null;
    return points && points.length > 1 ? make(points) : null;
  }

  private remove(pair: ActiveCommunication): void {
    if (this.active.get(pair.pairKey) !== pair) return;
    this.active.delete(pair.pairKey);
    pair.line.removeFromParent(); pair.arrow.removeFromParent(); pair.head.removeFromParent();
    pair.line.geometry.dispose(); pair.line.material.dispose();
    pair.arrow.geometry.dispose(); pair.arrow.material.dispose();
    pair.head.material.dispose();
  }

  private create(record: CommunicationInput, route: RoutedEdge, nowMs: number): ActiveCommunication {
    const resolved = route;
    const colour = this.colour(record.kind);
    const line = createGraphLine(resolved.points, colour, 1.75, 14);
    const arrow = createGraphLine(arrowPoints(resolved), colour, 1.9, 15);
    const head = new THREE.Mesh(this.headGeometry, new THREE.MeshBasicMaterial({
      color: colour, transparent: true, opacity: 0.95, depthWrite: false, toneMapped: false,
    }));
    line.name = `overview-communication:${record.id}`;
    arrow.name = `overview-communication-direction:${record.id}`;
    head.name = `overview-communication-head:${record.id}`;
    line.frustumCulled = arrow.frustumCulled = head.frustumCulled = false;
    line.renderOrder = 4; arrow.renderOrder = 5; head.renderOrder = 6;
    head.position.z = 16;
    this.object.add(line, arrow, head);
    return {
      pairKey: pairKeyFor(record), record, route: resolved, line, arrow, head,
      age: 0, lifetime: Math.max(0, Math.min(MAX_LIFETIME_SECONDS, (record.expiresAt - nowMs) / 1000)),
      emphasized: false, routeKey: "", presentationKey: "",
    };
  }

  private refresh(pair: ActiveCommunication): void {
    const geometryKey = routeKey(pair.route);
    if (geometryKey !== pair.routeKey) {
      pair.line.geometry.setPositions(pair.route.points.flatMap(point => [point.x, point.y, 14]));
      pair.line.computeLineDistances();
      pair.arrow.geometry.setPositions(arrowPoints(pair.route).flatMap(point => [point.x, point.y, 15]));
      pair.arrow.computeLineDistances();
      pair.routeKey = geometryKey;
    }
    const fade = Math.max(0, Math.min(1, pair.lifetime - pair.age));
    const progress = Math.min(1, pair.age / TRAVEL_SECONDS);
    const position = pointAlongRoute(pair.route, progress);
    pair.head.position.set(position.x, position.y, 16);
    pair.head.visible = progress < 1 && fade > 0;
    const presentationKey = `${pair.record.kind}:${pair.emphasized}:${fade.toFixed(3)}`;
    if (presentationKey === pair.presentationKey) return;
    pair.presentationKey = presentationKey;
    const colour = this.colour(pair.record.kind);
    pair.line.material.color.set(colour); pair.arrow.material.color.set(colour); pair.head.material.color.set(colour);
    pair.line.material.opacity = (pair.emphasized ? 0.92 : 0.56) * fade;
    pair.arrow.material.opacity = (pair.emphasized ? 1 : 0.82) * fade;
    pair.head.material.opacity = 0.95 * fade;
  }

  /**
   * Accept only newly observed records; an empty call still refreshes current
   * endpoints/routes. Ineligible records are consumed rather than deferred.
   */
  update(
    records: readonly CommunicationInput[],
    endpoints: ReadonlyMap<string, CommunicationEndpoint>,
    discardedIds: ReadonlySet<string>,
    emphasizedIds: ReadonlySet<string>,
    obstacles: readonly Rect[] = [],
    viewport?: Rect,
    nowMs = Date.now(),
  ): boolean {
    if (this.disposed) return false;
    const before = this.active.size;
    const beforeGeometry = [...this.active.values()].map(pair =>
      `${pair.record.id}:${pair.routeKey}:${pair.presentationKey}`).join("|");
    for (const pair of [...this.active.values()]) {
      if (pair.record.expiresAt <= nowMs || !endpoints.has(pair.record.senderId) || !endpoints.has(pair.record.recipientId)) {
        this.remember(pair.record.id); this.remove(pair);
      }
    }

    const latest = new Map<string, CommunicationInput>();
    for (const pair of this.active.values()) latest.set(pair.pairKey, pair.record);
    for (const source of records) {
      if (!finiteRecord(source) || this.consumed.has(source.id) || discardedIds.has(source.id)) continue;
      this.remember(source.id);
      const record = { ...source, expiresAt: Math.min(source.expiresAt, source.observedAt + MAX_LIFETIME_SECONDS * 1000) };
      if (record.expiresAt <= nowMs || !endpoints.has(record.senderId) || !endpoints.has(record.recipientId)) {
        this.diagnostics.dropped++; continue;
      }
      const key = pairKeyFor(record), previous = latest.get(key);
      if (previous) this.diagnostics.coalesced++;
      if (!previous || record.observedAt >= previous.observedAt) latest.set(key, record);
    }

    const candidates = [...latest.entries()].sort(([, a], [, b]) => {
      const aImportant = emphasizedIds.has(a.senderId) || emphasizedIds.has(a.recipientId);
      const bImportant = emphasizedIds.has(b.senderId) || emphasizedIds.has(b.recipientId);
      return Number(bImportant) - Number(aImportant) || b.observedAt - a.observedAt || a.id.localeCompare(b.id);
    }).slice(0, MAX_COMMUNICATIONS);
    const retained = new Set(candidates.map(([key]) => key));
    for (const pair of [...this.active.values()]) if (!retained.has(pair.pairKey)) {
      this.remember(pair.record.id); this.remove(pair);
    }

    for (const [key, record] of candidates) {
      let pair = this.active.get(key);
      const route = this.sourceRoute(record, endpoints, obstacles, viewport, pair?.route);
      if (!route) { if (pair) this.remove(pair); this.diagnostics.dropped++; continue; }
      if (!pair) {
        pair = this.create(record, route, nowMs);
        this.active.set(key, pair);
      } else if (pair.record.id !== record.id) {
        pair.record = record;
        pair.age = 0;
        pair.lifetime = Math.max(0, Math.min(MAX_LIFETIME_SECONDS, (record.expiresAt - nowMs) / 1000));
        pair.presentationKey = "";
      }
      pair.route = route;
      pair.emphasized = emphasizedIds.has(record.senderId) || emphasizedIds.has(record.recipientId);
      this.refresh(pair);
    }
    this.updateDiagnostics();
    const afterGeometry = [...this.active.values()].map(pair =>
      `${pair.record.id}:${pair.routeKey}:${pair.presentationKey}`).join("|");
    return before !== this.active.size || beforeGeometry !== afterGeometry ||
      [...this.active.values()].some(pair => pair.head.visible);
  }

  /** Integrated visual time: stopped input performs no geometry or material work. */
  advance(deltaSeconds: number, moving: boolean): boolean {
    if (this.disposed || !moving || !this.active.size) return false;
    const step = Math.max(0, Math.min(MAX_STEP_SECONDS, Number.isFinite(deltaSeconds) ? deltaSeconds : 0));
    if (step <= 0) return false;
    for (const pair of [...this.active.values()]) {
      pair.age += step;
      if (pair.age >= pair.lifetime) { this.remember(pair.record.id); this.remove(pair); continue; }
      this.refresh(pair);
    }
    this.updateDiagnostics();
    return true;
  }

  clearHosts(hostIds: ReadonlySet<string>): void {
    if (this.disposed || hostIds.size === 0) return;
    for (const pair of [...this.active.values()]) {
      if (hostIds.has(pair.record.senderHostId) || hostIds.has(pair.record.recipientHostId)) {
        this.remember(pair.record.id); this.remove(pair);
      }
    }
    this.updateDiagnostics();
  }

  /** Consume outstanding work so a later reveal cannot replay it. */
  clear(): void {
    if (this.disposed) return;
    for (const pair of [...this.active.values()]) { this.remember(pair.record.id); this.remove(pair); }
    this.updateDiagnostics();
  }

  private updateDiagnostics(): void {
    this.diagnostics.active = this.active.size;
    this.diagnostics.moving = [...this.active.values()].reduce((count, pair) => count + Number(pair.age < TRAVEL_SECONDS), 0);
  }

  isAnimating(): boolean { return !this.disposed && this.active.size > 0; }
  hasPending(): boolean { return this.isAnimating(); }

  updateTheme(theme: OverviewTheme): void {
    if (this.disposed) return;
    this.theme = theme;
    for (const pair of this.active.values()) { pair.presentationKey = ""; this.refresh(pair); }
  }

  dispose(): void {
    if (this.disposed) return;
    this.clear();
    this.disposed = true;
    this.object.removeFromParent();
    this.headGeometry.dispose();
    this.consumed.clear();
  }
}

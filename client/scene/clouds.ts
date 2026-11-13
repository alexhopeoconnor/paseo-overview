import * as THREE from "three";
import { gridPalette, isDarkBackground } from "../appearance";
import type { OverviewTheme } from "../../shared/renderer";
import type { ProjectSpatialPresentation } from "./spatial";
import { AMBIENT_PHASE_PERIOD_SECONDS, cloudFragmentShader, cloudLineFragmentShader, cloudVertexShader } from "./ambient-shader";
import type { OverviewProjection } from "./projection";
import type { PerspectiveRoom } from "./room";

export const CLOUD_GLOBAL_POINT_BUDGET = 4096;
export const CLOUD_PROJECT_POINT_LIMIT = 64;
const CLOUD_BIN_COLUMNS = 64;
const CLOUD_BIN_ROWS = CLOUD_GLOBAL_POINT_BUDGET / CLOUD_BIN_COLUMNS;
const CLOUD_ACTIVITY_TIME_CONSTANT = 0.45;
const CLOUD_ARRIVAL_TIME_CONSTANT = 0.8;

export function cloudSeed(projectId: string): number {
  let hash = 2166136261;
  for (let index = 0; index < projectId.length; index++) {
    hash ^= projectId.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Normal per-project LOD. Larger directories switch to bounded screen bins. */
export function cloudPointsPerProject(projectCount: number): number {
  if (projectCount <= 0 || projectCount > CLOUD_GLOBAL_POINT_BUDGET) return 0;
  return Math.max(1, Math.min(CLOUD_PROJECT_POINT_LIMIT, Math.floor(CLOUD_GLOBAL_POINT_BUDGET / projectCount)));
}

/** Hard point-allocation ceiling for both individual clouds and screen bins. */
export function cloudPointBufferBudget(projectCount: number): number {
  return projectCount <= 0 ? 0 : Math.min(CLOUD_GLOBAL_POINT_BUDGET, projectCount * CLOUD_PROJECT_POINT_LIMIT);
}

function bounded(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

function randomAt(seed: number, index: number, channel: number): number {
  let value = (seed ^ Math.imul(index + 1, 0x9e3779b1) ^ Math.imul(channel + 11, 0x85ebca6b)) >>> 0;
  value ^= value >>> 16; value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15; value = Math.imul(value, 0x846ca68b);
  value ^= value >>> 16;
  return (value >>> 0) / 4294967296;
}

interface CloudState {
  project: ProjectSpatialPresentation;
  seed: number;
  offsets: Float32Array;
  energy: number;
  targetEnergy: number;
  focusEnergy: number;
  arrival: number;
  arrivalEnergy: number;
  links: Map<number, Int16Array>;
}

interface CloudSlot { state: CloudState; start: number; lineStart: number; count: number }

interface CloudAttributes {
  position: Float32Array;
  size: Float32Array;
  energy: Float32Array;
  alpha: Float32Array;
  rim: Float32Array;
  seed: Float32Array;
}

interface AggregateBin {
  count: number;
  x: number;
  y: number;
  z: number;
  energy: number;
  visibility: number;
}

const POSITION_DIRTY = 1, SIZE_DIRTY = 2, ENERGY_DIRTY = 4, ALPHA_DIRTY = 8, RIM_DIRTY = 16, SEED_DIRTY = 32;
const attributeFlags = [
  ["position", POSITION_DIRTY], ["aCloudSize", SIZE_DIRTY], ["aCloudEnergy", ENERGY_DIRTY],
  ["aCloudAlpha", ALPHA_DIRTY], ["aCloudRim", RIM_DIRTY], ["aCloudSeed", SEED_DIRTY],
] as const;

function attributes(vertexCount: number): CloudAttributes {
  return {
    position: new Float32Array(vertexCount * 3), size: new Float32Array(vertexCount),
    energy: new Float32Array(vertexCount), alpha: new Float32Array(vertexCount),
    rim: new Float32Array(vertexCount), seed: new Float32Array(vertexCount),
  };
}

function geometryFor(values: CloudAttributes): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(values.position, 3));
  geometry.setAttribute("aCloudSize", new THREE.BufferAttribute(values.size, 1));
  geometry.setAttribute("aCloudEnergy", new THREE.BufferAttribute(values.energy, 1));
  geometry.setAttribute("aCloudAlpha", new THREE.BufferAttribute(values.alpha, 1));
  geometry.setAttribute("aCloudRim", new THREE.BufferAttribute(values.rim, 1));
  geometry.setAttribute("aCloudSeed", new THREE.BufferAttribute(values.seed, 1));
  return geometry;
}

/** Compare against the retained GPU input before setting an upload version. */
function store(array: Float32Array, index: number, value: number, flag: number): number {
  value = Math.fround(value);
  if (array[index] === value) return 0;
  array[index] = value;
  return flag;
}

function markUpdates(geometry: THREE.BufferGeometry, dirty: number): void {
  if (!dirty) return;
  for (const [name, flag] of attributeFlags) {
    const attribute = geometry.getAttribute(name);
    if (attribute && dirty & flag) attribute.needsUpdate = true;
  }
}

function ease(current: number, target: number, seconds: number): number {
  const next = current + (target - current) * (1 - Math.exp(-seconds / CLOUD_ACTIVITY_TIME_CONSTANT));
  return Math.abs(next - target) < 0.0001 ? target : next;
}

/** Normal projects get individual clouds; overflow projects share deterministic screen bins. */
export class ProjectParticleClouds {
  readonly points: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
  readonly lines: THREE.LineSegments<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private readonly states = new Map<string, CloudState>();
  private slots: CloudSlot[] = [];
  private aggregateBins: number[] = [];
  private aggregated = false;
  private pointValues = attributes(0);
  private lineValues = attributes(0);
  private pointGeometry = new THREE.BufferGeometry();
  private lineGeometry = new THREE.BufferGeometry();
  private layoutKey = "";
  private phase = 0;
  private disposed = false;

  constructor(scene: THREE.Scene, private readonly projection: OverviewProjection, private readonly surface: PerspectiveRoom, theme: OverviewTheme) {
    const pointMaterial = this.material("paseo-overview-clouds", cloudFragmentShader);
    const lineMaterial = this.material("paseo-overview-cloud-edges", cloudLineFragmentShader);
    this.points = new THREE.Points(this.pointGeometry, pointMaterial);
    this.lines = new THREE.LineSegments(this.lineGeometry, lineMaterial);
    this.points.name = "overview-project-clouds";
    this.lines.name = "overview-project-cloud-edges";
    this.points.userData.overviewClouds = true;
    this.lines.userData.overviewClouds = true;
    this.points.frustumCulled = this.lines.frustumCulled = false;
    this.points.renderOrder = -10; this.lines.renderOrder = -20;
    scene.add(this.lines, this.points);
    this.updateTheme(theme);
  }

  private material(name: string, fragmentShader: string): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      name,
      vertexShader: cloudVertexShader,
      fragmentShader,
      uniforms: {
        uPhase: { value: 0 }, uPixelRatio: { value: 1 }, uViewportHeight: { value: 1 },
        uInk: { value: new THREE.Color() }, uEnergy: { value: new THREE.Color() }, uRim: { value: new THREE.Color() },
        uOpacity: { value: 1 },
      },
      transparent: true,
      depthTest: true,
      depthWrite: false,
      toneMapped: false,
      blending: THREE.NormalBlending,
    });
  }

  private stateFor(project: ProjectSpatialPresentation): CloudState {
    const seed = cloudSeed(project.projectId), offsets = new Float32Array(CLOUD_PROJECT_POINT_LIMIT * 3);
    for (let index = 0; index < CLOUD_PROJECT_POINT_LIMIT; index++) {
      const azimuth = randomAt(seed, index, 0) * Math.PI * 2;
      const vertical = randomAt(seed, index, 1) * 2 - 1;
      const radial = Math.cbrt(randomAt(seed, index, 2));
      const horizontal = Math.sqrt(Math.max(0, 1 - vertical * vertical));
      offsets[index * 3] = Math.cos(azimuth) * horizontal * radial;
      offsets[index * 3 + 1] = vertical * radial;
      offsets[index * 3 + 2] = Math.sin(azimuth) * horizontal * radial;
    }
    return { project, seed, offsets, energy: 0, targetEnergy: bounded(project.energy), focusEnergy: 0, arrival: 0, arrivalEnergy: 0, links: new Map() };
  }

  private linksFor(state: CloudState, count: number): Int16Array {
    const cached = state.links.get(count);
    if (cached) return cached;
    const links: number[] = [];
    // This nearest-neighbour calculation is cached per stable LOD, never done
    // in an animation frame, and uses only stable local particle offsets.
    for (let index = 0; index + 1 < count; index++) {
      const nearest: { distance: number; other: number }[] = [];
      for (let other = index + 1; other < count; other++) {
        let distance = 0;
        for (let axis = 0; axis < 3; axis++) {
          const delta = state.offsets[index * 3 + axis]! - state.offsets[other * 3 + axis]!;
          distance += delta * delta;
        }
        nearest.push({ distance, other });
      }
      nearest.sort((a, b) => a.distance - b.distance || a.other - b.other);
      for (const candidate of nearest.slice(0, count < 12 ? 1 : 2)) links.push(index, candidate.other);
    }
    const result = new Int16Array(links);
    state.links.set(count, result);
    return result;
  }

  private replaceGeometry(pointCount: number, lineCount: number): void {
    this.pointValues = attributes(pointCount);
    this.lineValues = attributes(lineCount);
    this.pointGeometry.dispose(); this.lineGeometry.dispose();
    this.pointGeometry = geometryFor(this.pointValues); this.lineGeometry = geometryFor(this.lineValues);
    this.points.geometry = this.pointGeometry; this.lines.geometry = this.lineGeometry;
  }

  private rebuildLayout(count: number): void {
    const ids = [...this.states.keys()].sort();
    let lineStart = 0;
    this.slots = ids.map((id, index) => {
      const state = this.states.get(id)!;
      const slot = { state, start: index * count, lineStart, count };
      lineStart += this.linksFor(state, count).length;
      return slot;
    });
    this.replaceGeometry(this.slots.length * count, lineStart);
  }

  private screenBin(project: ProjectSpatialPresentation): number {
    const column = Math.min(CLOUD_BIN_COLUMNS - 1, Math.max(0, Math.floor(project.screenCentre.x / this.projection.width * CLOUD_BIN_COLUMNS)));
    const row = Math.min(CLOUD_BIN_ROWS - 1, Math.max(0, Math.floor(project.screenCentre.y / this.projection.height * CLOUD_BIN_ROWS)));
    return row * CLOUD_BIN_COLUMNS + column;
  }

  private syncAggregateLayout(): void {
    const bins = [...new Set([...this.states.values()].map(state => this.screenBin(state.project)))].sort((a, b) => a - b);
    const key = `bins:${bins.join(",")}`;
    this.aggregateBins = bins;
    if (key === this.layoutKey) return;
    this.layoutKey = key;
    this.replaceGeometry(bins.length, 0);
  }

  updateProjects(projects: readonly ProjectSpatialPresentation[]): void {
    if (this.disposed) return;
    const present = new Set(projects.map(project => project.projectId));
    for (const id of this.states.keys()) if (!present.has(id)) this.states.delete(id);
    for (const project of projects) {
      let state = this.states.get(project.projectId);
      if (!state) { state = this.stateFor(project); this.states.set(project.projectId, state); }
      state.project = { ...project, screenCentre: { ...project.screenCentre }, screenBounds: { ...project.screenBounds } };
      // Targets may refresh while paused; displayed sustained energy changes
      // only in advance(moving=true). Explicit focus may redraw immediately.
      state.targetEnergy = bounded(project.energy);
      state.focusEnergy = project.focused ? 0.24 : project.inspected ? 0.12 : 0;
    }
    this.aggregated = projects.length > CLOUD_GLOBAL_POINT_BUDGET;
    if (this.aggregated) {
      this.slots = [];
      this.syncAggregateLayout();
    } else {
      this.aggregateBins = [];
      const count = cloudPointsPerProject(projects.length);
      const key = `projects:${count}:${[...this.states.keys()].sort().join("\u0000")}`;
      if (key !== this.layoutKey) { this.layoutKey = key; this.rebuildLayout(count); }
    }
    this.updateWorld();
  }

  private energyFor(state: CloudState): number {
    return Math.max(state.energy, state.focusEnergy, state.arrival * state.arrivalEnergy);
  }

  private write(values: CloudAttributes, vertex: number, state: CloudState, localIndex: number, energy: number, alpha: number, line: boolean): number {
    const project = state.project;
    const worldPerPixel = this.projection.worldUnitsPerPixel(project.viewDepth);
    const energyScale = 0.94 + energy * 0.18;
    const radiusX = Math.max(52, Math.abs(project.screenBounds.width) * 0.56) * worldPerPixel * energyScale;
    const radiusY = Math.max(46, Math.abs(project.screenBounds.height) * 0.56) * worldPerPixel * energyScale;
    const radiusZ = (radiusX + radiusY) * 0.38;
    const centre = this.surface.projectPoint(project.screenCentre, project.viewDepth);
    const local = localIndex * 3, target = vertex * 3;
    let dirty = 0;
    dirty |= store(values.position, target, centre.x + state.offsets[local]! * radiusX, POSITION_DIRTY);
    dirty |= store(values.position, target + 1, centre.y + state.offsets[local + 1]! * radiusY, POSITION_DIRTY);
    dirty |= store(values.position, target + 2, centre.z + state.offsets[local + 2]! * radiusZ, POSITION_DIRTY);
    dirty |= store(values.size, vertex, (0.75 + randomAt(state.seed, localIndex, 3) * 1.35) * (0.8 + energy * 0.55) * worldPerPixel, SIZE_DIRTY);
    dirty |= store(values.energy, vertex, energy, ENERGY_DIRTY);
    dirty |= store(values.alpha, vertex, alpha * (line ? 1 : 0.68 + randomAt(state.seed, localIndex, 4) * 0.32), ALPHA_DIRTY);
    dirty |= store(values.rim, vertex, randomAt(state.seed, localIndex, 5), RIM_DIRTY);
    dirty |= store(values.seed, vertex, randomAt(state.seed, localIndex, 6), SEED_DIRTY);
    return dirty;
  }

  private updateAggregateWorld(): void {
    const bins = new Map<number, AggregateBin>();
    for (const state of this.states.values()) {
      const index = this.screenBin(state.project);
      const centre = this.surface.projectPoint(state.project.screenCentre, state.project.viewDepth);
      const energy = this.energyFor(state);
      let bin = bins.get(index);
      if (!bin) { bin = { count: 0, x: 0, y: 0, z: 0, energy: 0, visibility: 0 }; bins.set(index, bin); }
      bin.count++;
      bin.x += centre.x; bin.y += centre.y; bin.z += centre.z;
      bin.energy += energy; bin.visibility += bounded(state.project.visibility);
    }
    let dirty = 0;
    this.aggregateBins.forEach((index, vertex) => {
      const bin = bins.get(index)!;
      const energy = bin.energy / bin.count, visibility = bin.visibility / bin.count;
      const x = bin.x / bin.count, y = bin.y / bin.count, z = bin.z / bin.count;
      const worldPerPixel = this.projection.worldUnitsPerPixel(-z);
      dirty |= store(this.pointValues.position, vertex * 3, x, POSITION_DIRTY);
      dirty |= store(this.pointValues.position, vertex * 3 + 1, y, POSITION_DIRTY);
      dirty |= store(this.pointValues.position, vertex * 3 + 2, z, POSITION_DIRTY);
      dirty |= store(this.pointValues.size, vertex, (1.4 + energy * 0.9) * worldPerPixel, SIZE_DIRTY);
      dirty |= store(this.pointValues.energy, vertex, energy, ENERGY_DIRTY);
      dirty |= store(this.pointValues.alpha, vertex, visibility * 0.46 * (0.24 + energy * 0.76) * 0.85, ALPHA_DIRTY);
      dirty |= store(this.pointValues.rim, vertex, randomAt(index, 0, 5), RIM_DIRTY);
      dirty |= store(this.pointValues.seed, vertex, randomAt(index, 0, 6), SEED_DIRTY);
    });
    markUpdates(this.pointGeometry, dirty);
    markUpdates(this.lineGeometry, 0);
  }

  private updateWorld(): void {
    if (this.aggregated) { this.updateAggregateWorld(); return; }
    let pointDirty = 0, lineDirty = 0;
    for (const slot of this.slots) {
      const { state, start, count } = slot, project = state.project;
      const energy = this.energyFor(state);
      // Energy deliberately changes contrast and volume, leaving quiet clouds
      // faint while keeping active ones recognisable beneath the foreground.
      const pointAlpha = bounded(project.visibility) * 0.46 * (0.24 + energy * 0.76);
      for (let index = 0; index < count; index++) pointDirty |= this.write(this.pointValues, start + index, state, index, energy, pointAlpha, false);
      const links = this.linksFor(state, count);
      let vertex = slot.lineStart;
      for (let link = 0; link < links.length; link += 2) {
        lineDirty |= this.write(this.lineValues, vertex++, state, links[link]!, energy, pointAlpha, true);
        lineDirty |= this.write(this.lineValues, vertex++, state, links[link + 1]!, energy, pointAlpha, true);
      }
    }
    markUpdates(this.pointGeometry, pointDirty);
    markUpdates(this.lineGeometry, lineDirty);
  }

  resize(pixelRatio: number): void {
    if (this.disposed) return;
    const ratio = Math.max(1, Number.isFinite(pixelRatio) ? pixelRatio : 1);
    for (const material of [this.points.material, this.lines.material]) {
      material.uniforms.uPixelRatio!.value = ratio;
      material.uniforms.uViewportHeight!.value = this.projection.height * ratio;
    }
    if (this.aggregated) this.syncAggregateLayout();
    this.updateWorld();
  }

  advance(seconds: number, moving: boolean, rate: number): void {
    if (this.disposed) return;
    const elapsed = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
    if (!moving || elapsed === 0) return;
    const safeRate = Math.max(0, Number.isFinite(rate) ? rate : 1);
    const step = (elapsed % AMBIENT_PHASE_PERIOD_SECONDS) * safeRate;
    this.phase = (this.phase + step % AMBIENT_PHASE_PERIOD_SECONDS) % AMBIENT_PHASE_PERIOD_SECONDS;
    for (const material of [this.points.material, this.lines.material]) material.uniforms.uPhase!.value = this.phase;
    let energyChanged = false;
    for (const state of this.states.values()) {
      const energy = ease(state.energy, state.targetEnergy, elapsed);
      const arrival = state.arrival > 0 ? Math.max(0, state.arrival * Math.exp(-elapsed / CLOUD_ARRIVAL_TIME_CONSTANT)) : 0;
      energyChanged ||= energy !== state.energy || arrival !== state.arrival;
      state.energy = energy; state.arrival = arrival < 0.001 ? 0 : arrival;
    }
    if (energyChanged) this.updateWorld();
  }

  arrive(projectId: string, energy: number): void {
    const state = this.states.get(projectId);
    if (!state || this.disposed) return;
    state.arrival = 1;
    state.arrivalEnergy = bounded(energy);
    this.updateWorld();
  }

  clearTransient(): void {
    for (const state of this.states.values()) { state.arrival = 0; state.arrivalEnergy = 0; }
    if (!this.disposed) this.updateWorld();
  }

  updateTheme(theme: OverviewTheme): void {
    if (this.disposed) return;
    const palette = gridPalette(theme), dark = isDarkBackground(theme.background);
    for (const material of [this.points.material, this.lines.material]) {
      (material.uniforms.uInk!.value as THREE.Color).set(palette.line);
      (material.uniforms.uEnergy!.value as THREE.Color).set(palette.glow);
      (material.uniforms.uRim!.value as THREE.Color).set(palette.shade);
    }
    this.points.material.uniforms.uOpacity!.value = dark ? 0.62 : 0.5;
    this.lines.material.uniforms.uOpacity!.value = dark ? 0.62 : 0.5;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.points.removeFromParent(); this.lines.removeFromParent();
    this.pointGeometry.dispose(); this.lineGeometry.dispose();
    this.points.material.dispose(); this.lines.material.dispose();
    this.states.clear(); this.slots = []; this.aggregateBins = [];
  }
}

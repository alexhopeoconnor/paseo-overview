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
const CLOUD_STATE_WIDTH = 4;

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

interface CloudFieldState {
  valid: boolean;
  screenX: number;
  screenY: number;
  energy: number;
  visibility: number;
}

interface CloudState {
  project: ProjectSpatialPresentation;
  /** Reused scalar input for the room field's exact display values. */
  fieldProject: ProjectSpatialPresentation;
  field: CloudFieldState;
  seed: number;
  offsets: Float32Array;
  energy: number;
  targetEnergy: number;
  focusEnergy: number;
  arrival: number;
  arrivalEnergy: number;
  phase: number;
  links: Map<number, Int16Array>;
  seen: number;
}

interface CloudSlot { state: CloudState; start: number; count: number }

interface CloudAttributes {
  position: Float32Array;
  index: Float32Array;
  size: Float32Array;
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
  phase: number;
}

function attributes(vertexCount: number): CloudAttributes {
  return {
    position: new Float32Array(vertexCount * 3), index: new Float32Array(vertexCount),
    size: new Float32Array(vertexCount), alpha: new Float32Array(vertexCount),
    rim: new Float32Array(vertexCount), seed: new Float32Array(vertexCount),
  };
}

function setAttributes(geometry: THREE.BufferGeometry, values: CloudAttributes): void {
  geometry.setAttribute("position", new THREE.BufferAttribute(values.position, 3));
  geometry.setAttribute("aCloudIndex", new THREE.BufferAttribute(values.index, 1));
  geometry.setAttribute("aCloudSize", new THREE.BufferAttribute(values.size, 1));
  geometry.setAttribute("aCloudAlpha", new THREE.BufferAttribute(values.alpha, 1));
  geometry.setAttribute("aCloudRim", new THREE.BufferAttribute(values.rim, 1));
  geometry.setAttribute("aCloudSeed", new THREE.BufferAttribute(values.seed, 1));
}

function shareAttributes(target: THREE.BufferGeometry, source: THREE.BufferGeometry): void {
  for (const name of ["position", "aCloudIndex", "aCloudSize", "aCloudAlpha", "aCloudRim", "aCloudSeed"]) {
    target.setAttribute(name, source.getAttribute(name));
  }
}

function store(data: Float32Array, index: number, value: number): boolean {
  value = Math.fround(value);
  if (data[index] === value) return false;
  data[index] = value;
  return true;
}

function sameNumber(left: number, right: number): boolean {
  return Object.is(left, right);
}

function ease(current: number, target: number, seconds: number): number {
  const next = current + (target - current) * (1 - Math.exp(-seconds / CLOUD_ACTIVITY_TIME_CONSTANT));
  return Math.abs(next - target) < 0.0001 ? target : next;
}

/** Static local particles + one bounded per-project texture, never per-particle world rewrites. */
export class ProjectParticleClouds {
  readonly points: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
  readonly volume: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
  readonly lines: THREE.LineSegments<THREE.BufferGeometry, THREE.ShaderMaterial>;
  readonly stateData = new Float32Array(CLOUD_STATE_WIDTH * CLOUD_GLOBAL_POINT_BUDGET * 4);
  readonly stateTexture: THREE.DataTexture;
  private readonly states = new Map<string, CloudState>();
  private slots: CloudSlot[] = [];
  private aggregateBins: number[] = [];
  private aggregated = false;
  private pointValues = attributes(0);
  private pointGeometry = new THREE.BufferGeometry();
  private lineGeometry = new THREE.BufferGeometry();
  private layoutKey = "";
  private layoutDirty = false;
  private stateDirty = false;
  private fieldDirty = false;
  private projectPointCount = 0;
  private inputGeneration = 0;
  private readonly fieldProjects: ProjectSpatialPresentation[] = [];
  private phase = 0;
  private readonly commonUniforms: Record<string, THREE.IUniform>;
  private disposed = false;

  constructor(scene: THREE.Scene, private readonly projection: OverviewProjection, private readonly surface: PerspectiveRoom, theme: OverviewTheme) {
    this.stateTexture = new THREE.DataTexture(this.stateData, CLOUD_STATE_WIDTH, CLOUD_GLOBAL_POINT_BUDGET, THREE.RGBAFormat, THREE.FloatType);
    this.stateTexture.name = "overview-cloud-project-state";
    this.stateTexture.minFilter = this.stateTexture.magFilter = THREE.NearestFilter;
    this.stateTexture.generateMipmaps = false;
    this.stateTexture.flipY = false;
    this.stateTexture.unpackAlignment = 1;
    this.stateTexture.colorSpace = THREE.NoColorSpace;
    this.commonUniforms = {
      uPhase: { value: 0 }, uPixelRatio: { value: 1 }, uViewportHeight: { value: 1 },
      uCloudStates: { value: this.stateTexture }, uCloudStateSize: { value: new THREE.Vector2(CLOUD_STATE_WIDTH, CLOUD_GLOBAL_POINT_BUDGET) },
      uInk: { value: new THREE.Color() }, uEnergy: { value: new THREE.Color() },
      uShade: { value: new THREE.Color() }, uRim: { value: new THREE.Color() }, uOpacity: { value: 1 },
    };
    const pointMaterial = this.material("paseo-overview-clouds", cloudFragmentShader, false);
    const volumeMaterial = this.material("paseo-overview-cloud-volume", cloudFragmentShader, true);
    const lineMaterial = this.material("paseo-overview-cloud-edges", cloudLineFragmentShader, false);
    this.points = new THREE.Points(this.pointGeometry, pointMaterial);
    this.volume = new THREE.Points(this.pointGeometry, volumeMaterial);
    this.lines = new THREE.LineSegments(this.lineGeometry, lineMaterial);
    this.points.name = "overview-project-clouds";
    this.volume.name = "overview-project-cloud-volume";
    this.lines.name = "overview-project-cloud-edges";
    this.points.userData.overviewClouds = true;
    this.volume.userData.overviewClouds = true;
    this.lines.userData.overviewClouds = true;
    this.points.frustumCulled = this.volume.frustumCulled = this.lines.frustumCulled = false;
    this.volume.renderOrder = -25; this.lines.renderOrder = -20; this.points.renderOrder = -10;
    scene.add(this.volume, this.lines, this.points);
    this.updateTheme(theme);
  }

  private material(name: string, fragmentShader: string, volume: boolean): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      name,
      vertexShader: cloudVertexShader,
      fragmentShader,
      uniforms: { ...this.commonUniforms, uVolume: { value: volume ? 1 : 0 } },
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
    const snapshot: ProjectSpatialPresentation = {
      ...project, live: project.live !== false,
      screenCentre: { ...project.screenCentre }, screenBounds: { ...project.screenBounds },
    };
    const fieldProject: ProjectSpatialPresentation = {
      ...snapshot, screenCentre: { ...snapshot.screenCentre }, screenBounds: { ...snapshot.screenBounds },
    };
    return {
      project: snapshot, fieldProject,
      field: { valid: false, screenX: 0, screenY: 0, energy: 0, visibility: 0 },
      seed, offsets, energy: 0, targetEnergy: bounded(project.energy), focusEnergy: 0,
      arrival: 0, arrivalEnergy: 0, phase: 0, links: new Map(), seen: 0,
    };
  }

  private linksFor(state: CloudState, count: number): Int16Array {
    const cached = state.links.get(count);
    if (cached) return cached;
    const links: number[] = [];
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

  private replaceGeometry(pointCount: number): void {
    this.pointValues = attributes(pointCount);
    this.pointGeometry.dispose(); this.lineGeometry.dispose();
    this.pointGeometry = new THREE.BufferGeometry();
    this.lineGeometry = new THREE.BufferGeometry();
    this.lineGeometry.setIndex([]);
    setAttributes(this.pointGeometry, this.pointValues);
    shareAttributes(this.lineGeometry, this.pointGeometry);
    this.points.geometry = this.pointGeometry;
    this.volume.geometry = this.pointGeometry;
    this.lines.geometry = this.lineGeometry;
  }

  private writeParticle(vertex: number, state: CloudState, localIndex: number, stateIndex: number): void {
    const local = localIndex * 3;
    this.pointValues.position.set(state.offsets.subarray(local, local + 3), vertex * 3);
    this.pointValues.index[vertex] = stateIndex;
    this.pointValues.size[vertex] = 0.75 + randomAt(state.seed, localIndex, 3) * 1.35;
    this.pointValues.alpha[vertex] = 0.68 + randomAt(state.seed, localIndex, 4) * 0.32;
    this.pointValues.rim[vertex] = randomAt(state.seed, localIndex, 5);
    this.pointValues.seed[vertex] = randomAt(state.seed, localIndex, 6);
  }

  private rebuildLayout(count: number): void {
    const ids = [...this.states.keys()].sort();
    this.slots = ids.map((id, index) => ({ state: this.states.get(id)!, start: index * count, count }));
    this.replaceGeometry(this.slots.length * count);
    const lineIndices: number[] = [];
    this.slots.forEach((slot, stateIndex) => {
      for (let index = 0; index < count; index++) this.writeParticle(slot.start + index, slot.state, index, stateIndex);
      const links = this.linksFor(slot.state, count);
      for (let link = 0; link < links.length; link += 2) lineIndices.push(slot.start + links[link]!, slot.start + links[link + 1]!);
    });
    this.lineGeometry.setIndex(lineIndices);
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
    this.replaceGeometry(bins.length);
    bins.forEach((bin, vertex) => {
      this.pointValues.index[vertex] = vertex;
      this.pointValues.size[vertex] = 1.4;
      this.pointValues.alpha[vertex] = 0.85;
      this.pointValues.rim[vertex] = randomAt(bin, 0, 5);
      this.pointValues.seed[vertex] = randomAt(bin, 0, 6);
    });
  }

  updateProjects(projects: readonly ProjectSpatialPresentation[], online = true): void {
    if (this.disposed) return;
    const generation = ++this.inputGeneration;
    let membershipChanged = false, inputsChanged = false;
    for (const project of projects) {
      const live = Boolean(online) && project.live !== false;
      let state = this.states.get(project.projectId);
      if (!state) {
        state = this.stateFor(project);
        state.project.live = live;
        state.fieldProject.live = live;
        state.seen = generation;
        this.states.set(project.projectId, state);
        membershipChanged = true;
        inputsChanged = true;
      } else {
        const previous = state.project, centre = project.screenCentre, bounds = project.screenBounds;
        const changed = !sameNumber(previous.screenCentre.x, centre.x) || !sameNumber(previous.screenCentre.y, centre.y) ||
          !sameNumber(previous.screenBounds.x, bounds.x) || !sameNumber(previous.screenBounds.y, bounds.y) ||
          !sameNumber(previous.screenBounds.width, bounds.width) || !sameNumber(previous.screenBounds.height, bounds.height) ||
          !sameNumber(previous.scaleMultiplier, project.scaleMultiplier) || !sameNumber(previous.viewDepth, project.viewDepth) ||
          !sameNumber(previous.elevation, project.elevation) || !sameNumber(previous.energy, project.energy) ||
          !sameNumber(previous.visibility, project.visibility) || previous.inspected !== project.inspected ||
          previous.focused !== project.focused || previous.live !== live;
        if (changed) {
          previous.screenCentre.x = centre.x; previous.screenCentre.y = centre.y;
          previous.screenBounds.x = bounds.x; previous.screenBounds.y = bounds.y;
          previous.screenBounds.width = bounds.width; previous.screenBounds.height = bounds.height;
          previous.scaleMultiplier = project.scaleMultiplier; previous.viewDepth = project.viewDepth;
          previous.elevation = project.elevation; previous.energy = project.energy;
          previous.visibility = project.visibility; previous.inspected = project.inspected;
          previous.focused = project.focused; previous.live = live;
          inputsChanged = true;
        }
        state.seen = generation;
      }
      state.targetEnergy = bounded(project.energy);
      state.focusEnergy = project.focused ? 0.24 : project.inspected ? 0.12 : 0;
    }
    for (const [id, state] of this.states) {
      if (state.seen === generation) continue;
      this.states.delete(id);
      membershipChanged = true;
      this.fieldDirty = true;
    }
    const aggregated = this.states.size > CLOUD_GLOBAL_POINT_BUDGET;
    if (aggregated !== this.aggregated) { this.aggregated = aggregated; this.layoutDirty = true; }
    if (!aggregated) {
      const count = cloudPointsPerProject(this.states.size);
      if (count !== this.projectPointCount) { this.projectPointCount = count; this.layoutDirty = true; }
    }
    if (membershipChanged) this.layoutDirty = true;
    if (inputsChanged || membershipChanged) this.stateDirty = true;
  }

  /**
   * Push staged layout, cloud state and room field once. Ambient calls this
   * before each background draw; tests may call it explicitly to inspect the
   * displayed outputs without rendering.
   */
  flushState(): boolean {
    if (this.disposed) return false;
    this.syncLayout();
    const fieldProjects = this.fieldProjects;
    fieldProjects.length = 0;
    let fieldDirty = this.fieldDirty;
    for (const state of this.states.values()) {
      const project = state.project, fieldProject = state.fieldProject;
      const energy = Math.max(bounded(this.energyFor(state)), project.focused ? 0.5 : 0, project.inspected ? 0.25 : 0);
      const visibility = bounded(project.visibility), cache = state.field;
      if (!cache.valid || !sameNumber(cache.screenX, project.screenCentre.x) ||
        !sameNumber(cache.screenY, project.screenCentre.y) || !sameNumber(cache.energy, energy) ||
        !sameNumber(cache.visibility, visibility)) {
        fieldDirty = true;
        cache.valid = true; cache.screenX = project.screenCentre.x; cache.screenY = project.screenCentre.y;
        cache.energy = energy; cache.visibility = visibility;
      }
      fieldProject.screenCentre.x = project.screenCentre.x; fieldProject.screenCentre.y = project.screenCentre.y;
      fieldProject.energy = energy; fieldProject.visibility = visibility;
      fieldProject.focused = project.focused; fieldProject.inspected = project.inspected;
      fieldProjects.push(fieldProject);
    }
    let changed = false;
    if (fieldDirty) {
      changed = this.surface.updateProjects(fieldProjects);
      this.fieldDirty = false;
    }
    if (this.stateDirty) {
      this.writeStateTexture();
      this.stateDirty = false;
    }
    return changed;
  }

  private syncLayout(): void {
    if (this.aggregated) {
      this.slots = [];
      this.syncAggregateLayout();
      this.layoutDirty = false;
      return;
    }
    this.aggregateBins = [];
    if (!this.layoutDirty) return;
    this.layoutDirty = false;
    const count = cloudPointsPerProject(this.states.size);
    // Never leave an aggregate bin key behind: the next aggregate pass must
    // rebuild even when its bins match the pre-individual set.
    this.layoutKey = `projects:${count}`;
    this.rebuildLayout(count);
  }

  clearProjects(projectIds: ReadonlySet<string>): void {
    if (this.disposed || projectIds.size === 0) return;
    let changed = false;
    for (const id of projectIds) {
      const state = this.states.get(id);
      if (!state) continue;
      if (state.arrival !== 0 || state.arrivalEnergy !== 0) changed = true;
      state.arrival = 0; state.arrivalEnergy = 0;
    }
    if (changed) this.stateDirty = true;
  }

  private energyFor(state: CloudState): number {
    return Math.max(state.energy, state.focusEnergy, state.arrival * state.arrivalEnergy);
  }

  private writeState(index: number, centre: { x: number; y: number; z: number }, phase: number,
    radius: { x: number; y: number; z: number }, energy: number, alpha: number, worldPerPixel: number): void {
    let dirty = false;
    const base = index * CLOUD_STATE_WIDTH * 4;
    const values = [centre.x, centre.y, centre.z, phase, radius.x, radius.y, radius.z, energy, alpha, worldPerPixel, 1, 0];
    for (let offset = 0; offset < values.length; offset++) dirty = store(this.stateData, base + offset, values[offset]!) || dirty;
    if (dirty) this.stateTexture.needsUpdate = true;
  }

  private updateAggregateState(): void {
    const bins = new Map<number, AggregateBin>();
    for (const state of this.states.values()) {
      const index = this.screenBin(state.project);
      const centre = this.surface.projectPoint(state.project.screenCentre, state.project.viewDepth);
      const energy = this.energyFor(state);
      let bin = bins.get(index);
      if (!bin) { bin = { count: 0, x: 0, y: 0, z: 0, energy: 0, visibility: 0, phase: 0 }; bins.set(index, bin); }
      bin.count++;
      bin.x += centre.x; bin.y += centre.y; bin.z += centre.z;
      bin.energy += energy; bin.visibility += bounded(state.project.visibility); bin.phase += state.phase;
    }
    this.aggregateBins.forEach((index, vertex) => {
      const bin = bins.get(index)!;
      const energy = bin.energy / bin.count, visibility = bin.visibility / bin.count;
      const centre = { x: bin.x / bin.count, y: bin.y / bin.count, z: bin.z / bin.count };
      const worldPerPixel = this.projection.worldUnitsPerPixel(-centre.z);
      const radius = (2 + energy) * worldPerPixel;
      this.writeState(vertex, centre, bin.phase / bin.count, { x: radius, y: radius, z: radius }, energy,
        visibility * 0.46 * (0.24 + energy * 0.76), worldPerPixel);
    });
  }

  private writeStateTexture(): void {
    // The grid follows displayed eased/focused energy, never a newly arriving
    // raw target. Pause and offline therefore freeze deformation naturally.
    if (this.aggregated) { this.updateAggregateState(); return; }
    this.slots.forEach((slot, index) => {
      const { state } = slot, project = state.project;
      const worldPerPixel = this.projection.worldUnitsPerPixel(project.viewDepth);
      const energy = this.energyFor(state);
      const energyScale = 0.94 + energy * 0.18;
      const radiusX = Math.max(52, Math.abs(project.screenBounds.width) * 0.56) * worldPerPixel * energyScale;
      const radiusY = Math.max(46, Math.abs(project.screenBounds.height) * 0.56) * worldPerPixel * energyScale;
      const centre = this.surface.projectPoint(project.screenCentre, project.viewDepth);
      const alpha = bounded(project.visibility) * 0.46 * (0.24 + energy * 0.76);
      this.writeState(index, centre, state.phase, { x: radiusX, y: radiusY, z: (radiusX + radiusY) * 0.38 }, energy, alpha, worldPerPixel);
    });
  }

  resize(pixelRatio: number): void {
    if (this.disposed) return;
    const ratio = Math.max(1, Number.isFinite(pixelRatio) ? pixelRatio : 1);
    for (const material of [this.points.material, this.volume.material, this.lines.material]) {
      material.uniforms.uPixelRatio!.value = ratio;
      material.uniforms.uViewportHeight!.value = this.projection.height * ratio;
    }
    this.layoutDirty = true;
    this.stateDirty = true;
    this.fieldDirty = true;
  }

  advance(seconds: number, moving: boolean, rate: number): void {
    if (this.disposed) return;
    const elapsed = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
    if (!moving || elapsed === 0 || ![...this.states.values()].some(state => state.project.live !== false)) return;
    const safeRate = Math.max(0, Number.isFinite(rate) ? rate : 1);
    const step = (elapsed % AMBIENT_PHASE_PERIOD_SECONDS) * safeRate;
    this.phase = (this.phase + step % AMBIENT_PHASE_PERIOD_SECONDS) % AMBIENT_PHASE_PERIOD_SECONDS;
    for (const material of [this.points.material, this.volume.material, this.lines.material]) material.uniforms.uPhase!.value = this.phase;
    for (const state of this.states.values()) {
      if (state.project.live === false) continue;
      state.phase = (state.phase + step % AMBIENT_PHASE_PERIOD_SECONDS) % AMBIENT_PHASE_PERIOD_SECONDS;
      state.energy = ease(state.energy, state.targetEnergy, elapsed);
      const arrival = state.arrival > 0 ? Math.max(0, state.arrival * Math.exp(-elapsed / CLOUD_ARRIVAL_TIME_CONSTANT)) : 0;
      state.arrival = arrival < 0.001 ? 0 : arrival;
    }
    this.stateDirty = true;
  }

  arrive(projectId: string, energy: number): void {
    const state = this.states.get(projectId);
    if (!state || state.project.live === false || this.disposed) return;
    state.arrival = 1;
    state.arrivalEnergy = bounded(energy);
    this.stateDirty = true;
  }

  clearTransient(): void {
    if (this.disposed) return;
    let changed = false;
    for (const state of this.states.values()) {
      if (state.arrival !== 0 || state.arrivalEnergy !== 0) changed = true;
      state.arrival = 0; state.arrivalEnergy = 0;
    }
    if (changed) this.stateDirty = true;
  }

  isAnimating(): boolean {
    return !this.disposed && [...this.states.values()].some(state => state.project.live !== false && bounded(state.project.visibility) > 0);
  }

  updateTheme(theme: OverviewTheme): void {
    if (this.disposed) return;
    const palette = gridPalette(theme), dark = isDarkBackground(theme.background);
    for (const material of [this.points.material, this.volume.material, this.lines.material]) {
      (material.uniforms.uInk!.value as THREE.Color).set(palette.line);
      (material.uniforms.uEnergy!.value as THREE.Color).set(palette.glow);
      (material.uniforms.uShade!.value as THREE.Color).set(palette.shade);
      (material.uniforms.uRim!.value as THREE.Color).set(palette.rim);
    }
    this.points.material.uniforms.uOpacity!.value = dark ? 0.62 : 0.5;
    this.volume.material.uniforms.uOpacity!.value = dark ? 0.9 : 0.8;
    this.lines.material.uniforms.uOpacity!.value = dark ? 0.62 : 0.5;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.points.removeFromParent(); this.volume.removeFromParent(); this.lines.removeFromParent();
    this.pointGeometry.dispose(); this.lineGeometry.dispose();
    this.points.material.dispose(); this.volume.material.dispose(); this.lines.material.dispose();
    this.stateTexture.dispose();
    this.states.clear(); this.slots = []; this.aggregateBins = [];
  }
}

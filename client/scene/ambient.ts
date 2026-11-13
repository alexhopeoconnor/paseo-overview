import * as THREE from "three";
import type { OverviewTheme } from "../../shared/renderer";
import { DEFAULT_APPEARANCE, type OverviewAppearance } from "../../shared/settings";
import { appearancePolicy } from "../appearance-policy";
import { ProjectParticleClouds } from "./clouds";
import { OverviewProjection } from "./projection";
import { PerspectiveRoom } from "./room";
import type { ProjectSpatialPresentation } from "./spatial";
import { EnergyStreams } from "./streams";

// Native-facing TypeScript configurations intentionally omit the DOM library.
type ShaderErrorArguments = Parameters<NonNullable<THREE.WebGLRenderer["debug"]["onShaderError"]>>;
interface ShaderDiagnostics {
  getShaderSource(shader: ShaderErrorArguments[2]): string | null;
  getProgramInfoLog(program: ShaderErrorArguments[1]): string | null;
  getShaderInfoLog(shader: ShaderErrorArguments[2]): string | null;
}

export interface AmbientGrid {
  advanceTime(elapsedSeconds: number, moving: boolean): void;
  updateProjects(projects: readonly ProjectSpatialPresentation[], online?: boolean): void;
  clearProjects(projectIds: ReadonlySet<string>): void;
  setAppearance(value: OverviewAppearance): void;
  admitActivity(projectId: string): void;
  clearTransient(): void;
  updateTheme(theme: OverviewTheme): void;
  resize(width: number, height: number, pixelRatio: number): void;
  renderWithBackgroundFallback(renderForeground: () => void): void;
  isAnimating(): boolean;
  dispose(): void;
}

/** Owns every background resource and fails closed without disabling the graph. */
export class ProceduralAmbientGrid implements AmbientGrid {
  private readonly backgroundScene = new THREE.Scene();
  private readonly projection = new OverviewProjection();
  private readonly room: PerspectiveRoom;
  private readonly clouds: ProjectParticleClouds;
  private readonly streams: EnergyStreams;
  private appearance: OverviewAppearance = { ...DEFAULT_APPEARANCE };
  private theme: OverviewTheme;
  private projects: ProjectSpatialPresentation[] = [];
  private online = true;
  private pixelRatio = 1;
  private readonly validatedMaterials = new WeakMap<THREE.Material, number>();
  private disposed = false;
  private failed = false;

  constructor(_foregroundScene: THREE.Scene, private readonly renderer: THREE.WebGLRenderer, theme: OverviewTheme) {
    this.theme = theme;
    this.backgroundScene.name = "overview-background";
    this.room = new PerspectiveRoom(this.backgroundScene, this.projection, theme);
    this.clouds = new ProjectParticleClouds(this.backgroundScene, this.projection, this.room, theme);
    this.streams = new EnergyStreams(this.backgroundScene, theme);
    this.streams.setSpeed(appearancePolicy(this.appearance).backgroundRate);
  }

  private disable(): void {
    if (this.failed || this.disposed) return;
    this.failed = true;
    this.streams.clear();
    this.room.dispose();
    this.clouds.dispose();
    this.streams.dispose();
    this.backgroundScene.clear();
  }

  advanceTime(elapsedSeconds: number, moving: boolean): void {
    if (this.failed || this.disposed || this.appearance.background === "off") return;
    const seconds = Math.max(0, Number.isFinite(elapsedSeconds) ? elapsedSeconds : 0);
    const enabled = moving && this.appearance.background === "animated";
    this.clouds.advance(seconds, enabled, appearancePolicy(this.appearance).backgroundRate);
    this.streams.advance(seconds, enabled, (projectId, energy) => this.clouds.arrive(projectId, energy));
  }

  updateProjects(projects: readonly ProjectSpatialPresentation[], online = true): void {
    if (this.failed || this.disposed) return;
    this.online = online;
    this.projects = projects.map(project => ({ ...project, screenCentre: { ...project.screenCentre }, screenBounds: { ...project.screenBounds } }));
    this.streams.setOnline(online);
    if (this.appearance.background === "off") return;
    this.clouds.updateProjects(this.projects, online);
    this.streams.updateProjects(this.projects, this.room);
  }

  clearProjects(projectIds: ReadonlySet<string>): void {
    if (this.failed || this.disposed || projectIds.size === 0) return;
    if (this.appearance.background === "off") return;
    this.clouds.clearProjects(projectIds);
    this.streams.clearProjects(projectIds);
  }

  setAppearance(value: OverviewAppearance): void {
    if (this.failed || this.disposed) return;
    const wasOff = this.appearance.background === "off";
    if (this.appearance.background === "animated" && value.background !== "animated") this.clearTransient();
    this.appearance = { ...value };
    this.streams.setSpeed(appearancePolicy(value).backgroundRate);
    if (wasOff && value.background !== "off") {
      this.room.resize(this.pixelRatio);
      this.room.updateTheme(this.theme);
      this.clouds.updateTheme(this.theme);
      this.streams.updateTheme(this.theme);
      this.clouds.resize(this.pixelRatio);
      this.clouds.updateProjects(this.projects, this.online);
      this.streams.updateProjects(this.projects, this.room);
    }
  }

  admitActivity(projectId: string): void {
    if (this.failed || this.disposed || this.appearance.background !== "animated") return;
    const project = this.projects.find(project => project.projectId === projectId);
    if (!project || !this.online || project.live === false || project.visibility <= 0) return;
    this.streams.admit(projectId);
  }

  clearTransient(): void {
    if (this.failed || this.disposed || this.appearance.background === "off") return;
    this.streams.clear();
    this.clouds.clearTransient();
  }

  updateTheme(theme: OverviewTheme): void {
    this.theme = theme;
    if (this.failed || this.disposed || this.appearance.background === "off") return;
    this.room.updateTheme(theme);
    this.clouds.updateTheme(theme);
    this.streams.updateTheme(theme);
  }

  resize(width: number, height: number, pixelRatio: number): void {
    if (this.failed || this.disposed) return;
    this.pixelRatio = Math.max(1, Number.isFinite(pixelRatio) ? pixelRatio : 1);
    this.projection.resize(width, height, this.pixelRatio);
    if (this.appearance.background === "off") return;
    this.room.resize(this.pixelRatio);
    this.clouds.resize(this.pixelRatio);
    // Existing routes use the same new projection without resetting travel.
    this.streams.updateProjects(this.projects, this.room);
  }

  private visibleMaterials(): THREE.Material[] {
    const materials: THREE.Material[] = [];
    this.backgroundScene.traverseVisible(object => {
      const material = (object as THREE.Object3D & { material?: THREE.Material | THREE.Material[] }).material;
      if (Array.isArray(material)) materials.push(...material);
      else if (material) materials.push(material);
    });
    return materials;
  }

  /**
   * Validate each visible material version on actual use, not compile(). A
   * stream that becomes visible later is guarded just like an initial shader.
   * Root owns the normal clear; a failed pass needs its own complete retry clear.
   */
  renderWithBackgroundFallback(renderForeground: () => void): void {
    if (!this.failed && !this.disposed && this.appearance.background !== "off") this.clouds.flushState();
    let renderingBackground = false;
    let backgroundFailed = false;
    const composite = (guard = false): void => {
      if (!this.failed && !this.disposed && this.appearance.background !== "off") {
        renderingBackground = guard;
        try { this.renderer.render(this.backgroundScene, this.projection.camera); }
        finally { renderingBackground = false; }
        this.renderer.clearDepth();
      }
      renderForeground();
    };
    const materials = this.failed || this.disposed || this.appearance.background === "off" ? [] : this.visibleMaterials();
    if (!materials.some(material => this.validatedMaterials.get(material) !== material.version)) {
      composite();
      return;
    }
    const debug = this.renderer.debug;
    const previousHandler = debug.onShaderError;
    const previousCheck = debug.checkShaderErrors;
    debug.checkShaderErrors = true;
    debug.onShaderError = (gl, program, vertex, fragment) => {
      const diagnostics = gl as typeof gl & ShaderDiagnostics;
      if (renderingBackground) backgroundFailed = true;
      else if (previousHandler) previousHandler(gl, program, vertex, fragment);
      else console.error("THREE.WebGLProgram: Shader Error", diagnostics.getProgramInfoLog(program),
        diagnostics.getShaderInfoLog(vertex), diagnostics.getShaderInfoLog(fragment));
    };
    try { composite(true); }
    finally {
      debug.onShaderError = previousHandler;
      debug.checkShaderErrors = previousCheck;
      if (backgroundFailed) this.disable();
    }
    if (backgroundFailed) {
      this.renderer.clear(true, true, true);
      renderForeground();
    } else {
      for (const material of materials) this.validatedMaterials.set(material, material.version);
    }
  }

  isAnimating(): boolean {
    return !this.failed && !this.disposed && this.appearance.background === "animated" && this.online &&
      (this.clouds.isAnimating() || this.streams.isAnimating());
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (!this.failed) {
      this.streams.clear();
      this.room.dispose();
      this.clouds.dispose();
      this.streams.dispose();
    }
    this.backgroundScene.clear();
    this.projects = [];
  }
}

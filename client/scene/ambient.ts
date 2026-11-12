import * as THREE from "three";
import { gridPalette, type GridPalette } from "../appearance";
import type { OverviewTheme } from "../../shared/renderer";
import { createGridField, GRID_COLUMNS, GRID_ROWS, sampleGridField, type GridField, type ProjectGridInfluence } from "./ambient-field";
import { ambientFragmentShader, ambientVertexShader } from "./ambient-shader";

export interface AmbientGrid {
  advanceTime(elapsedSeconds: number, moving: boolean): void;
  updateField(influences: readonly ProjectGridInfluence[]): void;
  updateTheme(theme: OverviewTheme): void;
  resize(width: number, height: number, pixelRatio: number): void;
  isAnimating(): boolean;
  dispose(): void;
}

function sameInfluences(previous: readonly ProjectGridInfluence[], next: readonly ProjectGridInfluence[]): boolean {
  return previous.length === next.length && previous.every((value, index) => {
    const other = next[index]!;
    return value.id === other.id && value.centreX === other.centreX && value.centreY === other.centreY &&
      value.radiusX === other.radiusX && value.radiusY === other.radiusY && value.activity === other.activity &&
      value.visibility === other.visibility && value.focus === other.focus;
  });
}

/** A self-contained background: it can fail closed without affecting the graph's renderer. */
export class ProceduralAmbientGrid implements AmbientGrid {
  private readonly geometry = new THREE.PlaneGeometry(2, 2, 64, 40);
  private readonly field: GridField = createGridField();
  private readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private readonly material: THREE.ShaderMaterial;
  private readonly previousShaderError: typeof this.renderer.debug.onShaderError;
  private previous: ProjectGridInfluence[] = [];
  private width = 1;
  private height = 1;
  private phase = 0;
  private disposed = false;
  private failed = false;

  constructor(private readonly scene: THREE.Scene, private readonly renderer: THREE.WebGLRenderer, theme: OverviewTheme) {
    const position = this.geometry.getAttribute("position");
    this.geometry.setAttribute("aOverviewGridWarp", new THREE.BufferAttribute(this.field.warp, 2));
    this.geometry.setAttribute("aOverviewGridIntensity", new THREE.BufferAttribute(this.field.intensity, 1));
    this.geometry.setAttribute("aOverviewGridQuiet", new THREE.BufferAttribute(this.field.quietMask, 1));
    if (position.count !== GRID_COLUMNS * GRID_ROWS) throw new Error("Unexpected ambient grid geometry resolution.");
    const palette = gridPalette(theme);
    this.material = new THREE.ShaderMaterial({
      name: "paseo-overview-ambient-grid",
      vertexShader: ambientVertexShader,
      fragmentShader: ambientFragmentShader,
      uniforms: {
        uViewport: { value: new THREE.Vector2(1, 1) }, uPixelRatio: { value: 1 }, uTime: { value: 0 },
        uLine: { value: new THREE.Color(palette.line) }, uHighlight: { value: new THREE.Color(palette.highlight) },
        uGlow: { value: new THREE.Color(palette.glow) }, uLineOpacity: { value: palette.lineOpacity },
        uHighlightOpacity: { value: palette.highlightOpacity },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.position.z = -8;
    this.mesh.renderOrder = -10;
    this.mesh.frustumCulled = false;
    this.mesh.userData.overviewAmbientGrid = true;
    this.previousShaderError = renderer.debug.onShaderError;
    renderer.debug.onShaderError = (gl, program, vertex, fragment) => {
      const source = `${gl.getShaderSource(vertex) ?? ""}\n${gl.getShaderSource(fragment) ?? ""}`;
      if (source.includes("aOverviewGridQuiet")) this.disable();
      else this.previousShaderError?.(gl, program, vertex, fragment);
    };
    scene.add(this.mesh);
  }

  private updatePalette(palette: GridPalette): void {
    (this.material.uniforms.uLine!.value as THREE.Color).set(palette.line);
    (this.material.uniforms.uHighlight!.value as THREE.Color).set(palette.highlight);
    (this.material.uniforms.uGlow!.value as THREE.Color).set(palette.glow);
    this.material.uniforms.uLineOpacity!.value = palette.lineOpacity;
    this.material.uniforms.uHighlightOpacity!.value = palette.highlightOpacity;
  }

  private disable(): void {
    if (this.failed || this.disposed) return;
    this.failed = true;
    this.mesh.removeFromParent();
    this.material.dispose();
    this.geometry.dispose();
  }

  advanceTime(elapsedSeconds: number, moving: boolean): void {
    if (this.failed || this.disposed || !moving) return;
    this.phase += Math.min(0.25, Math.max(0, elapsedSeconds));
    this.material.uniforms.uTime!.value = this.phase;
  }

  updateField(influences: readonly ProjectGridInfluence[]): void {
    if (this.failed || this.disposed || sameInfluences(this.previous, influences)) return;
    this.previous = influences.map(influence => ({ ...influence }));
    sampleGridField(this.field, this.width, this.height, influences);
    this.geometry.getAttribute("aOverviewGridWarp").needsUpdate = true;
    this.geometry.getAttribute("aOverviewGridIntensity").needsUpdate = true;
    this.geometry.getAttribute("aOverviewGridQuiet").needsUpdate = true;
  }

  updateTheme(theme: OverviewTheme): void {
    if (!this.failed && !this.disposed) this.updatePalette(gridPalette(theme));
  }

  resize(width: number, height: number, pixelRatio: number): void {
    if (this.failed || this.disposed) return;
    this.width = Math.max(1, width); this.height = Math.max(1, height);
    // PlaneGeometry remains a fixed 2 × 2 grid; transform it into the current
    // CSS-pixel viewport and preserve the top-origin scene Y convention.
    this.mesh.position.set(this.width / 2, this.height / 2, -8);
    this.mesh.scale.set(this.width / 2, -this.height / 2, 1);
    (this.material.uniforms.uViewport!.value as THREE.Vector2).set(this.width, this.height);
    this.material.uniforms.uPixelRatio!.value = Math.max(1, pixelRatio);
    // A CSS-pixel resize changes sample coordinates even when project data did not.
    this.previous = [];
  }

  isAnimating(): boolean { return !this.failed && !this.disposed; }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.renderer.debug.onShaderError !== this.previousShaderError) this.renderer.debug.onShaderError = this.previousShaderError;
    this.mesh.removeFromParent();
    if (!this.failed) { this.material.dispose(); this.geometry.dispose(); }
    this.previous = [];
  }
}

import * as THREE from "three";
import { gridPalette, type GridPalette } from "../appearance";
import type { OverviewTheme } from "../../shared/renderer";
import { createGridField, GRID_COLUMNS, GRID_ROWS, GridInfluenceSmoother, sampleGridField, type GridField, type ProjectGridInfluence } from "./ambient-field";
import { ambientFragmentShader, ambientVertexShader, GRID_PHASE_PERIOD_SECONDS } from "./ambient-shader";

// Native-facing TypeScript configurations intentionally omit the DOM library.
// Describe only the WebGL diagnostic surface used inside this browser module.
type ShaderErrorArguments = Parameters<NonNullable<THREE.WebGLRenderer["debug"]["onShaderError"]>>;
interface ShaderDiagnostics {
  getShaderSource(shader: ShaderErrorArguments[2]): string | null;
  getProgramInfoLog(program: ShaderErrorArguments[1]): string | null;
  getShaderInfoLog(shader: ShaderErrorArguments[2]): string | null;
}

export interface AmbientGrid {
  advanceTime(elapsedSeconds: number, moving: boolean): void;
  updateField(influences: readonly ProjectGridInfluence[]): void;
  updateTheme(theme: OverviewTheme): void;
  resize(width: number, height: number, pixelRatio: number): void;
  renderWithBackgroundFallback(renderScene: () => void): void;
  isAnimating(): boolean;
  dispose(): void;
}

function sameInfluences(previous: readonly ProjectGridInfluence[], next: readonly ProjectGridInfluence[]): boolean {
  return previous.length === next.length && previous.every((value, index) => {
    const other = next[index]!;
    return value.id === other.id && value.centreX === other.centreX && value.centreY === other.centreY &&
      value.radiusX === other.radiusX && value.radiusY === other.radiusY && value.activity === other.activity &&
      value.elevation === other.elevation && value.visibility === other.visibility && value.focus === other.focus;
  });
}

/** A self-contained background: it can fail closed without affecting the graph's renderer. */
export class ProceduralAmbientGrid implements AmbientGrid {
  private readonly geometry = new THREE.PlaneGeometry(2, 2, 64, 40);
  private readonly field: GridField = createGridField();
  private readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private readonly material: THREE.ShaderMaterial;
  private readonly influences = new GridInfluenceSmoother();
  private previous: ProjectGridInfluence[] = [];
  private fieldDirty = true;
  private validatedVersion = -1;
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
    this.geometry.setAttribute("aOverviewGridShade", new THREE.BufferAttribute(this.field.contactShade, 1));
    this.geometry.setAttribute("aOverviewGridRim", new THREE.BufferAttribute(this.field.contactRim, 1));
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
        uShade: { value: new THREE.Color(palette.shade) }, uRim: { value: new THREE.Color(palette.rim) },
        uShadeOpacity: { value: palette.shadeOpacity }, uRimOpacity: { value: palette.rimOpacity },
        uHighlightOpacity: { value: palette.highlightOpacity },
        uHighlightBaseline: { value: palette.highlightBaseline }, uHighlightQuiet: { value: palette.highlightQuiet },
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
    scene.add(this.mesh);
  }

  private updatePalette(palette: GridPalette): void {
    (this.material.uniforms.uLine!.value as THREE.Color).set(palette.line);
    (this.material.uniforms.uHighlight!.value as THREE.Color).set(palette.highlight);
    (this.material.uniforms.uGlow!.value as THREE.Color).set(palette.glow);
    (this.material.uniforms.uShade!.value as THREE.Color).set(palette.shade);
    (this.material.uniforms.uRim!.value as THREE.Color).set(palette.rim);
    this.material.uniforms.uLineOpacity!.value = palette.lineOpacity;
    this.material.uniforms.uShadeOpacity!.value = palette.shadeOpacity;
    this.material.uniforms.uRimOpacity!.value = palette.rimOpacity;
    this.material.uniforms.uHighlightOpacity!.value = palette.highlightOpacity;
    this.material.uniforms.uHighlightBaseline!.value = palette.highlightBaseline;
    this.material.uniforms.uHighlightQuiet!.value = palette.highlightQuiet;
  }

  private disable(): void {
    if (this.failed || this.disposed) return;
    this.failed = true;
    this.mesh.removeFromParent();
    this.material.dispose();
    this.geometry.dispose();
  }

  advanceTime(elapsedSeconds: number, moving: boolean): void {
    if (this.failed || this.disposed) return;
    const seconds = Math.max(0, Number.isFinite(elapsedSeconds) ? elapsedSeconds : 0);
    if (moving) {
      // Every shader trace has an integer number of cycles per period. Reduce
      // the elapsed step first as well, keeping both CPU and GPU phase bounded
      // during long-lived dashboards without catching up paused/offline time.
      this.phase = (this.phase + seconds % GRID_PHASE_PERIOD_SECONDS) % GRID_PHASE_PERIOD_SECONDS;
      this.material.uniforms.uTime!.value = this.phase;
    }
    const changed = this.influences.advance(seconds, moving);
    if (!changed && !this.fieldDirty) return;
    sampleGridField(this.field, this.width, this.height, this.influences.values);
    this.geometry.getAttribute("aOverviewGridWarp").needsUpdate = true;
    this.geometry.getAttribute("aOverviewGridIntensity").needsUpdate = true;
    this.geometry.getAttribute("aOverviewGridQuiet").needsUpdate = true;
    this.geometry.getAttribute("aOverviewGridShade").needsUpdate = true;
    this.geometry.getAttribute("aOverviewGridRim").needsUpdate = true;
    this.fieldDirty = false;
  }

  updateField(influences: readonly ProjectGridInfluence[]): void {
    if (this.failed || this.disposed || sameInfluences(this.previous, influences)) return;
    this.previous = influences.map(influence => ({ ...influence }));
    const membershipChanged = this.influences.setTargets(this.previous);
    this.fieldDirty ||= membershipChanged;
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
    this.fieldDirty = true;
  }

  /** Three.js validates a program on first use, so compile() alone is insufficient.
   * Guard only a render that can introduce a new background program. Never leave
   * a global error handler installed or hide another material's diagnostics.
   */
  renderWithBackgroundFallback(renderScene: () => void): void {
    if (this.failed || this.disposed || this.validatedVersion === this.material.version) {
      renderScene();
      return;
    }
    const debug = this.renderer.debug;
    const previousHandler = debug.onShaderError;
    const previousCheck = debug.checkShaderErrors;
    let backgroundFailed = false;
    debug.checkShaderErrors = true;
    debug.onShaderError = (gl, program, vertex, fragment) => {
      const diagnostics = gl as typeof gl & ShaderDiagnostics;
      const source = `${diagnostics.getShaderSource(vertex) ?? ""}\n${diagnostics.getShaderSource(fragment) ?? ""}`;
      if (source.includes("#define SHADER_NAME paseo-overview-ambient-grid")) {
        backgroundFailed = true;
      } else if (previousHandler) {
        previousHandler(gl, program, vertex, fragment);
      } else {
        console.error("THREE.WebGLProgram: Shader Error", diagnostics.getProgramInfoLog(program),
          diagnostics.getShaderInfoLog(vertex), diagnostics.getShaderInfoLog(fragment));
      }
    };
    try {
      renderScene();
    } finally {
      debug.onShaderError = previousHandler;
      debug.checkShaderErrors = previousCheck;
      if (backgroundFailed) this.disable();
    }
    if (backgroundFailed) renderScene();
    else this.validatedVersion = this.material.version;
  }

  isAnimating(): boolean { return !this.failed && !this.disposed; }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.mesh.removeFromParent();
    if (!this.failed) { this.material.dispose(); this.geometry.dispose(); }
    this.previous = [];
    this.influences.setTargets([]);
  }
}

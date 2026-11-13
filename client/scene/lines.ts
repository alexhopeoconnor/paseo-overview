import {
  Color, DoubleSide, Group, InstancedBufferAttribute, type InterleavedBufferAttribute,
} from "three";
import { Line2 } from "three/addons/lines/Line2.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import type { Point } from "../geometry";
import { pointOnJourney, type PulseJourney } from "./pulses";

export function createGraphLine(points: readonly Point[], colour: string, width = 1.35, z = -2, dashed = false): Line2 {
  const geometry = new LineGeometry();
  geometry.setPositions(points.flatMap(point => [point.x, point.y, z]));
  const material = new LineMaterial({ color: colour, linewidth: width, worldUnits: false,
    transparent: true, opacity: 0.45, depthWrite: false, side: DoubleSide,
    // In this Three version alpha-to-coverage resets cap alpha independently
    // from opacity. Translucent sampled curves then acquire bright beads at
    // segment joins; ordinary MSAA keeps the continuous stroke consistent.
    alphaToCoverage: false, dashed, dashSize: 5, gapSize: 6 });
  const line = new Line2(geometry, material);
  line.computeLineDistances();
  return line;
}

const SEGMENTS = 20;
const FADE_KEY = "paseo-overview-fibre-fade";

/**
 * One instanced segments batch supplies both the core and glow. Per-segment
 * fade rides in a shader attribute so a single 20-segment geometry serves both
 * materials instead of four separately drawn tail parts.
 */
function createFibreMaterial(width: number): LineMaterial {
  const material = new LineMaterial({
    color: 0xffffff, linewidth: width, worldUnits: false, transparent: true,
    opacity: 0, depthWrite: false, side: DoubleSide, alphaToCoverage: false,
  });
  material.name = "paseo-overview-fibre-material";
  material.onBeforeCompile = shader => {
    shader.vertexShader = shader.vertexShader
      .replace("attribute vec3 instanceColorEnd;", "attribute vec3 instanceColorEnd;\n\t\tattribute float instanceFade;\n\t\tvarying float vFibreFade;")
      .replace("void main() {", "void main() {\n\t\t\tvFibreFade = instanceFade;");
    shader.fragmentShader = shader.fragmentShader
      .replace("void main() {", "varying float vFibreFade;\n\n\t\tvoid main() {")
      .replace("float alpha = opacity;", "float alpha = opacity * vFibreFade;");
  };
  material.customProgramCacheKey = () => FADE_KEY;
  return material;
}

/** A bounded reusable trail. Geometry buffers are allocated only on pool growth. */
export class FibreLight {
  readonly object = new Group();
  private readonly geometry = new LineSegmentsGeometry();
  private readonly core: LineSegments2;
  private readonly glow: LineSegments2;
  private readonly a = { x: 0, y: 0 };
  private readonly b = { x: 0, y: 0 };
  private readonly colour = new Color();

  constructor() {
    this.geometry.setPositions(new Float32Array(SEGMENTS * 6));
    const fade = new Float32Array(SEGMENTS);
    for (let index = 0; index < SEGMENTS; index++) fade[index] = (index + 1) / SEGMENTS;
    this.geometry.setAttribute("instanceFade", new InstancedBufferAttribute(fade, 1));
    this.glow = new LineSegments2(this.geometry, createFibreMaterial(5.5));
    this.core = new LineSegments2(this.geometry, createFibreMaterial(2));
    this.core.frustumCulled = this.glow.frustumCulled = false;
    this.glow.renderOrder = 2; this.core.renderOrder = 3;
    this.object.add(this.glow, this.core);
  }

  setColour(value: string): void {
    this.colour.set(value);
    this.core.material.color.copy(this.colour);
    this.glow.material.color.copy(this.colour);
  }

  update(journey: PulseJourney, now: number, scale: number, opacity: number): void {
    const head = Math.max(0, Math.min(1, (now - journey.startedAt) / journey.duration)) * journey.length;
    const tail = Math.min(38 / Math.max(0.1, scale), journey.length * 0.6);
    const start = Math.max(0, head - tail);
    const starts = this.geometry.getAttribute("instanceStart") as InterleavedBufferAttribute;
    const ends = this.geometry.getAttribute("instanceEnd") as InterleavedBufferAttribute;
    for (let index = 0; index < SEGMENTS; index++) {
      const first = start + (head - start) * index / SEGMENTS;
      const second = start + (head - start) * (index + 1) / SEGMENTS;
      const firstRoute = pointOnJourney(journey, first, this.a);
      const secondRoute = pointOnJourney(journey, second, this.b);
      // A parent tile interrupts a journey; no fabricated line crosses its body.
      if (firstRoute !== secondRoute) { this.a.x = this.b.x; this.a.y = this.b.y; }
      starts.setXYZ(index, this.a.x, this.a.y, 6);
      ends.setXYZ(index, this.b.x, this.b.y, 6);
    }
    starts.data.needsUpdate = true;
    this.core.material.opacity = opacity;
    this.glow.material.opacity = opacity * 0.2;
    const visible = head > start;
    this.core.visible = this.glow.visible = visible;
  }

  dispose(): void {
    this.geometry.dispose();
    this.core.material.dispose();
    this.glow.material.dispose();
    this.object.clear();
  }
}

import { Color, DoubleSide, Group, type InterleavedBufferAttribute } from "three";
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

const PARTS = 4, SEGMENTS = 5;
interface FibrePart { core: LineSegments2; glow: LineSegments2; geometry: LineSegmentsGeometry }

/** A bounded reusable trail. Geometry buffers are allocated only on pool growth. */
export class FibreLight {
  readonly object = new Group();
  private readonly parts: FibrePart[] = [];
  private readonly a = { x: 0, y: 0 };
  private readonly b = { x: 0, y: 0 };
  private readonly colour = new Color();

  constructor() {
    for (let index = 0; index < PARTS; index++) {
      const geometry = new LineSegmentsGeometry();
      geometry.setPositions(new Float32Array(SEGMENTS * 6));
      const make = (width: number) => new LineSegments2(geometry, new LineMaterial({
        color: 0xffffff, linewidth: width, worldUnits: false, transparent: true,
        opacity: 0, depthWrite: false, side: DoubleSide, alphaToCoverage: false,
      }));
      const glow = make(5.5), core = make(2);
      core.frustumCulled = false; glow.frustumCulled = false;
      glow.renderOrder = 2; core.renderOrder = 3;
      this.object.add(glow, core); this.parts.push({ core, glow, geometry });
    }
  }

  setColour(value: string): void {
    this.colour.set(value);
    for (const part of this.parts) {
      part.core.material.color.copy(this.colour);
      part.glow.material.color.copy(this.colour);
    }
  }

  update(journey: PulseJourney, now: number, scale: number, opacity: number): void {
    const head = Math.max(0, Math.min(1, (now - journey.startedAt) / journey.duration)) * journey.length;
    const tail = Math.min(38 / Math.max(0.1, scale), journey.length * 0.6);
    for (let partIndex = 0; partIndex < this.parts.length; partIndex++) {
      const part = this.parts[partIndex]!;
      const start = Math.max(0, head - tail * (PARTS - partIndex) / PARTS);
      const end = Math.max(0, head - tail * (PARTS - partIndex - 1) / PARTS);
      const starts = part.geometry.getAttribute("instanceStart") as InterleavedBufferAttribute;
      const ends = part.geometry.getAttribute("instanceEnd") as InterleavedBufferAttribute;
      for (let index = 0; index < SEGMENTS; index++) {
        const firstRoute = pointOnJourney(journey, start + (end - start) * index / SEGMENTS, this.a);
        const secondRoute = pointOnJourney(journey, start + (end - start) * (index + 1) / SEGMENTS, this.b);
        // A parent tile interrupts a journey; no fabricated line crosses its body.
        if (firstRoute !== secondRoute) { this.a.x = this.b.x; this.a.y = this.b.y; }
        starts.setXYZ(index, this.a.x, this.a.y, 6);
        ends.setXYZ(index, this.b.x, this.b.y, 6);
      }
      starts.data.needsUpdate = true;
      const intensity = (partIndex + 1) / PARTS;
      part.core.material.opacity = opacity * intensity;
      part.glow.material.opacity = opacity * intensity * 0.2;
      part.core.visible = part.glow.visible = end > start;
    }
  }

  dispose(): void {
    for (const part of this.parts) { part.geometry.dispose(); part.core.material.dispose(); part.glow.material.dispose(); }
    this.object.clear();
  }
}

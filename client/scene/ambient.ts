import { DoubleSide, Mesh, MeshBasicMaterial, type PlaneGeometry, type Scene, type Texture } from "three";
import type { OverviewTheme } from "../../shared/renderer";

/** Three broad washes reuse the renderer's texture; no particles or extra canvas. */
export class AmbientField {
  private phase = 0;
  private readonly meshes: Mesh<PlaneGeometry, MeshBasicMaterial>[];

  constructor(scene: Scene, plane: PlaneGeometry, texture: Texture) {
    this.meshes = [0, 1, 2].map(() => {
      const mesh = new Mesh(plane, new MeshBasicMaterial({ map: texture, transparent: true, opacity: 0,
        depthWrite: false, depthTest: false, side: DoubleSide }));
      mesh.position.z = -900; mesh.renderOrder = -10; scene.add(mesh); return mesh;
    });
  }

  update(width: number, height: number, theme: OverviewTheme, seconds: number, moving: boolean, focused: boolean): void {
    if (moving) this.phase = (this.phase + Math.min(0.25, Math.max(0, seconds)) * Math.PI * 2 / 75) % (Math.PI * 2);
    for (let index = 0; index < this.meshes.length; index++) {
      const mesh = this.meshes[index]!, phase = this.phase + index * Math.PI * 2 / 3;
      const x = [0.19, 0.78, 0.48][index]!, y = [0.22, 0.53, 0.86][index]!;
      mesh.position.set(width * x + Math.sin(phase) * 10, height * y + Math.cos(phase) * 8, -900);
      mesh.scale.set(Math.max(240, width * 0.85), Math.max(220, height * 0.95), 1);
      mesh.material.color.set(theme.muted);
      mesh.material.opacity = (0.018 + Math.sin(phase) * 0.003) * (focused ? 0.4 : 1);
    }
  }

  dispose(): void {
    for (const mesh of this.meshes) { mesh.removeFromParent(); mesh.material.dispose(); }
  }
}

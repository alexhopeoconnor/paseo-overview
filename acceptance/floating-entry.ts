import { createFloatingCardPositioner } from "../client/scene/floating";

const shell = document.getElementById("shell")!;
const area = document.getElementById("area")!;
const graph = document.getElementById("graph")!;
const card = document.getElementById("card")!;
const state = { dismissals: 0, backgroundEscapes: 0 };
let zoom = 1;
let positioner = createFloatingCardPositioner(graph, card, { onDismiss() {
  state.dismissals++;
  positioner.update(null);
} });

window.addEventListener("keydown", event => {
  if (event.key === "Escape") state.backgroundEscapes++;
});

function sizeShell() {
  shell.style.width = `${window.innerWidth / zoom}px`;
  shell.style.height = `${window.innerHeight / zoom}px`;
  shell.style.zoom = String(zoom);
  area.style.left = `${300 / zoom}px`;
  area.style.top = `${100 / zoom}px`;
  graph.style.left = `${20 / zoom}px`;
  graph.style.top = `${17 / zoom}px`;
}
sizeShell();
window.addEventListener("resize", sizeShell);

function anchor(x: number, y: number) {
  const width = 32, height = 32;
  return { x: Math.max(0, (graph.clientWidth - width) * x),
    y: Math.max(0, (graph.clientHeight - height) * y), width, height };
}
function visible(): Promise<void> {
  const deadline = performance.now() + 2500;
  return new Promise((resolve, reject) => {
    const check = () => {
      if (card.style.visibility === "visible") resolve();
      else if (performance.now() > deadline) reject(new Error("Floating card did not become visible"));
      else requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  });
}

(window as any).floatingTest = {
  state,
  async place(x: number, y: number) {
    positioner.update(null);
    positioner.update(anchor(x, y));
    await visible();
  },
  async rapid() {
    positioner.update(null);
    for (let index = 0; index < 30; index++) positioner.update(anchor(index % 2, (index % 3) / 2));
    positioner.update(anchor(0.5, 0.5));
    await visible();
  },
  setZoom(value: number) { zoom = value; sizeShell(); },
  offsetParentVariant() {
    area.style.border = "3px solid #cbd5e1";
    area.style.overflow = "auto";
    const spacer = document.createElement("div");
    spacer.style.width = "2200px";
    spacer.style.height = "1300px";
    spacer.style.pointerEvents = "none";
    area.appendChild(spacer);
    area.scrollLeft = 7;
    area.scrollTop = 13;
  },
  dispose() { positioner.dispose(); },
};

import { describe, expect, it } from "vitest";
import { advancePulseJourney, createPulseJourney, pointOnJourney } from "../client/scene/pulses";
import { routedEdge } from "../client/routing";

const edge = (source: string, target: string, from: number, to: number) => routedEdge({
  id: `${source}:${target}`, source, target, kind: "membership", projectId: "project",
  segments: [{ kind: "line", from: { x: from, y: 0 }, to: { x: to, y: 0 } }],
});

describe("pulse journeys", () => {
  const routes = [edge("parent", "child", 10, 110), edge("workspace", "parent", -100, 0), edge("project", "workspace", -210, -110)];
  it("emits each ancestor arrival once independent of animation frame frequency", () => {
    for (const interval of [8, 16, 60, 900]) {
      const journey = createPulseJourney(routes, 1000);
      const arrivals: Array<[string, number]> = [];
      for (let now = 1000; now < 1900; now += interval) advancePulseJourney(journey, now, (id, at) => arrivals.push([id, at]));
      advancePulseJourney(journey, 1900, (id, at) => arrivals.push([id, at]));
      advancePulseJourney(journey, 3000, (id, at) => arrivals.push([id, at]));
      expect(arrivals).toEqual([["parent", 1200], ["workspace", 1400], ["project", 1600]]);
    }
  });
  it("uses cumulative distance and backwards ownership direction without joining node gaps", () => {
    const journey = createPulseJourney(routes, 0), point = { x: 0, y: 0 };
    expect(pointOnJourney(journey, 0, point)).toBe(0); expect(point.x).toBe(110);
    expect(pointOnJourney(journey, 50, point)).toBe(0); expect(point.x).toBe(60);
    expect(pointOnJourney(journey, 101, point)).toBe(1); expect(point.x).toBe(-1);
    expect(pointOnJourney(journey, 300, point)).toBe(2); expect(point.x).toBe(-210);
  });
  it("caps journey duration while preserving correctly timed skipped arrivals", () => {
    const journey = createPulseJourney([edge("parent", "child", 0, 1000), edge("root", "parent", -1000, 0)], 20);
    expect(journey.duration).toBe(900);
    const arrivals: Array<[string, number]> = [];
    expect(advancePulseJourney(journey, 1020, (id, at) => arrivals.push([id, at]))).toBe(true);
    expect(arrivals).toEqual([["parent", 470], ["root", 920]]);
  });
});

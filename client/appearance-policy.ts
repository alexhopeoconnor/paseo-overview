import type { OverviewTheme } from "../shared/renderer";
import type { OverviewAppearance } from "../shared/settings";

export interface AppearancePolicy {
  /** 0 to 1; scales elevation and depth cues. */
  depthStrength: number;
  /** Relative easing rate for project elevation responses. */
  responseRate: number;
  /** Relative phase speed for the plugin-owned background. */
  backgroundRate: number;
}

const depthStrength = { off: 0, subtle: 0.4, balanced: 0.7, strong: 1 } as const;
const responseRate = { relaxed: 0.65, balanced: 1, responsive: 1.6 } as const;
const backgroundRate = { slow: 0.5, normal: 1, fast: 1.5 } as const;

/** Resolve preset names once, at the renderer boundary, rather than in animation frames. */
export function appearancePolicy(value: OverviewAppearance): AppearancePolicy {
  return {
    depthStrength: depthStrength[value.depth],
    responseRate: responseRate[value.response],
    backgroundRate: backgroundRate[value.backgroundSpeed],
  };
}

/** Complete plugin palettes; Light and Dark never depend on the host's effective theme. */
export const appearancePalettes: Readonly<Record<"light" | "dark", OverviewTheme>> = {
  light: {
    background: "#f5f8fb",
    surface: "#ffffff",
    foreground: "#17212b",
    muted: "#5f7183",
    border: "#d7e0e9",
    accent: "#1d6fd1",
    working: "#1d8a63",
    waiting: "#9a6b00",
    error: "#bf2f3f",
    selection: "#315fc4",
  },
  dark: {
    background: "#0b1118",
    surface: "#141d27",
    foreground: "#e7eef6",
    muted: "#9fb0c2",
    border: "#263545",
    accent: "#7cc4ff",
    working: "#58d6a5",
    waiting: "#f4c56a",
    error: "#ff7a86",
    selection: "#9cbdff",
  },
};

/**
 * Follow Paseo passes the supplied host theme through untouched. An explicit
 * Light or Dark choice uses the plugin palette for the graph, overlays and header.
 */
export function resolvedOverviewTheme(theme: OverviewAppearance["theme"], hostTheme: OverviewTheme): OverviewTheme {
  return theme === "paseo" ? hostTheme : appearancePalettes[theme];
}

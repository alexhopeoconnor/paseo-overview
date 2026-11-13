import type { OverviewTheme } from "../shared/renderer";

/** Logical CSS/DIP sizes, shared by geometry and presentation on both platforms. */
export const nodeAppearance = {
  agent: { size: 32, cornerRadius: 10, emojiSize: 22 },
  subagent: { size: 24, backingSize: 24, outerSize: 34, cornerRadius: 6, emojiSize: 17 },
  desktopHitTarget: 32,
  phoneHitTarget: 44,
} as const;

function luminance(hex: string): number | undefined {
  const value = hex.replace(/^#/, "");
  const expanded = /^[\da-f]{3}$/i.test(value) ? value.split("").map(part => part + part).join("") : value;
  if (!/^[\da-f]{6}(?:[\da-f]{2})?$/i.test(expanded)) return undefined;
  const components = [0, 2, 4].map(index => {
    const value = parseInt(expanded.slice(index, index + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
  });
  return components[0]! * 0.2126 + components[1]! * 0.7152 + components[2]! * 0.0722;
}

/** The supplied Paseo background remains the authoritative effective theme. */
export function isDarkBackground(background: string): boolean {
  return (luminance(background) ?? 1) < 0.35;
}

export interface GridPalette {
  line: string;
  highlight: string;
  glow: string;
  /** Broad elevation shadow and its rim, kept cool and distinct from status green. */
  shade: string;
  rim: string;
  lineOpacity: number;
  highlightOpacity: number;
  highlightBaseline: number;
  highlightQuiet: number;
  shadeOpacity: number;
  rimOpacity: number;
}

/** Keep the base grid quiet; moving ink needs stronger contrast against a light surface. */
export function gridPalette(theme: OverviewTheme): GridPalette {
  return isDarkBackground(theme.background)
    ? { line: "#507b9e", highlight: "#59c8ec", glow: "#397bb5", shade: "#010913", rim: "#7fb9dc",
      lineOpacity: 0.18, highlightOpacity: 0.38, highlightBaseline: 0.35, highlightQuiet: 0.52,
      shadeOpacity: 0.4, rimOpacity: 0.2 }
    : { line: "#617f9b", highlight: "#1f6285", glow: "#5e8eb5", shade: "#3d5a78", rim: "#7ba6c7",
      lineOpacity: 0.12, highlightOpacity: 0.45, highlightBaseline: 0.7, highlightQuiet: 0.8,
      shadeOpacity: 0.14, rimOpacity: 0.34 };
}

/** A separate blue selection cue prevents green activity from implying selection. */
export function selectionColour(theme: OverviewTheme): string {
  return isDarkBackground(theme.background) ? "#9cbdff" : "#315fc4";
}

export function identityAccent(index: number, theme: OverviewTheme): string {
  const light = ["#6c7698", "#87647b", "#6b7a55", "#997652", "#547d8c", "#7e6c9c"];
  const dark = ["#adb9e0", "#d9abc5", "#b6ca99", "#dfbd92", "#a0cad7", "#c6b2e4"];
  const palette = isDarkBackground(theme.background) ? dark : light;
  return palette[Math.abs(index) % palette.length]!;
}

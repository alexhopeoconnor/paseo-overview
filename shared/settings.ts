import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/** Host-shared appearance document. Defaults keep a missing document complete. */
export const overviewAppearanceSchema = z.object({
  theme: z.enum(["paseo", "light", "dark"]).default("paseo"),
  background: z.enum(["animated", "static", "off"]).default("animated"),
  depth: z.enum(["off", "subtle", "balanced", "strong"]).default("balanced"),
  response: z.enum(["relaxed", "balanced", "responsive"]).default("balanced"),
  backgroundSpeed: z.enum(["slow", "normal", "fast"]).default("normal"),
}).strict();

export type OverviewAppearance = z.output<typeof overviewAppearanceSchema>;

export const DEFAULT_APPEARANCE: OverviewAppearance = overviewAppearanceSchema.parse({});

export const overviewAppearance = defineSettings({
  id: "appearance",
  scope: "host",
  version: 1,
  schema: overviewAppearanceSchema,
});

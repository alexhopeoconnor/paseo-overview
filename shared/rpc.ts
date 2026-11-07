import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const id = z.string().min(1).max(512);
export const nativeRecordSchema = z.object({
  id, parentAgentId: id, parentSubagentId: id.nullable().optional(), provider: z.string(),
  title: z.string().nullable(), description: z.string().nullable(),
  status: z.enum(["running", "completed", "failed", "canceled"]),
  subtitle: z.string().nullable().optional(), updatedAt: z.string().optional(),
  toolCallId: z.string().nullable().optional(),
});
export const cursorSchema = z.object({ generation: id, revision: z.number().int().nonnegative() });
export const rosterSchema = z.object({
  parentAgentId: id, availability: z.enum(["resident", "not_resident"]),
  cursor: cursorSchema, subagents: z.array(nativeRecordSchema),
});
export const getRosterRpc = defineRpc({
  name: "overview.roster", input: z.object({ parentAgentId: id }).strict(), output: rosterSchema,
});
export const getProjectIconRpc = defineRpc({
  name: "overview.project-icon", input: z.object({ projectId: id }).strict(),
  output: z.object({ data: z.string().max(4 * 1024 * 1024), mimeType: z.string().max(128) }).nullable(),
});

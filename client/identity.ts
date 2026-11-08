import type { OverviewNode, OwnershipIndex } from "../shared/model";

/** Assignment is a versioned UI identity. Never reorder or append to this palette. */
const ANIMALS_V1 = [
  "🦊", "🦉", "🐼", "🐯", "🐸", "🐙", "🐨", "🦁",
  "🐧", "🐢", "🦋", "🐬", "🦝", "🐰", "🐻", "🐵",
  "🦄", "🐝", "🐞", "🦜", "🐳", "🦖", "🦔", "🦦",
  "🐺", "🦅", "🐴", "🦒", "🦩", "🐘", "🦎", "🐿️",
] as const;

export function identityHash(id: string): number {
  let hash = 2166136261;
  for (let index = 0; index < id.length; index++) {
    hash = Math.imul(hash ^ id.charCodeAt(index), 16777619);
  }
  return hash >>> 0;
}

export function agentIdentity(id: string) {
  const hash = identityHash(id);
  return {
    emoji: ANIMALS_V1[hash % ANIMALS_V1.length]!,
    accentIndex: (hash >>> 8) % 6,
    version: 1 as const,
  };
}

export type AgentRole = "agent" | "subagent";

/** A remote delegator is not an owner: role follows the actual displayed tree. */
export function agentRole(
  id: string,
  ownership: Pick<OwnershipIndex, "parentByNode">,
  agents: ReadonlyMap<string, OverviewNode>,
): AgentRole {
  const owner = ownership.parentByNode.get(id);
  return owner && agents.has(owner) ? "subagent" : "agent";
}

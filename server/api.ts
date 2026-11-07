import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { ProjectIcon, RosterSnapshot } from "../shared/observation";

type Api = PluginHandlerContext["paseo"];
interface IconActions { getIcon(projectId: string): Promise<ProjectIcon | null> }
interface RosterHandle { providerSubagents?: { snapshot(): Promise<RosterSnapshot> } }

export function readProjectIcon(paseo: Api, projectId: string): Promise<ProjectIcon | null> {
  const projects = paseo.projects as typeof paseo.projects & Partial<IconActions>;
  if (typeof projects.getIcon !== "function") throw new Error("This host needs the Overview project-icon API update.");
  return projects.getIcon(projectId);
}

export function readRoster(paseo: Api, parentAgentId: string): Promise<RosterSnapshot> {
  const agent = paseo.agents.ref(parentAgentId) as ReturnType<Api["agents"]["ref"]> & RosterHandle;
  if (typeof agent.providerSubagents?.snapshot !== "function") throw new Error("This host needs the passive Overview subagent API update.");
  return agent.providerSubagents.snapshot();
}

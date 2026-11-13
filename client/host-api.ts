import type { ProjectIcon, RosterSnapshot } from "../shared/observation";
import type { OverviewApi } from "./transport";

export interface OverviewReader {
  readRoster(parentAgentId: string): Promise<RosterSnapshot>;
  readIcon(projectId: string): Promise<ProjectIcon | null>;
}

interface IconActions {
  getIcon?(projectId: string): Promise<ProjectIcon | null>;
}
interface RosterHandle {
  providerSubagents?: { snapshot?(): Promise<RosterSnapshot> };
}

/**
 * The public, per-host passive reader. It calls the borrowed host API directly
 * so a remote host's agent or project IDs never travel through this installation's
 * local plugin RPC surface.
 */
export function createOverviewReader(api: OverviewApi): OverviewReader {
  const projects = api.projects as typeof api.projects & IconActions;
  return {
    readIcon(projectId: string): Promise<ProjectIcon | null> {
      if (typeof projects.getIcon !== "function") {
        return Promise.reject(new Error("This host needs the Overview project-icon API update."));
      }
      return projects.getIcon(projectId);
    },
    readRoster(parentAgentId: string): Promise<RosterSnapshot> {
      const agent = api.agents.ref(parentAgentId) as ReturnType<OverviewApi["agents"]["ref"]> & RosterHandle;
      if (typeof agent.providerSubagents?.snapshot !== "function") {
        return Promise.reject(new Error("This host needs the passive Overview subagent API update."));
      }
      return agent.providerSubagents.snapshot();
    },
  };
}

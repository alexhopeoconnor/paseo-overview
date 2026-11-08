import type { ProjectIcon, ProjectRecord, WorkspaceRecord } from "../shared/observation";
import type { ReadQueue } from "./transport";

interface Entry { revision: string; token: number; loaded: boolean; reading: boolean; url?: string }

/** Data URLs work in native Image and DOM img without browser-only object URLs. */
export class ProjectIcons {
  private readonly entries = new Map<string, Entry>();
  private disposed = false;
  private suspended = false;
  private queue: ReadQueue;
  constructor(private readonly options: {
    queue: ReadQueue;
    read(projectId: string): Promise<ProjectIcon | null>;
    changed(): void;
    failed(error: unknown): void;
  }) { this.queue = options.queue; }

  get urls(): ReadonlyMap<string, string> {
    return new Map([...this.entries].flatMap(([id, entry]) => entry.url ? [[id, entry.url] as const] : []));
  }

  sync(projects: readonly ProjectRecord[], workspaces: readonly WorkspaceRecord[]): void {
    if (this.disposed || this.suspended) return;
    const revisions = new Map(workspaces.map(workspace => [workspace.projectId, workspace.projectCustomIconRevision ?? "automatic"]));
    for (const project of projects) revisions.set(project.projectId, project.projectIconRevision ?? project.projectCustomIconRevision ?? "automatic");
    for (const [id, entry] of this.entries) if (!revisions.has(id)) { entry.token++; this.entries.delete(id); }
    for (const [id, revision] of revisions) {
      let entry = this.entries.get(id);
      if (!entry) {
        entry = { revision, token: 0, loaded: false, reading: false }; this.entries.set(id, entry); this.load(id, entry);
      } else if (entry.revision !== revision || (!entry.loaded && !entry.reading)) { entry.revision = revision; this.load(id, entry); }
    }
  }

  invalidate(projectId: string): void {
    const entry = this.entries.get(projectId);
    if (entry && !this.disposed) {
      entry.loaded = false;
      if (!this.suspended) this.load(projectId, entry);
    }
  }

  private load(projectId: string, entry: Entry): void {
    const token = ++entry.token;
    entry.loaded = false;
    entry.reading = true;
    const alive = () => !this.disposed && !this.suspended && this.entries.get(projectId) === entry && entry.token === token;
    void this.queue.run(() => alive() ? this.options.read(projectId) : Promise.resolve(null)).then(icon => {
      if (!alive()) return;
      if (icon && (!/^image\/(png|jpeg|webp|gif|svg\+xml|x-icon|vnd\.microsoft\.icon)$/.test(icon.mimeType) || !/^[A-Za-z0-9+/=\s]+$/.test(icon.data))) {
        throw new Error("The host returned an unsupported project icon.");
      }
      entry.url = icon ? `data:${icon.mimeType};base64,${icon.data}` : undefined;
      entry.loaded = true;
      this.options.changed();
    }).catch(error => { if (alive()) this.options.failed(error); }).finally(() => { if (alive()) entry.reading = false; });
  }

  suspend(): void {
    if (this.disposed || this.suspended) return;
    this.suspended = true;
    for (const entry of this.entries.values()) { entry.token++; entry.reading = false; }
  }

  resume(queue: ReadQueue): void {
    if (this.disposed) return;
    this.queue = queue;
    this.suspended = false;
  }

  dispose(): void {
    this.disposed = true;
    for (const entry of this.entries.values()) entry.token++;
    this.entries.clear();
  }
}

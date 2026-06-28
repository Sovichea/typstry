import { watch, type UnwatchFn, type WatchEvent, type WatchEventKind } from "@tauri-apps/plugin-fs";

export type WorkspaceChangeKind = "create" | "modify" | "remove" | "rename";

export type WorkspaceChange = {
  rootPath: string;
  kind: WorkspaceChangeKind;
  paths: string[];
};

export function workspaceChangeKind(type: WatchEventKind): WorkspaceChangeKind | null {
  if (typeof type === "string") return null;
  if ("create" in type) return "create";
  if ("remove" in type) return "remove";
  if ("modify" in type) {
    return type.modify.kind === "rename" ? "rename" : "modify";
  }
  return null;
}

export class WorkspaceWatcher {
  private unwatch: UnwatchFn | null = null;
  private generation = 0;

  constructor(
    private readonly onChange: (change: WorkspaceChange) => void,
    private readonly onError: (error: unknown) => void = () => {}
  ) {}

  public async start(rootPath: string): Promise<void> {
    this.stop();
    const generation = this.generation;

    try {
      const unwatch = await watch(
        rootPath,
        event => this.handleEvent(event, generation, rootPath),
        { recursive: true, delayMs: 150 }
      );
      if (generation !== this.generation) {
        unwatch();
        return;
      }
      this.unwatch = unwatch;
    } catch (error) {
      if (generation === this.generation) this.onError(error);
    }
  }

  public stop(): void {
    this.generation += 1;
    this.unwatch?.();
    this.unwatch = null;
  }

  private handleEvent(event: WatchEvent, generation: number, rootPath: string): void {
    if (generation !== this.generation) return;
    const kind = workspaceChangeKind(event.type);
    const paths = [...new Set(event.paths)];
    if (!kind || paths.length === 0) return;
    this.onChange({ rootPath, kind, paths });
  }
}

export type StoredWorkspaceTab = {
  path: string;
  selectionAnchor: number;
  selectionHead: number;
  scrollTop?: number;
  scrollLeft?: number;
  foldRanges?: unknown[] | null;
};

export type StoredWorkspaceState = {
  activeFilePath: string | null;
  openTabs: StoredWorkspaceTab[];
  inputContainerWidthPct: number;
  explorerSidebarWidthPx: number;
};

export class WorkspaceStateStore {
  public save(workspacePath: string, state: StoredWorkspaceState): void {
    localStorage.setItem(this.key(workspacePath), JSON.stringify(state));
  }

  public load(workspacePath: string): StoredWorkspaceState | null {
    try {
      const stored = localStorage.getItem(this.key(workspacePath));
      if (!stored) return null;
      const value = JSON.parse(stored) as Record<string, unknown>;
      const openTabs = Array.isArray(value.openTabs)
        ? value.openTabs
            .filter((tab): tab is Record<string, unknown> => !!tab && typeof tab === "object" && typeof (tab as Record<string, unknown>).path === "string")
            .map(tab => ({
              path: tab.path as string,
              selectionAnchor: this.numberOr(tab.selectionAnchor, 0),
              selectionHead: this.numberOr(tab.selectionHead, 0),
              scrollTop: typeof tab.scrollTop === "number" ? tab.scrollTop : undefined,
              scrollLeft: typeof tab.scrollLeft === "number" ? tab.scrollLeft : undefined,
              foldRanges: Array.isArray(tab.foldRanges) ? tab.foldRanges : null
            }))
        : [];
      return {
        activeFilePath: typeof value.activeFilePath === "string" ? value.activeFilePath : null,
        openTabs,
        inputContainerWidthPct: this.numberOr(value.inputContainerWidthPct, 50),
        explorerSidebarWidthPx: this.numberOr(value.explorerSidebarWidthPx, 250)
      };
    } catch {
      return null;
    }
  }

  private key(workspacePath: string): string {
    return `typstry-workspace-${workspacePath}`;
  }

  private numberOr(value: unknown, fallback: number): number {
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
  }
}

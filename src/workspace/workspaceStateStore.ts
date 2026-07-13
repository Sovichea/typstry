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
  pinnedMainFilePath: string | null;
  openTabs: StoredWorkspaceTab[];
  inputContainerWidthPct: number;
  explorerSidebarWidthPx: number;
  recommendedToolchain: StoredWorkspaceToolchain | null;
  selectedToolchain: StoredWorkspaceToolchain | null;
};

export type StoredWorkspaceToolchain = {
  tinymistVersion: string;
  typstVersion: string;
};

export function workspaceRestoreCandidates(state: StoredWorkspaceState): string[] {
  const candidates = [state.activeFilePath, state.pinnedMainFilePath, ...state.openTabs.map(tab => tab.path)];
  return candidates.filter((path, index): path is string =>
    typeof path === "string" && path.length > 0 && candidates.indexOf(path) === index
  );
}

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
        pinnedMainFilePath: typeof value.pinnedMainFilePath === "string" ? value.pinnedMainFilePath : null,
        openTabs,
        inputContainerWidthPct: this.numberOr(value.inputContainerWidthPct, 50),
        explorerSidebarWidthPx: this.numberOr(value.explorerSidebarWidthPx, 250),
        recommendedToolchain: this.toolchainOrNull(value.recommendedToolchain),
        selectedToolchain: this.toolchainOrNull(value.selectedToolchain)
      };
    } catch {
      return null;
    }
  }

  private key(workspacePath: string): string {
    return `typsastra-workspace-${workspacePath}`;
  }

  private numberOr(value: unknown, fallback: number): number {
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
  }

  private toolchainOrNull(value: unknown): StoredWorkspaceToolchain | null {
    if (!value || typeof value !== "object") return null;
    const toolchain = value as Record<string, unknown>;
    return typeof toolchain.tinymistVersion === "string" && typeof toolchain.typstVersion === "string"
      ? { tinymistVersion: toolchain.tinymistVersion, typstVersion: toolchain.typstVersion }
      : null;
  }
}

import { open as openUrl } from "@tauri-apps/plugin-shell";

export class LayoutController {
  constructor(
    private readonly onLayoutChanged: () => void,
    private readonly onHideLogConsole: () => void
  ) {}

  public initialize(): void {
    this.initializeResizers();
    this.initializePreviewUndocking();
  }

  private initializeResizers(): void {
    const explorerResizer = document.getElementById("explorer-resizer");
    const explorerSidebar = document.getElementById("explorer-sidebar");
    let resizingExplorer = false;
    if (explorerResizer && explorerSidebar) {
      explorerResizer.addEventListener("mousedown", () => {
        resizingExplorer = true;
        this.beginResize(explorerResizer, "col-resize");
      });
      document.addEventListener("mousemove", event => {
        if (resizingExplorer) explorerSidebar.style.width = `${Math.max(150, Math.min(event.clientX, 800))}px`;
      });
      document.addEventListener("mouseup", () => {
        if (!resizingExplorer) return;
        resizingExplorer = false;
        this.endResize(explorerResizer);
        this.onLayoutChanged();
      });
      explorerResizer.addEventListener("dblclick", () => {
        const hidden = explorerSidebar.style.display === "none" || explorerSidebar.classList.contains("hidden");
        explorerSidebar.classList.toggle("hidden", !hidden);
        explorerSidebar.style.display = hidden ? "block" : "none";
      });
    }

    const editorResizer = document.getElementById("editor-preview-resizer");
    const input = document.getElementById("input-container-wrapper");
    const preview = document.getElementById("preview-container-wrapper");
    const viewport = document.getElementById("workspace-viewport");
    let resizingEditor = false;
    if (editorResizer && input && preview && viewport) {
      editorResizer.addEventListener("mousedown", () => {
        resizingEditor = true;
        this.beginResize(editorResizer, "col-resize");
      });
      document.addEventListener("mousemove", event => {
        if (!resizingEditor) return;
        const rect = viewport.getBoundingClientRect();
        const percentage = Math.max(10, Math.min(((event.clientX - rect.left) / rect.width) * 100, 90));
        input.style.width = `${percentage}%`;
        preview.style.width = `${100 - percentage}%`;
      });
      document.addEventListener("mouseup", () => {
        if (!resizingEditor) return;
        resizingEditor = false;
        this.endResize(editorResizer);
        this.onLayoutChanged();
      });
    }

    const logResizer = document.getElementById("log-console-resizer");
    const logConsole = document.getElementById("log-console");
    let resizingLog = false;
    if (logResizer && logConsole) {
      logResizer.addEventListener("mousedown", () => {
        resizingLog = true;
        this.beginResize(logResizer, "row-resize");
      });
      document.addEventListener("mousemove", event => {
        if (!resizingLog) return;
        const statusBarHeight = document.getElementById("status-bar")?.offsetHeight || 26;
        const height = window.innerHeight - event.clientY - statusBarHeight;
        logConsole.style.height = `${Math.max(100, Math.min(height, window.innerHeight * 0.8))}px`;
      });
      document.addEventListener("mouseup", () => {
        if (!resizingLog) return;
        resizingLog = false;
        this.endResize(logResizer);
      });
      logResizer.addEventListener("dblclick", this.onHideLogConsole);
    }
  }

  private initializePreviewUndocking(): void {
    const undock = document.getElementById("undock-preview-btn");
    const previewWrapper = document.getElementById("preview-container-wrapper");
    const preview = document.getElementById("preview-render-pane");
    const resizer = document.getElementById("editor-preview-resizer");
    const input = document.getElementById("input-container-wrapper");
    const dock = document.getElementById("dock-preview-status-btn");
    const restoreDock = () => {
      if (previewWrapper) previewWrapper.style.display = "flex";
      if (resizer) resizer.style.display = "block";
      if (input) input.style.width = "50%";
      dock?.classList.add("hidden");
    };
    dock?.addEventListener("click", restoreDock);
    if (!undock || !preview || !previewWrapper) return;

    undock.addEventListener("click", async () => {
      const iframe = preview.querySelector<HTMLIFrameElement>("iframe");
      if (!iframe?.src) {
        alert("Live preview is not currently active.");
        return;
      }
      previewWrapper.style.display = "none";
      if (resizer) resizer.style.display = "none";
      if (input) input.style.width = "100%";
      dock?.classList.remove("hidden");
      try {
        await openUrl(iframe.src);
      } catch (error) {
        console.error("Shell open failed", error);
        alert("Could not open external preview window.");
        restoreDock();
      }
    });
  }

  private beginResize(resizer: HTMLElement, cursor: string): void {
    resizer.classList.add("resizing");
    document.body.style.cursor = cursor;
    document.body.style.userSelect = "none";
  }

  private endResize(resizer: HTMLElement): void {
    resizer.classList.remove("resizing");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  }
}

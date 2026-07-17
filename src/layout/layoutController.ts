export class LayoutController {
  private static readonly dragThresholdPx = 4;

  constructor(
    private readonly onLayoutChanged: () => void,
    private readonly onHideLogConsole: () => void,
    private readonly onDebug: (message: string) => void = () => {},
    private readonly onEditorWidthResizeStart: () => void = () => {},
    private readonly onEditorWidthResizeEnd: () => void = () => {}
  ) {}

  public initialize(): void {
    this.initializeResizers();
    this.initializePreviewUndocking();
  }

  public dockPreview(): void {
    const previewWrapper = document.getElementById("preview-container-wrapper");
    const resizer = document.getElementById("editor-preview-resizer");
    const input = document.getElementById("input-container-wrapper");
    
    import("@tauri-apps/api/webviewWindow").then(async ({ WebviewWindow }) => {
      const win = await WebviewWindow.getByLabel("preview");
      if (win) {
        await win.close();
      }
    }).catch(err => console.error("Error closing preview window", err));

    const before = previewWrapper
      ? `before class="${previewWrapper.className}", inline="${previewWrapper.style.display}", computed="${getComputedStyle(previewWrapper).display}"`
      : "before missing preview wrapper";
    if (previewWrapper) {
      previewWrapper.classList.remove("hidden");
      previewWrapper.style.display = "flex";
    }
    if (resizer) {
      resizer.classList.remove("hidden");
      resizer.style.display = "block";
    }
    input?.classList.remove("hidden");
    if (input && input.style.width === "100%") input.style.width = "50%";
    const after = previewWrapper
      ? `after class="${previewWrapper.className}", inline="${previewWrapper.style.display}", computed="${getComputedStyle(previewWrapper).display}", rect=${Math.round(previewWrapper.getBoundingClientRect().width)}x${Math.round(previewWrapper.getBoundingClientRect().height)}`
      : "after missing preview wrapper";
    this.onDebug(`Dock preview requested: ${before}; ${after}.`);
  }

  private initializeResizers(): void {
    const explorerResizer = document.getElementById("explorer-resizer");
    const explorerSidebar = document.getElementById("explorer-sidebar");
    if (explorerResizer && explorerSidebar) {
      this.installDragResize(explorerResizer, "col-resize", event => {
        explorerSidebar.style.width = `${Math.max(150, Math.min(event.clientX, 800))}px`;
      }, () => {
        this.onEditorWidthResizeEnd();
        this.onLayoutChanged();
      }, this.onEditorWidthResizeStart);
    }

    const editorResizer = document.getElementById("editor-preview-resizer");
    const input = document.getElementById("input-container-wrapper");
    const preview = document.getElementById("preview-container-wrapper");
    const viewport = document.getElementById("workspace-viewport");
    if (editorResizer && input && preview && viewport) {
      let viewportRect: DOMRect | null = null;
      this.installDragResize(editorResizer, "col-resize", event => {
        const rect = viewportRect ?? viewport.getBoundingClientRect();
        const percentage = Math.max(10, Math.min(((event.clientX - rect.left) / rect.width) * 100, 90));
        input.style.width = `${percentage}%`;
        preview.style.width = `${100 - percentage}%`;
      }, () => {
        viewportRect = null;
        this.onEditorWidthResizeEnd();
        this.onLayoutChanged();
      }, () => {
        viewportRect = viewport.getBoundingClientRect();
        this.onEditorWidthResizeStart();
      });
    }

    const logResizer = document.getElementById("log-console-resizer");
    const logConsole = document.getElementById("log-console");
    if (logResizer && logConsole) {
      this.installDragResize(logResizer, "row-resize", event => {
        const statusBarHeight = document.getElementById("status-bar")?.offsetHeight || 26;
        const height = window.innerHeight - event.clientY - statusBarHeight;
        logConsole.style.height = `${Math.max(100, Math.min(height, window.innerHeight * 0.8))}px`;
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
    const restoreDock = () => this.dockPreview();
    if (!undock || !preview || !previewWrapper) return;

    undock.addEventListener("click", async () => {
      previewWrapper.style.display = "none";
      if (resizer) resizer.style.display = "none";
      if (input) input.style.width = "100%";
      try {
        const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
        const win = new WebviewWindow("preview", {
          url: "index.html?mode=preview",
          title: "Typsastra - Live Preview",
          width: 800,
          height: 600
        });
        win.once("tauri://close-requested", async () => {
          try {
            const { WebviewWindow: WebviewWindowType } = await import("@tauri-apps/api/webviewWindow");
            const mainWin = await WebviewWindowType.getByLabel("main");
            if (mainWin) {
              restoreDock();
            } else {
              await win.close();
            }
          } catch (e) {
            console.error("Error checking main window during close:", e);
            try { await win.close(); } catch {}
          }
        });
      } catch (error) {
        console.error("Failed to create WebviewWindow", error);
        alert("Could not open external preview window.");
        restoreDock();
      }
    });
  }

  private beginResize(resizer: HTMLElement, cursor: string): void {
    resizer.classList.add("resizing");
    document.body.classList.add("typsastra-resizing");
    document.body.style.cursor = cursor;
    document.body.style.userSelect = "none";
  }

  private endResize(resizer: HTMLElement): void {
    resizer.classList.remove("resizing");
    document.body.classList.remove("typsastra-resizing");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  }

  private installDragResize(
    resizer: HTMLElement,
    cursor: string,
    onDrag: (event: { clientX: number; clientY: number }) => void,
    onEnd: () => void = () => {},
    onStart: () => void = () => {}
  ): void {
    let pending: { pointerId: number; x: number; y: number } | null = null;
    let dragging = false;
    let dragFrame: number | null = null;
    let latestPosition: { clientX: number; clientY: number } | null = null;

    const flushDrag = (): void => {
      dragFrame = null;
      const position = latestPosition;
      latestPosition = null;
      if (dragging && position) onDrag(position);
    };

    resizer.addEventListener("pointerdown", event => {
      if (event.button !== 0) return;
      pending = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
      dragging = false;
      resizer.setPointerCapture(event.pointerId);
      event.preventDefault();
    });

    resizer.addEventListener("pointermove", event => {
      if (!pending || event.pointerId !== pending.pointerId) return;
      if (!dragging) {
        const distance = Math.hypot(event.clientX - pending.x, event.clientY - pending.y);
        if (distance < LayoutController.dragThresholdPx) return;
        dragging = true;
        // Capture editor/preview state while the panes are still measurable.
        // The resizing class hides their children behind placeholders.
        onStart();
        this.beginResize(resizer, cursor);
      }
      latestPosition = { clientX: event.clientX, clientY: event.clientY };
      if (dragFrame === null) dragFrame = requestAnimationFrame(flushDrag);
    });

    const finish = (event: PointerEvent): void => {
      if (!pending || event.pointerId !== pending.pointerId) return;
      const pointerId = pending.pointerId;
      pending = null;
      if (resizer.hasPointerCapture(pointerId)) resizer.releasePointerCapture(pointerId);
      if (dragging) {
        if (dragFrame !== null) {
          cancelAnimationFrame(dragFrame);
          flushDrag();
        }
        dragging = false;
        this.endResize(resizer);
        onEnd();
      }
    };

    resizer.addEventListener("pointerup", finish);
    resizer.addEventListener("pointercancel", finish);
    resizer.addEventListener("lostpointercapture", finish);
  }
}

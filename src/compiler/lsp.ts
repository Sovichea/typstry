import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { EditorView } from "@codemirror/view";

type TinymistPreviewResult = {
  staticServerAddr?: string;
  staticServerPort?: number;
  dataPlanePort?: number;
};

export type LspStatusKind = "starting" | "running" | "initializing" | "ready" | "preview-starting" | "preview-ready" | "sync-pending" | "syncing" | "stopped" | "error";

export type LspStatus = {
  kind: LspStatusKind;
  message: string;
};

type ScrollPreviewRequest = {
  event: "panelScrollTo" | "changeCursorPosition";
  filepath: string;
  line: number;
  character: number;
};

export type LspSourcePosition = {
  line: number;
  character?: number;
};

export type LspDiagnostic = {
  range: {
    start: LspSourcePosition;
    end: LspSourcePosition;
  };
  severity?: number;
  code?: string | number;
  source?: string;
  message: string;
};

export type LspLogEntry = {
  kind: "error" | "warning" | "info" | "log";
  message: string;
  source?: string;
};

export type LspEditorSelection = {
  anchor: number;
  head?: number;
};

export class TinymistLspClient {
  private requestId = 0;
  private editorView?: EditorView;
  private latestPreviewUrl = "";
  private latestPreviewDataPlaneUrl = "";
  private pendingRequests = new Map<number, { resolve: (res: any) => void; reject: (err: any) => void; timeout?: number }>();

  constructor(
    private onSvgPreviewStream: (svgContent: string) => void,
    private onStatus: (status: LspStatus) => void = () => {},
    private onInverseSync: (position: LspSourcePosition, defaultCursorPos: number) => number | LspEditorSelection | void = () => {},
    private onDiagnostics: (uri: string, diagnostics: LspDiagnostic[], version?: number) => void = () => {},
    private onLog: (entry: LspLogEntry) => void = () => {}
  ) {}

  public setEditorView(view: EditorView) {
    this.editorView = view;
  }

  public async connect(): Promise<void> {
    try {
      this.setStatus("starting", "Starting Tinymist");
      await invoke("start_tinymist_lsp");
      this.setStatus("running", "Tinymist process running");

      await listen<string>("lsp-status", (event) => {
        if (event.payload === "stopped") {
          this.setStatus("stopped", "Tinymist stopped");
        } else if (event.payload === "running") {
          this.setStatus("running", "Tinymist process running");
        }
      });

      await listen<string>("lsp-rx", (event) => {
        try {
          const payload = JSON.parse(event.payload);
          this.handleMessage(payload);
        } catch (e) {
          console.error("Failed to parse LSP payload", e);
        }
      });

      this.setStatus("initializing", "Initializing LSP");
      await this.initializeLsp();
      this.setStatus("ready", "LSP ready");
    } catch (e) {
      console.error("Failed to start Tinymist LSP over IPC:", e);
      this.setStatus("error", `LSP unavailable: ${String(e)}`);
      throw e;
    }
  }

  public async restart(): Promise<void> {
    this.setStatus("starting", "Restarting Tinymist");
    await invoke("start_tinymist_lsp");
    this.setStatus("running", "Tinymist process running");
    this.setStatus("initializing", "Initializing LSP");
    await this.initializeLsp();
    this.setStatus("ready", "LSP ready");
  }

  private handleMessage(payload: any) {
    if (payload.id !== undefined && typeof payload.method === "string") {
      this.handleServerRequest(payload);
      return;
    }

    if (payload.id !== undefined && payload.method === undefined) {
      const id = Number(payload.id);
      const pending = this.pendingRequests.get(id);
      if (pending) {
        this.pendingRequests.delete(id);
        if (pending.timeout) window.clearTimeout(pending.timeout);
        if (payload.error) {
          pending.reject(payload.error);
        } else {
          pending.resolve(payload.result);
        }
      }
      return;
    }

    if (payload.method === "tinymist/preview/svgStream") {
      this.onSvgPreviewStream(payload.params.svg);
    }

    // Sometimes tinymist sends logs or errors!
    if (payload.method === "window/showMessage") {
      this.emitLog(payload.params?.type, payload.params?.message, "showMessage");
    }

    if (payload.method === "window/logMessage") {
      this.emitLog(payload.params?.type, payload.params?.message, "logMessage");
    }

    if (payload.method === "textDocument/publishDiagnostics") {
      const params = payload.params;
      if (typeof params?.uri === "string" && Array.isArray(params.diagnostics)) {
        this.onDiagnostics(params.uri, params.diagnostics, params.version);
      }
    }

    if (payload.error) {
      const errorMessage = payload.error.message ?? JSON.stringify(payload.error);
      if (
        errorMessage.includes("cannot register preview to the compiler instance") ||
        errorMessage.includes("cannot export multiple images without a page number template")
      ) {
        return;
      }
      this.onLog({
        kind: "error",
        source: "response",
        message: errorMessage
      });
    }
  }

  public editorPositionFromLspPosition(position: LspSourcePosition): number {
    const doc = this.editorView!.state.doc;
    const lineNumber = Math.max(1, Math.min(position.line + 1, doc.lines)); // LSP is 0-indexed, CodeMirror line() is 1-indexed
    const lineInfo = doc.line(lineNumber);
    const character = this.utf8ByteOffsetToStringOffset(lineInfo.text, position.character ?? 0);
    return lineInfo.from + character;
  }

  public lspPositionFromEditorPosition(doc: any, offset: number): LspSourcePosition {
    const lineInfo = doc.lineAt(offset);
    const characterOffset = offset - lineInfo.from;
    return {
      line: lineInfo.number - 1,
      character: this.stringOffsetToUtf8ByteOffset(lineInfo.text, characterOffset)
    };
  }

  private stringOffsetToUtf8ByteOffset(text: string, stringOffset: number): number {
    const target = Math.max(0, stringOffset);
    let bytes = 0;
    let offset = 0;

    for (const char of text) {
      if (offset >= target) break;
      bytes += new TextEncoder().encode(char).length;
      offset += char.length;
    }

    return bytes;
  }

  private utf8ByteOffsetToStringOffset(text: string, byteOffset: number): number {
    const target = Math.max(0, byteOffset);
    let bytes = 0;
    let offset = 0;

    for (const char of text) {
      const size = new TextEncoder().encode(char).length;
      if (bytes + size > target) break;
      bytes += size;
      offset += char.length;
    }

    return offset;
  }

  private async initializeLsp() {
    return new Promise<void>(async (resolve, reject) => {
      const id = this.requestId++;
      let unlisten: (() => void) | undefined;
      const timeout = window.setTimeout(() => {
        unlisten?.();
        reject(new Error("Tinymist initialize timed out"));
      }, 15000);

      unlisten = await listen<string>("lsp-rx", (event) => {
        try {
          const payload = JSON.parse(event.payload);
          if (payload.id === id) {
            window.clearTimeout(timeout);
            unlisten?.();
            if (payload.error) {
              reject(new Error(payload.error.message ?? "Tinymist initialize failed"));
              return;
            }
            this.sendNotification("initialized", {});
            resolve();
          }
        } catch (e) {
          window.clearTimeout(timeout);
          unlisten?.();
          reject(e);
        }
      });

      void this.sendRequest("initialize", {
        processId: null,
        capabilities: {
          textDocument: {
            synchronization: {
              dynamicRegistration: false,
              didSave: true
            },
            publishDiagnostics: {
              relatedInformation: true,
              versionSupport: true
            },
            completion: {
              contextSupport: true,
              completionItem: {
                snippetSupport: true,
                labelDetailsSupport: true,
                resolveSupport: {
                  properties: ['documentation', 'detail', 'additionalTextEdits']
                }
              }
            }
          },
          workspace: {
            configuration: true
          }
        },
        initializationOptions: {
          exportPdf: "never",
          exportSvg: "never",
          exportPng: "never",
          formatterMode: "typstyle",
          preview: {
            background: {
              enabled: true,
              args: ["--host", "127.0.0.1:8589"]
            }
          },
          tinymist: {
            exportPdf: "never",
            exportSvg: "never",
            exportPng: "never",
            formatterMode: "typstyle",
            preview: {
              background: {
                enabled: true,
                args: ["--host", "127.0.0.1:8589"]
              }
            }
          }
        },
        workspaceFolders: null
      }, id);
    });
  }

  public openTextDocument(uri: string, text: string, version: number): Promise<void> {
    return this.sendNotification("textDocument/didOpen", {
      textDocument: { uri, languageId: "typst", version, text }
    });
  }

  public startPreview(path: string): Promise<string> {
    // Force tinymist to render this specific file instead of auto-detecting an entry point.
    // NOTE: These commands specifically require the raw OS path, not a URI!
    this.sendRequest("workspace/executeCommand", {
      command: "tinymist.pinMain",
      arguments: [path]
    }, this.requestId++);

    this.sendRequest("workspace/executeCommand", {
      command: "tinymist.focusMain",
      arguments: [path]
    }, this.requestId++);

    // Tinymist 0.15 expects a Vec<String> as the first argument and returns server metadata.
    return new Promise<string>(async (resolve) => {
      this.setStatus("preview-starting", "Starting preview");
      const id = this.requestId++;
      let unlisten: (() => void) | undefined;
      const timeout = setTimeout(() => {
        console.warn("LSP Preview request timed out!");
        unlisten?.();
        this.setStatus("error", "Preview startup timed out");
        resolve("");
      }, 5000);

      unlisten = await listen<string>("lsp-rx", (event) => {
        try {
          const payload = JSON.parse(event.payload);
          if (payload.id === id) {
            clearTimeout(timeout);
            unlisten?.();
            if (payload.error) {
              console.error("Tinymist preview startup failed:", payload.error);
              this.setStatus("error", "Preview startup failed");
              resolve("");
              return;
            }
            const previewUrl = this.normalizePreviewUrl(payload.result);
            this.setStatus(previewUrl ? "preview-ready" : "error", previewUrl ? "Preview ready" : "Preview URL unavailable");
            resolve(previewUrl);
          }
        } catch (e) {}
      });

      this.sendRequest("workspace/executeCommand", {
        command: "tinymist.doStartPreview",
        arguments: [[path]]
      }, id);
    });
  }

  public notifyTextChange(uri: string, text: string, version: number): Promise<void> {
    return this.sendNotification("textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ text }]
    });
  }

  public scrollPreview(taskId: string, request: ScrollPreviewRequest): Promise<void> {
    return this.sendRequest("workspace/executeCommand", {
      command: "tinymist.scrollPreview",
      arguments: [taskId, request]
    });
  }

  public getPreviewHtml(): Promise<string> {
    return new Promise<string>(async (resolve) => {
      const id = this.requestId++;
      let unlisten: (() => void) | undefined;
      const timeout = setTimeout(() => {
        unlisten?.();
        resolve("");
      }, 3000);

      unlisten = await listen<string>("lsp-rx", (event) => {
        try {
          const payload = JSON.parse(event.payload);
          if (payload.id !== id) return;

          clearTimeout(timeout);
          unlisten?.();
          resolve(typeof payload.result === "string" ? payload.result : "");
        } catch {
          clearTimeout(timeout);
          unlisten?.();
          resolve("");
        }
      });

      this.sendRequest("workspace/executeCommand", {
        command: "tinymist.getResources",
        arguments: ["/preview/index.html"]
      }, id);
    });
  }

  public getLatestPreviewUrl(): string {
    return this.latestPreviewUrl;
  }

  public getLatestPreviewDataPlaneUrl(): string {
    return this.latestPreviewDataPlaneUrl;
  }

  private sendRequest(method: string, params: any, customId?: number): Promise<void> {
    return invoke("send_lsp_message", { message: JSON.stringify({ jsonrpc: "2.0", id: customId ?? this.requestId++, method, params }) });
  }

  public request(method: string, params: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = this.requestId++;
      const timeout = window.setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`LSP request timeout for ${method}`));
      }, 5000);
      
      this.pendingRequests.set(id, { resolve, reject, timeout });
      this.sendRequest(method, params, id).catch(err => {
        this.pendingRequests.delete(id);
        window.clearTimeout(timeout);
        reject(err);
      });
    });
  }

  private sendNotification(method: string, params: any): Promise<void> {
    return invoke("send_lsp_message", { message: JSON.stringify({ jsonrpc: "2.0", method, params }) });
  }

  private sendResponse(id: number | string, result: any): Promise<void> {
    return invoke("send_lsp_message", { message: JSON.stringify({ jsonrpc: "2.0", id, result }) });
  }

  private normalizePreviewUrl(result: string | TinymistPreviewResult | null | undefined): string {
    this.latestPreviewUrl = "";
    this.latestPreviewDataPlaneUrl = "";

    if (typeof result === "string") {
      this.latestPreviewUrl = result.startsWith("http") ? result : `http://${result}`;
      this.latestPreviewDataPlaneUrl = this.latestPreviewUrl.replace(/^http/, "ws");
      return this.latestPreviewUrl;
    }

    if (result?.staticServerAddr) {
      const previewUrl = result.staticServerAddr.startsWith("http")
        ? result.staticServerAddr
        : `http://${result.staticServerAddr}`;
      this.latestPreviewUrl = previewUrl;
      this.latestPreviewDataPlaneUrl = result.dataPlanePort
        ? `ws://127.0.0.1:${result.dataPlanePort}`
        : previewUrl.replace(/^http/, "ws");
      return previewUrl;
    }

    if (result?.staticServerPort) {
      this.latestPreviewUrl = `http://127.0.0.1:${result.staticServerPort}`;
      this.latestPreviewDataPlaneUrl = `ws://127.0.0.1:${result.dataPlanePort ?? result.staticServerPort}`;
      return this.latestPreviewUrl;
    }

    if (result?.dataPlanePort) {
      this.latestPreviewUrl = `http://127.0.0.1:${result.dataPlanePort}`;
      this.latestPreviewDataPlaneUrl = `ws://127.0.0.1:${result.dataPlanePort}`;
      return this.latestPreviewUrl;
    }

    return "";
  }

  private setStatus(kind: LspStatusKind, message: string) {
    this.onStatus({ kind, message });
  }

  private handleServerRequest(payload: any) {
    switch (payload.method) {
      case "client/registerCapability":
      case "client/unregisterCapability":
      case "window/showMessageRequest":
        this.sendResponse(payload.id, null);
        return;
      case "workspace/configuration": {
        this.emitLog(3, "Configuration requested: " + JSON.stringify(payload.params), "workspace/configuration");
        const count = Array.isArray(payload.params?.items) ? payload.params.items.length : 0;

        // tinymist usually asks for multiple items, we should map them based on the section
        const results = (payload.params?.items || []).map((item: any) => {
            if (item.section === "tinymist.exportPdf") return "never";
            if (item.section === "tinymist.exportSvg") return "never";
            if (item.section === "tinymist.exportPng") return "never";
            if (item.section === "tinymist.formatterMode") return "typstyle";
            if (item.section === "tinymist") return { exportPdf: "never", exportSvg: "never", exportPng: "never", formatterMode: "typstyle" };
            return null;
        });

        this.sendResponse(payload.id, results.length > 0 ? results : Array.from({ length: count }, () => null));
        return;
      }
      case "window/showDocument": {
        this.sendResponse(payload.id, { success: true });
        if (this.editorView) {
          const position = payload.params?.selection?.start;
          if (!position || typeof position.line !== "number") return;

          try {
            const defaultCursorPos = this.editorPositionFromLspPosition(position);
            const mappedSelection = this.onInverseSync(position, defaultCursorPos);
            const selection = typeof mappedSelection === "number"
              ? { anchor: mappedSelection }
              : mappedSelection && typeof mappedSelection.anchor === "number"
                ? mappedSelection
                : { anchor: defaultCursorPos };
            const scrollPos = selection.head ?? selection.anchor;
            this.editorView.dispatch({
              selection,
              effects: EditorView.scrollIntoView(scrollPos, { y: "center" })
            });
            this.editorView.focus();
          } catch (err) {
            console.warn("Could not scroll to preview source position", position, err);
          }
        }
        return;
      }
      default:
        if (payload.method.startsWith("$/")) {
          return;
        }
        this.sendResponse(payload.id, null);
    }
  }

  private emitLog(type: number | undefined, message: unknown, source: string) {
    const text = typeof message === "string" ? message : JSON.stringify(message ?? "");
    if (!text || text.includes("cannot register preview to the compiler instance") || text.includes("cannot export multiple images without a page number template")) return;

    this.onLog({
      kind: this.logKindFromLspType(type),
      source,
      message: text
    });
  }

  private logKindFromLspType(type: number | undefined): LspLogEntry["kind"] {
    switch (type) {
      case 1:
        return "error";
      case 2:
        return "warning";
      case 3:
        return "info";
      default:
        return "log";
    }
  }
}

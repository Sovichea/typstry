import { EditorView } from "@codemirror/view";
import type { Text } from "@codemirror/state";
import { TauriLspTransport } from "./lspTransport";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { asRecord, isRecord, type JsonRpcId, type JsonRpcMessage } from "./jsonRpc";

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
} | {
  event: "panelScrollByPosition";
  position: PreviewDocumentPosition;
};

export type PreviewDocumentPosition = {
  page_no: number;
  x: number;
  y: number;
};

export type TinymistDocumentOutlineItem = {
  title: string;
  position: PreviewDocumentPosition;
  span?: string;
  children: TinymistDocumentOutlineItem[];
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

type LspPositionEncoding = "utf-8" | "utf-16" | "utf-32";

function isLspDiagnostic(value: unknown): value is LspDiagnostic {
  if (!isRecord(value) || typeof value.message !== "string") return false;
  const range = asRecord(value.range);
  const start = asRecord(range?.start);
  const end = asRecord(range?.end);
  return typeof start?.line === "number" && typeof end?.line === "number";
}

function tinymistOutlineItem(value: unknown): TinymistDocumentOutlineItem | null {
  const item = asRecord(value);
  const position = asRecord(item?.position);
  if (
    typeof item?.title !== "string" ||
    typeof position?.page_no !== "number" ||
    typeof position.x !== "number" ||
    typeof position.y !== "number"
  ) return null;
  const children = Array.isArray(item.children)
    ? item.children.map(tinymistOutlineItem).filter((child): child is TinymistDocumentOutlineItem => child !== null)
    : [];
  return {
    title: item.title,
    position: { page_no: position.page_no, x: position.x, y: position.y },
    span: typeof item.span === "string" ? item.span : undefined,
    children
  };
}

export class TinymistLspClient {
  private requestId = 0;
  private editorView?: EditorView;
  private latestPreviewUrl = "";
  private latestPreviewDataPlaneUrl = "";
  private positionEncoding: LspPositionEncoding = "utf-16";
  private readonly transport = new TauriLspTransport();
  private transportListeners: Promise<void> | null = null;
  private unlistenTransport: UnlistenFn[] = [];
  private pendingRequests = new Map<number, { resolve: (result: unknown) => void; reject: (error: unknown) => void; timeout?: number }>();

  constructor(
    private onSvgPreviewStream: (svgContent: string) => void,
    private onStatus: (status: LspStatus) => void = () => {},
    private onInverseSync: (uri: string | undefined, position: LspSourcePosition) => number | LspEditorSelection | void | Promise<number | LspEditorSelection | void> = () => {},
    private onDiagnostics: (uri: string, diagnostics: LspDiagnostic[], version?: number) => void = () => {},
    private onLog: (entry: LspLogEntry) => void = () => {},
    private onDocumentOutline: (items: TinymistDocumentOutlineItem[]) => void = () => {}
  ) {}

  public setEditorView(view: EditorView) {
    this.editorView = view;
  }

  public async connect(): Promise<void> {
    try {
      this.setStatus("starting", "Starting Tinymist");
      await this.ensureTransportListeners();
      await this.transport.start();
      this.setStatus("running", "Tinymist process running");

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
    await this.ensureTransportListeners();
    await this.transport.start();
    this.setStatus("running", "Tinymist process running");
    this.setStatus("initializing", "Initializing LSP");
    await this.initializeLsp();
    this.setStatus("ready", "LSP ready");
  }

  public dispose(): void {
    for (const unlisten of this.unlistenTransport.splice(0)) unlisten();
    this.transportListeners = null;
  }

  private ensureTransportListeners(): Promise<void> {
    if (this.transportListeners) return this.transportListeners;
    this.transportListeners = Promise.all([
      this.transport.listenStatus(status => {
        if (status === "stopped") this.setStatus("stopped", "Tinymist stopped");
        else if (status === "running") this.setStatus("running", "Tinymist process running");
      }),
      this.transport.listenMessages(message => this.handleMessage(message))
    ]).then(unlisteners => {
      this.unlistenTransport.push(...unlisteners);
    });
    return this.transportListeners;
  }

  private handleMessage(payload: JsonRpcMessage) {
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

    const params = asRecord(payload.params);
    if (payload.method === "tinymist/preview/svgStream") {
      if (typeof params?.svg === "string") this.onSvgPreviewStream(params.svg);
    }

    // Sometimes tinymist sends logs or errors!
    if (payload.method === "window/showMessage") {
      this.emitLog(typeof params?.type === "number" ? params.type : undefined, params?.message, "showMessage");
    }

    if (payload.method === "window/logMessage") {
      this.emitLog(typeof params?.type === "number" ? params.type : undefined, params?.message, "logMessage");
    }

    if (payload.method === "textDocument/publishDiagnostics") {
      if (typeof params?.uri === "string" && Array.isArray(params.diagnostics)) {
        this.onDiagnostics(
          params.uri,
          params.diagnostics.filter(isLspDiagnostic),
          typeof params.version === "number" ? params.version : undefined
        );
      }
    }

    if (payload.method === "tinymist/documentOutline" && Array.isArray(params?.items)) {
      this.onDocumentOutline(
        params.items.map(tinymistOutlineItem).filter((item): item is TinymistDocumentOutlineItem => item !== null)
      );
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
    const character = this.stringOffsetFromLspCharacter(lineInfo.text, position.character ?? 0);
    return lineInfo.from + character;
  }

  public lspPositionFromEditorPosition(doc: Text, offset: number): LspSourcePosition {
    const lineInfo = doc.lineAt(offset);
    const characterOffset = offset - lineInfo.from;
    return {
      line: lineInfo.number - 1,
      character: this.lspCharacterFromStringOffset(lineInfo.text, characterOffset)
    };
  }

  public stringOffsetFromLspCharacter(text: string, character: number): number {
    const target = Math.max(0, character);

    if (this.positionEncoding === "utf-16") {
      return Math.min(target, text.length);
    }

    if (this.positionEncoding === "utf-32") {
      let codePoints = 0;
      let offset = 0;
      for (const char of text) {
        if (codePoints >= target) break;
        codePoints++;
        offset += char.length;
      }
      return offset;
    }

    return this.utf8ByteOffsetToStringOffset(text, target);
  }

  public lspCharacterFromStringOffset(text: string, stringOffset: number): number {
    const target = Math.max(0, Math.min(stringOffset, text.length));

    if (this.positionEncoding === "utf-16") {
      return target;
    }

    if (this.positionEncoding === "utf-32") {
      let codePoints = 0;
      let offset = 0;
      for (const char of text) {
        if (offset >= target) break;
        codePoints++;
        offset += char.length;
      }
      return codePoints;
    }

    return this.stringOffsetToUtf8ByteOffset(text, target);
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
    const result = await this.request<unknown>("initialize", {
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
      }, 15000);
    const capabilities = asRecord(asRecord(result)?.capabilities);
    this.positionEncoding = this.normalizePositionEncoding(capabilities?.positionEncoding);
    await this.sendNotification("initialized", {});
  }

  private normalizePositionEncoding(value: unknown): LspPositionEncoding {
    return value === "utf-8" || value === "utf-16" || value === "utf-32" ? value : "utf-16";
  }

  public openTextDocument(uri: string, text: string, version: number): Promise<void> {
    return this.sendNotification("textDocument/didOpen", {
      textDocument: { uri, languageId: "typst", version, text }
    });
  }

  public async startPreview(path: string): Promise<string> {
    // Force tinymist to render this specific file instead of auto-detecting an entry point.
    // NOTE: These commands specifically require the raw OS path, not a URI!
    void this.sendRequest("workspace/executeCommand", {
      command: "tinymist.pinMain",
      arguments: [path]
    }, this.requestId++);

    void this.sendRequest("workspace/executeCommand", {
      command: "tinymist.focusMain",
      arguments: [path]
    }, this.requestId++);

    this.setStatus("preview-starting", "Starting preview");
    try {
      const result = await this.request<string | TinymistPreviewResult | null>("workspace/executeCommand", {
        command: "tinymist.doStartPreview",
        arguments: [[path]]
      }, 5000);
      const previewUrl = this.normalizePreviewUrl(result);
      this.setStatus(previewUrl ? "preview-ready" : "error", previewUrl ? "Preview ready" : "Preview URL unavailable");
      return previewUrl;
    } catch (error) {
      console.error("Tinymist preview startup failed:", error);
      this.setStatus("error", "Preview startup failed");
      return "";
    }
  }

  public notifyTextChange(uri: string, text: string, version: number): Promise<void> {
    return this.sendNotification("textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ text }]
    });
  }

  public notifyWorkspaceFilesChanged(changes: { uri: string; type: 1 | 2 | 3 }[]): Promise<void> {
    return this.sendNotification("workspace/didChangeWatchedFiles", { changes });
  }

  public scrollPreview(taskId: string, request: ScrollPreviewRequest): Promise<void> {
    return this.sendRequest("workspace/executeCommand", {
      command: "tinymist.scrollPreview",
      arguments: [taskId, request]
    });
  }

  public async getPreviewHtml(): Promise<string> {
    try {
      const result = await this.request<unknown>("workspace/executeCommand", {
        command: "tinymist.getResources",
        arguments: ["/preview/index.html"]
      }, 3000);
      return typeof result === "string" ? result : "";
    } catch {
      return "";
    }
  }

  public getLatestPreviewUrl(): string {
    return this.latestPreviewUrl;
  }

  public getLatestPreviewDataPlaneUrl(): string {
    return this.latestPreviewDataPlaneUrl;
  }

  private sendRequest(method: string, params: unknown, customId?: number): Promise<void> {
    return this.transport.send({ jsonrpc: "2.0", id: customId ?? this.requestId++, method, params });
  }

  public request<T = unknown>(method: string, params: unknown, timeoutMs = 5000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = this.requestId++;
      const timeout = window.setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`LSP request timeout for ${method}`));
      }, timeoutMs);
      
      this.pendingRequests.set(id, { resolve: result => resolve(result as T), reject, timeout });
      this.sendRequest(method, params, id).catch(err => {
        this.pendingRequests.delete(id);
        window.clearTimeout(timeout);
        reject(err);
      });
    });
  }

  private sendNotification(method: string, params: unknown): Promise<void> {
    return this.transport.send({ jsonrpc: "2.0", method, params });
  }

  private sendResponse(id: JsonRpcId, result: unknown): Promise<void> {
    return this.transport.send({ jsonrpc: "2.0", id, result });
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

  private handleServerRequest(payload: JsonRpcMessage) {
    if (payload.id === undefined || !payload.method) return;
    switch (payload.method) {
      case "client/registerCapability":
      case "client/unregisterCapability":
      case "window/showMessageRequest":
        void this.sendResponse(payload.id, null);
        return;
      case "workspace/configuration": {
        this.emitLog(3, "Configuration requested: " + JSON.stringify(payload.params), "workspace/configuration");
        const params = asRecord(payload.params);
        const items = Array.isArray(params?.items) ? params.items : [];

        const results = items.map(item => {
            const section = asRecord(item)?.section;
            if (section === "tinymist.exportPdf") return "never";
            if (section === "tinymist.exportSvg") return "never";
            if (section === "tinymist.exportPng") return "never";
            if (section === "tinymist.formatterMode") return "typstyle";
            if (section === "tinymist") return { exportPdf: "never", exportSvg: "never", exportPng: "never", formatterMode: "typstyle" };
            return null;
        });

        void this.sendResponse(payload.id, results);
        return;
      }
      case "window/showDocument": {
        void this.handleShowDocumentRequest(payload);
        return;
      }
      default:
        if (payload.method.startsWith("$/")) return;
        void this.sendResponse(payload.id, null);
    }
  }

  private async handleShowDocumentRequest(payload: JsonRpcMessage) {
    if (payload.id === undefined) return;
    await this.sendResponse(payload.id, { success: true });
    const params = asRecord(payload.params);
    const selection = asRecord(params?.selection);
    const start = asRecord(selection?.start);
    if (typeof start?.line !== "number") return;
    const position: LspSourcePosition = {
      line: start.line,
      character: typeof start.character === "number" ? start.character : undefined
    };

    try {
      const uri = typeof params?.uri === "string" ? params.uri : undefined;
      const mappedSelection = await this.onInverseSync(uri, position);
      if (!this.editorView) return;

      const defaultCursorPos = this.editorPositionFromLspPosition(position);
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

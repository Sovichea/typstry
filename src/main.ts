import "./style.css";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { open as openUrl } from "@tauri-apps/plugin-shell";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { undo, redo } from "@codemirror/commands";
import { getEditorExtensions, themeCompartment, getThemeExtension, applyUIThemeVariables, wrapCompartment } from "./editor/extensions";
import { setEditorDiagnosticsEffect } from "./editor/diagnostics";
import type { EditorDiagnostic, EditorDiagnosticSeverity } from "./editor/diagnostics";
import { WorkspaceExplorer } from "./components/explorer";
import { TinymistLspClient } from "./compiler/lsp";
import type { LspDiagnostic, LspLogEntry, LspSourcePosition, LspStatus } from "./compiler/lsp";

type EditorMode = "CODE" | "WYSIWYM";
type LogEntryKind = "error" | "warning" | "info" | "log" | "hint";

type LogConsoleEntry = {
  id: number;
  kind: LogEntryKind;
  message: string;
  source: string;
  filePath?: string;
  fileName?: string;
  line?: number;
  column?: number;
  timestamp: Date;
};

type FallbackDiagnostic = {
  severity: "error" | "warning" | "info";
  message: string;
  line?: number;
  column?: number;
};

type PreviewHighlightMapping = {
  lineNumber: number;
  lineFrom: number;
  originalStart: number;
  originalEnd: number;
  highlightedStart: number;
  highlightedEnd: number;
  wrapperEnd: number;
  highlightedLineText: string;
};

class TypstryWorkspaceController {
  private readonly previewTaskId = "default_preview";
  private readonly previewHighlightPrefix = "#highlight[";
  private readonly previewHighlightSuffix = "]";
  private activeMode: EditorMode = "CODE";
  private activeFilePath: string | null = null;
  private previewRootPath: string | null = null;
  private workspaceRootPath: string | null = null;
  private currentVersion = 1;
  private isLoadingFile = false;
  private lspReady = false;
  private readonly lspSyncDebounceMs = 350;
  private readonly forwardSyncDebounceMs = 120;
  private pendingLspSyncTimer: number | null = null;
  private pendingLspSyncPath: string | null = null;
  private pendingLspSyncText: string | null = null;
  private pendingForwardSyncTimer: number | null = null;
  private suppressNextForwardSync = false;
  private previewHighlightMapping: PreviewHighlightMapping | null = null;
  private readonly previewOnlyVersions = new Set<number>();
  private latestDocumentVersion = 1;
  private nextLogEntryId = 1;
  private diagnosticLogEntries: LogConsoleEntry[] = [];
  private lspLogEntries: LogConsoleEntry[] = [];
  private isLogConsoleVisible = false;

  private editorInstance!: EditorView;
  private explorer!: WorkspaceExplorer;
  private lspClient!: TinymistLspClient;

  private codePane = document.getElementById("code-editor-pane")!;
  private wysiwymPane = document.getElementById("wysiwym-editor-pane")!;
  private wysiwymContainer = this.wysiwymPane.querySelector(".wysiwym-container")!;
  private previewPane = document.getElementById("preview-render-pane")!;
  private previewIframe: HTMLIFrameElement | null = null;
  private lspStatus = document.getElementById("lsp-status")!;
  private lspStatusDot = this.lspStatus.querySelector(".status-dot") as HTMLElement;
  private lspStatusText = this.lspStatus.querySelector(".status-text") as HTMLElement;
  private logConsole = document.getElementById("log-console")!;
  private logConsoleBody = document.getElementById("log-console-body")!;
  private logConsoleToggle = document.getElementById("log-console-toggle") as HTMLButtonElement;
  private logConsoleClose = document.getElementById("log-console-close") as HTMLButtonElement;
  private logConsoleClear = document.getElementById("log-console-clear") as HTMLButtonElement;
  private diagnosticCount = document.getElementById("diagnostic-count")!;

  public async bootstrap() {
    this.initCodeMirror();
    this.initExplorer();
    this.bindGlobalEvents();
    this.initResizers();
    this.initUndockPreview();
    this.initThemeSelector();
    this.initWordWrap();
    this.renderLogConsole();
    this.setLogConsoleVisible(false);
    this.updateWorkspaceViewportVisibility();

    await getCurrentWindow().show();

    this.setLspStatus({ kind: "starting", message: "Preparing toolchain" });
    await this.ensureDependencies();
    await this.initLsp();
  }

  private updateWorkspaceViewportVisibility() {
    const welcomeScreen = document.getElementById("welcome-screen");
    const inputWrapper = document.getElementById("input-container-wrapper");
    const previewWrapper = document.getElementById("preview-container-wrapper");
    const resizer = document.getElementById("editor-preview-resizer");
    const explorerSidebar = document.getElementById("explorer-sidebar");
    const explorerResizer = document.getElementById("explorer-resizer");

    if (this.activeFilePath || this.workspaceRootPath) {
      welcomeScreen?.classList.add("hidden");
      inputWrapper?.classList.remove("hidden");
      previewWrapper?.classList.remove("hidden");
      resizer?.classList.remove("hidden");
    } else {
      welcomeScreen?.classList.remove("hidden");
      inputWrapper?.classList.add("hidden");
      previewWrapper?.classList.add("hidden");
      resizer?.classList.add("hidden");
    }

    if (this.workspaceRootPath) {
      explorerSidebar?.classList.remove("hidden");
      explorerResizer?.classList.remove("hidden");
    } else {
      explorerSidebar?.classList.add("hidden");
      explorerResizer?.classList.add("hidden");
    }
  }

  private initThemeSelector() {
    const themeSelector = document.getElementById("editor-theme-selector") as HTMLSelectElement;
    if (themeSelector) {
      // Try to load saved theme
      const savedTheme = localStorage.getItem("typstry-theme") || "default";
      themeSelector.value = savedTheme;
      applyUIThemeVariables(savedTheme);
      if (savedTheme !== "default") {
          this.editorInstance.dispatch({
              effects: themeCompartment.reconfigure(getThemeExtension(savedTheme))
          });
      }

      themeSelector.addEventListener("change", (e) => {
        const themeName = (e.target as HTMLSelectElement).value;
        localStorage.setItem("typstry-theme", themeName);
        applyUIThemeVariables(themeName);
        this.editorInstance.dispatch({
          effects: themeCompartment.reconfigure(getThemeExtension(themeName))
        });
      });
    }
  }

  private initWordWrap() {
    const wrapToggleBtn = document.getElementById("word-wrap-toggle");
    const wrapLabel = document.getElementById("word-wrap-label");
    
    if (wrapToggleBtn && wrapLabel) {
      // Load preference from localStorage, default to true
      let isWrapEnabled = localStorage.getItem("typstry-word-wrap") !== "false";
      
      const applyWrapState = () => {
        wrapLabel.textContent = isWrapEnabled ? "Wrap: On" : "Wrap: Off";
        this.editorInstance.dispatch({
            effects: wrapCompartment.reconfigure(isWrapEnabled ? EditorView.lineWrapping : [])
        });
      };

      // Apply initial state
      applyWrapState();

      // Toggle listener
      wrapToggleBtn.addEventListener("click", () => {
        isWrapEnabled = !isWrapEnabled;
        localStorage.setItem("typstry-word-wrap", isWrapEnabled.toString());
        applyWrapState();
      });
    }
  }

  private async ensureDependencies() {
    this.previewPane.innerHTML = `<div style="padding: 20px; color: #007acc; font-family: sans-serif; text-align: center;">
      <h3>Initializing Typstry Editor</h3>
      <p>Checking and downloading required compiler toolchains (Typst, Tinymist). This may take a minute...</p>
    </div>`;

    try {
      await invoke("ensure_toolchain");
    } catch (e) {
      console.error("Toolchain setup failed:", e);
      this.previewPane.innerHTML = `<div style="padding: 20px; color: red;">Failed to download toolchain: ${e}</div>`;
      return;
    }

    this.previewPane.innerHTML = `<div style="padding: 20px; color: #008000; font-family: sans-serif; text-align: center;">Toolchain Ready.</div>`;
  }

  private initCodeMirror() {
    this.editorInstance = new EditorView({
      state: EditorState.create({
        doc: "= Welcome to Typstry\nSelect a file from the explorer to begin configuration editing.",
        extensions: [
          getEditorExtensions(),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              this.clearPendingForwardSync();
              this.handleContentMutation(update.state.doc.toString());
            } else if (update.selectionSet) {
              this.scheduleForwardSync(this.forwardSyncDebounceMs);
            }
          })
        ]
      }),
      parent: this.codePane
    });
  }

  private initExplorer() {
    this.explorer = new WorkspaceExplorer(document.getElementById("explorer-sidebar")!, (path) => this.loadFile(path));
  }

  private async initLsp() {
    this.lspClient = new TinymistLspClient(
      () => {},
      (status) => this.setLspStatus(status),
      (position, defaultCursorPos) => this.handleInverseSync(position, defaultCursorPos),
      (uri, diagnostics, version) => this.handleLspDiagnostics(uri, diagnostics, version),
      (entry) => this.appendLspLog(entry)
    );
    try {
      await this.lspClient.connect();
      this.lspReady = true;
    } catch (e) {
      this.lspReady = false;
      console.warn("Tinymist LSP instance offline.", e);
    }
    this.lspClient.setEditorView(this.editorInstance);
  }

  private async loadFile(path: string) {
    try {
      const contents: string = await invoke("read_workspace_file", { path });
      this.currentVersion = 1;
      this.latestDocumentVersion = 1;
      this.previewOnlyVersions.clear();
      this.previewHighlightMapping = null;
      this.clearDiagnostics();

      this.isLoadingFile = true;
      try {
        this.editorInstance.dispatch({
          changes: { from: 0, to: this.editorInstance.state.doc.length, insert: contents }
        });
      } finally {
        this.isLoadingFile = false;
      }

      this.activeFilePath = path;
      this.previewRootPath = await invoke<string | null>("resolve_preview_main", {
        filePath: path,
        workspaceRootPath: this.workspaceRootPath
      });
      this.clearPendingLspSync();
      this.clearPendingForwardSync();

      if (this.lspReady && this.lspClient) {
        const uri = this.filePathToUri(path);
        await this.lspClient.openTextDocument(uri, contents, this.currentVersion);
        void this.runFallbackDiagnostics(path, contents, this.currentVersion);

        if (this.previewRootPath) {
          this.previewPane.innerHTML = `<div style="padding: 20px; color: #007acc; font-family: sans-serif;">Starting live preview server...</div>`;
          const previewUrl = await this.startPreviewWithRestart(this.previewRootPath, contents);
          if (previewUrl) {
            this.mountPreviewFrame(previewUrl);
          } else {
            this.previewPane.innerHTML = `<div style="padding: 20px; color: red; font-family: sans-serif;">Failed to start live preview server after restart. Check the log console for details.</div>`;
          }
        } else {
          this.previewPane.innerHTML = `<div style="padding: 20px; color: #5f6368; font-family: sans-serif;">No preview root found for this library/template file. Diagnostics are still active.</div>`;
        }
      } else {
        this.previewPane.innerHTML = `<div style="padding: 20px; color: red; font-family: sans-serif;">Tinymist LSP is offline. Live preview is unavailable.</div>`;
      }

      if (this.activeMode === "WYSIWYM") {
        this.mapMarkupToWysiwym(contents);
      }
      this.updateWorkspaceViewportVisibility();
    } catch (e) {
      console.error("Failed to load file:", e);
      alert("Failed to load file: " + e);
    }
  }

  private async startPreviewWithRestart(previewRootPath: string, activeContents: string): Promise<string> {
    const firstAttemptUrl = await this.lspClient.startPreview(previewRootPath);
    if (firstAttemptUrl) {
      return firstAttemptUrl;
    }

    this.appendLspLog({
      kind: "warning",
      source: "preview",
      message: "Preview startup failed. Restarting Tinymist and retrying once."
    });
    this.setLspStatus({ kind: "starting", message: "Restarting preview" });

    try {
      await this.lspClient.restart();
      this.lspReady = true;
      if (!this.activeFilePath || this.previewRootPath !== previewRootPath) {
        return "";
      }

      await this.lspClient.openTextDocument(
        this.filePathToUri(this.activeFilePath),
        activeContents,
        this.currentVersion
      );
      return await this.lspClient.startPreview(previewRootPath);
    } catch (error) {
      this.lspReady = false;
      this.appendLspLog({
        kind: "error",
        source: "preview",
        message: `Preview restart failed: ${String(error)}`
      });
      return "";
    }
  }

  private handleContentMutation(rawText: string) {
    if (!this.isLoadingFile && this.activeFilePath && this.lspReady && this.lspClient) {
      this.pendingLspSyncPath = this.activeFilePath;
      this.pendingLspSyncText = rawText;
      this.setLspStatus({ kind: "sync-pending", message: "Preview update queued" });

      if (this.pendingLspSyncTimer) {
        window.clearTimeout(this.pendingLspSyncTimer);
      }

      this.pendingLspSyncTimer = window.setTimeout(
        () => this.flushPendingLspSync(),
        this.lspSyncDebounceMs
      );
    }
  }

  private flushPendingLspSync() {
    if (this.pendingLspSyncTimer) {
      window.clearTimeout(this.pendingLspSyncTimer);
      this.pendingLspSyncTimer = null;
    }

    if (!this.pendingLspSyncPath || this.pendingLspSyncText === null || !this.lspReady || !this.lspClient) {
      return;
    }

    const path = this.pendingLspSyncPath;
    const text = this.pendingLspSyncText;
    this.pendingLspSyncPath = null;
    this.pendingLspSyncText = null;

    this.setLspStatus({ kind: "syncing", message: "Syncing preview" });
    this.previewHighlightMapping = null;
    this.previewOnlyVersions.clear();
    const version = ++this.currentVersion;
    this.latestDocumentVersion = version;
    this.lspClient.notifyTextChange(this.filePathToUri(path), text, version);
    void this.runFallbackDiagnostics(path, text, version);
    window.setTimeout(() => {
      if (this.lspReady && !this.pendingLspSyncTimer && this.pendingLspSyncText === null) {
        this.setLspStatus({ kind: "preview-ready", message: "Preview update sent" });
      }
    }, 250);
  }

  private async runFallbackDiagnostics(path: string, text: string, version: number) {
    try {
      const diagnostics = await invoke<FallbackDiagnostic[]>("check_typst_document", {
        sourceCode: text,
        filePath: path
      });

      if (version !== this.latestDocumentVersion || path !== this.activeFilePath) {
        return;
      }

      const editorDiagnostics = diagnostics
        .map((diagnostic) => this.editorDiagnosticFromFallback(diagnostic))
        .filter((diagnostic): diagnostic is EditorDiagnostic => diagnostic !== null);

      this.editorInstance.dispatch({
        effects: setEditorDiagnosticsEffect.of(editorDiagnostics)
      });

      this.diagnosticLogEntries = diagnostics.map((diagnostic) => ({
        id: this.nextLogEntryId++,
        kind: diagnostic.severity,
        source: "typst check",
        filePath: path,
        fileName: this.fileNameFromPath(path),
        message: diagnostic.message,
        line: diagnostic.line ?? 1,
        column: diagnostic.column ?? 1,
        timestamp: new Date()
      }));
      this.renderLogConsole();
    } catch (error) {
      this.appendLspLog({
        kind: "error",
        source: "typst check",
        message: `Fallback diagnostics failed: ${String(error)}`
      });
    }
  }

  private editorDiagnosticFromFallback(diagnostic: FallbackDiagnostic): EditorDiagnostic | null {
    if (!diagnostic.line) return null;

    const from = this.editorPositionFromSourceLocation(diagnostic.line, diagnostic.column ?? 1);
    return {
      from,
      to: Math.min(from + 1, this.editorInstance.state.doc.length),
      severity: diagnostic.severity,
      message: diagnostic.message
    };
  }

  private clearPendingLspSync() {
    if (this.pendingLspSyncTimer) {
      window.clearTimeout(this.pendingLspSyncTimer);
      this.pendingLspSyncTimer = null;
    }
    this.pendingLspSyncPath = null;
    this.pendingLspSyncText = null;
  }

  private scheduleForwardSync(delayMs: number) {
    if (!this.activeFilePath || !this.previewRootPath || !this.lspReady || !this.lspClient) {
      return;
    }

    if (this.suppressNextForwardSync) {
      this.suppressNextForwardSync = false;
      this.clearPendingForwardSync();
      return;
    }

    if (this.pendingForwardSyncTimer) {
      window.clearTimeout(this.pendingForwardSyncTimer);
    }

    this.pendingForwardSyncTimer = window.setTimeout(
      () => { void this.flushForwardSync(); },
      delayMs
    );
  }

  private async flushForwardSync() {
    if (this.pendingForwardSyncTimer) {
      window.clearTimeout(this.pendingForwardSyncTimer);
      this.pendingForwardSyncTimer = null;
    }

    const cursor = this.editorInstance.state.selection.main.head;
    await this.renderHighlightedPreviewAtCursor(cursor);
  }

  private async renderHighlightedPreviewAtCursor(cursor: number) {
    if (!this.activeFilePath || this.activeFilePath !== this.previewRootPath || !this.lspReady || !this.lspClient) {
      return;
    }

    const previewHighlight = this.buildHighlightedPreviewSource(cursor);
    if (!previewHighlight) return;

    this.previewHighlightMapping = previewHighlight.mapping;
    const version = ++this.currentVersion;
    this.previewOnlyVersions.add(version);
    await this.lspClient.notifyTextChange(
      this.filePathToUri(this.activeFilePath),
      previewHighlight.text,
      version
    );
    window.setTimeout(() => {
      if (!this.activeFilePath || !this.lspReady || !this.lspClient) return;
      void this.lspClient.scrollPreview(this.previewTaskId, {
        event: "panelScrollTo",
        filepath: this.activeFilePath,
        line: previewHighlight.scrollLine,
        character: previewHighlight.scrollCharacter
      });
    }, 220);
  }

  private clearPendingForwardSync() {
    if (this.pendingForwardSyncTimer) {
      window.clearTimeout(this.pendingForwardSyncTimer);
      this.pendingForwardSyncTimer = null;
    }
  }

  private suppressForwardSyncOnce() {
    this.suppressNextForwardSync = true;
    this.clearPendingForwardSync();
  }

  private handleInverseSync(position: LspSourcePosition, defaultCursorPos: number): number {
    this.suppressForwardSyncOnce();
    const cursor = this.previewSourcePositionToEditorCursor(position, defaultCursorPos);
    window.setTimeout(() => {
      void this.renderHighlightedPreviewAtCursor(cursor);
    }, 0);
    return cursor;
  }

  private previewSourcePositionToEditorCursor(position: LspSourcePosition, defaultCursorPos: number): number {
    const mapping = this.previewHighlightMapping;
    if (!mapping || position.line + 1 !== mapping.lineNumber) {
      return defaultCursorPos;
    }

    const highlightedOffset = this.utf8ByteOffsetToStringOffset(mapping.highlightedLineText, position.character ?? 0);
    let originalOffset: number;

    if (highlightedOffset < mapping.originalStart) {
      originalOffset = highlightedOffset;
    } else if (highlightedOffset < mapping.highlightedStart) {
      originalOffset = mapping.originalStart;
    } else if (highlightedOffset <= mapping.highlightedEnd) {
      originalOffset = mapping.originalStart + highlightedOffset - mapping.highlightedStart;
    } else if (highlightedOffset <= mapping.wrapperEnd) {
      originalOffset = mapping.originalEnd;
    } else {
      originalOffset = highlightedOffset - this.previewHighlightPrefix.length - this.previewHighlightSuffix.length;
    }

    const line = this.editorInstance.state.doc.line(mapping.lineNumber);
    return Math.max(line.from, Math.min(mapping.lineFrom + originalOffset, line.to));
  }

  private mountPreviewFrame(previewUrl: string) {
    this.previewPane.innerHTML = "";
    const iframe = document.createElement("iframe");
    iframe.src = previewUrl;
    iframe.className = "preview-frame";
    iframe.addEventListener("load", () => this.suppressPreviewRippleStyles());
    this.previewPane.appendChild(iframe);
    this.previewIframe = iframe;
  }

  private suppressPreviewRippleStyles() {
    try {
      const doc = this.previewIframe?.contentDocument;
      if (!doc || doc.getElementById("typstry-disable-preview-ripple")) return;

      const style = doc.createElement("style");
      style.id = "typstry-disable-preview-ripple";
      style.textContent = ".typst-jump-ripple{display:none!important;animation:none!important;}";
      doc.head.appendChild(style);
    } catch {
      // The preview server may be cross-origin; in that case Tinymist owns its internals.
    }
  }

  private buildHighlightedPreviewSource(cursor: number): { text: string; scrollLine: number; scrollCharacter: number; mapping: PreviewHighlightMapping } | null {
    const range = this.wordRangeAtCursor(cursor);
    if (!range) return null;

    const text = this.editorInstance.state.doc.toString();
    const prefix = this.previewHighlightPrefix;
    const suffix = this.previewHighlightSuffix;
    const line = this.editorInstance.state.doc.lineAt(range.from);
    const cursorInWord = Math.max(0, Math.min(cursor - range.from, range.to - range.from));
    const originalStart = range.from - line.from;
    const originalEnd = range.to - line.from;
    const linePrefix = line.text.slice(0, originalStart);
    const word = line.text.slice(originalStart, originalEnd);
    const highlightedLinePrefix = `${linePrefix}${prefix}${line.text.slice(originalStart, originalStart + cursorInWord)}`;
    const highlightedLineText = `${linePrefix}${prefix}${word}${suffix}${line.text.slice(originalEnd)}`;

    return {
      text: `${text.slice(0, range.from)}${prefix}${text.slice(range.from, range.to)}${suffix}${text.slice(range.to)}`,
      scrollLine: line.number - 1,
      scrollCharacter: this.utf8ByteLength(highlightedLinePrefix),
      mapping: {
        lineNumber: line.number,
        lineFrom: line.from,
        originalStart,
        originalEnd,
        highlightedStart: originalStart + prefix.length,
        highlightedEnd: originalStart + prefix.length + word.length,
        wrapperEnd: originalEnd + prefix.length + suffix.length,
        highlightedLineText
      }
    };
  }

  private wordRangeAtCursor(cursor: number): { from: number; to: number } | null {
    const doc = this.editorInstance.state.doc;
    if (!doc.length) return null;

    const line = doc.lineAt(Math.min(cursor, doc.length));
    const lineText = line.text;
    let index = Math.max(0, Math.min(cursor - line.from, lineText.length));

    if (index === lineText.length || !this.isWordChar(lineText[index])) {
      const previousIndex = this.previousCodePointIndex(lineText, index);
      if (previousIndex === null || !this.isWordChar(lineText[previousIndex])) {
        return null;
      }
      index = previousIndex;
    }

    let start = index;
    while (true) {
      const previousIndex = this.previousCodePointIndex(lineText, start);
      if (previousIndex === null || !this.isWordChar(lineText[previousIndex])) break;
      start = previousIndex;
    }

    let end = index;
    while (end < lineText.length && this.isWordChar(lineText[end])) {
      end += lineText.codePointAt(end)! > 0xffff ? 2 : 1;
    }

    return end > start ? { from: line.from + start, to: line.from + end } : null;
  }

  private previousCodePointIndex(text: string, index: number): number | null {
    if (index <= 0) return null;
    const previous = index - 1;
    return previous > 0 && /[\uDC00-\uDFFF]/.test(text[previous]) ? previous - 1 : previous;
  }

  private isWordChar(char: string | undefined): boolean {
    return !!char && /[\p{L}\p{N}\p{M}_-]/u.test(char);
  }

  private utf8ByteLength(text: string): number {
    return new TextEncoder().encode(text).length;
  }

  private filePathToUri(path: string): string {
    const normalizedPath = path.replace(/\\/g, "/");
    const encodedPath = normalizedPath
      .split("/")
      .map((part, index) => index === 0 && /^[A-Za-z]:$/.test(part) ? part : encodeURIComponent(part))
      .join("/");

    return `file:///${encodedPath}`;
  }

  private filePathFromUri(uri: string): string {
    if (uri.startsWith("file:///")) {
      const decodedPath = uri
        .slice("file:///".length)
        .split("/")
        .map(decodeURIComponent)
        .join("/");
      if (!/^[A-Za-z]:/.test(decodedPath)) {
        return "/" + decodedPath;
      }
      return decodedPath;
    }
    if (uri.startsWith("file://")) {
      return decodeURIComponent(uri.slice("file://".length));
    }
    return uri;
  }

  private fileNameFromPath(path: string): string {
    const normalizedPath = path.replace(/\\/g, "/");
    const parts = normalizedPath.split("/");
    return parts[parts.length - 1] || path;
  }

  private setLspStatus(status: LspStatus) {
    this.lspStatus.dataset.state = status.kind;
    this.lspStatusDot.setAttribute("aria-label", status.message);
    this.lspStatusText.textContent = status.message;

    if (status.kind === "stopped" || status.kind === "error") {
      this.lspReady = false;
    }
  }

  private handleLspDiagnostics(uri: string, diagnostics: LspDiagnostic[], version?: number) {
    if (typeof version === "number") {
      if (this.previewOnlyVersions.delete(version)) return;
      if (version < this.latestDocumentVersion) return;
    }

    if (!this.activeFilePath || uri !== this.filePathToUri(this.activeFilePath)) {
      return;
    }

    const editorDiagnostics = diagnostics
      .map((diagnostic) => this.editorDiagnosticFromLsp(diagnostic))
      .filter((diagnostic): diagnostic is EditorDiagnostic => diagnostic !== null);

    this.editorInstance.dispatch({
      effects: setEditorDiagnosticsEffect.of(editorDiagnostics)
    });

    this.diagnosticLogEntries = diagnostics.map((diagnostic) => this.logEntryFromDiagnostic(uri, diagnostic));
    this.renderLogConsole();
  }

  private editorDiagnosticFromLsp(diagnostic: LspDiagnostic): EditorDiagnostic | null {
    const from = this.editorPositionFromLspPosition(diagnostic.range.start);
    const to = this.editorPositionFromLspPosition(diagnostic.range.end);
    if (from === null || to === null) return null;

    return {
      from,
      to: Math.max(from, to),
      severity: this.diagnosticSeverityFromLsp(diagnostic.severity),
      message: diagnostic.message
    };
  }

  private logEntryFromDiagnostic(uri: string, diagnostic: LspDiagnostic): LogConsoleEntry {
    const filePath = this.filePathFromUri(uri);
    return {
      id: this.nextLogEntryId++,
      kind: this.diagnosticSeverityFromLsp(diagnostic.severity),
      source: diagnostic.source ?? "typst",
      filePath,
      fileName: this.fileNameFromPath(filePath),
      message: diagnostic.message,
      line: diagnostic.range.start.line + 1,
      column: (diagnostic.range.start.character ?? 0) + 1,
      timestamp: new Date()
    };
  }

  private appendLspLog(entry: LspLogEntry) {
    this.lspLogEntries.unshift({
      id: this.nextLogEntryId++,
      kind: entry.kind,
      source: entry.source ?? "tinymist",
      message: entry.message,
      timestamp: new Date()
    });

    this.lspLogEntries = this.lspLogEntries.slice(0, 100);
    this.renderLogConsole();
  }

  private clearDiagnostics() {
    this.diagnosticLogEntries = [];
    if (this.editorInstance) {
      this.editorInstance.dispatch({
        effects: setEditorDiagnosticsEffect.of([])
      });
    }
    this.renderLogConsole();
  }

  private diagnosticSeverityFromLsp(severity: number | undefined): EditorDiagnosticSeverity {
    switch (severity) {
      case 1:
        return "error";
      case 2:
        return "warning";
      case 3:
        return "info";
      case 4:
        return "hint";
      default:
        return "info";
    }
  }

  private editorPositionFromLspPosition(position: LspSourcePosition): number | null {
    const doc = this.editorInstance.state.doc;
    if (!doc.length) return 0;

    const lineNumber = Math.max(1, Math.min(position.line + 1, doc.lines));
    const line = doc.line(lineNumber);
    const character = this.utf8ByteOffsetToStringOffset(line.text, position.character ?? 0);
    return Math.max(line.from, Math.min(line.from + character, line.to));
  }

  private renderLogConsole() {
    this.updateDiagnosticCount();
    this.logConsoleBody.replaceChildren();

    const entries = [...this.diagnosticLogEntries, ...this.lspLogEntries];
    if (!entries.length) {
      const empty = document.createElement("div");
      empty.className = "log-console-empty";
      empty.textContent = "No problems";
      this.logConsoleBody.appendChild(empty);
      return;
    }

    const groups = new Map<string, LogConsoleEntry[]>();
    for (const entry of entries) {
      const groupKey = entry.filePath ?? entry.source ?? "Other";
      if (!groups.has(groupKey)) {
        groups.set(groupKey, []);
      }
      groups.get(groupKey)!.push(entry);
    }

    for (const [key, groupEntries] of groups.entries()) {
      this.logConsoleBody.appendChild(this.createLogGroupElement(key, groupEntries));
    }
  }

  private dirnameFromPath(path: string): string {
    const normalized = path.replace(/\\/g, "/");
    const lastSlash = normalized.lastIndexOf("/");
    return lastSlash > 0 ? normalized.slice(0, lastSlash) : "";
  }

  private createLogGroupElement(groupKey: string, entries: LogConsoleEntry[]): HTMLElement {
    const groupContainer = document.createElement("div");
    groupContainer.className = "log-group";

    const header = document.createElement("button");
    header.className = "log-group-header";
    header.type = "button";

    const firstEntry = entries[0];
    const fileName = firstEntry.fileName ?? groupKey;
    let dirName = "";
    if (firstEntry.filePath) {
        dirName = this.dirnameFromPath(firstEntry.filePath);
    } else if (groupKey !== fileName && groupKey.endsWith(fileName)) {
        dirName = groupKey.slice(0, -(fileName.length + 1));
    }

    const nameSpan = document.createElement("span");
    nameSpan.className = "log-group-filename";
    nameSpan.textContent = fileName;

    const dirSpan = document.createElement("span");
    dirSpan.className = "log-group-dirname";
    dirSpan.textContent = dirName;

    const countBadge = document.createElement("span");
    countBadge.className = "log-group-count";
    countBadge.textContent = String(entries.length);

    header.append(nameSpan, dirSpan, countBadge);

    const itemsContainer = document.createElement("div");
    itemsContainer.className = "log-group-items";

    for (const entry of entries) {
      itemsContainer.appendChild(this.createLogEntryElement(entry));
    }

    header.addEventListener("click", () => {
      itemsContainer.classList.toggle("hidden");
    });

    groupContainer.append(header, itemsContainer);
    return groupContainer;
  }

  private createLogEntryElement(entry: LogConsoleEntry): HTMLElement {
    const item = document.createElement("button");
    item.type = "button";
    item.className = `log-entry log-entry-${entry.kind}`;

    const severityIcon = document.createElement("span");
    severityIcon.className = "log-entry-icon";
    if (entry.kind === "error") {
      severityIcon.textContent = "⊗";
    } else if (entry.kind === "warning") {
      severityIcon.textContent = "⚠";
    } else {
      severityIcon.textContent = "ℹ";
    }

    const message = document.createElement("span");
    message.className = "log-entry-message";
    message.textContent = entry.message;

    const source = document.createElement("span");
    source.className = "log-entry-source";
    source.textContent = entry.source ? `typst(${entry.source})` : "";

    const location = document.createElement("span");
    location.className = "log-entry-position";
    if (entry.line) {
      location.textContent = `[Ln ${entry.line}, Col ${entry.column ?? 1}]`;
    }

    item.append(severityIcon, message, source, location);
    
    item.addEventListener("click", async () => {
      if (!entry.line) return;
      if (entry.filePath && entry.filePath !== this.activeFilePath) {
        await this.loadFile(entry.filePath);
      }
      const cursor = this.editorPositionFromSourceLocation(entry.line, entry.column ?? 1);
      this.editorInstance.dispatch({
        selection: { anchor: cursor },
        effects: EditorView.scrollIntoView(cursor, { y: "center" })
      });
      this.editorInstance.focus();
    });

    return item;
  }

  private updateDiagnosticCount() {
    const errorCount = this.diagnosticLogEntries.filter((entry) => entry.kind === "error").length;
    const warningCount = this.diagnosticLogEntries.filter((entry) => entry.kind === "warning").length;
    const totalCount = this.diagnosticLogEntries.length;
    const state = errorCount ? "error" : warningCount ? "warning" : "ok";

    this.diagnosticCount.textContent = totalCount > 99 ? "99+" : String(totalCount);
    this.logConsoleToggle.dataset.state = state;
    this.logConsoleToggle.setAttribute("aria-expanded", String(this.isLogConsoleVisible));
    this.logConsoleToggle.setAttribute(
      "aria-label",
      `${this.isLogConsoleVisible ? "Hide" : "Show"} log console, ${totalCount} problem${totalCount === 1 ? "" : "s"}`
    );
  }

  private setLogConsoleVisible(visible: boolean) {
    this.isLogConsoleVisible = visible;
    this.logConsole.classList.toggle("hidden", !visible);
    this.updateDiagnosticCount();
  }

  private toggleLogConsole() {
    this.setLogConsoleVisible(!this.isLogConsoleVisible);
  }

  private switchViewLayoutMode() {
    if (this.activeMode === "CODE") {
      this.activeMode = "WYSIWYM";
      this.mapMarkupToWysiwym(this.editorInstance.state.doc.toString());
      this.codePane.classList.add("hidden");
      this.wysiwymPane.classList.remove("hidden");
    } else {
      this.activeMode = "CODE";
      const markup = this.mapWysiwymToMarkup();
      this.editorInstance.dispatch({
        changes: { from: 0, to: this.editorInstance.state.doc.length, insert: markup }
      });
      this.wysiwymPane.classList.add("hidden");
      this.codePane.classList.remove("hidden");
    }
  }

  private bindGlobalEvents() {
    listen("menu-toggle-layout", () => this.switchViewLayoutMode());
    listen("menu-toggle-log-console", () => this.toggleLogConsole());
    listen("menu-open-folder", async () => {
      const selected = await open({ directory: true, multiple: false });
      if (typeof selected === "string") {
        this.workspaceRootPath = selected;
        this.explorer.loadWorkspace(selected);
        this.updateWorkspaceViewportVisibility();
      }
    });

    document.getElementById("action-open-folder")?.addEventListener("click", async () => {
      const selected = await open({ directory: true, multiple: false });
      if (typeof selected === "string") {
        this.workspaceRootPath = selected;
        this.explorer.loadWorkspace(selected);
        this.updateWorkspaceViewportVisibility();
      }
    });

    document.getElementById("action-new-file")?.addEventListener("click", () => {
      this.activeFilePath = null;
      this.editorInstance.dispatch({
        changes: { from: 0, to: this.editorInstance.state.doc.length, insert: "" }
      });
      this.setLspStatus({ kind: "preview-ready", message: "New Unsaved File" });
      this.updateWorkspaceViewportVisibility();
    });

    document.getElementById("action-open-file")?.addEventListener("click", async () => {
      const selected = await open({ multiple: false });
      if (typeof selected === "string") {
        this.loadFile(selected);
      }
    });

    document.getElementById("action-save-file")?.addEventListener("click", async () => {
      if (this.activeFilePath) {
        try {
          const { writeTextFile } = await import("@tauri-apps/plugin-fs");
          const content = this.editorInstance.state.doc.toString();
          await writeTextFile(this.activeFilePath, content);
          this.setLspStatus({ kind: "preview-ready", message: "File saved" });
        } catch (e) {
          console.error("Save failed:", e);
        }
      }
    });

    document.getElementById("action-export-pdf")?.addEventListener("click", async () => {
      if (this.activeFilePath) {
        this.setLspStatus({ kind: "running", message: "Exporting PDF..." });
        const content = this.editorInstance.state.doc.toString();
        try {
          const pdfPath = await invoke<string>("compile_typst_document", {
            sourceCode: content,
            filePath: this.activeFilePath
          });
          this.setLspStatus({ kind: "preview-ready", message: `Exported to ${pdfPath}` });
        } catch (error) {
          this.setLspStatus({ kind: "error", message: `Export failed: ${error}` });
        }
      }
    });

    document.getElementById("action-exit")?.addEventListener("click", () => {
      getCurrentWindow().close();
    });

    document.getElementById("action-undo")?.addEventListener("click", () => {
      undo({ state: this.editorInstance.state, dispatch: this.editorInstance.dispatch });
    });

    document.getElementById("action-redo")?.addEventListener("click", () => {
      redo({ state: this.editorInstance.state, dispatch: this.editorInstance.dispatch });
    });

    document.getElementById("action-toggle-word-wrap")?.addEventListener("click", () => {
      document.getElementById("word-wrap-toggle")?.click();
    });

    document.getElementById("action-toggle-sidebar")?.addEventListener("click", () => {
      document.getElementById("explorer-sidebar")?.classList.toggle("hidden");
    });

    document.getElementById("action-clear-logs")?.addEventListener("click", () => {
      this.logConsoleClear.click();
    });

    document.getElementById("action-restart-lsp")?.addEventListener("click", async () => {
      this.setLspStatus({ kind: "starting", message: "Restarting LSP..." });
      await this.initLsp();
    });

    document.getElementById("action-docs-typstry")?.addEventListener("click", () => {
      openUrl("https://github.com/sovichea/typstry");
    });

    document.getElementById("action-docs-typst")?.addEventListener("click", () => {
      openUrl("https://typst.app/docs");
    });

    document.getElementById("action-toggle-layout")?.addEventListener("click", () => this.switchViewLayoutMode());
    document.getElementById("action-toggle-logs")?.addEventListener("click", () => this.toggleLogConsole());

    // Welcome Screen Actions
    document.getElementById("welcome-new-file")?.addEventListener("click", () => {
      document.getElementById("action-new-file")?.click();
    });
    
    document.getElementById("welcome-open-project")?.addEventListener("click", () => {
      document.getElementById("action-open-folder")?.click();
    });

    // Menu Bar Dropdown logic
    const dropdownContainers = document.querySelectorAll(".dropdown-container");
    dropdownContainers.forEach(container => {
      container.addEventListener("click", (e) => {
        const isActive = container.classList.contains("active");
        // Close all dropdowns
        dropdownContainers.forEach(c => c.classList.remove("active"));
        if (!isActive) {
          container.classList.add("active");
        }
        e.stopPropagation();
      });
    });

    // Close on outside click
    document.addEventListener("click", () => {
      dropdownContainers.forEach(c => c.classList.remove("active"));
    });

    const appWindow = getCurrentWindow();
    document.getElementById("titlebar-minimize")?.addEventListener("click", () => appWindow.minimize());
    document.getElementById("titlebar-maximize")?.addEventListener("click", () => appWindow.toggleMaximize());
    document.getElementById("titlebar-close")?.addEventListener("click", () => appWindow.close());

    this.logConsoleToggle.addEventListener("click", () => this.toggleLogConsole());
    this.logConsoleClose.addEventListener("click", () => this.setLogConsoleVisible(false));
    this.logConsoleClear.addEventListener("click", () => {
      this.lspLogEntries = [];
      this.renderLogConsole();
    });
    this.wysiwymContainer.addEventListener("input", () => {
      if (this.activeMode === "WYSIWYM") {
        const generatedMarkup = this.mapWysiwymToMarkup();
        this.handleContentMutation(generatedMarkup);
      }
    });

    this.previewPane.addEventListener("click", (e) => {
      const target = e.target as Element;
      // Typst compiler often outputs 'data-source' or 'data-typst-source' containing line mapping
      const srcElement = target.closest("[data-source], [data-typst-source]");
      if (srcElement) {
        const source = srcElement.getAttribute("data-source") || srcElement.getAttribute("data-typst-source");
        if (source) {
          const parts = source.split(":");
          if (parts.length >= 3) {
            try {
              const line = parseInt(parts[parts.length - 2], 10);
              const column = parseInt(parts[parts.length - 1], 10);
              const cursor = this.editorPositionFromSourceLocation(line, column);
              if (this.activeMode === "WYSIWYM") {
                this.switchViewLayoutMode(); // auto switch to code mode to show the line
              }
              this.suppressForwardSyncOnce();
              this.editorInstance.dispatch({
                selection: { anchor: cursor },
                scrollIntoView: true
              });
              this.editorInstance.focus();
              void this.renderHighlightedPreviewAtCursor(cursor);
            } catch (err) { console.warn("Failed to inverse sync:", err); }
          }
        }
      }
    });
  }

  private mapMarkupToWysiwym(markup: string) {
    this.wysiwymContainer.innerHTML = "";
    markup.split("\n").forEach(line => {
      const trimmed = line.trim();
      if (!trimmed) return;
      const block = document.createElement("div");
      block.className = "wysiwym-block " + (trimmed.startsWith("=") ? "heading" : "body");
      block.contentEditable = "true";
      block.textContent = trimmed.startsWith("=") ? trimmed.replace(/^=\s*/, "") : trimmed;
      this.wysiwymContainer.appendChild(block);
    });
  }

  private editorPositionFromSourceLocation(lineNumber: number, columnNumber: number): number {
    const doc = this.editorInstance.state.doc;
    const line = doc.line(Math.max(1, Math.min(lineNumber, doc.lines)));
    const character = this.utf8ByteOffsetToStringOffset(line.text, Math.max(0, columnNumber - 1));
    return line.from + character;
  }

  private utf8ByteOffsetToStringOffset(text: string, byteOffset: number): number {
    const target = Math.max(0, byteOffset);
    let bytes = 0;
    let offset = 0;

    for (const char of text) {
      const size = this.utf8ByteLength(char);
      if (bytes + size > target) break;
      bytes += size;
      offset += char.length;
    }

    return offset;
  }

  private mapWysiwymToMarkup(): string {
    return Array.from(this.wysiwymContainer.querySelectorAll(".wysiwym-block"))
      .map(b => b.classList.contains("heading") ? `= ${b.textContent?.trim()}` : b.textContent?.trim())
      .join("\n");
  }

  private initResizers() {
    const explorerResizer = document.getElementById("explorer-resizer");
    const explorerSidebar = document.getElementById("explorer-sidebar");
    let isResizingExplorer = false;

    if (explorerResizer && explorerSidebar) {
      explorerResizer.addEventListener("mousedown", () => {
        isResizingExplorer = true;
        explorerResizer.classList.add("resizing");
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
      });

      document.addEventListener("mousemove", (e) => {
        if (!isResizingExplorer) return;
        const newWidth = Math.max(150, Math.min(e.clientX, 800));
        explorerSidebar.style.width = `${newWidth}px`;
      });

      document.addEventListener("mouseup", () => {
        if (isResizingExplorer) {
          isResizingExplorer = false;
          explorerResizer.classList.remove("resizing");
          document.body.style.cursor = "";
          document.body.style.userSelect = "";
        }
      });
      
      // Toggle minimize explorer on double click resizer
      explorerResizer.addEventListener("dblclick", () => {
        if (explorerSidebar.style.display === "none" || explorerSidebar.classList.contains("hidden")) {
           explorerSidebar.classList.remove("hidden");
           explorerSidebar.style.display = "block";
        } else {
           explorerSidebar.classList.add("hidden");
           explorerSidebar.style.display = "none";
        }
      });
    }

    const editorPreviewResizer = document.getElementById("editor-preview-resizer");
    const inputContainer = document.getElementById("input-container-wrapper");
    const previewContainerWrapper = document.getElementById("preview-container-wrapper");
    const workspaceViewport = document.getElementById("workspace-viewport");
    let isResizingEditor = false;

    if (editorPreviewResizer && inputContainer && workspaceViewport && previewContainerWrapper) {
      editorPreviewResizer.addEventListener("mousedown", () => {
        isResizingEditor = true;
        editorPreviewResizer.classList.add("resizing");
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
      });

      document.addEventListener("mousemove", (e) => {
        if (!isResizingEditor) return;
        const viewportRect = workspaceViewport.getBoundingClientRect();
        const newWidth = e.clientX - viewportRect.left;
        const percentage = Math.max(10, Math.min((newWidth / viewportRect.width) * 100, 90));
        inputContainer.style.width = `${percentage}%`;
        previewContainerWrapper.style.width = `${100 - percentage}%`;
      });

      document.addEventListener("mouseup", () => {
        if (isResizingEditor) {
          isResizingEditor = false;
          editorPreviewResizer.classList.remove("resizing");
          document.body.style.cursor = "";
          document.body.style.userSelect = "";
        }
      });
    }
  }

  private initUndockPreview() {
    const undockBtn = document.getElementById("undock-preview-btn");
    const previewContainerWrapper = document.getElementById("preview-container-wrapper");
    const previewContainer = document.getElementById("preview-render-pane");
    const editorPreviewResizer = document.getElementById("editor-preview-resizer");
    const inputContainer = document.getElementById("input-container-wrapper");
    const dockStatusBtn = document.getElementById("dock-preview-status-btn");
    let externalWindow: WebviewWindow | null = null;

    const restoreDock = () => {
        if (externalWindow) {
            externalWindow.close();
        }
        externalWindow = null;
        if (previewContainerWrapper) previewContainerWrapper.style.display = "flex";
        if (editorPreviewResizer) editorPreviewResizer.style.display = "block";
        if (inputContainer) inputContainer.style.width = "50%";
        if (dockStatusBtn) dockStatusBtn.classList.add("hidden");
    };

    if (dockStatusBtn) {
        dockStatusBtn.addEventListener("click", restoreDock);
    }
    
    if (undockBtn && previewContainer && previewContainerWrapper) {
      undockBtn.addEventListener("click", async () => {
        const iframe = previewContainer.querySelector('iframe');
        if (iframe && iframe.src) {
            previewContainerWrapper.style.display = "none";
            if (editorPreviewResizer) editorPreviewResizer.style.display = "none";
            if (inputContainer) inputContainer.style.width = "100%";
            if (dockStatusBtn) dockStatusBtn.classList.remove("hidden");
            
            try {
                await openUrl(iframe.src);
            } catch (err) {
                console.error("Shell open failed", err);
                alert("Could not open external preview window.");
                restoreDock();
            }
        } else {
            alert("Live preview is not currently active.");
        }
      });
    }
  }
}

document.addEventListener("DOMContentLoaded", () => { new TypstryWorkspaceController().bootstrap(); });

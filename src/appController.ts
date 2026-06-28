import { listen } from "@tauri-apps/api/event";
import { confirm, open, save } from "@tauri-apps/plugin-dialog";
import { open as openUrl } from "@tauri-apps/plugin-shell";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { EditorState } from "@codemirror/state";
import { EditorView, highlightActiveLine, highlightActiveLineGutter, lineNumbers } from "@codemirror/view";
import { undo, redo } from "@codemirror/commands";
import { foldEffect, foldedRanges, indentUnit, unfoldEffect } from "@codemirror/language";
import { closeBrackets } from "@codemirror/autocomplete";
import { indentationMarkers } from "@replit/codemirror-indentation-markers";
import { getEditorExtensions, themeCompartment, getThemeExtension, applyUIThemeVariables, wrapCompartment, lineNumbersCompartment, activeLineCompartment, closeBracketsCompartment, indentationGuidesCompartment, tabSizeCompartment } from "./editor/extensions";
import { collectDefaultTypstFunctionFolds } from "./editor/folding";
import type { EditorFoldRange } from "./editor/folding";
import { setEditorDiagnosticsEffect } from "./editor/diagnostics";
import type { EditorDiagnostic, EditorDiagnosticSeverity } from "./editor/diagnostics";
import { WorkspaceExplorer } from "./components/explorer";
import { TinymistLspClient } from "./compiler/lsp";
import type { LspDiagnostic, LspLogEntry, LspSourcePosition, LspStatus } from "./compiler/lsp";
import type { AppSettings } from "./settings";
import { SettingsController } from "./settingsController";
import { fileNameFromPath, filePathFromUri, filePathKey, filePathToUri } from "./platform/paths";
import { WysiwymAdapter } from "./wysiwym/adapter";
import { PreviewFrame } from "./preview/previewFrame";
import { PreviewSyncController } from "./preview/previewSyncController";
import { LogConsoleController, type LogConsoleEntryInput } from "./diagnostics/logConsoleController";
import { EditorFontManager } from "./editor/fontManager";
import { LayoutController } from "./layout/layoutController";
import { WorkspaceStateStore } from "./workspace/workspaceStateStore";
import { RecentProjectsController } from "./workspace/recentProjectsController";
import { EditorToolbarController } from "./editor/toolbarController";
import { ContextMenuController } from "./components/contextMenuController";

type EditorMode = "CODE" | "WYSIWYM";
type FallbackDiagnostic = {
  severity: "error" | "warning" | "info";
  message: string;
  line?: number;
  column?: number;
};

type EditorTab = {
  path: string;
  content: string;
  savedContent: string;
  isDirty: boolean;
  previewRootPath: string | null;
  version: number;
  latestVersion: number;
  selectionAnchor: number;
  selectionHead: number;
  scrollTop?: number;
  scrollLeft?: number;
  foldRanges: EditorFoldRange[] | null;
};

export class TypstryWorkspaceController {
  private activeMode: EditorMode = "CODE";
  private activeFilePath: string | null = null;
  private previewRootPath: string | null = null;
  private workspaceRootPath: string | null = null;
  private currentVersion = 1;
  private isLoadingFile = false;
  private lspReady = false;
  private readonly lspSyncDebounceMs = 350;
  private forwardSyncDebounceMs = 120;
  private previewHighlightVisibleMs = 2200;
  private pendingLspSyncTimer: number | null = null;
  private pendingLspSyncPath: string | null = null;
  private pendingLspSyncText: string | null = null;
  private latestDocumentVersion = 1;
  private openTabs: EditorTab[] = [];
  private readonly settingsController = new SettingsController(settings => this.applySettingsToRuntime(settings));

  private editorInstance!: EditorView;
  private readonly editorFontManager = new EditorFontManager(() => this.editorInstance);
  private explorer!: WorkspaceExplorer;
  private lspClient!: TinymistLspClient;

  private codePane = document.getElementById("code-editor-pane")!;
  private editorTabBar = document.getElementById("editor-tab-bar")!;
  private editorVisualToolbar = document.getElementById("editor-visual-toolbar")!;
  private codeRenderPane = document.getElementById("code-render-pane")!;
  private wysiwymPane = document.getElementById("wysiwym-editor-pane")!;
  private wysiwymContainer = this.wysiwymPane.querySelector<HTMLElement>(".wysiwym-container")!;
  private readonly wysiwymAdapter = new WysiwymAdapter(this.wysiwymContainer);
  private previewPane = document.getElementById("preview-render-pane")!;
  private readonly previewFrame = new PreviewFrame(this.previewPane, point => {
    this.previewSyncController.recordTextClick(point);
  });
  private readonly previewSyncController = new PreviewSyncController(this.previewFrame, {
    getEditor: () => this.editorInstance,
    getClient: () => this.lspClient,
    getActiveFilePath: () => this.activeFilePath,
    getPreviewRootPath: () => this.previewRootPath,
    isReady: () => this.lspReady,
    isEnabled: () => this.settingsController.value.preview.cursorSync,
    getHighlightDuration: () => this.previewHighlightVisibleMs,
    nextPreviewVersion: () => ++this.currentVersion,
    restoreDocumentVersion: () => this.restorePreviewDocumentVersion()
  });
  private readonly logConsoleController = new LogConsoleController(entry => this.navigateToLogEntry(entry));
  private readonly layoutController = new LayoutController(
    () => this.saveWorkspaceState(),
    () => this.logConsoleController.setVisible(false)
  );
  private readonly workspaceStateStore = new WorkspaceStateStore();
  private readonly recentProjectsController = new RecentProjectsController(path => this.openWorkspace(path));
  private readonly editorToolbarController = new EditorToolbarController({
    getMode: () => this.activeMode,
    getEditor: () => this.editorInstance,
    wysiwymContainer: this.wysiwymContainer,
    serializeWysiwym: () => this.mapWysiwymToMarkup(),
    renderWysiwym: markup => this.mapMarkupToWysiwym(markup),
    save: () => this.saveActiveFile(),
    syncPreview: cursor => this.previewSyncController.renderAtCursor(cursor),
    toggleMode: () => this.switchViewLayoutMode()
  });
  private readonly contextMenuController = new ContextMenuController({
    getWorkspaceRoot: () => this.workspaceRootPath,
    getActiveFile: () => this.activeFilePath,
    getEditor: () => this.editorInstance,
    getExplorer: () => this.explorer,
    getPreviewFrame: () => this.previewFrame.element,
    loadFile: path => this.loadFile(path),
    save: () => this.saveActiveFile(),
    updateTabPath: (oldPath, newPath) => this.updateEditorTabPath(oldPath, newPath),
    activateTab: path => this.activateEditorTab(path, false),
    closeTab: path => this.closeEditorTab(path, true)
  });
  private lspStatus = document.getElementById("lsp-status")!;
  private lspStatusDot = this.lspStatus.querySelector(".status-dot") as HTMLElement;
  private lspStatusText = this.lspStatus.querySelector(".status-text") as HTMLElement;

  public async bootstrap() {
    await this.settingsController.load();
    this.recentProjectsController.initialize();
    this.initCodeMirror();
    this.applySettingsToRuntime(this.settingsController.value);
    this.initExplorer();
    this.editorToolbarController.initialize();
    this.bindGlobalEvents();
    this.layoutController.initialize();
    this.initWordWrap();
    this.settingsController.initializePanel();
    this.contextMenuController.initialize();
    this.logConsoleController.initialize();
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
    const appMenus = document.getElementById("app-menus");

    if (this.activeFilePath || this.workspaceRootPath) {
      welcomeScreen?.classList.add("hidden");
    } else {
      welcomeScreen?.classList.remove("hidden");
    }

    if (this.activeFilePath) {
      inputWrapper?.classList.remove("hidden");
      previewWrapper?.classList.remove("hidden");
      resizer?.classList.remove("hidden");
    } else {
      inputWrapper?.classList.add("hidden");
      previewWrapper?.classList.add("hidden");
      resizer?.classList.add("hidden");
    }

    if (this.workspaceRootPath) {
      explorerSidebar?.classList.remove("hidden");
      explorerResizer?.classList.remove("hidden");
      appMenus?.classList.remove("hidden");
    } else {
      explorerSidebar?.classList.add("hidden");
      explorerResizer?.classList.add("hidden");
      appMenus?.classList.add("hidden");
    }
  }

  private applySettingsToRuntime(settings: AppSettings) {
    const { appearance, editor, preview } = settings;
    document.documentElement.style.setProperty("--editor-font-size", `${appearance.editorFontSize}px`);
    document.documentElement.style.setProperty("--editor-line-height", String(appearance.editorLineHeight));
    this.forwardSyncDebounceMs = preview.syncDebounceMs;
    this.previewHighlightVisibleMs = preview.highlightDurationMs;
    this.editorFontManager.configure(editor.codeFont, editor.unicodeFont);

    void applyUIThemeVariables(appearance.theme);

    if (this.editorInstance) {
      const indentation = " ".repeat(editor.tabSize);
      this.editorInstance.dispatch({
        effects: [
          themeCompartment.reconfigure(getThemeExtension(appearance.theme)),
          wrapCompartment.reconfigure(editor.wordWrap ? EditorView.lineWrapping : []),
          lineNumbersCompartment.reconfigure(editor.lineNumbers ? lineNumbers() : []),
          activeLineCompartment.reconfigure(editor.highlightActiveLine ? [highlightActiveLineGutter(), highlightActiveLine()] : []),
          closeBracketsCompartment.reconfigure(editor.autoCloseBrackets ? closeBrackets() : []),
          indentationGuidesCompartment.reconfigure(editor.indentationGuides ? indentationMarkers() : []),
          tabSizeCompartment.reconfigure([EditorState.tabSize.of(editor.tabSize), indentUnit.of(indentation)])
        ]
      });
    }

    const wrapLabel = document.getElementById("word-wrap-label");
    if (wrapLabel) wrapLabel.textContent = editor.wordWrap ? "Wrap: On" : "Wrap: Off";
    if (!preview.cursorSync) this.previewSyncController.clearForward();
  }

  private initWordWrap() {
    const wrapToggleBtn = document.getElementById("word-wrap-toggle");
    const wrapLabel = document.getElementById("word-wrap-label");
    
    if (wrapToggleBtn && wrapLabel) {
      wrapLabel.textContent = this.settingsController.value.editor.wordWrap ? "Wrap: On" : "Wrap: Off";

      wrapToggleBtn.addEventListener("click", () => {
        this.settingsController.update(settings => {
          settings.editor.wordWrap = !settings.editor.wordWrap;
        });
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
    const initialDocument = "";
    this.editorFontManager.initialize();
    this.editorInstance = new EditorView({
      state: EditorState.create({
        doc: initialDocument,
        extensions: [
          getEditorExtensions(() => this.lspClient, () => this.activeFilePath ? filePathToUri(this.activeFilePath) : "", () => this.flushPendingLspSync()),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              const currentText = update.state.doc.toString();
              this.previewSyncController.clearForward();
              this.editorFontManager.updateDocument(currentText);
              this.handleContentMutation(currentText);
            } else if (this.shouldForwardSyncSelectionUpdate(update)) {
              this.previewSyncController.schedule(this.forwardSyncDebounceMs);
            }
          })
        ]
      }),
      parent: this.codeRenderPane
    });
    this.editorFontManager.updateDocument(initialDocument);
  }

  private shouldForwardSyncSelectionUpdate(update: { selectionSet: boolean; transactions: readonly { isUserEvent(event: string): boolean }[] }): boolean {
    if (!update.selectionSet) {
      return false;
    }

    return update.transactions.some((transaction) =>
      transaction.isUserEvent("select.pointer") ||
      transaction.isUserEvent("select.search")
    );
  }

  private initExplorer() {
    this.explorer = new WorkspaceExplorer(document.getElementById("explorer-sidebar")!, (path) => this.loadFile(path));
  }

  private renderEditorTabs() {
    this.editorTabBar.innerHTML = "";

    for (const tab of this.openTabs) {
      const tabButton = document.createElement("button");
      tabButton.className = `editor-tab${tab.path === this.activeFilePath ? " active" : ""}${tab.isDirty ? " dirty" : ""}`;
      tabButton.type = "button";
      tabButton.role = "tab";
      tabButton.title = tab.path;
      tabButton.setAttribute("aria-selected", String(tab.path === this.activeFilePath));
      tabButton.dataset.path = tab.path;

      const title = document.createElement("span");
      title.className = "editor-tab-title";
      title.textContent = fileNameFromPath(tab.path);
      tabButton.appendChild(title);

      const dirtyDot = document.createElement("span");
      dirtyDot.className = "editor-tab-dirty";
      dirtyDot.setAttribute("aria-hidden", "true");
      tabButton.appendChild(dirtyDot);

      const closeButton = document.createElement("span");
      closeButton.className = "editor-tab-close";
      closeButton.textContent = "x";
      closeButton.title = "Close";
      closeButton.setAttribute("aria-label", `Close ${fileNameFromPath(tab.path)}`);
      tabButton.appendChild(closeButton);

      tabButton.addEventListener("click", () => {
        void this.activateEditorTab(tab.path);
      });

      closeButton.addEventListener("click", (event) => {
        event.stopPropagation();
        void this.closeEditorTab(tab.path);
      });

      this.editorTabBar.appendChild(tabButton);
    }
  }

  private getActiveTab(): EditorTab | null {
    if (!this.activeFilePath) return null;
    return this.openTabs.find((tab) => tab.path === this.activeFilePath) ?? null;
  }

  private persistActiveTabState() {
    const tab = this.getActiveTab();
    if (!tab || !this.editorInstance) return;

    const content = this.activeMode === "WYSIWYM"
      ? this.mapWysiwymToMarkup()
      : this.editorInstance.state.doc.toString();
    const selection = this.editorInstance.state.selection.main;
    tab.content = content;
    tab.isDirty = tab.content !== tab.savedContent;
    tab.version = this.currentVersion;
    tab.latestVersion = this.latestDocumentVersion;
    tab.selectionAnchor = selection.anchor;
    tab.selectionHead = selection.head;
    tab.scrollTop = this.editorInstance.scrollDOM.scrollTop;
    tab.scrollLeft = this.editorInstance.scrollDOM.scrollLeft;
    tab.foldRanges = this.collectCurrentFoldRanges();
  }

  private collectCurrentFoldRanges(): EditorFoldRange[] {
    const ranges: EditorFoldRange[] = [];
    if (!this.editorInstance) return ranges;

    const docLength = this.editorInstance.state.doc.length;
    foldedRanges(this.editorInstance.state).between(0, docLength, (from, to) => {
      if (from < to) {
        ranges.push({ from, to });
      }
    });

    return ranges;
  }

  private restoreTabFoldState(tab: EditorTab) {
    const ranges = tab.foldRanges === null
      ? collectDefaultTypstFunctionFolds(this.editorInstance.state)
      : this.normalizeFoldRanges(tab.foldRanges, this.editorInstance.state.doc.length);

    tab.foldRanges = ranges;
    this.applyFoldRanges(ranges);
  }

  private applyFoldRanges(ranges: EditorFoldRange[]) {
    const effects = [];
    const docLength = this.editorInstance.state.doc.length;

    foldedRanges(this.editorInstance.state).between(0, docLength, (from, to) => {
      effects.push(unfoldEffect.of({ from, to }));
    });

    for (const range of this.normalizeFoldRanges(ranges, docLength)) {
      effects.push(foldEffect.of(range));
    }

    if (effects.length > 0) {
      this.editorInstance.dispatch({ effects });
    }
  }

  private normalizeFoldRanges(value: unknown, docLength: number): EditorFoldRange[] {
    if (!Array.isArray(value)) return [];

    const ranges: EditorFoldRange[] = [];

    for (let index = 0; index < value.length; index++) {
      const item = value[index];
      const range = typeof item === "object" && item !== null
        ? item as Partial<EditorFoldRange>
        : typeof item === "number" && typeof value[index + 1] === "number"
          ? { from: item, to: value[++index] as number }
          : null;

      if (
        range &&
        typeof range.from === "number" &&
        typeof range.to === "number" &&
        range.from >= 0 &&
        range.to <= docLength &&
        range.from < range.to
      ) {
        ranges.push({ from: range.from, to: range.to });
      }
    }

    return ranges;
  }

  private updateActiveTabContent(content: string) {
    const tab = this.getActiveTab();
    if (!tab) return;

    const wasDirty = tab.isDirty;
    tab.content = content;
    tab.isDirty = tab.content !== tab.savedContent;
    if (wasDirty !== tab.isDirty) {
      this.renderEditorTabs();
    }
  }

  private updateEditorTabPath(oldPath: string, newPath: string) {
    const tab = this.openTabs.find((candidate) => candidate.path === oldPath);
    if (!tab) return;

    tab.path = newPath;
    if (this.activeFilePath === oldPath) {
      this.activeFilePath = newPath;
      this.previewRootPath = tab.previewRootPath;
    }
    this.renderEditorTabs();
  }

  private async closeEditorTab(path: string, skipDirtyCheck = false) {
    const tabIndex = this.openTabs.findIndex((tab) => tab.path === path);
    if (tabIndex === -1) return;

    if (this.activeFilePath === path) {
      this.persistActiveTabState();
    }

    const tab = this.openTabs[tabIndex];
    if (!skipDirtyCheck && tab.isDirty) {
      const shouldClose = await confirm(
        `Close ${fileNameFromPath(tab.path)} without saving?`,
        { title: "Unsaved Changes", kind: "warning" }
      );
      if (!shouldClose) {
        return;
      }
    }

    const wasActive = this.activeFilePath === path;
    this.openTabs.splice(tabIndex, 1);

    if (wasActive) {
      const nextTab = this.openTabs[Math.min(tabIndex, this.openTabs.length - 1)] ?? null;
      this.activeFilePath = null;
      this.previewRootPath = null;
      this.clearDiagnostics();
      this.clearPendingLspSync();
      this.previewSyncController.clearForward();

      if (nextTab) {
        await this.activateEditorTab(nextTab.path, false);
      } else {
        this.isLoadingFile = true;
        try {
          this.editorInstance.dispatch({
            changes: { from: 0, to: this.editorInstance.state.doc.length, insert: "" }
          });
          this.applyFoldRanges([]);
        } finally {
          this.isLoadingFile = false;
        }
        this.previewPane.innerHTML = "";
        this.editorFontManager.updateDocument("");
        if (this.activeMode === "WYSIWYM") {
          this.mapMarkupToWysiwym("");
        }
      }
    }

    this.renderEditorTabs();
    this.updateWorkspaceViewportVisibility();
    this.saveWorkspaceState();
  }

  private async activateEditorTab(path: string, persistCurrent = true) {
    if (this.activeFilePath === path) {
      if (persistCurrent) {
        this.persistActiveTabState();
        this.renderEditorTabs();
      }
      this.editorInstance.focus();
      this.saveWorkspaceState();
      return;
    }

    if (persistCurrent) {
      this.persistActiveTabState();
    }

    const tab = this.openTabs.find((candidate) => candidate.path === path);
    if (!tab) return;

    this.currentVersion = tab.version;
    this.latestDocumentVersion = tab.latestVersion;
    this.previewSyncController.reset();
    this.clearDiagnostics();

    this.isLoadingFile = true;
    try {
      this.editorInstance.dispatch({
        changes: { from: 0, to: this.editorInstance.state.doc.length, insert: tab.content },
        selection: {
          anchor: Math.min(tab.selectionAnchor, tab.content.length),
          head: Math.min(tab.selectionHead, tab.content.length)
        }
      });
    } finally {
      this.isLoadingFile = false;
    }
    this.restoreTabFoldState(tab);

    if (tab.scrollTop !== undefined || tab.scrollLeft !== undefined) {
      requestAnimationFrame(() => {
        if (tab.scrollTop !== undefined) this.editorInstance.scrollDOM.scrollTop = tab.scrollTop;
        if (tab.scrollLeft !== undefined) this.editorInstance.scrollDOM.scrollLeft = tab.scrollLeft;
      });
    }

    this.activeFilePath = path;
    this.previewRootPath = await invoke<string | null>("resolve_preview_main", {
      filePath: path,
      workspaceRootPath: this.workspaceRootPath,
      fileContents: tab.content
    });
    tab.previewRootPath = this.previewRootPath;
    this.clearPendingLspSync();
    this.previewSyncController.clearForward();
    this.renderEditorTabs();
    this.editorFontManager.updateDocument(tab.content);

    if (this.lspReady && this.lspClient) {
      const uri = filePathToUri(path);
      await this.lspClient.openTextDocument(uri, tab.content, this.currentVersion);
      void this.runFallbackDiagnostics(path, tab.content, this.currentVersion);

      if (this.previewRootPath) {
        this.previewPane.innerHTML = `<div style="padding: 20px; color: #007acc; font-family: sans-serif;">Starting live preview server...</div>`;
        const previewUrl = await this.startPreviewWithRestart(this.previewRootPath, tab.content);
        if (previewUrl) {
          await this.previewFrame.mount(previewUrl, () => this.lspClient?.getPreviewHtml() ?? Promise.resolve(""));
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
      this.mapMarkupToWysiwym(tab.content);
    }
    this.updateWorkspaceViewportVisibility();
    this.editorInstance.focus();
    this.saveWorkspaceState();
  }

  private async initLsp() {
    this.lspClient = new TinymistLspClient(
      () => {},
      (status) => this.setLspStatus(status),
      (uri, position) => this.handleInverseSync(uri, position),
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
    const existingTab = this.openTabs.find((tab) => filePathKey(tab.path) === filePathKey(path));
    if (existingTab) {
      await this.activateEditorTab(existingTab.path);
      return;
    }

    try {
      const contents: string = await invoke("read_workspace_file", { path });
      this.openTabs.push({
        path,
        content: contents,
        savedContent: contents,
        isDirty: false,
        previewRootPath: null,
        version: 1,
        latestVersion: 1,
        selectionAnchor: 0,
        selectionHead: 0,
        foldRanges: null
      });
      this.renderEditorTabs();
      await this.activateEditorTab(path);
    } catch (e) {
      console.error("Failed to load file:", e);
      alert("Failed to load file: " + e);
    }
  }

  private async saveActiveFile() {
    if (!this.activeFilePath) {
      return;
    }

    try {
      const content = this.activeMode === "WYSIWYM"
        ? this.mapWysiwymToMarkup()
        : this.editorInstance.state.doc.toString();

      await invoke("save_workspace_file", {
        path: this.activeFilePath,
        contents: content
      });

      const activeTab = this.getActiveTab();
      if (activeTab) {
        activeTab.content = content;
        activeTab.savedContent = content;
        activeTab.isDirty = false;
        this.renderEditorTabs();
      }
      this.setLspStatus({ kind: "preview-ready", message: "File saved" });
    } catch (error) {
      const message = `Save failed: ${String(error)}`;
      console.error(message);
      this.setLspStatus({ kind: "error", message });
      alert(message);
    }
  }

  private async startPreviewWithRestart(previewRootPath: string, activeContents: string): Promise<string> {
    const firstAttemptUrl = await this.lspClient.startPreview(previewRootPath);
    if (firstAttemptUrl) {
      return firstAttemptUrl;
    }

    console.warn("Preview startup failed. Restarting Tinymist and retrying once.");
    this.setLspStatus({ kind: "starting", message: "Restarting preview" });

    try {
      await this.lspClient.restart();
      this.lspReady = true;
      if (!this.activeFilePath || this.previewRootPath !== previewRootPath) {
        return "";
      }

      await this.lspClient.openTextDocument(
        filePathToUri(this.activeFilePath),
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
    if (!this.isLoadingFile) {
      this.updateActiveTabContent(rawText);
    }

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
    this.previewSyncController.reset();
    const version = ++this.currentVersion;
    this.latestDocumentVersion = version;
    const activeTab = this.getActiveTab();
    if (activeTab && activeTab.path === path) {
      activeTab.version = version;
      activeTab.latestVersion = version;
    }
    this.lspClient.notifyTextChange(filePathToUri(path), text, version);
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

      const filteredDiagnostics = diagnostics.filter(
        (diagnostic) => !diagnostic.message.includes("cannot export multiple images without a page number template")
      );

      const editorDiagnostics = filteredDiagnostics
        .map((diagnostic) => this.editorDiagnosticFromFallback(diagnostic))
        .filter((diagnostic): diagnostic is EditorDiagnostic => diagnostic !== null);

      this.editorInstance.dispatch({
        effects: setEditorDiagnosticsEffect.of(editorDiagnostics)
      });

      this.logConsoleController.setDiagnostics(filteredDiagnostics.map((diagnostic) => ({
        kind: diagnostic.severity,
        source: "typst check",
        filePath: path,
        fileName: fileNameFromPath(path),
        message: diagnostic.message,
        line: diagnostic.line ?? 1,
        column: diagnostic.column ?? 1
      })));
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

  private restorePreviewDocumentVersion(): { path: string; text: string; version: number } | null {
    if (!this.activeFilePath || !this.lspReady || !this.lspClient || !this.editorInstance) return null;
    const version = ++this.currentVersion;
    this.latestDocumentVersion = version;
    const activeTab = this.getActiveTab();
    if (activeTab) {
      activeTab.version = version;
      activeTab.latestVersion = version;
    }
    return { path: this.activeFilePath, text: this.editorInstance.state.doc.toString(), version };
  }

  private async handleInverseSync(uri: string | undefined, position: LspSourcePosition): Promise<number> {
    const targetPath = uri ? filePathFromUri(uri) : null;
    const existingTargetTab = targetPath
      ? this.openTabs.find((tab) => filePathKey(tab.path) === filePathKey(targetPath))
      : null;
    const resolvedTargetPath = existingTargetTab?.path ?? targetPath;
    if (resolvedTargetPath && filePathKey(resolvedTargetPath) !== filePathKey(this.activeFilePath ?? "")) {
      this.previewSyncController.clearMapping();
      await this.loadFile(resolvedTargetPath);
    }

    if (this.activeMode === "WYSIWYM") {
      this.switchViewLayoutMode();
    }

    this.previewSyncController.clearForward();
    const defaultCursorPos = this.editorPositionFromLspPosition(position) ?? 0;
    return this.previewSyncController.mapInversePosition(position, defaultCursorPos);
  }

  private utf8ByteLength(text: string): number {
    return new TextEncoder().encode(text).length;
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
    if (this.previewSyncController.shouldIgnoreDiagnostics(version, this.latestDocumentVersion)) return;

    if (!this.activeFilePath || uri !== filePathToUri(this.activeFilePath)) {
      return;
    }

    const isPackageFile = uri.toLowerCase().includes("typst/packages") || 
                          uri.toLowerCase().includes("typst\\packages") ||
                          uri.toLowerCase().includes("packages/preview") ||
                          uri.toLowerCase().includes("packages\\preview");
    if (isPackageFile) {
      this.editorInstance.dispatch({
        effects: setEditorDiagnosticsEffect.of([])
      });
      return;
    }



    const filteredDiagnostics = diagnostics.filter(
      (diagnostic) => !diagnostic.message.includes("cannot export multiple images without a page number template")
    );

    const editorDiagnostics = filteredDiagnostics
      .map((diagnostic) => this.editorDiagnosticFromLsp(diagnostic))
      .filter((diagnostic): diagnostic is EditorDiagnostic => diagnostic !== null);

    this.editorInstance.dispatch({
      effects: setEditorDiagnosticsEffect.of(editorDiagnostics)
    });

    this.logConsoleController.setDiagnostics(filteredDiagnostics.map((diagnostic) => this.logEntryFromDiagnostic(uri, diagnostic)));
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

  private logEntryFromDiagnostic(uri: string, diagnostic: LspDiagnostic): LogConsoleEntryInput {
    const filePath = filePathFromUri(uri);
    return {
      kind: this.diagnosticSeverityFromLsp(diagnostic.severity),
      source: diagnostic.source ?? "typst",
      filePath,
      fileName: fileNameFromPath(filePath),
      message: diagnostic.message,
      line: diagnostic.range.start.line + 1,
      column: (diagnostic.range.start.character ?? 0) + 1
    };
  }

  private appendLspLog(entry: LspLogEntry) {
    if (entry.kind === "error" && this.previewSyncController.shouldSuppressErrorLog()) {
      return;
    }

    this.logConsoleController.appendLog({
      kind: entry.kind,
      source: entry.source ?? "tinymist",
      message: entry.message
    });
  }

  private clearDiagnostics() {
    this.logConsoleController.clearDiagnostics();
    if (this.editorInstance) {
      this.editorInstance.dispatch({
        effects: setEditorDiagnosticsEffect.of([])
      });
    }
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
    if (this.lspClient) {
      return this.lspClient.editorPositionFromLspPosition(position);
    }

    const doc = this.editorInstance.state.doc;
    if (!doc.length) return 0;

    const lineNumber = Math.max(1, Math.min(position.line + 1, doc.lines));
    const line = doc.line(lineNumber);
    const character = this.utf8ByteOffsetToStringOffset(line.text, position.character ?? 0);
    return Math.max(line.from, Math.min(line.from + character, line.to));
  }

  private async navigateToLogEntry(entry: LogConsoleEntryInput) {
    if (!entry.line) return;
    if (entry.filePath && entry.filePath !== this.activeFilePath) await this.loadFile(entry.filePath);
    const cursor = this.editorPositionFromSourceLocation(entry.line, entry.column ?? 1);
    this.editorInstance.dispatch({
      selection: { anchor: cursor },
      effects: EditorView.scrollIntoView(cursor, { y: "center" })
    });
    this.editorInstance.focus();
  }

  private switchViewLayoutMode() {
    if (this.activeMode === "CODE") {
      this.activeMode = "WYSIWYM";
      this.mapMarkupToWysiwym(this.editorInstance.state.doc.toString());
      this.codePane.classList.add("hidden");
      this.wysiwymPane.classList.remove("hidden");
      this.editorVisualToolbar.classList.add("wysiwym-active");
    } else {
      this.activeMode = "CODE";
      const markup = this.mapWysiwymToMarkup();
      this.editorInstance.dispatch({
        changes: { from: 0, to: this.editorInstance.state.doc.length, insert: markup }
      });
      this.wysiwymPane.classList.add("hidden");
      this.codePane.classList.remove("hidden");
      this.editorVisualToolbar.classList.remove("wysiwym-active");
    }
  }

  private saveWorkspaceState() {
    if (!this.workspaceRootPath) return;
    
    this.persistActiveTabState();
    
    const inputContainer = document.getElementById("input-container-wrapper");
    const explorerSidebar = document.getElementById("explorer-sidebar");
    
    this.workspaceStateStore.save(this.workspaceRootPath, {
      activeFilePath: this.activeFilePath,
      openTabs: this.openTabs.map(tab => ({
        path: tab.path,
        selectionAnchor: tab.selectionAnchor,
        selectionHead: tab.selectionHead,
        scrollTop: tab.scrollTop,
        scrollLeft: tab.scrollLeft,
        foldRanges: tab.foldRanges
      })),
      inputContainerWidthPct: inputContainer?.style.width ? parseFloat(inputContainer.style.width) : 50,
      explorerSidebarWidthPx: explorerSidebar?.style.width ? parseInt(explorerSidebar.style.width, 10) : 250
    });
  }

  private async restoreWorkspaceState(workspacePath: string) {
    try {
      const state = this.workspaceStateStore.load(workspacePath);
      if (!state) return;
      
      if (state.inputContainerWidthPct) {
        const inputContainer = document.getElementById("input-container-wrapper");
        const previewContainerWrapper = document.getElementById("preview-container-wrapper");
        if (inputContainer && previewContainerWrapper) {
          inputContainer.style.width = `${state.inputContainerWidthPct}%`;
          previewContainerWrapper.style.width = `${100 - state.inputContainerWidthPct}%`;
        }
      }
      
      if (state.explorerSidebarWidthPx) {
        const explorerSidebar = document.getElementById("explorer-sidebar");
        if (explorerSidebar) {
          explorerSidebar.style.width = `${state.explorerSidebarWidthPx}px`;
        }
      }
      
      if (state.openTabs.length) {
        for (const tabInfo of state.openTabs) {
          try {
             const contents: string = await invoke("read_workspace_file", { path: tabInfo.path });
             this.openTabs.push({
               path: tabInfo.path,
               content: contents,
               savedContent: contents,
               isDirty: false,
               previewRootPath: null,
               version: 1,
               latestVersion: 1,
               selectionAnchor: tabInfo.selectionAnchor || 0,
               selectionHead: tabInfo.selectionHead || 0,
               scrollTop: tabInfo.scrollTop,
               scrollLeft: tabInfo.scrollLeft,
               foldRanges: Array.isArray(tabInfo.foldRanges)
                 ? this.normalizeFoldRanges(tabInfo.foldRanges, contents.length)
                 : null
             });
          } catch(e) {
             console.warn("Failed to restore tab:", tabInfo.path, e);
          }
        }
        this.renderEditorTabs();
      }
      
      if (state.activeFilePath && this.openTabs.some(t => t.path === state.activeFilePath)) {
         await this.activateEditorTab(state.activeFilePath, false);
      } else if (this.openTabs.length > 0) {
         await this.activateEditorTab(this.openTabs[0].path, false);
      }
    } catch(e) {
      console.warn("Failed to restore workspace state:", e);
    }
  }

  private async openWorkspace(selected: string) {
    if (this.workspaceRootPath && this.workspaceRootPath !== selected) {
      this.closeProject();
    }
    this.workspaceRootPath = selected;
    this.explorer.loadWorkspace(selected);
    this.updateWorkspaceViewportVisibility();
    this.recentProjectsController.add(selected);
    await this.restoreWorkspaceState(selected);
  }

  private closeProject() {
    this.saveWorkspaceState();
    
    this.workspaceRootPath = null;
    this.activeFilePath = null;
    this.previewRootPath = null;
    this.openTabs = [];
    this.renderEditorTabs();
    
    // Clear editor
    this.editorInstance.dispatch({
      changes: { from: 0, to: this.editorInstance.state.doc.length, insert: "" }
    });
    
    // Clear explorer
    document.getElementById("explorer-sidebar")!.innerHTML = "";
    this.previewPane.innerHTML = "";
    
    this.setLspStatus({ kind: "ready", message: "Project closed" });
    this.updateWorkspaceViewportVisibility();
  }

  private bindGlobalEvents() {
    window.addEventListener("beforeunload", () => {
      this.saveWorkspaceState();
      this.settingsController.flush();
    });

    document.addEventListener("keydown", (e) => {
      const isMac = navigator.userAgent.toLowerCase().includes("mac");
      const cmdOrCtrl = isMac ? e.metaKey : e.ctrlKey;
      
      // Block common function keys (except F3 which we handle conditionally)
      if (["F5", "F6", "F7", "F11"].includes(e.key)) {
        e.preventDefault();
      }
      
      // Block specific browser shortcuts (that we don't map below)
      if (cmdOrCtrl && ["r", "p", "j", "u", "d"].includes(e.key.toLowerCase())) {
        e.preventDefault();
      }
      
      // Block browser's Find/Replace shortcuts only if not in an input/textarea/editor
      if (e.key === "F3" || (cmdOrCtrl && ["f", "g", "h"].includes(e.key.toLowerCase()))) {
         const active = document.activeElement;
         if (!active || (!active.classList.contains("cm-content") && active.tagName !== "INPUT" && active.tagName !== "TEXTAREA" && !active.closest('.cm-panel'))) {
             e.preventDefault();
         }
      }
      
      if (cmdOrCtrl && e.shiftKey && ["i", "c", "j", "r"].includes(e.key.toLowerCase())) {
        e.preventDefault();
      }
      
      // App Keymappings
      if (cmdOrCtrl && !e.shiftKey && !e.altKey) {
        switch (e.key.toLowerCase()) {
          case "s":
            e.preventDefault();
            void this.saveActiveFile();
            break;
          case "o":
            e.preventDefault();
            document.getElementById("action-open-folder")?.click();
            break;
          case "n":
            e.preventDefault();
            document.getElementById("action-new-file")?.click();
            break;
          case "b":
            e.preventDefault();
            document.getElementById("action-toggle-sidebar")?.click();
            break;
          case "e":
            e.preventDefault();
            document.getElementById("action-export-pdf")?.click();
            break;
          case "q":
            e.preventDefault();
            document.getElementById("action-exit")?.click();
            break;
          case "`":
            e.preventDefault();
            document.getElementById("action-toggle-logs")?.click();
            break;
        }
      }

      if (e.altKey && !cmdOrCtrl && !e.shiftKey) {
        if (e.key.toLowerCase() === "z") {
          e.preventDefault();
          document.getElementById("action-toggle-word-wrap")?.click();
        }
      }
    });

    listen("menu-toggle-layout", () => this.switchViewLayoutMode());
    listen("menu-toggle-log-console", () => this.logConsoleController.toggle());
    listen("menu-open-folder", async () => {
      const selected = await open({ directory: true, multiple: false });
      if (typeof selected === "string") {
        await this.openWorkspace(selected);
      }
    });

    document.getElementById("action-open-folder")?.addEventListener("click", async () => {
      const selected = await open({ directory: true, multiple: false });
      if (typeof selected === "string") {
        await this.openWorkspace(selected);
      }
    });
    
    document.getElementById("action-close-project")?.addEventListener("click", () => {
      this.closeProject();
    });

    document.getElementById("action-new-file")?.addEventListener("click", async () => {
      if (!this.workspaceRootPath) {
        alert("Please open a project workspace first.");
        return;
      }
      const savePath = await save({
        defaultPath: this.workspaceRootPath,
        filters: [{ name: "Typst Document", extensions: ["typ"] }]
      });
      if (typeof savePath === "string") {
        await invoke("save_workspace_file", { path: savePath, contents: "= New Document\n" });
        this.explorer.loadWorkspace(this.workspaceRootPath);
        this.loadFile(savePath);
      }
    });

    document.getElementById("action-save-file")?.addEventListener("click", async () => {
      await this.saveActiveFile();
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
      this.logConsoleController.clearLogs();
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
    document.getElementById("action-toggle-logs")?.addEventListener("click", () => this.logConsoleController.toggle());

    // Welcome Screen Actions
    document.getElementById("welcome-open-project")?.addEventListener("click", () => {
      document.getElementById("action-open-folder")?.click();
    });

    // Menu Bar Dropdown logic
    const dropdownContainers = document.querySelectorAll(".dropdown-container");
    dropdownContainers.forEach(container => {
      container.addEventListener("click", (e) => {
        const target = e.target as HTMLElement;
        
        // If the user clicked a dropdown action item, close all menus and do not toggle open
        if (target.closest(".dropdown-item")) {
          dropdownContainers.forEach(c => c.classList.remove("active"));
          return;
        }

        const isActive = container.classList.contains("active");
        // Close all dropdowns
        dropdownContainers.forEach(c => c.classList.remove("active"));
        if (!isActive) {
          container.classList.add("active");
        }
        e.stopPropagation();
      });

      container.addEventListener("mouseenter", () => {
        // If any dropdown is already active, open this one on hover
        const isAnyActive = Array.from(dropdownContainers).some(c => c.classList.contains("active"));
        if (isAnyActive && !container.classList.contains("active")) {
          dropdownContainers.forEach(c => c.classList.remove("active"));
          container.classList.add("active");
        }
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

    this.wysiwymContainer.addEventListener("input", () => {
      if (this.activeMode === "WYSIWYM") {
        const generatedMarkup = this.mapWysiwymToMarkup();
        this.handleContentMutation(generatedMarkup);
      }
    });

    this.wysiwymContainer.addEventListener("click", async (ev) => {
      const e = ev as MouseEvent;
      if (e.ctrlKey) {
        const target = e.target as HTMLElement;
        const linkSpan = target.closest(".wysiwym-link");
        if (linkSpan) {
          const url = linkSpan.getAttribute("data-url");
          if (url && (url.startsWith("http://") || url.startsWith("https://"))) {
            const trust = window.confirm(`Do you want to open this external link in your browser?\n\n${url}`);
            if (trust) {
              try {
                await openUrl(url);
              } catch (err) {
                console.error("Failed to open URL", err);
              }
            }
          }
        }
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
              this.previewSyncController.suppressOnce();
              this.editorInstance.dispatch({
                selection: { anchor: cursor },
                scrollIntoView: true
              });
              this.editorInstance.focus();
              void this.previewSyncController.renderAtCursor(cursor);
            } catch (err) { console.warn("Failed to inverse sync:", err); }
          }
        }
      }
    });
  }

  private mapMarkupToWysiwym(markup: string) {
    this.wysiwymAdapter.render(markup);
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
    return this.wysiwymAdapter.serialize();
  }

}

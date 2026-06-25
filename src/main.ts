import "./style.css";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { open as openUrl } from "@tauri-apps/plugin-shell";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { undo, redo } from "@codemirror/commands";
import { openSearchPanel } from "@codemirror/search";
import { getEditorExtensions, themeCompartment, getThemeExtension, applyUIThemeVariables, wrapCompartment, editorFontCompartment } from "./editor/extensions";
import { editorFontTheme } from "./editor/themes";
import { setEditorDiagnosticsEffect } from "./editor/diagnostics";
import type { EditorDiagnostic, EditorDiagnosticSeverity } from "./editor/diagnostics";
import { WorkspaceExplorer } from "./components/explorer";
import { TinymistLspClient } from "./compiler/lsp";
import type { LspDiagnostic, LspLogEntry, LspSourcePosition, LspStatus } from "./compiler/lsp";
import miSansKhmerRegularUrl from "./assets/fonts/MiSansKhmer-Regular.woff2?url";
import miSansKhmerBoldUrl from "./assets/fonts/MiSansKhmer-Bold.woff2?url";

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

type EditorFontCandidate = {
  id: string;
  language: string;
  fontFamily: string;
  regularUrl?: string;
  boldUrl?: string;
  restartRequired?: boolean;
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
};

const systemMonospaceFontStack = "ui-monospace, SFMono-Regular, Consolas, 'Liberation Mono', monospace";

const editorUnicodeFontRules: Array<EditorFontCandidate & { pattern: RegExp }> = [
  {
    id: "khmer",
    language: "Khmer",
    fontFamily: "MiSans Khmer",
    regularUrl: miSansKhmerRegularUrl,
    boldUrl: miSansKhmerBoldUrl,
    pattern: /[\u1780-\u17FF\u19E0-\u19FF]/
  },
  { id: "arabic", language: "Arabic", fontFamily: "MiSans Latin", restartRequired: true, pattern: /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/ },
  { id: "devanagari", language: "Devanagari", fontFamily: "MiSans Latin", restartRequired: true, pattern: /[\u0900-\u097F]/ },
  { id: "thai", language: "Thai", fontFamily: "MiSans Latin", restartRequired: true, pattern: /[\u0E00-\u0E7F]/ },
  { id: "cyrillic", language: "Cyrillic", fontFamily: "MiSans Latin", pattern: /[\u0400-\u04FF]/ },
  { id: "greek", language: "Greek", fontFamily: "MiSans Latin", pattern: /[\u0370-\u03FF]/ },
  { id: "japanese", language: "Japanese", fontFamily: "MiSans Latin", restartRequired: true, pattern: /[\u3040-\u30FF]/ },
  { id: "korean", language: "Korean", fontFamily: "MiSans Latin", restartRequired: true, pattern: /[\u1100-\u11FF\uAC00-\uD7AF]/ },
  { id: "cjk", language: "CJK", fontFamily: "MiSans Latin", restartRequired: true, pattern: /[\u3400-\u9FFF\uF900-\uFAFF]/ }
];

const fallbackUnicodeFontRule: EditorFontCandidate = {
  id: "unicode",
  language: "Unicode",
  fontFamily: "MiSans Latin",
  restartRequired: true
};

class TypstryWorkspaceController {
  private readonly previewHighlightPrefix = '#text(fill:rgb("#fe0102"))[';
  private readonly previewHighlightSuffix = "]";
  private activeMode: EditorMode = "CODE";
  private activeFilePath: string | null = null;
  private previewRootPath: string | null = null;
  private workspaceRootPath: string | null = null;
  private currentVersion = 1;
  private isLoadingFile = false;
  private clipboardFilePath: string | null = null;
  private lspReady = false;
  private readonly lspSyncDebounceMs = 350;
  private readonly forwardSyncDebounceMs = 120;
  private pendingLspSyncTimer: number | null = null;
  private pendingLspSyncPath: string | null = null;
  private pendingLspSyncText: string | null = null;
  private pendingForwardSyncTimer: number | null = null;
  private pendingPreviewSyncPollTimer: number | null = null;
  private suppressNextForwardSync = false;
  private previewHighlightMapping: PreviewHighlightMapping | null = null;
  private readonly previewOnlyVersions = new Set<number>();
  private previewOnlyDiagnosticsSuppressedUntil = 0;
  private latestDocumentVersion = 1;
  private nextLogEntryId = 1;
  private diagnosticLogEntries: LogConsoleEntry[] = [];
  private lspLogEntries: LogConsoleEntry[] = [];
  private isLogConsoleVisible = false;
  private openTabs: EditorTab[] = [];
  private activeEditorFontCandidate: EditorFontCandidate | null = null;
  private appliedEditorFontStack = systemMonospaceFontStack;
  private dismissedEditorFontPromptId: string | null = null;
  private readonly loadedEditorFonts = new Set<string>();

  private editorInstance!: EditorView;
  private explorer!: WorkspaceExplorer;
  private lspClient!: TinymistLspClient;

  private codePane = document.getElementById("code-editor-pane")!;
  private editorTabBar = document.getElementById("editor-tab-bar")!;
  private editorVisualToolbar = document.getElementById("editor-visual-toolbar")!;
  private codeRenderPane = document.getElementById("code-render-pane")!;
  private editorFontBreadcrumb = document.getElementById("editor-font-breadcrumb")!;
  private editorFontBreadcrumbText = document.getElementById("editor-font-breadcrumb-text")!;
  private editorFontDownload = document.getElementById("editor-font-download") as HTMLButtonElement;
  private editorFontDismiss = document.getElementById("editor-font-dismiss") as HTMLButtonElement;
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
  private diagnosticCount = document.getElementById("diagnostic-count")!;

  public async bootstrap() {
    this.renderRecentProjects();
    this.initCodeMirror();
    this.initExplorer();
    this.initVisualToolbar();
    this.bindGlobalEvents();
    this.initResizers();
    this.initUndockPreview();
    this.initThemeSelector();
    this.initWordWrap();
    this.initContextMenu();
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

  private initContextMenu() {
    const contextMenu = document.getElementById("context-menu");
    if (!contextMenu) return;

    let targetPath = "";
    let isTargetDir = false;

    // Hide context menu on click anywhere
    document.addEventListener("click", () => {
      contextMenu.style.display = "none";
    });

    // Handle clicks inside the context menu using event delegation
    contextMenu.addEventListener("click", async (e) => {
      const item = (e.target as HTMLElement).closest(".dropdown-item");
      if (!item) return;

      const action = item.id;
      
      switch (action) {
        case "ctx-new-file":
          if (this.workspaceRootPath) {
            this.explorer.showInlineInput(targetPath, "file", "", async (name) => {
              if (name) {
                const { join, dirname } = await import("@tauri-apps/api/path");
                let parentDir = this.workspaceRootPath!;
                if (targetPath) parentDir = isTargetDir ? targetPath : await dirname(targetPath);
                
                const newPath = await join(parentDir, name);
                try {
                   await invoke("save_workspace_file", { path: newPath, contents: "" });
                   if (this.workspaceRootPath) this.explorer.loadWorkspace(this.workspaceRootPath);
                   this.loadFile(newPath);
                } catch(e) { alert("Failed to create file: " + e); }
              }
            });
          } else {
            document.getElementById("action-new-file")?.click();
          }
          break;
        case "ctx-open-project":
          document.getElementById("action-open-folder")?.click();
          break;
        case "ctx-export-pdf":
          document.getElementById("action-export-pdf")?.click();
          break;
        case "ctx-copy-text":
          document.execCommand("copy");
          break;
        case "ctx-paste-text":
          try {
            const text = await navigator.clipboard.readText();
            this.editorInstance.dispatch(this.editorInstance.state.replaceSelection(text));
          } catch (err) {
            console.error("Failed to read clipboard:", err);
          }
          break;
        case "ctx-cut-text":
          document.execCommand("cut");
          break;
        case "ctx-undo":
          document.getElementById("action-undo")?.click();
          break;
        case "ctx-redo":
          document.getElementById("action-redo")?.click();
          break;
        case "ctx-fs-new-folder":
          if (targetPath || this.workspaceRootPath) {
            this.explorer.showInlineInput(targetPath, "folder", "", async (name) => {
              if (name) {
                const { join, dirname } = await import("@tauri-apps/api/path");
                let parentDir = this.workspaceRootPath!;
                if (targetPath) {
                   parentDir = isTargetDir ? targetPath : await dirname(targetPath);
                }
                const newDirPath = await join(parentDir, name);
                try {
                  await invoke("create_workspace_dir", { path: newDirPath });
                  if (this.workspaceRootPath) this.explorer.loadWorkspace(this.workspaceRootPath);
                } catch(e) { alert("Failed to create folder: " + e); }
              }
            });
          }
          break;
        case "ctx-fs-rename":
          if (targetPath) {
            const { basename } = await import("@tauri-apps/api/path");
            const oldName = await basename(targetPath);
            this.explorer.showInlineInput(targetPath, "rename", oldName, async (newName) => {
              if (newName && newName !== oldName) {
                const { join, dirname } = await import("@tauri-apps/api/path");
                const dir = await dirname(targetPath);
                const newPath = await join(dir, newName);
                try {
                  await invoke("rename_workspace_file", { oldPath: targetPath, newPath });
                  if (this.workspaceRootPath) this.explorer.loadWorkspace(this.workspaceRootPath);
                  const wasActiveTab = this.activeFilePath === targetPath;
                  this.updateEditorTabPath(targetPath, newPath);
                  if (wasActiveTab) {
                     await this.activateEditorTab(newPath, false);
                  }
                } catch(e) { alert("Failed to rename: " + e); }
              }
            });
          }
          break;
        case "ctx-fs-delete":
          if (targetPath) {
            const { confirm } = await import("@tauri-apps/plugin-dialog");
            const isConfirmed = await confirm("Are you sure you want to move this " + (isTargetDir ? "folder" : "file") + " to the Trash?", { title: "Confirm Delete", kind: "warning" });
            if (isConfirmed) {
              try {
                await invoke("move_to_trash", { path: targetPath });
                if (this.workspaceRootPath) this.explorer.loadWorkspace(this.workspaceRootPath);
                if (this.activeFilePath === targetPath) {
                   await this.closeEditorTab(targetPath, true);
                } else {
                   await this.closeEditorTab(targetPath, true);
                }
              } catch(e) { alert("Failed to move to trash: " + e); }
            }
          }
          break;
        case "ctx-fs-copy":
          if (targetPath) {
            if (isTargetDir) {
               alert("Copying directories directly is not yet supported.");
            } else {
               this.clipboardFilePath = targetPath;
            }
          }
          break;
        case "ctx-fs-reveal":
          if (targetPath) {
             invoke("reveal_in_explorer", { path: targetPath }).catch(console.error);
          }
          break;
        case "ctx-fs-copy-rel-path":
          if (targetPath && this.workspaceRootPath) {
             const relPath = targetPath.replace(this.workspaceRootPath, "").replace(/^[\\\/]/, "");
             navigator.clipboard.writeText(relPath.replace(/\\/g, "/")).catch(console.error);
          }
          break;
        case "ctx-fs-copy-abs-path":
          if (targetPath) {
             navigator.clipboard.writeText(targetPath).catch(console.error);
          }
          break;
        case "ctx-editor-format":
          if (this.activeFilePath && this.lspReady && this.lspClient) {
             // Currently relying on Tinymist for formatting. Wait for proper textDocument/formatting support in TinyMist LSP client implementation, or trigger save.
             await this.saveActiveFile();
          }
          break;
        case "ctx-editor-toggle-comment":
          import("@codemirror/commands").then(({ toggleLineComment }) => {
            toggleLineComment(this.editorInstance);
          });
          break;
        case "ctx-editor-select-all":
          import("@codemirror/commands").then(({ selectAll }) => {
            selectAll(this.editorInstance);
          });
          break;
        case "ctx-preview-open-external":
          if (this.activeFilePath) {
             const { dirname, join, basename } = await import("@tauri-apps/api/path");
             const dir = await dirname(this.activeFilePath);
             const name = await basename(this.activeFilePath);
             const pdfName = name.replace(/\.typ$/i, ".pdf");
             const pdfPath = await join(dir, pdfName);
             const { open } = await import("@tauri-apps/plugin-shell");
             open(pdfPath).catch(console.error);
          }
          break;
        case "ctx-fs-paste":
          if (this.clipboardFilePath) {
             const { basename, join, dirname } = await import("@tauri-apps/api/path");
             
             let parentDir = this.workspaceRootPath!;
             if (targetPath) {
                 parentDir = isTargetDir ? targetPath : await dirname(targetPath);
             }
             
             try {
                const name = await basename(this.clipboardFilePath);
                // Basic strategy to prevent overwriting: prefix with "Copy of "
                const newName = "Copy of " + name;
                const newPath = await join(parentDir, newName);
                await invoke("copy_workspace_file", { source: this.clipboardFilePath, dest: newPath });
                if (this.workspaceRootPath) this.explorer.loadWorkspace(this.workspaceRootPath);
             } catch(e) { alert("Failed to paste file: " + e); }
          }
          break;
      }
    });

    document.addEventListener("contextmenu", (e) => {
      // Prevent the default browser context menu globally
      e.preventDefault();
      
      const target = e.target as HTMLElement;
      let menuItems = "";

      const explorerItem = target.closest(".explorer-item-target") as HTMLElement;
      const isExplorer = target.closest("#explorer-sidebar");
      const isEditor = target.closest(".cm-editor") || target.closest("#code-render-pane");
      const isPreview = target.closest("#preview-container-wrapper");

      targetPath = explorerItem?.dataset?.path || "";
      isTargetDir = explorerItem?.dataset?.isDir === "true";

      if (explorerItem) {
        menuItems = `
          <div class="dropdown-item" id="ctx-new-file">New File</div>
          <div class="dropdown-item" id="ctx-fs-new-folder">New Folder</div>
          <div class="dropdown-separator"></div>
          <div class="dropdown-item" id="ctx-fs-rename">Rename</div>
          <div class="dropdown-item" id="ctx-fs-delete">Delete</div>
          ${!isTargetDir ? '<div class="dropdown-separator"></div><div class="dropdown-item" id="ctx-fs-copy">Copy File</div>' : ''}
          ${this.clipboardFilePath ? '<div class="dropdown-item" id="ctx-fs-paste">Paste File</div>' : ''}
          <div class="dropdown-separator"></div>
          <div class="dropdown-item" id="ctx-fs-reveal">Reveal in System Explorer</div>
          <div class="dropdown-item" id="ctx-fs-copy-rel-path">Copy Relative Path</div>
          <div class="dropdown-item" id="ctx-fs-copy-abs-path">Copy Absolute Path</div>
          <div class="dropdown-separator"></div>
          <div class="dropdown-item" id="ctx-open-project">Open Workspace <span class="hotkey">Ctrl+K Ctrl+O</span></div>
        `;
      } else if (isExplorer) {
        targetPath = this.workspaceRootPath || "";
        isTargetDir = !!this.workspaceRootPath;
        menuItems = `
          <div class="dropdown-item" id="ctx-new-file">New File <span class="hotkey">Ctrl+N</span></div>
          <div class="dropdown-item" id="ctx-fs-new-folder">New Folder</div>
          ${this.clipboardFilePath ? '<div class="dropdown-separator"></div><div class="dropdown-item" id="ctx-fs-paste">Paste File</div>' : ''}
          ${this.workspaceRootPath ? '<div class="dropdown-separator"></div><div class="dropdown-item" id="ctx-fs-reveal">Reveal Workspace in Explorer</div>' : ''}
          <div class="dropdown-separator"></div>
          <div class="dropdown-item" id="ctx-open-project">Open Workspace <span class="hotkey">Ctrl+K Ctrl+O</span></div>
        `;
      } else if (isEditor) {
        menuItems = `
          <div class="dropdown-item" id="ctx-copy-text">Copy <span class="hotkey">Ctrl+C</span></div>
          <div class="dropdown-item" id="ctx-paste-text">Paste <span class="hotkey">Ctrl+V</span></div>
          <div class="dropdown-item" id="ctx-cut-text">Cut <span class="hotkey">Ctrl+X</span></div>
          <div class="dropdown-separator"></div>
          <div class="dropdown-item" id="ctx-editor-toggle-comment">Toggle Line Comment <span class="hotkey">Ctrl+/</span></div>
          <div class="dropdown-item" id="ctx-editor-format">Format Document <span class="hotkey">Shift+Alt+F</span></div>
          <div class="dropdown-separator"></div>
          <div class="dropdown-item" id="ctx-undo">Undo <span class="hotkey">Ctrl+Z</span></div>
          <div class="dropdown-item" id="ctx-redo">Redo <span class="hotkey">Ctrl+Y</span></div>
          <div class="dropdown-separator"></div>
          <div class="dropdown-item" id="ctx-editor-select-all">Select All <span class="hotkey">Ctrl+A</span></div>
        `;
      } else if (isPreview) {
        menuItems = `
          <div class="dropdown-item" id="ctx-preview-open-external">Open in External Viewer</div>
          <div class="dropdown-separator"></div>
          <div class="dropdown-item" id="ctx-export-pdf">Export PDF</div>
        `;
      } else {
        // Default fallback menu
        menuItems = `
          <div class="dropdown-item" id="ctx-open-project">Open Workspace <span class="hotkey">Ctrl+K Ctrl+O</span></div>
        `;
      }

      contextMenu.innerHTML = menuItems;
      contextMenu.style.display = "block";
      
      // Ensure menu doesn't go off-screen
      const rect = contextMenu.getBoundingClientRect();
      let x = e.clientX;
      let y = e.clientY;
      if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width;
      if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height;
      
      contextMenu.style.left = `${x}px`;
      contextMenu.style.top = `${y}px`;
    });

    const previewMenuBtn = document.getElementById("preview-menu-btn");
    if (previewMenuBtn) {
      previewMenuBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const menuItems = `
          <div class="dropdown-item" id="ctx-preview-open-external">Open in External Viewer</div>
          <div class="dropdown-separator"></div>
          <div class="dropdown-item" id="ctx-export-pdf">Export PDF</div>
        `;
        contextMenu.innerHTML = menuItems;
        contextMenu.style.display = "block";
        const rect = previewMenuBtn.getBoundingClientRect();
        contextMenu.style.left = `${rect.right - contextMenu.offsetWidth}px`;
        contextMenu.style.top = `${rect.bottom + 4}px`;
      });
    }

    // Handle messages from the injected script in the preview iframe
    window.addEventListener("message", (e) => {
      if (e.data?.type === "HIDE_CONTEXT_MENU") {
         contextMenu.style.display = "none";
      } else if (e.data?.type === "SHOW_PREVIEW_CONTEXT_MENU" && this.previewIframe) {
        const iframeRect = this.previewIframe.getBoundingClientRect();
        let x = iframeRect.left + e.data.x;
        let y = iframeRect.top + e.data.y;

        const menuItems = `
          <div class="dropdown-item" id="ctx-preview-open-external">Open in External Viewer</div>
          <div class="dropdown-separator"></div>
          <div class="dropdown-item" id="ctx-export-pdf">Export PDF</div>
        `;
        contextMenu.innerHTML = menuItems;
        contextMenu.style.display = "block";
        
        // Ensure menu doesn't go off-screen
        const menuRect = contextMenu.getBoundingClientRect();
        if (x + menuRect.width > window.innerWidth) x = window.innerWidth - menuRect.width;
        if (y + menuRect.height > window.innerHeight) y = window.innerHeight - menuRect.height;
        
        contextMenu.style.left = `${x}px`;
        contextMenu.style.top = `${y}px`;
      }
    });
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
    const initialDocument = "";
    this.bindEditorFontBreadcrumb();
    this.editorInstance = new EditorView({
      state: EditorState.create({
        doc: initialDocument,
        extensions: [
          getEditorExtensions(() => this.lspClient, () => this.activeFilePath ? (this as any).filePathToUri(this.activeFilePath) : "", () => this.flushPendingLspSync()),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              const currentText = update.state.doc.toString();
              this.clearPendingForwardSync();
              this.updateEditorUnicodeFontState(currentText);
              this.handleContentMutation(currentText);
            } else if (this.shouldForwardSyncSelectionUpdate(update)) {
              this.scheduleForwardSync(this.forwardSyncDebounceMs);
            }
          })
        ]
      }),
      parent: this.codeRenderPane
    });
    this.codeRenderPane.addEventListener("click", (event) => {
      if ((event.target as HTMLElement).closest(".cm-editor")) {
        this.scheduleForwardSync(this.forwardSyncDebounceMs);
      }
    });
    this.updateEditorUnicodeFontState(initialDocument);
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

  private bindEditorFontBreadcrumb() {
    this.editorFontDownload.addEventListener("click", () => {
      if (!this.activeEditorFontCandidate) return;
      void this.downloadAndApplyEditorFont(this.activeEditorFontCandidate);
    });

    this.editorFontDismiss.addEventListener("click", () => {
      this.dismissedEditorFontPromptId = this.activeEditorFontCandidate?.id ?? null;
      this.hideEditorFontBreadcrumb();
    });
  }

  private updateEditorUnicodeFontState(text: string) {
    const candidate = this.detectEditorFontCandidate(text);
    this.activeEditorFontCandidate = candidate;

    if (!candidate) {
      this.dismissedEditorFontPromptId = null;
      this.hideEditorFontBreadcrumb();
      this.applyEditorFontStack(systemMonospaceFontStack, null);
      return;
    }

    if (this.isEditorFontDownloaded(candidate)) {
      const showAppliedNotice = this.dismissedEditorFontPromptId !== candidate.id;
      void this.downloadAndApplyEditorFont(candidate, true, showAppliedNotice);
      if (!showAppliedNotice) {
        this.hideEditorFontBreadcrumb();
      }
      return;
    }

    if (this.dismissedEditorFontPromptId === candidate.id) {
      this.hideEditorFontBreadcrumb();
      return;
    }

    this.renderEditorFontPrompt(candidate);
  }

  private detectEditorFontCandidate(text: string): EditorFontCandidate | null {
    if (!/[^\u0000-\u007F]/.test(text)) {
      return null;
    }

    const rule = editorUnicodeFontRules.find((candidate) => candidate.pattern.test(text));
    if (rule) {
      return rule;
    }

    return fallbackUnicodeFontRule;
  }

  private renderEditorFontPrompt(candidate: EditorFontCandidate) {
    this.editorFontBreadcrumbText.textContent = `${candidate.language} text detected. Download ${candidate.fontFamily} for the editor?`;
    this.editorFontDownload.textContent = `Download ${candidate.fontFamily}`;
    this.editorFontDownload.disabled = false;
    this.editorFontDownload.classList.remove("hidden");
    this.editorFontBreadcrumb.classList.remove("hidden");
  }

  private renderEditorFontApplied(candidate: EditorFontCandidate) {
    const restartText = candidate.restartRequired
      ? " Restart Typstry if glyphs still render incorrectly."
      : " Restart Typstry if the change does not appear everywhere.";
    this.editorFontBreadcrumbText.textContent = `${candidate.fontFamily} applied for ${candidate.language}.${restartText}`;
    this.editorFontDownload.classList.add("hidden");
    this.editorFontBreadcrumb.classList.remove("hidden");
  }

  private hideEditorFontBreadcrumb() {
    this.editorFontBreadcrumb.classList.add("hidden");
  }

  private isEditorFontDownloaded(candidate: EditorFontCandidate): boolean {
    return this.getDownloadedEditorFontIds().has(candidate.id);
  }

  private getDownloadedEditorFontIds(): Set<string> {
    try {
      const stored = JSON.parse(localStorage.getItem("typstry-downloaded-editor-fonts") || "[]");
      return new Set(Array.isArray(stored) ? stored.filter((value): value is string => typeof value === "string") : []);
    } catch {
      return new Set();
    }
  }

  private markEditorFontDownloaded(candidate: EditorFontCandidate) {
    const downloaded = this.getDownloadedEditorFontIds();
    downloaded.add(candidate.id);
    localStorage.setItem("typstry-downloaded-editor-fonts", JSON.stringify([...downloaded]));
  }

  private async downloadAndApplyEditorFont(candidate: EditorFontCandidate, fromCache = false, showNotice = true) {
    if (this.activeEditorFontCandidate?.id !== candidate.id) {
      return;
    }

    if (!fromCache) {
      this.editorFontDownload.disabled = true;
      this.editorFontDownload.textContent = "Downloading...";
    }

    try {
      await this.loadEditorFont(candidate);
      this.markEditorFontDownloaded(candidate);
      const fontStack = `"${candidate.fontFamily}", ${systemMonospaceFontStack}`;
      this.applyEditorFontStack(fontStack, candidate.fontFamily);
      if (!fromCache || showNotice) {
        this.dismissedEditorFontPromptId = null;
      }
      if (showNotice) {
        this.renderEditorFontApplied(candidate);
      }
    } catch (error) {
      this.editorFontBreadcrumbText.textContent = `Could not load ${candidate.fontFamily}: ${String(error)}`;
      this.editorFontDownload.textContent = `Retry ${candidate.fontFamily}`;
      this.editorFontDownload.disabled = false;
      this.editorFontDownload.classList.remove("hidden");
      this.editorFontBreadcrumb.classList.remove("hidden");
    }
  }

  private async loadEditorFont(candidate: EditorFontCandidate) {
    if (this.loadedEditorFonts.has(candidate.id)) {
      return;
    }

    if (candidate.regularUrl) {
      const regularFace = new FontFace(candidate.fontFamily, `url(${candidate.regularUrl})`, { weight: "400" });
      document.fonts.add(await regularFace.load());
    } else {
      await document.fonts.load(`14px "${candidate.fontFamily}"`);
    }

    if (candidate.boldUrl) {
      const boldFace = new FontFace(candidate.fontFamily, `url(${candidate.boldUrl})`, { weight: "700" });
      document.fonts.add(await boldFace.load());
    }

    this.loadedEditorFonts.add(candidate.id);
  }

  private applyEditorFontStack(fontStack: string, fontFamily: string | null = null) {
    if (this.appliedEditorFontStack === fontStack) {
      return;
    }

    this.appliedEditorFontStack = fontStack;
    this.editorInstance.dispatch({
      effects: editorFontCompartment.reconfigure(editorFontTheme(fontStack))
    });

    if (fontFamily) {
      document.documentElement.style.setProperty("--active-unicode-font", `"${fontFamily}"`);
    } else {
      document.documentElement.style.removeProperty("--active-unicode-font");
    }
  }

  private initExplorer() {
    this.explorer = new WorkspaceExplorer(document.getElementById("explorer-sidebar")!, (path) => this.loadFile(path));
  }

  private initVisualToolbar() {
    this.editorVisualToolbar.addEventListener("pointerdown", (event) => {
      const target = event.target as HTMLElement;
      if (target.closest("[data-tool]") || target.closest(".toolbar-dropdown-btn")) {
        event.preventDefault();
      }
    });

    this.editorVisualToolbar.addEventListener("click", (event) => {
      const target = event.target as HTMLElement;

      const dropdownBtn = target.closest(".toolbar-dropdown-btn");
      if (dropdownBtn) {
        const container = dropdownBtn.closest(".toolbar-dropdown-container");
        if (container) {
          this.editorVisualToolbar.querySelectorAll(".toolbar-dropdown-container.active").forEach((el) => {
            if (el !== container) el.classList.remove("active");
          });
          container.classList.toggle("active");
          event.stopPropagation();
        }
        return;
      }

      const button = target.closest("[data-tool]") as HTMLElement | null;
      if (!button) {
        this.editorVisualToolbar.querySelectorAll(".toolbar-dropdown-container.active").forEach((el) => {
          el.classList.remove("active");
        });
        return;
      }

      this.editorVisualToolbar.querySelectorAll(".toolbar-dropdown-container.active").forEach((el) => {
        el.classList.remove("active");
      });

      void this.runVisualToolbarTool(button.dataset.tool ?? "");
    });

    document.addEventListener("click", (event) => {
      if (!this.editorVisualToolbar.contains(event.target as Node)) {
        this.editorVisualToolbar.querySelectorAll(".toolbar-dropdown-container.active").forEach((el) => {
          el.classList.remove("active");
        });
      }
    });
  }

  private async runVisualToolbarTool(tool: string) {
    if (this.activeMode === "WYSIWYM" && tool !== "toggle-mode") {
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0 && this.wysiwymContainer.contains(sel.anchorNode)) {
        const range = sel.getRangeAt(0);
        const selectedText = range.toString();
        const anchorNode = sel.anchorNode!;
        const parentEl = (anchorNode.nodeType === Node.TEXT_NODE ? anchorNode.parentElement : anchorNode) as HTMLElement;
        const wysiwymBlock = parentEl?.closest('.wysiwym-block') as HTMLElement;

        // Handle inline formatting
        const inlineMap: Record<string, [string, string, string]> = {
          "bold": ["*", "*", "strong text"],
          "italic": ["_", "_", "emphasized text"],
          "underline": ["#underline[", "]", "text"],
          "strikethrough": ["#strike[", "]", "text"],
          "highlight": ["#highlight[", "]", "text"],
          "inline-code": ["`", "`", "code"],
          "footnote": ["#footnote[", "]", "note"],
          "label": ["<", ">", "label"],
          "reference": ["@", "", "label"],
          "inline-math": ["$", "$", "x"],
          "subscript": ["_", "", "sub"],
          "superscript": ["^", "", "sup"]
        };

        if (inlineMap[tool]) {
          const [prefix, suffix, placeholder] = inlineMap[tool];
          
          let existingSpan: HTMLElement | null = null;
          let node: Node | null = anchorNode;
          const className = `wysiwym-${tool}`;
          while (node && node !== this.wysiwymContainer) {
             if (node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).classList.contains(className)) {
                 existingSpan = node as HTMLElement;
                 break;
             }
             node = node.parentNode;
          }

          if (existingSpan) {
              const prev = existingSpan.previousSibling;
              const next = existingSpan.nextSibling;
              if (prev && prev.nodeType === Node.ELEMENT_NODE && (prev as HTMLElement).classList.contains("wysiwym-marker")) {
                  prev.parentNode?.removeChild(prev);
              }
              if (next && next.nodeType === Node.ELEMENT_NODE && (next as HTMLElement).classList.contains("wysiwym-marker")) {
                  next.parentNode?.removeChild(next);
              }
              const parent = existingSpan.parentNode;
              if (parent) {
                  while (existingSpan.firstChild) {
                      parent.insertBefore(existingSpan.firstChild, existingSpan);
                  }
                  parent.removeChild(existingSpan);
              }
          } else {
              const textToWrap = selectedText || placeholder;
              const newNode = document.createTextNode(`${prefix}${textToWrap}${suffix}`);
              range.deleteContents();
              range.insertNode(newNode);
          }
        } else if (wysiwymBlock) {
          // Handle block-level formatting
          this.wysiwymContainer.classList.add("serialize-mode");
          const currentText = wysiwymBlock.innerText;
          this.wysiwymContainer.classList.remove("serialize-mode");

          if (tool.startsWith("heading-")) {
            const level = tool.split("-")[1];
            const headingRegex = new RegExp(`^={${level}}\\s+`);
            if (headingRegex.test(currentText)) {
              wysiwymBlock.innerText = currentText.replace(/^=+\s*/, "");
            } else {
              wysiwymBlock.innerText = "=".repeat(Number(level)) + " " + currentText.replace(/^=+\s*/, "");
            }
          } else if (tool === "bullet-list") {
            if (currentText.startsWith("- ")) wysiwymBlock.innerText = currentText.replace(/^- \s*/, "");
            else wysiwymBlock.innerText = "- " + currentText.replace(/^[-+]\s*/, "");
          } else if (tool === "numbered-list") {
            if (currentText.startsWith("+ ")) wysiwymBlock.innerText = currentText.replace(/^\+ \s*/, "");
            else wysiwymBlock.innerText = "+ " + currentText.replace(/^[-+]\s*/, "");
          } else if (tool === "align-center") {
            if (currentText.startsWith("#align(center)[\n") && currentText.endsWith("\n]")) {
               wysiwymBlock.innerText = currentText.substring(16, currentText.length - 2).trim();
            } else {
               wysiwymBlock.innerText = `#align(center)[\n  ${currentText}\n]`;
            }
          } else if (tool === "align-right") {
            if (currentText.startsWith("#align(right)[\n") && currentText.endsWith("\n]")) {
               wysiwymBlock.innerText = currentText.substring(15, currentText.length - 2).trim();
            } else {
               wysiwymBlock.innerText = `#align(right)[\n  ${currentText}\n]`;
            }
          } else if (tool === "blockquote") {
            if (currentText.startsWith("#quote(block: true)[\n") && currentText.endsWith("\n]")) {
               wysiwymBlock.innerText = currentText.substring(21, currentText.length - 2).trim();
            } else {
               wysiwymBlock.innerText = `#quote(block: true)[\n  ${currentText}\n]`;
            }
          }
        }
      }

      // If snippet tools
      if (["table", "figure", "bibliography", "math-block", "outline", "pagebreak"].includes(tool)) {
          const snippetMap: Record<string, string> = {
            "table": `#table(\n  columns: 3,\n  [Header 1], [Header 2], [Header 3],\n  [Cell 1], [Cell 2], [Cell 3],\n)\n`,
            "figure": `#figure(\n  image("image.png", width: 80%),\n  caption: [Caption],\n)\n`,
            "bibliography": `#bibliography("refs.bib")\n`,
            "math-block": `$\n  x = frac(-b plus.minus sqrt(b^2 - 4 a c), 2 a)\n$\n`,
            "outline": `#outline()\n`,
            "pagebreak": `#pagebreak()\n`
          };
          const snippetDiv = document.createElement("div");
          snippetDiv.className = "wysiwym-block body";
          snippetDiv.innerText = snippetMap[tool];
          
          if (sel && sel.rangeCount > 0 && this.wysiwymContainer.contains(sel.anchorNode)) {
             const anchorNode = sel.anchorNode!;
             const parentEl = (anchorNode.nodeType === Node.TEXT_NODE ? anchorNode.parentElement : anchorNode) as HTMLElement;
             const wysiwymBlock = parentEl?.closest('.wysiwym-block') as HTMLElement;
             if (wysiwymBlock && wysiwymBlock.parentNode) {
                 wysiwymBlock.parentNode.insertBefore(snippetDiv, wysiwymBlock.nextSibling);
             } else {
                 this.wysiwymContainer.appendChild(snippetDiv);
             }
          } else {
             this.wysiwymContainer.appendChild(snippetDiv);
          }
      }

      // Push DOM state to CodeMirror
      const markup = this.mapWysiwymToMarkup();
      this.editorInstance.dispatch({
        changes: { from: 0, to: this.editorInstance.state.doc.length, insert: markup }
      });
      // Re-render WYSIWYM from the clean markup to parse styles properly
      this.mapMarkupToWysiwym(markup);
      return; // Exit early so it doesn't trigger CodeMirror-specific logic below
    }

    switch (tool) {
      case "save":
        await this.saveActiveFile();
        break;
      case "undo":
        undo(this.editorInstance);
        break;
      case "redo":
        redo(this.editorInstance);
        break;
      case "find-replace":
        openSearchPanel(this.editorInstance);
        break;
      case "heading-1":
        this.applyHeading(1);
        break;
      case "heading-2":
        this.applyHeading(2);
        break;
      case "heading-3":
        this.applyHeading(3);
        break;
      case "bold":
        this.wrapSelection("#strong[", "]", "strong text");
        break;
      case "italic":
        this.wrapSelection("#emph[", "]", "emphasized text");
        break;
      case "underline":
        this.wrapSelection("#underline[", "]", "text");
        break;
      case "strikethrough":
        this.wrapSelection("#strike[", "]", "text");
        break;
      case "highlight":
        this.wrapSelection("#highlight[", "]", "text");
        break;
      case "inline-code":
        this.wrapSelection("`", "`", "code");
        break;
      case "code-block":
        this.wrapSelection("```typst\n", "\n```", "code");
        break;
      case "blockquote":
        this.wrapSelection("#quote(block: true)[\n  ", "\n]", "quote");
        break;
      case "link":
        this.wrapSelection('#link("https://example.com")[', "]", "link text");
        break;
      case "bullet-list":
        this.applyLinePrefix("- ");
        break;
      case "numbered-list":
        this.applyLinePrefix("+ ");
        break;
      case "table":
        this.insertSnippet(`#table(
  columns: 3,
  [Header 1], [Header 2], [Header 3],
  [Cell 1], [Cell 2], [Cell 3],
)
`);
        break;
      case "figure":
        this.insertSnippet(`#figure(
  image("image.png", width: 80%),
  caption: [Caption],
)
`);
        break;
      case "footnote":
        this.wrapSelection("#footnote[", "]", "note");
        break;
      case "label":
        this.wrapSelection("<", ">", "label");
        break;
      case "reference":
        this.wrapSelection("@", "", "label");
        break;
      case "bibliography":
        this.insertSnippet('#bibliography("refs.bib")\n');
        break;
      case "inline-math":
        this.wrapSelection("$", "$", "x");
        break;
      case "math-block":
        this.insertSnippet(`$
  x = frac(-b plus.minus sqrt(b^2 - 4 a c), 2 a)
$
`);
        break;
      case "fraction":
        this.insertSnippet("$frac(1, 2)$", 6, 7);
        break;
      case "sqrt":
        this.insertSnippet("$sqrt(x)$", 6, 7);
        break;
      case "subscript":
        this.wrapSelection("_", "", "sub");
        break;
      case "superscript":
        this.wrapSelection("^", "", "sup");
        break;
      case "outline":
        this.insertSnippet("#outline()\n");
        break;
      case "pagebreak":
        this.insertSnippet("#pagebreak()\n");
        break;
      case "align-center":
        this.wrapSelection("#align(center)[\n  ", "\n]", "content");
        break;
      case "align-right":
        this.wrapSelection("#align(right)[\n  ", "\n]", "content");
        break;
      case "sync-preview":
        await this.renderHighlightedPreviewAtCursor(this.editorInstance.state.selection.main.head);
        this.editorInstance.focus();
        break;
      case "export-pdf":
        document.getElementById("action-export-pdf")?.click();
        break;
      case "toggle-wrap":
        document.getElementById("word-wrap-toggle")?.click();
        break;
      case "toggle-mode":
        this.switchViewLayoutMode();
        break;
    }

    if (this.activeMode === "WYSIWYM" && tool !== "toggle-mode") {
      this.mapMarkupToWysiwym(this.editorInstance.state.doc.toString());
    }
  }

  private wrapSelection(prefix: string, suffix: string, placeholder: string) {
    const state = this.editorInstance.state;
    const transaction = state.changeByRange((range) => {
      const selectedText = state.sliceDoc(range.from, range.to) || placeholder;
      const insert = `${prefix}${selectedText}${suffix}`;
      const selectionFrom = range.from + prefix.length;
      const selectionTo = selectionFrom + selectedText.length;

      return {
        changes: { from: range.from, to: range.to, insert },
        range: EditorSelection.range(selectionFrom, selectionTo)
      };
    });

    this.editorInstance.dispatch(transaction, { scrollIntoView: true, userEvent: "input" });
    this.editorInstance.focus();
  }

  private insertSnippet(snippet: string, selectFrom?: number, selectTo?: number) {
    const state = this.editorInstance.state;
    const range = state.selection.main;
    const selectionFrom = range.from + (selectFrom ?? snippet.length);
    const selectionTo = range.from + (selectTo ?? (selectFrom ?? snippet.length));

    this.editorInstance.dispatch({
      changes: { from: range.from, to: range.to, insert: snippet },
      selection: { anchor: selectionFrom, head: selectionTo },
      scrollIntoView: true,
      userEvent: "input"
    });
    this.editorInstance.focus();
  }

  private applyHeading(level: number) {
    const state = this.editorInstance.state;
    const selection = state.selection.main;
    const line = state.doc.lineAt(selection.from);
    const prefix = `${"=".repeat(level)} `;
    const lineText = line.text.replace(/^=+\s*/, "");

    this.editorInstance.dispatch({
      changes: { from: line.from, to: line.to, insert: `${prefix}${lineText}` },
      selection: { anchor: line.from + prefix.length, head: line.from + prefix.length + lineText.length },
      scrollIntoView: true,
      userEvent: "input"
    });
    this.editorInstance.focus();
  }

  private applyLinePrefix(prefix: string) {
    const state = this.editorInstance.state;
    const selection = state.selection.main;
    const startLine = state.doc.lineAt(selection.from);
    const endPosition = selection.to > selection.from ? selection.to - 1 : selection.to;
    const endLine = state.doc.lineAt(endPosition);
    const changes = [];

    for (let lineNumber = startLine.number; lineNumber <= endLine.number; lineNumber++) {
      const line = state.doc.line(lineNumber);
      changes.push({ from: line.from, insert: prefix });
    }

    this.editorInstance.dispatch({
      changes,
      scrollIntoView: true,
      userEvent: "input"
    });
    this.editorInstance.focus();
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
      title.textContent = this.fileNameFromPath(tab.path);
      tabButton.appendChild(title);

      const dirtyDot = document.createElement("span");
      dirtyDot.className = "editor-tab-dirty";
      dirtyDot.setAttribute("aria-hidden", "true");
      tabButton.appendChild(dirtyDot);

      const closeButton = document.createElement("span");
      closeButton.className = "editor-tab-close";
      closeButton.textContent = "x";
      closeButton.title = "Close";
      closeButton.setAttribute("aria-label", `Close ${this.fileNameFromPath(tab.path)}`);
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
      const { confirm: confirmDialog } = await import("@tauri-apps/plugin-dialog");
      const shouldClose = await confirmDialog(
        `Close ${this.fileNameFromPath(tab.path)} without saving?`,
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
      this.clearPendingForwardSync();

      if (nextTab) {
        await this.activateEditorTab(nextTab.path, false);
      } else {
        this.isLoadingFile = true;
        try {
          this.editorInstance.dispatch({
            changes: { from: 0, to: this.editorInstance.state.doc.length, insert: "" }
          });
        } finally {
          this.isLoadingFile = false;
        }
        this.previewPane.innerHTML = "";
        this.updateEditorUnicodeFontState("");
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
    this.previewOnlyVersions.clear();
    this.previewHighlightMapping = null;
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

    if (tab.scrollTop !== undefined || tab.scrollLeft !== undefined) {
      requestAnimationFrame(() => {
        if (tab.scrollTop !== undefined) this.editorInstance.scrollDOM.scrollTop = tab.scrollTop;
        if (tab.scrollLeft !== undefined) this.editorInstance.scrollDOM.scrollLeft = tab.scrollLeft;
      });
    }

    this.activeFilePath = path;
    this.previewRootPath = await invoke<string | null>("resolve_preview_main", {
      filePath: path,
      workspaceRootPath: this.workspaceRootPath
    });
    tab.previewRootPath = this.previewRootPath;
    this.clearPendingLspSync();
    this.clearPendingForwardSync();
    this.renderEditorTabs();
    this.updateEditorUnicodeFontState(tab.content);

    if (this.lspReady && this.lspClient) {
      const uri = this.filePathToUri(path);
      await this.lspClient.openTextDocument(uri, tab.content, this.currentVersion);
      void this.runFallbackDiagnostics(path, tab.content, this.currentVersion);

      if (this.previewRootPath) {
        this.previewPane.innerHTML = `<div style="padding: 20px; color: #007acc; font-family: sans-serif;">Starting live preview server...</div>`;
        const previewUrl = await this.startPreviewWithRestart(this.previewRootPath, tab.content);
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
    const existingTab = this.openTabs.find((tab) => tab.path === path);
    if (existingTab) {
      await this.activateEditorTab(path);
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
        selectionHead: 0
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
    this.previewHighlightMapping = null;
    this.previewOnlyVersions.clear();
    const version = ++this.currentVersion;
    this.latestDocumentVersion = version;
    const activeTab = this.getActiveTab();
    if (activeTab && activeTab.path === path) {
      activeTab.version = version;
      activeTab.latestVersion = version;
    }
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

      const filteredDiagnostics = diagnostics.filter(
        (diagnostic) => !diagnostic.message.includes("cannot export multiple images without a page number template")
      );

      const editorDiagnostics = filteredDiagnostics
        .map((diagnostic) => this.editorDiagnosticFromFallback(diagnostic))
        .filter((diagnostic): diagnostic is EditorDiagnostic => diagnostic !== null);

      this.editorInstance.dispatch({
        effects: setEditorDiagnosticsEffect.of(editorDiagnostics)
      });

      this.diagnosticLogEntries = filteredDiagnostics.map((diagnostic) => ({
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
    if (!previewHighlight) {
      this.clearPendingPreviewSyncPoll();
      if (this.previewHighlightMapping) {
        this.revertSyncText();
      }
      return;
    }

    this.previewHighlightMapping = previewHighlight.mapping;
    const version = ++this.currentVersion;
    this.previewOnlyVersions.add(version);
    this.previewOnlyDiagnosticsSuppressedUntil = Date.now() + 2000;
    this.clearPendingPreviewSyncPoll();

    await this.lspClient.notifyTextChange(
      this.filePathToUri(this.activeFilePath),
      previewHighlight.text,
      version
    );

    // Tell Tinymist to navigate to the correct page and rough line so the DOM node renders
    window.setTimeout(() => {
      if (this.activeFilePath && this.lspReady && this.lspClient) {
        void this.lspClient.scrollPreview("default_preview", {
          event: "panelScrollTo",
          filepath: this.activeFilePath,
          line: previewHighlight.scrollLine,
          character: previewHighlight.scrollCharacter
        });
      }
    }, 10);

    let attempts = 0;
    const maxAttempts = 15;
    
    this.pendingPreviewSyncPollTimer = window.setInterval(() => {
      attempts++;
      try {
        const iframe = this.previewIframe;
        if (!iframe) throw new Error("No iframe");
        
        const iframeDoc = iframe.contentDocument;
        if (!iframeDoc) throw new Error("No doc");

        const wrapperColor = "#fe0102";
        const elements = Array.from(iframeDoc.querySelectorAll(`[fill="${wrapperColor}"], [fill="rgb(254, 1, 2)"], [style*="color: ${wrapperColor}"], [style*="color: rgb(254, 1, 2)"]`));
        
        let targetEl: Element | null = null;
        for (const el of elements) {
           const rect = el.getBoundingClientRect();
           if (rect.width > 0 && rect.height > 0) {
               targetEl = el;
               break;
           }
        }
        
        if (targetEl) {
          if (this.pendingPreviewSyncPollTimer) {
            window.clearInterval(this.pendingPreviewSyncPollTimer);
            this.pendingPreviewSyncPollTimer = null;
          }
          
          const rect = targetEl.getBoundingClientRect();
          const iframeWin = iframe.contentWindow;
          let scrollContainer: Element | null = null;
          let current = targetEl.parentElement;
          
          if (iframeWin) {
             while (current) {
                const style = iframeWin.getComputedStyle(current);
                if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
                    scrollContainer = current;
                    break;
                }
                current = current.parentElement;
             }
          }

          if (scrollContainer) {
             const containerRect = scrollContainer.getBoundingClientRect();
             const scrollY = scrollContainer.scrollTop + rect.top - containerRect.top - (containerRect.height / 2) + (rect.height / 2);
             const scrollX = scrollContainer.scrollLeft + rect.left - containerRect.left - (containerRect.width / 2) + (rect.width / 2);
             scrollContainer.scrollTo({ top: scrollY, left: scrollX, behavior: 'smooth' });
          } else if (this.previewPane.scrollHeight > this.previewPane.clientHeight) {
             const iframeRect = iframe.getBoundingClientRect();
             const paneRect = this.previewPane.getBoundingClientRect();
             const absoluteTop = iframeRect.top + rect.top;
             const absoluteLeft = iframeRect.left + rect.left;
             
             const scrollTop = this.previewPane.scrollTop + absoluteTop - paneRect.top - (paneRect.height / 2) + (rect.height / 2);
             const scrollLeft = this.previewPane.scrollLeft + absoluteLeft - paneRect.left - (paneRect.width / 2) + (rect.width / 2);
             this.previewPane.scrollTo({ top: scrollTop, left: scrollLeft, behavior: 'smooth' });
          } else if (iframeWin) {
             const scrollY = iframeWin.scrollY + rect.top - (iframeWin.innerHeight / 2) + (rect.height / 2);
             const scrollX = iframeWin.scrollX + rect.left - (iframeWin.innerWidth / 2) + (rect.width / 2);
             iframeWin.scrollTo({ top: scrollY, left: scrollX, behavior: 'smooth' });
          }

          this.revertSyncText();
        } else if (attempts >= maxAttempts) {
          if (this.pendingPreviewSyncPollTimer) {
            window.clearInterval(this.pendingPreviewSyncPollTimer);
            this.pendingPreviewSyncPollTimer = null;
          }
          this.revertSyncText();
        }
      } catch (e) {
        if (attempts >= maxAttempts) {
          if (this.pendingPreviewSyncPollTimer) {
            window.clearInterval(this.pendingPreviewSyncPollTimer);
            this.pendingPreviewSyncPollTimer = null;
          }
          this.revertSyncText();
        }
      }
    }, 100);
  }

  private revertSyncText() {
    if (this.activeFilePath && this.lspReady && this.lspClient && this.editorInstance) {
        const version = ++this.currentVersion;
        this.latestDocumentVersion = version;
        const activeTab = this.getActiveTab();
        if (activeTab) {
          activeTab.version = version;
          activeTab.latestVersion = version;
        }
        this.previewHighlightMapping = null;
        this.previewOnlyDiagnosticsSuppressedUntil = Date.now() + 1000;
        this.lspClient.notifyTextChange(this.filePathToUri(this.activeFilePath), this.editorInstance.state.doc.toString(), version);
    }
  }

  private clearPendingPreviewSyncPoll() {
    if (this.pendingPreviewSyncPollTimer) {
      window.clearInterval(this.pendingPreviewSyncPollTimer);
      this.pendingPreviewSyncPollTimer = null;
    }
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

      // Try to disable the native context menu inside the preview iframe
      doc.addEventListener("contextmenu", e => e.preventDefault());
    } catch {
      // The preview server may be cross-origin; in that case Tinymist owns its internals.
    }
  }

  private buildHighlightedPreviewSource(cursor: number): { text: string; scrollLine: number; scrollCharacter: number; mapping: PreviewHighlightMapping } | null {
    const range = this.wordRangeAtCursor(cursor);
    if (!range) return null;
    if (!this.isPreviewHighlightableRange(range)) return null;

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

  private isPreviewHighlightableRange(range: { from: number; to: number }): boolean {
    const doc = this.editorInstance.state.doc;
    const line = doc.lineAt(range.from);
    if (range.to > line.to) return false;

    const start = range.from - line.from;
    const end = range.to - line.from;
    const lineText = line.text;

    if (this.isInsidePreviewExcludedInlineRegion(lineText, start)) {
      return false;
    }

    return !this.isTypstCodeSyntaxRange(lineText, start, end);
  }

  private isInsidePreviewExcludedInlineRegion(lineText: string, index: number): boolean {
    let inRaw = false;
    let inMath = false;
    let inBlockComment = false;

    for (let i = 0; i < index; i++) {
      const char = lineText[i];
      const next = lineText[i + 1];

      if (inBlockComment) {
        if (char === "*" && next === "/") {
          inBlockComment = false;
          i++;
        }
        continue;
      }

      if (!inRaw && !inMath && char === "/" && next === "/") {
        return true;
      }

      if (!inRaw && !inMath && char === "/" && next === "*") {
        inBlockComment = true;
        i++;
        continue;
      }

      if (!inMath && char === "`") {
        inRaw = !inRaw;
        continue;
      }

      if (!inRaw && char === "$") {
        inMath = !inMath;
      }
    }

    return inRaw || inMath || inBlockComment;
  }

  private isTypstCodeSyntaxRange(lineText: string, start: number, end: number): boolean {
    for (let hash = 0; hash < start; hash++) {
      if (lineText[hash] !== "#") continue;

      const span = this.typstCodeExpressionSpan(lineText, hash);
      if (span && start < span.to && end > span.from) {
        return true;
      }
    }

    return false;
  }

  private typstCodeExpressionSpan(lineText: string, hash: number): { from: number; to: number } | null {
    let index = this.skipInlineWhitespace(lineText, hash + 1);
    const expressionStart = index;

    if (index >= lineText.length) {
      return { from: hash, to: Math.min(hash + 1, lineText.length) };
    }

    if (!this.isWordChar(lineText[index])) {
      return { from: hash, to: Math.min(index + 1, lineText.length) };
    }

    const nameStart = index;
    while (index < lineText.length && this.isWordChar(lineText[index])) {
      index += lineText.codePointAt(index)! > 0xffff ? 2 : 1;
    }

    const name = lineText.slice(nameStart, index);
    if (this.isLineCodeKeyword(name)) {
      return { from: expressionStart, to: this.typstKeywordExpressionEnd(lineText, index, name) };
    }

    let expressionEnd = index;
    const afterName = this.skipInlineWhitespace(lineText, index);
    if (lineText[afterName] === "(") {
      expressionEnd = this.matchingDelimiterEnd(lineText, afterName, "(", ")") ?? lineText.length;
    }

    return { from: expressionStart, to: expressionEnd };
  }

  private typstKeywordExpressionEnd(lineText: string, index: number, keyword: string): number {
    if (keyword !== "set" && keyword !== "show") {
      return lineText.length;
    }

    let cursor = this.skipInlineWhitespace(lineText, index);
    while (cursor < lineText.length && this.isWordChar(lineText[cursor])) {
      cursor += lineText.codePointAt(cursor)! > 0xffff ? 2 : 1;
    }

    cursor = this.skipInlineWhitespace(lineText, cursor);
    if (lineText[cursor] === "(") {
      return this.matchingDelimiterEnd(lineText, cursor, "(", ")") ?? lineText.length;
    }

    return lineText.length;
  }

  private matchingDelimiterEnd(lineText: string, openIndex: number, open: string, close: string): number | null {
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = openIndex; i < lineText.length; i++) {
      const char = lineText[i];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === "\"") {
          inString = false;
        }
        continue;
      }

      if (char === "\"") {
        inString = true;
        continue;
      }

      if (char === open) {
        depth++;
      } else if (char === close) {
        depth--;
        if (depth === 0) {
          return i + 1;
        }
      }
    }

    return null;
  }

  private skipInlineWhitespace(text: string, index: number): number {
    let cursor = index;
    while (cursor < text.length && /\s/.test(text[cursor])) {
      cursor++;
    }
    return cursor;
  }

  private isLineCodeKeyword(name: string): boolean {
    return /^(let|set|show|import|include|if|else|for|while|break|continue|return)$/.test(name);
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
      if (this.previewOnlyVersions.has(version)) return;
      if (version < this.latestDocumentVersion) return;
    } else if (Date.now() < this.previewOnlyDiagnosticsSuppressedUntil) {
      return;
    }

    if (!this.activeFilePath || uri !== this.filePathToUri(this.activeFilePath)) {
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

    this.diagnosticLogEntries = filteredDiagnostics.map((diagnostic) => this.logEntryFromDiagnostic(uri, diagnostic));
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
    if (entry.kind === "error" && Date.now() < this.previewOnlyDiagnosticsSuppressedUntil) {
      return;
    }

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
    const resizer = document.getElementById("log-console-resizer");
    if (resizer) resizer.classList.toggle("hidden", !visible);
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

  private getRecentProjects(): string[] {
    try {
      const stored = localStorage.getItem("typstry-recent-projects");
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  }

  private addRecentProject(path: string) {
    let recent = this.getRecentProjects();
    recent = recent.filter(p => p !== path);
    recent.unshift(path);
    if (recent.length > 5) recent.pop();
    localStorage.setItem("typstry-recent-projects", JSON.stringify(recent));
    this.renderRecentProjects();
  }

  private renderRecentProjects() {
    const recentProjects = this.getRecentProjects();
    
    // Find the Recent Projects section in the welcome screen
    const welcomeSections = document.querySelectorAll('.welcome-section');
    if (welcomeSections.length < 2) return;
    
    const recentSection = welcomeSections[1];
    
    // Clear existing items but keep the title
    const titleHtml = '<div class="welcome-section-title">RECENT PROJECTS</div>';
    
    if (recentProjects.length === 0) {
      recentSection.innerHTML = titleHtml + '<div style="font-size: 13px; color: var(--ui-text); opacity: 0.5; padding: 8px 12px;">No recent projects</div>';
      return;
    }
    
    let html = titleHtml;
    recentProjects.forEach((path, index) => {
      // Extract folder name from path (handling both / and \ depending on OS)
      const folderName = path.split(/[/\\]/).pop() || path;
      const hotkey = index < 5 ? `Ctrl-${index + 1}` : '';
      
      html += `
        <div class="welcome-item recent-project-item" data-path="${path}">
          <span class="welcome-item-icon">📁</span>
          <span class="welcome-item-text" title="${path}">${folderName}</span>
          <span class="welcome-item-hotkey">${hotkey}</span>
        </div>
      `;
    });
    
    recentSection.innerHTML = html;
    
    // Bind click events
    recentSection.querySelectorAll('.recent-project-item').forEach(el => {
      el.addEventListener('click', async () => {
        const path = (el as HTMLElement).dataset.path;
        if (path) await this.openWorkspace(path);
      });
    });
  }

  private saveWorkspaceState() {
    if (!this.workspaceRootPath) return;
    
    this.persistActiveTabState();
    
    const inputContainer = document.getElementById("input-container-wrapper");
    const explorerSidebar = document.getElementById("explorer-sidebar");
    
    const state = {
      activeFilePath: this.activeFilePath,
      openTabs: this.openTabs.map(tab => ({
        path: tab.path,
        selectionAnchor: tab.selectionAnchor,
        selectionHead: tab.selectionHead,
        scrollTop: tab.scrollTop,
        scrollLeft: tab.scrollLeft
      })),
      inputContainerWidthPct: inputContainer?.style.width ? parseFloat(inputContainer.style.width) : 50,
      explorerSidebarWidthPx: explorerSidebar?.style.width ? parseInt(explorerSidebar.style.width, 10) : 250
    };
    
    localStorage.setItem(`typstry-workspace-${this.workspaceRootPath}`, JSON.stringify(state));
  }

  private async restoreWorkspaceState(workspacePath: string) {
    try {
      const stored = localStorage.getItem(`typstry-workspace-${workspacePath}`);
      if (!stored) return;
      
      const state = JSON.parse(stored);
      
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
      
      if (state.openTabs && Array.isArray(state.openTabs)) {
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
               scrollLeft: tabInfo.scrollLeft
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
    this.addRecentProject(selected);
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
    listen("menu-toggle-log-console", () => this.toggleLogConsole());
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
      this.lspLogEntries = [];
      this.renderLogConsole();
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

    this.logConsoleToggle.addEventListener("click", () => this.toggleLogConsole());
    this.logConsoleClose.addEventListener("click", () => this.setLogConsoleVisible(false));
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

  private getBlocksFromMarkup(markup: string): string[] {
    const blocks: string[] = [];
    let currentBlock: string[] = [];
    let inTable = false;
    let inCode = false;
    let inQuote = false;
    let inMath = false;

    const flush = () => {
      if (currentBlock.length > 0) {
        blocks.push(currentBlock.join("\n"));
        currentBlock = [];
      }
    };

    const lines = markup.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      if (inCode) {
        currentBlock.push(line);
        if (trimmed.startsWith("```")) { inCode = false; flush(); }
      } else if (inTable) {
        currentBlock.push(line);
        if (trimmed.startsWith(")")) { inTable = false; flush(); }
      } else if (inQuote) {
        currentBlock.push(line);
        if (trimmed.startsWith("]")) { inQuote = false; flush(); }
      } else if (inMath) {
        currentBlock.push(line);
        if (trimmed.startsWith("$")) { inMath = false; flush(); }
      } else {
        if (trimmed.startsWith("```")) {
          flush();
          inCode = true;
          currentBlock.push(line);
          if (trimmed.length > 3 && trimmed.endsWith("```")) { inCode = false; flush(); }
        } else if (trimmed.startsWith("#table(")) {
          flush();
          inTable = true;
          currentBlock.push(line);
        } else if (trimmed.startsWith("#quote[")) {
          flush();
          inQuote = true;
          currentBlock.push(line);
        } else if (trimmed === "$") {
          flush();
          inMath = true;
          currentBlock.push(line);
        } else if (trimmed.startsWith("=")) {
          flush();
          blocks.push(line);
        } else if (trimmed === "") {
          flush();
        } else {
          currentBlock.push(line);
        }
      }
    }
    flush();
    return blocks;
  }

  private renderInlineFormatting(text: string): string {
    let html = text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

    html = html.replace(/\*([^\*]+)\*/g, '<span class="wysiwym-marker">*</span><span class="wysiwym-bold">$1</span><span class="wysiwym-marker">*</span>');
    html = html.replace(/_([^_]+)_/g, '<span class="wysiwym-marker">_</span><span class="wysiwym-italic">$1</span><span class="wysiwym-marker">_</span>');
    html = html.replace(/#underline\[([^\]]+)\]/g, '<span class="wysiwym-marker">#underline[</span><span class="wysiwym-underline">$1</span><span class="wysiwym-marker">]</span>');
    html = html.replace(/#strike\[([^\]]+)\]/g, '<span class="wysiwym-marker">#strike[</span><span class="wysiwym-strike">$1</span><span class="wysiwym-marker">]</span>');
    html = html.replace(/#highlight\[([^\]]+)\]/g, '<span class="wysiwym-marker">#highlight[</span><span class="wysiwym-highlight">$1</span><span class="wysiwym-marker">]</span>');
    html = html.replace(/`([^`]+)`/g, '<span class="wysiwym-marker">`</span><span class="wysiwym-inline-code">$1</span><span class="wysiwym-marker">`</span>');
    html = html.replace(/#link\("([^"]+)"\)\[([^\]]+)\](?:&lt;([^&]+)&gt;)?/g, (_match, url, text, label) => {
       const labelMarkup = label ? `<span class="wysiwym-marker">&lt;${label}&gt;</span>` : '';
       return `<span class="wysiwym-marker">#link("${url}")[</span><span class="wysiwym-link" data-url="${url}">${text}</span><span class="wysiwym-marker">]</span>${labelMarkup}`;
    });
    html = html.replace(/#footnote\[([^\]]+)\]/g, '<span class="wysiwym-marker">#footnote[</span><span class="wysiwym-footnote">$1</span><span class="wysiwym-marker">]</span>');

    return html;
  }

  private mapMarkupToWysiwym(markup: string) {
    this.wysiwymContainer.innerHTML = "";
    const blocks = this.getBlocksFromMarkup(markup);
    blocks.forEach(blockText => {
      if (!blockText.trim()) return;
      const block = document.createElement("div");
      
      const trimmed = blockText.trim();
      if (trimmed.startsWith("=")) {
        block.className = "wysiwym-block heading";
        const match = trimmed.match(/^(=+)/);
        block.dataset.level = match ? match[1].length.toString() : "1";
        const content = trimmed.replace(/^=+\s*/, "");
        block.innerHTML = this.renderInlineFormatting(content);
        block.contentEditable = "true";
      } else if (trimmed.startsWith("#table(")) {
        block.className = "wysiwym-block table-block";
        block.contentEditable = "false"; // Do not allow editing raw table text container

        let innerContent = trimmed.substring(7); // remove `#table(`
        if (innerContent.endsWith(")")) innerContent = innerContent.substring(0, innerContent.length - 1);

        const cells: string[] = [];
        const namedArgs: string[] = [];
        let currentPart = "";
        let bDepth = 0;
        let pDepth = 0;
        let qDepth = 0;
        
        for (let i = 0; i < innerContent.length; i++) {
            const c = innerContent[i];
            if (c === '[') bDepth++;
            else if (c === ']') bDepth--;
            else if (c === '(') pDepth++;
            else if (c === ')') pDepth--;
            else if (c === '"') qDepth = 1 - qDepth;
            
            if (c === ',' && bDepth === 0 && pDepth === 0 && qDepth === 0) {
                const part = currentPart.trim();
                if (part) {
                    const colonIdx = part.indexOf(':');
                    if (colonIdx > 0 && !part.startsWith("[") && !part.startsWith('"')) {
                        namedArgs.push(part);
                    } else {
                        cells.push(part);
                    }
                }
                currentPart = "";
            } else {
                currentPart += c;
            }
        }
        const lastPart = currentPart.trim();
        if (lastPart) {
            const colonIdx = lastPart.indexOf(':');
            if (colonIdx > 0 && !lastPart.startsWith("[") && !lastPart.startsWith('"')) {
                namedArgs.push(lastPart);
            } else {
                cells.push(lastPart);
            }
        }

        let colCount = 2;
        const colArg = namedArgs.find(a => a.startsWith("columns:"));
        if (colArg) {
            const val = colArg.split(":")[1].trim();
            if (!isNaN(Number(val))) colCount = Number(val);
            else if (val.startsWith("(") && val.endsWith(")")) colCount = val.split(",").length;
        }

        block.dataset.namedArgs = JSON.stringify(namedArgs);
        block.dataset.cols = colCount.toString();

        const tableEl = document.createElement("table");
        tableEl.className = "wysiwym-table";
        let rowEl = document.createElement("tr");
        
        for (let i = 0; i < cells.length; i++) {
            let cellContent = cells[i];
            if (cellContent.startsWith("[") && cellContent.endsWith("]")) {
                cellContent = cellContent.substring(1, cellContent.length - 1);
            }
            const td = document.createElement("td");
            td.contentEditable = "true";
            td.innerHTML = this.renderInlineFormatting(cellContent);
            rowEl.appendChild(td);

            if ((i + 1) % colCount === 0 || i === cells.length - 1) {
                tableEl.appendChild(rowEl);
                rowEl = document.createElement("tr");
            }
        }
        
        const headerEl = document.createElement("div");
        headerEl.className = "wysiwym-table-header";
        headerEl.innerText = "Table (" + colCount + " columns)";
        block.appendChild(headerEl);
        block.appendChild(tableEl);

      } else if (trimmed.startsWith("#") || trimmed.startsWith("$") || trimmed.startsWith("```") || trimmed.startsWith("<") || trimmed.startsWith("@")) {
        block.className = "wysiwym-block function";
        block.innerHTML = blockText.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        block.contentEditable = "true";
      } else if (trimmed.startsWith("- ") || trimmed.startsWith("+ ")) {
        block.className = "wysiwym-block list";
        block.innerHTML = this.renderInlineFormatting(blockText);
        block.contentEditable = "true";
      } else {
        block.className = "wysiwym-block body";
        block.innerHTML = this.renderInlineFormatting(blockText);
        block.contentEditable = "true";
      }
      
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
    this.wysiwymContainer.classList.add("serialize-mode");
    const markup = Array.from(this.wysiwymContainer.querySelectorAll(".wysiwym-block"))
      .map((b: any) => {
         if (b.classList.contains("heading")) {
            const level = parseInt(b.getAttribute("data-level") || "1", 10);
            return `${"=".repeat(level)} ${b.innerText || b.textContent || ""}`;
         } else if (b.classList.contains("table-block")) {
            let markup = `#table(\n`;
            let namedArgs: string[] = [];
            try {
                namedArgs = JSON.parse(b.dataset.namedArgs || "[]");
            } catch(e){}
            for (const arg of namedArgs) {
                markup += `  ${arg},\n`;
            }
            const cells = Array.from(b.querySelectorAll("td")).map((td: any) => {
                let txt = td.innerText.trim();
                return `[${txt}]`;
            });
            const cols = parseInt(b.dataset.cols || "2", 10);
            for (let i = 0; i < cells.length; i++) {
               markup += `  ${cells[i]},`;
               if ((i + 1) % cols === 0 && i !== cells.length - 1) markup += "\n";
               else markup += " ";
            }
            if (!markup.endsWith("\n")) markup += "\n";
            markup += ")";
            return markup;
         }
         return b.innerText || b.textContent || "";
      })
      .join("\n\n");
    this.wysiwymContainer.classList.remove("serialize-mode");
    return markup;
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
          this.saveWorkspaceState();
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
          this.saveWorkspaceState();
        }
      });
    }

    const logConsoleResizer = document.getElementById("log-console-resizer");
    const logConsole = document.getElementById("log-console");
    let isResizingLogConsole = false;

    if (logConsoleResizer && logConsole) {
      logConsoleResizer.addEventListener("mousedown", () => {
        isResizingLogConsole = true;
        logConsoleResizer.classList.add("resizing");
        document.body.style.cursor = "row-resize";
        document.body.style.userSelect = "none";
      });

      document.addEventListener("mousemove", (e) => {
        if (!isResizingLogConsole) return;
        const statusBarHeight = document.getElementById("status-bar")?.offsetHeight || 26;
        const newHeight = window.innerHeight - e.clientY - statusBarHeight;
        const validHeight = Math.max(100, Math.min(newHeight, window.innerHeight * 0.8));
        logConsole.style.height = `${validHeight}px`;
      });

      document.addEventListener("mouseup", () => {
        if (isResizingLogConsole) {
          isResizingLogConsole = false;
          logConsoleResizer.classList.remove("resizing");
          document.body.style.cursor = "";
          document.body.style.userSelect = "";
        }
      });
      
      logConsoleResizer.addEventListener("dblclick", () => {
        this.setLogConsoleVisible(false);
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
